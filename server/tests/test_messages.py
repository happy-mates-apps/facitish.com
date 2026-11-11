"""Beskeder, phase 1 (specs/beskeder): broadcasts in two steps, the channel per recipient, SMS consent, quiet hours,
duplicates and the hourly cap, the inbox, reply threads, admin roles, GDPR. Carried over from happy-groups'
member-chat and member-sms worker tests."""

from app import jobs
from app.messages import service, text
from tests.helpers import full_user, otp_login, stepup


QUIET_OFF = {"quiet_start": "00:00", "quiet_end": "00:00"}


async def setup(make_client, owner_conn):
    """The super admin, and three users: Ida (phone, said yes to SMS), Ole (e-mail only), Per (phone, no yes)."""
    admin = make_client()
    auth = await full_user(admin, "11111111")
    assert (await admin.put("/api/admin/messages/settings", json=QUIET_OFF)).status_code == 200
    ida, ole, per = make_client(), make_client(), make_client()
    await otp_login(ida, "22222222")
    await otp_login(per, "44444444")
    owner_conn.execute("insert into users (email, display_name) values ('ole@example.dk', 'Ole Berg')")
    r = await ida.put("/api/messages/prefs", json={"sms": True})
    assert r.status_code == 200 and r.json()["sms"] is True and r.json()["sms_consent_at"]
    ids = {r[1]: r[0] for r in owner_conn.execute("select id, coalesce(phone, email) from users").fetchall()}
    return admin, auth, ida, ole, per, ids


def body(**kw) -> dict:
    return {"title": "Vedligehold lørdag", "body": "Appen er utilgængelig kl. 14-15.", "audience": {"kind": "admins"},
            "channels": ["sms", "mail"], **kw}


async def send(admin, auth, payload: dict) -> dict:
    r = await admin.post("/api/admin/messages/broadcast", json=payload)
    assert r.status_code == 200, r.text
    token = r.json()["confirmation_token"]
    r = await admin.post("/api/admin/messages/broadcast", json={**payload, "confirmation_token": token})
    if r.status_code == 403 and r.headers.get("x-gaer-error") == "stepup_required":
        assert (await stepup(admin, auth)).status_code == 200
        r = await admin.post("/api/admin/messages/broadcast", json={**payload, "confirmation_token": token})
    assert r.status_code == 200, r.text
    return r.json()


def test_segments():
    assert text.segments("a" * 160) == (1, "GSM-7")
    assert text.segments("a" * 161) == (2, "GSM-7")
    assert text.segments("€" * 80) == (1, "GSM-7")       # extension characters count twice
    assert text.segments("€" * 81) == (2, "GSM-7")
    assert text.segments("ø" * 160) == (1, "GSM-7")       # Danish letters are in GSM-7
    assert text.segments("ł" * 70) == (1, "UCS-2")
    assert text.segments("ł" * 71) == (2, "UCS-2")


def test_quiet_hours():
    from datetime import datetime, timezone
    s = {**service.DEFAULTS, "time_zone": "UTC"}
    assert service.quiet_delay(s, datetime(2026, 1, 5, 23, 0, tzinfo=timezone.utc)) == 8 * 3600
    assert service.quiet_delay(s, datetime(2026, 1, 5, 6, 30, tzinfo=timezone.utc)) == 1800
    assert service.quiet_delay(s, datetime(2026, 1, 5, 12, 0, tzinfo=timezone.utc)) == 0
    assert service.quiet_delay({**s, **QUIET_OFF}, datetime(2026, 1, 5, 23, 0, tzinfo=timezone.utc)) == 0


