/**
 * Mesh-direct file transfer and clipboard routes for the Host Companion Agent.
 *
 * These routes are mounted through {@link HostAgentHandlers.onExtraRoute},
 * which runs *after* the server's Mesh CIDR guard and Bearer token check. The
 * upload route deliberately consumes `ctx.req` as a raw stream and writes it
 * straight to a `.silkwarp.part` file, so multi-gigabyte transfers never sit in
 * memory.
 *
 * This module intentionally has NO `electron` imports so the compiled
 * CommonJS output can be exercised directly by Node's built-in test runner.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HostAgentExtraRouteContext, HostAgentHandlers } from "./hostAgentServer";
import type { ClipboardKind, ClipboardPayload, RemoteFileEntry, RemoteRootDir } from "./transferValidation";
import {
  MAX_CLIPBOARD_IMAGE_BYTES,
  MAX_UPLOAD_FILE_BYTES,
  computeClipboardFingerprint,
  isSafeReadableSubpath,
  normalizeTargetDir,
  resolveUniqueFilePath,
} from "./transferValidation";

/** Clipboard image payloads larger than this are rejected with 413. */
const MAX_CLIPBOARD_BODY_BYTES = 16 * 1024 * 1024;

/** Upper bound on directory entries returned by one `files/list` call. */
const MAX_DIRECTORY_ENTRIES = 500;

/**
 * Destinations already claimed by an in-flight upload. Without this, two
 * concurrent uploads of the same name both resolve to the same free path
 * before either file exists on disk, and the second silently overwrites the
 * first.
 */
const reservedUploadPaths = new Set<string>();

function reservationKey(candidatePath: string): string {
  const resolved = path.resolve(candidatePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Reserves a destination for an upload that is still in flight, skipping both
 * files that exist on disk and names already claimed by a concurrent request.
 */
function allocateReservedUploadPath(dir: string, filename: string): string {
  const allocated = resolveUniqueFilePath(dir, filename, (candidate) => {
    if (reservedUploadPaths.has(reservationKey(candidate))) return true;
    try {
      return fs.existsSync(candidate);
    } catch {
      return true;
    }
  });
  reservedUploadPaths.add(reservationKey(allocated));
  return allocated;
}

function releaseUploadPath(finalPath: string): void {
  reservedUploadPaths.delete(reservationKey(finalPath));
}

const VALID_CLIPBOARD_KINDS: readonly ClipboardKind[] = ["text", "image", "files"];

function isClipboardKind(value: string): value is ClipboardKind {
  return (VALID_CLIPBOARD_KINDS as readonly string[]).includes(value);
}

export interface ClipboardAdapter {
  read: () => Promise<ClipboardPayload>;
  write: (payload: ClipboardPayload) => Promise<{ ok: boolean; kind: ClipboardKind; message?: string }>;
}

export interface HostTransferOptions {
  /** Folder that receives uploads when the client does not name a target. */
  defaultReceiveDir?: string;
  /** Directories advertised to remote clients as browsable roots. */
  roots?: RemoteRootDir[];
  /**
   * When true, every list/upload/download path must stay inside `roots`.
   * Defaults to false because a remote-control host legitimately browses all
   * local drives; tests and locked-down deployments can opt in.
   */
  restrictToRoots?: boolean;
  /** Upload ceiling in bytes; defaults to {@link MAX_UPLOAD_FILE_BYTES}. */
  maxUploadBytes?: number;
  clipboard: ClipboardAdapter;
  onFileReceived?: (info: { filename: string; path: string; size: number }) => void;
  onRemoteClipboardUpdated?: (payload: ClipboardPayload) => void;
}

interface ResolvedTransferOptions {
  defaultReceiveDir: string;
  roots: RemoteRootDir[];
  rootPaths: string[];
  restrictToRoots: boolean;
  maxUploadBytes: number;
  clipboard: ClipboardAdapter;
  onFileReceived?: (info: { filename: string; path: string; size: number }) => void;
  onRemoteClipboardUpdated?: (payload: ClipboardPayload) => void;
}

function buildDefaultRoots(defaultReceiveDir: string): RemoteRootDir[] {
  const home = os.homedir();
  const roots: RemoteRootDir[] = [{ label: "接收文件夹", path: defaultReceiveDir }];
  const candidates: Array<{ label: string; path: string }> = [
    { label: "桌面", path: path.join(home, "Desktop") },
    { label: "下载", path: path.join(home, "Downloads") },
    { label: "文档", path: path.join(home, "Documents") },
  ];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate.path).isDirectory()) roots.push(candidate);
    } catch {
      // Missing folders are simply not advertised.
    }
  }
  if (roots.length === 1) {
    roots.push({ label: "用户目录", path: home });
  }
  return roots;
}

