"""Tools for /mcp/admin — the whole instance, as an admin. Reads answer at once; every change is a draft that
runs only after confirm_draft (app/mcp/drafts.py). The changes reuse the same functions as /api/admin, so the
audit rows are the same as when the change is made in /admin.

Never here: granting admin to yourself, writing to log tables, SQL writes, or handing out a session token.
"""

from datetime import datetime

from fastapi import HTTPException

from app import config, db, gdpr, mfa, settings_store
from app.features_catalog import CATALOG as FEATURE_CATALOG
from app.logs import audit, changed
from app.mcp import app_map, db_tools
from app.mcp.common import limit, masked, store_file
from app.mcp.links import build, link_for, links_for, resolve
from app.mcp.registry import Caller, DraftPlan, ToolError, ToolOutput, draft, tool
from app.routes import admin as admin_routes
from app.routes import features as feature_routes
from app.routes import impersonation as imp_routes
from app.routes.me import ProfileIn, clean_profile, update_profile_fields
from app.security import InvalidEmail, InvalidPhone, normalize_email, normalize_phone

S = "admin"
RING_NAMES = {1: "Internt", 2: "Beta", 3: "Preview", 4: "Stabilt"}


def _links(*items) -> list[dict]:
    return [x for x in items if x]


async def _user(conn, user_id: int, lock: bool = False) -> dict:
    row = await db.fetch_one(conn, "select * from users where id = %s" + (" for update" if lock else ""), (user_id,))
    if row is None:
        raise ToolError(f"Bruger #{user_id} findes ikke")
    return row


def _name(u: dict) -> str:
    return u["display_name"] or masked(u.get("email") or u["phone"]) or f"#{u['id']}"


async def _active_sessions(conn, user_id: int) -> int:
    row = await db.fetch_one(conn, """select count(*) as n from sessions where user_id = %s and revoked_at is null
                                      and expires_at > now()""", (user_id,))
    return row["n"]


# ── Core ────────────────────────────────────────────────────────────────────

@tool(S, "whoami")
async def whoami(args, caller: Caller) -> ToolOutput:
    async with db.connection() as conn:
        user = await _user(conn, caller.user_id)
    return ToolOutput({"user": {"id": user["id"], "displayName": user["display_name"], "email": masked(user["email"]),
                                "phone": masked(user["phone"]), "role": user["role"]},
                       "sessionId": caller.principal.session_id, "client": caller.client_id,
                       "draftTtlMinutes": config.settings.mcp_draft_ttl_min, "instance": config.settings.origin})


# ── Navigation ──────────────────────────────────────────────────────────────

@tool(S, "nav_sections")
async def nav_sections(args, caller: Caller) -> ToolOutput:
    return ToolOutput({"sections": [{**s, "url": build(s["path"])} for s in app_map.sections()]})


@tool(S, "nav_resolve")
async def nav_resolve(args, caller: Caller) -> ToolOutput:
    hits = app_map.search(args["q"])
    if not hits:
        raise ToolError("Fandt ingen skærm, der passer. Prøv nav_sections for hele oversigten.")
    return ToolOutput({"matches": hits}, links=[{"label": h["title"], "url": build(h["path"])} for h in hits])


@tool(S, "ui_deeplink")
async def ui_deeplink(args, caller: Caller) -> ToolOutput:
    path, focus = args["path"], args.get("focus")
    if not resolve(path, focus):
        anchors = next((s["anchors"] for s in app_map.sections() if s["path"] == path), None)
        if anchors is None:
            raise ToolError(f"{path} er ikke en kendt skærm. Se nav_sections.")
        raise ToolError(f"{focus} findes ikke på {path}. Mulige: {', '.join(anchors) or 'ingen'}")
    url = build(path, focus=focus)
    return ToolOutput({"url": url}, links=[{"label": path, "url": url}])


# ── Statistics ──────────────────────────────────────────────────────────────

@tool(S, "stats_overview")
async def stats_overview(args, caller: Caller) -> ToolOutput:
    days = limit(args.get("days"), 30, 400)
    a = await admin_routes.analytics(days)
    return ToolOutput({"days": days, "users": a["users"], "pageviews": a["totals"]["pageviews"],
                       "visits": a["totals"]["visits"], "visitors": a["totals"]["visitors"],
                       "anonymousPageviews": a["totals"]["anonymous_pageviews"], "logins": a["logins"],
                       "topFeatures": a.get("features", [])[:5]},
                      links=_links(link_for(S, "stats_overview", {"days": days})))


