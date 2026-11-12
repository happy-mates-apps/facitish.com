"""API sources (/admin/data/connect) with secrets from Hemmeligheder: names in the description, never values; the
source uses a value only through an approved, expiring grant "Brug i kilde"; a test call may use the tester's own
access; basic, OAuth 2 client credentials and extra headers."""

import base64

import pytest

from app import data_sources
from app.data_sources import FetchError, SpecError, parse_spec
from tests.test_secrets import _admins, _group

VALUE = "sk_live_abcdefghijklmnop4f2a"

SPEC = """
kilde: dawa
navn: Dataforsyningen
base_url: https://api.dataforsyningen.dk
klassifikation: hvid
auth: { type: bearer, hemmelighed: data-bi/cvr }
grænser: { kald_pr_minut: 600, timeout_s: 10, cache_min: 0 }
datasæt:
  - id: postnumre
    navn: Postnumre
    kald: GET /postnumre
    felter:
      nr:   { type: tal, navn: Postnr. }
      navn: { navn: By }
"""


@pytest.fixture
def fake_api(monkeypatch):
    calls = []

    async def http_get_json(url, headers, timeout):
        calls.append({"url": url, "headers": headers})
        return [{"nr": 8000, "navn": "Aarhus C"}]

    async def http_post_form(url, data, timeout):
        calls.append({"url": url, "form": data})
        return {"access_token": f"tok-{len(calls)}", "expires_in": 3600}

    async def check_host(host):
        return None

    monkeypatch.setattr(data_sources, "http_get_json", http_get_json)
    monkeypatch.setattr(data_sources, "http_post_form", http_post_form)
    monkeypatch.setattr(data_sources, "check_host", check_host)
    data_sources.clear_cache()
    yield calls
    data_sources.clear_cache()


def test_auth_types_and_secret_names():
    oauth = parse_spec(SPEC.replace("auth: { type: bearer, hemmelighed: data-bi/cvr }", """auth:
  type: oauth2
  token_url: https://auth.virk.dk/oauth2/token
  client_id: gaer-prod
  scope: cvr.read
  hemmelighed: data-bi/cvr client@prod
  headers:
    X-Virk-Partner: { hemmelighed: data-bi/partner }"""))
    assert oauth["hosts"] == ["api.dataforsyningen.dk", "auth.virk.dk"]
    assert oauth["secrets"] == [{"ref": "data-bi/cvr client@prod", "used_as": "auth"},
                                {"ref": "data-bi/partner", "used_as": "header:X-Virk-Partner"}]
    basic = parse_spec(SPEC.replace("type: bearer,", "type: basic, brugernavn: gaer,"))
    assert basic["auth"]["username"] == "gaer" and basic["secrets"][0]["ref"] == "data-bi/cvr"
    bad = {
        "auth: { type: bearer, hemmelighed: DATABASE_URL }": "DATA_SECRET_",
        "auth: { type: bearer, hemmelighed: cvr }": "gruppe/navn",
        "auth: { type: oauth2, hemmelighed: data-bi/cvr, client_id: x, token_url: http://auth.virk.dk/t }": "https",
        "auth: { type: bearer, hemmelighed: data-bi/cvr, headers: { Cookie: { hemmelighed: data-bi/x } } }": "headernavn",
        "auth: { type: bearer, hemmelighed: data-bi/cvr, headers: { Authorization: data-bi/x } }": "headernavn",
        "auth: { type: bearer, hemmelighed: data-bi/cvr, headers: { X-Key: { værdi: abc } } }": "hemmelighed",
        "auth: { type: basic, hemmelighed: data-bi/cvr, password: hunter2 }": "nøgle",
        "auth: { type: mtls, hemmelighed: data-bi/cvr }": "auth.type",
    }
    for auth, match in bad.items():
        with pytest.raises(SpecError, match=match):
            parse_spec(SPEC.replace("auth: { type: bearer, hemmelighed: data-bi/cvr }", auth))