function resolveOptions(options: HostTransferOptions): ResolvedTransferOptions {
  const defaultReceiveDir = path.resolve(
    options.defaultReceiveDir ?? path.join(os.homedir(), "Desktop", "SilkWarpRecv"),
  );
  const roots = options.roots && options.roots.length > 0 ? options.roots : buildDefaultRoots(defaultReceiveDir);
  const rootPaths = roots.map((root) => path.resolve(root.path));
  const maxUploadBytes =
    typeof options.maxUploadBytes === "number" && Number.isFinite(options.maxUploadBytes) && options.maxUploadBytes > 0
      ? Math.floor(options.maxUploadBytes)
      : MAX_UPLOAD_FILE_BYTES;
  return {
    defaultReceiveDir,
    roots,
    rootPaths,
    restrictToRoots: options.restrictToRoots === true,
    maxUploadBytes,
    clipboard: options.clipboard,
    onFileReceived: options.onFileReceived,
    onRemoteClipboardUpdated: options.onRemoteClipboardUpdated,
  };
}

function readHeader(req: HostAgentExtraRouteContext["req"], name: string): string {
  const raw = req.headers[name];
  if (typeof raw !== "string") return "";
  return raw.trim();
}

/**
 * Header values are expected to be percent-encoded UTF-8. Malformed sequences
 * (for example a literal `50%` in a file name) are kept verbatim rather than
 * rejecting the whole request.
 */
function decodeHeaderValue(raw: string): string {
  if (!raw) return "";
  if (!raw.includes("%")) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function ensureDirectory(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Resolves when `stream` emits `event`, rejects if it errors first. Used for
 * `drain` / `finish` waits so a broken write stream can never hang a request.
 */
function waitForStreamEvent(stream: NodeJS.EventEmitter, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      stream.removeListener(event, onEvent);
      stream.removeListener("error", onError);
    };
    const onEvent = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    stream.once(event, onEvent);
    stream.once("error", onError);
  });
}

async function unlinkQuiet(targetPath: string): Promise<void> {
  try {
    await fs.promises.unlink(targetPath);
  } catch {
    // The file may never have been created, or was already cleaned up.
  }
}

/**
 * Destroys a write stream, waits for its file handle to close (Windows keeps
 * `.part` files locked until then) and removes the partial file.
 */
async function destroyAndRemove(stream: fs.WriteStream, partPath: string): Promise<void> {
  if (!stream.closed) {
    const closed = waitForStreamEvent(stream, "close").catch(() => {});
    stream.destroy();
    await closed;
  }
  await unlinkQuiet(partPath);
}

