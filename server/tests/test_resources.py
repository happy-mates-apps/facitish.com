"""/admin/resources: resources in use, limits and prices (app.resources), and the ClickHouse client (app.clickhouse)."""

import dataclasses
import json
import re
import time

import httpx
import pytest

from app import admin_roles, clickhouse, config, nats_monitor
from tests.helpers import full_user


def rows(body: dict) -> dict:
    return {r["key"]: r for c in body["categories"] for r in c["items"]}


def ch_server(tables=(("events", 1),), oldest_age=3600, events=42):
    """A fake ClickHouse HTTP interface that answers the queries app.resources sends."""
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        sql = request.content.decode()
        seen.append(request)
        data: list[dict] = []
        if "system.parts" in sql:
            data = [{"bytes": 12_600_000_000, "rows": 1000}]
        elif "system.disks" in sql:
            data = [{"total_space": 40_000_000_000}]
        elif "MemoryTracking" in sql:
            data = [{"value": 900_000_000}]
        elif "system.server_settings" in sql:
            data = [{"name": "max_server_memory_usage", "value": "1500000000"}]
        elif "system.tables" in sql:
            data = [{"name": n, "has_ttl": t} for n, t in tables]
        elif "min(ts)" in sql:
            data = [{"oldest": int(time.time()) - oldest_age, "n": events}]
        elif "INTERVAL 1 DAY" in sql:
            data = [{"n": events}]
        return httpx.Response(200, json={"data": data})

    return httpx.MockTransport(handler), seen


@pytest.fixture
def no_externals(monkeypatch):
    monkeypatch.setattr(config, "settings", dataclasses.replace(config.settings, nats_monitor_url=None, clickhouse_url=None))


async def test_overview_lists_what_can_be_measured(client, no_externals, owner_conn):
    await full_user(client, "11111111")
    r = await client.get("/api/admin/resources")
    assert r.status_code == 200, r.text
    body = r.json()
    found = rows(body)
    assert {"cpu", "disk", "pg_storage", "pg_connections", "s3_storage", "email", "jobs"} <= set(found)
    assert found["pg_connections"]["max"] > 0 and found["pg_connections"]["used"] >= 1
    assert found["disk"]["max"] > found["disk"]["used"] > 0
    assert found["pg_storage"]["status"] == "none"          # no limit known until the admin sets one
    # ClickHouse is not configured: one row that says so, no error.
    assert found["ch_storage"]["status_label"] == "Ikke sat op"
    assert body["clickhouse"] == {"configured": False, "ttl_days": 7}
    assert body["total_cost"] is None
    row = owner_conn.execute("select detail->>'path' from audit_log where action = 'admin.read' order by id desc limit 1").fetchone()
    assert row == ("/api/admin/resources",)


async def test_limits_and_prices_are_saved_audited_and_used(client, no_externals, owner_conn):
    await full_user(client, "11111111")
    config_in = {"items": {
        "pg_storage": {"max": 20},                                   # GB
        "disk": {"monthly": 120},                                    # the server
        "email": {"max": 3000, "unit_price": 0.5},
        "ai_tokens": {"unit_price": 9},
    }}
    r = await client.put("/api/admin/resources/config", json=config_in, headers={"X-Gaer": "1"})
    assert r.status_code == 200, r.text
    body = (await client.get("/api/admin/resources")).json()
    found = rows(body)
    assert found["pg_storage"]["max"] == 20 * 1_000_000_000 and found["pg_storage"]["max_measured"] is False
    assert found["pg_storage"]["status"] in ("ok", "warn", "crit")
    assert found["disk"]["cost"] == 120
    assert found["email"]["max"] == 3000
    assert found["email"]["cost"] == round(found["email"]["used"] * 0.5, 2)
    assert body["total_cost"] >= 120
    server = next(c for c in body["categories"] if c["key"] == "server")
    assert server["cost"] == 120
    audit = owner_conn.execute("""select after from audit_log where table_name = 'settings' and row_id = 'resources'
                                  order by id desc limit 1""").fetchone()
    assert audit and audit[0]["disk"]["monthly"] == 120

    # Clearing a resource removes it, and the audit shows it.
    r = await client.put("/api/admin/resources/config", json={"items": {"disk": {"monthly": 120}}}, headers={"X-Gaer": "1"})
    assert r.status_code == 200
    audit = owner_conn.execute("""select before, after from audit_log where table_name = 'settings' and row_id = 'resources'
                                  order by id desc limit 1""").fetchone()
    assert audit[0]["pg_storage"] == {"max": 20, "monthly": None, "unit_price": None} and audit[1]["pg_storage"] is None


async def test_unknown_resource_and_bad_values_are_refused(client, no_externals):
    await full_user(client, "11111111")
    r = await client.put("/api/admin/resources/config", json={"items": {"rocket": {"max": 1}}}, headers={"X-Gaer": "1"})
    assert r.status_code == 422
    r = await client.put("/api/admin/resources/config", json={"items": {"disk": {"max": -1}}}, headers={"X-Gaer": "1"})
    assert r.status_code == 422


