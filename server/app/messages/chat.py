"""Beskeder, phase 2 (specs/beskeder/): conversations between users, reports, blocks, the word filter and moderation.
After happy-groups member-chat (service.ts, moderation.ts) without groups.

- The shared conversation ("Fællessamtalen") has every active user as a member; a member row (read state) appears on
  first read or post. Direct conversations are one per pair (pair_key = the two ids sorted) with two member rows.
- A block is the blocker's own: the blocked user's messages are hidden from them and no direct conversation passes
  between the two (either way). Admins see counts, never who blocked whom.
- A report reaches /admin → Moderering. A moderator sees the reported message and, while the report is open, the three
  before it (each look is audited); never the rest of a conversation. Removing a message keeps its text for the audit
  trail; users see only that it was removed.
- The word filter (setting messages.blocked_words, `*` matches anything) rejects a message before it is stored.
"""

import re

from fastapi import HTTPException

from app import db
from app.messages import service

INSTANCE_TITLE = "Fællessamtalen"
REASONS = {"harassment": "Chikane", "hate": "Hadefuld tale", "sexual": "Seksuelt indhold", "spam": "Spam", "other": "Andet"}
CONTEXT_BEFORE = 3


# ── Word filter ────────────────────────────────────────────────────────────

def _pattern(word: str) -> re.Pattern | None:
    word = word.strip().lower()
    if not word:
        return None
    body = ".*?".join(re.escape(part) for part in word.split("*"))
    return re.compile(rf"(?<!\w){body}(?!\w)", re.IGNORECASE)


def filtered(text: str, words: list[str]) -> bool:
    """True when the text contains one of the blocked words or patterns."""
    return any(p.search(text) for p in (_pattern(w) for w in words) if p)


async def check_text(conn, text: str) -> None:
    s = await service.get_settings(conn)
    if filtered(text, s.get("blocked_words") or []):
        from app import events
        await events.emit("messages.filtered")
        raise HTTPException(400, "Beskeden indeholder ord, der ikke er tilladt her. Ret den og prøv igen.")


# ── Who is who ─────────────────────────────────────────────────────────────

def name(display_name: str | None) -> str:
    return display_name or "Uden navn"


async def active_user(conn, user_id: int) -> dict | None:
    return await db.fetch_one(conn, """select id, display_name from users
                                       where id = %s and blocked_at is null and not impersonation_only""", (user_id,))


async def blocked_either_way(conn, a: int, b: int) -> bool:
    row = await db.fetch_one(conn, """select 1 from user_blocks where (blocker_id = %s and blocked_id = %s)
                                      or (blocker_id = %s and blocked_id = %s)""", (a, b, b, a))
    return row is not None


# ── Conversations ──────────────────────────────────────────────────────────

async def instance(conn) -> dict:
    row = await db.fetch_one(conn, "select * from conversations where kind = 'instance'")
    if row is None:
        row = await db.fetch_one(conn, """insert into conversations (kind, title) values ('instance', %s)
                                          on conflict (kind) where kind = 'instance' do update set title = conversations.title
                                          returning *""", (INSTANCE_TITLE,))
    return row


async def conversation_for(conn, conversation_id: int, user_id: int) -> dict:
    """The conversation if the user may read and post in it; 404 otherwise (also for reply threads)."""
    conv = await db.fetch_one(conn, "select * from conversations where id = %s and kind in ('instance', 'direct')",
                              (conversation_id,))
    if conv is None:
        raise HTTPException(404, "Samtalen findes ikke")
    if conv["kind"] == "direct":
        member = await db.fetch_one(conn, "select 1 from conversation_members where conversation_id = %s and user_id = %s",
                                    (conversation_id, user_id))
        if member is None:
            raise HTTPException(404, "Samtalen findes ikke")
        other = await _other(conn, conversation_id, user_id)
        if other and await blocked_either_way(conn, user_id, other["id"]):
            raise HTTPException(404, "Samtalen findes ikke")
    return conv


