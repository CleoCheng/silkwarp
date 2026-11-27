#!/usr/bin/env bash
set -euo pipefail

# SilkWarp Tier-2 Relay, Mesh Hub & WOL Gateway Deployment (Relay Node)
# Deploys:
#   1. Kernel BBR + fq + IP forwarding + UDP buffers
#   2. EasyTier (private team relay mesh, peering Fixed-IP coordinator)
#   3. RustDesk Server hbbr (-k _) using synced signaling keypair
#   4. SilkWarp WOL Gateway bound strictly to SILKWARP_RELAY_MESH_IP:SILKWARP_WOL_PORT

ENABLE_SSH_PORT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --enable-ssh-port)
      ENABLE_SSH_PORT="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

ENV_FILE="${SILKWARP_ENV_FILE:-/opt/silkwarp/silkwarp.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

EASYTIER_VERSION="${EASYTIER_VERSION:-v2.6.4}"
RUSTDESK_SERVER_VERSION="${RUSTDESK_SERVER_VERSION:-1.1.16}"
SILKWARP_RELAY_HOSTNAME="${SILKWARP_RELAY_HOSTNAME:-silkwarp-relay}"
SILKWARP_SIGNALING_HOST="${SILKWARP_SIGNALING_HOST:?SILKWARP_SIGNALING_HOST is required}"
SILKWARP_EASYTIER_COORD_PORT="${SILKWARP_EASYTIER_COORD_PORT:-11010}"
SILKWARP_EASYTIER_RELAY_PORT="${SILKWARP_EASYTIER_RELAY_PORT:-11011}"
SILKWARP_EASYTIER_ALT_PORT="${SILKWARP_EASYTIER_ALT_PORT:-}"
SILKWARP_RUSTDESK_HBBR_PORT="${SILKWARP_RUSTDESK_HBBR_PORT:-21117}"
SILKWARP_RELAY_MESH_IP="${SILKWARP_RELAY_MESH_IP:-10.144.0.1}"
SILKWARP_WOL_PORT="${SILKWARP_WOL_PORT:-9580}"
SILKWARP_WOL_BROADCAST="${SILKWARP_WOL_BROADCAST:-255.255.255.255}"
SILKWARP_NETWORK_NAME="${SILKWARP_NETWORK_NAME:-silkwarp-team}"
SILKWARP_NETWORK_SECRET="${SILKWARP_NETWORK_SECRET:?SILKWARP_NETWORK_SECRET is required}"
SILKWARP_WOL_TOKEN="${SILKWARP_WOL_TOKEN:?SILKWARP_WOL_TOKEN is required}"

INSTALL_BASE="/opt/silkwarp"
ET_DIR="${INSTALL_BASE}/easytier"
RD_DIR="${INSTALL_BASE}/rustdesk"
WOL_DIR="${INSTALL_BASE}/wol"
DL_DIR="${INSTALL_BASE}/downloads"

fetch_archive() {
  local filename="$1"
  local url="$2"
  local dest="$3"
  if [[ -s "${DL_DIR}/${filename}" ]]; then
    echo "    Using pre-staged archive: ${DL_DIR}/${filename}"
    cp -f "${DL_DIR}/${filename}" "$dest"
    return 0
  fi
  local effective_url="$url"
  if [[ -n "${GITHUB_PROXY_URL:-}" ]]; then
    effective_url="${GITHUB_PROXY_URL%/}/${url}"
  fi
  curl -fsSL --retry 3 --connect-timeout 15 -o "$dest" "$effective_url"
}

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: Run as root." >&2
  exit 1
fi

if [[ ! -f "${RD_DIR}/id_ed25519" || ! -f "${RD_DIR}/id_ed25519.pub" ]]; then
  echo "ERROR: Synced RustDesk keys missing in ${RD_DIR}/ (id_ed25519 & id_ed25519.pub)." >&2
  echo "Run scripts/push-r720-relay.ps1 or copy them from secrets/rustdesk/ first." >&2
  exit 1
fi

