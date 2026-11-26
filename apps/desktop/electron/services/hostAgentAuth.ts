/**
 * Host Companion Agent authentication primitives.
 *
 * This module intentionally has NO `electron` imports (only Node's built-in
 * `crypto`) so the compiled CommonJS output can be exercised directly by
 * Node's built-in test runner and reused by the Electron main process.
 */

import crypto from "node:crypto";

/** Default TCP port of the embedded Host Companion Agent. */
export const DEFAULT_AGENT_PORT = 19580;

const PASSWORD_HASH_SCHEME = "pbkdf2_sha512";
const PBKDF2_ITERATIONS = 120_000;
const PBKDF2_KEY_LENGTH = 32;
const PBKDF2_DIGEST = "sha512";
const SALT_BYTES = 16;

const MAX_FAILS = 5;
const LOCK_MS = 60_000;
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * Normalizes an address reported by Node's socket layer.
 *
 * Handles empty input, IPv6 zone suffixes (`fe80::1%12`), IPv4-mapped IPv6
 * (`::ffff:10.144.0.12`) and the IPv6 loopback (`::1` -> `127.0.0.1`).
 */
export function normalizeIpAddress(ip: string): string {
  let value = (ip || "").trim();
  if (!value) return "";
  if (value.startsWith("[") && value.endsWith("]")) {
    value = value.slice(1, -1);
  }
  const zoneIndex = value.indexOf("%");
  if (zoneIndex >= 0) {
    value = value.slice(0, zoneIndex);
  }
  const mappedPrefix = "::ffff:";
  if (value.toLowerCase().startsWith(mappedPrefix)) {
    value = value.slice(mappedPrefix.length);
  }
  if (value === "::1") {
    value = "127.0.0.1";
  }
  return value;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = ((result << 8) | octet) >>> 0;
  }
  return result;
}

/**
 * Returns true when `ip` falls inside the IPv4 `a.b.c.d/prefix` network.
 * Malformed addresses or CIDRs return false instead of throwing.
 */
export function isIpInCidr(ip: string, cidr: string): boolean {
  const address = normalizeIpAddress(ip);
  const spec = (cidr || "").trim();
  if (!address || !spec) return false;

  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return false;

  const networkText = spec.slice(0, slash).trim();
  const prefixText = spec.slice(slash + 1).trim();
  if (!/^\d{1,2}$/.test(prefixText)) return false;

  const prefix = Number(prefixText);
  if (prefix < 0 || prefix > 32) return false;

  const addressInt = ipv4ToInt(address);
  const networkInt = ipv4ToInt(networkText);
  if (addressInt === null || networkInt === null) return false;

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((addressInt & mask) >>> 0) === ((networkInt & mask) >>> 0);
}

function isHex(value: string): boolean {
  return value.length > 0 && value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value);
}