async def _other(conn, conversation_id: int, user_id: int) -> dict | None:
    return await db.fetch_one(conn, """select u.id, u.display_name from conversation_members m join users u on u.id = m.user_id
                                       where m.conversation_id = %s and m.user_id <> %s""", (conversation_id, user_id))


_UNREAD = """(select count(*) from conversation_messages x
              where x.conversation_id = c.id and x.removed_at is null and x.author_id is distinct from %(u)s
              and x.created_at > coalesce(m.last_read_at, m.joined_at, '-infinity')
              and not exists (select 1 from user_blocks b where b.blocker_id = %(u)s and b.blocked_id = x.author_id))"""


async def list_for(conn, user_id: int) -> list[dict]:
    """The shared conversation first, then the user's direct conversations by latest message."""
    inst = await instance(conn)
    rows = await db.fetch_all(conn, f"""
        select c.id, c.kind, c.title, c.last_message_at, {_UNREAD} as unread,
               o.id as other_id, o.display_name as other_name,
               (select x.body from conversation_messages x where x.conversation_id = c.id and x.removed_at is null
                  and not exists (select 1 from user_blocks b where b.blocker_id = %(u)s and b.blocked_id = x.author_id)
                order by x.created_at desc, x.id desc limit 1) as last_body
        from conversations c
        left join conversation_members m on m.conversation_id = c.id and m.user_id = %(u)s
        left join lateral (select u.id, u.display_name from conversation_members om join users u on u.id = om.user_id
                           where om.conversation_id = c.id and om.user_id <> %(u)s limit 1) o on c.kind = 'direct'
        where c.id = %(inst)s
           or (c.kind = 'direct' and m.user_id is not null
               and not exists (select 1 from user_blocks b where (b.blocker_id = %(u)s and b.blocked_id = o.id)
                                                              or (b.blocker_id = o.id and b.blocked_id = %(u)s)))
        order by (c.kind = 'instance') desc, c.last_message_at desc nulls last, c.id desc""",
        {"u": user_id, "inst": inst["id"]})
    return [{"id": r["id"], "kind": r["kind"],
             "title": r["title"] if r["kind"] == "instance" else name(r["other_name"]),
             "other_id": r["other_id"], "last_message_at": r["last_message_at"], "last_body": r["last_body"],
             "unread": r["unread"]} for r in rows]


async def unread_total(conn, user_id: int) -> int:
    return sum(c["unread"] for c in await list_for(conn, user_id))


async def messages(conn, conv: dict, user_id: int, *, before: int | None = None, limit: int = 50) -> list[dict]:
    """A page of messages, oldest first. Authors the user blocked are left out; removed ones carry no text."""
    rows = await db.fetch_all(conn, """
        select x.id, x.author_id, coalesce(u.display_name, x.author_name) as author_name, x.body, x.created_at,
               x.removed_at is not null as removed,
               exists (select 1 from message_reports r where r.message_id = x.id and r.reporter_id = %(u)s) as reported
        from conversation_messages x left join users u on u.id = x.author_id
        where x.conversation_id = %(c)s and (%(before)s::bigint is null or x.id < %(before)s)
          and not exists (select 1 from user_blocks b where b.blocker_id = %(u)s and b.blocked_id = x.author_id)
        order by x.id desc limit %(limit)s""", {"u": user_id, "c": conv["id"], "before": before, "limit": limit})
    rows.reverse()
    return [{"id": r["id"], "author_id": r["author_id"], "author_name": name(r["author_name"]) if r["author_id"] else "Slettet bruger",
             "mine": r["author_id"] == user_id, "body": None if r["removed"] else r["body"], "removed": r["removed"],
             "reported": r["reported"], "created_at": r["created_at"]} for r in rows]


async def mark_read(conn, conversation_id: int, user_id: int) -> None:
    await conn.execute("""insert into conversation_members (conversation_id, user_id, last_read_at) values (%s, %s, now())
                          on conflict (conversation_id, user_id) do update set last_read_at = now()""",
                       (conversation_id, user_id))


