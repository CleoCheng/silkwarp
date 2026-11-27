"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildListDisplaysScript,
  buildSystemActionScript,
  getHostMasterMute,
  isVirtualMonitorDescriptor,
  listHostDisplays,
  parseMonitorLines,
} = require("../dist-electron/services/hostSystemControl.js");

const START = "<<<SILKWARP_MONITORS>>>";
const END = "<<<SILKWARP_END>>>";

function monitorLine(record) {
  return JSON.stringify(record);
}

// ---------------------------------------------------------------------------
// 1. Monitor dump parsing
// ---------------------------------------------------------------------------

test("parseMonitorLines: parses a realistic multi-monitor dump in order", () => {
  const raw = [
    "Add-Type: compiling SilkWarpDisplays...",
    START,
    monitorLine({
      index: 0,
      id: "\\\\.\\DISPLAY1",
      deviceName: "\\\\.\\DISPLAY1",
      friendlyName: "DELL U2720Q",
      deviceId: "MONITOR\\DEL41A5\\{4d36e96e}",
      driver: "NVIDIA GeForce RTX 4070 Ti",
      width: 3840,
      height: 2160,
      x: 0,
      y: 0,
      isPrimary: true,
      isVirtual: false,
      active: true,
    }),
    monitorLine({
      index: 1,
      id: "\\\\.\\DISPLAY2",
      deviceName: "\\\\.\\DISPLAY2",
      friendlyName: "Apollo Virtual Display",
      deviceId: "MONITOR\\SUDOMAKER\\{4d36e96e}",
      driver: "Apollo Indirect Display Driver",
      width: 2560,
      height: 1440,
      x: 3840,
      y: 0,
      isPrimary: false,
      isVirtual: true,
      active: true,
    }),
    monitorLine({
      index: 2,
      id: "\\\\.\\DISPLAY3",
      deviceName: "\\\\.\\DISPLAY3",
      friendlyName: "USB Mobile Monitor",
      deviceId: "MONITOR\\USBMON\\{4d36e96e}",
      driver: "USB Display",
      width: 1920,
      height: 1080,
      x: -1920,
      y: 0,
      isPrimary: false,
      isVirtual: true,
      active: true,
    }),
    END,
    "extra trailing output that must be ignored",
  ].join("\n");

  const displays = parseMonitorLines(raw);
  assert.equal(displays.length, 3);

  assert.deepEqual(
    displays.map((d) => d.index),
    [0, 1, 2],
  );
  assert.equal(displays[0].friendlyName, "DELL U2720Q");
  assert.equal(displays[0].width, 3840);
  assert.equal(displays[0].height, 2160);
  assert.equal(displays[0].isPrimary, true);
  assert.equal(displays[0].isVirtual, false);
  assert.equal(displays[0].active, true);

  assert.equal(displays[1].isVirtual, true, "Apollo/SudoMaker must be detected as virtual");
  assert.equal(displays[1].x, 3840);

  assert.equal(displays[2].x, -1920, "negative coordinates must be preserved for left-side monitors");
  assert.equal(displays[2].isVirtual, true);
});

test("parseMonitorLines: clamps invalid dimensions and skips malformed records", () => {
  const raw = [
    START,
    monitorLine({ index: 0, deviceName: "\\\\.\\DISPLAY1", friendlyName: "Bad", width: -100, height: "oops", x: "12", y: null }),
    "{not valid json at all",
    "",
    monitorLine({ index: 1, deviceName: "\\\\.\\DISPLAY2", friendlyName: "Good", width: 1920.6, height: "1080", x: 0, y: 0, isPrimary: true }),
    END,
  ].join("\r\n");

  const displays = parseMonitorLines(raw);
  assert.equal(displays.length, 2);
  assert.equal(displays[0].width, 0, "negative width must clamp to 0");
  assert.equal(displays[0].height, 0, "non-numeric height must clamp to 0");
  assert.equal(displays[0].x, 12, "numeric string coordinates must parse");
  assert.equal(displays[0].y, 0, "null coordinates must fall back to 0");
  assert.equal(displays[1].width, 1921, "fractional widths must round");
  assert.equal(displays[1].height, 1080);
  assert.equal(displays[1].isPrimary, true);
});

