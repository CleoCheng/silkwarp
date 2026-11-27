"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BOOT_TUNNEL_CONFIG_PATH,
  PAIR_POLL_BURST_MS,
  PAIR_POLL_IDLE_MS,
  PAIR_POLL_VISIBLE_MS,
  REQUIRED_FIREWALL_RULES,
  buildEasyTierBootTaskXml,
  computePairPollDelayMs,
  enrichDevicesWithEasyTierPeers,
  parseFirewallRulesFromRegQuery,
  parseUuRemoteFromTasklist,
  serializeStateIfChanged,
  xmlEscape,
} = require("../dist-electron/services/hostMaintenance.js");

test("parseFirewallRulesFromRegQuery: returns configured=true when both required active Allow rules exist", () => {
  const sample = [
    "",
    "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\SharedAccess\\Parameters\\FirewallPolicy\\FirewallRules",
    "    {a7bd6b45-4626-4e4d-b727-05858d8e2346}    REG_SZ    v2.33|Action=Allow|Active=TRUE|Dir=In|Protocol=6|LPort2_10=47984-48010|RA4=10.144.0.0/255.255.255.0|Name=SilkWarp-Apollo-TCP|",
    "    {11111111-2222-3333-4444-555555555555}    REG_SZ    v2.33|Action=Allow|Active=TRUE|Dir=In|Protocol=6|LPort=19580|RA4=10.144.0.0/255.255.255.0|Name=SilkWarp-Agent-TCP|",
    "",
    "End of search: 2 match(es) found.",
  ].join("\r\n");

  const res = parseFirewallRulesFromRegQuery(sample, REQUIRED_FIREWALL_RULES);
  assert.equal(res.parsed, true);
  assert.equal(res.configured, true);
  assert.deepEqual(res.foundRules.sort(), ["SilkWarp-Agent-TCP", "SilkWarp-Apollo-TCP"]);
});

test("parseFirewallRulesFromRegQuery: missing SilkWarp-Agent-TCP returns parsed=true, configured=false", () => {
  const sample = [
    "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\SharedAccess\\Parameters\\FirewallPolicy\\FirewallRules",
    "    {a7bd6b45}    REG_SZ    v2.33|Action=Allow|Active=TRUE|Dir=In|Protocol=6|Name=SilkWarp-Apollo-TCP|",
    "End of search: 1 match(es) found.",
  ].join("\r\n");

  const res = parseFirewallRulesFromRegQuery(sample);
  assert.equal(res.parsed, true);
  assert.equal(res.configured, false);
  assert.deepEqual(res.foundRules, ["SilkWarp-Apollo-TCP"]);
});

test("parseFirewallRulesFromRegQuery: inactive or Block rule is ignored", () => {
  const sample = [
    "HKEY_LOCAL_MACHINE\\...\\FirewallRules",
    "    {1}    REG_SZ    v2.33|Action=Allow|Active=FALSE|Dir=In|Name=SilkWarp-Apollo-TCP|",
    "    {2}    REG_SZ    v2.33|Action=Block|Active=TRUE|Dir=In|Name=SilkWarp-Agent-TCP|",
    "End of search: 2 match(es) found.",
  ].join("\r\n");

  const res = parseFirewallRulesFromRegQuery(sample);
  assert.equal(res.parsed, true);
  assert.equal(res.configured, false);
  assert.deepEqual(res.foundRules, []);
});

test("parseFirewallRulesFromRegQuery: handles zero-match output cleanly without netsh fallback", () => {
  assert.deepEqual(parseFirewallRulesFromRegQuery("\r\nEnd of search: 0 match(es) found.\r\n"), {
    parsed: true,
    configured: false,
    foundRules: [],
  });
  assert.deepEqual(parseFirewallRulesFromRegQuery("搜索结束: 找到 0 个匹配项。"), {
    parsed: true,
    configured: false,
    foundRules: [],
  });
});

test("parseFirewallRulesFromRegQuery: returns parsed=false on empty or access-denied failure", () => {
  assert.deepEqual(parseFirewallRulesFromRegQuery(""), {
    parsed: false,
    configured: false,
    foundRules: [],
  });
  assert.deepEqual(parseFirewallRulesFromRegQuery("ERROR: Access is denied."), {
    parsed: false,
    configured: false,
    foundRules: [],
  });
});

