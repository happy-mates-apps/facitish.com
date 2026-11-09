"""Login: e-mail address + one-time code; passkeys are offered to everyone and required where MFA applies.
With SMS_LOGIN=1 a phone number + code sent by SMS works the same way (opt-in).

  0. GET  /captcha        a proof-of-work challenge (app.captcha); /otp/start needs its solution unless CAPTCHA=off
  1. POST /otp/start      sends a code (stored only as a hash, short-lived, single use)
  2. POST /otp/verify     the first user on a new instance becomes admin and super admin.
                          "Kræv passkey" switched on (users.mfa_required) -> pending 'mfa' session, see 5.
                          Otherwise -> full session. An admin without a second factor uses one of GRACE_LOGINS
                          grace logins (the session may enter /admin); everybody else is offered a passkey.
  3. POST /passkey/register/*  adds a passkey or security key (full session; see app.mfa for when a recent second
                          factor is needed first).
  4. POST /passkey/login/*     login with a passkey. Counts as MFA when the authenticator verified the user.
  5. POST /mfa/*               the second factor (passkey/security key with user verification, or an authenticator
                          app). Completes a pending login or steps up a full session; always issues a new session.

The rules are described in the gaer-auth skill and must not be bypassed.
"""

import json
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from webauthn import (base64url_to_bytes, generate_authentication_options, generate_registration_options,
                      options_to_json, verify_authentication_response, verify_registration_response)
from webauthn.helpers.exceptions import InvalidAuthenticationResponse, InvalidRegistrationResponse
from webauthn.helpers.structs import (AuthenticatorAttachment, AuthenticatorSelectionCriteria,
                                      PublicKeyCredentialDescriptor, ResidentKeyRequirement,
                                      UserVerificationRequirement)

from app import admin_roles, captcha, config, db, mfa, settings_store, totp, webhooks
from app.logs import RequestMeta, audit, auth_event
from app.mail import MailError, otp_mail, send_mail
from app.security import (InvalidEmail, InvalidPhone, bootstrap_admin_email, bootstrap_admin_phone, new_otp_code,
                          normalize_email, normalize_phone, otp_hash, otp_matches, phone_hash)
from app.sessions import (IMP_COOKIE, Principal, admin_mfa_ok, any_session, clear_session_cookie, create_session,
                          current_user, optional_principal, request_meta, revoke_sessions)
from app.sms import SmsError, otp_message, send_sms

router = APIRouter(prefix="/api/auth", tags=["auth"])

CHANNELS = ("email", "phone")  # also the users column the contact is stored in


class ContactIn(BaseModel):
    email: str | None = Field(default=None, max_length=254)
    phone: str | None = Field(default=None, max_length=32)


class StartIn(ContactIn):
    captcha: str | None = Field(default=None, max_length=2000)  # base64 solution from GET /captcha


class VerifyIn(ContactIn):
    code: str = Field(min_length=4, max_length=8)


class RegisterIn(BaseModel):
    challenge_id: str
    credential: dict
    name: str | None = Field(default=None, max_length=60)


class LoginIn(BaseModel):
    challenge_id: str
    credential: dict


def parse_email(raw: str) -> str:
    try:
        return normalize_email(raw)
    except InvalidEmail as e:
        raise HTTPException(400, str(e))


def parse_phone(raw: str) -> str:
    try:
        return normalize_phone(raw)
    except InvalidPhone as e:
        raise HTTPException(400, str(e))


def _contact(body: ContactIn) -> tuple[str, str]:
    """(channel, normalized contact). A phone number is only accepted when SMS login is switched on."""
    if body.email:
        return "email", parse_email(body.email)
    if body.phone:
        if not config.settings.sms_login:
            raise HTTPException(400, "Log ind med din e-mailadresse")
        return "phone", parse_phone(body.phone)
    raise HTTPException(400, "Skriv din e-mailadresse")


def dev_code_allowed(channel: str) -> bool:
    """In development the console providers print the code, and the API returns it to the login page."""
    s = config.settings
    provider = s.mail_provider if channel == "email" else s.sms_provider
    return provider == "console" and not s.is_production