test("parseMonitorLines: empty / marker-less / unterminated input is safe", () => {
  assert.deepEqual(parseMonitorLines(""), []);
  assert.deepEqual(parseMonitorLines("no markers here"), []);
  assert.deepEqual(parseMonitorLines(`${START}\n${END}`), []);

  const unterminated = [START, monitorLine({ index: 0, deviceName: "\\\\.\\DISPLAY1", friendlyName: "Only", width: 800, height: 600 })].join("\n");
  const displays = parseMonitorLines(unterminated);
  assert.equal(displays.length, 1, "missing end marker must still parse complete records");
  assert.equal(displays[0].width, 800);
});

test("parseMonitorLines: tab-delimited legacy records are accepted", () => {
  const raw = [
    START,
    "0\t\\\\.\\DISPLAY1\tDell P2419H\tMONITOR\\DEL4098\tIntel UHD\t1920\t1080\t0\t0\ttrue\tfalse\ttrue",
    END,
  ].join("\n");

  const displays = parseMonitorLines(raw);
  assert.equal(displays.length, 1);
  assert.equal(displays[0].friendlyName, "Dell P2419H");
  assert.equal(displays[0].width, 1920);
  assert.equal(displays[0].height, 1080);
  assert.equal(displays[0].isPrimary, true);
  assert.equal(displays[0].isVirtual, false);
});

// ---------------------------------------------------------------------------
// 2. Virtual monitor detection
// ---------------------------------------------------------------------------

test("isVirtualMonitorDescriptor: recognizes known virtual display descriptors", () => {
  assert.equal(isVirtualMonitorDescriptor("DELL U2720Q", "MONITOR\\DEL41A5\\{4d36e96e}", "NVIDIA GeForce RTX 4070 Ti"), false);
  assert.equal(isVirtualMonitorDescriptor("Virtual Display", "", ""), true);
  assert.equal(isVirtualMonitorDescriptor("", "MONITOR\\SUDOMAKER\\{4d36e96e}", ""), true);
  assert.equal(isVirtualMonitorDescriptor("Apollo Virtual Display", "", ""), true);
  assert.equal(isVirtualMonitorDescriptor("Indirect Display Device", "", ""), true);
  assert.equal(isVirtualMonitorDescriptor("USB Mobile Monitor", "", ""), true);
  assert.equal(isVirtualMonitorDescriptor("IddSampleDriver Device", "", ""), true);
  assert.equal(isVirtualMonitorDescriptor("Generic PnP Monitor", "", "Apollo Indirect Display Driver"), true);
  assert.equal(isVirtualMonitorDescriptor("VIRTUAL", "", ""), true, "matching must be case-insensitive");
});

test("isVirtualMonitorDescriptor: tolerates missing arguments", () => {
  assert.equal(isVirtualMonitorDescriptor("", ""), false);
  assert.equal(isVirtualMonitorDescriptor("", "", undefined), false);
  assert.equal(isVirtualMonitorDescriptor("Studio Display", "MONITOR\\APP\\{4d36e96e}", "Apple"), false);
});

// ---------------------------------------------------------------------------
// 3. System action scripts
// ---------------------------------------------------------------------------

test("buildSystemActionScript: lock uses LockWorkStation via P/Invoke", () => {
  const spec = buildSystemActionScript("lock");
  assert.equal(typeof spec.powershell, "string");
  assert.match(spec.powershell, /SilkWarpLock/);
  assert.match(spec.powershell, /LockWorkStation/);
  assert.match(spec.powershell, /user32\.dll/);
  assert.match(spec.powershell, /<<<SILKWARP_ACTION:OK>>>/);
  assert.equal(spec.exe, undefined);
});

test("buildSystemActionScript: show_desktop minimizes all windows through Shell.Application", () => {
  const spec = buildSystemActionScript("show_desktop");
  assert.equal(typeof spec.powershell, "string");
  assert.match(spec.powershell, /Shell\.Application/);
  assert.match(spec.powershell, /MinimizeAll/);
  assert.match(spec.powershell, /<<<SILKWARP_ACTION:OK>>>/);
});

