"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "native", "silkwarp-win-helper", "Program.cs");
const OUT_DIR = path.join(ROOT, "resources", "helper");
const OUT_EXE = path.join(OUT_DIR, "silkwarp-win-helper.exe");

function findCscExe() {
  const candidates = [
    path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function main() {
  if (process.platform !== "win32") {
    console.log("[build:helper] Non-Windows platform detected, skipping silkwarp-win-helper.exe build.");
    return;
  }

  if (!fs.existsSync(SRC)) {
    console.error(`[build:helper] Missing C# source: ${SRC}`);
    process.exit(1);
  }

  const force = process.argv.includes("--force");
  if (!force && fs.existsSync(OUT_EXE)) {
    const srcMtime = fs.statSync(SRC).mtimeMs;
    const outMtime = fs.statSync(OUT_EXE).mtimeMs;
    if (outMtime >= srcMtime) {
      console.log(`[build:helper] Up to date: ${OUT_EXE}`);
      return;
    }
  }

  const csc = findCscExe();
  if (!csc) {
    console.error("[build:helper] .NET Framework 4.x csc.exe not found; cannot build silkwarp-win-helper.exe.");
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[build:helper] Compiling ${path.relative(ROOT, SRC)} -> ${path.relative(ROOT, OUT_EXE)}...`);
  execFileSync(csc, ["/nologo", "/optimize+", "/platform:anycpu", "/target:exe", `/out:${OUT_EXE}`, SRC], {
    stdio: "inherit",
    windowsHide: true,
  });
  const sizeKb = (fs.statSync(OUT_EXE).size / 1024).toFixed(1);
  console.log(`[build:helper] Built ${OUT_EXE} (${sizeKb} KB).`);
}

main();
