import type {
  DisplayMode,
  StreamAppTarget,
  StreamPreset,
  SystemKeyCaptureMode,
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
};

const RESOLUTION_RE = /^\d{3,4}x\d{3,4}$/;
const ALLOWED_FPS = [30, 60, 120, 144] as const;
const ALLOWED_CODECS = ["hevc", "av1", "h264"] as const;
const ALLOWED_DISPLAY_MODES: DisplayMode[] = ["windowed", "borderless", "fullscreen"];
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
    fps,
    bitrateMbps: clampBitrate(src.bitrateMbps),
    codec,
    displayMode,
    streamApp,
    muteHostAudio: boolOr(src.muteHostAudio, d.muteHostAudio),
    lowLatency: boolOr(src.lowLatency, d.lowLatency),
    adaptiveRelayCap: boolOr(src.adaptiveRelayCap, d.adaptiveRelayCap),
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
 * Resolves the UDP payload size passed to Moonlight. The default 1392-byte
 * payload fragments over SilkWarp's 1360-MTU Wintun adapter, so we stay below
 * it; relay hops get an even smaller payload to absorb tunnel overhead.
 */
export function resolvePacketSize(preset: StreamPreset, routeType: string): number {
  if (typeof preset.packetSize === "number" && Number.isFinite(preset.packetSize)) {
    return Math.min(MAX_PACKET_SIZE, Math.max(MIN_PACKET_SIZE, Math.round(preset.packetSize)));
  }
  return routeType.trim().toLowerCase().startsWith("relay") ? 1024 : 1200;
}

/**
 * Applies the relay guardrail. Only the effective command-line preset is
 * clamped; the user's persisted P2P preset is never mutated.
 */
export function computeEffectivePreset(preset: StreamPreset, routeType: string): StreamPreset {
  if (preset.adaptiveRelayCap && routeType.trim().toLowerCase().startsWith("relay")) {
    return {
      ...preset,
      fps: preset.fps > 60 ? 60 : preset.fps,
      bitrateMbps: Math.min(preset.bitrateMbps, 15),
    };
  }
  return { ...preset };
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
): string[] {
  const effective = computeEffectivePreset(preset, routeType);
  const packetSize = resolvePacketSize(effective, routeType);
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
    "--capture-system-keys",
    effective.captureSystemKeys,
    effective.absoluteMouse ? "--absolute-mouse" : "--no-absolute-mouse",
    effective.muteHostAudio ? "--no-audio-on-host" : "--audio-on-host",
    effective.showPerfOverlay ? "--performance-overlay" : "--no-performance-overlay",
  ];

  if (effective.lowLatency) {
    args.push("--no-vsync", "--no-frame-pacing", "--no-game-optimization", "--video-decoder", "hardware");
  } else {
    args.push("--vsync", "--frame-pacing", "--video-decoder", "auto");
  }

  args.push("stream", meshIp, resolvedApp);
  return args;
}
