"""The data catalog governs the MCP tools (app/mcp/toolmap.py), internal/external users and access requests with
approval from a list or an e-mail link (app/access.py)."""

import re

import pytest

from app import access, db, gdpr, jobs
from tests.helpers import full_user, otp_login, stepup
from tests.mcp_client import McpClient
from tests.mcp_helpers import mcp_token


async def _connect(http, scope="mcp") -> McpClient:
    t = await mcp_token(http, scope)
    return await McpClient(http, "/mcp/admin" if scope == "mcp:admin" else "/mcp", t["access_token"]).initialize()


async def _tool(admin, name: str) -> dict:
    r = await admin.get("/api/admin/data/tools")
    assert r.status_code == 200, r.text
    return next(t for t in r.json()["tools"] if t["name"] == name)


async def _patch(admin, auth, tool_id: int, body: dict):
    r = await admin.patch(f"/api/admin/data/tools/{tool_id}", json=body)
    if r.status_code == 403 and r.headers.get("x-gaer-error") == "stepup_required":
        await stepup(admin, auth)
        r = await admin.patch(f"/api/admin/data/tools/{tool_id}", json=body)
    return r


async def _post_stepup(client, auth, url: str, body: dict):
    r = await client.post(url, json=body)
    if r.status_code == 403 and r.headers.get("x-gaer-error") == "stepup_required":
        await stepup(client, auth)
        r = await client.post(url, json=body)
    return r


@pytest.fixture
def mails(monkeypatch):
    sent = []

    async def fake_send(to, subject, text, html_body, sender_name):
        sent.append({"to": to, "subject": subject, "text": text})

    monkeypatch.setattr(access, "send_mail", fake_send)
    return sent


async def _setup(make_client, owner_conn):
    admin = make_client()
    admin_auth = await full_user(admin, "11111111")
    user = make_client()
    await otp_login(user, "22222222")
    return admin, admin_auth, user


def _user_id(owner_conn, phone: str) -> int:
    return owner_conn.execute("select id from users where phone = %s", (phone,)).fetchone()[0]


# ── Users ───────────────────────────────────────────────────────────────────

async def test_first_admin_is_internal_new_users_external(make_client, owner_conn):
    admin, admin_auth, user = await _setup(make_client, owner_conn)
    rows = dict(owner_conn.execute("select phone, audience from users").fetchall())
    assert rows == {"+4511111111": "internal", "+4522222222": "external"}
    uid = _user_id(owner_conn, "+4522222222")
    r = await _post_stepup(admin, admin_auth, f"/api/admin/users/{uid}/audience", {"audience": "internal"})
    assert r.status_code == 200, r.text
    assert owner_conn.execute("select audience from users where id = %s", (uid,)).fetchone()[0] == "internal"
    entry = owner_conn.execute("""select before, after from audit_log where table_name = 'users' and row_id = %s
                                  and action = 'update' order by id desc limit 1""", (str(uid),)).fetchone()
    assert entry == ({"audience": "external"}, {"audience": "internal"})
    assert (await user.post(f"/api/admin/users/{uid}/audience", json={"audience": "external"})).status_code == 403
    listed = (await admin.get("/api/admin/users")).json()["items"]
    assert {u["audience"] for u in listed} == {"internal"}


# ── The endpoint map ────────────────────────────────────────────────────────

async def test_code_tools_are_mapped_from_the_catalog_and_can_be_moved(make_client, owner_conn):
    admin, admin_auth, user = await _setup(make_client, owner_conn)
    whoami = await _tool(admin, "whoami")
    assert whoami["kind"] == "code" and whoami["endpoints"] == ["admin", "app"] and whoami["core"]
    clips = await _tool(admin, "clips_list")
    assert clips["endpoints"] == ["app"] and clips["possibleEndpoints"] == ["app"] and clips["classification"] == "white"

    # A Code tool only goes on an endpoint that has code for it; core tools cannot be changed.
    assert (await _patch(admin, admin_auth, clips["id"], {"endpoints": ["app", "admin"]})).status_code == 422
    assert (await _patch(admin, admin_auth, whoami["id"], {"classification": "red"})).status_code == 409

    m = await _connect(user)
    assert "clips_list" in {t["name"] for t in await m.list_tools()}
    assert (await _patch(admin, admin_auth, clips["id"], {"endpoints": []})).status_code == 200
    assert "clips_list" not in {t["name"] for t in await m.list_tools()}
    result, is_error = await m.call("clips_list")
    assert is_error and "Ukendt værktøj" in result["error"]
    assert (await _patch(admin, admin_auth, clips["id"], {"endpoints": ["app"], "enabled": False})).status_code == 200
    assert (await m.call("clips_list"))[1]
    assert (await _patch(admin, admin_auth, clips["id"], {"enabled": True})).status_code == 200
    assert not (await m.call("clips_list"))[1]
    actions = [r[0] for r in owner_conn.execute("select action from audit_log where table_name = 'mcp_tools'").fetchall()]
    assert actions.count("mcp_tool.updated") >= 3