async def test_basic_oauth2_and_headers_are_filled_in_on_the_server(fake_api):
    spec = parse_spec(SPEC.replace("type: bearer,", "type: basic, brugernavn: gaer,"))
    await data_sources.fetch(spec, spec["datasets"][0], {}, secrets={"data-bi/cvr": "pw"})
    assert fake_api[-1]["headers"]["Authorization"] == "Basic " + base64.b64encode(b"gaer:pw").decode()

    spec = parse_spec(SPEC.replace("auth: { type: bearer, hemmelighed: data-bi/cvr }", """auth:
  type: oauth2
  token_url: https://auth.virk.dk/oauth2/token
  client_id: gaer-prod
  hemmelighed: data-bi/cvr
  headers: { X-Partner: data-bi/partner }"""))
    secrets = {"data-bi/cvr": "client-secret", "data-bi/partner": "p-42"}
    with pytest.raises(FetchError, match="data-bi/partner"):
        await data_sources.fetch(spec, spec["datasets"][0], {}, secrets={"data-bi/cvr": "client-secret"})
    fake_api.clear()
    await data_sources.fetch(spec, spec["datasets"][0], {}, secrets=secrets)
    await data_sources.fetch(spec, spec["datasets"][0], {}, secrets=secrets)
    token_calls = [c for c in fake_api if "form" in c]
    assert len(token_calls) == 1  # the token is kept until shortly before it expires
    assert token_calls[0]["form"] == {"grant_type": "client_credentials", "client_id": "gaer-prod",
                                      "client_secret": "client-secret"}
    get = [c for c in fake_api if "headers" in c][-1]["headers"]
    assert get["Authorization"] == "Bearer tok-1" and get["X-Partner"] == "p-42"
    # A new value (rotation) gets a new token.
    await data_sources.fetch(spec, spec["datasets"][0], {}, secrets={**secrets, "data-bi/cvr": "rotated"})
    assert len([c for c in fake_api if "form" in c]) == 2


