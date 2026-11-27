import type {
  DisplayMode,
  DisplayMonitorInfo,
  ResolutionMode,
  StreamAppTarget,
  StreamPreset,
  SystemKeyCaptureMode,
  WindowRect,
} from "../types";

/**
 * Pure stream-preset helpers shared by the Electron main process, the state
 * store and the Node unit tests.
 *
 * IMPORTANT: this module must not import `electron` or any native GUI module so
 * that `node --test scripts/test_stream_options.cjs` can load the compiled
 * CommonJS output directly.
 */

export const DEFAULT_STREAM_PRESET: StreamPreset = {
  resolution: "2560x1440",
  resolutionMode: "follow_client",
  fps: 60,
  bitrateMbps: 20,
  codec: "hevc",
  displayMode: "windowed",
  streamApp: "Virtual Display",
  muteHostAudio: true,
  lowLatency: true,
  adaptiveRelayCap: true,
  yuv444: false,
  absoluteMouse: true,
  showPerfOverlay: false,
  captureSystemKeys: "fullscreen",
  packetSize: "auto",
};

export interface StreamLinkQuality {
  tunnel?: string | null;
  latencyMs?: number | null;
  lossPercent?: number | null;
  clientRefreshHz?: number | null;
  recoveryBitrateCapMbps?: number | null;
}

export function parseLossPercent(raw?: string | null): number | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().replace(/%$/, "");
  if (!cleaned || cleaned === "-") return null;
  const val = Number.parseFloat(cleaned);
  return Number.isFinite(val) && val >= 0 ? val : null;
}

export function isTcpOnlyTunnel(tunnel?: string | null): boolean {
  if (typeof tunnel !== "string") return false;
  const t = tunnel.trim().toLowerCase();
  if (!t || t === "-") return false;
  return t.includes("tcp") && !t.includes("udp");
}

export function isLocalLanLink(routeType: string, link?: StreamLinkQuality | null): boolean {
  const route = routeType.trim().toLowerCase();
  if (route === "local") return true;
  if (route !== "p2p") return false;
  if (isTcpOnlyTunnel(link?.tunnel)) return false;
  if (typeof link?.latencyMs !== "number" || !Number.isFinite(link.latencyMs) || link.latencyMs >= 8) {
    return false;
  }
  const loss = typeof link?.lossPercent === "number" && Number.isFinite(link.lossPercent) ? link.lossPercent : 0;
  return loss < 0.5;
}

export function isDegradedLink(routeType: string, link?: StreamLinkQuality | null): boolean {
  if (routeType.trim().toLowerCase().startsWith("relay")) return true;
  if (isTcpOnlyTunnel(link?.tunnel)) return true;
  if (typeof link?.latencyMs === "number" && Number.isFinite(link.latencyMs) && link.latencyMs >= 60) {
    return true;
  }
  if (typeof link?.lossPercent === "number" && Number.isFinite(link.lossPercent) && link.lossPercent >= 1) {
    return true;
  }
  return false;
}

const RESOLUTION_RE = /^\d{3,4}x\d{3,4}$/;
const ALLOWED_FPS = [30, 60, 120, 144] as const;
const ALLOWED_CODECS = ["hevc", "av1", "h264"] as const;
const ALLOWED_DISPLAY_MODES: DisplayMode[] = ["windowed", "borderless", "fullscreen"];
const ALLOWED_RESOLUTION_MODES: ResolutionMode[] = ["follow_client", "follow_host", "fit_window", "fixed"];
const ALLOWED_STREAM_APPS: StreamAppTarget[] = ["Virtual Display", "Desktop"];
const ALLOWED_SYSTEM_KEY_MODES: SystemKeyCaptureMode[] = ["always", "fullscreen", "never"];

const MIN_BITRATE_MBPS = 4;
const MAX_BITRATE_MBPS = 100;
const MIN_PACKET_SIZE = 512;
const MAX_PACKET_SIZE = 1320;

function clampBitrate(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_STREAM_PRESET.bitrateMbps;
  return Math.min(MAX_BITRATE_MBPS, Math.max(MIN_BITRATE_MBPS, Math.round(raw)));
}

function normalizePacketSize(raw: unknown): "auto" | number {
  if (raw === "auto" || raw === undefined || raw === null) return "auto";
  if (typeof raw !== "number" || !Number.isFinite(raw)) return "auto";
  const rounded = Math.round(raw);
  if (rounded < MIN_PACKET_SIZE || rounded > MAX_PACKET_SIZE) return "auto";
  return rounded;
}

