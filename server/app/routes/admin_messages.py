"""/api/admin/messages — Beskeder in /admin (specs/beskeder). Each sub-path belongs to its own /admin section, so the
admin roles can split the work: Beskeder, Send besked and Svar (Support), Levering and Kanaler og regler (Drift).

Reads are logged by require_admin (admin.read). A broadcast is sent in two steps: the first call returns the estimate
and a confirmation token, the second (with the token) sends; a token sends once (409). A broadcast to everyone needs
a fresh second factor.
"""

from datetime import datetime, timedelta, timezone
from typing import Literal

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator, model_validator

from app import config, db, mfa, settings_store
from app.logs import audit, changed
from app.messages import service
from app.messages.service import who
from app.messages import tasks as _tasks  # noqa: F401  (registers the messages.* jobs)
from app.security import mask_contact, mask_phone
from app.sessions import Principal, require_admin

router = APIRouter(prefix="/api/admin/messages", tags=["admin"], dependencies=[Depends(require_admin)])


class Audience(BaseModel):
    kind: Literal["all", "admins", "ring", "inactive", "users"]
    ring: int | None = Field(default=None, ge=1, le=3)
    days: int | None = Field(default=None, ge=1, le=3650)
    user_ids: list[int] | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def _complete(self):
        if self.kind == "ring" and self.ring is None:
            raise ValueError("Vælg en ring")
        if self.kind == "inactive" and self.days is None:
            raise ValueError("Angiv antal dage")
        if self.kind == "users" and not self.user_ids:
            raise ValueError("Vælg mindst én bruger")
        return self

    def as_dict(self) -> dict:
        d: dict = {"kind": self.kind}
        if self.kind == "ring":
            d["ring"] = self.ring
        elif self.kind == "inactive":
            d["days"] = self.days
        elif self.kind == "users":
            d["user_ids"] = sorted(set(self.user_ids or []))
        return d


Channel = Literal["sms", "mail"]


class EstimateIn(BaseModel):
    audience: Audience
    channels: list[Channel] = Field(default_factory=lambda: ["sms", "mail"], max_length=2)
    title: str = Field(default="", max_length=120)
    body: str = Field(default="", max_length=1000)


class BroadcastIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=1000)
    audience: Audience
    channels: list[Channel] = Field(default_factory=lambda: ["sms", "mail"], max_length=2)
    urgent: bool = False
    allow_replies: bool = True
    send_at: datetime | None = None
    confirmation_token: str | None = Field(default=None, max_length=200)

    @field_validator("title", "body")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Må ikke være tom")
        return v

    @field_validator("send_at")
    @classmethod
    def _future(cls, v: datetime | None) -> datetime | None:
        if v is None:
            return None
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        if v > datetime.now(timezone.utc) + timedelta(days=60):
            raise ValueError("Højst 60 dage frem")
        return v if v > datetime.now(timezone.utc) else None

    def fields(self) -> dict:
        return {"title": self.title, "body": self.body, "audience": self.audience.as_dict(),
                "channels": sorted(set(self.channels)), "urgent": self.urgent, "allow_replies": self.allow_replies,
                "send_at": self.send_at.isoformat() if self.send_at else None}


# ── Beskeder (overview) ─────────────────────────────────────────────────────

def _log_row(r: dict) -> dict:
    return {"id": r["id"], "title": r["title"], "body": r["body"], "audience_label": r["audience_label"],
            "channels": r["channels"], "urgent": r["urgent"], "allow_replies": r["allow_replies"], "status": r["status"],
            "total": r["total"], "sms": r["sms"], "mail": r["mail"], "app_only": r["app_only"],
            "price_minor": r["price_minor"], "segments": r["segments"],
            "actor_name": who({"display_name": r["actor_name"], "email": r["actor_email"], "phone": r["actor_phone"]})
            if r.get("actor_id") else None,
            "replies": r.get("replies", 0), "unread_in_app": r.get("unread_in_app", 0),
            "send_at": r["send_at"], "sent_at": r["sent_at"], "created_at": r["created_at"]}


