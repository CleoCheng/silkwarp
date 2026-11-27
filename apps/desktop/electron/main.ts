import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createElectronClipboardAdapter } from "./services/clipboardSyncManager";
import { ControlClient, type PairRequestItem } from "./services/controlClient";
import { EasyTierManager } from "./services/easytierManager";
import {
  checkApolloAuthStatus,
  collectHostInfo,
  configureAutoStartTask,
  configureBootTunnelTask,
  configureRustDeskClient,
  configureWindowsFirewall,
  downloadAndRunApolloInstaller,
  downloadAndRunRustDeskInstaller,
  ensureApolloCredentials,
  ensureApolloServiceRunning,
  getApolloOutputName,
  grantAllApolloClientPermissions,
  invalidateFirewallCache,
  restartBootTunnelTask,
  setApolloOutputName,
  silentInstallApollo,
  submitApolloPin,
} from "./services/hostManager";
import { computePairPollDelayMs, enrichDevicesWithEasyTierPeers } from "./services/hostMaintenance";
import {
  AgentAuthManager,
  DEFAULT_AGENT_PORT,
  generateTempAccessPassword,
  hashAccessPassword,
} from "./services/hostAgentAuth";
import { AgentClientError, HostAgentClient } from "./services/hostAgentClient";
import { HostAgentServer } from "./services/hostAgentServer";
import { createHostTransferExtraRoute } from "./services/hostTransferService";
import {
  getHostMasterMute,
  listHostDisplays,
  runHostSystemAction,
  setHostMasterMute,
} from "./services/hostSystemControl";
import { PrivacyScreenManager } from "./services/privacyScreenManager";
import { StateStore } from "./services/store";
import { StreamSessionManager } from "./services/streamSessionManager";
import { normalizeStreamPreset, parseLossPercent, type StreamLinkQuality } from "./services/streamOptions";
import {
  fetchAvailableApolloApps,
  isMoonlightHostPaired,
  launchMoonlightGui,
  launchRustDeskConnect,
  probeRemoteApolloPermission,
  probeTcpPort,
  spawnSilentMoonlightPair,
  wakeDeviceViaGateway,
} from "./services/streamLauncher";
import type {
  ActiveSessionState,
  AppRuntimeState,
  BootstrapConfig,
  ConnectDeviceResult,
  ConnectProgressEvent,
  DeviceAgentSessionResult,
  DeviceInfo,
  DisplayMonitorInfo,
  HostHardwareInfo,
  ProvisionStage,
  RemoteFileListing,
  ResolutionMode,
  SessionHotkeyAction,
  StreamPreset,
  SystemActionType,
  TransferTaskItem,
} from "./types";

const execFileAsync = promisify(execFile);

process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (err && (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED")) {
    return;
  }
  console.error("Uncaught exception in SilkWarp main process:", err);
});

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let heartbeatTimer: NodeJS.Timeout | null = null;
let pairPollTimer: NodeJS.Timeout | null = null;
let sessionTelemetryTimer: NodeJS.Timeout | null = null;

const store = new StateStore();
const client = new ControlClient(
  () => store.get().apiUrl,
  () => store.get().token,
);
const easyTier = new EasyTierManager();

const SESSION_FULLSCREEN_SHORTCUTS = ["CommandOrControl+Alt+F", "CommandOrControl+Alt+Return"] as const;
let sessionShortcutsRegistered = false;

function syncSessionTelemetryLoop(active: boolean): void {
  if (!active || isQuitting) {
    if (sessionTelemetryTimer) {
      clearInterval(sessionTelemetryTimer);
      sessionTelemetryTimer = null;
    }
    return;
  }
  if (!sessionTelemetryTimer) {
    sessionTelemetryTimer = setInterval(() => {
      void easyTier
        .refreshPeers()
        .then((peers) => {
          sessionManager.updateTelemetry(peers);
        })
        .catch(() => {});
    }, 5_000);
    sessionTelemetryTimer.unref?.();
  }
}

function resolveLivePeerLink(device: DeviceInfo): {
  routeType: string;
  latencyMs: number | null;
  linkQuality: StreamLinkQuality;
} {
  const peer = easyTier.getStatus().peers.find((p) => p.ipv4 === device.mesh_ip);
  const routeType = peer?.cost || device.route_type || "p2p";
  const latencyMs = peer?.latencyMs ?? device.latency_ms ?? null;
  const tunnel = peer?.tunnel && peer.tunnel !== "-" ? peer.tunnel : undefined;
  const lossPercent = peer ? parseLossPercent(peer.loss) : null;
  return {
    routeType,
    latencyMs,
    linkQuality: {
      tunnel,
      latencyMs,
      lossPercent,
    },
  };
}

const sessionManager = new StreamSessionManager(
  store,
  (sessionState: ActiveSessionState | null) => {
    syncSessionGlobalShortcuts(Boolean(sessionState));
    syncSessionTelemetryLoop(Boolean(sessionState));
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("session:stateChanged", sessionState);
    }
  },
  undefined,
  { refreshPeers: () => easyTier.refreshPeers() },
);

function syncSessionGlobalShortcuts(active: boolean): void {
  if (!app.isReady()) return;
  if (active && !sessionShortcutsRegistered) {
    sessionShortcutsRegistered = true;
    for (const accel of SESSION_FULLSCREEN_SHORTCUTS) {
      try {
        globalShortcut.register(accel, () => {
          if (sessionManager.isSessionFocused()) {
            void sessionManager.toggleFullscreen({ fromHotkey: true });
          }
        });
      } catch {
        // ignore if shortcut is temporarily claimed elsewhere
      }
    }
  } else if (!active && sessionShortcutsRegistered) {
    sessionShortcutsRegistered = false;
    for (const accel of SESSION_FULLSCREEN_SHORTCUTS) {
      try {
        globalShortcut.unregister(accel);
      } catch {
        // ignore
      }
    }
  }
}

function emitConnectProgress(progress: ConnectProgressEvent | null): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("connect:progress", progress);
  }
}

const ME_SYNC_TTL_MS = 5 * 60_000;
const BOOTSTRAP_SYNC_TTL_MS = 5 * 60_000;
const APOLLO_PERM_SYNC_INTERVAL_MS = 10 * 60_000;

let bootstrapCache: BootstrapConfig | null = null;
let devicesCache: DeviceInfo[] = [];
let lastRustDeskConfigSig = "";
let lastMeSyncAt = 0;
let lastBootstrapSyncAt = 0;
let lastApolloPermSyncAt = 0;
let lastPairCheckAt = 0;
let lastPairActivityAt = 0;
let pairPollStopped = false;
let provisionStage: ProvisionStage = "idle";
let provisionMessage = "";
let apolloAuthReady = false;
let autoHealExhausted = false;
let provisionInFlight: Promise<void> | null = null;
const activePairReqIds = new Set<string>();

let hostInfoCache: HostHardwareInfo = {
  hostname: os.hostname(),
  cpu: "",
  gpu: "",
  macAddress: "",
  broadcastIp: "255.255.255.255",
  isElevated: false,
  apolloInstalled: false,
  apolloRunning: false,
  apolloPort: 47984,
  rustdeskInstalled: false,
  rustdeskId: "",
  firewallConfigured: false,
  bootTunnelConfigured: false,
  uuRemoteDetected: false,
  provisionStage: "idle",
  provisionMessage: "",
  apolloAuthReady: false,
  agentRunning: false,
  agentPort: DEFAULT_AGENT_PORT,
};
const pairLogs: string[] = [];

const TEMP_PASSWORD_TTL_MS = 30 * 60 * 1000;
let tempAccessPassword = "";
let tempAccessPasswordExpiresAt = 0;
let hostSessionOrigMuted: boolean | null = null;
let hostSelectedDisplayId = "";
let apolloOutputSeeded = false;
let agentServerRunning = false;

const privacyScreen = new PrivacyScreenManager();
const agentClient = new HostAgentClient();
let cachedHostDisplays: { value: DisplayMonitorInfo[]; updatedAt: number } | null = null;

async function getCachedHostDisplays(): Promise<DisplayMonitorInfo[]> {
  if (cachedHostDisplays && Date.now() - cachedHostDisplays.updatedAt < 10_000) {
    return cachedHostDisplays.value;
  }
  const value = await listHostDisplays();
  cachedHostDisplays = { value, updatedAt: Date.now() };
  return value;
}