async def test_classification_gates_tools_and_yellow_needs_the_users_approval(make_client, owner_conn, mails):
    admin, admin_auth, user = await _setup(make_client, owner_conn)
    clips = await _tool(admin, "clips_list")
    m = await _connect(user)

    # Green: internal users only.
    assert (await _patch(admin, admin_auth, clips["id"], {"classification": "green"})).status_code == 200
    result, is_error = await m.call("clips_list")
    assert is_error and "interne" in result["error"]
    tools = {t["name"]: t for t in await m.list_tools()}
    assert "Låst" in tools["clips_list"]["description"]
    # An external user may not ask for a tool, only for their own data.
    result, is_error = await m.call("access_request", target="clips_list", reason="Jeg vil se mine klip")
    assert is_error and "Eksterne" in result["error"]

    uid = _user_id(owner_conn, "+4522222222")
    owner_conn.execute("update users set audience = 'internal' where id = %s", (uid,))
    assert not (await m.call("clips_list"))[1]

    # Yellow: needs a grant the user approves; the client cannot approve itself.
    assert (await _patch(admin, admin_auth, clips["id"], {"classification": "yellow"})).status_code == 200
    result, is_error = await m.call("clips_list")
    assert is_error and "access_request" in result["error"]
    listed, _ = await m.call("access_list")
    item = next(i for i in listed["items"] if i["target"] == "clips_list")
    assert item["level"] == "internal" and item["mayRequest"] and item["status"] is None

    result, is_error = await m.call("access_request", target="clips_list", reason="Opsummér mine klip")
    assert not is_error, result
    req = result["request"]
    assert req["status"] == "awaiting_user" and req["level"] == "internal"
    again, _ = await m.call("access_request", target="clips_list", reason="Opsummér mine klip igen")
    assert again["created"] is False and again["request"]["id"] == req["id"]
    assert (await m.call("clips_list"))[1]

    mine = (await user.get("/api/me/mcp-access")).json()
    assert mine["items"][0]["id"] == req["id"]
    r = await user.post(f"/api/me/mcp-access/{req['id']}/decide", json={"approve": True})
    assert r.status_code == 200 and r.json()["status"] == "approved"
    result, is_error = await m.call("clips_list")
    assert not is_error, result

    # Another client of the same user does not get the grant.
    other = await _connect(user)
    assert (await other.call("clips_list"))[1]

    # Becoming external ends it at once.
    r = await _post_stepup(admin, admin_auth, f"/api/admin/users/{uid}/audience", {"audience": "external"})
    assert r.status_code == 200 and r.json()["grants_ended"] == 1
    assert (await m.call("clips_list"))[1]
    statuses = [r[0] for r in owner_conn.execute("select status from mcp_access_requests").fetchall()]
    assert statuses == ["revoked"]


