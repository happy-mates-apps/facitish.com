"""Access requests from MCP clients, and internal/external users (specs/mcp/ACCESS.md).

What an MCP client may use is decided by the data catalog in /admin/data (app/mcp/toolmap.py): each tool on an
endpoint has a classification (Code tools their own, Data tools their dataset's), and some need a grant. A client
asks for one with `access_request(target, reason)`:

    target       what it opens                                        level          who may ask
    email        the user's own e-mail address in clear               own            everyone
    phone        the user's own phone number in clear                 own            everyone
    <tool name>  a yellow tool, or a Data tool's yellow fields        internal       internal users
                 a red tool, or a Data tool's red fields              confidential   internal users

Every request is approved by the user (from the list in /konto or the link in an e-mail); the client can never
approve itself. A confidential request then also needs an approver: an admin whose roles open /admin/access
(Fuld adgang, Privatliv), who is not the user, from the list in /admin/access, the link in an e-mail, or the
/mcp/admin draft access_request_decide. An approved row is the grant: it holds for that one MCP session until
expires_at, only while the user is still internal (internal and confidential grants), and ends when the session
ends, the user revokes it, or an approver revokes it. Every step is audited in the same transaction.
"""

import html
import logging
from datetime import datetime, timezone

from app import admin_roles, config, db, jobs, settings_store
from app.logs import RequestMeta, audit
from app.mail import send_mail
from app.security import new_token, token_hash

log = logging.getLogger("gaer.access")

AUDIENCES = ("internal", "external")
AUDIENCE_LABELS = {"internal": "Intern", "external": "Ekstern"}
OWN = {"email": "Din e-mailadresse i klartekst", "phone": "Dit telefonnummer i klartekst"}
DAYS = {"own": 90, "internal": 30, "confidential": 7}
LEVEL_LABELS = {"own": "Egne data", "internal": "Intern", "confidential": "Fortroligt"}
STATUS_LABELS = {"awaiting_user": "Afventer brugeren", "awaiting_approver": "Afventer godkender", "approved": "Godkendt",
                 "denied": "Afvist", "withdrawn": "Trukket tilbage", "revoked": "Tilbagekaldt", "expired": "Udløbet"}
OPEN = ("awaiting_user", "awaiting_approver")
CONFIDENTIAL_DAYS = (1, 7, 30)
DEFAULT_CONFIDENTIAL_DAYS = 7
ACCESS_SECTION = "/access"
MAX_APPROVER_MAILS = 20


class AccessError(Exception):
    """A Danish message for the user (routes turn it into 4xx, MCP tools into ToolError)."""

    def __init__(self, message: str, status: int = 409):
        super().__init__(message)
        self.status = status


def internal_domain(email: str | None) -> bool:
    if not email or "@" not in email:
        return False
    return email.rsplit("@", 1)[1].lower() in config.settings.internal_email_domains


def is_approver(user: dict) -> bool:
    """An admin whose roles open /admin/access. Blocked users and test accounts never approve."""
    if user.get("role") != "admin" or user.get("blocked_at") or user.get("impersonation_only"):
        return False
    roles = list(user.get("admin_roles") or []) + ([admin_roles.FULL] if user.get("super_admin") else [])
    return ACCESS_SECTION in admin_roles.sections(roles)


# ── Reading ─────────────────────────────────────────────────────────────────

REQUEST_COLUMNS = """r.*, u.display_name as user_name, u.email as user_email, u.audience as user_audience,
                     t.kind as tool_kind, d.name as dataset_name, a.display_name as approver_name,
                     case when r.status = 'approved' and r.expires_at <= now() then 'expired' else r.status end
                         as effective_status"""
REQUEST_FROM = """mcp_access_requests r join users u on u.id = r.user_id left join mcp_tools t on t.id = r.tool_id
                  left join datasets d on d.id = t.dataset_id left join users a on a.id = r.approver_id"""


def describe(row: dict) -> str:
    if row["target"] in OWN:
        return OWN[row["target"]]
    if row.get("dataset_name"):
        return f"Dataværktøjet {row['tool_name']} (datasæt: {row['dataset_name']})"
    return f"Værktøjet {row['tool_name']}"


