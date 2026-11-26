import { contextBridge, ipcRenderer } from "electron";
import type {
  ActiveSessionState,
  AppRuntimeState,
  ConnectDeviceResult,
  DeviceInfo,
  SessionHotkeyAction,
  StreamPreset,
  SystemActionType,
  UserInfo,
} from "./types";

export interface AccessPasswordPayload {
  requireAccessPassword?: boolean;
  permanentPassword?: string;
  clearPermanentPassword?: boolean;
  allowSameAccountBypass?: boolean;
  autoLockOnDisconnect?: boolean;
}

export interface ConnectOptions {
  password?: string;
  rememberPassword?: boolean;
}

const api = {
  getState: (): Promise<AppRuntimeState> => ipcRenderer.invoke("app:getState"),
  login: (args: { apiUrl: string; username: string; password: string }): Promise<AppRuntimeState> =>
    ipcRenderer.invoke("auth:login", args),
  logout: (): Promise<AppRuntimeState> => ipcRenderer.invoke("auth:logout"),
  refresh: (): Promise<AppRuntimeState> => ipcRenderer.invoke("app:refresh"),
  updatePreset: (preset: StreamPreset): Promise<AppRuntimeState> => ipcRenderer.invoke("settings:updatePreset", preset),
  updateHostSettings: (patch: {
    isHost?: boolean;
    autoApprovePair?: boolean;
    autoStart?: boolean;
    apolloUser?: string;
    apolloPass?: string;
  }): Promise<AppRuntimeState> => ipcRenderer.invoke("host:updateSettings", patch),
  startEasyTier: (): Promise<AppRuntimeState> => ipcRenderer.invoke("easytier:start"),
  relaunchAsAdmin: (): Promise<void> => ipcRenderer.invoke("app:relaunchAdmin"),
  configureFirewall: (): Promise<AppRuntimeState> => ipcRenderer.invoke("host:configureFirewall"),
  configureRustDesk: (): Promise<string[]> => ipcRenderer.invoke("host:configureRustDesk"),
  installApollo: (): Promise<string> => ipcRenderer.invoke("host:installApollo"),
  installRustDesk: (): Promise<string> => ipcRenderer.invoke("host:installRustDesk"),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("app:openExternal", url),
  connectDevice: (device: DeviceInfo, opts?: ConnectOptions): Promise<ConnectDeviceResult> =>
    ipcRenderer.invoke("device:connect", device, opts),
  retryProvision: (): Promise<AppRuntimeState> => ipcRenderer.invoke("host:retryProvision"),
  streamDevice: (device: DeviceInfo, opts?: ConnectOptions): Promise<ConnectDeviceResult> =>
    ipcRenderer.invoke("device:stream", device, opts),
  openMoonlightGui: (): Promise<void> => ipcRenderer.invoke("device:moonlightGui"),
  connectRustDesk: (device: DeviceInfo, opts?: ConnectOptions): Promise<ConnectDeviceResult> =>
    ipcRenderer.invoke("device:rustdesk", device, opts),
  wakeDevice: (device: DeviceInfo): Promise<{ status: string; methods?: string[] }> =>
    ipcRenderer.invoke("device:wake", device),
  requestPair: (args: { hostDeviceId: string; pin: string }): Promise<{ status: string; message?: string }> =>
    ipcRenderer.invoke("device:pairRequest", args),
  updateDevice: (args: {
    deviceId: string;
    patch: Partial<Pick<DeviceInfo, "name" | "mac_address" | "broadcast_ip" | "visibility">>;
  }): Promise<AppRuntimeState> => ipcRenderer.invoke("device:update", args),
  deleteDevice: (deviceId: string): Promise<AppRuntimeState> => ipcRenderer.invoke("device:delete", deviceId),
  adminListUsers: (): Promise<UserInfo[]> => ipcRenderer.invoke("admin:listUsers"),
  adminCreateUser: (payload: {
    username: string;
    display_name: string;
    password: string;
    role: "admin" | "member";
  }): Promise<UserInfo> => ipcRenderer.invoke("admin:createUser", payload),
  adminUpdateUser: (args: {
    userId: string;
    patch: { display_name?: string; role?: "admin" | "member"; enabled?: boolean; password?: string };
  }): Promise<UserInfo> => ipcRenderer.invoke("admin:updateUser", args),
  adminDeleteUser: (userId: string): Promise<boolean> => ipcRenderer.invoke("admin:deleteUser", userId),
  getSessionState: (): Promise<ActiveSessionState | null> => ipcRenderer.invoke("session:getState"),
  updateSessionOptions: (patch: Partial<StreamPreset>): Promise<ActiveSessionState | null> =>
    ipcRenderer.invoke("session:updateOptions", patch),
  fitSessionWindow: (): Promise<ActiveSessionState | null> => ipcRenderer.invoke("session:fitWindow"),
  toggleSessionFullscreen: (): Promise<ActiveSessionState | null> =>
    ipcRenderer.invoke("session:toggleFullscreen"),
  sendSessionHotkey: (action: SessionHotkeyAction): Promise<void> =>
    ipcRenderer.invoke("session:sendHotkey", action),
  focusSessionRemote: (): Promise<void> => ipcRenderer.invoke("session:focusRemote"),
  switchSessionOfficeMode: (): Promise<void> => ipcRenderer.invoke("session:switchOfficeMode"),
  disconnectSession: (): Promise<void> => ipcRenderer.invoke("session:disconnect"),
  setSessionBarExpanded: (expanded: boolean): Promise<void> =>
    ipcRenderer.invoke("session:setBarExpanded", expanded),
  nudgeSessionBarOffset: (deltaX: number): Promise<void> =>
    ipcRenderer.invoke("session:setBarOffset", deltaX),
  refreshSessionDisplays: (): Promise<ActiveSessionState | null> =>
    ipcRenderer.invoke("session:refreshDisplays"),
  selectSessionDisplay: (displayId: string): Promise<ActiveSessionState | null> =>
    ipcRenderer.invoke("session:selectDisplay", displayId),
  setSessionHostMute: (muted: boolean): Promise<ActiveSessionState | null> =>
    ipcRenderer.invoke("session:setHostMute", muted),
  setSessionPrivacy: (active: boolean): Promise<ActiveSessionState | null> =>
    ipcRenderer.invoke("session:setPrivacy", active),
  runSessionSystemAction: (action: SystemActionType): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke("session:runSystemAction", action),
  setSessionAutoLock: (enabled: boolean): Promise<ActiveSessionState | null> =>
    ipcRenderer.invoke("session:setAutoLock", enabled),
  setAccessPassword: (payload: AccessPasswordPayload): Promise<AppRuntimeState> =>
    ipcRenderer.invoke("host:setAccessPassword", payload),
  rotateTempPassword: (): Promise<AppRuntimeState> => ipcRenderer.invoke("host:rotateTempPassword"),
  onSessionChanged: (cb: (state: ActiveSessionState | null) => void): (() => void) => {
    const listener = (_evt: Electron.IpcRendererEvent, state: ActiveSessionState | null) => cb(state);
    ipcRenderer.on("session:stateChanged", listener);
    return () => ipcRenderer.removeListener("session:stateChanged", listener);
  },
  onStateChanged: (cb: (state: AppRuntimeState) => void): (() => void) => {
    const listener = (_evt: Electron.IpcRendererEvent, state: AppRuntimeState) => cb(state);
    ipcRenderer.on("app:stateChanged", listener);
    return () => ipcRenderer.removeListener("app:stateChanged", listener);
  },
};

contextBridge.exposeInMainWorld("silkwarp", api);

export type SilkWarpBridge = typeof api;
