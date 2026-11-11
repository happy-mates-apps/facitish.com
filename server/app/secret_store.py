"""The secret manager (/admin/secrets): secrets owned by a group, governed by a RACI, shared by approval.

Rules (design: the canvas "Secret Manager", specs in this docstring):

- A secret is owned by one group (app/groups.py) and has its own RACI: exactly one A (Accountable), at least one R
  (Responsible), any number of C (Consulted) and I (Informed). Defaults when created: the creator is A and R, the
  rest of the owning group is I. A, R and C act in /admin, so they must be admins whose roles open /admin/secrets
  (`eligible`); I may be anyone.
- The value is encrypted with app.secrets_box (purpose "secret:<id>:<version>"). Each change is a new version; old
  versions are kept until the retention policy `secret_versions` removes them. A value is never logged, mailed, put in
  a webhook, returned by a list, or reachable through MCP.
- Who can read and change the value: A, R, and whoever holds an active grant (level `read` = see, `write` = see and
  change). A grant to a group covers its members who are eligible. Group membership alone gives nothing.
- An API source in /admin/data can hold a grant too (level `use` = "Brug i kilde"): the server sends the value to the
  source's hosts when it calls the API, and no person can see it through that grant (app/source_secrets.py).
- A grant comes only from an access request that the approvers accept. Approvers are fixed when the request is made,
  from the secret's approval rule: `all` = everyone in A, R and C; `a_and_one_r` = A and one R; `a_only` = A. The
  requester and the person getting the access never approve it. One rejection closes it; unanswered it expires after REQUEST_DAYS.
  When nobody but the requester could approve, any other eligible admin may approve once (`fallback`).
- Seeing or changing the value, approving, changing the RACI: a second factor within STEPUP_MINUTES (the routes use
  require_admin_stepup). Everything is audited in the same transaction (table "secrets", row = the secret).
- Notifications: `notify` decides who hears about an event from the owning group's rules (group_notify_rules, with
  NOTIFY_DEFAULTS for missing rows): straight away by mail (job secrets.mail), in the daily digest (secrets.digest),
  or not at all. Approvers and the requester are always told at once. Webhooks get the event with ids only.
"""

import html
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

from app import admin_roles, config, db, groups, jobs, mail, outbound_mail, secrets_box, settings_store, webhooks
from app.logs import RequestMeta, audit

SECTION_API = "/api/admin/secrets"
RACI = ("R", "A", "C", "I")
RULES = {"all": "Alle i A, R og C", "a_and_one_r": "A og én R", "a_only": "Kun A"}
LEVELS = {"read": "Kun se", "write": "Se og ændre", "use": "Brug i kilde"}
REQUEST_DAYS = 7
MAX_GRANT_DAYS = 365
REMIND_DAYS = 14
ROTATION_REMIND_DAYS = 14
FALLBACK_MAX = 20
MAX_VALUE = 20_000

# Event → (Danish label, default mode per audience). A missing audience is "off".
NOTIFY_EVENTS: dict[str, tuple[str, dict[str, str]]] = {
    # Approvers are always told at once (direct); these rows decide who else in the RACI hears about it.
    "secret.access.requested": ("Ny anmodning om adgang", {"A": "now", "R": "now", "C": "now", "channel": "now"}),
    "secret.access.decided": ("Adgang givet eller afvist", {"A": "now", "R": "now", "C": "now", "I": "digest"}),
    "secret.value.changed": ("Værdien er ændret", {"A": "now", "R": "now", "I": "digest", "grantee": "now", "channel": "now"}),
    "secret.revealed": ("Værdien er vist", {"A": "digest", "R": "digest"}),
    "secret.rotation.due": ("Rotation forfalder", {"A": "now", "R": "now", "channel": "now"}),
    "secret.grant.expiring": ("Adgang udløber snart", {"A": "now", "grantee": "now"}),
    "secret.grant.ended": ("Adgang er udløbet eller tilbagekaldt", {"A": "now", "R": "now", "grantee": "now"}),
    "secret.grant.member_added": ("Ny person med adgang via en gruppe", {"A": "now", "R": "now"}),
    "secret.raci.changed": ("RACI er ændret", {"A": "now", "R": "now", "C": "now", "I": "digest"}),
    "secret.orphaned": ("Uden ansvarlig (A)", {"R": "now", "C": "now", "I": "digest", "channel": "now"}),
    "secret.archived": ("Hemmelighed arkiveret", {"A": "now", "R": "now", "C": "now", "I": "digest", "grantee": "now",
                                                  "channel": "now"}),
}
AUDIENCES = ("A", "R", "C", "I", "grantee", "channel")
MODES = ("now", "digest", "off")
RANK = {"off": 0, "digest": 1, "now": 2}

