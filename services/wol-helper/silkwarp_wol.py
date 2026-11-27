#!/usr/bin/env python3
"""SilkWarp Wake-on-LAN & Mesh Status Helper.

Zero-dependency HTTP service intended to bind strictly to the relay node EasyTier mesh IP
(e.g., 10.144.0.1:9580) and dispatch authenticated Wake-on-LAN magic packets to
physical controlled hosts on the home LAN.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import re
import shutil
import socket
import subprocess
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
LOGGER = logging.getLogger("silkwarp-wol")

MAC_RE = re.compile(r"^[0-9a-fA-F]{12}$")

HTML_PAGE = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>SilkWarp WOL Gateway</title>
  <style>
    :root {
      --bg: #0f1117;
      --card: #181c26;
      --border: #2a3142;
      --text: #e6edf3;
      --muted: #8b949e;
      --accent: #3b82f6;
      --ok: #10b981;
      --err: #ef4444;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; font-family: system-ui, -apple-system, sans-serif;
      background: var(--bg); color: var(--text);
      display: flex; justify-content: center; padding: 32px 16px;
    }
    .wrap { width: 100%; max-width: 680px; }
    h1 { font-size: 1.35rem; margin: 0 0 6px; }
    p.sub { color: var(--muted); font-size: 0.9rem; margin: 0 0 20px; }
    .bar { display: flex; gap: 8px; margin-bottom: 16px; }
    input {
      flex: 1; padding: 10px 12px; border-radius: 8px;
      border: 1px solid var(--border); background: var(--card); color: var(--text);
    }
    button {
      padding: 10px 16px; border-radius: 8px; border: 0;
      background: var(--accent); color: #fff; font-weight: 600; cursor: pointer;
    }
    button:hover { opacity: 0.92; }
    .list { display: grid; gap: 10px; }
    .item {
      display: flex; justify-content: space-between; align-items: center;
      padding: 14px 16px; background: var(--card);
      border: 1px solid var(--border); border-radius: 10px;
    }
    .meta { font-size: 0.82rem; color: var(--muted); margin-top: 4px; }
    .msg { min-height: 22px; font-size: 0.88rem; margin-bottom: 12px; }
    .ok { color: var(--ok); }
    .err { color: var(--err); }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>SilkWarp 远程唤醒控制台</h1>
    <p class="sub">仅限 EasyTier 内网访问 · 发送局域网 Wake-on-LAN 魔术包</p>
    <div class="bar">
      <input id="token" type="password" placeholder="输入 SILKWARP_WOL_TOKEN" />
      <button onclick="loadDevices()">刷新设备</button>
    </div>
    <div id="msg" class="msg"></div>
    <div id="list" class="list"></div>
  </div>
  <script>
    const tokenEl = document.getElementById('token');
    tokenEl.value = sessionStorage.getItem('silkwarp_wol_token') || '';
    function setMsg(text, ok) {
      const el = document.getElementById('msg');
      el.textContent = text;
      el.className = 'msg ' + (ok ? 'ok' : 'err');
    }
    async function loadDevices() {
      const tok = tokenEl.value.trim();
      sessionStorage.setItem('silkwarp_wol_token', tok);
      const res = await fetch('/api/devices', { headers: { 'X-SilkWarp-Token': tok } });
      if (!res.ok) {
        setMsg('认证失败或读取设备列表出错 (' + res.status + ')', false);
        document.getElementById('list').innerHTML = '';
        return;
      }
      const data = await res.json();
      setMsg('已加载 ' + data.devices.length + ' 台设备', true);
      const list = document.getElementById('list');
      list.innerHTML = '';
      for (const d of data.devices) {
        const div = document.createElement('div');
        div.className = 'item';
        div.innerHTML = '<div><strong>' + escapeHtml(d.name) + '</strong>' +
          '<div class="meta">MAC: ' + escapeHtml(d.mac) +
          (d.mesh_ip ? ' · Mesh: ' + escapeHtml(d.mesh_ip) : '') +
          (d.notes ? ' · ' + escapeHtml(d.notes) : '') +
          '</div></div>';
        const btn = document.createElement('button');
        btn.textContent = '唤醒开机';
        btn.onclick = () => wakeDevice(d.name);
        div.appendChild(btn);
        list.appendChild(div);
      }
    }
    async function wakeDevice(name) {
      const tok = tokenEl.value.trim();
      const res = await fetch('/api/wake/' + encodeURIComponent(name), {
        method: 'POST',
        headers: { 'X-SilkWarp-Token': tok }
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        setMsg('已向 ' + name + ' 发送 WOL 魔术包', true);
      } else {
        setMsg('唤醒失败: ' + (body.error || res.status), false);
      }
    }
    function escapeHtml(str) {
      return String(str || '').replace(/[&<>"']/g, s => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
      }[s]));
    }
    if (tokenEl.value) loadDevices();
  </script>
</body>
</html>
"""


def normalize_mac(mac: str) -> bytes:
    """Validate a MAC address string and return its 6 raw bytes."""
    cleaned = re.sub(r"[:\-.]", "", mac.strip())
    if not MAC_RE.match(cleaned):
        raise ValueError(f"Invalid MAC address: {mac!r}")
    return bytes.fromhex(cleaned)


def build_magic_packet(mac: str) -> bytes:
    """Build a standard 102-byte Wake-on-LAN magic packet."""
    mac_bytes = normalize_mac(mac)
    return b"\xff" * 6 + mac_bytes * 16