async def test_clickhouse_storage_memory_retention_and_ingest(client, monkeypatch):
    monkeypatch.setattr(config, "settings", dataclasses.replace(
        config.settings, nats_monitor_url=None, clickhouse_url="http://clickhouse:8123", clickhouse_password="pw"))
    transport, seen = ch_server()
    monkeypatch.setattr(clickhouse, "transport", transport)
    await full_user(client, "11111111")
    found = rows((await client.get("/api/admin/resources")).json())
    assert found["ch_storage"]["used"] == 12_600_000_000 and found["ch_storage"]["max"] == 40_000_000_000
    assert found["ch_memory"]["pct"] == 60.0
    assert found["ch_retention"]["status"] == "info" and found["ch_retention"]["status_label"] == "TTL aktiv"
    assert found["ch_retention"]["max"] == 7 * 86400
    assert found["ch_ingest"]["used"] == 42
    # Credentials go in headers, never in the URL.
    assert seen[0].headers["X-ClickHouse-Key"] == "pw" and "pw" not in str(seen[0].url)


async def test_clickhouse_warns_about_missing_ttl_and_old_rows(client, monkeypatch):
    monkeypatch.setattr(config, "settings", dataclasses.replace(
        config.settings, nats_monitor_url=None, clickhouse_url="http://clickhouse:8123"))
    await full_user(client, "11111111")
    monkeypatch.setattr(clickhouse, "transport", ch_server(tables=(("events", 1), ("raw", 0)))[0])
    found = rows((await client.get("/api/admin/resources")).json())
    assert found["ch_retention"]["status"] == "crit" and "raw" in found["ch_retention"]["note"]
    monkeypatch.setattr(clickhouse, "transport", ch_server(oldest_age=10 * 86400)[0])
    found = rows((await client.get("/api/admin/resources")).json())
    assert found["ch_retention"]["status_label"] == "Sletning halter"


async def test_one_failing_source_does_not_break_the_page(client, monkeypatch):
    monkeypatch.setattr(config, "settings", dataclasses.replace(
        config.settings, nats_monitor_url="http://nats:8222", clickhouse_url="http://clickhouse:8123"))

    def down(request):
        raise httpx.ConnectError("refused")
    monkeypatch.setattr(nats_monitor, "transport", httpx.MockTransport(down))
    monkeypatch.setattr(clickhouse, "transport", httpx.MockTransport(down))
    await full_user(client, "11111111")
    body = (await client.get("/api/admin/resources")).json()
    found = rows(body)
    assert found["nats_error"]["status"] == "error"
    assert found["clickhouse_error"]["status"] == "error" and "svarer ikke" in found["clickhouse_error"]["source"]
    assert "pg_storage" in found and "disk" in found


async def test_nats_jetstream_limits(client, monkeypatch):
    monkeypatch.setattr(config, "settings", dataclasses.replace(
        config.settings, nats_monitor_url="http://nats:8222", clickhouse_url=None))
    varz = {"connections": 3, "max_connections": 65536,
            "jetstream": {"config": {"max_storage": 10_000_000_000, "max_memory": 1_000_000_000},
                          "stats": {"storage": 800_000_000, "memory": 210_000_000}}}
    monkeypatch.setattr(nats_monitor, "transport", httpx.MockTransport(lambda r: httpx.Response(200, json=varz)))
    await full_user(client, "11111111")
    found = rows((await client.get("/api/admin/resources")).json())
    assert found["nats_storage"]["pct"] == 8.0 and found["nats_memory"]["pct"] == 21.0
    assert found["nats_connections"]["used"] == 3


def test_drift_role_opens_the_section():
    assert "/resources" in admin_roles.sections(["drift"])
    assert admin_roles.allows(["drift"], "PUT", "/api/admin/resources/config")
    assert not admin_roles.allows(["support"], "GET", "/api/admin/resources")


def test_clickhouse_migration_files_split_into_statements_and_all_have_ttl():
    files = clickhouse.migration_files()
    assert files and files[0].name == "0001_events.sql"
    for path in files:
        for statement in clickhouse.statements(path.read_text()):
            if statement.upper().startswith("CREATE TABLE"):
                assert re.search(rf"\bTTL\b.*INTERVAL {clickhouse.TTL_DAYS} DAY", statement, re.S), path.name


def test_clickhouse_migrate_is_skipped_without_url(monkeypatch):
    monkeypatch.setattr(config, "settings", dataclasses.replace(config.settings, clickhouse_url=None))
    assert clickhouse.migrate(verbose=False) == []


async def test_clickhouse_insert_sends_json_each_row(monkeypatch):
    monkeypatch.setattr(config, "settings", dataclasses.replace(config.settings, clickhouse_url="http://clickhouse:8123"))
    bodies = []
    monkeypatch.setattr(clickhouse, "transport", httpx.MockTransport(
        lambda r: (bodies.append(r.content.decode()), httpx.Response(200, text=""))[1]))
    assert await clickhouse.insert("events", [{"kind": "job.done", "ref": "17"}, {"kind": "job.done", "ref": "18"}]) == 2
    head, *lines = bodies[0].splitlines()
    assert head == "INSERT INTO events FORMAT JSONEachRow" and json.loads(lines[1])["ref"] == "18"
    with pytest.raises(ValueError):
        await clickhouse.insert("events; drop table x", [{"a": 1}])
