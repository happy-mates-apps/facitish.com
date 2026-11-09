"""/admin/resources: resources, limits and prices (app.resources), events (app.events) and kill switches (app.killswitch)."""

import dataclasses
import json
import uuid

import httpx
import pytest

from app import admin_roles, config, events, killswitch, nats_monitor
from tests.helpers import full_user

H = {"X-Gaer": "1"}


def rows(body: dict) -> dict:
    return {r["key"]: r for c in body["categories"] for r in c["items"]}


@pytest.fixture
def no_nats(monkeypatch):
    monkeypatch.setattr(config, "settings", dataclasses.replace(config.settings, nats_monitor_url=None, nats_url=None))


# ── Resources ───────────────────────────────────────────────────────────────

async def test_overview_lists_what_can_be_measured(client, no_nats, owner_conn):
    await full_user(client, "11111111")
    r = await client.get("/api/admin/resources")
    assert r.status_code == 200, r.text
    body = r.json()
    found = rows(body)
    assert {"cpu", "disk", "pg_storage", "pg_connections", "s3_storage", "email", "jobs",
            "ev_stream", "ev_table", "ev_ingest", "ev_retention"} <= set(found)
    assert found["pg_connections"]["max"] > 0 and found["pg_connections"]["used"] >= 1
    assert found["disk"]["max"] > found["disk"]["used"] > 0
    assert found["pg_storage"]["status"] == "none"          # no limit known until the admin sets one
    assert found["ev_stream"]["status_label"] == "Uden NATS"
    assert found["ev_retention"]["status_label"] == "Oprydning aktiv" and found["ev_retention"]["max"] == 7 * 86400
    assert found["ev_retention"]["pct"] is None
    assert body["events"]["bus"] == "postgres" and body["events"]["ttl_days"] == 7
    assert body["total_cost"] is None
    row = owner_conn.execute("select detail->>'path' from audit_log where action = 'admin.read' order by id desc limit 1").fetchone()
    assert row == ("/api/admin/resources",)


async def test_limits_and_prices_are_saved_audited_and_used(client, no_nats, owner_conn):
    await full_user(client, "11111111")
    config_in = {"items": {
        "pg_storage": {"max": 20},                                   # GB
        "disk": {"monthly": 120},                                    # the server
        "email": {"max": 3000, "unit_price": 0.5},
        "ai_tokens": {"unit_price": 9},
    }}
    r = await client.put("/api/admin/resources/config", json=config_in, headers=H)
    assert r.status_code == 200, r.text
    body = (await client.get("/api/admin/resources")).json()
    found = rows(body)
    assert found["pg_storage"]["max"] == 20 * 1_000_000_000 and found["pg_storage"]["max_measured"] is False
    assert found["disk"]["cost"] == 120
    assert found["email"]["max"] == 3000
    assert found["email"]["cost"] == round(found["email"]["used"] * 0.5, 2)
    assert body["total_cost"] >= 120
    assert next(c for c in body["categories"] if c["key"] == "server")["cost"] == 120
    audit = owner_conn.execute("""select after from audit_log where table_name = 'settings' and row_id = 'resources'
                                  order by id desc limit 1""").fetchone()
    assert audit and audit[0]["disk"]["monthly"] == 120

    r = await client.put("/api/admin/resources/config", json={"items": {"disk": {"monthly": 120}}}, headers=H)
    assert r.status_code == 200
    audit = owner_conn.execute("""select before, after from audit_log where table_name = 'settings' and row_id = 'resources'
                                  order by id desc limit 1""").fetchone()
    assert audit[0]["pg_storage"] == {"max": 20, "monthly": None, "unit_price": None} and audit[1]["pg_storage"] is None


async def test_unknown_resource_and_bad_values_are_refused(client, no_nats):
    await full_user(client, "11111111")
    r = await client.put("/api/admin/resources/config", json={"items": {"rocket": {"max": 1}}}, headers=H)
    assert r.status_code == 422
    r = await client.put("/api/admin/resources/config", json={"items": {"disk": {"max": -1}}}, headers=H)
    assert r.status_code == 422


async def test_one_failing_source_does_not_break_the_page(client, monkeypatch):
    monkeypatch.setattr(config, "settings", dataclasses.replace(config.settings, nats_monitor_url="http://nats:8222"))

    def down(request):
        raise httpx.ConnectError("refused")
    monkeypatch.setattr(nats_monitor, "transport", httpx.MockTransport(down))
    await full_user(client, "11111111")
    found = rows((await client.get("/api/admin/resources")).json())
    assert found["nats_error"]["status"] == "error"
    assert found["ev_stream"]["status"] == "error"
    assert "pg_storage" in found and "ev_table" in found