async def test_estimate_picks_one_channel_per_recipient(make_client, owner_conn):
    admin, auth, ida, ole, per, ids = await setup(make_client, owner_conn)
    chips = (await admin.get("/api/admin/messages/broadcast/audiences")).json()["items"]
    assert chips[0] == {"audience": {"kind": "all"}, "label": "Alle brugere", "count": 4}

    r = await admin.post("/api/admin/messages/broadcast/estimate",
                         json={"audience": {"kind": "all"}, "channels": ["sms", "mail"], "title": "Hej", "body": "Kort"})
    est = r.json()
    # Ida said yes to SMS; Ole has only e-mail; Per has a phone but no yes; the admin has a phone and no e-mail.
    assert (est["total"], est["sms"], est["mail"], est["app_only"], est["push"]) == (4, 1, 1, 2, 0)
    assert est["segments"] == 1 and est["price_minor"] == 45 and est["label"] == "Alle brugere"

    est = (await admin.post("/api/admin/messages/broadcast/estimate",
                            json={"audience": {"kind": "all"}, "channels": ["mail"]})).json()
    assert (est["sms"], est["mail"], est["app_only"]) == (0, 1, 3)

    # A login phone number is not a yes; withdrawing the yes takes Ida out of SMS.
    assert (await ida.put("/api/messages/prefs", json={"sms": False})).json()["sms_consent_at"] is None
    est = (await admin.post("/api/admin/messages/broadcast/estimate",
                            json={"audience": {"kind": "all"}, "channels": ["sms"]})).json()
    assert est["sms"] == 0
    audit = owner_conn.execute("""select before, after from audit_log where action = 'messages.prefs'
                                  order by id""").fetchall()
    assert audit == [({"sms": False}, {"sms": True}), ({"sms": True}, {"sms": False})]

    # Without a phone, SMS cannot be switched on.
    owner_conn.execute("update users set phone = null, email = 'per@example.dk' where id = %s", (ids["+4544444444"],))
    assert (await per.put("/api/messages/prefs", json={"sms": True})).status_code == 400


async def test_two_steps_then_delivery_inbox_and_replay(make_client, owner_conn):
    admin, auth, ida, ole, per, ids = await setup(make_client, owner_conn)
    payload = body(audience={"kind": "users", "user_ids": [ids["+4522222222"], ids["+4544444444"]]})

    r = await admin.post("/api/admin/messages/broadcast", json=payload)
    proposal = r.json()
    assert proposal["proposal"]["estimate"]["sms"] == 1 and proposal["proposal"]["estimate"]["app_only"] == 1
    assert owner_conn.execute("select count(*) from message_broadcasts").fetchone()[0] == 0

    # The token is bound to the text and the audience: a changed text is refused.
    r = await admin.post("/api/admin/messages/broadcast",
                         json={**payload, "body": "Noget andet", "confirmation_token": proposal["confirmation_token"]})
    assert r.status_code == 409 and "ændret" in r.json()["detail"]

    r = await admin.post("/api/admin/messages/broadcast", json={**payload, "confirmation_token": proposal["confirmation_token"]})
    assert r.status_code == 200, r.text
    bid = r.json()["id"]
    # A second click with the same token cannot send twice.
    r = await admin.post("/api/admin/messages/broadcast", json={**payload, "confirmation_token": proposal["confirmation_token"]})
    assert r.status_code == 409 and "allerede sendt" in r.json()["detail"]

    await jobs.run_pending()
    rows = owner_conn.execute("""select u.phone, d.channel, d.status from message_deliveries d join users u on u.id = d.user_id
                                 where broadcast_id = %s order by u.phone, d.channel""", (bid,)).fetchall()
    assert rows == [("+4522222222", "app", "delivered"), ("+4522222222", "sms", "sent"),
                    ("+4544444444", "app", "delivered")]
    sms = owner_conn.execute("select to_phone, body, segments, status from sms_messages").fetchall()
    assert len(sms) == 1 and sms[0][0] == "+4522222222" and sms[0][3] == "sent"
    assert "Vedligehold lørdag" in sms[0][1] and f"/beskeder/{bid}" in sms[0][1]
    b = owner_conn.execute("select status, total, sms, app_only from message_broadcasts where id = %s", (bid,)).fetchone()
    assert b == ("sent", 2, 1, 1)
    detail = owner_conn.execute("select detail from audit_log where action = 'messages.broadcast.send'").fetchone()[0]
    assert detail["total"] == 2 and detail["body_length"] == len(payload["body"]) and "body" not in detail

    # The inbox: Per sees it, unread; Ole was not a recipient.
    assert (await per.get("/api/messages/unread")).json() == {"total": 1}
    items = (await per.get("/api/messages/inbox")).json()["items"]
    assert [(i["id"], i["title"], i["unread"]) for i in items] == [(bid, "Vedligehold lørdag", True)]
    assert (await per.get(f"/api/messages/inbox/{bid}")).json()["body"] == payload["body"]
    assert (await per.post(f"/api/messages/inbox/{bid}/read")).status_code == 200
    assert (await per.get("/api/messages/unread")).json() == {"total": 0}
    assert (await ole.get(f"/api/messages/inbox/{bid}")).status_code == 401  # Ole never logged in
    other = make_client()
    await otp_login(other, "55555555")
    assert (await other.get(f"/api/messages/inbox/{bid}")).status_code == 404
    assert (await other.post(f"/api/messages/inbox/{bid}/reply", json={"body": "hej"})).status_code == 404

    log = (await admin.get("/api/admin/messages/broadcast/log")).json()["items"]
    assert log[0]["id"] == bid and log[0]["unread_in_app"] == 1
    overview = (await admin.get("/api/admin/messages/overview")).json()
    assert overview["broadcasts"] == 1 and overview["split"]["sms"] == 1 and overview["sms_segments"] == sms[0][2]


