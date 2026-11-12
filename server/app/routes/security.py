"""The user's own security: overview, "Kræv passkey" (MFA opt-in) and authenticator apps (TOTP).

Passkeys and security keys are registered with /api/auth/passkey/register/* and listed/renamed/deleted under
/api/me/passkeys. Adding or removing a factor, and switching MFA on or off, needs a second factor proven within
STEPUP_MINUTES once the user has one (app.mfa.ensure_can_change_factors); the frontend then runs /api/auth/mfa/*.
"""

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from app import config, db, mfa, settings_store, totp
from app.logs import audit, auth_event
from app.routes.auth import check_totp
from app.sessions import Principal, admin_mfa_ok, create_session, current_user

router = APIRouter(prefix="/api/me", tags=["me"])

MAX_TOTP = 5


class MfaIn(BaseModel):
    required: bool


class TotpSetupIn(BaseModel):
    name: str = Field(default="Godkendelsesapp", min_length=1, max_length=60)


class TotpConfirmIn(BaseModel):
    code: str = Field(min_length=6, max_length=10)


class RenameIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)


@router.get("/security")
async def security_overview(p: Principal = Depends(current_user)):
    """Everything the account page needs in one call: factors, MFA status, /admin status, sessions and advice."""
    s = config.settings
    async with db.connection() as conn:
        user = await db.fetch_one(conn, "select role, mfa_required, yubikey_required, grace_logins_used from users where id = %s",
                                  (p.user_id,))
        f = await mfa.factors(conn, p.user_id)
        keys = await db.fetch_all(conn, """select id, name, kind, yubikey, attestation, enrolled_by is not null as by_admin,
                                                  created_at, last_used_at from passkeys
                                           where user_id = %s order by created_at""", (p.user_id,))
        apps = await db.fetch_all(conn, """select id, name, created_at, last_used_at from totp_factors
                                           where user_id = %s and confirmed_at is not null order by created_at""",
                                  (p.user_id,))
        sessions = await db.fetch_one(conn, """select count(*) as n from sessions where user_id = %s and scope = 'full'
                                               and revoked_at is null and expires_at > now()""", (p.user_id,))
    is_admin = user["role"] == "admin"
    advice = []
    if not f["passkeys"] + f["security_keys"]:
        advice.append("add_passkey")
    if is_admin and not f["total"]:
        advice.append("admin_needs_mfa")
    if f["total"] == 1 and (user["mfa_required"] or is_admin):
        advice.append("add_backup_factor")
    if f["total"] and not user["mfa_required"] and not is_admin:
        advice.append("enable_mfa")
    return {
        "mfa_required": user["mfa_required"],
        "yubikey_required": user["yubikey_required"],
        "factors": f,
        "methods": mfa.methods(f),
        "passkeys": [k for k in keys if k["kind"] == "passkey"],
        "security_keys": [k for k in keys if k["kind"] == "security_key"],
        "totp": apps,
        "session": {
            "mfa_at": p.mfa_at,
            "stepup_ok": mfa.stepup_ok(p),
            "yubikey_at": p.yubikey_at,
            "grace": p.grace,
        },
        "admin": {
            "ok": admin_mfa_ok(p),
            "grace_logins": s.grace_logins,
            "grace_left": max(0, s.grace_logins - user["grace_logins_used"]) if not f["total"] else 0,
            "mfa_hours": s.admin_mfa_hours,
        } if is_admin else None,
        "active_sessions": sessions["n"],
        "advice": advice,
    }


@router.put("/mfa")
async def set_mfa(body: MfaIn, p: Principal = Depends(current_user)):
    """ "Kræv passkey": with it on, a one-time code alone is no longer enough to log in."""
    async with db.connection() as conn:
        f = await mfa.ensure_can_change_factors(conn, p)
        user = await mfa.lock_user(conn, p.user_id)
        if user["mfa_required"] == body.required:
            return {"ok": True, "required": body.required}
        if body.required and not f["total"]:
            raise HTTPException(409, "Opret en passkey, sikkerhedsnøgle eller godkendelsesapp først")
        await conn.execute("update users set mfa_required = %s, updated_at = now() where id = %s",
                           (body.required, p.user_id))
        await audit(conn, "update", actor_id=p.user_id, meta=p.meta, table="users", row_id=p.user_id,
                    before={"mfa_required": user["mfa_required"]}, after={"mfa_required": body.required})
        await auth_event(conn, "mfa.enabled" if body.required else "mfa.disabled", ok=True, meta=p.meta,
                         user_id=p.user_id, contact=p.contact)
    return {"ok": True, "required": body.required}