async def _count_events(conn, event: str, *, since_minutes: int, contact: str | None = None,
                        ip: str | None = None, result: str | None = None) -> int:
    where = ["event = %s", "ts > now() - make_interval(mins => %s)"]
    params: list = [event, since_minutes]
    if contact:
        where.append("phone_hash = %s")
        params.append(phone_hash(contact))
    if ip:
        where.append("ip = %s")
        params.append(ip)
    if result:
        where.append("result = %s")
        params.append(result)
    row = await db.fetch_one(conn, f"select count(*) as n from auth_log where {' and '.join(where)}", params)
    return row["n"]


async def _is_locked(conn, contact: str) -> bool:
    s = config.settings
    failed = await _count_events(conn, "otp.failed", since_minutes=s.otp_lock_minutes, contact=contact)
    return failed >= s.otp_max_attempts


# ── One-time codes ──────────────────────────────────────────────────────────

async def check_send_limits(conn, contact: str, meta: RequestMeta, **detail) -> None:
    """Lock after too many wrong codes, and rate limits per contact and per IP. Raises 429 (and logs it)."""
    s = config.settings
    if await _is_locked(conn, contact):
        await auth_event(conn, "otp.sent", ok=False, meta=meta, contact=contact, reason="locked", **detail)
        await conn.commit()
        raise HTTPException(429, "For mange forkerte forsøg. Prøv igen om lidt.")
    per_contact = await _count_events(conn, "otp.sent", since_minutes=60, contact=contact, result="ok")
    per_ip = await _count_events(conn, "otp.sent", since_minutes=60, ip=meta.ip, result="ok") if meta.ip else 0
    if per_contact >= s.otp_max_per_phone_per_hour or per_ip >= s.otp_max_per_ip_per_hour:
        await auth_event(conn, "otp.sent", ok=False, meta=meta, contact=contact, reason="rate_limited", **detail)
        await conn.commit()
        raise HTTPException(429, "Der er sendt for mange koder. Prøv igen senere.")


