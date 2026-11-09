"""Mit område (/user) and delegated access to it (/user/<id>), migration 0016.

A user (the owner) can give another user access to their area as
  reader   sees the owner's overview, clips and files, and may download the files
  author   also creates and edits clips and uploads files in the owner's home
The owner always keeps for themselves: deleting, settings and security, and giving others access.
Access is given to an e-mail address and may expire. The person logs in as themselves; there is no way in as the owner.

Everything a delegate changes is audited with the delegate as actor and detail.on_behalf_of = the owner (also
`via: "delegation"`), so the owner's activity list shows it and GDPR erasure of the owner removes it.
"""

from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

from app import db
from app.logs import audit
from app.sessions import Principal

ROLES = ("reader", "author")
ROLE_LABEL = {"reader": "Læser", "author": "Forfatter", "owner": "Ejer"}
MAX_PER_OWNER = 50
USED_EVERY = timedelta(minutes=10)  # last_used_at is written at most this often


def delegate_match(alias: str = "d") -> str:
    """SQL: the delegation belongs to the caller (params: user id, e-mail). A pending one matches on the e-mail."""
    return (f"({alias}.delegate_id = %s or ({alias}.delegate_id is null and %s::text is not null "
            f"and {alias}.delegate_email = %s))")


def active(alias: str = "d") -> str:
    return f"({alias}.expires_at is null or {alias}.expires_at > now())"


def expires_at(days: int | None) -> datetime | None:
    return datetime.now(timezone.utc) + timedelta(days=days) if days else None


async def claim(conn, p: Principal) -> None:
    """Pending delegations to the caller's e-mail become theirs (delegate_id is set)."""
    if not p.email:
        return
    await conn.execute("""update user_delegations set delegate_id = %s
                          where delegate_id is null and delegate_email = %s and owner_id <> %s
                            and not exists (select 1 from user_delegations x
                                            where x.owner_id = user_delegations.owner_id and x.delegate_id = %s)""",
                       (p.user_id, p.email, p.user_id, p.user_id))


async def access(conn, p: Principal, owner_id: int, *, write: bool = False) -> dict:
    """The caller's access to owner_id's area: {"role": "owner" | "reader" | "author", "owner": {...}, ...}.
    404 when there is none (also for a blocked or unknown owner), 403 when write is asked of a reader."""
    owner = await db.fetch_one(conn, """select id, display_name, email, blocked_at from users
                                        where id = %s and not impersonation_only""", (owner_id,))
    if owner_id == p.user_id:
        return {"role": "owner", "owner": _owner_out(owner or {"id": p.user_id, "display_name": p.display_name,
                                                                 "email": p.email}), "delegation": None}
    if owner is None or owner["blocked_at"] is not None:
        raise HTTPException(404, "Området findes ikke, eller du har ikke adgang til det")
    await claim(conn, p)
    row = await db.fetch_one(conn, f"""select d.* from user_delegations d
                                       where d.owner_id = %s and {delegate_match()} and {active()}""",
                             (owner_id, p.user_id, p.email, p.email))
    if row is None:
        raise HTTPException(404, "Området findes ikke, eller du har ikke adgang til det")
    if row["accepted_at"] is None:
        # The page loads several endpoints at once: only the request that sets accepted_at logs it.
        first = await db.fetch_one(conn, """update user_delegations set accepted_at = now(), last_used_at = now()
                                            where id = %s and accepted_at is null returning id""", (row["id"],))
        if first:
            await audit(conn, "delegation.accepted", actor_id=p.user_id, meta=p.meta, table="user_delegations",
                        row_id=row["id"], on_behalf_of=owner_id, via="delegation", role=row["role"])
    elif row["last_used_at"] is None or datetime.now(timezone.utc) - row["last_used_at"] > USED_EVERY:
        await conn.execute("update user_delegations set last_used_at = now() where id = %s", (row["id"],))
    if write and row["role"] != "author":
        raise HTTPException(403, "Du har læseadgang til området og kan ikke ændre noget")
    return {"role": row["role"], "owner": _owner_out(owner), "delegation": row}


def _owner_out(u: dict) -> dict:
    return {"id": u["id"], "display_name": u.get("display_name"), "email": u.get("email")}


def on_behalf(acc: dict) -> dict:
    """Audit detail for a change made through a delegation (nothing extra for the owner)."""
    if acc["role"] == "owner":
        return {}
    return {"on_behalf_of": acc["owner"]["id"], "via": "delegation"}


# ── The owner's side ────────────────────────────────────────────────────────

def grant_out(row: dict) -> dict:
    return {
        "id": row["id"], "email": row["delegate_email"], "role": row["role"], "role_label": ROLE_LABEL[row["role"]],
        "user_id": row.get("delegate_id"), "display_name": row.get("delegate_name"),
        "created_at": row["created_at"], "expires_at": row["expires_at"], "accepted_at": row["accepted_at"],
        "last_used_at": row["last_used_at"],
        "expired": row["expires_at"] is not None and row["expires_at"] <= datetime.now(timezone.utc),
    }


GRANT_SQL = """select d.*, u.display_name as delegate_name from user_delegations d
               left join users u on u.id = d.delegate_id"""


