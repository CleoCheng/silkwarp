import type { SilkWarpBridge } from "../electron/preload";
import type {
  ActiveSessionState,
  AppRuntimeState,
  DeviceInfo,
  DisplayMonitorInfo,
  StreamPreset,
  UserInfo,
} from "../electron/types";

declare global {
  interface Window {
    silkwarp?: SilkWarpBridge;
  }
}

const PREVIEW_DISPLAYS: DisplayMonitorInfo[] = [
  {
    index: 0,
    id: "\\\\.\\DISPLAY1",
    deviceName: "\\\\.\\DISPLAY1",
    friendlyName: "DELL U2720Q",
    width: 3840,
    height: 2160,
    x: 0,
    y: 0,
    isPrimary: true,
    isVirtual: false,
    active: true,
  },
  {
    index: 1,
    id: "\\\\.\\DISPLAY2",
    deviceName: "\\\\.\\DISPLAY2",
    friendlyName: "Apollo Virtual Display",
    width: 2560,
    height: 1440,
    x: 3840,
    y: 0,
    isPrimary: false,
    isVirtual: true,
    active: true,
  },
];

const PREVIEW_DEVICES: DeviceInfo[] = [
  {
    id: "preview-host-1",
    owner_user_id: "u1",
    owner_username: "admin",
    name: "Workstation-4070TiS",
    os: "win32",
    mesh_ip: "10.144.0.10",
    mac_address: "a8:a1:59:11:22:33",
    broadcast_ip: "255.255.255.255",
    cpu: "AMD Ryzen 7 9800X3D",
    gpu: "NVIDIA GeForce RTX 4070 Ti SUPER",
    rustdesk_id: "418902114",
    apollo_ready: true,
    apollo_port: 47984,
    route_type: "p2p",
    latency_ms: 11.4,
    is_host: true,
    visibility: "team",
    online: true,
    last_seen: new Date().toISOString(),
    created_at: new Date().toISOString(),
    has_access_password: true,
    agent_port: 19580,
  },
  {
    id: "preview-host-2",
    owner_user_id: "u1",
    owner_username: "admin",
    name: "Studio-7900XTX",
    os: "win32",
    mesh_ip: "10.144.0.11",
    mac_address: "74:56:3c:44:55:66",
    broadcast_ip: "255.255.255.255",
    cpu: "Intel Core i9-14900K",
    gpu: "AMD Radeon RX 7900 XTX",
    rustdesk_id: "592018331",
    apollo_ready: true,
    apollo_port: 47984,
    route_type: "relay",
    latency_ms: 18.2,
    is_host: true,
    visibility: "team",
    online: false,
    last_seen: new Date(Date.now() - 3600_000).toISOString(),
    created_at: new Date().toISOString(),
    has_access_password: false,
    agent_port: 19580,
  },
];

let previewAuthed = false;
let previewSessionState: ActiveSessionState | null = null;

function buildPreviewSession(device: DeviceInfo): ActiveSessionState {
  return {
    sessionId: "preview-session",
    device,
    preset: previewState.settings.preset,
    effectivePreset: previewState.settings.preset,
    routeType: device.route_type || "p2p",
    latencyMs: device.latency_ms,
    resolvedApp: "Virtual Display",
    availableApps: ["Desktop", "Virtual Display"],
    windowRect: null,
    reconnecting: false,
    startedAt: Date.now(),
    agentConnected: true,
    displays: PREVIEW_DISPLAYS,
    selectedDisplayId: PREVIEW_DISPLAYS[1].id,
    hostMuted: previewState.settings.preset.muteHostAudio,
    privacyActive: false,
    privacySupported: true,
    autoLockOnDisconnect: previewState.settings.autoLockOnDisconnect,
  };
}

const previewSavedPasswords = new Map<string, string>();

function previewPasswordGate(
  device: DeviceInfo,
  opts?: { password?: string; rememberPassword?: boolean },
): { ok: false; needsPassword: true; message: string } | null {
  if (!device.has_access_password) return null;
  const supplied = opts?.password?.trim() || previewSavedPasswords.get(device.id) || "";
  const accepted =
    Boolean(supplied) &&
    (supplied === previewState.settings.tempAccessPassword || supplied === "silkwarp");
  if (accepted) {
    if (opts?.password && opts.rememberPassword) {
      previewSavedPasswords.set(device.id, opts.password);
    }
    return null;
  }
  return {
    ok: false,
    needsPassword: true,
    message: supplied ? "访问密码错误" : "此主机需要输入访问密码",
  };
}