_LOG_SQL = """
    select b.*, a.display_name as actor_name, a.email as actor_email, a.phone as actor_phone,
           (select count(*) from conversations c where c.broadcast_id = b.id) as replies,
           (select count(*) from message_deliveries d where d.broadcast_id = b.id and d.channel = 'app'
                                                      and d.read_at is null) as unread_in_app
    from message_broadcasts b left join users a on a.id = b.actor_id"""


@router.get("/overview")
async def overview():
    async with db.connection() as conn:
        counts = await db.fetch_one(conn, """
            select (select count(*) from message_broadcasts where created_at > now() - interval '30 days') as broadcasts,
                   (select count(*) from message_broadcasts where status = 'scheduled') as scheduled,
                   (select count(distinct user_id) from message_deliveries
                     where channel = 'app' and created_at > now() - interval '30 days') as reached,
                   (select coalesce(sum(segments), 0) from sms_messages
                     where status in ('sent', 'delivered') and created_at >= date_trunc('month', now())) as sms_segments,
                   (select count(*) from sms_messages
                     where status = 'failed' and created_at > now() - interval '24 hours') as sms_failed,
                   (select count(*) from message_deliveries where status = 'held') as held,
                   (select count(*) from conversations where closed_at is null and not last_from_admin) as open_replies""")
        split = await db.fetch_one(conn, """
            select count(*) filter (where channel = 'sms') as sms, count(*) filter (where channel = 'mail') as mail,
                   count(*) filter (where channel = 'push') as push,
                   (select count(*) from message_deliveries a where a.channel = 'app' and a.reason = 'broadcast'
                      and a.created_at > now() - interval '30 days') as app
            from message_deliveries where channel <> 'app' and reason = 'broadcast'
              and created_at > now() - interval '30 days'""")
        recent = await db.fetch_all(conn, _LOG_SQL + " order by b.created_at desc limit 5", ())
        s = await service.get_settings(conn)
    app_only = max(0, split["app"] - split["sms"] - split["mail"] - split["push"])
    return {**counts, "sms_cost_minor": counts["sms_segments"] * int(s["sms_price_minor"]),
            "split": {"push": split["push"], "sms": split["sms"], "mail": split["mail"], "app_only": app_only},
            "recent": [_log_row(r) for r in recent]}


# ── Send besked ─────────────────────────────────────────────────────────────

@router.get("/broadcast/audiences")
async def audiences():
    async with db.connection() as conn:
        return {"items": await service.audience_options(conn), "settings": _public_settings(await service.get_settings(conn))}


@router.post("/broadcast/estimate")
async def estimate(body: EstimateIn):
    async with db.connection() as conn:
        return await service.estimate(conn, body.audience.as_dict(), list(body.channels), body.title, body.body)


