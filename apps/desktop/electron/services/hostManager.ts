import { app, net } from "electron";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import nodeNet from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { BootstrapConfig, HostHardwareInfo, ProvisionStage } from "../types";
import { APOLLO_PERM_ALL, needsApolloPermissionUpgrade } from "./apolloPermissions";

const execFileAsync = promisify(execFile);

const APOLLO_PATHS = [
  "C:\\Program Files\\Apollo\\apollo.exe",
  "C:\\Program Files\\Apollo\\sunshine.exe",
  "C:\\Program Files (x86)\\Apollo\\apollo.exe",
  "C:\\Program Files (x86)\\Apollo\\sunshine.exe",
  "C:\\Program Files\\Sunshine\\sunshine.exe",
];

interface CachedHardware {
  cpu: string;
  gpu: string;
  uuRemoteDetected: boolean;
  updatedAt: number;
}
let hwCache: CachedHardware | null = null;

const RUSTDESK_EXE_PATHS = [
  "C:\\Program Files\\RustDesk\\rustdesk.exe",
  "C:\\Program Files (x86)\\RustDesk\\rustdesk.exe",
];

const RUSTDESK_CFG_PATHS = [
  path.join(process.env.APPDATA || "", "RustDesk", "config", "RustDesk.toml"),
  path.join("C:\\Windows\\ServiceProfiles\\LocalService\\AppData\\Roaming\\RustDesk\\config\\RustDesk.toml"),
];

