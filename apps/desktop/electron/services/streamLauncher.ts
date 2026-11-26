import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import type { BootstrapConfig, DeviceInfo, StreamPreset } from "../types";
import { configureRustDeskClient, findRustDeskExe } from "./hostManager";

const execFileAsync = promisify(execFile);

export function probeTcpPort(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const sock = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

export function resolveMoonlightExe(): string | null {
  const candidates = [
    path.join(process.resourcesPath || "", "moonlight", "Moonlight.exe"),
    path.resolve(__dirname, "../../resources/moonlight/Moonlight.exe"),
    path.resolve(process.cwd(), "resources/moonlight/Moonlight.exe"),
    "C:\\Program Files\\Moonlight Game Streaming\\Moonlight.exe",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export async function isMoonlightHostPaired(meshIp: string): Promise<boolean> {
  const exe = resolveMoonlightExe();
  if (!exe) return false;
  try {
    const { stdout, stderr } = await execFileAsync(exe, ["list", meshIp], {
      cwd: path.dirname(exe),
      timeout: 7000,
      windowsHide: true,
    });
    const combined = `${stdout}\n${stderr}`;
    if (/not\s+been\s+paired|not\s+paired|unable\s+to|failed|error/i.test(combined)) {
      return false;
    }
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export function spawnSilentMoonlightPair(
  meshIp: string,
  pin: string,
): { promise: Promise<{ ok: boolean; output: string }>; cancel: () => void } {
  const exe = resolveMoonlightExe();
  if (!exe) {
    return {
      promise: Promise.resolve({ ok: false, output: "未找到内置 Moonlight.exe" }),
      cancel: () => {},
    };
  }
  const child = spawn(exe, ["--pin", pin, "pair", meshIp], {
    cwd: path.dirname(exe),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let settled = false;
  const chunks: string[] = [];
  child.stdout?.on("data", (d: Buffer) => chunks.push(d.toString("utf-8")));
  child.stderr?.on("data", (d: Buffer) => chunks.push(d.toString("utf-8")));

  const promise = new Promise<{ ok: boolean; output: string }>((resolve) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolve({ ok: false, output: `Moonlight 静默配对超时\n${chunks.join("")}` });
    }, 20_000);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, output: err.message });
    });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, output: chunks.join("").trim() });
    });
  });

  return {
    promise,
    cancel: () => {
      if (!settled) {
        settled = true;
        try {
          child.kill();
        } catch {
          // ignore
        }
      }
    },
  };
}

export function launchMoonlightStream(device: DeviceInfo, preset: StreamPreset): void {
  const exe = resolveMoonlightExe();
  if (!exe) {
    throw new Error("未找到内置 Moonlight.exe，请先执行资源打包准备。");
  }
  const codecMap: Record<StreamPreset["codec"], string> = {
    hevc: "HEVC",
    av1: "AV1",
    h264: "H.264",
  };
  const args = [
    "--resolution",
    preset.resolution,
    "--fps",
    String(preset.fps),
    "--bitrate",
    String(preset.bitrateMbps * 1000),
    "--video-codec",
    codecMap[preset.codec] || "HEVC",
    "--absolute-mouse",
    "stream",
    device.mesh_ip,
    "Desktop",
  ];
  const child = spawn(exe, args, {
    cwd: path.dirname(exe),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export function launchMoonlightGui(): void {
  const exe = resolveMoonlightExe();
  if (!exe) {
    throw new Error("未找到内置 Moonlight.exe。");
  }
  const child = spawn(exe, [], {
    cwd: path.dirname(exe),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export function launchRustDeskConnect(device: DeviceInfo, cfg: BootstrapConfig): void {
  configureRustDeskClient(cfg);
  const exe = findRustDeskExe();
  if (!exe) {
    throw new Error("本机尚未安装 RustDesk 客户端，请在【被控模式】页一键下载安装。");
  }
  const args = device.rustdesk_id ? ["--connect", device.rustdesk_id] : [];
  const child = spawn(exe, args, {
    cwd: path.dirname(exe),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export async function wakeDeviceViaGateway(device: DeviceInfo, cfg: BootstrapConfig): Promise<{ status: string; methods?: string[] }> {
  if (!device.mac_address) {
    throw new Error("该设备尚未登记网卡 MAC 地址，无法发送 WOL 魔术包。");
  }
  const resp = await fetch(`${cfg.wol.url}/api/wake-mac`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SilkWarp-Token": cfg.wol.token,
    },
    body: JSON.stringify({
      mac: device.mac_address,
      broadcast: device.broadcast_ip || "255.255.255.255",
    }),
    signal: AbortSignal.timeout(5000),
  });
  const data = (await resp.json().catch(() => ({}))) as { error?: string; status?: string; methods?: string[] };
  if (!resp.ok) {
    throw new Error(data.error || `WOL 请求失败: HTTP ${resp.status}`);
  }
  return { status: data.status || "sent", methods: data.methods };
}
