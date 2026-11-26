import type { ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ActiveSessionState,
  BootstrapConfig,
  DeviceInfo,
  DisplayMonitorInfo,
  PeerStatus,
  RemoteFileListing,
  SessionHotkeyAction,
  StreamPreset,
  SystemActionType,
  TransferTaskItem,
} from "../types";
import {
  ClipboardSyncManager,
  createElectronClipboardAdapter,
  type ClipboardSyncStatus,
} from "./clipboardSyncManager";
import { FloatingBarWindow } from "./floatingBarWindow";
import { DEFAULT_AGENT_PORT } from "./hostAgentAuth";
import { HostAgentClient } from "./hostAgentClient";
import type { ClipboardAdapter } from "./hostTransferService";
import type { StateStore } from "./store";
import {
  computeEffectivePreset,
  normalizeStreamPreset,
  normalizeWindowResolution,
  resolveStreamAppTarget,
} from "./streamOptions";
import {
  fetchAvailableApolloApps,
  launchRustDeskConnect,
  spawnMoonlightStreamProcess,
} from "./streamLauncher";
import { WindowTracker } from "./windowTracker";

const RELOAD_DEBOUNCE_MS = 250;
const PROCESS_EXIT_TIMEOUT_MS = 2000;
/** How many finished/running transfers stay visible in the session bar. */
const MAX_TRANSFER_TASKS = 12;
/** Progress IPC updates are coalesced to ~10 Hz per transfer. */
const TRANSFER_PROGRESS_THROTTLE_MS = 100;

