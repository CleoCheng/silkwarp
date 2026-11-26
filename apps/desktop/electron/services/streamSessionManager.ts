import type { ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import type {
  ActiveSessionState,
  BootstrapConfig,
  DeviceInfo,
  PeerStatus,
  SessionHotkeyAction,
  StreamPreset,
} from "../types";
import { FloatingBarWindow } from "./floatingBarWindow";
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

  private active: ActiveSessionState | null = null;
  private moonlight: ChildProcess | null = null;
  private tracker: WindowTracker | null = null;
  private floatingBar: FloatingBarWindow | null = null;

  private closing = false;
  private generation = 0;
  private lifecycle: Promise<unknown> = Promise.resolve();
  private reloadTimer: NodeJS.Timeout | null = null;
  private reloadChain: Promise<void> = Promise.resolve();

  constructor(store: StateStore, onStateChange: (state: ActiveSessionState | null) => void) {
    this.store = store;
    this.onStateChange = onStateChange;
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
  ): Promise<ActiveSessionState> {
    return this.runLifecycle(() => this.startSessionInternal(device, routeType, latencyMs));
  }

  private async startSessionInternal(
    device: DeviceInfo,
    routeType: string,
    latencyMs: number | null,
  ): Promise<ActiveSessionState> {
    const generation = ++this.generation;

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
    };
    this.active = active;

    const bar = this.ensureFloatingBar();
    bar.setExpanded(false);
    bar.updateAnchor(null);

    try {
      this.spawnFor(active);
    } catch (err) {
      this.active = null;
      bar.destroy();
      this.floatingBar = null;
      this.broadcast();
      throw err;
    }

    this.broadcast();
    return active;
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
      this.active = null;
      await this.stopCurrentProcess();
      this.floatingBar?.destroy();
      this.floatingBar = null;
      this.broadcast();
    } finally {
      this.closing = false;
    }
  }
}
