"""/api/admin/groups (section /groups) and /api/me/groups: groups as a general feature (app/groups.py).

Adding someone to a group can give them access to secrets the group holds a grant for (app/secret_store.py), so
member changes need a recent second factor and A and R of those secrets are told.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import db, groups, secret_store
from app.logs import audit, changed
from app.sessions import Principal, current_user, require_admin, require_admin_stepup

router = APIRouter(prefix="/api/admin/groups", tags=["admin"], dependencies=[Depends(require_admin)])
me_router = APIRouter(prefix="/api/me/groups", tags=["me"])


class GroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    slug: str | None = Field(default=None, pattern=r"^[a-z0-9][a-z0-9-]{0,62}$")
    description: str = Field(default="", max_length=500)
    notify_email: str | None = Field(default=None, max_length=254, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class GroupPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    notify_email: str | None = Field(default=None, max_length=254, pattern=r"^([^@\s]+@[^@\s]+\.[^@\s]+)?$")


class MemberIn(BaseModel):
    role: str = Field(default="member", pattern="^(member|manager)$")


@router.get("")
async def list_groups():
    async with db.connection() as conn:
        items = await db.fetch_all(conn, f"""
            select {groups.COLUMNS},
                   (select count(*) from group_members m where m.group_id = g.id) as members,
                   (select count(*) from secrets s where s.group_id = g.id and s.archived_at is null) as secrets
            from groups g order by lower(g.name)""")
    return {"items": items, "roles": [{"key": k, "label": v} for k, v in groups.ROLE_LABELS.items()]}


@router.post("", status_code=201)
async def create_group(body: GroupIn, admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        slug = body.slug or await groups.unique_slug(conn, groups.slugify(body.name))
        if await db.fetch_one(conn, "select 1 from groups where slug = %s", (slug,)):
            raise HTTPException(409, "Der findes allerede en gruppe med den kortform")
        row = await db.fetch_one(conn, """
            insert into groups (slug, name, description, notify_email, created_by) values (%s, %s, %s, %s, %s)
            returning id, slug, name, description, notify_email, created_at, updated_at""",
            (slug, body.name.strip(), body.description.strip(), (body.notify_email or "").lower() or None, admin.user_id))
        await audit(conn, "create", actor_id=admin.user_id, meta=admin.meta, table="groups", row_id=row["id"],
                    after={"slug": slug, "name": row["name"]})
    return row


@router.get("/{group_id}")
async def get_group(group_id: int):
    async with db.connection() as conn:
        group = await groups.get(conn, group_id)
        group["members"] = await groups.members(conn, group_id)
        group["secrets"] = await db.fetch_all(conn, """select id, name, environment from secrets
                                                       where group_id = %s and archived_at is null order by lower(name)""",
                                              (group_id,))
    return group


@router.patch("/{group_id}")
async def update_group(group_id: int, body: GroupPatch, admin: Principal = Depends(require_admin)):
    fields = body.model_dump(exclude_unset=True)
    if "notify_email" in fields:
        fields["notify_email"] = (fields["notify_email"] or "").lower() or None
    async with db.connection() as conn:
        before = await groups.get(conn, group_id)
        if not fields:
            return before
        # Column names come from this fixed tuple, never from the request.
        cols = [c for c in ("name", "description", "notify_email") if c in fields]
        sets = ", ".join(f"{c} = %s" for c in cols)
        row = await db.fetch_one(conn, f"""update groups set {sets}, updated_at = now() where id = %s
                                           returning id, slug, name, description, notify_email, created_at, updated_at""",
                                 (*(fields[c] for c in cols), group_id))
        b, a = changed(before, fields)
        await audit(conn, "update", actor_id=admin.user_id, meta=admin.meta, table="groups", row_id=group_id, before=b, after=a)
    return row


@router.delete("/{group_id}")
async def delete_group(group_id: int, admin: Principal = Depends(require_admin_stepup)):
    async with db.connection() as conn:
        group = await groups.get(conn, group_id)
        if await db.fetch_one(conn, "select 1 from secrets where group_id = %s", (group_id,)):
            raise HTTPException(409, "Gruppen ejer hemmeligheder. Flyt eller slet dem først.")
        await conn.execute("delete from groups where id = %s", (group_id,))
        await audit(conn, "delete", actor_id=admin.user_id, meta=admin.meta, table="groups", row_id=group_id,
                    before={"slug": group["slug"], "name": group["name"]})
    return {"ok": True}


@router.put("/{group_id}/members/{user_id}")
async def put_member(group_id: int, user_id: int, body: MemberIn, admin: Principal = Depends(require_admin_stepup)):
    async with db.connection() as conn:
        await groups.get(conn, group_id)
        user = await db.fetch_one(conn, "select id, impersonation_only from users where id = %s", (user_id,))
        if user is None or user["impersonation_only"]:
            raise HTTPException(404, "Brugeren findes ikke")
        old = await groups.is_member(conn, group_id, user_id)
        await conn.execute("""insert into group_members (group_id, user_id, role, added_by) values (%s, %s, %s, %s)
                              on conflict (group_id, user_id) do update set role = excluded.role""",
                           (group_id, user_id, body.role, admin.user_id))
        if old is None:
            await audit(conn, "group.member_added", actor_id=admin.user_id, meta=admin.meta, table="groups",
                        row_id=group_id, user_id=user_id, role=body.role)
            await secret_store.after_group_member_added(conn, group_id, user_id, admin.meta)
        elif old != body.role:
            await audit(conn, "group.member_role", actor_id=admin.user_id, meta=admin.meta, table="groups",
                        row_id=group_id, user_id=user_id, before={"role": old}, after={"role": body.role})
        return {"members": await groups.members(conn, group_id)}


@router.delete("/{group_id}/members/{user_id}")
async def remove_member(group_id: int, user_id: int, admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        await groups.get(conn, group_id)
        cur = await conn.execute("delete from group_members where group_id = %s and user_id = %s", (group_id, user_id))
        if not cur.rowcount:
            raise HTTPException(404, "Personen er ikke medlem af gruppen")
        await audit(conn, "group.member_removed", actor_id=admin.user_id, meta=admin.meta, table="groups",
                    row_id=group_id, user_id=user_id)
        return {"members": await groups.members(conn, group_id)}


@me_router.get("")
async def my_groups(user: Principal = Depends(current_user)):
    async with db.connection() as conn:
        return await groups.for_user(conn, user.user_id)
