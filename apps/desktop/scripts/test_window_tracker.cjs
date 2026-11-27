"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { WindowTracker } = require("../dist-electron/services/windowTracker.js");

test("WindowTracker: writing or stopping after helper exit never raises uncaught EPIPE", async () => {
  const uncaught = [];
  const onUncaught = (err) => uncaught.push(err);
  process.on("uncaughtException", onUncaught);

  try {
    let exitCount = 0;
    let resolveExit;
    const exited = new Promise((r) => {
      resolveExit = r;
    });

    const tracker = new WindowTracker(99999999, {
      onRect: () => {},
      onExit: () => {
        exitCount += 1;
        resolveExit?.();
      },
    });

    // Wait up to 8s for PowerShell helper to finish its missing-PID check and close pipes.
    await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
    await new Promise((r) => setTimeout(r, 150));

    // Repeated commands and stop() after pipe closure must never emit uncaught EPIPE.
    tracker.sendHotkey("fullscreen");
    tracker.focusTarget();
    tracker.stop();
    tracker.stop();

    await new Promise((r) => setTimeout(r, 250));
    assert.equal(exitCount >= 0, true);
    assert.equal(uncaught.length, 0, `unexpected uncaught exceptions: ${uncaught.map((e) => e.message).join("; ")}`);
  } finally {
    process.off("uncaughtException", onUncaught);
  }
});

test("WindowTracker: stopping immediately while helper starts closes cleanly without EPIPE", async () => {
  const uncaught = [];
  const onUncaught = (err) => uncaught.push(err);
  process.on("uncaughtException", onUncaught);

  try {
    const tracker = new WindowTracker(process.pid, {
      onRect: () => {},
      onExit: () => {},
    });
    tracker.sendHotkey("perf");
    tracker.stop();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(uncaught.length, 0, `unexpected uncaught exceptions: ${uncaught.map((e) => e.message).join("; ")}`);
  } finally {
    process.off("uncaughtException", onUncaught);
  }
});
