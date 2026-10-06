"""Session cookies and the FastAPI dependencies that guard endpoints.

Two scopes:
  full    normal login
  enroll  after a one-time code when a passkey is required: may only register a passkey
"""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request, Response

from app import config, db
from app.logs import RequestMeta, audit, auth_event
from app.security import client_ip, new_token, token_hash, user_agent

COOKIE = "gaer_session"


@dataclass
class Principal:
    session_id: int
    user_id: int
    phone: str
    role: str
    scope: str
    display_name: str | None
    meta: RequestMeta

    @property
    def is_admin(self) -> bool:
        return self.role == "admin" and self.scope == "full"


def request_meta(request: Request) -> RequestMeta:
    return RequestMeta(ip=client_ip(request), user_agent=user_agent(request),
                       embedded=request.headers.get("x-gaer-embedded") == "1")


def set_session_cookie(response: Response, token: str, max_age: int, embedded: bool) -> None:
    """Inside the browser extension or an Office pane the app is a third-party iframe. There the
    cookie must be SameSite=None and Partitioned (CHIPS), so it only exists inside that embedding.
    CSRF is still covered by the X-Gaer header requirement."""
    s = config.settings
    if embedded and s.secure_cookies:
        response.headers.append("set-cookie", _partitioned(token, max_age))
    else:
        response.set_cookie(COOKIE, token, max_age=max_age, httponly=True, secure=s.secure_cookies,
                            samesite="lax", path="/")


def _partitioned(value: str, max_age: int) -> str:
    # Written by hand: Starlette only supports Partitioned on Python 3.14+.
    return f"{COOKIE}={value}; Max-Age={max_age}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned"


def clear_session_cookie(response: Response, embedded: bool) -> None:
    s = config.settings
    if embedded and s.secure_cookies:
        response.headers.append("set-cookie", _partitioned("", 0))
    else:
        response.delete_cookie(COOKIE, path="/")


async def create_session(conn, response: Response, user_id: int, scope: str, meta: RequestMeta) -> None:
    token = new_token()
    s = config.settings
    lifetime = timedelta(days=s.session_days) if scope == "full" else timedelta(minutes=s.enroll_session_minutes)
    expires = datetime.now(timezone.utc) + lifetime
    await conn.execute(
        """insert into sessions (user_id, token_hash, scope, expires_at, ip, user_agent)
           values (%s, %s, %s, %s, %s, %s)""",
        (user_id, token_hash(token), scope, expires, meta.ip, meta.user_agent),
    )
    set_session_cookie(response, token, int(lifetime.total_seconds()), meta.embedded)


async def revoke_sessions(conn, *, meta: RequestMeta, user_id: int, session_id: int | None = None,
                          reason: str, actor_id: int | None = None) -> int:
    """Revokes one session or all of a user's sessions and writes session.revoked."""
    if session_id is not None:
        cur = await conn.execute(
            "update sessions set revoked_at = now() where id = %s and user_id = %s and revoked_at is null",
            (session_id, user_id))
    else:
        cur = await conn.execute(
            "update sessions set revoked_at = now() where user_id = %s and revoked_at is null", (user_id,))
    if cur.rowcount:
        await auth_event(conn, "session.revoked", ok=True, meta=meta, user_id=user_id, reason=reason,
                         count=cur.rowcount, by=actor_id)
    return cur.rowcount


async def _load(request: Request) -> Principal | None:
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    async with db.connection() as conn:
        row = await db.fetch_one(conn, """
            select s.id as session_id, s.scope, s.last_seen_at, u.id as user_id, u.phone, u.role,
                   u.display_name, u.blocked_at
            from sessions s join users u on u.id = s.user_id
            where s.token_hash = %s and s.revoked_at is null and s.expires_at > now()""",
            (token_hash(token),))
        if row is None or row["blocked_at"] is not None:
            return None
        if datetime.now(timezone.utc) - row["last_seen_at"] > timedelta(minutes=5):
            await conn.execute("update sessions set last_seen_at = now() where id = %s", (row["session_id"],))
    return Principal(session_id=row["session_id"], user_id=row["user_id"], phone=row["phone"],
                     role=row["role"], scope=row["scope"], display_name=row["display_name"],
                     meta=request_meta(request))


async def optional_principal(request: Request) -> Principal | None:
    return await _load(request)


async def any_session(request: Request) -> Principal:
    """Full or enroll session. Only the passkey registration endpoints accept enroll sessions."""
    principal = await _load(request)
    if principal is None:
        raise HTTPException(401, "Ikke logget ind")
    return principal


async def current_user(principal: Principal = Depends(any_session)) -> Principal:
    if principal.scope != "full":
        raise HTTPException(403, "Opret en passkey for at fortsætte")
    return principal


async def require_admin(request: Request, principal: Principal = Depends(current_user)) -> Principal:
    """Everything in /admin is audited. Changes write their own detailed entries;
    reads are logged here as admin.read with the path and query."""
    if principal.role != "admin":
        raise HTTPException(403, "Kræver admin-rollen")
    if request.method == "GET":
        async with db.connection() as conn:
            await audit(conn, "admin.read", actor_id=principal.user_id, meta=principal.meta,
                        path=request.url.path, query=str(request.url.query) or None)
    return principal
