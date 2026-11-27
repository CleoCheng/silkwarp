import type { DeviceInfo, PeerStatus } from "../types";

export const REQUIRED_FIREWALL_RULES = [
  "SilkWarp-Apollo-TCP",
  "SilkWarp-Agent-TCP",
] as const;

export const PAIR_POLL_BURST_MS = 2_500;
export const PAIR_POLL_VISIBLE_MS = 4_000;
export const PAIR_POLL_IDLE_MS = 8_000;
export const PAIR_POLL_BURST_WINDOW_MS = 60_000;

export const BOOT_TUNNEL_TASK_NAME = "SilkWarpEasyTierBoot";
export const BOOT_TUNNEL_PROGRAM_DATA_DIR = "C:\\ProgramData\\SilkWarp";
export const BOOT_TUNNEL_BIN_DIR = "C:\\ProgramData\\SilkWarp\\easytier";
export const BOOT_TUNNEL_CONFIG_PATH = "C:\\ProgramData\\SilkWarp\\easytier.toml";

export interface FirewallRegQueryResult {
  parsed: boolean;
  configured: boolean;
  foundRules: string[];
}

/**
 * Parses `reg query HKLM\...\FirewallRules /f SilkWarp- /d` output without
 * spawning `netsh` (which triggers noisy Event ID 1 configuration change logs).
 */
export function parseFirewallRulesFromRegQuery(
  stdout: string,
  requiredRules: readonly string[] = REQUIRED_FIREWALL_RULES,
): FirewallRegQueryResult {
  const text = String(stdout || "");
  const looksValid = /FirewallRules|End of search:|搜索结束|找不到/i.test(text);
  if (!looksValid) {
    return { parsed: false, configured: false, foundRules: [] };
  }

  const requiredSet = new Set(requiredRules);
  const foundSet = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const regIdx = rawLine.indexOf("REG_SZ");
    if (regIdx < 0) continue;

    const payload = rawLine.slice(regIdx + "REG_SZ".length).trim();
    if (!payload) continue;

    let allowAction = false;
    let activeTrue = false;
    let ruleName = "";

    for (const seg of payload.split("|")) {
      const part = seg.trim();
      if (!part) continue;
      if (/^Action=Allow$/i.test(part)) {
        allowAction = true;
      } else if (/^Active=TRUE$/i.test(part)) {
        activeTrue = true;
      } else if (/^Name=/i.test(part)) {
        ruleName = part.slice(5).trim();
      }
    }

    if (allowAction && activeTrue && ruleName && requiredSet.has(ruleName)) {
      foundSet.add(ruleName);
    }
  }

  const foundRules = Array.from(foundSet);
  const configured = requiredRules.every((rule) => foundSet.has(rule));
  return { parsed: true, configured, foundRules };
}

/**
 * Parses `tasklist /NH /FO CSV /FI "IMAGENAME eq GameViewer*"` stdout to detect
 * active UU Remote background/viewer processes without spawning PowerShell.
 */
export function parseUuRemoteFromTasklist(stdout: string): boolean {
  const text = String(stdout || "");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(?:INFO|信息):/i.test(line)) continue;
    if (/(?:^|[",\s])GameViewer(?:Server|Service)?\.exe(?:["\s,]|$)/i.test(line)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns formatted JSON only when the serialized payload actually changed,
 * letting StateStore skip redundant synchronous disk writes on 15s heartbeats.
 */
export function serializeStateIfChanged(prevSerialized: string, nextState: unknown): string | null {
  const serialized = JSON.stringify(nextState, null, 2);
  return serialized === prevSerialized ? null : serialized;
}

/**
 * Computes adaptive pairing poll interval: fast burst right after pair
 * activity, moderate while the desktop window is visible, slow when hidden.
 */
export function computePairPollDelayMs(opts: {
  windowVisible: boolean;
  now: number;
  lastPairActivityAt: number;
}): number {
  if (opts.lastPairActivityAt > 0 && opts.now - opts.lastPairActivityAt < PAIR_POLL_BURST_WINDOW_MS) {
    return PAIR_POLL_BURST_MS;
  }
  return opts.windowVisible ? PAIR_POLL_VISIBLE_MS : PAIR_POLL_IDLE_MS;
}

/**
 * Enriches device online/route telemetry from live EasyTier mesh peers so hosts
 * running a boot-time tunnel (before Windows desktop logon) still appear online.
 */
export function enrichDevicesWithEasyTierPeers(
  devices: DeviceInfo[],
  peers: PeerStatus[],
): DeviceInfo[] {
  const peerByIp = new Map<string, PeerStatus>();
  for (const p of peers) {
    if (!p.ipv4) continue;
    if (p.cost === "p2p" || p.cost.startsWith("relay")) {
      peerByIp.set(p.ipv4, p);
    }
  }
  if (peerByIp.size === 0) return devices;

  return devices.map((device) => {
    const livePeer = peerByIp.get(device.mesh_ip);
    if (!livePeer) return device;
    return {
      ...device,
      online: true,
      route_type: livePeer.cost,
      latency_ms: livePeer.latencyMs ?? device.latency_ms,
    };
  });
}

export function xmlEscape(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Generates Windows Task Scheduler 1.2 XML for running `easytier-core.exe` as
 * LocalSystem (`S-1-5-18`) at OS boot so the mesh tunnel is reachable before login.
 */
export function buildEasyTierBootTaskXml(
  exePath: string,
  configPath: string,
  workingDir: string,
): string {
  const escapedExe = xmlEscape(exePath);
  const escapedWorkingDir = xmlEscape(workingDir);
  const rawArgs = `-c "${configPath}" --rpc-portal 127.0.0.1:15888 --rpc-portal-whitelist 127.0.0.1,127.0.0.0/8,::1/128`;
  const escapedArgs = xmlEscape(rawArgs);

  return [
    `<?xml version="1.0" encoding="UTF-16"?>`,
    `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
    `  <Triggers>`,
    `    <BootTrigger>`,
    `      <Enabled>true</Enabled>`,
    `    </BootTrigger>`,
    `  </Triggers>`,
    `  <Principals>`,
    `    <Principal id="Author">`,
    `      <UserId>S-1-5-18</UserId>`,
    `      <RunLevel>HighestAvailable</RunLevel>`,
    `    </Principal>`,
    `  </Principals>`,
    `  <Settings>`,
    `    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`,
    `    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>`,
    `    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`,
    `    <AllowHardTerminate>true</AllowHardTerminate>`,
    `    <StartWhenAvailable>true</StartWhenAvailable>`,
    `    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>`,
    `    <Enabled>true</Enabled>`,
    `    <Hidden>true</Hidden>`,
    `    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`,
    `    <RestartOnFailure>`,
    `      <Interval>PT1M</Interval>`,
    `      <Count>999</Count>`,
    `    </RestartOnFailure>`,
    `  </Settings>`,
    `  <Actions Context="Author">`,
    `    <Exec>`,
    `      <Command>${escapedExe}</Command>`,
    `      <Arguments>${escapedArgs}</Arguments>`,
    `      <WorkingDirectory>${escapedWorkingDir}</WorkingDirectory>`,
    `    </Exec>`,
    `  </Actions>`,
    `</Task>`,
  ].join("\r\n");
}
