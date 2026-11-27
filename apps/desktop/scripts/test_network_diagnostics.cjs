"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildNetworkDiagnostics,
  inspectLocalIpv6Interfaces,
  isGlobalUnicastIpv6,
  parseEasyTierNodeInfo,
} = require("../dist-electron/services/networkDiagnostics.js");

test("isGlobalUnicastIpv6: distinguishes global unicast 2000::/3 from local/private/mapped addresses", () => {
  assert.equal(isGlobalUnicastIpv6("240e:390:1234:5678::1"), true);
  assert.equal(isGlobalUnicastIpv6("2001:db8::1%12"), true);
  assert.equal(isGlobalUnicastIpv6("fe80::1%12"), false);
  assert.equal(isGlobalUnicastIpv6("::1"), false);
  assert.equal(isGlobalUnicastIpv6("fc00::1"), false);
  assert.equal(isGlobalUnicastIpv6("fd12:3456::1"), false);
  assert.equal(isGlobalUnicastIpv6("ff02::1"), false);
  assert.equal(isGlobalUnicastIpv6("::ffff:192.0.2.1"), false);
  assert.equal(isGlobalUnicastIpv6("192.168.1.10"), false);
});

test("inspectLocalIpv6Interfaces: counts non-internal global IPv6 addresses without returning raw IPs", () => {
  const result = inspectLocalIpv6Interfaces({
    Ethernet: [
      { address: "fe80::1234", family: "IPv6", internal: false },
      { address: "2409:8a1e:abcd::1", family: "IPv6", internal: false },
      { address: "192.168.1.100", family: "IPv4", internal: false },
    ],
    Loopback: [{ address: "::1", family: "IPv6", internal: true }],
  });
  assert.deepEqual(result, { ipv6GlobalReady: true, ipv6InterfaceCount: 1 });
});

test("parseEasyTierNodeInfo: extracts IPv6 readiness without leaking config secrets or raw IPs", () => {
  const raw = JSON.stringify({
    hostname: "Mi",
    config: "network_secret = \"TOP_SECRET_NEVER_LEAK\"",
    ip_list: {
      public_ipv4: { addr: 827166440 },
      public_ipv6: null,
      interface_ipv6s: [{ addr: "secret-should-not-pass-through" }],
    },
    public_ipv6_addr: null,
  });

  const parsed = parseEasyTierNodeInfo(raw);
  assert.deepEqual(parsed, { publicIpv6Ready: true, interfaceIpv6Count: 1 });
  assert.equal("config" in parsed, false);
  assert.equal("ip_list" in parsed, false);
});

test("buildNetworkDiagnostics: evaluates excellent, double-symmetric relay, TCP fallback & elevation states", () => {
  const excellent = buildNetworkDiagnostics({
    easytierRunning: true,
    needsElevation: false,
    peers: [
      { ipv4: "10.144.0.12", hostname: "Mi", cost: "Local", latencyMs: null, loss: "-", rx: "-", tx: "-", tunnel: "-", nat: "PortRestricted" },
      { ipv4: "10.144.0.11", hostname: "Think", cost: "p2p", latencyMs: 2.3, loss: "0.0%", rx: "1MB", tx: "1MB", tunnel: "udp", nat: "PortRestricted" },
    ],
    localIpv6: { ipv6GlobalReady: true, ipv6InterfaceCount: 1 },
    nodeInfo: { publicIpv6Ready: true, interfaceIpv6Count: 1 },
  });
  assert.equal(excellent.overall, "excellent");
  assert.equal(excellent.p2pCount, 1);
  assert.equal(excellent.relayCount, 0);
  assert.equal(excellent.tcpFallbackCount, 0);

  const doubleSymTcp = buildNetworkDiagnostics({
    easytierRunning: true,
    needsElevation: false,
    peers: [
      { ipv4: "10.144.0.12", hostname: "Mi", cost: "Local", latencyMs: null, loss: "-", rx: "-", tx: "-", tunnel: "-", nat: "Symmetric" },
      { ipv4: "10.144.0.11", hostname: "Think", cost: "relay", latencyMs: 42.1, loss: "0.0%", rx: "1MB", tx: "1MB", tunnel: "tcp", nat: "Symmetric" },
    ],
    localIpv6: { ipv6GlobalReady: false, ipv6InterfaceCount: 0 },
  });
  assert.equal(doubleSymTcp.overall, "degraded");
  assert.equal(doubleSymTcp.tcpFallbackCount, 1);
  const udpCheck = doubleSymTcp.checks.find((c) => c.id === "udp_transport");
  assert.equal(udpCheck.action, "reconnect_udp");
  assert.ok(doubleSymTcp.recommendations.some((r) => r.includes("IPv6")));

  const offline = buildNetworkDiagnostics({
    easytierRunning: false,
    needsElevation: true,
    peers: [],
    localIpv6: { ipv6GlobalReady: false, ipv6InterfaceCount: 0 },
  });
  assert.equal(offline.overall, "degraded");
  assert.equal(offline.checks.find((c) => c.id === "easytier_core")?.action, "relaunch_admin");
});
