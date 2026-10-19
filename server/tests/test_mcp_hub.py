"""The MCP hub in /admin (/api/admin/mcp) and the deep links in app_map.json."""

import re

from app.mcp import links
from app.mcp.registry import CATALOG
from tests.helpers import full_user, otp_login


async def _admin(make_client):
    admin = make_client()
    await full_user(admin, "11111111")
    return admin


async def test_hub_is_admin_only(make_client):
    await _admin(make_client)
    user = make_client()
    await otp_login(user, "22222222")
    for path in ("/api/admin/mcp/overview", "/api/admin/mcp/tools", "/api/admin/mcp/drafts", "/api/admin/mcp/events"):
        assert (await user.get(path)).status_code == 403
    r = await user.post("/api/admin/mcp/tools/whoami/invoke?server=app", json={"args": {}})
    assert r.status_code == 403


async def test_overview_and_tools(make_client):
    admin = await _admin(make_client)
    for server in ("app", "admin"):
        ov = (await admin.get(f"/api/admin/mcp/overview?server={server}")).json()
        assert ov["endpoint"].endswith("/mcp/admin" if server == "admin" else "/mcp")
        assert ov["enabled"] is True and ov["pendingDrafts"] == 0
        cat = (await admin.get(f"/api/admin/mcp/tools?server={server}")).json()
        names = {t["name"] for t in cat["tools"]}
        assert names == {t["name"] for t in CATALOG["tools"] if t["server"] == server}
        assert all("inputSchema" in t for t in cat["tools"])
        assert set(cat["domains"]) == {t["domain"] for t in cat["tools"]}


async def test_invoke_read_tool_runs_as_the_admin_and_is_logged(make_client, owner_conn):
    admin = await _admin(make_client)
    r = await admin.post("/api/admin/mcp/tools/whoami/invoke?server=app", json={"args": {}})
    assert r.status_code == 200 and r.json()["isError"] is False
    assert r.json()["result"]["user"]["role"] == "admin"

    r = await admin.post("/api/admin/mcp/tools/user_get/invoke?server=admin", json={"args": {}})
    assert r.json()["isError"] is True and "userId" in r.json()["result"]["error"]
    assert (await admin.post("/api/admin/mcp/tools/nope/invoke?server=admin", json={"args": {}})).status_code == 404

    rows = owner_conn.execute("select server, tool, status, client_id from mcp_log where method = 'tools/call' order by id").fetchall()
    assert rows == [("app", "whoami", "ok", None), ("admin", "user_get", "error", None)]
    events = (await admin.get("/api/admin/mcp/events?server=admin")).json()["events"]
    assert [e["tool"] for e in events] == ["user_get"]


async def test_hub_drafts_confirm_once_and_cancel(make_client, owner_conn):
    admin = await _admin(make_client)
    user = make_client()
    await otp_login(user, "22222222")
    user_id = (await admin.get("/api/admin/users")).json()["items"][1]["id"]

    r = await admin.post("/api/admin/mcp/tools/user_block/invoke?server=admin", json={"args": {"userId": str(user_id), "reason": "test"}})
    draft = r.json()["result"]
    assert draft["status"] == "pending"
    assert owner_conn.execute("select blocked_at from users where id = %s", (user_id,)).fetchone()[0] is None
    assert (await admin.get("/api/admin/mcp/overview")).json()["pendingDrafts"] == 1

    assert (await admin.post(f"/api/admin/mcp/drafts/{draft['draftId']}/confirm", json={"reason": "x"})).status_code == 422
    r = await admin.post(f"/api/admin/mcp/drafts/{draft['draftId']}/confirm", json={"reason": "mistet telefon"})
    assert r.status_code == 200, r.text
    assert owner_conn.execute("select blocked_at from users where id = %s", (user_id,)).fetchone()[0] is not None
    assert (await admin.post(f"/api/admin/mcp/drafts/{draft['draftId']}/confirm", json={"reason": "igen igen"})).status_code == 409
    audit = owner_conn.execute("select detail->>'via' from audit_log where action = 'mcp.user_block'").fetchall()
    assert audit == [("hub:admin",)]

    r = await admin.post("/api/admin/mcp/tools/user_unblock/invoke?server=admin", json={"args": {"userId": user_id}})
    d2 = r.json()["result"]["draftId"]
    assert (await admin.post(f"/api/admin/mcp/drafts/{d2}/cancel")).status_code == 200
    drafts = (await admin.get("/api/admin/mcp/drafts")).json()["drafts"]
    assert {d["draftId"]: d["status"] for d in drafts} == {draft["draftId"]: "confirmed", d2: "cancelled"}
    assert (await admin.post("/api/admin/mcp/drafts/d_missing/cancel")).status_code == 404


def _pattern(s: str) -> re.Pattern:
    return re.compile("^" + "[a-z0-9_{}-]+".join(re.escape(p) for p in re.split(r"\{\w+\}", s)) + "$")


def test_every_catalog_link_resolves_in_app_map():
    """app_map.json is generated from the data-deeplink anchors in web/src (npm run app-map --prefix web)."""
    for t in CATALOG["tools"]:
        link = t.get("link")
        if not link:
            continue
        path = re.sub(r"\{\w+\}", "1", link["section"])
        assert links.resolve(path), f"{t['name']}: {link['section']} is not a route"
        focus = link.get("focus")
        if focus:
            anchors = links._route_for(path)["anchors"]
            assert any(_pattern(focus).match(a) or _pattern(a).match(focus) for a in anchors), f"{t['name']}: no anchor {focus}"


async def test_stream_sends_new_calls(make_client):
    """GET /stream: LISTEN mcp_log → one `call` event per new row of the chosen server."""
    from app.mcp import hub
    from app.mcp.registry import log_call

    class Req:
        disconnected = False

        async def is_disconnected(self):
            return self.disconnected

    req = Req()
    body = (await hub.stream(req, server="admin")).body_iterator
    assert await anext(body) == ": connected\n\n"
    await log_call(server="app", user_id=None, client_id=None, method="tools/call", tool="whoami", args=None, ms=1, status="ok", ip=None)
    await log_call(server="admin", user_id=None, client_id=None, method="tools/call", tool="stats_overview", args=None, ms=2,
                   status="ok", ip=None)
    chunk = await anext(body)
    assert chunk.startswith("id: ") and "event: call" in chunk and '"stats_overview"' in chunk and "whoami" not in chunk
    req.disconnected = True
    await body.aclose()
