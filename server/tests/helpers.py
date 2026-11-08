"""Test helpers: a software passkey authenticator and login shortcuts."""

import hashlib
import json
import os
import struct

import cbor2
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url

ORIGIN = "http://localhost:5173"
RP_ID = "localhost"


class SoftAuthenticator:
    """Creates 'none' attestation registrations and ES256 assertions, like a platform passkey."""

    def __init__(self):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.credential_id = os.urandom(32)
        self.sign_count = 0

    def _cose_key(self) -> bytes:
        numbers = self.key.public_key().public_numbers()
        return cbor2.dumps({1: 2, 3: -7, -1: 1, -2: numbers.x.to_bytes(32, "big"), -3: numbers.y.to_bytes(32, "big")})

    def _client_data(self, kind: str, challenge: str) -> bytes:
        return json.dumps({"type": kind, "challenge": challenge, "origin": ORIGIN, "crossOrigin": False}).encode()

    def register(self, options: dict) -> dict:
        client_data = self._client_data("webauthn.create", options["challenge"])
        rp_hash = hashlib.sha256(options["rp"]["id"].encode()).digest()
        flags = 0x01 | 0x04 | 0x40  # user present, user verified, attested credential data
        auth_data = (rp_hash + bytes([flags]) + struct.pack(">I", self.sign_count) + bytes(16)
                     + struct.pack(">H", len(self.credential_id)) + self.credential_id + self._cose_key())
        attestation = cbor2.dumps({"fmt": "none", "attStmt": {}, "authData": auth_data})
        cid = bytes_to_base64url(self.credential_id)
        return {"id": cid, "rawId": cid, "type": "public-key",
                "response": {"clientDataJSON": bytes_to_base64url(client_data),
                             "attestationObject": bytes_to_base64url(attestation), "transports": ["internal"]}}

    def assert_(self, options: dict, uv: bool = True) -> dict:
        """uv=False is a key used without PIN/biometrics: possession only."""
        self.sign_count += 1
        client_data = self._client_data("webauthn.get", options["challenge"])
        rp_hash = hashlib.sha256(RP_ID.encode()).digest()
        auth_data = rp_hash + bytes([0x01 | (0x04 if uv else 0)]) + struct.pack(">I", self.sign_count)
        signature = self.key.sign(auth_data + hashlib.sha256(client_data).digest(), ec.ECDSA(hashes.SHA256()))
        cid = bytes_to_base64url(self.credential_id)
        return {"id": cid, "rawId": cid, "type": "public-key",
                "response": {"clientDataJSON": bytes_to_base64url(client_data),
                             "authenticatorData": bytes_to_base64url(auth_data),
                             "signature": bytes_to_base64url(signature), "userHandle": None}}


async def otp_login(client, phone: str) -> dict:
    r = await client.post("/api/auth/otp/start", json={"phone": phone})
    assert r.status_code == 200, r.text
    r = await client.post("/api/auth/otp/verify", json={"phone": phone, "code": r.json()["dev_code"]})
    assert r.status_code == 200, r.text
    return r.json()


async def register_passkey(client, authenticator: SoftAuthenticator) -> None:
    r = await client.post("/api/auth/passkey/register/options")
    assert r.status_code == 200, r.text
    body = r.json()
    r = await client.post("/api/auth/passkey/register/verify",
                          json={"challenge_id": body["challenge_id"], "credential": authenticator.register(body["options"])})
    assert r.status_code == 200, r.text


async def passkey_login(client, authenticator: SoftAuthenticator, uv: bool = True):
    r = await client.post("/api/auth/passkey/login/options")
    body = r.json()
    return await client.post("/api/auth/passkey/login/verify",
                             json={"challenge_id": body["challenge_id"],
                                   "credential": authenticator.assert_(body["options"], uv=uv)})


async def stepup(client, authenticator: SoftAuthenticator, uv: bool = True):
    """Proves the second factor with a passkey (completes a pending login or steps up a full session)."""
    r = await client.post("/api/auth/mfa/passkey/options")
    assert r.status_code == 200, r.text
    body = r.json()
    return await client.post("/api/auth/mfa/passkey/verify",
                             json={"challenge_id": body["challenge_id"],
                                   "credential": authenticator.assert_(body["options"], uv=uv)})


def totp_code(secret: str, offset_steps: int = 0) -> str:
    from app import totp
    return totp.code_at(secret, totp.current_step() + offset_steps)


async def full_user(client, phone: str) -> SoftAuthenticator:
    """Logs in with a code and registers a passkey: a normal, fully enrolled user."""
    authenticator = SoftAuthenticator()
    await otp_login(client, phone)
    await register_passkey(client, authenticator)
    return authenticator


__all__ = ["SoftAuthenticator", "otp_login", "register_passkey", "passkey_login", "full_user", "stepup", "totp_code",
           "base64url_to_bytes"]
