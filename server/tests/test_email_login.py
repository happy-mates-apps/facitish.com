"""Login with e-mail (the default), the super admin, and the mail providers."""

import dataclasses
import json

import httpx
import pytest

from app import config, mail
from tests.helpers import SoftAuthenticator, full_user, register_passkey


@pytest.fixture
def settings(monkeypatch):
    def set_(**values):
        monkeypatch.setattr(config, "settings", dataclasses.replace(config.settings, **values))
    return set_


async def email_login(client, email: str) -> dict:
    r = await client.post("/api/auth/otp/start", json={"email": email})
    assert r.status_code == 200, r.text
    r = await client.post("/api/auth/otp/verify", json={"email": email, "code": r.json()["dev_code"]})
    assert r.status_code == 200, r.text
    return r.json()


async def test_first_user_by_email_becomes_super_admin(make_client, owner_conn):
    first, second = make_client(), make_client()
    assert (await email_login(first, " Niels@Example.COM "))["became_admin"] is True
    assert (await email_login(second, "anna@example.com"))["became_admin"] is False
    rows = owner_conn.execute("select email, phone, role, super_admin from users order by id").fetchall()
    assert rows == [("niels@example.com", None, "admin", True), ("anna@example.com", None, "user", False)]
    me = (await first.get("/api/auth/me")).json()["user"]
    assert me["email"] == "niels@example.com" and me["super_admin"] is True
    masked = {r[0] for r in owner_conn.execute("select phone_masked from auth_log").fetchall()}
    assert masked == {"n•••@example.com", "a•••@example.com"}


async def test_email_logins_without_passkey(make_client):
    await email_login(make_client(), "admin@example.com")
    for _ in range(4):
        body = await email_login(make_client(), "anna@example.com")
        assert body["status"] == "logged_in" and body["offer_passkey"] is True
    client = make_client()
    await email_login(client, "anna@example.com")
    await register_passkey(client, SoftAuthenticator())
    assert (await client.get("/api/auth/me")).json()["user"]["passkeys"] == 1


async def test_invalid_or_missing_email(client):
    assert (await client.post("/api/auth/otp/start", json={"email": "not-an-email"})).status_code == 400
    assert (await client.post("/api/auth/otp/start", json={})).status_code == 400


async def test_phone_login_is_opt_in(client, settings):
    settings(sms_login=False)
    r = await client.post("/api/auth/otp/start", json={"phone": "12345678"})
    assert r.status_code == 400
    assert (await client.get("/api/public/config")).json()["sms_login"] is False


async def test_mail_failure_is_logged_and_reported(client, settings, owner_conn):
    settings(mail_provider="ahasend", ahasend_api_key=None, ahasend_account_id=None, mail_from=None)
    r = await client.post("/api/auth/otp/start", json={"email": "anna@example.com"})
    assert r.status_code == 502
    row = owner_conn.execute("select result, detail from auth_log where event = 'otp.sent'").fetchone()
    assert row[0] == "fail" and row[1]["reason"] == "mail_error" and "AHASEND_API_KEY" in row[1]["error"]
    assert owner_conn.execute("select count(*) from otp_codes").fetchone()[0] == 0


async def test_bootstrap_email_is_the_only_first_admin(make_client, settings, owner_conn):
    settings(bootstrap_admin_email="Owner@Example.com")
    assert (await make_client().get("/api/public/config")).json()["first_user"] is False
    assert (await email_login(make_client(), "early@example.com"))["became_admin"] is False
    assert (await email_login(make_client(), "owner@example.com"))["became_admin"] is True
    rows = dict(owner_conn.execute("select email, super_admin from users").fetchall())
    assert rows == {"early@example.com": False, "owner@example.com": True}


async def test_super_admin_is_protected_from_other_admins(make_client, owner_conn):
    owner = make_client()
    await full_user(owner, "11111111")                     # first user: super admin
    other = make_client()
    await full_user(other, "22222222")
    owner_conn.execute("update users set role = 'admin' where phone = '+4522222222'")
    owner_id, other_id = [r[0] for r in owner_conn.execute("select id from users order by id").fetchall()]

    assert (await other.patch(f"/api/admin/users/{owner_id}/role", json={"role": "user"})).status_code == 409
    assert (await other.post(f"/api/admin/users/{owner_id}/block")).status_code == 409
    # The super admin may manage other admins as usual.
    assert (await owner.patch(f"/api/admin/users/{other_id}/role", json={"role": "user"})).status_code == 200
    assert owner_conn.execute("select role, super_admin from users where id = %s", (owner_id,)).fetchone() == ("admin", True)


async def test_change_email_with_code(make_client, owner_conn):
    me = make_client()
    await email_login(me, "anna@example.com")
    await email_login(make_client(), "taken@example.com")
    assert (await me.post("/api/me/email/start", json={"email": "taken@example.com"})).status_code == 409
    assert (await me.post("/api/me/email/start", json={"email": "anna@example.com"})).status_code == 400
    code = (await me.post("/api/me/email/start", json={"email": "Anna@New.dk"})).json()["dev_code"]
    # An e-mail-change code cannot be used to log in as the new address.
    assert (await make_client().post("/api/auth/otp/verify", json={"email": "anna@new.dk", "code": code})).status_code == 400
    r = await me.post("/api/me/email/verify", json={"email": "anna@new.dk", "code": code})
    assert r.status_code == 200 and r.json()["email"] == "anna@new.dk"
    assert owner_conn.execute("select count(*) from users where email = 'anna@new.dk'").fetchone()[0] == 1