/** Hashes an access password as `pbkdf2_sha512$120000$<saltHex>$<hashHex>`. */
export function hashAccessPassword(plain: string): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.pbkdf2Sync(plain, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, PBKDF2_DIGEST);
  return `${PASSWORD_HASH_SCHEME}$${PBKDF2_ITERATIONS}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** Verifies a password against a hash produced by `hashAccessPassword`. */
export function verifyAccessPassword(plain: string, storedHash: string): boolean {
  if (!plain || !storedHash) return false;

  const parts = storedHash.split("$");
  if (parts.length !== 4) return false;

  const [scheme, iterationsText, saltHex, hashHex] = parts;
  if (scheme !== PASSWORD_HASH_SCHEME) return false;
  if (!/^\d+$/.test(iterationsText)) return false;

  const iterations = Number(iterationsText);
  if (!Number.isSafeInteger(iterations) || iterations <= 0 || iterations > 10_000_000) {
    return false;
  }
  if (!isHex(saltHex) || !isHex(hashHex)) return false;

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = crypto.pbkdf2Sync(plain, salt, iterations, expected.length, PBKDF2_DIGEST);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/** Generates a random six-digit temporary access password. */
export function generateTempAccessPassword(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftHash = crypto.createHash("sha256").update(left, "utf8").digest();
  const rightHash = crypto.createHash("sha256").update(right, "utf8").digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

export interface AgentAuthConfig {
  requireAccessPassword: boolean;
  permanentPasswordHash: string;
  tempPassword: string;
  tempPasswordExpiresAt: number;
  allowSameAccountBypass: boolean;
  hostOwnerUserId: string;
}

export interface AgentAuthInput {
  remoteIp: string;
  password?: string;
  clientUserId?: string;
  deviceId?: string;
}

export type AgentAuthResult =
  | { ok: true; statusCode: 200; token: string; expiresAt: number }
  | { ok: false; statusCode: 401 | 429; error: string; retryAfterSec?: number };

interface FailureEntry {
  timestamps: number[];
  blockedUntil: number;
}

/**
 * Per-IP password authentication with rolling failure windows and bearer
 * token issuance. Time is injectable so unit tests can fast-forward locks.
 */
export class AgentAuthManager {
  private readonly failures = new Map<string, FailureEntry>();
  private readonly tokens = new Map<string, number>();
  private readonly nowFn: () => number;

  constructor(
    private readonly getConfig: () => AgentAuthConfig,
    nowFn: () => number = Date.now,
  ) {
    this.nowFn = nowFn;
  }

  authenticate(input: AgentAuthInput): AgentAuthResult {
    const now = this.nowFn();
    const ip = normalizeIpAddress(input.remoteIp) || "unknown";

    this.cleanupStale(now);

    const existing = this.failures.get(ip);
    if (existing && existing.blockedUntil > now) {
      return {
        ok: false,
        statusCode: 429,
        error: "密码错误次数过多，请稍后再试",
        retryAfterSec: Math.ceil((existing.blockedUntil - now) / 1000),
      };
    }

    const cfg = this.getConfig();
    const password = typeof input.password === "string" ? input.password : undefined;

    const authorized =
      !cfg.requireAccessPassword ||
      (cfg.allowSameAccountBypass &&
        Boolean(cfg.hostOwnerUserId) &&
        Boolean(input.clientUserId) &&
        input.clientUserId === cfg.hostOwnerUserId) ||
      (typeof password === "string" &&
        Boolean(cfg.permanentPasswordHash) &&
        verifyAccessPassword(password, cfg.permanentPasswordHash)) ||
      (typeof password === "string" &&
        Boolean(cfg.tempPassword) &&
        cfg.tempPasswordExpiresAt > now &&
        constantTimeStringEqual(password.trim(), cfg.tempPassword));

    if (authorized) {
      this.failures.delete(ip);
      this.pruneTokens(now);
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = now + TOKEN_TTL_MS;
      this.tokens.set(token, expiresAt);
      return { ok: true, statusCode: 200, token, expiresAt };
    }

    const entry = existing ?? { timestamps: [], blockedUntil: 0 };
    entry.timestamps = entry.timestamps.filter((stamp) => now - stamp < LOCK_MS);
    entry.timestamps.push(now);

    if (entry.timestamps.length >= MAX_FAILS) {
      entry.blockedUntil = now + LOCK_MS;
      entry.timestamps = [];
      this.failures.set(ip, entry);
      return {
        ok: false,
        statusCode: 429,
        error: "密码错误次数过多，请稍后再试",
        retryAfterSec: Math.ceil(LOCK_MS / 1000),
      };
    }

    this.failures.set(ip, entry);
    const error = cfg.requireAccessPassword
      ? password
        ? "访问密码错误"
        : "此主机需要输入访问密码"
      : "认证失败";
    return { ok: false, statusCode: 401, error };
  }

  verifyToken(token: string): boolean {
    if (!token) return false;
    const now = this.nowFn();
    const expiresAt = this.tokens.get(token);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }

  revokeAllTokens(): void {
    this.tokens.clear();
  }

  private cleanupStale(now: number): void {
    for (const [ip, entry] of this.failures) {
      if (entry.blockedUntil > now) continue;
      if (entry.blockedUntil !== 0) {
        entry.blockedUntil = 0;
        entry.timestamps = [];
      }
      entry.timestamps = entry.timestamps.filter((stamp) => now - stamp < LOCK_MS);
      if (entry.timestamps.length === 0) {
        this.failures.delete(ip);
      }
    }
  }

  private pruneTokens(now: number): void {
    for (const [token, expiresAt] of this.tokens) {
      if (expiresAt <= now) {
        this.tokens.delete(token);
      }
    }
  }
}