BREAKDOWNS = {"pages": "pages", "sources": "sources", "devices": "devices", "browsers": "browsers", "entries": "entries",
              "flows": "flows"}


@tool(S, "stats_breakdown")
async def stats_breakdown(args, caller: Caller) -> ToolOutput:
    by = args["by"]
    if by not in BREAKDOWNS:
        raise ToolError(f"by skal være en af: {', '.join(BREAKDOWNS)}")
    days = limit(args.get("days"), 30, 400)
    a = await admin_routes.analytics(days)
    return ToolOutput({"days": days, "by": by, "rows": a[BREAKDOWNS[by]]},
                      links=_links(link_for(S, "stats_breakdown", {"days": days, "by": by})))


@tool(S, "stats_logins")
async def stats_logins(args, caller: Caller) -> ToolOutput:
    days = limit(args.get("days"), 30, 400)
    a = await admin_routes.analytics(days)
    return ToolOutput({"days": days, "logins": a["logins"], "perDay": a["logins_per_day"],
                       "withPasskey": a["users"]["with_passkey"], "mustCreatePasskey": a["users"]["must_passkey"]},
                      links=_links(link_for(S, "stats_logins", {"days": days})))


# ── Users ───────────────────────────────────────────────────────────────────

USER_FILTERS = {
    "all": "true", "active": "u.blocked_at is null", "blocked": "u.blocked_at is not null",
    "nopk": "not u.impersonation_only and not exists (select 1 from passkeys p where p.user_id = u.id)",
    "admins": "u.role = 'admin'", "test": "u.impersonation_only",
}
USER_COLUMNS = """u.id, u.display_name, u.email, u.phone, u.role, u.blocked_at, u.created_at, u.last_login_at, u.grace_logins_used,
                  u.impersonation_only, u.mfa_required, u.locale, u.time_zone,
                  (select count(*) from passkeys p where p.user_id = u.id) as passkeys,
                  (select count(*) from totp_factors t where t.user_id = u.id and t.confirmed_at is not null) as totp,
                  (select count(*) from sessions s where s.user_id = u.id and s.revoked_at is null and s.expires_at > now())
                      as active_sessions"""


def _user_out(u: dict) -> dict:
    return {"userId": u["id"], "name": u["display_name"], "email": masked(u["email"]), "phone": masked(u["phone"]), "role": u["role"],
            "blocked": u["blocked_at"] is not None, "testAccount": u["impersonation_only"], "passkeys": u["passkeys"],
            "authenticatorApps": u["totp"], "mfaRequired": u["mfa_required"],
            "activeSessions": u["active_sessions"], "graceLoginsUsed": u["grace_logins_used"],
            "lastLoginAt": u["last_login_at"], "createdAt": u["created_at"]}


@tool(S, "user_search")
async def user_search(args, caller: Caller) -> ToolOutput:
    f = args.get("filter") or "all"
    if f not in USER_FILTERS:
        raise ToolError(f"filter skal være en af: {', '.join(USER_FILTERS)}")
    q = args["q"].strip()
    where = [USER_FILTERS[f], "(not u.impersonation_only or u.impersonation_owner_id = %s)"]
    params: list = [caller.user_id]
    if q and q != "*":
        try:  # e-mail addresses and phone numbers are matched in full, never by fragment
            if "@" in q:
                where.append("u.email = %s")
                params.append(normalize_email(q))
            else:
                where.append("u.phone = %s")
                params.append(normalize_phone(q))
        except (InvalidEmail, InvalidPhone):
            where.append("coalesce(u.display_name, '') ilike %s")
            params.append(f"%{q}%")
    async with db.connection() as conn:
        rows = await db.fetch_all(conn, f"""select {USER_COLUMNS} from users u where {' and '.join(where)}
                                           order by u.created_at limit %s""", params + [limit(args.get("limit"), 20, 100)])
    users = [_user_out(u) for u in rows]
    return ToolOutput({"users": users, "count": len(users)},
                      links=_links(link_for(S, "user_search", {"q": q, "filter": f})) + links_for(S, "user_get", users, label="name"))


