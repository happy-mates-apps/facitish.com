"""Enrolling a YubiKey that counts for the YubiKey requirement (users.yubikey_required, app.mfa).

Two ways, both started by an admin in /admin/users/<id> (section Brugere, step-up):

  in person  POST /api/admin/users/{id}/yubikey/options + /verify
             The user is at the admin's computer with the key and sets its PIN. The key is registered for the user
             without a discoverable credential and with enrolled_by = the admin: because the admin held it, it is only
             ever a second factor after the user's own code (routes/auth.py refuses it as a login on its own).
             Only the super admin may do this for another admin (the rule of reset-mfa).
  link       POST /api/admin/users/{id}/yubikey/link mails the user a single-use link (YUBIKEY_LINK_HOURS).
             The user opens /konto#yubikey=<token>, logs in and registers the key themselves:
             POST /api/auth/yubikey/enroll/options + /verify.

Either way the key must be a YubiKey by its attestation (app.yubikey), or it is refused.
"""

import json
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from webauthn import generate_registration_options, options_to_json, verify_registration_response
from webauthn.helpers.exceptions import InvalidRegistrationResponse
from webauthn.helpers.structs import (AttestationConveyancePreference, AuthenticatorAttachment,
                                      AuthenticatorSelectionCriteria, PublicKeyCredentialDescriptor,
                                      ResidentKeyRequirement, UserVerificationRequirement)

from app import config, db, mfa, outbound_mail, settings_store, yubikey
from app.logs import audit, auth_event
from app.mail import MailError, send_mail, yubikey_link_mail
from app.routes.admin import _ensure_may_reset, _user_or_404
from app.security import new_token, token_hash
from app.sessions import Principal, create_session, current_user, require_admin_stepup

admin_router = APIRouter(prefix="/api/admin/users", tags=["admin"])
router = APIRouter(prefix="/api/auth/yubikey", tags=["auth"])


class EnrollIn(BaseModel):
    challenge_id: str
    credential: dict
    name: str | None = Field(default=None, max_length=60)


def _options(user: dict, existing: list[dict], *, discoverable: bool):
    s = config.settings
    contact = user["email"] or user["phone"] or str(user["id"])
    return generate_registration_options(
        rp_id=s.rp_id, rp_name=s.rp_name, user_id=str(user["id"]).encode(), user_name=contact,
        user_display_name=user["display_name"] or contact,
        authenticator_selection=AuthenticatorSelectionCriteria(
            authenticator_attachment=AuthenticatorAttachment.CROSS_PLATFORM,
            resident_key=ResidentKeyRequirement.PREFERRED if discoverable else ResidentKeyRequirement.DISCOURAGED,
            user_verification=UserVerificationRequirement.REQUIRED),
        exclude_credentials=[PublicKeyCredentialDescriptor(id=bytes(r["credential_id"])) for r in existing],
        attestation=AttestationConveyancePreference.DIRECT)


async def _store(conn, challenge: bytes, user_id: int, actor_id: int | None) -> str:
    challenge_id = secrets.token_urlsafe(24)
    await conn.execute("""insert into webauthn_challenges (id, challenge, kind, user_id, actor_id, expires_at)
                          values (%s, %s, 'enroll', %s, %s, %s)""",
                       (challenge_id, challenge, user_id, actor_id, datetime.now(timezone.utc) + timedelta(minutes=5)))
    return challenge_id


async def _take(conn, challenge_id: str, user_id: int, actor_id: int | None) -> bytes:
    row = await db.fetch_one(conn, """delete from webauthn_challenges where id = %s and kind = 'enroll' and expires_at > now()
                                      returning challenge, user_id, actor_id""", (challenge_id,))
    if row is None or row["user_id"] != user_id or row["actor_id"] != actor_id:
        raise HTTPException(400, "Forespørgslen er udløbet. Prøv igen.")
    return bytes(row["challenge"])


