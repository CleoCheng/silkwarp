#!/usr/bin/env bash
set -euo pipefail

# SilkWarp Tier-1 Signaling Plane Deployment (Fixed-IP VPS)
# Deploys:
#   1. Kernel BBR + fq + UDP buffer tuning
#   2. EasyTier (RPC-only coordination mode, no_tun=true, zero data relay)
#   3. RustDesk Server hbbs (ID/Rendezvous pointing relay to dedicated Relay Node)

ENV_FILE="${SILKWARP_ENV_FILE:-/opt/silkwarp/silkwarp.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

EASYTIER_VERSION="${EASYTIER_VERSION:-v2.6.4}"
RUSTDESK_SERVER_VERSION="${RUSTDESK_SERVER_VERSION:-1.1.16}"
SILKWARP_COORD_HOSTNAME="${SILKWARP_COORD_HOSTNAME:-silkwarp-coord}"
SILKWARP_COORD_NETWORK_NAME="${SILKWARP_COORD_NETWORK_NAME:-silkwarp-coord-only}"
SILKWARP_COORD_SECRET="${SILKWARP_COORD_SECRET:?SILKWARP_COORD_SECRET is required}"
SILKWARP_RELAY_HOST="${SILKWARP_RELAY_HOST:?SILKWARP_RELAY_HOST is required}"
SILKWARP_EASYTIER_COORD_PORT="${SILKWARP_EASYTIER_COORD_PORT:-11010}"
SILKWARP_RUSTDESK_HBBR_PORT="${SILKWARP_RUSTDESK_HBBR_PORT:-21117}"

INSTALL_BASE="/opt/silkwarp"
ET_DIR="${INSTALL_BASE}/easytier"
RD_DIR="${INSTALL_BASE}/rustdesk"
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

echo "==> [1/5] Ensuring prerequisite tools"
NEED_APT=0
for cmd in curl unzip ss; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    NEED_APT=1
  fi
done
if [[ "$NEED_APT" -eq 1 ]]; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl unzip iproute2
fi

echo "==> [2/5] Enabling BBR, fq qdisc, and UDP socket buffers"
modprobe tcp_bbr || true
echo "tcp_bbr" >/etc/modules-load.d/bbr.conf
cat >/etc/sysctl.d/99-silkwarp-bbr.conf <<'EOF'
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.core.rmem_default = 262144
net.core.wmem_default = 262144
EOF
sysctl --system >/dev/null

echo "==> [3/5] Installing EasyTier ${EASYTIER_VERSION} (RPC-only coordinator)"
mkdir -p "$ET_DIR" "$RD_DIR"
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

systemctl stop silkwarp-easytier-coord.service 2>/dev/null || true
install -m 0755 "$ET_CORE_SRC" "${ET_DIR}/easytier-core"
install -m 0755 "$ET_CLI_SRC" "${ET_DIR}/easytier-cli"

cat >"${ET_DIR}/config.toml" <<EOF
hostname = "${SILKWARP_COORD_HOSTNAME}"
dhcp = false

listeners = [
    "tcp://0.0.0.0:${SILKWARP_EASYTIER_COORD_PORT}",
    "udp://0.0.0.0:${SILKWARP_EASYTIER_COORD_PORT}",
]

rpc_portal = "127.0.0.1:15888"

[network_identity]
network_name = "${SILKWARP_COORD_NETWORK_NAME}"
network_secret = "${SILKWARP_COORD_SECRET}"

[flags]
no_tun = true
relay_network_whitelist = ""
relay_all_peer_rpc = true
multi_thread = true
enable_encryption = true
EOF
chmod 600 "${ET_DIR}/config.toml"

cat >/etc/systemd/system/silkwarp-easytier-coord.service <<EOF
[Unit]
Description=SilkWarp EasyTier RPC-Only Coordinator
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

echo "==> [4/5] Installing RustDesk Server ${RUSTDESK_SERVER_VERSION} (hbbs)"
RD_ZIP="${TMP_DIR}/rustdesk.zip"
RD_URL="https://github.com/rustdesk/rustdesk-server/releases/download/${RUSTDESK_SERVER_VERSION}/rustdesk-server-linux-amd64.zip"
fetch_archive "rustdesk-server-linux-amd64-${RUSTDESK_SERVER_VERSION}.zip" "$RD_URL" "$RD_ZIP"
unzip -qo "$RD_ZIP" -d "${TMP_DIR}/rd"

HBBS_SRC="$(find "${TMP_DIR}/rd" -type f -name 'hbbs' | head -n 1)"
if [[ -z "$HBBS_SRC" ]]; then
  echo "ERROR: Failed to locate hbbs binary in archive." >&2
  exit 1
fi

systemctl stop silkwarp-rustdesk-hbbs.service 2>/dev/null || true
install -m 0755 "$HBBS_SRC" "${RD_DIR}/hbbs"

cat >/etc/systemd/system/silkwarp-rustdesk-hbbs.service <<EOF
[Unit]
Description=SilkWarp RustDesk ID/Rendezvous Server (hbbs)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${RD_DIR}
ExecStart=${RD_DIR}/hbbs -r ${SILKWARP_RELAY_HOST}:${SILKWARP_RUSTDESK_HBBR_PORT} -k _
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

echo "==> [5/5] Starting services and verifying keypair"
systemctl daemon-reload
systemctl enable --now silkwarp-easytier-coord.service
systemctl enable --now silkwarp-rustdesk-hbbs.service

for _ in $(seq 1 15); do
  if [[ -f "${RD_DIR}/id_ed25519.pub" ]]; then
    break
  fi
  sleep 1
done

if [[ -f "${RD_DIR}/id_ed25519" ]]; then
  chmod 600 "${RD_DIR}/id_ed25519"
fi
if [[ -f "${RD_DIR}/id_ed25519.pub" ]]; then
  chmod 644 "${RD_DIR}/id_ed25519.pub"
fi

sleep 1
echo "--- SYSCTL ---"
sysctl net.ipv4.tcp_congestion_control net.core.default_qdisc
echo "--- SERVICES ---"
systemctl is-active silkwarp-easytier-coord.service silkwarp-rustdesk-hbbs.service
echo "--- PORTS ---"
ss -tulnp | grep -E ":(${SILKWARP_EASYTIER_COORD_PORT}|15888|21115|21116|21118)\b" || true
if [[ -f "${RD_DIR}/id_ed25519.pub" ]]; then
  echo "RUSTDESK_PUBLIC_KEY=$(cat "${RD_DIR}/id_ed25519.pub")"
else
  echo "WARNING: id_ed25519.pub was not generated within timeout." >&2
  exit 1
fi
