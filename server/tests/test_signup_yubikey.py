"""Sign-up modes, login links, users created by an admin, the full user edit and the YubiKey requirement."""

import dataclasses
import datetime
import hashlib
import struct
import uuid

import cbor2
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from webauthn.helpers import bytes_to_base64url

from app import config
from tests.helpers import SoftAuthenticator, register_passkey, stepup

YUBIKEY_AAGUID = uuid.UUID("fa2b99dc-9e39-4257-8f92-4a30d23c4118")


def _name(org: str, cn: str, ou: str | None = None) -> x509.Name:
    attrs = [x509.NameAttribute(NameOID.COUNTRY_NAME, "SE"), x509.NameAttribute(NameOID.ORGANIZATION_NAME, org)]
    if ou:
        attrs.append(x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, ou))
    return x509.Name(attrs + [x509.NameAttribute(NameOID.COMMON_NAME, cn)])


class AttestationCA:
    """A stand-in for a vendor's attestation root and the certificate a key's batch is signed with."""

    def __init__(self, org: str = "Yubico AB"):
        now = datetime.datetime.now(datetime.timezone.utc)
        self.root_key = ec.generate_private_key(ec.SECP256R1())
        root_name = _name(org, f"{org} Test Root")
        self.root = (x509.CertificateBuilder().subject_name(root_name).issuer_name(root_name)
                     .public_key(self.root_key.public_key()).serial_number(x509.random_serial_number())
                     .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=365))
                     .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
                     .sign(self.root_key, hashes.SHA256()))
        self.leaf_key = ec.generate_private_key(ec.SECP256R1())
        self.leaf = (x509.CertificateBuilder()
                     .subject_name(_name(org, f"{org} FIDO EE Serial 1", "Authenticator Attestation"))
                     .issuer_name(root_name).public_key(self.leaf_key.public_key())
                     .serial_number(x509.random_serial_number())
                     .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=365))
                     .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
                     .sign(self.root_key, hashes.SHA256()))

    def root_pem(self) -> str:
        return self.root.public_bytes(serialization.Encoding.PEM).decode()


class SoftYubiKey(SoftAuthenticator):
    """A security key with packed attestation signed by the given CA (a YubiKey when the CA names Yubico)."""

    def __init__(self, ca: AttestationCA):
        super().__init__()
        self.ca = ca

    def register(self, options: dict) -> dict:
        client_data = self._client_data("webauthn.create", options["challenge"])
        rp_hash = hashlib.sha256(options["rp"]["id"].encode()).digest()
        flags = 0x01 | 0x04 | 0x40
        auth_data = (rp_hash + bytes([flags]) + struct.pack(">I", self.sign_count) + YUBIKEY_AAGUID.bytes
                     + struct.pack(">H", len(self.credential_id)) + self.credential_id + self._cose_key())
        sig = self.ca.leaf_key.sign(auth_data + hashlib.sha256(client_data).digest(), ec.ECDSA(hashes.SHA256()))
        attestation = cbor2.dumps({"fmt": "packed", "authData": auth_data, "attStmt": {
            "alg": -7, "sig": sig, "x5c": [self.ca.leaf.public_bytes(serialization.Encoding.DER)]}})
        cid = bytes_to_base64url(self.credential_id)
        return {"id": cid, "rawId": cid, "type": "public-key", "authenticatorAttachment": "cross-platform",
                "response": {"clientDataJSON": bytes_to_base64url(client_data),
                             "attestationObject": bytes_to_base64url(attestation), "transports": ["usb", "nfc"]}}


@pytest.fixture
def settings(monkeypatch):
    def set_(**values):
        monkeypatch.setattr(config, "settings", dataclasses.replace(config.settings, **values))
    return set_


async def email_start(client, email: str):
    r = await client.post("/api/auth/otp/start", json={"email": email})
    assert r.status_code == 200, r.text
    return r.json()


async def email_login(client, email: str) -> dict:
    body = await email_start(client, email)
    r = await client.post("/api/auth/otp/verify", json={"email": email, "code": body["dev_code"]})
    assert r.status_code == 200, r.text
    return r.json()


async def admin_client(make_client, email: str = "admin@example.com"):
    """The first user (super admin) with a passkey, stepped up just now."""
    client = make_client()
    await email_login(client, email)
    key = SoftAuthenticator()
    await register_passkey(client, key)
    return client, key