async def _register(conn, *, user: dict, body: EnrollIn, challenge: bytes, meta, actor_id: int,
                    enrolled_by: int | None, via: str) -> int:
    """Verifies the registration and its YubiKey attestation, stores the key. Raises 400 (logged) otherwise."""
    s = config.settings
    contact = user["email"] or user["phone"]
    try:
        verified = verify_registration_response(credential=body.credential, expected_challenge=challenge,
                                                expected_rp_id=s.rp_id, expected_origin=s.origin,
                                                require_user_verification=True)
    except InvalidRegistrationResponse as e:
        await auth_event(conn, "yubikey.enrolled", ok=False, meta=meta, user_id=user["id"], contact=contact,
                         reason=str(e), via=via, by=actor_id)
        await conn.commit()
        raise HTTPException(400, "Nøglen kunne ikke registreres. Den skal have en PIN-kode.")
    att = yubikey.inspect(body.credential, expected_challenge=challenge)
    if not att.yubikey:
        await auth_event(conn, "yubikey.enrolled", ok=False, meta=meta, user_id=user["id"], contact=contact,
                         reason=att.reason, via=via, by=actor_id)
        await conn.commit()
        raise HTTPException(400, "Nøglen er ikke en YubiKey, eller den viste ikke, hvem der har lavet den. "
                                 "Tillad browseren at se nøglens model, og prøv igen.")
    transports = body.credential.get("response", {}).get("transports") or []
    name = (body.name or "").strip() or "YubiKey"
    row = await db.fetch_one(conn, """
        insert into passkeys (user_id, credential_id, public_key, sign_count, transports, name, kind,
                              yubikey, attestation, aaguid, enrolled_by)
        values (%s, %s, %s, %s, %s, %s, 'security_key', true, %s, %s, %s) returning id""",
        (user["id"], verified.credential_id, verified.credential_public_key, verified.sign_count, transports, name,
         att.attestation, att.aaguid, enrolled_by))
    await auth_event(conn, "yubikey.enrolled", ok=True, meta=meta, user_id=user["id"], contact=contact,
                     passkey_id=row["id"], attestation=att.attestation, via=via, by=actor_id)
    await audit(conn, "create", actor_id=actor_id, meta=meta, table="passkeys", row_id=row["id"],
                after={"name": name, "kind": "security_key", "yubikey": True, "attestation": att.attestation,
                       "user_id": user["id"], "enrolled_by": enrolled_by}, subject_user_id=user["id"], via=via)
    return row["id"]


# ── Admin: in person ────────────────────────────────────────────────────────

async def _target(conn, user_id: int, admin: Principal) -> dict:
    user = await _user_or_404(conn, user_id, admin)
    if user["impersonation_only"]:
        raise HTTPException(409, "Testkonti har ingen nøgler")
    if user["blocked_at"]:
        raise HTTPException(409, "Brugeren er spærret")
    return user


@admin_router.post("/{user_id}/yubikey/options")
async def admin_enroll_options(user_id: int, admin: Principal = Depends(require_admin_stepup)):
    async with db.connection() as conn:
        user = await _target(conn, user_id, admin)
        await _ensure_may_reset(user, admin)
        existing = await db.fetch_all(conn, "select credential_id from passkeys where user_id = %s", (user_id,))
        options = _options(user, existing, discoverable=False)
        challenge_id = await _store(conn, options.challenge, user_id, admin.user_id)
    return {"challenge_id": challenge_id, "options": json.loads(options_to_json(options))}


@admin_router.post("/{user_id}/yubikey/verify")
async def admin_enroll_verify(user_id: int, body: EnrollIn, admin: Principal = Depends(require_admin_stepup)):
    async with db.connection() as conn:
        user = await _target(conn, user_id, admin)
        await _ensure_may_reset(user, admin)
        challenge = await _take(conn, body.challenge_id, user_id, admin.user_id)
        passkey_id = await _register(conn, user=user, body=body, challenge=challenge, meta=admin.meta,
                                     actor_id=admin.user_id, enrolled_by=admin.user_id, via="admin")
    return {"ok": True, "passkey_id": passkey_id}


# ── Admin: link ─────────────────────────────────────────────────────────────