function boolOr(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/**
 * Migrates legacy 4-field presets (`resolution` / `fps` / `bitrateMbps` /
 * `codec`) and fills every new stage-1 field with a safe default.
 */
export function normalizeStreamPreset(raw?: Partial<StreamPreset> | null): StreamPreset {
  const src = raw ?? {};
  const d = DEFAULT_STREAM_PRESET;

  const resolution =
    typeof src.resolution === "string" && RESOLUTION_RE.test(src.resolution)
      ? src.resolution
      : d.resolution;

  const fps = ALLOWED_FPS.includes(src.fps as (typeof ALLOWED_FPS)[number]) ? (src.fps as StreamPreset["fps"]) : d.fps;

  const codec = ALLOWED_CODECS.includes(src.codec as (typeof ALLOWED_CODECS)[number])
    ? (src.codec as StreamPreset["codec"])
    : d.codec;

  const resolutionMode = ALLOWED_RESOLUTION_MODES.includes(src.resolutionMode as ResolutionMode)
    ? (src.resolutionMode as ResolutionMode)
    : d.resolutionMode;

  const displayMode = ALLOWED_DISPLAY_MODES.includes(src.displayMode as DisplayMode)
    ? (src.displayMode as DisplayMode)
    : d.displayMode;

  const streamApp = ALLOWED_STREAM_APPS.includes(src.streamApp as StreamAppTarget)
    ? (src.streamApp as StreamAppTarget)
    : d.streamApp;

  const captureSystemKeys = ALLOWED_SYSTEM_KEY_MODES.includes(src.captureSystemKeys as SystemKeyCaptureMode)
    ? (src.captureSystemKeys as SystemKeyCaptureMode)
    : d.captureSystemKeys;

  return {
    resolution,
    resolutionMode,
    fps,
    bitrateMbps: clampBitrate(src.bitrateMbps),
    codec,
    displayMode,
    streamApp,
    muteHostAudio: boolOr(src.muteHostAudio, d.muteHostAudio),
    lowLatency: boolOr(src.lowLatency, d.lowLatency),
    adaptiveRelayCap: boolOr(src.adaptiveRelayCap, d.adaptiveRelayCap),
    yuv444: boolOr(src.yuv444, Boolean(d.yuv444)),
    absoluteMouse: boolOr(src.absoluteMouse, d.absoluteMouse),
    showPerfOverlay: boolOr(src.showPerfOverlay, d.showPerfOverlay),
    captureSystemKeys,
    packetSize: normalizePacketSize(src.packetSize),
  };
}

/**
 * Turns an arbitrary client-area size into an even-pixel resolution string that
 * hardware YUV420 encoders accept, clamped to sane streaming bounds.
 */
export function normalizeWindowResolution(width: number, height: number): string {
  const safeWidth = Number.isFinite(width) ? width : 1920;
  const safeHeight = Number.isFinite(height) ? height : 1080;
  const w = Math.floor(Math.min(3840, Math.max(800, safeWidth))) & ~1;
  const h = Math.floor(Math.min(2160, Math.max(600, safeHeight))) & ~1;
  return `${w}x${h}`;
}

/**
 * Picks the best host display for "follow host native resolution": prefers
 * the selected physical monitor, then primary physical monitor, then any valid monitor.
 */
export function pickHostNativeDisplay(
  displays: DisplayMonitorInfo[],
  selectedDisplayId?: string,
): DisplayMonitorInfo | null {
  const valid = displays.filter((d) => d && d.width > 0 && d.height > 0);
  if (valid.length === 0) return null;

  if (selectedDisplayId) {
    const selected = valid.find((d) => d.id === selectedDisplayId && !d.isVirtual);
    if (selected) return selected;
  }

  return (
    valid.find((d) => d.isPrimary && !d.isVirtual) ??
    valid.find((d) => !d.isVirtual) ??
    valid.find((d) => d.isPrimary) ??
    valid[0]
  );
}

/**
 * Resolves effective stream resolution and stream source based on UU-Remote-style
 * resolution mode (`follow_client`, `follow_host`, `fit_window`, `fixed`).
 */
export function resolveTargetResolution(
  mode: ResolutionMode,
  fallbackResolution: string,
  ctx: {
    clientSize?: { width: number; height: number } | null;
    hostDisplays?: DisplayMonitorInfo[];
    selectedDisplayId?: string;
    windowRect?: WindowRect | null;
    availableApps?: string[];
    currentStreamApp?: StreamAppTarget;
  },
): { resolution: string; streamApp: StreamAppTarget } {
  const preferVirtual = (): StreamAppTarget => {
    if (ctx.availableApps && ctx.availableApps.length > 0) {
      return ctx.availableApps.some((a) => a.trim().toLowerCase() === "virtual display")
        ? "Virtual Display"
        : "Desktop";
    }
    return ctx.currentStreamApp ?? "Virtual Display";
  };

  if (mode === "follow_client") {
    const cs = ctx.clientSize;
    if (cs && Number.isFinite(cs.width) && cs.width > 0 && Number.isFinite(cs.height) && cs.height > 0) {
      const normalizedClient = normalizeWindowResolution(cs.width, cs.height);
      const native = pickHostNativeDisplay(ctx.hostDisplays ?? [], ctx.selectedDisplayId);
      const hostMatchesClient =
        native !== null && normalizeWindowResolution(native.width, native.height) === normalizedClient;
      return {
        resolution: normalizedClient,
        streamApp: hostMatchesClient ? "Desktop" : preferVirtual(),
      };
    }
    return { resolution: fallbackResolution, streamApp: preferVirtual() };
  }

  if (mode === "follow_host") {
    const native = pickHostNativeDisplay(ctx.hostDisplays ?? [], ctx.selectedDisplayId);
    return {
      resolution: native ? normalizeWindowResolution(native.width, native.height) : fallbackResolution,
      streamApp: "Desktop",
    };
  }

  if (mode === "fit_window") {
    const rect = ctx.windowRect;
    if (rect) {
      const w = rect.clientWidth > 0 ? rect.clientWidth : rect.width - 16;
      const h = rect.clientHeight > 0 ? rect.clientHeight : rect.height - 39;
      return {
        resolution: normalizeWindowResolution(w, h),
        streamApp: preferVirtual(),
      };
    }
    return { resolution: fallbackResolution, streamApp: preferVirtual() };
  }

  return {
    resolution: fallbackResolution,
    streamApp: ctx.currentStreamApp ?? "Virtual Display",
  };
}

/**
 * Configures SDL3/SDL2 environment variables so the local client IME does not
 * hijack text input on the viewport window with a corner candidate box at (0,0).
 */
export function buildMoonlightSpawnEnv(baseEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...(baseEnv ?? process.env),
    SDL_IME_SHOW_UI: "0",
    SDL_IME_IMPLEMENTED_UI: "composition,candidates",
  };
}

