/**
 * HTTP client for a remote Host Companion Agent.
 *
 * This module intentionally has NO `electron` imports so the compiled
 * CommonJS output can be exercised directly by Node's built-in test runner.
 */

import http from "node:http";
import type { DisplayMonitorInfo, HostAgentInfoPayload, SystemActionType } from "./hostAgentServer";
import { DEFAULT_AGENT_PORT } from "./hostAgentAuth";

const DEFAULT_TIMEOUT_MS = 5000;

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
      { host, port, method, path, headers, timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
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
  ): Promise<{ ok: boolean; token: string; expiresAt: number }> {
    return this.requestJson(host, port, "POST", "/api/agent/auth", { body: payload });
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
}