def send_wol(mac: str, broadcast_ip: str = "255.255.255.255", iface: str | None = None) -> list[str]:
    """Send WOL magic packet via UDP broadcast and optional etherwake."""
    packet = build_magic_packet(mac)
    methods: list[str] = []

    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        for port in (9, 7):
            sock.sendto(packet, (broadcast_ip, port))
        methods.append(f"udp:{broadcast_ip}:9,7")

    etherwake_bin = shutil.which("etherwake")
    if etherwake_bin and iface:
        subprocess.run([etherwake_bin, "-i", iface, mac], check=True)
        methods.append(f"etherwake:{iface}")
    return methods


def load_devices(devices_path: Path) -> list[dict[str, Any]]:
    """Read device definitions from JSON file."""
    if not devices_path.exists():
        return []
    raw = json.loads(devices_path.read_text(encoding="utf-8"))
    if isinstance(raw, dict):
        items = raw.get("devices", [])
    elif isinstance(raw, list):
        items = raw
    else:
        raise ValueError("devices.json must contain a list or {'devices': [...]}")
    return [d for d in items if isinstance(d, dict) and d.get("name") and d.get("mac")]


class WolHandler(BaseHTTPRequestHandler):
    """HTTP handler for SilkWarp WOL gateway."""

    server_version = "SilkWarpWOL/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        LOGGER.info("%s - %s", self.client_address[0], format % args)

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _is_authorized(self) -> bool:
        expected: str = self.server.wol_token  # type: ignore[attr-defined]
        provided = self.headers.get("X-SilkWarp-Token", "").strip()
        if not provided:
            auth = self.headers.get("Authorization", "")
            if auth.lower().startswith("bearer "):
                provided = auth[7:].strip()
        return bool(expected) and hmac.compare_digest(provided, expected)

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        devices_path: Path = self.server.devices_path  # type: ignore[attr-defined]

        if path == "/health":
            try:
                count = len(load_devices(devices_path))
            except Exception as exc:
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"status": "error", "error": str(exc)})
                return
            self._send_json(HTTPStatus.OK, {"status": "ok", "devices": count})
            return

        if path == "/":
            body = HTML_PAGE.encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/api/devices":
            if not self._is_authorized():
                self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                return
            try:
                devices = load_devices(devices_path)
            except Exception as exc:
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})
                return
            self._send_json(HTTPStatus.OK, {"devices": devices})
            return

        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def _read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0 or length > 65536:
            raise ValueError("invalid_content_length")
        raw = self.rfile.read(length)
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("json_object_required")
        return data

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        default_bcast: str = self.server.default_broadcast  # type: ignore[attr-defined]
        default_iface: str | None = self.server.default_iface  # type: ignore[attr-defined]

        if path == "/api/wake-mac":
            if not self._is_authorized():
                self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                return
            try:
                body = self._read_json_body()
            except Exception as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": f"invalid_json: {exc}"})
                return
            mac = str(body.get("mac") or "").strip()
            if not mac:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "missing_mac"})
                return
            bcast = str(body.get("broadcast") or default_bcast).strip()
            iface = body.get("iface") or default_iface
            try:
                methods = send_wol(mac, broadcast_ip=bcast, iface=iface)
            except ValueError as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return
            except Exception as exc:
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})
                return
            LOGGER.info("Dispatched WOL by MAC (%s) via %s", mac, methods)
            self._send_json(HTTPStatus.OK, {"status": "sent", "mac": mac, "methods": methods})
            return

        if not path.startswith("/api/wake/"):
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return

        if not self._is_authorized():
            self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return

        target_name = unquote(path.removeprefix("/api/wake/").strip("/"))
        if not target_name:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "missing_device_name"})
            return

        devices_path: Path = self.server.devices_path  # type: ignore[attr-defined]

        try:
            devices = load_devices(devices_path)
        except Exception as exc:
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})
            return

        match = next((d for d in devices if d.get("name") == target_name), None)
        if not match:
            self._send_json(HTTPStatus.NOT_FOUND, {"error": f"device_not_found: {target_name}"})
            return

        bcast = str(match.get("broadcast") or default_bcast)
        iface = match.get("iface") or default_iface
        try:
            methods = send_wol(str(match["mac"]), broadcast_ip=bcast, iface=iface)
        except ValueError as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        except Exception as exc:
            self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})
            return

        LOGGER.info("Dispatched WOL for %s (%s) via %s", target_name, match["mac"], methods)
        self._send_json(HTTPStatus.OK, {"status": "sent", "device": target_name, "methods": methods})


class WolServer(ThreadingHTTPServer):
    """Typed ThreadingHTTPServer holding runtime configuration."""

    allow_reuse_address = True

    def __init__(
        self,
        server_address: tuple[str, int],
        wol_token: str,
        devices_path: Path,
        default_broadcast: str,
        default_iface: str | None,
    ) -> None:
        self.wol_token = wol_token
        self.devices_path = devices_path
        self.default_broadcast = default_broadcast
        self.default_iface = default_iface
        super().__init__(server_address, WolHandler)


def main() -> None:
    bind_ip = os.environ.get("SILKWARP_WOL_BIND", "10.144.0.1")
    port = int(os.environ.get("SILKWARP_WOL_PORT", "9580"))
    token = os.environ.get("SILKWARP_WOL_TOKEN", "").strip()
    if not token:
        raise SystemExit("SILKWARP_WOL_TOKEN must be set before starting silkwarp_wol.py")

    devices_path = Path(os.environ.get("SILKWARP_WOL_DEVICES", "/opt/silkwarp/wol/devices.json"))
    default_broadcast = os.environ.get("SILKWARP_WOL_BROADCAST", "255.255.255.255")
    default_iface = os.environ.get("SILKWARP_WOL_IFACE") or None

    server = WolServer((bind_ip, port), token, devices_path, default_broadcast, default_iface)
    LOGGER.info("SilkWarp WOL Gateway listening on http://%s:%d (devices=%s)", bind_ip, port, devices_path)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
