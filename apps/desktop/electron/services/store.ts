import { app, safeStorage } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppSettings, StreamPreset, UserInfo } from "../types";
import { DEFAULT_AGENT_PORT } from "./hostAgentAuth";
import { serializeStateIfChanged } from "./hostMaintenance";
import { DEFAULT_STREAM_PRESET, normalizeStreamPreset } from "./streamOptions";

export interface ExternalAppConfig {
  apiUrl?: string;
  meshCidr?: string;
  defaultBroadcastIp?: string;
}

export interface PersistedState {
  apiUrl: string;
  token: string;
  user: UserInfo | null;
  deviceId: string;
  isHost: boolean;
  autoApprovePair: boolean;
  autoStart: boolean;
  apolloUser: string;
  apolloPass: string;
  pairedHosts: Record<string, string>;
  preset: StreamPreset;
  requireAccessPassword: boolean;
  accessPasswordHash: string;
  allowSameAccountBypass: boolean;
  autoLockOnDisconnect: boolean;
  savedDevicePasswords: Record<string, string>;
  hostDisplayResolutions: Record<string, string>;
  hostDisplayRefreshRates: Record<string, number>;
}

function normalizeApiUrl(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
}

function loadExternalConfig(): ExternalAppConfig {
  const candidates = [
    process.env.SILKWARP_CONFIG_PATH || "",
    path.join(app.getPath("userData"), "silkwarp.config.json"),
    path.join(path.dirname(process.execPath), "silkwarp.config.json"),
    path.resolve(process.cwd(), "silkwarp.config.json"),
    path.resolve(process.cwd(), "../../silkwarp.config.json"),
    path.resolve(app.getAppPath(), "../../silkwarp.config.json"),
  ].filter(Boolean);

  const merged: ExternalAppConfig = {};
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf-8")) as Record<string, unknown>;
      const apiUrl = normalizeApiUrl(parsed.apiUrl);
      if (apiUrl) merged.apiUrl = apiUrl;
      if (typeof parsed.meshCidr === "string" && parsed.meshCidr.trim()) {
        merged.meshCidr = parsed.meshCidr.trim();
      }
      if (typeof parsed.defaultBroadcastIp === "string" && parsed.defaultBroadcastIp.trim()) {
        merged.defaultBroadcastIp = parsed.defaultBroadcastIp.trim();
      }
      break;
    } catch {
      // ignore invalid external config files and keep probing fallbacks
    }
  }

  const envUrl = normalizeApiUrl(process.env.SILKWARP_API_URL);
  if (envUrl) {
    merged.apiUrl = envUrl;
  }
  return merged;
}

export class StateStore {
  private readonly filePath: string;
  private readonly externalConfig: ExternalAppConfig;
  private state: PersistedState;
  private lastSavedJson = "";

