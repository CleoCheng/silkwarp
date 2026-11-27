/**
 * Resolution and CLI argument helpers for the pre-compiled native Windows
 * helper (`silkwarp-win-helper.exe`).
 *
 * Intentionally free of `electron` imports so unit tests can load it directly.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Locates `silkwarp-win-helper.exe` across packaged resources and local dev
 * directories. Setting `SILKWARP_WIN_HELPER_PATH=none|off` disables the native
 * helper so PowerShell fallbacks can be tested cleanly.
 */
export function resolveWinHelperExe(overridePath?: string): string | null {
  const envPath = (process.env.SILKWARP_WIN_HELPER_PATH || "").trim();
  const normalizedEnv = envPath.toLowerCase();
  if (normalizedEnv === "none" || normalizedEnv === "off") {
    return null;
  }

  const candidates = [
    overridePath?.trim() || "",
    envPath,
    path.join(process.resourcesPath || "", "helper", "silkwarp-win-helper.exe"),
    path.resolve(__dirname, "../../resources/helper/silkwarp-win-helper.exe"),
    path.resolve(process.cwd(), "resources/helper/silkwarp-win-helper.exe"),
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Builds argv for `silkwarp-win-helper.exe track <pid> ...`.
 */
export function buildWindowTrackerHelperArgs(
  targetPid: number,
  options: { windowTitle?: string; suppressLocalIme?: boolean } = {},
): string[] {
  const args = ["track", String(targetPid)];
  if (options.windowTitle) {
    const titleB64 = Buffer.from(options.windowTitle, "utf8").toString("base64");
    args.push("--title-b64", titleB64);
  }
  if (options.suppressLocalIme === false) {
    args.push("--no-suppress-ime");
  }
  return args;
}