@router.post("/broadcast")
async def broadcast(body: BroadcastIn, admin: Principal = Depends(require_admin)):
    fields = body.fields()
    dig = service.digest(fields)
    async with db.connection() as conn:
        est = await service.estimate(conn, fields["audience"], fields["channels"], body.title, body.body)
        if est["total"] == 0:
            raise HTTPException(400, "Ingen modtagere i den gruppe")
        if not body.confirmation_token:
            return {"proposal": {"estimate": est, "fields": fields},
                    "confirmation_token": service.propose_token(admin.user_id, dig),
                    "expires_in": service.TOKEN_SECONDS}
        why = service.check_token(body.confirmation_token, admin.user_id, dig)
        if why == "expired":
            raise HTTPException(409, "Bekræftelsen er udløbet. Tjek overslaget igen.")
        if why:
            raise HTTPException(409, "Beskeden eller modtagerne er ændret siden overslaget. Tjek det igen.")
        if fields["audience"]["kind"] == "all" and not mfa.within(admin.mfa_at, timedelta(minutes=config.settings.stepup_minutes)):
            raise mfa.mfa_error("stepup_required", "Bekræft med din passkey, sikkerhedsnøgle eller godkendelsesapp først")
        h = service.token_hash(body.confirmation_token)
        if await db.fetch_one(conn, "select 1 from message_broadcasts where confirmation_hash = %s", (h,)):
            raise HTTPException(409, "Beskeden er allerede sendt")
        try:
            row = await service.create_broadcast(
                conn, title=body.title, body=body.body, audience=fields["audience"], channels=fields["channels"],
                urgent=body.urgent, allow_replies=body.allow_replies, send_at=body.send_at, est=est,
                actor_id=admin.user_id, confirmation_hash=h)
        except psycopg.errors.UniqueViolation:
            raise HTTPException(409, "Beskeden er allerede sendt")
        await audit(conn, "messages.broadcast.send", actor_id=admin.user_id, meta=admin.meta, table="message_broadcasts",
                    row_id=row["id"], audience=fields["audience"], label=est["label"], channels=fields["channels"],
                    urgent=body.urgent, allow_replies=body.allow_replies, total=est["total"], sms=est["sms"],
                    mail=est["mail"], title_length=len(body.title), body_length=len(body.body),
                    send_at=fields["send_at"])
    return {"sent": True, "id": row["id"], "status": row["status"], "estimate": est}


class TestIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=1000)
    channels: list[Channel] = Field(default_factory=lambda: ["sms", "mail"], max_length=2)


@router.post("/broadcast/test")
async def broadcast_test(body: TestIn, admin: Principal = Depends(require_admin)):
    """Sends the message to the admin alone, through the same channels, so they see how it looks."""
    audience = {"kind": "users", "user_ids": [admin.user_id]}
    async with db.connection() as conn:
        est = await service.estimate(conn, audience, list(body.channels), body.title, body.body)
        est["label"] = "Prøve til mig selv"
        row = await service.create_broadcast(conn, title=body.title.strip(), body=body.body.strip(), audience=audience,
                                             channels=sorted(set(body.channels)), urgent=True, allow_replies=False,
                                             send_at=None, est=est, actor_id=admin.user_id, confirmation_hash=None)
        await audit(conn, "messages.broadcast.test", actor_id=admin.user_id, meta=admin.meta, table="message_broadcasts",
                    row_id=row["id"], channels=body.channels)
    return {"sent": True, "id": row["id"], "estimate": est}


@router.get("/broadcast/log")
async def broadcast_log(limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)):
    async with db.connection() as conn:
        rows = await db.fetch_all(conn, _LOG_SQL + " order by b.created_at desc limit %s offset %s", (limit, offset))
        total = (await db.fetch_one(conn, "select count(*) as n from message_broadcasts"))["n"]
    return {"items": [_log_row(r) for r in rows], "total": total}


# ── Svar ────────────────────────────────────────────────────────────────────

@router.get("/replies")
async def replies(state: Literal["open", "all", "closed"] = "open", broadcast: int | None = None,
                  limit: int = Query(100, ge=1, le=500)):
    where = ["true"]
    params: list = []
    if state == "open":
        where.append("c.closed_at is null")
    elif state == "closed":
        where.append("c.closed_at is not null")
    if broadcast:
        where.append("c.broadcast_id = %s")
        params.append(broadcast)
    async with db.connection() as conn:
        rows = await db.fetch_all(conn, f"""
            select c.id, c.broadcast_id, c.user_id, c.last_message_at, c.last_from_admin, c.closed_at,
                   u.display_name, u.email, u.phone, b.title as broadcast_title,
                   (select m.body from conversation_messages m where m.conversation_id = c.id
                     order by m.created_at desc, m.id desc limit 1) as last_body
            from conversations c join users u on u.id = c.user_id join message_broadcasts b on b.id = c.broadcast_id
            where c.kind = 'reply' and {' and '.join(where)}
            order by (c.closed_at is null and not c.last_from_admin) desc, c.last_message_at desc
            limit %s""", (*params, limit))
        unanswered = (await db.fetch_one(conn, """select count(*) as n from conversations
                                                  where closed_at is null and not last_from_admin"""))["n"]
    return {"items": [{**{k: v for k, v in r.items() if k not in ("email", "phone")}, "display_name": who(r),
                       "unanswered": r["closed_at"] is None and not r["last_from_admin"]} for r in rows],
            "unanswered": unanswered}


