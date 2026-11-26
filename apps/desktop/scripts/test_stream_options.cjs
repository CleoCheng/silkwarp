"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_STREAM_PRESET,
  buildMoonlightStreamArgs,
  computeEffectivePreset,
  normalizeStreamPreset,
  normalizeWindowResolution,
  resolvePacketSize,
  resolveStreamAppTarget,
} = require("../dist-electron/services/streamOptions.js");

test("normalizeStreamPreset: undefined returns the full default preset", () => {
  assert.deepEqual(normalizeStreamPreset(undefined), DEFAULT_STREAM_PRESET);
  assert.deepEqual(normalizeStreamPreset(null), DEFAULT_STREAM_PRESET);
  assert.equal(DEFAULT_STREAM_PRESET.displayMode, "windowed");
  assert.equal(DEFAULT_STREAM_PRESET.muteHostAudio, true);
  assert.equal(DEFAULT_STREAM_PRESET.lowLatency, true);
  assert.equal(DEFAULT_STREAM_PRESET.streamApp, "Virtual Display");
  assert.equal(DEFAULT_STREAM_PRESET.packetSize, "auto");
});

test("normalizeStreamPreset: migrates legacy 4-field presets", () => {
  const migrated = normalizeStreamPreset({
    resolution: "1920x1080",
    fps: 60,
    bitrateMbps: 15,
    codec: "h264",
  });
  assert.deepEqual(migrated, {
    ...DEFAULT_STREAM_PRESET,
    resolution: "1920x1080",
    fps: 60,
    bitrateMbps: 15,
    codec: "h264",
  });
});

test("normalizeStreamPreset: clamps and falls back on invalid values", () => {
  assert.equal(normalizeStreamPreset({ resolution: "not-a-resolution" }).resolution, "2560x1440");
  assert.equal(normalizeStreamPreset({ resolution: "12x34" }).resolution, "2560x1440");
  assert.equal(normalizeStreamPreset({ fps: 75 }).fps, 120);
  assert.equal(normalizeStreamPreset({ bitrateMbps: 2 }).bitrateMbps, 4);
  assert.equal(normalizeStreamPreset({ bitrateMbps: 500 }).bitrateMbps, 100);
  assert.equal(normalizeStreamPreset({ bitrateMbps: Number.NaN }).bitrateMbps, 35);
  assert.equal(normalizeStreamPreset({ codec: "vp9" }).codec, "hevc");
  assert.equal(normalizeStreamPreset({ displayMode: "picture-in-picture" }).displayMode, "windowed");
  assert.equal(normalizeStreamPreset({ streamApp: "Unknown" }).streamApp, "Virtual Display");
  assert.equal(normalizeStreamPreset({ captureSystemKeys: "sometimes" }).captureSystemKeys, "fullscreen");
  assert.equal(normalizeStreamPreset({ packetSize: 100 }).packetSize, "auto");
  assert.equal(normalizeStreamPreset({ packetSize: 2000 }).packetSize, "auto");
  assert.equal(normalizeStreamPreset({ packetSize: 1100 }).packetSize, 1100);
  assert.equal(normalizeStreamPreset({ muteHostAudio: "yes" }).muteHostAudio, true);
  assert.equal(normalizeStreamPreset({ lowLatency: 0 }).lowLatency, true);
  assert.equal(normalizeStreamPreset({ showPerfOverlay: true }).showPerfOverlay, true);
});

test("normalizeWindowResolution: aligns odd sizes down to even pixels", () => {
  assert.equal(normalizeWindowResolution(1367, 769), "1366x768");
  assert.equal(normalizeWindowResolution(300, 200), "800x600");
  assert.equal(normalizeWindowResolution(5000, 3000), "3840x2160");
  assert.equal(normalizeWindowResolution(Number.NaN, Number.POSITIVE_INFINITY), "1920x1080");
  assert.equal(normalizeWindowResolution(1920.9, 1080.9), "1920x1080");
});

test("resolvePacketSize: p2p / relay defaults and explicit overrides", () => {
  const preset = normalizeStreamPreset();
  assert.equal(resolvePacketSize(preset, "p2p"), 1200);
  assert.equal(resolvePacketSize(preset, "local"), 1200);
  assert.equal(resolvePacketSize(preset, "relay"), 1024);
  assert.equal(resolvePacketSize(preset, "relay(2)"), 1024);
  assert.equal(resolvePacketSize(preset, " RELAY "), 1024);
  assert.equal(resolvePacketSize({ ...preset, packetSize: 1100 }, "p2p"), 1100);
  assert.equal(resolvePacketSize({ ...preset, packetSize: 100 }, "p2p"), 512);
  assert.equal(resolvePacketSize({ ...preset, packetSize: 9999 }, "p2p"), 1320);
});

test("computeEffectivePreset: relay guardrail caps 120fps/35Mbps to 60fps/15Mbps", () => {
  const preset = normalizeStreamPreset({ fps: 120, bitrateMbps: 35, adaptiveRelayCap: true });
  const relayed = computeEffectivePreset(preset, "relay(2)");
  assert.equal(relayed.fps, 60);
  assert.equal(relayed.bitrateMbps, 15);
  // The persisted preset must not be mutated.
  assert.equal(preset.fps, 120);
  assert.equal(preset.bitrateMbps, 35);

  const cappedOff = computeEffectivePreset({ ...preset, adaptiveRelayCap: false }, "relay(2)");
  assert.equal(cappedOff.fps, 120);
  assert.equal(cappedOff.bitrateMbps, 35);

  const p2p = computeEffectivePreset(preset, "p2p");
  assert.equal(p2p.fps, 120);
  assert.equal(p2p.bitrateMbps, 35);
});

