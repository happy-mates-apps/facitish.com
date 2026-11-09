"""Mit område: /api/user (your own dashboard and who you share it with) and /api/user/<id> (an area someone
has shared with you, as reader or author). The rules are in app/delegation.py."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from pydantic import BaseModel, Field

from app import db, delegation, filetree
from app.logs import audit, changed
from app.routes.clips import ClipIn, ClipPatch
from app.security import InvalidEmail, normalize_email
from app.sessions import Principal, current_user

router = APIRouter(prefix="/api/user", tags=["user"])

ROLE = "^(reader|author)$"
CLIP_COLS = "id, source, title, body, url, created_at, updated_at"


def _real(p: Principal) -> None:
    if p.impersonator_id is not None:
        raise HTTPException(403, "Ikke muligt for en testkonto")


# ── Your own area ───────────────────────────────────────────────────────────

@router.get("/overview")
async def overview(p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        grants = await delegation.grants(conn, p.user_id)
        live = [g for g in grants if not g["expired"]]
        return {
            "user": {"id": p.user_id, "display_name": p.display_name, "email": p.email},
            "stats": await delegation.area_stats(conn, p.user_id),
            "access": {"readers": sum(g["role"] == "reader" for g in live),
                       "authors": sum(g["role"] == "author" for g in live),
                       "pending": sum(g["accepted_at"] is None for g in live),
                       "people": [{"display_name": g["display_name"], "email": g["email"], "role": g["role"]}
                                  for g in live[:8]]},
            "activity": await delegation.activity(conn, p.user_id),
            "shared_with_me": await delegation.shared_with(conn, p),
        }


class GrantIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    role: str = Field(pattern=ROLE)
    expires_days: int | None = Field(default=None, ge=1, le=365)


class GrantPatch(BaseModel):
    role: str | None = Field(default=None, pattern=ROLE)
    expires_days: int | None = Field(default=None, ge=1, le=365)
    never_expires: bool = False


@router.get("/delegations")
async def list_grants(p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        return await delegation.grants(conn, p.user_id)


@router.post("/delegations")
async def create_grant(body: GrantIn, p: Principal = Depends(current_user)):
    _real(p)
    try:
        email = normalize_email(body.email)
    except InvalidEmail as e:
        raise HTTPException(400, str(e))
    async with db.connection() as conn:
        return await delegation.grant(conn, p, email, body.role, body.expires_days)


@router.patch("/delegations/{grant_id}")
async def update_grant(grant_id: int, body: GrantPatch, p: Principal = Depends(current_user)):
    _real(p)
    async with db.connection() as conn:
        row = await delegation.owned(conn, p, grant_id)
        after = {"role": body.role or row["role"], "expires_at": row["expires_at"]}
        if body.never_expires:
            after["expires_at"] = None
        elif body.expires_days:
            after["expires_at"] = delegation.expires_at(body.expires_days)
        b, a = changed({"role": row["role"], "expires_at": row["expires_at"]}, after)
        if a:
            await conn.execute("update user_delegations set role = %s, expires_at = %s, updated_at = now() where id = %s",
                               (after["role"], after["expires_at"], grant_id))
            await audit(conn, "update", actor_id=p.user_id, meta=p.meta, table="user_delegations", row_id=grant_id,
                        before=b, after={**a, "email": row["delegate_email"]})
        return delegation.grant_out(await db.fetch_one(conn, delegation.GRANT_SQL + " where d.id = %s", (grant_id,)))


@router.delete("/delegations/{grant_id}")
async def revoke_grant(grant_id: int, p: Principal = Depends(current_user)):
    _real(p)
    async with db.connection() as conn:
        row = await delegation.owned(conn, p, grant_id)
        await conn.execute("delete from user_delegations where id = %s", (grant_id,))
        await audit(conn, "delete", actor_id=p.user_id, meta=p.meta, table="user_delegations", row_id=grant_id,
                    before={"email": row["delegate_email"], "role": row["role"]})
    return {"ok": True}


@router.get("/shared")
async def shared_with_me(p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        return await delegation.shared_with(conn, p)


@router.delete("/shared/{grant_id}")
async def leave(grant_id: int, p: Principal = Depends(current_user)):
    """Gives up access someone gave you."""
    async with db.connection() as conn:
        await delegation.claim(conn, p)
        row = await db.fetch_one(conn, "delete from user_delegations where id = %s and delegate_id = %s "
                                       "returning owner_id, role", (grant_id, p.user_id))
        if row is None:
            raise HTTPException(404, "Ikke fundet")
        await audit(conn, "delete", actor_id=p.user_id, meta=p.meta, table="user_delegations", row_id=grant_id,
                    before={"role": row["role"]}, on_behalf_of=row["owner_id"], via="delegation", by_delegate=True)
    return {"ok": True}


# ── An area shared with you: /api/user/<owner id>/… ─────────────────────────

def _area_out(acc: dict) -> dict:
    d = acc["delegation"]
    return {"owner": acc["owner"], "role": acc["role"], "role_label": delegation.ROLE_LABEL[acc["role"]],
            "can_write": acc["role"] in ("owner", "author"),
            "granted_at": d["created_at"] if d else None, "expires_at": d["expires_at"] if d else None}


async def _files(conn, owner_id: int, limit: int) -> list[dict]:
    rows = await db.fetch_all(conn, f"""select {filetree.FILE_COLS} from files f
                                        where f.user_id = %s and f.space = 'user' and f.kind = 'file'
                                        order by coalesce(f.updated_at, f.created_at) desc limit %s""",
                              (owner_id, limit))
    return [filetree.out(r) for r in rows]


@router.get("/{owner_id}")
async def area(owner_id: int, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        acc = await delegation.access(conn, p, owner_id)
        return {**_area_out(acc), "stats": await delegation.area_stats(conn, owner_id),
                "clips": await db.fetch_all(conn, f"select {CLIP_COLS} from clips where user_id = %s "
                                                  "order by created_at desc limit 8", (owner_id,)),
                "files": await _files(conn, owner_id, 8)}


@router.get("/{owner_id}/clips")
async def area_clips(owner_id: int, q: str | None = None, limit: int = 100, p: Principal = Depends(current_user)):
    where, params = "where user_id = %s", [owner_id]
    if q:
        where += " and (title ilike %s or body ilike %s)"
        params += [f"%{q}%", f"%{q}%"]
    async with db.connection() as conn:
        await delegation.access(conn, p, owner_id)
        return await db.fetch_all(conn, f"select {CLIP_COLS} from clips {where} order by created_at desc limit %s",
                                  params + [max(1, min(limit, 500))])


@router.post("/{owner_id}/clips")
async def area_create_clip(owner_id: int, body: ClipIn, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        acc = await delegation.access(conn, p, owner_id, write=True)
        row = await db.fetch_one(conn, f"""insert into clips (user_id, source, title, body, url)
                                           values (%s, %s, %s, %s, %s) returning {CLIP_COLS}""",
                                 (owner_id, body.source, body.title.strip(), body.body, body.url))
        await audit(conn, "create", actor_id=p.user_id, meta=p.meta, table="clips", row_id=row["id"],
                    after={"source": body.source, "title": row["title"], "url": body.url, "chars": len(body.body)},
                    **delegation.on_behalf(acc))
    return row


@router.patch("/{owner_id}/clips/{clip_id}")
async def area_update_clip(owner_id: int, clip_id: int, body: ClipPatch, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        acc = await delegation.access(conn, p, owner_id, write=True)
        before = await db.fetch_one(conn, "select title, body from clips where id = %s and user_id = %s for update",
                                    (clip_id, owner_id))
        if before is None:
            raise HTTPException(404, "Ikke fundet")
        after = {"title": body.title if body.title is not None else before["title"],
                 "body": body.body if body.body is not None else before["body"]}
        await conn.execute("update clips set title = %s, body = %s, updated_at = now() where id = %s",
                           (after["title"], after["body"], clip_id))
        b, a = changed(before, after)
        if a:
            # The text itself is not logged, only its length.
            if "body" in a:
                b["body"], a["body"] = len(b["body"] or ""), len(a["body"] or "")
            await audit(conn, "update", actor_id=p.user_id, meta=p.meta, table="clips", row_id=clip_id,
                        before=b, after={**a, "title": after["title"]}, **delegation.on_behalf(acc))
    return {"ok": True}


@router.get("/{owner_id}/files")
async def area_files(owner_id: int, limit: int = 200, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        await delegation.access(conn, p, owner_id)
        return await _files(conn, owner_id, max(1, min(limit, 500)))


@router.get("/{owner_id}/files/{file_id}/link")
async def area_file_link(owner_id: int, file_id: uuid.UUID, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        acc = await delegation.access(conn, p, owner_id)
        row = await db.fetch_one(conn, f"""select {filetree.FILE_COLS} from files f where f.id = %s and f.user_id = %s
                                           and f.space = 'user' and f.kind = 'file'""", (file_id, owner_id))
        if row is None:
            raise HTTPException(404, "Filen findes ikke")
        if acc["role"] != "owner":
            await audit(conn, "file.download", actor_id=p.user_id, meta=p.meta, table="files", row_id=file_id,
                        after={"filename": row["filename"], "path": filetree.file_path(row)},
                        **delegation.on_behalf(acc))
        return await filetree.download_link(row)


@router.post("/{owner_id}/files")
async def area_upload(owner_id: int, file: UploadFile, folder: str = "/", p: Principal = Depends(current_user)):
    """An author uploads into the owner's home. Never over an existing file: a clash gets a free name."""
    async with db.connection() as conn:
        acc = await delegation.access(conn, p, owner_id, write=True)
        loc = filetree.parse(f"/users/{owner_id}/{folder.strip('/')}")
        if loc.kind != "home" or loc.user_id != owner_id:
            raise HTTPException(400, "Ugyldig mappe")
        row = await filetree.upload(conn, loc, file, p, admin=True, overwrite=False,
                                    audit_extra=delegation.on_behalf(acc))
    return filetree.out(row)
