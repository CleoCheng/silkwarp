import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import type { BootstrapConfig, DeviceInfo, StreamAppTarget, StreamPreset } from "../types";
import {
  type ApolloAppEntry,
  parseApolloAppEntries,
  parseApolloCurrentGameId,
  parseApolloServerInfoPermission,
  parseMoonlightIniCredentials,
} from "./apolloPermissions";
import { configureRustDeskClient, findRustDeskExe } from "./hostManager";
import { optimizeMoonlightIni } from "./moonlightIni";
import { buildMoonlightSpawnEnv, buildMoonlightStreamArgs, type StreamLinkQuality } from "./streamOptions";

export type { ApolloAppEntry };

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

function getMoonlightIniPath(): string | null {
  const exe = resolveMoonlightExe();
  if (!exe) return null;
  return path.join(path.dirname(exe), "Moonlight Game Streaming Project", "Moonlight.ini");
}

/**
 * Ensures portable `Moonlight.ini` disables slow launch warning delays, STUN
 * timeouts, and background mDNS scanning without touching certs or hosts.
 */
export function ensureOptimizedMoonlightIni(): boolean {
  const iniPath = getMoonlightIniPath();
  if (!iniPath) return false;
  try {
    if (!fs.existsSync(iniPath)) return false;
    const raw = fs.readFileSync(iniPath, "utf-8");
    const next = optimizeMoonlightIni(raw);
    if (!next.changed) return false;
    fs.writeFileSync(iniPath, next.content, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the local Moonlight client certificate/key pair from the portable
 * Moonlight.ini. Returns `null` when the exe or the ini is missing.
 */
function readLocalMoonlightCredentials(): ReturnType<typeof parseMoonlightIniCredentials> {
  const iniPath = getMoonlightIniPath();
  if (!iniPath) return null;
  try {
    if (!fs.existsSync(iniPath)) return null;
    return parseMoonlightIniCredentials(fs.readFileSync(iniPath, "utf-8"));
  } catch {
    return null;
  }
}

type MoonlightCreds = NonNullable<ReturnType<typeof parseMoonlightIniCredentials>>;

function apolloHttpsGet(
  meshIp: string,
  httpsPort: number,
  reqPath: string,
  creds: MoonlightCreds,
  timeoutMs: number,
): Promise<{ statusCode: number; body: string } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { statusCode: number; body: string } | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = https.request(
      {
        hostname: meshIp,
        port: httpsPort,
        path: reqPath,
        method: "GET",
        cert: creds.cert,
        key: creds.key,
        rejectUnauthorized: false,
        agent: false,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          finish({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") });
        });
        res.on("error", () => finish(null));
      },
    );
    req.on("error", () => finish(null));
    req.on("timeout", () => {
      req.destroy();
      finish(null);
    });
    req.end();
  });
}

/**
 * Queries the remote Apollo/Sunshine `/serverinfo` endpoint using the local
 * Moonlight client certificate to learn whether this client is paired, whether
 * it has been granted input permissions, and any currently running app ID.
 *
 * Fail-open: any timeout, network error, missing credentials or non-200
 * response returns `null` so that a healthy paired stream is never blocked by
 * a flaky probe.
 */
export async function probeRemoteApolloPermission(
  meshIp: string,
  httpsPort = 47984,
  timeoutMs = 2500,
): Promise<{ paired: boolean; permission: number | null; hasInput: boolean; currentGameId: number } | null> {
  const creds = readLocalMoonlightCredentials();
  if (!creds) return null;

  const res = await apolloHttpsGet(
    meshIp,
    httpsPort,
    `/serverinfo?uniqueid=${encodeURIComponent(creds.uniqueId)}`,
    creds,
    timeoutMs,
  );
  if (!res || res.statusCode !== 200) return null;
  try {
    const parsed = parseApolloServerInfoPermission(res.body);
    return {
      ...parsed,
      currentGameId: parseApolloCurrentGameId(res.body),
    };
  } catch {
    return null;
  }
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
      promise: Promise.resolve({ ok: false, output: "未找到远程连接引擎，请重新安装 SilkWarp。" }),
      cancel: () => {},
    };
  }
  ensureOptimizedMoonlightIni();
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
      resolve({ ok: false, output: `首次安全配对超时\n${chunks.join("")}` });
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