async def test_everyone_needs_a_fresh_second_factor(make_client, owner_conn):
    admin, auth, ida, ole, per, ids = await setup(make_client, owner_conn)
    owner_conn.execute("update sessions set mfa_at = now() - interval '1 hour'")
    payload = body(audience={"kind": "all"})
    token = (await admin.post("/api/admin/messages/broadcast", json=payload)).json()["confirmation_token"]
    r = await admin.post("/api/admin/messages/broadcast", json={**payload, "confirmation_token": token})
    assert r.status_code == 403 and r.headers["x-gaer-error"] == "stepup_required"
    # A smaller audience does not.
    small = body(audience={"kind": "admins"})
    token = (await admin.post("/api/admin/messages/broadcast", json=small)).json()["confirmation_token"]
    assert (await admin.post("/api/admin/messages/broadcast", json={**small, "confirmation_token": token})).status_code == 200
    assert (await stepup(admin, auth)).status_code == 200
    await send(admin, auth, payload)
    await jobs.run_pending()
    assert owner_conn.execute("select count(*) from message_deliveries where channel = 'app'").fetchone()[0] == 5


async def test_quiet_hours_hold_sms_unless_urgent(make_client, owner_conn):
    admin, auth, ida, ole, per, ids = await setup(make_client, owner_conn)
    # A quiet window that always covers now: 00:00 → 23:59.
    await admin.put("/api/admin/messages/settings", json={"quiet_start": "00:00", "quiet_end": "23:59", "time_zone": "UTC"})
    to_ida = {"kind": "users", "user_ids": [ids["+4522222222"]]}
    await send(admin, auth, body(audience=to_ida))
    await jobs.run_pending()
    row = owner_conn.execute("select status, held_until is not null from message_deliveries where channel = 'sms'").fetchone()
    assert row == ("held", True)
    await send(admin, auth, body(audience=to_ida, title="Haster", urgent=True))
    await jobs.run_pending()
    statuses = owner_conn.execute("select status from message_deliveries where channel = 'sms' order by id").fetchall()
    assert statuses == [("held",), ("sent",)]


