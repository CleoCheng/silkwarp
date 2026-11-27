/**
 * Embedded Host Companion Agent HTTP server.
 *
 * Listens on the SilkWarp Mesh interface only, enforces a Mesh CIDR guard on
 * every request, and protects all mutating routes with bearer tokens issued by
 * {@link AgentAuthManager}.
 *
 * This module intentionally has NO `electron` imports so the compiled
 * CommonJS output can be exercised directly by Node's built-in test runner.
 */

import http from "node:http";
import type { AgentAuthManager } from "./hostAgentAuth";
import { DEFAULT_AGENT_PORT, isIpInCidr, normalizeIpAddress } from "./hostAgentAuth";

export const AGENT_VERSION = "2.0.0";
export const DEFAULT_MESH_CIDR = "10.144.0.0/24";

export interface DisplayMonitorInfo {
  index: number;
  id: string;
  deviceName: string;
  friendlyName: string;
  width: number;
  height: number;
  refreshHz?: number;
  x: number;
  y: number;
  isPrimary: boolean;
  isVirtual: boolean;
  active: boolean;
}

export type SystemActionType = "lock" | "taskmgr" | "show_desktop" | "sas" | "repair_ime" | "reboot" | "shutdown";

export const SYSTEM_ACTION_TYPES: readonly SystemActionType[] = [
  "lock",
  "taskmgr",
  "show_desktop",
  "sas",
  "repair_ime",
  "reboot",
  "shutdown",
];

export interface HostAgentInfoPayload {
  ok: boolean;
  version: string;
  hostDeviceId: string;
  hostname: string;
  requirePassword: boolean;
  privacyActive: boolean;
  muted: boolean;
  autoLockOnDisconnect: boolean;
  apolloPort: number;
  apolloReady: boolean;
  capabilities: string[];
}

export interface HostAgentExtraRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  query: URLSearchParams;
  remoteIp: string;
  sendJson: (status: number, body: unknown) => void;
  readJsonBody: (maxBytes?: number) => Promise<Record<string, unknown>>;
}

export interface HostAgentHandlers {
  getHostInfo: () => Promise<Omit<HostAgentInfoPayload, "ok" | "version">>;
  listDisplays: () => Promise<DisplayMonitorInfo[]>;
  selectDisplay: (displayId: string) => Promise<{
    ok: boolean;
    selectedDisplayId: string;
    restartRecommended: boolean;
    displays: DisplayMonitorInfo[];
    message?: string;
  }>;
  getMuteState: () => Promise<{ muted: boolean }>;
  setMuteState: (muted: boolean) => Promise<{ muted: boolean }>;
  getPrivacyState: () => Promise<{ active: boolean; supported: boolean }>;
  setPrivacyState: (active: boolean) => Promise<{ active: boolean; supported: boolean; message?: string }>;
  runSystemAction: (action: SystemActionType) => Promise<{ ok: boolean; message: string }>;
  onSessionEnded?: (opts: { autoLock?: boolean }) => Promise<{
    locked: boolean;
    muteRestored: boolean;
    privacyRestored: boolean;
  }>;
  onExtraRoute?: (ctx: HostAgentExtraRouteContext) => Promise<boolean>;
}

export interface HostAgentServerOptions {
  authManager: AgentAuthManager;
  getMeshCidr: () => string;
  allowLoopback?: boolean;
  handlers: HostAgentHandlers;
}

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

function readBearerToken(req: http.IncomingMessage): string {
  const header = req.headers.authorization;
  if (typeof header !== "string") return "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function readJsonBodyFromRequest(
  req: http.IncomingMessage,
  maxBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new Error("request_body_too_large");
    }
    chunks.push(buffer);
  }
  if (total === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid_json_body");
  }
  return parsed as Record<string, unknown>;
}

/**
 * HTTP server exposing the Host Companion Agent API.
 *
 * Lifecycle: `start()` -> `stop()`. `start()` is idempotent while the server
 * is already listening on the requested port.
 */
export class HostAgentServer {
  private readonly authManager: AgentAuthManager;
  private readonly getMeshCidr: () => string;
  private readonly allowLoopback: boolean;
  private readonly handlers: HostAgentHandlers;

  private server: http.Server | null = null;
  private boundHost = "";
  private boundPort = 0;
  private requestedPort = -1;
  private starting: Promise<{ host: string; port: number }> | null = null;

  constructor(options: HostAgentServerOptions) {
    this.authManager = options.authManager;
    this.getMeshCidr = options.getMeshCidr;
    this.allowLoopback = options.allowLoopback !== false;
    this.handlers = options.handlers;
  }

  getPort(): number {
    return this.boundPort;
  }

  async start(host = "0.0.0.0", port = DEFAULT_AGENT_PORT): Promise<{ host: string; port: number }> {
    if (this.server && this.server.listening && this.boundHost === host && this.requestedPort === port) {
      return { host: this.boundHost, port: this.boundPort };
    }
    if (this.starting) {
      return this.starting;
    }
    if (this.server) {
      await this.stop();
    }

    const task = this.listen(host, port).finally(() => {
      this.starting = null;
    });
    this.starting = task;
    return task;
  }

