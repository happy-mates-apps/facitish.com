"""Beskeder, phase 2 (specs/beskeder): conversations between users, the word filter, reports and moderation, blocks,
admin roles and GDPR. Carried over from happy-groups' member-chat worker tests (group conversation, direct ones and
their visibility, report and block workflows, blocked-language filtering, unread + read)."""

from app.messages import chat
from tests.helpers import full_user, otp_login


async def setup(make_client, owner_conn):
    """The super admin and three users with names: Ida, Per and Ole."""
    admin = make_client()
    await full_user(admin, "11111111")
    users = {}
    for phone, name in (("22222222", "Ida"), ("33333333", "Per"), ("44444444", "Ole")):
        c = make_client()
        await otp_login(c, phone)
        assert (await c.patch("/api/me/profile", json={"display_name": name})).status_code == 200
        users[name] = c
    ids = {r[1]: r[0] for r in owner_conn.execute("select id, display_name from users where display_name is not null")}
    return admin, users, ids


async def shared_id(client) -> int:
    items = (await client.get("/api/messages/conversations")).json()["items"]
    assert items[0]["kind"] == "instance" and items[0]["title"] == "Fællessamtalen"
    return items[0]["id"]


def test_word_filter():
    words = ["idiot", "tjen * om dagen", "*.whatsapp.com/*"]
    assert chat.filtered("Du er en IDIOT!", words)
    assert not chat.filtered("idiotsikker plan", words)          # whole words only
    assert chat.filtered("Tjen 5.000 kr om dagen hjemmefra", words)
    assert chat.filtered("se chat.whatsapp.com/abc", words)
    assert not chat.filtered("Hej med dig", words)
    assert not chat.filtered("hvad som helst", [" ", ""])


async def test_shared_conversation_unread_and_read(make_client, owner_conn):
    admin, u, ids = await setup(make_client, owner_conn)
    cid = await shared_id(u["Ida"])
    r = await u["Ida"].post(f"/api/messages/conversations/{cid}/messages", json={"body": "Hej alle sammen"})
    assert r.status_code == 200, r.text
    await u["Per"].post(f"/api/messages/conversations/{cid}/read")  # Per has read everything so far …
    await u["Ida"].post(f"/api/messages/conversations/{cid}/messages", json={"body": "Møde kl. 10?"})

    assert (await u["Per"].get("/api/messages/conversations/unread")).json() == {"total": 1}
    assert (await u["Ida"].get("/api/messages/conversations/unread")).json() == {"total": 0}  # own messages never count
    page = (await u["Per"].get(f"/api/messages/conversations/{cid}/messages")).json()
    assert [(m["author_name"], m["body"], m["mine"]) for m in page["items"]] == [
        ("Ida", "Hej alle sammen", False), ("Ida", "Møde kl. 10?", False)]
    await u["Per"].post(f"/api/messages/conversations/{cid}/read")
    assert (await u["Per"].get("/api/messages/conversations/unread")).json() == {"total": 0}
    actions = [r[0] for r in owner_conn.execute("select action from audit_log where action = 'messages.post'")]
    assert len(actions) == 2
    detail = owner_conn.execute("select detail from audit_log where action = 'messages.post' limit 1").fetchone()[0]
    assert "body" not in detail and detail["length"] == len("Hej alle sammen")


async def test_direct_conversations_are_private(make_client, owner_conn):
    admin, u, ids = await setup(make_client, owner_conn)
    found = (await u["Ida"].get("/api/messages/members?q=pe")).json()["items"]
    assert found == [{"id": ids["Per"], "display_name": "Per"}]
    r = await u["Ida"].post("/api/messages/conversations/direct", json={"user_id": ids["Per"]})
    cid = r.json()["id"]
    # The same pair gets the same conversation, from either side.
    assert (await u["Per"].post("/api/messages/conversations/direct", json={"user_id": ids["Ida"]})).json()["id"] == cid
    assert (await u["Ida"].post(f"/api/messages/conversations/{cid}/messages", json={"body": "Hej Per"})).status_code == 200
    titles = [c["title"] for c in (await u["Per"].get("/api/messages/conversations")).json()["items"]]
    assert titles == ["Fællessamtalen", "Ida"]
    # Ole is not in it.
    assert (await u["Ole"].get(f"/api/messages/conversations/{cid}/messages")).status_code == 404
    assert (await u["Ole"].post(f"/api/messages/conversations/{cid}/messages", json={"body": "hej"})).status_code == 404
    assert (await u["Ida"].post("/api/messages/conversations/direct", json={"user_id": ids["Ida"]})).status_code == 400
    # Reply threads are not reachable as conversations.
    owner_conn.execute("insert into message_broadcasts (title, body, audience, audience_label) values ('t', 'b', '{}', 'x')")
    owner_conn.execute("insert into conversations (kind, broadcast_id, user_id) values ('reply', 1, %s)", (ids["Ida"],))
    rid = owner_conn.execute("select id from conversations where kind = 'reply'").fetchone()[0]
    assert (await u["Ida"].get(f"/api/messages/conversations/{rid}/messages")).status_code == 404


