"""OAuth 2.0 (authorization code + PKCE, dynamic client registration) on top of the normal Gær login.

There is no new way to sign in: /mcp/authorize sends the browser to the consent page in the app, which
requires a full session (phone, one-time code, passkey as always). The user approves the client there.
The token endpoint then creates a row in `sessions` for the client, so it shows under Konto → Sessioner and
dies with "log ud alle steder", a block or an erasure. Tokens are random; only their SHA-256 is stored.

    GET  /.well-known/oauth-authorization-server
    GET  /.well-known/oauth-protected-resource[/mcp|/mcp/admin]
    POST /mcp/register            public clients only, PKCE required
    GET  /mcp/authorize           → /forbind?… (consent page, web/src/pages/McpConsent.tsx)
    GET  /api/mcp/consent         what the consent page shows
    POST /api/mcp/consent         approve or deny → redirect URL with ?code= or ?error=
    POST /mcp/token               authorization_code | refresh_token (refresh rotates)
"""

import base64
import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode, urlparse

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field, ValidationError

from app import config, db, mfa
from app.logs import audit, auth_event
from app.mfa import mfa_error
from app.security import new_token, token_hash
from app.sessions import Principal, current_user, request_meta

router = APIRouter(tags=["mcp"])

SCOPES = ("mcp", "mcp:admin")
CODE_TTL = timedelta(minutes=10)
CONSENT_PAGE = "/forbind"


def origin() -> str:
    return config.settings.origin.rstrip("/")


def resource_url(server: str) -> str:
    return origin() + ("/mcp/admin" if server == "admin" else "/mcp")


def scope_for(server: str) -> str:
    return "mcp:admin" if server == "admin" else "mcp"


# ── Discovery ───────────────────────────────────────────────────────────────

@router.get("/.well-known/oauth-authorization-server", include_in_schema=False)
async def authorization_server_metadata():
    o = origin()
    return {
        "issuer": o,
        "authorization_endpoint": f"{o}/mcp/authorize",
        "token_endpoint": f"{o}/mcp/token",
        "registration_endpoint": f"{o}/mcp/register",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "scopes_supported": list(SCOPES),
    }


def _protected_resource(server: str) -> dict:
    return {"resource": resource_url(server), "authorization_servers": [origin()], "scopes_supported": [scope_for(server)],
            "bearer_methods_supported": ["header"]}


@router.get("/.well-known/oauth-protected-resource", include_in_schema=False)
@router.get("/.well-known/oauth-protected-resource/mcp", include_in_schema=False)
async def protected_resource_app():
    return _protected_resource("app")


@router.get("/.well-known/oauth-protected-resource/mcp/admin", include_in_schema=False)
async def protected_resource_admin():
    return _protected_resource("admin")


# ── Client registration ─────────────────────────────────────────────────────

def _valid_redirect(uri: str) -> bool:
    """https anywhere, http only on loopback (desktop clients), or a private-use scheme (com.example.app:/cb)."""
    p = urlparse(uri)
    if p.fragment:
        return False
    if p.scheme == "https":
        return bool(p.netloc)
    if p.scheme == "http":
        return p.hostname in ("localhost", "127.0.0.1", "::1")
    return "." in p.scheme and p.scheme not in ("javascript", "data", "file")


class RegisterIn(BaseModel):
    client_name: str = Field(default="MCP-klient", max_length=100)
    redirect_uris: list[str] = Field(min_length=1, max_length=10)


@router.post("/mcp/register", status_code=201)
async def register_client(body: RegisterIn):
    if not all(_valid_redirect(u) for u in body.redirect_uris):
        return JSONResponse({"error": "invalid_redirect_uri"}, status_code=400)
    client_id = "mcp_" + secrets.token_urlsafe(16)
    name = body.client_name.strip() or "MCP-klient"
    async with db.connection() as conn:
        await conn.execute("insert into mcp_clients (id, name, redirect_uris) values (%s, %s, %s)",
                           (client_id, name, body.redirect_uris))
    return {"client_id": client_id, "client_name": name, "redirect_uris": body.redirect_uris,
            "token_endpoint_auth_method": "none", "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"]}