echo "==> [1/6] Ensuring prerequisite packages"
if [[ -f /etc/apt/sources.list ]]; then
  sed -i 's/^[[:space:]]*deb cdrom:/# deb cdrom:/g' /etc/apt/sources.list
  if ! grep -Eq '^[[:space:]]*deb[[:space:]]+https?://' /etc/apt/sources.list /etc/apt/sources.list.d/*.list 2>/dev/null; then
    cat >>/etc/apt/sources.list <<'EOF'
deb http://mirrors.tuna.tsinghua.edu.cn/debian/ bookworm main contrib non-free non-free-firmware
deb http://mirrors.tuna.tsinghua.edu.cn/debian/ bookworm-updates main contrib non-free non-free-firmware
deb http://mirrors.tuna.tsinghua.edu.cn/debian-security bookworm-security main contrib non-free non-free-firmware
EOF
  fi
fi
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl unzip iproute2 python3 etherwake

echo "==> [2/6] Enabling BBR, fq qdisc, forwarding, and UDP socket buffers"
modprobe tcp_bbr || true
echo "tcp_bbr" >/etc/modules-load.d/bbr.conf
cat >/etc/sysctl.d/99-silkwarp-relay.conf <<'EOF'
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.core.rmem_default = 262144
net.core.wmem_default = 262144
EOF
sysctl --system >/dev/null

echo "==> [3/6] Installing EasyTier ${EASYTIER_VERSION} (Relay & Mesh Hub)"
mkdir -p "$ET_DIR" "$RD_DIR" "$WOL_DIR"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

ET_ZIP="${TMP_DIR}/easytier.zip"
ET_URL="https://github.com/EasyTier/EasyTier/releases/download/${EASYTIER_VERSION}/easytier-linux-x86_64-${EASYTIER_VERSION}.zip"
fetch_archive "easytier-linux-x86_64-${EASYTIER_VERSION}.zip" "$ET_URL" "$ET_ZIP"
unzip -qo "$ET_ZIP" -d "${TMP_DIR}/et"

ET_CORE_SRC="$(find "${TMP_DIR}/et" -type f -name 'easytier-core' | head -n 1)"
ET_CLI_SRC="$(find "${TMP_DIR}/et" -type f -name 'easytier-cli' | head -n 1)"
if [[ -z "$ET_CORE_SRC" || -z "$ET_CLI_SRC" ]]; then
  echo "ERROR: Failed to locate easytier binaries in archive." >&2
  exit 1
fi

systemctl stop silkwarp-easytier-relay.service 2>/dev/null || true
install -m 0755 "$ET_CORE_SRC" "${ET_DIR}/easytier-core"
install -m 0755 "$ET_CLI_SRC" "${ET_DIR}/easytier-cli"

cat >"${ET_DIR}/config.toml" <<EOF
hostname = "${SILKWARP_RELAY_HOSTNAME}"
ipv4 = "${SILKWARP_RELAY_MESH_IP}/24"
dhcp = false

listeners = [
    "udp://0.0.0.0:${SILKWARP_EASYTIER_RELAY_PORT}",
    "udp://[::]:${SILKWARP_EASYTIER_RELAY_PORT}",
    "tcp://0.0.0.0:${SILKWARP_EASYTIER_RELAY_PORT}",
    "tcp://[::]:${SILKWARP_EASYTIER_RELAY_PORT}",
]

rpc_portal = "127.0.0.1:15888"

[[peer]]
uri = "udp://${SILKWARP_SIGNALING_HOST}:${SILKWARP_EASYTIER_COORD_PORT}"

[[peer]]
uri = "tcp://${SILKWARP_SIGNALING_HOST}:${SILKWARP_EASYTIER_COORD_PORT}"

[network_identity]
network_name = "${SILKWARP_NETWORK_NAME}"
network_secret = "${SILKWARP_NETWORK_SECRET}"

[flags]
default_protocol = "udp"
relay_network_whitelist = "${SILKWARP_NETWORK_NAME}"
relay_all_peer_rpc = false
multi_thread = true
multi_thread_count = 4
latency_first = false
enable_ipv6 = true
enable_encryption = true
compression = "none"
disable_tcp_hole_punching = true
disable_sym_hole_punching = false
EOF
chmod 600 "${ET_DIR}/config.toml"

cat >/etc/systemd/system/silkwarp-easytier-relay.service <<EOF
[Unit]
Description=SilkWarp EasyTier Relay & Mesh Hub
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${ET_DIR}/easytier-core -c ${ET_DIR}/config.toml --rpc-portal 127.0.0.1:15888 --rpc-portal-whitelist 127.0.0.1,127.0.0.0/8,::1/128
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

echo "==> [4/6] Installing RustDesk Server ${RUSTDESK_SERVER_VERSION} (hbbr)"
RD_ZIP="${TMP_DIR}/rustdesk.zip"
RD_URL="https://github.com/rustdesk/rustdesk-server/releases/download/${RUSTDESK_SERVER_VERSION}/rustdesk-server-linux-amd64.zip"
fetch_archive "rustdesk-server-linux-amd64-${RUSTDESK_SERVER_VERSION}.zip" "$RD_URL" "$RD_ZIP"
unzip -qo "$RD_ZIP" -d "${TMP_DIR}/rd"

HBBR_SRC="$(find "${TMP_DIR}/rd" -type f -name 'hbbr' | head -n 1)"
if [[ -z "$HBBR_SRC" ]]; then
  echo "ERROR: Failed to locate hbbr binary in archive." >&2
  exit 1
fi

systemctl stop silkwarp-rustdesk-hbbr.service 2>/dev/null || true
install -m 0755 "$HBBR_SRC" "${RD_DIR}/hbbr"
chmod 600 "${RD_DIR}/id_ed25519"
chmod 644 "${RD_DIR}/id_ed25519.pub"

cat >/etc/systemd/system/silkwarp-rustdesk-hbbr.service <<EOF
[Unit]
Description=SilkWarp RustDesk Relay Server (hbbr)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${RD_DIR}
ExecStart=${RD_DIR}/hbbr -p ${SILKWARP_RUSTDESK_HBBR_PORT} -k _
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

echo "==> [5/6] Configuring SilkWarp WOL Gateway"
if [[ -f "${WOL_DIR}/silkwarp_wol.py" ]]; then
  chmod 755 "${WOL_DIR}/silkwarp_wol.py"
fi

if [[ ! -f "${WOL_DIR}/devices.json" ]]; then
  PRIMARY_IFACE="$(ip route show default 2>/dev/null | awk '/default/ {print $5; exit}')"
  cat >"${WOL_DIR}/devices.json" <<EOF
{
  "devices": [
    {
      "name": "pc-main-example",
      "mac": "00:00:00:00:00:00",
      "mesh_ip": "10.144.0.10",
      "broadcast": "${SILKWARP_WOL_BROADCAST}",
      "iface": "${PRIMARY_IFACE:-eth0}",
      "notes": "Replace with actual GPU host MAC before using"
    }
  ]
}
EOF
  chmod 600 "${WOL_DIR}/devices.json"
fi

cat >/etc/systemd/system/silkwarp-wol.service <<EOF
[Unit]
Description=SilkWarp Wake-on-LAN Gateway (Mesh Only)
After=network-online.target silkwarp-easytier-relay.service
Wants=silkwarp-easytier-relay.service

[Service]
Type=simple
EnvironmentFile=${ENV_FILE}
Environment=SILKWARP_WOL_BIND=${SILKWARP_RELAY_MESH_IP}
Environment=SILKWARP_WOL_PORT=${SILKWARP_WOL_PORT}
Environment=SILKWARP_WOL_DEVICES=${WOL_DIR}/devices.json
ExecStart=/usr/bin/python3 ${WOL_DIR}/silkwarp_wol.py
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

if [[ -n "$ENABLE_SSH_PORT" ]]; then
  echo "==> Configuring additional SSH port ${ENABLE_SSH_PORT}"
  mkdir -p /etc/ssh/sshd_config.d
  cat >/etc/ssh/sshd_config.d/99-silkwarp.conf <<EOF
Port 22
Port ${ENABLE_SSH_PORT}
EOF
  sshd -t
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
fi

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow "${SILKWARP_EASYTIER_RELAY_PORT}/tcp"
  ufw allow "${SILKWARP_EASYTIER_RELAY_PORT}/udp"
  if [[ -n "$SILKWARP_EASYTIER_ALT_PORT" ]]; then
    ufw allow "${SILKWARP_EASYTIER_ALT_PORT}/tcp"
    ufw allow "${SILKWARP_EASYTIER_ALT_PORT}/udp"
  fi
  ufw allow "${SILKWARP_RUSTDESK_HBBR_PORT}/tcp"
  if [[ -n "$ENABLE_SSH_PORT" ]]; then
    ufw allow "${ENABLE_SSH_PORT}/tcp"
  fi
fi

echo "==> [6/6] Starting services and verifying state"
systemctl daemon-reload
systemctl enable --now silkwarp-easytier-relay.service
systemctl enable --now silkwarp-rustdesk-hbbr.service
sleep 2
systemctl enable --now silkwarp-wol.service

echo "--- SYSCTL ---"
sysctl net.ipv4.tcp_congestion_control net.core.default_qdisc
echo "--- SERVICES ---"
systemctl is-active silkwarp-easytier-relay.service silkwarp-rustdesk-hbbr.service silkwarp-wol.service
echo "--- PORTS ---"
ss -tulnp | grep -E ":(${SILKWARP_EASYTIER_RELAY_PORT}|${SILKWARP_RUSTDESK_HBBR_PORT}|${SILKWARP_WOL_PORT}|15888)\b" || true
echo "--- EASYTIER PEERS ---"
"${ET_DIR}/easytier-cli" -p 127.0.0.1:15888 peer || true
