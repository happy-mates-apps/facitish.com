"""The developer portal (/developer → /api/admin/studio): the dashboard numbers and the dynamic MCP endpoints
/mcp/<key> made in MCP Studio (app/mcp/endpoints.py, migration 0030)."""

from app import admin_roles
from tests.helpers import full_user, otp_login, stepup
from tests.mcp_client import McpClient
from tests.mcp_helpers import REDIRECT, authorize_code, exchange, mcp_token, pkce, register

STUDIO = "/api/admin/studio"


async def _setup(make_client):
    admin = make_client()
    admin_auth = await full_user(admin, "11111111")
    user = make_client()
    await otp_login(user, "22222222")
    return admin, admin_auth, user


async def _stepup(client, auth, method: str, url: str, body: dict | None = None):
    send = getattr(client, method)
    r = await send(url, json=body) if body is not None else await send(url)
    if r.status_code == 403 and r.headers.get("x-gaer-error") == "stepup_required":
        await stepup(client, auth)
        r = await send(url, json=body) if body is not None else await send(url)
    return r


async def _create(admin, auth, key="salg", **extra):
    r = await _stepup(admin, auth, "post", f"{STUDIO}/mcp-endpoints",
                      {"key": key, "name": "Salg", "description": "Tal til salgsteamet", "instructions": "Svar kort.", **extra})
    assert r.status_code == 201, r.text
    return r.json()


async def _connect(http, path: str, scope="mcp") -> McpClient:
    t = await mcp_token(http, scope)
    return await McpClient(http, path, t["access_token"]).initialize()


def _ids(owner_conn, phone: str) -> int:
    return owner_conn.execute("select id from users where phone = %s", (phone,)).fetchone()[0]


# ── Who may use it ──────────────────────────────────────────────────────────

async def test_developer_is_a_section_of_the_data_role(make_client, owner_conn):
    admin, admin_auth, user = await _setup(make_client)
    assert "/developer" in admin_roles.sections(["data"]) and "/developer" in admin_roles.sections(["fuld"])
    assert "/developer" not in admin_roles.sections(["support"])
    assert admin_roles.allows(["data"], "POST", f"{STUDIO}/mcp-endpoints")
    assert not admin_roles.allows(["drift"], "GET", f"{STUDIO}/overview")
    assert (await user.get(f"{STUDIO}/overview")).status_code == 403
    assert (await admin.get(f"{STUDIO}/overview")).status_code == 200
    # An admin with only Support sees neither the dashboard nor the endpoints.
    other = make_client()
    await full_user(other, "33333333")
    other_id = _ids(owner_conn, "+4533333333")
    assert (await admin.patch(f"/api/admin/users/{other_id}/role", json={"role": "admin"})).status_code == 200
    r = await admin.put(f"/api/admin/users/{other_id}/admin-roles", json={"roles": ["support"]})
    assert r.status_code == 200, r.text
    r = await other.get(f"{STUDIO}/overview")
    assert r.status_code == 403 and "admin-rolle" in r.json()["detail"]


# ── Dashboard ───────────────────────────────────────────────────────────────

async def test_overview_counts_sources_catalog_tools_and_endpoints(make_client, owner_conn):
    admin, admin_auth, user = await _setup(make_client)
    before = (await admin.get(f"{STUDIO}/overview")).json()
    assert before["endpoints"]["count"] == 2 and before["endpoints"]["dynamic"] == 0
    assert {e["key"] for e in before["endpoints"]["items"]} == {"app", "admin"}
    assert before["sources"]["count"] == 0 and before["catalog"]["datasets"] == 0
    assert before["tools"]["code"] > 0 and before["tools"]["data"] == 0

    await _create(admin, admin_auth)
    ds = (await admin.post("/api/admin/data/datasets", json={"table": "clips"})).json()
    after = (await admin.get(f"{STUDIO}/overview")).json()
    assert after["endpoints"]["count"] == 3 and after["endpoints"]["dynamic"] == 1
    salg = next(e for e in after["endpoints"]["items"] if e["key"] == "salg")
    assert salg["path"] == "/mcp/salg" and salg["url"].endswith("/mcp/salg") and salg["tools"] == 5 and salg["live"]
    assert after["catalog"]["datasets"] == 1 and ds["id"]


# ── Endpoints ───────────────────────────────────────────────────────────────