let previewState: AppRuntimeState = {
  authenticated: false,
  user: null,
  bootstrap: null,
  settings: {
    apiUrl: "https://silkwarp.example.com/silkwarp",
    deviceId: "preview-local",
    isHost: true,
    autoApprovePair: true,
    autoStart: false,
    apolloUser: "",
    apolloPass: "",
    preset: {
      resolution: "2560x1440",
      fps: 120,
      bitrateMbps: 35,
      codec: "hevc",
      displayMode: "windowed",
      streamApp: "Virtual Display",
      muteHostAudio: true,
      lowLatency: true,
      adaptiveRelayCap: true,
      absoluteMouse: true,
      showPerfOverlay: false,
      captureSystemKeys: "fullscreen",
      packetSize: "auto",
    },
    requireAccessPassword: true,
    hasAccessPassword: true,
    allowSameAccountBypass: true,
    autoLockOnDisconnect: false,
    agentPort: 19580,
    tempAccessPassword: "482913",
    tempAccessPasswordExpiresAt: Date.now() + 30 * 60 * 1000,
  },
  easytier: {
    running: true,
    externalService: false,
    needsElevation: false,
    meshIp: "10.144.0.12",
    peers: [
      {
        ipv4: "10.144.0.1",
        hostname: "silkwarp-relay-node",
        cost: "p2p",
        latencyMs: 11.2,
        loss: "0.0%",
        rx: "12.4 MB",
        tx: "3.1 MB",
        tunnel: "udp",
        nat: "PortRestricted",
      },
      {
        ipv4: "10.144.0.10",
        hostname: "Workstation-4070TiS",
        cost: "p2p",
        latencyMs: 11.4,
        loss: "0.0%",
        rx: "418 MB",
        tx: "24 MB",
        tunnel: "udp",
        nat: "FullCone",
      },
    ],
    error: "",
  },
  host: {
    hostname: "SILKWARP-PC",
    cpu: "Intel Core Ultra 5 225H",
    gpu: "Intel Arc 130T GPU (16GB)",
    macAddress: "00:11:22:33:44:55",
    broadcastIp: "255.255.255.255",
    isElevated: true,
    apolloInstalled: true,
    apolloRunning: true,
    apolloPort: 47984,
    rustdeskInstalled: true,
    rustdeskId: "391820411",
    firewallConfigured: true,
    uuRemoteDetected: false,
    provisionStage: "ready",
    provisionMessage: "已就绪，可随时接受远程连接",
    apolloAuthReady: true,
    agentRunning: true,
    agentPort: 19580,
  },
  devices: PREVIEW_DEVICES,
  lastPairLogs: [],
};