export async function checkIsElevated(): Promise<boolean> {
  if (process.platform !== "win32") return true;
  try {
    await execFileAsync("net", ["session"], { timeout: 2500, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function probeApolloHttps(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname: "127.0.0.1", port, path: "/", method: "GET", rejectUnauthorized: false, timeout: 1500 },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 0) > 0);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function probeTcpLocal(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const sock = nodeNet.createConnection({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(1200);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

function ipToUint(ip: string): number {
  return ip.split(".").reduce((acc, oct) => ((acc << 8) | Number(oct)) >>> 0, 0) >>> 0;
}

function uintToIp(num: number): string {
  return [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255].join(".");
}

function detectPrimaryLanNic(): { macAddress: string; broadcastIp: string } {
  const ifaces = os.networkInterfaces();
  let bestScore = -999;
  let best = { macAddress: "", broadcastIp: "255.255.255.255" };

  for (const [name, list] of Object.entries(ifaces)) {
    if (!list) continue;
    for (const addr of list) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      if (addr.address.startsWith("169.254.") || /silkwarp|wintun|easytier/i.test(name)) continue;

      let score = 0;
      if (/wintun|easytier|tailscale|zerotier|vethernet|vmware|virtualbox|hyper-v|loopback/i.test(name)) {
        score -= 50;
      }
      if (/ethernet|以太网|wi-fi|wlan|realtek|intel/i.test(name)) {
        score += 20;
      }
      if (addr.address.startsWith("192.168.") || addr.address.startsWith("10.") || addr.address.startsWith("172.")) {
        score += 10;
      }
      if (addr.mac && addr.mac !== "00:00:00:00:00:00") {
        score += 5;
      }
      if (score > bestScore) {
        bestScore = score;
        const macAddress = addr.mac && addr.mac !== "00:00:00:00:00:00" ? addr.mac.toLowerCase() : "";
        let broadcastIp = "255.255.255.255";
        if (addr.netmask) {
          const bcastNum = (ipToUint(addr.address) | (~ipToUint(addr.netmask) >>> 0)) >>> 0;
          broadcastIp = uintToIp(bcastNum);
        }
        best = { macAddress, broadcastIp };
      }
    }
  }
  return best;
}

async function checkFirewallConfigured(): Promise<boolean> {
  if (process.platform !== "win32") return true;
  const requiredRules = ["SilkWarp-Apollo-TCP", "SilkWarp-Agent-TCP"];
  try {
    for (const rule of requiredRules) {
      await execFileAsync(
        "netsh",
        ["advfirewall", "firewall", "show", "rule", "name=" + rule],
        { timeout: 4000, windowsHide: true },
      );
    }
    return true;
  } catch {
    return false;
  }
}

async function fetchHardwareSummary(): Promise<{ cpu: string; gpu: string; uuRemoteDetected: boolean }> {
  const fallbackCpu = os.cpus()[0]?.model?.trim() || "";
  if (process.platform !== "win32") {
    return { cpu: fallbackCpu, gpu: "", uuRemoteDetected: false };
  }
  if (hwCache && Date.now() - hwCache.updatedAt < 120_000) {
    return { cpu: hwCache.cpu, gpu: hwCache.gpu, uuRemoteDetected: hwCache.uuRemoteDetected };
  }

  const psCmd = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$gpus = (Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join ' / '
$cpuName = (Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name)
$uuProc = [bool](Get-Process -Name 'GameViewer','GameViewerServer','GameViewerService' -ErrorAction SilentlyContinue)
$uu = $uuProc -or ($gpus -match 'GameViewer')
[PSCustomObject]@{ cpu=$cpuName; gpu=$gpus; uu=$uu } | ConvertTo-Json -Compress
`;
  try {
    const { stdout } = await execFileAsync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCmd],
      { timeout: 15000, windowsHide: true },
    );
    const parsed = JSON.parse(stdout.trim()) as { cpu?: string; gpu?: string; uu?: boolean };
    const result = {
      cpu: parsed.cpu?.trim() || fallbackCpu,
      gpu: parsed.gpu?.trim() || "",
      uuRemoteDetected: Boolean(parsed.uu),
    };
    hwCache = { ...result, updatedAt: Date.now() };
    return result;
  } catch {
    return { cpu: fallbackCpu, gpu: hwCache?.gpu || "", uuRemoteDetected: hwCache?.uuRemoteDetected || false };
  }
}

function readRustDeskId(): string {
  for (const cfgPath of RUSTDESK_CFG_PATHS) {
    try {
      if (!fs.existsSync(cfgPath)) continue;
      const text = fs.readFileSync(cfgPath, "utf-8");
      const m = text.match(/^\s*id\s*=\s*['"]?([0-9]+)['"]?/m);
      if (m) return m[1];
    } catch {
      // ignore permission errors on LocalService when unelevated
    }
  }
  return "";
}

export function findRustDeskExe(): string | null {
  for (const p of RUSTDESK_EXE_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function findApolloExe(): string | null {
  for (const p of APOLLO_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export async function collectHostInfo(): Promise<HostHardwareInfo> {
  const [isElevated, hw, firewallConfigured, apollo47990, apollo47989, apollo47984] = await Promise.all([
    checkIsElevated(),
    fetchHardwareSummary(),
    checkFirewallConfigured(),
    probeApolloHttps(47990),
    probeTcpLocal(47989),
    probeTcpLocal(47984),
  ]);
  const { macAddress, broadcastIp } = detectPrimaryLanNic();
  const apolloInstalled = Boolean(findApolloExe());
  const apolloRunning = apollo47990 || apollo47989 || apollo47984;
  const rustdeskInstalled = Boolean(findRustDeskExe());
  const rustdeskId = readRustDeskId();

  return {
    hostname: os.hostname(),
    cpu: hw.cpu,
    gpu: hw.gpu,
    macAddress,
    broadcastIp,
    isElevated,
    apolloInstalled,
    apolloRunning,
    apolloPort: 47984,
    rustdeskInstalled,
    rustdeskId,
    firewallConfigured,
    uuRemoteDetected: hw.uuRemoteDetected,
    provisionStage: "idle",
    provisionMessage: "",
    apolloAuthReady: false,
  };
}

export async function configureWindowsFirewall(meshCidr: string, isElevated = false): Promise<void> {
  const safeCidr = meshCidr.trim();
  if (!/^[0-9./:,a-zA-Z-]+$/.test(safeCidr)) {
    throw new Error(`无效的网段格式: ${meshCidr}`);
  }
  const script = `
foreach ($r in @('SilkWarp-Apollo-TCP','SilkWarp-Apollo-UDP','SilkWarp-Mesh-ICMP','SilkWarp-Agent-TCP')) {
  Get-NetFirewallRule -DisplayName $r -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
}
New-NetFirewallRule -DisplayName 'SilkWarp-Apollo-TCP' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 47984-48010 -RemoteAddress '${safeCidr}' -Profile Any | Out-Null
New-NetFirewallRule -DisplayName 'SilkWarp-Apollo-UDP' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 47984-48010 -RemoteAddress '${safeCidr}' -Profile Any | Out-Null
New-NetFirewallRule -DisplayName 'SilkWarp-Mesh-ICMP' -Direction Inbound -Action Allow -Protocol ICMPv4 -RemoteAddress '${safeCidr}' -Profile Any | Out-Null
New-NetFirewallRule -DisplayName 'SilkWarp-Agent-TCP' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 19580 -RemoteAddress '${safeCidr}' -Profile Any | Out-Null
`;
  if (isElevated) {
    await execFileAsync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 15000, windowsHide: true },
    );
    return;
  }
  await execFileAsync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile -ExecutionPolicy Bypass -Command "${script.replace(/"/g, '\\"')}"'`],
    { timeout: 45000, windowsHide: true },
  );
}

export async function configureAutoStartTask(enable: boolean, isElevated: boolean): Promise<void> {
  if (process.platform !== "win32" || !app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: enable });
    return;
  }
  const taskName = "SilkWarpAutoStart";
  if (isElevated) {
    if (enable) {
      try {
        await execFileAsync(
          "schtasks",
          ["/Create", "/TN", taskName, "/SC", "ONLOGON", "/RL", "HIGHEST", "/TR", `"${process.execPath}"`, "/F"],
          { timeout: 6000, windowsHide: true },
        );
        app.setLoginItemSettings({ openAtLogin: false });
        return;
      } catch {
        // fallback to Electron login item below
      }
    } else {
      try {
        await execFileAsync("schtasks", ["/Delete", "/TN", taskName, "/F"], { timeout: 6000, windowsHide: true });
      } catch {
        // ignore if scheduled task was not registered
      }
      app.setLoginItemSettings({ openAtLogin: false });
      return;
    }
  }
  app.setLoginItemSettings({ openAtLogin: enable });
}

export function configureRustDeskClient(cfg: BootstrapConfig): string[] {
  const content = [
    `rendezvous_server = '${cfg.rustdesk.id_server}:21116'`,
    `nat_type = 1`,
    `serial = 0`,
    ``,
    `[options]`,
    `custom-rendezvous-server = '${cfg.rustdesk.id_server}'`,
    `relay-server = '${cfg.rustdesk.relay_server}'`,
    `api-server = '${cfg.rustdesk.api_server}'`,
    `key = '${cfg.rustdesk.public_key}'`,
    `allow-https-21114 = 'Y'`,
    ``,
  ].join("\n");

  const written: string[] = [];
  const targets = [
    path.join(process.env.APPDATA || "", "RustDesk", "config", "RustDesk2.toml"),
    "C:\\Windows\\ServiceProfiles\\LocalService\\AppData\\Roaming\\RustDesk\\config\\RustDesk2.toml",
  ];
  for (const t of targets) {
    try {
      fs.mkdirSync(path.dirname(t), { recursive: true });
      fs.writeFileSync(t, content, "utf-8");
      written.push(t);
    } catch {
      // LocalService may require admin elevation
    }
  }
  return written;
}

interface ApolloHttpResponse {
  statusCode: number;
  text: string;
  json: Record<string, unknown> | null;
  headers: Record<string, string | string[] | undefined>;
}

const apolloCookieCache = new Map<string, string>();

function clearApolloCookiesForPort(port: number): void {
  const prefix = `${port}|`;
  for (const key of Array.from(apolloCookieCache.keys())) {
    if (key.startsWith(prefix)) apolloCookieCache.delete(key);
  }
}

function extractAuthCookie(setCookie: string | string[] | undefined): string {
  if (!setCookie) return "";
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const raw of list) {
    const m = raw.match(/(?:^|,\s*|\s)auth=([^;\s]+)/i);
    if (m?.[1]) return m[1];
  }
  return "";
}