async def set_signup(client, **body):
    r = await client.put("/api/admin/settings/signup", json=body)
    assert r.status_code == 200, r.text
    return r.json()


# ── Sign-up modes ───────────────────────────────────────────────────────────

async def test_closed_signup_sends_no_code_and_answers_the_same(make_client, owner_conn):
    admin, _ = await admin_client(make_client)
    await set_signup(admin, mode="closed", domains=[], contact="support@example.com")
    stranger = make_client()
    body = await email_start(stranger, "stranger@example.com")
    assert body["ok"] is True and "dev_code" not in body
    assert owner_conn.execute("select count(*) from otp_codes where recipient = 'stranger@example.com'").fetchone()[0] == 0
    assert owner_conn.execute("""select count(*) from auth_log where event = 'otp.sent' and result = 'fail'
                                 and detail->>'reason' = 'signup_closed'""").fetchone()[0] == 1
    cfg = (await stranger.get("/api/public/config")).json()["signup"]
    assert cfg == {"open": False, "contact": "support@example.com"}
    # Existing users still log in.
    assert (await email_login(make_client(), "admin@example.com"))["status"] == "logged_in"
    audit = owner_conn.execute("select after from audit_log where table_name = 'settings' and row_id = 'signup'").fetchone()
    assert audit[0]["mode"] == "closed"


async def test_domains_signup(make_client, owner_conn):
    admin, _ = await admin_client(make_client)
    value = await set_signup(admin, mode="domains", domains=[" @Firma.DK ", "firma.dk", "partner.dk"], contact="")
    assert value["domains"] == ["firma.dk", "partner.dk"]
    assert (await email_login(make_client(), "anna@firma.dk"))["status"] == "logged_in"
    assert (await email_login(make_client(), "bo@afd.partner.dk"))["status"] == "logged_in"
    assert "dev_code" not in await email_start(make_client(), "eve@notfirma.dk")
    assert "dev_code" not in await email_start(make_client(), "eve@firma.dk.evil.com")
    r = await admin.put("/api/admin/settings/signup", json={"mode": "domains", "domains": [], "contact": ""})
    assert r.status_code == 422
    r = await admin.put("/api/admin/settings/signup", json={"mode": "domains", "domains": ["not a domain"], "contact": ""})
    assert r.status_code == 422


async def test_first_user_always_gets_in_and_late_close_creates_no_account(make_client, owner_conn):
    owner_conn.execute("""insert into settings (key, value) values ('signup', '{"mode": "closed"}')""")
    first = make_client()
    assert (await email_login(first, "first@example.com"))["became_admin"] is True
    # A code sent while sign-up was open stops working for a new account once it is closed.
    owner_conn.execute("""update settings set value = '{"mode": "open"}' where key = 'signup'""")
    late = make_client()
    code = (await email_start(late, "late@example.com"))["dev_code"]
    owner_conn.execute("""update settings set value = '{"mode": "closed"}' where key = 'signup'""")
    r = await late.post("/api/auth/otp/verify", json={"email": "late@example.com", "code": code})
    assert r.status_code == 403
    assert owner_conn.execute("select count(*) from users where email = 'late@example.com'").fetchone()[0] == 0


async def test_only_drift_or_full_edits_signup(make_client, owner_conn):
    admin, key = await admin_client(make_client)
    support = make_client()
    await email_login(support, "support@example.com")
    await stepup(admin, key)
    r = await admin.post("/api/admin/users", json={"email": "s2@example.com", "role": "admin", "admin_roles": ["support"],
                                                    "send_welcome": False})
    assert r.status_code == 201, r.text
    s2 = make_client()
    await email_login(s2, "s2@example.com")
    assert (await s2.put("/api/admin/settings/signup", json={"mode": "closed"})).status_code == 403


# ── Login links ─────────────────────────────────────────────────────────────

async def test_login_link_logs_in_once(make_client, owner_conn):
    await email_login(make_client(), "admin@example.com")
    client = make_client()
    body = await email_start(client, "anna@example.com")
    token = body["dev_link"]
    assert owner_conn.execute("select link_hash is not null from otp_codes where recipient = 'anna@example.com'").fetchone()[0]
    other = make_client()
    r = await other.post("/api/auth/otp/link", json={"token": token})
    assert r.status_code == 200 and r.json()["status"] == "logged_in", r.text
    assert (await other.get("/api/auth/me")).json()["user"]["email"] == "anna@example.com"
    # Single use, and it used up the code too.
    assert (await make_client().post("/api/auth/otp/link", json={"token": token})).status_code == 400
    r = await client.post("/api/auth/otp/verify", json={"email": "anna@example.com", "code": body["dev_code"]})
    assert r.status_code == 400
    assert owner_conn.execute("""select count(*) from auth_log where event = 'otp.verified'
                                 and detail->>'via' = 'link'""").fetchone()[0] == 1


