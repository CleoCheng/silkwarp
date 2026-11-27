/**
 * HTTP client for a remote Host Companion Agent.
 *
 * This module intentionally has NO `electron` imports so the compiled
 * CommonJS output can be exercised directly by Node's built-in test runner.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { DisplayMonitorInfo, HostAgentInfoPayload, SystemActionType } from "./hostAgentServer";
import { DEFAULT_AGENT_PORT } from "./hostAgentAuth";
import type {
  ClipboardKind,
  ClipboardPayload,
  RemoteFileEntry,
  RemoteRootDir,
} from "./transferValidation";

const DEFAULT_TIMEOUT_MS = 5000;
/** Socket-inactivity timeout for long-running file transfers. */
const DEFAULT_TRANSFER_TIMEOUT_MS = 120_000;

export interface TransferProgress {
  transferred: number;
  total: number;
}

export interface UploadFileOptions {
  targetDir?: string;
  onProgress?: (progress: TransferProgress) => void;
  timeoutMs?: number;
}

export interface DownloadFileOptions {
  onProgress?: (progress: TransferProgress) => void;
  timeoutMs?: number;
}

export interface RemoteFileListing {
  currentPath: string;
  parentPath: string | null;
  roots: RemoteRootDir[];
  entries: RemoteFileEntry[];
}

export class AgentClientError extends Error {
  readonly statusCode: number;
  readonly code?: string;
  readonly retryAfterSec?: number;

  constructor(message: string, statusCode = 0, options: { code?: string; retryAfterSec?: number } = {}) {
    super(message);
    this.name = "AgentClientError";
    this.statusCode = statusCode;
    this.code = options.code;
    this.retryAfterSec = options.retryAfterSec;
  }
}

interface RequestOptions {
  token?: string;
  body?: unknown;
  timeoutMs?: number;
}

interface ParsedResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

function requestRaw(
  host: string,
  port: number,
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<ParsedResponse> {
  return new Promise((resolve, reject) => {
    const payload =
      options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body), "utf8");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(payload.length);
    }
    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }

    const req = http.request(
      { host, port, method, path, headers, agent: false, timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", (err: Error) => {
          reject(new AgentClientError(err.message || "响应读取失败", 0, { code: "response_error" }));
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(new AgentClientError("请求超时", 0, { code: "timeout" }));
    });
    req.on("error", (err: Error) => {
      if (err instanceof AgentClientError) {
        reject(err);
        return;
      }
      reject(new AgentClientError(err.message || "网络请求失败", 0, { code: "network_error" }));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

function parseRetryAfter(headers: http.IncomingHttpHeaders): number | undefined {
  const raw = headers["retry-after"];
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined;
}

function buildErrorFromResponse(
  statusCode: number,
  headers: http.IncomingHttpHeaders,
  text: string,
): AgentClientError {
  let json: Record<string, unknown> = {};
  if (text.trim()) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        json = parsed as Record<string, unknown>;
      }
    } catch {
      // Non-JSON error bodies still surface their HTTP status.
    }
  }
  const message = typeof json.error === "string" && json.error ? json.error : `HTTP ${statusCode}`;
  const retryAfterSec =
    parseRetryAfter(headers) ??
    (typeof json.retryAfterSec === "number" ? json.retryAfterSec : undefined);
  return new AgentClientError(message, statusCode, {
    code: typeof json.error === "string" ? json.error : undefined,
    retryAfterSec,
  });
}

/**
 * Thin typed wrapper around the Host Companion Agent HTTP API.
 *
 * Every non-2xx response or transport failure is surfaced as an
 * {@link AgentClientError} carrying the HTTP status, server error code and
 * optional `Retry-After` hint.
 */