def out(row: dict, *, mask=None) -> dict:
    """A request as the API and the MCP tools return it. `mask` masks the user's e-mail (admin lists)."""
    status = row.get("effective_status") or row["status"]
    return {"id": row["id"], "userId": row["user_id"], "userName": row.get("user_name"),
            "userEmail": mask(row.get("user_email")) if mask else None, "userAudience": row.get("user_audience"),
            "endpoint": row["endpoint"], "client": row["client_name"], "target": row["target"],
            "toolId": row["tool_id"], "toolName": row["tool_name"], "toolKind": row.get("tool_kind"),
            "datasetName": row.get("dataset_name"), "what": describe(row), "level": row["level"],
            "levelLabel": LEVEL_LABELS[row["level"]], "reason": row["reason"], "status": status,
            "statusLabel": STATUS_LABELS[status], "sessionActive": row["session_id"] is not None,
            "userDecidedAt": row["user_decided_at"], "userVia": row["user_via"], "approverName": row.get("approver_name"),
            "approverDecidedAt": row["approver_decided_at"], "approverVia": row["approver_via"], "note": row["note"],
            "durationDays": row["duration_days"], "expiresAt": row["expires_at"], "createdAt": row["created_at"]}


async def get(conn, request_id: int, lock: bool = False) -> dict:
    row = await db.fetch_one(conn, f"select {REQUEST_COLUMNS} from {REQUEST_FROM} where r.id = %s"
                             + (" for update of r" if lock else ""), (request_id,))
    if row is None:
        raise AccessError("Anmodningen findes ikke", 404)
    return row


async def for_user(conn, user_id: int) -> list[dict]:
    return await db.fetch_all(conn, f"""select {REQUEST_COLUMNS} from {REQUEST_FROM} where r.user_id = %s
                                        order by r.created_at desc limit 200""", (user_id,))


async def listing(conn, status: str = "open", limit: int = 100) -> list[dict]:
    where = {"open": "r.status = 'awaiting_approver'",
             "active": "r.status = 'approved' and r.expires_at > now()",
             "user": "r.status = 'awaiting_user'",
             "all": "true"}.get(status)
    if where is None:
        raise AccessError("status skal være open, active, user eller all", 422)
    return await db.fetch_all(conn, f"""select {REQUEST_COLUMNS} from {REQUEST_FROM} where {where}
                                        order by r.created_at desc limit %s""", (limit,))


ACTIVE = "r.user_id = %s and r.session_id = %s and r.status = 'approved' and r.expires_at > now()"


async def own_grant(conn, user_id: int, session_id: int, target: str) -> dict | None:
    """The session's grant to see the user's own e-mail or phone in clear."""
    return await db.fetch_one(conn, f"""select r.* from mcp_access_requests r where {ACTIVE} and r.target = %s
                                        order by r.expires_at desc limit 1""", (user_id, session_id, target))


async def tool_grant(conn, user_id: int, session_id: int, tool_id: int) -> dict | None:
    """The session's strongest grant for a tool. Only counts while the user is internal."""
    return await db.fetch_one(conn, f"""
        select r.* from mcp_access_requests r join users u on u.id = r.user_id
        where {ACTIVE} and r.tool_id = %s and u.audience = 'internal'
        order by (r.level = 'confidential') desc, r.expires_at desc limit 1""", (user_id, session_id, tool_id))


