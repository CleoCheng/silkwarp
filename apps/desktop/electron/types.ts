import type { DisplayMonitorInfo, SystemActionType } from "./services/hostAgentServer";

export type { DisplayMonitorInfo, SystemActionType } from "./services/hostAgentServer";

export interface UserInfo {
  id: string;
  username: string;
  display_name: string;
  role: "admin" | "member";
  enabled: boolean;
  created_at: string;
}

export interface DeviceInfo {
  id: string;
  owner_user_id: string;
  owner_username: string;
  name: string;
  os: string;
  mesh_ip: string;
  mac_address: string;
  broadcast_ip: string;
  cpu: string;
  gpu: string;
  rustdesk_id: string;
  apollo_ready: boolean;
  apollo_port: number;
  route_type: string;
  latency_ms: number | null;
  is_host: boolean;
  visibility: "team" | "private";
  online: boolean;
  last_seen: string;
  created_at: string;
  has_access_password?: boolean;
  agent_port?: number;
}

export interface BootstrapConfig {
  api_url: string;
  mesh_ip: string;
  mesh_cidr: string;
  easytier: {
    network_name: string;
    network_secret: string;
    peers: string[];
  };
  rustdesk: {
    id_server: string;
    relay_server: string;
    api_server: string;
    public_key: string;
  };
  wol: {
    url: string;
    token: string;
  };
  device: DeviceInfo;
}

export type DisplayMode = "windowed" | "borderless" | "fullscreen";
export type StreamAppTarget = "Virtual Display" | "Desktop";
export type SystemKeyCaptureMode = "always" | "fullscreen" | "never";
export type SessionHotkeyAction = "fullscreen" | "perf" | "mouse";

export interface StreamPreset {
  resolution: string;
  fps: 30 | 60 | 120 | 144;
  bitrateMbps: number;
  codec: "hevc" | "av1" | "h264";
  displayMode: DisplayMode;
  streamApp: StreamAppTarget;
  muteHostAudio: boolean;
  lowLatency: boolean;
  adaptiveRelayCap: boolean;
  absoluteMouse: boolean;
  showPerfOverlay: boolean;
  captureSystemKeys: SystemKeyCaptureMode;
  packetSize: "auto" | number;
}

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  visible: boolean;
  minimized: boolean;
  foreground: boolean;
}

export interface ActiveSessionState {
  sessionId: string;
  device: DeviceInfo;
  preset: StreamPreset;
  effectivePreset: StreamPreset;
  routeType: string;
  latencyMs: number | null;
  resolvedApp: StreamAppTarget;
  availableApps: string[];
  windowRect: WindowRect | null;
  reconnecting: boolean;
  startedAt: number;
  agentConnected: boolean;
  displays: DisplayMonitorInfo[];
  selectedDisplayId: string;
  hostMuted: boolean;
  privacyActive: boolean;
  privacySupported: boolean;
  autoLockOnDisconnect: boolean;
}

export interface PeerStatus {
  ipv4: string;
  hostname: string;
  cost: string;
  latencyMs: number | null;
  loss: string;
  rx: string;
  tx: string;
  tunnel: string;
  nat: string;
}

export interface EasyTierStatus {
  running: boolean;
  externalService: boolean;
  needsElevation: boolean;
  meshIp: string;
  peers: PeerStatus[];
  error: string;
}

export type ProvisionStage =
  | "idle"
  | "needs_admin"
  | "configuring_firewall"
  | "installing_apollo"
  | "starting_apollo"
  | "initializing_apollo"
  | "reinstalling_apollo"
  | "ready"
  | "error";

export interface ConnectDeviceResult {
  ok: boolean;
  stage?: string;
  message: string;
  needsPassword?: boolean;
  retryAfterSec?: number;
}

export interface HostHardwareInfo {
  hostname: string;
  cpu: string;
  gpu: string;
  macAddress: string;
  broadcastIp: string;
  isElevated: boolean;
  apolloInstalled: boolean;
  apolloRunning: boolean;
  apolloPort: number;
  rustdeskInstalled: boolean;
  rustdeskId: string;
  firewallConfigured: boolean;
  uuRemoteDetected: boolean;
  provisionStage: ProvisionStage;
  provisionMessage: string;
  apolloAuthReady: boolean;
  agentRunning: boolean;
  agentPort: number;
}

export interface AppSettings {
  apiUrl: string;
  deviceId: string;
  isHost: boolean;
  autoApprovePair: boolean;
  autoStart: boolean;
  apolloUser: string;
  apolloPass: string;
  preset: StreamPreset;
  requireAccessPassword: boolean;
  hasAccessPassword: boolean;
  allowSameAccountBypass: boolean;
  autoLockOnDisconnect: boolean;
  agentPort: number;
  tempAccessPassword: string;
  tempAccessPasswordExpiresAt: number;
}

export interface AppRuntimeState {
  authenticated: boolean;
  user: UserInfo | null;
  bootstrap: BootstrapConfig | null;
  settings: AppSettings;
  easytier: EasyTierStatus;
  host: HostHardwareInfo;
  devices: DeviceInfo[];
  lastPairLogs: string[];
}