const previewFallback: SilkWarpBridge = {
  getState: async () => ({ ...previewState, authenticated: previewAuthed }),
  login: async ({ apiUrl, username }) => {
    previewAuthed = true;
    previewState = {
      ...previewState,
      authenticated: true,
      user: {
        id: "u1",
        username,
        display_name: username === "admin" ? "管理员" : username,
        role: "admin",
        enabled: true,
        created_at: new Date().toISOString(),
      },
      settings: { ...previewState.settings, apiUrl },
    };
    return previewState;
  },
  logout: async () => {
    previewAuthed = false;
    previewState = { ...previewState, authenticated: false, user: null };
    return previewState;
  },
  refresh: async () => previewState,
  updatePreset: async (preset: StreamPreset) => {
    previewState = { ...previewState, settings: { ...previewState.settings, preset } };
    return previewState;
  },
  updateHostSettings: async (patch) => {
    previewState = { ...previewState, settings: { ...previewState.settings, ...patch } };
    return previewState;
  },
  startEasyTier: async () => previewState,
  relaunchAsAdmin: async () => {},
  configureFirewall: async () => previewState,
  configureRustDesk: async () => [],
  installApollo: async () => "",
  installRustDesk: async () => "",
  openExternal: async () => {},
  connectDevice: async (device, opts) => {
    const denied = previewPasswordGate(device, opts);
    if (denied) return denied;
    previewSessionState = buildPreviewSession(device);
    return { ok: true, stage: "connected", message: `正在远程连接 ${device.name}...` };
  },
  retryProvision: async () => previewState,
  streamDevice: async (device, opts) => {
    const denied = previewPasswordGate(device, opts);
    if (denied) return denied;
    previewSessionState = buildPreviewSession(device);
    return { ok: true, stage: "streaming", message: `正在串流 ${device.name}...` };
  },
  openMoonlightGui: async () => {},
  connectRustDesk: async (device, opts) => {
    const denied = previewPasswordGate(device, opts);
    if (denied) return denied;
    return { ok: true, stage: "rustdesk", message: `正在启动 RustDesk 办公模式连接 ${device.name}...` };
  },
  wakeDevice: async () => ({ status: "sent" }),
  requestPair: async () => ({ status: "approved", message: "预览模式自动配对成功" }),
  updateDevice: async () => previewState,
  deleteDevice: async () => previewState,
  adminListUsers: async (): Promise<UserInfo[]> => (previewState.user ? [previewState.user] : []),
  adminCreateUser: async (p) => ({
    id: "u-new",
    username: p.username,
    display_name: p.display_name,
    role: p.role,
    enabled: true,
    created_at: new Date().toISOString(),
  }),
  adminUpdateUser: async () => previewState.user!,
  adminDeleteUser: async () => true,
  getSessionState: async (): Promise<ActiveSessionState | null> => previewSessionState,
  updateSessionOptions: async (patch: Partial<StreamPreset>) => {
    previewState = {
      ...previewState,
      settings: {
        ...previewState.settings,
        preset: { ...previewState.settings.preset, ...patch },
      },
    };
    if (previewSessionState) {
      previewSessionState = {
        ...previewSessionState,
        preset: previewState.settings.preset,
        effectivePreset: previewState.settings.preset,
      };
    }
    return previewSessionState;
  },
  fitSessionWindow: async () => previewSessionState,
  toggleSessionFullscreen: async () => {
    if (!previewSessionState) return null;
    const nextMode = previewSessionState.preset.displayMode === "fullscreen" ? "windowed" : "fullscreen";
    previewSessionState = {
      ...previewSessionState,
      preset: { ...previewSessionState.preset, displayMode: nextMode },
      effectivePreset: { ...previewSessionState.effectivePreset, displayMode: nextMode },
    };
    previewState = {
      ...previewState,
      settings: { ...previewState.settings, preset: previewSessionState.preset },
    };
    return previewSessionState;
  },
  sendSessionHotkey: async () => {},
  focusSessionRemote: async () => {},
  switchSessionOfficeMode: async () => {},
  disconnectSession: async () => {
    previewSessionState = null;
  },
  setSessionBarExpanded: async () => {},
  nudgeSessionBarOffset: async () => {},
  refreshSessionDisplays: async () => previewSessionState,
  selectSessionDisplay: async (displayId: string) => {
    if (!previewSessionState) return null;
    const selected = previewSessionState.displays.find((d) => d.id === displayId);
    const streamApp = selected?.isVirtual ? "Virtual Display" : "Desktop";
    previewSessionState = {
      ...previewSessionState,
      selectedDisplayId: displayId,
      preset: { ...previewSessionState.preset, streamApp },
      effectivePreset: { ...previewSessionState.effectivePreset, streamApp },
    };
    return previewSessionState;
  },
  setSessionHostMute: async (muted: boolean) => {
    if (!previewSessionState) return null;
    previewSessionState = {
      ...previewSessionState,
      hostMuted: muted,
      preset: { ...previewSessionState.preset, muteHostAudio: muted },
    };
    previewState = {
      ...previewState,
      settings: { ...previewState.settings, preset: previewSessionState.preset },
    };
    return previewSessionState;
  },
  setSessionPrivacy: async (active: boolean) => {
    if (!previewSessionState) return null;
    previewSessionState = { ...previewSessionState, privacyActive: active, privacySupported: true };
    return previewSessionState;
  },
  runSessionSystemAction: async (action) => ({
    ok: true,
    message: `预览模式：已模拟执行 ${action}`,
  }),
  setSessionAutoLock: async (enabled: boolean) => {
    if (!previewSessionState) return null;
    previewSessionState = { ...previewSessionState, autoLockOnDisconnect: enabled };
    previewState = {
      ...previewState,
      settings: { ...previewState.settings, autoLockOnDisconnect: enabled },
    };
    return previewSessionState;
  },
  setAccessPassword: async (payload) => {
    const nextSettings = { ...previewState.settings };
    if (payload.requireAccessPassword !== undefined) {
      nextSettings.requireAccessPassword = payload.requireAccessPassword;
    }
    if (payload.allowSameAccountBypass !== undefined) {
      nextSettings.allowSameAccountBypass = payload.allowSameAccountBypass;
    }
    if (payload.autoLockOnDisconnect !== undefined) {
      nextSettings.autoLockOnDisconnect = payload.autoLockOnDisconnect;
    }
    if (payload.clearPermanentPassword) {
      nextSettings.hasAccessPassword = false;
    } else if (payload.permanentPassword && payload.permanentPassword.trim()) {
      nextSettings.hasAccessPassword = true;
    }
    if (nextSettings.requireAccessPassword) {
      if (!nextSettings.tempAccessPassword) {
        nextSettings.tempAccessPassword = String(100000 + Math.floor(Math.random() * 900000));
        nextSettings.tempAccessPasswordExpiresAt = Date.now() + 30 * 60 * 1000;
      }
    } else {
      nextSettings.tempAccessPassword = "";
      nextSettings.tempAccessPasswordExpiresAt = 0;
    }
    previewState = { ...previewState, settings: nextSettings };
    return previewState;
  },
  rotateTempPassword: async () => {
    previewState = {
      ...previewState,
      settings: {
        ...previewState.settings,
        requireAccessPassword: true,
        tempAccessPassword: String(100000 + Math.floor(Math.random() * 900000)),
        tempAccessPasswordExpiresAt: Date.now() + 30 * 60 * 1000,
      },
    };
    return previewState;
  },
  onSessionChanged: () => () => {},
  onStateChanged: () => () => {},
};

export function getBridge(): SilkWarpBridge {
  return window.silkwarp ?? previewFallback;
}