function ensureValidTempPassword(): void {
  const s = store.get();
  if (!s.requireAccessPassword) return;
  if (!tempAccessPassword || Date.now() >= tempAccessPasswordExpiresAt) {
    tempAccessPassword = generateTempAccessPassword();
    tempAccessPasswordExpiresAt = Date.now() + TEMP_PASSWORD_TTL_MS;
  }
}

const authManager = new AgentAuthManager(() => {
  const s = store.get();
  if (s.requireAccessPassword) ensureValidTempPassword();
  return {
    requireAccessPassword: s.requireAccessPassword,
    permanentPasswordHash: s.accessPasswordHash,
    tempPassword: tempAccessPassword,
    tempPasswordExpiresAt: tempAccessPasswordExpiresAt,
    allowSameAccountBypass: s.allowSameAccountBypass,
    hostOwnerUserId: s.user?.id || "",
  };
});

const hostAgentServer = new HostAgentServer({
  authManager,
  getMeshCidr: getDefaultMeshCidr,
  allowLoopback: true,
  handlers: {
    onExtraRoute: createHostTransferExtraRoute({
      clipboard: createElectronClipboardAdapter({ clipboard, nativeImage }),
      onFileReceived: (info) => {
        pushPairLog(`收到传输文件 [${info.filename}] (${Math.round(info.size / 1024)} KB)`);
        emitState();
      },
    }),
    getHostInfo: async () => {
      const s = store.get();
      const muted = await getHostMasterMute().catch(() => false);
      if (!apolloOutputSeeded && s.apolloUser && s.apolloPass) {
        apolloOutputSeeded = true;
        const output = await getApolloOutputName(s.apolloUser, s.apolloPass).catch(() => "");
        // Only seed when Apollo reports a Win32 device path, which is what
        // listHostDisplays() uses as a stable display id.
        if (output.startsWith("\\\\.\\DISPLAY")) hostSelectedDisplayId = output;
      }
      return {
        hostDeviceId: s.deviceId,
        hostname: os.hostname(),
        requirePassword: s.requireAccessPassword,
        privacyActive: privacyScreen.isActive(),
        muted,
        autoLockOnDisconnect: s.autoLockOnDisconnect,
        apolloPort: hostInfoCache.apolloPort,
        apolloReady: hostInfoCache.apolloRunning && apolloAuthReady,
        capabilities: [
          "displays",
          "audio_mute",
          "privacy_screen",
          "system_actions",
          "temp_password",
          "files",
          "clipboard",
        ],
      };
    },
    listDisplays: async () => getCachedHostDisplays(),
    selectDisplay: async (displayId) => {
      hostSelectedDisplayId = displayId;
      cachedHostDisplays = null;
      const s = store.get();
      let message: string | undefined;
      if (s.apolloUser && s.apolloPass) {
        const switchResult = await setApolloOutputName(displayId, s.apolloUser, s.apolloPass).catch(
          (err: unknown) => ({
            ok: false,
            message: err instanceof Error ? err.message : "屏幕输出切换失败",
          }),
        );
        if (!switchResult.ok) {
          message = switchResult.message || "屏幕输出切换失败";
        }
      }
      return {
        ok: !message,
        selectedDisplayId: displayId,
        restartRecommended: !message,
        displays: await getCachedHostDisplays(),
        message,
      };
    },
    getMuteState: async () => ({ muted: await getHostMasterMute() }),
    setMuteState: async (muted) => {
      if (muted && hostSessionOrigMuted === null) {
        hostSessionOrigMuted = await getHostMasterMute().catch(() => false);
      }
      const next = await setHostMasterMute(muted);
      return { muted: next };
    },
    getPrivacyState: async () => ({
      active: privacyScreen.isActive(),
      supported: privacyScreen.isSupported(),
    }),
    setPrivacyState: async (active) => {
      const result = active ? privacyScreen.enable(() => emitState()) : privacyScreen.disable();
      emitState();
      return result;
    },
    runSystemAction: async (action) => runHostSystemAction(action),
    onSessionEnded: async (opts) => {
      let muteRestored = false;
      if (hostSessionOrigMuted !== null) {
        const restoreTarget = hostSessionOrigMuted;
        hostSessionOrigMuted = null;
        muteRestored = await setHostMasterMute(restoreTarget)
          .then((muted) => muted === restoreTarget)
          .catch(() => false);
      }

      let privacyRestored = false;
      if (privacyScreen.isActive()) {
        privacyScreen.disable();
        privacyRestored = true;
        emitState();
      }

      const autoLock = Boolean(opts?.autoLock) || store.get().autoLockOnDisconnect;
      let locked = false;
      if (autoLock) {
        const result = await runHostSystemAction("lock").catch(() => ({ ok: false, message: "" }));
        locked = result.ok;
      }
      return { locked, muteRestored, privacyRestored };
    },
  },
});

async function syncHostAgentServer(): Promise<void> {
  const shouldRun = store.get().isHost;
  if (shouldRun && !agentServerRunning) {
    try {
      await hostAgentServer.start("0.0.0.0", DEFAULT_AGENT_PORT);
      agentServerRunning = true;
    } catch {
      agentServerRunning = false;
    }
    return;
  }
  if (!shouldRun && agentServerRunning) {
    await hostAgentServer.stop().catch(() => {});
    agentServerRunning = false;
  }
}

function pushPairLog(line: string): void {
  pairLogs.unshift(`${new Date().toLocaleTimeString()} ${line}`);
  if (pairLogs.length > 20) pairLogs.pop();
}

function getDefaultMeshCidr(): string {
  return bootstrapCache?.mesh_cidr || store.getExternalConfig().meshCidr || "10.144.0.0/24";
}

function buildRuntimeState(): AppRuntimeState {
  const s = store.get();
  const settings = store.getPublicSettings();
  if (s.requireAccessPassword) {
    ensureValidTempPassword();
    settings.tempAccessPassword = tempAccessPassword;
    settings.tempAccessPasswordExpiresAt = tempAccessPasswordExpiresAt;
  } else {
    settings.tempAccessPassword = "";
    settings.tempAccessPasswordExpiresAt = 0;
  }
  return {
    authenticated: Boolean(s.token && s.user),
    user: s.user,
    bootstrap: bootstrapCache,
    settings,
    easytier: easyTier.getStatus(),
    host: {
      ...hostInfoCache,
      provisionStage,
      provisionMessage,
      apolloAuthReady,
      agentRunning: agentServerRunning,
      agentPort: hostAgentServer.getPort() || DEFAULT_AGENT_PORT,
    },
    devices: devicesCache,
    lastPairLogs: [...pairLogs],
  };
}

function emitState(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("app:stateChanged", buildRuntimeState());
  }
}