SECRET_COLUMNS = """s.id, s.group_id, g.name as group_name, s.name, s.environment, s.description, s.tags, s.approval_rule,
                    s.rotation_days, s.expires_at, s.current_version, s.value_changed_at, s.archived_at, s.created_by,
                    s.created_at, s.updated_at"""


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── People ─────────────────────────────────────────────────────────────────

def eligible(user: dict | None) -> bool:
    """May this user act in /admin/secrets (approve, see a value, be A, R or C)?"""
    if not user or user.get("role") != "admin" or user.get("blocked_at") or user.get("impersonation_only"):
        return False
    roles = list(user.get("admin_roles") or []) + ([admin_roles.FULL] if user.get("super_admin") else [])
    return admin_roles.allows(roles, "GET", SECTION_API)


async def users_by_id(conn, ids) -> dict[int, dict]:
    ids = sorted(set(ids))
    if not ids:
        return {}
    rows = await db.fetch_all(conn, """select id, email, display_name, role, admin_roles, super_admin, blocked_at,
                                              impersonation_only from users where id = any(%s)""", (ids,))
    return {r["id"]: r for r in rows}


def person(u: dict | None) -> dict | None:
    if u is None:
        return None
    return {"id": u["id"], "name": u.get("display_name") or u.get("email") or f"#{u['id']}", "email": u.get("email"),
            "eligible": eligible(u)}


async def eligible_admins(conn) -> list[dict]:
    rows = await db.fetch_all(conn, """select id, email, display_name, role, admin_roles, super_admin, blocked_at,
                                              impersonation_only from users
                                       where role = 'admin' and blocked_at is null and not impersonation_only
                                       order by lower(coalesce(display_name, email, '')), id""")
    return [r for r in rows if eligible(r)]


# ── Reading ────────────────────────────────────────────────────────────────

async def get(conn, secret_id: int, *, lock: bool = False) -> dict:
    row = await db.fetch_one(conn, f"""select {SECRET_COLUMNS} from secrets s join groups g on g.id = s.group_id
                                       where s.id = %s {'for update of s' if lock else ''}""", (secret_id,))
    if row is None:
        raise HTTPException(404, "Hemmeligheden findes ikke")
    return row


async def raci_map(conn, secret_id: int) -> dict[int, list[str]]:
    out: dict[int, list[str]] = {}
    for r in await db.fetch_all(conn, "select user_id, role from secret_raci where secret_id = %s", (secret_id,)):
        out.setdefault(r["user_id"], []).append(r["role"])
    return {k: sorted(v, key=RACI.index) for k, v in out.items()}


async def roles_of(conn, secret_id: int, user_id: int) -> set[str]:
    return {r["role"] for r in await db.fetch_all(
        conn, "select role from secret_raci where secret_id = %s and user_id = %s", (secret_id, user_id))}


async def active_grants(conn, secret_id: int) -> list[dict]:
    return await db.fetch_all(conn, """
        select gr.id, gr.user_id, gr.group_id, gr.source_id, gr.level, gr.request_id, gr.granted_at, gr.expires_at,
               g.name as group_name, ds.name as source_name, ds.key as source_key, ds.hosts as source_hosts
        from secret_grants gr left join groups g on g.id = gr.group_id left join data_sources ds on ds.id = gr.source_id
        where gr.secret_id = %s and gr.ended_at is null and gr.expires_at > now() order by gr.granted_at""", (secret_id,))


async def grantee_ids(conn, secret_id: int) -> set[int]:
    """Users who hold an active grant, directly or as members of a group with one."""
    rows = await db.fetch_all(conn, """
        select gr.user_id as id from secret_grants gr
        where gr.secret_id = %s and gr.ended_at is null and gr.expires_at > now() and gr.user_id is not null
        union
        select m.user_id from secret_grants gr join group_members m on m.group_id = gr.group_id
        where gr.secret_id = %s and gr.ended_at is null and gr.expires_at > now()""", (secret_id, secret_id))
    return {r["id"] for r in rows}