function compareEntries(a: RemoteFileEntry, b: RemoteFileEntry): number {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
  const left = a.name.toLowerCase();
  const right = b.name.toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

async function handleListFiles(
  ctx: HostAgentExtraRouteContext,
  options: ResolvedTransferOptions,
): Promise<boolean> {
  if (ctx.method !== "GET" || ctx.pathname !== "/api/agent/files/list") return false;

  try {
    ensureDirectory(options.defaultReceiveDir);
    const requested = ctx.query.get("path") ?? undefined;
    const targetDir = normalizeTargetDir(
      requested,
      options.defaultReceiveDir,
      options.restrictToRoots ? options.rootPaths : undefined,
    );

    const dirents = await fs.promises.readdir(targetDir, { withFileTypes: true });
    const entries: RemoteFileEntry[] = [];

    for (const dirent of dirents) {
      if (entries.length >= MAX_DIRECTORY_ENTRIES) break;
      const entryPath = path.join(targetDir, dirent.name);
      let isDirectory = dirent.isDirectory();
      let size = 0;
      let modifiedAt = 0;
      try {
        const stat = await fs.promises.stat(entryPath);
        isDirectory = stat.isDirectory();
        size = stat.isDirectory() ? 0 : stat.size;
        modifiedAt = Math.floor(stat.mtimeMs);
      } catch {
        // Windows system files (pagefile.sys, System Volume Information, ...)
        // often deny stat to normal users. Skip them instead of failing the
        // whole folder listing.
        continue;
      }
      entries.push({ name: dirent.name, path: entryPath, isDirectory, size, modifiedAt });
    }

    entries.sort(compareEntries);

    const parentCandidate = path.dirname(targetDir);
    const parentAllowed =
      parentCandidate !== targetDir &&
      (!options.restrictToRoots || isSafeReadableSubpath(parentCandidate, options.rootPaths));

    ctx.sendJson(200, {
      ok: true,
      currentPath: targetDir,
      parentPath: parentAllowed ? parentCandidate : null,
      roots: options.roots,
      entries,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "list_failed";
    if (message === "path_outside_allowed_roots") {
      ctx.sendJson(403, { error: "path_outside_allowed_roots" });
    } else {
      ctx.sendJson(400, { error: "list_failed", message });
    }
  }
  return true;
}

async function handleUploadFile(
  ctx: HostAgentExtraRouteContext,
  options: ResolvedTransferOptions,
): Promise<boolean> {
  if (ctx.method !== "POST" || ctx.pathname !== "/api/agent/files/upload") return false;

  // The raw header value is percent-encoded UTF-8; sanitizeUploadFilename
  // performs the decode (and tolerates malformed sequences) exactly once.
  const queryFilename = ctx.query.get("filename");
  const rawFilename =
    readHeader(ctx.req, "x-silkwarp-filename") ||
    // URLSearchParams already decoded the query value, so re-encode it to keep
    // sanitizeUploadFilename's single decode pass exact (e.g. `100%25.bin`).
    (queryFilename ? encodeURIComponent(queryFilename) : "");
  const rawTargetDir = decodeHeaderValue(readHeader(ctx.req, "x-silkwarp-target-dir"));

  let targetDir: string;
  try {
    targetDir = normalizeTargetDir(
      rawTargetDir || undefined,
      options.defaultReceiveDir,
      options.restrictToRoots ? options.rootPaths : undefined,
    );
    ensureDirectory(targetDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid_target_dir";
    ctx.req.resume(); // discard the body so the client can finish its write
    ctx.sendJson(message === "path_outside_allowed_roots" ? 403 : 400, { error: message });
    return true;
  }

  const declaredLength = Number(ctx.req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > options.maxUploadBytes) {
    ctx.req.resume();
    ctx.sendJson(413, {
      ok: false,
      error: "file_too_large",
      maxUploadBytes: options.maxUploadBytes,
    });
    return true;
  }

  const finalPath = allocateReservedUploadPath(targetDir, rawFilename || "unnamed.bin");
  const partPath = `${finalPath}.silkwarp.part`;

  const writeStream = fs.createWriteStream(partPath, { flags: "w" });
  const streamState: { error: Error | null } = { error: null };
  writeStream.on("error", (err) => {
    streamState.error = err;
  });

  let size = 0;
  let tooLarge = false;
  try {
    for await (const chunk of ctx.req) {
      if (tooLarge) continue; // drain the rest so the client is not reset mid-write
      // A write error may fire between chunks (disk full, handle revoked).
      // Checking the captured error here avoids attaching a drain listener
      // after the stream has already failed and waiting forever.
      if (streamState.error) throw streamState.error;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > options.maxUploadBytes) {
        tooLarge = true;
        await destroyAndRemove(writeStream, partPath);
        continue;
      }
      if (!writeStream.write(buffer)) {
        await waitForStreamEvent(writeStream, "drain");
      }
    }
  } catch (err) {
    await destroyAndRemove(writeStream, partPath);
    releaseUploadPath(finalPath);
    const message = err instanceof Error ? err.message : "upload_failed";
    ctx.sendJson(400, { ok: false, error: "upload_failed", message });
    return true;
  }

  if (tooLarge) {
    await unlinkQuiet(partPath);
    releaseUploadPath(finalPath);
    ctx.sendJson(413, {
      ok: false,
      error: "file_too_large",
      maxUploadBytes: options.maxUploadBytes,
    });
    return true;
  }

  try {
    writeStream.end();
    await waitForStreamEvent(writeStream, "finish");
    if (streamState.error) throw streamState.error;
    await fs.promises.rename(partPath, finalPath);
  } catch (err) {
    await destroyAndRemove(writeStream, partPath);
    releaseUploadPath(finalPath);
    const message = err instanceof Error ? err.message : "upload_failed";
    ctx.sendJson(400, { ok: false, error: "upload_failed", message });
    return true;
  }

  // The file now exists on disk, so the on-disk check alone keeps it unique.
  releaseUploadPath(finalPath);

  const filename = path.basename(finalPath);
  try {
    options.onFileReceived?.({ filename, path: finalPath, size });
  } catch {
    // Observer callbacks must never fail an otherwise completed transfer.
  }

  ctx.sendJson(200, { ok: true, filename, path: finalPath, size });
  return true;
}

async function handleDownloadFile(
  ctx: HostAgentExtraRouteContext,
  options: ResolvedTransferOptions,
): Promise<boolean> {
  if (ctx.method !== "GET" || ctx.pathname !== "/api/agent/files/download") return false;

  const requested = ctx.query.get("path") ?? "";
  if (!isSafeReadableSubpath(requested, options.restrictToRoots ? options.rootPaths : undefined)) {
    ctx.sendJson(requested.trim() ? 403 : 400, {
      error: requested.trim() ? "path_outside_allowed_roots" : "path_required",
    });
    return true;
  }

  const resolved = path.resolve(requested);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(resolved);
  } catch {
    ctx.sendJson(404, { error: "file_not_found" });
    return true;
  }

  if (!stat.isFile()) {
    ctx.sendJson(400, { error: "not_a_file" });
    return true;
  }

  const filename = path.basename(resolved);
  ctx.res.statusCode = 200;
  ctx.res.setHeader("Content-Type", "application/octet-stream");
  ctx.res.setHeader("Content-Length", String(stat.size));
  ctx.res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);

  await new Promise<void>((resolve) => {
    const readStream = fs.createReadStream(resolved);
    readStream.on("error", () => {
      ctx.res.destroy();
      resolve();
    });
    ctx.res.on("close", () => {
      readStream.destroy();
      resolve();
    });
    readStream.pipe(ctx.res);
  });

  return true;
}

function normalizeClipboardFiles(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const files: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.trim()) files.push(entry.trim());
  }
  return files;
}