async def post(conn, conv: dict, *, user_id: int, author_name: str | None, body: str) -> int:
    await check_text(conn, body)
    message_id = await service.add_message(conn, conv["id"], author_id=user_id, author_name=author_name,
                                           from_admin=False, body=body)
    await mark_read(conn, conv["id"], user_id)
    return message_id


async def direct(conn, user_id: int, other_id: int) -> dict:
    """Get or create the direct conversation between two users."""
    if other_id == user_id:
        raise HTTPException(400, "Du kan ikke skrive til dig selv")
    other = await active_user(conn, other_id)
    if other is None:
        raise HTTPException(404, "Brugeren findes ikke")
    if await blocked_either_way(conn, user_id, other_id):
        raise HTTPException(409, "Du kan ikke skrive til denne bruger")
    pair = ":".join(str(i) for i in sorted((user_id, other_id)))
    conv = await db.fetch_one(conn, """insert into conversations (kind, pair_key) values ('direct', %s)
                                       on conflict (pair_key) do update set pair_key = excluded.pair_key returning *""", (pair,))
    for uid in (user_id, other_id):
        await conn.execute("""insert into conversation_members (conversation_id, user_id) values (%s, %s)
                              on conflict do nothing""", (conv["id"], uid))
    return {"id": conv["id"], "created": conv["last_message_at"] is None, "title": name(other["display_name"])}


async def members(conn, user_id: int, q: str | None, limit: int = 20) -> list[dict]:
    """Other active users to start a direct conversation with. Searched by name only, never by contact details."""
    rows = await db.fetch_all(conn, """
        select u.id, u.display_name from users u
        where u.id <> %(u)s and u.blocked_at is null and not u.impersonation_only and u.display_name is not null
          and (%(q)s::text is null or u.display_name ilike %(like)s)
          and not exists (select 1 from user_blocks b where (b.blocker_id = %(u)s and b.blocked_id = u.id)
                                                         or (b.blocker_id = u.id and b.blocked_id = %(u)s))
        order by u.display_name limit %(limit)s""", {"u": user_id, "q": q or None, "like": f"%{q or ''}%", "limit": limit})
    return [{"id": r["id"], "display_name": r["display_name"]} for r in rows]


# ── Reports and blocks ─────────────────────────────────────────────────────

async def report(conn, *, message_id: int, reporter_id: int, reason: str, details: str) -> int:
    msg = await db.fetch_one(conn, """select x.id, x.author_id, x.conversation_id, x.removed_at from conversation_messages x
                                      join conversations c on c.id = x.conversation_id
                                      where x.id = %s and c.kind in ('instance', 'direct')""", (message_id,))
    if msg is None:
        raise HTTPException(404, "Beskeden findes ikke")
    await conversation_for(conn, msg["conversation_id"], reporter_id)
    if msg["author_id"] == reporter_id:
        raise HTTPException(400, "Du kan ikke anmelde din egen besked")
    if msg["removed_at"] is not None:
        raise HTTPException(409, "Beskeden er allerede fjernet")
    row = await db.fetch_one(conn, """insert into message_reports (message_id, reporter_id, reason, details)
                                      values (%s, %s, %s, %s) on conflict (message_id, reporter_id) do nothing returning id""",
                             (message_id, reporter_id, reason, details))
    if row is None:
        raise HTTPException(409, "Du har allerede anmeldt beskeden")
    return row["id"]


async def blocks_of(conn, user_id: int) -> list[dict]:
    rows = await db.fetch_all(conn, """select u.id, u.display_name, b.created_at from user_blocks b
                                       join users u on u.id = b.blocked_id where b.blocker_id = %s order by b.created_at desc""",
                              (user_id,))
    return [{"user_id": r["id"], "display_name": name(r["display_name"]), "created_at": r["created_at"]} for r in rows]


# ── Moderation (admin) ─────────────────────────────────────────────────────

