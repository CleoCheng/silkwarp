import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ControlClient, type PairRequestItem } from "./services/controlClient";
import { EasyTierManager } from "./services/easytierManager";
import {
  checkApolloAuthStatus,
  collectHostInfo,
  configureAutoStartTask,
  configureRustDeskClient,
  configureWindowsFirewall,
  downloadAndRunApolloInstaller,
  downloadAndRunRustDeskInstaller,
  ensureApolloCredentials,
  ensureApolloServiceRunning,
  grantAllApolloClientPermissions,
  silentInstallApollo,
  submitApolloPin,
} from "./services/hostManager";
import { StateStore } from "./services/store";
import {
  isMoonlightHostPaired,
  launchMoonlightGui,
  launchMoonlightStream,
  launchRustDeskConnect,
  probeRemoteApolloPermission,
  probeTcpPort,
  spawnSilentMoonlightPair,
  wakeDeviceViaGateway,
} from "./services/streamLauncher";
import type {
  AppRuntimeState,
  BootstrapConfig,
  DeviceInfo,
  HostHardwareInfo,
  ProvisionStage,
  StreamPreset,
} from "./types";

const execFileAsync = promisify(execFile);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let heartbeatTimer: NodeJS.Timeout | null = null;
let pairPollTimer: NodeJS.Timeout | null = null;

const store = new StateStore();
const client = new ControlClient(
  () => store.get().apiUrl,
  () => store.get().token,
);
const easyTier = new EasyTierManager();

let bootstrapCache: BootstrapConfig | null = null;
let devicesCache: DeviceInfo[] = [];
let lastRustDeskConfigSig = "";
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
  uuRemoteDetected: false,
  provisionStage: "idle",
  provisionMessage: "",
  apolloAuthReady: false,
};
const pairLogs: string[] = [];

function pushPairLog(line: string): void {
  pairLogs.unshift(`${new Date().toLocaleTimeString()} ${line}`);
  if (pairLogs.length > 20) pairLogs.pop();
}

function getDefaultMeshCidr(): string {
  return bootstrapCache?.mesh_cidr || store.getExternalConfig().meshCidr || "10.144.0.0/24";
}