async def test_source_uses_a_secret_only_with_an_approved_grant(make_client, owner_conn, fake_api):
    (boss, two, three, four), ids = await _admins(make_client)
    gid = await _group(boss, ids, "Data BI")
    sid = (await boss.post("/api/admin/secrets", json={"group_id": gid, "name": "cvr", "value": VALUE})).json()["id"]
    raci = [{"user_id": ids[0], "roles": ["A"]}, {"user_id": ids[1], "roles": ["R"]}, {"user_id": ids[2], "roles": ["C"]},
            {"user_id": ids[3], "roles": ["I"]}]
    assert (await boss.put(f"/api/admin/secrets/{sid}/raci", json={"raci": raci})).status_code == 200

    # Four (I) cannot test with it; the boss (A) can, with their own access, and that is audited on the secret.
    r = (await four.post("/api/admin/data/sources/test", json={"spec_yaml": SPEC})).json()
    assert r["preview"] is None and r["secrets"][0]["ok"] is False and not fake_api
    assert any("ikke adgang til data-bi/cvr" in c["text"] for c in r["checks"])
    r = (await boss.post("/api/admin/data/sources/test", json={"spec_yaml": SPEC})).json()
    assert r["preview"]["rows"][0]["navn"] == "Aarhus C" and r["secrets"][0]["how"] == "own"
    assert fake_api[-1]["headers"]["Authorization"] == f"Bearer {VALUE}"
    assert VALUE not in str(r)
    assert owner_conn.execute("select count(*) from audit_log where action = 'secret.used_in_test' and row_id = %s",
                              (str(sid),)).fetchone()[0] == 1

    # Saved, the source names the secret but cannot use it yet.
    src = (await four.post("/api/admin/data/sources", json={"spec_yaml": SPEC})).json()["id"]
    assert owner_conn.execute("select secret_id, used_as from data_source_secrets where source_id = %s",
                              (src,)).fetchall() == [(sid, "auth")]
    catalog = (await four.get("/api/admin/data/catalog")).json()
    ds = next(d for d in catalog["datasets"] if d["source_id"] == src)["id"]
    r = await four.post(f"/api/admin/data/datasets/{ds}/query", json={})
    assert r.status_code == 424 and "Brug i kilde" in r.json()["detail"]

    # Four asks for "Brug i kilde"; A, R and C approve.
    other = (await boss.post("/api/admin/secrets", json={"group_id": gid, "name": "andet", "value": VALUE})).json()["id"]
    assert (await four.post(f"/api/admin/data/sources/{src}/secret-requests",
                            json={"secret_id": other, "days": 30, "reason": "Ikke nævnt"})).status_code == 409
    r = await four.post(f"/api/admin/data/sources/{src}/secret-requests",
                        json={"secret_id": sid, "days": 30, "reason": "CVR-opslag i dashboardet"})
    assert r.status_code == 201, r.text
    req = r.json()["id"]
    assert (await four.post(f"/api/admin/data/sources/{src}/secret-requests",
                            json={"secret_id": sid, "days": 30, "reason": "igen"})).status_code == 409
    picker = (await four.get(f"/api/admin/data/secrets?source_id={src}")).json()["items"]
    mine = next(p for p in picker if p["id"] == sid)
    assert mine["ref"] == "data-bi/cvr" and mine["source_request"]["total"] == 3 and mine["my_level"] is None
    assert "value" not in str(mine).lower().replace("value_changed_at", "")
    waiting = (await three.get("/api/admin/secrets/requests?scope=waiting")).json()["items"]
    assert waiting[0]["grantee_source"]["key"] == "dawa" and waiting[0]["level_label"] == "Brug i kilde"
    assert "api.dataforsyningen.dk" in waiting[0]["reason"]
    for c in (boss, two, three):
        r = await c.post(f"/api/admin/secrets/requests/{req}/decide", json={"approve": True})
        assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved"

    # Now the source answers for everyone in /admin/data, and still nobody sees the value through the grant.
    r = await four.post(f"/api/admin/data/datasets/{ds}/query", json={})
    assert r.status_code == 200 and r.json()["rows"][0]["navn"] == "Aarhus C"
    assert fake_api[-1]["headers"]["Authorization"] == f"Bearer {VALUE}"
    assert (await four.post(f"/api/admin/secrets/{sid}/reveal")).status_code == 403
    detail = (await boss.get(f"/api/admin/secrets/{sid}")).json()
    grant = detail["grants"][0]
    assert grant["source"]["key"] == "dawa" and grant["level"] == "use" and grant["user"] is None
    assert detail["used_by"][0]["key"] == "dawa" and detail["used_by"][0]["used_as"] == ["auth"]
    source = (await four.get(f"/api/admin/data/sources/{src}")).json()
    assert source["secrets"][0]["how"] == "source" and source["secrets"][0]["grant_expires_at"]

    # A new value is used at once; a revoked grant stops the source at once.
    assert (await two.put(f"/api/admin/secrets/{sid}/value", json={"value": "rotated-value-9999"})).status_code == 200
    await four.post(f"/api/admin/data/datasets/{ds}/query", json={})
    assert fake_api[-1]["headers"]["Authorization"] == "Bearer rotated-value-9999"
    assert (await two.post(f"/api/admin/secrets/{sid}/grants/{grant['id']}/revoke")).status_code == 200
    assert (await four.post(f"/api/admin/data/datasets/{ds}/query", json={})).status_code == 424
    actions = [r[0] for r in owner_conn.execute(
        "select action from audit_log where table_name = 'secrets' and row_id = %s order by id", (str(sid),))]
    assert "secret.access_granted" in actions and actions[-1] == "secret.access_ended"


async def test_parse_for_the_form(make_client):
    (boss, *_), _ = await _admins(make_client, 1)
    r = await boss.post("/api/admin/data/sources/parse", json={"spec_yaml": SPEC})
    assert r.status_code == 200 and r.json()["auth"] == {
        "type": "bearer", "secret": "data-bi/cvr", "header": None, "username": None, "token_url": None, "client_id": None,
        "scope": None, "headers": []}
    assert r.json()["datasets"][0]["fields"][1]["label"] == "By"
    r = await boss.post("/api/admin/data/sources/parse", json={"spec_yaml": "kilde: x\nauth: { type: bearer, token: abc }"})
    assert r.status_code == 422 and "nøgle" in r.json()["detail"]


async def test_secret_tables_are_never_explored(make_client):
    (boss, *_), _ = await _admins(make_client, 1)
    names = {t["name"] for t in (await boss.get("/api/admin/data/tables")).json()}
    assert not names & {"secrets", "secret_versions", "secret_grants", "secret_raci", "data_source_secrets"}
    assert (await boss.post("/api/admin/data/datasets", json={"table": "secret_versions"})).status_code in (400, 404, 422)