async def _conversation(conn, conversation_id: int, lock: bool = False) -> dict:
    conv = await db.fetch_one(conn, "select * from conversations where id = %s and kind = 'reply'"
                                    + (" for update" if lock else ""), (conversation_id,))
    if conv is None:
        raise HTTPException(404, "Tråden findes ikke")
    return conv


@router.get("/replies/{conversation_id}")
async def reply_thread(conversation_id: int):
    async with db.connection() as conn:
        conv = await _conversation(conn, conversation_id)
        user = await db.fetch_one(conn, """
            select u.id, u.display_name, u.phone, u.email, coalesce(p.sms, false) as sms_ok, coalesce(p.mail, true) as mail_ok
            from users u left join notification_prefs p on p.user_id = u.id where u.id = %s""", (conv["user_id"],))
        b = await db.fetch_one(conn, "select id, title, body, channels, sent_at, created_at from message_broadcasts where id = %s",
                               (conv["broadcast_id"],))
        msgs = await db.fetch_all(conn, """select id, author_name, from_admin, body, created_at, read_at
                                           from conversation_messages where conversation_id = %s
                                           order by created_at, id""", (conversation_id,))
        s = await service.get_settings(conn)
    channel = service.channel_for(user, list(b["channels"]), s)
    return {"id": conv["id"], "closed_at": conv["closed_at"],
            "user": {"id": user["id"], "display_name": who(user)},
            "notify_by": channel or "app", "broadcast": b, "messages": msgs}


class ReplyIn(BaseModel):
    body: str = Field(min_length=1, max_length=4000)


@router.post("/replies/{conversation_id}")
async def answer(conversation_id: int, body: ReplyIn, admin: Principal = Depends(require_admin)):
    text_ = body.body.strip()
    if not text_:
        raise HTTPException(400, "Skriv et svar")
    async with db.connection() as conn:
        conv = await _conversation(conn, conversation_id, lock=True)
        result = await service.admin_reply(conn, conv, admin_id=admin.user_id, admin_name=admin.display_name, body=text_)
        await conn.execute("""update conversation_messages set read_at = now()
                              where conversation_id = %s and not from_admin and read_at is null""", (conversation_id,))
        await audit(conn, "messages.reply", actor_id=admin.user_id, meta=admin.meta, table="conversation_messages",
                    row_id=result["message_id"], conversation_id=conversation_id, from_admin=True, length=len(text_),
                    notify_by=result["channel"] or "app")
    return {"ok": True, **result}


