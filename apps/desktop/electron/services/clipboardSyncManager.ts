/**
 * Bidirectional clipboard bridge between the local desktop and a remote Host
 * Companion Agent.
 *
 * This module intentionally has NO top-level `electron` import: the Electron
 * clipboard / nativeImage objects are only resolved lazily inside
 * {@link createElectronClipboardAdapter} when no dependencies are injected, so
 * `dist-electron/services/clipboardSyncManager.js` can be loaded directly by
 * Node's built-in test runner.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { HostAgentClient } from "./hostAgentClient";
import type { ClipboardAdapter } from "./hostTransferService";
import type { ClipboardKind, ClipboardPayload } from "./transferValidation";
import {
  MAX_CLIPBOARD_IMAGE_BYTES,
  computeClipboardFingerprint,
  resolveUniqueFilePath,
} from "./transferValidation";

const execFileAsync = promisify(execFile);

/**
 * Largest total payload mirrored automatically when the clipboard contains
 * files. Bigger sets are intentionally left to the explicit drag-and-drop /
 * file drawer UI so a stray Ctrl+C on a 30 GB folder never saturates the Mesh.
 */
export const MAX_CLIPBOARD_AUTO_FILES_BYTES = 50 * 1024 * 1024;

/** Polling cadence for {@link ClipboardSyncManager.start}. */
export const CLIPBOARD_SYNC_INTERVAL_MS = 900;

const CFILES_START_MARKER = "<<<SILKWARP_CFILES>>>";
const CFILES_END_MARKER = "<<<SILKWARP_END>>>";
const CFILES_WRITTEN_MARKER = "<<<SILKWARP_CFILES_WRITTEN>>>";
const POWERSHELL_TIMEOUT_MS = 3000;

const POWERSHELL_PREFIX =
  "$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;\n";

/** Minimal surface of Electron's `clipboard` module used by the adapter. */
export interface ElectronClipboardLike {
  readText(): string;
  writeText(text: string): void;
  readImage(): { isEmpty(): boolean; toPNG(): Buffer };
  writeImage(image: unknown): void;
  availableFormats?(): string[];
}

/** Minimal surface of Electron's `nativeImage` module used by the adapter. */
export interface ElectronNativeImageLike {
  createFromBuffer(buffer: Buffer): unknown;
}

/** Injectable Windows `CF_HDROP` helper (overridable for tests). */
export interface FileDropListHelper {
  read(): Promise<string[]>;
  write(paths: string[]): Promise<boolean>;
}

export interface ElectronClipboardDeps {
  clipboard: ElectronClipboardLike;
  nativeImage: ElectronNativeImageLike;
  /** Optional override for the STA PowerShell `CF_HDROP` helper. */
  fileDropList?: FileDropListHelper;
}

function runPowerShellSta(script: string): Promise<string> {
  const encoded = Buffer.from(`${POWERSHELL_PREFIX}${script}`, "utf16le").toString("base64");
  return execFileAsync(
    "powershell.exe",
    ["-STA", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
  ).then((result) => String(result.stdout || ""));
}

function buildReadFileDropListScript(): string {
  return String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms;
try {
    if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
        Write-Output '${CFILES_START_MARKER}'
        foreach ($item in [System.Windows.Forms.Clipboard]::GetFileDropList()) {
            $entry = @{ path = [string]$item } | ConvertTo-Json -Compress
            Write-Output $entry
        }
    }
} catch {
    # Desktop locked, clipboard owned by another process, or no session:
    # report an empty file list instead of failing the whole read.
}
Write-Output '${CFILES_END_MARKER}'
`;
}

function buildWriteFileDropListScript(paths: string[]): string {
  const payload = Buffer.from(JSON.stringify(paths), "utf8").toString("base64");
  return String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms;
$json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))
$paths = $json | ConvertFrom-Json
$col = New-Object System.Collections.Specialized.StringCollection
foreach ($item in @($paths)) {
    $candidate = [string]$item
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        [void]$col.Add($candidate)
    }
}
if ($col.Count -eq 0) { exit 2 }
[System.Windows.Forms.Clipboard]::SetFileDropList($col)
Write-Output '${CFILES_WRITTEN_MARKER}'
`;
}

