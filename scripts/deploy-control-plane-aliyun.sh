#!/usr/bin/env bash
set -euo pipefail

# SilkWarp Control Plane & Web Companion Deployment
# Expects env vars from /opt/silkwarp/control-plane/control.env (or SILKWARP_ENV_FILE)

CP_DIR="/opt/silkwarp/control-plane"
ENV_FILE="${SILKWARP_ENV_FILE:-${CP_DIR}/control.env}"
NGINX_SNIPPET="/etc/nginx/snippets/silkwarp.conf"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: Run as root." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: Missing $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

SILKWARP_CP_PORT="${SILKWARP_CP_PORT:-18800}"
SILKWARP_CP_PATH="${SILKWARP_CP_PATH:-/silkwarp}"
CP_PATH="/${SILKWARP_CP_PATH#/}"
CP_PATH="${CP_PATH%/}"
SILKWARP_NGINX_SITE="${SILKWARP_NGINX_SITE:-}"
SILKWARP_NGINX_ANCHOR="${SILKWARP_NGINX_ANCHOR:-}"

mkdir -p "${CP_DIR}/data" "${CP_DIR}/static"
chmod 700 "${CP_DIR}/data"
chmod 600 "$ENV_FILE"

cat >/etc/systemd/system/silkwarp-control-plane.service <<EOF
[Unit]
Description=SilkWarp Control Plane & Web Companion
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${CP_DIR}
EnvironmentFile=${ENV_FILE}
Environment=SILKWARP_CP_BIND=127.0.0.1
Environment=SILKWARP_CP_PORT=${SILKWARP_CP_PORT}
Environment=SILKWARP_CP_DB=${CP_DIR}/data/silkwarp.db
ExecStart=/usr/bin/python3 ${CP_DIR}/app.py
Restart=always
RestartSec=3
MemoryMax=256M
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
EOF

cat >"$NGINX_SNIPPET" <<EOF
# SilkWarp Control Plane & Web Companion (127.0.0.1:${SILKWARP_CP_PORT})
location = ${CP_PATH} {
    return 301 ${CP_PATH}/;
}

location ${CP_PATH}/ {
    proxy_pass http://127.0.0.1:${SILKWARP_CP_PORT}/;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-Prefix ${CP_PATH};
    proxy_read_timeout 60s;
}
EOF

if [[ -n "$SILKWARP_NGINX_SITE" && -f "$SILKWARP_NGINX_SITE" ]]; then
  if ! grep -q "snippets/silkwarp.conf" "$SILKWARP_NGINX_SITE"; then
    if [[ -n "$SILKWARP_NGINX_ANCHOR" ]] && grep -qF "$SILKWARP_NGINX_ANCHOR" "$SILKWARP_NGINX_SITE"; then
      BAK="${SILKWARP_NGINX_SITE}.bak.silkwarp-$(date +%Y%m%d%H%M%S)"
      cp -a "$SILKWARP_NGINX_SITE" "$BAK"
      SILKWARP_NGINX_SITE="$SILKWARP_NGINX_SITE" SILKWARP_NGINX_ANCHOR="$SILKWARP_NGINX_ANCHOR" python3 - <<'PYEOF'
import os
from pathlib import Path
site = Path(os.environ["SILKWARP_NGINX_SITE"])
anchor = os.environ["SILKWARP_NGINX_ANCHOR"]
text = site.read_text(encoding="utf-8")
assert anchor in text, f"Anchor {anchor!r} not found in {site}"
site.write_text(text.replace(anchor, anchor + "\n    include /etc/nginx/snippets/silkwarp.conf;", 1), encoding="utf-8")
PYEOF
      if ! nginx -t; then
        cp -a "$BAK" "$SILKWARP_NGINX_SITE"
        exit 1
      fi
    else
      echo "NOTE: Snippet written to ${NGINX_SNIPPET}. Add 'include ${NGINX_SNIPPET};' to your Nginx site ${SILKWARP_NGINX_SITE}."
      nginx -t
    fi
  else
    nginx -t
  fi
else
  echo "NOTE: Snippet written to ${NGINX_SNIPPET}. Include it inside your Nginx server {} block."
  nginx -t
fi

systemctl daemon-reload
systemctl enable --now silkwarp-control-plane.service
systemctl restart silkwarp-control-plane.service
systemctl reload nginx

sleep 1
systemctl is-active silkwarp-control-plane.service nginx
curl -fsS "http://127.0.0.1:${SILKWARP_CP_PORT}/api/health"
echo ""