function parseResolution(resolution: string): { width: number; height: number } {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(resolution);
  if (!match) return { width: 2560, height: 1440 };
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * Coordinates the Moonlight process, the Win32 window tracker and the floating
 * session bar for a single active stream session.
 *
 * Concurrency model:
 * - `startSession` / `disconnect` are serialised through `lifecycle` so rapid
 *   clicks can never leave two Moonlight processes alive.
 * - Every session mutation bumps `generation`; async reload work re-checks it
 *   after each await so a disconnect or a newer session wins.
 * - Process handlers compare `this.moonlight` identity, so a late exit event
 *   from a killed old process can never tear down the replacement session.
 */
export class StreamSessionManager {
  private readonly store: StateStore;
  private readonly onStateChange: (state: ActiveSessionState | null) => void;
  private readonly agentClient: HostAgentClient;

  private active: ActiveSessionState | null = null;
  private moonlight: ChildProcess | null = null;
  private tracker: WindowTracker | null = null;
  private floatingBar: FloatingBarWindow | null = null;

  private agentHost = "";
  private agentPort = DEFAULT_AGENT_PORT;
  private agentToken = "";
  private agentConnected = false;

  private closing = false;
  private generation = 0;
  private lifecycle: Promise<unknown> = Promise.resolve();
  private reloadTimer: NodeJS.Timeout | null = null;
  private reloadChain: Promise<void> = Promise.resolve();

  private clipboardSync: ClipboardSyncManager | null = null;
  private clipboardAdapterOverride: ClipboardAdapter | null = null;
  private transfers: TransferTaskItem[] = [];
  private transferEmitTimers = new Map<string, NodeJS.Timeout>();
  private transferLastEmit = new Map<string, number>();

  constructor(
    store: StateStore,
    onStateChange: (state: ActiveSessionState | null) => void,
    agentClient = new HostAgentClient(),
    options: { clipboardAdapter?: ClipboardAdapter } = {},
  ) {
    this.store = store;
    this.onStateChange = onStateChange;
    this.agentClient = agentClient;
    this.clipboardAdapterOverride = options.clipboardAdapter ?? null;
  }

  getState(): ActiveSessionState | null {
    return this.active;
  }

  private runLifecycle<T>(task: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(task, task);
    this.lifecycle = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private broadcast(): void {
    const snapshot = this.active;
    this.floatingBar?.sendSessionState(snapshot);
    try {
      this.onStateChange(snapshot);
    } catch {
      // listener errors must not break session lifecycle
    }
  }

  private ensureFloatingBar(): FloatingBarWindow {
    if (!this.floatingBar) {
      this.floatingBar = new FloatingBarWindow();
    }
    return this.floatingBar;
  }

  private async stopCurrentProcess(): Promise<void> {
    this.tracker?.stop();
    this.tracker = null;
    const child = this.moonlight;
    this.moonlight = null;
    if (child) {
      await this.killChild(child, PROCESS_EXIT_TIMEOUT_MS);
    }
  }

  private killChild(child: ChildProcess, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          if (!child.killed) child.kill("SIGKILL");
        } catch {
          // already gone
        }
        finish();
      }, timeoutMs);
      timer.unref?.();
      child.once("exit", finish);
      child.once("error", finish);
      try {
        child.kill();
      } catch {
        finish();
      }
    });
  }

  private spawnFor(active: ActiveSessionState): void {
    const child = spawnMoonlightStreamProcess(
      active.device.mesh_ip,
      active.preset,
      active.routeType,
      active.resolvedApp,
    );
    this.moonlight = child;

    const pid = child.pid;
    if (pid) {
      this.tracker = new WindowTracker(pid, {
        onRect: (rect) => {
          if (this.active !== active) return;
          active.windowRect = rect;
          this.floatingBar?.updateAnchor(rect);
          this.broadcast();
        },
        onExit: () => {
          if (this.closing || this.active !== active || active.reconnecting) return;
          void this.disconnect();
        },
      });
    }

    const handleUnexpectedExit = () => {
      // A killed old process may report exit after its replacement spawned;
      // identity check keeps it from tearing down the live session.
      if (this.moonlight !== child) return;
      if (this.closing || this.active !== active || active.reconnecting) return;
      void this.disconnect();
    };
    child.on("exit", handleUnexpectedExit);
    child.on("error", handleUnexpectedExit);
  }

  async startSession(
    device: DeviceInfo,
    routeType: string,
    latencyMs: number | null,
    agentContext?: { agentConnected: boolean; agentPort: number; agentToken: string },
  ): Promise<ActiveSessionState> {
    return this.runLifecycle(() =>
      this.startSessionInternal(device, routeType, latencyMs, agentContext),
    );
  }

  private async startSessionInternal(
    device: DeviceInfo,
    routeType: string,
    latencyMs: number | null,
    agentContext?: { agentConnected: boolean; agentPort: number; agentToken: string },
  ): Promise<ActiveSessionState> {
    const generation = ++this.generation;

    // A new session replaces the previous one without going through
    // disconnect(); tell the old host to restore mute/privacy and honour its
    // auto-lock setting before we drop the old credentials.
    const previous = this.active;
    if (previous && this.agentConnected && this.agentToken) {
      this.agentClient
        .notifySessionEnd(this.agentHost, this.agentPort, this.agentToken, {
          autoLock: previous.autoLockOnDisconnect,
        })
        .catch(() => {});
    }
    this.stopClipboardSync();

    this.agentHost = device.mesh_ip;
    this.agentPort = agentContext?.agentPort || device.agent_port || DEFAULT_AGENT_PORT;
    this.agentToken = agentContext?.agentToken || "";
    this.agentConnected = Boolean(agentContext?.agentConnected && agentContext?.agentToken);

    // Detach the previous session first so its process-exit handlers cannot
    // tear down the new session that is about to be created.
    this.active = null;
    await this.stopCurrentProcess();
    if (generation !== this.generation) {
      throw new Error("连接请求已被更新的会话取代。");
    }

    const preset = normalizeStreamPreset(this.store.get().preset);
    const availableApps = await fetchAvailableApolloApps(device.mesh_ip, device.apollo_port || 47984);
    if (generation !== this.generation) {
      throw new Error("连接请求已被更新的会话取代。");
    }
    const resolvedApp = resolveStreamAppTarget(preset.streamApp, availableApps);

    const active: ActiveSessionState = {
      sessionId: crypto.randomUUID(),
      device,
      preset,
      effectivePreset: computeEffectivePreset(preset, routeType),
      routeType,
      latencyMs,
      resolvedApp,
      availableApps,
      windowRect: null,
      reconnecting: false,
      startedAt: Date.now(),
      agentConnected: this.agentConnected,
      displays: [],
      selectedDisplayId: "",
      hostMuted: false,
      privacyActive: false,
      privacySupported: true,
      autoLockOnDisconnect: false,
      clipboardSyncEnabled: this.clipboardSync ? this.clipboardSync.enabled : true,
      clipboardLastKind: "empty",
      clipboardLastSyncAt: null,
      clipboardError: "",
      transfers: this.snapshotTransfers(),
    };
    this.active = active;

    const bar = this.ensureFloatingBar();
    bar.setExpanded(false);
    bar.updateAnchor(null);

    try {
      this.spawnFor(active);
    } catch (err) {
      this.active = null;
      this.agentConnected = false;
      bar.destroy();
      this.floatingBar = null;
      this.broadcast();
      throw err;
    }

    if (this.agentConnected) {
      await this.hydrateAgentState(active, generation);
      this.startClipboardSync();
    }

    if (generation !== this.generation || this.active !== active) {
      return active;
    }
    this.broadcast();
    return active;
  }

  /**
   * Best-effort parallel probe of the host agent after the stream launches.
   * Individual route failures degrade to defaults instead of failing the session.
   */
  private async hydrateAgentState(active: ActiveSessionState, generation: number): Promise<void> {
    const host = this.agentHost;
    const port = this.agentPort;
    const token = this.agentToken;
    if (!token) return;

    const [info, displays, mute, privacy] = await Promise.allSettled([
      this.agentClient.probeInfo(host, port, 1800),
      this.agentClient.listDisplays(host, port, token),
      this.agentClient.getMuteState(host, port, token),
      this.agentClient.getPrivacyState(host, port, token),
    ]);
    if (generation !== this.generation || this.active !== active) return;

    if (displays.status === "fulfilled") {
      active.displays = displays.value;
    }
    if (info.status === "fulfilled") {
      active.autoLockOnDisconnect = Boolean(info.value.autoLockOnDisconnect);
    }
    if (mute.status === "fulfilled") {
      active.hostMuted = Boolean(mute.value.muted);
    }
    if (privacy.status === "fulfilled") {
      active.privacyActive = Boolean(privacy.value.active);
      active.privacySupported = privacy.value.supported !== false;
    }

    if (!active.selectedDisplayId && active.displays.length > 0) {
      active.selectedDisplayId = this.inferSelectedDisplay(active.displays, active.preset.streamApp);
    }

    if (active.effectivePreset.muteHostAudio) {
      try {
        await this.agentClient.setMuteState(host, port, token, true);
        active.hostMuted = true;
      } catch {
        // Mute is best-effort; the stream itself is unaffected.
      }
    }
  }

  private inferSelectedDisplay(displays: DisplayMonitorInfo[], streamApp: string): string {
    if (streamApp === "Virtual Display") {
      const virtual = displays.find((d) => d.isVirtual) ?? displays.find((d) => d.active);
      return (virtual ?? displays[0]).id;
    }
    const primary = displays.find((d) => d.isPrimary && !d.isVirtual) ?? displays.find((d) => !d.isVirtual);
    return (primary ?? displays[0]).id;
  }

  async updateOptions(patch: Partial<StreamPreset>): Promise<ActiveSessionState | null> {
    const current = this.store.get().preset;
    const merged: Partial<StreamPreset> = { ...current, ...patch };

    // An explicit user override of the relay guardrail (raising fps/bitrate
    // above the cap) disables it unless the caller re-enables it in the same
    // patch. Re-sending an already-high value is not a raise.
    const raisesFps =
      typeof patch.fps === "number" && patch.fps > 60 && patch.fps > current.fps;
    const raisesBitrate =
      typeof patch.bitrateMbps === "number" &&
      patch.bitrateMbps > 15 &&
      patch.bitrateMbps > current.bitrateMbps;
    if ((raisesFps || raisesBitrate) && patch.adaptiveRelayCap === undefined) {
      merged.adaptiveRelayCap = false;
    }

    const preset = normalizeStreamPreset(merged);
    this.store.update({ preset });

    const active = this.active;
    if (!active) {
      return null;
    }

    active.preset = preset;
    active.effectivePreset = computeEffectivePreset(preset, active.routeType);
    this.broadcast();
    this.scheduleReload();
    return active;
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      this.reloadChain = this.reloadChain
        .then(() => this.reloadCurrentStream())
        .catch(() => {});
    }, RELOAD_DEBOUNCE_MS);
    this.reloadTimer.unref?.();
  }

  private async reloadCurrentStream(): Promise<void> {
    const active = this.active;
    if (!active) return;
    const generation = this.generation;

    active.reconnecting = true;
    this.broadcast();

    await this.stopCurrentProcess();
    if (generation !== this.generation || this.active !== active) return;

    const availableApps = await fetchAvailableApolloApps(
      active.device.mesh_ip,
      active.device.apollo_port || 47984,
    );
    if (generation !== this.generation || this.active !== active) return;

    active.availableApps = availableApps;
    active.resolvedApp = resolveStreamAppTarget(active.preset.streamApp, availableApps);
    active.effectivePreset = computeEffectivePreset(active.preset, active.routeType);

    try {
      this.spawnFor(active);
    } catch {
      // Moonlight missing or spawn failure: surface a disconnected state.
      this.active = null;
      this.floatingBar?.destroy();
      this.floatingBar = null;
      this.broadcast();
      return;
    }

    active.reconnecting = false;
    this.broadcast();
  }

  // -------------------------------------------------------------------------
  // Stage 3: bidirectional clipboard + Mesh file transfer
  // -------------------------------------------------------------------------

  private startClipboardSync(): void {
    if (!this.agentConnected || !this.agentToken || !this.active) return;

    if (!this.clipboardSync) {
      const adapter = this.clipboardAdapterOverride ?? createElectronClipboardAdapter();
      this.clipboardSync = new ClipboardSyncManager({
        getTarget: () => this.getAgentContext(),
        adapter,
        client: this.agentClient,
        onStatusChange: (status: ClipboardSyncStatus) => this.applyClipboardStatus(status),
      });
    }
    this.clipboardSync.setEnabled(this.active.clipboardSyncEnabled);
    this.clipboardSync.start();
  }

  private clearTransferTimers(): void {
    for (const timer of this.transferEmitTimers.values()) clearTimeout(timer);
    this.transferEmitTimers.clear();
    this.transferLastEmit.clear();
  }

  private stopClipboardSync(): void {
    this.clipboardSync?.stop();
  }

  private applyClipboardStatus(status: ClipboardSyncStatus): void {
    const active = this.active;
    if (!active) return;
    const changed =
      active.clipboardSyncEnabled !== status.enabled ||
      active.clipboardLastKind !== status.lastKind ||
      active.clipboardLastSyncAt !== status.lastSyncedAt ||
      active.clipboardError !== status.lastError;
    if (!changed) return;
    active.clipboardSyncEnabled = status.enabled;
    active.clipboardLastKind = status.lastKind;
    active.clipboardLastSyncAt = status.lastSyncedAt;
    active.clipboardError = status.lastError;
    this.broadcast();
  }

  setClipboardSync(enabled: boolean): ActiveSessionState | null {
    const active = this.active;
    if (!active) return null;
    active.clipboardSyncEnabled = Boolean(enabled);
    if (this.clipboardSync) {
      this.clipboardSync.setEnabled(active.clipboardSyncEnabled);
    } else if (active.clipboardSyncEnabled) {
      this.startClipboardSync();
    }
    this.broadcast();
    return active;
  }

  async syncClipboardNow(): Promise<ActiveSessionState | null> {
    const active = this.active;
    if (!active) return null;
    if (!this.clipboardSync) this.startClipboardSync();
    await this.clipboardSync?.syncOnce();
    this.broadcast();
    return this.active;
  }

  private snapshotTransfers(): TransferTaskItem[] {
    return this.transfers.map((item) => ({ ...item }));
  }

  private upsertTransfer(item: TransferTaskItem): void {
    const index = this.transfers.findIndex((existing) => existing.id === item.id);
    if (index >= 0) {
      this.transfers[index] = { ...item };
    } else {
      this.transfers.unshift({ ...item });
      if (this.transfers.length > MAX_TRANSFER_TASKS) {
        this.transfers.length = MAX_TRANSFER_TASKS;
      }
    }
    this.publishTransfers();
  }

  /**
   * Progress callbacks fire per socket chunk (~64 KiB), so raw IPC broadcasts
   * would flood the renderer. Running updates are coalesced to ~10 Hz while
   * terminal states (done/error) publish immediately.
   */
  private publishTransfers(immediate = false): void {
    const active = this.active;
    if (!active) return;
    active.transfers = this.snapshotTransfers();

    const now = Date.now();
    const running = this.transfers.filter((item) => item.status === "running");
    if (immediate || running.length === 0) {
      for (const timer of this.transferEmitTimers.values()) clearTimeout(timer);
      this.transferEmitTimers.clear();
      this.transferLastEmit.clear();
      this.broadcast();
      return;
    }

    for (const item of running) {
      if (this.transferEmitTimers.has(item.id)) continue;
      const last = this.transferLastEmit.get(item.id) ?? 0;
      const wait = Math.max(0, TRANSFER_PROGRESS_THROTTLE_MS - (now - last));
      const timer = setTimeout(() => {
        this.transferEmitTimers.delete(item.id);
        this.transferLastEmit.set(item.id, Date.now());
        const current = this.active;
        if (!current) return;
        current.transfers = this.snapshotTransfers();
        this.broadcast();
      }, wait);
      timer.unref?.();
      this.transferEmitTimers.set(item.id, timer);
    }
  }

  async listRemoteFiles(dirPath?: string): Promise<RemoteFileListing> {
    if (!this.agentConnected || !this.agentToken) {
      throw new Error("Host Companion Agent 未连接，无法浏览远端文件。");
    }
    return this.agentClient.listRemoteFiles(this.agentHost, this.agentPort, this.agentToken, dirPath);
  }

  /**
   * Uploads local files one after another (bounded concurrency of one keeps the
   * Mesh link and the host's `.part` allocator predictable) while emitting
   * throttled progress into `ActiveSessionState.transfers`.
   */
  async uploadFiles(localPaths: string[], targetDir?: string): Promise<TransferTaskItem[]> {
    if (!this.agentConnected || !this.agentToken) {
      throw new Error("Host Companion Agent 未连接，无法上传文件。");
    }
    const paths = (Array.isArray(localPaths) ? localPaths : [])
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
    if (paths.length === 0) return [];

    const results: TransferTaskItem[] = [];
    for (const localPath of paths) {
      const taskId = crypto.randomUUID();
      const filename = path.basename(localPath) || localPath;
      let total = 0;
      try {
        total = fs.statSync(localPath).size;
      } catch {
        total = 0;
      }

      const task: TransferTaskItem = {
        id: taskId,
        direction: "upload",
        filename,
        transferred: 0,
        total,
        status: "running",
        localPath,
      };
      this.upsertTransfer(task);

      try {
        const result = await this.agentClient.uploadFileStream(
          this.agentHost,
          this.agentPort,
          this.agentToken,
          localPath,
          {
            targetDir,
            onProgress: (progress) => {
              task.transferred = progress.transferred;
              task.total = progress.total || total;
              this.upsertTransfer(task);
            },
          },
        );
        task.status = "done";
        task.transferred = result.size;
        task.total = result.size;
        task.filename = result.filename;
        task.remotePath = result.path;
        this.upsertTransfer(task);
      } catch (err) {
        task.status = "error";
        task.message = err instanceof Error ? err.message : String(err);
        this.upsertTransfer(task);
      }
      results.push({ ...task });
    }

    this.publishTransfers(true);
    return results;
  }

  async downloadRemoteFile(remotePath: string, localSavePath: string): Promise<TransferTaskItem> {
    if (!this.agentConnected || !this.agentToken) {
      throw new Error("Host Companion Agent 未连接，无法下载文件。");
    }
    const task: TransferTaskItem = {
      id: crypto.randomUUID(),
      direction: "download",
      filename: path.basename(localSavePath) || path.basename(remotePath),
      transferred: 0,
      total: 0,
      status: "running",
      remotePath,
      localPath: localSavePath,
    };
    this.upsertTransfer(task);

    try {
      const result = await this.agentClient.downloadFileStream(
        this.agentHost,
        this.agentPort,
        this.agentToken,
        remotePath,
        localSavePath,
        {
          onProgress: (progress) => {
            task.transferred = progress.transferred;
            task.total = progress.total || task.total;
            this.upsertTransfer(task);
          },
        },
      );
      task.status = "done";
      task.transferred = result.size;
      task.total = result.size;
      task.localPath = result.path;
      this.upsertTransfer(task);
    } catch (err) {
      task.status = "error";
      task.message = err instanceof Error ? err.message : String(err);
      this.upsertTransfer(task);
    }

    this.publishTransfers(true);
    return { ...task };
  }

  getAgentContext(): { connected: boolean; host: string; port: number; token: string } | null {
    if (!this.active) return null;
    return {
      connected: this.agentConnected,
      host: this.agentHost,
      port: this.agentPort,
      token: this.agentToken,
    };
  }

  async refreshDisplays(): Promise<ActiveSessionState | null> {
    const active = this.active;
    if (!active || !this.agentConnected || !this.agentToken) return active;

    const displays = await this.agentClient.listDisplays(this.agentHost, this.agentPort, this.agentToken);
    if (this.active !== active) return this.active;

    active.displays = displays;
    if (!active.selectedDisplayId && displays.length > 0) {
      active.selectedDisplayId = this.inferSelectedDisplay(displays, active.preset.streamApp);
    }
    this.broadcast();
    return active;
  }

  async selectDisplay(displayId: string): Promise<ActiveSessionState | null> {
    const active = this.active;
    if (!active || !this.agentConnected || !this.agentToken) return active;

    const result = await this.agentClient.selectDisplay(
      this.agentHost,
      this.agentPort,
      this.agentToken,
      displayId,
    );
    if (this.active !== active) return this.active;
    if (!result.ok) {
      active.displays = result.displays?.length ? result.displays : active.displays;
      this.broadcast();
      throw new Error(result.message || "切换显示器失败");
    }

    active.displays = result.displays?.length ? result.displays : active.displays;
    active.selectedDisplayId = result.selectedDisplayId || displayId;

    const selected = active.displays.find((d) => d.id === active.selectedDisplayId);
    const nextStreamApp: StreamPreset["streamApp"] = selected?.isVirtual
      ? "Virtual Display"
      : !selected?.isVirtual && active.preset.streamApp === "Virtual Display"
        ? "Desktop"
        : active.preset.streamApp;

    const streamAppChanged = nextStreamApp !== active.preset.streamApp;
    if (streamAppChanged) {
      const preset = normalizeStreamPreset({ ...active.preset, streamApp: nextStreamApp });
      this.store.update({ preset });
      active.preset = preset;
      active.effectivePreset = computeEffectivePreset(preset, active.routeType);
    }

    this.broadcast();

    if (result.restartRecommended || streamAppChanged) {
      this.scheduleReload();
    }
    return active;
  }

  async setHostMute(muted: boolean): Promise<ActiveSessionState | null> {
    const active = this.active;
    if (!active) return null;

    if (this.agentConnected && this.agentToken) {
      const res = await this.agentClient.setMuteState(
        this.agentHost,
        this.agentPort,
        this.agentToken,
        muted,
      );
      if (this.active !== active) return this.active;
      active.hostMuted = Boolean(res.muted);

      // Reflect the live state in the persisted preset without restarting
      // Moonlight (the audio path is a host-side master mute, not an encoder
      // option).
      const preset = normalizeStreamPreset({ ...this.store.get().preset, muteHostAudio: active.hostMuted });
      this.store.update({ preset });
      active.preset = preset;
      active.effectivePreset = computeEffectivePreset(preset, active.routeType);
      this.broadcast();
      return active;
    }

    return this.updateOptions({ muteHostAudio: muted });
  }

  async setPrivacy(enabled: boolean): Promise<ActiveSessionState | null> {
    const active = this.active;
    if (!active || !this.agentConnected || !this.agentToken) return active;

    const res = await this.agentClient.setPrivacyState(
      this.agentHost,
      this.agentPort,
      this.agentToken,
      enabled,
    );
    if (this.active !== active) return this.active;

    active.privacyActive = Boolean(res.active);
    active.privacySupported = res.supported !== false;
    this.broadcast();
    return active;
  }

  async runSystemAction(action: SystemActionType): Promise<{ ok: boolean; message: string }> {
    const active = this.active;
    if (!active) {
      return { ok: false, message: "当前没有活跃的远程会话。" };
    }
    if (!this.agentConnected || !this.agentToken) {
      return { ok: false, message: "目标主机的 Host Companion Agent 未连接，无法执行远程系统操作。" };
    }
    return this.agentClient.runSystemAction(this.agentHost, this.agentPort, this.agentToken, action);
  }

  async setAutoLockOnDisconnect(enabled: boolean): Promise<ActiveSessionState | null> {
    const active = this.active;
    if (!active) return null;
    active.autoLockOnDisconnect = enabled;
    this.broadcast();
    return active;
  }

  async fitToWindow(): Promise<ActiveSessionState | null> {
    const active = this.active;
    if (!active) return null;

    const cur = active.preset;
    const rect = active.windowRect;
    let width: number;
    let height: number;
    if (rect) {
      width = rect.clientWidth > 0 ? rect.clientWidth : rect.width - 16;
      height = rect.clientHeight > 0 ? rect.clientHeight : rect.height - 39;
    } else {
      const fallback = parseResolution(cur.resolution);
      width = fallback.width;
      height = fallback.height;
    }

    const resolution = normalizeWindowResolution(width, height);
    const hasVirtualDisplay = active.availableApps.some(
      (a) => a.trim().toLowerCase() === "virtual display",
    );

    return this.updateOptions({
      resolution,
      streamApp: hasVirtualDisplay ? "Virtual Display" : cur.streamApp,
    });
  }

  async toggleFullscreen(): Promise<ActiveSessionState | null> {
    const active = this.active;
    if (!active) return null;

    const cur = active.preset.displayMode;
    if ((cur === "windowed" || cur === "fullscreen") && this.tracker && active.windowRect) {
      const nextMode = cur === "fullscreen" ? "windowed" : "fullscreen";
      const preset: StreamPreset = { ...active.preset, displayMode: nextMode };
      this.store.update({ preset });
      active.preset = preset;
      active.effectivePreset = computeEffectivePreset(preset, active.routeType);
      this.tracker.sendHotkey("fullscreen");
      this.broadcast();
      return active;
    }

    return this.updateOptions({ displayMode: cur === "windowed" ? "fullscreen" : "windowed" });
  }

  sendHotkey(action: SessionHotkeyAction): void {
    const active = this.active;
    if (!active) return;

    if (action === "perf") {
      const preset: StreamPreset = { ...active.preset, showPerfOverlay: !active.preset.showPerfOverlay };
      this.store.update({ preset });
      active.preset = preset;
      active.effectivePreset = computeEffectivePreset(preset, active.routeType);
      this.broadcast();
    }

    this.tracker?.sendHotkey(action);
  }

  focusRemoteWindow(): void {
    this.tracker?.focusTarget();
  }

  updateTelemetry(peers: PeerStatus[]): void {
    const active = this.active;
    if (!active) return;

    const peer = peers.find((p) => p.ipv4 === active.device.mesh_ip);
    if (!peer) return;

    const nextRoute = peer.cost || active.routeType;
    const nextLatency = peer.latencyMs ?? null;
    if (nextRoute === active.routeType && nextLatency === active.latencyMs) return;

    active.routeType = nextRoute;
    active.latencyMs = nextLatency;
    active.effectivePreset = computeEffectivePreset(active.preset, nextRoute);
    this.broadcast();
  }

  async switchToOfficeMode(bootstrap: BootstrapConfig): Promise<void> {
    const active = this.active;
    if (!active) {
      throw new Error("当前没有活跃的远程会话。");
    }
    if (!active.device.rustdesk_id) {
      throw new Error(
        `目标主机「${active.device.name}」尚未启用 RustDesk。请对方在【本机受控】页点击「一键安装并接入自建中继」后重试。`,
      );
    }
    const device = active.device;
    await this.disconnect();
    launchRustDeskConnect(device, bootstrap);
  }

  setBarExpanded(expanded: boolean): void {
    this.floatingBar?.setExpanded(expanded);
  }

  nudgeBarOffset(deltaX: number): void {
    this.floatingBar?.nudgeOffset(deltaX);
  }

  async disconnect(): Promise<void> {
    return this.runLifecycle(() => this.disconnectInternal());
  }

  private async disconnectInternal(): Promise<void> {
    if (this.closing) return;
    this.closing = true;

    try {
      this.generation++;
      if (this.reloadTimer) {
        clearTimeout(this.reloadTimer);
        this.reloadTimer = null;
      }

      const closingSession = this.active;
      if (closingSession && this.agentConnected && this.agentToken) {
        this.agentClient
          .notifySessionEnd(this.agentHost, this.agentPort, this.agentToken, {
            autoLock: closingSession.autoLockOnDisconnect,
          })
          .catch(() => {});
      }

      this.active = null;
      this.agentConnected = false;
      this.agentToken = "";
      this.agentHost = "";
      this.stopClipboardSync();
      this.clearTransferTimers();
      this.transfers = [];
      await this.stopCurrentProcess();
      this.floatingBar?.destroy();
      this.floatingBar = null;
      this.broadcast();
    } finally {
      this.closing = false;
    }
  }
}
