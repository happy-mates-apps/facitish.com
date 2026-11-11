"""Beskeder, phase 1 (specs/beskeder/): broadcasts from the administration, the in-app inbox and reply threads.

    estimate(conn, audience, channels, title, body)       who gets what, before anything is sent
    propose_token / check_token                            the two-step confirmation (after member-chat's broadcast)
    create_broadcast(conn, …)                              stores it and enqueues messages.deliver
    deliver(broadcast_id)                                  fan-out: one app row per recipient, plus SMS or e-mail
    add_reply / admin_reply                                the private thread between a recipient and the admins

Channel per recipient (phase 1, no push yet): SMS when the broadcast uses SMS, SMS is on, the user said yes to SMS
messages and has a phone; else e-mail when the broadcast uses e-mail, e-mail is on and the user has an address and
has not switched it off; else only in the app. Everyone gets the in-app copy.
"""

import hashlib
import hmac
import json
import time
from datetime import datetime, time as dtime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from psycopg.types.json import Jsonb

from app import config, db, jobs, settings_store, webhooks
from app.security import mask_contact
from app.messages import text as sms_text

CHANNELS = ("sms", "mail")          # app is always on; push is phase 3
TOKEN_SECONDS = 600

DEFAULTS: dict = {
    "sms_enabled": True,
    "mail_enabled": True,
    "sms_price_minor": 45,          # øre per SMS segment, for the estimate
    "quiet_start": "22:00",         # SMS waits in quiet hours unless the broadcast is urgent
    "quiet_end": "07:00",
    "time_zone": "Europe/Copenhagen",
    "sms_max_per_hour": 500,        # more than this in an hour is recorded as throttled
    "duplicate_seconds": 60,        # the same text to the same number within this is a duplicate
    "inactive_days": 30,            # the "Ikke logget ind" audience chip
}


def who(row: dict) -> str:
    """A person as /admin shows them here: their name, else their contact masked."""
    return row.get("display_name") or mask_contact(row.get("email") or row.get("phone")) or "Uden navn"


async def get_settings(conn) -> dict:
    return {**DEFAULTS, **(await settings_store.get(conn, "messages") or {})}


# ── Audiences ──────────────────────────────────────────────────────────────

RING_LABELS = {1: "Ring 1 · Internt", 2: "Ring 2 · Beta", 3: "Ring 3 · Preview"}


def _where(audience: dict) -> tuple[str, list]:
    kind = audience.get("kind")
    if kind == "all":
        return "", []
    if kind == "admins":
        return " and u.role = 'admin'", []
    if kind == "ring":
        return (" and coalesce((select fr.ring from feature_rings fr where fr.user_id = u.id), 4) <= %s",
                [int(audience["ring"])])
    if kind == "inactive":
        return (" and (u.last_login_at is null or u.last_login_at < now() - make_interval(days => %s))",
                [int(audience["days"])])
    if kind == "users":
        return " and u.id = any(%s)", [list(audience["user_ids"])]
    raise ValueError(f"unknown audience {kind!r}")


def audience_label(audience: dict, names: list[str] | None = None) -> str:
    kind = audience["kind"]
    if kind == "all":
        return "Alle brugere"
    if kind == "admins":
        return "Admins"
    if kind == "ring":
        return RING_LABELS.get(audience["ring"], f"Ring {audience['ring']}")
    if kind == "inactive":
        return f"Ikke logget ind i {audience['days']} dage"
    if names and len(names) <= 3:
        return ", ".join(names)
    n = len(audience["user_ids"])
    return "1 udvalgt bruger" if n == 1 else f"{n} udvalgte brugere"


async def recipients(conn, audience: dict) -> list[dict]:
    """Active users in the audience with what each can be reached on. Blocked users and test accounts never are."""
    where, params = _where(audience)
    return await db.fetch_all(conn, f"""
        select u.id, u.display_name, u.phone, u.email, coalesce(p.sms, false) as sms_ok, coalesce(p.mail, true) as mail_ok
        from users u left join notification_prefs p on p.user_id = u.id
        where u.blocked_at is null and not u.impersonation_only{where}
        order by u.id""", params)


def channel_for(user: dict, channels: list[str], s: dict) -> str | None:
    if "sms" in channels and s["sms_enabled"] and user["sms_ok"] and user["phone"]:
        return "sms"
    if "mail" in channels and s["mail_enabled"] and user["mail_ok"] and user["email"]:
        return "mail"
    return None


async def estimate(conn, audience: dict, channels: list[str], title: str = "", body: str = "") -> dict:
    s = await get_settings(conn)
    people = await recipients(conn, audience)
    counts = {"sms": 0, "mail": 0}
    for u in people:
        ch = channel_for(u, channels, s)
        if ch:
            counts[ch] += 1
    app_name = await settings_store.get(conn, "app_name")
    segs, enc = sms_text.segments(sms_text.broadcast_sms(app_name, title or "-", body or "-",
                                                         sms_text.preview_link(config.settings.origin)))
    names = [who(u) for u in people] if audience["kind"] == "users" else None
    return {"total": len(people), "push": 0, "sms": counts["sms"], "mail": counts["mail"],
            "app_only": len(people) - counts["sms"] - counts["mail"], "segments": segs, "encoding": enc,
            "price_minor": counts["sms"] * segs * int(s["sms_price_minor"]), "currency": "DKK",
            "label": audience_label(audience, names), "sms_enabled": s["sms_enabled"], "mail_enabled": s["mail_enabled"]}