@admin_router.post("/{user_id}/yubikey/link")
async def admin_enroll_link(user_id: int, admin: Principal = Depends(require_admin_stepup)):
    """Mails the user a single-use link to add a YubiKey themselves. A new link replaces an unused one."""
    s = config.settings
    async with db.connection() as conn:
        user = await _target(conn, user_id, admin)
        if user["id"] == admin.user_id:
            raise HTTPException(409, "Din egen YubiKey tilføjer du under Konto")
        if not user["email"]:
            raise HTTPException(409, "Brugeren har ingen e-mailadresse")
        token = new_token()
        await conn.execute("""update yubikey_enrollments set expires_at = now()
                              where user_id = %s and used_at is null and expires_at > now()""", (user_id,))
        row = await db.fetch_one(conn, """
            insert into yubikey_enrollments (user_id, token_hash, created_by, expires_at)
            values (%s, %s, %s, now() + make_interval(hours => %s)) returning id, expires_at""",
            (user_id, token_hash(token), admin.user_id, s.yubikey_link_hours))
        values = await settings_store.get_all(conn)
        link = f"{s.origin.rstrip('/')}/konto#yubikey={token}"
        subject, text, html_body = yubikey_link_mail(values["app_name"], link, s.yubikey_link_hours)
        try:
            message_id = await send_mail(user["email"], subject, text, html_body, values["app_name"])
        except MailError:
            raise HTTPException(502, "Vi kunne ikke sende mailen. Prøv igen.")
        await outbound_mail.record_sent(conn, message_id=message_id, recipient=user["email"], user_id=user_id,
                                        purpose="other", subject=subject)
        await audit(conn, "create", actor_id=admin.user_id, meta=admin.meta, table="yubikey_enrollments",
                    row_id=row["id"], subject_user_id=user_id, after={"expires_at": row["expires_at"].isoformat()})
    out = {"ok": True, "expires_at": row["expires_at"]}
    if s.mail_provider == "console" and not s.is_production:
        out["dev_token"] = token
    return out


# ── The user, with the link ─────────────────────────────────────────────────

class TokenIn(BaseModel):
    token: str = Field(min_length=20, max_length=200)


class LinkEnrollIn(EnrollIn):
    token: str = Field(min_length=20, max_length=200)


async def _enrollment(conn, token: str, principal: Principal) -> dict:
    row = await db.fetch_one(conn, """select * from yubikey_enrollments where token_hash = %s
                                      and used_at is null and expires_at > now() for update""", (token_hash(token),))
    if row is None or row["user_id"] != principal.user_id:
        raise HTTPException(400, "Linket er udløbet, allerede brugt eller til en anden bruger. Bed om et nyt.")
    return row


@router.post("/enroll/check")
async def enroll_check(body: TokenIn, principal: Principal = Depends(current_user)):
    """Is the link valid for the logged-in user? Lets /konto show the right message before the key is needed."""
    async with db.connection() as conn:
        row = await _enrollment(conn, body.token, principal)
    return {"ok": True, "expires_at": row["expires_at"]}


@router.post("/enroll/options")
async def enroll_options(body: TokenIn, principal: Principal = Depends(current_user)):
    async with db.connection() as conn:
        await mfa.ensure_can_change_factors(conn, principal)
        await _enrollment(conn, body.token, principal)
        user = await db.fetch_one(conn, "select id, email, phone, display_name from users where id = %s",
                                  (principal.user_id,))
        existing = await db.fetch_all(conn, "select credential_id from passkeys where user_id = %s", (principal.user_id,))
        options = _options(user, existing, discoverable=True)
        challenge_id = await _store(conn, options.challenge, principal.user_id, None)
    return {"challenge_id": challenge_id, "options": json.loads(options_to_json(options))}


@router.post("/enroll/verify")
async def enroll_verify(body: LinkEnrollIn, response: Response, principal: Principal = Depends(current_user)):
    async with db.connection() as conn:
        f = await mfa.ensure_can_change_factors(conn, principal)
        enrollment = await _enrollment(conn, body.token, principal)
        challenge = await _take(conn, body.challenge_id, principal.user_id, None)
        user = await db.fetch_one(conn, "select id, email, phone, display_name from users where id = %s",
                                  (principal.user_id,))
        passkey_id = await _register(conn, user=user, body=body, challenge=challenge, meta=principal.meta,
                                     actor_id=principal.user_id, enrolled_by=None, via="link")
        await conn.execute("update yubikey_enrollments set used_at = now(), passkey_id = %s where id = %s",
                           (passkey_id, enrollment["id"]))
        # The key was just used with its PIN: a new session that has proven a YubiKey (gaer-auth: new token).
        await conn.execute("update sessions set revoked_at = now() where id = %s", (principal.session_id,))
        session_id = await create_session(conn, response, principal.user_id, "full", principal.meta, mfa=True,
                                          yubikey=True)
        if not f["total"]:
            await mfa.revoke_grace_sessions(conn, principal.user_id, session_id)
    return {"ok": True, "passkey_id": passkey_id}
