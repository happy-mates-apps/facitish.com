"""The MCP servers end to end over Streamable HTTP — every item under "Verify" in specs/mcp/SPEC.md."""

import json
import pathlib

import psycopg
import pytest

from app.mcp import db_tools
from app.mcp.registry import CATALOG, ToolError, check_catalog
from tests.helpers import SoftAuthenticator, full_user, otp_login, register_passkey
from tests.mcp_client import McpClient
from tests.mcp_helpers import REDIRECT, mcp_token, pkce, register

SPEC_CATALOG = pathlib.Path(__file__).parents[2] / "specs" / "mcp" / "catalog.json"


async def _connect(http, scope="mcp") -> McpClient:
    t = await mcp_token(http, scope)
    return await McpClient(http, "/mcp/admin" if scope == "mcp:admin" else "/mcp", t["access_token"]).initialize()


async def _admin_and_user(make_client):
    admin = make_client()
    await full_user(admin, "11111111")
    user = make_client()
    await otp_login(user, "22222222")
    return admin, user


# ── Auth ────────────────────────────────────────────────────────────────────

async def test_401_without_token(client):
    for path in ("/mcp", "/mcp/admin"):
        r = await client.post(path, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        assert r.status_code == 401
        assert "resource_metadata=" in r.headers["www-authenticate"]
        r = await client.post(path, json={}, headers={"authorization": "Bearer nope"})
        assert r.status_code == 401


async def test_admin_server_403_for_non_admins(make_client, owner_conn):
    admin, user = await _admin_and_user(make_client)
    # A normal user's token (scope mcp) does not open /mcp/admin.
    t = await mcp_token(user)
    r = await McpClient(user, "/mcp/admin", t["access_token"]).raw("initialize", {})
    assert r.status_code == 403
    # An admin who loses the role loses /mcp/admin on the next request.
    m = await _connect(admin, "mcp:admin")
    owner_conn.execute("insert into users (phone, role) values ('+4533333333', 'admin')")
    owner_conn.execute("update users set role = 'user' where phone = '+4511111111'")
    r = await m.raw("tools/list")
    assert r.status_code == 403


async def test_no_mcp_while_impersonating_or_for_test_accounts(make_client, owner_conn):
    admin, _ = await _admin_and_user(make_client)
    test = (await admin.post("/api/impersonation/users", json={"display_name": "T", "role": "admin"})).json()
    await admin.post("/api/impersonation/start", json={"user_id": test["id"]})
    r = await admin.get("/mcp/authorize")  # sanity: the endpoint exists
    assert r.status_code == 400
    from tests.mcp_helpers import REDIRECT, pkce, register
    client_id = await register(admin)
    _, challenge = pkce()
    q = {"client_id": client_id, "redirect_uri": REDIRECT, "code_challenge": challenge, "code_challenge_method": "S256",
         "scope": "mcp:admin"}
    assert (await admin.post("/api/mcp/consent", json={**q, "approve": True})).status_code == 403
    # Even a token row for a test account is never accepted.
    from app.mcp.oauth import verify_access_token
    owner_conn.execute("insert into mcp_clients (id, name, redirect_uris) values ('c1', 'x', '{}')")
    sid = owner_conn.execute("""insert into sessions (user_id, token_hash, scope, expires_at) values (%s, 'h', 'full',
                                now() + interval '1 day') returning id""", (test["id"],)).fetchone()[0]
    from app.security import token_hash
    owner_conn.execute("""insert into mcp_tokens (kind, token_hash, client_id, user_id, session_id, scope, expires_at)
                          values ('access', %s, 'c1', %s, %s, 'mcp:admin', now() + interval '1 hour')""",
                       (token_hash("tok"), test["id"], sid))
    assert await verify_access_token("tok") is None


async def test_revoking_sessions_or_blocking_ends_tokens(make_client):
    admin, user = await _admin_and_user(make_client)
    m = await _connect(user)
    assert (await m.raw("tools/list")).status_code == 200
    user_id = (await admin.get("/api/admin/users")).json()["items"][1]["id"]
    await admin.post(f"/api/admin/users/{user_id}/revoke-sessions")
    assert (await m.raw("tools/list")).status_code == 401

    await otp_login(user, "22222222")
    m = await _connect(user)
    await admin.post(f"/api/admin/users/{user_id}/block")
    assert (await m.raw("tools/list")).status_code == 401


async def test_revoking_the_session_in_konto_ends_the_client(make_client):
    c = make_client()
    await full_user(c, "11111111")
    m = await _connect(c)
    session = next(s for s in (await c.get("/api/me/sessions")).json() if s["user_agent"].startswith("MCP"))
    assert (await c.delete(f"/api/me/sessions/{session['id']}")).status_code == 200
    assert (await m.raw("tools/list")).status_code == 401


# ── Catalog ─────────────────────────────────────────────────────────────────

async def test_bundled_catalog_is_the_spec():
    assert json.loads(SPEC_CATALOG.read_text()) == CATALOG
    assert check_catalog() == []


async def test_tools_list_equals_catalog(make_client):
    admin = make_client()
    await full_user(admin, "11111111")
    for scope, server in (("mcp", "app"), ("mcp:admin", "admin")):
        m = await _connect(admin, scope)
        tools = {t["name"]: t for t in await m.list_tools()}
        expected = [t for t in CATALOG["tools"] if t["server"] == server]
        assert set(tools) == {t["name"] for t in expected}
        for t in expected:
            schema = tools[t["name"]]["inputSchema"]
            assert set(schema["properties"]) == {p["name"] for p in t["params"]}
            assert set(schema["required"]) == {p["name"] for p in t["params"] if not p.get("optional")}
            assert tools[t["name"]]["annotations"]["readOnlyHint"] == (t["mode"] == "read")


# ── App server ──────────────────────────────────────────────────────────────

async def test_app_tools_only_touch_own_rows(make_client, owner_conn):
    admin, user = await _admin_and_user(make_client)
    mine = (await admin.post("/api/clips", json={"title": "Admins klip", "body": "hemmelig"})).json()
    m = await _connect(user)
    created, err = await m.call("clip_create", title="Mødenoter", body="Punkt 1")
    assert not err and created["clip"]["source"] == "mcp"
    clips, _ = await m.call("clips_list")
    assert [c["title"] for c in clips["clips"]] == ["Mødenoter"]
    found, _ = await m.call("clips_search", q="hemmelig")
    assert found["clips"] == []
    other, err = await m.call("clip_get", clipId=mine["id"])
    assert err and other["error"] == "Klippet findes ikke"
    _, err = await m.call("clip_update", clipId=mine["id"], title="hacked")
    assert err
    _, err = await m.call("clip_delete", clipId=mine["id"])
    assert err
    assert owner_conn.execute("select title from clips where id = %s", (mine["id"],)).fetchone()[0] == "Admins klip"
    # Writes are audited with the user as actor.
    row = owner_conn.execute("select detail from audit_log where table_name = 'clips' and action = 'create' order by id desc").fetchone()
    assert row[0]["client"].startswith("mcp_")


async def test_app_read_tools_run(make_client):
    c = make_client()
    await full_user(c, "11111111")
    m = await _connect(c)
    for name, args in (("whoami", {}), ("me_sessions", {}), ("me_features", {}), ("files_list", {}),
                       ("clips_list", {"source": "mcp"})):
        result, err = await m.call(name, **args)
        assert not err, (name, result)
    who, _ = await m.call("whoami")
    assert who["user"]["phone"] == "+45 •••• ••11" and who["ring"]["level"] == 4
    ring, err = await m.call("me_set_ring", ring=2)
    assert not err and ring["level"] == 2
    _, err = await m.call("file_link", fileId="00000000-0000-0000-0000-000000000000")
    assert err
    sessions, _ = await m.call("me_sessions")
    assert any(s["current"] and s["mcp_client"] == "Claude Code" for s in sessions["sessions"])


async def test_privacy_export_draft(make_client, owner_conn):
    c = make_client()
    await full_user(c, "11111111")
    m = await _connect(c)
    d, err = await m.call("privacy_export")
    assert not err and d["status"] == "pending"
    assert owner_conn.execute("select count(*) from files").fetchone()[0] == 0  # nothing before confirm
    done, err = await m.call("confirm_draft", draftId=d["draftId"], reason="Jeg vil se mine data")
    assert not err and done["status"] == "confirmed" and done["result"]["download_url"]
    assert owner_conn.execute("select filename from files").fetchone()[0].startswith("indsigt-")


# ── Drafts ──────────────────────────────────────────────────────────────────

async def test_draft_confirms_exactly_once(make_client, owner_conn):
    c = make_client()
    await full_user(c, "11111111")
    clip = (await c.post("/api/clips", json={"title": "Slet mig"})).json()
    m = await _connect(c)
    d, err = await m.call("clip_delete", clipId=clip["id"])
    assert not err and d["status"] == "pending" and "Slet mig" in d["summary"]
    assert owner_conn.execute("select count(*) from clips").fetchone()[0] == 1
    _, err = await m.call("confirm_draft", draftId=d["draftId"], reason="x")  # reason too short
    assert err
    done, err = await m.call("confirm_draft", draftId=d["draftId"], reason="Ryd op")
    assert not err and done["status"] == "confirmed"
    assert owner_conn.execute("select count(*) from clips").fetchone()[0] == 0
    again, err = await m.call("confirm_draft", draftId=d["draftId"], reason="Ryd op")
    assert err and "bekræftet" in again["error"]
    action, detail = owner_conn.execute("select action, detail from audit_log where action like 'mcp.%%'").fetchone()
    assert action == "mcp.clip_delete" and detail["via"] == "mcp:app" and detail["reason"] == "Ryd op"


async def test_expired_and_changed_drafts_do_nothing(make_client, owner_conn):
    c = make_client()
    await full_user(c, "11111111")
    m = await _connect(c)
    a = (await c.post("/api/clips", json={"title": "A"})).json()
    d, _ = await m.call("clip_delete", clipId=a["id"])
    owner_conn.execute("update mcp_drafts set expires_at = now() - interval '1 second' where id = %s", (d["draftId"],))
    r, err = await m.call("confirm_draft", draftId=d["draftId"], reason="for sent")
    assert err and "udløbet" in r["error"]
    assert owner_conn.execute("select status from mcp_drafts where id = %s", (d["draftId"],)).fetchone()[0] == "expired"

    d, _ = await m.call("clip_delete", clipId=a["id"])
    await c.patch(f"/api/clips/{a['id']}", json={"title": "A2"})  # the state the draft was based on changes
    r, err = await m.call("confirm_draft", draftId=d["draftId"], reason="ændret")
    assert err and "ændret" in r["error"]
    assert owner_conn.execute("select count(*) from clips").fetchone()[0] == 1
    assert owner_conn.execute("select status from mcp_drafts where id = %s", (d["draftId"],)).fetchone()[0] == "failed"

    d, _ = await m.call("clip_delete", clipId=a["id"])
    r, err = await m.call("cancel_draft", draftId=d["draftId"])
    assert not err and r["status"] == "cancelled"
    _, err = await m.call("confirm_draft", draftId=d["draftId"], reason="annulleret")
    assert err


async def test_only_the_creator_confirms(make_client):
    admin, user = await _admin_and_user(make_client)
    clip = (await user.post("/api/clips", json={"title": "B"})).json()
    mu = await _connect(user)
    d, _ = await mu.call("clip_delete", clipId=clip["id"])
    ma = await _connect(admin)
    r, err = await ma.call("confirm_draft", draftId=d["draftId"], reason="ikke min")
    assert err and r["error"] == "Kladden findes ikke"


# ── Admin server ────────────────────────────────────────────────────────────

async def test_admin_read_tools_run(make_client):
    admin, user = await _admin_and_user(make_client)
    m = await _connect(admin, "mcp:admin")
    user_id = (await admin.get("/api/admin/users")).json()["items"][1]["id"]
    calls = [("whoami", {}), ("list_drafts", {}), ("nav_sections", {}), ("nav_resolve", {"q": "where do I block a user?"}),
             ("stats_overview", {"days": 7}), ("stats_breakdown", {"by": "pages"}), ("stats_logins", {}),
             ("user_search", {"q": "22 22 22 22"}), ("user_search", {"q": "*", "filter": "nopk"}), ("user_get", {"userId": user_id}),
             ("test_accounts_list", {}), ("feature_list", {}), ("feature_usage", {"key": "klip"}), ("auth_log_search", {"userId": user_id}),
             ("audit_log_search", {}), ("gdpr_list", {}), ("db_schema", {}), ("settings_get", {})]
    for name, args in calls:
        result, err = await m.call(name, **args)
        assert not err, (name, result)
    found, _ = await m.call("user_search", q="+4522222222")
    assert found["count"] == 1 and found["users"][0]["phone"] == "+45 •••• ••22"
    nav, _ = await m.call("nav_resolve", q="block a user")
    assert nav["matches"][0]["path"] == "/admin/users"


async def test_admin_changes_are_drafts(make_client, owner_conn):
    admin, user = await _admin_and_user(make_client)
    m = await _connect(admin, "mcp:admin")
    me = (await admin.get("/api/auth/me")).json()["user"]["id"]
    user_id = (await admin.get("/api/admin/users")).json()["items"][1]["id"]

    _, err = await m.call("user_set_role", userId=me, role="admin")
    assert err  # never your own role
    _, err = await m.call("user_block", userId=me, reason="test")
    assert err

    d, err = await m.call("user_block", userId=user_id, reason="mistet telefon")
    assert not err and "Spær" in d["summary"]
    assert owner_conn.execute("select blocked_at from users where id = %s", (user_id,)).fetchone()[0] is None
    done, err = await m.call("confirm_draft", draftId=d["draftId"], reason="mistet telefon")
    assert not err and done["result"]["blocked"] is True
    assert owner_conn.execute("select blocked_at from users where id = %s", (user_id,)).fetchone()[0] is not None
    assert (await user.get("/api/auth/me")).json()["user"] is None

    d, _ = await m.call("feature_set_ring", key="klip", ring=2)
    assert d["impact"]["counts"]["lose"] >= 1
    await m.call("confirm_draft", draftId=d["draftId"], reason="beta igen")
    assert owner_conn.execute("select ring from features where key = 'klip'").fetchone()[0] == 2

    d, _ = await m.call("settings_set", key="app_name", value="my-gaer")
    await m.call("confirm_draft", draftId=d["draftId"], reason="nyt navn")
    assert (await admin.get("/api/public/config")).json()["app_name"] == "my-gaer"
    _, err = await m.call("settings_set", key="logo_key", value="x")
    assert err

    d, _ = await m.call("test_account_create", displayName="Test Kasserer", role="user")
    created, _ = await m.call("confirm_draft", draftId=d["draftId"], reason="test")
    test_id = created["result"]["userId"]
    d, err = await m.call("impersonate_start", userId=test_id, reason="se appen")
    assert not err
    started, _ = await m.call("confirm_draft", draftId=d["draftId"], reason="se appen")
    assert "token" not in json.dumps(started).lower()
    _, err = await m.call("impersonate_start", userId=user_id, reason="rigtig bruger")
    assert err

    d, _ = await m.call("gdpr_export", userId=user_id)
    exported, err = await m.call("confirm_draft", draftId=d["draftId"], reason="indsigt")
    assert not err and exported["result"]["download_url"]

    drafts, _ = await m.call("list_drafts", status="confirmed")
    assert len(drafts["drafts"]) >= 5
    actions = {r[0] for r in owner_conn.execute("select action from audit_log where action like 'mcp.%%'")}
    assert {"mcp.user_block", "mcp.feature_set_ring", "mcp.settings_set", "mcp.gdpr_export"} <= actions


# ── Database tools ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("sql", ["update users set role = 'admin'", "drop table users", "select 1; delete from users",
                                 "select 1; select 2", "with x as (delete from clips returning *) select * from x",
                                 "explain analyze delete from clips", "select * into t from users", "/* x */ insert into clips values (1)"])