export class HostAgentClient {
  private async requestJson<T>(
    host: string,
    port: number,
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    let response: ParsedResponse;
    try {
      response = await requestRaw(host, port, method, path, options);
    } catch (err) {
      if (err instanceof AgentClientError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new AgentClientError(message, 0, { code: "network_error" });
    }

    let json: Record<string, unknown> = {};
    if (response.text.trim()) {
      try {
        const parsed: unknown = JSON.parse(response.text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          json = parsed as Record<string, unknown>;
        }
      } catch {
        throw new AgentClientError(`HTTP ${response.statusCode}: 非 JSON 响应`, response.statusCode, {
          code: "invalid_json",
        });
      }
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      const message =
        typeof json.error === "string" && json.error
          ? json.error
          : `HTTP ${response.statusCode}`;
      const code = typeof json.error === "string" ? json.error : undefined;
      const retryAfterSec =
        parseRetryAfter(response.headers) ??
        (typeof json.retryAfterSec === "number" ? json.retryAfterSec : undefined);
      throw new AgentClientError(message, response.statusCode, { code, retryAfterSec });
    }

    return json as T;
  }

  probeInfo(host: string, port = DEFAULT_AGENT_PORT, timeoutMs = 2500): Promise<HostAgentInfoPayload> {
    return this.requestJson<HostAgentInfoPayload>(host, port, "GET", "/api/agent/info", { timeoutMs });
  }

  authenticate(
    host: string,
    port: number,
    payload: { password?: string; clientUserId?: string; deviceId?: string },
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<{ ok: boolean; token: string; expiresAt: number }> {
    return this.requestJson(host, port, "POST", "/api/agent/auth", { body: payload, timeoutMs });
  }

  async listDisplays(host: string, port: number, token: string): Promise<DisplayMonitorInfo[]> {
    const result = await this.requestJson<{ ok: boolean; displays: DisplayMonitorInfo[] }>(
      host,
      port,
      "GET",
      "/api/agent/displays",
      { token },
    );
    return result.displays;
  }

  selectDisplay(
    host: string,
    port: number,
    token: string,
    displayId: string,
  ): Promise<{
    ok: boolean;
    selectedDisplayId: string;
    restartRecommended: boolean;
    displays: DisplayMonitorInfo[];
    message?: string;
  }> {
    return this.requestJson(host, port, "POST", "/api/agent/displays/select", {
      token,
      body: { displayId },
    });
  }

  getMuteState(host: string, port: number, token: string): Promise<{ muted: boolean }> {
    return this.requestJson(host, port, "GET", "/api/agent/audio/mute", { token });
  }

  setMuteState(host: string, port: number, token: string, muted: boolean): Promise<{ muted: boolean }> {
    return this.requestJson(host, port, "POST", "/api/agent/audio/mute", { token, body: { muted } });
  }

  getPrivacyState(host: string, port: number, token: string): Promise<{ active: boolean; supported: boolean }> {
    return this.requestJson(host, port, "GET", "/api/agent/privacy", { token });
  }

  setPrivacyState(
    host: string,
    port: number,
    token: string,
    active: boolean,
  ): Promise<{ active: boolean; supported: boolean; message?: string }> {
    return this.requestJson(host, port, "POST", "/api/agent/privacy", { token, body: { active } });
  }

  runSystemAction(
    host: string,
    port: number,
    token: string,
    action: SystemActionType,
  ): Promise<{ ok: boolean; message: string }> {
    return this.requestJson(host, port, "POST", "/api/agent/system/action", { token, body: { action } });
  }

  notifySessionEnd(
    host: string,
    port: number,
    token: string,
    opts: { autoLock?: boolean } = {},
  ): Promise<{ locked: boolean; muteRestored: boolean; privacyRestored: boolean }> {
    return this.requestJson(host, port, "POST", "/api/agent/session/end", { token, body: opts });
  }

  // -------------------------------------------------------------------------
  // Stage 3: Mesh-direct file transfer + clipboard
  // -------------------------------------------------------------------------

  async listRemoteFiles(
    host: string,
    port: number,
    token: string,
    dirPath?: string,
  ): Promise<RemoteFileListing> {
    const query = dirPath ? `?path=${encodeURIComponent(dirPath)}` : "";
    const result = await this.requestJson<RemoteFileListing & { ok: boolean }>(
      host,
      port,
      "GET",
      `/api/agent/files/list${query}`,
      { token },
    );
    return {
      currentPath: result.currentPath,
      parentPath: result.parentPath ?? null,
      roots: Array.isArray(result.roots) ? result.roots : [],
      entries: Array.isArray(result.entries) ? result.entries : [],
    };
  }

  /**
   * Streams `localFilePath` to the host without buffering it in memory.
   *
   * `onProgress` fires as each chunk is flushed to the socket, so callers can
   * render a progress bar for multi-gigabyte transfers.
   */
  async uploadFileStream(
    host: string,
    port: number,
    token: string,
    localFilePath: string,
    opts: UploadFileOptions = {},
  ): Promise<{ ok: boolean; filename: string; path: string; size: number }> {
    const stat = await fs.promises.stat(localFilePath);
    if (!stat.isFile()) {
      throw new AgentClientError("只能上传文件", 0, { code: "not_a_file" });
    }
    const total = stat.size;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;

    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(total),
      "x-silkwarp-filename": encodeURIComponent(path.basename(localFilePath)),
      Authorization: `Bearer ${token}`,
    };
    if (opts.targetDir) {
      headers["x-silkwarp-target-dir"] = encodeURIComponent(opts.targetDir);
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err: AgentClientError | null, value?: { ok: boolean; filename: string; path: string; size: number }) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(value as { ok: boolean; filename: string; path: string; size: number });
      };

      const req = http.request(
        { host, port, method: "POST", path: "/api/agent/files/upload", headers, agent: false, timeout: timeoutMs },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
              finish(buildErrorFromResponse(res.statusCode ?? 0, res.headers, text));
              return;
            }
            try {
              const parsed = JSON.parse(text) as { ok: boolean; filename: string; path: string; size: number };
              finish(null, parsed);
            } catch {
              finish(new AgentClientError("上传响应不是有效 JSON", res.statusCode ?? 0, { code: "invalid_json" }));
            }
          });
          res.on("error", (err: Error) => {
            finish(new AgentClientError(err.message || "上传响应读取失败", 0, { code: "response_error" }));
          });
        },
      );

      req.on("timeout", () => {
        req.destroy(new AgentClientError("上传超时", 0, { code: "timeout" }));
      });
      req.on("error", (err: Error) => {
        if (err instanceof AgentClientError) {
          finish(err);
          return;
        }
        finish(new AgentClientError(err.message || "上传失败", 0, { code: "network_error" }));
      });

      const readStream = fs.createReadStream(localFilePath);
      let transferred = 0;
      let progressError: Error | null = null;
      readStream.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        transferred += buffer.length;
        if (opts.onProgress && !progressError) {
          try {
            opts.onProgress({ transferred, total });
          } catch (err) {
            progressError = err instanceof Error ? err : new Error("progress_callback_error");
            readStream.destroy(progressError);
          }
        }
      });
      readStream.on("error", (err: Error) => {
        req.destroy();
        if (progressError) {
          finish(
            new AgentClientError(progressError.message || "上传进度回调异常", 0, {
              code: "progress_callback_error",
            }),
          );
          return;
        }
        finish(new AgentClientError(err.message || "读取本地文件失败", 0, { code: "local_read_error" }));
      });
      readStream.pipe(req);
    });
  }

  /**
   * Streams a remote file into `<localSavePath>.part`, then atomically renames
   * it into place once the full body has been written.
   */
  async downloadFileStream(
    host: string,
    port: number,
    token: string,
    remoteFilePath: string,
    localSavePath: string,
    opts: DownloadFileOptions = {},
  ): Promise<{ ok: boolean; path: string; size: number }> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
    const partPath = `${localSavePath}.part`;
    const dir = path.dirname(localSavePath);
    await fs.promises.mkdir(dir, { recursive: true });

    return new Promise((resolve, reject) => {
      let settled = false;
      let writeStream: fs.WriteStream | null = null;
      let transferred = 0;
      let failed = false;

      const finish = (err: AgentClientError | null, value?: { ok: boolean; path: string; size: number }) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(value as { ok: boolean; path: string; size: number });
      };

      /**
       * Windows keeps the `.part` file locked until the write handle closes, so
       * unlink only after the stream reports `close` (or is already closed).
       */
      const removePartFile = async (): Promise<void> => {
        const stream = writeStream;
        if (stream && !stream.closed) {
          await new Promise<void>((done) => {
            stream.once("close", () => done());
            stream.destroy();
          }).catch(() => {});
        }
        await fs.promises.unlink(partPath).catch(() => {});
      };

      const fail = (err: AgentClientError) => {
        if (failed) return;
        failed = true;
        void removePartFile().then(() => finish(err));
      };

      const req = http.request(
        {
          host,
          port,
          method: "GET",
          path: `/api/agent/files/download?path=${encodeURIComponent(remoteFilePath)}`,
          headers: { Accept: "application/octet-stream", Authorization: `Bearer ${token}` },
          agent: false,
          timeout: timeoutMs,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
              finish(buildErrorFromResponse(status, res.headers, Buffer.concat(chunks).toString("utf8")));
            });
            res.on("error", (err: Error) => {
              finish(new AgentClientError(err.message || "下载响应读取失败", 0, { code: "response_error" }));
            });
            return;
          }

          const totalHeader = Number(res.headers["content-length"]);
          const total = Number.isFinite(totalHeader) && totalHeader >= 0 ? totalHeader : 0;
          const stream = fs.createWriteStream(partPath, { flags: "w" });
          writeStream = stream;

          res.on("data", (chunk: Buffer | string) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            transferred += buffer.length;
            if (opts.onProgress && !failed) {
              try {
                opts.onProgress({ transferred, total });
              } catch (err) {
                fail(
                  new AgentClientError(
                    err instanceof Error ? err.message : "下载进度回调异常",
                    0,
                    { code: "progress_callback_error" },
                  ),
                );
              }
            }
          });
          res.on("error", (err: Error) => {
            fail(new AgentClientError(err.message || "下载中断", 0, { code: "response_error" }));
          });
          res.on("aborted", () => {
            fail(new AgentClientError("下载中断", 0, { code: "response_error" }));
          });
          stream.on("error", (err: Error) => {
            fail(new AgentClientError(err.message || "写入本地文件失败", 0, { code: "local_write_error" }));
          });
          stream.on("finish", () => {
            if (failed) return;
            void fs.promises
              .rename(partPath, localSavePath)
              .then(() => finish(null, { ok: true, path: localSavePath, size: transferred }))
              .catch((err: unknown) => {
                void fs.promises.unlink(partPath).catch(() => {});
                finish(
                  new AgentClientError(err instanceof Error ? err.message : "保存文件失败", 0, {
                    code: "local_write_error",
                  }),
                );
              });
          });

          res.pipe(stream);
        },
      );

      req.on("timeout", () => {
        req.destroy(new AgentClientError("下载超时", 0, { code: "timeout" }));
      });
      req.on("error", (err: Error) => {
        if (err instanceof AgentClientError) {
          fail(err);
          return;
        }
        fail(new AgentClientError(err.message || "下载失败", 0, { code: "network_error" }));
      });
      req.end();
    });
  }

  getRemoteClipboard(
    host: string,
    port: number,
    token: string,
  ): Promise<{ ok: boolean; payload: ClipboardPayload }> {
    return this.requestJson(host, port, "GET", "/api/agent/clipboard", { token });
  }

  setRemoteClipboard(
    host: string,
    port: number,
    token: string,
    payload: Omit<ClipboardPayload, "updatedAt"> & { updatedAt?: number },
  ): Promise<{ ok: boolean; kind: ClipboardKind; message?: string; fingerprint?: string }> {
    return this.requestJson(host, port, "POST", "/api/agent/clipboard", {
      token,
      body: payload,
      timeoutMs: 15_000,
    });
  }
}
