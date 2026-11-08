"""Authenticator apps (TOTP, RFC 6238): 6 digits, 30-second steps, SHA-1 — what every app supports.

The shared secret is stored encrypted with AES-GCM and is only shown once, at setup. Keys are versioned so they can
be rotated: TOTP_KEYS="2:<base64 32 bytes>,1:<…>" (first = current). Version 0 is derived from SECRET_KEY and is
used when TOTP_KEYS is not set; set TOTP_KEYS in production so SECRET_KEY can be rotated without breaking the apps.
"""

import base64
import hashlib
import hmac
import io
import os
import struct
import time
from urllib.parse import quote, urlencode

import segno
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app import config

DIGITS = 6
PERIOD = 30
WINDOW = 1  # accept the previous and the next step as well (clock drift)


def new_secret() -> str:
    return base64.b32encode(os.urandom(20)).decode().rstrip("=")


def _keys() -> tuple[int, dict[int, bytes]]:
    """(current version, {version: key})."""
    keys = {0: hashlib.sha256(b"gaer-totp\0" + config.settings.secret_key.encode()).digest()}
    current = 0
    for i, part in enumerate(p for p in (config.settings.totp_keys or "").split(",") if p.strip()):
        version, _, raw = part.strip().partition(":")
        key = base64.b64decode(raw)
        if not version.isdigit() or not 1 <= int(version) <= 255 or len(key) != 32:
            raise ValueError("TOTP_KEYS: use '<1-255>:<base64 of 32 bytes>', comma separated")
        keys[int(version)] = key
        if i == 0:
            current = int(version)
    return current, keys


def encrypt(secret: str) -> bytes:
    version, keys = _keys()
    nonce = os.urandom(12)
    return bytes([version]) + nonce + AESGCM(keys[version]).encrypt(nonce, secret.encode(), b"totp")


def decrypt(blob: bytes) -> str:
    blob = bytes(blob)
    _, keys = _keys()
    return AESGCM(keys[blob[0]]).decrypt(blob[1:13], blob[13:], b"totp").decode()


def code_at(secret: str, step: int) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    digest = hmac.new(key, struct.pack(">Q", step), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(value % 10 ** DIGITS).zfill(DIGITS)


def current_step(now: float | None = None) -> int:
    return int((time.time() if now is None else now) // PERIOD)


def match(secret: str, code: str, *, after_step: int | None = None, now: float | None = None) -> int | None:
    """The time step the code belongs to, or None. Steps at or before after_step are refused (replay)."""
    code = "".join(c for c in code if c.isdigit())
    if len(code) != DIGITS:
        return None
    step = current_step(now)
    for candidate in range(step - WINDOW, step + WINDOW + 1):
        if after_step is not None and candidate <= after_step:
            continue
        if hmac.compare_digest(code_at(secret, candidate), code):
            return candidate
    return None


def otpauth_uri(secret: str, account: str, issuer: str) -> str:
    label = quote(f"{issuer}:{account}")
    query = urlencode({"secret": secret, "issuer": issuer, "digits": DIGITS, "period": PERIOD, "algorithm": "SHA1"})
    return f"otpauth://totp/{label}?{query}"


def qr_svg(uri: str) -> str:
    out = io.BytesIO()
    segno.make(uri, error="m").save(out, kind="svg", scale=5, border=2, xmldecl=False, svgns=True)
    return out.getvalue().decode()
