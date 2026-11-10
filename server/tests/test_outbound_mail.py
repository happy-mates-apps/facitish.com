"""Outbound mail: the app's own mail through Lettermint, followed by webhook and by polling the Team API."""

import dataclasses
import json
import time

import httpx
import pytest

from app import config, jobs, outbound_mail, webhooks
from app.security import phone_hash
from tests.helpers import full_user


@pytest.fixture
def settings(monkeypatch):
    def set_(**values):
        monkeypatch.setattr(config, "settings", dataclasses.replace(config.settings, **values))
    return set_


@pytest.fixture
def lettermint(monkeypatch, settings):
    """Lettermint as mail provider: /v1/send answers a message id; /v1/messages (Team API) answers what the test puts
    in `messages`. Records every request."""
    settings(mail_provider="lettermint", lettermint_api_token="lm-x", mail_from="login@example.com", mail_from_name="Gær",
             lettermint_team_token="lm_team_x")
    state = {"calls": [], "messages": [], "sent": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        state["calls"].append(request)
        if request.url.path.endswith("/send"):
            state["sent"] += 1
            return httpx.Response(200, json={"message_id": f"msg-{state['sent']}"})
        if request.url.path.endswith("/messages"):
            assert request.headers["authorization"] == "Bearer lm_team_x"
            return httpx.Response(200, json={"data": state["messages"], "next_cursor": None})
        return httpx.Response(404)

    real = httpx.AsyncClient

    def client(**kw):  # the test client gives its own ASGI transport; the providers get the mock
        return real(**kw) if "transport" in kw else real(transport=httpx.MockTransport(handler), **kw)

    monkeypatch.setattr(httpx, "AsyncClient", client)
    return state


async def _admin(make_client):
    admin = make_client()
    await full_user(admin, "91111111")
    return admin


def _signed(secret: str, body: bytes, event: str) -> dict:
    ts = int(time.time())
    return {"content-type": "application/json", "x-lettermint-event": event, "x-lettermint-delivery": str(ts),
            "x-lettermint-signature": f"t={ts},v1={webhooks.sign(secret, ts, body)}"}


async def test_login_code_is_recorded_and_followed_by_webhook(make_client, owner_conn, lettermint):
    admin = await _admin(make_client)
    # A Lettermint-style endpoint: the t=…,v1=… scheme on X-Lettermint-Signature, with Lettermint's own secret.
    r = await admin.post("/api/admin/inbound-webhooks", json={
        "name": "Lettermint", "verify": "gaer", "header_name": "X-Lettermint-Signature", "secret": "whsec_lettermint",
        "handler": "lettermint", "event_header": "X-Lettermint-Event"})
    assert r.status_code == 201, r.text
    ep = r.json()
    assert ep["secret"] == "whsec_lettermint"

    # Somebody asks for a login code by e-mail: the send is recorded without the address in clear.
    r = await make_client().post("/api/auth/otp/start", json={"email": "mette@firma.dk"})
    assert r.status_code == 200 and "dev_code" not in r.json()
    row = owner_conn.execute("""select provider_message_id, user_id, recipient_hash, recipient_domain, purpose, subject, status,
                                       status_source from outbound_mail""").fetchone()
    assert row[0] == "msg-1" and row[1] is None and row[2] == phone_hash("mette@firma.dk") and row[3] == "firma.dk"
    assert row[4] == "login" and row[5].startswith("••• er din engangskode") and row[6:] == ("sent", "app")

    # Lettermint reports delivery. A later "sent" event cannot undo it; a bounce can.
    sender = make_client()
    sender.headers.pop("x-gaer")
    for name, delivery in (("message.delivered", "ev-1"), ("message.sent", "ev-2")):
        body = json.dumps({"id": delivery, "event": name, "timestamp": "2026-11-10T10:00:00Z",
                           "data": {"message_id": "msg-1", "subject": "123456 er din engangskode til Gær",
                                    "to": [{"email": "mette@firma.dk"}]}}).encode()
        r = await sender.post(f"/api/hooks/in/{ep['key']}", content=body, headers=_signed("whsec_lettermint", body, name))
        assert r.status_code == 202, r.text
    await jobs.run_pending()
    status, source, changed = owner_conn.execute("select status, status_source, status_changed_at from outbound_mail").fetchone()
    assert (status, source) == ("delivered", "webhook") and changed.isoformat().startswith("2026-11-10T10:00")

    body = json.dumps({"id": "ev-3", "event": "message.hard_bounced", "data": {"message_id": "msg-1"}}).encode()
    assert (await sender.post(f"/api/hooks/in/{ep['key']}", content=body, headers=_signed("whsec_lettermint", body, "message.hard_bounced"))).status_code == 202
    # A forged request with the wrong secret is turned away.
    assert (await sender.post(f"/api/hooks/in/{ep['key']}", content=body, headers=_signed("whsec_other", body, "message.hard_bounced"))).status_code == 401
    await jobs.run_pending()
    assert owner_conn.execute("select status from outbound_mail").fetchone()[0] == "hard_bounced"

    # The admin page: counts, the endpoint and the row — with domain only.
    r = await admin.get("/api/admin/mail/outbound")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["counts"]["total"] == 1 and d["counts"]["problems"] == 1 and d["webhook"]["last_event_at"]
    assert d["webhook_endpoints"][0]["header_name"] == "X-Lettermint-Signature" and d["team_token_set"] is True
    item = d["items"][0]
    assert item["recipient_domain"] == "firma.dk" and "mette" not in json.dumps(d) and "123456" not in json.dumps(d)
    assert (await admin.get("/api/admin/mail/outbound?status=problems")).json()["total"] == 1
    assert (await admin.get("/api/admin/mail/outbound?status=pending")).json()["total"] == 0


async def test_poll_fills_in_what_the_webhook_missed(make_client, owner_conn, lettermint):
    admin = await _admin(make_client)
    await make_client().post("/api/auth/otp/start", json={"email": "lars@firma.dk"})  # msg-1, status sent
    lettermint["messages"] = [
        {"id": "msg-1", "type": "outbound", "status": "delivered", "subject": "987654 er din engangskode til Gær",
         "from_email": "login@example.com", "to": [{"email": "lars@firma.dk"}], "created_at": "2026-11-10T09:00:00Z",
         "status_changed_at": "2026-11-10T09:00:05Z"},
        # Sent by another instance sharing the project, or before this table existed: a row is created, purpose guessed.
        {"id": "msg-old", "type": "outbound", "status": "soft_bounced", "subject": "Godkend adgang: Mette vil læse Salg",
         "from_email": "login@example.com", "to": [{"email": "ole@andet.dk"}], "created_at": "2026-11-09T09:00:00Z",
         "status_changed_at": "2026-11-09T09:01:00Z"},
    ]
    result = await outbound_mail.poll()
    assert result["seen"] == 2 and result["updated"] == 1 and result["created"] == 1
    q = lettermint["calls"][-1].url.params
    assert q["filter[type]"] == "outbound" and q["filter[from_email]"] == "login@example.com" and "filter[from_date]" in q
    rows = owner_conn.execute("""select provider_message_id, status, status_source, purpose, recipient_domain,
                                        subject ~ '^••• er din engangskode' as masked
                                 from outbound_mail order by provider_message_id""").fetchall()
    assert rows == [("msg-1", "delivered", "poll", "login", "firma.dk", True),
                    ("msg-old", "soft_bounced", "poll", "access", "andet.dk", False)]

    # The scheduled job and the admin button do the same; a second poll changes nothing.
    assert (await outbound_mail.poll_job({}, {}))["updated"] == 0
    r = await admin.post("/api/admin/mail/outbound/poll", json={"days": 3})
    assert r.status_code == 200 and r.json()["seen"] == 2
    assert owner_conn.execute("select count(*) from audit_log where action = 'mail.outbound_poll'").fetchone()[0] == 1


async def test_poll_needs_a_team_token(make_client, settings):
    admin = await _admin(make_client)
    settings(lettermint_team_token=None)
    assert await outbound_mail.poll() == {"skipped": "LETTERMINT_TEAM_TOKEN er ikke sat"}
    r = await admin.post("/api/admin/mail/outbound/poll", json={})
    assert r.status_code == 409
    assert (await admin.get("/api/admin/mail/outbound")).json()["team_token_set"] is False


def test_status_normalisation():
    assert outbound_mail.normalize_status("message.delivered") == "delivered"
    assert outbound_mail.normalize_status("message.hard_bounced") == "hard_bounced"
    assert outbound_mail.normalize_status("message.soft_bounced") == "soft_bounced"
    assert outbound_mail.normalize_status("message.spam_complaint") == "spam_complaint"
    assert outbound_mail.normalize_status("message.created") == "queued"
    assert outbound_mail.normalize_status("processed") == "sent"
    assert outbound_mail.normalize_status("whatever") == "unknown"
    assert outbound_mail.mask_subject("123456 er din engangskode til Gær") == "••• er din engangskode til Gær"


async def test_gdpr_export_and_erasure_cover_outbound_mail(make_client, owner_conn, lettermint):
    await _admin(make_client)
    # A code requested before the account exists: the row has no user_id, but matches the e-mail hash.
    await make_client().post("/api/auth/otp/start", json={"email": "anna@firma.dk"})
    assert owner_conn.execute("select count(*) from outbound_mail where user_id is null").fetchone()[0] == 1
    # Once the user exists, the next mail is hers.
    owner_conn.execute("insert into users (email, role) values ('anna@firma.dk', 'user')")
    uid = owner_conn.execute("select id from users where email = 'anna@firma.dk'").fetchone()[0]
    await make_client().post("/api/auth/otp/start", json={"email": "anna@firma.dk"})
    assert owner_conn.execute("select count(*) from outbound_mail where user_id = %s", (uid,)).fetchone()[0] == 1

    from app import db, gdpr
    from app.logs import RequestMeta
    async with db.connection() as conn:
        export = await gdpr.build_user_export(conn, uid)
    assert len(export["outbound_mail"]) == 2 and all(m["purpose"] == "login" for m in export["outbound_mail"])
    assert "anna" not in json.dumps(export["outbound_mail"], default=str)

    # Erasure removes both: the one that cascades with the user and the one that only matches the hash.
    await gdpr.erase_user(uid, actor_id=None, meta=RequestMeta(), reason="test")
    assert owner_conn.execute("select count(*) from outbound_mail").fetchone()[0] == 0
