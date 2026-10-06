"""Clips and bridge consent: what the extension, the Office add-ins and /m share.

A clip is text the user captured (a web page, a selection, a mail) or wrote, and can
insert into Word or Outlook. Bridge consent lists the domains the extension may read.
"""

from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import db
from app.logs import audit, changed
from app.sessions import Principal, current_user

router = APIRouter(prefix="/api", tags=["clips"])

SOURCES = "^(manual|extension|outlook|word|mobile)$"


class ClipIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    body: str = Field(default="", max_length=100_000)
    url: str | None = Field(default=None, max_length=2000)
    source: str = Field(default="manual", pattern=SOURCES)


class ClipPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=300)
    body: str | None = Field(default=None, max_length=100_000)


@router.get("/clips")
async def list_clips(q: str | None = None, limit: int = 100, p: Principal = Depends(current_user)):
    where, params = "where user_id = %s", [p.user_id]
    if q:
        where += " and (title ilike %s or body ilike %s)"
        params += [f"%{q}%", f"%{q}%"]
    async with db.connection() as conn:
        return await db.fetch_all(conn, f"""
            select id, source, title, body, url, created_at, updated_at from clips {where}
            order by created_at desc limit %s""", params + [max(1, min(limit, 500))])


@router.post("/clips")
async def create_clip(body: ClipIn, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        row = await db.fetch_one(conn, """
            insert into clips (user_id, source, title, body, url) values (%s, %s, %s, %s, %s)
            returning id, source, title, body, url, created_at, updated_at""",
            (p.user_id, body.source, body.title.strip(), body.body, body.url))
        await audit(conn, "create", actor_id=p.user_id, meta=p.meta, table="clips", row_id=row["id"],
                    after={"source": body.source, "title": row["title"], "url": body.url, "chars": len(body.body)})
    return row


@router.patch("/clips/{clip_id}")
async def update_clip(clip_id: int, body: ClipPatch, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        before = await db.fetch_one(conn, "select title, body from clips where id = %s and user_id = %s for update",
                                    (clip_id, p.user_id))
        if before is None:
            raise HTTPException(404, "Ikke fundet")
        after = {"title": body.title if body.title is not None else before["title"],
                 "body": body.body if body.body is not None else before["body"]}
        await conn.execute("update clips set title = %s, body = %s, updated_at = now() where id = %s",
                           (after["title"], after["body"], clip_id))
        b, a = changed(before, after)
        if a:
            await audit(conn, "update", actor_id=p.user_id, meta=p.meta, table="clips", row_id=clip_id,
                        before=b, after=a)
    return {"ok": True}


@router.delete("/clips/{clip_id}")
async def delete_clip(clip_id: int, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        row = await db.fetch_one(conn, "delete from clips where id = %s and user_id = %s returning title, source, url",
                                 (clip_id, p.user_id))
        if row is None:
            raise HTTPException(404, "Ikke fundet")
        await audit(conn, "delete", actor_id=p.user_id, meta=p.meta, table="clips", row_id=clip_id, before=row)
    return {"ok": True}


# ── Bridge consent (which domains the extension may read) ──────────────────

def normalize_domain(value: str) -> str:
    value = value.strip().lower()
    host = urlparse(value).hostname if "://" in value else value.split("/")[0]
    host = (host or "").removeprefix("www.")
    if not host or len(host) > 253 or " " in host:
        raise HTTPException(400, "Ugyldigt domæne")
    return host


class ConsentIn(BaseModel):
    domain: str = Field(min_length=1, max_length=300)


@router.get("/bridge-consent")
async def list_bridge_consent(p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        return await db.fetch_all(conn, "select id, domain, created_at from bridge_consents where user_id = %s order by domain",
                                  (p.user_id,))


@router.get("/bridge-consent/check")
async def check_bridge_consent(domain: str, p: Principal = Depends(current_user)):
    host = normalize_domain(domain)
    async with db.connection() as conn:
        row = await db.fetch_one(conn, "select 1 as ok from bridge_consents where user_id = %s and domain = %s",
                                 (p.user_id, host))
    return {"domain": host, "allowed": row is not None}


@router.post("/bridge-consent")
async def allow_domain(body: ConsentIn, p: Principal = Depends(current_user)):
    host = normalize_domain(body.domain)
    async with db.connection() as conn:
        row = await db.fetch_one(conn, """
            insert into bridge_consents (user_id, domain) values (%s, %s)
            on conflict (user_id, domain) do nothing returning id""", (p.user_id, host))
        if row:
            await audit(conn, "create", actor_id=p.user_id, meta=p.meta, table="bridge_consents", row_id=row["id"],
                        after={"domain": host})
    return {"domain": host, "allowed": True}


@router.delete("/bridge-consent/{consent_id}")
async def revoke_domain(consent_id: int, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        row = await db.fetch_one(conn, "delete from bridge_consents where id = %s and user_id = %s returning domain",
                                 (consent_id, p.user_id))
        if row is None:
            raise HTTPException(404, "Ikke fundet")
        await audit(conn, "delete", actor_id=p.user_id, meta=p.meta, table="bridge_consents", row_id=consent_id,
                    before=row)
    return {"ok": True}