async def test_login_link_keeps_the_second_factor(make_client):
    await email_login(make_client(), "admin@example.com")
    user = make_client()
    key = await _user_with_mfa(user, "anna@example.com")
    link = (await email_start(make_client(), "anna@example.com"))["dev_link"]
    c = make_client()
    r = await c.post("/api/auth/otp/link", json={"token": link})
    assert r.json()["status"] == "mfa_required"
    assert (await c.get("/api/me/security")).status_code == 403
    assert (await stepup(c, key)).status_code == 200


async def _user_with_mfa(client, email: str) -> SoftAuthenticator:
    await email_login(client, email)
    key = SoftAuthenticator()
    await register_passkey(client, key)
    r = await client.put("/api/me/mfa", json={"required": True})
    assert r.status_code == 200, r.text
    return key


async def test_no_link_for_sms_or_expired(make_client, owner_conn):
    await email_login(make_client(), "admin@example.com")
    body = (await make_client().post("/api/auth/otp/start", json={"phone": "+4512345678"})).json()
    assert "dev_link" not in body
    link = (await email_start(make_client(), "anna@example.com"))["dev_link"]
    owner_conn.execute("update otp_codes set expires_at = now() - interval '1 second'")
    assert (await make_client().post("/api/auth/otp/link", json={"token": link})).status_code == 400


async def test_admin_sends_login_link_and_can_reset_mfa(make_client, owner_conn):
    admin, key = await admin_client(make_client)
    user = make_client()
    await _user_with_mfa(user, "anna@example.com")
    uid = owner_conn.execute("select id from users where email = 'anna@example.com'").fetchone()[0]
    r = await admin.post(f"/api/admin/users/{uid}/login-link", json={})
    assert r.status_code == 200 and r.json()["dev_link"], r.text
    r = await admin.post(f"/api/admin/users/{uid}/login-link", json={"reset_mfa": True})
    assert r.status_code == 200, r.text   # the passkey registration a moment ago is the step-up
    c = make_client()
    r = await c.post("/api/auth/otp/link", json={"token": r.json()["dev_link"]})
    assert r.json()["status"] == "logged_in"   # MFA was reset: no pending session
    assert owner_conn.execute("select count(*) from passkeys where user_id = %s", (uid,)).fetchone()[0] == 0
    assert owner_conn.execute("select count(*) from audit_log where action = 'user.login_link'").fetchone()[0] == 2


# ── Users created by an admin, and the full edit ────────────────────────────

async def test_create_user_then_closed_signup_login(make_client, owner_conn):
    admin, _ = await admin_client(make_client)
    await set_signup(admin, mode="closed", domains=[], contact="")
    r = await admin.post("/api/admin/users", json={"email": "Ny@Example.com", "display_name": "Ny Bruger"})
    assert r.status_code == 201, r.text
    assert r.json()["welcome_sent"] is True
    row = owner_conn.execute("select role, display_name, created_by, audience from users where email = 'ny@example.com'").fetchone()
    assert row == ("user", "Ny Bruger", 1, "external")
    assert (await email_login(make_client(), "ny@example.com"))["status"] == "logged_in"
    assert (await admin.post("/api/admin/users", json={"email": "ny@example.com"})).status_code == 409
    listed = (await admin.get("/api/admin/users")).json()["items"]
    assert [u["created_by_name"] for u in listed if u["email"] == "ny@example.com"] == [None]  # admin has no name
    assert any(u["created_by"] == 1 for u in listed)


