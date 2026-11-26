#!/usr/bin/env bash
set -euo pipefail

# SilkWarp RustDesk API Server (lejianwen/rustdesk-api v2.7)
# Listens locally on 127.0.0.1:21114 and exposes TLS via Nginx on SILKWARP_DOMAIN:SILKWARP_RUSTDESK_API_PORT

RD_API_DIR="/opt/silkwarp/rustdesk-api"
ARCHIVE="/opt/silkwarp/downloads/rustdesk-api-v2.7-linux-amd64.tar.gz"
ENV_FILE="${SILKWARP_ENV_FILE:-/opt/silkwarp/control-plane/control.env}"
NGINX_CONF="/etc/nginx/sites-available/silkwarp-rustdesk-api.conf"
NGINX_LINK="/etc/nginx/sites-enabled/silkwarp-rustdesk-api.conf"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: Run as root." >&2
  exit 1
fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

SILKWARP_SIGNALING_HOST="${SILKWARP_SIGNALING_HOST:?SILKWARP_SIGNALING_HOST is required}"
SILKWARP_RELAY_HOST="${SILKWARP_RELAY_HOST:?SILKWARP_RELAY_HOST is required}"
SILKWARP_RUSTDESK_HBBS_PORT="${SILKWARP_RUSTDESK_HBBS_PORT:-21116}"
SILKWARP_RUSTDESK_HBBR_PORT="${SILKWARP_RUSTDESK_HBBR_PORT:-21117}"
SILKWARP_RUSTDESK_API_URL="${SILKWARP_RUSTDESK_API_URL:?SILKWARP_RUSTDESK_API_URL is required}"
SILKWARP_RUSTDESK_API_PORT="${SILKWARP_RUSTDESK_API_PORT:-21114}"
SILKWARP_DOMAIN="${SILKWARP_DOMAIN:?SILKWARP_DOMAIN is required}"
SILKWARP_SSL_CERT="${SILKWARP_SSL_CERT:?SILKWARP_SSL_CERT is required}"
SILKWARP_SSL_KEY="${SILKWARP_SSL_KEY:?SILKWARP_SSL_KEY is required}"
export SILKWARP_SIGNALING_HOST SILKWARP_RELAY_HOST SILKWARP_RUSTDESK_HBBS_PORT SILKWARP_RUSTDESK_HBBR_PORT SILKWARP_RUSTDESK_API_URL

if [[ ! -s "$ARCHIVE" ]]; then
  echo "ERROR: Missing archive $ARCHIVE" >&2
  exit 1
fi

mkdir -p "${RD_API_DIR}" "${RD_API_DIR}/data" "${RD_API_DIR}/runtime"
systemctl stop silkwarp-rustdesk-api.service 2>/dev/null || true

# Preserve existing config/db if upgrading, otherwise extract fresh
HAS_CONF=0
if [[ -f "${RD_API_DIR}/conf/config.yaml" ]]; then
  HAS_CONF=1
  cp -a "${RD_API_DIR}/conf/config.yaml" "${RD_API_DIR}/conf/config.yaml.bak"
fi

tar -xzf "$ARCHIVE" -C "${RD_API_DIR}" --strip-components=2
chmod +x "${RD_API_DIR}/apimain"

if [[ "$HAS_CONF" -eq 1 ]]; then
  cp -a "${RD_API_DIR}/conf/config.yaml.bak" "${RD_API_DIR}/conf/config.yaml"
fi

python3 - <<'PYEOF'
import os, secrets
from pathlib import Path

cfg_path = Path("/opt/silkwarp/rustdesk-api/conf/config.yaml")
lines = cfg_path.read_text(encoding="utf-8").splitlines()
pub_key = os.environ.get("RUSTDESK_PUBLIC_KEY", "").strip()
sig_host = os.environ["SILKWARP_SIGNALING_HOST"].strip()
relay_host = os.environ["SILKWARP_RELAY_HOST"].strip()
hbbs_port = os.environ["SILKWARP_RUSTDESK_HBBS_PORT"].strip()
hbbr_port = os.environ["SILKWARP_RUSTDESK_HBBR_PORT"].strip()
api_url = os.environ["SILKWARP_RUSTDESK_API_URL"].strip()
jwt_secret = secrets.token_urlsafe(24)[:32]

section = ""
out = []
for line in lines:
    stripped = line.strip()
    if line and not line.startswith(" ") and not stripped.startswith("#") and stripped.endswith(":"):
        section = stripped[:-1]
    if section == "gin":
        if stripped.startswith("api-addr:"):
            line = '  api-addr: "127.0.0.1:21114"'
        elif stripped.startswith("trust-proxy:"):
            line = '  trust-proxy: "127.0.0.1"'
    elif section == "rustdesk":
        if stripped.startswith("id-server:"):
            line = f'  id-server: "{sig_host}:{hbbs_port}"'
        elif stripped.startswith("relay-server:"):
            line = f'  relay-server: "{relay_host}:{hbbr_port}"'
        elif stripped.startswith("api-server:"):
            line = f'  api-server: "{api_url}"'
        elif stripped.startswith("key:"):
            line = f'  key: "{pub_key}"'
        elif stripped.startswith("key-file:"):
            line = '  key-file: "/opt/silkwarp/rustdesk/id_ed25519.pub"'
    elif section == "jwt":
        if stripped.startswith("key:") and ('""' in stripped or "''" in stripped):
            line = f'  key: "{jwt_secret}"'
    out.append(line)

cfg_path.write_text("\n".join(out) + "\n", encoding="utf-8")
PYEOF
chmod 600 "${RD_API_DIR}/conf/config.yaml"

cat >/etc/systemd/system/silkwarp-rustdesk-api.service <<EOF
[Unit]
Description=SilkWarp RustDesk API Server (lejianwen/rustdesk-api)
After=network-online.target silkwarp-rustdesk-hbbs.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${RD_API_DIR}
ExecStart=${RD_API_DIR}/apimain
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

cat >"$NGINX_CONF" <<EOF
server {
    listen ${SILKWARP_RUSTDESK_API_PORT} ssl;
    listen [::]:${SILKWARP_RUSTDESK_API_PORT} ssl;
    http2 on;
    server_name ${SILKWARP_DOMAIN};

    ssl_certificate ${SILKWARP_SSL_CERT};
    ssl_certificate_key ${SILKWARP_SSL_KEY};

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    location / {
        proxy_pass http://127.0.0.1:21114;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF

ln -sf "$NGINX_CONF" "$NGINX_LINK"
nginx -t
systemctl daemon-reload
systemctl enable --now silkwarp-rustdesk-api.service
systemctl reload nginx

sleep 3
systemctl is-active silkwarp-rustdesk-api.service nginx
echo "--- RUSTDESK API JOURNAL ---"
journalctl -u silkwarp-rustdesk-api.service -n 25 --no-pager || true
echo "--- LOCAL VERIFY ---"
curl -sI http://127.0.0.1:21114/_admin/ | head -n 5 || true
curl -skI -H "Host: ${SILKWARP_DOMAIN}" "https://127.0.0.1:${SILKWARP_RUSTDESK_API_PORT}/_admin/" | head -n 5 || true
free -m
