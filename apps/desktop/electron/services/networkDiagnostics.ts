/**
 * Pure EasyTier + local IPv6 link diagnostics engine.
 *
 * Intentionally avoids `electron` imports and never preserves or emits raw IP
 * addresses or network secrets from `easytier-cli -o json node`.
 */

import os from "node:os";
import type { PeerStatus } from "../types";
import { parseLossPercent } from "./streamOptions";

export type DiagnosticSeverity = "ok" | "warn" | "error";

export interface DiagnosticCheckItem {
  id: string;
  label: string;
  severity: DiagnosticSeverity;
  summary: string;
  detail: string;
  action?: "reconnect_udp" | "relaunch_admin" | "enable_ipv6";
}

export interface PeerDiagnosticItem {
  ipv4: string;
  hostname: string;
  routeType: string;
  tunnel: string;
  nat: string;
  latencyMs: number | null;
  lossPercent: number | null;
  severity: DiagnosticSeverity;
  verdict: string;
}

export interface NetworkDiagnosticsReport {
  checkedAt: number;
  overall: "excellent" | "good" | "degraded";
  easytierRunning: boolean;
  localNatType: string;
  ipv6GlobalReady: boolean;
  ipv6InterfaceCount: number;
  p2pCount: number;
  relayCount: number;
  tcpFallbackCount: number;
  checks: DiagnosticCheckItem[];
  peers: PeerDiagnosticItem[];
  recommendations: string[];
}

export interface EasyTierNodeDiagnostics {
  publicIpv6Ready: boolean;
  interfaceIpv6Count: number;
}

/**
 * Returns true only for IPv6 Global Unicast Addresses (`2000::/3`).
 * Rejects loopback (`::1`), link-local (`fe80::/10`), ULA (`fc00::/7`),
 * multicast (`ff00::/8`), and IPv4-mapped (`::ffff:0:0/96`) addresses.
 */
export function isGlobalUnicastIpv6(addr: string): boolean {
  if (typeof addr !== "string" || !addr.trim()) return false;
  const clean = addr.trim().split("%")[0].toLowerCase();
  if (!clean.includes(":")) return false;
  if (clean === "::" || clean === "::1") return false;
  if (clean.startsWith("::ffff:")) return false;

  const firstHextetStr = clean.split(":")[0];
  if (!firstHextetStr || !/^[0-9a-f]{1,4}$/.test(firstHextetStr)) {
    return false;
  }
  const firstHextet = Number.parseInt(firstHextetStr, 16);
  // Global Unicast IPv6 range is 2000::/3 (first hextet 0x2000 .. 0x3fff)
  return firstHextet >= 0x2000 && firstHextet <= 0x3fff;
}

export function inspectLocalIpv6Interfaces(
  ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): { ipv6GlobalReady: boolean; ipv6InterfaceCount: number } {
  let count = 0;
  for (const entries of Object.values(ifaces)) {
    if (!Array.isArray(entries)) continue;
    for (const info of entries) {
      if (!info || info.internal) continue;
      if (info.family === "IPv6" && isGlobalUnicastIpv6(info.address)) {
        count += 1;
      }
    }
  }
  return {
    ipv6GlobalReady: count > 0,
    ipv6InterfaceCount: count,
  };
}

/**
 * Extracts only non-sensitive IPv6 readiness metrics from `easytier-cli -o json node`.
 */
export function parseEasyTierNodeInfo(rawJson: string): EasyTierNodeDiagnostics | null {
  if (typeof rawJson !== "string" || !rawJson.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const ipList =
      obj.ip_list && typeof obj.ip_list === "object" && !Array.isArray(obj.ip_list)
        ? (obj.ip_list as Record<string, unknown>)
        : null;

    const ifaceIpv6s = Array.isArray(ipList?.interface_ipv6s) ? ipList.interface_ipv6s : [];
    const hasPublicV6 =
      Boolean(ipList?.public_ipv6) || Boolean(obj.public_ipv6_addr);

    return {
      publicIpv6Ready: hasPublicV6 || ifaceIpv6s.length > 0,
      interfaceIpv6Count: ifaceIpv6s.length,
    };
  } catch {
    return null;
  }
}

function isSymmetricNat(nat: string): boolean {
  return nat.trim().toLowerCase().includes("symmetric");
}

function isTcpFallbackTunnel(tunnel: string): boolean {
  const lower = tunnel.trim().toLowerCase();
  return Boolean(lower) && lower !== "-" && lower.includes("tcp") && !lower.includes("udp");
}