/**
 * Windows Explorer's file clipboard lives in `CF_HDROP`, which Electron does
 * not expose, so it is read and written through a short-lived STA PowerShell
 * process. Failures (locked desktop, PowerShell missing, timeout) degrade to
 * "no files" / "write failed" instead of throwing into the polling loop.
 */
export function createWindowsFileDropListHelper(): FileDropListHelper {
  return {
    async read(): Promise<string[]> {
      if (process.platform !== "win32") return [];
      try {
        const output = await runPowerShellSta(buildReadFileDropListScript());
        const startIndex = output.indexOf(CFILES_START_MARKER);
        if (startIndex < 0) return [];
        let body = output.slice(startIndex + CFILES_START_MARKER.length);
        const endIndex = body.indexOf(CFILES_END_MARKER);
        if (endIndex >= 0) body = body.slice(0, endIndex);

        const files: string[] = [];
        for (const line of body.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed: unknown = JSON.parse(trimmed);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              const candidate = (parsed as Record<string, unknown>).path;
              if (typeof candidate === "string" && candidate.trim()) {
                files.push(candidate.trim());
              }
            }
          } catch {
            // Ignore non-JSON banner lines from PowerShell.
          }
        }
        return files;
      } catch {
        return [];
      }
    },

    async write(paths: string[]): Promise<boolean> {
      if (process.platform !== "win32" || paths.length === 0) return false;
      try {
        const output = await runPowerShellSta(buildWriteFileDropListScript(paths));
        return output.includes(CFILES_WRITTEN_MARKER);
      } catch {
        return false;
      }
    },
  };
}

function loadElectronClipboardDeps(): ElectronClipboardDeps {
  // Lazy require so merely importing this module never pulls in Electron and
  // breaks `node --test`. Only called from the Electron main process.
  const electron = require("electron") as {
    clipboard: ElectronClipboardLike;
    nativeImage: ElectronNativeImageLike;
  };
  return { clipboard: electron.clipboard, nativeImage: electron.nativeImage };
}

function isRegularFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function normalizeFileList(raw: string[] | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const files: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const key = process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(trimmed);
  }
  return files;
}

/**
 * Builds the real Electron clipboard adapter.
 *
 * `deps` is injected by tests; in production it is omitted and the Electron
 * `clipboard` / `nativeImage` modules are required lazily.
 */
