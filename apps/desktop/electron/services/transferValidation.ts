/**
 * Pure validation and sanitization helpers shared by the Stage 3 Mesh file
 * transfer routes and the bidirectional clipboard bridge.
 *
 * This module intentionally has NO `electron` imports so the compiled
 * CommonJS output can be exercised directly by Node's built-in test runner.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Hard ceiling for a single streamed upload (2 GiB). */
export const MAX_UPLOAD_FILE_BYTES = 2 * 1024 * 1024 * 1024;

/** Hard ceiling for a clipboard image before base64 decoding (10 MiB). */
export const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024;

/** Upper bound for a sanitized file name, including its extension. */
export const MAX_FILENAME_LENGTH = 180;

const FALLBACK_FILENAME = "unnamed.bin";

const COMPOUND_EXTENSIONS = [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tar.lz4"];

/** Splits `archive.tar.gz` into `{ stem: "archive", extension: ".tar.gz" }`. */
function splitFilenameExtension(name: string): { stem: string; extension: string } {
  const lower = name.toLowerCase();
  for (const compound of COMPOUND_EXTENSIONS) {
    if (lower.endsWith(compound) && name.length > compound.length) {
      return { stem: name.slice(0, -compound.length), extension: name.slice(-compound.length) };
    }
  }
  const extension = path.extname(name);
  return { stem: name.slice(0, name.length - extension.length), extension };
}

const CONTROL_CHARS = /[\x00-\x1f]/g;
const WINDOWS_INVALID_FILENAME_CHARS = /[<>:"/\\|?*]/g;
const TRAILING_DOTS_OR_SPACES = /[. ]+$/;

export type ClipboardKind = "empty" | "text" | "image" | "files";

export interface ClipboardPayload {
  kind: ClipboardKind;
  text?: string;
  imageBase64?: string;
  files?: string[];
  updatedAt: number;
}

export interface RemoteFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: number;
}

export interface RemoteRootDir {
  label: string;
  path: string;
}

/**
 * Best-effort percent-decoding for values that may arrive raw (query string)
 * or URL-encoded (custom HTTP header). Malformed sequences such as a literal
 * `50% off` are preserved verbatim instead of throwing.
 */
function decodePercentEncoded(raw: string): string {
  if (!raw.includes("%")) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function capFilenameLength(name: string): string {
  if (name.length <= MAX_FILENAME_LENGTH) return name;

  const { stem, extension } = splitFilenameExtension(name);
  const safeExtension = extension.length > 32 ? extension.slice(0, 32) : extension;
  const maxStemLength = Math.max(1, MAX_FILENAME_LENGTH - safeExtension.length);
  const cappedStem = stem.slice(0, maxStemLength).replace(TRAILING_DOTS_OR_SPACES, "") || "file";
  return `${cappedStem}${safeExtension}`;
}

/**
 * Turns an untrusted upload name into a single, safe Windows/POSIX file name.
 *
 * - percent-decodes when possible, then trims;
 * - strips both POSIX `/` and Windows `\` directory components;
 * - removes control characters and replaces `<>:"/\|?*` with `_`;
 * - removes trailing dots/spaces (invalid on Windows) and caps the result at
 *   180 characters while keeping the extension readable;
 * - falls back to `unnamed.bin` for empty, `.` and `..` inputs.
 */
export function sanitizeUploadFilename(raw: string): string {
  if (typeof raw !== "string") return FALLBACK_FILENAME;

  let name = decodePercentEncoded(raw).trim();
  if (!name) return FALLBACK_FILENAME;

  name = name.replace(/\0/g, "");
  name = path.posix.basename(name);
  name = path.win32.basename(name);
  name = name.replace(CONTROL_CHARS, "");
  name = name.replace(WINDOWS_INVALID_FILENAME_CHARS, "_");
  name = name.replace(TRAILING_DOTS_OR_SPACES, "").trim();

  if (!name || name === "." || name === "..") return FALLBACK_FILENAME;

  return capFilenameLength(name);
}

/**
 * Resolves a collision-free destination inside `dir`.
 *
 * The sanitized name is tried first, then `stem (1).ext`, `stem (2).ext` and
 * so on up to `stem (9999).ext`. `existsFn` is injectable for tests.
 */
export function resolveUniqueFilePath(
  dir: string,
  filename: string,
  existsFn: (candidatePath: string) => boolean = fs.existsSync,
): string {
  const safeName = sanitizeUploadFilename(filename);
  const baseDir = path.resolve(dir);
  const directPath = path.join(baseDir, safeName);
  if (!existsFn(directPath)) return directPath;

  const { stem, extension } = splitFilenameExtension(safeName);

  for (let index = 1; index <= 9999; index += 1) {
    const candidate = path.join(baseDir, `${stem} (${index})${extension}`);
    if (!existsFn(candidate)) return candidate;
  }

  // Practically unreachable, but never hand back a path that already exists.
  return path.join(baseDir, `${stem} (${Date.now()})${extension}`);
}

function normalizeForComparison(candidatePath: string): string {
  let resolved = path.resolve(candidatePath);
  const root = path.parse(resolved).root;
  while (
    resolved.length > root.length &&
    (resolved.endsWith(path.sep) || resolved.endsWith("/"))
  ) {
    resolved = resolved.slice(0, -1);
  }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** True when `candidate` is exactly `root` or lives strictly below it. */
export function isPathWithinRoot(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeForComparison(candidate);
  const normalizedRoot = normalizeForComparison(root);
  if (normalizedCandidate === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
  return normalizedCandidate.startsWith(prefix);
}

function assertWithinAllowedRoots(resolvedPath: string, allowedRoots?: string[]): void {
  if (!allowedRoots || allowedRoots.length === 0) return;
  const allowed = allowedRoots.some((root) => isPathWithinRoot(resolvedPath, root));
  if (!allowed) {
    throw new Error("path_outside_allowed_roots");
  }
}

/**
 * Resolves a client-supplied target directory.
 *
 * Empty input falls back to `defaultDir`. Null bytes are stripped before
 * resolution. When `allowedRoots` is supplied, the resolved path must equal or
 * live strictly inside one of the roots (case-insensitive on Windows);
 * otherwise an `Error("path_outside_allowed_roots")` is thrown.
 */
export function normalizeTargetDir(
  rawPath: string | undefined,
  defaultDir: string,
  allowedRoots?: string[],
): string {
  const cleaned = typeof rawPath === "string" ? rawPath.replace(/\0/g, "").trim() : "";
  const resolved = path.resolve(cleaned || defaultDir);
  assertWithinAllowedRoots(resolved, allowedRoots);
  return resolved;
}

/**
 * Validates a path supplied for download/read access. Returns false for empty
 * input, embedded null bytes, or paths escaping every allowed root.
 */
export function isSafeReadableSubpath(candidatePath: string, allowedRoots?: string[]): boolean {
  if (typeof candidatePath !== "string") return false;
  const trimmed = candidatePath.trim();
  if (!trimmed || trimmed.includes("\0")) return false;

  const resolved = path.resolve(trimmed);
  if (!allowedRoots || allowedRoots.length === 0) return true;

  return allowedRoots.some((root) => isPathWithinRoot(resolved, root));
}

function normalizeClipboardText(text: string | undefined): string {
  return (text ?? "").replace(/\r\n?/g, "\n").trim();
}

const EMPTY_CLIPBOARD_FINGERPRINT = crypto
  .createHash("sha256")
  .update("silkwarp:clipboard:empty")
  .digest("hex");

/**
 * Deterministic SHA-256 fingerprint used to suppress clipboard echo loops.
 *
 * The digest is stable across cosmetic differences: text is trimmed and CRLF
 * normalized, base64 image payloads ignore whitespace, and file lists are
 * sorted. The kind is always mixed in, so identical bytes under different
 * kinds never collide. `empty` maps to a constant fingerprint.
 */
export function computeClipboardFingerprint(
  payload: Pick<ClipboardPayload, "kind" | "text" | "imageBase64" | "files">,
): string {
  if (!payload || payload.kind === "empty") return EMPTY_CLIPBOARD_FINGERPRINT;

  const hash = crypto.createHash("sha256");
  hash.update(String(payload.kind));
  hash.update("\u0000");

  if (payload.kind === "text") {
    hash.update(normalizeClipboardText(payload.text));
  } else if (payload.kind === "image") {
    hash.update((payload.imageBase64 ?? "").replace(/\s+/g, ""));
  } else if (payload.kind === "files") {
    const files = (payload.files ?? [])
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .sort();
    hash.update(files.join("\u0000"));
  }

  return hash.digest("hex");
}
