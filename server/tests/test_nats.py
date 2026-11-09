"""/admin/nats: monitoring of the NATS server through its HTTP monitoring port (app.nats_monitor)."""

import dataclasses

import httpx
import pytest

from app import admin_roles, config, nats_monitor
from tests.helpers import full_user, otp_login

seen: list[httpx.Request] = []

VARZ = {"server_id": "NABC", "server_name": "gaer-nats", "version": "2.15.2", "now": "2026-11-09T10:00:00Z",
        "connections": 3, "subscriptions": 12, "in_msgs": 100, "out_msgs": 90, "auth_required": True,
        "jetstream": {"config": {"max_storage": 10_737_418_240, "store_dir": "/data/jetstream"},
                      "stats": {"storage": 2048}}}
JSZ = {"config": {"max_storage": 10_737_418_240}, "streams": 1, "consumers": 1, "messages": 50,
       "account_details": [{"name": "$G", "stream_detail": [{"name": "ORDERS", "state": {"messages": 50}}]}]}


def monitor(healthy: bool = True, down: bool = False):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if down:
            raise httpx.ConnectError("refused")
        path = request.url.path.lstrip("/")
        if path == "varz":
            return httpx.Response(200, json=VARZ)
        if path == "healthz":
            if healthy:
                return httpx.Response(200, json={"status": "ok"})
            return httpx.Response(503, json={"status": "unavailable", "error": "JetStream is not current"})
        if path == "jsz":
            return httpx.Response(200, json=JSZ)
        if path == "connz":
            return httpx.Response(200, json={"num_connections": 1, "total": 1, "connections": [
                {"cid": 7, "name": "worker", "ip": "172.18.0.4", "port": 51234, "auth_token": "s3cret-token"}]})
        return httpx.Response(404, text="not found")
    return httpx.MockTransport(handler)


@pytest.fixture
def nats_on(monkeypatch):
    seen.clear()
    monkeypatch.setattr(config, "settings", dataclasses.replace(
        config.settings, nats_monitor_url="http://nats:8222", nats_url="nats://abcdef123456@nats:4222"))

    def use(**kw):
        monkeypatch.setattr(nats_monitor, "transport", monitor(**kw))
    use()
    return use


async def test_not_configured_says_so(client, monkeypatch):
    monkeypatch.setattr(config, "settings", dataclasses.replace(config.settings, nats_monitor_url=None))
    await full_user(client, "11111111")
    r = await client.get("/api/admin/nats")
    assert r.status_code == 200
    assert r.json()["configured"] is False and r.json()["reachable"] is False
    r = await client.get("/api/admin/nats/varz")
    assert r.status_code == 503 and "ikke sat op" in r.json()["detail"]


async def test_overview_reads_server_health_and_jetstream(client, nats_on, owner_conn):
    await full_user(client, "11111111")
    r = await client.get("/api/admin/nats")
    assert r.status_code == 200
    body = r.json()
    assert body["reachable"] is True and body["error"] is None
    assert body["varz"]["server_name"] == "gaer-nats"
    assert body["health"]["status"] == "ok"
    assert body["jsz"]["streams"] == 1
    # Credentials in NATS_URL are never shown.
    assert body["client_url"] == "nats://••••@nats:4222"
    assert {e["key"] for e in body["endpoints"]} >= {"varz", "connz", "jsz", "subsz", "routez", "gatewayz", "leafz", "healthz"}
    # Like every /admin read, it is in the audit log.
    row = owner_conn.execute("select detail->>'path' from audit_log where action = 'admin.read' order by id desc limit 1").fetchone()
    assert row == ("/api/admin/nats",)


async def test_unhealthy_and_unreachable(client, nats_on):
    await full_user(client, "11111111")
    nats_on(healthy=False)
    body = (await client.get("/api/admin/nats")).json()
    assert body["reachable"] is True and body["health"]["status"] == "unavailable" and body["health"]["http_status"] == 503

    nats_on(down=True)
    body = (await client.get("/api/admin/nats")).json()
    assert body["reachable"] is False and "svarer ikke" in body["error"]
    r = await client.get("/api/admin/nats/connz")
    assert r.status_code == 502


async def test_endpoints_are_whitelisted_and_secrets_masked(client, nats_on):
    await full_user(client, "11111111")
    r = await client.get("/api/admin/nats/connz?sort=msgs_to&state=open&limit=50&subs=detail")
    assert r.status_code == 200
    conn = r.json()["data"]["connections"][0]
    assert conn["name"] == "worker" and conn["auth_token"] == "••••"
    assert seen[-1].url.path == "/connz" and seen[-1].url.params["sort"] == "msgs_to"

    assert (await client.get("/api/admin/nats/stacksz")).status_code == 404       # not a monitoring endpoint we allow
    assert (await client.get("/api/admin/nats/connz?sort=drop")).status_code == 400
    assert (await client.get("/api/admin/nats/connz?limit=99999")).status_code == 400
    assert (await client.get("/api/admin/nats/varz?x=1")).status_code == 400
    assert (await client.get("/api/admin/nats/..%2Fvarz")).status_code == 404
    assert all(req.url.path.lstrip("/") in nats_monitor.ENDPOINTS for req in seen)


async def test_only_admins_with_drift_or_full_access(make_client, nats_on):
    boss = make_client()
    await full_user(boss, "11111111")
    other = make_client()
    await full_user(other, "22222222")
    other_id = (await boss.get("/api/admin/users")).json()["items"][1]["id"]

    assert (await other.get("/api/admin/nats")).status_code == 403             # not admin
    assert (await boss.patch(f"/api/admin/users/{other_id}/role", json={"role": "admin"})).status_code == 200
    assert (await boss.put(f"/api/admin/users/{other_id}/admin-roles", json={"roles": ["support"]})).status_code == 200
    assert (await other.get("/api/admin/nats")).status_code == 403
    assert (await boss.put(f"/api/admin/users/{other_id}/admin-roles", json={"roles": ["drift"]})).status_code == 200
    assert (await other.get("/api/admin/nats")).status_code == 200
    assert "/nats" in (await other.get("/api/auth/me")).json()["user"]["admin_sections"]
    assert "/nats" in admin_roles.sections(["drift"])


async def test_plain_user_cannot_read(make_client, nats_on):
    boss = make_client()
    await full_user(boss, "11111111")
    user = make_client()
    await otp_login(user, "22222222")
    assert (await user.get("/api/admin/nats/varz")).status_code == 403


def test_redact_url():
    assert nats_monitor.redact_url("nats://tok@nats:4222") == "nats://••••@nats:4222"
    assert nats_monitor.redact_url("nats://u:p@h:4222") == "nats://••••@h:4222"
    assert nats_monitor.redact_url("nats://nats:4222") == "nats://nats:4222"
    assert nats_monitor.redact_url(None) is None