export function createElectronClipboardAdapter(deps?: ElectronClipboardDeps): ClipboardAdapter {
  const resolved = deps ?? loadElectronClipboardDeps();
  const fileDropList = resolved.fileDropList ?? createWindowsFileDropListHelper();

  return {
    async read(): Promise<ClipboardPayload> {
      const updatedAt = Date.now();

      // 1. Explorer file copies (CF_HDROP). Only probe when the clipboard could
      // plausibly hold files: Electron's format list tells us cheaply, and a
      // text/image clipboard skips the PowerShell round-trip entirely.
      let maybeFiles = true;
      try {
        const formats = resolved.clipboard.availableFormats?.();
        if (Array.isArray(formats) && formats.length > 0) {
          maybeFiles = formats.some((format) => /filenamew|cf_hdrop|filename/i.test(format));
        }
      } catch {
        maybeFiles = true;
      }
      if (maybeFiles) {
        const rawFiles = await fileDropList.read();
        const files = normalizeFileList(rawFiles).filter(isRegularFile);
        if (files.length > 0) {
          return { kind: "files", files, updatedAt };
        }
      }

      // 2. Image payloads (PNG re-encoded so the remote side can write them
      // back with nativeImage.createFromBuffer).
      try {
        const image = resolved.clipboard.readImage();
        if (image && typeof image.isEmpty === "function" && !image.isEmpty()) {
          const png = image.toPNG();
          if (png && png.length > 0 && png.length <= MAX_CLIPBOARD_IMAGE_BYTES) {
            return { kind: "image", imageBase64: png.toString("base64"), updatedAt };
          }
        }
      } catch {
        // A failed image read must not hide plain text.
      }

      // 3. Plain text.
      try {
        const text = resolved.clipboard.readText();
        if (typeof text === "string" && text.length > 0) {
          return { kind: "text", text, updatedAt };
        }
      } catch {
        // Fall through to the empty payload.
      }

      return { kind: "empty", updatedAt };
    },

    async write(payload: ClipboardPayload): Promise<{ ok: boolean; kind: ClipboardKind; message?: string }> {
      if (!payload || payload.kind === "empty") {
        return { ok: false, kind: "empty", message: "剪贴板载荷为空，未写入" };
      }

      if (payload.kind === "text") {
        try {
          resolved.clipboard.writeText(payload.text ?? "");
          return { ok: true, kind: "text" };
        } catch (err) {
          return {
            ok: false,
            kind: "text",
            message: err instanceof Error ? err.message : "写入剪贴板文本失败",
          };
        }
      }

      if (payload.kind === "image") {
        const base64 = (payload.imageBase64 ?? "").replace(/\s+/g, "");
        if (!base64) {
          return { ok: false, kind: "image", message: "剪贴板图片数据为空" };
        }
        const buffer = Buffer.from(base64, "base64");
        if (buffer.length > MAX_CLIPBOARD_IMAGE_BYTES) {
          return { ok: false, kind: "image", message: "剪贴板图片超过 10 MiB 上限" };
        }
        try {
          const image = resolved.nativeImage.createFromBuffer(buffer);
          if (
            image &&
            typeof (image as { isEmpty?: () => boolean }).isEmpty === "function" &&
            (image as { isEmpty: () => boolean }).isEmpty()
          ) {
            return { ok: false, kind: "image", message: "无法解析剪贴板图片数据" };
          }
          resolved.clipboard.writeImage(image);
          return { ok: true, kind: "image" };
        } catch (err) {
          return {
            ok: false,
            kind: "image",
            message: err instanceof Error ? err.message : "写入剪贴板图片失败",
          };
        }
      }

      const files = normalizeFileList(payload.files).filter(isRegularFile);
      if (files.length === 0) {
        return { ok: false, kind: "files", message: "没有可写入剪贴板的本地文件" };
      }
      try {
        const ok = await fileDropList.write(files);
        return ok
          ? { ok: true, kind: "files" }
          : { ok: false, kind: "files", message: "Windows 文件剪贴板写入失败" };
      } catch (err) {
        return {
          ok: false,
          kind: "files",
          message: err instanceof Error ? err.message : "写入文件剪贴板失败",
        };
      }
    },
  };
}

export interface ClipboardSyncTarget {
  connected: boolean;
  host: string;
  port: number;
  token: string;
}

export interface ClipboardSyncStatus {
  enabled: boolean;
  lastKind: ClipboardKind;
  lastSyncedAt: number | null;
  lastError: string;
}

export interface ClipboardSyncManagerOptions {
  getTarget: () => ClipboardSyncTarget | null;
  adapter: ClipboardAdapter;
  client: HostAgentClient;
  onStatusChange?: (status: ClipboardSyncStatus) => void;
  /** Destination for clipboard files pulled from the remote host. */
  defaultReceiveDir?: string;
}

/**
 * Polls both clipboards and mirrors changes, suppressing echo loops with the
 * shared SHA-256 fingerprints.
 *
 * Loop-suppression invariant: every payload the manager pushes *and* every
 * payload it applies locally records both fingerprints (`lastLocalFp` and
 * `lastRemoteFp`) as seen on each side, so the next poll of either side sees
 * "already known" and stays silent.
 */
