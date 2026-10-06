"""The logged-in user's own account: profile, passkeys, sessions and GDPR requests."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import db
from app.logs import audit, auth_event, changed
from app.sessions import Principal, current_user, revoke_sessions

router = APIRouter(prefix="/api/me", tags=["me"])


class ProfileIn(BaseModel):
    display_name: str = Field(max_length=80)


class RenameIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)


class GdprIn(BaseModel):
    kind: str = Field(pattern="^(access|rectification|erasure)$")
    message: str = Field(default="", max_length=4000)


@router.patch("/profile")
async def update_profile(body: ProfileIn, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        before = await db.fetch_one(conn, "select display_name from users where id = %s for update", (p.user_id,))
        after = {"display_name": body.display_name.strip() or None}
        await conn.execute("update users set display_name = %s, updated_at = now() where id = %s",
                           (after["display_name"], p.user_id))
        b, a = changed(before, after)
        if a:
            await audit(conn, "update", actor_id=p.user_id, meta=p.meta, table="users", row_id=p.user_id,
                        before=b, after=a)
    return {"ok": True}


@router.get("/passkeys")
async def list_passkeys(p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        return await db.fetch_all(conn, """
            select id, name, created_at, last_used_at from passkeys where user_id = %s order by created_at""",
            (p.user_id,))


@router.patch("/passkeys/{passkey_id}")
async def rename_passkey(passkey_id: int, body: RenameIn, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        before = await db.fetch_one(conn, "select name from passkeys where id = %s and user_id = %s",
                                    (passkey_id, p.user_id))
        if before is None:
            raise HTTPException(404, "Ikke fundet")
        await conn.execute("update passkeys set name = %s where id = %s", (body.name.strip(), passkey_id))
        await audit(conn, "update", actor_id=p.user_id, meta=p.meta, table="passkeys", row_id=passkey_id,
                    before=before, after={"name": body.name.strip()})
    return {"ok": True}


@router.delete("/passkeys/{passkey_id}")
async def delete_passkey(passkey_id: int, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        row = await db.fetch_one(conn, "delete from passkeys where id = %s and user_id = %s returning name",
                                 (passkey_id, p.user_id))
        if row is None:
            raise HTTPException(404, "Ikke fundet")
        await audit(conn, "delete", actor_id=p.user_id, meta=p.meta, table="passkeys", row_id=passkey_id,
                    before=row)
        await auth_event(conn, "passkey.deleted", ok=True, meta=p.meta, user_id=p.user_id, phone=p.phone,
                         passkey_id=passkey_id)
    return {"ok": True}


@router.get("/sessions")
async def list_sessions(p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        rows = await db.fetch_all(conn, """
            select id, created_at, last_seen_at, expires_at, host(ip) as ip, user_agent from sessions
            where user_id = %s and revoked_at is null and expires_at > now() and scope = 'full'
            order by last_seen_at desc""", (p.user_id,))
    for r in rows:
        r["current"] = r["id"] == p.session_id
    return rows


@router.delete("/sessions/{session_id}")
async def revoke_session(session_id: int, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        n = await revoke_sessions(conn, meta=p.meta, user_id=p.user_id, session_id=session_id, reason="user")
    if not n:
        raise HTTPException(404, "Ikke fundet")
    return {"ok": True}


@router.get("/gdpr")
async def my_gdpr_requests(p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        return await db.fetch_all(conn, """
            select id, kind, status, received_at, due_at, completed_at from gdpr_requests
            where user_id = %s order by received_at desc""", (p.user_id,))


@router.post("/gdpr")
async def create_gdpr_request(body: GdprIn, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        row = await db.fetch_one(conn, """
            insert into gdpr_requests (user_id, kind, contact, message) values (%s, %s, %s, %s)
            returning id, due_at""", (p.user_id, body.kind, p.phone, body.message))
        await audit(conn, "gdpr.request", actor_id=p.user_id, meta=p.meta, table="gdpr_requests", row_id=row["id"],
                    after={"kind": body.kind, "status": "received"})
    return {"id": row["id"], "due_at": row["due_at"]}
