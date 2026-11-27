"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  APOLLO_READONLY_CONFIG_KEYS,
  SILKWARP_APOLLO_TUNING,
  buildOptimalApolloConfigPatch,
} = require("../dist-electron/services/apolloTuning.js");

test("buildOptimalApolloConfigPatch: strips readonly metadata (including vdisplayStatus), preserves user keys, and repairs v3.1.2 regressions", () => {
  const raw = {
    status: 200,
    status_code: 200,
    version: "0.4.6",
    platform: "windows",
    has_session: false,
    login_pin: "",
    vdisplayStatus: "1",
    output_name: "\\\\.\\DISPLAY1",
    server_cmd: [{ name: "Bubbles", cmd: "bubbles.scr" }],
    fec_percentage: 10,
    lan_encryption_mode: "1",
    qsv_preset: "veryfast",
    minimum_fps_target: 15,
    hevc_mode: 1,
    ping_timeout: "10000",
  };
  const snapshot = JSON.stringify(raw);

  const patch = buildOptimalApolloConfigPatch(raw);
  assert.equal(JSON.stringify(raw), snapshot, "input config must not be mutated");
  assert.equal(patch.changed, true);
  assert.deepEqual(patch.changedKeys.sort(), [
    "amd_rc",
    "amd_usage",
    "double_refreshrate",
    "fec_percentage",
    "hevc_mode",
    "high_resolution_scrolling",
    "lan_encryption_mode",
    "limit_framerate",
    "minimum_fps_target",
    "nvenc_intra_refresh",
    "nvenc_latency_over_power",
    "ping_timeout",
    "qsv_preset",
  ]);

  for (const k of APOLLO_READONLY_CONFIG_KEYS) {
    assert.equal(Object.prototype.hasOwnProperty.call(patch.nextConfig, k), false, `${k} must be stripped`);
  }
  assert.equal(Object.prototype.hasOwnProperty.call(patch.nextConfig, "vdisplayStatus"), false);
  assert.equal(patch.nextConfig.output_name, "\\\\.\\DISPLAY1");
  assert.deepEqual(patch.nextConfig.server_cmd, [{ name: "Bubbles", cmd: "bubbles.scr" }]);

  assert.equal(patch.nextConfig.fec_percentage, 20);
  assert.equal(patch.nextConfig.lan_encryption_mode, "0");
  assert.equal(patch.nextConfig.qsv_preset, "medium");
  assert.equal(patch.nextConfig.minimum_fps_target, 60);
  assert.equal(patch.nextConfig.double_refreshrate, "enabled");
  assert.equal(patch.nextConfig.limit_framerate, "enabled");
  assert.equal(patch.nextConfig.high_resolution_scrolling, "enabled");
  assert.equal(patch.nextConfig.hevc_mode, 0);
  assert.equal(patch.nextConfig.ping_timeout, "20000");
  assert.equal(patch.nextConfig.nvenc_intra_refresh, "enabled");
  assert.equal(patch.nextConfig.nvenc_latency_over_power, "enabled");
  assert.equal(patch.nextConfig.amd_usage, "ultralowlatency");
  assert.equal(patch.nextConfig.amd_rc, "vbr_latency");
});

test("buildOptimalApolloConfigPatch: is idempotent even when Apollo returns stringified integers", () => {
  const alreadyTuned = {
    fec_percentage: "20",
    lan_encryption_mode: "0",
    qsv_preset: SILKWARP_APOLLO_TUNING.qsv_preset,
    minimum_fps_target: "60",
    double_refreshrate: "enabled",
    limit_framerate: "enabled",
    high_resolution_scrolling: "enabled",
    hevc_mode: "0",
    ping_timeout: "20000",
    nvenc_intra_refresh: "enabled",
    nvenc_latency_over_power: "enabled",
    amd_usage: "ultralowlatency",
    amd_rc: "vbr_latency",
    output_name: "",
  };

  const patch = buildOptimalApolloConfigPatch(alreadyTuned);
  assert.equal(patch.changed, false);
  assert.deepEqual(patch.changedKeys, []);
});