/**
 * Enumerates the app entries (title + numeric ID) advertised by the remote
 * Apollo host. Returns `[]` on any failure so callers never block connection.
 */
export async function fetchAvailableApolloAppEntries(
  meshIp: string,
  httpsPort = 47984,
  timeoutMs = 2000,
): Promise<ApolloAppEntry[]> {
  const creds = readLocalMoonlightCredentials();
  if (!creds) return [];

  const res = await apolloHttpsGet(
    meshIp,
    httpsPort,
    `/applist?uniqueid=${encodeURIComponent(creds.uniqueId)}`,
    creds,
    timeoutMs,
  );
  if (!res || res.statusCode !== 200) return [];
  return parseApolloAppEntries(res.body);
}

/**
 * Enumerates the app titles advertised by the remote Apollo host. Returns `[]`
 * on any failure so callers can fall back to `"Desktop"` without blocking.
 */
export async function fetchAvailableApolloApps(
  meshIp: string,
  httpsPort = 47984,
  timeoutMs = 2000,
): Promise<string[]> {
  const entries = await fetchAvailableApolloAppEntries(meshIp, httpsPort, timeoutMs);
  return entries.map((e) => e.title);
}

/**
 * Sends `/cancel` to clear an existing running Apollo app session cleanly
 * before switching apps (e.g. `Desktop` <-> `Virtual Display`), preventing
 * Moonlight's hidden GUI quit-confirmation prompt from stalling CLI launch.
 */
export async function cancelRemoteApolloApp(
  meshIp: string,
  httpsPort = 47984,
  timeoutMs = 1500,
): Promise<boolean> {
  const creds = readLocalMoonlightCredentials();
  if (!creds) return false;
  const res = await apolloHttpsGet(
    meshIp,
    httpsPort,
    `/cancel?uniqueid=${encodeURIComponent(creds.uniqueId)}`,
    creds,
    timeoutMs,
  );
  return Boolean(res && res.statusCode === 200 && !/<cancel>\s*0\s*<\/cancel>/i.test(res.body));
}

/**
 * Spawns Moonlight for a managed session. Unlike the legacy fire-and-forget
 * launcher this keeps the child attached (no `detached` / `unref`) so the
 * session manager can hot-reload it and reap it on disconnect.
 */
export function spawnMoonlightStreamProcess(
  meshIp: string,
  preset: StreamPreset,
  routeType = "p2p",
  resolvedApp: StreamAppTarget = "Desktop",
  linkQuality?: StreamLinkQuality | null,
): ChildProcess {
  const exe = resolveMoonlightExe();
  if (!exe) {
    throw new Error("未找到远程画面引擎，请重新安装 SilkWarp。");
  }
  ensureOptimizedMoonlightIni();
  const args = buildMoonlightStreamArgs(meshIp, preset, routeType, resolvedApp, linkQuality);
  return spawn(exe, args, {
    cwd: path.dirname(exe),
    env: buildMoonlightSpawnEnv(),
    detached: false,
    windowsHide: false,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

export function launchMoonlightStream(
  device: DeviceInfo,
  preset: StreamPreset,
  routeType = "p2p",
  resolvedApp: StreamAppTarget = "Desktop",
  linkQuality?: StreamLinkQuality | null,
): void {
  const exe = resolveMoonlightExe();
  if (!exe) {
    throw new Error("未找到远程画面引擎，请重新安装 SilkWarp。");
  }
  ensureOptimizedMoonlightIni();
  const args = buildMoonlightStreamArgs(device.mesh_ip, preset, routeType, resolvedApp, linkQuality);
  const child = spawn(exe, args, {
    cwd: path.dirname(exe),
    env: buildMoonlightSpawnEnv(),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export function launchMoonlightGui(): void {
  const exe = resolveMoonlightExe();
  if (!exe) {
    throw new Error("未找到远程画面引擎。");
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
    throw new Error("本机尚未安装轻办公组件，请在【本机受控 -> 高级与运维设置】中一键安装。");
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
