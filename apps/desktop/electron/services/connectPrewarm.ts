/**
 * Bounded TTL pre-warm cache & candidate selector for SilkWarp connections.
 *
 * Keeps no `electron` dependency so all cache expiration, safety margins,
 * and candidate ranking rules can be unit-tested in Node directly.
 */

import type { DeviceInfo, PeerStatus } from "../types";
import type { ApolloAppEntry } from "./apolloPermissions";

export const APPLIST_TTL_MS = 5 * 60_000;
export const PERM_TTL_MS = 45_000;
export const AGENT_TOKEN_SAFETY_MARGIN_MS = 60_000;
export const AGENT_TOKEN_MAX_AGE_MS = 10 * 60_000;
export const DEFAULT_PREWARM_COOLDOWN_MS = 45_000;

export interface ApolloPermissionSnapshot {
  paired: boolean;
  permission: number | null;
  hasInput: boolean;
  currentGameId: number;
}

interface CachedAppList {
  meshIp: string;
  port: number;
  entries: ApolloAppEntry[];
  expiresAt: number;
}

interface CachedPermission {
  meshIp: string;
  port: number;
  perm: ApolloPermissionSnapshot;
  expiresAt: number;
}

interface CachedAgentToken {
  meshIp: string;
  port: number;
  userId: string;
  token: string;
  expiresAt: number;
}

export class ConnectPrewarmCache {
  private readonly nowFn: () => number;
  private appLists = new Map<string, CachedAppList>();
  private permissions = new Map<string, CachedPermission>();
  private agentTokens = new Map<string, CachedAgentToken>();
  private lastAttempts = new Map<string, number>();

  constructor(nowFn: () => number = () => Date.now()) {
    this.nowFn = nowFn;
  }

  getFreshAppEntries(deviceId: string, meshIp: string, port: number): ApolloAppEntry[] | null {
    const cached = this.appLists.get(deviceId);
    if (!cached) return null;
    if (cached.meshIp !== meshIp || cached.port !== port || this.nowFn() >= cached.expiresAt) {
      return null;
    }
    return cached.entries;
  }

  setAppEntries(
    deviceId: string,
    meshIp: string,
    port: number,
    entries: ApolloAppEntry[],
    ttlMs = APPLIST_TTL_MS,
  ): void {
    if (!deviceId || !meshIp || entries.length === 0) return;
    this.appLists.set(deviceId, {
      meshIp,
      port,
      entries,
      expiresAt: this.nowFn() + Math.max(1000, ttlMs),
    });
  }

  getFreshPermission(deviceId: string, meshIp: string, port: number): ApolloPermissionSnapshot | null {
    const cached = this.permissions.get(deviceId);
    if (!cached) return null;
    if (cached.meshIp !== meshIp || cached.port !== port || this.nowFn() >= cached.expiresAt) {
      return null;
    }
    return cached.perm;
  }

  setPermission(
    deviceId: string,
    meshIp: string,
    port: number,
    perm: ApolloPermissionSnapshot,
    ttlMs = PERM_TTL_MS,
  ): void {
    if (!deviceId || !meshIp) return;
    this.permissions.set(deviceId, {
      meshIp,
      port,
      perm,
      expiresAt: this.nowFn() + Math.max(1000, ttlMs),
    });
  }

  getValidAgentToken(deviceId: string, meshIp: string, port: number, userId: string): string | null {
    const cached = this.agentTokens.get(deviceId);
    if (!cached || !cached.token) return null;
    if (cached.meshIp !== meshIp || cached.port !== port || cached.userId !== userId) {
      return null;
    }
    if (this.nowFn() >= cached.expiresAt - AGENT_TOKEN_SAFETY_MARGIN_MS) {
      return null;
    }
    return cached.token;
  }

  setAgentToken(
    deviceId: string,
    meshIp: string,
    port: number,
    userId: string,
    token: string,
    serverExpiresAt?: number,
  ): void {
    if (!deviceId || !meshIp || !token) return;
    const now = this.nowFn();
    const boundedExpiry =
      typeof serverExpiresAt === "number" && Number.isFinite(serverExpiresAt) && serverExpiresAt > now
        ? Math.min(serverExpiresAt, now + AGENT_TOKEN_MAX_AGE_MS)
        : now + AGENT_TOKEN_MAX_AGE_MS;
    this.agentTokens.set(deviceId, {
      meshIp,
      port,
      userId,
      token,
      expiresAt: boundedExpiry,
    });
  }

  shouldPrewarm(deviceId: string, cooldownMs = DEFAULT_PREWARM_COOLDOWN_MS): boolean {
    if (!deviceId) return false;
    const last = this.lastAttempts.get(deviceId);
    if (last === undefined) return true;
    return this.nowFn() - last >= cooldownMs;
  }

  markPrewarmAttempt(deviceId: string): void {
    if (!deviceId) return;
    this.lastAttempts.set(deviceId, this.nowFn());
  }

  invalidatePermission(deviceId: string): void {
    this.permissions.delete(deviceId);
  }

  invalidateAgent(deviceId: string): void {
    this.agentTokens.delete(deviceId);
  }

  invalidateAgentByEndpoint(meshIp: string, port: number): void {
    for (const [deviceId, entry] of this.agentTokens.entries()) {
      if (entry.meshIp === meshIp && entry.port === port) {
        this.agentTokens.delete(deviceId);
      }
    }
  }

  invalidateDevice(deviceId: string): void {
    this.appLists.delete(deviceId);
    this.permissions.delete(deviceId);
    this.agentTokens.delete(deviceId);
    this.lastAttempts.delete(deviceId);
  }

  clear(): void {
    this.appLists.clear();
    this.permissions.clear();
    this.agentTokens.clear();
    this.lastAttempts.clear();
  }
}

/**
 * Selects up to `maxCount` online, Apollo-ready remote hosts eligible for
 * low-overhead background connection pre-warming.
 */
export function selectPrewarmCandidates(
  devices: DeviceInfo[],
  selfDeviceId: string,
  pairedHosts: Record<string, string>,
  peers: PeerStatus[],
  maxCount = 4,
): DeviceInfo[] {
  const activePeerIps = new Set(
    peers.filter((p) => p.ipv4 && p.cost !== "Local").map((p) => p.ipv4),
  );

  const eligible = devices.filter((d) => {
    if (!d || d.id === selfDeviceId || !d.online || !d.apollo_ready || !d.mesh_ip) {
      return false;
    }
    const isPaired = pairedHosts[d.id] === d.mesh_ip;
    const hasPeerRoute = activePeerIps.has(d.mesh_ip);
    return isPaired || hasPeerRoute;
  });

  eligible.sort((a, b) => {
    const aPaired = pairedHosts[a.id] === a.mesh_ip ? 0 : 1;
    const bPaired = pairedHosts[b.id] === b.mesh_ip ? 0 : 1;
    if (aPaired !== bPaired) return aPaired - bPaired;

    const aLat = typeof a.latency_ms === "number" && Number.isFinite(a.latency_ms) ? a.latency_ms : Infinity;
    const bLat = typeof b.latency_ms === "number" && Number.isFinite(b.latency_ms) ? b.latency_ms : Infinity;
    if (aLat !== bLat) return aLat - bLat;

    return a.id.localeCompare(b.id);
  });

  return eligible.slice(0, Math.max(0, maxCount));
}
