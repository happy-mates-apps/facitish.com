"""The logged-in user's own account: profile, avatar, passkeys, sessions and GDPR requests.
Second factors, "Kræv passkey" and the security overview are in routes/security.py."""

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field

from app import config, db, gdpr, mfa, webhooks
from app.logs import audit, auth_event, changed
from app.routes.auth import check_send_limits, consume_code, dev_code_allowed, issue_code, parse_email, parse_phone
from app.routes.files import delete_file, save_upload
from app.security import InvalidEmail, InvalidPhone, normalize_email, normalize_phone
from app.sessions import Principal, clear_session_cookie, current_user, revoke_sessions
from app.storage import get_storage

router = APIRouter(prefix="/api/me", tags=["me"])

LOCALES = ("da", "en")
AVATAR_TYPES = {b"\x89PNG\r\n\x1a\n": "image/png", b"\xff\xd8\xff": "image/jpeg", b"RIFF": "image/webp"}
AVATAR_MAX_BYTES = 2 * 1024 * 1024


class ProfileIn(BaseModel):
    """Only the fields that are sent are changed. Empty string or null clears a field."""
    display_name: str | None = Field(default=None, max_length=80)
    locale: str | None = Field(default=None, max_length=5)
    time_zone: str | None = Field(default=None, max_length=64)


def clean_profile(body: ProfileIn) -> dict:
    """Validated profile values for the fields that were sent. Shared with /api/admin/users/{id}/profile."""
    values = {}
    for name in body.model_fields_set:
        value = (getattr(body, name) or "").strip() or None
        if name == "locale" and value is not None and value not in LOCALES:
            raise HTTPException(400, "Sproget skal være da eller en")
        if name == "time_zone" and value is not None:
            try:
                ZoneInfo(value)
            except (ZoneInfoNotFoundError, ValueError):
                raise HTTPException(400, "Ukendt tidszone")
        values[name] = value
    return values


async def update_profile_fields(conn, user_id: int, values: dict, *, actor_id: int, meta) -> None:
    if not values:
        return
    cols = ", ".join(values)
    before = await db.fetch_one(conn, f"select {cols} from users where id = %s for update", (user_id,))
    if before is None:
        raise HTTPException(404, "Brugeren findes ikke")
    sets = ", ".join(f"{c} = %({c})s" for c in values)
    await conn.execute(f"update users set {sets}, updated_at = now() where id = %(id)s", {**values, "id": user_id})
    b, a = changed(before, values)
    if a:
        await audit(conn, "update", actor_id=actor_id, meta=meta, table="users", row_id=user_id, before=b, after=a)


class RenameIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)


class GdprIn(BaseModel):
    kind: str = Field(pattern="^(access|rectification|erasure)$")
    message: str = Field(default="", max_length=4000)