async function autoProvisionHostIfNeeded(forceManualRetry = false): Promise<void> {
  if (forceManualRetry) {
    autoHealExhausted = false;
  }
  if (provisionInFlight) return provisionInFlight;
  provisionInFlight = (async () => {
    const s = store.get();
    if (!s.token || !s.isHost) {
      provisionStage = "idle";
      provisionMessage = "";
      emitState();
      return;
    }

    try {
      hostInfoCache = await collectHostInfo();
      if (!hostInfoCache.isElevated) {
        provisionStage = "needs_admin";
        provisionMessage = "请点击顶部【一键授权启用】，系统将自动完成全部配置";
        emitState();
        return;
      }

      if (!hostInfoCache.firewallConfigured) {
        provisionStage = "configuring_firewall";
        provisionMessage = "正在自动配置虚拟内网防火墙白名单...";
        emitState();
        await configureWindowsFirewall(getDefaultMeshCidr(), true);
        hostInfoCache = await collectHostInfo({ forceFirewallCheck: true });
      }

      if (!hostInfoCache.apolloInstalled) {
        provisionStage = "installing_apollo";
        provisionMessage = "正在后台静默部署高清串流引擎（约 15 秒）...";
        emitState();
        await silentInstallApollo();
        hostInfoCache = await collectHostInfo();
      }

      if (!hostInfoCache.apolloRunning) {
        provisionStage = "starting_apollo";
        provisionMessage = "正在拉起高清串流引擎...";
        emitState();
        await ensureApolloServiceRunning();
        hostInfoCache = await collectHostInfo();
      }

      if (!hostInfoCache.apolloRunning) {
        provisionStage = "error";
        provisionMessage = "高清串流引擎安装完成但服务未响应，请点击重试";
        autoHealExhausted = true;
        emitState();
        return;
      }

      provisionStage = "initializing_apollo";
      provisionMessage = "正在自动同步零配置握手凭据...";
      emitState();
      const latest = store.get();
      const cred = await ensureApolloCredentials(latest.apolloUser, latest.apolloPass, true, 47990, {
        allowSilentReinstall: true,
        onStage: (stage, msg) => {
          provisionStage = stage;
          provisionMessage = msg;
          emitState();
        },
      });
      if (cred.ok) {
        if (cred.user !== latest.apolloUser || cred.pass !== latest.apolloPass) {
          store.update({ apolloUser: cred.user, apolloPass: cred.pass });
        }
        hostInfoCache = await collectHostInfo({ forceFirewallCheck: true });
        if (!hostInfoCache.firewallConfigured) {
          await configureWindowsFirewall(getDefaultMeshCidr(), true);
          hostInfoCache = await collectHostInfo({ forceFirewallCheck: true });
        }
        if (
          app.isPackaged &&
          latest.autoStart &&
          hostInfoCache.isElevated &&
          !hostInfoCache.bootTunnelConfigured &&
          bootstrapCache
        ) {
          const bootOk = await configureBootTunnelTask(true, true, bootstrapCache).catch(() => false);
          if (bootOk) {
            hostInfoCache.bootTunnelConfigured = true;
          }
        }
        lastApolloPermSyncAt = 0;
        apolloAuthReady = true;
        autoHealExhausted = false;
        provisionStage = "ready";
        provisionMessage = "一切就绪，可随时接受其他设备一键远程";
      } else {
        apolloAuthReady = false;
        autoHealExhausted = true;
        provisionStage = "error";
        provisionMessage = cred.message;
      }
    } catch (err) {
      autoHealExhausted = true;
      provisionStage = "error";
      provisionMessage = err instanceof Error ? err.message : String(err);
    }
    emitState();
  })().finally(() => {
    provisionInFlight = null;
  });
  return provisionInFlight;
}

/**
 * Apollo only persists a client certificate after the PIN handshake completes,
 * so grant permissions a few times after pairing to cover the window in which
 * Moonlight finishes writing its certificate to disk.
 */
function scheduleGrantApolloPermissions(): void {
  for (const delayMs of [1500, 4000, 8000]) {
    const timer = setTimeout(() => {
      const latest = store.get();
      if (!latest.token || !latest.isHost || !latest.apolloUser || !latest.apolloPass) return;
      void grantAllApolloClientPermissions(latest.apolloUser, latest.apolloPass)
        .then((res) => {
          if (res.updated > 0) {
            pushPairLog(`已自动补全 ${res.updated} 个客户端的键鼠与启动权限`);
            emitState();
          }
        })
        .catch(() => {});
    }, delayMs);
    timer.unref?.();
  }
}

async function processPendingPairs(pending: PairRequestItem[]): Promise<void> {
  for (const req of pending) {
    if (activePairReqIds.has(req.id)) continue;
    activePairReqIds.add(req.id);
    try {
      let s = store.get();
      if (!apolloAuthReady || !s.apolloUser || !s.apolloPass) {
        const cred = await ensureApolloCredentials(s.apolloUser, s.apolloPass, hostInfoCache.isElevated);
        if (cred.ok) {
          store.update({ apolloUser: cred.user, apolloPass: cred.pass });
          apolloAuthReady = true;
          s = store.get();
        }
      }

      let res = await submitApolloPin(req.pin, s.apolloUser, s.apolloPass, req.client_name);
      if (!res.ok && res.message.includes("status=false")) {
        await new Promise((r) => setTimeout(r, 700));
        res = await submitApolloPin(req.pin, s.apolloUser, s.apolloPass, req.client_name);
      }
      if (!res.ok && (res.message.includes("307") || res.message.includes("401")) && hostInfoCache.isElevated) {
        const healed = await ensureApolloCredentials("", "", true);
        if (healed.ok) {
          store.update({ apolloUser: healed.user, apolloPass: healed.pass });
          apolloAuthReady = true;
          res = await submitApolloPin(req.pin, healed.user, healed.pass, req.client_name);
        }
      }

      await client.resolvePairRequest(req.id, res.ok ? "approved" : "failed", res.message);
      pushPairLog(`静默握手 [${req.client_name}] PIN=${req.pin}: ${res.message}`);
      lastPairActivityAt = Date.now();
      if (res.ok) {
        scheduleGrantApolloPermissions();
      }
    } catch {
      // ignore transient resolution errors so loop keeps running
    } finally {
      activePairReqIds.delete(req.id);
    }
  }
}

export interface SyncAllOptions {
  force?: boolean;
  forceFirewallCheck?: boolean;
}

async function syncAll(opts: SyncAllOptions = {}): Promise<void> {
  const force = Boolean(opts.force);
  hostInfoCache = await collectHostInfo({
    forceFirewallCheck: Boolean(opts.forceFirewallCheck || force),
    forceUuCheck: force,
    forceBootTunnelCheck: force,
  });
  await syncHostAgentServer();
  const s = store.get();
  if (!s.token) {
    emitState();
    return;
  }

  try {
    const now = Date.now();
    if (force || !s.user || now - lastMeSyncAt >= ME_SYNC_TTL_MS) {
      const me = await client.me();
      store.update({ user: me.user });
      lastMeSyncAt = Date.now();
    }

    if (force || !bootstrapCache || now - lastBootstrapSyncAt >= BOOTSTRAP_SYNC_TTL_MS) {
      bootstrapCache = await client.bootstrap(s.deviceId, os.hostname(), process.platform);
      lastBootstrapSyncAt = Date.now();
    }

    await easyTier.ensureStarted(bootstrapCache, hostInfoCache.isElevated);
    if (
      easyTier.consumeMachineConfigChanged() &&
      easyTier.getStatus().externalService &&
      hostInfoCache.isElevated
    ) {
      await restartBootTunnelTask(true);
    }

    if (hostInfoCache.rustdeskInstalled) {
      const sig = [
        bootstrapCache.rustdesk.id_server,
        bootstrapCache.rustdesk.relay_server,
        bootstrapCache.rustdesk.api_server,
        bootstrapCache.rustdesk.public_key,
      ].join("|");
      if (sig !== lastRustDeskConfigSig) {
        configureRustDeskClient(bootstrapCache);
        lastRustDeskConfigSig = sig;
      }
    }

    if (s.isHost) {
      if (hostInfoCache.apolloRunning && !apolloAuthReady && s.apolloUser && s.apolloPass) {
        apolloAuthReady = (await checkApolloAuthStatus(s.apolloUser, s.apolloPass)) === "ok";
      }
      const hostNeedsProvision =
        !hostInfoCache.apolloInstalled ||
        !hostInfoCache.apolloRunning ||
        !hostInfoCache.firewallConfigured ||
        !apolloAuthReady;

      if (!hostNeedsProvision && easyTier.getStatus().running) {
        autoHealExhausted = false;
        provisionStage = "ready";
        provisionMessage = "一切就绪，可随时接受其他设备一键远程";
      } else if (!hostInfoCache.isElevated) {
        provisionStage = "needs_admin";
        provisionMessage = "请点击顶部【一键授权启用】，系统将自动完成全部配置";
      } else if (hostNeedsProvision) {
        if (!autoHealExhausted && !provisionInFlight) {
          void autoProvisionHostIfNeeded(false);
        }
      }
    } else {
      provisionStage = "idle";
      provisionMessage = "";
    }

    // Throttled self-heal: refresh Apollo client permissions once per 10 minutes
    // (initial pairing still triggers immediate burst grants via scheduleGrantApolloPermissions).
    if (
      s.isHost &&
      hostInfoCache.isElevated &&
      hostInfoCache.apolloRunning &&
      apolloAuthReady &&
      s.apolloUser &&
      s.apolloPass &&
      (force || Date.now() - lastApolloPermSyncAt >= APOLLO_PERM_SYNC_INTERVAL_MS)
    ) {
      lastApolloPermSyncAt = Date.now();
      void grantAllApolloClientPermissions(s.apolloUser, s.apolloPass).catch(() => {});
    }

    const peers = easyTier.getStatus().peers;
    sessionManager.updateTelemetry(peers);
    const activeRelay = peers.find((p) => p.cost === "p2p" || p.cost.startsWith("relay"));
    const routeType = activeRelay ? activeRelay.cost : easyTier.getStatus().running ? "local" : "offline";
    const latencyMs = activeRelay ? activeRelay.latencyMs : null;

    const latestSettings = store.get();
    const hb = await client.heartbeat({
      device_id: latestSettings.deviceId,
      name: os.hostname(),
      os: process.platform,
      mac_address: hostInfoCache.macAddress,
      broadcast_ip: hostInfoCache.broadcastIp,
      cpu: hostInfoCache.cpu,
      gpu: hostInfoCache.gpu,
      rustdesk_id: hostInfoCache.rustdeskId,
      apollo_ready: hostInfoCache.apolloRunning && (apolloAuthReady || !latestSettings.isHost),
      apollo_port: hostInfoCache.apolloPort,
      route_type: routeType,
      latency_ms: latencyMs,
      is_host: latestSettings.isHost,
      has_access_password: latestSettings.requireAccessPassword,
      agent_port: hostAgentServer.getPort() || DEFAULT_AGENT_PORT,
    });
    lastPairCheckAt = Date.now();

    if (latestSettings.isHost && latestSettings.autoApprovePair && hb.pending_pairs.length > 0) {
      lastPairActivityAt = Date.now();
      await processPendingPairs(hb.pending_pairs);
    }

    const listResp = await client.listDevices();
    devicesCache = enrichDevicesWithEasyTierPeers(listResp.devices, peers);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("unauthorized") || msg.includes("401")) {
      store.update({ token: "", user: null });
      bootstrapCache = null;
      devicesCache = [];
      lastMeSyncAt = 0;
      lastBootstrapSyncAt = 0;
      lastApolloPermSyncAt = 0;
      lastPairCheckAt = 0;
      lastPairActivityAt = 0;
      apolloAuthReady = false;
      easyTier.stop();
    }
  }
  emitState();
}