test("computeEffectivePreset: does not raise low fps/bitrate", () => {
  const preset = normalizeStreamPreset({ fps: 30, bitrateMbps: 8, adaptiveRelayCap: true });
  const effective = computeEffectivePreset(preset, "relay");
  assert.equal(effective.fps, 30);
  assert.equal(effective.bitrateMbps, 8);
});

test("resolveStreamAppTarget: prefers Virtual Display, falls back to Desktop", () => {
  assert.equal(resolveStreamAppTarget("Virtual Display", ["Desktop", "Virtual Display"]), "Virtual Display");
  assert.equal(resolveStreamAppTarget("Virtual Display", ["virtual display"]), "Virtual Display");
  assert.equal(resolveStreamAppTarget("Virtual Display", ["Desktop", "Steam"]), "Desktop");
  assert.equal(resolveStreamAppTarget("Virtual Display", []), "Desktop");
  assert.equal(resolveStreamAppTarget("Desktop", ["Virtual Display"]), "Desktop");
});

test("buildMoonlightStreamArgs: default low-latency windowed P2P session", () => {
  const preset = normalizeStreamPreset();
  const args = buildMoonlightStreamArgs("10.144.0.11", preset, "p2p", "Virtual Display");

  const flagValue = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(flagValue("--display-mode"), "windowed");
  assert.equal(flagValue("--packet-size"), "1200");
  assert.equal(flagValue("--resolution"), "2560x1440");
  assert.equal(flagValue("--fps"), "120");
  assert.equal(flagValue("--bitrate"), "35000");
  assert.equal(flagValue("--video-codec"), "HEVC");
  assert.equal(flagValue("--capture-system-keys"), "fullscreen");

  for (const flag of [
    "--no-vsync",
    "--no-frame-pacing",
    "--no-game-optimization",
    "--no-audio-on-host",
    "--absolute-mouse",
    "--no-performance-overlay",
  ]) {
    assert.ok(args.includes(flag), `expected ${flag} in ${args.join(" ")}`);
  }
  assert.equal(flagValue("--video-decoder"), "hardware");
  assert.ok(!args.includes("--vsync"));
  assert.ok(!args.includes("--frame-pacing"));
  assert.ok(!args.includes("--audio-on-host"));
  assert.ok(!args.includes("--performance-overlay"));

  assert.deepEqual(args.slice(-3), ["stream", "10.144.0.11", "Virtual Display"]);
  // Every flag must precede the `stream` verb.
  assert.equal(args.lastIndexOf("stream"), args.length - 3);
});

test("buildMoonlightStreamArgs: relay session uses packet-size 1024 and capped params", () => {
  const preset = normalizeStreamPreset();
  const args = buildMoonlightStreamArgs("10.144.0.12", preset, "relay(2)", "Desktop");
  const flagValue = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(flagValue("--packet-size"), "1024");
  assert.equal(flagValue("--fps"), "60");
  assert.equal(flagValue("--bitrate"), "15000");
  assert.deepEqual(args.slice(-3), ["stream", "10.144.0.12", "Desktop"]);
});

test("buildMoonlightStreamArgs: buffered mode, host audio and perf overlay", () => {
  const preset = normalizeStreamPreset({
    lowLatency: false,
    muteHostAudio: false,
    showPerfOverlay: true,
    absoluteMouse: false,
    displayMode: "borderless",
    codec: "av1",
    captureSystemKeys: "always",
  });
  const args = buildMoonlightStreamArgs("10.144.0.11", preset, "p2p", "Desktop");
  const flagValue = (flag) => args[args.indexOf(flag) + 1];

  assert.equal(flagValue("--display-mode"), "borderless");
  assert.equal(flagValue("--capture-system-keys"), "always");
  assert.equal(flagValue("--video-codec"), "AV1");
  assert.equal(flagValue("--video-decoder"), "auto");

  for (const flag of ["--vsync", "--frame-pacing", "--audio-on-host", "--performance-overlay", "--no-absolute-mouse"]) {
    assert.ok(args.includes(flag), `expected ${flag} in ${args.join(" ")}`);
  }
  assert.ok(!args.includes("--no-vsync"));
  assert.ok(!args.includes("--no-frame-pacing"));
  assert.ok(!args.includes("--no-game-optimization"));
  assert.ok(!args.includes("--no-audio-on-host"));
  assert.ok(!args.includes("--no-performance-overlay"));
  assert.ok(!args.includes("--absolute-mouse"));
});

test("buildMoonlightStreamArgs: h264 codec maps to H.264", () => {
  const preset = normalizeStreamPreset({ codec: "h264" });
  const args = buildMoonlightStreamArgs("10.144.0.11", preset, "p2p", "Desktop");
  assert.equal(args[args.indexOf("--video-codec") + 1], "H.264");
});
