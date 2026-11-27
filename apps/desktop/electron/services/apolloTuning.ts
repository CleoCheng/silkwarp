/**
 * Pure Apollo/Sunshine `/api/config` streaming-pipeline tuning helpers.
 *
 * IMPORTANT: this module must not import `electron` so that Node unit tests
 * can import the compiled CommonJS module directly.
 */

export const APOLLO_READONLY_CONFIG_KEYS = [
  "status",
  "status_code",
  "version",
  "platform",
  "has_session",
  "login_pin",
  "vdisplayStatus",
] as const;

/**
 * Lossless low-latency WAN streaming defaults applied to SilkWarp Apollo hosts:
 * - `fec_percentage: 20`: preserves full FEC redundancy to recover WAN UDP burst drops
 * - `lan_encryption_mode: 0`: avoids double AES-GCM encryption over EasyTier's encrypted mesh
 * - `qsv_preset: "medium"`: keeps full visual quality on Intel QuickSync without "veryfast" degradation
 * - `minimum_fps_target: 0`: automatic VFR so static desktop views don't flood uplink
 * - `hevc_mode: 0`: auto-enable hardware HEVC
 * - `ping_timeout: 20000`: tolerates WAN jitter without spurious disconnect popups
 * - `nvenc_intra_refresh: "enabled"` & `nvenc_latency_over_power: "enabled"`: heals WAN drops row-by-row on NVIDIA hosts
 * - `amd_usage: "ultralowlatency"` & `amd_rc: "vbr_latency"`: minimizes encoder buffering on AMD AMF hosts
 */
export const SILKWARP_APOLLO_TUNING = {
  fec_percentage: 20,
  lan_encryption_mode: 0,
  qsv_preset: "medium",
  minimum_fps_target: 0,
  hevc_mode: 0,
  ping_timeout: 20000,
  nvenc_intra_refresh: "enabled",
  nvenc_latency_over_power: "enabled",
  amd_usage: "ultralowlatency",
  amd_rc: "vbr_latency",
} as const;

export interface ApolloConfigPatchResult {
  changed: boolean;
  changedKeys: string[];
  nextConfig: Record<string, unknown>;
}

/**
 * Computes an idempotent full `/api/config` payload that strips read-only
 * status fields and applies SilkWarp's non-lossy host encoder/network tuning
 * while preserving existing user settings (`output_name`, `server_cmd`, etc.).
 */
export function buildOptimalApolloConfigPatch(
  currentConfig: Record<string, unknown>,
  tuning: Record<string, string | number> = SILKWARP_APOLLO_TUNING,
): ApolloConfigPatchResult {
  const nextConfig: Record<string, unknown> = JSON.parse(JSON.stringify(currentConfig ?? {}));
  for (const key of APOLLO_READONLY_CONFIG_KEYS) {
    delete nextConfig[key];
  }

  const changedKeys: string[] = [];
  for (const [key, desired] of Object.entries(tuning)) {
    const existing = nextConfig[key];
    const existingNorm = existing === undefined || existing === null ? "" : String(existing).trim();
    const desiredNorm = String(desired).trim();

    if (existingNorm !== desiredNorm) {
      nextConfig[key] = typeof existing === "string" ? desiredNorm : desired;
      changedKeys.push(key);
    }
  }

  return {
    changed: changedKeys.length > 0,
    changedKeys,
    nextConfig,
  };
}
