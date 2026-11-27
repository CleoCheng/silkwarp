"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  APOLLO_READONLY_CONFIG_KEYS,
  SILKWARP_APOLLO_TUNING,
  buildOptimalApolloConfigPatch,
} = require("../dist-electron/services/apolloTuning.js");

test("buildOptimalApolloConfigPatch: strips readonly metadata, preserves user keys, and sets lossless WAN tuning", () => {
  const raw = {
    status: 200,
    status_code: 200,
    version: "0.4.6",
    platform: "windows",
    has_session: false,
    login_pin: "",
    output_name: "\\\\.\\DISPLAY1",
    server_cmd: [{ name: "Bubbles", cmd: "bubbles.scr" }],
    fec_percentage: 20,
    lan_encryption_mode: "1",
    qsv_preset: "medium",
    minimum_fps_target: 15,
    hevc_mode: 1,
    ping_timeout: "10000",
  };
  const snapshot = JSON.stringify(raw);

  const patch = buildOptimalApolloConfigPatch(raw);
  assert.equal(JSON.stringify(raw), snapshot, "input config must not be mutated");
  assert.equal(patch.changed, true);
  assert.deepEqual(patch.changedKeys.sort(), [
    "fec_percentage",
    "hevc_mode",
    "lan_encryption_mode",
    "minimum_fps_target",
    "ping_timeout",
    "qsv_preset",
  ]);

  for (const k of APOLLO_READONLY_CONFIG_KEYS) {
    assert.equal(Object.prototype.hasOwnProperty.call(patch.nextConfig, k), false, `${k} must be stripped`);
  }
  assert.equal(patch.nextConfig.output_name, "\\\\.\\DISPLAY1");
  assert.deepEqual(patch.nextConfig.server_cmd, [{ name: "Bubbles", cmd: "bubbles.scr" }]);

  assert.equal(patch.nextConfig.fec_percentage, 10);
  assert.equal(patch.nextConfig.lan_encryption_mode, "0");
  assert.equal(patch.nextConfig.qsv_preset, "veryfast");
  assert.equal(patch.nextConfig.minimum_fps_target, 0);
  assert.equal(patch.nextConfig.hevc_mode, 0);
  assert.equal(patch.nextConfig.ping_timeout, "15000");
});

test("buildOptimalApolloConfigPatch: is idempotent even when Apollo returns stringified integers", () => {
  const alreadyTuned = {
    fec_percentage: "10",
    lan_encryption_mode: "0",
    qsv_preset: SILKWARP_APOLLO_TUNING.qsv_preset,
    minimum_fps_target: "0",
    hevc_mode: "0",
    ping_timeout: "15000",
    output_name: "",
  };

  const patch = buildOptimalApolloConfigPatch(alreadyTuned);
  assert.equal(patch.changed, false);
  assert.deepEqual(patch.changedKeys, []);
});