function apolloRequest(
  port: number,
  method: "GET" | "POST",
  apiPath: string,
  bodyObj?: Record<string, unknown>,
  auth?: { cookie?: string; basic?: { user: string; pass: string } },
): Promise<ApolloHttpResponse> {
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  const headers: Record<string, string | number> = {};
  if (bodyObj) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(body);
  }
  if (auth?.cookie) {
    headers.Cookie = `auth=${auth.cookie}`;
  } else if (auth?.basic?.user && auth?.basic?.pass) {
    headers.Authorization = `Basic ${Buffer.from(`${auth.basic.user}:${auth.basic.pass}`).toString("base64")}`;
  }
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "127.0.0.1",
        port,
        path: apiPath,
        method,
        rejectUnauthorized: false,
        timeout: 4000,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let json: Record<string, unknown> | null = null;
          try {
            json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
          } catch {
            json = null;
          }
          resolve({ statusCode: res.statusCode ?? 0, text, json, headers: res.headers });
        });
      },
    );
    req.on("error", (err) => resolve({ statusCode: 0, text: err.message, json: null, headers: {} }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ statusCode: 0, text: "timeout", json: null, headers: {} });
    });
    if (body) req.write(body);
    req.end();
  });
}

async function loginApolloSession(
  user: string,
  pass: string,
  port = 47990,
): Promise<{ status: "ok" | "uninitialized" | "unauthorized" | "offline" | "basic_only"; cookie?: string }> {
  const loginRes = await apolloRequest(port, "POST", "/api/login", { username: user, password: pass });
  if (loginRes.statusCode === 200) {
    const cookie = extractAuthCookie(loginRes.headers["set-cookie"]);
    if (cookie) {
      apolloCookieCache.set(`${port}|${user}`, cookie);
      return { status: "ok", cookie };
    }
  }
  if (loginRes.statusCode === 404) {
    return { status: "basic_only" };
  }
  if (loginRes.statusCode === 0) {
    return { status: "offline" };
  }
  const probe = await apolloRequest(port, "GET", "/api/config");
  if (probe.statusCode === 307 || probe.statusCode === 302) {
    return { status: "uninitialized" };
  }
  if (probe.statusCode === 0) {
    return { status: "offline" };
  }
  return { status: "unauthorized" };
}