async def access_level(conn, secret: dict, user: dict) -> str | None:
    """'write', 'read' or None for this user and the secret's value."""
    if secret["archived_at"] is not None or not eligible(user):
        return None
    if await roles_of(conn, secret["id"], user["id"]) & {"A", "R"}:
        return "write"
    rows = await db.fetch_all(conn, """
        select gr.level from secret_grants gr
        where gr.secret_id = %s and gr.ended_at is null and gr.expires_at > now()
          and (gr.user_id = %s or gr.group_id in (select group_id from group_members where user_id = %s))""",
        (secret["id"], user["id"], user["id"]))
    levels = {r["level"] for r in rows}
    return "write" if "write" in levels else "read" if levels else None


async def user_row(conn, user_id: int) -> dict:
    return (await users_by_id(conn, [user_id]))[user_id]


async def require_level(conn, secret: dict, user_id: int, need: str) -> str:
    level = await access_level(conn, secret, await user_row(conn, user_id))
    if level is None or (need == "write" and level != "write"):
        raise HTTPException(403, "Du har ikke adgang til værdien. Anmod om adgang, så A, R og C kan tage stilling."
                            if level is None else "Din adgang giver kun lov til at se værdien")
    return level


# ── RACI ───────────────────────────────────────────────────────────────────

async def validate_raci(conn, assignments: dict[int, list[str]]) -> dict[int, list[str]]:
    """Cleans and checks a RACI: exactly one A, at least one R, A/R/C eligible, I alone."""
    clean: dict[int, list[str]] = {}
    for uid, roles in assignments.items():
        roles = sorted({r for r in roles if r in RACI}, key=RACI.index)
        if not roles:
            continue
        if "I" in roles and len(roles) > 1:
            roles = [r for r in roles if r != "I"]  # someone with a real role is informed anyway
        clean[int(uid)] = roles
    users = await users_by_id(conn, clean)
    missing = [u for u in clean if u not in users]
    if missing:
        raise HTTPException(400, "En person i RACI findes ikke")
    a = [u for u, rs in clean.items() if "A" in rs]
    if len(a) != 1:
        raise HTTPException(400, "Der skal være præcis én Accountable (A)")
    if not any("R" in rs for rs in clean.values()):
        raise HTTPException(400, "Der skal være mindst én Responsible (R)")
    not_ok = [person(users[u])["name"] for u, rs in clean.items() if set(rs) & {"A", "R", "C"} and not eligible(users[u])]
    if not_ok:
        raise HTTPException(400, "A, R og C skal være administratorer med adgang til Hemmeligheder: " + ", ".join(not_ok))
    return clean


async def write_raci(conn, secret_id: int, assignments: dict[int, list[str]]) -> None:
    await conn.execute("delete from secret_raci where secret_id = %s", (secret_id,))
    for uid, roles in assignments.items():
        for role in roles:
            await conn.execute("insert into secret_raci (secret_id, user_id, role) values (%s, %s, %s)",
                               (secret_id, uid, role))


async def default_raci(conn, group_id: int, creator_id: int) -> dict[int, list[str]]:
    out = {creator_id: ["R", "A"]}
    for uid in await groups.member_ids(conn, group_id):
        out.setdefault(uid, ["I"])
    return out


# ── Values ─────────────────────────────────────────────────────────────────

def _hint(value: str) -> str:
    return "…" + value[-4:] if len(value) >= 12 else ""


async def set_value(conn, secret: dict, value: str, actor_id: int) -> int:
    if not value or len(value) > MAX_VALUE:
        raise HTTPException(400, f"Værdien skal være mellem 1 og {MAX_VALUE} tegn")
    version = secret["current_version"] + 1
    await conn.execute("update secret_versions set superseded_at = now() where secret_id = %s and superseded_at is null",
                       (secret["id"],))
    await conn.execute("""insert into secret_versions (secret_id, version, value_enc, hint, length, created_by)
                          values (%s, %s, %s, %s, %s, %s)""",
                       (secret["id"], version, secrets_box.encrypt(value, f"secret:{secret['id']}:{version}"),
                        _hint(value), len(value), actor_id))
    await conn.execute("""update secrets set current_version = %s, value_changed_at = now(), rotation_notified_at = null,
                          updated_at = now() where id = %s""", (version, secret["id"]))
    secret["current_version"] = version
    return version


async def read_value(conn, secret_id: int, version: int) -> str:
    row = await db.fetch_one(conn, "select value_enc from secret_versions where secret_id = %s and version = %s",
                             (secret_id, version))
    if row is None:
        raise HTTPException(404, "Versionen findes ikke længere")
    return secrets_box.decrypt(row["value_enc"], f"secret:{secret_id}:{version}")