/**
 * Resolves the UDP payload size passed to Moonlight. The default 1392-byte
 * payload fragments over SilkWarp's 1360-MTU Wintun adapter, so we stay below
 * it; WAN/degraded/TCP/relay hops get a smaller 1024-byte payload to avoid
 * fragmentation or bufferbloat without reducing picture quality.
 */
export function resolvePacketSize(
  preset: StreamPreset,
  routeType: string,
  link?: StreamLinkQuality | null,
): number {
  if (typeof preset.packetSize === "number" && Number.isFinite(preset.packetSize)) {
    return Math.min(MAX_PACKET_SIZE, Math.max(MIN_PACKET_SIZE, Math.round(preset.packetSize)));
  }
  const wanLatency = typeof link?.latencyMs === "number" && Number.isFinite(link.latencyMs) && link.latencyMs >= 25;
  return isDegradedLink(routeType, link) || wanLatency ? 1024 : 1200;
}

/**
 * Computes effective stream bitrate/FPS while NEVER downgrading resolution:
 * - Applies emergency `recoveryBitrateCapMbps` if provided after black-screen retry
 * - Respects `adaptiveRelayCap: false` for all passive WAN/relay caps
 * - Trims >60 FPS when display <=65 Hz or on relay / TCP fallback
 * - Caps WAN relay / TCP / lossy bitrate (10/12/18 Mbps for 1080p/2K/4K, scaled
 *   by 0.75 on >=2% loss) so home upload pipes never drop 2K keyframes.
 */
