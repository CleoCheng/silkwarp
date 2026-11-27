import type { DisplayMonitorInfo, SystemActionType } from "./services/hostAgentServer";
import type {
  DiagnosticCheckItem,
  DiagnosticSeverity,
  NetworkDiagnosticsReport,
  PeerDiagnosticItem,
} from "./services/networkDiagnostics";
import type { ClipboardKind, RemoteFileEntry, RemoteRootDir } from "./services/transferValidation";
import type {
  UpdateCheckResult,
  UpdateDownloadProgress,
  UpdateDownloadResult,
  UpdateReleaseInfo,
} from "./services/updateLogic";

export type { DisplayMonitorInfo, SystemActionType } from "./services/hostAgentServer";
export type {
  DiagnosticCheckItem,
  DiagnosticSeverity,
  NetworkDiagnosticsReport,
  PeerDiagnosticItem,
} from "./services/networkDiagnostics";
export type {
  ClipboardKind,
  ClipboardPayload,
  RemoteFileEntry,
  RemoteRootDir,
} from "./services/transferValidation";
export type {
  UpdateCheckResult,
  UpdateDownloadProgress,
  UpdateDownloadResult,
  UpdateReleaseInfo,
} from "./services/updateLogic";

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
export type ResolutionMode = "follow_client" | "follow_host" | "fit_window" | "fixed";
export type StreamAppTarget = "Virtual Display" | "Desktop";
export type SystemKeyCaptureMode = "always" | "fullscreen" | "never";
export type SessionHotkeyAction = "fullscreen" | "perf" | "mouse";

export interface StreamPreset {
  resolution: string;
  resolutionMode: ResolutionMode;
  fps: 30 | 60 | 120 | 144;
  bitrateMbps: number;
  codec: "hevc" | "av1" | "h264";
  displayMode: DisplayMode;
  streamApp: StreamAppTarget;
  muteHostAudio: boolean;
  lowLatency: boolean;
  adaptiveRelayCap: boolean;
  yuv444?: boolean;
  absoluteMouse: boolean;
  showPerfOverlay: boolean;
  captureSystemKeys: SystemKeyCaptureMode;
  packetSize: "auto" | number;
}

export interface ConnectProgressEvent {
  deviceId: string;
  deviceName: string;
  stage: "connecting" | "verifying" | "pairing" | "launching" | "ready" | "error";
  step: number;
  totalSteps: number;
  title: string;
  detail: string;
  routeType?: string;
  latencyMs?: number | null;
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
  tunnelProto?: string;
  lossPercent?: number | null;
  resolvedApp: StreamAppTarget;
  availableApps: string[];
  clientDisplayResolution?: string;
  hostDisplayResolution?: string;
  windowRect: WindowRect | null;
  reconnecting: boolean;
  reconnectAttempt?: number;
  reconnectStatus?: string;
  startedAt: number;
  agentConnected: boolean;
  displays: DisplayMonitorInfo[];
  selectedDisplayId: string;
  hostMuted: boolean;
  privacyActive: boolean;
  privacySupported: boolean;
  autoLockOnDisconnect: boolean;
  clipboardSyncEnabled: boolean;
  clipboardLastKind: ClipboardKind;
  clipboardLastSyncAt: number | null;
  clipboardError: string;
  transfers: TransferTaskItem[];
}

/** One upload/download shown in the session bar and the device transfer modal. */
export interface TransferTaskItem {
  id: string;
  direction: "upload" | "download";
  filename: string;
  transferred: number;
  total: number;
  status: "running" | "done" | "error";
  message?: string;
  remotePath?: string;
  localPath?: string;
}

/** Result of browsing one remote directory through the Host Companion Agent. */
export interface RemoteFileListing {
  currentPath: string;
  parentPath: string | null;
  roots: RemoteRootDir[];
  entries: RemoteFileEntry[];
}

/** Structured outcome of `device:prepareAgent` / `transfer:*` IPC calls. */
export interface DeviceAgentSessionResult {
  ok: boolean;
  needsPassword?: boolean;
  retryAfterSec?: number;
  message: string;
  agentPort: number;
  agentToken: string;
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
  bootTunnelConfigured?: boolean;
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
  appVersion: string;
  authenticated: boolean;
  user: UserInfo | null;
  bootstrap: BootstrapConfig | null;
  settings: AppSettings;
  easytier: EasyTierStatus;
  host: HostHardwareInfo;
  devices: DeviceInfo[];
  lastPairLogs: string[];
}