test("parseUuRemoteFromTasklist: recognizes GameViewer executables and rejects empty/INFO lines", () => {
  const runningCsv = [
    `"GameViewerService.exe","5588","Services","0","12,904 K"`,
    `"GameViewerServer.exe","7944","Console","1","215,160 K"`,
    `"GameViewer.exe","22300","Console","1","114,580 K"`,
  ].join("\r\n");
  assert.equal(parseUuRemoteFromTasklist(runningCsv), true);
  assert.equal(parseUuRemoteFromTasklist("GameViewerService.exe  5588 Services"), true);
  assert.equal(parseUuRemoteFromTasklist("INFO: No tasks are running which match the specified criteria."), false);
  assert.equal(parseUuRemoteFromTasklist("信息: 没有运行的任务匹配指定标准。"), false);
  assert.equal(parseUuRemoteFromTasklist(""), false);
});

test("serializeStateIfChanged: skips identical state and returns JSON on mutation", () => {
  const initial = { token: "t1", user: { id: "u1", username: "admin" } };
  const saved = JSON.stringify(initial, null, 2);

  assert.equal(serializeStateIfChanged(saved, { token: "t1", user: { id: "u1", username: "admin" } }), null);
  const changed = serializeStateIfChanged(saved, { token: "t1", user: { id: "u1", username: "admin2" } });
  assert.ok(typeof changed === "string" && changed.includes('"admin2"'));
});

test("computePairPollDelayMs: prioritizes recent activity burst, then visible, then idle", () => {
  const now = 1_000_000;
  assert.equal(computePairPollDelayMs({ windowVisible: false, now, lastPairActivityAt: now - 10_000 }), PAIR_POLL_BURST_MS);
  assert.equal(computePairPollDelayMs({ windowVisible: true, now, lastPairActivityAt: now - 120_000 }), PAIR_POLL_VISIBLE_MS);
  assert.equal(computePairPollDelayMs({ windowVisible: false, now, lastPairActivityAt: 0 }), PAIR_POLL_IDLE_MS);
});

test("enrichDevicesWithEasyTierPeers: promotes offline rebooted device with active mesh peer to online", () => {
  const devices = [
    {
      id: "d1",
      owner_user_id: "u1",
      owner_username: "admin",
      name: "Workstation",
      os: "win32",
      mesh_ip: "10.144.0.10",
      mac_address: "",
      broadcast_ip: "255.255.255.255",
      cpu: "",
      gpu: "",
      rustdesk_id: "",
      apollo_ready: true,
      apollo_port: 47984,
      route_type: "offline",
      latency_ms: null,
      is_host: true,
      visibility: "team",
      online: false,
      last_seen: "2026-11-27T00:00:00Z",
      created_at: "2026-11-27T00:00:00Z",
    },
    {
      id: "d2",
      owner_user_id: "u1",
      owner_username: "admin",
      name: "OfflineBox",
      os: "win32",
      mesh_ip: "10.144.0.19",
      mac_address: "",
      broadcast_ip: "255.255.255.255",
      cpu: "",
      gpu: "",
      rustdesk_id: "",
      apollo_ready: true,
      apollo_port: 47984,
      route_type: "offline",
      latency_ms: null,
      is_host: true,
      visibility: "team",
      online: false,
      last_seen: "2026-11-27T00:00:00Z",
      created_at: "2026-11-27T00:00:00Z",
    },
  ];
  const peers = [
    {
      ipv4: "10.144.0.10",
      hostname: "Workstation",
      cost: "p2p",
      latencyMs: 9.5,
      loss: "0%",
      rx: "1 MB",
      tx: "1 MB",
      tunnel: "udp",
      nat: "FullCone",
    },
  ];

  const enriched = enrichDevicesWithEasyTierPeers(devices, peers);
  assert.equal(enriched[0].online, true);
  assert.equal(enriched[0].route_type, "p2p");
  assert.equal(enriched[0].latency_ms, 9.5);
  assert.equal(enriched[1], devices[1]);
});

test("buildEasyTierBootTaskXml & xmlEscape: renders LocalSystem BootTrigger XML safely", () => {
  assert.equal(xmlEscape(`A&B<"C">'D'`), "A&amp;B&lt;&quot;C&quot;&gt;&apos;D&apos;");
  const xml = buildEasyTierBootTaskXml(
    "C:\\ProgramData\\SilkWarp\\easytier\\easytier-core.exe",
    BOOT_TUNNEL_CONFIG_PATH,
    "C:\\ProgramData\\SilkWarp\\easytier",
  );
  assert.match(xml, /<\?xml version="1\.0" encoding="UTF-16"\?>/);
  assert.match(xml, /<BootTrigger>/);
  assert.match(xml, /<UserId>S-1-5-18<\/UserId>/);
  assert.match(xml, /<RestartOnFailure>/);
  assert.match(xml, /-c &quot;C:\\ProgramData\\SilkWarp\\easytier\.toml&quot;/);
});