function buildRuntimeState(): AppRuntimeState {
  const s = store.get();
  return {
    authenticated: Boolean(s.token && s.user),
    user: s.user,
    bootstrap: bootstrapCache,
    settings: store.getPublicSettings(),
    easytier: easyTier.getStatus(),
    host: {
      ...hostInfoCache,
      provisionStage,
      provisionMessage,
      apolloAuthReady,
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
        hostInfoCache = await collectHostInfo();
        if (!hostInfoCache.firewallConfigured) {
          await configureWindowsFirewall(getDefaultMeshCidr(), true);
          hostInfoCache = await collectHostInfo();
        }
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

async function syncAll(): Promise<void> {
  hostInfoCache = await collectHostInfo();
  const s = store.get();
  if (!s.token) {
    emitState();
    return;
  }

  try {
    const me = await client.me();
    store.update({ user: me.user });
    bootstrapCache = await client.bootstrap(s.deviceId, os.hostname(), process.platform);
    await easyTier.ensureStarted(bootstrapCache, hostInfoCache.isElevated);
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
      if (!hostInfoCache.isElevated) {
        apolloAuthReady = false;
        provisionStage = "needs_admin";
        provisionMessage = "请点击顶部【一键授权启用】，系统将自动完成全部配置";
      } else {
        if (hostInfoCache.apolloRunning && !apolloAuthReady && s.apolloUser && s.apolloPass) {
          apolloAuthReady = (await checkApolloAuthStatus(s.apolloUser, s.apolloPass)) === "ok";
        }
        if (!hostInfoCache.apolloInstalled || !hostInfoCache.apolloRunning || !hostInfoCache.firewallConfigured || !apolloAuthReady) {
          if (!autoHealExhausted && !provisionInFlight) {
            void autoProvisionHostIfNeeded(false);
          }
        } else {
          autoHealExhausted = false;
          provisionStage = "ready";
          provisionMessage = "一切就绪，可随时接受其他设备一键远程";
        }
      }
    } else {
      provisionStage = "idle";
      provisionMessage = "";
    }

    // Self-heal clients that were paired before the permission fix by
    // re-granting full Apollo permissions on every host heartbeat.
    if (
      s.isHost &&
      hostInfoCache.isElevated &&
      hostInfoCache.apolloRunning &&
      apolloAuthReady &&
      s.apolloUser &&
      s.apolloPass
    ) {
      void grantAllApolloClientPermissions(s.apolloUser, s.apolloPass).catch(() => {});
    }

    const peers = easyTier.getStatus().peers;
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
    });

    if (latestSettings.isHost && latestSettings.autoApprovePair && hb.pending_pairs.length > 0) {
      await processPendingPairs(hb.pending_pairs);
    }

    const listResp = await client.listDevices();
    devicesCache = listResp.devices;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("unauthorized") || msg.includes("401")) {
      store.update({ token: "", user: null });
      bootstrapCache = null;
      devicesCache = [];
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

function startPairFastPoll(): void {
  if (pairPollTimer) clearInterval(pairPollTimer);
  pairPollTimer = setInterval(async () => {
    const s = store.get();
    if (!s.token || !s.isHost || !s.autoApprovePair || !hostInfoCache.apolloRunning) return;
    try {
      const { pending_pairs } = await client.getPendingPairs(s.deviceId);
      if (pending_pairs.length > 0) {
        await processPendingPairs(pending_pairs);
        emitState();
      }
    } catch {
      // ignore transient network glitches during fast poll
    }
  }, 2_000);
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
  await syncAll();
  startHeartbeatLoop();
  startPairFastPoll();
});

app.on("before-quit", () => {
  isQuitting = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (pairPollTimer) clearInterval(pairPollTimer);
  easyTier.stop();
});

// --- IPC Handlers ---
ipcMain.handle("app:getState", async () => buildRuntimeState());

ipcMain.handle("app:refresh", async () => {
  await syncAll();
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
  await syncAll();
  startPairFastPoll();
  return buildRuntimeState();
});

ipcMain.handle("auth:logout", async () => {
  try {
    await client.logout();
  } catch {
    // ignore
  }
  if (pairPollTimer) {
    clearInterval(pairPollTimer);
    pairPollTimer = null;
  }
  store.update({ token: "", user: null });
  bootstrapCache = null;
  devicesCache = [];
  apolloAuthReady = false;
  provisionStage = "idle";
  provisionMessage = "";
  easyTier.stop();
  return buildRuntimeState();
});

ipcMain.handle("settings:updatePreset", async (_evt, preset: StreamPreset) => {
  store.update({ preset });
  return buildRuntimeState();
});

ipcMain.handle("host:updateSettings", async (_evt, patch: Record<string, unknown>) => {
  store.update(patch);
  if ("apolloUser" in patch || "apolloPass" in patch || patch.isHost === true) {
    apolloAuthReady = false;
    autoHealExhausted = false;
  }
  if (typeof patch.autoStart === "boolean") {
    await configureAutoStartTask(patch.autoStart, hostInfoCache.isElevated);
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
  await syncAll();
  return buildRuntimeState();
});

ipcMain.handle("easytier:start", async () => {
  if (bootstrapCache) {
    hostInfoCache = await collectHostInfo();
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
  if (pairPollTimer) clearInterval(pairPollTimer);
  easyTier.stop();
  tray?.destroy();
  setTimeout(() => app.exit(0), 150);
});

ipcMain.handle("host:retryProvision", async () => {
  await autoProvisionHostIfNeeded(true);
  await syncAll();
  return buildRuntimeState();
});

ipcMain.handle("host:configureFirewall", async () => {
  const cidr = getDefaultMeshCidr();
  await configureWindowsFirewall(cidr, hostInfoCache.isElevated);
  hostInfoCache = await collectHostInfo();
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

async function assertRemoteInputPermission(device: DeviceInfo): Promise<void> {
  const permInfo = await probeRemoteApolloPermission(device.mesh_ip, device.apollo_port || 47984);
  if (permInfo && permInfo.paired && !permInfo.hasInput && permInfo.permission !== null) {
    throw new Error(
      `目标主机「${device.name}」的 Apollo 未授予本机键鼠输入权限（Permission=0x${permInfo.permission.toString(16)}，仅可观看画面）。` +
        `请在目标主机更新 SilkWarp，或在其本机 https://localhost:47990 -> PIN / Clients 页面中为该客户端勾选鼠标与键盘权限后重试。`,
    );
  }
}

ipcMain.handle("device:connect", async (_evt, device: DeviceInfo) => {
  if (!easyTier.getStatus().running) {
    throw new Error("本机虚拟网卡尚未就绪，请先点击顶部【一键授权启用】。");
  }
  const primaryPort = device.apollo_port || 47984;
  const [okPrimary, okHttp] = await Promise.all([
    probeTcpPort(device.mesh_ip, primaryPort, 2500),
    probeTcpPort(device.mesh_ip, 47989, 2500),
  ]);
  if (!okPrimary && !okHttp) {
    if (!device.apollo_ready) {
      throw new Error(
        `目标主机「${device.name}」正在后台自动初始化高清串流引擎（约需 15 秒），请稍候再试，或确认对方已开启【允许本机被远程】。`,
      );
    }
    throw new Error(`虚拟内网已在线，但无法连接 ${device.mesh_ip}:47984/47989，请稍候 10 秒等待对方防火墙自动同步。`);
  }

  if (await isMoonlightHostPaired(device.mesh_ip)) {
    const s = store.get();
    if (s.pairedHosts[device.id] !== device.mesh_ip) {
      store.update({ pairedHosts: { ...s.pairedHosts, [device.id]: device.mesh_ip } });
    }
    await assertRemoteInputPermission(device);
    launchMoonlightStream(device, s.preset);
    return { ok: true, stage: "streaming", message: `正在连接「${device.name}」桌面...` };
  }

  let lastReason = "静默握手未响应";
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = store.get();
    const pin = String(1000 + Math.floor(Math.random() * 9000));
    const pairProc = spawnSilentMoonlightPair(device.mesh_ip, pin);
    try {
      await new Promise((r) => setTimeout(r, 900));
      const created = await client.createPairRequest(device.id, pin, s.deviceId, os.hostname());
      const reqId = created.pair_request.id;

      let remoteFailure = "";
      const pollPromise = (async () => {
        for (let i = 0; i < 16; i++) {
          await new Promise((r) => setTimeout(r, 1000));
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
        await new Promise((r) => setTimeout(r, 350));
        await assertRemoteInputPermission(device);
        launchMoonlightStream(device, cur.preset);
        return { ok: true, stage: "connected", message: `首次静默握手成功，正在进入「${device.name}」桌面！` };
      }
      lastReason = remoteFailure || pairOutcome.output || lastReason;
    } finally {
      pairProc.cancel();
    }
  }
  throw new Error(`自动握手失败：${lastReason}。请确认对方「本机受控」页显示一切就绪后重试。`);
});

ipcMain.handle("device:stream", async (_evt, device: DeviceInfo) => {
  if (!easyTier.getStatus().running) {
    throw new Error("本机虚拟网卡尚未启动，请先点击顶部【以管理员权限重启】拉起虚拟网卡。");
  }
  const primaryPort = device.apollo_port || 47984;
  const [okPrimary, okHttp] = await Promise.all([
    probeTcpPort(device.mesh_ip, primaryPort, 2500),
    probeTcpPort(device.mesh_ip, 47989, 2500),
  ]);
  if (!okPrimary && !okHttp) {
    if (!device.apollo_ready) {
      throw new Error(
        `目标主机「${device.name} (${device.mesh_ip})」尚未安装或启动 Apollo 串流服务。请前往被控端【被控模式】点击“一键安装 Apollo”，装完启动后再点击【首次配对】。`,
      );
    }
    throw new Error(
      `无法连接到 ${device.mesh_ip}:47984/47989。请确认被控端已在【被控模式】点击“放行内网防火墙”，且双方【组网状态】均显示 p2p 或 relay 在线。`,
    );
  }
  await assertRemoteInputPermission(device);
  launchMoonlightStream(device, store.get().preset);
});

ipcMain.handle("device:moonlightGui", async () => {
  launchMoonlightGui();
});

ipcMain.handle("device:rustdesk", async (_evt, device: DeviceInfo) => {
  if (!bootstrapCache) throw new Error("请先登录账号");
  launchRustDeskConnect(device, bootstrapCache);
});

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
