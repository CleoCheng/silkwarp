"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");

const { buildWindowTrackerHelperArgs, resolveWinHelperExe } = require("../dist-electron/services/winHelper.js");
const { WindowTracker } = require("../dist-electron/services/windowTracker.js");
const { getHostMasterMute, listHostDisplays } = require("../dist-electron/services/hostSystemControl.js");

const isWindows = process.platform === "win32";

test("buildWindowTrackerHelperArgs: builds track args with optional b64 title and IME flag", () => {
  const args1 = buildWindowTrackerHelperArgs(4242, { windowTitle: "SilkWarp · Test", suppressLocalIme: true });
  assert.equal(args1[0], "track");
  assert.equal(args1[1], "4242");
  assert.equal(args1[2], "--title-b64");
  assert.equal(Buffer.from(args1[3], "base64").toString("utf8"), "SilkWarp · Test");
  assert.equal(args1.includes("--no-suppress-ime"), false);

  const args2 = buildWindowTrackerHelperArgs(777, { suppressLocalIme: false });
  assert.deepEqual(args2, ["track", "777", "--no-suppress-ime"]);
});

test("resolveWinHelperExe: respects none/off env disable switch", () => {
  const prev = process.env.SILKWARP_WIN_HELPER_PATH;
  try {
    process.env.SILKWARP_WIN_HELPER_PATH = "none";
    assert.equal(resolveWinHelperExe(), null);
    process.env.SILKWARP_WIN_HELPER_PATH = "OFF";
    assert.equal(resolveWinHelperExe(), null);
  } finally {
    if (prev === undefined) delete process.env.SILKWARP_WIN_HELPER_PATH;
    else process.env.SILKWARP_WIN_HELPER_PATH = prev;
  }
});

test("native win helper: compiles cleanly, responds fast, and matches hostSystemControl / WindowTracker contracts", { skip: !isWindows }, async () => {
  const exe = resolveWinHelperExe();
  assert.ok(exe, "expected silkwarp-win-helper.exe to be built under resources/helper/");

  const pingOut = execFileSync(exe, ["ping"], { encoding: "utf8", windowsHide: true, timeout: 3000 });
  assert.match(pingOut, /<<<SILKWARP_HELPER:OK>>>/);

  const t0 = Date.now();
  const displays = await listHostDisplays();
  const elapsedMs = Date.now() - t0;
  assert.ok(displays.length >= 1, "expected >=1 monitor via native helper");
  assert.ok(displays.some((d) => d.isPrimary && d.width > 0 && d.height > 0));
  assert.ok(elapsedMs < 2000, `expected native displays query under 2000ms, got ${elapsedMs}ms`);

  const muted = await getHostMasterMute();
  assert.equal(typeof muted, "boolean");

  // WindowTracker exit detection via native helper must complete well under 1.5s without EPIPE.
  let resolveExit;
  const exited = new Promise((r) => {
    resolveExit = r;
  });
  const tTrackStart = Date.now();
  const tracker = new WindowTracker(99999999, {
    onRect: () => {},
    onExit: () => resolveExit?.(),
  });
  await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  const trackElapsed = Date.now() - tTrackStart;
  tracker.stop();
  assert.ok(trackElapsed < 2000, `expected native helper missing-PID exit < 2000ms, got ${trackElapsed}ms`);
});

test("hostSystemControl: falls back cleanly to PowerShell when helper override is none", { skip: !isWindows }, async () => {
  const prev = process.env.SILKWARP_WIN_HELPER_PATH;
  try {
    process.env.SILKWARP_WIN_HELPER_PATH = "none";
    assert.equal(resolveWinHelperExe(), null);
    const muted = await getHostMasterMute();
    assert.equal(typeof muted, "boolean");
  } finally {
    if (prev === undefined) delete process.env.SILKWARP_WIN_HELPER_PATH;
    else process.env.SILKWARP_WIN_HELPER_PATH = prev;
  }
});
