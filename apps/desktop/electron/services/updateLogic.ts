/**
 * Pure semver, GitHub release payload parsing, URL safety validation, and
 * SHA-256 verification helpers for SilkWarp desktop auto-updates.
 *
 * Zero `electron` imports so Node's built-in test runner can exercise every edge case.
 */

import crypto from "node:crypto";
import fs from "node:fs";

export interface UpdateReleaseInfo {
  version: string;
  tagName: string;
  name: string;
  publishedAt: string;
  notes: string;
  releaseUrl: string;
  downloadUrl: string;
  assetName: string;
  sizeBytes: number;
  sha256: string | null;
}

export interface UpdateCheckResult {
  status: "up_to_date" | "available" | "error";
  currentVersion: string;
  latestVersion?: string;
  hasUpdate: boolean;
  release?: UpdateReleaseInfo;
  message: string;
}

export interface UpdateDownloadProgress {
  phase: "downloading" | "verifying" | "ready" | "error";
  version: string;
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
  filePath?: string;
  message?: string;
}

export interface UpdateDownloadResult {
  ok: boolean;
  filePath?: string;
  version: string;
  sha256Verified: boolean;
  actualSha256?: string;
  message: string;
}

const ALLOWED_UPDATE_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

const SHA256_DIGEST_FIELD = /^sha256:([a-fA-F0-9]{64})$/i;
const HEX_64 = /\b([a-fA-F0-9]{64})\b/;

export function parseSemver(version: string): [number, number, number] | null {
  if (typeof version !== "string") return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

export function isAllowedUpdateDownloadUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return false;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "https:") return false;
    return ALLOWED_UPDATE_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function extractSha256FromRelease(
  asset: { name?: string; digest?: string } | null,
  body: string,
): string | null {
  if (asset && typeof asset.digest === "string") {
    const m = SHA256_DIGEST_FIELD.exec(asset.digest.trim());
    if (m) return m[1].toUpperCase();
  }

  if (typeof body !== "string" || !body.trim()) return null;
  const lines = body.split(/\r?\n/);
  const assetNameLower = asset?.name ? asset.name.toLowerCase() : "";

  if (assetNameLower) {
    for (const line of lines) {
      if (line.toLowerCase().includes(assetNameLower)) {
        const m = HEX_64.exec(line);
        if (m) return m[1].toUpperCase();
      }
    }
  }

  for (const line of lines) {
    if (/sha-?256|校验/i.test(line)) {
      const m = HEX_64.exec(line);
      if (m) return m[1].toUpperCase();
    }
  }
  return null;
}

function summarizeNotes(rawBody: string): string {
  const lines = rawBody
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^[a-fA-F0-9]{64}$/.test(line));
  const compact = lines.slice(0, 14).join("\n");
  return compact.length > 800 ? `${compact.slice(0, 797)}...` : compact;
}

export function parseLatestReleasePayload(currentVersion: string, payload: unknown): UpdateCheckResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      status: "error",
      currentVersion,
      hasUpdate: false,
      message: "更新服务器返回了无效格式",
    };
  }

  const obj = payload as Record<string, unknown>;
  if (obj.draft === true) {
    return {
      status: "up_to_date",
      currentVersion,
      hasUpdate: false,
      message: "当前已是最新正式版本",
    };
  }

  const tagName = typeof obj.tag_name === "string" ? obj.tag_name.trim() : "";
  const parsedLatest = parseSemver(tagName);
  if (!parsedLatest) {
    return {
      status: "error",
      currentVersion,
      hasUpdate: false,
      message: `无法解析最新版本号: ${tagName || "未知"}`,
    };
  }

  const latestVersion = parsedLatest.join(".");
  const hasUpdate = compareSemver(latestVersion, currentVersion) > 0;
  const releaseUrl =
    typeof obj.html_url === "string" && obj.html_url
      ? obj.html_url
      : `https://github.com/CleoCheng/silkwarp/releases/tag/${encodeURIComponent(tagName)}`;
  const body = typeof obj.body === "string" ? obj.body : "";
  const releaseName = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : `SilkWarp v${latestVersion}`;
  const publishedAt = typeof obj.published_at === "string" ? obj.published_at : "";

  const assets = Array.isArray(obj.assets) ? (obj.assets as Record<string, unknown>[]) : [];
  const exeAsset = assets.find((a) => {
    const name = typeof a?.name === "string" ? a.name.trim() : "";
    return /^SilkWarp-Setup-.*\.exe$/i.test(name) && !name.toLowerCase().endsWith(".blockmap");
  });

  if (!hasUpdate) {
    return {
      status: "up_to_date",
      currentVersion,
      latestVersion,
      hasUpdate: false,
      message: `当前已是最新版本 v${currentVersion}`,
    };
  }

  const assetName = exeAsset && typeof exeAsset.name === "string" ? exeAsset.name.trim() : "";
  const downloadUrl =
    exeAsset && typeof exeAsset.browser_download_url === "string"
      ? exeAsset.browser_download_url.trim()
      : "";

  if (!exeAsset || !assetName || !isAllowedUpdateDownloadUrl(downloadUrl)) {
    return {
      status: "error",
      currentVersion,
      latestVersion,
      hasUpdate: false,
      message: `发现新版本 v${latestVersion}，但未找到有效的 Windows 安装包资源`,
    };
  }

  const sha256 = extractSha256FromRelease(
    {
      name: assetName,
      digest: typeof exeAsset.digest === "string" ? exeAsset.digest : undefined,
    },
    body,
  );

  const sizeBytes =
    typeof exeAsset.size === "number" && Number.isFinite(exeAsset.size) && exeAsset.size >= 0
      ? exeAsset.size
      : 0;

  return {
    status: "available",
    currentVersion,
    latestVersion,
    hasUpdate: true,
    release: {
      version: latestVersion,
      tagName,
      name: releaseName,
      publishedAt,
      notes: summarizeNotes(body),
      releaseUrl,
      downloadUrl,
      assetName,
      sizeBytes,
      sha256,
    },
    message: `发现新版本 v${latestVersion}`,
  };
}

export async function verifyFileSha256(filePath: string, expectedSha256: string): Promise<boolean> {
  const expected = expectedSha256.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) return false;

  const actual = await new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex").toLowerCase()));
    stream.on("error", reject);
  });

  return actual === expected;
}
