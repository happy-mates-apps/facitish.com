"""MCP OAuth: discovery, registration, PKCE, consent through the normal login, refresh rotation and revocation."""

from tests.helpers import full_user, otp_login
from tests.mcp_helpers import REDIRECT, authorize_code, exchange, mcp_token, pkce, register


async def test_discovery(client):
    meta = (await client.get("/.well-known/oauth-authorization-server")).json()
    assert meta["code_challenge_methods_supported"] == ["S256"]
    assert meta["scopes_supported"] == ["mcp", "mcp:admin"]
    assert meta["token_endpoint"].endswith("/mcp/token")
    admin = (await client.get("/.well-known/oauth-protected-resource/mcp/admin")).json()
    assert admin["resource"].endswith("/mcp/admin") and admin["scopes_supported"] == ["mcp:admin"]


async def test_register_rejects_unsafe_redirects(client):
    for uri in ("http://evil.example/cb", "javascript:alert(1)", "https://x.example/cb#frag"):
        r = await client.post("/mcp/register", json={"client_name": "x", "redirect_uris": [uri]})
        assert r.status_code == 400, uri


async def test_authorize_requires_pkce_and_known_redirect(make_client):
    c = make_client()
    client_id = await register(c)
    base = {"response_type": "code", "client_id": client_id, "redirect_uri": REDIRECT, "scope": "mcp"}
    assert (await c.get("/mcp/authorize", params=base)).status_code == 400
    _, challenge = pkce()
    bad = {**base, "code_challenge": challenge, "code_challenge_method": "S256", "redirect_uri": "https://other.example/cb"}
    assert (await c.get("/mcp/authorize", params=bad)).status_code == 400
    # Consent needs the normal login; anonymous gets 401 (the page sends them to /login).
    ok = {**base, "code_challenge": challenge, "code_challenge_method": "S256"}
    assert (await c.get("/mcp/authorize", params=ok)).status_code == 302
    assert (await c.post("/api/mcp/consent", json={**ok, "approve": True})).status_code == 401


async def test_code_flow_and_pkce(make_client, owner_conn):
    c = make_client()
    await full_user(c, "11111111")
    client_id = await register(c)
    code, verifier = await authorize_code(c, client_id)
    assert (await exchange(c, client_id, code, "wrong-verifier")).status_code == 400
    assert (await exchange(c, client_id, code, verifier)).status_code == 400  # a code is used once, even after a failure

    code, verifier = await authorize_code(c, client_id)
    r = await exchange(c, client_id, code, verifier)
    body = r.json()
    assert r.status_code == 200 and body["token_type"] == "Bearer" and body["scope"] == "mcp"
    # Only hashes are stored, and the client is a session the user can see.
    assert owner_conn.execute("select count(*) from mcp_tokens where token_hash = %s", (body["access_token"],)).fetchone()[0] == 0
    sessions = (await c.get("/api/me/sessions")).json()
    assert any(s["user_agent"] == "MCP · Claude Code" for s in sessions)


async def test_refresh_rotates(make_client):
    c = make_client()
    await full_user(c, "11111111")
    t = await mcp_token(c)
    r = await c.post("/mcp/token", data={"grant_type": "refresh_token", "refresh_token": t["refresh_token"], "client_id": t["client_id"]})
    assert r.status_code == 200 and r.json()["refresh_token"] != t["refresh_token"]
    again = await c.post("/mcp/token", data={"grant_type": "refresh_token", "refresh_token": t["refresh_token"],
                                             "client_id": t["client_id"]})
    assert again.status_code == 400


async def test_admin_scope_only_for_admins(make_client):
    admin = make_client()
    await full_user(admin, "11111111")
    user = make_client()
    await otp_login(user, "22222222")
    client_id = await register(user)
    _, challenge = pkce()
    q = {"client_id": client_id, "redirect_uri": REDIRECT, "code_challenge": challenge, "code_challenge_method": "S256",
         "scope": "mcp:admin"}
    info = (await user.get("/api/mcp/consent", params=q)).json()
    assert info["allowed"] is False
    assert (await user.post("/api/mcp/consent", json={**q, "approve": True})).status_code == 403
    assert (await mcp_token(admin, "mcp:admin"))["scope"] == "mcp:admin"


async def test_deny_returns_error(make_client):
    c = make_client()
    await full_user(c, "11111111")
    client_id = await register(c)
    _, challenge = pkce()
    q = {"client_id": client_id, "redirect_uri": REDIRECT, "code_challenge": challenge, "code_challenge_method": "S256",
         "scope": "mcp", "state": "s1"}
    r = await c.post("/api/mcp/consent", json={**q, "approve": False})
    assert "error=access_denied" in r.json()["redirect"] and "state=s1" in r.json()["redirect"]