async def available(conn, user: dict, session_id: int | None, endpoint: str) -> list[dict]:
    """What this user may ask for in this session on this endpoint, with the state of each."""
    from app.mcp import toolmap

    rows = await db.fetch_all(conn, """
        select distinct on (target, coalesce(tool_id, 0), level) target, tool_id, level, expires_at,
               case when status = 'approved' and expires_at <= now() then 'expired' else status end as effective_status
        from mcp_access_requests where user_id = %s and session_id is not distinct from %s
        order by target, coalesce(tool_id, 0), level, created_at desc""", (user["id"], session_id))
    internal = user["audience"] == "internal"

    def state(target, tool_id, level):
        r = next((x for x in rows if x["target"] == target and x["tool_id"] == tool_id and x["level"] == level), None)
        status = r["effective_status"] if r else None
        if status == "approved" and level != "own" and not internal:
            status = "suspended"
        return {"status": status, "expiresAt": r["expires_at"] if r else None}

    items = [{"target": k, "label": v, "level": "own", "levelLabel": LEVEL_LABELS["own"], "needsApprover": False,
              "mayRequest": bool(user[k]), **state(k, None, "own")} for k, v in OWN.items()]
    for t in await toolmap.for_endpoint(conn, endpoint):
        level = toolmap.request_level(t)
        if level is None or t["name"] in toolmap.CORE:
            continue
        items.append({"target": t["name"], "label": f"{'Dataværktøj' if t['kind'] == 'data' else 'Værktøj'} {t['name']}",
                      "kind": t["kind"], "classification": t["classification"], "level": level,
                      "levelLabel": LEVEL_LABELS[level], "needsApprover": level == "confidential",
                      "mayRequest": internal, **state("tool", t["id"], level)})
    return items


# ── Changing ────────────────────────────────────────────────────────────────

async def create(conn, *, user: dict, session_id: int, endpoint: str, client_name: str, target: str, reason: str,
                 meta: RequestMeta) -> tuple[dict, bool]:
    """A new request (or the open/active one for the same thing in this session). Returns (row, created)."""
    from app.mcp import toolmap

    reason = (reason or "").strip()
    if len(reason) < 5 or len(reason) > 500:
        raise AccessError("Skriv en begrundelse på 5–500 tegn", 422)
    tool = None
    if target in OWN:
        if not user[target]:
            raise AccessError("Du har ingen " + ("e-mailadresse" if target == "email" else "telefonnummer") + " på kontoen")
        level = "own"
    else:
        tool = await toolmap.resolve(conn, endpoint, target)
        if tool is None:
            raise AccessError(f"Ukendt værktøj: {target}. Brug email, phone eller et værktøj fra access_list", 404)
        if user["audience"] != "internal":
            raise AccessError("Eksterne brugere kan kun bede om adgang til deres egne data (email, phone)", 403)
        level = toolmap.request_level(tool)
        if level is None or tool["name"] in toolmap.CORE:
            raise AccessError(f"{target} kræver ingen adgang — kald det direkte")

    existing = await db.fetch_one(conn, """
        select r.id from mcp_access_requests r
        where r.user_id = %s and r.session_id = %s and r.target = %s and r.tool_id is not distinct from %s
          and r.level = %s
          and (r.status in ('awaiting_user', 'awaiting_approver') or (r.status = 'approved' and r.expires_at > now()))
        order by r.created_at desc limit 1""",
        (user["id"], session_id, "tool" if tool else target, tool["id"] if tool else None, level))
    if existing:
        return await get(conn, existing["id"]), False
    open_count = await db.fetch_one(conn, """select count(*) as n from mcp_access_requests
                                              where user_id = %s and status in ('awaiting_user', 'awaiting_approver')""",
                                    (user["id"],))
    if open_count["n"] >= 20:
        raise AccessError("Du har for mange åbne anmodninger. Godkend eller afvis nogle først i Konto → MCP-adgang", 429)

    row = await db.fetch_one(conn, """
        insert into mcp_access_requests (user_id, session_id, endpoint, client_name, target, tool_id, tool_name, level,
                                         reason, duration_days)
        values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) returning id""",
        (user["id"], session_id, endpoint, client_name, "tool" if tool else target, tool["id"] if tool else None,
         tool["name"] if tool else None, level, reason, DAYS[level]))
    await audit(conn, "mcp_access.requested", actor_id=user["id"], meta=meta, table="mcp_access_requests",
                row_id=row["id"], after={"target": target, "level": level, "endpoint": endpoint, "client": client_name})
    await jobs.enqueue(conn, "mcp_access.notify", {"request_id": row["id"], "step": "user"})
    return await get(conn, row["id"]), True


