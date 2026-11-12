"""/admin/users, the parts beyond the single actions in routes/admin.py:

  POST /api/admin/users                  create a user (or an admin) without them signing up themselves
  PUT  /api/admin/users/{id}             the full-screen edit's Save: every changed field in one transaction
  POST /api/admin/users/{id}/login-link  send the user a login mail (code + link); optionally reset MFA first
  GET/PUT /api/admin/settings/signup     who may create an account by logging in (app/signup.py)

The rules are the ones the single actions have (routes/admin.py: super admin, last admin, who may change whom),
reused through their do_* functions. Security changes (role, admin roles, e-mail, phone, user type, the YubiKey
requirement) need a step-up; creating an admin needs the role `fuld`.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import access, admin_roles, config, db, mfa, outbound_mail, settings_store, signup, webhooks
from app.logs import audit
from app.mail import MailError, send_mail, welcome_mail
from app.routes.admin import (_user_or_404, do_reset_mfa, do_set_admin_roles, do_set_contact, do_set_role,
                              get_user)
from app.routes.auth import check_send_limits, dev_code_allowed, issue_code, parse_email, parse_phone
from app.routes.me import ProfileIn, clean_profile, update_profile_fields
from app.sessions import Principal, require_admin

log = logging.getLogger("gaer.admin_users")

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_admin)])


def _full(admin: Principal) -> bool:
    return admin.super_admin or admin_roles.FULL in admin.admin_roles


def _require_full(admin: Principal) -> None:
    if not _full(admin):
        raise HTTPException(403, "Kun admins med fuld adgang kan ændre, hvem der er admin")


# ── Create ──────────────────────────────────────────────────────────────────

class CreateUserIn(BaseModel):
    email: str | None = Field(default=None, max_length=254)
    phone: str | None = Field(default=None, max_length=32)
    display_name: str | None = Field(default=None, max_length=80)
    role: str = Field(default="user", pattern="^(user|admin)$")
    admin_roles: list[str] = Field(default_factory=list, max_length=len(admin_roles.ROLES))
    audience: str | None = Field(default=None, pattern="^(internal|external)$")
    yubikey_required: bool = False
    send_welcome: bool = True


@router.post("/users", status_code=201)
async def create_user(body: CreateUserIn, admin: Principal = Depends(require_admin)):
    """A user created by an admin logs in like anybody else (e-mail or SMS + code); this is how people get in when
    sign-up is closed (app/signup.py). Creating an admin, or a user with the YubiKey requirement, is a security
    action (step-up); an admin only with the role `fuld`."""
    email = parse_email(body.email) if body.email else None
    phone = parse_phone(body.phone) if body.phone else None
    if not email and not phone:
        raise HTTPException(422, "Skriv en e-mailadresse")
    if phone and not email and not config.settings.sms_login:
        raise HTTPException(422, "Skriv en e-mailadresse. Login med SMS er ikke slået til.")
    roles = admin_roles.clean(body.admin_roles)
    if len(roles) != len(set(body.admin_roles)):
        raise HTTPException(422, "Ukendt admin-rolle")
    if body.role == "admin":
        _require_full(admin)
    if body.role == "admin" or body.yubikey_required:
        mfa.require_stepup(admin)
    audience = body.audience or ("internal" if body.role == "admin" or access.internal_domain(email) else "external")
    name = (body.display_name or "").strip() or None
    async with db.connection() as conn:
        for channel, contact in (("email", email), ("phone", phone)):
            if contact and await db.fetch_one(conn, f"select 1 from users where {channel} = %s", (contact,)):
                raise HTTPException(409, "E-mailadressen bruges allerede af en anden bruger" if channel == "email"
                                    else "Nummeret bruges allerede af en anden bruger")
        user = await db.fetch_one(conn, """
            insert into users (email, phone, display_name, role, admin_roles, audience, yubikey_required, created_by)
            values (%s, %s, %s, %s, %s, %s, %s, %s) returning id, role, admin_roles""",
            (email, phone, name, body.role, (roles or None) if body.role == "admin" else None, audience,
             body.yubikey_required, admin.user_id))
        await audit(conn, "create", actor_id=admin.user_id, meta=admin.meta, table="users", row_id=user["id"],
                    after={"email": email, "phone": phone, "display_name": name, "role": user["role"],
                           "admin_roles": user["admin_roles"], "audience": audience,
                           "yubikey_required": body.yubikey_required}, reason="admin.create_user")
        await webhooks.emit(conn, "user.created", {"user_id": user["id"], "role": user["role"]})
        mail_sent = None
        if body.send_welcome and email:
            mail_sent = await _send_welcome(conn, user["id"], email, yubikey=body.yubikey_required)
    return {"id": user["id"], "welcome_sent": mail_sent}


async def _send_welcome(conn, user_id: int, email: str, *, yubikey: bool) -> bool:
    """A welcome mail is a courtesy: if it fails, the user still exists and can log in from /login."""
    values = await settings_store.get_all(conn)
    subject, text, html_body = welcome_mail(values["app_name"], f"{config.settings.origin.rstrip('/')}/login",
                                            yubikey=yubikey)
    try:
        message_id = await send_mail(email, subject, text, html_body, values["app_name"])
    except MailError as e:
        log.warning("welcome mail to user %s failed: %s", user_id, e)
        return False
    await outbound_mail.record_sent(conn, message_id=message_id, recipient=email, user_id=user_id, purpose="other",
                                    subject=subject)
    return True


# ── Full edit (one Save) ────────────────────────────────────────────────────

class UserUpdateIn(BaseModel):
    """Only the fields that are sent are considered; unchanged values are ignored."""
    display_name: str | None = Field(default=None, max_length=80)
    email: str | None = Field(default=None, max_length=254)
    phone: str | None = Field(default=None, max_length=32)
    audience: str | None = Field(default=None, pattern="^(internal|external)$")
    role: str | None = Field(default=None, pattern="^(user|admin)$")
    admin_roles: list[str] | None = Field(default=None, max_length=len(admin_roles.ROLES))
    yubikey_required: bool | None = None


SECURITY_FIELDS = ("email", "phone", "audience", "role", "admin_roles", "yubikey_required")


@router.put("/users/{user_id}")
async def update_user(user_id: int, body: UserUpdateIn, admin: Principal = Depends(require_admin)):
    """Applies every change from the edit page at once, or none of them. Returns the user as GET does."""
    sent = body.model_fields_set
    async with db.connection() as conn:
        user = await _user_or_404(conn, user_id, admin)
        if user["impersonation_only"]:
            raise HTTPException(409, "Testkonti redigeres under Efterligning")
        email = parse_email(body.email) if "email" in sent and body.email else None
        phone = parse_phone(body.phone) if "phone" in sent and body.phone else None
        changes = {
            "email": email if email and email != user["email"] else None,
            "phone": phone if phone and phone != user["phone"] else None,
            "audience": body.audience if body.audience and body.audience != user["audience"] else None,
            "role": body.role if body.role and body.role != user["role"] else None,
            "admin_roles": (admin_roles.clean(body.admin_roles) if body.admin_roles is not None
                            and admin_roles.clean(body.admin_roles) != sorted(user["admin_roles"] or []) else None),
            "yubikey_required": (body.yubikey_required if body.yubikey_required is not None
                                 and body.yubikey_required != user["yubikey_required"] else None),
        }
        if any(changes[f] is not None for f in SECURITY_FIELDS):
            mfa.require_stepup(admin)
        if changes["role"] is not None or changes["admin_roles"] is not None:
            _require_full(admin)

        if "display_name" in sent:
            await update_profile_fields(conn, user_id, clean_profile(ProfileIn(display_name=body.display_name)),
                                        actor_id=admin.user_id, meta=admin.meta)
        for channel in ("email", "phone"):
            if changes[channel]:
                await do_set_contact(conn, user, channel, changes[channel], admin)
        if changes["audience"]:
            try:
                await access.set_audience(conn, user, changes["audience"], actor_id=admin.user_id, meta=admin.meta)
            except access.AccessError as e:
                raise HTTPException(e.status, str(e))
        if changes["role"]:
            await do_set_role(conn, user, changes["role"], admin)
            user = await _user_or_404(conn, user_id, admin)
        if changes["admin_roles"] is not None and user["role"] == "admin":
            await do_set_admin_roles(conn, user, body.admin_roles or [], admin)
        if changes["yubikey_required"] is not None:
            await do_set_yubikey_required(conn, user, changes["yubikey_required"], admin)
    return await get_user(user_id, admin)


async def do_set_yubikey_required(conn, user: dict, required: bool, admin: Principal) -> None:
    """Switches the YubiKey requirement on or off. Nobody locks themselves out: switching it on for yourself needs
    a YubiKey of your own first. The user's sessions are not touched; /admin re-checks on every request."""
    if user["id"] == admin.user_id and required:
        f = await mfa.factors(conn, user["id"])
        if not f["yubikeys"]:
            raise HTTPException(409, "Tilknyt først en YubiKey til dig selv under Konto")
    await conn.execute("update users set yubikey_required = %s, updated_at = now() where id = %s",
                       (required, user["id"]))
    await audit(conn, "update", actor_id=admin.user_id, meta=admin.meta, table="users", row_id=user["id"],
                before={"yubikey_required": user["yubikey_required"]}, after={"yubikey_required": required})