async def test_create_admin_needs_full_and_stepup(make_client, owner_conn):
    admin, key = await admin_client(make_client)
    owner_conn.execute("update sessions set mfa_at = now() - interval '1 hour'")
    r = await admin.post("/api/admin/users", json={"email": "a2@example.com", "role": "admin"})
    assert r.status_code == 403 and r.headers["x-gaer-error"] == "stepup_required"
    await stepup(admin, key)
    r = await admin.post("/api/admin/users", json={"email": "a2@example.com", "role": "admin",
                                                    "admin_roles": ["support", "drift"], "yubikey_required": True})
    assert r.status_code == 201, r.text
    row = owner_conn.execute("select role, admin_roles, yubikey_required from users where email = 'a2@example.com'").fetchone()
    assert row == ("admin", ["drift", "support"], True)
    # A Support admin may create users, but no admins.
    support = make_client()
    await email_login(support, "a2@example.com")
    owner_conn.execute("update users set yubikey_required = false where email = 'a2@example.com'")
    key2 = SoftAuthenticator()
    await register_passkey(support, key2)
    assert (await support.post("/api/admin/users", json={"email": "u3@example.com"})).status_code == 201
    r = await support.post("/api/admin/users", json={"email": "a3@example.com", "role": "admin"})
    assert r.status_code == 403