async function apolloAuthedRequest(
  port: number,
  method: "GET" | "POST",
  apiPath: string,
  user: string,
  pass: string,
  bodyObj?: Record<string, unknown>,
): Promise<ApolloHttpResponse> {
  const key = `${port}|${user}`;
  let cachedCookie = apolloCookieCache.get(key);
  let usingBasic = false;

  if (!cachedCookie) {
    const login = await loginApolloSession(user, pass, port);
    if (login.status === "ok" && login.cookie) {
      cachedCookie = login.cookie;
    } else if (login.status === "basic_only") {
      usingBasic = true;
    } else if (login.status === "uninitialized") {
      return { statusCode: 307, text: "uninitialized", json: null, headers: {} };
    } else if (login.status === "offline") {
      return { statusCode: 0, text: "offline", json: null, headers: {} };
    } else {
      return { statusCode: 401, text: "unauthorized", json: null, headers: {} };
    }
  }

  let res = await apolloRequest(
    port,
    method,
    apiPath,
    bodyObj,
    usingBasic ? { basic: { user, pass } } : { cookie: cachedCookie },
  );

  if (res.statusCode === 401 && !usingBasic) {
    apolloCookieCache.delete(key);
    const relogin = await loginApolloSession(user, pass, port);
    if (relogin.status === "ok" && relogin.cookie) {
      res = await apolloRequest(port, method, apiPath, bodyObj, { cookie: relogin.cookie });
    } else if (relogin.status === "uninitialized") {
      return { statusCode: 307, text: "uninitialized", json: null, headers: {} };
    } else if (relogin.status === "offline") {
      return { statusCode: 0, text: "offline", json: null, headers: {} };
    }
  }
  return res;
}

export async function checkApolloAuthStatus(
  user: string,
  pass: string,
  port = 47990,
): Promise<"ok" | "uninitialized" | "unauthorized" | "offline"> {
  const res =
    user && pass
      ? await apolloAuthedRequest(port, "GET", "/api/config", user, pass)
      : await apolloRequest(port, "GET", "/api/config");
  if (res.statusCode === 200) return "ok";
  if (res.statusCode === 307 || res.statusCode === 302) return "uninitialized";
  if (res.statusCode === 401 || res.statusCode === 403) return "unauthorized";
  return "offline";
}

export async function initializeApolloPassword(newUser: string, newPass: string, port = 47990): Promise<boolean> {
  const res = await apolloRequest(port, "POST", "/api/password", {
    currentUsername: "",
    currentPassword: "",
    newUsername: newUser,
    newPassword: newPass,
    confirmNewPassword: newPass,
  });
  const ok = res.statusCode >= 200 && res.statusCode < 300 && Boolean(res.json && res.json.status === true);
  if (ok) clearApolloCookiesForPort(port);
  return ok;
}