# ── Access requests ────────────────────────────────────────────────────────

def approvers_for(rule: str, raci: dict[int, list[str]], exclude: set[int], users: dict[int, dict]) -> dict[int, list[str]]:
    """Who must answer, with the roles they answer in. The requester and the person who gets the access never approve;
    approvers who can no longer use /admin are left out."""
    wanted = {"all": {"A", "R", "C"}, "a_and_one_r": {"A", "R"}, "a_only": {"A"}}[rule]
    out = {}
    for uid, roles in raci.items():
        mine = [r for r in roles if r in wanted]
        if mine and uid not in exclude and eligible(users.get(uid)):
            out[uid] = mine
    if rule == "a_and_one_r" and not any("A" in rs for rs in out.values()) and not any("R" in rs for rs in out.values()):
        return {}
    if rule == "a_only" and not out:
        return {}
    return out


def outcome(fallback: bool, rule: str, approvals: list[dict]) -> str:
    """'approved', 'rejected' or 'pending' from the answers so far."""
    if any(a["decision"] == "rejected" for a in approvals):
        return "rejected"
    if not approvals:
        return "pending"
    if fallback:
        return "approved" if any(a["decision"] == "approved" for a in approvals) else "pending"
    if rule == "all":
        return "approved" if all(a["decision"] == "approved" for a in approvals) else "pending"
    a_rows = [a for a in approvals if "A" in a["roles"]]
    r_rows = [a for a in approvals if "R" in a["roles"]]
    a_ok = all(a["decision"] == "approved" for a in a_rows)
    if rule == "a_only":
        return "approved" if a_ok else "pending"
    r_ok = not r_rows or any(a["decision"] == "approved" for a in r_rows)
    return "approved" if a_ok and r_ok else "pending"


async def create_request(conn, secret: dict, *, requester_id: int, grantee_user_id: int | None,
                         grantee_group_id: int | None, level: str, days: int, reason: str, meta: RequestMeta,
                         grantee_source_id: int | None = None) -> dict:
    if secret["archived_at"] is not None:
        raise HTTPException(409, "Hemmeligheden er arkiveret")
    if [grantee_user_id, grantee_group_id, grantee_source_id].count(None) != 2:
        raise HTTPException(400, "Vælg én modtager")
    if (level == "use") != (grantee_source_id is not None):
        raise HTTPException(400, "Kun en API-kilde kan få adgangen Brug i kilde")
    if grantee_source_id is not None:
        if not await db.fetch_one(conn, "select 1 from data_sources where id = %s", (grantee_source_id,)):
            raise HTTPException(404, "Kilden findes ikke")
    elif grantee_user_id is not None:
        grantee = (await users_by_id(conn, [grantee_user_id])).get(grantee_user_id)
        if not eligible(grantee):
            raise HTTPException(400, "Adgang kan kun gives til administratorer med adgang til Hemmeligheder")
    else:
        await groups.get(conn, grantee_group_id)
    dup = await db.fetch_one(conn, """select id from secret_access_requests where secret_id = %s and status = 'pending'
                                      and grantee_user_id is not distinct from %s and grantee_group_id is not distinct from %s
                                      and grantee_source_id is not distinct from %s""",
                             (secret["id"], grantee_user_id, grantee_group_id, grantee_source_id))
    if dup:
        raise HTTPException(409, "Der er allerede en åben anmodning for den samme modtager")
    raci = await raci_map(conn, secret["id"])
    users = await users_by_id(conn, raci)
    exclude = {requester_id} | ({grantee_user_id} if grantee_user_id else set())
    approvers = approvers_for(secret["approval_rule"], raci, exclude, users)
    fallback = not approvers
    if fallback:
        approvers = {a["id"]: ["admin"] for a in await eligible_admins(conn) if a["id"] not in exclude}
        approvers = dict(list(approvers.items())[:FALLBACK_MAX])
        if not approvers:
            raise HTTPException(409, "Der er ingen andre, der kan godkende anmodningen")
    row = await db.fetch_one(conn, """
        insert into secret_access_requests (secret_id, requester_id, grantee_user_id, grantee_group_id, grantee_source_id,
                                            level, days, reason, approval_rule, fallback, expires_at)
        values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now() + make_interval(days => %s)) returning *""",
        (secret["id"], requester_id, grantee_user_id, grantee_group_id, grantee_source_id, level, days, reason.strip(),
         secret["approval_rule"], fallback, REQUEST_DAYS))
    for uid, roles in approvers.items():
        await conn.execute("insert into secret_approvals (request_id, approver_id, roles) values (%s, %s, %s)",
                           (row["id"], uid, roles))
    skipped = [u for u, rs in raci.items() if set(rs) & {"A", "R", "C"} and u not in exclude and u not in approvers
               and not fallback and not eligible(users.get(u))]
    await audit(conn, "secret.access_requested", actor_id=requester_id, meta=meta, table="secrets", row_id=secret["id"],
                request_id=row["id"], level=level, days=days, grantee_user_id=grantee_user_id,
                grantee_group_id=grantee_group_id, grantee_source_id=grantee_source_id, approvers=sorted(approvers), fallback=fallback,
                skipped_approvers=skipped or None)
    await notify(conn, secret, "secret.access.requested", actor_id=requester_id, direct=list(approvers),
                 extra={"request_id": row["id"]})
    return row