@tool(S, "user_get")
async def user_get(args, caller: Caller) -> ToolOutput:
    async with db.connection() as conn:
        u = await db.fetch_one(conn, f"select {USER_COLUMNS} from users u where u.id = %s", (args["userId"],))
        if u is None or (u["impersonation_only"] and not await imp_routes._owned(conn, u["id"], caller.user_id)):
            raise ToolError(f"Bruger #{args['userId']} findes ikke")
        extra = await db.fetch_one(conn, """
            select (select coalesce(sum(size_bytes), 0) from files where user_id = %(u)s) as file_bytes,
                   (select count(*) from files where user_id = %(u)s) as files,
                   (select ring from feature_rings where user_id = %(u)s) as feature_ring,
                   (select count(*) from sessions where user_id = %(u)s and mcp_client_id is not null and revoked_at is null
                        and expires_at > now()) as mcp_clients""", {"u": u["id"]})
    out = {**_user_out(u), "files": extra["files"], "fileBytes": extra["file_bytes"], "locale": u["locale"],
           "timeZone": u["time_zone"], "featureLevel": extra["feature_ring"] or 4, "mcpClients": extra["mcp_clients"]}
    return ToolOutput({"user": out}, links=_links(link_for(S, "user_get", {"userId": u["id"]}, _name(u))))


@draft(S, "user_set_role")
async def user_set_role(args, caller: Caller, conn) -> DraftPlan:
    role = args["role"]
    if role not in ("user", "admin"):
        raise ToolError("role skal være user eller admin")
    if args["userId"] == caller.user_id:
        raise ToolError("Du kan ikke ændre din egen rolle via MCP")
    u = await _user(conn, args["userId"], lock=True)
    if u["role"] == role:
        raise ToolError(f"{_name(u)} har allerede rollen {role}")

    async def execute(conn):
        await admin_routes.do_set_role(conn, await _user(conn, u["id"], lock=True), role, caller.principal)
        return {"userId": u["id"], "role": role}

    bullets = [f"Rolle {u['role']} → {role}", "Ændringen gælder fra næste kald"]
    if role == "admin":
        bullets.append("Brugeren får adgang til /admin og /mcp/admin")
    return DraftPlan(summary=f"Giv {_name(u)} rollen {role}.", impact={"bullets": bullets, "diff": {"role": [u["role"], role]}},
                     state={"id": u["id"], "role": u["role"], "blocked": u["blocked_at"]}, execute=execute,
                     links=_links(link_for(S, "user_set_role", {"userId": u["id"]})))


@draft(S, "user_block")
async def user_block(args, caller: Caller, conn) -> DraftPlan:
    u = await _user(conn, args["userId"], lock=True)
    if u["id"] == caller.user_id:
        raise ToolError("Du kan ikke spærre dig selv")
    if u["blocked_at"]:
        raise ToolError(f"{_name(u)} er allerede spærret")
    sessions = await _active_sessions(conn, u["id"])

    async def execute(conn):
        n = await admin_routes.do_block(conn, await _user(conn, u["id"], lock=True), caller.principal)
        return {"userId": u["id"], "blocked": True, "sessionsEnded": n}

    return DraftPlan(summary=f"Spær {_name(u)} og log ud alle steder.",
                     impact={"bullets": [f"{sessions} aktive sessioner afsluttes, også MCP-klienter", f"Årsag: {args['reason']}"],
                             "counts": {"sessions": sessions}},
                     state={"id": u["id"], "blocked": None, "role": u["role"]}, execute=execute,
                     links=_links(link_for(S, "user_block", {"userId": u["id"]})))


@draft(S, "user_unblock")
async def user_unblock(args, caller: Caller, conn) -> DraftPlan:
    u = await _user(conn, args["userId"], lock=True)
    if not u["blocked_at"]:
        raise ToolError(f"{_name(u)} er ikke spærret")

    async def execute(conn):
        await admin_routes.do_unblock(conn, u, caller.principal)
        return {"userId": u["id"], "blocked": False}

    return DraftPlan(summary=f"Ophæv spærringen af {_name(u)}.", impact={"bullets": ["Brugeren kan logge ind igen"]},
                     state={"id": u["id"], "blocked": u["blocked_at"]}, execute=execute,
                     links=_links(link_for(S, "user_unblock", {"userId": u["id"]})))