async def test_word_filter_rejects_before_storing(make_client, owner_conn):
    admin, u, ids = await setup(make_client, owner_conn)
    r = await admin.put("/api/admin/messages/settings", json={"blocked_words": ["Idiot", "tjen * om dagen", " "]})
    assert r.status_code == 200 and r.json()["blocked_words"] == ["idiot", "tjen * om dagen"]
    after = owner_conn.execute("select after from audit_log where action = 'messages.settings'").fetchone()[0]
    assert after == {"blocked_words": 2}  # counts, never the words
    cid = await shared_id(u["Ida"])
    r = await u["Ida"].post(f"/api/messages/conversations/{cid}/messages", json={"body": "Du er en idiot"})
    assert r.status_code == 400 and "ikke er tilladt" in r.json()["detail"]
    assert owner_conn.execute("select count(*) from conversation_messages").fetchone()[0] == 0
    # Broadcasts are filtered too.
    payload = {"title": "Tjen 100 kr om dagen", "body": "x", "audience": {"kind": "admins"}}
    assert (await admin.post("/api/admin/messages/broadcast", json=payload)).status_code == 400


async def test_report_context_and_remove(make_client, owner_conn):
    admin, u, ids = await setup(make_client, owner_conn)
    cid = await shared_id(u["Ida"])
    for text in ("en", "to", "tre", "fire"):
        await u["Per"].post(f"/api/messages/conversations/{cid}/messages", json={"body": text})
    r = await u["Ole"].post(f"/api/messages/conversations/{cid}/messages", json={"body": "Hold dig væk fra projektet"})
    bad = r.json()["id"]

    assert (await u["Ole"].post("/api/messages/reports", json={"message_id": bad, "reason": "harassment"})).status_code == 400
    r = await u["Ida"].post("/api/messages/reports", json={"message_id": bad, "reason": "harassment", "details": "Igen"})
    assert r.status_code == 200, r.text
    assert (await u["Ida"].post("/api/messages/reports", json={"message_id": bad, "reason": "spam"})).status_code == 409
    assert (await u["Per"].post("/api/messages/reports", json={"message_id": bad, "reason": "other"})).status_code == 200

    reports = (await admin.get("/api/admin/messages/moderation/reports")).json()
    assert reports["pending"] == 1
    item = reports["items"][0]
    assert (item["author_name"], item["body"], item["where"]) == ("Ole", "Hold dig væk fra projektet", "Fællessamtalen")
    assert [(r["reporter"], r["reason_label"]) for r in item["reports"]] == [("Ida", "Chikane"), ("Per", "Andet")]

    # The three before it, and only those; the look is audited.
    ctx = (await admin.get(f"/api/admin/messages/moderation/reports/{bad}/context")).json()["items"]
    assert [m["body"] for m in ctx] == ["to", "tre", "fire"]
    row = owner_conn.execute("select detail from audit_log where action = 'messages.report.context'").fetchone()[0]
    assert len(row["shown"]) == 3

    r = await admin.post(f"/api/admin/messages/moderation/reports/{bad}", json={"action": "remove"})
    assert r.status_code == 200 and r.json()["reports"] == 2
    assert (await admin.post(f"/api/admin/messages/moderation/reports/{bad}", json={"action": "dismiss"})).status_code == 409
    # Once decided, the context is closed.
    assert (await admin.get(f"/api/admin/messages/moderation/reports/{bad}/context")).status_code == 409
    page = (await u["Per"].get(f"/api/messages/conversations/{cid}/messages")).json()["items"]
    assert page[-1]["removed"] is True and page[-1]["body"] is None
    # The text stays for the audit trail.
    assert owner_conn.execute("select body, removed_at is not null from conversation_messages where id = %s",
                              (bad,)).fetchone() == ("Hold dig væk fra projektet", True)
    assert (await admin.get("/api/admin/messages/moderation/reports")).json()["pending"] == 0
    assert (await admin.get("/api/admin/messages/moderation/reports?status=removed")).json()["items"][0]["removed"] is True
    assert (await admin.get("/api/admin/messages/overview")).json()["pending_reports"] == 0


