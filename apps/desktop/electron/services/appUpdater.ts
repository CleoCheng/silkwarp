/**
 * Electron-backed update check, verified installer download, and handoff.
 */

import { app, net, shell } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  isAllowedUpdateDownloadUrl,
  parseLatestReleasePayload,
  type UpdateCheckResult,
  type UpdateDownloadProgress,
  type UpdateDownloadResult,
  type UpdateReleaseInfo,
} from "./updateLogic";

export {
  compareSemver,
  extractSha256FromRelease,
  isAllowedUpdateDownloadUrl,
  parseLatestReleasePayload,
  parseSemver,
  verifyFileSha256,
  type UpdateCheckResult,
  type UpdateDownloadProgress,
  type UpdateDownloadResult,
  type UpdateReleaseInfo,
} from "./updateLogic";

export const GITHUB_LATEST_RELEASE_API =
  "https://api.github.com/repos/CleoCheng/silkwarp/releases/latest";

let downloadInFlight: Promise<UpdateDownloadResult> | null = null;

function sanitizeAssetFilename(assetName: string, version: string): string {
  const base = path.basename(assetName || "").replace(/[^\w.-]/g, "");
  if (/^SilkWarp-Setup-.*\.exe$/i.test(base)) {
    return base;
  }
  const cleanVer = version.replace(/[^\w.-]/g, "") || "latest";
  return `SilkWarp-Setup-${cleanVer}.exe`;
}