async def test_nats_jetstream_and_the_events_stream(client, monkeypatch):
    monkeypatch.setattr(config, "settings", dataclasses.replace(config.settings, nats_monitor_url="http://nats:8222"))
    varz = {"connections": 3, "max_connections": 65536,
            "jetstream": {"config": {"max_storage": 10_000_000_000, "max_memory": 1_000_000_000},
                          "stats": {"storage": 800_000_000, "memory": 210_000_000}}}
    jsz = {"account_details": [{"name": "$G", "stream_detail": [
        {"name": "EVENTS", "state": {"messages": 1234, "bytes": 250_000_000}, "config": {"max_bytes": 1_000_000_000}}]}]}

    def handler(request):
        return httpx.Response(200, json=jsz if request.url.path.endswith("jsz") else varz)
    monkeypatch.setattr(nats_monitor, "transport", httpx.MockTransport(handler))
    await full_user(client, "11111111")
    found = rows((await client.get("/api/admin/resources")).json())
    assert found["nats_storage"]["pct"] == 8.0 and found["nats_memory"]["pct"] == 21.0
    assert found["ev_stream"]["pct"] == 25.0 and "1.234 beskeder" in found["ev_stream"]["source"]


def test_drift_role_opens_the_section():
    assert "/resources" in admin_roles.sections(["drift"])
    assert admin_roles.allows(["drift"], "PUT", "/api/admin/resources/killswitches/all")
    assert not admin_roles.allows(["support"], "GET", "/api/admin/resources")


# ── Events ──────────────────────────────────────────────────────────────────

async def test_emit_without_nats_writes_to_postgres(no_nats, owner_conn):
    assert await events.emit("http.5xx", ref="/api/files/{file_id}") is True
    assert await events.emit("Bad Kind!") is False
    assert owner_conn.execute("select kind, ref from events").fetchall() == [("http.5xx", "/api/files/{file_id}")]


async def test_emit_with_nats_publishes_and_the_consumer_stores_once(monkeypatch, owner_conn):
    published = []

    class FakeNats:
        is_connected = True

        async def publish(self, subject, payload):
            published.append((subject, payload))
    monkeypatch.setattr(events, "_nc", FakeNats())
    assert events.bus() == "nats"
    assert await events.emit("ai.tokens", ref="app", value=812) is True
    assert owner_conn.execute("select count(*) from events").fetchone() == (0,)   # not written directly
    subject, payload = published[0]
    assert subject == "events.ai.tokens" and json.loads(payload)["value"] == 812

    acked = []

    class Msg:
        def __init__(self, data):
            self.data = data

        async def ack(self):
            acked.append(self)
    batch = [Msg(payload), Msg(payload), Msg(b"not json")]   # a redelivery and a broken message
    assert await events.store_messages(batch) == 1
    assert len(acked) == 3
    assert owner_conn.execute("select kind, ref, value from events").fetchall() == [("ai.tokens", "app", 812.0)]


async def test_control_counts_events_by_kind(client, no_nats):
    await full_user(client, "11111111")
    for _ in range(3):
        await events.emit("http.5xx", ref="/api/x")
    await events.emit("custom.thing")
    body = (await client.get("/api/admin/resources/control")).json()
    kinds = {k["kind"]: k for k in body["kinds"]}
    assert kinds["http.5xx"]["m5"] == 3 and kinds["http.5xx"]["description"]
    assert kinds["custom.thing"]["d1"] == 1 and kinds["custom.thing"]["description"] is None
    assert "custom.thing" in {k["kind"] for k in body["known_kinds"]}
    assert {s["key"] for s in body["switches"]} == set(killswitch.SWITCHES)
    assert body["bus"] == "postgres"


# ── Kill switches ───────────────────────────────────────────────────────────

async def test_closing_a_switch_answers_503_and_opening_restores(client, no_nats, owner_conn):
    await full_user(client, "11111111")
    assert (await client.post("/api/collect", json={}, headers=H)).status_code != 503
    r = await client.put("/api/admin/resources/killswitches/collect", json={"closed": True, "reason": "Spam"}, headers=H)
    assert r.status_code == 200 and r.json()["changed"] is True
    r = await client.post("/api/collect", json={}, headers=H)
    assert r.status_code == 503 and r.json()["switch"] == "collect" and r.headers["Retry-After"] == "60"
    assert owner_conn.execute("select ref from events where kind = 'http.blocked'").fetchone() == ("collect",)
    switch = next(s for s in (await client.get("/api/admin/resources/control")).json()["switches"] if s["key"] == "collect")
    assert switch["closed"] and switch["reason"] == "Spam" and switch["set_by_name"]
    audit = owner_conn.execute("""select before, after from audit_log where table_name = 'kill_switches'
                                  and row_id = 'collect' order by id desc limit 1""").fetchone()
    assert audit[0]["active"] is False and audit[1]["active"] is True

    r = await client.put("/api/admin/resources/killswitches/collect", json={"closed": False}, headers=H)
    assert r.status_code == 200
    assert (await client.post("/api/collect", json={}, headers=H)).status_code != 503