async def approvals(conn, request_id: int) -> list[dict]:
    return await db.fetch_all(conn, """select approver_id, roles, decision, note, decided_at from secret_approvals
                                       where request_id = %s order by approver_id""", (request_id,))


async def decide(conn, request_id: int, *, approver_id: int, approve: bool, note: str | None, meta: RequestMeta) -> dict:
    req = await db.fetch_one(conn, "select * from secret_access_requests where id = %s for update", (request_id,))
    if req is None:
        raise HTTPException(404, "Anmodningen findes ikke")
    secret = await get(conn, req["secret_id"], lock=True)
    if req["status"] != "pending" or req["expires_at"] < _now():
        raise HTTPException(409, "Anmodningen er allerede afgjort eller udløbet")
    if req["requester_id"] == approver_id:
        raise HTTPException(403, "Du kan ikke godkende din egen anmodning")
    mine = await db.fetch_one(conn, "select * from secret_approvals where request_id = %s and approver_id = %s for update",
                              (request_id, approver_id))
    if mine is None:
        raise HTTPException(403, "Du er ikke godkender på denne anmodning")
    if mine["decision"] != "pending":
        raise HTTPException(409, "Du har allerede svaret")
    if not approve and not (note or "").strip():
        raise HTTPException(400, "Skriv en begrundelse, når du afviser")
    await conn.execute("""update secret_approvals set decision = %s, note = %s, decided_at = now()
                          where request_id = %s and approver_id = %s""",
                       ("approved" if approve else "rejected", (note or "").strip() or None, request_id, approver_id))
    await audit(conn, "secret.access_approved" if approve else "secret.access_rejected", actor_id=approver_id, meta=meta,
                table="secrets", row_id=secret["id"], request_id=request_id, roles=mine["roles"])
    result = outcome(req["fallback"], req["approval_rule"], await approvals(conn, request_id))
    grant = None
    if result != "pending":
        await conn.execute("update secret_access_requests set status = %s, decided_at = now() where id = %s",
                           (result, request_id))
        if result == "approved":
            grant = await _grant(conn, secret, req, meta)
        await webhooks.emit(conn, "secret.access.decided", {"secret_id": secret["id"], "request_id": request_id,
                                                            "status": result})
        await notify(conn, secret, "secret.access.decided", actor_id=approver_id, webhook=False,
                     direct=[req["requester_id"]] + ([req["grantee_user_id"]] if req["grantee_user_id"] else []),
                     extra={"request_id": request_id, "status": result})
    return {"status": result, "grant_id": grant}


async def _grant(conn, secret: dict, req: dict, meta: RequestMeta) -> int:
    # A new grant replaces an active one for the same grantee.
    await conn.execute("""update secret_grants set ended_at = now(), ended_reason = 'revoked'
                          where secret_id = %s and ended_at is null and user_id is not distinct from %s
                            and group_id is not distinct from %s and source_id is not distinct from %s""",
                       (secret["id"], req["grantee_user_id"], req["grantee_group_id"], req["grantee_source_id"]))
    row = await db.fetch_one(conn, """
        insert into secret_grants (secret_id, user_id, group_id, source_id, level, request_id, expires_at)
        values (%s, %s, %s, %s, %s, %s, now() + make_interval(days => %s)) returning id, expires_at""",
        (secret["id"], req["grantee_user_id"], req["grantee_group_id"], req["grantee_source_id"], req["level"], req["id"],
         req["days"]))
    await audit(conn, "secret.access_granted", actor_id=None, meta=meta, table="secrets", row_id=secret["id"],
                grant_id=row["id"], request_id=req["id"], user_id=req["grantee_user_id"], group_id=req["grantee_group_id"],
                source_id=req["grantee_source_id"], level=req["level"], expires_at=row["expires_at"])
    return row["id"]