export function resolveApolloInstallDir(binPath: string): string {
  let dir = path.dirname(binPath);
  while (["config", "tools"].includes(path.basename(dir).toLowerCase())) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

export async function detectApolloInstallation(): Promise<{ installDir: string | null; exePath: string | null }> {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$paths = @()
Get-CimInstance Win32_Process -Filter "Name='apollo.exe' OR Name='sunshine.exe' OR Name='apollosvc.exe' OR Name='sunshinesvc.exe'" | ForEach-Object {
  if ($_.ExecutablePath) { $paths += $_.ExecutablePath }
}
Get-CimInstance Win32_Service -Filter "Name='ApolloService' OR Name='SunshineService'" | ForEach-Object {
  if ($_.PathName) {
    if ($_.PathName -match '^"([^"]+)"') { $paths += $matches[1] }
    else { $paths += ($_.PathName -split '\\s+')[0] }
  }
}
$paths | Select-Object -Unique | ConvertTo-Json -Compress
`;
    try {
      const { stdout } = await execFileAsync(
        "powershell",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
        { timeout: 6000, windowsHide: true },
      );
      const raw = stdout.trim();
      if (raw) {
        const parsed = JSON.parse(raw) as string | string[];
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const p of list) {
          if (typeof p === "string" && p.trim()) candidates.push(p.trim());
        }
      }
    } catch {
      // fallback to standard install paths
    }
  }
  for (const p of APOLLO_PATHS) candidates.push(p);

  for (const cand of candidates) {
    if (!cand || !fs.existsSync(cand)) continue;
    const dir = resolveApolloInstallDir(cand);
    const exePriority = [
      path.join(dir, "sunshine.exe"),
      path.join(dir, "apollo.exe"),
      cand,
    ];
    const resolvedExe = exePriority.find(
      (p) => fs.existsSync(p) && !/svc\.exe$/i.test(path.basename(p)),
    ) || cand;
    return { installDir: dir, exePath: resolvedExe };
  }
  return { installDir: null, exePath: null };
}

export async function stopApolloCompletely(): Promise<void> {
  if (process.platform !== "win32") return;
  for (const svc of ["ApolloService", "SunshineService"]) {
    try {
      await execFileAsync("net", ["stop", svc], { timeout: 10_000, windowsHide: true });
    } catch {
      // ignore if service not installed or already stopped
    }
  }
  try {
    await execFileAsync(
      "taskkill",
      ["/F", "/IM", "apollo.exe", "/IM", "sunshine.exe", "/IM", "apollosvc.exe", "/IM", "sunshinesvc.exe"],
      { timeout: 5000, windowsHide: true },
    );
  } catch {
    // ignore when no running process matched
  }
  await new Promise((r) => setTimeout(r, 1200));
}

export function collectApolloStateCandidates(installDir: string | null): string[] {
  const rawList = [
    installDir ? path.join(installDir, "config", "sunshine_state.json") : "",
    installDir ? path.join(installDir, "sunshine_state.json") : "",
    "C:\\Program Files\\Apollo\\config\\sunshine_state.json",
    "C:\\Program Files\\Apollo\\sunshine_state.json",
    "C:\\Program Files (x86)\\Apollo\\config\\sunshine_state.json",
    "C:\\Program Files (x86)\\Apollo\\sunshine_state.json",
    "C:\\Program Files\\Sunshine\\config\\sunshine_state.json",
    "C:\\Program Files\\Sunshine\\sunshine_state.json",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Apollo", "sunshine_state.json") : "",
  ];
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const item of rawList) {
    if (!item) continue;
    const norm = path.normalize(item);
    const key = norm.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(norm);
    }
  }
  return deduped;
}

export function stripApolloAuthFromStateFile(statePath: string): "cleaned" | "deleted" | "missing" {
  if (!fs.existsSync(statePath)) return "missing";
  try {
    const raw = fs.readFileSync(statePath, "utf-8");
    fs.writeFileSync(`${statePath}.bak`, raw, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (obj.root && typeof obj.root === "object" && !Array.isArray(obj.root)) {
        const r = obj.root as Record<string, unknown>;
        delete r.username;
        delete r.password;
        delete r.salt;
      }
      delete obj.username;
      delete obj.password;
      delete obj.salt;
      fs.writeFileSync(statePath, JSON.stringify(obj, null, 2), "utf-8");
      return "cleaned";
    }
  } catch {
    // malformed or unparseable JSON; unlink so Apollo resets cleanly
  }
  try {
    fs.unlinkSync(statePath);
    return "deleted";
  } catch {
    return "missing";
  }
}

async function takeoverApolloCredsViaCli(newUser: string, newPass: string): Promise<boolean> {
  const { installDir, exePath } = await detectApolloInstallation();
  if (!exePath || !installDir) return false;
  await stopApolloCompletely();

  const cwds = [path.join(installDir, "config"), installDir].filter((d) => fs.existsSync(d));
  for (const cwd of cwds) {
    try {
      await execFileAsync(exePath, ["--creds", newUser, newPass], {
        cwd,
        timeout: 12_000,
        windowsHide: true,
      });
    } catch {
      // ignore if one cwd fails and try next
    }
  }
  const running = await ensureApolloServiceRunning();
  if (!running) return false;
  return (await checkApolloAuthStatus(newUser, newPass)) === "ok";
}

async function resetApolloStateFilesAndInit(newUser: string, newPass: string): Promise<boolean> {
  const { installDir } = await detectApolloInstallation();
  await stopApolloCompletely();

  const candidates = collectApolloStateCandidates(installDir);
  let touched = false;
  for (const statePath of candidates) {
    const outcome = stripApolloAuthFromStateFile(statePath);
    if (outcome !== "missing") touched = true;
  }
  if (!touched) return false;

  const running = await ensureApolloServiceRunning();
  if (!running) return false;
  for (let i = 0; i < 8; i++) {
    const st = await checkApolloAuthStatus("", "");
    if (st === "uninitialized") {
      const initOk = await initializeApolloPassword(newUser, newPass);
      return initOk && (await checkApolloAuthStatus(newUser, newPass)) === "ok";
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function silentCleanReinstallApollo(newUser: string, newPass: string): Promise<boolean> {
  const { installDir } = await detectApolloInstallation();
  await stopApolloCompletely();

  if (installDir) {
    const uninst = path.join(installDir, "Uninstall.exe");
    if (fs.existsSync(uninst)) {
      try {
        await execFileAsync(uninst, ["/S"], { timeout: 60_000, windowsHide: true });
      } catch {
        // continue cleanup even if uninstaller returned non-zero
      }
      await new Promise((r) => setTimeout(r, 3000));
      await stopApolloCompletely();
    }
  }

  for (const statePath of collectApolloStateCandidates(installDir)) {
    try {
      if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
    } catch {
      // ignore locked/missing cleanup
    }
  }
  if (installDir) {
    for (const rel of ["sunshine.conf", "apollo.conf", path.join("config", "sunshine.conf"), path.join("config", "apollo.conf")]) {
      const p = path.join(installDir, rel);
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        // ignore
      }
    }
  }

  const installer = await resolveOrDownloadApolloInstaller();
  await execFileAsync(installer, ["/S"], { timeout: 120_000, windowsHide: true });
  const running = await ensureApolloServiceRunning();
  if (!running) return false;

  for (let i = 0; i < 10; i++) {
    const st = await checkApolloAuthStatus("", "");
    if (st === "uninitialized") {
      const initOk = await initializeApolloPassword(newUser, newPass);
      return initOk && (await checkApolloAuthStatus(newUser, newPass)) === "ok";
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export async function ensureApolloCredentials(
  currentUser: string,
  currentPass: string,
  isElevated: boolean,
  port = 47990,
  options?: { allowSilentReinstall?: boolean; onStage?: (stage: ProvisionStage, msg: string) => void },
): Promise<{ ok: boolean; user: string; pass: string; message: string }> {
  const status = await checkApolloAuthStatus(currentUser, currentPass, port);
  if (status === "ok") {
    return { ok: true, user: currentUser, pass: currentPass, message: "Apollo 认证就绪" };
  }
  if (status === "offline") {
    return { ok: false, user: currentUser, pass: currentPass, message: "Apollo 服务尚未启动" };
  }

  const nextUser = "silkwarp";
  const nextPass = `Sw${crypto.randomBytes(10).toString("hex")}`;

  if (status === "uninitialized") {
    const initOk = await initializeApolloPassword(nextUser, nextPass, port);
    if (initOk && (await checkApolloAuthStatus(nextUser, nextPass, port)) === "ok") {
      return { ok: true, user: nextUser, pass: nextPass, message: "Apollo 静默初始化成功" };
    }
    return { ok: false, user: currentUser, pass: currentPass, message: "Apollo 凭据自动初始化失败" };
  }

  if (isElevated && port === 47990) {
    options?.onStage?.("initializing_apollo", "检测到旧版凭据冲突，正在自动同步静默握手凭据...");
    if (await takeoverApolloCredsViaCli(nextUser, nextPass)) {
      return { ok: true, user: nextUser, pass: nextPass, message: "已通过 CLI 自动同步 Apollo 本地凭据" };
    }
    if (await resetApolloStateFilesAndInit(nextUser, nextPass)) {
      return { ok: true, user: nextUser, pass: nextPass, message: "已清理旧认证状态并自动完成 Apollo 初始化" };
    }
    if (options?.allowSilentReinstall !== false) {
      options?.onStage?.("reinstalling_apollo", "检测到旧版安装残留，正在后台自动静默清理并重装高清引擎（约 20 秒）...");
      if (await silentCleanReinstallApollo(nextUser, nextPass)) {
        return { ok: true, user: nextUser, pass: nextPass, message: "已静默重装 Apollo 并完成零配置初始化" };
      }
    }
  }
  return {
    ok: false,
    user: currentUser,
    pass: currentPass,
    message: "自动静默修复未成功，请点击“重试自动部署”或在高级设置中检查本机权限与安全软件拦截。",
  };
}

export async function grantAllApolloClientPermissions(
  apolloUser: string,
  apolloPass: string,
  port = 47990,
): Promise<{ total: number; updated: number }> {
  if (!apolloUser || !apolloPass) return { total: 0, updated: 0 };
  const listRes = await apolloAuthedRequest(port, "GET", "/api/clients/list", apolloUser, apolloPass);
  if (listRes.statusCode !== 200 || !listRes.json || !Array.isArray(listRes.json.named_certs)) {
    return { total: 0, updated: 0 };
  }

  const namedCerts = listRes.json.named_certs as Array<Record<string, unknown>>;
  const total = namedCerts.length;
  let updated = 0;

  for (const item of namedCerts) {
    if (!needsApolloPermissionUpgrade(item.perm, item.allow_client_commands)) continue;
    const uuid = String(item.uuid || "");
    if (!uuid) continue;

    const updateRes = await apolloAuthedRequest(
      port,
      "POST",
      "/api/clients/update",
      apolloUser,
      apolloPass,
      {
        uuid,
        name: String(item.name || "SilkWarp-Client"),
        display_mode: String(item.display_mode || ""),
        enable_legacy_ordering: item.enable_legacy_ordering !== false,
        allow_client_commands: true,
        always_use_virtual_display: Boolean(item.always_use_virtual_display),
        do: Array.isArray(item.do) ? item.do : [],
        undo: Array.isArray(item.undo) ? item.undo : [],
        perm: APOLLO_PERM_ALL,
      },
    );
    if (updateRes.statusCode >= 200 && updateRes.statusCode < 300 && updateRes.json?.status === true) {
      updated++;
    }
  }

  return { total, updated };
}

const APOLLO_READONLY_CONFIG_KEYS = [
  "status",
  "status_code",
  "version",
  "platform",
  "has_session",
  "login_pin",
];

/**
 * Reads Apollo/Sunshine's configured capture output name (empty string when
 * unset or unreachable).
 */
export async function getApolloOutputName(
  apolloUser: string,
  apolloPass: string,
  port = 47990,
): Promise<string> {
  const res = await apolloAuthedRequest(port, "GET", "/api/config", apolloUser, apolloPass);
  if (res.statusCode < 200 || res.statusCode >= 300 || !res.json) return "";
  const value = res.json.output_name;
  return typeof value === "string" ? value : String(value ?? "");
}

/**
 * Switches Apollo/Sunshine's capture output to the named display.
 *
 * CRITICAL: `POST /api/config` rewrites the *entire* configuration from the
 * submitted JSON rather than patching a single key. We therefore read the
 * current config, strip read-only status metadata, set `output_name`, and post
 * the full cloned object back.
 */
export async function setApolloOutputName(
  outputName: string,
  apolloUser: string,
  apolloPass: string,
  port = 47990,
): Promise<{ ok: boolean; message?: string }> {
  const target = String(outputName || "").trim();
  if (!target) {
    return { ok: false, message: "显示器名称为空，无法切换 Apollo 输出" };
  }

  const readRes = await apolloAuthedRequest(port, "GET", "/api/config", apolloUser, apolloPass);
  if (readRes.statusCode < 200 || readRes.statusCode >= 300) {
    return {
      ok: false,
      message:
        readRes.statusCode === 0
          ? `连接本机 Apollo (${port}) 失败: ${readRes.text}`
          : `读取 Apollo 配置失败 (HTTP ${readRes.statusCode})`,
    };
  }
  if (!readRes.json || typeof readRes.json !== "object" || Array.isArray(readRes.json)) {
    return { ok: false, message: "Apollo 配置响应格式异常" };
  }

  const cloned: Record<string, unknown> = JSON.parse(JSON.stringify(readRes.json));
  for (const key of APOLLO_READONLY_CONFIG_KEYS) {
    delete cloned[key];
  }
  cloned.output_name = target;

  const writeRes = await apolloAuthedRequest(port, "POST", "/api/config", apolloUser, apolloPass, cloned);
  const ok = writeRes.statusCode >= 200 && writeRes.statusCode < 300;
  if (ok) {
    return { ok: true, message: `已切换 Apollo 输出到「${target}」` };
  }
  return {
    ok: false,
    message:
      writeRes.statusCode === 0
        ? `连接本机 Apollo (${port}) 失败: ${writeRes.text}`
        : `Apollo 拒绝新配置 (HTTP ${writeRes.statusCode}): ${writeRes.text.slice(0, 200)}`,
  };
}

export async function submitApolloPin(
  pin: string,
  apolloUser: string,
  apolloPass: string,
  clientName: string,
  port = 47990,
): Promise<{ ok: boolean; message: string }> {
  if (!apolloUser || !apolloPass) {
    return { ok: false, message: "本机 Apollo 凭据尚未初始化" };
  }
  const res = await apolloAuthedRequest(
    port,
    "POST",
    "/api/pin",
    apolloUser,
    apolloPass,
    { pin, name: clientName || "SilkWarp" },
  );
  if (res.statusCode >= 200 && res.statusCode < 300) {
    if (res.json && res.json.status === true) {
      return { ok: true, message: "Apollo 自动配对成功" };
    }
    return { ok: false, message: "Apollo 尚未收到配对会话 (status=false)" };
  }
  if (res.statusCode === 0) {
    return { ok: false, message: `连接本机 Apollo (${port}) 失败: ${res.text}` };
  }
  return { ok: false, message: `Apollo 返回 ${res.statusCode}: ${res.text}` };
}

async function downloadFileAtomic(url: string, target: string, label: string): Promise<void> {
  if (fs.existsSync(target)) return;
  const tmp = `${target}.tmp`;
  try {
    const resp = await net.fetch(url, { headers: { "User-Agent": "SilkWarp" } });
    if (!resp.ok) throw new Error(`下载 ${label} 失败: HTTP ${resp.status}`);
    const arr = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(tmp, arr);
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}

async function resolveOrDownloadApolloInstaller(): Promise<string> {
  const bundledCandidates = [
    path.join(process.resourcesPath || "", "installers", "Apollo-0.4.6.exe"),
    path.resolve(__dirname, "../../resources/installers/Apollo-0.4.6.exe"),
    path.resolve(process.cwd(), "resources/installers/Apollo-0.4.6.exe"),
  ];
  const bundled = bundledCandidates.find((p) => {
    try {
      return Boolean(p) && fs.existsSync(p) && fs.statSync(p).size > 10_000_000;
    } catch {
      return false;
    }
  });
  if (bundled) return bundled;

  const installerDir = path.join(app.getPath("userData"), "installers");
  fs.mkdirSync(installerDir, { recursive: true });
  const target = path.join(installerDir, "Apollo-0.4.6.exe");
  const url = "https://github.com/ClassicOldSong/Apollo/releases/download/v0.4.6/Apollo-0.4.6.exe";
  await downloadFileAtomic(url, target, "Apollo");
  return target;
}

export async function silentInstallApollo(): Promise<void> {
  if (findApolloExe()) return;
  const installer = await resolveOrDownloadApolloInstaller();
  await execFileAsync(installer, ["/S"], { timeout: 120_000, windowsHide: true });
}

export async function ensureApolloServiceRunning(): Promise<boolean> {
  if ((await probeApolloHttps(47990)) || (await probeTcpLocal(47989))) {
    return true;
  }
  for (const svc of ["ApolloService", "SunshineService"]) {
    try {
      await execFileAsync("sc", ["start", svc], { timeout: 8000, windowsHide: true });
    } catch {
      // ignore and probe port
    }
  }
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if ((await probeApolloHttps(47990)) || (await probeTcpLocal(47989))) {
      return true;
    }
  }
  const exe = findApolloExe();
  if (exe) {
    try {
      const sq = (v: string) => `'${v.replace(/'/g, "''")}'`;
      await execFileAsync(
        "powershell",
        ["-NoProfile", "-Command", `Start-Process -FilePath ${sq(exe)} -WindowStyle Hidden`],
        { timeout: 8000, windowsHide: true },
      );
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if ((await probeApolloHttps(47990)) || (await probeTcpLocal(47989))) {
          return true;
        }
      }
    } catch {
      // ignore fallback error
    }
  }
  return false;
}