export class ClipboardSyncManager {
  enabled = true;
  lastLocalFp = "";
  lastRemoteFp = "";
  lastKind: ClipboardKind = "empty";
  lastSyncedAt: number | null = null;
  lastError = "";
  inFlight = false;

  private readonly getTarget: () => ClipboardSyncTarget | null;
  private readonly adapter: ClipboardAdapter;
  private readonly client: HostAgentClient;
  private readonly onStatusChange?: (status: ClipboardSyncStatus) => void;
  private readonly receiveDir: string;

  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(options: ClipboardSyncManagerOptions) {
    this.getTarget = options.getTarget;
    this.adapter = options.adapter;
    this.client = options.client;
    this.onStatusChange = options.onStatusChange;
    this.receiveDir = path.resolve(
      options.defaultReceiveDir ?? path.join(os.homedir(), "Desktop", "SilkWarpRecv"),
    );
  }

  getStatus(): ClipboardSyncStatus {
    return {
      enabled: this.enabled,
      lastKind: this.lastKind,
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError,
    };
  }

  private emitStatus(): void {
    try {
      this.onStatusChange?.(this.getStatus());
    } catch {
      // Status listeners must never break the polling loop.
    }
  }

  private ensureTimer(): void {
    if (this.timer || !this.running || !this.enabled) return;
    this.timer = setInterval(() => {
      void this.syncOnce();
    }, CLIPBOARD_SYNC_INTERVAL_MS);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  setEnabled(enabled: boolean): void {
    const next = Boolean(enabled);
    if (this.enabled === next) return;
    this.enabled = next;
    if (next) {
      this.lastError = "";
      this.ensureTimer();
      void this.syncOnce();
    } else {
      this.clearTimer();
    }
    this.emitStatus();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.ensureTimer();
    void this.syncOnce();
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
  }

  /**
   * Runs one bidirectional exchange. Single-flight: concurrent calls (interval
   * tick + manual "立即同步") are dropped while a previous exchange is running.
   */
  async syncOnce(): Promise<void> {
    if (!this.enabled || this.inFlight) return;
    const target = this.getTarget();
    if (!target || !target.connected || !target.token) return;

    this.inFlight = true;
    try {
      this.lastError = "";
      await this.pushLocalChanges(target);
      await this.pullRemoteChanges(target);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      this.inFlight = false;
      this.emitStatus();
    }
  }

  private async pushLocalChanges(target: ClipboardSyncTarget): Promise<void> {
    const local = await this.adapter.read();
    if (!local || local.kind === "empty") return;

    const localFp = computeClipboardFingerprint(local);
    if (localFp === this.lastLocalFp || localFp === this.lastRemoteFp) return;

    if (local.kind === "files") {
      const files = normalizeFileList(local.files);
      const accepted: string[] = [];
      let totalBytes = 0;
      for (const file of files) {
        let size = 0;
        try {
          const stat = fs.statSync(file);
          if (!stat.isFile()) continue;
          size = stat.size;
        } catch {
          continue;
        }
        if (totalBytes + size > MAX_CLIPBOARD_AUTO_FILES_BYTES) continue;
        totalBytes += size;
        accepted.push(file);
      }

      if (accepted.length === 0) {
        // Remember the fingerprint so a huge/missing selection is not retried
        // on every tick; the explicit file drawer still handles it.
        this.lastLocalFp = localFp;
        this.lastError = "剪贴板文件不存在或总大小超过 50 MiB，已跳过自动同步";
        return;
      }

      const uploadedPaths: string[] = [];
      for (const file of accepted) {
        const result = await this.client.uploadFileStream(target.host, target.port, target.token, file);
        uploadedPaths.push(result.path);
      }

      const remoteFp = computeClipboardFingerprint({ kind: "files", files: uploadedPaths });
      await this.client.setRemoteClipboard(target.host, target.port, target.token, {
        kind: "files",
        files: uploadedPaths,
      });
      this.lastLocalFp = localFp;
      this.lastRemoteFp = remoteFp;
      this.lastKind = "files";
      this.lastSyncedAt = Date.now();
      this.lastError = "";
      return;
    }

    await this.client.setRemoteClipboard(target.host, target.port, target.token, {
      kind: local.kind,
      text: local.text,
      imageBase64: local.imageBase64,
    });
    this.lastLocalFp = localFp;
    this.lastRemoteFp = localFp;
    this.lastKind = local.kind;
    this.lastSyncedAt = Date.now();
    this.lastError = "";
  }

  private async pullRemoteChanges(target: ClipboardSyncTarget): Promise<void> {
    const response = await this.client.getRemoteClipboard(target.host, target.port, target.token);
    const remote = response?.payload;
    if (!remote || remote.kind === "empty") return;

    const remoteFp = computeClipboardFingerprint(remote);
    if (remoteFp === this.lastRemoteFp || remoteFp === this.lastLocalFp) return;

    if (remote.kind === "files") {
      await this.pullRemoteFiles(target, remote, remoteFp);
      return;
    }

    const result = await this.adapter.write(remote);
    if (!result.ok) {
      this.lastError = result.message || "写入本机剪贴板失败";
      return;
    }
    this.lastRemoteFp = remoteFp;
    this.lastLocalFp = remoteFp;
    this.lastKind = remote.kind;
    this.lastSyncedAt = Date.now();
    this.lastError = "";
  }

  private async pullRemoteFiles(
    target: ClipboardSyncTarget,
    remote: ClipboardPayload,
    remoteFp: string,
  ): Promise<void> {
    const remoteFiles = normalizeFileList(remote.files);
    if (remoteFiles.length === 0) {
      this.lastRemoteFp = remoteFp;
      this.lastError = "远端剪贴板文件列表为空";
      return;
    }

    fs.mkdirSync(this.receiveDir, { recursive: true });

    const localPaths: string[] = [];
    let totalBytes = 0;

    for (const remotePath of remoteFiles) {
      const basename = path.win32.basename(remotePath) || path.basename(remotePath);
      if (!basename) continue;

      // Best-effort size pre-check so one 4 GB file does not silently blow
      // past the auto-mirror ceiling before we notice.
      let remoteSize = 0;
      try {
        const dir = path.win32.dirname(remotePath);
        const listing = await this.client.listRemoteFiles(target.host, target.port, target.token, dir);
        const entry = listing.entries.find((item) => item.path === remotePath || item.name === basename);
        remoteSize = entry && !entry.isDirectory ? entry.size : 0;
      } catch {
        remoteSize = 0;
      }
      if (remoteSize > 0 && totalBytes + remoteSize > MAX_CLIPBOARD_AUTO_FILES_BYTES) continue;

      const savePath = resolveUniqueFilePath(this.receiveDir, basename);
      try {
        const downloaded = await this.client.downloadFileStream(
          target.host,
          target.port,
          target.token,
          remotePath,
          savePath,
        );
        localPaths.push(downloaded.path);
        totalBytes += downloaded.size;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : "下载远端剪贴板文件失败";
      }
    }

    if (localPaths.length === 0) {
      this.lastRemoteFp = remoteFp;
      return;
    }

    const writeResult = await this.adapter.write({ kind: "files", files: localPaths, updatedAt: Date.now() });
    if (!writeResult.ok) {
      this.lastError = writeResult.message || "写入本机文件剪贴板失败";
      return;
    }

    this.lastRemoteFp = remoteFp;
    // The local clipboard now holds local save paths, which fingerprint
    // differently from the remote paths — record that to prevent a push-back.
    this.lastLocalFp = computeClipboardFingerprint({ kind: "files", files: localPaths });
    this.lastKind = "files";
    this.lastSyncedAt = Date.now();
  }
}