@draft(S, "user_reset_passkeys")
async def user_reset_passkeys(args, caller: Caller, conn) -> DraftPlan:
    u = await _user(conn, args["userId"], lock=True)
    n = (await db.fetch_one(conn, "select count(*) as n from passkeys where user_id = %s", (u["id"],)))["n"]
    if not n:
        raise ToolError(f"{_name(u)} har ingen passkeys")

    async def execute(conn):
        deleted = await admin_routes.do_reset_passkeys(conn, await _user(conn, u["id"], lock=True), caller.principal)
        return {"userId": u["id"], "deleted": deleted}

    return DraftPlan(summary=f"Nulstil {n} passkeys for {_name(u)}.",
                     impact={"bullets": [f"{n} passkeys og sikkerhedsnøgler slettes; godkendelsesapps bevares",
                                         "Brugeren logges ud alle steder og logger ind med en engangskode"],
                             "counts": {"passkeys": n}},
                     state={"id": u["id"], "passkeys": n}, execute=execute,
                     links=_links(link_for(S, "user_reset_passkeys", {"userId": u["id"]})))


@draft(S, "user_reset_mfa")
async def user_reset_mfa(args, caller: Caller, conn) -> DraftPlan:
    u = await _user(conn, args["userId"], lock=True)
    if u["id"] == caller.user_id:
        raise ToolError("Dine egne nøgler styrer du under Konto")
    if u["role"] == "admin" and not caller.principal.super_admin:
        raise ToolError("Kun superadministratoren kan nulstille en anden administrators MFA")
    f = await mfa.factors(conn, u["id"])
    if not f["total"] and not u["mfa_required"]:
        raise ToolError(f"{_name(u)} har ingen passkeys, sikkerhedsnøgler eller godkendelsesapps")

    async def execute(conn):
        deleted = await admin_routes.do_reset_mfa(conn, await _user(conn, u["id"], lock=True), caller.principal)
        return {"userId": u["id"], "deleted": deleted}

    bullets = [f"{f['passkeys'] + f['security_keys']} passkeys/sikkerhedsnøgler og {f['totp']} godkendelsesapps slettes",
               "“Kræv passkey” slås fra", "Brugeren logges ud alle steder og logger ind med en engangskode",
               f"Årsag: {args['reason']}"]
    return DraftPlan(summary=f"Nulstil MFA for {_name(u)}.", impact={"bullets": bullets, "counts": f},
                     state={"id": u["id"], "factors": f["total"], "mfa_required": u["mfa_required"]}, execute=execute,
                     links=_links(link_for(S, "user_reset_mfa", {"userId": u["id"]})))


@draft(S, "user_profile_set")
async def user_profile_set(args, caller: Caller, conn) -> DraftPlan:
    """Rectification of name, language and time zone (validated like PATCH /api/admin/users/{id}/profile)."""
    u = await _user(conn, args["userId"], lock=True)
    if u["impersonation_only"] and not await imp_routes._owned(conn, u["id"], caller.user_id):
        raise ToolError(f"Bruger #{args['userId']} findes ikke")
    sent = {k: args[k] for k in ("displayName", "locale", "timeZone") if k in args}
    if not sent:
        raise ToolError("Angiv mindst ét af displayName, locale og timeZone")
    try:
        values = clean_profile(ProfileIn(**{{"displayName": "display_name", "timeZone": "time_zone"}.get(k, k): v
                                             for k, v in sent.items()}))
    except HTTPException as e:
        raise ToolError(str(e.detail))
    diff = {k: [u[k], v] for k, v in values.items() if u[k] != v}
    if not diff:
        raise ToolError("Ingen ændringer")

    async def execute(conn):
        await update_profile_fields(conn, u["id"], values, actor_id=caller.user_id, meta=caller.principal.meta)
        return {"userId": u["id"], **values}

    labels = {"display_name": "Navn", "locale": "Sprog", "time_zone": "Tidszone"}
    return DraftPlan(summary=f"Ret profilen for {_name(u)}.",
                     impact={"bullets": [f"{labels[k]}: {a or '—'} → {b or '—'}" for k, (a, b) in diff.items()], "diff": diff},
                     state={"id": u["id"], **{k: u[k] for k in values}}, execute=execute,
                     links=_links(link_for(S, "user_profile_set", {"userId": u["id"]})))