async def test_db_query_rejects_writes(sql):
    with pytest.raises(ToolError):
        db_tools.check_query(sql)


async def test_db_query_runs_read_only_as_mcp_ro(make_client):
    admin = make_client()
    await full_user(admin, "11111111")
    m = await _connect(admin, "mcp:admin")
    r, err = await m.call("db_query", sql="select current_user as who, phone, role from users;")
    assert not err and r["rows"][0]["who"].endswith("_mcp_ro")
    assert r["rows"][0]["phone"] == "•••"
    r, err = await m.call("db_query", sql="select phone_masked from auth_log")
    assert err and "adgang" in r["error"]
    r, err = await m.call("db_query", sql="select secret_enc from totp_factors")
    assert err and "adgang" in r["error"]  # authenticator-app secrets are hidden from db_query
    r, err = await m.call("db_query", sql="select 'it''s; fine' as s, $$a;b$$ as t")
    assert not err and r["rows"][0]["s"] == "it's; fine"
    _, err = await m.call("db_query", sql="update users set role = 'admin'")
    assert err


# ── Log ─────────────────────────────────────────────────────────────────────

async def test_every_call_is_logged_and_the_log_is_append_only(make_client, owner_conn, app_conn):
    c = make_client()
    await full_user(c, "11111111")
    m = await _connect(c)
    await m.list_tools()
    await m.call("whoami")
    await m.call("clip_get", clipId=999)
    await c.post("/mcp", json={})  # no token
    rows = owner_conn.execute("select method, tool, status from mcp_log order by id").fetchall()
    assert ("tools/list", None, "ok") in rows and ("tools/call", "whoami", "ok") in rows
    assert ("tools/call", "clip_get", "error") in rows and ("POST", None, "auth_failed") in rows
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        app_conn.execute("update mcp_log set status = 'ok'")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        app_conn.execute("delete from mcp_log")