async def grants(conn, owner_id: int) -> list[dict]:
    rows = await db.fetch_all(conn, GRANT_SQL + " where d.owner_id = %s order by d.created_at", (owner_id,))
    return [grant_out(r) for r in rows]


async def grant(conn, p: Principal, email: str, role: str, days: int | None) -> dict:
    if p.email and email == p.email:
        raise HTTPException(400, "Du har allerede adgang til dit eget område")
    n = await db.fetch_one(conn, "select count(*) as n from user_delegations where owner_id = %s", (p.user_id,))
    if n["n"] >= MAX_PER_OWNER:
        raise HTTPException(409, f"Du kan højst dele dit område med {MAX_PER_OWNER} personer")
    user = await db.fetch_one(conn, "select id from users where email = %s and not impersonation_only", (email,))
    if user and user["id"] == p.user_id:
        raise HTTPException(400, "Du har allerede adgang til dit eget område")
    taken = await db.fetch_one(conn, """select 1 as x from user_delegations where owner_id = %s
                                        and (delegate_email = %s or delegate_id = %s)""",
                               (p.user_id, email, user["id"] if user else None))
    if taken:
        raise HTTPException(409, "Personen har allerede adgang – skift rollen i listen i stedet")
    row = await db.fetch_one(conn, """
        insert into user_delegations (owner_id, delegate_email, delegate_id, role, expires_at)
        values (%s, %s, %s, %s, %s) returning id""",
        (p.user_id, email, user["id"] if user else None, role, expires_at(days)))
    await audit(conn, "create", actor_id=p.user_id, meta=p.meta, table="user_delegations", row_id=row["id"],
                after={"email": email, "role": role, "expires_days": days})
    return grant_out(await db.fetch_one(conn, GRANT_SQL + " where d.id = %s", (row["id"],)))


async def owned(conn, p: Principal, grant_id: int) -> dict:
    row = await db.fetch_one(conn, "select * from user_delegations where id = %s and owner_id = %s for update",
                             (grant_id, p.user_id))
    if row is None:
        raise HTTPException(404, "Ikke fundet")
    return row


# ── The activity list on /user ──────────────────────────────────────────────

AREA_TABLES = ("clips", "files", "file_folders", "user_delegations")


async def activity(conn, owner_id: int, limit: int = 20) -> list[dict]:
    """What happened in the owner's area: their own changes and everything delegates did there."""
    rows = await db.fetch_all(conn, """
        select a.ts, a.action, a.table_name, a.actor_user_id, a.before, a.after, a.detail,
               coalesce(u.display_name, u.email, u.phone) as actor_name
        from audit_log a left join users u on u.id = a.actor_user_id
        where ((a.actor_user_id = %s and a.table_name = any(%s) and not a.detail ? 'on_behalf_of')
               or (a.detail ? 'on_behalf_of' and (a.detail ->> 'on_behalf_of')::bigint = %s))
          and a.action <> 'admin.read'
        order by a.ts desc limit %s""", (owner_id, list(AREA_TABLES), owner_id, limit))
    return [_activity_out(r, owner_id) for r in rows]


def _activity_out(r: dict, owner_id: int) -> dict:
    data = r["after"] or r["before"] or {}
    detail = r["detail"] or {}
    subject = data.get("title") or data.get("filename") or data.get("path") or data.get("email")
    if subject is None and detail.get("path"):
        subject = detail["path"]
    mine = r["actor_user_id"] == owner_id
    return {"ts": r["ts"], "action": r["action"], "table": r["table_name"], "subject": subject,
            "role": data.get("role") or detail.get("role"), "mine": mine,
            "actor": None if mine else {"id": r["actor_user_id"], "name": r["actor_name"]}}


# ── What a delegate sees ────────────────────────────────────────────────────

async def area_stats(conn, owner_id: int) -> dict:
    clips = await db.fetch_one(conn, """select count(*) as clips,
                                               count(*) filter (where created_at > now() - interval '7 days') as clips_week
                                        from clips where user_id = %s""", (owner_id,))
    files = await db.fetch_one(conn, """select count(*) as files, coalesce(sum(size_bytes), 0) as bytes from files
                                        where user_id = %s and space = 'user' and kind = 'file'""", (owner_id,))
    return {**clips, **files}


async def shared_with(conn, p: Principal) -> list[dict]:
    """The areas others have given the caller access to."""
    await claim(conn, p)
    rows = await db.fetch_all(conn, f"""
        select d.id, d.owner_id, d.role, d.created_at, d.expires_at, d.accepted_at,
               u.display_name, u.email
        from user_delegations d join users u on u.id = d.owner_id
        where {delegate_match()} and {active()} and u.blocked_at is null and not u.impersonation_only
        order by lower(coalesce(u.display_name, u.email, ''))""", (p.user_id, p.email, p.email))
    return [{"id": r["id"], "owner": {"id": r["owner_id"], "display_name": r["display_name"], "email": r["email"]},
             "role": r["role"], "role_label": ROLE_LABEL[r["role"]], "created_at": r["created_at"],
             "expires_at": r["expires_at"], "accepted_at": r["accepted_at"]} for r in rows]
