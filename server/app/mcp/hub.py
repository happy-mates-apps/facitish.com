"""/api/admin/mcp: the MCP hub in /admin (section "MCP-servere"). Admin only; GETs are logged as admin.read by
require_admin. Tools run through registry.invoke exactly as over MCP (Caller via="hub", no client), so every call
lands in mcp_log, and draft tools return a draft that is confirmed here or with confirm_draft.
"""

import asyncio
import json
import time

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from psycopg.rows import dict_row

from app import config, db
from app.mcp import drafts, oauth
from app.mcp.registry import CATALOG, Caller, invoke, tool_list
from app.mcp.transport import enabled
from app.sessions import Principal, require_admin, require_admin_stepup

router = APIRouter(prefix="/api/admin/mcp", tags=["admin"], dependencies=[Depends(require_admin)])

ServerParam = Query("admin", pattern="^(app|admin)$")


def _caller(server: str, admin: Principal) -> Caller:
    return Caller(server=server, principal=admin, client_id=None, via="hub")


@router.get("/overview")
async def overview(server: str = ServerParam, admin: Principal = Depends(require_admin)):
    info = CATALOG["servers"][server]
    async with db.connection() as conn:
        await conn.execute("update mcp_drafts set status = 'expired' where status = 'pending' and expires_at <= now()")
        stats = await db.fetch_one(conn, """
            select count(*) filter (where method = 'tools/call') as calls,
                   count(*) filter (where status in ('error', 'forbidden', 'auth_failed')) as errors,
                   count(distinct user_id) as callers
            from mcp_log where server = %s and ts > now() - interval '30 days'""", (server,))
        clients = await db.fetch_all(conn, """
            select c.id, c.name, count(s.id) as sessions, max(s.last_seen_at) as last_seen_at
            from sessions s join mcp_clients c on c.id = s.mcp_client_id
            where s.mcp_scope = %s and s.revoked_at is null and s.expires_at > now()
            group by c.id, c.name order by max(s.last_seen_at) desc nulls last""", (info["scope"],))
        pending = await db.fetch_one(conn, "select count(*) as n from mcp_drafts where created_by = %s and status = 'pending'",
                                     (admin.user_id,))
    return {"server": server, "enabled": enabled(server), "endpoint": oauth.origin().rstrip("/") + info["path"],
            "scope": info["scope"], "info": info, "clients": clients, "stats30d": stats, "pendingDrafts": pending["n"],
            "draftTtlMinutes": config.settings.mcp_draft_ttl_min}


@router.get("/tools")
async def tools(server: str = ServerParam):
    """The catalog for one server: tools with mode, domain, parameters and link template, plus domains and prompts."""
    used = {t["domain"] for t in CATALOG["tools"] if t["server"] == server}
    return {"server": CATALOG["servers"][server], "origin": oauth.origin().rstrip("/"),
            "domains": {k: v for k, v in CATALOG["domains"].items() if k in used},
            "prompts": [p for p in CATALOG["prompts"] if p["server"] == server],
            "tools": tool_list(server)}


class InvokeIn(BaseModel):
    args: dict = Field(default_factory=dict)


@router.post("/tools/{name}/invoke")
async def invoke_tool(name: str, body: InvokeIn, server: str = ServerParam, admin: Principal = Depends(require_admin)):
    """Runs a tool as the admin. App tools run as the admin's own user; draft tools only return the draft."""
    if (server, name) not in {(t["server"], t["name"]) for t in CATALOG["tools"]}:
        raise HTTPException(404, "Ukendt værktøj")
    started = time.monotonic()
    result, is_error = await invoke(server, name, body.args, _caller(server, admin))
    return {"result": result, "isError": is_error, "ms": int((time.monotonic() - started) * 1000)}


@router.get("/drafts")
async def list_drafts(server: str | None = Query(None, pattern="^(app|admin)$"), admin: Principal = Depends(require_admin)):
    """The admin's own drafts from both servers (also those made from an MCP client)."""
    return {"drafts": await drafts.list_for(_caller(server or "admin", admin), server=server)}


class ConfirmIn(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


async def _draft_server(draft_id: str, admin: Principal) -> str:
    async with db.connection() as conn:
        row = await db.fetch_one(conn, "select server from mcp_drafts where id = %s and created_by = %s", (draft_id, admin.user_id))
    if row is None:
        raise HTTPException(404, "Kladden findes ikke")
    return row["server"]


@router.post("/drafts/{draft_id}/confirm")
async def confirm(draft_id: str, body: ConfirmIn, admin: Principal = Depends(require_admin_stepup)):
    server = await _draft_server(draft_id, admin)
    result, is_error = await invoke(server, "confirm_draft", {"draftId": draft_id, "reason": body.reason}, _caller(server, admin))
    if is_error:
        raise HTTPException(409, result["error"])
    return result


@router.post("/drafts/{draft_id}/cancel")
async def cancel(draft_id: str, admin: Principal = Depends(require_admin)):
    server = await _draft_server(draft_id, admin)
    result, is_error = await invoke(server, "cancel_draft", {"draftId": draft_id}, _caller(server, admin))
    if is_error:
        raise HTTPException(409, result["error"])
    return result


# ── Monitor ─────────────────────────────────────────────────────────────────

EVENT_SQL = """
    select l.id, l.ts, l.server, l.method, l.tool, l.status, l.duration_ms, l.client_id, c.name as client,
           coalesce(u.display_name, case when u.id is null then null else 'Bruger #' || u.id end) as user_name
    from mcp_log l left join users u on u.id = l.user_id left join mcp_clients c on c.id = l.client_id
"""


def _sse(row: dict) -> str:
    return f"id: {row['id']}\nevent: call\ndata: {json.dumps(row, default=str)}\n\n"


@router.get("/events")
async def events(server: str = ServerParam, limit: int = Query(50, ge=1, le=200)):
    """The latest calls, newest first (the monitor's start before the stream takes over)."""
    async with db.connection() as conn:
        rows = await db.fetch_all(conn, EVENT_SQL + " where l.server = %s order by l.id desc limit %s", (server, limit))
    return {"events": rows}


@router.get("/stream")
async def stream(request: Request, server: str = ServerParam):
    """Server-sent events: one `call` event per new mcp_log row (LISTEN mcp_log, NOTIFY on insert)."""

    async def gen():
        conn = await psycopg.AsyncConnection.connect(config.settings.database_url, autocommit=True, row_factory=dict_row)
        try:
            await conn.execute("listen mcp_log")
            yield ": connected\n\n"
            idle = 0.0
            while not await request.is_disconnected():
                ids = [int(n.payload) async for n in conn.notifies(timeout=1.0)]
                if not ids:
                    idle += 1.0
                    if idle >= 15:
                        idle = 0.0
                        yield ": ping\n\n"
                    continue
                idle = 0.0
                cur = await conn.execute(EVENT_SQL + " where l.id = any(%s) and l.server = %s order by l.id", (ids, server))
                for row in await cur.fetchall():
                    yield _sse(row)
        except asyncio.CancelledError:
            pass
        finally:
            await conn.close()

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