async def test_create_edit_and_delete_an_endpoint_with_audit(make_client, owner_conn):
    admin, admin_auth, user = await _setup(make_client)
    assert (await user.post(f"{STUDIO}/mcp-endpoints", json={"key": "salg", "name": "Salg"})).status_code == 403
    created = await _create(admin, admin_auth)
    assert created["key"] == "salg" and created["audience"] == "all" and created["enabled"] and not created["builtin"]
    assert created["scope"] == "mcp" and created["tools"] == 5

    # Keys: lower-case slug, not reserved, unique.
    for bad in ("sælg", "a", "x" * 33, "mcp_x", "-salg"):
        r = await _stepup(admin, admin_auth, "post", f"{STUDIO}/mcp-endpoints", {"key": bad, "name": "x"})
        assert r.status_code == 422, bad
    for reserved in ("admin", "app", "token", "authorize", "register"):
        r = await _stepup(admin, admin_auth, "post", f"{STUDIO}/mcp-endpoints", {"key": reserved, "name": "x"})
        assert r.status_code == 422, reserved
    assert (await _stepup(admin, admin_auth, "post", f"{STUDIO}/mcp-endpoints", {"key": "salg", "name": "x"})).status_code == 409

    listed = (await admin.get(f"{STUDIO}/mcp-endpoints")).json()
    assert [e["key"] for e in listed["endpoints"]] == ["admin", "app", "salg"]
    detail = (await admin.get(f"{STUDIO}/mcp-endpoints/salg")).json()
    assert detail["connect"]["url"].endswith("/mcp/salg") and detail["connect"]["scope"] == "mcp"
    assert detail["connect"]["metadata"].endswith("/.well-known/oauth-protected-resource/mcp/salg")
    assert {t["name"] for t in detail["tools"]} == {"whoami", "access_list", "access_request", "confirm_draft", "cancel_draft"}
    names = {t["name"] for t in detail["available"]}
    assert "clips_list" in names and "user_block" not in names     # app handlers yes, admin-only tools no

    r = await _stepup(admin, admin_auth, "patch", f"{STUDIO}/mcp-endpoints/salg", {"audience": "admin", "name": "Salg 2"})
    assert r.status_code == 200 and r.json()["audience"] == "admin" and r.json()["name"] == "Salg 2"
    # The built-in endpoints are not edited here.
    assert (await _stepup(admin, admin_auth, "patch", f"{STUDIO}/mcp-endpoints/app", {"name": "x"})).status_code == 409
    assert (await _stepup(admin, admin_auth, "delete", f"{STUDIO}/mcp-endpoints/admin")).status_code == 409

    assert (await _stepup(admin, admin_auth, "delete", f"{STUDIO}/mcp-endpoints/salg")).status_code == 200
    assert (await admin.get(f"{STUDIO}/mcp-endpoints/salg")).status_code == 404
    assert owner_conn.execute("select count(*) from mcp_tool_endpoints where endpoint = 'salg'").fetchone()[0] == 0
    actions = [r[0] for r in owner_conn.execute(
        "select action from audit_log where table_name = 'mcp_endpoints' and row_id = 'salg' order by id").fetchall()]
    assert actions == ["mcp_endpoint.created", "mcp_endpoint.updated", "mcp_endpoint.deleted"]
    row = owner_conn.execute("""select before, after from audit_log where action = 'mcp_endpoint.updated'""").fetchone()
    assert row == ({"audience": "all", "name": "Salg"}, {"audience": "admin", "name": "Salg 2"})


async def test_endpoint_tools_are_chosen_in_the_studio(make_client, owner_conn):
    admin, admin_auth, user = await _setup(make_client)
    await _create(admin, admin_auth)
    tools = (await admin.get("/api/admin/data/tools")).json()["tools"]
    by_name = {t["name"]: t for t in tools}
    assert "salg" in by_name["clips_list"]["possibleEndpoints"] and "salg" not in by_name["user_block"]["possibleEndpoints"]

    ds = (await admin.post("/api/admin/data/datasets", json={"table": "clips"})).json()
    r = await _stepup(admin, admin_auth, "post", "/api/admin/data/tools",
                      {"name": "klip_data", "dataset_id": ds["id"], "title": "Alle klip", "endpoints": ["salg"]})
    assert r.status_code == 201, r.text
    data_tool = r.json()
    assert data_tool["endpoints"] == ["salg"]

    r = await _stepup(admin, admin_auth, "put", f"{STUDIO}/mcp-endpoints/salg/tools",
                      {"tool_ids": [by_name["clips_list"]["id"], data_tool["id"]]})
    assert r.status_code == 200, r.text
    names = {t["name"] for t in r.json()["tools"]}
    assert {"clips_list", "klip_data", "whoami", "access_list", "access_request"} <= names   # core tools stay
    # An admin-only Code tool cannot be put on a dynamic endpoint.
    r = await _stepup(admin, admin_auth, "put", f"{STUDIO}/mcp-endpoints/salg/tools", {"tool_ids": [by_name["user_block"]["id"]]})
    assert r.status_code == 422
    row = owner_conn.execute("select after from audit_log where action = 'mcp_endpoint.tools' order by id desc").fetchone()
    assert "klip_data" in row[0]["tools"]

    # Trying a tool from the studio runs it as the admin and logs it on the endpoint.
    r = await admin.post(f"{STUDIO}/mcp-endpoints/salg/tools/whoami/invoke", json={"args": {}})
    assert r.status_code == 200 and not r.json()["isError"], r.text
    assert (await admin.post(f"{STUDIO}/mcp-endpoints/salg/tools/user_block/invoke", json={"args": {}})).status_code == 404
    log = (await admin.get(f"{STUDIO}/mcp-endpoints/salg/log")).json()["items"]
    assert log and log[0]["tool"] == "whoami" and log[0]["status"] == "ok"