  private listen(host: string, port: number): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      const onError = (err: Error): void => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("failed_to_resolve_listen_address"));
          return;
        }
        this.server = server;
        this.boundHost = host;
        this.boundPort = address.port;
        this.requestedPort = port;
        resolve({ host, port: address.port });
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundHost = "";
    this.boundPort = 0;
    this.requestedPort = -1;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const sendJson = (status: number, body: unknown): void => {
      if (res.headersSent) return;
      const payload = Buffer.from(JSON.stringify(body ?? {}), "utf8");
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Length", String(payload.length));
      res.end(payload);
    };

    try {
      const remoteIp = normalizeIpAddress(req.socket.remoteAddress || "");
      const meshCidr = this.getMeshCidr() || DEFAULT_MESH_CIDR;
      const inMesh = isIpInCidr(remoteIp, meshCidr);
      const isLoopback = remoteIp === "127.0.0.1";
      if (!inMesh && !(this.allowLoopback && isLoopback)) {
        sendJson(403, { error: "mesh_only" });
        return;
      }

      const method = (req.method || "GET").toUpperCase();
      const parsed = new URL(req.url || "/", "http://localhost");
      const pathname = parsed.pathname;
      const query = parsed.searchParams;
      const readJsonBody = (maxBytes?: number): Promise<Record<string, unknown>> =>
        readJsonBodyFromRequest(req, maxBytes);

      const ctx: HostAgentExtraRouteContext = {
        req,
        res,
        method,
        pathname,
        query,
        remoteIp,
        sendJson,
        readJsonBody,
      };

      if (method === "GET" && pathname === "/api/agent/info") {
        const info = await this.handlers.getHostInfo();
        sendJson(200, { ok: true, version: AGENT_VERSION, ...info });
        return;
      }

      if (method === "POST" && pathname === "/api/agent/auth") {
        const body = await readJsonBody();
        const password = typeof body.password === "string" ? body.password : undefined;
        const clientUserId = typeof body.clientUserId === "string" ? body.clientUserId : undefined;
        const deviceId = typeof body.deviceId === "string" ? body.deviceId : undefined;
        const result = this.authManager.authenticate({ remoteIp, password, clientUserId, deviceId });
        if (!result.ok) {
          if (result.retryAfterSec !== undefined) {
            res.setHeader("Retry-After", String(result.retryAfterSec));
          }
          const failure: Record<string, unknown> = { ok: false, error: result.error };
          if (result.retryAfterSec !== undefined) {
            failure.retryAfterSec = result.retryAfterSec;
          }
          sendJson(result.statusCode, failure);
          return;
        }
        sendJson(200, { ok: true, token: result.token, expiresAt: result.expiresAt });
        return;
      }

      if (pathname === "/api/agent" || pathname.startsWith("/api/agent/")) {
        const token = readBearerToken(req);
        if (!this.authManager.verifyToken(token)) {
          sendJson(401, { error: "unauthorized" });
          return;
        }
        const handled = await this.handleAuthenticatedRoute(ctx);
        if (handled) return;

        if (this.handlers.onExtraRoute) {
          const extraHandled = await this.handlers.onExtraRoute(ctx);
          if (extraHandled) return;
        }
        sendJson(404, { error: "not_found" });
        return;
      }

      sendJson(404, { error: "not_found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal_error";
      const status = message === "request_body_too_large" ? 413 : 400;
      if (!res.headersSent) {
        sendJson(status, { error: message === "request_body_too_large" ? "body_too_large" : "bad_request" });
      } else {
        res.end();
      }
    }
  }

  private async handleAuthenticatedRoute(ctx: HostAgentExtraRouteContext): Promise<boolean> {
    const { method, pathname, sendJson } = ctx;

    if (method === "GET" && pathname === "/api/agent/displays") {
      const displays = await this.handlers.listDisplays();
      sendJson(200, { ok: true, displays });
      return true;
    }

    if (method === "POST" && pathname === "/api/agent/displays/select") {
      const body = await ctx.readJsonBody();
      const displayId = typeof body.displayId === "string" ? body.displayId.trim() : "";
      if (!displayId) {
        sendJson(400, { error: "display_id_required" });
        return true;
      }
      const result = await this.handlers.selectDisplay(displayId);
      sendJson(200, result);
      return true;
    }

    if (method === "GET" && pathname === "/api/agent/audio/mute") {
      const state = await this.handlers.getMuteState();
      sendJson(200, state);
      return true;
    }

    if (method === "POST" && pathname === "/api/agent/audio/mute") {
      const body = await ctx.readJsonBody();
      if (typeof body.muted !== "boolean") {
        sendJson(400, { error: "muted_boolean_required" });
        return true;
      }
      const state = await this.handlers.setMuteState(body.muted);
      sendJson(200, state);
      return true;
    }

    if (method === "GET" && pathname === "/api/agent/privacy") {
      const state = await this.handlers.getPrivacyState();
      sendJson(200, state);
      return true;
    }

    if (method === "POST" && pathname === "/api/agent/privacy") {
      const body = await ctx.readJsonBody();
      if (typeof body.active !== "boolean") {
        sendJson(400, { error: "active_boolean_required" });
        return true;
      }
      const state = await this.handlers.setPrivacyState(body.active);
      sendJson(200, state);
      return true;
    }

    if (method === "POST" && pathname === "/api/agent/system/action") {
      const body = await ctx.readJsonBody();
      const action = typeof body.action === "string" ? body.action : "";
      if (!SYSTEM_ACTION_TYPES.includes(action as SystemActionType)) {
        sendJson(400, { error: "invalid_action" });
        return true;
      }
      const result = await this.handlers.runSystemAction(action as SystemActionType);
      sendJson(200, result);
      return true;
    }

    if (method === "POST" && pathname === "/api/agent/session/end") {
      const body = await ctx.readJsonBody();
      const autoLock = typeof body.autoLock === "boolean" ? body.autoLock : undefined;
      const result = this.handlers.onSessionEnded
        ? await this.handlers.onSessionEnded({ autoLock })
        : { locked: false, muteRestored: false, privacyRestored: false };
      sendJson(200, result);
      return true;
    }

    return false;
  }
}