export function computeEffectivePreset(
  preset: StreamPreset,
  routeType: string,
  link?: StreamLinkQuality | null,
): StreamPreset {
  let bitrateMbps = preset.bitrateMbps;
  const hasRecoveryCap =
    typeof link?.recoveryBitrateCapMbps === "number" && Number.isFinite(link.recoveryBitrateCapMbps);
  if (hasRecoveryCap) {
    const recoveryCap = clampBitrate(link.recoveryBitrateCapMbps);
    bitrateMbps = Math.min(bitrateMbps, recoveryCap);
  }

  if (!preset.adaptiveRelayCap) {
    return {
      ...preset,
      bitrateMbps,
      yuv444: hasRecoveryCap ? false : Boolean(preset.yuv444),
    };
  }

  const tcpOnly = isTcpOnlyTunnel(link?.tunnel);
  const isRelay = routeType.trim().toLowerCase().startsWith("relay");
  const loss = typeof link?.lossPercent === "number" && Number.isFinite(link.lossPercent) ? link.lossPercent : 0;
  const refresh60Only =
    typeof link?.clientRefreshHz === "number" &&
    Number.isFinite(link.clientRefreshHz) &&
    link.clientRefreshHz > 0 &&
    link.clientRefreshHz <= 65;

  const fps: StreamPreset["fps"] =
    (refresh60Only || isRelay || tcpOnly) && preset.fps > 60 ? 60 : preset.fps;

  if (isRelay || tcpOnly || loss >= 2) {
    const m = /^(\d{3,4})x(\d{3,4})$/.exec(preset.resolution);
    const pixels = m ? Number(m[1]) * Number(m[2]) : 2560 * 1440;
    let ceiling = pixels <= 1920 * 1080 ? 10 : pixels <= 2560 * 1440 ? 12 : 18;
    if (loss >= 2) {
      ceiling = Math.max(pixels <= 1920 * 1080 ? 6 : 8, Math.round(ceiling * 0.75));
    }
    bitrateMbps = Math.min(bitrateMbps, ceiling);
  }

  const yuv444 =
    Boolean(preset.yuv444) && !isRelay && !tcpOnly && loss < 2 && !hasRecoveryCap;

  return {
    ...preset,
    fps,
    bitrateMbps,
    yuv444,
  };
}

/**
 * Picks the remote app to stream. `Virtual Display` is preferred when the host
 * advertises it; an empty list (probe failed) or a host without the app safely
 * falls back to the physical desktop so a connection is never blocked.
 */
export function resolveStreamAppTarget(preferred: StreamAppTarget, availableApps: string[]): StreamAppTarget {
  if (preferred === "Desktop") return "Desktop";
  if (availableApps.some((a) => a.trim().toLowerCase() === "virtual display")) {
    return "Virtual Display";
  }
  return "Desktop";
}

/**
 * Builds the full Moonlight CLI argument vector. All `--option` flags come
 * first, followed by the `stream <meshIp> <app>` verb tail.
 */
export function buildMoonlightStreamArgs(
  meshIp: string,
  preset: StreamPreset,
  routeType: string,
  resolvedApp: StreamAppTarget,
  link?: StreamLinkQuality | null,
): string[] {
  const effective = computeEffectivePreset(preset, routeType, link);
  const packetSize = resolvePacketSize(effective, routeType, link);
  const localLan = isLocalLanLink(routeType, link);
  const codecMap: Record<StreamPreset["codec"], string> = {
    hevc: "HEVC",
    av1: "AV1",
    h264: "H.264",
  };

  const args: string[] = [
    "--resolution",
    effective.resolution,
    "--fps",
    String(effective.fps),
    "--bitrate",
    String(effective.bitrateMbps * 1000),
    "--video-codec",
    codecMap[effective.codec] || "HEVC",
    "--packet-size",
    String(packetSize),
    "--display-mode",
    effective.displayMode,
    "--audio-config",
    "stereo",
    "--no-hdr",
    effective.yuv444 ? "--yuv444" : "--no-yuv444",
    "--keep-awake",
    "--capture-system-keys",
    effective.captureSystemKeys,
    effective.absoluteMouse ? "--absolute-mouse" : "--no-absolute-mouse",
    effective.muteHostAudio ? "--no-audio-on-host" : "--audio-on-host",
    effective.showPerfOverlay ? "--performance-overlay" : "--no-performance-overlay",
  ];

  if (effective.lowLatency) {
    args.push(
      "--no-vsync",
      localLan ? "--no-frame-pacing" : "--frame-pacing",
      "--no-game-optimization",
      "--video-decoder",
      "auto",
    );
  } else {
    args.push("--vsync", "--frame-pacing", "--video-decoder", "auto");
  }

  args.push("stream", meshIp, resolvedApp);
  return args;
}
