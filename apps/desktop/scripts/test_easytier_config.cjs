"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  hasConnectedRemotePeer,
  renderEasyTierConfig,
  selectEasyTierPeers,
} = require("../dist-electron/services/easytierConfig.js");

const SAMPLE_CFG = {
  api_url: "https://example.com",
  mesh_ip: "10.144.0.10",
  mesh_cidr: "10.144.0.0/24",
  easytier: {
    network_name: "silkwarp-team",
    network_secret: "secret-value",
    peers: [
      "tcp://relay.example.com:11011",
      "udp://relay.example.com:11011",
      "TCP://RELAY.EXAMPLE.COM:11011",
      "udp://coord.example.com:11010",
      "tcp://coord.example.com:11010",
      "tcp://tcp-only.example.com:11012",
      " ",
    ],
  },
};

test("selectEasyTierPeers: udp_only drops matching TCP duplicates while keeping TCP-only endpoints", () => {
  const selected = selectEasyTierPeers(SAMPLE_CFG.easytier.peers, "udp_only");
  assert.deepEqual(selected, [
    "udp://relay.example.com:11011",
    "udp://coord.example.com:11010",
    "tcp://tcp-only.example.com:11012",
  ]);
});

test("selectEasyTierPeers: udp_and_tcp preserves TCP fallbacks ordered after UDP", () => {
  const selected = selectEasyTierPeers(SAMPLE_CFG.easytier.peers, "udp_and_tcp");
  assert.deepEqual(selected, [
    "udp://relay.example.com:11011",
    "udp://coord.example.com:11010",
    "tcp://relay.example.com:11011",
    "tcp://coord.example.com:11010",
    "tcp://tcp-only.example.com:11012",
  ]);
});

test("renderEasyTierConfig: defaults to pure-UDP listeners, no client relaying, and MTU 1360", () => {
  const toml = renderEasyTierConfig(SAMPLE_CFG, 'Mobar-"PC"');
  assert.match(toml, /hostname = "Mobar-PC"/);
  assert.match(toml, /ipv4 = "10\.144\.0\.10\/24"/);
  assert.match(toml, /"udp:\/\/0\.0\.0\.0:0"/);
  assert.match(toml, /"udp:\/\/\[::\]:0"/);
  assert.doesNotMatch(toml, /"tcp:\/\/0\.0\.0\.0:0"/);
  assert.match(toml, /default_protocol = "udp"/);
  assert.match(toml, /latency_first = false/);
  assert.match(toml, /multi_thread_count = 4/);
  assert.match(toml, /disable_tcp_hole_punching = true/);
  assert.match(toml, /relay_network_whitelist = ""/);
  assert.match(toml, /mtu = 1360/);
  assert.doesNotMatch(toml, /tcp:\/\/relay\.example\.com:11011/);
});

test("renderEasyTierConfig: udp_and_tcp mode restores TCP listeners and TCP hole punching", () => {
  const toml = renderEasyTierConfig(SAMPLE_CFG, "Mobar", "udp_and_tcp");
  assert.match(toml, /"udp:\/\/0\.0\.0\.0:0"/);
  assert.match(toml, /"tcp:\/\/0\.0\.0\.0:0"/);
  assert.match(toml, /disable_tcp_hole_punching = false/);
  assert.match(toml, /tcp:\/\/relay\.example\.com:11011/);
  assert.ok(toml.indexOf("udp://relay.example.com:11011") < toml.indexOf("tcp://relay.example.com:11011"));
});

test("hasConnectedRemotePeer: requires at least one non-local p2p or relay peer", () => {
  assert.equal(hasConnectedRemotePeer([]), false);
  assert.equal(
    hasConnectedRemotePeer([{ ipv4: "10.144.0.10", hostname: "Mobar", cost: "Local" }]),
    false,
  );
  assert.equal(
    hasConnectedRemotePeer([
      { ipv4: "10.144.0.10", hostname: "Mobar", cost: "Local" },
      { ipv4: "10.144.0.1", hostname: "relay", cost: "p2p" },
    ]),
    true,
  );
  assert.equal(
    hasConnectedRemotePeer([{ ipv4: "10.144.0.11", hostname: "Think", cost: "relay(2)" }]),
    true,
  );
});

test("easytier-core --check-config accepts rendered udp_only and udp_and_tcp TOML", { timeout: 10000 }, (t) => {
  const candidates = [
    path.resolve(__dirname, "../resources/easytier/easytier-core.exe"),
    "C:\\Program Files\\SilkWarp\\resources\\easytier\\easytier-core.exe",
  ];
  const core = candidates.find((p) => fs.existsSync(p));
  if (!core) {
    t.skip("easytier-core.exe binary not present in test environment");
    return;
  }

  for (const mode of ["udp_only", "udp_and_tcp"]) {
    const tmpPath = path.join(os.tmpdir(), `silkwarp-et-check-${mode}-${process.pid}.toml`);
    try {
      fs.writeFileSync(tmpPath, renderEasyTierConfig(SAMPLE_CFG, "TestNode", mode), "utf8");
      execFileSync(core, ["-c", tmpPath, "--check-config"], { timeout: 5000, windowsHide: true });
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  }
});