async def end_grant(conn, secret: dict, grant_id: int, *, reason: str, actor_id: int | None, meta: RequestMeta) -> None:
    row = await db.fetch_one(conn, """update secret_grants set ended_at = now(), ended_reason = %s, revoked_by = %s
                                      where id = %s and secret_id = %s and ended_at is null
                                      returning id, user_id, group_id, source_id""", (reason, actor_id, grant_id, secret["id"]))
    if row is None:
        raise HTTPException(404, "Adgangen findes ikke eller er allerede afsluttet")
    await audit(conn, "secret.access_ended", actor_id=actor_id, meta=meta, table="secrets", row_id=secret["id"],
                grant_id=grant_id, reason=reason, user_id=row["user_id"], group_id=row["group_id"], source_id=row["source_id"])
    await notify(conn, secret, "secret.grant.ended", actor_id=actor_id, direct=[row["user_id"]] if row["user_id"] else [],
                 extra={"grant_id": grant_id, "reason": reason})


# ── Notifications ──────────────────────────────────────────────────────────

async def rules_for(conn, group_id: int) -> dict[str, dict[str, str]]:
    out = {ev: {a: d.get(a, "off") for a in AUDIENCES} for ev, (_, d) in NOTIFY_EVENTS.items()}
    for r in await db.fetch_all(conn, "select event, audience, mode from group_notify_rules where group_id = %s",
                                (group_id,)):
        if r["event"] in out:
            out[r["event"]][r["audience"]] = r["mode"]
    return out


async def notify(conn, secret: dict, event: str, *, actor_id: int | None, direct: list[int] | None = None,
                 extra: dict | None = None, webhook: bool = True) -> dict:
    """Queues mails (now) and digest rows for one event on one secret, and emits the webhook. `direct` are told at
    once whatever the rules say (approvers, the requester). The actor is never told about their own action."""
    rules = (await rules_for(conn, secret["group_id"]))[event]
    raci = await raci_map(conn, secret["id"])
    audience_of: dict[int, set[str]] = {}
    for uid, roles in raci.items():
        audience_of.setdefault(uid, set()).update(roles)
    if rules.get("grantee", "off") != "off":
        for uid in await grantee_ids(conn, secret["id"]):
            audience_of.setdefault(uid, set()).add("grantee")
    modes: dict[int, str] = {}
    for uid, auds in audience_of.items():
        mode = max((rules.get(a, "off") for a in auds), key=RANK.__getitem__, default="off")
        if mode != "off":
            modes[uid] = mode
    for uid in direct or []:
        if uid:
            modes[uid] = "now"
    modes.pop(actor_id, None)
    payload = {"secret_id": secret["id"], "event": event, **(extra or {})}
    for uid, mode in sorted(modes.items()):
        if mode == "now":
            await jobs.enqueue(conn, "secrets.mail", {**payload, "user_id": uid})
        else:
            await conn.execute("insert into secret_notifications (user_id, secret_id, event) values (%s, %s, %s)",
                               (uid, secret["id"], event))
    if rules.get("channel") == "now":
        group = await groups.get(conn, secret["group_id"])
        if group["notify_email"]:
            await jobs.enqueue(conn, "secrets.mail", {**payload, "group_id": group["id"]})
    if webhook and event in webhooks.EVENTS:
        await webhooks.emit(conn, event, {k: v for k, v in payload.items() if k != "event"} | {"group_id": secret["group_id"]})
    return modes


SUBJECTS = {
    "secret.access.requested": "Godkend adgang: {name}",
    "secret.access.decided": "Anmodning om {name} er {status}",
    "secret.value.changed": "Ny værdi i {name}",
    "secret.revealed": "{name} er blevet vist",
    "secret.rotation.due": "{name} skal roteres",
    "secret.grant.expiring": "Adgang til {name} udløber snart",
    "secret.grant.ended": "Adgang til {name} er afsluttet",
    "secret.grant.member_added": "Ny person har adgang til {name} via en gruppe",
    "secret.raci.changed": "RACI for {name} er ændret",
    "secret.orphaned": "{name} mangler en ansvarlig (A)",
    "secret.archived": "{name} er arkiveret",
}
STATUS = {"approved": "godkendt", "rejected": "afvist", "expired": "udløbet"}


