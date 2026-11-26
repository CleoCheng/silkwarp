import { app } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppSettings, StreamPreset, UserInfo } from "../types";

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
}

const DEFAULT_PRESET: StreamPreset = {
  resolution: "2560x1440",
  fps: 120,
  bitrateMbps: 35,
  codec: "hevc",
};

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
      preset: { ...DEFAULT_PRESET },
    };
    try {
      if (!fs.existsSync(this.filePath)) {
        this.saveRaw(fallback);
        return fallback;
      }
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as Partial<PersistedState>;
      const merged: PersistedState = {
        ...fallback,
        ...parsed,
        pairedHosts: parsed.pairedHosts ?? {},
        preset: { ...DEFAULT_PRESET, ...(parsed.preset ?? {}) },
      };
      if (!merged.apiUrl && this.externalConfig.apiUrl) {
        merged.apiUrl = this.externalConfig.apiUrl;
      }
      if (!merged.deviceId) {
        merged.deviceId = crypto.randomUUID();
      }
      return merged;
    } catch {
      return fallback;
    }
  }

  private saveRaw(data: PersistedState): void {
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
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
    };
  }

  update(patch: Partial<PersistedState>): PersistedState {
    this.state = {
      ...this.state,
      ...patch,
      preset: patch.preset ? { ...this.state.preset, ...patch.preset } : this.state.preset,
    };
    this.saveRaw(this.state);
    return this.state;
  }
}