# ── Over MCP ────────────────────────────────────────────────────────────────

async def test_dynamic_endpoint_speaks_mcp_as_the_user(make_client, owner_conn):
    admin, admin_auth, user = await _setup(make_client)
    await _create(admin, admin_auth)
    tools = {t["name"]: t for t in (await admin.get("/api/admin/data/tools")).json()["tools"]}
    r = await _stepup(admin, admin_auth, "put", f"{STUDIO}/mcp-endpoints/salg/tools", {"tool_ids": [tools["clips_list"]["id"]]})
    assert r.status_code == 200, r.text

    # Discovery and 401 without a token point at the endpoint's own metadata.
    meta = (await user.get("/.well-known/oauth-protected-resource/mcp/salg")).json()
    assert meta["resource"].endswith("/mcp/salg") and meta["scopes_supported"] == ["mcp"]
    assert (await user.get("/.well-known/oauth-protected-resource/mcp/nope")).status_code == 404
    r = await user.post("/mcp/salg", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert r.status_code == 401 and "/mcp/salg" in r.headers["www-authenticate"]
    assert (await user.post("/mcp/nope", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})).status_code == 404

    uid = _ids(owner_conn, "+4522222222")
    owner_conn.execute("insert into clips (user_id, source, title, body) values (%s, 'manual', 'Mit klip', 'x')", (uid,))
    other = _ids(owner_conn, "+4511111111")
    owner_conn.execute("insert into clips (user_id, source, title, body) values (%s, 'manual', 'Admins klip', 'y')", (other,))

    m = await _connect(user, "/mcp/salg")
    names = {t["name"] for t in await m.list_tools()}
    assert names == {"whoami", "access_list", "access_request", "confirm_draft", "cancel_draft", "clips_list"}
    me, is_error = await m.call("whoami")
    assert not is_error and me["user"]["id"] == uid
    clips, is_error = await m.call("clips_list")
    assert not is_error and [c["title"] for c in clips["clips"]] == ["Mit klip"]   # own rows only
    logged = owner_conn.execute("select server, tool, status from mcp_log where server = 'salg' and method = 'tools/call' "
                                "order by id").fetchall()
    assert ("salg", "clips_list", "ok") in logged

    # A token for /mcp does not open /mcp/salg's admin audience; the audience is checked on every request.
    r = await _stepup(admin, admin_auth, "patch", f"{STUDIO}/mcp-endpoints/salg", {"audience": "admin"})
    assert r.status_code == 200
    r = await m.raw("tools/list")
    assert r.status_code == 403 and "admins" in r.json()["error_description"].lower()
    r = await _stepup(admin, admin_auth, "patch", f"{STUDIO}/mcp-endpoints/salg", {"audience": "internal"})
    assert r.status_code == 200
    assert (await m.raw("tools/list")).status_code == 403
    owner_conn.execute("update users set audience = 'internal' where id = %s", (uid,))
    assert (await m.raw("tools/list")).status_code == 200

    # Switched off → 404, and so is a deleted endpoint.
    r = await _stepup(admin, admin_auth, "patch", f"{STUDIO}/mcp-endpoints/salg", {"enabled": False})
    assert r.status_code == 200
    assert (await m.raw("tools/list")).status_code == 404
    assert (await user.get("/.well-known/oauth-protected-resource/mcp/salg")).status_code == 404
    r = await _stepup(admin, admin_auth, "patch", f"{STUDIO}/mcp-endpoints/salg", {"enabled": True})
    assert (await m.raw("tools/list")).status_code == 200
    assert (await _stepup(admin, admin_auth, "delete", f"{STUDIO}/mcp-endpoints/salg")).status_code == 200
    assert (await m.raw("tools/list")).status_code == 404


