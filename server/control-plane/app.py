#!/usr/bin/env python3
"""SilkWarp Control Plane API & Web Companion Server.

Zero-dependency Python 3.13 HTTP server backed by SQLite WAL.
Designed to sit behind Nginx (e.g. https://silkwarp.example.com/silkwarp/ -> 127.0.0.1:18800).
"""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import signal
import sqlite3
import threading
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from db import Database

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
LOGGER = logging.getLogger("silkwarp-control-plane")

STATIC_DIR = Path(__file__).resolve().parent / "static"
DEFAULT_CONFIG_PATH = Path(__file__).resolve().parents[2] / "silkwarp.config.json"


def _load_json_config() -> dict[str, Any]:
    """Load optional external JSON config (SILKWARP_CONFIG_FILE or repo-root silkwarp.config.json)."""
    raw_path = os.environ.get("SILKWARP_CONFIG_FILE", "").strip()
    candidate = Path(raw_path) if raw_path else DEFAULT_CONFIG_PATH
    if not candidate.is_file():
        return {}
    try:
        data = json.loads(candidate.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception as exc:
        LOGGER.warning("Ignoring unreadable config file %s: %s", candidate, exc)
        return {}


@dataclass(frozen=True)
class ControlPlaneConfig:
    """Runtime configuration loaded from environment variables with optional JSON fallback."""

    bind_host: str
    bind_port: int
    db_path: Path
    admin_user: str
    admin_password: str
    signaling_host: str
    relay_host: str
    easytier_coord_port: int
    easytier_relay_port: int
    rustdesk_hbbs_port: int
    rustdesk_hbbr_port: int
    rustdesk_public_key: str
    rustdesk_api_url: str
    mesh_cidr: str
    relay_mesh_ip: str
    network_name: str
    network_secret: str
    wol_port: int
    wol_token: str
    api_url: str

    @classmethod
    def from_env(cls) -> "ControlPlaneConfig":
        json_cfg = _load_json_config()

        def pick_str(env_key: str, json_key: str, default: str) -> str:
            env_val = os.environ.get(env_key)
            if env_val is not None and env_val.strip():
                return env_val.strip()
            cfg_val = json_cfg.get(json_key)
            if isinstance(cfg_val, str) and cfg_val.strip():
                return cfg_val.strip()
            return default

        def pick_int(env_key: str, json_key: str, default: int) -> int:
            env_val = os.environ.get(env_key)
            if env_val is not None and env_val.strip():
                return int(env_val.strip())
            cfg_val = json_cfg.get(json_key)
            if isinstance(cfg_val, (int, str)) and str(cfg_val).strip():
                return int(str(cfg_val).strip())
            return default

        return cls(
            bind_host=os.environ.get("SILKWARP_CP_BIND", "127.0.0.1"),
            bind_port=int(os.environ.get("SILKWARP_CP_PORT", "18800")),
            db_path=Path(os.environ.get("SILKWARP_CP_DB", "/opt/silkwarp/control-plane/data/silkwarp.db")),
            admin_user=os.environ.get("SILKWARP_ADMIN_USER", "admin").strip() or "admin",
            admin_password=os.environ.get("SILKWARP_ADMIN_PASSWORD", "").strip(),
            signaling_host=pick_str("SILKWARP_SIGNALING_HOST", "signalingHost", "signaling.example.com"),
            relay_host=pick_str("SILKWARP_RELAY_HOST", "relayHost", "relay.example.com"),
            easytier_coord_port=pick_int("SILKWARP_EASYTIER_COORD_PORT", "easytierCoordPort", 11010),
            easytier_relay_port=pick_int("SILKWARP_EASYTIER_RELAY_PORT", "easytierRelayPort", 11011),
            rustdesk_hbbs_port=pick_int("SILKWARP_RUSTDESK_HBBS_PORT", "rustdeskHbbsPort", 21116),
            rustdesk_hbbr_port=pick_int("SILKWARP_RUSTDESK_HBBR_PORT", "rustdeskHbbrPort", 21117),
            rustdesk_public_key=os.environ.get("RUSTDESK_PUBLIC_KEY", "").strip(),
            rustdesk_api_url=pick_str("SILKWARP_RUSTDESK_API_URL", "rustdeskApiUrl", "https://silkwarp.example.com:21114"),
            mesh_cidr=pick_str("SILKWARP_MESH_CIDR", "meshCidr", "10.144.0.0/24"),
            relay_mesh_ip=pick_str("SILKWARP_RELAY_MESH_IP", "relayMeshIp", "10.144.0.1"),
            network_name=pick_str("SILKWARP_NETWORK_NAME", "networkName", "silkwarp-team"),
            network_secret=os.environ.get("SILKWARP_NETWORK_SECRET", "").strip(),
            wol_port=pick_int("SILKWARP_WOL_PORT", "wolPort", 9580),
            wol_token=os.environ.get("SILKWARP_WOL_TOKEN", "").strip(),
            api_url=pick_str("SILKWARP_API_URL", "apiUrl", "https://silkwarp.example.com/silkwarp"),
        )


def build_bootstrap_payload(cfg: ControlPlaneConfig, device: dict[str, Any]) -> dict[str, Any]:
    """Assemble zero-config client bootstrap payload without printing secrets in logs."""
    return {
        "api_url": cfg.api_url,
        "mesh_ip": device["mesh_ip"],
        "mesh_cidr": cfg.mesh_cidr,
        "easytier": {
            "network_name": cfg.network_name,
            "network_secret": cfg.network_secret,
            "peers": [
                f"udp://{cfg.relay_host}:{cfg.easytier_relay_port}",
                f"tcp://{cfg.relay_host}:{cfg.easytier_relay_port}",
                f"udp://{cfg.signaling_host}:{cfg.easytier_coord_port}",
                f"tcp://{cfg.signaling_host}:{cfg.easytier_coord_port}",
            ],
        },
        "rustdesk": {
            "id_server": cfg.signaling_host,
            "relay_server": f"{cfg.relay_host}:{cfg.rustdesk_hbbr_port}",
            "api_server": cfg.rustdesk_api_url,
            "public_key": cfg.rustdesk_public_key,
        },
        "wol": {
            "url": f"http://{cfg.relay_mesh_ip}:{cfg.wol_port}",
            "token": cfg.wol_token,
        },
        "device": device,
    }


class ControlPlaneServer(ThreadingHTTPServer):
    """Typed HTTP server holding DB and config references."""

    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 64

    def __init__(
        self,
        server_address: tuple[str, int],
        db: Database,
        cfg: ControlPlaneConfig,
        static_dir: Path = STATIC_DIR,
    ) -> None:
        self.db = db
        self.cfg = cfg
        self.static_dir = static_dir
        super().__init__(server_address, ControlPlaneHandler)


class ControlPlaneHandler(BaseHTTPRequestHandler):
    """HTTP request handler for SilkWarp Control Plane API and static web UI."""

    server_version = "SilkWarpControlPlane/1.0"
    timeout = 15

    def log_message(self, format: str, *args: Any) -> None:
        LOGGER.info("%s - %s", self.client_address[0], format % args)

    @property
    def db(self) -> Database:
        return self.server.db  # type: ignore[attr-defined]

    @property
    def cfg(self) -> ControlPlaneConfig:
        return self.server.cfg  # type: ignore[attr-defined]

    @property
    def static_dir(self) -> Path:
        return self.server.static_dir  # type: ignore[attr-defined]

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0 or length > 262_144:
            raise ValueError("invalid_content_length")
        raw = self.rfile.read(length)
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("json_object_required")
        return data

    def _extract_token(self) -> str:
        auth = self.headers.get("Authorization", "")
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
        return self.headers.get("X-SilkWarp-Session", "").strip()

    def _require_user(self) -> dict[str, Any] | None:
        user = self.db.get_user_by_token(self._extract_token())
        if not user:
            self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return None
        return user

    def _require_admin(self) -> dict[str, Any] | None:
        user = self._require_user()
        if not user:
            return None
        if user["role"] != "admin":
            self._send_json(HTTPStatus.FORBIDDEN, {"error": "admin_required"})
            return None
        return user

    def _serve_static(self, req_path: str) -> None:
        rel = req_path.lstrip("/") or "index.html"
        static_root = self.static_dir.resolve()
        target = (static_root / rel).resolve()
        if not target.is_relative_to(static_root) or not target.is_file():
            target = static_root / "index.html"
        if not target.is_file():
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "static_not_found"})
            return
        mime, _ = mimetypes.guess_type(str(target))
        content = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{mime or 'text/html'}; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/health":
            self._send_json(HTTPStatus.OK, {"status": "ok", "version": "1.0.0", **self.db.counts()})
            return

        if path == "/api/auth/me":
            user = self._require_user()
            if user:
                self._send_json(HTTPStatus.OK, {"user": user})
            return

        if path == "/api/bootstrap/config":
            user = self._require_user()
            if not user:
                return
            qs = parse_qs(parsed.query)
            device_id = (qs.get("device_id", [""])[0]).strip()
            name = (qs.get("name", ["SilkWarp-Node"])[0]).strip()
            os_name = (qs.get("os", ["windows"])[0]).strip()
            existing = self.db.get_device(device_id) if device_id else None
            if existing and existing["owner_user_id"] != user["id"] and user["role"] != "admin":
                self._send_json(HTTPStatus.FORBIDDEN, {"error": "device_owned_by_other_user"})
                return
            device = self.db.ensure_device(user["id"], device_id, name, os_name)
            self._send_json(HTTPStatus.OK, build_bootstrap_payload(self.cfg, device))
            return

        if path == "/api/devices":
            user = self._require_user()
            if not user:
                return
            self._send_json(HTTPStatus.OK, {"devices": self.db.list_devices(user)})
            return

        if path.startswith("/api/devices/") and path.endswith("/pending-pairs"):
            user = self._require_user()
            if not user:
                return
            dev_id = path.removeprefix("/api/devices/").removesuffix("/pending-pairs").strip("/")
            dev = self.db.get_device(dev_id)
            if not dev:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "device_not_found"})
                return
            if dev["owner_user_id"] != user["id"] and user["role"] != "admin":
                self._send_json(HTTPStatus.FORBIDDEN, {"error": "forbidden"})
                return
            self._send_json(HTTPStatus.OK, {"pending_pairs": self.db.get_pending_pairs(dev_id)})
            return

        if path.startswith("/api/pair-requests/"):
            user = self._require_user()
            if not user:
                return
            req_id = path.removeprefix("/api/pair-requests/").strip("/")
            pr = self.db.get_pair_request(req_id)
            if not pr:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "pair_request_not_found"})
                return
            self._send_json(HTTPStatus.OK, {"pair_request": pr})
            return

        if path == "/api/admin/users":
            admin = self._require_admin()
            if not admin:
                return
            self._send_json(HTTPStatus.OK, {"users": self.db.list_users()})
            return

        if path.startswith("/api/"):
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return

        self._serve_static(path)

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path

        if path == "/api/auth/login":
            try:
                body = self._read_json()
            except Exception as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": f"invalid_json: {exc}"})
                return
            user = self.db.authenticate_user(str(body.get("username") or ""), str(body.get("password") or ""))
            if not user:
                self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "用户名或密码错误，或账号已被禁用"})
                return
            token, expires_at = self.db.create_session(user["id"], str(body.get("device_id") or ""))
            self._send_json(HTTPStatus.OK, {"token": token, "expires_at": expires_at, "user": user})
            return

        if path == "/api/auth/logout":
            self.db.revoke_token(self._extract_token())
            self._send_json(HTTPStatus.OK, {"ok": True})
            return

        if path == "/api/auth/change-password":
            user = self._require_user()
            if not user:
                return
            try:
                body = self._read_json()
                cur_pw = str(body.get("current_password") or "")
                new_pw = str(body.get("new_password") or "")
                ok = self.db.change_password(user["id"], cur_pw, new_pw)
            except ValueError as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return
            except Exception as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return
            if not ok:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "原密码不正确"})
                return
            self._send_json(HTTPStatus.OK, {"ok": True})
            return

        if path == "/api/devices/heartbeat":
            user = self._require_user()
            if not user:
                return
            try:
                body = self._read_json()
                device, pending = self.db.heartbeat_device(user, body)
            except PermissionError as exc:
                self._send_json(HTTPStatus.FORBIDDEN, {"error": str(exc)})
                return
            except Exception as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return
            self._send_json(HTTPStatus.OK, {"ok": True, "device": device, "pending_pairs": pending})
            return

        if path.startswith("/api/devices/") and path.endswith("/pair-request"):
            user = self._require_user()
            if not user:
                return
            host_id = path.removeprefix("/api/devices/").removesuffix("/pair-request").strip("/")
            dev = self.db.get_device(host_id)
            if not dev:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "device_not_found"})
                return
            if dev["visibility"] == "private" and dev["owner_user_id"] != user["id"] and user["role"] != "admin":
                self._send_json(HTTPStatus.FORBIDDEN, {"error": "forbidden"})
                return
            try:
                body = self._read_json()
                pr = self.db.create_pair_request(
                    host_id,
                    str(body.get("client_device_id") or ""),
                    str(body.get("client_name") or user["display_name"]),
                    str(body.get("pin") or ""),
                )
            except Exception as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return
            self._send_json(HTTPStatus.CREATED, {"pair_request": pr})
            return

        if path.startswith("/api/pair-requests/") and path.endswith("/resolve"):
            user = self._require_user()
            if not user:
                return
            req_id = path.removeprefix("/api/pair-requests/").removesuffix("/resolve").strip("/")
            pr = self.db.get_pair_request(req_id)
            if not pr:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "pair_request_not_found"})
                return
            host_dev = self.db.get_device(pr["host_device_id"])
            if not host_dev or (host_dev["owner_user_id"] != user["id"] and user["role"] != "admin"):
                self._send_json(HTTPStatus.FORBIDDEN, {"error": "forbidden"})
                return
            try:
                body = self._read_json()
                resolved = self.db.resolve_pair_request(
                    req_id,
                    str(body.get("status") or ""),
                    str(body.get("message") or ""),
                )
            except Exception as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return
            self._send_json(HTTPStatus.OK, {"pair_request": resolved})
            return

        if path == "/api/admin/users":
            admin = self._require_admin()
            if not admin:
                return
            try:
                body = self._read_json()
                created = self.db.create_user(
                    str(body.get("username") or ""),
                    str(body.get("display_name") or ""),
                    str(body.get("password") or ""),
                    str(body.get("role") or "member"),
                )
            except sqlite3.IntegrityError:
                self._send_json(HTTPStatus.CONFLICT, {"error": "用户名已存在"})
                return
            except Exception as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return
            self._send_json(HTTPStatus.CREATED, {"user": created})
            return

        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def do_PATCH(self) -> None:  # noqa: N802
        path = urlparse(self.path).path

        if path.startswith("/api/devices/"):
            user = self._require_user()
            if not user:
                return
            dev_id = path.removeprefix("/api/devices/").strip("/")
            dev = self.db.get_device(dev_id)
            if not dev:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "device_not_found"})
                return
            if dev["owner_user_id"] != user["id"] and user["role"] != "admin":
                self._send_json(HTTPStatus.FORBIDDEN, {"error": "forbidden"})
                return
            try:
                body = self._read_json()
                updated = self.db.update_device(dev_id, body)
            except Exception as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return
            self._send_json(HTTPStatus.OK, {"device": updated})
            return

        if path.startswith("/api/admin/users/"):
            admin = self._require_admin()
            if not admin:
                return
            uid = path.removeprefix("/api/admin/users/").strip("/")
            try:
                body = self._read_json()
                updated = self.db.update_user(
                    uid,
                    display_name=body.get("display_name"),
                    role=body.get("role"),
                    enabled=body.get("enabled"),
                    password=body.get("password"),
                )
            except Exception as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return
            if not updated:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "user_not_found"})
                return
            self._send_json(HTTPStatus.OK, {"user": updated})
            return

        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})

    def do_DELETE(self) -> None:  # noqa: N802
        path = urlparse(self.path).path

        if path.startswith("/api/devices/"):
            user = self._require_user()
            if not user:
                return
            dev_id = path.removeprefix("/api/devices/").strip("/")
            dev = self.db.get_device(dev_id)
            if not dev:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "device_not_found"})
                return
            if dev["owner_user_id"] != user["id"] and user["role"] != "admin":
                self._send_json(HTTPStatus.FORBIDDEN, {"error": "forbidden"})
                return
            self.db.delete_device(dev_id)
            self._send_json(HTTPStatus.OK, {"ok": True})
            return

        if path.startswith("/api/admin/users/"):
            admin = self._require_admin()
            if not admin:
                return
            uid = path.removeprefix("/api/admin/users/").strip("/")
            if uid == admin["id"]:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "不能删除当前登录管理员"})
                return
            if not self.db.delete_user(uid):
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "user_not_found"})
                return
            self._send_json(HTTPStatus.OK, {"ok": True})
            return

        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})


def create_server(cfg: ControlPlaneConfig) -> ControlPlaneServer:
    """Initialize DB, ensure admin exists, and construct ControlPlaneServer."""
    if not cfg.admin_password:
        raise SystemExit("SILKWARP_ADMIN_PASSWORD must be set.")
    db = Database(cfg.db_path)
    db.ensure_admin(cfg.admin_user, cfg.admin_password)
    return ControlPlaneServer((cfg.bind_host, cfg.bind_port), db, cfg)


def main() -> None:
    cfg = ControlPlaneConfig.from_env()
    server = create_server(cfg)

    def _handle_sigterm(_signum: int, _frame: Any) -> None:
        LOGGER.info("Received SIGTERM, shutting down gracefully...")
        threading.Thread(target=server.shutdown, daemon=True).start()

    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _handle_sigterm)

    LOGGER.info("SilkWarp Control Plane listening on http://%s:%d", cfg.bind_host, cfg.bind_port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        server.db.close()


if __name__ == "__main__":
    main()
