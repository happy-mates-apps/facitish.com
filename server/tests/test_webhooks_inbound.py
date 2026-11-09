"""Incoming webhooks: the four ways of verifying, dedupe, limits, processing through the job queue, and admin."""

import base64
import hashlib
import hmac
import json
import time

import pytest

from app import jobs, webhooks, webhooks_in
from tests.helpers import full_user, otp_login


async def _admin(make_client, phone="91111111"):
    admin = make_client()
    await full_user(admin, phone)
    return admin


async def _endpoint(admin, **body) -> dict:
    r = await admin.post("/api/admin/inbound-webhooks", json={"name": "Test", **body})
    assert r.status_code == 201, r.text
    return r.json()


def _path(ep: dict) -> str:
    return "/api/hooks/in/" + ep["key"]


def _gaer_headers(secret: str, body: bytes, *, ts: int | None = None, delivery: str = "d-1") -> dict:
    ts = ts or int(time.time())
    return {"content-type": "application/json", "x-gaer-event": "user.created", "x-gaer-delivery": delivery,
            "x-gaer-signature": f"t={ts},v1={webhooks.sign(secret, ts, body)}"}


async def test_gaer_signature_dedupe_and_processing(make_client, owner_conn):
    admin = await _admin(make_client)
    ep = await _endpoint(admin)  # verify=gaer by default
    assert ep["secret"].startswith("whsec_") and ep["url"].endswith(ep["key"])
    sender = make_client()
    sender.headers.pop("x-gaer")  # other systems do not send our CSRF header
    body = json.dumps({"event": "user.created", "data": {"user_id": 7}}).encode()

    r = await sender.post(_path(ep), content=body, headers=_gaer_headers(ep["secret"], body))
    assert r.status_code == 202, r.text
    event_id = r.json()["id"]
    r = await sender.post(_path(ep), content=body, headers=_gaer_headers(ep["secret"], body))
    assert r.status_code == 200 and r.json() == {"id": event_id, "duplicate": True}

    # Wrong secret, tampered body, old timestamp, no signature: 401, and not stored.
    for headers, content in ((_gaer_headers("whsec_wrong", body, delivery="x"), body),
                             (_gaer_headers(ep["secret"], body, delivery="y"), body + b" "),
                             (_gaer_headers(ep["secret"], body, ts=int(time.time()) - 3600, delivery="z"), body),
                             ({"content-type": "application/json"}, body)):
        assert (await sender.post(_path(ep), content=content, headers=headers)).status_code == 401
    assert (await sender.post("/api/hooks/in/in_unknown", content=body)).status_code == 404

    await jobs.run_pending()
    events = (await admin.get(f"/api/admin/inbound-webhooks/{ep['id']}/events")).json()
    assert len(events) == 1
    e = events[0]
    assert e["status"] == "processed" and e["event"] == "user.created" and e["external_id"] == "d-1"
    assert e["body_json"]["data"]["user_id"] == 7 and "x-gaer-signature" not in e["headers"]
    item = (await admin.get("/api/admin/inbound-webhooks")).json()["items"][0]
    assert item["received_count"] == 1 and item["rejected_count"] == 4
    assert item["last_rejected_reason"] == "missing_signature"
    assert "secret" not in item and "secret_enc" not in item


async def test_outgoing_gaer_webhook_is_accepted_by_inbound(make_client, monkeypatch):
    """Two Gær instances: our outgoing delivery verifies at our own inbound endpoint."""
    import httpx
    from app.main import app
    admin = await _admin(make_client, "91111112")
    ep = await _endpoint(admin, name="Fra anden Gær")
    monkeypatch.setattr(webhooks, "transport", httpx.ASGITransport(app=app, client=("198.51.100.4", 4000)))
    hook = (await admin.post("/api/admin/webhooks", json={
        "name": "Til os selv", "url": "http://localhost" + _path(ep), "events": ["webhook.ping"]})).json()
    r = await admin.patch(f"/api/admin/inbound-webhooks/{ep['id']}", json={"secret": hook["secret"]})
    assert r.status_code == 200
    r = await admin.post(f"/api/admin/webhooks/{hook['id']}/test")
    assert r.json()["ok"] is True and r.json()["status"] == 202


@pytest.mark.parametrize("fmt", ["prefixed", "hex", "base64"])
async def test_generic_hmac_header(make_client, fmt):
    admin = await _admin(make_client, f"9222222{len(fmt)}")
    ep = await _endpoint(admin, verify="hmac", header_name="X-Hub-Signature-256", secret="sender-secret",
                         event_header="X-GitHub-Event", id_header="X-GitHub-Delivery")
    assert ep["secret"] == "sender-secret"  # the sender's own secret was given
    body = b'{"ref": "refs/heads/main"}'
    digest = hmac.new(b"sender-secret", body, hashlib.sha256).digest()
    value = {"prefixed": "sha256=" + digest.hex(), "hex": digest.hex(), "base64": base64.b64encode(digest).decode()}[fmt]
    sender = make_client()
    r = await sender.post(_path(ep), content=body, headers={"X-Hub-Signature-256": value, "X-GitHub-Event": "push",
                                                            "X-GitHub-Delivery": "gh-1"})
    assert r.status_code == 202
    r = await sender.post(_path(ep), content=body + b"x", headers={"X-Hub-Signature-256": value})
    assert r.status_code == 401
    e = (await admin.get(f"/api/admin/inbound-webhooks/{ep['id']}/events")).json()[0]
    assert (e["event"], e["external_id"]) == ("push", "gh-1")