async def test_oauth_resource_names_the_endpoint(make_client, owner_conn):
    admin, admin_auth, user = await _setup(make_client)
    await _create(admin, admin_auth)
    client_id = await register(user)
    origin = (await user.get("/.well-known/oauth-protected-resource/mcp/salg")).json()["resource"]
    verifier, challenge = pkce()
    query = {"response_type": "code", "client_id": client_id, "redirect_uri": REDIRECT, "code_challenge": challenge,
             "code_challenge_method": "S256", "resource": origin}
    r = await user.get("/mcp/authorize", params=query)
    assert r.status_code == 302 and "scope=mcp&" in r.headers["location"] + "&", r.headers["location"]
    consent = {k: v for k, v in query.items() if k != "response_type"}
    info = (await user.get("/api/mcp/consent", params={**consent, "scope": "mcp"})).json()
    assert info["endpoint"] == {"key": "salg", "path": "/mcp/salg", "name": "Salg", "description": "Tal til salgsteamet"}
    # The admin scope does not fit a dynamic endpoint; an unknown resource is refused.
    r = await user.get("/api/mcp/consent", params={**consent, "scope": "mcp:admin"})
    assert r.status_code == 400
    r = await user.get("/api/mcp/consent", params={**consent, "scope": "mcp", "resource": origin.replace("salg", "nope")})
    assert r.status_code == 400
    r = await user.post("/api/mcp/consent", json={**consent, "scope": "mcp", "approve": True})
    assert r.status_code == 200, r.text
    code = r.json()["redirect"].split("code=")[1].split("&")[0]
    token = await exchange(user, client_id, code, verifier)
    assert token.status_code == 200, token.text
    m = await McpClient(user, "/mcp/salg", token.json()["access_token"]).initialize()
    assert "whoami" in {t["name"] for t in await m.list_tools()}
    assert authorize_code  # the helper for the default resource is covered in test_mcp_oauth


API_SPEC = """
kilde: priser
navn: Priser
type: rest
base_url: https://api.example.dk
klassifikation: hvid
grænser: { kald_pr_minut: 60, timeout_s: 10, cache_min: 0 }
datasæt:
  - id: elpriser
    navn: Elpriser
    kald: GET /priser
    sider: { type: offset, parameter: offset, størrelse: limit, max: 100 }
    rækker: $.records[*]
    felter:
      HourDK:   { type: dato, navn: Time }
      PriceDKK: { type: tal, navn: Pris }
"""


async def test_data_tool_on_an_api_dataset_over_a_dynamic_endpoint(make_client, owner_conn, monkeypatch):
    """API Studio → catalog → MCP Studio → a client reads the rows through the dynamic endpoint."""
    from app import data_sources

    calls = []

    async def http_get_json(url, headers, timeout):
        calls.append(url)
        return {"records": [{"HourDK": "2026-11-12T08:00:00", "PriceDKK": 690.7}, {"HourDK": "2026-11-12T09:00:00", "PriceDKK": 650.1}]}

    async def check_host(host):
        return None

    monkeypatch.setattr(data_sources, "http_get_json", http_get_json)
    monkeypatch.setattr(data_sources, "check_host", check_host)
    data_sources.clear_cache()

    admin, admin_auth, user = await _setup(make_client)
    r = await admin.post("/api/admin/data/sources", json={"spec_yaml": API_SPEC})
    assert r.status_code == 201, r.text
    ds = next(d for d in (await admin.get("/api/admin/data/catalog")).json()["datasets"] if d["key"] == "elpriser")
    await _create(admin, admin_auth, key="energi")
    r = await _stepup(admin, admin_auth, "post", "/api/admin/data/tools",
                      {"name": "elpriser_data", "dataset_id": ds["id"], "endpoints": ["energi"]})
    assert r.status_code == 201, r.text

    # From the studio (as the admin) and over MCP (as a user): the same reader, offset paging on the API.
    r = await admin.post(f"{STUDIO}/mcp-endpoints/energi/tools/elpriser_data/invoke", json={"args": {"limit": 2}})
    assert r.status_code == 200 and not r.json()["isError"], r.text
    assert [row["PriceDKK"] for row in r.json()["result"]["rows"]] == [690.7, 650.1]
    assert calls[-1] == "https://api.example.dk/priser?offset=0&limit=2"

    m = await _connect(user, "/mcp/energi")
    result, is_error = await m.call("elpriser_data", limit=2, offset=2)
    assert not is_error, result
    assert result["dataset"]["name"] == "Elpriser" and result["columns"][0]["label"] == "Time"
    assert calls[-1] == "https://api.example.dk/priser?offset=2&limit=2"
