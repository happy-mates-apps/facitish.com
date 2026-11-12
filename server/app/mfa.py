"""Second factors: passkeys, security keys (e.g. YubiKey) and authenticator apps (TOTP).

Who needs one (the rules are in the gaer-auth skill):
  - /admin: after GRACE_LOGINS logins with a code, an admin needs a second factor proven within ADMIN_MFA_HOURS.
    Security actions (roles, contact details, blocking, MFA reset, impersonation …) need one within STEPUP_MINUTES.
  - users who turned on "Kræv passkey" (users.mfa_required): every login needs a second factor.
  - everybody else: a passkey is offered, never required.
  - users with the YubiKey requirement (users.yubikey_required, set in /admin): /admin and every step-up count only a
    YubiKey proven within the same windows (sessions.yubikey_at); no grace logins. Passkeys and apps still log them in
    to the app. A YubiKey counts once an admin enrolled it (in person or with a link) or the user proved another
    YubiKey first; see routes/yubikey.py.
A passkey or security key only counts as a second factor when the authenticator verified the user (PIN or biometrics).
"""

from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

from app import config, db

ERROR_HEADER = "X-Gaer-Error"  # lets the frontend tell the MFA cases apart from other 403s


def mfa_error(code: str, message: str) -> HTTPException:
    """403 with a machine-readable code: mfa_required, mfa_setup_required, stepup_required, or for users with the
    YubiKey requirement yubikey_required, yubikey_setup_required, yubikey_stepup_required."""
    return HTTPException(403, message, headers={ERROR_HEADER: code})


def within(ts: datetime | None, delta: timedelta) -> bool:
    return ts is not None and datetime.now(timezone.utc) - ts <= delta


async def factors(conn, user_id: int) -> dict:
    """Counts of confirmed factors per kind."""
    row = await db.fetch_one(conn, """
        select (select count(*) from passkeys where user_id = %(u)s and kind = 'passkey') as passkeys,
               (select count(*) from passkeys where user_id = %(u)s and kind = 'security_key') as security_keys,
               (select count(*) from passkeys where user_id = %(u)s and yubikey) as yubikeys,
               (select count(*) from totp_factors where user_id = %(u)s and confirmed_at is not null) as totp""",
        {"u": user_id})
    return {**row, "total": row["passkeys"] + row["security_keys"] + row["totp"]}


def methods(f: dict) -> list[str]:
    """The ways a user can prove the second factor."""
    return (["passkey"] if f["passkeys"] + f["security_keys"] else []) + (["totp"] if f["totp"] else [])


def stepup_ok(principal) -> bool:
    """A second factor within STEPUP_MINUTES; for users with the YubiKey requirement, a YubiKey."""
    window = timedelta(minutes=config.settings.stepup_minutes)
    if getattr(principal, "yubikey_required", False):
        return within(principal.yubikey_at, window)
    return within(principal.mfa_at, window)


def stepup_error(principal) -> HTTPException:
    if getattr(principal, "yubikey_required", False):
        return mfa_error("yubikey_stepup_required", "Bekræft med din YubiKey først")
    return mfa_error("stepup_required", "Bekræft med din passkey, sikkerhedsnøgle eller godkendelsesapp først")


def require_stepup(principal) -> None:
    """Raises 403 + X-Gaer-Error: stepup_required (or yubikey_stepup_required) unless stepup_ok."""
    if not stepup_ok(principal):
        raise stepup_error(principal)


async def lock_user(conn, user_id: int) -> dict:
    """Serializes factor changes for one user (adding, confirming, removing, switching MFA on/off)."""
    return await db.fetch_one(conn, "select id, role, mfa_required, impersonation_only from users where id = %s for update",
                              (user_id,))


async def require_recent_mfa(conn, principal) -> dict:
    """Actions that could lock the owner out (changing factors, e-mail or phone, deleting the account): once the user
    has a second factor, it must be proven within STEPUP_MINUTES. Without one, the code login is all there is."""
    f = await factors(conn, principal.user_id)
    if f["total"] and not within(principal.mfa_at, timedelta(minutes=config.settings.stepup_minutes)):
        raise mfa_error("stepup_required", "Bekræft med din passkey, sikkerhedsnøgle eller godkendelsesapp først")
    return f


async def ensure_can_change_factors(conn, principal) -> dict:
    """Adding or removing a factor, or switching MFA on or off. The first factor may be added right after a login
    with a code (bootstrap); once the user has one, a second factor proven within STEPUP_MINUTES is required, so
    someone who only got hold of a code cannot add their own passkey or lock the owner out."""
    if principal.impersonator_id is not None:
        raise HTTPException(403, "Ikke muligt for en testkonto")
    await lock_user(conn, principal.user_id)
    return await require_recent_mfa(conn, principal)


async def revoke_grace_sessions(conn, user_id: int, keep_session_id: int | None) -> None:
    """After the first factor is added, sessions that got into /admin on a grace login are no longer needed."""
    await conn.execute("""update sessions set revoked_at = now()
                          where user_id = %s and grace and revoked_at is null and id is distinct from %s""",
                       (user_id, keep_session_id))
