"""YubiKeys: is a newly registered security key a YubiKey? Judged by its attestation (WebAuthn "direct").

- `packed` or `fido-u2f` attestation with a certificate chain (x5c) whose leaf is issued by Yubico.
- With YUBICO_ROOTS (config) the chain must also end in one of Yubico's roots: attestation 'verified'.
  Without them the issuer's name is all there is to go on: attestation 'issuer'. A software authenticator could fake
  that, which is why a key only counts for the YubiKey requirement when an admin enrolled it (in person or with a
  link, see routes/yubikey.py) or the user proved an existing YubiKey first.

Used by the registration endpoints in routes/auth.py and routes/yubikey.py; the rules live in app.mfa.
"""

import re
import uuid
from dataclasses import dataclass
from pathlib import Path

from cryptography import x509
from cryptography.x509.oid import NameOID
from webauthn import base64url_to_bytes, verify_registration_response
from webauthn.helpers import parse_attestation_object
from webauthn.helpers.exceptions import InvalidRegistrationResponse
from webauthn.helpers.structs import AttestationFormat

from app import config

_PEM = re.compile(rb"-----BEGIN CERTIFICATE-----.+?-----END CERTIFICATE-----", re.S)
FORMATS = (AttestationFormat.PACKED, AttestationFormat.FIDO_U2F)


@dataclass(frozen=True)
class Attestation:
    yubikey: bool
    attestation: str | None = None   # 'verified' or 'issuer' when yubikey
    aaguid: str | None = None
    reason: str | None = None        # why it is not a YubiKey (for the auth log)


def roots() -> list[bytes]:
    """Yubico's root certificates from YUBICO_ROOTS: the PEM itself or a path to a PEM file."""
    raw = config.settings.yubico_roots
    if not raw:
        return []
    data = raw.encode() if "-----BEGIN" in raw else Path(raw).read_bytes()
    return _PEM.findall(data)


def _names_yubico(name: x509.Name) -> bool:
    for oid in (NameOID.ORGANIZATION_NAME, NameOID.COMMON_NAME):
        if any("yubico" in str(a.value).lower() for a in name.get_attributes_for_oid(oid)):
            return True
    return False


def inspect(credential: dict, *, expected_challenge: bytes) -> Attestation:
    """Call after verify_registration_response accepted the credential. Never raises for a bad attestation; it
    answers yubikey=False with a reason."""
    try:
        obj = parse_attestation_object(base64url_to_bytes(credential["response"]["attestationObject"]))
    except Exception:
        return Attestation(False, reason="unreadable")
    acd = obj.auth_data.attested_credential_data
    aaguid = str(uuid.UUID(bytes=acd.aaguid)) if acd and acd.aaguid and any(acd.aaguid) else None
    x5c = obj.att_stmt.x5c if obj.att_stmt else None
    if obj.fmt not in FORMATS or not x5c:
        return Attestation(False, aaguid=aaguid, reason=f"format_{obj.fmt.value}")
    try:
        leaf = x509.load_der_x509_certificate(x5c[0])
    except ValueError:
        return Attestation(False, aaguid=aaguid, reason="certificate")
    if not _names_yubico(leaf.issuer):
        return Attestation(False, aaguid=aaguid, reason="not_yubico")
    pem_roots = roots()
    if not pem_roots:
        return Attestation(True, "issuer", aaguid)
    s = config.settings
    try:
        # The same check again, now with the chain anchored in Yubico's roots.
        verify_registration_response(credential=credential, expected_challenge=expected_challenge,
                                     expected_rp_id=s.rp_id, expected_origin=s.origin, require_user_verification=True,
                                     pem_root_certs_bytes_by_fmt={fmt: pem_roots for fmt in FORMATS})
    except InvalidRegistrationResponse:
        return Attestation(False, aaguid=aaguid, reason="chain")
    return Attestation(True, "verified", aaguid)