async def decide_user(conn, request_id: int, *, user_id: int, approve: bool, via: str, meta: RequestMeta) -> dict:
    r = await get(conn, request_id, lock=True)
    if r["user_id"] != user_id:
        raise AccessError("Anmodningen findes ikke", 404)
    if r["status"] != "awaiting_user":
        raise AccessError(f"Anmodningen er allerede {STATUS_LABELS[r['effective_status']].lower()}")
    if approve and r["session_id"] is None:
        raise AccessError("MCP-klienten er ikke længere forbundet. Anmodningen kan kun afvises")
    if approve and r["level"] != "own" and r["user_audience"] != "internal":
        raise AccessError("Kun interne brugere kan få adgang til disse data", 403)
    if not approve:
        status = "denied"
    else:
        status = "awaiting_approver" if r["level"] == "confidential" else "approved"
    await conn.execute("""
        update mcp_access_requests set status = %s, user_decided_at = now(), user_via = %s, updated_at = now(),
               expires_at = case when %s = 'approved' then now() + make_interval(days => duration_days) end
        where id = %s""", (status, via, status, request_id))
    await audit(conn, "mcp_access.user_" + ("approved" if approve else "denied"), actor_id=user_id, meta=meta,
                table="mcp_access_requests", row_id=request_id, before={"status": r["status"]}, after={"status": status},
                via=via)
    await _close_links(conn, request_id, "user")
    if status == "awaiting_approver":
        await jobs.enqueue(conn, "mcp_access.notify", {"request_id": request_id, "step": "approver"})
    return await get(conn, request_id)


async def decide_approver(conn, request_id: int, *, approver: dict, approve: bool, days: int | None, note: str | None,
                          via: str, meta: RequestMeta) -> dict:
    """`approver` is the users row of the admin deciding."""
    r = await get(conn, request_id, lock=True)
    if not is_approver(approver):
        raise AccessError("Kun admins med rollen Privatliv eller Fuld adgang kan godkende fortrolige data", 403)
    if r["user_id"] == approver["id"]:
        raise AccessError("Du kan ikke godkende din egen anmodning", 403)
    if r["status"] != "awaiting_approver":
        raise AccessError(f"Anmodningen er {STATUS_LABELS[r['effective_status']].lower()}, den afventer ikke en godkender")
    note = (note or "").strip()[:500] or None
    if approve:
        if r["user_audience"] != "internal":
            raise AccessError("Brugeren er ekstern og kan ikke få adgang til fortrolige data", 409)
        if r["session_id"] is None:
            raise AccessError("MCP-klienten er ikke længere forbundet. Anmodningen kan kun afvises")
        days = days or DEFAULT_CONFIDENTIAL_DAYS
        if days not in CONFIDENTIAL_DAYS:
            raise AccessError(f"Varigheden skal være {', '.join(map(str, CONFIDENTIAL_DAYS))} dage", 422)
    elif not note:
        raise AccessError("Skriv en begrundelse, når du afviser", 422)
    status = "approved" if approve else "denied"
    await conn.execute("""
        update mcp_access_requests set status = %s, approver_id = %s, approver_decided_at = now(), approver_via = %s,
               note = %s, duration_days = coalesce(%s, duration_days), updated_at = now(),
               expires_at = case when %s = 'approved' then now() + make_interval(days => %s) end
        where id = %s""", (status, approver["id"], via, note, days, status, days or 0, request_id))
    await audit(conn, "mcp_access." + ("approved" if approve else "denied"), actor_id=approver["id"], meta=meta,
                table="mcp_access_requests", row_id=request_id, before={"status": r["status"]},
                after={"status": status, "days": days if approve else None}, via=via, note=note, user_id=r["user_id"])
    await _close_links(conn, request_id, "approver")
    return await get(conn, request_id)