@router.get("/profile")
async def get_profile(p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        user = await db.fetch_one(conn, """
            select id, email, phone, display_name, locale, time_zone, avatar_file_id is not null as has_avatar,
                   role, created_at from users where id = %s""", (p.user_id,))
    has_avatar = user.pop("has_avatar")
    return {**user, "avatar_url": "/api/me/avatar" if has_avatar else None, "locales": list(LOCALES)}


@router.patch("/profile")
async def update_profile(body: ProfileIn, p: Principal = Depends(current_user)):
    values = clean_profile(body)
    async with db.connection() as conn:
        await update_profile_fields(conn, p.user_id, values, actor_id=p.user_id, meta=p.meta)
    return {"ok": True}


def _avatar_type(data: bytes) -> str | None:
    for magic, content_type in AVATAR_TYPES.items():
        if data.startswith(magic) and (content_type != "image/webp" or data[8:12] == b"WEBP"):
            return content_type
    return None


@router.put("/avatar")
async def set_avatar(file: UploadFile, p: Principal = Depends(current_user)):
    """PNG, JPEG or WebP up to 2 MB, checked by content (not by the file name). Replaces the old avatar."""
    if p.impersonator_id is not None:
        raise HTTPException(403, "Ikke muligt for en testkonto")
    head = await file.read(AVATAR_MAX_BYTES + 1)
    if len(head) > AVATAR_MAX_BYTES:
        raise HTTPException(413, "Billedet må højst fylde 2 MB")
    content_type = _avatar_type(head)
    if content_type is None:
        raise HTTPException(400, "Brug et PNG-, JPEG- eller WebP-billede")
    await file.seek(0)
    async with db.connection() as conn:
        old = await db.fetch_one(conn, "select avatar_file_id from users where id = %s for update", (p.user_id,))
        row = await save_upload(conn, file, owner_id=p.user_id, actor=p, prefix=f"avatars/{p.user_id}",
                                content_type=content_type, kind="avatar")
        await conn.execute("update users set avatar_file_id = %s, updated_at = now() where id = %s", (row["id"], p.user_id))
        await audit(conn, "update", actor_id=p.user_id, meta=p.meta, table="users", row_id=p.user_id,
                    before={"avatar_file_id": str(old["avatar_file_id"]) if old["avatar_file_id"] else None},
                    after={"avatar_file_id": str(row["id"])})
        if old["avatar_file_id"]:
            await delete_file(conn, old["avatar_file_id"], p, owner_id=p.user_id)
    return {"ok": True, "avatar_url": "/api/me/avatar"}


@router.get("/avatar")
async def get_avatar(p: Principal = Depends(current_user)):
    return await avatar_response(p.user_id)


async def avatar_response(user_id: int) -> Response:
    """The image itself (small, ≤ 2 MB), served by the server so it works with the CSP and without public links.
    Also used by /api/admin/users/{id}/avatar."""
    async with db.connection() as conn:
        row = await db.fetch_one(conn, """select f.storage_key, f.content_type from users u join files f on f.id = u.avatar_file_id
                                          where u.id = %s and f.kind = 'avatar'""", (user_id,))
    if row is None:
        raise HTTPException(404, "Intet profilbillede")
    data, _ = await get_storage().get(row["storage_key"])
    return Response(data, media_type=row["content_type"],
                    headers={"Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff"})


@router.delete("/avatar")
async def delete_avatar(p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        old = await db.fetch_one(conn, "select avatar_file_id from users where id = %s for update", (p.user_id,))
        if old["avatar_file_id"] is None:
            return {"ok": True}
        await conn.execute("update users set avatar_file_id = null, updated_at = now() where id = %s", (p.user_id,))
        await audit(conn, "update", actor_id=p.user_id, meta=p.meta, table="users", row_id=p.user_id,
                    before={"avatar_file_id": str(old["avatar_file_id"])}, after={"avatar_file_id": None})
        await delete_file(conn, old["avatar_file_id"], p, owner_id=p.user_id)
    return {"ok": True}


@router.get("/passkeys")
async def list_passkeys(p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        return await db.fetch_all(conn, """
            select id, name, kind, created_at, last_used_at from passkeys where user_id = %s order by created_at""",
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
        f = await mfa.ensure_can_change_factors(conn, p)
        user = await mfa.lock_user(conn, p.user_id)
        if user["mfa_required"] and f["total"] <= 1:
            raise HTTPException(409, "Slå “Kræv passkey” fra, før du sletter din sidste nøgle")
        row = await db.fetch_one(conn, "delete from passkeys where id = %s and user_id = %s returning name, kind",
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
            select s.id, s.created_at, s.last_seen_at, s.expires_at, host(s.ip) as ip, s.user_agent,
                   c.name as mcp_client, s.mcp_scope
            from sessions s left join mcp_clients c on c.id = s.mcp_client_id
            where s.user_id = %s and s.revoked_at is null and s.expires_at > now() and s.scope = 'full'
            order by s.last_seen_at desc""", (p.user_id,))
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
        await webhooks.emit(conn, "gdpr.request.created", {"id": row["id"], "kind": body.kind, "source": "user"})
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
        await mfa.require_recent_mfa(conn, p)  # a stolen code alone must not move the login elsewhere
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
        await mfa.require_recent_mfa(conn, p)
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
    async with db.connection() as conn:
        await mfa.require_recent_mfa(conn, p)
    result = await gdpr.erase_user(p.user_id, actor_id=p.user_id, meta=p.meta, reason="self_service")
    clear_session_cookie(response, p.meta.embedded)
    return {"ok": True, **result}
