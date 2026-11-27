"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_STREAM_PRESET,
  buildMoonlightSpawnEnv,
  buildMoonlightStreamArgs,
  computeEffectivePreset,
  isDegradedLink,
  isLocalLanLink,
  isTcpOnlyTunnel,
  normalizeStreamPreset,
  normalizeWindowResolution,
  parseLossPercent,
  pickHostNativeDisplay,
  resolvePacketSize,
  resolveStreamAppTarget,
  resolveTargetResolution,
} = require("../dist-electron/services/streamOptions.js");

test("normalizeStreamPreset: undefined returns the full default preset", () => {
  assert.deepEqual(normalizeStreamPreset(undefined), DEFAULT_STREAM_PRESET);
  assert.deepEqual(normalizeStreamPreset(null), DEFAULT_STREAM_PRESET);
  assert.equal(DEFAULT_STREAM_PRESET.displayMode, "windowed");
  assert.equal(DEFAULT_STREAM_PRESET.resolutionMode, "follow_client");
  assert.equal(DEFAULT_STREAM_PRESET.fps, 60);
  assert.equal(DEFAULT_STREAM_PRESET.bitrateMbps, 20);
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
  assert.equal(normalizeStreamPreset({ fps: 75 }).fps, 60);
  assert.equal(normalizeStreamPreset({ bitrateMbps: 2 }).bitrateMbps, 4);
  assert.equal(normalizeStreamPreset({ bitrateMbps: 500 }).bitrateMbps, 100);
  assert.equal(normalizeStreamPreset({ bitrateMbps: Number.NaN }).bitrateMbps, 20);
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

test("computeEffectivePreset: never downgrades resolution; trims >60fps and shields WAN relay bitrate cleanly", () => {
  const preset = normalizeStreamPreset({ resolution: "2560x1440", fps: 120, bitrateMbps: 35, adaptiveRelayCap: true });
  const relayed = computeEffectivePreset(preset, "relay(2)");
  assert.equal(relayed.resolution, "2560x1440");
  assert.equal(relayed.fps, 60);
  assert.equal(relayed.bitrateMbps, 12);
  // The persisted preset must not be mutated.
  assert.equal(preset.resolution, "2560x1440");
  assert.equal(preset.fps, 120);
  assert.equal(preset.bitrateMbps, 35);

  const relayed1080 = computeEffectivePreset({ ...preset, resolution: "1920x1080" }, "relay");
  assert.equal(relayed1080.resolution, "1920x1080");
  assert.equal(relayed1080.bitrateMbps, 10);

  const relayed4k = computeEffectivePreset({ ...preset, resolution: "3840x2160", bitrateMbps: 60 }, "relay");
  assert.equal(relayed4k.resolution, "3840x2160");
  assert.equal(relayed4k.bitrateMbps, 18);

  const cappedOff = computeEffectivePreset({ ...preset, adaptiveRelayCap: false }, "relay(2)");
  assert.equal(cappedOff.resolution, "2560x1440");
  assert.equal(cappedOff.fps, 120);
  assert.equal(cappedOff.bitrateMbps, 35);

  const p2p = computeEffectivePreset(preset, "p2p");
  assert.equal(p2p.resolution, "2560x1440");
  assert.equal(p2p.fps, 120);
  assert.equal(p2p.bitrateMbps, 35);
});

test("computeEffectivePreset: does not raise low fps/bitrate", () => {
  const preset = normalizeStreamPreset({ resolution: "1920x1080", fps: 30, bitrateMbps: 6, adaptiveRelayCap: true });
  const effective = computeEffectivePreset(preset, "relay");
  assert.equal(effective.resolution, "1920x1080");
  assert.equal(effective.fps, 30);
  assert.equal(effective.bitrateMbps, 6);
});

test("resolveStreamAppTarget: prefers Virtual Display, falls back to Desktop", () => {
  assert.equal(resolveStreamAppTarget("Virtual Display", ["Desktop", "Virtual Display"]), "Virtual Display");
  assert.equal(resolveStreamAppTarget("Virtual Display", ["virtual display"]), "Virtual Display");
  assert.equal(resolveStreamAppTarget("Virtual Display", ["Desktop", "Steam"]), "Desktop");
  assert.equal(resolveStreamAppTarget("Virtual Display", []), "Desktop");
  assert.equal(resolveStreamAppTarget("Desktop", ["Virtual Display"]), "Desktop");
});

test("buildMoonlightStreamArgs: low-latency P2P LAN skips frame-pacing while WAN P2P keeps frame-pacing and auto decoder", () => {
  const preset = normalizeStreamPreset();
  const lanArgs = buildMoonlightStreamArgs("10.144.0.11", preset, "p2p", "Virtual Display", {
    tunnel: "udp",
    latencyMs: 3,
    lossPercent: 0,
  });

  const lanVal = (flag) => lanArgs[lanArgs.indexOf(flag) + 1];
  assert.equal(lanVal("--display-mode"), "windowed");
  assert.equal(lanVal("--packet-size"), "1200");
  assert.equal(lanVal("--resolution"), "2560x1440");
  assert.equal(lanVal("--fps"), "60");
  assert.equal(lanVal("--bitrate"), "20000");
  assert.equal(lanVal("--video-codec"), "HEVC");
  assert.equal(lanVal("--audio-config"), "stereo");
  assert.equal(lanVal("--capture-system-keys"), "fullscreen");
  assert.equal(lanVal("--video-decoder"), "auto");

  for (const flag of [
    "--no-hdr",
    "--keep-awake",
    "--no-vsync",
    "--no-frame-pacing",
    "--no-game-optimization",
    "--no-audio-on-host",
    "--absolute-mouse",
    "--no-performance-overlay",
  ]) {
    assert.ok(lanArgs.includes(flag), `expected ${flag} in ${lanArgs.join(" ")}`);
  }
  assert.ok(!lanArgs.includes("--vsync"));
  assert.ok(!lanArgs.includes("--frame-pacing"));
  assert.ok(!lanArgs.includes("--audio-on-host"));
  assert.ok(!lanArgs.includes("--performance-overlay"));

  assert.deepEqual(lanArgs.slice(-3), ["stream", "10.144.0.11", "Virtual Display"]);
  assert.equal(lanArgs.lastIndexOf("stream"), lanArgs.length - 3);

  const wanArgs = buildMoonlightStreamArgs("10.144.0.11", preset, "p2p", "Virtual Display", {
    tunnel: "udp",
    latencyMs: 28,
    lossPercent: 0,
  });
  assert.ok(wanArgs.includes("--frame-pacing"));
  assert.ok(!wanArgs.includes("--no-frame-pacing"));
  assert.equal(wanArgs[wanArgs.indexOf("--packet-size") + 1], "1024");
  assert.equal(wanArgs[wanArgs.indexOf("--video-decoder") + 1], "auto");
});

test("buildMoonlightStreamArgs: relay preserves native 2K resolution with 12Mbps WAN stability ceiling, 1024-byte packets and frame-pacing", () => {
  const preset = normalizeStreamPreset();
  const args = buildMoonlightStreamArgs("10.144.0.12", preset, "relay(2)", "Desktop");
  const flagValue = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(flagValue("--resolution"), "2560x1440");
  assert.equal(flagValue("--packet-size"), "1024");
  assert.equal(flagValue("--fps"), "60");
  assert.equal(flagValue("--bitrate"), "12000");
  assert.ok(args.includes("--frame-pacing"));
  assert.equal(flagValue("--video-decoder"), "auto");
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

test("normalizeStreamPreset: resolutionMode validates and preserves allowed modes", () => {
  for (const mode of ["follow_client", "follow_host", "fit_window", "fixed"]) {
    assert.equal(normalizeStreamPreset({ resolutionMode: mode }).resolutionMode, mode);
  }
  assert.equal(normalizeStreamPreset({ resolutionMode: "bogus" }).resolutionMode, "follow_client");
});

test("pickHostNativeDisplay and resolveTargetResolution cover all 4 resolution modes", () => {
  const displays = [
    {
      index: 0,
      id: "\\\\.\\DISPLAY1",
      deviceName: "\\\\.\\DISPLAY1",
      friendlyName: "Primary 4K",
      width: 3840,
      height: 2160,
      x: 0,
      y: 0,
      isPrimary: true,
      isVirtual: false,
      active: true,
    },
    {
      index: 1,
      id: "\\\\.\\DISPLAY2",
      deviceName: "\\\\.\\DISPLAY2",
      friendlyName: "Apollo Virtual Display",
      width: 2560,
      height: 1440,
      x: 3840,
      y: 0,
      isPrimary: false,
      isVirtual: true,
      active: true,
    },
  ];

  assert.equal(pickHostNativeDisplay(displays).id, "\\\\.\\DISPLAY1");

  const fc = resolveTargetResolution("follow_client", "1920x1080", {
    clientSize: { width: 2561, height: 1601 },
    availableApps: ["Desktop", "Virtual Display"],
  });
  assert.deepEqual(fc, { resolution: "2560x1600", streamApp: "Virtual Display" });

  const fcMatch = resolveTargetResolution("follow_client", "1920x1080", {
    clientSize: { width: 2560, height: 1440 },
    hostDisplays: [displays[1]],
    availableApps: ["Desktop", "Virtual Display"],
  });
  assert.deepEqual(fcMatch, { resolution: "2560x1440", streamApp: "Desktop" });

  const fh = resolveTargetResolution("follow_host", "1920x1080", {
    hostDisplays: displays,
    selectedDisplayId: "\\\\.\\DISPLAY2",
    availableApps: ["Desktop", "Virtual Display"],
  });
  assert.deepEqual(fh, { resolution: "3840x2160", streamApp: "Desktop" });

  const fw = resolveTargetResolution("fit_window", "1920x1080", {
    windowRect: {
      x: 0,
      y: 0,
      width: 1400,
      height: 900,
      clientWidth: 1367,
      clientHeight: 769,
      visible: true,
      minimized: false,
      foreground: true,
    },
    availableApps: ["Desktop", "Virtual Display"],
  });
  assert.deepEqual(fw, { resolution: "1366x768", streamApp: "Virtual Display" });

  const fx = resolveTargetResolution("fixed", "2560x1440", {
    clientSize: { width: 1280, height: 720 },
    hostDisplays: displays,
    currentStreamApp: "Desktop",
  });
  assert.deepEqual(fx, { resolution: "2560x1440", streamApp: "Desktop" });
});

test("buildMoonlightSpawnEnv injects SDL3/SDL2 IME UI suppression hints", () => {
  const env = buildMoonlightSpawnEnv({ PATH: "C:\\Windows" });
  assert.equal(env.PATH, "C:\\Windows");
  assert.equal(env.SDL_IME_SHOW_UI, "0");
  assert.equal(env.SDL_IME_IMPLEMENTED_UI, "composition,candidates");
});

test("parseLossPercent & isTcpOnlyTunnel & isLocalLanLink & isDegradedLink classify link health accurately", () => {
  assert.equal(parseLossPercent("0.0%"), 0);
  assert.equal(parseLossPercent("2.5%"), 2.5);
  assert.equal(parseLossPercent("-"), null);
  assert.equal(parseLossPercent(undefined), null);

  assert.equal(isTcpOnlyTunnel("tcp"), true);
  assert.equal(isTcpOnlyTunnel("tcp,udp"), false);
  assert.equal(isTcpOnlyTunnel("udp"), false);
  assert.equal(isTcpOnlyTunnel("-"), false);

  assert.equal(isLocalLanLink("local"), true);
  assert.equal(isLocalLanLink("p2p", { tunnel: "udp", latencyMs: 3, lossPercent: 0 }), true);
  assert.equal(isLocalLanLink("p2p", { tunnel: "udp", latencyMs: 18, lossPercent: 0 }), false);
  assert.equal(isLocalLanLink("p2p", { tunnel: "tcp", latencyMs: 2, lossPercent: 0 }), false);
  assert.equal(isLocalLanLink("relay(2)", { tunnel: "udp", latencyMs: 5, lossPercent: 0 }), false);

  assert.equal(isDegradedLink("p2p", { tunnel: "udp", latencyMs: 5, lossPercent: 0 }), false);
  assert.equal(isDegradedLink("p2p", { tunnel: "tcp", latencyMs: 2, lossPercent: 0 }), true);
  assert.equal(isDegradedLink("p2p", { tunnel: "udp", latencyMs: 75, lossPercent: 0 }), true);
  assert.equal(isDegradedLink("p2p", { tunnel: "udp", latencyMs: 5, lossPercent: 1.5 }), true);
  assert.equal(isDegradedLink("relay(2)", { tunnel: "udp", latencyMs: 25, lossPercent: 0 }), true);
});

test("computeEffectivePreset preserves full resolution while shielding TCP, lossy WAN, and black-screen recovery", () => {
  const highPreset = normalizeStreamPreset({ resolution: "2560x1440", fps: 120, bitrateMbps: 35, adaptiveRelayCap: true });

  const tcpCap = computeEffectivePreset(highPreset, "p2p", { tunnel: "tcp", latencyMs: 2, lossPercent: 0 });
  assert.equal(tcpCap.resolution, "2560x1440");
  assert.equal(tcpCap.fps, 60);
  assert.equal(tcpCap.bitrateMbps, 12);

  const highLatCap = computeEffectivePreset(highPreset, "p2p", { tunnel: "udp", latencyMs: 65, lossPercent: 0 });
  assert.equal(highLatCap.resolution, "2560x1440");
  assert.equal(highLatCap.fps, 120);
  assert.equal(highLatCap.bitrateMbps, 35);

  const extremeCap = computeEffectivePreset(highPreset, "relay(2)", { tunnel: "udp", latencyMs: 160, lossPercent: 5 });
  assert.equal(extremeCap.resolution, "2560x1440");
  assert.equal(extremeCap.fps, 60);
  assert.equal(extremeCap.bitrateMbps, 9);

  const recoveryCap = computeEffectivePreset(highPreset, "p2p", {
    tunnel: "udp",
    latencyMs: 25,
    lossPercent: 0,
    recoveryBitrateCapMbps: 8,
  });
  assert.equal(recoveryCap.resolution, "2560x1440");
  assert.equal(recoveryCap.bitrateMbps, 8);

  const hzCap = computeEffectivePreset(highPreset, "p2p", {
    tunnel: "udp",
    latencyMs: 2,
    lossPercent: 0,
    clientRefreshHz: 59,
  });
  assert.equal(hzCap.resolution, "2560x1440");
  assert.equal(hzCap.fps, 60);
  assert.equal(hzCap.bitrateMbps, 35);

  const tcpArgs = buildMoonlightStreamArgs("10.144.0.11", highPreset, "p2p", "Desktop", {
    tunnel: "tcp",
    latencyMs: 115,
    lossPercent: 0,
  });
  const flagValue = (flag) => tcpArgs[tcpArgs.indexOf(flag) + 1];
  assert.equal(flagValue("--resolution"), "2560x1440");
  assert.equal(flagValue("--packet-size"), "1024");
  assert.equal(flagValue("--bitrate"), "12000");
  assert.equal(flagValue("--fps"), "60");
  assert.equal(flagValue("--video-decoder"), "auto");
  assert.ok(tcpArgs.includes("--frame-pacing"));
  assert.ok(!tcpArgs.includes("--no-frame-pacing"));
  assert.ok(tcpArgs.includes("--no-hdr"));
  assert.ok(tcpArgs.includes("--keep-awake"));
  assert.equal(flagValue("--audio-config"), "stereo");
});