# ── Authorization ───────────────────────────────────────────────────────────

class AuthRequest(BaseModel):
    client_id: str
    redirect_uri: str
    code_challenge: str = Field(min_length=43, max_length=128)
    code_challenge_method: str = "S256"
    scope: str = "mcp"
    state: str | None = None
    resource: str | None = None


async def _check_request(conn, a: AuthRequest) -> dict:
    client = await db.fetch_one(conn, "select * from mcp_clients where id = %s", (a.client_id,))
    if client is None or a.redirect_uri not in client["redirect_uris"]:
        raise HTTPException(400, "Ukendt klient eller redirect_uri")
    if a.code_challenge_method != "S256":
        raise HTTPException(400, "Kun PKCE med S256")
    if a.scope not in SCOPES:
        raise HTTPException(400, "Ukendt scope")
    if a.resource and a.resource not in (resource_url("app"), resource_url("admin")):
        raise HTTPException(400, "Ukendt resource")
    return client


def _from_query(request: Request, scope: str) -> AuthRequest:
    q = request.query_params
    try:
        return AuthRequest(client_id=q.get("client_id", ""), redirect_uri=q.get("redirect_uri", ""),
                           code_challenge=q.get("code_challenge", ""), code_challenge_method=q.get("code_challenge_method", ""),
                           scope=scope, state=q.get("state"), resource=q.get("resource"))
    except ValidationError:
        raise HTTPException(400, "Ugyldig forespørgsel: PKCE (S256) er påkrævet")


def _requested_scope(request: Request) -> str:
    """Clients send the scope; when they send none, the resource decides it."""
    q = request.query_params
    scope = (q.get("scope") or "").strip()
    if not scope:
        return "mcp:admin" if q.get("resource") == resource_url("admin") else "mcp"
    return "mcp:admin" if "mcp:admin" in scope.split() else scope.split()[0]


@router.get("/mcp/authorize", include_in_schema=False)
async def authorize(request: Request):
    q = request.query_params
    if q.get("response_type") != "code":
        return JSONResponse({"error": "unsupported_response_type"}, status_code=400)
    a = _from_query(request, _requested_scope(request))
    async with db.connection() as conn:
        await _check_request(conn, a)
    # The consent page is in the app and requires the normal login (RequireUser → /login → back here).
    params = {k: v for k, v in a.model_dump().items() if v is not None}
    return RedirectResponse(f"{CONSENT_PAGE}?{urlencode(params)}", status_code=302)


def _consent_principal(p: Principal) -> Principal:
    if p.impersonator_id is not None:
        raise HTTPException(403, "MCP kan ikke forbindes, mens du efterligner en testkonto")
    return p


@router.get("/api/mcp/consent")
async def consent_info(request: Request, p: Principal = Depends(current_user)):
    _consent_principal(p)
    a = _from_query(request, request.query_params.get("scope", "mcp"))
    async with db.connection() as conn:
        client = await _check_request(conn, a)
    return {"client": {"id": client["id"], "name": client["name"]}, "scope": a.scope,
            "redirect_host": urlparse(a.redirect_uri).netloc or urlparse(a.redirect_uri).scheme,
            "allowed": a.scope == "mcp" or p.is_admin}


class ConsentIn(AuthRequest):
    approve: bool