async def test_delete_account_confirmed_by_email(make_client, owner_conn):
    await email_login(make_client(), "boss@example.com")
    me = make_client()
    await email_login(me, "anna@example.com")
    assert (await me.post("/api/me/delete", json={"confirm": "other@example.com"})).status_code == 400
    assert (await me.post("/api/me/delete", json={"confirm": "ANNA@example.com"})).status_code == 200
    assert owner_conn.execute("select count(*) from users where email = 'anna@example.com'").fetchone()[0] == 0
    assert owner_conn.execute("select count(*) from auth_log where phone_masked = 'a•••@example.com'").fetchone()[0] == 0


# ── Mail providers ──────────────────────────────────────────────────────────

@pytest.fixture
def captured(monkeypatch):
    """Routes the providers' HTTP calls to a mock transport and records them."""
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if "mailjet" in request.url.host:
            return httpx.Response(200, json={"Messages": [{"Status": "success"}]})
        if "ahasend" in request.url.host:
            return httpx.Response(202, json={"object": "list", "data": [{"status": "queued"}]})
        return httpx.Response(200, json={})

    real = httpx.AsyncClient
    monkeypatch.setattr(mail.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    return calls


PROVIDERS = {
    "ahasend": dict(ahasend_api_key="aha-sk-x", ahasend_account_id="acc-1"),
    "scaleway": dict(scaleway_secret_key="scw-x", scaleway_project_id="proj-1", scaleway_region="fr-par"),
    "mailjet": dict(mailjet_api_key="mj-key", mailjet_api_secret="mj-secret"),
    "brevo": dict(brevo_api_key="brevo-x"),
    "lettermint": dict(lettermint_api_token="lm-x"),
}


@pytest.mark.parametrize("provider", PROVIDERS)
async def test_mail_providers_send_the_code(provider, settings, captured):
    settings(mail_provider=provider, mail_from="login@example.com", mail_from_name="Gær", **PROVIDERS[provider])
    assert mail.missing_config() == []
    subject, text, body = mail.otp_mail("123456", "Gær", 5)
    await mail.send_mail("anna@example.com", subject, text, body, "Gær")
    (request,) = captured
    payload = json.loads(request.content)
    if provider == "ahasend":
        assert str(request.url) == "https://api.ahasend.com/v2/accounts/acc-1/messages"
        assert request.headers["authorization"] == "Bearer aha-sk-x"
        assert payload["recipients"] == [{"email": "anna@example.com"}] and "123456" in payload["text_content"]
    elif provider == "scaleway":
        assert str(request.url) == "https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails"
        assert request.headers["x-auth-token"] == "scw-x"
        assert payload["project_id"] == "proj-1" and payload["to"] == [{"email": "anna@example.com"}]
    elif provider == "mailjet":
        assert str(request.url) == "https://api.mailjet.com/v3.1/send"
        assert request.headers["authorization"].startswith("Basic ")
        assert payload["Messages"][0]["To"] == [{"Email": "anna@example.com"}]
    elif provider == "lettermint":
        assert str(request.url) == "https://api.lettermint.co/v1/send"
        assert request.headers["x-lettermint-token"] == "lm-x"
        assert payload["to"] == ["anna@example.com"] and payload["from"] == '"Gær" <login@example.com>'
        return
    else:
        assert str(request.url) == "https://api.brevo.com/v3/smtp/email"
        assert request.headers["api-key"] == "brevo-x"
        assert payload["to"] == [{"email": "anna@example.com"}] and "123456" in payload["textContent"]
    sender = payload.get("from") or payload.get("sender") or payload["Messages"][0]["From"]
    assert "login@example.com" in sender.values()


async def test_demo_mode_logs_the_code_and_never_returns_it(make_client, settings, caplog, owner_conn):
    settings(demo_mode=True, environment="production", mail_provider="ahasend", ahasend_api_key=None)
    client = make_client()
    assert (await client.get("/api/public/config")).json()["demo_mode"] is True
    r = await client.post("/api/auth/otp/start", json={"email": "anna@example.com"})
    assert r.status_code == 200 and "dev_code" not in r.json()
    code = next(m.split(": ")[1].split(" ")[0] for m in caplog.messages if m.startswith("DEMO_MODE mail to anna@"))
    r = await client.post("/api/auth/otp/verify", json={"email": "anna@example.com", "code": code})
    assert r.status_code == 200 and r.json()["became_admin"] is True


def test_mail_config_lists_what_is_missing(settings):
    settings(mail_provider="brevo", brevo_api_key=None, mail_from=None)
    assert mail.missing_config() == ["BREVO_API_KEY", "MAIL_FROM"]
    settings(mail_provider="nope")
    assert mail.missing_config() == ["MAIL_PROVIDER"]