@router.post("/totp")
async def totp_setup(body: TotpSetupIn | None = None, p: Principal = Depends(current_user)):
    """Starts adding an authenticator app. The secret and QR code are shown once; the factor only counts after
    /api/me/totp/{id}/confirm with a code from the app."""
    name = (body.name if body else "Godkendelsesapp").strip()
    async with db.connection() as conn:
        await mfa.ensure_can_change_factors(conn, p)
        await conn.execute("delete from totp_factors where user_id = %s and confirmed_at is null", (p.user_id,))
        n = await db.fetch_one(conn, "select count(*) as n from totp_factors where user_id = %s", (p.user_id,))
        if n["n"] >= MAX_TOTP:
            raise HTTPException(409, f"Du kan højst have {MAX_TOTP} godkendelsesapps")
        secret = totp.new_secret()
        row = await db.fetch_one(conn, "insert into totp_factors (user_id, name, secret_enc) values (%s, %s, %s) returning id",
                                 (p.user_id, name, totp.encrypt(secret)))
        app_name = (await settings_store.get_all(conn))["app_name"]
    uri = totp.otpauth_uri(secret, p.contact or str(p.user_id), app_name)
    return {"id": row["id"], "secret": secret, "uri": uri, "qr_svg": totp.qr_svg(uri),
            "digits": totp.DIGITS, "period": totp.PERIOD}


@router.post("/totp/{factor_id}/confirm")
async def totp_confirm(factor_id: int, body: TotpConfirmIn, response: Response, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        f = await mfa.ensure_can_change_factors(conn, p)
        pending = await db.fetch_one(conn, """select id, name from totp_factors where id = %s and user_id = %s
                                              and confirmed_at is null and created_at > now() - interval '30 minutes'""",
                                     (factor_id, p.user_id))
        if pending is None:
            raise HTTPException(404, "Opsætningen er udløbet. Start forfra.")
        await check_totp(conn, p, body.code, factor_id=factor_id)
        await conn.execute("update totp_factors set confirmed_at = now() where id = %s", (factor_id,))
        await audit(conn, "create", actor_id=p.user_id, meta=p.meta, table="totp_factors", row_id=factor_id,
                    after={"name": pending["name"], "user_id": p.user_id})
        await auth_event(conn, "totp.registered", ok=True, meta=p.meta, user_id=p.user_id, contact=p.contact,
                         factor_id=factor_id)
        # The code was just proven: new session with a second factor, and grace logins are no longer needed.
        await conn.execute("update sessions set revoked_at = now() where id = %s", (p.session_id,))
        session_id = await create_session(conn, response, p.user_id, "full", p.meta, mfa=True)
        if not f["total"]:
            await mfa.revoke_grace_sessions(conn, p.user_id, session_id)
    return {"ok": True, "id": factor_id}


@router.patch("/totp/{factor_id}")
async def totp_rename(factor_id: int, body: RenameIn, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        before = await db.fetch_one(conn, "select name from totp_factors where id = %s and user_id = %s",
                                    (factor_id, p.user_id))
        if before is None:
            raise HTTPException(404, "Ikke fundet")
        await conn.execute("update totp_factors set name = %s where id = %s", (body.name.strip(), factor_id))
        await audit(conn, "update", actor_id=p.user_id, meta=p.meta, table="totp_factors", row_id=factor_id,
                    before=before, after={"name": body.name.strip()})
    return {"ok": True}


@router.delete("/totp/{factor_id}")
async def totp_delete(factor_id: int, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        f = await mfa.ensure_can_change_factors(conn, p)
        user = await mfa.lock_user(conn, p.user_id)
        row = await db.fetch_one(conn, "select name, confirmed_at from totp_factors where id = %s and user_id = %s",
                                 (factor_id, p.user_id))
        if row is None:
            raise HTTPException(404, "Ikke fundet")
        if row["confirmed_at"] and user["mfa_required"] and f["total"] <= 1:
            raise HTTPException(409, "Slå “Kræv passkey” fra, før du sletter din sidste nøgle")
        await conn.execute("delete from totp_factors where id = %s", (factor_id,))
        await audit(conn, "delete", actor_id=p.user_id, meta=p.meta, table="totp_factors", row_id=factor_id,
                    before={"name": row["name"]})
        await auth_event(conn, "totp.deleted", ok=True, meta=p.meta, user_id=p.user_id, contact=p.contact,
                         factor_id=factor_id)
    return {"ok": True}