@router.post("/api/mcp/consent")
async def consent(body: ConsentIn, p: Principal = Depends(current_user)):
    _consent_principal(p)
    async with db.connection() as conn:
        client = await _check_request(conn, body)
        extra = {"state": body.state} if body.state else {}
        if not body.approve:
            await auth_event(conn, "mcp.consent", ok=False, meta=p.meta, user_id=p.user_id, client=client["id"],
                             scope=body.scope, reason="denied")
            return {"redirect": _with_query(body.redirect_uri, {"error": "access_denied", **extra})}
        if body.scope == "mcp:admin" and (not p.is_admin or "fuld" not in p.admin_roles):
            raise HTTPException(403, "Kun admins med fuld adgang kan forbinde /mcp/admin")
        if body.scope == "mcp:admin" and not mfa.within(p.mfa_at, timedelta(minutes=config.settings.stepup_minutes)):
            # An admin token lives for weeks: it is only handed out right after a second factor (gaer-auth).
            raise mfa_error("stepup_required", "Bekræft med din passkey, sikkerhedsnøgle eller godkendelsesapp først")
        code = new_token()
        await conn.execute("""
            insert into mcp_tokens (kind, token_hash, client_id, user_id, scope, redirect_uri, code_challenge, resource, expires_at)
            values ('code', %s, %s, %s, %s, %s, %s, %s, %s)""",
            (token_hash(code), client["id"], p.user_id, body.scope, body.redirect_uri, body.code_challenge, body.resource,
             datetime.now(timezone.utc) + CODE_TTL))
        await auth_event(conn, "mcp.consent", ok=True, meta=p.meta, user_id=p.user_id, client=client["id"], scope=body.scope)
    return {"redirect": _with_query(body.redirect_uri, {"code": code, **extra})}


def _with_query(uri: str, params: dict) -> str:
    return uri + ("&" if "?" in uri else "?") + urlencode(params)


# ── Tokens ──────────────────────────────────────────────────────────────────

def _pkce_ok(verifier: str, challenge: str) -> bool:
    digest = hashlib.sha256(verifier.encode()).digest()
    expected = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return secrets.compare_digest(expected, challenge)


def _token_error(error: str, description: str, status: int = 400) -> JSONResponse:
    return JSONResponse({"error": error, "error_description": description}, status_code=status,
                        headers={"Cache-Control": "no-store"})


async def _issue(conn, *, session_id: int, client_id: str, user_id: int, scope: str, resource: str | None) -> dict:
    s = config.settings
    access, refresh = new_token(), new_token()
    now = datetime.now(timezone.utc)
    for kind, token, ttl in (("access", access, timedelta(minutes=s.mcp_access_token_minutes)),
                             ("refresh", refresh, timedelta(days=s.mcp_refresh_token_days))):
        await conn.execute("""
            insert into mcp_tokens (kind, token_hash, client_id, user_id, session_id, scope, resource, expires_at)
            values (%s, %s, %s, %s, %s, %s, %s, %s)""", (kind, token_hash(token), client_id, user_id, session_id, scope,
                                                         resource, now + ttl))
    await conn.execute("update sessions set expires_at = greatest(expires_at, %s), last_seen_at = now() where id = %s",
                       (now + timedelta(days=s.mcp_refresh_token_days), session_id))
    await conn.execute("update mcp_clients set last_used_at = now() where id = %s", (client_id,))
    return {"access_token": access, "token_type": "Bearer", "expires_in": s.mcp_access_token_minutes * 60,
            "refresh_token": refresh, "scope": scope}


