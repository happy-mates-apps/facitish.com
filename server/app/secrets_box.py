"""AES-GCM for secrets the server must be able to read again (webhook signing secrets and auth headers).

Keys: SECRET_BOX_KEYS = "<version 1-255>:<base64 of 32 bytes>,…" (the first is used for new values, the others still
decrypt, so keys can be rotated). Without it a key derived from SECRET_KEY is used (version 0). Every value carries
its purpose as associated data, so a value encrypted for one purpose cannot be swapped in for another.
"""

import base64
import hashlib
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app import config


def _keys() -> tuple[int, dict[int, bytes]]:
    keys = {0: hashlib.sha256(b"gaer-secret-box\0" + config.settings.secret_key.encode()).digest()}
    current = 0
    for i, part in enumerate(p for p in (config.settings.secret_box_keys or "").split(",") if p.strip()):
        version, _, raw = part.strip().partition(":")
        key = base64.b64decode(raw)
        if not version.isdigit() or not 1 <= int(version) <= 255 or len(key) != 32:
            raise ValueError("SECRET_BOX_KEYS: use '<1-255>:<base64 of 32 bytes>', comma separated")
        keys[int(version)] = key
        if i == 0:
            current = int(version)
    return current, keys


def encrypt(value: str, purpose: str) -> bytes:
    version, keys = _keys()
    nonce = os.urandom(12)
    return bytes([version]) + nonce + AESGCM(keys[version]).encrypt(nonce, value.encode(), purpose.encode())


def decrypt(blob: bytes, purpose: str) -> str:
    blob = bytes(blob)
    _, keys = _keys()
    return AESGCM(keys[blob[0]]).decrypt(blob[1:13], blob[13:], purpose.encode()).decode()
