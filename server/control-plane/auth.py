"""Password hashing and session token helpers for SilkWarp Control Plane."""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets

PBKDF2_ITERATIONS = 200_000


def hash_password(password: str) -> str:
    """Hash a plaintext password using PBKDF2-HMAC-SHA256 with a 16-byte random salt."""
    if not password or len(password) < 6:
        raise ValueError("Password must be at least 6 characters long.")
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    """Verify a plaintext password against a stored PBKDF2 hash string."""
    try:
        scheme, iter_str, salt_hex, digest_hex = stored_hash.split("$", 3)
        if scheme != "pbkdf2_sha256":
            return False
        iterations = int(iter_str)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(digest_hex)
    except (ValueError, TypeError):
        return False

    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(actual, expected)


def generate_session_token() -> str:
    """Generate a high-entropy URL-safe session bearer token."""
    return secrets.token_urlsafe(32)


def hash_session_token(token: str) -> str:
    """Compute deterministic SHA-256 hex digest of a session token for DB lookup."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
