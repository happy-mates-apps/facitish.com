"""/admin → Data: catalog, Udforsk with masking and unmasking, API sources and their safety rules."""

import pytest

from app import config, data_sources
from app.data_sources import FetchError, SpecError, parse_spec
from tests.helpers import full_user, otp_login

SPEC = """
kilde: dawa
navn: Dataforsyningen · Adresser
type: rest
base_url: https://api.dataforsyningen.dk
klassifikation: hvid
grænser: { kald_pr_minut: 60, timeout_s: 10, cache_min: 0 }
datasæt:
  - id: adresser
    navn: Adresser
    kald: GET /adresser
    parametre:
      postnr: { type: tal, navn: Postnr. }
    sider: { type: side, parameter: side, størrelse: per_side, max: 100 }
    rækker: $[*]
    nøgle: id
    felter:
      id:     { type: uuid, navn: ID }
      vej:    { sti: adgangsadresse.vejstykke.navn, navn: Vej }
      postnr: { sti: adgangsadresse.postnummer.nr, navn: Postnr. }
      by:     { sti: adgangsadresse.postnummer.navn, navn: By, klassifikation: gul }
  - id: postnumre
    navn: Postnumre
    kald: GET /postnumre
    felter:
      nr:   { type: tal, navn: Postnr. }
      navn: { navn: By }
"""

ADDRESSES = [
    {"id": "a1", "adgangsadresse": {"vejstykke": {"navn": "Trøjborgvej"}, "postnummer": {"nr": "8200", "navn": "Aarhus N"}}},
    {"id": "a2", "adgangsadresse": {"vejstykke": {"navn": "Nørregade"}, "postnummer": {"nr": "8000", "navn": "Aarhus C"}}},
]


async def _admin_and_user(make_client):
    admin = make_client()
    await full_user(admin, "11111111")
    user = make_client()
    await otp_login(user, "22222222")
    return admin, user


def _audit(owner_conn, action: str, table: str) -> list[dict]:
    cur = owner_conn.execute("select row_id, before, after, detail from audit_log where action = %s and table_name = %s "
                             "order by id", (action, table))
    return [dict(zip(("row_id", "before", "after", "detail"), r)) for r in cur.fetchall()]


@pytest.fixture
def fake_api(monkeypatch):
    calls = []

    async def http_get_json(url, headers, timeout):
        calls.append({"url": url, "headers": headers})
        return ADDRESSES if "/adresser" in url else [{"nr": 8000, "navn": "Aarhus C"}]

    async def check_host(host):
        return None

    monkeypatch.setattr(data_sources, "http_get_json", http_get_json)
    monkeypatch.setattr(data_sources, "check_host", check_host)
    data_sources.clear_cache()
    yield calls
    data_sources.clear_cache()


async def test_only_admins(make_client):
    _, user = await _admin_and_user(make_client)
    assert (await user.get("/api/admin/data/catalog")).status_code == 403
    assert (await user.post("/api/admin/data/datasets", json={"table": "clips"})).status_code == 403


