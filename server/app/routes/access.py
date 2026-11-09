"""Access requests from MCP clients (app/access.py) — the user's list in /konto, the e-mail link page /godkend, the
approvers' list in /admin/access — and marking a user internal or external in /admin/users.

Approving from an e-mail is the same decision as from the list: the link opens the page, the person must be logged in
as the one the mail was sent to, and an approver also needs a fresh second factor (require_admin_stepup).
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app import access, db
from app.security import mask_contact
from app.sessions import Principal, current_user, require_admin, require_admin_stepup

router = APIRouter(tags=["access"])


def _fail(e: access.AccessError) -> HTTPException:
    return HTTPException(e.status, str(e))


# ── The user (/konto, /godkend) ─────────────────────────────────────────────

@router.get("/api/me/mcp-access")
async def my_requests(user: Principal = Depends(current_user)):
    async with db.connection() as conn:
        rows = await access.for_user(conn, user.user_id)
        me = await db.fetch_one(conn, "select audience from users where id = %s", (user.user_id,))
    return {"audience": me["audience"], "audienceLabel": access.AUDIENCE_LABELS[me["audience"]],
            "items": [access.out(r) for r in rows]}


class UserDecisionIn(BaseModel):
    approve: bool


@router.post("/api/me/mcp-access/{request_id}/decide")
async def my_decide(request_id: int, body: UserDecisionIn, user: Principal = Depends(current_user)):
    try:
        async with db.connection() as conn:
            row = await access.decide_user(conn, request_id, user_id=user.user_id, approve=body.approve, via="list",
                                           meta=user.meta)
    except access.AccessError as e:
        raise _fail(e)
    return access.out(row)


@router.post("/api/me/mcp-access/{request_id}/revoke")
async def my_revoke(request_id: int, user: Principal = Depends(current_user)):
    try:
        async with db.connection() as conn:
            row = await access.revoke(conn, request_id, actor_id=user.user_id, by_owner=True, meta=user.meta)
    except access.AccessError as e:
        raise _fail(e)
    return access.out(row)


@router.get("/api/me/mcp-access/link")
async def my_link(t: str = Query(min_length=10, max_length=100), user: Principal = Depends(current_user)):
    """What the link in the e-mail is about. Only for the person it was sent to."""
    try:
        async with db.connection() as conn:
            link = await access.check_link(conn, t, user_id=user.user_id, step="user")
            row = await access.get(conn, link["request_id"])
    except access.AccessError as e:
        raise _fail(e)
    return access.out(row)


class LinkDecisionIn(BaseModel):
    t: str = Field(min_length=10, max_length=100)
    approve: bool


@router.post("/api/me/mcp-access/link")
async def my_link_decide(body: LinkDecisionIn, user: Principal = Depends(current_user)):
    try:
        async with db.connection() as conn:
            link = await access.check_link(conn, body.t, user_id=user.user_id, step="user")
            row = await access.decide_user(conn, link["request_id"], user_id=user.user_id, approve=body.approve,
                                           via="email", meta=user.meta)
    except access.AccessError as e:
        raise _fail(e)
    return access.out(row)


# ── Approvers (/admin/access) ───────────────────────────────────────────────

@router.get("/api/admin/access")
async def admin_list(status: str = Query("open", pattern="^(open|user|active|all)$"),
                     admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        rows = await access.listing(conn, status, 200)
        counts = await db.fetch_one(conn, """
            select count(*) filter (where status = 'awaiting_approver') as open,
                   count(*) filter (where status = 'awaiting_user') as "user",
                   count(*) filter (where status = 'approved' and expires_at > now()) as active
            from mcp_access_requests""")
    return {"items": [{**access.out(r, mask=mask_contact), "own": r["user_id"] == admin.user_id} for r in rows],
            "counts": counts, "days": list(access.CONFIDENTIAL_DAYS), "defaultDays": access.DEFAULT_CONFIDENTIAL_DAYS}


@router.get("/api/admin/access/link")
async def admin_link(t: str = Query(min_length=10, max_length=100), admin: Principal = Depends(require_admin)):
    try:
        async with db.connection() as conn:
            link = await access.check_link(conn, t, user_id=admin.user_id, step="approver")
            row = await access.get(conn, link["request_id"])
    except access.AccessError as e:
        raise _fail(e)
    return {**access.out(row, mask=mask_contact), "own": row["user_id"] == admin.user_id}


class ApproverDecisionIn(BaseModel):
    approve: bool
    days: int | None = None
    note: str | None = Field(default=None, max_length=500)
    t: str | None = Field(default=None, max_length=100)   # set when the decision comes from the e-mail link


@router.post("/api/admin/access/{request_id}/decide")
async def admin_decide(request_id: int, body: ApproverDecisionIn, admin: Principal = Depends(require_admin_stepup)):
    try:
        async with db.connection() as conn:
            if body.t:
                await access.check_link(conn, body.t, user_id=admin.user_id, step="approver", request_id=request_id)
            approver = await db.fetch_one(conn, "select * from users where id = %s", (admin.user_id,))
            row = await access.decide_approver(conn, request_id, approver=approver, approve=body.approve, days=body.days,
                                               note=body.note, via="email" if body.t else "list", meta=admin.meta)
    except access.AccessError as e:
        raise _fail(e)
    return access.out(row, mask=mask_contact)


class RevokeIn(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


@router.post("/api/admin/access/{request_id}/revoke")
async def admin_revoke(request_id: int, body: RevokeIn, admin: Principal = Depends(require_admin)):
    try:
        async with db.connection() as conn:
            row = await access.revoke(conn, request_id, actor_id=admin.user_id, by_owner=False, meta=admin.meta,
                                      reason=body.reason)
    except access.AccessError as e:
        raise _fail(e)
    return access.out(row, mask=mask_contact)


# ── Internal or external (/admin/users) ─────────────────────────────────────

class AudienceIn(BaseModel):
    audience: str = Field(pattern="^(internal|external)$")


@router.post("/api/admin/users/{user_id}/audience")
async def set_audience(user_id: int, body: AudienceIn, admin: Principal = Depends(require_admin_stepup)):
    async with db.connection() as conn:
        user = await db.fetch_one(conn, "select * from users where id = %s for update", (user_id,))
        if user is None or user["impersonation_only"]:
            raise HTTPException(404, "Brugeren findes ikke")
        ended = await access.set_audience(conn, user, body.audience, actor_id=admin.user_id, meta=admin.meta)
    return {"id": user_id, "audience": body.audience, "grants_ended": ended}


@router.get("/api/admin/users/{user_id}/access")
async def user_access(user_id: int, admin: Principal = Depends(require_admin)):
    """A user's requests and grants, for the user drawer."""
    async with db.connection() as conn:
        rows = await access.for_user(conn, user_id)
        internal = await access.count_internal_grants(conn, user_id)
    return {"items": [access.out(r, mask=mask_contact) for r in rows[:20]], "internal_grants": internal}
