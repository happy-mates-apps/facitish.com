"""/api/messages — the user's side of Beskeder (specs/beskeder): the inbox, replies to a broadcast, and how they want
to be told. SMS messages need a yes of their own: a phone number used for login is not consent."""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app import db, events
from app.logs import audit, changed
from app.messages import service
from app.sessions import Principal, current_user

router = APIRouter(prefix="/api/messages", tags=["messages"])


async def _inbox_row(conn, broadcast_id: int, user_id: int) -> dict:
    row = await db.fetch_one(conn, """
        select d.id as delivery_id, d.read_at, d.delivered_at, b.id, b.title, b.body, b.allow_replies, b.sent_at,
               b.created_at
        from message_deliveries d join message_broadcasts b on b.id = d.broadcast_id
        where d.channel = 'app' and d.broadcast_id = %s and d.user_id = %s""", (broadcast_id, user_id))
    if row is None:
        raise HTTPException(404, "Beskeden findes ikke")
    return row


@router.get("/inbox")
async def inbox(limit: int = Query(100, ge=1, le=500), p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        rows = await db.fetch_all(conn, """
            select b.id, b.title, left(b.body, 200) as excerpt, b.allow_replies, d.delivered_at, d.read_at,
                   c.id as conversation_id, c.closed_at,
                   (select count(*) from conversation_messages m where m.conversation_id = c.id
                     and m.from_admin and m.read_at is null) as unread_replies,
                   (select count(*) from conversation_messages m where m.conversation_id = c.id) as thread_length
            from message_deliveries d join message_broadcasts b on b.id = d.broadcast_id
            left join conversations c on c.broadcast_id = b.id and c.user_id = d.user_id
            where d.channel = 'app' and d.user_id = %s
            order by coalesce(c.last_message_at, d.delivered_at) desc limit %s""", (p.user_id, limit))
    return {"items": [{**r, "unread": r["read_at"] is None or r["unread_replies"] > 0} for r in rows]}


@router.get("/unread")
async def unread(p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        row = await db.fetch_one(conn, """
            select (select count(*) from message_deliveries where channel = 'app' and user_id = %s and read_at is null)
                 + (select count(*) from conversation_messages m join conversations c on c.id = m.conversation_id
                     where c.user_id = %s and m.from_admin and m.read_at is null) as total""", (p.user_id, p.user_id))
    return {"total": row["total"]}


@router.get("/inbox/{broadcast_id}")
async def message(broadcast_id: int, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        row = await _inbox_row(conn, broadcast_id, p.user_id)
        conv = await service.thread(conn, broadcast_id, p.user_id)
        msgs = []
        if conv:
            msgs = await db.fetch_all(conn, """
                select id, case when from_admin then 'Administrationen' else author_name end as author,
                       case when from_admin then author_name end as admin_name, from_admin, body, created_at
                from conversation_messages where conversation_id = %s order by created_at, id""", (conv["id"],))
    return {**{k: row[k] for k in ("id", "title", "body", "allow_replies", "delivered_at", "read_at")},
            "thread": msgs, "closed": bool(conv and conv["closed_at"])}


@router.post("/inbox/{broadcast_id}/read")
async def mark_read(broadcast_id: int, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        row = await _inbox_row(conn, broadcast_id, p.user_id)
        await conn.execute("update message_deliveries set read_at = coalesce(read_at, now()), status = 'read' where id = %s",
                           (row["delivery_id"],))
        await conn.execute("""update conversation_messages m set read_at = now() from conversations c
                              where c.id = m.conversation_id and c.broadcast_id = %s and c.user_id = %s
                              and m.from_admin and m.read_at is null""", (broadcast_id, p.user_id))
    return {"ok": True}


class ReplyIn(BaseModel):
    body: str = Field(min_length=1, max_length=4000)


@router.post("/inbox/{broadcast_id}/reply")
async def reply(broadcast_id: int, body: ReplyIn, p: Principal = Depends(current_user)):
    text_ = body.body.strip()
    if not text_:
        raise HTTPException(400, "Skriv et svar")
    async with db.connection() as conn:
        row = await _inbox_row(conn, broadcast_id, p.user_id)
        if not row["allow_replies"]:
            raise HTTPException(409, "Der kan ikke svares på denne besked")
        result = await service.user_reply(conn, broadcast_id=broadcast_id, user_id=p.user_id,
                                          author_name=p.display_name, body=text_)
        await conn.execute("update message_deliveries set read_at = coalesce(read_at, now()), status = 'read' where id = %s",
                           (row["delivery_id"],))
        await audit(conn, "messages.reply", actor_id=p.user_id, meta=p.meta, table="conversation_messages",
                    row_id=result["message_id"], conversation_id=result["conversation_id"], from_admin=False,
                    length=len(text_))
    await events.emit("messages.reply", ref=str(broadcast_id))
    return {"ok": True, **result}


# ── How the user wants to be told ───────────────────────────────────────────

async def _prefs(conn, user_id: int) -> dict:
    row = await db.fetch_one(conn, """
        select u.phone, u.email, coalesce(p.sms, false) as sms, p.sms_consent_at, coalesce(p.mail, true) as mail
        from users u left join notification_prefs p on p.user_id = u.id where u.id = %s""", (user_id,))
    s = await service.get_settings(conn)
    return {"sms": row["sms"], "sms_consent_at": row["sms_consent_at"], "mail": row["mail"],
            "has_phone": bool(row["phone"]), "has_email": bool(row["email"]),
            "sms_available": bool(s["sms_enabled"]), "mail_available": bool(s["mail_enabled"])}


@router.get("/prefs")
async def get_prefs(p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        return await _prefs(conn, p.user_id)


class PrefsIn(BaseModel):
    sms: bool | None = None
    mail: bool | None = None


@router.put("/prefs")
async def put_prefs(body: PrefsIn, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        before = await _prefs(conn, p.user_id)
        if body.sms and not before["has_phone"]:
            raise HTTPException(400, "Tilføj et telefonnummer under Konto først")
        new = {"sms": before["sms"] if body.sms is None else body.sms,
               "mail": before["mail"] if body.mail is None else body.mail}
        await conn.execute("""
            insert into notification_prefs (user_id, sms, sms_consent_at, mail)
            values (%(u)s, %(sms)s, case when %(sms)s then now() end, %(mail)s)
            on conflict (user_id) do update set
                sms = excluded.sms, mail = excluded.mail, updated_at = now(),
                sms_consent_at = case when excluded.sms and not notification_prefs.sms then now()
                                      when excluded.sms then notification_prefs.sms_consent_at end""",
                           {"u": p.user_id, **new})
        b, a = changed({"sms": before["sms"], "mail": before["mail"]}, new)
        if a:
            await audit(conn, "messages.prefs", actor_id=p.user_id, meta=p.meta, table="notification_prefs",
                        row_id=p.user_id, before=b, after=a)
        return await _prefs(conn, p.user_id)
