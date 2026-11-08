"""MFA: /admin needs a second factor after the grace logins, users may opt in ("Kræv passkey"), factors are passkeys,
security keys and authenticator apps (TOTP). Plus the profile API and the admin user API."""

import io
import json
import zipfile

from tests.helpers import SoftAuthenticator, full_user, otp_login, passkey_login, register_passkey, stepup, totp_code

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 64


async def _totp(client) -> tuple[int, str]:
    """Adds an authenticator app and returns (factor id, secret)."""
    r = await client.post("/api/me/totp", json={"name": "Telefon"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["uri"].startswith("otpauth://totp/") and "<svg" in body["qr_svg"]
    r = await client.post(f"/api/me/totp/{body['id']}/confirm", json={"code": totp_code(body["secret"])})
    assert r.status_code == 200, r.text
    return body["id"], body["secret"]


# ── /admin ──────────────────────────────────────────────────────────────────

async def test_admin_with_passkey_steps_up_after_code_login(make_client, owner_conn):
    authenticator = await full_user(make_client(), "11111111")
    client = make_client()
    body = await otp_login(client, "11111111")
    assert body["admin_grace_left"] is None  # has a factor: no grace logins
    r = await client.get("/api/admin/users")
    assert r.status_code == 403 and r.headers["x-gaer-error"] == "mfa_required"
    old_cookie = client.cookies.get("gaer_session")

    # Without user verification (a key without PIN) it does not count.
    assert (await stepup(client, authenticator, uv=False)).status_code == 400
    assert (await stepup(client, authenticator)).status_code == 200
    assert client.cookies.get("gaer_session") != old_cookie  # a new token, the old session is revoked
    assert (await client.get("/api/admin/users")).status_code == 200
    events = [r[0] for r in owner_conn.execute("select event from auth_log where event like 'mfa.%' order by id")]
    assert events == ["mfa.failed", "mfa.verified"]


async def test_passkey_login_with_user_verification_opens_admin(make_client):
    authenticator = await full_user(make_client(), "11111111")
    client = make_client()
    assert (await passkey_login(client, authenticator)).status_code == 200
    assert (await client.get("/api/admin/users")).status_code == 200
    # The same key without user verification is one factor only.
    client = make_client()
    assert (await passkey_login(client, authenticator, uv=False)).json()["status"] == "logged_in"
    assert (await client.get("/api/admin/users")).headers["x-gaer-error"] == "mfa_required"


async def test_grace_login_is_not_enough_for_security_actions(make_client):
    admin = make_client()
    await otp_login(admin, "11111111")  # first grace login
    await otp_login(make_client(), "22222222")
    users = (await admin.get("/api/admin/users")).json()["items"]
    r = await admin.patch(f"/api/admin/users/{users[1]['id']}/role", json={"role": "admin"})
    assert r.status_code == 403 and r.headers["x-gaer-error"] == "stepup_required"


async def test_grace_and_mfa_expire_for_admin(make_client, owner_conn):
    client = make_client()
    await otp_login(client, "11111111")
    assert (await client.get("/api/admin/users")).status_code == 200
    owner_conn.execute("update sessions set created_at = now() - interval '13 hours'")
    assert (await client.get("/api/admin/users")).status_code == 403

    authenticator = await full_user(make_client(), "22222222")
    owner_conn.execute("update users set role = 'admin' where phone = '+4522222222'")
    client = make_client()
    assert (await passkey_login(client, authenticator)).status_code == 200
    assert (await client.get("/api/admin/users")).status_code == 200
    owner_conn.execute("update sessions set mfa_at = now() - interval '13 hours' where mfa_at is not null")
    assert (await client.get("/api/admin/users")).headers["x-gaer-error"] == "mfa_required"


async def test_first_factor_revokes_other_grace_sessions(make_client):
    laptop, phone = make_client(), make_client()
    await otp_login(laptop, "11111111")
    await otp_login(phone, "11111111")
    await register_passkey(laptop, SoftAuthenticator())
    assert (await phone.get("/api/auth/me")).json() == {"user": None}
    assert (await laptop.get("/api/admin/users")).status_code == 200


# ── "Kræv passkey" (opt-in) ─────────────────────────────────────────────────

async def test_mfa_opt_in_needs_a_factor_and_then_a_second_step(make_client, owner_conn):
    await otp_login(make_client(), "11111111")  # admin
    client = make_client()
    await otp_login(client, "22222222")
    assert (await client.put("/api/me/mfa", json={"required": True})).status_code == 409  # no factor yet
    authenticator = SoftAuthenticator()
    await register_passkey(client, authenticator)
    assert (await client.put("/api/me/mfa", json={"required": True})).status_code == 200

    client = make_client()
    body = await otp_login(client, "22222222")
    assert body == {"status": "mfa_required", "methods": ["passkey"]}
    assert (await client.get("/api/auth/me")).json()["scope"] == "mfa"
    r = await client.get("/api/me/profile")
    assert r.status_code == 403 and r.headers["x-gaer-error"] == "mfa_required"
    r = await client.post("/api/auth/passkey/register/options")  # a pending login cannot add its own key
    assert r.status_code == 403
    assert (await stepup(client, authenticator)).status_code == 200
    assert (await client.get("/api/me/profile")).status_code == 200


async def test_mfa_opt_in_fails_closed_without_factors(make_client, owner_conn):
    await otp_login(make_client(), "11111111")
    owner_conn.execute("insert into users (phone, mfa_required) values ('+4533333333', true)")
    client = make_client()
    assert await otp_login(client, "33333333") == {"status": "mfa_required", "methods": []}
    assert (await client.get("/api/me/profile")).status_code == 403


async def test_last_factor_cannot_be_removed_while_mfa_is_required(make_client):
    await otp_login(make_client(), "11111111")
    client = make_client()
    await otp_login(client, "22222222")
    await register_passkey(client, SoftAuthenticator())
    await client.put("/api/me/mfa", json={"required": True})
    passkey_id = (await client.get("/api/me/passkeys")).json()[0]["id"]
    assert (await client.delete(f"/api/me/passkeys/{passkey_id}")).status_code == 409
    assert (await client.put("/api/me/mfa", json={"required": False})).status_code == 200
    assert (await client.delete(f"/api/me/passkeys/{passkey_id}")).status_code == 200


# ── Authenticator apps ──────────────────────────────────────────────────────

async def test_totp_setup_login_and_replay(make_client, owner_conn):
    await otp_login(make_client(), "11111111")
    client = make_client()
    await otp_login(client, "22222222")
    _, secret = await _totp(client)
    assert owner_conn.execute("select secret_enc from totp_factors").fetchone()[0] != secret.encode()
    await client.put("/api/me/mfa", json={"required": True})

    client = make_client()
    assert (await otp_login(client, "22222222"))["methods"] == ["totp"]
    code = totp_code(secret, 1)
    assert (await client.post("/api/auth/mfa/totp/verify", json={"code": code})).status_code == 200
    # The same code again (another pending login) is refused.
    other = make_client()
    await otp_login(other, "22222222")
    assert (await other.post("/api/auth/mfa/totp/verify", json={"code": code})).status_code == 400


async def test_totp_wrong_codes_lock(make_client):
    await otp_login(make_client(), "11111111")
    client = make_client()
    await otp_login(client, "22222222")
    await _totp(client)
    await client.put("/api/me/mfa", json={"required": True})
    client = make_client()
    await otp_login(client, "22222222")
    for _ in range(5):
        assert (await client.post("/api/auth/mfa/totp/verify", json={"code": "000000"})).status_code in (400, 429)
    assert (await client.post("/api/auth/mfa/totp/verify", json={"code": "000000"})).status_code == 429


async def test_second_factor_needs_step_up(make_client):
    await otp_login(make_client(), "11111111")
    first = make_client()
    await otp_login(first, "22222222")
    _, secret = await _totp(first)
    client = make_client()
    await otp_login(client, "22222222")  # a code only: may not add a factor to an account that has one
    r = await client.post("/api/me/totp")
    assert r.status_code == 403 and r.headers["x-gaer-error"] == "stepup_required"
    assert (await client.post("/api/auth/mfa/totp/verify", json={"code": totp_code(secret, 1)})).status_code == 200
    assert (await client.post("/api/me/totp")).status_code == 200


# ── Security overview, profile and avatar ───────────────────────────────────

async def test_security_overview(make_client):
    client = make_client()
    await otp_login(client, "11111111")
    sec = (await client.get("/api/me/security")).json()
    assert sec["factors"]["total"] == 0 and sec["admin"]["grace_left"] == 2
    assert set(sec["advice"]) == {"add_passkey", "admin_needs_mfa"}
    await register_passkey(client, SoftAuthenticator())
    sec = (await client.get("/api/me/security")).json()
    assert sec["methods"] == ["passkey"] and sec["session"]["stepup_ok"] is True
    assert sec["advice"] == ["add_backup_factor"]


async def test_profile_fields_and_avatar(make_client, owner_conn):
    client = make_client()
    await otp_login(client, "11111111")
    r = await client.patch("/api/me/profile", json={"display_name": "Niels", "locale": "en", "time_zone": "Europe/Copenhagen"})
    assert r.status_code == 200
    assert (await client.patch("/api/me/profile", json={"locale": "fr"})).status_code == 400
    assert (await client.patch("/api/me/profile", json={"time_zone": "Mars/Base"})).status_code == 400
    profile = (await client.get("/api/me/profile")).json()
    assert (profile["display_name"], profile["locale"], profile["time_zone"]) == ("Niels", "en", "Europe/Copenhagen")

    bad = await client.put("/api/me/avatar", files={"file": ("x.png", b"<svg/>", "image/png")})
    assert bad.status_code == 400
    r = await client.put("/api/me/avatar", files={"file": ("me.png", PNG, "image/png")})
    assert r.status_code == 200
    avatar = await client.get("/api/me/avatar")
    assert avatar.status_code == 200 and avatar.headers["content-type"] == "image/png" and avatar.content == PNG
    assert (await client.get("/api/files")).json() == []  # not listed with the user's files
    r = await client.put("/api/me/avatar", files={"file": ("new.png", PNG, "image/png")})
    assert owner_conn.execute("select count(*) from files where kind = 'avatar'").fetchone()[0] == 1

    export = await client.get("/api/me/export")
    data = json.loads(zipfile.ZipFile(io.BytesIO(export.content)).read("data.json"))
    assert data["user"]["locale"] == "en" and data["user"]["avatar_file_id"]
    assert "totp_factors" in data


async def test_gdpr_export_has_totp_without_secret(make_client):
    client = make_client()
    await otp_login(client, "11111111")
    await _totp(client)
    export = await client.get("/api/me/export")
    raw = zipfile.ZipFile(io.BytesIO(export.content)).read("data.json").decode()
    data = json.loads(raw)
    assert data["totp_factors"][0]["name"] == "Telefon"
    assert "secret" not in raw


# ── Admin user API ──────────────────────────────────────────────────────────

async def test_admin_user_detail_profile_and_reset_mfa(make_client, owner_conn):
    super_admin = make_client()
    await full_user(super_admin, "11111111")
    user = make_client()
    await otp_login(user, "22222222")
    await register_passkey(user, SoftAuthenticator())
    await _totp(user)
    await user.put("/api/me/mfa", json={"required": True})
    user_id = owner_conn.execute("select id from users where phone = '+4522222222'").fetchone()[0]

    detail = (await super_admin.get(f"/api/admin/users/{user_id}")).json()
    assert detail["user"]["mfa_required"] is True
    assert detail["security"]["factors"]["total"] == 2 and detail["security"]["methods"] == ["passkey", "totp"]
    assert "secret_enc" not in json.dumps(detail)

    r = await super_admin.patch(f"/api/admin/users/{user_id}/profile", json={"display_name": "Anna", "locale": "da"})
    assert r.status_code == 200
    assert owner_conn.execute("select display_name, locale from users where id = %s", (user_id,)).fetchone() == ("Anna", "da")

    r = await super_admin.post(f"/api/admin/users/{user_id}/reset-mfa")
    assert r.json()["deleted"] == {"keys": 1, "apps": 1}
    assert owner_conn.execute("select mfa_required from users where id = %s", (user_id,)).fetchone()[0] is False
    assert (await user.get("/api/auth/me")).json() == {"user": None}  # logged out everywhere
    assert (await otp_login(make_client(), "22222222"))["status"] == "logged_in"


async def test_only_super_admin_resets_another_admins_mfa(make_client, owner_conn):
    await full_user(make_client(), "11111111")  # super admin
    second = make_client()
    await full_user(second, "22222222")
    third = make_client()
    await full_user(third, "33333333")
    owner_conn.execute("update users set role = 'admin' where phone in ('+4522222222', '+4533333333')")
    third_id = owner_conn.execute("select id from users where phone = '+4533333333'").fetchone()[0]
    assert (await second.post(f"/api/admin/users/{third_id}/reset-mfa")).status_code == 403
    assert (await third.post(f"/api/admin/users/{third_id}/reset-mfa")).status_code == 409  # own: use /konto


async def test_code_alone_cannot_move_or_delete_an_account_with_a_factor(make_client):
    await otp_login(make_client(), "11111111")
    owner = make_client()
    await otp_login(owner, "22222222")
    _, secret = await _totp(owner)
    thief = make_client()
    await otp_login(thief, "22222222")  # only the code
    for r in (await thief.post("/api/me/phone/start", json={"phone": "33333333"}),
              await thief.post("/api/me/delete", json={"confirm": "+4522222222"})):
        assert r.status_code == 403 and r.headers["x-gaer-error"] == "stepup_required"
    assert (await owner.get("/api/auth/me")).json()["user"] is not None
    # With the second factor the owner may.
    assert (await thief.post("/api/auth/mfa/totp/verify", json={"code": totp_code(secret, 1)})).status_code == 200
    assert (await thief.post("/api/me/phone/start", json={"phone": "33333333"})).status_code == 200