function startHeartbeatLoop(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    void syncAll();
  }, 15_000);
}

function stopPairPoll(): void {
  if (pairPollTimer) {
    clearTimeout(pairPollTimer);
    pairPollTimer = null;
  }
}

function schedulePairPoll(): void {
  stopPairPoll();
  if (pairPollStopped || isQuitting) return;
  const s = store.get();
  if (!s.token) return;

  const windowVisible = Boolean(
    mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized(),
  );
  const delayMs = computePairPollDelayMs({
    windowVisible,
    now: Date.now(),
    lastPairActivityAt,
  });

  pairPollTimer = setTimeout(async () => {
    pairPollTimer = null;
    const cur = store.get();
    if (
      !pairPollStopped &&
      !isQuitting &&
      cur.token &&
      cur.isHost &&
      cur.autoApprovePair &&
      hostInfoCache.apolloRunning &&
      apolloAuthReady &&
      Date.now() - lastPairCheckAt >= 2_000
    ) {
      lastPairCheckAt = Date.now();
      try {
        const { pending_pairs } = await client.getPendingPairs(cur.deviceId);
        if (pending_pairs.length > 0) {
          lastPairActivityAt = Date.now();
          await processPendingPairs(pending_pairs);
          emitState();
        }
      } catch {
        // ignore transient network glitches during fast poll
      }
    }
    schedulePairPoll();
  }, delayMs);
  pairPollTimer.unref?.();
}

function startPairFastPoll(): void {
  pairPollStopped = false;
  schedulePairPoll();
}

function getIconPath(): string {
  const candidates = [
    path.join(process.resourcesPath || "", "icon.png"),
    path.join(process.resourcesPath || "", "..", "build", "icon.png"),
    path.resolve(__dirname, "../build/icon.png"),
    path.resolve(__dirname, "../../build/icon.png"),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[3];
}

function createWindow(): void {
  const icon = nativeImage.createFromPath(getIconPath());
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0b0d13",
    title: "SilkWarp",
    icon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.resolve(__dirname, "../dist/index.html"));
  }

  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  const onVisibilityChange = () => {
    if (!pairPollStopped && !isQuitting && store.get().token) {
      schedulePairPoll();
    }
  };
  mainWindow.on("show", onVisibilityChange);
  mainWindow.on("restore", onVisibilityChange);
  mainWindow.on("hide", onVisibilityChange);
  mainWindow.on("minimize", onVisibilityChange);
}