@draft(S, "user_revoke_sessions")
async def user_revoke_sessions(args, caller: Caller, conn) -> DraftPlan:
    u = await _user(conn, args["userId"], lock=True)
    n = await _active_sessions(conn, u["id"])
    if not n:
        raise ToolError(f"{_name(u)} har ingen aktive sessioner")

    async def execute(conn):
        ended = await admin_routes.do_revoke_sessions(conn, u, caller.principal)
        return {"userId": u["id"], "sessionsEnded": ended}

    warn = ["Det omfatter også denne MCP-forbindelse"] if u["id"] == caller.user_id else []
    return DraftPlan(summary=f"Log {_name(u)} ud alle steder.",
                     impact={"bullets": [f"{n} sessioner og MCP-klienter afsluttes"], "counts": {"sessions": n}, "warnings": warn},
                     state={"id": u["id"]}, execute=execute,
                     links=_links(link_for(S, "user_revoke_sessions", {"userId": u["id"]})))


# ── Impersonation ───────────────────────────────────────────────────────────

@tool(S, "test_accounts_list")
async def test_accounts_list(args, caller: Caller) -> ToolOutput:
    async with db.connection() as conn:
        rows = await db.fetch_all(conn, """select id, display_name, role, phone, created_at from users
                                           where impersonation_only and impersonation_owner_id = %s order by created_at""",
                                  (caller.user_id,))
    accounts = [{"userId": r["id"], "displayName": r["display_name"], "role": r["role"], "handle": r["phone"],
                 "createdAt": r["created_at"]} for r in rows]
    return ToolOutput({"testAccounts": accounts}, links=_links(link_for(S, "test_accounts_list", {})))


@draft(S, "test_account_create")
async def test_account_create(args, caller: Caller, conn) -> DraftPlan:
    name, role = args["displayName"].strip()[:80], args["role"]
    if not name or role not in ("user", "admin"):
        raise ToolError("displayName og role (user eller admin) er påkrævet")

    async def execute(conn):
        u = await imp_routes._create(conn, caller.principal, name, role)
        return {"userId": u["id"], "displayName": name, "role": role, "handle": u["phone"]}

    return DraftPlan(summary=f"Opret testkontoen „{name}“ med rollen {role}.",
                     impact={"bullets": ["Kan ikke logge ind selv; kun du kan se og bruge den",
                                         "Bruges via efterligning i /admin"]},
                     state={"owner": caller.user_id, "name": name, "role": role}, execute=execute,
                     links=_links(link_for(S, "test_account_create", {})))


@draft(S, "impersonate_start")
async def impersonate_start(args, caller: Caller, conn) -> DraftPlan:
    target = await imp_routes._owned(conn, args["userId"], caller.user_id)
    if target is None:
        raise ToolError("Kun dine egne testkonti kan efterlignes — aldrig rigtige brugere")
    link = link_for(S, "impersonate_start", {"userId": target["id"]})

    async def execute(conn):
        # No session token over MCP: the admin starts it in the browser from the link.
        return {"userId": target["id"], "displayName": target["display_name"], "link": link,
                "next": "Åbn linket i browseren, hvor du er logget ind i /admin, og klik Skift til."}

    return DraftPlan(summary=f"Forbered efterligning af testkontoen „{target['display_name']}“ (årsag: {args['reason']}).",
                     impact={"bullets": ["Du får et link, der åbner Efterligning med testkontoen fremhævet",
                                         "Selve skiftet sker i browseren; MCP udleverer ingen session"]},
                     state={"id": target["id"]}, execute=execute, links=_links(link))


# ── Features ────────────────────────────────────────────────────────────────