async def revoke(conn, request_id: int, *, actor_id: int, by_owner: bool, meta: RequestMeta, reason: str | None = None) -> dict:
    """The user withdraws an open request or revokes a grant; an approver revokes a grant."""
    r = await get(conn, request_id, lock=True)
    if by_owner and r["user_id"] != actor_id:
        raise AccessError("Anmodningen findes ikke", 404)
    if r["status"] in OPEN and by_owner:
        status = "withdrawn"
    elif r["status"] == "approved" and r["effective_status"] == "approved":
        status = "revoked"
    else:
        raise AccessError(f"Anmodningen er {STATUS_LABELS[r['effective_status']].lower()}")
    await conn.execute("update mcp_access_requests set status = %s, updated_at = now(), note = coalesce(%s, note) where id = %s",
                       (status, reason, request_id))
    await audit(conn, "mcp_access." + status, actor_id=actor_id, meta=meta, table="mcp_access_requests",
                row_id=request_id, before={"status": r["status"]}, after={"status": status}, by_owner=by_owner,
                reason=reason)
    await _close_links(conn, request_id, None)
    return await get(conn, request_id)


async def set_audience(conn, user: dict, audience: str, *, actor_id: int, meta: RequestMeta) -> int:
    """Marks a user internal or external. Going external ends the user's internal and confidential grants and open
    requests at once. Returns how many were ended."""
    if audience not in AUDIENCES:
        raise AccessError("Brugertypen skal være internal eller external", 422)
    if user["audience"] == audience:
        return 0
    await conn.execute("update users set audience = %s, updated_at = now() where id = %s", (audience, user["id"]))
    await audit(conn, "update", actor_id=actor_id, meta=meta, table="users", row_id=user["id"],
                before={"audience": user["audience"]}, after={"audience": audience})
    if audience == "internal":
        return 0
    ended = await db.fetch_all(conn, """
        update mcp_access_requests set status = case when status = 'approved' then 'revoked' else 'withdrawn' end,
               note = coalesce(note, 'Brugeren blev ekstern'), updated_at = now()
        where user_id = %s and level <> 'own'
          and (status in ('awaiting_user', 'awaiting_approver') or (status = 'approved' and expires_at > now()))
        returning id, status""", (user["id"],))
    for e in ended:
        await audit(conn, "mcp_access." + e["status"], actor_id=actor_id, meta=meta, table="mcp_access_requests",
                    row_id=e["id"], after={"status": e["status"]}, reason="user_became_external")
    return len(ended)


async def count_internal_grants(conn, user_id: int) -> int:
    row = await db.fetch_one(conn, """select count(*) as n from mcp_access_requests where user_id = %s and level <> 'own'
                                      and (status in ('awaiting_user', 'awaiting_approver')
                                           or (status = 'approved' and expires_at > now()))""", (user_id,))
    return row["n"]


# ── E-mail links ────────────────────────────────────────────────────────────

async def make_link(conn, request_id: int, recipient_id: int, step: str) -> str:
    token = new_token()
    await conn.execute("""insert into mcp_access_links (token_hash, request_id, recipient_id, step, expires_at)
                          values (%s, %s, %s, %s, now() + make_interval(hours => %s))""",
                       (token_hash(token), request_id, recipient_id, step, config.settings.mcp_access_link_hours))
    return token


async def check_link(conn, token: str, *, user_id: int, step: str, request_id: int | None = None) -> dict:
    """The link from an e-mail. It belongs to the person it was sent to, and they must be logged in as themselves."""
    row = await db.fetch_one(conn, "select * from mcp_access_links where token_hash = %s", (token_hash(token or ""),))
    if row is None or row["step"] != step or (request_id is not None and row["request_id"] != request_id):
        raise AccessError("Linket er ugyldigt", 404)
    if row["recipient_id"] != user_id:
        raise AccessError("Linket blev sendt til en anden. Log ind som modtageren af mailen", 403)
    if row["used_at"] is not None or row["expires_at"] <= datetime.now(timezone.utc):
        raise AccessError("Linket er brugt eller udløbet. Find anmodningen på listen i stedet", 410)
    return row


async def _close_links(conn, request_id: int, step: str | None) -> None:
    await conn.execute("""update mcp_access_links set used_at = now() where request_id = %s and used_at is null
                          and (%s::text is null or step = %s)""", (request_id, step, step))