async def test_own_table_is_masked_until_unmasked_with_a_reason(make_client, owner_conn):
    admin, _ = await _admin_and_user(make_client)
    owner_conn.execute("insert into clips (user_id, source, title, body) values (2, 'manual', 'Mødenoter', 'Hemmeligt'), "
                       "(2, 'extension', 'Artikel om passkeys', 'Tekst')")

    tables = {t["name"] for t in (await admin.get("/api/admin/data/tables")).json()}
    assert "clips" in tables and not tables & {"sessions", "otp_codes", "totp_factors", "mcp_tokens", "settings"}
    r = await admin.post("/api/admin/data/datasets", json={"table": "sessions"})
    assert r.status_code == 422

    # Columns that look like secrets never enter the catalog.
    users = (await admin.post("/api/admin/data/datasets", json={"table": "users"})).json()
    assert "phone" not in {f["name"] for f in users["fields"]} and users["personal_data"] is True

    r = await admin.post("/api/admin/data/datasets", json={"table": "clips"})
    assert r.status_code == 201, r.text
    clips = r.json()
    assert clips["name"] == "Klip" and clips["personal_data"] is True
    assert {f["classification"] for f in clips["fields"]} == {"yellow"}
    assert (await admin.post("/api/admin/data/datasets", json={"table": "clips"})).status_code == 409

    url = f"/api/admin/data/datasets/{clips['id']}"
    data = (await admin.post(f"{url}/query", json={})).json()
    assert data["total"] == 2 and {r["title"] for r in data["rows"]} == {"•••"}
    assert all(c["masked"] for c in data["columns"])
    # A masked field cannot be filtered or sorted (that would leak it one guess at a time).
    assert (await admin.post(f"{url}/query", json={"filters": [{"field": "title", "op": "eq", "value": "x"}]})).status_code == 422
    assert (await admin.post(f"{url}/query", json={"sort": "title"})).status_code == 422

    # Classify title as green: it shows, and the change is audited.
    title = next(f for f in clips["fields"] if f["name"] == "title")
    r = await admin.patch(f"{url}/fields/{title['id']}", json={"classification": "green", "label": "Titel"})
    assert r.status_code == 200
    assert _audit(owner_conn, "update", "dataset_fields")[-1]["after"] == {"classification": "green", "label": "Titel"}
    data = (await admin.post(f"{url}/query", json={"filters": [{"field": "title", "op": "contains", "value": "passkey"}]})).json()
    assert data["total"] == 1 and data["rows"][0]["title"] == "Artikel om passkeys" and data["rows"][0]["body"] == "•••"

    # Unmasking needs a reason, lasts 15 minutes and is an audit entry.
    assert (await admin.post(f"{url}/unmask", json={"reason": "x"})).status_code == 422
    r = await admin.post(f"{url}/unmask", json={"reason": "GDPR-forespørgsel 2026-14"})
    assert r.status_code == 200 and r.json()["unmasked_until"]
    entry = _audit(owner_conn, "data.unmask", "datasets")[-1]
    assert entry["row_id"] == str(clips["id"]) and entry["detail"]["reason"] == "GDPR-forespørgsel 2026-14"
    data = (await admin.post(f"{url}/query", json={"sort": "-title", "filters": [{"field": "source", "op": "in", "value": "manual, word"}]})).json()
    assert data["unmasked_until"] and [r["body"] for r in data["rows"]] == ["Hemmeligt"]
    assert (await admin.get(url)).json()["unmasked_until"]


async def test_filters_are_parameters_not_sql(make_client, owner_conn):
    admin, _ = await _admin_and_user(make_client)
    owner_conn.execute("insert into clips (user_id, source, title) select 2, 'manual', 'Klip ' || n from generate_series(1, 30) n")
    clips = (await admin.post("/api/admin/data/datasets", json={"table": "clips"})).json()
    url = f"/api/admin/data/datasets/{clips['id']}"
    for f in clips["fields"]:
        await admin.patch(f"{url}/fields/{f['id']}", json={"classification": "white"})

    r = await admin.post(f"{url}/query", json={"filters": [{"field": "id; drop table clips", "op": "eq", "value": "1"}]})
    assert r.status_code == 422
    r = await admin.post(f"{url}/query", json={"filters": [{"field": "title", "op": "eq", "value": "x' or '1'='1"}]})
    assert r.json()["total"] == 0
    r = await admin.post(f"{url}/query", json={"filters": [{"field": "id", "op": "gt", "value": "25"}], "sort": "id"})
    assert [row["id"] for row in r.json()["rows"]] == [26, 27, 28, 29, 30]
    assert (await admin.post(f"{url}/query", json={"filters": [{"field": "id", "op": "gt", "value": "abc"}]})).status_code == 422
    r = await admin.post(f"{url}/query", json={"filters": [{"field": "title", "op": "contains", "value": "%"}]})
    assert r.json()["total"] == 0
    page = (await admin.post(f"{url}/query", json={"limit": 10, "offset": 10})).json()
    assert page["total"] == 30 and len(page["rows"]) == 10 and page["has_more"] is True
    assert owner_conn.execute("select count(*) from clips").fetchone()[0] == 30

    assert (await admin.delete(url)).status_code == 200
    assert _audit(owner_conn, "delete", "datasets")[-1]["before"]["key"] == "clips"