export async function checkForUpdates(currentVersion = app.getVersion()): Promise<UpdateCheckResult> {
  try {
    const resp = await net.fetch(GITHUB_LATEST_RELEASE_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `SilkWarp-Desktop/${currentVersion}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      return {
        status: "error",
        currentVersion,
        hasUpdate: false,
        message: `检查更新失败 (HTTP ${resp.status})`,
      };
    }

    const payload: unknown = await resp.json();
    return parseLatestReleasePayload(currentVersion, payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      currentVersion,
      hasUpdate: false,
      message: `检查更新失败：${msg}`,
    };
  }
}

export async function downloadUpdate(
  release: UpdateReleaseInfo,
  onProgress?: (progress: UpdateDownloadProgress) => void,
): Promise<UpdateDownloadResult> {
  if (downloadInFlight) {
    return downloadInFlight;
  }

  downloadInFlight = runDownloadUpdate(release, onProgress).finally(() => {
    downloadInFlight = null;
  });
  return downloadInFlight;
}

async function computeFileSha256Hex(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex").toUpperCase()));
    stream.on("error", reject);
  });
}

async function runDownloadUpdate(
  release: UpdateReleaseInfo,
  onProgress?: (progress: UpdateDownloadProgress) => void,
): Promise<UpdateDownloadResult> {
  if (!release || !isAllowedUpdateDownloadUrl(release.downloadUrl)) {
    return {
      ok: false,
      version: release?.version || "",
      sha256Verified: false,
      message: "更新下载地址未通过安全校验",
    };
  }

  const updatesDir = path.join(app.getPath("userData"), "updates");
  await fs.promises.mkdir(updatesDir, { recursive: true });
  const safeName = sanitizeAssetFilename(release.assetName, release.version);
  const finalPath = path.join(updatesDir, safeName);
  const partPath = `${finalPath}.part`;

  if (release.sha256 && fs.existsSync(finalPath)) {
    try {
      const existingHex = await computeFileSha256Hex(finalPath);
      if (existingHex === release.sha256.toUpperCase()) {
        const size = fs.statSync(finalPath).size;
        onProgress?.({
          phase: "ready",
          version: release.version,
          downloadedBytes: size,
          totalBytes: size,
          percent: 100,
          filePath: finalPath,
          message: "安装包已下载并校验通过",
        });
        return {
          ok: true,
          filePath: finalPath,
          version: release.version,
          sha256Verified: true,
          actualSha256: existingHex,
          message: "安装包已就绪（SHA-256 校验通过）",
        };
      }
    } catch {
      // fall through and re-download cleanly
    }
  }

  let writeStream: fs.WriteStream | null = null;
  try {
    const resp = await net.fetch(release.downloadUrl, {
      headers: { "User-Agent": `SilkWarp-Desktop/${app.getVersion()}` },
    });

    if (!resp.ok || !resp.body) {
      const msg = `下载更新失败 (HTTP ${resp.status})`;
      onProgress?.({
        phase: "error",
        version: release.version,
        downloadedBytes: 0,
        totalBytes: release.sizeBytes,
        percent: 0,
        message: msg,
      });
      return { ok: false, version: release.version, sha256Verified: false, message: msg };
    }

    if (resp.url && !isAllowedUpdateDownloadUrl(resp.url)) {
      const msg = "更新重定向域名未通过安全校验";
      onProgress?.({
        phase: "error",
        version: release.version,
        downloadedBytes: 0,
        totalBytes: release.sizeBytes,
        percent: 0,
        message: msg,
      });
      return { ok: false, version: release.version, sha256Verified: false, message: msg };
    }

    const totalBytes = Number(resp.headers.get("content-length")) || release.sizeBytes || 0;
    writeStream = fs.createWriteStream(partPath, { flags: "w" });
    const stream = writeStream;
    const hash = crypto.createHash("sha256");
    const reader = resp.body.getReader();

    let downloadedBytes = 0;
    let lastEmitAt = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      const chunk = Buffer.from(value);
      hash.update(chunk);
      downloadedBytes += chunk.length;

      if (!stream.write(chunk)) {
        await new Promise<void>((resolve, reject) => {
          stream.once("drain", resolve);
          stream.once("error", reject);
        });
      }

      const now = Date.now();
      if (now - lastEmitAt >= 120) {
        lastEmitAt = now;
        const percent = totalBytes > 0 ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 100)) : 0;
        onProgress?.({
          phase: "downloading",
          version: release.version,
          downloadedBytes,
          totalBytes,
          percent,
        });
      }
    }

    await new Promise<void>((resolve, reject) => {
      stream.once("finish", resolve);
      stream.once("error", reject);
      stream.end();
    });
    writeStream = null;

    onProgress?.({
      phase: "verifying",
      version: release.version,
      downloadedBytes,
      totalBytes: totalBytes || downloadedBytes,
      percent: 100,
      message: "正在校验安装包 SHA-256 完整性…",
    });

    const actualSha256 = hash.digest("hex").toUpperCase();
    let sha256Verified = false;
    if (release.sha256) {
      sha256Verified = actualSha256 === release.sha256.trim().toUpperCase();
      if (!sha256Verified) {
        await fs.promises.unlink(partPath).catch(() => {});
        const msg = "安装包 SHA-256 校验失败，已自动清理损坏文件，请重试下载。";
        onProgress?.({
          phase: "error",
          version: release.version,
          downloadedBytes: 0,
          totalBytes,
          percent: 0,
          message: msg,
        });
        return {
          ok: false,
          version: release.version,
          sha256Verified: false,
          actualSha256,
          message: msg,
        };
      }
    }

    await fs.promises.unlink(finalPath).catch(() => {});
    await fs.promises.rename(partPath, finalPath);

    onProgress?.({
      phase: "ready",
      version: release.version,
      downloadedBytes,
      totalBytes: totalBytes || downloadedBytes,
      percent: 100,
      filePath: finalPath,
      message: sha256Verified ? "下载完成，SHA-256 校验通过" : "下载完成，可点击立即安装",
    });

    return {
      ok: true,
      filePath: finalPath,
      version: release.version,
      sha256Verified,
      actualSha256,
      message: sha256Verified ? "下载完成且 SHA-256 校验通过" : "下载完成",
    };
  } catch (err) {
    if (writeStream) {
      await new Promise<void>((resolve) => {
        writeStream?.once("close", resolve);
        writeStream?.destroy();
      }).catch(() => {});
      writeStream = null;
    }
    await fs.promises.unlink(partPath).catch(() => {});
    const msg = `下载失败：${err instanceof Error ? err.message : String(err)}`;
    onProgress?.({
      phase: "error",
      version: release.version,
      downloadedBytes: 0,
      totalBytes: release.sizeBytes,
      percent: 0,
      message: msg,
    });
    return { ok: false, version: release.version, sha256Verified: false, message: msg };
  }
}

export async function launchDownloadedInstaller(
  filePath: string,
): Promise<{ ok: boolean; message: string }> {
  const updatesDir = path.resolve(app.getPath("userData"), "updates");
  const resolved = path.resolve(String(filePath || ""));
  const prefix = updatesDir.endsWith(path.sep) ? updatesDir : `${updatesDir}${path.sep}`;

  if (
    !resolved.toLowerCase().startsWith(prefix.toLowerCase()) ||
    !resolved.toLowerCase().endsWith(".exe")
  ) {
    return { ok: false, message: "安装程序路径无效或不在更新缓存目录内" };
  }

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      return { ok: false, message: "找不到已下载的安装程序" };
    }
  } catch {
    return { ok: false, message: "找不到已下载的安装程序，请重新下载" };
  }

  const openError = await shell.openPath(resolved);
  if (openError) {
    return { ok: false, message: `启动安装程序失败：${openError}` };
  }
  return { ok: true, message: "正在启动安装程序，SilkWarp 即将退出完成升级" };
}
