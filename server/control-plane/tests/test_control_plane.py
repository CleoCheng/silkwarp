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


if __name__ == "__main__":
    unittest.main()