@tool(S, "feature_list")
async def feature_list(args, caller: Caller) -> ToolOutput:
    data = await feature_routes.admin_features()
    items = [{**i, "ringName": RING_NAMES[i["ring"]]} for i in data["items"] if not args.get("ring") or i["ring"] == args["ring"]]
    return ToolOutput({"features": items, "missingFromDatabase": data["missing"], "userLevels": len(data["levels"])},
                      links=_links(link_for(S, "feature_list", {})))


@tool(S, "feature_usage")
async def feature_usage(args, caller: Caller) -> ToolOutput:
    rows = await feature_routes.admin_feature_usage(args["key"])
    users = [{"userId": r["user_id"], "name": r["display_name"], "phone": masked(r["phone"]), "uses": r["n"], "last": r["last"]}
             for r in rows]
    return ToolOutput({"key": args["key"], "days": 30, "users": users},
                      links=_links(link_for(S, "feature_usage", {"key": args["key"]})))


async def _feature(conn, key: str) -> dict:
    row = await db.fetch_one(conn, "select * from features where key = %s for update", (key,))
    if row is None:
        raise ToolError(f"Featuren {key} findes ikke. Se feature_list.")
    return row


async def _level_counts(conn) -> dict[int, int]:
    rows = await db.fetch_all(conn, """
        select coalesce(r.ring, 4) as level, count(*) as n from users u left join feature_rings r on r.user_id = u.id
        where not u.impersonation_only and u.blocked_at is null group by 1""")
    return {r["level"]: r["n"] for r in rows}


@draft(S, "feature_set_ring")
async def feature_set_ring(args, caller: Caller, conn) -> DraftPlan:
    ring = args["ring"]
    if ring not in RING_NAMES:
        raise ToolError("ring skal være 1, 2, 3 eller 4")
    f = await _feature(conn, args["key"])
    if f["ring"] == ring:
        raise ToolError(f"{f['title']} er allerede i ring {ring}")
    levels = await _level_counts(conn)
    gain = sum(n for lvl, n in levels.items() if ring >= lvl > f["ring"])
    lose = sum(n for lvl, n in levels.items() if f["ring"] >= lvl > ring)
    users30 = (await db.fetch_one(conn, """select count(distinct user_id) as n from feature_usage
                                           where feature_key = %s and ts > now() - interval '30 days'""", (f["key"],)))["n"]

    async def execute(conn):
        await conn.execute("update features set ring = %s, updated_at = now() where key = %s", (ring, f["key"]))
        await audit(conn, "feature.ring", actor_id=caller.user_id, meta=caller.principal.meta, table="features",
                    row_id=f["key"], before={"ring": f["ring"]}, after={"ring": ring})
        return {"key": f["key"], "ring": ring}

    return DraftPlan(summary=f"Flyt {f['title']} til ring {ring} · {RING_NAMES[ring]}.",
                     impact={"bullets": [f"Ring {f['ring']} → {ring}", f"{gain} brugere får den, {lose} mister den",
                                         f"{users30} brugere har brugt den de seneste 30 dage"],
                             "counts": {"gain": gain, "lose": lose, "users30d": users30}, "diff": {"ring": [f["ring"], ring]}},
                     state={"key": f["key"], "ring": f["ring"]}, execute=execute,
                     links=_links(link_for(S, "feature_set_ring", {"key": f["key"]})))


@draft(S, "feature_set_observe")
async def feature_set_observe(args, caller: Caller, conn) -> DraftPlan:
    f = await _feature(conn, args["key"])
    observe = bool(args["observe"])
    if f["observe"] == observe:
        raise ToolError(f"Observation er allerede {'slået til' if observe else 'slået fra'} for {f['title']}")

    async def execute(conn):
        await conn.execute("update features set observe = %s, updated_at = now() where key = %s", (observe, f["key"]))
        await audit(conn, "update", actor_id=caller.user_id, meta=caller.principal.meta, table="features", row_id=f["key"],
                    before={"observe": f["observe"]}, after={"observe": observe})
        return {"key": f["key"], "observe": observe}

    return DraftPlan(summary=f"Slå observation {'til' if observe else 'fra'} for {f['title']}.",
                     impact={"bullets": ["Brugerne bliver bedt om en vurdering 1–5" if observe else "Ingen vurderinger"],
                             "diff": {"observe": [f["observe"], observe]}},
                     state={"key": f["key"], "observe": f["observe"]}, execute=execute,
                     links=_links(link_for(S, "feature_set_observe", {"key": f["key"]})))


