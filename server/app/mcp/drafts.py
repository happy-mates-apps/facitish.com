"""Drafts, after happy-groups superadmin/drafts.ts. A mutating tool only plans; nothing changes until the
creator calls confirm_draft(draftId, reason) within MCP_DRAFT_TTL_MIN. Confirm runs exactly once: the row is
locked, the plan is made again and must read the same state (state_hash), and execute() runs in the same
transaction as the audit row (action mcp.<tool>, via mcp:<server>, reason).
"""

import hashlib
import json
import secrets
from datetime import datetime, timedelta, timezone

from psycopg.types.json import Jsonb

from app import config, db
from app.logs import audit
from app.mcp.registry import HANDLERS, Caller, ToolError, ToolOutput, jsonable, tool

STATUS = {"pending": "Afventer", "confirmed": "Bekræftet", "cancelled": "Annulleret", "expired": "Udløbet", "failed": "Fejlede"}


def state_hash(state) -> str:
    return hashlib.sha256(json.dumps(jsonable(state), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _view(row: dict) -> dict:
    return {"draftId": row["id"], "server": row["server"], "tool": row["tool_name"], "args": row["args"],
            "summary": row["summary"], "impact": row["impact"], "links": row["links"], "status": row["status"],
            "statusText": STATUS[row["status"]], "createdAt": row["created_at"], "expiresAt": row["expires_at"],
            "confirmedAt": row["confirmed_at"], "reason": row["reason"], "result": row["result"]}


async def create(server: str, name: str, args: dict, caller: Caller) -> dict:
    handler = HANDLERS[(server, name)]
    async with db.connection() as conn:
        plan = await handler.plan(args, caller, conn)
        await conn.rollback()  # plan() never changes anything
        draft_id = "d_" + secrets.token_hex(4)
        expires = datetime.now(timezone.utc) + timedelta(minutes=config.settings.mcp_draft_ttl_min)
        row = await db.fetch_one(conn, """
            insert into mcp_drafts (id, server, tool_name, args, summary, impact, links, state_hash, created_by, expires_at)
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) returning *""",
            (draft_id, server, name, Jsonb(args), plan.summary, Jsonb(jsonable(plan.impact)), Jsonb(plan.links),
             state_hash(plan.state), caller.user_id, expires))
    return {**_view(row), "next": f"Vis brugeren opsummeringen og kald confirm_draft(draftId=\"{draft_id}\", reason) "
                                  "når de har sagt ja. Intet er ændret endnu."}


async def confirm(server: str, draft_id: str, reason: str, caller: Caller) -> dict:
    if len(reason.strip()) < 3:
        raise ToolError("Skriv en årsag (mindst 3 tegn) — den gemmes i audit-loggen")
    async with db.connection() as conn:
        row = await db.fetch_one(conn, "select * from mcp_drafts where id = %s and server = %s and created_by = %s for update",
                                 (draft_id, server, caller.user_id))
        if row is None:
            raise ToolError("Kladden findes ikke")
        if row["status"] != "pending":
            raise ToolError(f"Kladden er {STATUS[row['status']].lower()} og kan ikke bekræftes igen")
        if row["expires_at"] <= datetime.now(timezone.utc):
            await conn.execute("update mcp_drafts set status = 'expired' where id = %s", (draft_id,))
            await conn.commit()
            raise ToolError("Kladden er udløbet. Lav en ny.")
        handler = HANDLERS[(server, row["tool_name"])]
        error = ""
        try:
            plan = await handler.plan(row["args"], caller, conn)
        except ToolError as e:
            plan, error = None, str(e)
        if plan is None or state_hash(plan.state) != row["state_hash"]:
            await conn.rollback()
            await conn.execute("update mcp_drafts set status = 'failed', result = %s where id = %s",
                               (Jsonb({"error": "state_changed"}), draft_id))
            await conn.commit()
            raise ToolError("Data er ændret, siden kladden blev lavet. Intet er udført — lav en ny kladde."
                            if plan is not None else f"Kladden kan ikke udføres længere: {error}")
        result = jsonable(await plan.execute(conn))
        await audit(conn, f"mcp.{row['tool_name']}", actor_id=caller.user_id, meta=caller.principal.meta,
                    via=f"mcp:{server}" if caller.via == "mcp" else f"hub:{server}", draft=draft_id, reason=reason.strip(),
                    args=row["args"], client=caller.client_id)
        row = await db.fetch_one(conn, """
            update mcp_drafts set status = 'confirmed', confirmed_at = now(), reason = %s, result = %s
            where id = %s returning *""", (reason.strip(), Jsonb(result), draft_id))
    return _view(row)


async def cancel(server: str, draft_id: str, caller: Caller) -> dict:
    async with db.connection() as conn:
        row = await db.fetch_one(conn, """
            update mcp_drafts set status = 'cancelled' where id = %s and server = %s and created_by = %s and status = 'pending'
            returning *""", (draft_id, server, caller.user_id))
    if row is None:
        raise ToolError("Ingen afventende kladde med det id")
    return _view(row)


async def list_for(caller: Caller, server: str | None = None, status: str | None = None, limit: int = 100) -> list[dict]:
    where, params = ["created_by = %s"], [caller.user_id]
    if server:
        where.append("server = %s"); params.append(server)
    if status:
        where.append("status = %s"); params.append(status)
    async with db.connection() as conn:
        await conn.execute("update mcp_drafts set status = 'expired' where status = 'pending' and expires_at <= now()")
        rows = await db.fetch_all(conn, f"select * from mcp_drafts where {' and '.join(where)} order by created_at desc limit %s",
                                  params + [limit])
    return [_view(r) for r in rows]


# ── The draft tools on both servers ─────────────────────────────────────────

for _server in ("app", "admin"):
    def _register(server: str):
        @tool(server, "confirm_draft")
        async def confirm_draft(args, caller: Caller) -> ToolOutput:
            d = await confirm(server, args["draftId"], args["reason"], caller)
            return ToolOutput(d, links=d["links"], text=f"Udført: {d['summary']}")

        @tool(server, "cancel_draft")
        async def cancel_draft(args, caller: Caller) -> ToolOutput:
            d = await cancel(server, args["draftId"], caller)
            return ToolOutput(d, text="Kladden er annulleret. Intet er ændret.")

    _register(_server)


@tool("admin", "list_drafts")
async def list_drafts(args, caller: Caller) -> ToolOutput:
    from app.mcp.links import link_for
    rows = await list_for(caller, status=args.get("status"))
    return ToolOutput({"drafts": rows}, links=[link_for("admin", "list_drafts", {"tab": "drafts"})])