function setupTray(): void {
  const icon = nativeImage.createFromPath(getIconPath()).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("SilkWarp 远程桌面与低延迟串流");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 SilkWarp", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { type: "separator" },
      {
        label: "彻底退出",
        click: () => {
          isQuitting = true;
          easyTier.stop();
          app.quit();
        },
      },
    ]),
  );
  tray.on("double-click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

async function acquireSingleInstanceLockWithRetry(): Promise<boolean> {
  const isRelaunch = process.argv.includes("--relaunch-elevated");
  const attempts = isRelaunch ? 16 : 3;
  const delayMs = isRelaunch ? 250 : 200;
  for (let i = 0; i < attempts; i++) {
    if (app.requestSingleInstanceLock()) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

app.whenReady().then(async () => {
  const gotLock = await acquireSingleInstanceLockWithRetry();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  createWindow();
  setupTray();
  await syncAll({ force: true, forceFirewallCheck: true });
  startHeartbeatLoop();
  startPairFastPoll();
});

app.on("before-quit", () => {
  isQuitting = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  pairPollStopped = true;
  stopPairPoll();
  syncSessionTelemetryLoop(false);
  void sessionManager.disconnect();
  syncSessionGlobalShortcuts(false);
  easyTier.stop();
  privacyScreen.dispose();
  void hostAgentServer.stop().catch(() => {});
  authManager.revokeAllTokens();
  agentServerRunning = false;
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

// --- IPC Handlers ---
ipcMain.handle("app:getState", async () => buildRuntimeState());

ipcMain.handle("app:refresh", async () => {
  await syncAll({ force: true, forceFirewallCheck: true });
  return buildRuntimeState();
});

ipcMain.handle("auth:login", async (_evt, args: { apiUrl: string; username: string; password: string }) => {
  const cleanUrl = args.apiUrl.trim().replace(/\/+$/, "");
  if (!cleanUrl || !/^https?:\/\//i.test(cleanUrl)) {
    throw new Error("请先在下方填写有效的控制中心地址（以 http:// 或 https:// 开头），或在目录中放置 silkwarp.config.json。");
  }
  store.update({ apiUrl: cleanUrl });
  const s = store.get();
  const res = await client.login(args.username.trim(), args.password, s.deviceId);
  store.update({ token: res.token, user: res.user });
  await syncAll({ force: true, forceFirewallCheck: true });
  startPairFastPoll();
  return buildRuntimeState();
});

ipcMain.handle("auth:logout", async () => {
  try {
    await client.logout();
  } catch {
    // ignore
  }
  pairPollStopped = true;
  stopPairPoll();
  store.update({ token: "", user: null });
  bootstrapCache = null;
  devicesCache = [];
  lastMeSyncAt = 0;
  lastBootstrapSyncAt = 0;
  lastApolloPermSyncAt = 0;
  lastPairCheckAt = 0;
  lastPairActivityAt = 0;
  apolloAuthReady = false;
  provisionStage = "idle";
  provisionMessage = "";
  easyTier.stop();
  return buildRuntimeState();
});

ipcMain.handle("settings:updatePreset", async (_evt, preset: StreamPreset) => {
  const next = await sessionManager.updateOptions(preset);
  if (!next) {
    store.update({ preset: normalizeStreamPreset(preset) });
  }
  return buildRuntimeState();
});

// --- Session IPC ---
ipcMain.handle("app:getLocalDisplayResolution", async () => sessionManager.getLocalDisplayResolution());
ipcMain.handle("session:getState", async () => sessionManager.getState());
ipcMain.handle("session:updateOptions", async (_evt, patch: Partial<StreamPreset>) =>
  sessionManager.updateOptions(patch),
);
ipcMain.handle(
  "session:setResolutionMode",
  async (_evt, args: { mode: ResolutionMode; fixedResolution?: string }) =>
    sessionManager.setResolutionMode(args.mode, args.fixedResolution),
);
ipcMain.handle("session:fitWindow", async () => sessionManager.fitToWindow());
ipcMain.handle("session:toggleFullscreen", async () => sessionManager.toggleFullscreen());
ipcMain.handle("session:sendHotkey", async (_evt, action: SessionHotkeyAction) => {
  sessionManager.sendHotkey(action);
});
ipcMain.handle("session:focusRemote", async () => {
  sessionManager.focusRemoteWindow();
});
ipcMain.handle("session:switchOfficeMode", async () => {
  if (!bootstrapCache) throw new Error("请先登录账号");
  await sessionManager.switchToOfficeMode(bootstrapCache);
});
ipcMain.handle("session:disconnect", async () => {
  await sessionManager.disconnect();
});
ipcMain.handle("session:setBarExpanded", async (_evt, expanded: boolean) => {
  sessionManager.setBarExpanded(Boolean(expanded));
});
ipcMain.handle("session:setBarOffset", async (_evt, deltaX: number) => {
  sessionManager.nudgeBarOffset(Number(deltaX) || 0);
});

// --- Stage 2 host agent IPC ---
ipcMain.handle("session:refreshDisplays", async () => sessionManager.refreshDisplays());
ipcMain.handle("session:selectDisplay", async (_evt, displayId: string) =>
  sessionManager.selectDisplay(String(displayId || "")),
);
ipcMain.handle("session:setHostMute", async (_evt, muted: boolean) =>
  sessionManager.setHostMute(Boolean(muted)),
);
ipcMain.handle("session:setPrivacy", async (_evt, active: boolean) =>
  sessionManager.setPrivacy(Boolean(active)),
);
ipcMain.handle("session:runSystemAction", async (_evt, action: SystemActionType) =>
  sessionManager.runSystemAction(action),
);
ipcMain.handle("session:setAutoLock", async (_evt, enabled: boolean) =>
  sessionManager.setAutoLockOnDisconnect(Boolean(enabled)),
);

// --- Stage 3 session file / clipboard IPC ---
ipcMain.handle("session:listRemoteFiles", async (_evt, dirPath?: string) =>
  sessionManager.listRemoteFiles(typeof dirPath === "string" && dirPath.trim() ? dirPath : undefined),
);

ipcMain.handle(
  "session:uploadFiles",
  async (_evt, args: { localPaths?: string[]; targetDir?: string } = {}) =>
    sessionManager.uploadFiles(
      Array.isArray(args.localPaths) ? args.localPaths : [],
      typeof args.targetDir === "string" && args.targetDir.trim() ? args.targetDir : undefined,
    ),
);

ipcMain.handle("session:pickAndUploadFiles", async (_evt, targetDir?: string) => {
  const picked = await dialog.showOpenDialog({
    title: "选择要上传到被控端的文件",
    properties: ["openFile", "multiSelections"],
  });
  if (picked.canceled || picked.filePaths.length === 0) return [] as TransferTaskItem[];
  return sessionManager.uploadFiles(
    picked.filePaths,
    typeof targetDir === "string" && targetDir.trim() ? targetDir : undefined,
  );
});

ipcMain.handle(
  "session:downloadRemoteFile",
  async (_evt, args: { remotePath?: string; suggestedName?: string } = {}) => {
    const remotePath = typeof args.remotePath === "string" ? args.remotePath.trim() : "";
    if (!remotePath) throw new Error("缺少远端文件路径");
    const suggestedName =
      typeof args.suggestedName === "string" && args.suggestedName.trim()
        ? args.suggestedName.trim()
        : path.win32.basename(remotePath);
    const saved = await dialog.showSaveDialog({
      title: "另存远端文件",
      defaultPath: path.join(app.getPath("downloads"), suggestedName),
    });
    if (saved.canceled || !saved.filePath) return null as TransferTaskItem | null;
    return sessionManager.downloadRemoteFile(remotePath, saved.filePath);
  },
);

ipcMain.handle("session:setClipboardSync", async (_evt, enabled: boolean) =>
  sessionManager.setClipboardSync(Boolean(enabled)),
);

ipcMain.handle("session:syncClipboardNow", async () => sessionManager.syncClipboardNow());

// --- Stage 3 device-level transfer IPC (works without a video session) ---

/**
 * Authenticates a Host Companion Agent session for a device without launching
 * Apollo/Moonlight, so the DevicesView file transfer modal can browse and
 * exchange files on its own.
 */
ipcMain.handle(
  "device:prepareAgent",
  async (
    _evt,
    device: DeviceInfo,
    opts?: { password?: string; rememberPassword?: boolean },
  ): Promise<DeviceAgentSessionResult> => {
    if (!device || !device.mesh_ip) {
      return { ok: false, message: "设备信息不完整", agentPort: DEFAULT_AGENT_PORT, agentToken: "" };
    }
    const session = await ensureRemoteAgentSession(device, opts);
    if (!session.ok) {
      return {
        ok: false,
        needsPassword: session.needsPassword,
        retryAfterSec: session.retryAfterSec,
        message: session.message,
        agentPort: device.agent_port || DEFAULT_AGENT_PORT,
        agentToken: "",
      };
    }
    if (!session.agentConnected || !session.token) {
      return {
        ok: false,
        message: "目标电脑未开启文件传输服务，请确认对方 SilkWarp 已开启受控并升级到最新版本。",
        agentPort: session.port,
        agentToken: "",
      };
    }
    return {
      ok: true,
      message: "已连接文件通道",
      agentPort: session.port,
      agentToken: session.token,
    };
  },
);

interface TransferTargetArgs {
  meshIp?: string;
  port?: number;
  token?: string;
  dirPath?: string;
  localPaths?: string[];
  targetDir?: string;
  remotePath?: string;
  suggestedName?: string;
}

function resolveTransferTarget(args: TransferTargetArgs): { host: string; port: number; token: string } {
  const host = typeof args.meshIp === "string" ? args.meshIp.trim() : "";
  const token = typeof args.token === "string" ? args.token.trim() : "";
  const port = Number(args.port) || DEFAULT_AGENT_PORT;
  if (!host) throw new Error("缺少目标主机 Mesh IP");
  if (!token) throw new Error("文件通道未授权，请重新验证访问密码");
  return { host, port, token };
}

ipcMain.handle("transfer:listFiles", async (_evt, args: TransferTargetArgs = {}): Promise<RemoteFileListing> => {
  const target = resolveTransferTarget(args);
  return agentClient.listRemoteFiles(
    target.host,
    target.port,
    target.token,
    typeof args.dirPath === "string" && args.dirPath.trim() ? args.dirPath : undefined,
  );
});

ipcMain.handle(
  "transfer:uploadFiles",
  async (_evt, args: TransferTargetArgs = {}): Promise<TransferTaskItem[]> => {
    const target = resolveTransferTarget(args);
    const paths = (Array.isArray(args.localPaths) ? args.localPaths : [])
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
    if (paths.length === 0) return [];
    const targetDir =
      typeof args.targetDir === "string" && args.targetDir.trim() ? args.targetDir : undefined;

    const results: TransferTaskItem[] = [];
    for (const localPath of paths) {
      const filename = path.basename(localPath) || localPath;
      const task: TransferTaskItem = {
        id: crypto.randomUUID(),
        direction: "upload",
        filename,
        transferred: 0,
        total: 0,
        status: "running",
        localPath,
      };
      try {
        task.total = fs.statSync(localPath).size;
        const result = await agentClient.uploadFileStream(
          target.host,
          target.port,
          target.token,
          localPath,
          { targetDir },
        );
        task.status = "done";
        task.transferred = result.size;
        task.total = result.size;
        task.filename = result.filename;
        task.remotePath = result.path;
      } catch (err) {
        task.status = "error";
        task.message = err instanceof Error ? err.message : String(err);
      }
      results.push(task);
    }
    return results;
  },
);

ipcMain.handle(
  "transfer:pickAndUploadFiles",
  async (_evt, args: TransferTargetArgs = {}): Promise<TransferTaskItem[]> => {
    const target = resolveTransferTarget(args);
    const picked = await dialog.showOpenDialog({
      title: "选择要上传到被控端的文件",
      properties: ["openFile", "multiSelections"],
    });
    if (picked.canceled || picked.filePaths.length === 0) return [];
    const targetDir =
      typeof args.targetDir === "string" && args.targetDir.trim() ? args.targetDir : undefined;

    const results: TransferTaskItem[] = [];
    for (const localPath of picked.filePaths) {
      const filename = path.basename(localPath) || localPath;
      const task: TransferTaskItem = {
        id: crypto.randomUUID(),
        direction: "upload",
        filename,
        transferred: 0,
        total: 0,
        status: "running",
        localPath,
      };
      try {
        task.total = fs.statSync(localPath).size;
        const result = await agentClient.uploadFileStream(
          target.host,
          target.port,
          target.token,
          localPath,
          { targetDir },
        );
        task.status = "done";
        task.transferred = result.size;
        task.total = result.size;
        task.filename = result.filename;
        task.remotePath = result.path;
      } catch (err) {
        task.status = "error";
        task.message = err instanceof Error ? err.message : String(err);
      }
      results.push(task);
    }
    return results;
  },
);

ipcMain.handle(
  "transfer:downloadFile",
  async (_evt, args: TransferTargetArgs = {}): Promise<TransferTaskItem | null> => {
    const target = resolveTransferTarget(args);
    const remotePath = typeof args.remotePath === "string" ? args.remotePath.trim() : "";
    if (!remotePath) throw new Error("缺少远端文件路径");
    const suggestedName =
      typeof args.suggestedName === "string" && args.suggestedName.trim()
        ? args.suggestedName.trim()
        : path.win32.basename(remotePath);
    const saved = await dialog.showSaveDialog({
      title: "另存远端文件",
      defaultPath: path.join(app.getPath("downloads"), suggestedName),
    });
    if (saved.canceled || !saved.filePath) return null;

    const task: TransferTaskItem = {
      id: crypto.randomUUID(),
      direction: "download",
      filename: path.basename(saved.filePath),
      transferred: 0,
      total: 0,
      status: "running",
      remotePath,
      localPath: saved.filePath,
    };
    try {
      const result = await agentClient.downloadFileStream(
        target.host,
        target.port,
        target.token,
        remotePath,
        saved.filePath,
      );
      task.status = "done";
      task.transferred = result.size;
      task.total = result.size;
      task.localPath = result.path;
    } catch (err) {
      task.status = "error";
      task.message = err instanceof Error ? err.message : String(err);
    }
    return task;
  },
);

ipcMain.handle(
  "host:setAccessPassword",
  async (
    _evt,
    payload: {
      requireAccessPassword?: boolean;
      permanentPassword?: string;
      clearPermanentPassword?: boolean;
      allowSameAccountBypass?: boolean;
      autoLockOnDisconnect?: boolean;
    } = {},
  ) => {
    const patch: Record<string, unknown> = {};
    const newPassword = typeof payload.permanentPassword === "string" ? payload.permanentPassword.trim() : "";
    if (newPassword && newPassword.length < 4) {
      throw new Error("固定访问密码至少需要 4 个字符");
    }
    if (newPassword) {
      patch.accessPasswordHash = hashAccessPassword(newPassword);
      authManager.revokeAllTokens();
    }
    if (payload.clearPermanentPassword) {
      patch.accessPasswordHash = "";
      authManager.revokeAllTokens();
    }
    if (typeof payload.requireAccessPassword === "boolean") {
      patch.requireAccessPassword = payload.requireAccessPassword;
      if (!payload.requireAccessPassword) {
        tempAccessPassword = "";
        tempAccessPasswordExpiresAt = 0;
        authManager.revokeAllTokens();
      }
    }
    if (typeof payload.allowSameAccountBypass === "boolean") {
      patch.allowSameAccountBypass = payload.allowSameAccountBypass;
    }
    if (typeof payload.autoLockOnDisconnect === "boolean") {
      patch.autoLockOnDisconnect = payload.autoLockOnDisconnect;
    }
    if (Object.keys(patch).length > 0) {
      store.update(patch);
    }
    if (store.get().requireAccessPassword) {
      ensureValidTempPassword();
    }
    await syncHostAgentServer();
    await syncAll();
    return buildRuntimeState();
  },
);

ipcMain.handle("host:rotateTempPassword", async () => {
  tempAccessPassword = generateTempAccessPassword();
  tempAccessPasswordExpiresAt = Date.now() + TEMP_PASSWORD_TTL_MS;
  emitState();
  return buildRuntimeState();
});

ipcMain.handle("host:updateSettings", async (_evt, patch: Record<string, unknown>) => {
  store.update(patch);
  if ("apolloUser" in patch || "apolloPass" in patch || patch.isHost === true) {
    apolloAuthReady = false;
    autoHealExhausted = false;
  }
  if (typeof patch.autoStart === "boolean") {
    await configureAutoStartTask(patch.autoStart, hostInfoCache.isElevated, bootstrapCache);
  }
  if (patch.isHost === true && hostInfoCache.isElevated && !hostInfoCache.firewallConfigured) {
    try {
      await configureWindowsFirewall(getDefaultMeshCidr(), true);
    } catch {
      // firewall errors remain visible in host hardware status
    }
  }
  if (store.get().isHost && hostInfoCache.isElevated && ("apolloUser" in patch || "apolloPass" in patch || patch.isHost === true)) {
    void autoProvisionHostIfNeeded(true);
  }
  await syncHostAgentServer();
  await syncAll({ force: true, forceFirewallCheck: true });
  return buildRuntimeState();
});

ipcMain.handle("easytier:start", async () => {
  if (bootstrapCache) {
    hostInfoCache = await collectHostInfo({ forceFirewallCheck: true, forceBootTunnelCheck: true });
    await easyTier.ensureStarted(bootstrapCache, hostInfoCache.isElevated);
  }
  return buildRuntimeState();
});

ipcMain.handle("app:relaunchAdmin", async () => {
  if (process.platform !== "win32") return;
  const sq = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const argsList = app.isPackaged
    ? `@('--relaunch-elevated')`
    : `@(${sq(app.getAppPath())}, '--relaunch-elevated')`;
  const psCmd = `$p = Start-Process -FilePath ${sq(process.execPath)} -ArgumentList ${argsList} -Verb RunAs -PassThru; if (-not $p) { exit 1 }; $p.Id`;

  app.releaseSingleInstanceLock();
  try {
    await execFileAsync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCmd],
      { timeout: 60_000, windowsHide: true },
    );
  } catch {
    app.requestSingleInstanceLock();
    isQuitting = false;
    throw new Error("未获得管理员授权（已取消 UAC）。您也可以右键桌面 SilkWarp 图标选择【以管理员身份运行】。");
  }

  isQuitting = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  pairPollStopped = true;
  stopPairPoll();
  syncSessionTelemetryLoop(false);
  void sessionManager.disconnect();
  easyTier.stop();
  tray?.destroy();
  setTimeout(() => app.exit(0), 150);
});

ipcMain.handle("host:retryProvision", async () => {
  await autoProvisionHostIfNeeded(true);
  await syncAll({ force: true, forceFirewallCheck: true });
  return buildRuntimeState();
});

ipcMain.handle("host:configureFirewall", async () => {
  const cidr = getDefaultMeshCidr();
  await configureWindowsFirewall(cidr, hostInfoCache.isElevated);
  invalidateFirewallCache();
  hostInfoCache = await collectHostInfo({ forceFirewallCheck: true });
  return buildRuntimeState();
});

ipcMain.handle("host:configureRustDesk", async () => {
  if (!bootstrapCache) throw new Error("请先登录账号");
  return configureRustDeskClient(bootstrapCache);
});

ipcMain.handle("host:installApollo", async () => downloadAndRunApolloInstaller());
ipcMain.handle("host:installRustDesk", async () => downloadAndRunRustDeskInstaller());
ipcMain.handle("app:openExternal", async (_evt, url: string) => {
  await shell.openExternal(url);
});

function assertInputAllowed(
  device: DeviceInfo,
  permInfo: { paired: boolean; permission: number | null; hasInput: boolean } | null,
): void {
  if (permInfo && permInfo.paired && !permInfo.hasInput && permInfo.permission !== null) {
    throw new Error(
      `目标电脑「${device.name}」暂未授予本机键鼠控制权限，请在对方 SilkWarp【本机受控】页面刷新状态或重新配对后重试。`,
    );
  }
}

async function assertRemoteInputPermission(device: DeviceInfo): Promise<void> {
  const permInfo = await probeRemoteApolloPermission(device.mesh_ip, device.apollo_port || 47984);
  assertInputAllowed(device, permInfo);
}

type AgentSessionResult =
  | { ok: true; agentConnected: boolean; port: number; token: string }
  | { ok: false; needsPassword?: boolean; retryAfterSec?: number; message: string };

/**
 * Establishes a remote SilkWarp security & file-channel bearer session in one RTT.
 *
 * A host without the enhanced agent (or an unreachable optional agent when no password
 * is configured) degrades gracefully to a stream-only session; a host that advertises a
 * password returns a structured `needsPassword` result for the prompt dialog.
 */
async function ensureRemoteAgentSession(
  device: DeviceInfo,
  opts?: { password?: string; rememberPassword?: boolean },
): Promise<AgentSessionResult> {
  const port = device.agent_port || DEFAULT_AGENT_PORT;
  const s = store.get();
  const explicitPassword = typeof opts?.password === "string" ? opts.password : "";
  const savedPassword = store.getSavedDevicePassword(device.id);
  const password = explicitPassword || savedPassword;

  try {
    const auth = await agentClient.authenticate(
      device.mesh_ip,
      port,
      {
        password: password || undefined,
        clientUserId: s.user?.id || undefined,
        deviceId: s.deviceId,
      },
      1200,
    );
    if (!auth?.token) {
      return {
        ok: false,
        needsPassword: true,
        message: "目标电脑未返回有效安全令牌，请重新输入访问密码",
      };
    }
    if (explicitPassword && opts?.rememberPassword) {
      store.setSavedDevicePassword(device.id, explicitPassword);
    }
    return { ok: true, agentConnected: true, port, token: auth.token };
  } catch (err) {
    if (err instanceof AgentClientError) {
      if (err.statusCode === 0) {
        if (!device.has_access_password) {
          return { ok: true, agentConnected: false, port, token: "" };
        }
        return {
          ok: false,
          message: "无法连接目标电脑的安全验证服务，请确认对方 SilkWarp 在线",
        };
      }
      if (err.statusCode === 401) {
        // Drop the cached password only when the failing credential came from
        // the cache (or the user retyped that same stale value).
        if (!explicitPassword || (savedPassword && savedPassword === explicitPassword)) {
          store.clearSavedDevicePassword(device.id);
        }
        return { ok: false, needsPassword: true, message: err.message };
      }
      if (err.statusCode === 429) {
        return {
          ok: false,
          needsPassword: true,
          retryAfterSec: err.retryAfterSec,
          message: err.message,
        };
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `安全验证失败：${message}` };
  }
}

function deniedResult(result: Extract<AgentSessionResult, { ok: false }>): ConnectDeviceResult {
  return {
    ok: false,
    stage: result.needsPassword ? "needs_password" : "agent_error",
    message: result.message,
    needsPassword: Boolean(result.needsPassword),
    retryAfterSec: result.retryAfterSec,
  };
}

function clearConnectProgressSoon(): void {
  const timer = setTimeout(() => emitConnectProgress(null), 2500);
  timer.unref?.();
}

ipcMain.handle(
  "device:connect",
  async (_evt, device: DeviceInfo, opts?: { password?: string; rememberPassword?: boolean }) => {
    if (!easyTier.getStatus().running) {
      throw new Error("本机高速传输通道尚未就绪，请先点击顶部【一键授权启用】。");
    }

    const liveLink = resolveLivePeerLink(device);
    emitConnectProgress({
      deviceId: device.id,
      deviceName: device.name,
      stage: "connecting",
      step: 1,
      totalSteps: 3,
      title: `正在连接 ${device.name}`,
      detail: "正在并行建立高速加密通道与安全验证…",
      routeType: liveLink.routeType,
      latencyMs: liveLink.latencyMs,
    });

    try {
      const primaryPort = device.apollo_port || 47984;
      const [agentSession, permInfo, applist] = await Promise.all([
        ensureRemoteAgentSession(device, opts),
        probeRemoteApolloPermission(device.mesh_ip, primaryPort, 1800),
        fetchAvailableApolloApps(device.mesh_ip, primaryPort, 1800),
      ]);

      if (!agentSession.ok) {
        emitConnectProgress(null);
        return deniedResult(agentSession);
      }

      const agentContext = {
        agentConnected: agentSession.agentConnected,
        agentPort: agentSession.port,
        agentToken: agentSession.token,
      };

      // Fast-path: already paired with local client certificate — start stream right away.
      if (permInfo?.paired) {
        assertInputAllowed(device, permInfo);
        const s = store.get();
        if (s.pairedHosts[device.id] !== device.mesh_ip) {
          store.update({ pairedHosts: { ...s.pairedHosts, [device.id]: device.mesh_ip } });
        }
        emitConnectProgress({
          deviceId: device.id,
          deviceName: device.name,
          stage: "launching",
          step: 3,
          totalSteps: 3,
          title: `正在进入「${device.name}」桌面`,
          detail: "画面引擎准备就绪，即将显示远程桌面…",
          routeType: liveLink.routeType,
          latencyMs: liveLink.latencyMs,
        });
        await sessionManager.startSession(
          device,
          liveLink.routeType,
          liveLink.latencyMs,
          agentContext,
          {
            prefetchedApps: applist,
            onFirstWindow: () => emitConnectProgress(null),
            linkQuality: liveLink.linkQuality,
          },
        );
        clearConnectProgressSoon();
        return { ok: true, stage: "streaming", message: `已连接「${device.name}」` };
      }

      // Fallback: check TCP reachability & silent pair when unpaired or certificate missing.
      emitConnectProgress({
        deviceId: device.id,
        deviceName: device.name,
        stage: "verifying",
        step: 2,
        totalSteps: 3,
        title: `正在检测「${device.name}」连通性`,
        detail: "正在核验远程画面服务端口…",
        routeType: liveLink.routeType,
        latencyMs: liveLink.latencyMs,
      });

      const [okPrimary, okHttp] = await Promise.all([
        probeTcpPort(device.mesh_ip, primaryPort, 1500),
        probeTcpPort(device.mesh_ip, 47989, 1500),
      ]);
      if (!okPrimary && !okHttp) {
        if (!device.apollo_ready) {
          throw new Error(
            `目标电脑「${device.name}」的高清画面服务正在后台初始化中（约需 10 秒），请稍候再试，或确认对方已开启【允许本机被远程】。`,
          );
        }
        throw new Error(`无法连接到「${device.name}」，请确认对方保持在线并已开启受控服务。`);
      }

      if (permInfo === null && (await isMoonlightHostPaired(device.mesh_ip))) {
        const s = store.get();
        if (s.pairedHosts[device.id] !== device.mesh_ip) {
          store.update({ pairedHosts: { ...s.pairedHosts, [device.id]: device.mesh_ip } });
        }
        await assertRemoteInputPermission(device);
        emitConnectProgress({
          deviceId: device.id,
          deviceName: device.name,
          stage: "launching",
          step: 3,
          totalSteps: 3,
          title: `正在进入「${device.name}」桌面`,
          detail: "正在打开远程画面窗口…",
          routeType: liveLink.routeType,
          latencyMs: liveLink.latencyMs,
        });
        await sessionManager.startSession(
          device,
          liveLink.routeType,
          liveLink.latencyMs,
          agentContext,
          {
            prefetchedApps: applist,
            onFirstWindow: () => emitConnectProgress(null),
            linkQuality: liveLink.linkQuality,
          },
        );
        clearConnectProgressSoon();
        return { ok: true, stage: "streaming", message: `已连接「${device.name}」` };
      }

      emitConnectProgress({
        deviceId: device.id,
        deviceName: device.name,
        stage: "pairing",
        step: 2,
        totalSteps: 3,
        title: "正在完成首次安全配对",
        detail: "全自动静默交换加密凭据，无需手动输入 PIN 码…",
        routeType: liveLink.routeType,
        latencyMs: liveLink.latencyMs,
      });

      let lastReason = "安全配对未响应";
      for (let attempt = 0; attempt < 2; attempt++) {
        const s = store.get();
        const pin = String(1000 + Math.floor(Math.random() * 9000));
        const pairProc = spawnSilentMoonlightPair(device.mesh_ip, pin);
        try {
          await new Promise((r) => setTimeout(r, 600));
          const created = await client.createPairRequest(device.id, pin, s.deviceId, os.hostname());
          const reqId = created.pair_request.id;

          let remoteFailure = "";
          const pollPromise = (async () => {
            for (let i = 0; i < 28; i++) {
              await new Promise((r) => setTimeout(r, 500));
              const poll = await client.getPairRequest(reqId).catch(() => null);
              if (poll && (poll.pair_request.status === "failed" || poll.pair_request.status === "rejected")) {
                remoteFailure = poll.pair_request.message || "被控端自动确认配对失败";
                pairProc.cancel();
                return;
              }
              if (poll && poll.pair_request.status === "approved") {
                return;
              }
            }
          })();

          const [pairOutcome] = await Promise.all([pairProc.promise, pollPromise]);
          if (pairOutcome.ok || (await isMoonlightHostPaired(device.mesh_ip))) {
            const cur = store.get();
            store.update({ pairedHosts: { ...cur.pairedHosts, [device.id]: device.mesh_ip } });
            await new Promise((r) => setTimeout(r, 250));
            await assertRemoteInputPermission(device);
            emitConnectProgress({
              deviceId: device.id,
              deviceName: device.name,
              stage: "launching",
              step: 3,
              totalSteps: 3,
              title: `首次配对成功，正在进入「${device.name}」`,
              detail: "即将开启远程桌面画面…",
              routeType: liveLink.routeType,
              latencyMs: liveLink.latencyMs,
            });
            await sessionManager.startSession(
              device,
              liveLink.routeType,
              liveLink.latencyMs,
              agentContext,
              {
                onFirstWindow: () => emitConnectProgress(null),
                linkQuality: liveLink.linkQuality,
              },
            );
            clearConnectProgressSoon();
            return { ok: true, stage: "connected", message: `已成功连接「${device.name}」桌面` };
          }
          lastReason = remoteFailure || pairOutcome.output || lastReason;
        } finally {
          pairProc.cancel();
        }
      }
      throw new Error(`自动安全配对失败：${lastReason}。请确认对方「本机受控」显示已就绪后重试。`);
    } catch (err) {
      emitConnectProgress(null);
      throw err;
    }
  },
);

ipcMain.handle(
  "device:stream",
  async (_evt, device: DeviceInfo, opts?: { password?: string; rememberPassword?: boolean }) => {
    if (!easyTier.getStatus().running) {
      throw new Error("本机高速传输通道尚未就绪，请先点击顶部【一键授权启用】。");
    }

    const liveLink = resolveLivePeerLink(device);
    emitConnectProgress({
      deviceId: device.id,
      deviceName: device.name,
      stage: "connecting",
      step: 1,
      totalSteps: 3,
      title: `正在连接 ${device.name}`,
      detail: "正在校验直连画面通道…",
      routeType: liveLink.routeType,
      latencyMs: liveLink.latencyMs,
    });

    try {
      const primaryPort = device.apollo_port || 47984;
      const [agentSession, permInfo, applist] = await Promise.all([
        ensureRemoteAgentSession(device, opts),
        probeRemoteApolloPermission(device.mesh_ip, primaryPort, 1800),
        fetchAvailableApolloApps(device.mesh_ip, primaryPort, 1800),
      ]);

      if (!agentSession.ok) {
        emitConnectProgress(null);
        return deniedResult(agentSession);
      }

      if (!permInfo?.paired) {
        const [okPrimary, okHttp] = await Promise.all([
          probeTcpPort(device.mesh_ip, primaryPort, 1500),
          probeTcpPort(device.mesh_ip, 47989, 1500),
        ]);
        if (!okPrimary && !okHttp) {
          if (!device.apollo_ready) {
            throw new Error(
              `目标电脑「${device.name}」的高清画面引擎尚未就绪，请对方在【本机受控】等待自动部署完成后重试。`,
            );
          }
          throw new Error(
            `无法连接到目标电脑「${device.name}」，请确认对方防火墙与高速通道在线。`,
          );
        }
      }

      assertInputAllowed(device, permInfo);
      emitConnectProgress({
        deviceId: device.id,
        deviceName: device.name,
        stage: "launching",
        step: 3,
        totalSteps: 3,
        title: `正在打开「${device.name}」桌面`,
        detail: "画面引擎准备就绪…",
        routeType: liveLink.routeType,
        latencyMs: liveLink.latencyMs,
      });

      await sessionManager.startSession(
        device,
        liveLink.routeType,
        liveLink.latencyMs,
        {
          agentConnected: agentSession.agentConnected,
          agentPort: agentSession.port,
          agentToken: agentSession.token,
        },
        {
          prefetchedApps: applist,
          onFirstWindow: () => emitConnectProgress(null),
          linkQuality: liveLink.linkQuality,
        },
      );
      clearConnectProgressSoon();
      return {
        ok: true,
        stage: "streaming",
        message: `正在连接「${device.name}」…`,
      } satisfies ConnectDeviceResult;
    } catch (err) {
      emitConnectProgress(null);
      throw err;
    }
  },
);

ipcMain.handle("device:moonlightGui", async () => {
  launchMoonlightGui();
});

ipcMain.handle(
  "device:rustdesk",
  async (_evt, device: DeviceInfo, opts?: { password?: string; rememberPassword?: boolean }) => {
    if (!bootstrapCache) throw new Error("请先登录账号");

    const agentSession = await ensureRemoteAgentSession(device, opts);
    if (!agentSession.ok) return deniedResult(agentSession);

    launchRustDeskConnect(device, bootstrapCache);
    return { ok: true, stage: "rustdesk", message: `正在启动轻办公模式连接「${device.name}」...` };
  },
);

ipcMain.handle("device:wake", async (_evt, device: DeviceInfo) => {
  if (!bootstrapCache) throw new Error("请先登录账号");
  return wakeDeviceViaGateway(device, bootstrapCache);
});

ipcMain.handle("device:pairRequest", async (_evt, args: { hostDeviceId: string; pin: string }) => {
  const s = store.get();
  const created = await client.createPairRequest(args.hostDeviceId, args.pin, s.deviceId, os.hostname());
  const reqId = created.pair_request.id;
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const poll = await client.getPairRequest(reqId);
    if (poll.pair_request.status !== "pending") {
      return { status: poll.pair_request.status, message: poll.pair_request.message || "" };
    }
  }
  return { status: "pending", message: "等待被控端响应超时，请确认被控端已开启“被控模式”和“自动配对”。" };
});

ipcMain.handle("device:update", async (_evt, args: { deviceId: string; patch: Partial<DeviceInfo> }) => {
  await client.updateDevice(args.deviceId, args.patch);
  await syncAll();
  return buildRuntimeState();
});

ipcMain.handle("device:delete", async (_evt, deviceId: string) => {
  await client.deleteDevice(deviceId);
  await syncAll();
  return buildRuntimeState();
});

ipcMain.handle("admin:listUsers", async () => (await client.listUsers()).users);
ipcMain.handle("admin:createUser", async (_evt, payload: { username: string; display_name: string; password: string; role: "admin" | "member" }) =>
  (await client.createUser(payload)).user,
);
ipcMain.handle("admin:updateUser", async (_evt, args: { userId: string; patch: { display_name?: string; role?: "admin" | "member"; enabled?: boolean; password?: string } }) =>
  (await client.updateUser(args.userId, args.patch)).user,
);
ipcMain.handle("admin:deleteUser", async (_evt, userId: string) => (await client.deleteUser(userId)).ok);