async def test_token_header_and_no_auth(make_client, owner_conn):
    admin = await _admin(make_client, "93333333")
    with_token = await _endpoint(admin, verify="token")  # generated: Authorization: Bearer …
    assert with_token["header_name"] == "Authorization" and with_token["secret"].startswith("Bearer ")
    without = await _endpoint(admin, verify="none", event_field="data.type")
    assert without["secret"] is None
    sender = make_client()
    body = b'{"data": {"type": "order.paid"}}'
    assert (await sender.post(_path(with_token), content=body)).status_code == 401
    assert (await sender.post(_path(with_token), content=body, headers={"Authorization": "Bearer nope"})).status_code == 401
    r = await sender.post(_path(with_token), content=body, headers={"Authorization": with_token["secret"]})
    assert r.status_code == 202
    r = await sender.post(_path(without), content=body)
    assert r.status_code == 202
    stored = owner_conn.execute("select headers, event from webhook_inbound where endpoint_id = %s",
                                (with_token["id"],)).fetchone()
    assert "authorization" not in stored[0]
    assert owner_conn.execute("select event from webhook_inbound where endpoint_id = %s",
                              (without["id"],)).fetchone()[0] == "order.paid"
    logged = json.dumps([r for r in owner_conn.execute(
        "select before, after from audit_log where table_name = 'webhook_endpoints'")])
    assert with_token["secret"] not in logged


async def test_limits_ip_allowlist_and_inactive(make_client):
    admin = await _admin(make_client, "94444444")
    ep = await _endpoint(admin, verify="none", max_body_kb=1, max_per_minute=2, allowed_ips=["203.0.113.0/24"])
    sender = make_client()  # the test client comes from 203.0.113.7
    assert (await sender.post(_path(ep), content=b"x" * 2000)).status_code == 413
    assert (await sender.post(_path(ep), content=b"1")).status_code == 202
    assert (await sender.post(_path(ep), content=b"2")).status_code == 202
    assert (await sender.post(_path(ep), content=b"3")).status_code == 429
    await admin.patch(f"/api/admin/inbound-webhooks/{ep['id']}", json={"allowed_ips": ["10.0.0.0/8"], "max_per_minute": 100})
    assert (await sender.post(_path(ep), content=b"4")).status_code == 403
    assert (await admin.patch(f"/api/admin/inbound-webhooks/{ep['id']}", json={"allowed_ips": ["nope"]})).status_code == 400
    await admin.patch(f"/api/admin/inbound-webhooks/{ep['id']}", json={"allowed_ips": [], "active": False})
    assert (await sender.post(_path(ep), content=b"5")).status_code == 404

    # A new URL: the old one stops working.
    await admin.patch(f"/api/admin/inbound-webhooks/{ep['id']}", json={"active": True})
    new_url = (await admin.post(f"/api/admin/inbound-webhooks/{ep['id']}/rotate?what=key")).json()["url"]
    assert (await sender.post(_path(ep), content=b"6")).status_code == 404
    assert (await sender.post(new_url.split("localhost:5173")[1], content=b"6")).status_code == 202


async def test_failing_handler_retries_and_replay(make_client, owner_conn, monkeypatch):
    calls = []

    @webhooks_in.handler("flaky", "Fejler første gang")
    async def flaky(event, endpoint):
        calls.append(event["id"])
        if len(calls) == 1:
            raise RuntimeError("nede")
        return {"ok": len(calls)}

    try:
        admin = await _admin(make_client, "95555555")
        ep = await _endpoint(admin, verify="none", handler="flaky")
        r = await admin.post("/api/admin/inbound-webhooks", json={"name": "x", "handler": "findes-ikke"})
        assert r.status_code == 400
        event_id = (await make_client().post(_path(ep), content=b"{}")).json()["id"]
        await jobs.run_pending()
        e = (await admin.get(f"/api/admin/inbound-webhooks/{ep['id']}/events")).json()[0]
        assert e["status"] == "received" and e["error"] == "nede"
        owner_conn.execute("update jobs set run_at = now() where status = 'queued'")
        await jobs.run_pending()
        e = (await admin.get(f"/api/admin/inbound-webhooks/{ep['id']}/events")).json()[0]
        assert e["status"] == "processed" and e["result"] == {"ok": 2} and e["attempts"] == 2

        assert (await admin.post(f"/api/admin/inbound-webhooks/events/{event_id}/replay")).status_code == 200
        await jobs.run_pending()
        assert len(calls) == 3
        assert owner_conn.execute("select count(*) from audit_log where action = 'webhook.received'").fetchone()[0] >= 1
    finally:
        webhooks_in.HANDLERS.pop("flaky", None)


async def test_inbound_admin_needs_admin(make_client):
    await _admin(make_client, "96666666")
    user = make_client()
    await otp_login(user, "96666667")
    assert (await user.get("/api/admin/inbound-webhooks")).status_code == 403
    assert (await user.post("/api/admin/inbound-webhooks", json={"name": "x"})).status_code == 403