export async function downloadAndRunApolloInstaller(): Promise<string> {
  const target = await resolveOrDownloadApolloInstaller();
  await execFileAsync("powershell", ["-NoProfile", "-Command", `Start-Process -FilePath '${target.replace(/'/g, "''")}'`], {
    windowsHide: true,
  });
  return target;
}

export async function downloadAndRunRustDeskInstaller(): Promise<string> {
  const installerDir = path.join(app.getPath("userData"), "installers");
  fs.mkdirSync(installerDir, { recursive: true });
  const target = path.join(installerDir, "rustdesk-latest-x86_64.exe");
  let exeUrl = "https://github.com/rustdesk/rustdesk/releases/download/1.5.3/rustdesk-1.5.3-x86_64.exe";
  try {
    const resp = await net.fetch("https://api.github.com/repos/rustdesk/rustdesk/releases/latest", {
      headers: { "User-Agent": "SilkWarp" },
    });
    if (resp.ok) {
      const d = (await resp.json()) as { assets?: Array<{ name: string; browser_download_url: string }> };
      const found = d.assets?.find((a) => a.name.endsWith("-x86_64.exe"));
      if (found) exeUrl = found.browser_download_url;
    }
  } catch {
    // fallback to known release URL on API rate limit or network error
  }
  await downloadFileAtomic(exeUrl, target, "RustDesk");
  await execFileAsync("powershell", ["-NoProfile", "-Command", `Start-Process -FilePath '${target.replace(/'/g, "''")}'`], {
    windowsHide: true,
  });
  return target;
}