@router.post("/mcp/token", include_in_schema=False)
async def token(request: Request):
    form = await request.form()
    grant = form.get("grant_type")
    client_id = str(form.get("client_id") or "")
    meta = request_meta(request)
    async with db.connection() as conn:
        if grant == "authorization_code":
            row = await db.fetch_one(conn, """
                update mcp_tokens set used_at = now()
                where token_hash = %s and kind = 'code' and used_at is null and expires_at > now()
                returning *""", (token_hash(str(form.get("code") or "")),))
            if (row is None or row["client_id"] != client_id or row["redirect_uri"] != form.get("redirect_uri")
                    or not _pkce_ok(str(form.get("code_verifier") or ""), row["code_challenge"] or "")):
                await conn.commit()  # the code stays used even when the exchange fails
                return _token_error("invalid_grant", "Koden er ugyldig, brugt eller udløbet")
            user = await db.fetch_one(conn, "select * from users where id = %s", (row["user_id"],))
            if user is None or user["blocked_at"] or user["impersonation_only"]:
                return _token_error("invalid_grant", "Brugeren kan ikke bruge MCP")
            if row["scope"] == "mcp:admin" and (user["role"] != "admin" or "fuld" not in (user["admin_roles"] or [])):
                return _token_error("invalid_scope", "Kræver admin-rollen med fuld adgang")
            client = await db.fetch_one(conn, "select name from mcp_clients where id = %s", (client_id,))
            session = await db.fetch_one(conn, """
                insert into sessions (user_id, token_hash, scope, expires_at, ip, user_agent, mcp_client_id, mcp_scope)
                values (%s, %s, 'full', now(), %s, %s, %s, %s) returning id""",
                (user["id"], token_hash(new_token()), meta.ip, f"MCP · {client['name']}", client_id, row["scope"]))
            result = await _issue(conn, session_id=session["id"], client_id=client_id, user_id=user["id"],
                                  scope=row["scope"], resource=row["resource"])
            await auth_event(conn, "mcp.authorized", ok=True, meta=meta, user_id=user["id"], client=client_id,
                             scope=row["scope"], session_id=session["id"])
            await audit(conn, "create", actor_id=user["id"], meta=meta, table="sessions", row_id=session["id"],
                        after={"mcp_client": client_id, "scope": row["scope"]})
            return JSONResponse(result, headers={"Cache-Control": "no-store"})

        if grant == "refresh_token":
            row = await db.fetch_one(conn, """
                update mcp_tokens t set used_at = now()
                from sessions s join users u on u.id = s.user_id
                where t.token_hash = %s and t.kind = 'refresh' and t.used_at is null and t.expires_at > now()
                  and s.id = t.session_id and s.revoked_at is null and s.expires_at > now() and u.blocked_at is null
                returning t.*""", (token_hash(str(form.get("refresh_token") or "")),))
            if row is None or row["client_id"] != client_id:
                await conn.commit()
                return _token_error("invalid_grant", "Refresh-token er ugyldigt, brugt eller udløbet")
            # Rotation: the old access tokens of this session end with the old refresh token.
            await conn.execute("update mcp_tokens set used_at = now() where session_id = %s and kind = 'access' and used_at is null",
                               (row["session_id"],))
            result = await _issue(conn, session_id=row["session_id"], client_id=client_id, user_id=row["user_id"],
                                  scope=row["scope"], resource=row["resource"])
            return JSONResponse(result, headers={"Cache-Control": "no-store"})

    return _token_error("unsupported_grant_type", "Kun authorization_code og refresh_token")


# ── Validation (used by the transport) ──────────────────────────────────────

@dataclass
class McpGrant:
    user_id: int
    session_id: int
    client_id: str
    scope: str
    role: str
    email: str | None
    phone: str | None
    display_name: str | None
    super_admin: bool = False
    admin_roles: tuple = ()


async def verify_access_token(token: str) -> McpGrant | None:
    """A valid access token of a live session of a user who is not blocked. Revoking the session, blocking
    the user or erasing them ends the token at once."""
    async with db.connection() as conn:
        row = await db.fetch_one(conn, """
            select t.user_id, t.session_id, t.client_id, t.scope, u.role, u.super_admin, u.admin_roles, u.email, u.phone, u.display_name, s.last_seen_at
            from mcp_tokens t join sessions s on s.id = t.session_id join users u on u.id = t.user_id
            where t.token_hash = %s and t.kind = 'access' and t.used_at is null and t.expires_at > now()
              and s.revoked_at is null and s.expires_at > now() and u.blocked_at is null and not u.impersonation_only""",
            (token_hash(token),))
        if row is None:
            return None
        if datetime.now(timezone.utc) - row["last_seen_at"] > timedelta(minutes=5):
            await conn.execute("update sessions set last_seen_at = now() where id = %s", (row["session_id"],))
    return McpGrant(user_id=row["user_id"], session_id=row["session_id"], client_id=row["client_id"], scope=row["scope"],
                    role=row["role"], email=row["email"], phone=row["phone"], display_name=row["display_name"],
                    super_admin=row["super_admin"], admin_roles=tuple(row["admin_roles"] or ()))