def _mail(*, greeting: str, lines: list[str], button: str, url: str, footer: str) -> tuple[str, str]:
    text = "\n\n".join([greeting, *lines, f"{button}: {url}", footer])
    body = (f"<p>{html.escape(greeting)}</p>" + "".join(f"<p>{html.escape(x)}</p>" for x in lines)
            + f'<p><a href="{html.escape(url)}" style="display:inline-block;background:#2563eb;color:#f8fafc;'
              f'padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">{html.escape(button)}</a></p>'
            + f'<p style="color:#64748b;font-size:13px">{html.escape(footer)}</p>')
    return text, body


async def approvers(conn, exclude_user_id: int) -> list[dict]:
    rows = await db.fetch_all(conn, """select id, email, display_name, role, admin_roles, super_admin, blocked_at,
                                              impersonation_only from users
                                       where role = 'admin' and blocked_at is null and not impersonation_only
                                         and id <> %s order by id""", (exclude_user_id,))
    return [r for r in rows if is_approver(r)]


@jobs.handler("mcp_access.notify")
async def notify(payload: dict, job: dict) -> dict:
    """Fans out one mail job per recipient, so a failed mail is retried without sending the others twice."""
    async with db.connection() as conn:
        r = await get(conn, payload["request_id"])
        step = payload["step"]
        if r["status"] != ("awaiting_user" if step == "user" else "awaiting_approver"):
            return {"skipped": r["status"]}
        if step == "user":
            recipients = [r["user_id"]] if r["user_email"] else []
        else:
            recipients = [a["id"] for a in await approvers(conn, r["user_id"]) if a["email"]][:MAX_APPROVER_MAILS]
        for rid in recipients:
            await jobs.enqueue(conn, "mcp_access.mail", {"request_id": r["id"], "step": step, "recipient_id": rid})
    return {"recipients": len(recipients)}


@jobs.handler("mcp_access.mail")
async def send_one(payload: dict, job: dict) -> dict:
    async with db.connection() as conn:
        r = await get(conn, payload["request_id"])
        step = payload["step"]
        if r["status"] != ("awaiting_user" if step == "user" else "awaiting_approver"):
            return {"skipped": r["status"]}
        to = await db.fetch_one(conn, "select id, email, display_name from users where id = %s", (payload["recipient_id"],))
        if not to or not to["email"]:
            return {"skipped": "no_email"}
        token = await make_link(conn, r["id"], to["id"], step)
        app_name = (await settings_store.get_all(conn))["app_name"]
    origin = config.settings.origin.rstrip("/")
    hours = config.settings.mcp_access_link_hours
    what = describe(r)
    who = r["user_name"] or "En bruger"
    if step == "user":
        subject = f"{r['client_name']} beder om adgang: {what}"
        text, body = _mail(
            greeting=f"Hej {to['display_name'] or ''}".strip() + ",",
            lines=[f"MCP-klienten {r['client_name']} har bedt om adgang til: {what}.", f"Begrundelse: {r['reason']}",
                   *(["Dataene er fortrolige. Når du har godkendt, skal en godkender også sige ja."]
                     if r["level"] == "confidential" else [])],
            button="Se og godkend", url=f"{origin}/godkend?t={token}",
            footer=f"Linket virker i {hours} timer og kun for dig, når du er logget ind. Du kan også godkende eller "
                   f"afvise under Konto → MCP-adgang. Kender du ikke anmodningen, så afvis den.")
    else:
        subject = f"Godkend adgang: {who} vil læse {what}"
        text, body = _mail(
            greeting=f"Hej {to['display_name'] or ''}".strip() + ",",
            lines=[f"{who} ({'intern' if r['user_audience'] == 'internal' else 'ekstern'}) har bedt om, at MCP-klienten "
                   f"{r['client_name']} må læse {what}. Dataene er fortrolige.",
                   f"Begrundelse: {r['reason']}", "Brugeren har selv godkendt anmodningen."],
            button="Se og godkend", url=f"{origin}/admin/access?request={r['id']}&t={token}",
            footer=f"Linket virker i {hours} timer og kun for dig. Du skal logge ind og bruge din anden faktor, før du "
                   f"kan godkende. Anmodningen står også på listen i /admin/access.")
    await send_mail(to["email"], subject, text, body, app_name)
    return {"sent": True}