async def test_whole_service_closes_but_admin_and_login_stay_open(client, no_nats):
    await full_user(client, "11111111")
    r = await client.put("/api/admin/resources/killswitches/all", json={"closed": True, "reason": "Angreb"}, headers=H)
    assert r.status_code == 200
    assert (await client.get("/api/me")).status_code == 503
    assert (await client.get("/api/auth/me")).status_code == 200
    assert (await client.get("/api/admin/resources/control")).status_code == 200
    assert (await client.get("/health")).status_code == 200
    await client.put("/api/admin/resources/killswitches/all", json={"closed": False}, headers=H)
    assert (await client.get("/api/me")).status_code != 503


async def test_closing_needs_a_reason_and_a_known_switch(client, no_nats):
    await full_user(client, "11111111")
    assert (await client.put("/api/admin/resources/killswitches/all", json={"closed": True}, headers=H)).status_code == 422
    assert (await client.put("/api/admin/resources/killswitches/nope", json={"closed": True, "reason": "x"},
                             headers=H)).status_code == 404


async def test_a_switch_with_minutes_opens_by_itself(client, no_nats, owner_conn):
    await full_user(client, "11111111")
    await client.put("/api/admin/resources/killswitches/collect", json={"closed": True, "reason": "Kort", "minutes": 5},
                     headers=H)
    assert (await client.post("/api/collect", json={}, headers=H)).status_code == 503
    owner_conn.execute("update kill_switches set expires_at = now() - interval '1 second' where key = 'collect'")
    killswitch.invalidate()
    assert (await client.post("/api/collect", json={}, headers=H)).status_code != 503


async def test_ai_status_says_disabled_while_ai_is_closed(client, monkeypatch):
    monkeypatch.setattr(config, "settings", dataclasses.replace(config.settings, ai_api_key="k", nats_url=None))
    await full_user(client, "11111111")
    assert (await client.get("/api/ai/status")).json()["enabled"] is True
    await client.put("/api/admin/resources/killswitches/ai", json={"closed": True, "reason": "Pris"}, headers=H)
    assert (await client.get("/api/ai/status")).json() == {"enabled": False, "closed": True}
    assert (await client.post("/api/ai/chat", json={}, headers=H)).status_code == 503


async def test_a_rule_closes_a_switch_once_and_audits_it(client, no_nats, owner_conn):
    await full_user(client, "11111111")
    rules = {"rules": [{"kind": "http.5xx", "threshold": 3, "window_seconds": 60, "switch": "collect", "minutes": 10}]}
    r = await client.put("/api/admin/resources/rules", json=rules, headers=H)
    assert r.status_code == 200, r.text
    await events.emit("http.5xx")
    await events.emit("http.5xx")
    assert await events.evaluate_rules() == []
    await events.emit("http.5xx")
    assert await events.evaluate_rules() == ["collect"]
    assert await events.evaluate_rules() == []                 # already closed: nothing new, no second audit line
    assert (await client.post("/api/collect", json={}, headers=H)).status_code == 503
    row = owner_conn.execute("select auto, expires_at > now() + interval '9 minutes' from kill_switches where key = 'collect'").fetchone()
    assert row == (True, True)
    assert owner_conn.execute("select count(*) from audit_log where action = 'killswitch.auto'").fetchone() == (1,)
    body = (await client.get("/api/admin/resources/control")).json()
    assert body["rules"][0]["kind"] == "http.5xx"
    assert next(s for s in body["switches"] if s["key"] == "collect")["auto"] is True


async def test_bad_rules_are_refused(client, no_nats):
    await full_user(client, "11111111")
    bad_switch = {"rules": [{"kind": "http.5xx", "threshold": 3, "window_seconds": 60, "switch": "rocket"}]}
    assert (await client.put("/api/admin/resources/rules", json=bad_switch, headers=H)).status_code == 422
    bad_kind = {"rules": [{"kind": "HTTP 5xx", "threshold": 3, "window_seconds": 60, "switch": "ai"}]}
    assert (await client.put("/api/admin/resources/rules", json=bad_kind, headers=H)).status_code == 422


def test_unique_event_ids():
    a, b = events._event("x.y", "", 0, None), events._event("x.y", "", 0, None)
    assert a["id"] != b["id"] and uuid.UUID(a["id"])