  constructor() {
    const dir = app.getPath("userData");
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, "silkwarp-state.json");
    this.externalConfig = loadExternalConfig();
    this.state = this.load();
  }

  getExternalConfig(): ExternalAppConfig {
    return this.externalConfig;
  }

  private load(): PersistedState {
    const fallback: PersistedState = {
      apiUrl: this.externalConfig.apiUrl || "",
      token: "",
      user: null,
      deviceId: crypto.randomUUID(),
      isHost: true,
      autoApprovePair: true,
      autoStart: false,
      apolloUser: "",
      apolloPass: "",
      pairedHosts: {},
      preset: { ...DEFAULT_STREAM_PRESET },
      requireAccessPassword: false,
      accessPasswordHash: "",
      allowSameAccountBypass: true,
      autoLockOnDisconnect: false,
      savedDevicePasswords: {},
      hostDisplayResolutions: {},
      hostDisplayRefreshRates: {},
    };
    try {
      if (!fs.existsSync(this.filePath)) {
        this.saveRaw(fallback);
        return fallback;
      }
      const rawText = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(rawText) as Partial<PersistedState>;
      const merged: PersistedState = {
        ...fallback,
        ...parsed,
        pairedHosts: parsed.pairedHosts ?? {},
        preset: normalizeStreamPreset(parsed.preset),
        requireAccessPassword:
          typeof parsed.requireAccessPassword === "boolean" ? parsed.requireAccessPassword : false,
        accessPasswordHash: typeof parsed.accessPasswordHash === "string" ? parsed.accessPasswordHash : "",
        allowSameAccountBypass:
          typeof parsed.allowSameAccountBypass === "boolean" ? parsed.allowSameAccountBypass : true,
        autoLockOnDisconnect:
          typeof parsed.autoLockOnDisconnect === "boolean" ? parsed.autoLockOnDisconnect : false,
        savedDevicePasswords:
          parsed.savedDevicePasswords &&
          typeof parsed.savedDevicePasswords === "object" &&
          !Array.isArray(parsed.savedDevicePasswords)
            ? parsed.savedDevicePasswords
            : {},
        hostDisplayResolutions:
          parsed.hostDisplayResolutions &&
          typeof parsed.hostDisplayResolutions === "object" &&
          !Array.isArray(parsed.hostDisplayResolutions)
            ? parsed.hostDisplayResolutions
            : {},
        hostDisplayRefreshRates:
          parsed.hostDisplayRefreshRates &&
          typeof parsed.hostDisplayRefreshRates === "object" &&
          !Array.isArray(parsed.hostDisplayRefreshRates)
            ? parsed.hostDisplayRefreshRates
            : {},
      };
      let needsSync = false;
      if (!merged.apiUrl && this.externalConfig.apiUrl) {
        merged.apiUrl = this.externalConfig.apiUrl;
        needsSync = true;
      }
      if (!merged.deviceId) {
        merged.deviceId = crypto.randomUUID();
        needsSync = true;
      }
      if (needsSync) {
        this.saveRaw(merged);
      } else {
        this.lastSavedJson = rawText;
      }
      return merged;
    } catch {
      return fallback;
    }
  }

  private saveRaw(data: PersistedState, preSerialized?: string): void {
    const json = preSerialized ?? JSON.stringify(data, null, 2);
    fs.writeFileSync(this.filePath, json, { encoding: "utf-8", mode: 0o600 });
    this.lastSavedJson = json;
  }

  get(): PersistedState {
    return this.state;
  }

  getPublicSettings(): AppSettings {
    return {
      apiUrl: this.state.apiUrl,
      deviceId: this.state.deviceId,
      isHost: this.state.isHost,
      autoApprovePair: this.state.autoApprovePair,
      autoStart: this.state.autoStart,
      apolloUser: this.state.apolloUser,
      apolloPass: this.state.apolloPass,
      preset: this.state.preset,
      requireAccessPassword: this.state.requireAccessPassword,
      hasAccessPassword: Boolean(this.state.accessPasswordHash),
      allowSameAccountBypass: this.state.allowSameAccountBypass,
      autoLockOnDisconnect: this.state.autoLockOnDisconnect,
      agentPort: DEFAULT_AGENT_PORT,
      tempAccessPassword: "",
      tempAccessPasswordExpiresAt: 0,
    };
  }

  /** Encrypts a secret with the OS keystore when available, else base64. */
  encodeSecret(plain: string): string {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return `enc:${safeStorage.encryptString(plain).toString("base64")}`;
      }
    } catch {
      // keystore unavailable (e.g. before app ready): fall back to plain base64
    }
    return `plain:${Buffer.from(plain, "utf8").toString("base64")}`;
  }

  /** Decrypts a value produced by {@link encodeSecret}; failures yield `""`. */
  decodeSecret(stored: string): string {
    if (typeof stored !== "string" || !stored) return "";
    try {
      if (stored.startsWith("enc:")) {
        const payload = Buffer.from(stored.slice(4), "base64");
        return safeStorage.decryptString(payload);
      }
      if (stored.startsWith("plain:")) {
        return Buffer.from(stored.slice(6), "base64").toString("utf8");
      }
    } catch {
      return "";
    }
    return "";
  }

  getSavedDevicePassword(deviceId: string): string {
    const encoded = this.state.savedDevicePasswords[deviceId];
    return encoded ? this.decodeSecret(encoded) : "";
  }

  setSavedDevicePassword(deviceId: string, password: string): void {
    if (!deviceId) return;
    const next = { ...this.state.savedDevicePasswords };
    if (!password) {
      delete next[deviceId];
    } else {
      next[deviceId] = this.encodeSecret(password);
    }
    this.update({ savedDevicePasswords: next });
  }

  clearSavedDevicePassword(deviceId: string): void {
    if (!deviceId || !(deviceId in this.state.savedDevicePasswords)) return;
    const next = { ...this.state.savedDevicePasswords };
    delete next[deviceId];
    this.update({ savedDevicePasswords: next });
  }

  getHostDisplayResolution(deviceId: string): string {
    const val = this.state.hostDisplayResolutions[deviceId];
    return typeof val === "string" ? val : "";
  }

  setHostDisplayResolution(deviceId: string, resolution: string): void {
    if (!deviceId || !resolution) return;
    if (this.state.hostDisplayResolutions[deviceId] === resolution) return;
    this.update({
      hostDisplayResolutions: {
        ...this.state.hostDisplayResolutions,
        [deviceId]: resolution,
      },
    });
  }

  getHostDisplayRefreshHz(deviceId: string): number {
    const val = this.state.hostDisplayRefreshRates[deviceId];
    return typeof val === "number" && Number.isFinite(val) && val > 0 ? val : 0;
  }

  setHostDisplayRefreshHz(deviceId: string, refreshHz: number): void {
    if (!deviceId || !Number.isFinite(refreshHz) || refreshHz <= 0 || refreshHz > 1000) return;
    const rounded = Math.round(refreshHz);
    if (this.state.hostDisplayRefreshRates[deviceId] === rounded) return;
    this.update({
      hostDisplayRefreshRates: {
        ...this.state.hostDisplayRefreshRates,
        [deviceId]: rounded,
      },
    });
  }

  update(patch: Partial<PersistedState>): PersistedState {
    const nextState: PersistedState = {
      ...this.state,
      ...patch,
      preset: normalizeStreamPreset(
        patch.preset ? { ...this.state.preset, ...patch.preset } : this.state.preset,
      ),
    };
    this.state = nextState;
    const nextJson = serializeStateIfChanged(this.lastSavedJson, nextState);
    if (nextJson !== null) {
      this.saveRaw(nextState, nextJson);
    }
    return this.state;
  }
}