async def test_duplicates_and_the_hourly_cap(make_client, owner_conn):
    admin, auth, ida, ole, per, ids = await setup(make_client, owner_conn)
    to_ida = {"kind": "users", "user_ids": [ids["+4522222222"]]}
    first = await send(admin, auth, body(audience=to_ida))
    await jobs.run_pending()
    # The same SMS again to the same number within the window (a second delivery of the same broadcast): a duplicate.
    owner_conn.execute("""insert into message_deliveries (broadcast_id, user_id, channel, status)
                          values (%s, %s, 'sms', 'queued')""", (first["id"], ids["+4522222222"]))
    did = owner_conn.execute("select max(id) from message_deliveries").fetchone()[0]
    owner_conn.execute("insert into jobs (kind, payload) values ('messages.sms', %s)", (f'{{"delivery_id": {did}}}',))
    await jobs.run_pending()
    assert owner_conn.execute("select status from message_deliveries where id = %s", (did,)).fetchone()[0] == "duplicate"

    await admin.put("/api/admin/messages/settings", json={"sms_max_per_hour": 1})
    await send(admin, auth, body(audience=to_ida, title="Ny besked"))
    await jobs.run_pending()
    assert owner_conn.execute("select status from sms_messages order by id").fetchall() == [
        ("sent",), ("duplicate",), ("throttled",)]


async def test_replies_are_a_private_thread(make_client, owner_conn):
    admin, auth, ida, ole, per, ids = await setup(make_client, owner_conn)
    to_both = {"kind": "users", "user_ids": [ids["+4522222222"], ids["+4544444444"]]}
    bid = (await send(admin, auth, body(audience=to_both)))["id"]
    await jobs.run_pending()

    r = await per.post(f"/api/messages/inbox/{bid}/reply", json={"body": "Gælder det også mobilappen?"})
    assert r.status_code == 200, r.text
    conv = r.json()["conversation_id"]
    # Ida sees nothing of Per's thread.
    assert (await ida.get(f"/api/messages/inbox/{bid}")).json()["thread"] == []

    threads = (await admin.get("/api/admin/messages/replies")).json()
    assert threads["unanswered"] == 1 and threads["items"][0]["last_body"] == "Gælder det også mobilappen?"
    r = await admin.post(f"/api/admin/messages/replies/{conv}", json={"body": "Ja, også mobilappen."})
    assert r.status_code == 200 and r.json()["channel"] is None  # Per has no yes to SMS and no e-mail: in the app only
    assert (await admin.get("/api/admin/messages/replies")).json()["unanswered"] == 0

    assert (await per.get("/api/messages/unread")).json() == {"total": 1}  # the answer (replying read the broadcast)
    thread = (await per.get(f"/api/messages/inbox/{bid}")).json()["thread"]
    assert [(m["author"], m["body"]) for m in thread] == [(None, "Gælder det også mobilappen?"),
                                                           ("Administrationen", "Ja, også mobilappen.")]
    await per.post(f"/api/messages/inbox/{bid}/read")
    assert (await per.get("/api/messages/unread")).json() == {"total": 0}

    # Ida replies and has said yes to SMS: the admin's answer reaches her by SMS too.
    conv_ida = (await ida.post(f"/api/messages/inbox/{bid}/reply", json={"body": "Tak!"})).json()["conversation_id"]
    r = await admin.post(f"/api/admin/messages/replies/{conv_ida}", json={"body": "Selv tak."})
    assert r.json()["channel"] == "sms"
    await jobs.run_pending()
    last = owner_conn.execute("select body from sms_messages order by id desc limit 1").fetchone()[0]
    assert "Svar på »Vedligehold lørdag«" in last and "Selv tak." in last

    # Closing; a new reply from the user opens it again.
    assert (await admin.post(f"/api/admin/messages/replies/{conv}/close")).status_code == 200
    assert (await admin.get("/api/admin/messages/replies?state=closed")).json()["items"][0]["id"] == conv
    await per.post(f"/api/messages/inbox/{bid}/reply", json={"body": "En ting mere"})
    assert (await admin.get(f"/api/admin/messages/replies/{conv}")).json()["closed_at"] is None
    actions = [r[0] for r in owner_conn.execute("select action from audit_log where action like 'messages.reply%%' order by id")]
    assert actions == ["messages.reply"] * 4 + ["messages.reply.close", "messages.reply"]

    # Replies switched off for a broadcast.
    bid2 = (await send(admin, auth, body(audience=to_both, title="Kun til orientering", allow_replies=False)))["id"]
    await jobs.run_pending()
    assert (await per.post(f"/api/messages/inbox/{bid2}/reply", json={"body": "hej"})).status_code == 409


