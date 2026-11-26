"""SQLite WAL storage layer for SilkWarp Control Plane."""

from __future__ import annotations

import sqlite3
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from auth import generate_session_token, hash_password, hash_session_token, verify_password

ONLINE_THRESHOLD_SECONDS = 45
SESSION_TTL_DAYS = 30
PAIR_TTL_MINUTES = 10


def utc_now() -> datetime:
    """Return current UTC datetime."""
    return datetime.now(timezone.utc)


def iso_utc(dt: datetime | None = None) -> str:
    """Format a UTC datetime in ISO-8601 format."""
    target = dt or utc_now()
    return target.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def parse_iso(ts: str | None) -> datetime | None:
    """Parse an ISO-8601 timestamp string safely."""
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts)
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError:
        return None


class Database:
    """Thread-safe SQLite database wrapper for SilkWarp users, sessions, devices, and pair requests."""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False, timeout=15.0)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL;")
            self._conn.execute("PRAGMA busy_timeout=15000;")
            self._conn.execute("PRAGMA synchronous=NORMAL;")
            self._conn.execute("PRAGMA foreign_keys=ON;")
            self._init_schema()

    def close(self) -> None:
        """Close the underlying SQLite connection."""
        with self._lock:
            self._conn.close()

    def _init_schema(self) -> None:
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                display_name TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'member',
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                device_id TEXT DEFAULT '',
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS devices (
                id TEXT PRIMARY KEY,
                owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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

            CREATE TABLE IF NOT EXISTS pair_requests (
                id TEXT PRIMARY KEY,
                host_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                client_device_id TEXT NOT NULL DEFAULT '',
                client_name TEXT NOT NULL DEFAULT '',
                pin TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                message TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        self._conn.commit()

    def ensure_admin(self, username: str, password: str, display_name: str = "管理员") -> None:
        """Create the initial admin account if no admin exists yet."""
        with self._lock:
            row = self._conn.execute("SELECT id FROM users WHERE role = 'admin' LIMIT 1").fetchone()
            if row:
                return
            existing = self._conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
            if existing:
                return
            self._conn.execute(
                """
                INSERT INTO users (id, username, display_name, password_hash, role, enabled, created_at)
                VALUES (?, ?, ?, ?, 'admin', 1, ?)
                """,
                (str(uuid.uuid4()), username, display_name, hash_password(password), iso_utc()),
            )
            self._conn.commit()

    def _user_dict(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "username": row["username"],
            "display_name": row["display_name"],
            "role": row["role"],
            "enabled": bool(row["enabled"]),
            "created_at": row["created_at"],
        }

    def authenticate_user(self, username: str, password: str) -> dict[str, Any] | None:
        """Verify username and password, returning the user dict if valid and enabled."""
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM users WHERE username = ?",
                (username.strip(),),
            ).fetchone()
            if not row or not row["enabled"]:
                return None
            if not verify_password(password, row["password_hash"]):
                return None
            return self._user_dict(row)

    def create_session(self, user_id: str, device_id: str = "") -> tuple[str, str]:
        """Issue and persist a new session token, returning (raw_token, expires_at)."""
        raw_token = generate_session_token()
        token_hash = hash_session_token(raw_token)
        now = utc_now()
        expires = iso_utc(now + timedelta(days=SESSION_TTL_DAYS))
        with self._lock:
            self._conn.execute(
                "DELETE FROM sessions WHERE expires_at < ?",
                (iso_utc(now),),
            )
            self._conn.execute(
                """
                INSERT INTO sessions (token_hash, user_id, device_id, expires_at, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (token_hash, user_id, device_id, expires, iso_utc(now)),
            )
            self._conn.commit()
        return raw_token, expires

    def get_user_by_token(self, raw_token: str) -> dict[str, Any] | None:
        """Resolve an active, unexpired bearer token to its enabled user."""
        if not raw_token:
            return None
        token_hash = hash_session_token(raw_token)
        now = utc_now()
        with self._lock:
            row = self._conn.execute(
                """
                SELECT u.*, s.expires_at
                FROM sessions s
                JOIN users u ON u.id = s.user_id
                WHERE s.token_hash = ?
                """,
                (token_hash,),
            ).fetchone()
            if not row or not row["enabled"]:
                return None
            exp = parse_iso(row["expires_at"])
            if not exp or exp <= now:
                self._conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
                self._conn.commit()
                return None
            if (exp - now) < timedelta(days=SESSION_TTL_DAYS - 5):
                new_exp = iso_utc(now + timedelta(days=SESSION_TTL_DAYS))
                self._conn.execute(
                    "UPDATE sessions SET expires_at = ? WHERE token_hash = ?",
                    (new_exp, token_hash),
                )
                self._conn.commit()
            return self._user_dict(row)

    def revoke_token(self, raw_token: str) -> None:
        """Revoke a session token."""
        if not raw_token:
            return
        with self._lock:
            self._conn.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_session_token(raw_token),))
            self._conn.commit()

    def change_password(self, user_id: str, current_password: str, new_password: str) -> bool:
        """Update user password after checking current password."""
        with self._lock:
            row = self._conn.execute("SELECT password_hash FROM users WHERE id = ?", (user_id,)).fetchone()
            if not row or not verify_password(current_password, row["password_hash"]):
                return False
            self._conn.execute(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                (hash_password(new_password), user_id),
            )
            self._conn.commit()
            return True

    def list_users(self) -> list[dict[str, Any]]:
        """List all team users (admin view)."""
        with self._lock:
            rows = self._conn.execute("SELECT * FROM users ORDER BY created_at ASC").fetchall()
            return [self._user_dict(r) for r in rows]

    def create_user(self, username: str, display_name: str, password: str, role: str = "member") -> dict[str, Any]:
        """Create a new team user."""
        uname = username.strip()
        if not uname or len(uname) < 2:
            raise ValueError("Username must be at least 2 characters.")
        if role not in ("admin", "member"):
            raise ValueError("Role must be 'admin' or 'member'.")
        uid = str(uuid.uuid4())
        now = iso_utc()
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO users (id, username, display_name, password_hash, role, enabled, created_at)
                VALUES (?, ?, ?, ?, ?, 1, ?)
                """,
                (uid, uname, (display_name or uname).strip(), hash_password(password), role, now),
            )
            self._conn.commit()
            row = self._conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
            return self._user_dict(row)

    def update_user(
        self,
        user_id: str,
        *,
        display_name: str | None = None,
        role: str | None = None,
        enabled: bool | None = None,
        password: str | None = None,
    ) -> dict[str, Any] | None:
        """Update user attributes (admin action)."""
        with self._lock:
            row = self._conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            if not row:
                return None
            new_display = display_name.strip() if display_name is not None else row["display_name"]
            new_role = role if role in ("admin", "member") else row["role"]
            new_enabled = int(enabled) if enabled is not None else row["enabled"]
            new_hash = hash_password(password) if password else row["password_hash"]
            self._conn.execute(
                """
                UPDATE users
                SET display_name = ?, role = ?, enabled = ?, password_hash = ?
                WHERE id = ?
                """,
                (new_display, new_role, new_enabled, new_hash, user_id),
            )
            if not new_enabled:
                self._conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
            self._conn.commit()
            updated = self._conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            return self._user_dict(updated)

    def delete_user(self, user_id: str) -> bool:
        """Delete a user and cascade sessions/devices."""
        with self._lock:
            cur = self._conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
            self._conn.commit()
            return cur.rowcount > 0

    def _allocate_mesh_ip_locked(self) -> str:
        used = {
            r["mesh_ip"].split("/")[0]
            for r in self._conn.execute("SELECT mesh_ip FROM devices").fetchall()
        }
        used.add("10.144.0.1")
        for host_octet in range(10, 241):
            candidate = f"10.144.0.{host_octet}"
            if candidate not in used:
                return candidate
        raise RuntimeError("No free Mesh IP addresses left in 10.144.0.10-240")

    def _device_dict(self, row: sqlite3.Row, now: datetime | None = None) -> dict[str, Any]:
        ref = now or utc_now()
        last_dt = parse_iso(row["last_seen"])
        online = bool(last_dt and (ref - last_dt).total_seconds() <= ONLINE_THRESHOLD_SECONDS)
        return {
            "id": row["id"],
            "owner_user_id": row["owner_user_id"],
            "owner_username": row["owner_username"] if "owner_username" in row.keys() else "",
            "name": row["name"],
            "os": row["os"],
            "mesh_ip": row["mesh_ip"],
            "mac_address": row["mac_address"],
            "broadcast_ip": row["broadcast_ip"],
            "cpu": row["cpu"],
            "gpu": row["gpu"],
            "rustdesk_id": row["rustdesk_id"],
            "apollo_ready": bool(row["apollo_ready"]),
            "apollo_port": row["apollo_port"],
            "route_type": row["route_type"],
            "latency_ms": row["latency_ms"],
            "is_host": bool(row["is_host"]),
            "visibility": row["visibility"],
            "online": online,
            "last_seen": row["last_seen"],
            "created_at": row["created_at"],
        }

    def ensure_device(self, user_id: str, device_id: str, name: str, os_name: str = "windows") -> dict[str, Any]:
        """Return existing device or register a new one with a persistent static Mesh IP."""
        dev_id = (device_id or "").strip() or str(uuid.uuid4())
        clean_name = (name or "SilkWarp-Node").strip()[:64]
        clean_os = (os_name or "windows").strip()[:32]
        now_str = iso_utc()
        with self._lock:
            row = self._conn.execute(
                """
                SELECT d.*, u.username AS owner_username
                FROM devices d
                JOIN users u ON u.id = d.owner_user_id
                WHERE d.id = ?
                """,
                (dev_id,),
            ).fetchone()
            if row:
                return self._device_dict(row)
            mesh_ip = self._allocate_mesh_ip_locked()
            self._conn.execute(
                """
                INSERT INTO devices (
                    id, owner_user_id, name, os, mesh_ip, last_seen, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (dev_id, user_id, clean_name, clean_os, mesh_ip, now_str, now_str),
            )
            self._conn.commit()
            created = self._conn.execute(
                """
                SELECT d.*, u.username AS owner_username
                FROM devices d
                JOIN users u ON u.id = d.owner_user_id
                WHERE d.id = ?
                """,
                (dev_id,),
            ).fetchone()
            return self._device_dict(created)

    def heartbeat_device(self, user: dict[str, Any], payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """Update device state and return pending pair requests for this host."""
        dev_id = str(payload.get("device_id") or "").strip()
        if not dev_id:
            raise ValueError("device_id is required")
        name = str(payload.get("name") or "SilkWarp-Node").strip()[:64]
        os_name = str(payload.get("os") or "windows").strip()[:32]

        device = self.ensure_device(user["id"], dev_id, name, os_name)
        if device["owner_user_id"] != user["id"] and user["role"] != "admin":
            raise PermissionError("Device belongs to another user")

        now = utc_now()
        now_str = iso_utc(now)
        with self._lock:
            row = self._conn.execute("SELECT * FROM devices WHERE id = ?", (dev_id,)).fetchone()
            new_name = str(payload.get("name") or row["name"]).strip()[:64]
            new_os = str(payload.get("os") or row["os"]).strip()[:32]
            new_mac = str(payload.get("mac_address") if payload.get("mac_address") is not None else row["mac_address"]).strip()[:32]
            new_bcast = str(payload.get("broadcast_ip") or row["broadcast_ip"]).strip()[:45]
            new_cpu = str(payload.get("cpu") if payload.get("cpu") is not None else row["cpu"]).strip()[:96]
            new_gpu = str(payload.get("gpu") if payload.get("gpu") is not None else row["gpu"]).strip()[:96]
            new_rd = str(payload.get("rustdesk_id") if payload.get("rustdesk_id") is not None else row["rustdesk_id"]).strip()[:48]
            new_apollo_ready = int(bool(payload["apollo_ready"])) if "apollo_ready" in payload else row["apollo_ready"]
            new_apollo_port = int(payload["apollo_port"]) if "apollo_port" in payload and payload["apollo_port"] else row["apollo_port"]
            new_route = str(payload.get("route_type") or row["route_type"]).strip()[:24]
            new_lat = float(payload["latency_ms"]) if payload.get("latency_ms") is not None else row["latency_ms"]
            new_is_host = int(bool(payload["is_host"])) if "is_host" in payload else row["is_host"]
            vis = str(payload.get("visibility") or row["visibility"])
            if vis not in ("team", "private"):
                vis = row["visibility"]

            self._conn.execute(
                """
                UPDATE devices
                SET name=?, os=?, mac_address=?, broadcast_ip=?, cpu=?, gpu=?,
                    rustdesk_id=?, apollo_ready=?, apollo_port=?, route_type=?,
                    latency_ms=?, is_host=?, visibility=?, last_seen=?
                WHERE id=?
                """,
                (
                    new_name, new_os, new_mac, new_bcast, new_cpu, new_gpu,
                    new_rd, new_apollo_ready, new_apollo_port, new_route,
                    new_lat, new_is_host, vis, now_str, dev_id,
                ),
            )

            cutoff = iso_utc(now - timedelta(minutes=PAIR_TTL_MINUTES))
            self._conn.execute("DELETE FROM pair_requests WHERE created_at < ?", (cutoff,))
            pending_rows = self._conn.execute(
                """
                SELECT * FROM pair_requests
                WHERE host_device_id = ? AND status = 'pending'
                ORDER BY created_at ASC
                """,
                (dev_id,),
            ).fetchall()
            self._conn.commit()

            updated = self._conn.execute(
                """
                SELECT d.*, u.username AS owner_username
                FROM devices d
                JOIN users u ON u.id = d.owner_user_id
                WHERE d.id = ?
                """,
                (dev_id,),
            ).fetchone()
            pending = [
                {
                    "id": p["id"],
                    "host_device_id": p["host_device_id"],
                    "client_device_id": p["client_device_id"],
                    "client_name": p["client_name"],
                    "pin": p["pin"],
                    "status": p["status"],
                    "created_at": p["created_at"],
                }
                for p in pending_rows
            ]
            return self._device_dict(updated, now), pending

    def list_devices(self, user: dict[str, Any]) -> list[dict[str, Any]]:
        """List devices visible to the authenticated user."""
        now = utc_now()
        with self._lock:
            if user["role"] == "admin":
                rows = self._conn.execute(
                    """
                    SELECT d.*, u.username AS owner_username
                    FROM devices d
                    JOIN users u ON u.id = d.owner_user_id
                    ORDER BY d.is_host DESC, d.last_seen DESC
                    """
                ).fetchall()
            else:
                rows = self._conn.execute(
                    """
                    SELECT d.*, u.username AS owner_username
                    FROM devices d
                    JOIN users u ON u.id = d.owner_user_id
                    WHERE d.owner_user_id = ? OR d.visibility = 'team'
                    ORDER BY d.is_host DESC, d.last_seen DESC
                    """,
                    (user["id"],),
                ).fetchall()
            return [self._device_dict(r, now) for r in rows]

    def get_device(self, device_id: str) -> dict[str, Any] | None:
        """Fetch a single device by ID."""
        with self._lock:
            row = self._conn.execute(
                """
                SELECT d.*, u.username AS owner_username
                FROM devices d
                JOIN users u ON u.id = d.owner_user_id
                WHERE d.id = ?
                """,
                (device_id,),
            ).fetchone()
            return self._device_dict(row) if row else None

    def update_device(self, device_id: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        """Update editable device fields (name, mac_address, broadcast_ip, visibility)."""
        with self._lock:
            row = self._conn.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone()
            if not row:
                return None
            name = str(payload.get("name") if payload.get("name") is not None else row["name"]).strip()[:64]
            mac = str(payload.get("mac_address") if payload.get("mac_address") is not None else row["mac_address"]).strip()[:32]
            bcast = str(payload.get("broadcast_ip") if payload.get("broadcast_ip") is not None else row["broadcast_ip"]).strip()[:45]
            vis = str(payload.get("visibility") or row["visibility"])
            if vis not in ("team", "private"):
                vis = row["visibility"]
            self._conn.execute(
                "UPDATE devices SET name=?, mac_address=?, broadcast_ip=?, visibility=? WHERE id=?",
                (name or row["name"], mac, bcast or "255.255.255.255", vis, device_id),
            )
            self._conn.commit()
            return self.get_device(device_id)

    def delete_device(self, device_id: str) -> bool:
        """Delete a device record."""
        with self._lock:
            cur = self._conn.execute("DELETE FROM devices WHERE id = ?", (device_id,))
            self._conn.commit()
            return cur.rowcount > 0

    def create_pair_request(self, host_device_id: str, client_device_id: str, client_name: str, pin: str) -> dict[str, Any]:
        """Queue a zero-touch Moonlight/Apollo PIN approval request."""
        clean_pin = pin.strip()
        if not clean_pin.isdigit() or not (4 <= len(clean_pin) <= 8):
            raise ValueError("PIN must be 4 to 8 digits")
        req_id = str(uuid.uuid4())
        now_str = iso_utc()
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO pair_requests (
                    id, host_device_id, client_device_id, client_name, pin, status, message, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'pending', '', ?, ?)
                """,
                (req_id, host_device_id, client_device_id, client_name[:64], clean_pin, now_str, now_str),
            )
            self._conn.commit()
            row = self._conn.execute("SELECT * FROM pair_requests WHERE id = ?", (req_id,)).fetchone()
            return dict(row)

    def get_pair_request(self, req_id: str) -> dict[str, Any] | None:
        """Fetch pair request status by ID."""
        with self._lock:
            row = self._conn.execute("SELECT * FROM pair_requests WHERE id = ?", (req_id,)).fetchone()
            return dict(row) if row else None

    def get_pending_pairs(self, host_device_id: str) -> list[dict[str, Any]]:
        """Read-only fast poll for pending pair requests targeting host_device_id."""
        cutoff = iso_utc(utc_now() - timedelta(minutes=PAIR_TTL_MINUTES))
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT * FROM pair_requests
                WHERE host_device_id = ? AND status = 'pending' AND created_at >= ?
                ORDER BY created_at ASC
                """,
                (host_device_id, cutoff),
            ).fetchall()
            return [
                {
                    "id": p["id"],
                    "host_device_id": p["host_device_id"],
                    "client_device_id": p["client_device_id"],
                    "client_name": p["client_name"],
                    "pin": p["pin"],
                    "status": p["status"],
                    "created_at": p["created_at"],
                }
                for p in rows
            ]

    def resolve_pair_request(self, req_id: str, status: str, message: str = "") -> dict[str, Any] | None:
        """Mark a pair request as approved, rejected, or failed."""
        if status not in ("approved", "rejected", "failed"):
            raise ValueError("Invalid resolution status")
        with self._lock:
            cur = self._conn.execute(
                "UPDATE pair_requests SET status=?, message=?, updated_at=? WHERE id=?",
                (status, message[:200], iso_utc(), req_id),
            )
            self._conn.commit()
            if cur.rowcount == 0:
                return None
            return self.get_pair_request(req_id)

    def counts(self) -> dict[str, int]:
        """Return lightweight counts for /api/health."""
        now = utc_now()
        cutoff = iso_utc(now - timedelta(seconds=ONLINE_THRESHOLD_SECONDS))
        with self._lock:
            users_cnt = self._conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
            dev_cnt = self._conn.execute("SELECT COUNT(*) FROM devices").fetchone()[0]
            on_cnt = self._conn.execute("SELECT COUNT(*) FROM devices WHERE last_seen >= ?", (cutoff,)).fetchone()[0]
            return {"users": int(users_cnt), "devices": int(dev_cnt), "online_devices": int(on_cnt)}