async def audience_options(conn) -> list[dict]:
    s = await get_settings(conn)
    options = [{"kind": "all"}, {"kind": "admins"}, {"kind": "ring", "ring": 1}, {"kind": "ring", "ring": 2},
               {"kind": "inactive", "days": int(s["inactive_days"])}]
    out = []
    for a in options:
        where, params = _where(a)
        n = await db.fetch_one(conn, f"""select count(*) as n from users u
                                          where u.blocked_at is null and not u.impersonation_only{where}""", params)
        out.append({"audience": a, "label": audience_label(a), "count": n["n"]})
    return out


# ── Two-step confirmation ──────────────────────────────────────────────────

def digest(fields: dict) -> str:
    return hashlib.sha256(json.dumps(fields, sort_keys=True, default=str, ensure_ascii=False).encode()).hexdigest()


def _sign(admin_id: int, dig: str, expires: int) -> str:
    key = f"{config.settings.secret_key}:messages.broadcast".encode()
    return hmac.new(key, f"{admin_id}:{dig}:{expires}".encode(), hashlib.sha256).hexdigest()


def propose_token(admin_id: int, dig: str, now: float | None = None) -> str:
    expires = int((now or time.time()) + TOKEN_SECONDS)
    return f"{expires}.{_sign(admin_id, dig, expires)}"


def check_token(token: str, admin_id: int, dig: str, now: float | None = None) -> str | None:
    """None when the token is good; else why not ('expired' or 'mismatch')."""
    try:
        expires_s, sig = token.split(".", 1)
        expires = int(expires_s)
    except ValueError:
        return "mismatch"
    if not hmac.compare_digest(sig, _sign(admin_id, dig, expires)):
        return "mismatch"
    if expires < (now or time.time()):
        return "expired"
    return None


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# ── Sending ────────────────────────────────────────────────────────────────

async def create_broadcast(conn, *, title: str, body: str, audience: dict, channels: list[str], urgent: bool,
                           allow_replies: bool, send_at: datetime | None, est: dict, actor_id: int,
                           confirmation_hash: str | None) -> dict:
    delay = 0
    if send_at is not None:
        delay = max(0, int((send_at - datetime.now(timezone.utc)).total_seconds()))
    row = await db.fetch_one(conn, """
        insert into message_broadcasts (title, body, audience, audience_label, channels, urgent, allow_replies, total,
                                        push, sms, mail, app_only, segments, price_minor, status, actor_id,
                                        confirmation_hash, send_at)
        values (%s, %s, %s, %s, %s, %s, %s, %s, 0, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        returning id, status""",
        (title, body, Jsonb(audience), est["label"], channels, urgent, allow_replies, est["total"], est["sms"],
         est["mail"], est["app_only"], est["segments"], est["price_minor"], "scheduled" if delay else "sending",
         actor_id, confirmation_hash, send_at))
    await jobs.enqueue(conn, "messages.deliver", {"broadcast_id": row["id"]}, run_in_seconds=delay,
                       dedupe_key=f"messages.deliver:{row['id']}", max_attempts=5)
    return row


def quiet_delay(s: dict, now: datetime | None = None) -> int:
    """Seconds until quiet hours end, or 0 when it is not quiet now."""
    try:
        tz = ZoneInfo(s["time_zone"])
    except (ZoneInfoNotFoundError, ValueError):
        tz = ZoneInfo("Europe/Copenhagen")
    local = (now or datetime.now(timezone.utc)).astimezone(tz)
    start = dtime.fromisoformat(s["quiet_start"])
    end = dtime.fromisoformat(s["quiet_end"])
    t = local.time()
    quiet = (start <= t or t < end) if start > end else (start <= t < end)
    if not quiet or start == end:
        return 0
    end_dt = local.replace(hour=end.hour, minute=end.minute, second=0, microsecond=0)
    if end_dt <= local:
        end_dt += timedelta(days=1)
    return int((end_dt - local).total_seconds())


async def queue_channel(conn, *, broadcast_id: int, user_id: int, channel: str, urgent: bool, s: dict,
                        reason: str = "broadcast", reply_id: int | None = None) -> int:
    """One SMS or e-mail delivery and its job. A non-urgent SMS in quiet hours is held until they end."""
    hold = quiet_delay(s) if channel == "sms" and not urgent else 0
    row = await db.fetch_one(conn, """
        insert into message_deliveries (broadcast_id, user_id, channel, status, reason, reply_id, held_until)
        values (%s, %s, %s, %s, %s, %s, case when %s > 0 then now() + make_interval(secs => %s) end)
        returning id""", (broadcast_id, user_id, channel, "held" if hold else "queued", reason, reply_id, hold, hold))
    await jobs.enqueue(conn, f"messages.{channel}", {"delivery_id": row["id"]}, run_in_seconds=hold,
                       dedupe_key=f"messages.{channel}:{row['id']}", max_attempts=4)
    return row["id"]


