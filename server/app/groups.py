"""Groups: named sets of users, managed in /admin/groups and used by other features (first: the secret manager,
app/secret_store.py, where a group owns secrets and can be given access to one).

A member is `member` or `manager`. Managers may change their group's notification rules for secrets; adding and
removing members is done by admins with the section /groups. Groups hold no personal data of their own; memberships
are exported with the user and cascade on erasure (app/gdpr.py).
"""

import re

from fastapi import HTTPException

from app import db

ROLES = ("member", "manager")
ROLE_LABELS = {"member": "Medlem", "manager": "Ansvarlig for gruppen"}
COLUMNS = "g.id, g.slug, g.name, g.description, g.notify_email, g.created_at, g.updated_at"


def slugify(name: str) -> str:
    s = name.lower().translate(str.maketrans({"æ": "ae", "ø": "oe", "å": "aa"}))
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:63]
    return s or "gruppe"


async def get(conn, group_id: int) -> dict:
    row = await db.fetch_one(conn, f"select {COLUMNS} from groups g where g.id = %s", (group_id,))
    if row is None:
        raise HTTPException(404, "Gruppen findes ikke")
    return row


async def members(conn, group_id: int) -> list[dict]:
    return await db.fetch_all(conn, """
        select m.user_id as id, u.display_name, u.email, u.role as user_role, m.role, m.added_at
        from group_members m join users u on u.id = m.user_id
        where m.group_id = %s order by lower(coalesce(u.display_name, u.email, '')), u.id""", (group_id,))


async def member_ids(conn, group_id: int) -> list[int]:
    return [r["user_id"] for r in await db.fetch_all(
        conn, "select user_id from group_members where group_id = %s order by user_id", (group_id,))]


async def is_member(conn, group_id: int, user_id: int) -> str | None:
    """The user's role in the group, or None."""
    row = await db.fetch_one(conn, "select role from group_members where group_id = %s and user_id = %s",
                             (group_id, user_id))
    return row["role"] if row else None


async def for_user(conn, user_id: int) -> list[dict]:
    return await db.fetch_all(conn, f"""
        select {COLUMNS}, m.role from groups g join group_members m on m.group_id = g.id
        where m.user_id = %s order by lower(g.name)""", (user_id,))


async def unique_slug(conn, wanted: str, own_id: int | None = None) -> str:
    base, n = wanted, 1
    while await db.fetch_one(conn, "select 1 from groups where slug = %s and id is distinct from %s", (wanted, own_id)):
        n += 1
        wanted = f"{base[:60]}-{n}"
    return wanted