async def test_disabled_server_is_404(make_client, monkeypatch):
    from dataclasses import replace
    from app import config
    c = make_client()
    await full_user(c, "11111111")
    t = await mcp_token(c)
    monkeypatch.setattr(config, "settings", replace(config.settings, mcp_app_enabled=False))
    r = await c.post("/mcp", json={}, headers={"authorization": f"Bearer {t['access_token']}"})
    assert r.status_code == 404


# ── Profile, security and MFA ───────────────────────────────────────────────

async def test_profile_and_security_tools(make_client, owner_conn):
    c = make_client()
    await full_user(c, "11111111")
    m = await _connect(c)
    done, err = await m.call("profile_update", displayName="Niels", locale="en", timeZone="Europe/Copenhagen")
    assert not err and done["updated"] == {"display_name": "Niels", "locale": "en", "time_zone": "Europe/Copenhagen"}
    _, err = await m.call("profile_update", locale="fr")
    assert err
    profile, _ = await m.call("profile_get")
    assert profile["profile"]["displayName"] == "Niels" and profile["profile"]["timeZone"] == "Europe/Copenhagen"
    sec, err = await m.call("security_get")
    assert not err and sec["methods"] == ["passkey"] and sec["mfaRequired"] is False and "secret" not in str(sec)
    assert sec["admin"] == {"graceLoginsLeft": 0, "mfaHours": 12}
    row = owner_conn.execute("select after from audit_log where action = 'update' and table_name = 'users' order by id desc").fetchone()
    assert row[0]["locale"] == "en"