async def deliver(broadcast_id: int) -> dict:
    """Fan-out of one broadcast at its send time. Idempotent: a broadcast already sent is skipped."""
    async with db.connection() as conn:
        b = await db.fetch_one(conn, "select * from message_broadcasts where id = %s for update", (broadcast_id,))
        if b is None:
            return {"skipped": "not found"}
        if b["status"] == "sent":
            return {"skipped": "already sent"}
        s = await get_settings(conn)
        people = await recipients(conn, b["audience"])
        counts = {"sms": 0, "mail": 0}
        for u in people:
            await conn.execute("""
                insert into message_deliveries (broadcast_id, user_id, channel, status, sent_at, delivered_at)
                values (%s, %s, 'app', 'delivered', now(), now()) on conflict do nothing""", (broadcast_id, u["id"]))
            ch = channel_for(u, b["channels"], s)
            if ch:
                counts[ch] += 1
                await queue_channel(conn, broadcast_id=broadcast_id, user_id=u["id"], channel=ch, urgent=b["urgent"], s=s)
        await conn.execute("""update message_broadcasts set status = 'sent', sent_at = now(), total = %s, sms = %s,
                                     mail = %s, app_only = %s where id = %s""",
                           (len(people), counts["sms"], counts["mail"], len(people) - counts["sms"] - counts["mail"],
                            broadcast_id))
        await webhooks.emit(conn, "message.broadcast.sent", {"broadcast_id": broadcast_id, "total": len(people)})
    from app import events
    await events.emit("messages.broadcast", ref=str(broadcast_id), value=len(people))
    return {"total": len(people), **counts}


# ── Replies ────────────────────────────────────────────────────────────────

async def thread(conn, broadcast_id: int, user_id: int) -> dict | None:
    return await db.fetch_one(conn, "select * from conversations where kind = 'reply' and broadcast_id = %s and user_id = %s",
                              (broadcast_id, user_id))


async def add_message(conn, conversation_id: int, *, author_id: int, author_name: str | None, from_admin: bool,
                      body: str) -> int:
    row = await db.fetch_one(conn, """
        insert into conversation_messages (conversation_id, author_id, author_name, from_admin, body)
        values (%s, %s, %s, %s, %s) returning id""", (conversation_id, author_id, author_name, from_admin, body))
    await conn.execute("""update conversations set last_message_at = now(), last_from_admin = %s,
                                 closed_at = case when %s then closed_at end,
                                 closed_by = case when %s then closed_by end
                          where id = %s""", (from_admin, from_admin, from_admin, conversation_id))
    return row["id"]


async def user_reply(conn, *, broadcast_id: int, user_id: int, author_name: str | None, body: str) -> dict:
    """The recipient answers a broadcast. Opens the thread, or reopens it if an admin had closed it."""
    conv = await thread(conn, broadcast_id, user_id)
    if conv is None:
        conv = await db.fetch_one(conn, """
            insert into conversations (kind, broadcast_id, user_id) values ('reply', %s, %s)
            on conflict (broadcast_id, user_id) do update set kind = excluded.kind returning *""", (broadcast_id, user_id))
    message_id = await add_message(conn, conv["id"], author_id=user_id, author_name=author_name, from_admin=False,
                                   body=body)
    await webhooks.emit(conn, "message.reply.created", {"conversation_id": conv["id"], "broadcast_id": broadcast_id})
    return {"conversation_id": conv["id"], "message_id": message_id}


async def admin_reply(conn, conv: dict, *, admin_id: int, admin_name: str | None, body: str) -> dict:
    """An admin answers in a thread. The user is told the same way as for a broadcast: always in the app (the thread
    shows it as unread), and by SMS or e-mail by the same rules, never in quiet hours."""
    message_id = await add_message(conn, conv["id"], author_id=admin_id, author_name=admin_name, from_admin=True,
                                   body=body)
    b = await db.fetch_one(conn, "select channels from message_broadcasts where id = %s", (conv["broadcast_id"],))
    s = await get_settings(conn)
    user = await db.fetch_one(conn, """
        select u.id, u.phone, u.email, coalesce(p.sms, false) as sms_ok, coalesce(p.mail, true) as mail_ok
        from users u left join notification_prefs p on p.user_id = u.id
        where u.id = %s and u.blocked_at is null""", (conv["user_id"],))
    channel = channel_for(user, list(b["channels"]) if b else [], s) if user else None
    if channel:
        await queue_channel(conn, broadcast_id=conv["broadcast_id"], user_id=conv["user_id"], channel=channel,
                            urgent=False, s=s, reason="reply", reply_id=message_id)
    return {"message_id": message_id, "channel": channel}
