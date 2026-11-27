"""Unit & HTTP integration tests for SilkWarp Control Plane."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError
from urllib.request import Request, urlopen

CP_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CP_DIR))

from app import ControlPlaneConfig, create_server  # noqa: E402
from db import Database  # noqa: E402


class ControlPlaneTestCase(unittest.TestCase):
    """Verify auth, IP bootstrap, heartbeat, pair broker, and admin CRUD."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        cfg = ControlPlaneConfig(
            bind_host="127.0.0.1",
            bind_port=0,
            db_path=Path(self._tmp.name) / "test.db",
            admin_user="admin",
            admin_password="TestPassword123!",
            signaling_host="203.0.113.10",
            relay_host="relay.example.com",
            easytier_coord_port=11010,
            easytier_relay_port=11011,
            rustdesk_hbbs_port=21116,
            rustdesk_hbbr_port=21117,
            rustdesk_public_key="TEST_PUB_KEY=",
            rustdesk_api_url="https://silkwarp.example.com:21114",
            mesh_cidr="10.144.0.0/24",
            relay_mesh_ip="10.144.0.1",
            network_name="silkwarp-team",
            network_secret="secret-token",
            wol_port=9580,
            wol_token="wol-token",
            api_url="https://silkwarp.example.com/silkwarp",
        )
        self.server = create_server(cfg)
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self._thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.server.db.close()
        self._tmp.cleanup()

    def _req(self, path: str, method: str = "GET", body: dict | None = None, token: str = "") -> tuple[int, dict]:
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urlopen(req, timeout=5) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except HTTPError as err:
            return err.code, json.loads(err.read().decode("utf-8"))

    def test_full_control_plane_flow(self) -> None:
        # 1. Health & bad login
        code, health = self._req("/api/health")
        self.assertEqual(code, 200)
        self.assertEqual(health["status"], "ok")

        code, _ = self._req("/api/auth/login", "POST", {"username": "admin", "password": "wrong"})
        self.assertEqual(code, 401)

        # 2. Valid admin login
        code, login = self._req("/api/auth/login", "POST", {"username": "admin", "password": "TestPassword123!"})
        self.assertEqual(code, 200)
        admin_tok = login["token"]

        # 3. Bootstrap allocates persistent static Mesh IP (10.144.0.10+)
        code, boot1 = self._req("/api/bootstrap/config?device_id=host-1&name=GPU-PC&os=windows", token=admin_tok)
        self.assertEqual(code, 200)
        self.assertEqual(boot1["mesh_ip"], "10.144.0.10")
        self.assertEqual(boot1["easytier"]["network_name"], "silkwarp-team")
        # Stage 2 device metadata defaults to "no access password" + agent port 19580.
        self.assertIs(boot1["device"]["has_access_password"], False)
        self.assertEqual(boot1["device"]["agent_port"], 19580)

        code, boot1_again = self._req("/api/bootstrap/config?device_id=host-1&name=GPU-PC&os=windows", token=admin_tok)
        self.assertEqual(boot1_again["mesh_ip"], "10.144.0.10")

        # 4. Create member user, login, verify device visibility & pair broker
        code, created = self._req(
            "/api/admin/users",
            "POST",
            {"username": "alice", "display_name": "Alice", "password": "AlicePass99!"},
            token=admin_tok,
        )
        self.assertEqual(code, 201)
        alice_id = created["user"]["id"]

        code, alice_login = self._req("/api/auth/login", "POST", {"username": "alice", "password": "AlicePass99!"})
        self.assertEqual(code, 200)
        alice_tok = alice_login["token"]

        # Host sends heartbeat
        code, hb = self._req(
            "/api/devices/heartbeat",
            "POST",
            {
                "device_id": "host-1",
                "name": "GPU-4070TiS",
                "gpu": "RTX 4070 Ti Super",
                "mac_address": "aa:bb:cc:dd:ee:ff",
                "apollo_ready": True,
                "is_host": True,
                "route_type": "p2p",
                "latency_ms": 11.2,
            },
            token=admin_tok,
        )
        self.assertEqual(code, 200)
        self.assertEqual(hb["device"]["gpu"], "RTX 4070 Ti Super")
        self.assertIs(hb["device"]["has_access_password"], False)
        self.assertEqual(hb["device"]["agent_port"], 19580)

        # Host reports Stage 2 Host Agent metadata; values round-trip to clients.
        code, hb_secure = self._req(
            "/api/devices/heartbeat",
            "POST",
            {
                "device_id": "host-1",
                "is_host": True,
                "has_access_password": True,
                "agent_port": 19581,
            },
            token=admin_tok,
        )
        self.assertEqual(code, 200)
        self.assertIs(hb_secure["device"]["has_access_password"], True)
        self.assertEqual(hb_secure["device"]["agent_port"], 19581)

        # Heartbeats that omit the keys preserve the previously reported values.
        code, hb_preserved = self._req(
            "/api/devices/heartbeat",
            "POST",
            {"device_id": "host-1", "is_host": True},
            token=admin_tok,
        )
        self.assertEqual(code, 200)
        self.assertIs(hb_preserved["device"]["has_access_password"], True)
        self.assertEqual(hb_preserved["device"]["agent_port"], 19581)

        # Out-of-range agent ports are ignored instead of persisted.
        code, hb_bad_port = self._req(
            "/api/devices/heartbeat",
            "POST",
            {"device_id": "host-1", "agent_port": 80},
            token=admin_tok,
        )
        self.assertEqual(code, 200)
        self.assertEqual(hb_bad_port["device"]["agent_port"], 19581)

        # Devices listing exposes the same metadata for the client UI.
        code, dev_list = self._req("/api/devices", token=admin_tok)
        self.assertEqual(code, 200)
        listed = next(d for d in dev_list["devices"] if d["id"] == "host-1")
        self.assertIs(listed["has_access_password"], True)
        self.assertEqual(listed["agent_port"], 19581)

        # Reset the flag to False for the remaining pair-broker assertions.
        code, hb_reset = self._req(
            "/api/devices/heartbeat",
            "POST",
            {"device_id": "host-1", "has_access_password": False, "agent_port": 19580},
            token=admin_tok,
        )
        self.assertEqual(code, 200)
        self.assertIs(hb_reset["device"]["has_access_password"], False)
        self.assertEqual(hb_reset["device"]["agent_port"], 19580)

        # Alice creates pair request against host-1
        code, pr_resp = self._req(
            "/api/devices/host-1/pair-request",
            "POST",
            {"pin": "4829", "client_device_id": "laptop-1", "client_name": "Alice-Mac"},
            token=alice_tok,
        )
        self.assertEqual(code, 201)
        req_id = pr_resp["pair_request"]["id"]

        # Zero-write fast poll checks owner authorization and returns pending pair
        code, _ = self._req("/api/devices/host-1/pending-pairs", token=alice_tok)
        self.assertEqual(code, 403)
        code, pp_resp = self._req("/api/devices/host-1/pending-pairs", token=admin_tok)
        self.assertEqual(code, 200)
        self.assertEqual(len(pp_resp["pending_pairs"]), 1)
        self.assertEqual(pp_resp["pending_pairs"][0]["pin"], "4829")

        # Host heartbeat picks up pending pair request and resolves it
        code, hb2 = self._req("/api/devices/heartbeat", "POST", {"device_id": "host-1", "is_host": True}, token=admin_tok)
        self.assertEqual(len(hb2["pending_pairs"]), 1)
        self.assertEqual(hb2["pending_pairs"][0]["pin"], "4829")

        code, res_resp = self._req(f"/api/pair-requests/{req_id}/resolve", "POST", {"status": "approved"}, token=admin_tok)
        self.assertEqual(code, 200)
        self.assertEqual(res_resp["pair_request"]["status"], "approved")

        # Alice polls status
        code, poll_resp = self._req(f"/api/pair-requests/{req_id}", token=alice_tok)
        self.assertEqual(poll_resp["pair_request"]["status"], "approved")

        # Disable alice and verify token rejected
        code, _ = self._req(f"/api/admin/users/{alice_id}", "PATCH", {"enabled": False}, token=admin_tok)
        self.assertEqual(code, 200)
        code, _ = self._req("/api/auth/me", token=alice_tok)
        self.assertEqual(code, 401)

    def test_config_loads_from_json_and_env_overrides(self) -> None:
        cfg_file = Path(self._tmp.name) / "custom.config.json"
        cfg_file.write_text(
            json.dumps(
                {
                    "apiUrl": "https://json.example.com/silkwarp",
                    "signalingHost": "198.51.100.20",
                    "relayHost": "json-relay.example.com",
                    "easytierCoordPort": 12010,
                    "easytierRelayPort": 12011,
                    "rustdeskHbbsPort": 22116,
                    "rustdeskHbbrPort": 22117,
                    "rustdeskApiUrl": "https://json.example.com:22114",
                    "wolPort": 19001,
                    "networkName": "json-net",
                }
            ),
            encoding="utf-8",
        )
        with mock.patch.dict(
            os.environ,
            {
                "SILKWARP_CONFIG_FILE": str(cfg_file),
                "SILKWARP_RELAY_HOST": "env-relay.example.com",
                "SILKWARP_WOL_PORT": "19002",
            },
            clear=False,
        ):
            loaded = ControlPlaneConfig.from_env()
        self.assertEqual(loaded.api_url, "https://json.example.com/silkwarp")
        self.assertEqual(loaded.signaling_host, "198.51.100.20")
        self.assertEqual(loaded.relay_host, "env-relay.example.com")
        self.assertEqual(loaded.easytier_relay_port, 12011)
        self.assertEqual(loaded.rustdesk_hbbr_port, 22117)
        self.assertEqual(loaded.wol_port, 19002)
        self.assertEqual(loaded.network_name, "json-net")

    def test_legacy_devices_table_is_migrated_idempotently(self) -> None:
        """Pre-Stage-2 databases gain has_access_password/agent_port on open."""
        import sqlite3

        legacy_path = Path(self._tmp.name) / "legacy.db"
        legacy = sqlite3.connect(str(legacy_path))
        legacy.executescript(
            """
            CREATE TABLE users (
                id TEXT PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                display_name TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'member',
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );
            CREATE TABLE devices (
                id TEXT PRIMARY KEY,
                owner_user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                os TEXT NOT NULL DEFAULT 'windows',
                mesh_ip TEXT UNIQUE NOT NULL,
                mac_address TEXT NOT NULL DEFAULT '',
                broadcast_ip TEXT NOT NULL DEFAULT '255.255.255.255',
                cpu TEXT NOT NULL DEFAULT '',
                gpu TEXT NOT NULL DEFAULT '',
                rustdesk_id TEXT NOT NULL DEFAULT '',
                apollo_ready INTEGER NOT NULL DEFAULT 0,
                apollo_port INTEGER NOT NULL DEFAULT 47984,
                route_type TEXT NOT NULL DEFAULT 'unknown',
                latency_ms REAL DEFAULT NULL,
                is_host INTEGER NOT NULL DEFAULT 0,
                visibility TEXT NOT NULL DEFAULT 'team',
                last_seen TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            INSERT INTO users (id, username, display_name, password_hash, role, enabled, created_at)
            VALUES ('user-1', 'legacy', 'Legacy', 'x', 'admin', 1, '2026-01-01T00:00:00+00:00');
            INSERT INTO devices (id, owner_user_id, name, mesh_ip, last_seen, created_at)
            VALUES ('legacy-1', 'user-1', 'Legacy-PC', '10.144.0.50', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
            """
        )
        legacy.commit()
        legacy.close()

        # Opening twice proves the ALTER TABLE migration is idempotent.
        for _ in range(2):
            db = Database(legacy_path)
            try:
                device = db.get_device("legacy-1")
                assert device is not None
                self.assertIs(device["has_access_password"], False)
                self.assertEqual(device["agent_port"], 19580)
            finally:
                db.close()

        check = sqlite3.connect(str(legacy_path))
        columns = {row[1] for row in check.execute("PRAGMA table_info(devices)").fetchall()}
        check.close()
        self.assertIn("has_access_password", columns)
        self.assertIn("agent_port", columns)

    def test_static_traversal_and_wol_unquote(self) -> None:
        from http.client import HTTPConnection
        from urllib.parse import urlparse

        parsed = urlparse(self.base)
        conn = HTTPConnection(parsed.hostname, parsed.port, timeout=5)
        try:
            # Sibling/parent traversal must never escape static_dir.
            conn.request("GET", "/../../app.py")
            resp = conn.getresponse()
            body = resp.read().decode("utf-8", errors="ignore")
            self.assertIn(resp.status, (200, 404))
            self.assertNotIn("ControlPlaneConfig", body)
        finally:
            conn.close()

        wol_dir = Path(__file__).resolve().parents[3] / "services" / "wol-helper"
        sys.path.insert(0, str(wol_dir))
        try:
            import silkwarp_wol  # noqa: PLC0415

            encoded = "/api/wake/%E4%B8%BB%E6%9C%BA%20A"
            decoded = silkwarp_wol.unquote(urlparse(encoded).path.removeprefix("/api/wake/").strip("/"))
            self.assertEqual(decoded, "主机 A")
        finally:
            sys.path.pop(0)


if __name__ == "__main__":
    unittest.main()