async def test_admin_roles_split_the_sections(make_client, owner_conn):
    admin, auth, ida, ole, per, ids = await setup(make_client, owner_conn)
    owner_conn.execute("""insert into users (phone, display_name, role, admin_roles)
                          values ('+4577777777', 'Drift', 'admin', '{drift}')""")
    ops = make_client()
    await otp_login(ops, "77777777")
    assert (await ops.get("/api/admin/messages/deliveries")).status_code == 200
    assert (await ops.get("/api/admin/messages/settings")).status_code == 200
    assert (await ops.get("/api/admin/messages/overview")).status_code == 200
    assert (await ops.post("/api/admin/messages/broadcast", json=body())).status_code == 403
    assert (await ops.get("/api/admin/messages/replies")).status_code == 403
    me = (await ops.get("/api/auth/me")).json()["user"]
    assert {"/messages", "/messages/delivery", "/messages/settings"} <= set(me["admin_sections"])
    assert "/messages/send" not in me["admin_sections"]
    # Plain users get nothing under /api/admin/messages.
    assert (await per.get("/api/admin/messages/overview")).status_code == 403


async def test_deliveries_mask_contacts(make_client, owner_conn):
    admin, auth, ida, ole, per, ids = await setup(make_client, owner_conn)
    await send(admin, auth, body(audience={"kind": "users", "user_ids": [ids["+4522222222"], ids["ole@example.dk"]]}))
    await jobs.run_pending()
    items = (await admin.get("/api/admin/messages/deliveries?channel=sms")).json()["items"]
    assert [i["to"] for i in items] == ["+45 •••• ••22"]
    items = (await admin.get("/api/admin/messages/deliveries?channel=mail")).json()["items"]
    assert [(i["to"], i["status"]) for i in items] == [("o•••@example.dk", "sent")]
    summary = (await admin.get("/api/admin/messages/deliveries")).json()["summary"]
    assert summary["ok"] == 4 and summary["failed"] == 0


async def test_gdpr_export_and_erasure(make_client, owner_conn):
    admin, auth, ida, ole, per, ids = await setup(make_client, owner_conn)
    bid = (await send(admin, auth, body(audience={"kind": "users", "user_ids": [ids["+4522222222"]]})))["id"]
    await jobs.run_pending()
    await ida.post(f"/api/messages/inbox/{bid}/reply", json={"body": "Tak"})
    from app import gdpr
    from app import db
    async with db.connection() as conn:
        data = await gdpr.build_user_export(conn, ids["+4522222222"])
    assert data["messages_inbox"][0]["title"] == "Vedligehold lørdag"
    assert data["messages_replies"][0]["body"] == "Tak"
    assert data["notification_prefs"][0]["sms"] is True
    assert data["sms_messages"][0]["to_phone"] == "+4522222222"

    r = await ida.post("/api/me/delete", json={"confirm_phone": "22222222"})
    assert r.status_code == 200, r.text
    for table in ("message_deliveries", "notification_prefs", "sms_messages", "conversations", "conversation_messages"):
        assert owner_conn.execute(f"select count(*) from {table}").fetchone()[0] == 0, table
    # The broadcast itself stays, sent by the admin.
    assert owner_conn.execute("select count(*) from message_broadcasts").fetchone()[0] == 1