# ── Login link and recovery ─────────────────────────────────────────────────

class LoginLinkIn(BaseModel):
    reset_mfa: bool = False


@router.post("/users/{user_id}/login-link")
async def send_login_link(user_id: int, body: LoginLinkIn | None = None, admin: Principal = Depends(require_admin)):
    """"Gendan adgang": mails the user a login code and link, as if they had asked for one on /login. With reset_mfa
    the user's passkeys, keys and apps are deleted first (the same action and rules as reset-mfa, so a step-up).
    The second-factor rules still apply after the link: it is never a way past them."""
    reset = bool(body and body.reset_mfa)
    if reset:
        mfa.require_stepup(admin)
    async with db.connection() as conn:
        user = await _user_or_404(conn, user_id, admin)
        if user["impersonation_only"]:
            raise HTTPException(409, "Testkonti logger ikke ind")
        if user["blocked_at"]:
            raise HTTPException(409, "Brugeren er spærret. Ophæv spærringen først.")
        if not user["email"]:
            raise HTTPException(409, "Brugeren har ingen e-mailadresse. Brugeren kan logge ind med en kode på SMS.")
        deleted = await do_reset_mfa(conn, user, admin) if reset else None
        await check_send_limits(conn, user["email"], admin.meta, by=admin.user_id)
        issued = await issue_code(conn, "email", user["email"], admin.meta, user_id=user_id, by=admin.user_id)
        await audit(conn, "user.login_link", actor_id=admin.user_id, meta=admin.meta, table="users", row_id=user_id,
                    subject_user_id=user_id, reset_mfa=reset)
    out = {"ok": True, "reset": deleted, "expires_in": config.settings.otp_ttl_seconds}
    if dev_code_allowed("email") and issued.link:
        out["dev_link"] = issued.link
    return out


# ── Sign-up setting ─────────────────────────────────────────────────────────

class SignupIn(BaseModel):
    mode: str = Field(pattern="^(open|domains|closed)$")
    domains: list[str] = Field(default_factory=list, max_length=200)
    contact: str = Field(default="", max_length=200)


@router.get("/settings/signup")
async def signup_get():
    async with db.connection() as conn:
        return await signup.get(conn)


@router.put("/settings/signup")
async def signup_put(body: SignupIn, admin: Principal = Depends(require_admin)):
    value = signup.clean(body.mode, [d for d in body.domains if isinstance(d, str)], body.contact)
    async with db.connection() as conn:
        before = await signup.get(conn)
        if before != value:
            await settings_store.set_many(conn, {"signup": value})
            await audit(conn, "update", actor_id=admin.user_id, meta=admin.meta, table="settings", row_id="signup",
                        before=before, after=value)
    return value