def _title(secret: dict) -> str:
    return secret["name"] + (f" ({secret['environment']})" if secret["environment"] else "")


def mail_for(secret: dict, event: str, extra: dict, app_name: str) -> tuple[str, str, str]:
    """Subject, text and HTML. Names and links only: never a value."""
    name = _title(secret)
    subject = SUBJECTS.get(event, "{name}").format(name=name, status=STATUS.get(extra.get("status"), extra.get("status", "")))
    link = f"{config.settings.origin.rstrip('/')}/admin/secrets/{secret['id']}"
    label = NOTIFY_EVENTS.get(event, (event, {}))[0]
    lines = [f"{label}: {name} i gruppen {secret['group_name']}."]
    if event == "secret.access.requested":
        lines.append("Du er godkender. Åbn anmodningen og tag stilling. Du skal bruge din anden faktor.")
    text = "\n\n".join([*lines, f"Åbn: {link}", f"Beskeden indeholder aldrig værdien. — {app_name}"])
    body = ("".join(f"<p>{html.escape(x)}</p>" for x in lines)
            + f'<p><a href="{html.escape(link)}" style="display:inline-block;background:#2563eb;color:#f8fafc;'
              f'padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Åbn i {html.escape(app_name)}</a></p>'
            + '<p style="color:#64748b;font-size:13px">Beskeden indeholder aldrig værdien.</p>')
    return subject, text, body


@jobs.handler("secrets.mail")
async def send_notification(payload: dict, job: dict) -> dict:
    async with db.connection() as conn:
        secret = await db.fetch_one(conn, f"""select {SECRET_COLUMNS} from secrets s join groups g on g.id = s.group_id
                                              where s.id = %s""", (payload["secret_id"],))
        if secret is None:
            return {"skipped": "secret gone"}
        if payload.get("group_id"):
            group = await db.fetch_one(conn, "select notify_email from groups where id = %s", (payload["group_id"],))
            to, user_id = (group or {}).get("notify_email"), None
        else:
            user = await db.fetch_one(conn, "select id, email from users where id = %s", (payload["user_id"],))
            to, user_id = (user or {}).get("email"), payload["user_id"]
        if not to:
            return {"skipped": "no e-mail"}
        app_name = await settings_store.get(conn, "app_name")
    subject, text, body = mail_for(secret, payload["event"], payload, app_name)
    message_id = await mail.send_mail(to, subject, text, body, app_name)
    async with db.connection() as conn:
        await outbound_mail.record_sent(conn, message_id=message_id, recipient=to, user_id=user_id, purpose="secrets",
                                        subject=subject)
    return {"sent": payload["event"]}


@jobs.handler("secrets.digest")
async def send_digests(payload: dict, job: dict) -> dict:
    """One mail per user with everything waiting for the digest."""
    async with db.connection() as conn:
        rows = await db.fetch_all(conn, """
            select n.id, n.user_id, n.event, n.created_at, s.name, s.environment, g.name as group_name, u.email
            from secret_notifications n join secrets s on s.id = n.secret_id join groups g on g.id = s.group_id
            join users u on u.id = n.user_id where n.sent_at is null order by n.user_id, n.id""")
        app_name = await settings_store.get(conn, "app_name")
    by_user: dict[int, list[dict]] = {}
    for r in rows:
        by_user.setdefault(r["user_id"], []).append(r)
    sent = 0
    for uid, items in by_user.items():
        email = items[0]["email"]
        if email:
            lines = [f"{NOTIFY_EVENTS.get(i['event'], (i['event'], {}))[0]}: {_title(i)} ({i['group_name']})" for i in items]
            link = f"{config.settings.origin.rstrip('/')}/admin/secrets"
            subject = f"Hemmeligheder: {len(items)} {'ændring' if len(items) == 1 else 'ændringer'}"
            text = "\n".join(["Siden sidste opsamling:", *[f"- {x}" for x in lines], "", f"Åbn: {link}"])
            body = ("<p>Siden sidste opsamling:</p><ul>" + "".join(f"<li>{html.escape(x)}</li>" for x in lines)
                    + f'</ul><p><a href="{html.escape(link)}">Åbn Hemmeligheder</a></p>')
            message_id = await mail.send_mail(email, subject, text, body, app_name)
            async with db.connection() as conn:
                await outbound_mail.record_sent(conn, message_id=message_id, recipient=email, user_id=uid,
                                                purpose="secrets", subject=subject)
            sent += 1
        async with db.connection() as conn:
            await conn.execute("update secret_notifications set sent_at = now() where id = any(%s)",
                               ([i["id"] for i in items],))
    return {"users": sent, "items": len(rows)}