async def test_blocks_hide_messages_and_direct_conversations(make_client, owner_conn):
    admin, u, ids = await setup(make_client, owner_conn)
    cid = await shared_id(u["Ida"])
    dm = (await u["Ida"].post("/api/messages/conversations/direct", json={"user_id": ids["Ole"]})).json()["id"]
    await u["Ole"].post(f"/api/messages/conversations/{cid}/messages", json={"body": "Ole skriver"})
    await u["Per"].post(f"/api/messages/conversations/{cid}/messages", json={"body": "Per skriver"})

    assert (await u["Ida"].put(f"/api/messages/blocks/{ids['Ole']}")).status_code == 200
    assert [b["display_name"] for b in (await u["Ida"].get("/api/messages/blocks")).json()["items"]] == ["Ole"]
    bodies = [m["body"] for m in (await u["Ida"].get(f"/api/messages/conversations/{cid}/messages")).json()["items"]]
    assert bodies == ["Per skriver"]
    assert (await u["Ida"].get("/api/messages/conversations/unread")).json() == {"total": 1}
    # The direct conversation is gone for both, and neither can open a new one.
    assert [c["kind"] for c in (await u["Ida"].get("/api/messages/conversations")).json()["items"]] == ["instance"]
    assert (await u["Ole"].get(f"/api/messages/conversations/{dm}/messages")).status_code == 404
    assert (await u["Ole"].post("/api/messages/conversations/direct", json={"user_id": ids["Ida"]})).status_code == 409
    assert all(m["id"] != ids["Ida"] for m in (await u["Ole"].get("/api/messages/members")).json()["items"])

    # Admins see counts, never who.
    summary = (await admin.get("/api/admin/messages/moderation/blocks")).json()["items"]
    assert [(s["display_name"], s["blocked_by"]) for s in summary] == [("Ole", 1)]
    assert "blocker_id" not in summary[0]

    assert (await u["Ida"].delete(f"/api/messages/blocks/{ids['Ole']}")).status_code == 200
    assert (await u["Ole"].get(f"/api/messages/conversations/{dm}/messages")).status_code == 200
    actions = [r[0] for r in owner_conn.execute("select action from audit_log where action like 'messages.%%block' order by id")]
    assert actions == ["messages.block", "messages.unblock"]


async def test_moderation_roles(make_client, owner_conn):
    admin, u, ids = await setup(make_client, owner_conn)
    for roles, phone in (("{privatliv}", "+4577777777"), ("{drift}", "+4588888888")):
        owner_conn.execute("insert into users (phone, role, admin_roles) values (%s, 'admin', %s)", (phone, roles))
    priv, ops = make_client(), make_client()
    await otp_login(priv, "77777777")
    await otp_login(ops, "88888888")
    assert (await priv.get("/api/admin/messages/moderation/reports")).status_code == 200
    assert (await priv.post("/api/admin/messages/broadcast", json={"title": "x", "body": "y", "audience": {"kind": "admins"}})).status_code == 403
    assert (await ops.get("/api/admin/messages/moderation/reports")).status_code == 403
    assert (await u["Ida"].get("/api/admin/messages/moderation/reports")).status_code == 403


async def test_gdpr_export_and_erasure(make_client, owner_conn):
    admin, u, ids = await setup(make_client, owner_conn)
    cid = await shared_id(u["Ida"])
    await u["Ida"].post(f"/api/messages/conversations/{cid}/messages", json={"body": "Mit indlæg"})
    await u["Per"].post(f"/api/messages/conversations/{cid}/messages", json={"body": "Pers indlæg"})
    dm = (await u["Ida"].post("/api/messages/conversations/direct", json={"user_id": ids["Per"]})).json()["id"]
    await u["Per"].post(f"/api/messages/conversations/{dm}/messages", json={"body": "Hej Ida"})
    per_msg = owner_conn.execute("select id from conversation_messages where body = 'Pers indlæg'").fetchone()[0]
    await u["Ida"].post("/api/messages/reports", json={"message_id": per_msg, "reason": "spam"})
    await u["Ida"].put(f"/api/messages/blocks/{ids['Ole']}")

    from app import db, gdpr
    async with db.connection() as conn:
        data = await gdpr.build_user_export(conn, ids["Ida"])
    assert [m["body"] for m in data["conversation_messages"]] == ["Mit indlæg"]
    assert data["message_reports"][0]["reason"] == "spam"
    assert data["user_blocks"][0]["blocked_id"] == ids["Ole"]
    assert {c["kind"] for c in data["conversations"]} == {"instance", "direct"}

    assert (await u["Ida"].post("/api/me/delete", json={"confirm_phone": "22222222"})).status_code == 200
    bodies = [r[0] for r in owner_conn.execute("select body from conversation_messages order by id")]
    assert bodies == ["Pers indlæg"]  # her post and the whole direct conversation went
    assert owner_conn.execute("select count(*) from conversations where kind = 'direct'").fetchone()[0] == 0
    assert owner_conn.execute("select count(*) from message_reports").fetchone()[0] == 0
    assert owner_conn.execute("select count(*) from user_blocks").fetchone()[0] == 0
