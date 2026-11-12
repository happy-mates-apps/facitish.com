"""Udforsk → Forbindelser (GET /api/admin/data/connections): APIs called from code (app/integrations.py) and API sources,
counted by the event api.call with only the registered endpoint pattern (never a real path, account or query)."""

import dataclasses

import httpx
import pytest

from app import config, data_sources, integrations
from app.data_sources import FetchError
from tests.helpers import full_user

SPEC = """
kilde: dawa
navn: Dataforsyningen
base_url: https://api.dataforsyningen.dk
klassifikation: hvid
grænser: { kald_pr_minut: 600, timeout_s: 10, cache_min: 0 }
datasæt:
  - id: postnumre
    navn: Postnumre
    kald: GET /postnumre
    felter:
      nr:   { type: tal, navn: Postnr. }
      navn: { navn: By }
"""


def _refs(owner_conn) -> list[str]:
    return [r[0] for r in owner_conn.execute("select ref from events where kind = 'api.call' order by ts")]


async def test_hooks_record_only_the_endpoint_pattern(owner_conn):
    def answer(request):
        return httpx.Response(503 if "queue" in request.url.path else 200, json={})

    transport = httpx.MockTransport(answer)
    async with httpx.AsyncClient(transport=transport, event_hooks=integrations.hooks("stalwart")) as c:
        await c.get("https://mail.example.dk/api/principal/niels@example.dk?x=secret")
        await c.get("https://mail.example.dk/api/queue/messages?limit=1")
        await c.get("https://mail.example.dk/something/else/42")
    async with httpx.AsyncClient(transport=transport, event_hooks=integrations.hooks("ai")) as c:
        await c.post("https://oai.example.net/v1/chat/completions", json={})
    refs = _refs(owner_conn)
    assert refs == ["stalwart:GET /api/principal…", "stalwart:GET /api/queue…", "stalwart:GET (andet)", "ai:POST /chat/completions"]
    assert not any("@" in r or "niels" in r or "secret" in r for r in refs)
    statuses = [r[0] for r in owner_conn.execute("select data->>'status' from events where kind = 'api.call' order by ts")]
    assert statuses == ["200", "503", "200", "200"]


async def test_connections_lists_code_and_sources(make_client, owner_conn, monkeypatch):
    admin = make_client()
    await full_user(admin, "11111111")
    monkeypatch.setattr(config, "settings", dataclasses.replace(config.settings, ai_api_key="sk-very-secret-value"))

    calls = []

    async def http_get_json(url, headers, timeout):
        calls.append(url)
        if len(calls) == 2:
            raise FetchError("API'et svarede 503")
        return [{"nr": 8000, "navn": "Aarhus C"}]

    async def check_host(host):
        return None

    monkeypatch.setattr(data_sources, "http_get_json", http_get_json)
    monkeypatch.setattr(data_sources, "check_host", check_host)
    data_sources.clear_cache()

    transport = httpx.MockTransport(lambda r: httpx.Response(200, json={}))
    async with httpx.AsyncClient(transport=transport, event_hooks=integrations.hooks("ai")) as c:
        for _ in range(3):
            await c.post("https://oai.example.net/v1/chat/completions", json={})

    src = (await admin.post("/api/admin/data/sources", json={"spec_yaml": SPEC})).json()["id"]
    ds = next(d for d in (await admin.get("/api/admin/data/catalog")).json()["datasets"] if d["source_id"] == src)["id"]
    assert (await admin.post(f"/api/admin/data/datasets/{ds}/query", json={})).status_code == 200
    assert (await admin.post(f"/api/admin/data/datasets/{ds}/query", json={})).status_code == 424

    r = await admin.get("/api/admin/data/connections")
    assert r.status_code == 200
    body = r.json()
    assert "sk-very-secret-value" not in r.text
    ai = next(c for c in body["code"] if c["key"] == "ai")
    assert ai["active"] and ai["secrets"] == [{"name": "AI_API_KEY", "set": True, "where": "env"}]
    chat = next(e for e in ai["endpoints"] if e["path"] == "/chat/completions")
    assert chat["calls"] == 3 and chat["errors"] == 0 and ai["calls"] == 3
    assert {c["key"] for c in body["code"]} >= {"ai", "lettermint", "stalwart", "nats", "s3", "ovh_sms"}
    assert next(c for c in body["code"] if c["key"] == "s3")["counted"] is False

    dawa = next(s for s in body["sources"] if s["key"] == "dawa")
    ep = dawa["endpoints"][0]
    assert ep["path"] == "/postnumre" and ep["calls"] == 2 and ep["errors"] == 1 and ep["dataset_id"] == ds
    assert dawa["calls"] == 2 and dawa["errors"] == 1 and dawa["last_error_at"]
    assert dawa["auth"] == "ingen" and dawa["secrets"] == []
    data_sources.clear_cache()


async def test_only_data_admins(make_client):
    from tests.helpers import otp_login
    await full_user(make_client(), "11111111")  # the first user becomes admin
    user = make_client()
    await otp_login(user, "22222222")
    assert (await user.get("/api/admin/data/connections")).status_code == 403


@pytest.mark.parametrize("key", [i.key for i in integrations.REGISTRY])
def test_registry_is_consistent(key):
    it = integrations.BY_KEY[key]
    assert it.name and it.purpose and it.files
    for e in it.endpoints:
        assert e.path and e.label and e.called_from and e.pattern
    for name in it.secrets + it.settings:
        assert hasattr(config.settings, name.lower()), name