@jobs.handler("secrets.maintenance")
async def maintenance(payload: dict, job: dict) -> dict:
    """Expires requests and grants, reminds before a grant expires and before a rotation is due."""
    meta = RequestMeta()
    counts = {"requests_expired": 0, "grants_expired": 0, "grants_reminded": 0, "rotations_due": 0}
    async with db.connection() as conn:
        for r in await db.fetch_all(conn, """update secret_access_requests set status = 'expired', decided_at = now()
                                             where status = 'pending' and expires_at < now()
                                             returning id, secret_id, requester_id"""):
            secret = await get(conn, r["secret_id"])
            await audit(conn, "secret.access_expired", actor_id=None, meta=meta, table="secrets", row_id=secret["id"],
                        request_id=r["id"])
            await notify(conn, secret, "secret.access.decided", actor_id=None, direct=[r["requester_id"]],
                         extra={"request_id": r["id"], "status": "expired"})
            counts["requests_expired"] += 1
        for g in await db.fetch_all(conn, """select id, secret_id from secret_grants
                                             where ended_at is null and expires_at < now()"""):
            await end_grant(conn, await get(conn, g["secret_id"]), g["id"], reason="expired", actor_id=None, meta=meta)
            counts["grants_expired"] += 1
        for g in await db.fetch_all(conn, """update secret_grants set reminded_at = now()
                                             where ended_at is null and reminded_at is null
                                               and expires_at < now() + make_interval(days => %s)
                                             returning id, secret_id, user_id""", (REMIND_DAYS,)):
            await notify(conn, await get(conn, g["secret_id"]), "secret.grant.expiring", actor_id=None,
                         direct=[g["user_id"]] if g["user_id"] else [], extra={"grant_id": g["id"]})
            counts["grants_reminded"] += 1
        for s in await db.fetch_all(conn, """update secrets set rotation_notified_at = now()
                                             where archived_at is null and rotation_days is not null
                                               and value_changed_at is not null and rotation_notified_at is null
                                               and value_changed_at + make_interval(days => rotation_days)
                                                   < now() + make_interval(days => %s)
                                             returning id""", (ROTATION_REMIND_DAYS,)):
            await notify(conn, await get(conn, s["id"]), "secret.rotation.due", actor_id=None)
            counts["rotations_due"] += 1
    return counts


# ── Users leaving ──────────────────────────────────────────────────────────

async def before_user_erased(conn, user_id: int, meta: RequestMeta) -> int:
    """Called by app.gdpr.erase_user before the user row goes: their RACI rows cascade, so secrets where they were
    A lose their accountable person. R and C are told (secret.orphaned)."""
    n = 0
    for r in await db.fetch_all(conn, """select secret_id from secret_raci where user_id = %s and role = 'A'""", (user_id,)):
        secret = await get(conn, r["secret_id"])
        await conn.execute("delete from secret_raci where secret_id = %s and user_id = %s", (secret["id"], user_id))
        await audit(conn, "secret.orphaned", actor_id=None, meta=meta, table="secrets", row_id=secret["id"])
        await notify(conn, secret, "secret.orphaned", actor_id=None)
        n += 1
    return n


async def after_group_member_added(conn, group_id: int, user_id: int, meta: RequestMeta) -> int:
    """A new member of a group that holds grants now has access to those secrets: A and R are told."""
    rows = await db.fetch_all(conn, """select distinct secret_id from secret_grants
                                       where group_id = %s and ended_at is null and expires_at > now()""", (group_id,))
    for r in rows:
        secret = await get(conn, r["secret_id"])
        await audit(conn, "secret.access_via_group", actor_id=None, meta=meta, table="secrets", row_id=secret["id"],
                    group_id=group_id, user_id=user_id)
        await notify(conn, secret, "secret.grant.member_added", actor_id=None, extra={"group_id": group_id})
    return len(rows)


def status_of(secret: dict, *, has_a: bool, pending: int) -> str:
    if secret["archived_at"] is not None:
        return "archived"
    if not has_a:
        return "orphaned"
    if secret["rotation_days"] and secret["value_changed_at"]:
        due = secret["value_changed_at"] + timedelta(days=secret["rotation_days"])
        if due < _now() + timedelta(days=ROTATION_REMIND_DAYS):
            return "rotation_due"
    if pending:
        return "pending"
    return "ok"
