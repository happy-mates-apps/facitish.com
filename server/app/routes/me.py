"""The logged-in user's own account: profile, passkeys, sessions and GDPR requests."""

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from app import config, db, gdpr
from app.logs import audit, auth_event, changed
from app.routes.auth import check_send_limits, consume_code, dev_code_allowed, issue_code, parse_email, parse_phone
from app.security import InvalidEmail, InvalidPhone, normalize_email, normalize_phone
from app.sessions import Principal, clear_session_cookie, current_user, revoke_sessions

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
        await auth_event(conn, "passkey.deleted", ok=True, meta=p.meta, user_id=p.user_id, contact=p.contact,
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
            returning id, due_at""", (p.user_id, body.kind, p.contact, body.message))
        await audit(conn, "gdpr.request", actor_id=p.user_id, meta=p.meta, table="gdpr_requests", row_id=row["id"],
                    after={"kind": body.kind, "status": "received"})
    return {"id": row["id"], "due_at": row["due_at"]}


# ── Self-service GDPR: own data, e-mail and phone number, delete account ─────

@router.get("/export")
async def export_my_data(p: Principal = Depends(current_user)):
    """Right of access without waiting for an admin: a zip with data.json and the user's files."""
    async with db.connection() as conn:
        body = await gdpr.export_zip(conn, p.user_id)
        await audit(conn, "gdpr.export", actor_id=p.user_id, meta=p.meta, table="users", row_id=p.user_id,
                    by_self=True, bytes=len(body))
    return Response(body, media_type="application/zip", headers={
        "Content-Disposition": f'attachment; filename="{gdpr.export_filename(p.user_id)}"'})


class EmailIn(BaseModel):
    email: str = Field(max_length=254)


class EmailVerifyIn(EmailIn):
    code: str = Field(min_length=4, max_length=8)


class PhoneIn(BaseModel):
    phone: str = Field(max_length=32)


class PhoneVerifyIn(PhoneIn):
    code: str = Field(min_length=4, max_length=8)


def _not_test_account(p: Principal) -> None:
    """A test account (/admin → Efterligning) never gets a real e-mail or phone number, so it can never log in on its
    own; it is deleted from /admin, not from the app."""
    if p.impersonator_id is not None:
        raise HTTPException(403, "Ikke muligt for en testkonto")


def _new_contact(channel: str, raw: str, p: Principal) -> str:
    if channel == "phone" and not config.settings.sms_login:
        raise HTTPException(400, "Login med SMS er ikke slået til")
    contact = parse_email(raw) if channel == "email" else parse_phone(raw)
    if contact == getattr(p, channel):
        raise HTTPException(400, "Det er din nuværende e-mailadresse" if channel == "email" else "Det er dit nuværende nummer")
    return contact


def _taken(channel: str) -> HTTPException:
    return HTTPException(409, "E-mailadressen bruges allerede af en anden bruger" if channel == "email"
                         else "Nummeret bruges allerede af en anden bruger")


async def _change_start(channel: str, raw: str, p: Principal) -> dict:
    """Rectification of the e-mail or phone number: a code is sent to the new contact to prove it belongs to the user."""
    _not_test_account(p)
    contact = _new_contact(channel, raw, p)
    purpose = f"{channel}_change"
    async with db.connection() as conn:
        if await db.fetch_one(conn, f"select 1 from users where {channel} = %s", (contact,)):
            raise _taken(channel)
        await check_send_limits(conn, contact, p.meta, purpose=purpose)
        code = await issue_code(conn, channel, contact, p.meta, purpose=purpose, user_id=p.user_id)
    response = {"ok": True, "expires_in": config.settings.otp_ttl_seconds}
    if dev_code_allowed(channel):
        response["dev_code"] = code
    return response


async def _change_verify(channel: str, raw: str, code: str, p: Principal) -> str:
    _not_test_account(p)
    contact = _new_contact(channel, raw, p)
    async with db.connection() as conn:
        await consume_code(conn, contact, code, p.meta, purpose=f"{channel}_change", user_id=p.user_id)
        if await db.fetch_one(conn, f"select 1 from users where {channel} = %s", (contact,)):
            raise _taken(channel)
        await conn.execute(f"update users set {channel} = %s, updated_at = now() where id = %s", (contact, p.user_id))
        await audit(conn, "update", actor_id=p.user_id, meta=p.meta, table="users", row_id=p.user_id,
                    before={channel: getattr(p, channel)}, after={channel: contact})
        await auth_event(conn, f"{channel}.changed", ok=True, meta=p.meta, user_id=p.user_id, contact=contact)
        # Other devices were logged in under the old contact: log them out.
        await conn.execute("""update sessions set revoked_at = now()
                              where user_id = %s and id <> %s and revoked_at is null""", (p.user_id, p.session_id))
    return contact


@router.post("/email/start")
async def change_email_start(body: EmailIn, p: Principal = Depends(current_user)):
    return await _change_start("email", body.email, p)


@router.post("/email/verify")
async def change_email_verify(body: EmailVerifyIn, p: Principal = Depends(current_user)):
    return {"ok": True, "email": await _change_verify("email", body.email, body.code, p)}


@router.post("/phone/start")
async def change_phone_start(body: PhoneIn, p: Principal = Depends(current_user)):
    return await _change_start("phone", body.phone, p)


@router.post("/phone/verify")
async def change_phone_verify(body: PhoneVerifyIn, p: Principal = Depends(current_user)):
    return {"ok": True, "phone": await _change_verify("phone", body.phone, body.code, p)}


class DeleteAccountIn(BaseModel):
    confirm: str | None = Field(default=None, max_length=254)        # the user's e-mail address or phone number
    confirm_phone: str | None = Field(default=None, max_length=32)   # older clients


def _confirms(value: str, p: Principal) -> bool:
    try:
        if "@" in value:
            return p.email is not None and normalize_email(value) == p.email
        return p.phone is not None and normalize_phone(value) == p.phone
    except (InvalidEmail, InvalidPhone):
        return False


@router.post("/delete")
async def delete_my_account(body: DeleteAccountIn, response: Response, p: Principal = Depends(current_user)):
    """The right to be forgotten, done by the user. The e-mail address (or phone number) must be typed as confirmation."""
    _not_test_account(p)
    if not _confirms(body.confirm or body.confirm_phone or "", p):
        raise HTTPException(400, "E-mailadressen passer ikke" if p.email else "Telefonnummeret passer ikke")
    result = await gdpr.erase_user(p.user_id, actor_id=p.user_id, meta=p.meta, reason="self_service")
    clear_session_cookie(response, p.meta.embedded)
    return {"ok": True, **result}
