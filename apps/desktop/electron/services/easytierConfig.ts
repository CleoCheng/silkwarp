import os from "node:os";
import type { BootstrapConfig, PeerStatus } from "../types";

/**
 * Pure EasyTier TOML rendering and peer selection helpers.
 *
 * IMPORTANT: this module must not import `electron` so that Node unit tests
 * can import the compiled CommonJS module directly.
 */

export type EasyTierTransportMode = "udp_only" | "udp_and_tcp";

function splitUriSchemeAndAuthority(rawUri: string): { scheme: string; authority: string } | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)/i.exec(rawUri.trim());
  if (!m) return null;
  return {
    scheme: m[1].toLowerCase(),
    authority: m[2].toLowerCase(),
  };
}

/**
 * Selects EasyTier bootstrap `[[peer]]` URIs for the requested transport mode.
 *
 * - `"udp_only"`: eliminates `tcp://host:port` duplicates whenever a matching
 *   `udp://host:port` peer exists, preventing TCP-over-TCP tunneling and
 *   ordering UDP endpoints first; `tcp://` peers without a UDP counterpart are
 *   retained for reachability.
 * - `"udp_and_tcp"`: keeps all deduplicated URIs with `udp://` before `tcp://`.
 */
export function selectEasyTierPeers(
  peers: readonly string[],
  mode: EasyTierTransportMode = "udp_only",
): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  const udpAuthorities = new Set<string>();

  for (const raw of peers) {
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(trimmed);

    const parsed = splitUriSchemeAndAuthority(trimmed);
    if (parsed && parsed.scheme === "udp") {
      udpAuthorities.add(parsed.authority);
    }
  }

  const filtered =
    mode === "udp_only"
      ? deduped.filter((uri) => {
          const parsed = splitUriSchemeAndAuthority(uri);
          if (!parsed || parsed.scheme !== "tcp") return true;
          return !udpAuthorities.has(parsed.authority);
        })
      : deduped;

  const udpFirst: string[] = [];
  const others: string[] = [];
  for (const uri of filtered) {
    const parsed = splitUriSchemeAndAuthority(uri);
    if (parsed && parsed.scheme === "udp") {
      udpFirst.push(uri);
    } else {
      others.push(uri);
    }
  }
  return [...udpFirst, ...others];
}

/**
 * Renders an EasyTier TOML configuration tailored for desktop SilkWarp nodes.
 * Defaults to `"udp_only"` to avoid TCP-over-TCP head-of-line blocking and
 * sets `relay_network_whitelist = ""` so ordinary desktop nodes never act as
 * accidental LAN relays for other peers.
 */
export function renderEasyTierConfig(
  cfg: BootstrapConfig,
  hostname = os.hostname(),
  mode: EasyTierTransportMode = "udp_only",
): string {
  const meshCidrPrefix = cfg.mesh_cidr.split("/")[1] || "24";
  const selectedPeers = selectEasyTierPeers(cfg.easytier.peers, mode);
  const listeners =
    mode === "udp_and_tcp"
      ? [`    "udp://0.0.0.0:0",`, `    "udp://[::]:0",`, `    "tcp://0.0.0.0:0",`, `    "tcp://[::]:0",`]
      : [`    "udp://0.0.0.0:0",`, `    "udp://[::]:0",`];
  const disableTcpHolePunching = mode === "udp_only";

  const lines = [
    `hostname = "${hostname.replace(/"/g, "")}"`,
    `ipv4 = "${cfg.mesh_ip}/${meshCidrPrefix}"`,
    `dhcp = false`,
    ``,
    `listeners = [`,
    ...listeners,
    `]`,
    ``,
    `rpc_portal = "127.0.0.1:15888"`,
    ``,
    ...selectedPeers.flatMap((uri) => [`[[peer]]`, `uri = "${uri}"`, ``]),
    `[network_identity]`,
    `network_name = "${cfg.easytier.network_name}"`,
    `network_secret = "${cfg.easytier.network_secret}"`,
    ``,
    `[flags]`,
    `dev_name = "SilkWarp"`,
    `default_protocol = "udp"`,
    `enable_exit_node = false`,
    `accept_dns = false`,
    `latency_first = false`,
    `multi_thread = true`,
    `multi_thread_count = 4`,
    `enable_ipv6 = true`,
    `enable_encryption = true`,
    `disable_tcp_hole_punching = ${disableTcpHolePunching ? "true" : "false"}`,
    `relay_network_whitelist = ""`,
    `mtu = 1360`,
    ``,
  ];
  return lines.join("\n");
}

/**
 * Returns true if at least one non-local remote peer has formed a p2p or relay route.
 */
export function hasConnectedRemotePeer(peers: readonly PeerStatus[]): boolean {
  return peers.some((p) => p && p.cost !== "Local" && (p.cost === "p2p" || p.cost.startsWith("relay")));
}