@draft(S, "feature_import")
async def feature_import(args, caller: Caller, conn) -> DraftPlan:
    known = {r["key"] for r in await db.fetch_all(conn, "select key from features")}
    missing = [c for c in FEATURE_CATALOG if c.key not in known]
    if not missing:
        raise ToolError("Alle features fra koden findes allerede")

    async def execute(conn):
        for c in missing:
            await conn.execute("""insert into features (key, title, description, area, ring, builtin, created_by)
                                  values (%s, %s, %s, %s, 1, true, %s) on conflict (key) do nothing""",
                               (c.key, c.title, c.description, c.area, caller.user_id))
        await audit(conn, "feature.import", actor_id=caller.user_id, meta=caller.principal.meta, table="features",
                    created=[c.key for c in missing])
        return {"created": [c.key for c in missing]}

    return DraftPlan(summary=f"Importér {len(missing)} features fra koden i ring 1.",
                     impact={"bullets": [f"{c.title} ({c.key})" for c in missing] + ["Eksisterende ringe ændres ikke"],
                             "counts": {"features": len(missing)}},
                     state={"missing": sorted(c.key for c in missing)}, execute=execute,
                     links=_links(link_for(S, "feature_import", {})))


@draft(S, "user_ring_set")
async def user_ring_set(args, caller: Caller, conn) -> DraftPlan:
    u = await _user(conn, args["userId"])
    ring = args.get("ring")
    if ring is not None and ring not in RING_NAMES:
        raise ToolError("ring skal være 1, 2, 3 eller 4 (eller udeladt for at nulstille)")
    before = await feature_routes.user_level(conn, u["id"])

    async def execute(conn):
        await feature_routes._set_level(conn, u["id"], None if ring in (None, 4) else ring, caller.principal)
        return {"userId": u["id"], "level": ring or 4}

    return DraftPlan(summary=f"Sæt {_name(u)}s feature-niveau til ring {ring or 4}" + (" (nulstil)" if ring is None else "") + ".",
                     impact={"bullets": [f"Niveau {before} → {ring or 4}"], "diff": {"level": [before, ring or 4]}},
                     state={"id": u["id"], "level": before}, execute=execute,
                     links=_links(link_for(S, "user_ring_set", {})))


# ── Logs ────────────────────────────────────────────────────────────────────