async def test_full_edit_saves_everything_at_once(make_client, owner_conn):
    admin, key = await admin_client(make_client)
    await email_login(make_client(), "anna@example.com")
    uid = owner_conn.execute("select id from users where email = 'anna@example.com'").fetchone()[0]
    r = await admin.put(f"/api/admin/users/{uid}", json={
        "display_name": "Anna Holm", "email": "anna.holm@example.com", "audience": "internal", "role": "admin",
        "admin_roles": ["support"], "yubikey_required": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["user"]["email"] == "anna.holm@example.com" and body["user"]["admin_roles"] == ["support"]
    assert body["user"]["yubikey_required"] is True and body["security"]["yubikey_required"] is True
    row = owner_conn.execute("select display_name, audience, role from users where id = %s", (uid,)).fetchone()
    assert row == ("Anna Holm", "internal", "admin")
    # All or nothing: an invalid e-mail later in the request leaves the name as it was.
    r = await admin.put(f"/api/admin/users/{uid}", json={"display_name": "X", "phone": "nope"})
    assert r.status_code == 400
    assert owner_conn.execute("select display_name from users where id = %s", (uid,)).fetchone()[0] == "Anna Holm"
    # Only the name: no step-up needed.
    owner_conn.execute("update sessions set mfa_at = now() - interval '1 hour', yubikey_at = null")
    assert (await admin.put(f"/api/admin/users/{uid}", json={"display_name": "A. Holm"})).status_code == 200
    r = await admin.put(f"/api/admin/users/{uid}", json={"yubikey_required": False})
    assert r.status_code == 403 and r.headers["x-gaer-error"] == "stepup_required"


async def test_cannot_lock_yourself_out(make_client):
    admin, _ = await admin_client(make_client)
    r = await admin.put("/api/admin/users/1", json={"yubikey_required": True})
    assert r.status_code == 409


# ── The YubiKey requirement ─────────────────────────────────────────────────

async def test_self_registered_yubikey_is_recognised(make_client, owner_conn):
    await email_login(make_client(), "admin@example.com")
    client = make_client()
    await email_login(client, "anna@example.com")
    yk = SoftYubiKey(AttestationCA())
    r = await client.post("/api/auth/passkey/register/options", json={"kind": "security_key"})
    assert r.json()["options"]["attestation"] == "direct"
    body = r.json()
    r = await client.post("/api/auth/passkey/register/verify",
                          json={"challenge_id": body["challenge_id"], "credential": yk.register(body["options"])})
    assert r.status_code == 200 and r.json()["yubikey"] is True, r.text
    row = owner_conn.execute("select kind, yubikey, attestation, aaguid, name from passkeys").fetchone()
    assert row == ("security_key", True, "issuer", YUBIKEY_AAGUID, "YubiKey")
    # Another vendor's key is a security key, not a YubiKey.
    other = SoftYubiKey(AttestationCA("Other Vendor Inc"))
    await stepup(client, yk)
    r = await client.post("/api/auth/passkey/register/options", json={"kind": "security_key"})
    body = r.json()
    r = await client.post("/api/auth/passkey/register/verify",
                          json={"challenge_id": body["challenge_id"], "credential": other.register(body["options"])})
    assert r.json()["yubikey"] is False and r.json()["yubikey_detected"] is False


async def test_roots_make_attestation_verified_and_reject_fakes(make_client, owner_conn, settings):
    real, fake = AttestationCA(), AttestationCA()   # both name Yubico; only one is the configured root
    settings(yubico_roots=real.root_pem())
    await email_login(make_client(), "admin@example.com")
    client = make_client()
    await email_login(client, "anna@example.com")
    for ca, expected in ((real, True), (fake, False)):
        if expected is False:
            await stepup(client, first)
        key = SoftYubiKey(ca)
        body = (await client.post("/api/auth/passkey/register/options", json={"kind": "security_key"})).json()
        r = await client.post("/api/auth/passkey/register/verify",
                              json={"challenge_id": body["challenge_id"], "credential": key.register(body["options"])})
        assert r.status_code == 200 and r.json()["yubikey"] is expected, r.text
        first = key
    assert owner_conn.execute("select attestation from passkeys order by id").fetchall() == [("verified",), (None,)]


async def _required_admin(make_client, owner_conn):
    """Super admin + a second admin 'bo' with the YubiKey requirement and a passkey (no YubiKey)."""
    admin, admin_key = await admin_client(make_client)
    bo = make_client()
    await email_login(bo, "bo@example.com")
    bo_key = SoftAuthenticator()
    await register_passkey(bo, bo_key)
    uid = owner_conn.execute("select id from users where email = 'bo@example.com'").fetchone()[0]
    r = await admin.put(f"/api/admin/users/{uid}", json={"role": "admin", "yubikey_required": True})
    assert r.status_code == 200, r.text
    return admin, admin_key, bo, bo_key, uid


async def test_requirement_blocks_admin_until_a_yubikey(make_client, owner_conn):
    admin, admin_key, bo, bo_key, uid = await _required_admin(make_client, owner_conn)
    r = await bo.get("/api/admin/users")
    assert r.status_code == 403 and r.headers["x-gaer-error"] == "yubikey_setup_required"
    me = (await bo.get("/api/auth/me")).json()["user"]["mfa"]
    assert me["yubikey_required"] is True and me["yubikeys"] == 0 and me["admin_ok"] is False
    # A passkey proves nothing for /admin now; the app itself works.
    assert (await stepup(bo, bo_key)).status_code == 200
    assert (await bo.get("/api/admin/users")).status_code == 403
    assert (await bo.get("/api/me/security")).status_code == 200
    # A YubiKey bo adds alone does not count: the first one comes from an admin.
    yk = SoftYubiKey(AttestationCA())
    body = (await bo.post("/api/auth/passkey/register/options", json={"kind": "security_key"})).json()
    r = await bo.post("/api/auth/passkey/register/verify",
                      json={"challenge_id": body["challenge_id"], "credential": yk.register(body["options"])})
    assert r.status_code == 200 and r.json()["yubikey"] is False and r.json()["yubikey_detected"] is True


async def test_admin_enrolls_yubikey_in_person(make_client, owner_conn):
    admin, admin_key, bo, bo_key, uid = await _required_admin(make_client, owner_conn)
    yk = SoftYubiKey(AttestationCA())
    r = await admin.post(f"/api/admin/users/{uid}/yubikey/options")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["options"]["authenticatorSelection"]["residentKey"] == "discouraged"
    # A key that is not a YubiKey is refused.
    other = SoftYubiKey(AttestationCA("Other Vendor Inc"))
    r = await admin.post(f"/api/admin/users/{uid}/yubikey/verify",
                         json={"challenge_id": body["challenge_id"], "credential": other.register(body["options"])})
    assert r.status_code == 400
    body = (await admin.post(f"/api/admin/users/{uid}/yubikey/options")).json()
    r = await admin.post(f"/api/admin/users/{uid}/yubikey/verify", json={
        "challenge_id": body["challenge_id"], "credential": yk.register(body["options"]), "name": "Kontor"})
    assert r.status_code == 200, r.text
    row = owner_conn.execute("select yubikey, enrolled_by, name from passkeys where user_id = %s and yubikey", (uid,)).fetchone()
    assert row == (True, 1, "Kontor")
    # bo proves the YubiKey after the code and gets into /admin; a passkey step-up is not enough for security actions.
    r = await bo.post("/api/auth/mfa/passkey/options", json={"yubikey": True})
    assert len(r.json()["options"]["allowCredentials"]) == 1
    assert (await stepup_yubikey(bo, yk)).status_code == 200
    assert (await bo.get("/api/admin/users")).status_code == 200
    # An hour later /admin still opens, but a security action wants the YubiKey again (not a passkey).
    owner_conn.execute("update sessions set yubikey_at = now() - interval '1 hour' where user_id = %s", (uid,))
    assert (await bo.get("/api/admin/users")).status_code == 200
    r = await bo.post(f"/api/admin/users/{uid}/revoke-sessions")
    assert r.status_code == 403 and r.headers["x-gaer-error"] == "yubikey_stepup_required"
    # A passkey step-up is a new session without a YubiKey: /admin closes again until the YubiKey is shown.
    await stepup(bo, bo_key)
    r = await bo.get("/api/admin/users")
    assert r.status_code == 403 and r.headers["x-gaer-error"] == "yubikey_required"
    # The admin held the key: it never logs bo in on its own.
    c = make_client()
    r = await c.post("/api/auth/passkey/login/options")
    opts = r.json()
    r = await c.post("/api/auth/passkey/login/verify",
                     json={"challenge_id": opts["challenge_id"], "credential": yk.assert_(opts["options"])})
    assert r.status_code == 400


async def stepup_yubikey(client, key: SoftAuthenticator):
    r = await client.post("/api/auth/mfa/passkey/options", json={"yubikey": True})
    body = r.json()
    return await client.post("/api/auth/mfa/passkey/verify",
                             json={"challenge_id": body["challenge_id"], "credential": key.assert_(body["options"])})


async def test_only_super_admin_enrolls_for_another_admin(make_client, owner_conn):
    admin, admin_key, bo, bo_key, uid = await _required_admin(make_client, owner_conn)
    owner_conn.execute("update users set yubikey_required = false, admin_roles = '{fuld}' where id = %s", (uid,))
    await stepup(bo, bo_key)
    r = await bo.post("/api/admin/users/1/yubikey/options")
    assert r.status_code == 403
    r = await admin.post("/api/admin/users/1/yubikey/options")
    assert r.status_code == 409   # not for yourself


async def test_yubikey_link_enrollment(make_client, owner_conn):
    admin, admin_key, bo, bo_key, uid = await _required_admin(make_client, owner_conn)
    r = await admin.post(f"/api/admin/users/{uid}/yubikey/link")
    assert r.status_code == 200, r.text
    token = r.json()["dev_token"]
    # Not for anybody else.
    assert (await admin.post("/api/auth/yubikey/enroll/check", json={"token": token})).status_code == 400
    assert (await bo.post("/api/auth/yubikey/enroll/check", json={"token": token})).status_code == 200
    await stepup(bo, bo_key)  # bo has a passkey: changing factors needs a recent second factor
    yk = SoftYubiKey(AttestationCA())
    body = (await bo.post("/api/auth/yubikey/enroll/options", json={"token": token})).json()
    r = await bo.post("/api/auth/yubikey/enroll/verify", json={
        "token": token, "challenge_id": body["challenge_id"], "credential": yk.register(body["options"])})
    assert r.status_code == 200, r.text
    assert (await bo.get("/api/admin/users")).status_code == 200   # the new session proved the YubiKey
    assert owner_conn.execute("select used_at is not null from yubikey_enrollments").fetchone()[0] is True
    row = owner_conn.execute("select yubikey, enrolled_by from passkeys where user_id = %s and yubikey", (uid,)).fetchone()
    assert row == (True, None)
    # Single use.
    assert (await bo.post("/api/auth/yubikey/enroll/options", json={"token": token})).status_code == 400
    # A YubiKey added after proving this one counts as well.
    yk2 = SoftYubiKey(AttestationCA())
    body = (await bo.post("/api/auth/passkey/register/options", json={"kind": "security_key"})).json()
    r = await bo.post("/api/auth/passkey/register/verify",
                      json={"challenge_id": body["challenge_id"], "credential": yk2.register(body["options"])})
    assert r.json()["yubikey"] is True


async def test_gdpr_export_has_the_new_fields(make_client, owner_conn):
    from app import db, gdpr
    admin, admin_key, bo, bo_key, uid = await _required_admin(make_client, owner_conn)
    await admin.post(f"/api/admin/users/{uid}/yubikey/link")
    async with db.connection() as conn:
        data = await gdpr.build_user_export(conn, uid)
    assert data["user"]["yubikey_required"] is True
    assert len(data["yubikey_enrollments"]) == 1 and "token_hash" not in data["yubikey_enrollments"][0]
    assert all("yubikey" in k for k in data["passkeys"])
    assert (await admin.get(f"/api/admin/users/{uid}")).json()["security"]["yubikey_attestation"] == "issuer"
