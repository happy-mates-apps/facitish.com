"""Access tools on both endpoints (access_list, access_request) and the approver's tools on /mcp/admin
(access_requests_list, access_request_decide, user_set_audience). Rules: app/access.py and app/mcp/toolmap.py."""

from app import access, db
from app.mcp import endpoints
from app.mcp.common import limit, masked
from app.mcp.links import link_for
from app.mcp.registry import Caller, DraftPlan, ToolError, ToolOutput, draft, tool


def _links(*items) -> list[dict]:
    return [x for x in items if x]


async def _me(conn, user_id: int) -> dict:
    return await db.fetch_one(conn, "select id, email, phone, audience, display_name from users where id = %s", (user_id,))


async def _client_name(conn, caller: Caller) -> str:
    row = await db.fetch_one(conn, """select c.name from sessions s join mcp_clients c on c.id = s.mcp_client_id
                                      where s.id = %s""", (caller.principal.session_id,))
    return row["name"] if row else (caller.client_id or "MCP-klient")


async def access_list(args, caller: Caller) -> ToolOutput:
    async with db.connection() as conn:
        user = await _me(conn, caller.user_id)
        items = await access.available(conn, user, caller.principal.session_id, caller.server)
    return ToolOutput({"audience": user["audience"], "audienceLabel": access.AUDIENCE_LABELS[user["audience"]],
                       "items": items}, links=_links(link_for(caller.server, "access_list", {})))


async def access_request(args, caller: Caller) -> ToolOutput:
    if caller.client_id is None:
        raise ToolError("Adgang kan kun bedes om fra en MCP-klient")
    try:
        async with db.connection() as conn:
            user = await _me(conn, caller.user_id)
            row, created = await access.create(conn, user=user, session_id=caller.principal.session_id,
                                               endpoint=caller.server, client_name=await _client_name(conn, caller),
                                               target=args["target"], reason=args["reason"], meta=caller.principal.meta)
    except access.AccessError as e:
        raise ToolError(str(e))
    r = access.out(row)
    if r["status"] == "approved":
        text = f"Adgangen er allerede godkendt til {r['expiresAt']:%d.%m.%Y}"
    elif r["status"] == "awaiting_approver":
        text = "Brugeren har godkendt. Nu mangler en godkender i /admin"
    else:
        text = ("Anmodningen er sendt. Bed brugeren om at godkende den i Konto → MCP-adgang eller fra mailen"
                + (". Derefter skal en godkender i /admin også sige ja" if r["level"] == "confidential" else ""))
    return ToolOutput({"request": r, "created": created}, text=text,
                      links=_links(link_for(caller.server, "access_request", {})))


for _server in ("app", "admin"):
    tool(_server, "access_list")(access_list)
    tool(_server, "access_request")(access_request)


# ── Approver (/mcp/admin) ───────────────────────────────────────────────────

@tool("admin", "access_requests_list")
async def access_requests_list(args, caller: Caller) -> ToolOutput:
    try:
        async with db.connection() as conn:
            rows = await access.listing(conn, args.get("status") or "open", limit(args.get("limit"), 50, 200))
    except access.AccessError as e:
        raise ToolError(str(e))
    items = [access.out(r, mask=masked) for r in rows]
    return ToolOutput({"requests": items, "count": len(items)},
                      links=_links(link_for("admin", "access_requests_list", {})))


@draft("admin", "access_request_decide")
async def access_request_decide(args, caller: Caller, conn) -> DraftPlan:
    try:
        r = await access.get(conn, args["requestId"])
    except access.AccessError as e:
        raise ToolError(str(e))
    approver = await db.fetch_one(conn, "select * from users where id = %s", (caller.user_id,))
    if not access.is_approver(approver):
        raise ToolError("Kun admins med rollen Privatliv eller Fuld adgang kan godkende fortrolige data")
    if r["user_id"] == caller.user_id:
        raise ToolError("Du kan ikke godkende din egen anmodning")
    if r["status"] != "awaiting_approver":
        raise ToolError(f"Anmodningen er {access.STATUS_LABELS[r['effective_status']].lower()}, den afventer ikke en godkender")
    approve, days, note = args["approve"], args.get("days"), args.get("note")
    if approve and (days or access.DEFAULT_CONFIDENTIAL_DAYS) not in access.CONFIDENTIAL_DAYS:
        raise ToolError("days skal være 1, 7 eller 30")
    if not approve and not (note or "").strip():
        raise ToolError("Skriv en note, når du afviser")

    async def execute(conn):
        try:
            row = await access.decide_approver(conn, r["id"], approver=approver, approve=approve, days=days, note=note,
                                               via="mcp", meta=caller.principal.meta)
        except access.AccessError as e:
            raise ToolError(str(e))
        return {"request": access.out(row, mask=masked)}

    who = r["user_name"] or masked(r["user_email"]) or f"#{r['user_id']}"
    what = access.describe(r)
    summary = (f"Godkend i {days or access.DEFAULT_CONFIDENTIAL_DAYS} dage: {who} · {what}" if approve
               else f"Afvis: {who} · {what}")
    return DraftPlan(summary=summary,
                     impact={"bullets": [f"Klient: {r['client_name']} på {endpoints.path_for(r['endpoint'])}",
                                         f"Begrundelse: {r['reason']}",
                                         "Gælder kun den MCP-session, der bad om det"]},
                     state={"id": r["id"], "status": r["status"], "audience": r["user_audience"]}, execute=execute,
                     links=_links(link_for("admin", "access_request_decide", {"requestId": r["id"]})))


@draft("admin", "user_set_audience")
async def user_set_audience(args, caller: Caller, conn) -> DraftPlan:
    audience = args["audience"]
    if audience not in access.AUDIENCES:
        raise ToolError("audience skal være internal eller external")
    if len(args["reason"].strip()) < 5:
        raise ToolError("Skriv en begrundelse på mindst 5 tegn")
    u = await db.fetch_one(conn, "select * from users where id = %s", (args["userId"],))
    if u is None or u["impersonation_only"]:
        raise ToolError(f"Bruger #{args['userId']} findes ikke")
    if u["audience"] == audience:
        raise ToolError(f"Brugeren er allerede {access.AUDIENCE_LABELS[audience].lower()}")
    ending = await access.count_internal_grants(conn, u["id"]) if audience == "external" else 0

    async def execute(conn):
        user = await db.fetch_one(conn, "select * from users where id = %s for update", (u["id"],))
        n = await access.set_audience(conn, user, audience, actor_id=caller.user_id, meta=caller.principal.meta)
        return {"userId": u["id"], "audience": audience, "grantsEnded": n}

    name = u["display_name"] or masked(u["email"] or u["phone"]) or f"#{u['id']}"
    bullets = [f"Brugertype {access.AUDIENCE_LABELS[u['audience']]} → {access.AUDIENCE_LABELS[audience]}",
               f"Årsag: {args['reason']}"]
    if audience == "external":
        bullets.append(f"{ending} interne/fortrolige adgange og anmodninger ophører med det samme")
        bullets.append("Brugeren kan kun bruge hvide værktøjer og bede om egne data")
    else:
        bullets.append("Brugeren kan bruge grønne værktøjer og bede om gule og røde")
    return DraftPlan(summary=f"Gør {name} {access.AUDIENCE_LABELS[audience].lower()}.",
                     impact={"bullets": bullets, "diff": {"audience": [u["audience"], audience]}, "counts": {"grants": ending}},
                     state={"id": u["id"], "audience": u["audience"]}, execute=execute,
                     links=_links(link_for("admin", "user_set_audience", {"userId": u["id"]})))
