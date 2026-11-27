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
] as const;

/**
 * Lossless low-latency WAN streaming defaults applied to SilkWarp Apollo hosts:
 * - `fec_percentage: 10`: halves 20% redundant burst traffic per frame over WAN
 * - `lan_encryption_mode: 0`: avoids double AES-GCM encryption over EasyTier's encrypted mesh
 * - `qsv_preset: "veryfast"`: cuts Intel Iris Xe / Arc encode latency at 2K/4K
 * - `minimum_fps_target: 0`: automatic VFR so static desktop views don't flood uplink
 * - `hevc_mode: 0`: auto-enable hardware HEVC
 * - `ping_timeout: 15000`: tolerates brief WAN jitter without spurious disconnect
 */
export const SILKWARP_APOLLO_TUNING = {
  fec_percentage: 10,
  lan_encryption_mode: 0,
  qsv_preset: "veryfast",
  minimum_fps_target: 0,
  hevc_mode: 0,
  ping_timeout: 15000,
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