async def test_admin_mcp_needs_a_fresh_second_factor(make_client, owner_conn):
    admin = make_client()
    await otp_login(admin, "11111111")  # a grace login: /admin works, an admin MCP token does not
    client_id = await register(admin)
    verifier, challenge = pkce()
    consent = {"client_id": client_id, "redirect_uri": REDIRECT, "code_challenge": challenge,
               "code_challenge_method": "S256", "scope": "mcp:admin", "state": "xyz", "approve": True}
    r = await admin.post("/api/mcp/consent", json=consent)
    assert r.status_code == 403 and r.headers["x-gaer-error"] == "stepup_required"
    consent["scope"] = "mcp"
    assert (await admin.post("/api/mcp/consent", json=consent)).status_code == 200


async def test_admin_mfa_reset_and_profile_drafts(make_client, owner_conn):
    admin, user = await _admin_and_user(make_client)
    await register_passkey(user, SoftAuthenticator())
    await user.put("/api/me/mfa", json={"required": True})
    user_id = owner_conn.execute("select id from users where phone = '+4522222222'").fetchone()[0]
    m = await _connect(admin, "mcp:admin")

    got, _ = await m.call("user_get", userId=user_id)
    assert got["user"]["mfaRequired"] is True and got["user"]["passkeys"] == 1

    d, err = await m.call("user_profile_set", userId=user_id, displayName="Anna", timeZone="Europe/Oslo")
    assert not err and d["impact"]["diff"]["time_zone"] == [None, "Europe/Oslo"]
    await m.call("confirm_draft", draftId=d["draftId"], reason="rettelse efter henvendelse")
    assert owner_conn.execute("select display_name, time_zone from users where id = %s", (user_id,)).fetchone() == ("Anna", "Europe/Oslo")

    d, err = await m.call("user_reset_mfa", userId=user_id, reason="mistet telefon")
    assert not err and "Nulstil MFA" in d["summary"]
    done, err = await m.call("confirm_draft", draftId=d["draftId"], reason="mistet telefon")
    assert not err and done["result"]["deleted"] == {"keys": 1, "apps": 0}
    assert owner_conn.execute("select mfa_required from users where id = %s", (user_id,)).fetchone()[0] is False
    me = (await admin.get("/api/auth/me")).json()["user"]["id"]
    _, err = await m.call("user_reset_mfa", userId=me, reason="mig selv")
    assert err
