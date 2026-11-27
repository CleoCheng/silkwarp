"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AGENT_TOKEN_SAFETY_MARGIN_MS,
  APPLIST_TTL_MS,
  ConnectPrewarmCache,
  DEFAULT_PREWARM_COOLDOWN_MS,
  PERM_TTL_MS,
  selectPrewarmCandidates,
} = require("../dist-electron/services/connectPrewarm.js");

test("ConnectPrewarmCache: manages applist & permission TTLs and endpoint invalidation", () => {
  let now = 1_000_000;
  const cache = new ConnectPrewarmCache(() => now);

  cache.setAppEntries("dev-1", "10.144.0.11", 47984, [{ title: "Desktop", id: 881448767 }]);
  assert.deepEqual(cache.getFreshAppEntries("dev-1", "10.144.0.11", 47984), [{ title: "Desktop", id: 881448767 }]);
  assert.equal(cache.getFreshAppEntries("dev-1", "10.144.0.99", 47984), null, "meshIp change must miss");
  assert.equal(cache.getFreshAppEntries("dev-1", "10.144.0.11", 47999), null, "port change must miss");

  cache.setPermission("dev-1", "10.144.0.11", 47984, {
    paired: true,
    permission: 255,
    hasInput: true,
    currentGameId: 0,
  });
  assert.equal(cache.getFreshPermission("dev-1", "10.144.0.11", 47984)?.paired, true);

  now += PERM_TTL_MS + 1;
  assert.equal(cache.getFreshPermission("dev-1", "10.144.0.11", 47984), null, "permission must expire after TTL");
  assert.ok(cache.getFreshAppEntries("dev-1", "10.144.0.11", 47984), "applist should still be fresh");

  now += APPLIST_TTL_MS;
  assert.equal(cache.getFreshAppEntries("dev-1", "10.144.0.11", 47984), null, "applist must expire");
});

test("ConnectPrewarmCache: enforces safety margin & user scoping on agent tokens", () => {
  let now = 5_000_000;
  const cache = new ConnectPrewarmCache(() => now);

  cache.setAgentToken("dev-1", "10.144.0.11", 19580, "u1", "tok-abc", now + 180_000);
  assert.equal(cache.getValidAgentToken("dev-1", "10.144.0.11", 19580, "u1"), "tok-abc");
  assert.equal(cache.getValidAgentToken("dev-1", "10.144.0.11", 19580, "u2"), null, "user switch must miss");

  now += 180_000 - AGENT_TOKEN_SAFETY_MARGIN_MS + 5;
  assert.equal(cache.getValidAgentToken("dev-1", "10.144.0.11", 19580, "u1"), null, "safety margin must evict token early");

  cache.setAgentToken("dev-2", "10.144.0.22", 19580, "u1", "tok-xyz", now + 300_000);
  cache.invalidateAgentByEndpoint("10.144.0.22", 19580);
  assert.equal(cache.getValidAgentToken("dev-2", "10.144.0.22", 19580, "u1"), null);
});

test("ConnectPrewarmCache: respects cooldown and device invalidation", () => {
  let now = 100_000;
  const cache = new ConnectPrewarmCache(() => now);

  assert.equal(cache.shouldPrewarm("dev-1"), true);
  cache.markPrewarmAttempt("dev-1");
  assert.equal(cache.shouldPrewarm("dev-1"), false);

  now += DEFAULT_PREWARM_COOLDOWN_MS + 1;
  assert.equal(cache.shouldPrewarm("dev-1"), true);

  cache.setPermission("dev-1", "10.144.0.11", 47984, {
    paired: true,
    permission: 255,
    hasInput: true,
    currentGameId: 123,
  });
  cache.invalidateDevice("dev-1");
  assert.equal(cache.getFreshPermission("dev-1", "10.144.0.11", 47984), null);
});

test("selectPrewarmCandidates: prioritizes paired reachable hosts and respects maxCount", () => {
  const devices = [
    { id: "self", online: true, apollo_ready: true, mesh_ip: "10.144.0.12", latency_ms: 0 },
    { id: "offline", online: false, apollo_ready: true, mesh_ip: "10.144.0.13", latency_ms: 5 },
    { id: "no-apollo", online: true, apollo_ready: false, mesh_ip: "10.144.0.14", latency_ms: 5 },
    { id: "unroutable", online: true, apollo_ready: true, mesh_ip: "10.144.0.15", latency_ms: 5 },
    { id: "peer-slow", online: true, apollo_ready: true, mesh_ip: "10.144.0.16", latency_ms: 40 },
    { id: "paired-lat", online: true, apollo_ready: true, mesh_ip: "10.144.0.11", latency_ms: 2.5 },
    { id: "peer-fast", online: true, apollo_ready: true, mesh_ip: "10.144.0.17", latency_ms: 8 },
  ];
  const pairedHosts = { "paired-lat": "10.144.0.11" };
  const peers = [
    { ipv4: "10.144.0.12", cost: "Local" },
    { ipv4: "10.144.0.11", cost: "p2p" },
    { ipv4: "10.144.0.16", cost: "relay" },
    { ipv4: "10.144.0.17", cost: "p2p" },
  ];

  const selected = selectPrewarmCandidates(devices, "self", pairedHosts, peers, 2);
  assert.deepEqual(
    selected.map((d) => d.id),
    ["paired-lat", "peer-fast"],
  );
});