async def test_red_needs_an_approver_from_the_list(make_client, owner_conn, mails):
    admin, admin_auth, user = await _setup(make_client, owner_conn)
    uid = _user_id(owner_conn, "+4522222222")
    owner_conn.execute("update users set audience = 'internal' where id = %s", (uid,))
    clips = await _tool(admin, "clips_list")
    assert (await _patch(admin, admin_auth, clips["id"], {"classification": "red"})).status_code == 200
    m = await _connect(user)
    result, _ = await m.call("access_request", target="clips_list", reason="Kvartalsrapport Q4")
    rid = result["request"]["id"]
    assert result["request"]["level"] == "confidential"

    # The approver cannot act before the user has.
    r = await _post_stepup(admin, admin_auth, f"/api/admin/access/{rid}/decide", {"approve": True, "days": 7})
    assert r.status_code == 409
    assert (await user.post(f"/api/me/mcp-access/{rid}/decide", json={"approve": True})).json()["status"] == "awaiting_approver"
    assert (await m.call("clips_list"))[1]

    # The approver gets a mail with a link; jobs fan out one mail per approver.
    owner_conn.execute("update users set email = 'admin@firma.dk' where phone = '+4511111111'")
    await jobs.run_pending()
    assert any("Godkend adgang" in x["subject"] and x["to"] == "admin@firma.dk" for x in mails)

    listed = (await admin.get("/api/admin/access?status=open")).json()
    assert [i["id"] for i in listed["items"]] == [rid] and listed["counts"]["open"] == 1
    # A normal user cannot see or decide.
    assert (await user.get("/api/admin/access")).status_code == 403
    assert (await _post_stepup(admin, admin_auth, f"/api/admin/access/{rid}/decide", {"approve": True, "days": 3})).status_code == 422
    assert (await _post_stepup(admin, admin_auth, f"/api/admin/access/{rid}/decide", {"approve": False})).status_code == 422
    r = await _post_stepup(admin, admin_auth, f"/api/admin/access/{rid}/decide", {"approve": True, "days": 1, "note": "OK"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved" and r.json()["approverVia"] == "list"
    assert not (await m.call("clips_list"))[1]

    # Revoked by the approver: gone.
    assert (await admin.post(f"/api/admin/access/{rid}/revoke", json={"reason": "Projekt slut"})).status_code == 200
    assert (await m.call("clips_list"))[1]
    actions = [r[0] for r in owner_conn.execute("""select action from audit_log where table_name = 'mcp_access_requests'
                                                   order by id""").fetchall()]
    assert actions == ["mcp_access.requested", "mcp_access.user_approved", "mcp_access.approved", "mcp_access.revoked"]


async def test_no_approving_your_own_confidential_request(make_client, owner_conn, mails):
    admin, admin_auth, _ = await _setup(make_client, owner_conn)
    clips = await _tool(admin, "clips_list")
    await _patch(admin, admin_auth, clips["id"], {"classification": "red"})
    m = await _connect(admin)
    result, _ = await m.call("access_request", target="clips_list", reason="Mine egne klip")
    rid = result["request"]["id"]
    await admin.post(f"/api/me/mcp-access/{rid}/decide", json={"approve": True})
    r = await _post_stepup(admin, admin_auth, f"/api/admin/access/{rid}/decide", {"approve": True})
    assert r.status_code == 403 and "egen" in r.json()["detail"]
    assert (await admin.get("/api/admin/access")).json()["items"][0]["own"] is True


async def test_email_and_phone_by_mail_link(make_client, owner_conn, mails):
    admin, _, user = await _setup(make_client, owner_conn)
    owner_conn.execute("update users set email = 'mette@firma.dk' where phone = '+4522222222'")
    m = await _connect(user)
    me, _ = await m.call("whoami")
    assert me["user"]["email"] != "mette@firma.dk" and "•" in me["user"]["email"]

    # An external user may ask for their own data.
    result, is_error = await m.call("access_request", target="email", reason="Svar på mails fra kunder")
    assert not is_error, result
    await jobs.run_pending()
    mail = next(x for x in mails if x["to"] == "mette@firma.dk")
    token = re.search(r"/godkend\?t=([\w-]+)", mail["text"]).group(1)

    # The link belongs to the recipient: someone else logged in gets nothing.
    r = await admin.get(f"/api/me/mcp-access/link?t={token}")
    assert r.status_code == 403
    r = await user.get(f"/api/me/mcp-access/link?t={token}")
    assert r.status_code == 200 and r.json()["target"] == "email"
    r = await user.post("/api/me/mcp-access/link", json={"t": token, "approve": True})
    assert r.status_code == 200 and r.json()["status"] == "approved" and r.json()["userVia"] == "email"
    # Single use.
    assert (await user.post("/api/me/mcp-access/link", json={"t": token, "approve": True})).status_code == 410

    me, _ = await m.call("whoami")
    assert me["user"]["email"] == "mette@firma.dk" and "•" in me["user"]["phone"]
    profile, _ = await m.call("profile_get")
    assert profile["profile"]["email"] == "mette@firma.dk"

    # The user revokes it in /konto.
    assert (await user.post(f"/api/me/mcp-access/{r.json()['id']}/revoke")).status_code == 200
    me, _ = await m.call("whoami")
    assert "•" in me["user"]["email"]


async def test_data_tool_follows_the_dataset_and_unmasks_with_a_grant(make_client, owner_conn, mails):
    admin, admin_auth, user = await _setup(make_client, owner_conn)
    uid = _user_id(owner_conn, "+4522222222")
    owner_conn.execute("""insert into clips (user_id, source, title, body) values (%s, 'manual', 'Hej', 'Hemmeligt')""", (uid,))
    ds = (await admin.post("/api/admin/data/datasets", json={"table": "clips"})).json()
    title = next(f for f in ds["fields"] if f["name"] == "title")
    body = next(f for f in ds["fields"] if f["name"] == "body")
    await admin.patch(f"/api/admin/data/datasets/{ds['id']}/fields/{title['id']}", json={"classification": "white"})
    await admin.patch(f"/api/admin/data/datasets/{ds['id']}/fields/{body['id']}", json={"classification": "red"})
    for f in ds["fields"]:
        if f["name"] not in ("title", "body"):
            await admin.patch(f"/api/admin/data/datasets/{ds['id']}/fields/{f['id']}", json={"classification": "green"})
    await admin.patch(f"/api/admin/data/datasets/{ds['id']}", json={"classification": "green"})

    r = await _post_stepup(admin, admin_auth, "/api/admin/data/tools",
                           {"name": "klip_data", "dataset_id": ds["id"], "title": "Alle klip", "endpoints": ["admin"]})
    assert r.status_code == 201, r.text
    tool = r.json()
    assert tool["kind"] == "data" and tool["classification"] == "green" and tool["requestLevel"] == "confidential"
    assert owner_conn.execute("select mcp_exposed from datasets where id = %s", (ds["id"],)).fetchone()[0] is True
    # A Data tool has no classification of its own.
    assert (await _patch(admin, admin_auth, tool["id"], {"classification": "white"})).status_code == 409

    # Only on /mcp/admin so far; then also on /mcp.
    m = await _connect(user)
    assert "klip_data" not in {t["name"] for t in await m.list_tools()}
    assert (await _patch(admin, admin_auth, tool["id"], {"endpoints": ["admin", "app"]})).status_code == 200
    assert "klip_data" in {t["name"] for t in await m.list_tools()}

    # Green → external users are refused.
    result, is_error = await m.call("klip_data")
    assert is_error and "interne" in result["error"]
    owner_conn.execute("update users set audience = 'internal' where id = %s", (uid,))
    result, is_error = await m.call("klip_data")
    assert not is_error, result
    row = result["rows"][0]
    assert row["title"] == "Hej" and row["body"] == "•••" and "access_request" in result["summary"]
    # A masked field cannot be a filter.
    assert (await m.call("klip_data", field="body", value="x"))[1]

    # The red field needs a confidential grant: the user, then an approver.
    req, _ = await m.call("access_request", target="klip_data", reason="Kvartalsrapport")
    rid = req["request"]["id"]
    assert req["request"]["level"] == "confidential"
    await user.post(f"/api/me/mcp-access/{rid}/decide", json={"approve": True})
    # The approver can also decide from /mcp/admin as a draft.
    am = await _connect(admin, "mcp:admin")
    listed, _ = await am.call("access_requests_list")
    assert [x["id"] for x in listed["requests"]] == [rid]
    d, is_error = await am.call("access_request_decide", requestId=rid, approve=True, days=7)
    assert not is_error, d
    confirmed, is_error = await am.call("confirm_draft", draftId=d["draftId"], reason="Godkendt til Q4")
    assert not is_error, confirmed
    result, _ = await m.call("klip_data")
    assert result["rows"][0]["body"] == "Hemmeligt" and result["grant"]["level"] == "confidential"

    # Raising the dataset to red in the catalog locks the tool for everyone without such a grant.
    await admin.patch(f"/api/admin/data/datasets/{ds['id']}", json={"classification": "red"})
    assert (await _tool(admin, "klip_data"))["classification"] == "red"
    assert not (await m.call("klip_data"))[1]
    assert (await (await _connect(user)).call("klip_data"))[1]


async def test_admin_set_audience_draft_and_gdpr(make_client, owner_conn, mails):
    admin, _, user = await _setup(make_client, owner_conn)
    uid = _user_id(owner_conn, "+4522222222")
    am = await _connect(admin, "mcp:admin")
    got, _ = await am.call("user_get", userId=uid)
    assert got["user"]["audience"] == "external"
    d, is_error = await am.call("user_set_audience", userId=uid, audience="internal", reason="Ny medarbejder")
    assert not is_error, d
    await am.call("confirm_draft", draftId=d["draftId"], reason="Ny medarbejder")
    assert owner_conn.execute("select audience from users where id = %s", (uid,)).fetchone()[0] == "internal"

    # Requests are personal data: in the GDPR export, and gone with the user.
    m = await _connect(user)
    await m.call("access_request", target="phone", reason="Ring tilbage til kunder")
    async with db.connection() as conn:
        data = await gdpr.build_user_export(conn, uid)
    assert data["user"]["audience"] == "internal"
    assert [(r["target"], r["status"]) for r in data["mcp_access_requests"]] == [("phone", "awaiting_user")]
    owner_conn.execute("delete from users where id = %s", (uid,))
    assert owner_conn.execute("select count(*) from mcp_access_requests").fetchone()[0] == 0