test("buildSystemActionScript: taskmgr launches taskmgr.exe directly", () => {
  const spec = buildSystemActionScript("taskmgr");
  assert.equal(spec.exe, "taskmgr.exe");
  assert.deepEqual(spec.args, []);
  assert.equal(spec.powershell, undefined);
});

test("buildSystemActionScript: sas guards SoftwareSASGeneration and reports OK/DENIED markers", () => {
  const spec = buildSystemActionScript("sas");
  assert.equal(typeof spec.powershell, "string");
  assert.match(spec.powershell, /SoftwareSASGeneration/);
  assert.match(spec.powershell, /sas\.dll/);
  assert.match(spec.powershell, /SendSAS/);
  assert.match(spec.powershell, /<<<SILKWARP_SAS:OK>>>/);
  assert.match(spec.powershell, /<<<SILKWARP_SAS:DENIED>>>/);
  // Must not throw out of PowerShell: the whole call is wrapped in try/catch.
  assert.match(spec.powershell, /catch\s*\{/);
});

test("buildSystemActionScript: reboot and shutdown call shutdown.exe with a 2s delay", () => {
  const reboot = buildSystemActionScript("reboot");
  assert.equal(reboot.exe, "shutdown.exe");
  assert.deepEqual(reboot.args, ["/r", "/t", "2", "/c", "SilkWarp 远程重启"]);

  const shutdown = buildSystemActionScript("shutdown");
  assert.equal(shutdown.exe, "shutdown.exe");
  assert.deepEqual(shutdown.args, ["/s", "/t", "2", "/c", "SilkWarp 远程关机"]);
});

test("buildSystemActionScript: repair_ime restarts TextInputHost and ctfmon safely", () => {
  const spec = buildSystemActionScript("repair_ime");
  assert.equal(typeof spec.powershell, "string");
  assert.match(spec.powershell, /TextInputHost/);
  assert.match(spec.powershell, /ctfmon\.exe/);
  assert.match(spec.powershell, /<<<SILKWARP_ACTION:OK>>>/);
});

test("buildListDisplaysScript: queries physical pixel dimensions via EnumDisplaySettingsW DEVMODEW", () => {
  const script = buildListDisplaysScript();
  assert.match(script, /EnumDisplaySettingsW/);
  assert.match(script, /DEVMODEW/);
  assert.match(script, /dmPelsWidth/);
  assert.match(script, /dmPelsHeight/);
});

// ---------------------------------------------------------------------------
// 4. Windows-only read-only live checks (never mutates host state)
// ---------------------------------------------------------------------------

const isWindows = process.platform === "win32";

test("listHostDisplays: enumerates at least one real display on Windows", { skip: !isWindows }, async () => {
  const displays = await listHostDisplays();
  assert.ok(Array.isArray(displays));
  assert.ok(displays.length >= 1, "expected at least one monitor on a Windows host");

  const usable = displays.filter((d) => d.width > 0 && d.height > 0);
  assert.ok(usable.length >= 1, "expected at least one display with positive dimensions");

  for (const display of displays) {
    assert.equal(typeof display.index, "number");
    assert.equal(typeof display.id, "string");
    assert.ok(display.width >= 0 && display.height >= 0);
    if (display.refreshHz !== undefined) {
      assert.ok(Number.isInteger(display.refreshHz) && display.refreshHz > 0 && display.refreshHz <= 1000);
    }
    assert.equal(typeof display.isPrimary, "boolean");
    assert.equal(typeof display.isVirtual, "boolean");
    assert.equal(typeof display.active, "boolean");
  }
  assert.equal(
    displays.some((d) => d.isPrimary),
    true,
    "one display must be flagged primary",
  );
});

test("getHostMasterMute: returns a boolean without mutating audio state", { skip: !isWindows }, async () => {
  const muted = await getHostMasterMute();
  assert.equal(typeof muted, "boolean");
});