export function buildNetworkDiagnostics(input: {
  easytierRunning: boolean;
  needsElevation: boolean;
  peers: PeerStatus[];
  localIpv6: { ipv6GlobalReady: boolean; ipv6InterfaceCount: number };
  nodeInfo?: EasyTierNodeDiagnostics | null;
  now?: number;
}): NetworkDiagnosticsReport {
  const checkedAt = input.now ?? Date.now();
  const peers = Array.isArray(input.peers) ? input.peers : [];
  const localPeer = peers.find((p) => p.cost === "Local");
  const localNatType = localPeer?.nat && localPeer.nat !== "-" ? localPeer.nat : "未知";

  const ipv6GlobalReady = Boolean(input.localIpv6.ipv6GlobalReady || input.nodeInfo?.publicIpv6Ready);
  const ipv6InterfaceCount = Math.max(
    input.localIpv6.ipv6InterfaceCount,
    input.nodeInfo?.interfaceIpv6Count ?? 0,
  );

  // Exclude coordinator / relay infrastructure noise if it has no mesh IPv4, keep real peers
  const remotePeers = peers.filter(
    (p) => p.cost !== "Local" && Boolean(p.ipv4) && !p.hostname.startsWith("PublicServer_"),
  );

  let p2pCount = 0;
  let relayCount = 0;
  let tcpFallbackCount = 0;
  let highLossCount = 0;
  let doubleSymmetricCount = 0;

  const peerItems: PeerDiagnosticItem[] = remotePeers.map((p) => {
    const costLower = (p.cost || "").trim().toLowerCase();
    const isP2p = costLower === "p2p" || costLower === "direct";
    const isRelay = !isP2p;
    const isTcpOnly = isTcpFallbackTunnel(p.tunnel || "");
    const lossPercent = parseLossPercent(p.loss);
    const hasHighLoss = lossPercent !== null && lossPercent >= 2;
    const peerSymmetric = isSymmetricNat(p.nat || "");
    const localSymmetric = isSymmetricNat(localNatType);

    if (isP2p) p2pCount += 1;
    else relayCount += 1;
    if (isTcpOnly) tcpFallbackCount += 1;
    if (hasHighLoss) highLossCount += 1;
    if (isRelay && localSymmetric && peerSymmetric) doubleSymmetricCount += 1;

    let severity: DiagnosticSeverity = "ok";
    const notes: string[] = [];
    if (isRelay) {
      severity = "warn";
      notes.push("服务器中转");
    } else {
      notes.push("P2P 直连");
    }
    if (isTcpOnly) {
      severity = "error";
      notes.push("TCP 回落");
    }
    if (hasHighLoss) {
      severity = "error";
      notes.push(`丢包 ${lossPercent?.toFixed(1)}%`);
    }
    if (p.latencyMs !== null && p.latencyMs >= 80 && severity === "ok") {
      severity = "warn";
      notes.push("延迟偏高");
    }

    return {
      ipv4: p.ipv4,
      hostname: p.hostname || p.ipv4,
      routeType: p.cost || "-",
      tunnel: p.tunnel || "-",
      nat: p.nat || "-",
      latencyMs: p.latencyMs,
      lossPercent,
      severity,
      verdict: notes.join(" · "),
    };
  });

  const checks: DiagnosticCheckItem[] = [];
  const recommendations: string[] = [];

  if (!input.easytierRunning) {
    checks.push({
      id: "easytier_core",
      label: "虚拟组网引擎",
      severity: "error",
      summary: input.needsElevation ? "需要管理员授权以建立虚拟网卡" : "虚拟组网未运行",
      detail: input.needsElevation
        ? "当前未获得创建 Wintun 虚拟网卡权限，无法建立低延迟 UDP 通道。"
        : "EasyTier 通道尚未启动。",
      action: input.needsElevation ? "relaunch_admin" : undefined,
    });
    if (input.needsElevation) {
      recommendations.push("点击顶部【一键授权启用】或本页【以管理员授权启用】，即可恢复 P2P 直连能力。");
    }
  } else {
    checks.push({
      id: "easytier_core",
      label: "虚拟组网引擎",
      severity: "ok",
      summary: "运行正常",
      detail: `已检测到 ${remotePeers.length} 个在线受控/组网节点。`,
    });
  }

  if (isSymmetricNat(localNatType)) {
    checks.push({
      id: "local_nat",
      label: "本机 NAT 类型",
      severity: ipv6GlobalReady ? "ok" : "warn",
      summary: `Symmetric (${ipv6GlobalReady ? "IPv6 可辅助直连" : "对称型 NAT"})`,
      detail: ipv6GlobalReady
        ? "虽然本机 IPv4 为 Symmetric NAT，但已具备公网 IPv6 地址，可直接绕过 IPv4 NAT 限制。"
        : "本机处于对称型 NAT（Symmetric），若对端同为 Symmetric 则难以打通 IPv4 UDP 打洞。",
    });
  } else {
    checks.push({
      id: "local_nat",
      label: "本机 NAT 类型",
      severity: localNatType === "未知" ? "warn" : "ok",
      summary: localNatType,
      detail: localNatType === "未知"
        ? "尚未采集到本地 STUN NAT 探测结果，请稍后刷新。"
        : "当前 NAT 类型支持 UDP 打洞直连。",
    });
  }

  checks.push({
    id: "ipv6_direct",
    label: "公网 IPv6 直连能力",
    severity: ipv6GlobalReady ? "ok" : "warn",
    summary: ipv6GlobalReady ? `已就绪（${ipv6InterfaceCount} 个全局 IPv6）` : "未检测到公网 IPv6",
    detail: ipv6GlobalReady
      ? "本机已获得 2000::/3 全局单播 IPv6，在跨省复杂 NAT 场景下可显著提升 P2P 直连率。"
      : "当前网络未下发公网 IPv6（或网卡仅启用了链路本地地址 fe80::）。开启路由器与宽带 IPv6 并确保允许 UDP 入站可大幅提高直连概率。",
    action: ipv6GlobalReady ? undefined : "enable_ipv6",
  });

  if (remotePeers.length === 0) {
    checks.push({
      id: "p2p_routing",
      label: "节点直连路径",
      severity: input.easytierRunning ? "warn" : "error",
      summary: "暂无可检测的对端主机",
      detail: "当前没有其他在线节点加入虚拟内网，开机其他设备后可再次运行体检。",
    });
  } else if (relayCount === 0) {
    checks.push({
      id: "p2p_routing",
      label: "节点直连路径",
      severity: "ok",
      summary: `全部 ${p2pCount} 台设备已 P2P 直连`,
      detail: "所有在线节点均直接点对点通信，不经过中转服务器。",
    });
  } else {
    checks.push({
      id: "p2p_routing",
      label: "节点直连路径",
      severity: p2pCount === 0 ? "error" : "warn",
      summary: `${p2pCount} 台直连 / ${relayCount} 台服务器中转`,
      detail:
        doubleSymmetricCount > 0
          ? "部分链路两端同为 Symmetric NAT 且缺少公网 IPv6，目前通过中转服务器转发。"
          : "部分节点当前走中转链路，可能是对端防火墙拦截 UDP 或刚上线仍在打洞中。",
    });
  }

  if (tcpFallbackCount > 0) {
    checks.push({
      id: "udp_transport",
      label: "底层传输协议",
      severity: "error",
      summary: `${tcpFallbackCount} 条链路已回落为 TCP`,
      detail: "TCP 封装隧道在串流高码率场景下容易出现队头阻塞与卡顿，建议重建纯 UDP 通道。",
      action: "reconnect_udp",
    });
    recommendations.push("检测到 TCP 隧道回落，建议立即点击【重建纯 UDP】强制切回低延迟 UDP 传输。");
  } else {
    checks.push({
      id: "udp_transport",
      label: "底层传输协议",
      severity: highLossCount > 0 ? "warn" : "ok",
      summary: highLossCount > 0 ? `纯 UDP 传输（${highLossCount} 节点丢包偏高）` : "纯 UDP 低延迟传输",
      detail:
        highLossCount > 0
          ? "当前已使用 UDP，但部分节点丢包率 ≥ 2%，建议检查 Wi-Fi 信号或运营商 UDP QoS 限速。"
          : "所有在线节点均保持 UDP 隧道通信，避免 TCP-over-TCP 队头阻塞。",
    });
  }

  if (doubleSymmetricCount > 0 && !ipv6GlobalReady) {
    recommendations.push("检测到两端均为对称型 NAT 且未开启 IPv6：建议在路由器开启原生 IPv6 并放行对端 UDP 入站，可免公网 IPv4 实现直连。");
  } else if (!ipv6GlobalReady) {
    recommendations.push("如遇到跨省宽带难以直连，建议在家庭光猫/路由器开启 IPv6（无状态 SLAAC/DHCPv6），系统会自动优先尝试 IPv6 直连。");
  }
  if (highLossCount > 0) {
    recommendations.push("部分对端丢包 ≥ 2%：若主机使用无线网卡建议换有线/近距离 5GHz，并在串流时适当关注右上浮窗连接状态。");
  }
  if (recommendations.length === 0) {
    recommendations.push("当前网络链路健康，适合高帧率原画低延迟远程操作。");
  }

  const hasError = checks.some((c) => c.severity === "error");
  const hasWarn = checks.some((c) => c.severity === "warn");
  const overall: NetworkDiagnosticsReport["overall"] = hasError
    ? "degraded"
    : hasWarn
      ? "good"
      : "excellent";

  return {
    checkedAt,
    overall,
    easytierRunning: input.easytierRunning,
    localNatType,
    ipv6GlobalReady,
    ipv6InterfaceCount,
    p2pCount,
    relayCount,
    tcpFallbackCount,
    checks,
    peers: peerItems,
    recommendations,
  };
}
