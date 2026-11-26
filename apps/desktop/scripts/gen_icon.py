#!/usr/bin/env python3
"""Generate crisp SilkWarp desktop icons (256x256 PNG + multi-size ICO) using Python stdlib."""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

BUILD_DIR = Path(__file__).resolve().parents[1] / "build"


def png_chunk(chunk_type: bytes, data: bytes) -> bytes:
    """Create a CRC-32-checksummed PNG chunk."""
    crc = zlib.crc32(chunk_type + data) & 0xFFFFFFFF
    return struct.pack("!I", len(data)) + chunk_type + data + struct.pack("!I", crc)


def encode_png(rgba: bytes, size: int) -> bytes:
    """Encode raw top-down RGBA bytes into a PNG image."""
    stride = size * 4
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        start = y * stride
        raw.extend(rgba[start : start + stride])
    ihdr = struct.pack("!IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), level=9)
    return b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", ihdr) + png_chunk(b"IDAT", idat) + png_chunk(b"IEND", b"")


def render_icon(size: int) -> bytes:
    """Render anti-aliased SilkWarp rounded-square emblem with glowing warp ribbon."""
    buf = bytearray(size * size * 4)
    half = size / 2.0
    radius = size * 0.22
    box_half = size * 0.44

    for y in range(size):
        for x in range(size):
            px = x + 0.5
            py = y + 0.5
            dx = abs(px - half) - (box_half - radius)
            dy = abs(py - half) - (box_half - radius)
            outside = math.hypot(max(dx, 0.0), max(dy, 0.0)) + min(max(dx, dy), 0.0) - radius
            alpha = max(0.0, min(1.0, 0.5 - outside))
            if alpha <= 0.0:
                continue

            nx = (px - half) / box_half
            ny = (py - half) / box_half

            # Dark obsidian base gradient + subtle cyan radial glow
            glow = max(0.0, 1.0 - math.hypot(nx + 0.35, ny + 0.35) * 0.9)
            r = 14 + glow * 14
            g = 19 + glow * 34
            b = 34 + glow * 58

            # Inner subtle border ring
            if -2.2 < outside < -0.8:
                r += 24
                g += 55
                b += 85

            # Stylized dual-ribbon "S / Warp" wave vectors
            wave1 = abs(ny - (0.32 * math.sin(nx * 2.6) - 0.14))
            wave2 = abs(ny - (0.32 * math.sin(nx * 2.6 + 0.7) + 0.18))
            in_x = abs(nx) < 0.62

            if in_x:
                w1 = max(0.0, 1.0 - max(0.0, wave1 - 0.075) / 0.05)
                w2 = max(0.0, 1.0 - max(0.0, wave2 - 0.065) / 0.05)
                if w1 > 0:
                    # Bright cyan -> sky gradient
                    t = (nx + 0.62) / 1.24
                    cr = 56 + t * 40
                    cg = 189 + t * 30
                    cb = 248
                    r = r * (1 - w1) + cr * w1
                    g = g * (1 - w1) + cg * w1
                    b = b * (1 - w1) + cb * w1
                if w2 > 0:
                    t = (nx + 0.62) / 1.24
                    cr = 59 + t * 20
                    cg = 130 + t * 80
                    cb = 246
                    r = r * (1 - w2) + cr * w2
                    g = g * (1 - w2) + cg * w2
                    b = b * (1 - w2) + cb * w2

            idx = (y * size + x) * 4
            buf[idx] = int(max(0, min(255, r)))
            buf[idx + 1] = int(max(0, min(255, g)))
            buf[idx + 2] = int(max(0, min(255, b)))
            buf[idx + 3] = int(round(alpha * 255))

    return bytes(buf)


def write_ico(sizes: list[int], out_path: Path) -> None:
    """Write a multi-size Windows ICO wrapping PNG-encoded icon frames."""
    pngs = [(s, encode_png(render_icon(s), s)) for s in sizes]
    header = struct.pack("<HHH", 0, 1, len(pngs))
    entries = bytearray()
    offset = 6 + 16 * len(pngs)
    payload = bytearray()

    for s, data in pngs:
        w = 0 if s >= 256 else s
        h = 0 if s >= 256 else s
        entries.extend(struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(data), offset))
        payload.extend(data)
        offset += len(data)

    out_path.write_bytes(header + bytes(entries) + bytes(payload))


def main() -> None:
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    png256 = encode_png(render_icon(256), 256)
    (BUILD_DIR / "icon.png").write_bytes(png256)
    write_ico([16, 32, 48, 256], BUILD_DIR / "icon.ico")
    print(f"Generated {BUILD_DIR / 'icon.png'} and {BUILD_DIR / 'icon.ico'}")


if __name__ == "__main__":
    main()