async def issue_code(conn, channel: str, contact: str, meta: RequestMeta, *, purpose: str = "login",
                     user_id: int | None = None) -> str:
    """Stores a new one-time code (hashed) for the contact and purpose, and sends it by e-mail or SMS."""
    s = config.settings
    code = new_otp_code()
    await conn.execute("""update otp_codes set consumed_at = now()
                          where recipient = %s and purpose = %s and consumed_at is null""", (contact, purpose))
    await conn.execute("""insert into otp_codes (recipient, purpose, user_id, code_hash, expires_at)
                          values (%s, %s, %s, %s, now() + make_interval(secs => %s))""",
                       (contact, purpose, user_id, otp_hash(contact, code), s.otp_ttl_seconds))
    values = await settings_store.get_all(conn)
    minutes = max(1, s.otp_ttl_seconds // 60)
    detail = {"channel": channel} | ({} if purpose == "login" else {"purpose": purpose})
    try:
        if channel == "email":
            subject, text, body = otp_mail(code, values["app_name"], minutes)
            await send_mail(contact, subject, text, body, values["app_name"])
        else:
            await send_sms(contact, otp_message(code, values["app_name"], minutes), values["sms_sender"])
    except (MailError, SmsError) as e:
        await conn.rollback()
        await auth_event(conn, "otp.sent", ok=False, meta=meta, contact=contact, user_id=user_id,
                         reason=f"{'mail' if channel == 'email' else 'sms'}_error", error=str(e), **detail)
        await conn.commit()
        raise HTTPException(502, "Vi kunne ikke sende mailen. Prøv igen." if channel == "email"
                            else "Vi kunne ikke sende SMS'en. Prøv igen.")
    await auth_event(conn, "otp.sent", ok=True, meta=meta, contact=contact, user_id=user_id, **detail)
    return code


async def consume_code(conn, contact: str, code: str, meta: RequestMeta, *, purpose: str = "login",
                       user_id: int | None = None) -> None:
    """Checks a one-time code and marks it used. Wrong codes count towards the lock. Raises 400/429."""
    s = config.settings
    detail = {} if purpose == "login" else {"purpose": purpose}
    if await _is_locked(conn, contact):
        await auth_event(conn, "otp.failed", ok=False, meta=meta, contact=contact, reason="locked", **detail)
        await conn.commit()
        raise HTTPException(429, "For mange forkerte forsøg. Prøv igen om lidt.")
    otp = await db.fetch_one(conn, """
        select id, code_hash, attempts from otp_codes
        where recipient = %s and purpose = %s and consumed_at is null and expires_at > now()
          and (%s::bigint is null or user_id = %s)
        order by created_at desc limit 1 for update""", (contact, purpose, user_id, user_id))
    if otp is None or not otp_matches(contact, code.strip(), otp["code_hash"]):
        if otp is not None:
            attempts = otp["attempts"] + 1
            await conn.execute(
                "update otp_codes set attempts = %s, consumed_at = case when %s then now() end where id = %s",
                (attempts, attempts >= s.otp_max_attempts, otp["id"]))
        await auth_event(conn, "otp.failed", ok=False, meta=meta, contact=contact, user_id=user_id,
                         reason="no_active_code" if otp is None else "wrong_code", **detail)
        await conn.commit()
        raise HTTPException(400, "Koden er forkert eller udløbet")
    await conn.execute("update otp_codes set consumed_at = now() where id = %s", (otp["id"],))


@router.get("/captcha")
async def captcha_challenge():
    """A new proof-of-work challenge. Public: it is what stands in front of account creation and login."""
    if not captcha.enabled():
        return {"enabled": False}
    return {"enabled": True, **captcha.new_challenge()}


@router.post("/otp/start")
async def otp_start(body: StartIn, request: Request):
    s = config.settings
    meta = request_meta(request)
    channel, contact = _contact(body)
    async with db.connection() as conn:
        if captcha.enabled():
            try:
                await captcha.verify(conn, body.captcha)
            except captcha.CaptchaError as e:
                await auth_event(conn, "otp.sent", ok=False, meta=meta, contact=contact, reason="captcha",
                                 captcha=str(e))
                await conn.commit()
                raise HTTPException(400, "Robottjekket mangler eller er udløbet. Prøv igen.")
        await check_send_limits(conn, contact, meta)
        user = await db.fetch_one(conn, f"select id, blocked_at from users where {channel} = %s", (contact,))
        if user and user["blocked_at"]:
            # Answer as usual so the endpoint does not reveal which contacts are blocked.
            await auth_event(conn, "otp.sent", ok=False, meta=meta, contact=contact, user_id=user["id"],
                             reason="blocked")
            return {"ok": True, "expires_in": s.otp_ttl_seconds}
        code = await issue_code(conn, channel, contact, meta, user_id=user["id"] if user else None)

    response = {"ok": True, "expires_in": s.otp_ttl_seconds}
    if dev_code_allowed(channel):
        response["dev_code"] = code
    return response


@router.post("/otp/verify")
async def otp_verify(body: VerifyIn, request: Request, response: Response):
    s = config.settings
    meta = request_meta(request)
    channel, contact = _contact(body)
    async with db.connection() as conn:
        await consume_code(conn, contact, body.code, meta)
        user = await _get_or_create_user(conn, channel, contact, meta)
        if user["blocked_at"]:
            await auth_event(conn, "otp.verified", ok=False, meta=meta, contact=contact, user_id=user["id"],
                             reason="blocked")
            await conn.commit()
            raise HTTPException(403, "Din bruger er spærret. Kontakt en administrator.")
        await auth_event(conn, "otp.verified", ok=True, meta=meta, contact=contact, user_id=user["id"])
        return await _after_first_factor(conn, response, user, meta, contact=contact, via="otp")


async def _after_first_factor(conn, response: Response, user: dict, meta: RequestMeta, *, contact: str | None,
                              via: str) -> dict:
    """The user proved one factor (a code, or a passkey without user verification). Decides between a pending
    'mfa' session and a full one, and uses an admin grace login when the admin has no second factor yet."""
    s = config.settings
    f = await mfa.factors(conn, user["id"])
    if user["mfa_required"]:
        # Fails closed: with "Kræv passkey" on and no factor left, only an admin can help (reset MFA).
        await create_session(conn, response, user["id"], "mfa", meta)
        await auth_event(conn, "mfa.pending", ok=True, meta=meta, contact=contact, user_id=user["id"], via=via)
        return {"status": "mfa_required", "methods": mfa.methods(f)}
    grace, grace_left = False, None
    if user["role"] == "admin" and not f["total"]:
        used = user["grace_logins_used"]
        if used < s.grace_logins:
            used += 1
            grace = True
            await conn.execute("update users set grace_logins_used = %s where id = %s", (used, user["id"]))
            await auth_event(conn, "grace.used", ok=True, meta=meta, contact=contact, user_id=user["id"],
                             used=used, of=s.grace_logins)
        grace_left = s.grace_logins - used
    await conn.execute("update users set last_login_at = now(), updated_at = now() where id = %s", (user["id"],))
    await create_session(conn, response, user["id"], "full", meta, grace=grace)
    return {"status": "logged_in", "offer_passkey": not (f["passkeys"] + f["security_keys"]),
            "admin": user["role"] == "admin", "admin_grace_left": grace_left,
            "became_admin": user.get("became_admin", False)}


def _bootstrap() -> dict[str, str | None]:
    """BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PHONE per channel. The phone number only counts with SMS login."""
    return {"email": bootstrap_admin_email(),
            "phone": bootstrap_admin_phone() if config.settings.sms_login else None}


async def admin_open_to_anyone(conn) -> bool:
    """True when the next person to log in becomes admin: a new instance without a bootstrap contact."""
    if any(_bootstrap().values()):
        return False
    return (await db.fetch_one(conn, "select not exists (select 1 from users) as open"))["open"]


async def _get_or_create_user(conn, channel: str, contact: str, meta: RequestMeta) -> dict:
    """Creates the user on first login and decides who becomes admin:
    - a bootstrap contact is set: only that contact becomes admin, and only while the instance has no admin.
      If it already exists as a normal user then, it is promoted.
    - none set: the very first user to register becomes admin.
    The first admin of the instance is also its super admin."""
    assert channel in CHANNELS
    bootstraps = _bootstrap()
    bootstrap = bootstraps[channel]
    user = await db.fetch_one(conn, f"select * from users where {channel} = %s for update", (contact,))
    if user and user["impersonation_only"]:
        raise HTTPException(403, "Testkonti kan ikke logge ind")
    if user and (contact != bootstrap or user["role"] == "admin"):
        return user  # the normal case: an existing user, no admin decision to make
    # Creating a user or promoting the bootstrap contact: serialize so only one becomes the first admin.
    await conn.execute("select pg_advisory_xact_lock(7301948)")
    user = await db.fetch_one(conn, f"select * from users where {channel} = %s for update", (contact,))
    if user:
        if contact == bootstrap and user["role"] != "admin" and not await _has_admin(conn):
            super_admin = not await _has_super_admin(conn)
            await conn.execute("update users set role = 'admin', super_admin = %s, updated_at = now() where id = %s",
                               (super_admin, user["id"]))
            await audit(conn, "role.changed", actor_id=user["id"], meta=meta, table="users", row_id=user["id"],
                        before={"role": user["role"]}, after={"role": "admin", "super_admin": super_admin},
                        reason=f"bootstrap_admin_{channel}")
            user = {**user, "role": "admin", "super_admin": super_admin, "became_admin": True}
        return user

    if any(bootstraps.values()):
        role = "admin" if contact == bootstrap and not await _has_admin(conn) else "user"
    else:
        exists = (await db.fetch_one(conn, "select exists (select 1 from users) as e"))["e"]
        role = "user" if exists else "admin"
    super_admin = role == "admin" and not await _has_super_admin(conn)
    user = await db.fetch_one(conn, f"insert into users ({channel}, role, super_admin) values (%s, %s, %s) returning *",
                              (contact, role, super_admin))
    await audit(conn, "create", actor_id=user["id"], meta=meta, table="users", row_id=user["id"],
                after={channel: contact, "role": role, "super_admin": super_admin})
    await webhooks.emit(conn, "user.created", {"user_id": user["id"], "role": role})
    if role == "admin":
        await audit(conn, "admin.first_user", actor_id=user["id"], meta=meta, table="users", row_id=user["id"],
                    via=f"bootstrap_admin_{channel}" if bootstrap else "first_login", super_admin=super_admin)
        user["became_admin"] = True
    return user


async def _has_admin(conn) -> bool:
    return (await db.fetch_one(conn, "select exists (select 1 from users where role = 'admin' and not impersonation_only) as e"))["e"]


async def _has_super_admin(conn) -> bool:
    return (await db.fetch_one(conn, "select exists (select 1 from users where super_admin) as e"))["e"]


# ── Passkeys ────────────────────────────────────────────────────────────────

async def _store_challenge(conn, challenge: bytes, kind: str, user_id: int | None) -> str:
    challenge_id = secrets.token_urlsafe(24)
    await conn.execute(
        "insert into webauthn_challenges (id, challenge, kind, user_id, expires_at) values (%s, %s, %s, %s, %s)",
        (challenge_id, challenge, kind, user_id, datetime.now(timezone.utc) + timedelta(minutes=5)))
    return challenge_id


async def _take_challenge(conn, challenge_id: str, kind: str, user_id: int | None) -> bytes:
    row = await db.fetch_one(conn, """
        delete from webauthn_challenges where id = %s and kind = %s and expires_at > now()
        returning challenge, user_id""", (challenge_id, kind))
    if row is None or (user_id is not None and row["user_id"] != user_id):
        raise HTTPException(400, "Forespørgslen er udløbet. Prøv igen.")
    return bytes(row["challenge"])


class RegisterOptionsIn(BaseModel):
    kind: str = Field(default="passkey", pattern="^(passkey|security_key)$")


@router.post("/passkey/register/options")
async def passkey_register_options(body: RegisterOptionsIn | None = None, principal: Principal = Depends(current_user)):
    """A passkey on this device, or a security key (YubiKey …). Both must verify the user (PIN or biometrics), so
    every registered key also works as a second factor."""
    kind = body.kind if body else "passkey"
    s = config.settings
    async with db.connection() as conn:
        await mfa.ensure_can_change_factors(conn, principal)
        existing = await db.fetch_all(conn, "select credential_id from passkeys where user_id = %s",
                                      (principal.user_id,))
        options = generate_registration_options(
            rp_id=s.rp_id,
            rp_name=s.rp_name,
            user_id=str(principal.user_id).encode(),
            user_name=principal.contact or str(principal.user_id),
            user_display_name=principal.display_name or principal.contact or str(principal.user_id),
            authenticator_selection=AuthenticatorSelectionCriteria(
                authenticator_attachment=AuthenticatorAttachment.CROSS_PLATFORM if kind == "security_key" else None,
                # Security keys have few slots for discoverable credentials; they work without one as second factor.
                resident_key=ResidentKeyRequirement.PREFERRED if kind == "security_key" else ResidentKeyRequirement.REQUIRED,
                user_verification=UserVerificationRequirement.REQUIRED),
            exclude_credentials=[PublicKeyCredentialDescriptor(id=bytes(r["credential_id"])) for r in existing],
        )
        challenge_id = await _store_challenge(conn, options.challenge, "register", principal.user_id)
    return {"challenge_id": challenge_id, "options": json.loads(options_to_json(options))}


@router.post("/passkey/register/verify")
async def passkey_register_verify(body: RegisterIn, response: Response, principal: Principal = Depends(current_user)):
    s = config.settings
    meta = principal.meta
    async with db.connection() as conn:
        f = await mfa.ensure_can_change_factors(conn, principal)
        challenge = await _take_challenge(conn, body.challenge_id, "register", principal.user_id)
        try:
            verified = verify_registration_response(credential=body.credential, expected_challenge=challenge,
                                                    expected_rp_id=s.rp_id, expected_origin=s.origin,
                                                    require_user_verification=True)
        except InvalidRegistrationResponse as e:
            await auth_event(conn, "passkey.registered", ok=False, meta=meta, user_id=principal.user_id,
                             contact=principal.contact, reason=str(e))
            await conn.commit()
            raise HTTPException(400, "Passkey kunne ikke registreres. Kræver fingeraftryk, ansigt eller PIN-kode.")
        transports = body.credential.get("response", {}).get("transports") or []
        attachment = body.credential.get("authenticatorAttachment")
        kind = "security_key" if attachment == "cross-platform" and "hybrid" not in transports else "passkey"
        name = (body.name or "").strip() or ("Sikkerhedsnøgle" if kind == "security_key"
                                              else _default_passkey_name(meta.user_agent))
        row = await db.fetch_one(conn, """
            insert into passkeys (user_id, credential_id, public_key, sign_count, transports, name, kind)
            values (%s, %s, %s, %s, %s, %s, %s) returning id""",
            (principal.user_id, verified.credential_id, verified.credential_public_key, verified.sign_count,
             transports, name, kind))
        await auth_event(conn, "passkey.registered", ok=True, meta=meta, user_id=principal.user_id,
                         contact=principal.contact, passkey_id=row["id"], kind=kind)
        await audit(conn, "create", actor_id=principal.user_id, meta=meta, table="passkeys", row_id=row["id"],
                    after={"name": name, "kind": kind, "user_id": principal.user_id})
        # The new key was just used with user verification: this is a second factor. New token, no grace.
        session_id = await _rotate_session(conn, response, principal)
        if not f["total"]:
            await mfa.revoke_grace_sessions(conn, principal.user_id, session_id)
    return {"ok": True, "passkey_id": row["id"], "kind": kind}


async def _rotate_session(conn, response: Response, principal: Principal) -> int:
    """Replaces the session with a new full one that has proven a second factor now."""
    await conn.execute("update sessions set revoked_at = now() where id = %s", (principal.session_id,))
    return await create_session(conn, response, principal.user_id, "full", principal.meta, mfa=True)


def _default_passkey_name(ua: str) -> str:
    from app.security import short_device
    return short_device(ua) or "Passkey"


@router.post("/passkey/login/options")
async def passkey_login_options():
    options = generate_authentication_options(rp_id=config.settings.rp_id,
                                              user_verification=UserVerificationRequirement.PREFERRED)
    async with db.connection() as conn:
        challenge_id = await _store_challenge(conn, options.challenge, "login", None)
    return {"challenge_id": challenge_id, "options": json.loads(options_to_json(options))}


@router.post("/passkey/login/verify")
async def passkey_login_verify(body: LoginIn, request: Request, response: Response):
    s = config.settings
    meta = request_meta(request)
    async with db.connection() as conn:
        challenge = await _take_challenge(conn, body.challenge_id, "login", None)
        try:
            raw_id = base64url_to_bytes(body.credential.get("rawId") or body.credential.get("id", ""))
        except Exception:
            raw_id = b""
        passkey = await db.fetch_one(conn, """
            select p.*, coalesce(u.email, u.phone) as contact, u.blocked_at from passkeys p join users u on u.id = p.user_id
            where p.credential_id = %s and not u.impersonation_only""", (raw_id,))
        if passkey is None:
            await auth_event(conn, "passkey.login", ok=False, meta=meta, reason="unknown_credential")
            await conn.commit()
            raise HTTPException(400, "Passkey blev ikke genkendt. Log ind med din e-mailadresse.")
        try:
            verified = verify_authentication_response(
                credential=body.credential, expected_challenge=challenge, expected_rp_id=s.rp_id,
                expected_origin=s.origin, credential_public_key=bytes(passkey["public_key"]),
                credential_current_sign_count=passkey["sign_count"])
        except InvalidAuthenticationResponse as e:
            await auth_event(conn, "passkey.login", ok=False, meta=meta, user_id=passkey["user_id"],
                             contact=passkey["contact"], reason=str(e))
            await conn.commit()
            raise HTTPException(400, "Passkey kunne ikke bekræftes")
        if passkey["blocked_at"]:
            await auth_event(conn, "passkey.login", ok=False, meta=meta, user_id=passkey["user_id"],
                             contact=passkey["contact"], reason="blocked")
            await conn.commit()
            raise HTTPException(403, "Din bruger er spærret. Kontakt en administrator.")
        await conn.execute("update passkeys set sign_count = %s, last_used_at = now() where id = %s",
                           (verified.new_sign_count, passkey["id"]))
        await auth_event(conn, "passkey.login", ok=True, meta=meta, user_id=passkey["user_id"],
                         contact=passkey["contact"], passkey_id=passkey["id"], user_verified=verified.user_verified)
        if not verified.user_verified:
            # Possession only (e.g. a security key without PIN): one factor, like a code.
            user = await db.fetch_one(conn, "select * from users where id = %s", (passkey["user_id"],))
            return await _after_first_factor(conn, response, user, meta, contact=passkey["contact"], via="passkey")
        await conn.execute("update users set last_login_at = now() where id = %s", (passkey["user_id"],))
        await create_session(conn, response, passkey["user_id"], "full", meta, mfa=True)
    return {"status": "logged_in"}


# ── Second factor (step-up) ─────────────────────────────────────────────────

class TotpIn(BaseModel):
    code: str = Field(min_length=6, max_length=10)


def _no_impersonation(principal: Principal) -> None:
    if principal.impersonator_id is not None:
        raise HTTPException(403, "Ikke muligt for en testkonto")


async def _complete_mfa(conn, response: Response, principal: Principal, method: str, factor_id: int) -> dict:
    """A second factor was proven: the session (pending or full) is replaced by a new full session with mfa_at."""
    pending = principal.scope == "mfa"
    await conn.execute("update sessions set revoked_at = now() where id = %s", (principal.session_id,))
    if pending:
        await conn.execute("update users set last_login_at = now(), updated_at = now() where id = %s",
                           (principal.user_id,))
    await create_session(conn, response, principal.user_id, "full", principal.meta, mfa=True)
    await auth_event(conn, "mfa.verified", ok=True, meta=principal.meta, user_id=principal.user_id,
                     contact=principal.contact, method=method, factor_id=factor_id, login=pending)
    return {"ok": True, "status": "logged_in"}


@router.post("/mfa/passkey/options")
async def mfa_passkey_options(principal: Principal = Depends(any_session)):
    """Only the user's own keys, so security keys without a discoverable credential work too. Requires user
    verification: a key without PIN/biometrics is possession only and does not count as a second factor."""
    _no_impersonation(principal)
    async with db.connection() as conn:
        keys = await db.fetch_all(conn, "select credential_id, transports from passkeys where user_id = %s",
                                  (principal.user_id,))
        if not keys:
            raise HTTPException(400, "Du har ingen passkey eller sikkerhedsnøgle")
        options = generate_authentication_options(
            rp_id=config.settings.rp_id, user_verification=UserVerificationRequirement.REQUIRED,
            allow_credentials=[PublicKeyCredentialDescriptor(id=bytes(k["credential_id"])) for k in keys])
        challenge_id = await _store_challenge(conn, options.challenge, "stepup", principal.user_id)
    return {"challenge_id": challenge_id, "options": json.loads(options_to_json(options))}


@router.post("/mfa/passkey/verify")
async def mfa_passkey_verify(body: LoginIn, response: Response, principal: Principal = Depends(any_session)):
    _no_impersonation(principal)
    s = config.settings
    async with db.connection() as conn:
        challenge = await _take_challenge(conn, body.challenge_id, "stepup", principal.user_id)
        try:
            raw_id = base64url_to_bytes(body.credential.get("rawId") or body.credential.get("id", ""))
        except Exception:
            raw_id = b""
        passkey = await db.fetch_one(conn, "select * from passkeys where credential_id = %s and user_id = %s for update",
                                     (raw_id, principal.user_id))
        try:
            if passkey is None:
                raise InvalidAuthenticationResponse("unknown credential")
            verified = verify_authentication_response(
                credential=body.credential, expected_challenge=challenge, expected_rp_id=s.rp_id,
                expected_origin=s.origin, credential_public_key=bytes(passkey["public_key"]),
                credential_current_sign_count=passkey["sign_count"], require_user_verification=True)
        except InvalidAuthenticationResponse as e:
            await auth_event(conn, "mfa.failed", ok=False, meta=principal.meta, user_id=principal.user_id,
                             contact=principal.contact, method="passkey", reason=str(e))
            await conn.commit()
            raise HTTPException(400, "Passkey kunne ikke bekræftes. Kræver fingeraftryk, ansigt eller PIN-kode.")
        await conn.execute("update passkeys set sign_count = %s, last_used_at = now() where id = %s",
                           (verified.new_sign_count, passkey["id"]))
        return await _complete_mfa(conn, response, principal, passkey["kind"], passkey["id"])


async def check_totp(conn, principal: Principal, code: str, *, factor_id: int | None = None) -> int:
    """Checks a code against the user's confirmed authenticator apps (or one unconfirmed factor during setup).
    Wrong codes count towards a lock like one-time codes. Returns the factor id; raises 400/429."""
    s = config.settings
    failed = await _count_user_events(conn, "mfa.failed", principal.user_id, s.otp_lock_minutes)
    if failed >= s.otp_max_attempts:
        raise HTTPException(429, "For mange forkerte forsøg. Prøv igen om lidt.")
    where = "id = %s and confirmed_at is null" if factor_id is not None else "confirmed_at is not null"
    params = (principal.user_id, factor_id) if factor_id is not None else (principal.user_id,)
    rows = await db.fetch_all(conn, f"""select id, secret_enc, last_used_step from totp_factors
                                        where user_id = %s and {where} order by id""", params)
    for row in rows:
        step = totp.match(totp.decrypt(row["secret_enc"]), code, after_step=row["last_used_step"])
        if step is None:
            continue
        # Conditional update: two requests with the same code cannot both succeed (replay).
        used = await db.fetch_one(conn, """
            update totp_factors set last_used_step = %(step)s, last_used_at = now()
            where id = %(id)s and (last_used_step is null or last_used_step < %(step)s) returning id""",
            {"id": row["id"], "step": step})
        if used:
            return row["id"]
    await auth_event(conn, "mfa.failed", ok=False, meta=principal.meta, user_id=principal.user_id,
                     contact=principal.contact, method="totp", reason="wrong_code" if rows else "no_factor")
    await conn.commit()
    raise HTTPException(400, "Koden er forkert eller allerede brugt")


async def _count_user_events(conn, event: str, user_id: int, minutes: int) -> int:
    row = await db.fetch_one(conn, """select count(*) as n from auth_log
                                      where event = %s and user_id = %s and ts > now() - make_interval(mins => %s)""",
                             (event, user_id, minutes))
    return row["n"]


@router.post("/mfa/totp/verify")
async def mfa_totp_verify(body: TotpIn, response: Response, principal: Principal = Depends(any_session)):
    _no_impersonation(principal)
    async with db.connection() as conn:
        factor_id = await check_totp(conn, principal, body.code)
        return await _complete_mfa(conn, response, principal, "totp", factor_id)


# ── Session ─────────────────────────────────────────────────────────────────

@router.post("/logout")
async def logout(request: Request, response: Response, principal: Principal | None = Depends(optional_principal)):
    if principal and principal.impersonator_id is not None:
        # Logging out of the app on / while impersonating ends the impersonation, not the admin's session.
        async with db.connection() as conn:
            await conn.execute("update sessions set revoked_at = now() where id = %s", (principal.session_id,))
            await audit(conn, "impersonation.stop", actor_id=principal.impersonator_id, meta=principal.meta,
                        table="users", row_id=principal.user_id, via="logout")
        response.delete_cookie(IMP_COOKIE, path="/")
        return {"ok": True}
    if principal:
        async with db.connection() as conn:
            await revoke_sessions(conn, meta=principal.meta, user_id=principal.user_id,
                                  session_id=principal.session_id, reason="logout")
    clear_session_cookie(response, request_meta(request).embedded)
    return {"ok": True}


@router.get("/me")
async def me(principal: Principal | None = Depends(optional_principal)):
    if principal is None:
        return {"user": None}
    async with db.connection() as conn:
        user = await db.fetch_one(conn, """
            select u.id, u.email, u.phone, u.display_name, u.role, u.super_admin, u.admin_roles, u.grace_logins_used, u.mfa_required,
                   u.locale, u.avatar_file_id is not null as has_avatar
            from users u where u.id = %s""", (principal.user_id,))
        f = await mfa.factors(conn, principal.user_id)
    s = config.settings
    is_admin = user["role"] == "admin"
    return {
        "user": {
            "id": user["id"],
            "email": user["email"],
            "phone": user["phone"],
            "display_name": user["display_name"],
            "role": user["role"],
            "super_admin": user["super_admin"],
            # app/admin_roles.py: the admin's roles and the /admin sections they open (the menu shows only these)
            "admin_roles": user["admin_roles"] if is_admin else [],
            "admin_sections": admin_roles.sections(user["admin_roles"]) if is_admin else [],
            "locale": user["locale"],
            "avatar_url": "/api/me/avatar" if user["has_avatar"] else None,
            "passkeys": f["passkeys"] + f["security_keys"],
            "mfa": {
                "required": user["mfa_required"],
                "factors": f["total"],
                "methods": mfa.methods(f),
                # /admin: is this session allowed in, and how many grace logins are left without a second factor
                "admin_ok": is_admin and principal.scope == "full" and admin_mfa_ok(principal),
                "admin_grace_left": max(0, s.grace_logins - user["grace_logins_used"]) if is_admin and not f["total"] else None,
            },
        },
        "scope": principal.scope,
        "impersonator": await _impersonator(principal),
    }


async def _impersonator(principal: Principal) -> dict | None:
    if principal.impersonator_id is None:
        return None
    async with db.connection() as conn:
        return await db.fetch_one(conn, "select id, display_name from users where id = %s", (principal.impersonator_id,))