def _date(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        raise ToolError(f"Ugyldig dato: {value} (brug ÅÅÅÅ-MM-DD)")


@tool(S, "auth_log_search")
async def auth_log_search(args, caller: Caller) -> ToolOutput:
    r = await admin_routes.auth_log(user_id=args.get("userId"), phone=None, device=None, ip=None, event=args.get("event"),
                                    result=None, date_from=_date(args.get("from")), date_to=_date(args.get("to")),
                                    limit=500, offset=0)
    return ToolOutput({"total": r["total"], "events": r["items"], "eventTypes": r["events"]},
                      links=_links(link_for(S, "auth_log_search", {"userId": args.get("userId")})))


@tool(S, "audit_log_search")
async def audit_log_search(args, caller: Caller) -> ToolOutput:
    r = await admin_routes.audit_log(actor_id=args.get("actorId"), action=args.get("action"), table=None, row_id=None,
                                     date_from=_date(args.get("from")), date_to=_date(args.get("to")), include_reads=False,
                                     limit=500, offset=0)
    return ToolOutput({"total": r["total"], "entries": r["items"], "actions": r["actions"]},
                      links=_links(link_for(S, "audit_log_search", {"actorId": args.get("actorId")})))


# ── GDPR ────────────────────────────────────────────────────────────────────

@tool(S, "gdpr_list")
async def gdpr_list(args, caller: Caller) -> ToolOutput:
    rows = await admin_routes.gdpr_list(args.get("status"))
    requests = [{**{k: v for k, v in r.items() if k not in ("user_phone", "contact")}, "userPhone": masked(r.get("user_phone"))}
                for r in rows]
    return ToolOutput({"requests": requests}, links=_links(link_for(S, "gdpr_list", {})))


@draft(S, "gdpr_export")
async def gdpr_export(args, caller: Caller, conn) -> DraftPlan:
    u = await _user(conn, args["userId"])

    async def execute(conn):
        data = await gdpr.export_zip(conn, u["id"])
        stored = await store_file(conn, owner_id=None, filename=gdpr.export_filename(u["id"]), data=data,
                                  content_type="application/zip", caller=caller, prefix="exports/admin")
        await audit(conn, "gdpr.export", actor_id=caller.user_id, meta=caller.principal.meta, table="users", row_id=u["id"],
                    subject_user_id=u["id"], bytes=len(data), via="mcp")
        return stored

    return DraftPlan(summary=f"Lav den samlede GDPR-eksport for {_name(u)}.",
                     impact={"bullets": ["Alt om brugeren: data.json og kopier af filerne i én zip",
                                         "Gemmes under /admin/files; linket udløber efter "
                                         f"{config.settings.download_link_seconds} sekunder"]},
                     state={"id": u["id"]}, execute=execute, links=_links(link_for(S, "gdpr_export", {"userId": u["id"]})))


# ── Database ────────────────────────────────────────────────────────────────

@tool(S, "db_query")
async def db_query(args, caller: Caller) -> ToolOutput:
    return ToolOutput(await db_tools.run_query(args["sql"]))


@tool(S, "db_schema")
async def db_schema(args, caller: Caller) -> ToolOutput:
    return ToolOutput(await db_tools.schema())


# ── Settings ────────────────────────────────────────────────────────────────

# key → (type, min, max). Logo and SMS provider are not settings here; logs and secrets never are.
SETTABLE = {
    "app_name": (str, 1, 80), "sms_sender": (str, 1, 11), "gdpr_email": (str, 0, 200),
    "consent_title": (str, 1, 120), "consent_text": (str, 1, 2000), "consent_accept": (str, 1, 40),
    "consent_decline": (str, 1, 40),
    "retention_auth_log_days": (int, 30, 3650), "retention_audit_log_days": (int, 30, 3650),
    "retention_analytics_days": (int, 7, 3650), "retention_mcp_log_days": (int, 7, 3650),
}


@tool(S, "settings_get")
async def settings_get(args, caller: Caller) -> ToolOutput:
    async with db.connection() as conn:
        values = await settings_store.get_all(conn)
    out = {k: values[k] for k in SETTABLE}
    out |= {"logo": bool(values["logo_key"]), "consent_version": values["consent_version"],
            "retention_last_run": values["retention_last_run"], "version": config.settings.version,
            "environment": config.settings.environment}
    return ToolOutput({"settings": out, "settable": list(SETTABLE)}, links=_links(link_for(S, "settings_get", {})))


@draft(S, "settings_set")
async def settings_set(args, caller: Caller, conn) -> DraftPlan:
    key, raw = args["key"], args["value"]
    if key not in SETTABLE:
        raise ToolError(f"{key} kan ikke ændres her. Mulige: {', '.join(SETTABLE)}")
    kind, lo, hi = SETTABLE[key]
    if kind is int:
        try:
            value = int(raw)
        except ValueError:
            raise ToolError(f"{key} skal være et tal")
        if not lo <= value <= hi:
            raise ToolError(f"{key} skal være mellem {lo} og {hi}")
    else:
        value = raw.strip()
        if not lo <= len(value) <= hi:
            raise ToolError(f"{key} skal være {lo}–{hi} tegn")
    before = await settings_store.get(conn, key)
    if before == value:
        raise ToolError(f"{key} har allerede den værdi")

    async def execute(conn):
        await settings_store.set_many(conn, {key: value})
        b, a = changed({key: before}, {key: value})
        await audit(conn, "update", actor_id=caller.user_id, meta=caller.principal.meta, table="settings", row_id=key,
                    before=b, after=a)
        return {"key": key, "value": value}

    return DraftPlan(summary=f"Ændr indstillingen {key}.", impact={"diff": {key: [before, value]},
                                                                    "bullets": [f"{before!r} → {value!r}"]},
                     state={"key": key, "value": before}, execute=execute,
                     links=_links(link_for(S, "settings_set", {"key": key})))