async def test_api_source_from_a_description(make_client, owner_conn, fake_api):
    admin, _ = await _admin_and_user(make_client)
    r = await admin.post("/api/admin/data/sources/test", json={"spec_yaml": SPEC})
    assert r.status_code == 200, r.text
    test = r.json()
    assert [d["key"] for d in test["datasets"]] == ["adresser", "postnumre"]
    assert test["preview"]["rows"][0]["vej"] == "Trøjborgvej" and test["preview"]["rows"][0]["by"] == "•••"
    assert "side=1" in test["preview"]["url"]
    assert (await admin.get("/api/admin/data/catalog")).json()["stats"]["datasets"] == 0  # a test changes nothing

    r = await admin.post("/api/admin/data/sources", json={"spec_yaml": SPEC})
    assert r.status_code == 201, r.text
    source_id = r.json()["id"]
    assert _audit(owner_conn, "create", "data_sources")[-1]["after"]["hosts"] == ["api.dataforsyningen.dk"]
    assert (await admin.post("/api/admin/data/sources", json={"spec_yaml": SPEC})).status_code == 409

    catalog = (await admin.get("/api/admin/data/catalog")).json()
    assert {s["key"] for s in catalog["sources"]} == {"gaer", "dawa"}
    adresser = next(d for d in catalog["datasets"] if d["key"] == "adresser")
    assert adresser["source_name"] == "Dataforsyningen · Adresser" and adresser["classification"] == "white"

    url = f"/api/admin/data/datasets/{adresser['id']}"
    detail = (await admin.get(url)).json()
    assert detail["call"]["path"] == "/adresser" and {f["name"]: f["classification"] for f in detail["fields"]}["by"] == "yellow"
    # postnr is a parameter of the API: an eq filter is sent to the API; vej is filtered here.
    r = await admin.post(f"{url}/query", json={"filters": [{"field": "postnr", "op": "eq", "value": "8200"},
                                                            {"field": "vej", "op": "starts_with", "value": "trøj"}]})
    assert r.status_code == 200, r.text
    data = r.json()
    assert "postnr=8200" in fake_api[-1]["url"] and [f["where"] for f in data["filters"]] == ["api", "lokalt"]
    assert [row["vej"] for row in data["rows"]] == ["Trøjborgvej"] and data["rows"][0]["by"] == "•••"

    # Editing the description keeps the source key, drops removed datasets and is audited.
    edited = SPEC.split("  - id: postnumre")[0]
    r = await admin.put(f"/api/admin/data/sources/{source_id}", json={"spec_yaml": edited})
    assert r.status_code == 200 and r.json()["removed"] == ["postnumre"]
    assert (await admin.put(f"/api/admin/data/sources/{source_id}",
                            json={"spec_yaml": edited.replace("kilde: dawa", "kilde: andet")})).status_code == 422
    assert (await admin.delete(url)).status_code == 409  # API datasets go with the description
    assert (await admin.delete(f"/api/admin/data/sources/{source_id}")).status_code == 200
    assert (await admin.get("/api/admin/data/catalog")).json()["datasets"] == []


def test_descriptions_never_hold_secrets_or_point_inside():
    with pytest.raises(SpecError, match="nøgle"):
        parse_spec(SPEC.replace("klassifikation: hvid", "klassifikation: hvid\nauth: { type: bearer, token: abc123 }"))
    with pytest.raises(SpecError, match="DATA_SECRET_"):
        parse_spec(SPEC.replace("klassifikation: hvid", "klassifikation: hvid\nauth: { type: bearer, hemmelighed: DATABASE_URL }"))
    with pytest.raises(SpecError, match="https"):
        parse_spec(SPEC.replace("https://api.dataforsyningen.dk", "http://api.dataforsyningen.dk"))
    with pytest.raises(SpecError, match="stien"):
        parse_spec(SPEC.replace("GET /adresser", "GET /../admin"))
    with pytest.raises(SpecError, match="ikke understøttet"):
        parse_spec(SPEC.replace("type: rest", "type: graphql"))
    assert parse_spec(SPEC.replace("klassifikation: hvid", "klassifikation: hvid\nauth: { type: bearer, hemmelighed: DATA_SECRET_DAWA }"))
    assert config.data_secret("DATABASE_URL") is None and config.data_secret("SECRET_KEY") is None


async def test_internal_hosts_are_refused():
    for host in ("127.0.0.1", "localhost", "10.0.0.5", "169.254.169.254"):
        with pytest.raises(FetchError, match="intern"):
            await data_sources.check_host(host)


async def test_secret_comes_from_a_data_secret_variable(monkeypatch, fake_api):
    spec = parse_spec(SPEC.replace("klassifikation: hvid", "klassifikation: hvid\nauth: { type: bearer, hemmelighed: DATA_SECRET_DAWA }"))
    ds = spec["datasets"][1]
    with pytest.raises(FetchError, match="ikke sat"):
        await data_sources.fetch(spec, ds, {})
    monkeypatch.setenv("DATA_SECRET_DAWA", "s3cret")
    result = await data_sources.fetch(spec, ds, {})
    assert fake_api[-1]["headers"]["Authorization"] == "Bearer s3cret" and result["rows"][0]["navn"] == "Aarhus C"