async def pending_reports(conn, status: str = "pending", limit: int = 100) -> list[dict]:
    """One entry per reported message with every report on it, oldest first for open ones."""
    rows = await db.fetch_all(conn, """
        select x.id as message_id, x.body, x.created_at as message_at, x.removed_at, x.author_id,
               coalesce(a.display_name, x.author_name) as author_name, c.kind, c.title,
               json_agg(json_build_object('id', r.id, 'reporter', coalesce(ru.display_name, 'Uden navn'), 'reason', r.reason,
                                          'details', r.details, 'status', r.status, 'created_at', r.created_at)
                        order by r.created_at) as reports,
               min(r.created_at) as first_at, max(r.reviewed_at) as reviewed_at
        from message_reports r
        join conversation_messages x on x.id = r.message_id
        join conversations c on c.id = x.conversation_id
        left join users a on a.id = x.author_id
        left join users ru on ru.id = r.reporter_id
        where (%(status)s = 'all' or r.status = %(status)s)
        group by x.id, a.display_name, c.kind, c.title
        order by case when %(status)s = 'pending' then min(r.created_at) end asc, max(r.created_at) desc
        limit %(limit)s""", {"status": status, "limit": limit})
    return [{"message_id": r["message_id"], "body": r["body"], "message_at": r["message_at"], "removed": r["removed_at"] is not None,
             "author_id": r["author_id"], "author_name": name(r["author_name"]) if r["author_id"] else "Slettet bruger",
             "where": r["title"] or INSTANCE_TITLE if r["kind"] == "instance" else "Direkte samtale",
             "reports": [{**rep, "reason_label": REASONS.get(rep["reason"], rep["reason"])} for rep in r["reports"]],
             "first_at": r["first_at"], "reviewed_at": r["reviewed_at"]} for r in rows]


async def context(conn, message_id: int) -> list[dict]:
    """The three messages before a reported one — only while a report on it is open."""
    msg = await db.fetch_one(conn, """select x.id, x.conversation_id from conversation_messages x
                                      where x.id = %s and exists (select 1 from message_reports r
                                                                  where r.message_id = x.id and r.status = 'pending')""",
                             (message_id,))
    if msg is None:
        raise HTTPException(409, "Konteksten vises kun, mens en anmeldelse er åben")
    rows = await db.fetch_all(conn, """
        select x.id, coalesce(u.display_name, x.author_name) as author_name, x.author_id, x.body, x.created_at,
               x.removed_at is not null as removed
        from conversation_messages x left join users u on u.id = x.author_id
        where x.conversation_id = %s and x.id < %s order by x.id desc limit %s""",
        (msg["conversation_id"], message_id, CONTEXT_BEFORE))
    rows.reverse()
    return [{"id": r["id"], "author_name": name(r["author_name"]) if r["author_id"] else "Slettet bruger",
             "body": None if r["removed"] else r["body"], "removed": r["removed"], "created_at": r["created_at"]} for r in rows]


async def review(conn, message_id: int, action: str, admin_id: int) -> int:
    """Decides every open report on a message. Returns how many were decided (0: nothing open)."""
    status = "removed" if action == "remove" else "dismissed"
    rows = await db.fetch_all(conn, """update message_reports set status = %s, reviewed_by = %s, reviewed_at = now()
                                       where message_id = %s and status = 'pending' returning id""",
                              (status, admin_id, message_id))
    if rows and action == "remove":
        await conn.execute("""update conversation_messages set removed_at = now(), removed_by = %s
                              where id = %s and removed_at is null""", (admin_id, message_id))
    return len(rows)


async def block_summary(conn, limit: int = 100) -> list[dict]:
    rows = await db.fetch_all(conn, """
        select u.id, u.display_name, count(*) as blocked_by, max(b.created_at) as latest,
               (select count(*) from message_reports r join conversation_messages x on x.id = r.message_id
                where x.author_id = u.id) as reported
        from user_blocks b join users u on u.id = b.blocked_id
        group by u.id order by count(*) desc, max(b.created_at) desc limit %s""", (limit,))
    return [{**r, "display_name": name(r["display_name"])} for r in rows]