@router.post("/replies/{conversation_id}/close")
async def close(conversation_id: int, admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        conv = await _conversation(conn, conversation_id, lock=True)
        if conv["closed_at"] is None:
            await conn.execute("update conversations set closed_at = now(), closed_by = %s where id = %s",
                               (admin.user_id, conversation_id))
            await audit(conn, "messages.reply.close", actor_id=admin.user_id, meta=admin.meta, table="conversations",
                        row_id=conversation_id)
    return {"ok": True}


# ── Levering ────────────────────────────────────────────────────────────────

@router.get("/deliveries")
async def deliveries(channel: Literal["app", "push", "sms", "mail"] | None = None,
                     status: str | None = Query(None, max_length=20), broadcast: int | None = None,
                     q: str | None = Query(None, max_length=100), limit: int = Query(100, ge=1, le=500),
                     offset: int = Query(0, ge=0)):
    where = ["true"]
    params: list = []
    if channel:
        where.append("d.channel = %s")
        params.append(channel)
    if status:
        where.append("d.status = %s")
        params.append(status)
    if broadcast:
        where.append("d.broadcast_id = %s")
        params.append(broadcast)
    if q:
        where.append("(u.display_name ilike %s or b.title ilike %s)")
        params += [f"%{q}%", f"%{q}%"]
    sql_where = " and ".join(where)
    async with db.connection() as conn:
        rows = await db.fetch_all(conn, f"""
            select d.id, d.broadcast_id, d.user_id, d.channel, d.status, d.reason, d.error, d.held_until, d.cost_minor,
                   d.created_at, d.sent_at, d.delivered_at, d.read_at, b.title, u.display_name, u.phone, u.email,
                   s.segments
            from message_deliveries d join message_broadcasts b on b.id = d.broadcast_id
            join users u on u.id = d.user_id left join sms_messages s on s.id = d.sms_id
            where {sql_where} order by d.created_at desc, d.id desc limit %s offset %s""", (*params, limit, offset))
        total = (await db.fetch_one(conn, f"""select count(*) as n from message_deliveries d
                                              join message_broadcasts b on b.id = d.broadcast_id
                                              join users u on u.id = d.user_id where {sql_where}""", params))["n"]
        summary = await db.fetch_one(conn, """
            select count(*) filter (where status in ('sent', 'delivered', 'read')) as ok,
                   count(*) filter (where status = 'held') as held,
                   count(*) filter (where status = 'failed') as failed,
                   count(*) as all_rows,
                   (select coalesce(sum(segments), 0) from sms_messages
                     where status in ('sent', 'delivered') and created_at > now() - interval '24 hours') as sms_segments
            from message_deliveries where created_at > now() - interval '24 hours'""")
    items = []
    for r in rows:
        to = None
        if r["channel"] == "sms":
            to = mask_phone(r["phone"])
        elif r["channel"] == "mail":
            to = mask_contact(r["email"])
        items.append({k: r[k] for k in ("id", "broadcast_id", "user_id", "channel", "status", "reason", "error",
                                         "held_until", "cost_minor", "created_at", "sent_at", "delivered_at", "read_at",
                                         "title", "segments")}
                     | {"display_name": who(r), "to": to})
    return {"items": items, "total": total, "summary": summary}


# ── Kanaler og regler ───────────────────────────────────────────────────────

def _public_settings(s: dict) -> dict:
    return {**s, "sms_provider": config.settings.sms_provider}


@router.get("/settings")
async def get_settings():
    async with db.connection() as conn:
        s = await service.get_settings(conn)
        sender = await settings_store.get(conn, "sms_sender")
    return {**_public_settings(s), "sms_sender": sender}


TIME = r"^([01]\d|2[0-3]):[0-5]\d$"


class SettingsIn(BaseModel):
    sms_enabled: bool | None = None
    mail_enabled: bool | None = None
    sms_price_minor: int | None = Field(default=None, ge=0, le=10000)
    quiet_start: str | None = Field(default=None, pattern=TIME)
    quiet_end: str | None = Field(default=None, pattern=TIME)
    time_zone: str | None = Field(default=None, max_length=64)
    sms_max_per_hour: int | None = Field(default=None, ge=1, le=100000)
    duplicate_seconds: int | None = Field(default=None, ge=0, le=3600)
    inactive_days: int | None = Field(default=None, ge=1, le=3650)


@router.put("/settings")
async def put_settings(body: SettingsIn, admin: Principal = Depends(require_admin)):
    values = body.model_dump(exclude_unset=True, exclude_none=True)
    if "time_zone" in values:
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
        try:
            ZoneInfo(values["time_zone"])
        except (ZoneInfoNotFoundError, ValueError):
            raise HTTPException(400, "Ukendt tidszone")
    async with db.connection() as conn:
        stored = await settings_store.get(conn, "messages") or {}
        before = await service.get_settings(conn)
        await settings_store.set_many(conn, {"messages": {**stored, **values}})
        b, a = changed(before, values)
        if a:
            await audit(conn, "messages.settings", actor_id=admin.user_id, meta=admin.meta, table="settings",
                        row_id="messages", before=b, after=a)
        s = await service.get_settings(conn)
    return _public_settings(s)