async function handleClipboardGet(
  ctx: HostAgentExtraRouteContext,
  options: ResolvedTransferOptions,
): Promise<boolean> {
  if (ctx.method !== "GET" || ctx.pathname !== "/api/agent/clipboard") return false;

  try {
    const payload = await options.clipboard.read();
    ctx.sendJson(200, { ok: true, payload });
  } catch (err) {
    const message = err instanceof Error ? err.message : "clipboard_read_failed";
    ctx.sendJson(500, { ok: false, error: "clipboard_read_failed", message });
  }
  return true;
}

async function handleClipboardPost(
  ctx: HostAgentExtraRouteContext,
  options: ResolvedTransferOptions,
): Promise<boolean> {
  if (ctx.method !== "POST" || ctx.pathname !== "/api/agent/clipboard") return false;

  const body = await ctx.readJsonBody(MAX_CLIPBOARD_BODY_BYTES);
  const rawKind = typeof body.kind === "string" ? body.kind : "";
  if (!isClipboardKind(rawKind)) {
    ctx.sendJson(400, { ok: false, error: "invalid_clipboard_kind" });
    return true;
  }
  const kind: ClipboardKind = rawKind;

  const text = typeof body.text === "string" ? body.text : undefined;
  const imageBase64 = typeof body.imageBase64 === "string" ? body.imageBase64 : undefined;
  const files = normalizeClipboardFiles(body.files);

  if (kind === "image") {
    if (!imageBase64) {
      ctx.sendJson(400, { ok: false, error: "image_required" });
      return true;
    }
    const decodedBytes = Buffer.from(imageBase64, "base64").length;
    if (decodedBytes > MAX_CLIPBOARD_IMAGE_BYTES) {
      ctx.sendJson(413, { ok: false, error: "clipboard_image_too_large" });
      return true;
    }
  }

  const payload: ClipboardPayload = {
    kind,
    text,
    imageBase64,
    files,
    updatedAt: Date.now(),
  };

  let writeResult: { ok: boolean; kind: ClipboardKind; message?: string };
  try {
    writeResult = await options.clipboard.write(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : "clipboard_write_failed";
    ctx.sendJson(500, { ok: false, error: "clipboard_write_failed", message });
    return true;
  }

  try {
    options.onRemoteClipboardUpdated?.(payload);
  } catch {
    // Observer callbacks must never fail an accepted clipboard update.
  }

  ctx.sendJson(200, {
    ok: writeResult.ok,
    kind: writeResult.kind,
    message: writeResult.message,
    fingerprint: computeClipboardFingerprint(payload),
  });
  return true;
}

/**
 * Builds the `onExtraRoute` handler for Stage 3 file transfer + clipboard.
 *
 * The returned handler only claims the five routes it owns and returns `false`
 * for everything else, letting the built-in Host Agent routes keep working.
 */
export function createHostTransferExtraRoute(
  options: HostTransferOptions,
): NonNullable<HostAgentHandlers["onExtraRoute"]> {
  const resolved = resolveOptions(options);

  return async (ctx: HostAgentExtraRouteContext): Promise<boolean> => {
    if (await handleListFiles(ctx, resolved)) return true;
    if (await handleUploadFile(ctx, resolved)) return true;
    if (await handleDownloadFile(ctx, resolved)) return true;
    if (await handleClipboardGet(ctx, resolved)) return true;
    if (await handleClipboardPost(ctx, resolved)) return true;
    return false;
  };
}
