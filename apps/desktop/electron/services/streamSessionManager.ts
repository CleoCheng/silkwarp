import { screen } from "electron";
import type { ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ActiveSessionState,
  BootstrapConfig,
  DeviceInfo,
  DisplayMode,
  DisplayMonitorInfo,
  PeerStatus,
  RemoteFileListing,
  ResolutionMode,
  SessionHotkeyAction,
  StreamPreset,
  SystemActionType,
  TransferTaskItem,
  WindowRect,
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
  parseLossPercent,
  pickHostNativeDisplay,
  resolveStreamAppTarget,
  resolveTargetResolution,
  type StreamLinkQuality,
} from "./streamOptions";
import {
  type ApolloAppEntry,
  cancelRemoteApolloApp,
  fetchAvailableApolloAppEntries,
  launchRustDeskConnect,
  probeRemoteApolloPermission,
  spawnMoonlightStreamProcess,
} from "./streamLauncher";
import { WindowTracker } from "./windowTracker";

const RELOAD_DEBOUNCE_MS = 250;
const PROCESS_EXIT_TIMEOUT_MS = 2000;
const APPLIST_CACHE_TTL_MS = 5 * 60_000;
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
  private readonly refreshPeersFn: (() => Promise<PeerStatus[]>) | null;

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
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reloadChain: Promise<void> = Promise.resolve();
  private autoReconnectCount = 0;
  private stderrTail: string[] = [];

  private clipboardSync: ClipboardSyncManager | null = null;
  private clipboardAdapterOverride: ClipboardAdapter | null = null;
  private transfers: TransferTaskItem[] = [];
  private transferEmitTimers = new Map<string, NodeJS.Timeout>();
  private transferLastEmit = new Map<string, number>();
  private availableAppEntriesCache = new Map<string, { entries: ApolloAppEntry[]; expiresAt: number }>();
  private hostNativeResolutionCache = new Map<string, string>();
  private hostNativeRefreshHzCache = new Map<string, number>();
  private recoveryBitrateCapMbps: number | null = null;

  constructor(
    store: StateStore,
    onStateChange: (state: ActiveSessionState | null) => void,
    agentClient = new HostAgentClient(),
    options: { clipboardAdapter?: ClipboardAdapter; refreshPeers?: () => Promise<PeerStatus[]> } = {},
  ) {
    this.store = store;
    this.onStateChange = onStateChange;
    this.agentClient = agentClient;
    this.clipboardAdapterOverride = options.clipboardAdapter ?? null;
    this.refreshPeersFn = options.refreshPeers ?? null;

    const savedResolutions = this.store.get().hostDisplayResolutions;
    if (savedResolutions && typeof savedResolutions === "object") {
      for (const [devId, res] of Object.entries(savedResolutions)) {
        if (devId && typeof res === "string" && res) {
          this.hostNativeResolutionCache.set(devId, res);
        }
      }
    }

    const savedRefreshRates = this.store.get().hostDisplayRefreshRates;
    if (savedRefreshRates && typeof savedRefreshRates === "object") {
      for (const [devId, hz] of Object.entries(savedRefreshRates)) {
        if (devId && typeof hz === "number" && Number.isFinite(hz) && hz > 0) {
          this.hostNativeRefreshHzCache.set(devId, hz);
        }
      }
    }
  }

  private rememberHostDisplayResolution(deviceId: string, resolution: string): void {
    if (!deviceId || !resolution) return;
    this.hostNativeResolutionCache.set(deviceId, resolution);
    this.store.setHostDisplayResolution?.(deviceId, resolution);
  }

  private rememberHostDisplayRefreshHz(deviceId: string, refreshHz?: number): void {
    if (!deviceId || typeof refreshHz !== "number" || !Number.isFinite(refreshHz) || refreshHz <= 0) {
      return;
    }
    const rounded = Math.round(refreshHz);
    this.hostNativeRefreshHzCache.set(deviceId, rounded);
    this.store.setHostDisplayRefreshHz?.(deviceId, rounded);
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

  getLocalDisplayResolution(): string {
    const size = this.getClientDisplaySize(this.active?.windowRect ?? null);
    return normalizeWindowResolution(size.width, size.height);
  }

  private getClientDisplay(winRect: WindowRect | null): Electron.Display | null {
    try {
      if (winRect && winRect.width > 0 && winRect.height > 0) {
        const dip = screen.screenToDipRect(null, {
          x: winRect.x,
          y: winRect.y,
          width: winRect.width,
          height: winRect.height,
        });
        return screen.getDisplayMatching(dip);
      }
      return screen.getPrimaryDisplay();
    } catch {
      return null;
    }
  }

  private getClientDisplaySize(winRect: WindowRect | null): { width: number; height: number } {
    const disp = this.getClientDisplay(winRect);
    if (!disp) return { width: 1920, height: 1080 };
    const scale = disp.scaleFactor || 1;
    return {
      width: Math.round(disp.size.width * scale),
      height: Math.round(disp.size.height * scale),
    };
  }

  private getClientDisplayRefreshHz(winRect: WindowRect | null): number | null {
    const disp = this.getClientDisplay(winRect);
    if (!disp) return null;
    const hz = (disp as Electron.Display & { displayFrequency?: number }).displayFrequency;
    return typeof hz === "number" && Number.isFinite(hz) && hz > 0 ? hz : null;
  }

  private buildLinkQuality(active: ActiveSessionState): StreamLinkQuality {
    return {
      tunnel: active.tunnelProto,
      latencyMs: active.latencyMs,
      lossPercent: active.lossPercent,
      clientRefreshHz: this.getClientDisplayRefreshHz(active.windowRect),
      recoveryBitrateCapMbps: this.recoveryBitrateCapMbps,
    };
  }

  isSessionFocused(): boolean {
    return Boolean(this.active && (this.active.windowRect?.foreground || this.floatingBar?.isFocused()));
  }

  private async getOrFetchAvailableAppEntries(meshIp: string, apolloPort: number): Promise<ApolloAppEntry[]> {
    const cached = this.availableAppEntriesCache.get(meshIp);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.entries;
    }
    const entries = await fetchAvailableApolloAppEntries(meshIp, apolloPort, 1500);
    if (entries.length > 0) {
      this.availableAppEntriesCache.set(meshIp, { entries, expiresAt: Date.now() + APPLIST_CACHE_TTL_MS });
    }
    return entries;
  }

  private async cancelConflictingApolloAppIfNeeded(
    meshIp: string,
    apolloPort: number,
    resolvedApp: string,
    knownCurrentGameId?: number,
    entries?: ApolloAppEntry[],
    forceCancel = false,
  ): Promise<void> {
    if (forceCancel) {
      await cancelRemoteApolloApp(meshIp, apolloPort, 1500).catch(() => false);
      return;
    }
    let currentGameId = knownCurrentGameId;
    if (currentGameId === undefined) {
      const perm = await probeRemoteApolloPermission(meshIp, apolloPort, 900).catch(() => null);
      currentGameId = perm?.currentGameId ?? 0;
    }
    if (!currentGameId || currentGameId <= 0) return;

    const appEntries = entries ?? this.availableAppEntriesCache.get(meshIp)?.entries ?? [];
    const targetLower = resolvedApp.trim().toLowerCase();
    const targetEntry = appEntries.find((entry) => entry.title.trim().toLowerCase() === targetLower);
    if (targetEntry && targetEntry.id > 0 && targetEntry.id !== currentGameId) {
      await cancelRemoteApolloApp(meshIp, apolloPort, 1500).catch(() => false);
    }
  }

  private async performAutoReconnect(active: ActiveSessionState, forceCancelRemote = false): Promise<void> {
    if (this.closing || this.active !== active) return;
    if (this.refreshPeersFn) {
      const peers = await this.refreshPeersFn().catch(() => []);
      if (this.closing || this.active !== active) return;
      const peer = peers.find((p) => p.ipv4 === active.device.mesh_ip);
      if (peer) {
        active.routeType = peer.cost || active.routeType;
        active.latencyMs = peer.latencyMs ?? active.latencyMs;
        active.tunnelProto = peer.tunnel && peer.tunnel !== "-" ? peer.tunnel : active.tunnelProto;
        active.lossPercent = parseLossPercent(peer.loss);
      }
    }
    this.reloadChain = this.reloadChain.then(() => this.reloadCurrentStream(forceCancelRemote)).catch(() => {});
    await this.reloadChain;
  }

  private spawnFor(active: ActiveSessionState, onFirstWindow?: () => void): void {
    const linkQuality = this.buildLinkQuality(active);
    const child = spawnMoonlightStreamProcess(
      active.device.mesh_ip,
      active.preset,
      active.routeType,
      active.resolvedApp,
      linkQuality,
    );
    this.moonlight = child;
    this.stderrTail = [];

    const streamStartedAt = Date.now();
    let sawWindow = false;
    let firstReadyFired = false;
    let sawFirstVideoPacket = false;
    let fatalVideoError = false;
    let stabilityTimer: NodeJS.Timeout | null = null;

    const fireFirstReady = () => {
      if (firstReadyFired || this.active !== active) return;
      firstReadyFired = true;
      onFirstWindow?.();
      stabilityTimer = setTimeout(() => {
        if (this.moonlight === child && this.active === active) {
          this.autoReconnectCount = 0;
          if (active.reconnectAttempt || active.reconnectStatus) {
            active.reconnectAttempt = undefined;
            active.reconnectStatus = "";
            this.broadcast();
          }
        }
      }, 10_000);
      stabilityTimer.unref?.();
    };

    child.stderr?.on("error", () => {});
    child.stderr?.on("data", (chunk: Buffer) => {
      const lines = chunk
        .toString("utf-8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length === 0) return;
      for (const line of lines) {
        if (/Received first video packet|Decoded frame with POC 0\/0/i.test(line)) {
          sawFirstVideoPacket = true;
          fireFirstReady();
        }
        if (/No video received from host|fatal video encoding error|Connection terminated|The connection was terminated/i.test(line)) {
          fatalVideoError = true;
        }
      }
      this.stderrTail.push(...lines);
      if (this.stderrTail.length > 10) {
        this.stderrTail.splice(0, this.stderrTail.length - 10);
      }
    });

    const pid = child.pid;
    if (pid) {
      this.tracker = new WindowTracker(
        pid,
        {
          onRect: (rect) => {
            if (this.active !== active) return;
            sawWindow = true;
            fireFirstReady();
            active.windowRect = rect;
            this.floatingBar?.updateAnchor(rect);
            this.broadcast();
          },
          onExit: () => {
            // Let child's exit handler own auto-reconnect vs clean user disconnect.
            if (this.moonlight || this.closing || this.active !== active || active.reconnecting) return;
            void this.disconnect();
          },
        },
        {
          windowTitle: `SilkWarp - ${active.device.name}`,
          suppressLocalIme: true,
        },
      );
    }

    const handleUnexpectedExit = (code: number | null = null) => {
      if (stabilityTimer) {
        clearTimeout(stabilityTimer);
        stabilityTimer = null;
      }
      // A killed old process may report exit after its replacement spawned;
      // identity check keeps it from tearing down the live session.
      if (this.moonlight !== child) return;
      if (this.closing || this.active !== active || active.reconnecting) return;

      if (
        code === 0 &&
        sawWindow &&
        sawFirstVideoPacket &&
        !fatalVideoError &&
        Date.now() - streamStartedAt >= 4000
      ) {
        void this.disconnect();
        return;
      }

      if (this.autoReconnectCount < 3) {
        const attempt = ++this.autoReconnectCount;
        const needVideoRecovery = !sawFirstVideoPacket || fatalVideoError;
        let needCancelRemote = fatalVideoError;
        if (needVideoRecovery) {
          const currentBitrate = active.effectivePreset.bitrateMbps;
          const stepCap = [10, 8, 6][attempt - 1] ?? 6;
          this.recoveryBitrateCapMbps = Math.max(
            4,
            Math.min(stepCap, Math.max(4, currentBitrate - 2)),
          );
          if (
            active.resolvedApp === "Virtual Display" &&
            active.availableApps.some((a) => a.trim().toLowerCase() === "desktop")
          ) {
            const switched = normalizeStreamPreset({ ...active.preset, streamApp: "Desktop" });
            active.preset = switched;
            active.resolvedApp = "Desktop";
            this.store.update({ preset: switched });
            needCancelRemote = true;
          }
          active.effectivePreset = computeEffectivePreset(
            active.preset,
            active.routeType,
            this.buildLinkQuality(active),
          );
        }

        this.moonlight = null;
        this.tracker?.stop();
        this.tracker = null;
        active.reconnecting = true;
        active.reconnectAttempt = attempt;
        active.reconnectStatus = needVideoRecovery
          ? `检测到画面未送达，正在切换稳定通道自动重连 (${attempt}/3)…`
          : `网络波动，正在自动重连 (${attempt}/3)…`;
        this.broadcast();

        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          void this.performAutoReconnect(active, needCancelRemote);
        }, needVideoRecovery ? 400 : 1000 * attempt);
        this.reconnectTimer.unref?.();
        return;
      }

      void this.disconnect();
    };
    child.on("exit", (code) => handleUnexpectedExit(code));
    child.on("error", () => handleUnexpectedExit(null));
  }

  attachAgentContext(
    sessionId: string,
    agentContext: { agentConnected: boolean; agentPort: number; agentToken: string },
  ): void {
    const active = this.active;
    if (this.closing || !active || active.sessionId !== sessionId) return;
    if (!agentContext.agentConnected || !agentContext.agentToken) return;
    this.agentPort = agentContext.agentPort || this.agentPort;
    this.agentToken = agentContext.agentToken;
    this.agentConnected = true;
    active.agentConnected = true;
    this.broadcast();
    void this.hydrateAgentState(active, this.generation).then(() => {
      if (this.active === active) {
        this.broadcast();
      }
    });
    this.startClipboardSync();
  }

  async startSession(
    device: DeviceInfo,
    routeType: string,
    latencyMs: number | null,
    agentContext?: { agentConnected: boolean; agentPort: number; agentToken: string },
    options?: {
      prefetchedApps?: string[];
      prefetchedAppEntries?: ApolloAppEntry[];
      currentGameId?: number;
      onFirstWindow?: () => void;
      linkQuality?: StreamLinkQuality;
    },
  ): Promise<ActiveSessionState> {
    return this.runLifecycle(() =>
      this.startSessionInternal(device, routeType, latencyMs, agentContext, options),
    );
  }

  private async startSessionInternal(
    device: DeviceInfo,
    routeType: string,
    latencyMs: number | null,
    agentContext?: { agentConnected: boolean; agentPort: number; agentToken: string },
    options?: {
      prefetchedApps?: string[];
      prefetchedAppEntries?: ApolloAppEntry[];
      currentGameId?: number;
      onFirstWindow?: () => void;
      linkQuality?: StreamLinkQuality;
    },
  ): Promise<ActiveSessionState> {
    const generation = ++this.generation;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.autoReconnectCount = 0;
    this.recoveryBitrateCapMbps = null;

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

    const basePreset = normalizeStreamPreset(this.store.get().preset);
    let appEntries: ApolloAppEntry[] = options?.prefetchedAppEntries ?? [];
    if (appEntries.length > 0) {
      this.availableAppEntriesCache.set(device.mesh_ip, {
        entries: appEntries,
        expiresAt: Date.now() + APPLIST_CACHE_TTL_MS,
      });
    } else if (options?.prefetchedApps && options.prefetchedApps.length > 0) {
      appEntries = options.prefetchedApps.map((title) => ({ title, id: 0 }));
    } else {
      appEntries = await this.getOrFetchAvailableAppEntries(device.mesh_ip, device.apollo_port || 47984);
    }
    const availableApps = appEntries.map((entry) => entry.title);
    if (generation !== this.generation) {
      throw new Error("连接请求已被更新的会话取代。");
    }

    const clientSize = this.getClientDisplaySize(null);
    const clientDisplayResolution = normalizeWindowResolution(clientSize.width, clientSize.height);
    const clientDisplayRefreshHz = this.getClientDisplayRefreshHz(null);
    const cachedHostRes = this.hostNativeResolutionCache.get(device.id) || "";
    const cachedHostHz = this.hostNativeRefreshHzCache.get(device.id) || 0;
    const cachedHostDisplays: DisplayMonitorInfo[] = cachedHostRes
      ? [
          {
            index: 0,
            id: "cached-host",
            deviceName: "cached-host",
            friendlyName: "Host Primary",
            width: Number(cachedHostRes.split("x")[0]) || 1920,
            height: Number(cachedHostRes.split("x")[1]) || 1080,
            ...(cachedHostHz > 0 ? { refreshHz: cachedHostHz } : {}),
            x: 0,
            y: 0,
            isPrimary: true,
            isVirtual: false,
            active: true,
          },
        ]
      : [];

    const resolvedTarget = resolveTargetResolution(basePreset.resolutionMode, basePreset.resolution, {
      clientSize,
      hostDisplays: cachedHostDisplays,
      availableApps,
      currentStreamApp: basePreset.streamApp,
      targetFps: basePreset.fps,
    });

    const preset = normalizeStreamPreset({
      ...basePreset,
      resolution: resolvedTarget.resolution,
      streamApp: resolvedTarget.streamApp,
    });
    if (preset.resolution !== basePreset.resolution || preset.streamApp !== basePreset.streamApp) {
      this.store.update({ preset });
    }
    const resolvedApp = resolveStreamAppTarget(preset.streamApp, availableApps);

    await this.cancelConflictingApolloAppIfNeeded(
      device.mesh_ip,
      device.apollo_port || 47984,
      resolvedApp,
      options?.currentGameId,
      appEntries,
    );
    if (generation !== this.generation) {
      throw new Error("连接请求已被更新的会话取代。");
    }

    const tunnelProto =
      options?.linkQuality?.tunnel && options.linkQuality.tunnel !== "-" ? options.linkQuality.tunnel : "";
    const lossPercent = options?.linkQuality?.lossPercent ?? null;
    const initialLink: StreamLinkQuality = {
      tunnel: tunnelProto,
      latencyMs,
      lossPercent,
      clientRefreshHz: clientDisplayRefreshHz,
      recoveryBitrateCapMbps: this.recoveryBitrateCapMbps,
    };

    const active: ActiveSessionState = {
      sessionId: crypto.randomUUID(),
      device,
      preset,
      effectivePreset: computeEffectivePreset(preset, routeType, initialLink),
      routeType,
      latencyMs,
      tunnelProto,
      lossPercent,
      resolvedApp,
      availableApps,
      clientDisplayResolution,
      clientDisplayRefreshHz: clientDisplayRefreshHz ?? undefined,
      hostDisplayResolution: cachedHostRes || undefined,
      windowRect: null,
      reconnecting: false,
      reconnectAttempt: undefined,
      reconnectStatus: "",
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
      this.spawnFor(active, options?.onFirstWindow);
    } catch (err) {
      this.active = null;
      this.agentConnected = false;
      bar.destroy();
      this.floatingBar = null;
      this.broadcast();
      throw err;
    }

    // Launch stream & floating bar immediately, then hydrate host displays/audio/privacy asynchronously.
    this.broadcast();
    if (this.agentConnected) {
      void this.hydrateAgentState(active, generation).then(() => {
        if (generation === this.generation && this.active === active) {
          this.broadcast();
        }
      });
      this.startClipboardSync();
    }

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

    if (active.displays.length > 0) {
      const native = pickHostNativeDisplay(active.displays, active.selectedDisplayId);
      if (native) {
        const hostRes = normalizeWindowResolution(native.width, native.height);
        active.hostDisplayResolution = hostRes;
        this.rememberHostDisplayResolution(active.device.id, hostRes);
        this.rememberHostDisplayRefreshHz(active.device.id, native.refreshHz);
        if (
          active.preset.resolutionMode === "follow_host" &&
          (hostRes !== active.preset.resolution || active.preset.streamApp !== "Desktop")
        ) {
          const updated = normalizeStreamPreset({
            ...active.preset,
            resolution: hostRes,
            streamApp: "Desktop",
          });
          this.store.update({ preset: updated });
          active.preset = updated;
          active.effectivePreset = computeEffectivePreset(updated, active.routeType, this.buildLinkQuality(active));
          this.scheduleReload();
        } else if (
          active.preset.resolutionMode === "follow_client" &&
          active.preset.streamApp === "Desktop" &&
          native.refreshHz &&
          native.refreshHz + 5 < active.preset.fps &&
          active.availableApps.some((a) => a.trim().toLowerCase() === "virtual display")
        ) {
          const updated = normalizeStreamPreset({
            ...active.preset,
            streamApp: "Virtual Display",
          });
          this.store.update({ preset: updated });
          active.preset = updated;
          active.effectivePreset = computeEffectivePreset(updated, active.routeType, this.buildLinkQuality(active));
          this.scheduleReload();
        }
      }
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

    // An explicit user override raising fps or bitrate disables automatic
    // WAN/relay stability caps unless the caller re-enables it in the patch.
    const raisesFps =
      typeof patch.fps === "number" && patch.fps > 60 && patch.fps > current.fps;
    const raisesBitrate =
      typeof patch.bitrateMbps === "number" && patch.bitrateMbps > current.bitrateMbps;
    if ((raisesFps || raisesBitrate) && patch.adaptiveRelayCap === undefined) {
      merged.adaptiveRelayCap = false;
    }
    if (
      patch.bitrateMbps !== undefined ||
      patch.fps !== undefined ||
      patch.streamApp !== undefined ||
      patch.codec !== undefined ||
      patch.yuv444 !== undefined
    ) {
      this.recoveryBitrateCapMbps = null;
    }

    const preset = normalizeStreamPreset(merged);
    this.store.update({ preset });

    const active = this.active;
    if (!active) {
      return null;
    }

    active.preset = preset;
    active.effectivePreset = computeEffectivePreset(preset, active.routeType, this.buildLinkQuality(active));
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

  private async reloadCurrentStream(forceCancelRemote = false): Promise<void> {
    const active = this.active;
    if (!active) return;
    const generation = this.generation;

    active.reconnecting = true;
    this.broadcast();

    await this.stopCurrentProcess();
    if (generation !== this.generation || this.active !== active) return;

    const appEntries =
      active.availableApps.length > 0
        ? this.availableAppEntriesCache.get(active.device.mesh_ip)?.entries ??
          active.availableApps.map((title) => ({ title, id: 0 }))
        : await this.getOrFetchAvailableAppEntries(
            active.device.mesh_ip,
            active.device.apollo_port || 47984,
          );
    if (generation !== this.generation || this.active !== active) return;

    const availableApps = appEntries.map((entry) => entry.title);
    active.availableApps = availableApps;
    active.resolvedApp = resolveStreamAppTarget(active.preset.streamApp, availableApps);

    await this.cancelConflictingApolloAppIfNeeded(
      active.device.mesh_ip,
      active.device.apollo_port || 47984,
      active.resolvedApp,
      undefined,
      appEntries,
      forceCancelRemote,
    );
    if (generation !== this.generation || this.active !== active) return;

    active.effectivePreset = computeEffectivePreset(active.preset, active.routeType, this.buildLinkQuality(active));

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
    active.reconnectAttempt = undefined;
    active.reconnectStatus = "";
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
      throw new Error("远控增强服务未连接，无法浏览对方文件。");
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
      throw new Error("远控增强服务未连接，无法上传文件。");
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
      throw new Error("远控增强服务未连接，无法下载文件。");
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
      active.effectivePreset = computeEffectivePreset(preset, active.routeType, this.buildLinkQuality(active));
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
      active.effectivePreset = computeEffectivePreset(preset, active.routeType, this.buildLinkQuality(active));
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
      return { ok: false, message: "目标电脑的远控增强服务未连接，无法执行远程系统操作。" };
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

  async setResolutionMode(
    mode: ResolutionMode,
    fixedResolution?: string,
  ): Promise<ActiveSessionState | null> {
    const current = this.store.get().preset;
    const active = this.active;
    if (!active) {
      if (mode === "fixed" && fixedResolution) {
        this.store.update({ preset: normalizeStreamPreset({ ...current, resolutionMode: "fixed", resolution: fixedResolution }) });
      } else if (mode === "follow_client") {
        const res = this.getLocalDisplayResolution();
        this.store.update({ preset: normalizeStreamPreset({ ...current, resolutionMode: "follow_client", resolution: res }) });
      } else {
        this.store.update({ preset: normalizeStreamPreset({ ...current, resolutionMode: mode }) });
      }
      return null;
    }

    if (mode === "fit_window") {
      return this.fitToWindow();
    }

    if (mode === "follow_client") {
      const clientSize = this.getClientDisplaySize(active.windowRect);
      const clientRes = normalizeWindowResolution(clientSize.width, clientSize.height);
      active.clientDisplayResolution = clientRes;
      active.clientDisplayRefreshHz = this.getClientDisplayRefreshHz(active.windowRect) ?? active.clientDisplayRefreshHz;
      const cachedHostRes = this.hostNativeResolutionCache.get(active.device.id) || "";
      const cachedHostHz = this.hostNativeRefreshHzCache.get(active.device.id) || 0;
      const hostDisplays: DisplayMonitorInfo[] =
        active.displays.length > 0
          ? active.displays
          : cachedHostRes
            ? [
                {
                  index: 0,
                  id: "cached-host",
                  deviceName: "cached-host",
                  friendlyName: "Host Primary",
                  width: Number(cachedHostRes.split("x")[0]) || 1920,
                  height: Number(cachedHostRes.split("x")[1]) || 1080,
                  ...(cachedHostHz > 0 ? { refreshHz: cachedHostHz } : {}),
                  x: 0,
                  y: 0,
                  isPrimary: true,
                  isVirtual: false,
                  active: true,
                },
              ]
            : [];
      const target = resolveTargetResolution("follow_client", current.resolution, {
        clientSize,
        hostDisplays,
        selectedDisplayId: active.selectedDisplayId,
        availableApps: active.availableApps,
        currentStreamApp: active.preset.streamApp,
        targetFps: current.fps,
      });
      return this.updateOptions({
        resolutionMode: "follow_client",
        resolution: target.resolution,
        streamApp: target.streamApp,
      });
    }

    if (mode === "follow_host") {
      if (active.displays.length === 0 && this.agentConnected && this.agentToken) {
        await this.refreshDisplays().catch(() => null);
      }
      const native = pickHostNativeDisplay(active.displays, active.selectedDisplayId);
      if (native) {
        const hostRes = normalizeWindowResolution(native.width, native.height);
        active.hostDisplayResolution = hostRes;
        this.rememberHostDisplayResolution(active.device.id, hostRes);
      }
      const target = resolveTargetResolution("follow_host", active.hostDisplayResolution || current.resolution, {
        hostDisplays: active.displays,
        selectedDisplayId: active.selectedDisplayId,
        availableApps: active.availableApps,
        currentStreamApp: active.preset.streamApp,
      });
      return this.updateOptions({
        resolutionMode: "follow_host",
        resolution: target.resolution,
        streamApp: target.streamApp,
      });
    }

    return this.updateOptions({
      resolutionMode: "fixed",
      resolution: fixedResolution || active.preset.resolution,
    });
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
      resolutionMode: "fit_window",
      streamApp: hasVirtualDisplay ? "Virtual Display" : cur.streamApp,
    });
  }

  async toggleFullscreen(opts?: { fromHotkey?: boolean }): Promise<ActiveSessionState | null> {
    const active = this.active;
    if (!active) return null;

    const cur = active.preset.displayMode;
    const nextMode: DisplayMode = cur === "windowed" ? "fullscreen" : "windowed";
    if (this.tracker && active.windowRect) {
      const preset: StreamPreset = { ...active.preset, displayMode: nextMode };
      this.store.update({ preset });
      active.preset = preset;
      active.effectivePreset = computeEffectivePreset(preset, active.routeType, this.buildLinkQuality(active));
      this.broadcast();
      if (opts?.fromHotkey) {
        await new Promise((r) => setTimeout(r, 140));
        if (this.active !== active) return active;
      }
      this.tracker.sendHotkey("fullscreen");
      return active;
    }

    return this.updateOptions({ displayMode: nextMode });
  }

  sendHotkey(action: SessionHotkeyAction): void {
    const active = this.active;
    if (!active) return;

    if (action === "perf") {
      const preset: StreamPreset = { ...active.preset, showPerfOverlay: !active.preset.showPerfOverlay };
      this.store.update({ preset });
      active.preset = preset;
      active.effectivePreset = computeEffectivePreset(preset, active.routeType, this.buildLinkQuality(active));
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
    const nextTunnel = peer.tunnel && peer.tunnel !== "-" ? peer.tunnel : active.tunnelProto || "";
    const nextLoss = parseLossPercent(peer.loss);

    const telemetryChanged =
      nextRoute !== active.routeType ||
      nextLatency !== active.latencyMs ||
      nextTunnel !== (active.tunnelProto || "") ||
      nextLoss !== (active.lossPercent ?? null);

    active.routeType = nextRoute;
    active.latencyMs = nextLatency;
    active.tunnelProto = nextTunnel;
    active.lossPercent = nextLoss;
    active.effectivePreset = computeEffectivePreset(active.preset, nextRoute, this.buildLinkQuality(active));

    if (telemetryChanged) {
      this.broadcast();
    }
  }

  async switchToOfficeMode(bootstrap: BootstrapConfig): Promise<void> {
    const active = this.active;
    if (!active) {
      throw new Error("当前没有活跃的远程会话。");
    }
    if (!active.device.rustdesk_id) {
      throw new Error(
        `目标电脑「${active.device.name}」尚未就绪轻办公模式。请对方在【本机受控 -> 高级与运维设置】中完成初始化后重试。`,
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
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.autoReconnectCount = 0;
      this.recoveryBitrateCapMbps = null;
      this.stderrTail = [];

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
