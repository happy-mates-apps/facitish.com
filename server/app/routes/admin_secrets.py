"""/api/admin/secrets (section /secrets): the secret manager. Rules in app/secret_store.py.

Every admin with the section sees names, groups, RACI, grants and requests — never a value. Seeing or changing a
value, approving a request and changing the RACI need a second factor within STEPUP_MINUTES.
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import admin_roles, db, groups, secret_store as ss, webhooks
from app.logs import audit, changed
from app.sessions import Principal, require_admin, require_admin_stepup

router = APIRouter(prefix="/api/admin/secrets", tags=["admin"], dependencies=[Depends(require_admin)])

TAG = r"^[a-zA-Z0-9æøåÆØÅ._-]{1,30}$"


def _full(p: Principal) -> bool:
    return p.super_admin or admin_roles.FULL in p.admin_roles


class RaciIn(BaseModel):
    user_id: int
    roles: list[str] = Field(min_length=1, max_length=4)


class SecretIn(BaseModel):
    group_id: int
    name: str = Field(min_length=1, max_length=120)
    environment: str = Field(default="", max_length=40)
    description: str = Field(default="", max_length=1000)
    tags: list[str] = Field(default_factory=list, max_length=20)
    value: str = Field(min_length=1, max_length=ss.MAX_VALUE)
    approval_rule: str = Field(default="all", pattern="^(all|a_and_one_r|a_only)$")
    rotation_days: int | None = Field(default=None, ge=1, le=3650)
    expires_at: datetime | None = None
    raci: list[RaciIn] | None = Field(default=None, max_length=200)


class SecretPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    environment: str | None = Field(default=None, max_length=40)
    description: str | None = Field(default=None, max_length=1000)
    tags: list[str] | None = Field(default=None, max_length=20)
    approval_rule: str | None = Field(default=None, pattern="^(all|a_and_one_r|a_only)$")
    rotation_days: int | None = Field(default=None, ge=1, le=3650)
    expires_at: datetime | None = None


class ValueIn(BaseModel):
    value: str = Field(min_length=1, max_length=ss.MAX_VALUE)


class RaciPut(BaseModel):
    raci: list[RaciIn] = Field(min_length=1, max_length=200)


class RequestIn(BaseModel):
    grantee_user_id: int | None = None   # none and no group = the requester
    grantee_group_id: int | None = None
    level: str = Field(default="write", pattern="^(read|write)$")
    days: int = Field(default=30, ge=1, le=ss.MAX_GRANT_DAYS)
    reason: str = Field(min_length=3, max_length=1000)


class DecideIn(BaseModel):
    approve: bool
    note: str | None = Field(default=None, max_length=500)


class ReasonIn(BaseModel):
    reason: str | None = Field(default=None, max_length=500)


class NotifyRule(BaseModel):
    event: str
    audience: str = Field(pattern="^(A|R|C|I|grantee|channel)$")
    mode: str = Field(pattern="^(now|digest|off)$")


class NotifyPut(BaseModel):
    rules: list[NotifyRule] = Field(max_length=200)


def _tags(tags: list[str]) -> list[str]:
    import re
    clean = sorted({t.strip().lower() for t in tags if t.strip()})
    if any(not re.match(TAG, t) for t in clean):
        raise HTTPException(400, "Tags må kun indeholde bogstaver, tal, punktum, bindestreg og understreg")
    return clean


def _raci_dict(items: list[RaciIn]) -> dict[int, list[str]]:
    out: dict[int, list[str]] = {}
    for r in items:
        out.setdefault(r.user_id, []).extend(r.roles)
    return out


async def _me(conn, admin: Principal) -> dict:
    return await ss.user_row(conn, admin.user_id)


async def _need_roles(conn, secret: dict, admin: Principal, roles: set[str], what: str) -> set[str]:
    mine = await ss.roles_of(conn, secret["id"], admin.user_id)
    if not mine & roles:
        raise HTTPException(403, f"Kun {what} kan gøre det")
    return mine


# ── Lists and meta ─────────────────────────────────────────────────────────

@router.get("")
async def list_secrets(archived: bool = False, admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        rows = await db.fetch_all(conn, f"""
            select {ss.SECRET_COLUMNS},
                   (select r.user_id from secret_raci r where r.secret_id = s.id and r.role = 'A') as a_id,
                   (select array_agg(r.role) from secret_raci r where r.secret_id = s.id and r.user_id = %s) as my_roles,
                   (select count(*) from secret_grants gr where gr.secret_id = s.id and gr.ended_at is null
                      and gr.expires_at > now()) as grants,
                   (select count(*) from secret_access_requests q where q.secret_id = s.id and q.status = 'pending') as pending,
                   (select count(*) from secret_access_requests q join secret_approvals a on a.request_id = q.id
                      where q.secret_id = s.id and q.status = 'pending' and a.approver_id = %s
                        and a.decision = 'pending') as waiting_for_me
            from secrets s join groups g on g.id = s.group_id
            where (s.archived_at is null) <> %s order by lower(g.name), lower(s.name), s.environment""",
            (admin.user_id, admin.user_id, archived))
        users = await ss.users_by_id(conn, [r["a_id"] for r in rows if r["a_id"]])
        me = await _me(conn, admin)
        items = []
        for r in rows:
            a = users.get(r["a_id"])
            level = await ss.access_level(conn, r, me)
            items.append({**{k: r[k] for k in r if k not in ("a_id",)}, "my_roles": sorted(r["my_roles"] or [], key=ss.RACI.index),
                          "my_level": level, "accountable": ss.person(a),
                          "status": ss.status_of(r, has_a=bool(a and ss.eligible(a)), pending=r["pending"])})
        waiting = await db.fetch_one(conn, """select count(*) as n from secret_approvals a join secret_access_requests q
                                              on q.id = a.request_id where a.approver_id = %s and a.decision = 'pending'
                                              and q.status = 'pending'""", (admin.user_id,))
    return {"items": items, "waiting_for_me": waiting["n"]}


@router.get("/meta")
async def meta(admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        all_groups = await db.fetch_all(conn, f"select {groups.COLUMNS} from groups g order by lower(g.name)")
        members = await db.fetch_all(conn, """select m.group_id, m.user_id, m.role from group_members m""")
        users = await ss.users_by_id(conn, [m["user_id"] for m in members])
        people = [ss.person(u) for u in await ss.eligible_admins(conn)]
    by_group: dict[int, list] = {}
    for m in members:
        by_group.setdefault(m["group_id"], []).append({**ss.person(users[m["user_id"]]), "group_role": m["role"]})
    return {
        "groups": [{**g, "members": by_group.get(g["id"], []),
                    "is_member": any(m["id"] == admin.user_id for m in by_group.get(g["id"], [])),
                    "is_manager": any(m["id"] == admin.user_id and m["group_role"] == "manager"
                                      for m in by_group.get(g["id"], []))} for g in all_groups],
        "people": people,
        "me": admin.user_id,
        "full": _full(admin),
        "rules": [{"key": k, "label": v} for k, v in ss.RULES.items()],
        "levels": [{"key": k, "label": v} for k, v in ss.LEVELS.items()],
        "events": [{"key": k, "label": v[0]} for k, v in ss.NOTIFY_EVENTS.items()],
        "max_days": ss.MAX_GRANT_DAYS,
    }


@router.get("/requests")
async def list_requests(scope: str = "waiting", admin: Principal = Depends(require_admin)):
    if scope not in ("waiting", "mine", "open", "all"):
        raise HTTPException(400, "Ukendt filter")
    where = {"waiting": """q.status = 'pending' and exists (select 1 from secret_approvals a where a.request_id = q.id
                            and a.approver_id = %(me)s and a.decision = 'pending')""",
             "mine": "q.requester_id = %(me)s", "open": "q.status = 'pending'", "all": "true"}[scope]
    async with db.connection() as conn:
        rows = await db.fetch_all(conn, f"""select q.*, s.name as secret_name, s.environment, g.name as group_name
                                            from secret_access_requests q join secrets s on s.id = q.secret_id
                                            join groups g on g.id = s.group_id
                                            where {where} order by q.created_at desc limit 200""", {"me": admin.user_id})
        return {"items": [await _request_out(conn, r, admin.user_id) for r in rows]}


async def _request_out(conn, r: dict, me: int) -> dict:
    appr = await ss.approvals(conn, r["id"])
    users = await ss.users_by_id(conn, [a["approver_id"] for a in appr] + [r["requester_id"]]
                                 + ([r["grantee_user_id"]] if r["grantee_user_id"] else []))
    group = await db.fetch_one(conn, "select id, name from groups where id = %s", (r["grantee_group_id"],)) \
        if r["grantee_group_id"] else None
    mine = next((a for a in appr if a["approver_id"] == me), None)
    return {
        "id": r["id"], "secret_id": r["secret_id"], "secret_name": r.get("secret_name"), "environment": r.get("environment"),
        "group_name": r.get("group_name"), "requester": ss.person(users.get(r["requester_id"])),
        "grantee": ss.person(users.get(r["grantee_user_id"])) if r["grantee_user_id"] else None,
        "grantee_group": group, "level": r["level"], "level_label": ss.LEVELS[r["level"]], "days": r["days"],
        "reason": r["reason"], "status": r["status"], "approval_rule": r["approval_rule"],
        "rule_label": "Én administrator (ingen andre i RAC)" if r["fallback"] else ss.RULES[r["approval_rule"]],
        "fallback": r["fallback"], "created_at": r["created_at"], "expires_at": r["expires_at"], "decided_at": r["decided_at"],
        "approvals": [{"approver": ss.person(users.get(a["approver_id"])), "roles": a["roles"], "decision": a["decision"],
                       "note": a["note"], "decided_at": a["decided_at"]} for a in appr],
        "approved": sum(a["decision"] == "approved" for a in appr), "total": len(appr),
        "can_decide": r["status"] == "pending" and mine is not None and mine["decision"] == "pending",
        "own": r["requester_id"] == me,
    }


# ── One secret ─────────────────────────────────────────────────────────────

@router.post("", status_code=201)
async def create_secret(body: SecretIn, admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        group = await groups.get(conn, body.group_id)
        if not ss.eligible(await _me(conn, admin)):
            raise HTTPException(403, "Kræver adgang til Hemmeligheder")
        if not await groups.is_member(conn, group["id"], admin.user_id) and not _full(admin):
            raise HTTPException(403, "Du skal være medlem af gruppen for at oprette en hemmelighed i den")
        raci = await ss.validate_raci(conn, _raci_dict(body.raci) if body.raci else
                                      await ss.default_raci(conn, group["id"], admin.user_id))
        if await db.fetch_one(conn, """select 1 from secrets where group_id = %s and lower(name) = lower(%s)
                                       and environment = %s and archived_at is null""",
                              (group["id"], body.name.strip(), body.environment.strip())):
            raise HTTPException(409, "Gruppen har allerede en hemmelighed med det navn i det miljø")
        row = await db.fetch_one(conn, """
            insert into secrets (group_id, name, environment, description, tags, approval_rule, rotation_days, expires_at,
                                 created_by)
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s) returning id""",
            (group["id"], body.name.strip(), body.environment.strip(), body.description.strip(), _tags(body.tags),
             body.approval_rule, body.rotation_days, body.expires_at, admin.user_id))
        secret = await ss.get(conn, row["id"])
        await ss.write_raci(conn, secret["id"], raci)
        version = await ss.set_value(conn, secret, body.value, admin.user_id)
        await audit(conn, "create", actor_id=admin.user_id, meta=admin.meta, table="secrets", row_id=secret["id"],
                    after={"name": secret["name"], "environment": secret["environment"], "group_id": group["id"],
                           "approval_rule": body.approval_rule, "raci": {str(k): v for k, v in raci.items()},
                           "version": version, "length": len(body.value)})
        await webhooks.emit(conn, "secret.created", {"secret_id": secret["id"], "group_id": group["id"]})
    return {"id": secret["id"]}


@router.get("/{secret_id}")
async def get_secret(secret_id: int, admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        secret = await ss.get(conn, secret_id)
        me = await _me(conn, admin)
        raci = await ss.raci_map(conn, secret_id)
        grants = await ss.active_grants(conn, secret_id)
        versions = await db.fetch_all(conn, """select version, hint, length, created_by, created_at, superseded_at
                                               from secret_versions where secret_id = %s order by version desc""", (secret_id,))
        reqs = await db.fetch_all(conn, """select * from secret_access_requests where secret_id = %s
                                           order by (status = 'pending') desc, created_at desc limit 50""", (secret_id,))
        activity = await db.fetch_all(conn, """
            select a.ts, a.action, a.actor_user_id, a.detail from audit_log a
            where a.table_name = 'secrets' and a.row_id = %s order by a.id desc limit 50""", (str(secret_id),))
        users = await ss.users_by_id(conn, list(raci) + [g["user_id"] for g in grants if g["user_id"]]
                                     + [v["created_by"] for v in versions if v["created_by"]]
                                     + [a["actor_user_id"] for a in activity if a["actor_user_id"]])
        level = await ss.access_level(conn, secret, me)
        a_user = next((users.get(u) for u, rs in raci.items() if "A" in rs), None)
        pending = sum(r["status"] == "pending" for r in reqs)
        group_role = await groups.is_member(conn, secret["group_id"], admin.user_id)
        return {
            **secret,
            "status": ss.status_of(secret, has_a=bool(a_user and ss.eligible(a_user)), pending=pending),
            "rule_label": ss.RULES[secret["approval_rule"]],
            "my_roles": sorted(raci.get(admin.user_id, []), key=ss.RACI.index),
            "my_level": level,
            "can_edit_raci": "A" in raci.get(admin.user_id, []) or (_full(admin) and not (a_user and ss.eligible(a_user))),
            "can_manage": bool({"A", "R"} & set(raci.get(admin.user_id, []))),
            "group_role": group_role,
            "raci": [{**ss.person(users.get(u)), "roles": rs} for u, rs in
                     sorted(raci.items(), key=lambda kv: (min(ss.RACI.index(r) for r in kv[1]), kv[0]))],
            "versions": [{"version": v["version"], "current": v["version"] == secret["current_version"],
                          "hint": v["hint"] if level else "", "length": v["length"] if level else None,
                          "created_at": v["created_at"], "superseded_at": v["superseded_at"],
                          "created_by": ss.person(users.get(v["created_by"]))} for v in versions],
            "grants": [{"id": g["id"], "level": g["level"], "level_label": ss.LEVELS[g["level"]], "granted_at": g["granted_at"],
                        "expires_at": g["expires_at"], "user": ss.person(users.get(g["user_id"])) if g["user_id"] else None,
                        "group": {"id": g["group_id"], "name": g["group_name"]} if g["group_id"] else None} for g in grants],
            "requests": [await _request_out(conn, r, admin.user_id) for r in reqs],
            "activity": [{"ts": a["ts"], "action": a["action"], "actor": ss.person(users.get(a["actor_user_id"])),
                          "detail": {k: v for k, v in (a["detail"] or {}).items()
                                     if k in ("request_id", "grant_id", "level", "days", "reason", "version", "status")}}
                         for a in activity],
        }


@router.patch("/{secret_id}")
async def update_secret(secret_id: int, body: SecretPatch, admin: Principal = Depends(require_admin)):
    fields = body.model_dump(exclude_unset=True)
    if "tags" in fields:
        fields["tags"] = _tags(fields["tags"] or [])
    for k in ("name", "environment", "description"):
        if k in fields and fields[k] is not None:
            fields[k] = fields[k].strip()
    async with db.connection() as conn:
        secret = await ss.get(conn, secret_id, lock=True)
        mine = await _need_roles(conn, secret, admin, {"A", "R"}, "A og R")
        if "approval_rule" in fields and "A" not in mine:
            raise HTTPException(403, "Kun A kan ændre, hvem der skal godkende adgang")
        if not fields:
            return {"ok": True}
        sets = ", ".join(f"{k} = %s" for k in fields)
        await conn.execute(f"update secrets set {sets}, updated_at = now() where id = %s", (*fields.values(), secret_id))
        b, a = changed(secret, fields)
        await audit(conn, "update", actor_id=admin.user_id, meta=admin.meta, table="secrets", row_id=secret_id, before=b, after=a)
    return {"ok": True}


@router.post("/{secret_id}/archive")
async def archive_secret(secret_id: int, body: ReasonIn, admin: Principal = Depends(require_admin_stepup)):
    async with db.connection() as conn:
        secret = await ss.get(conn, secret_id, lock=True)
        if secret["archived_at"] is not None:
            raise HTTPException(409, "Hemmeligheden er allerede arkiveret")
        await _need_roles(conn, secret, admin, {"A"}, "A")
        await ss.notify(conn, secret, "secret.archived", actor_id=admin.user_id)  # before the grants end: grantees hear it
        await conn.execute("update secrets set archived_at = now(), updated_at = now() where id = %s", (secret_id,))
        await conn.execute("""update secret_grants set ended_at = now(), ended_reason = 'archived'
                              where secret_id = %s and ended_at is null""", (secret_id,))
        await conn.execute("""update secret_access_requests set status = 'cancelled', decided_at = now()
                              where secret_id = %s and status = 'pending'""", (secret_id,))
        await audit(conn, "secret.archived", actor_id=admin.user_id, meta=admin.meta, table="secrets", row_id=secret_id,
                    reason=body.reason)
    return {"ok": True}


@router.post("/{secret_id}/reveal")
async def reveal(secret_id: int, version: int | None = None, admin: Principal = Depends(require_admin_stepup)):
    async with db.connection() as conn:
        secret = await ss.get(conn, secret_id)
        level = await ss.require_level(conn, secret, admin.user_id, "read")
        v = version or secret["current_version"]
        if v != secret["current_version"] and level != "write":
            raise HTTPException(403, "Kun A, R og dem med “Se og ændre” kan se gamle versioner")
        value = await ss.read_value(conn, secret_id, v)
        await audit(conn, "secret.revealed", actor_id=admin.user_id, meta=admin.meta, table="secrets", row_id=secret_id,
                    version=v)
        await ss.notify(conn, secret, "secret.revealed", actor_id=admin.user_id, extra={"version": v})
    return {"value": value, "version": v, "show_seconds": 30}


@router.put("/{secret_id}/value")
async def change_value(secret_id: int, body: ValueIn, admin: Principal = Depends(require_admin_stepup)):
    async with db.connection() as conn:
        secret = await ss.get(conn, secret_id, lock=True)
        await ss.require_level(conn, secret, admin.user_id, "write")
        version = await ss.set_value(conn, secret, body.value, admin.user_id)
        await audit(conn, "secret.value_changed", actor_id=admin.user_id, meta=admin.meta, table="secrets", row_id=secret_id,
                    version=version, length=len(body.value))
        await ss.notify(conn, secret, "secret.value.changed", actor_id=admin.user_id, extra={"version": version})
    return {"version": version}


@router.post("/{secret_id}/versions/{version}/restore")
async def restore_version(secret_id: int, version: int, admin: Principal = Depends(require_admin_stepup)):
    async with db.connection() as conn:
        secret = await ss.get(conn, secret_id, lock=True)
        await ss.require_level(conn, secret, admin.user_id, "write")
        if version == secret["current_version"]:
            raise HTTPException(400, "Det er allerede den nuværende version")
        value = await ss.read_value(conn, secret_id, version)
        new = await ss.set_value(conn, secret, value, admin.user_id)
        await audit(conn, "secret.value_changed", actor_id=admin.user_id, meta=admin.meta, table="secrets", row_id=secret_id,
                    version=new, restored_from=version, length=len(value))
        await ss.notify(conn, secret, "secret.value.changed", actor_id=admin.user_id, extra={"version": new})
    return {"version": new}


@router.put("/{secret_id}/raci")
async def put_raci(secret_id: int, body: RaciPut, admin: Principal = Depends(require_admin_stepup)):
    async with db.connection() as conn:
        secret = await ss.get(conn, secret_id, lock=True)
        if secret["archived_at"] is not None:
            raise HTTPException(409, "Hemmeligheden er arkiveret")
        before = await ss.raci_map(conn, secret_id)
        users = await ss.users_by_id(conn, before)
        a_user = next((users.get(u) for u, rs in before.items() if "A" in rs), None)
        orphaned = not (a_user and ss.eligible(a_user))
        if "A" not in before.get(admin.user_id, []) and not (orphaned and _full(admin)):
            raise HTTPException(403, "Kun A kan ændre RACI (eller en admin med fuld adgang, når A mangler)")
        after = await ss.validate_raci(conn, _raci_dict(body.raci))
        await ss.write_raci(conn, secret_id, after)
        await conn.execute("update secrets set updated_at = now() where id = %s", (secret_id,))
        b, a = changed({str(k): v for k, v in before.items()} | {str(k): None for k in after if k not in before},
                       {str(k): v for k, v in after.items()} | {str(k): None for k in before if k not in after})
        await audit(conn, "secret.raci_changed", actor_id=admin.user_id, meta=admin.meta, table="secrets", row_id=secret_id,
                    before=b, after=a)
        await ss.notify(conn, secret, "secret.raci.changed", actor_id=admin.user_id,
                        direct=[u for u in before if u not in after and set(before[u]) & {"A", "R", "C"}])
    return {"raci": after}


@router.post("/{secret_id}/requests", status_code=201)
async def request_access(secret_id: int, body: RequestIn, admin: Principal = Depends(require_admin)):
    if body.grantee_user_id is not None and body.grantee_group_id is not None:
        raise HTTPException(400, "Vælg enten en person eller en gruppe")
    async with db.connection() as conn:
        secret = await ss.get(conn, secret_id, lock=True)
        if not ss.eligible(await _me(conn, admin)):
            raise HTTPException(403, "Kræver adgang til Hemmeligheder")
        grantee_user = body.grantee_user_id if body.grantee_group_id is None else None
        if grantee_user is None and body.grantee_group_id is None:
            grantee_user = admin.user_id
        row = await ss.create_request(conn, secret, requester_id=admin.user_id, grantee_user_id=grantee_user,
                                      grantee_group_id=body.grantee_group_id, level=body.level, days=body.days,
                                      reason=body.reason, meta=admin.meta)
        return await _request_out(conn, row, admin.user_id)


@router.post("/requests/{request_id}/decide")
async def decide(request_id: int, body: DecideIn, admin: Principal = Depends(require_admin_stepup)):
    async with db.connection() as conn:
        return await ss.decide(conn, request_id, approver_id=admin.user_id, approve=body.approve, note=body.note,
                               meta=admin.meta)


@router.post("/requests/{request_id}/cancel")
async def cancel_request(request_id: int, admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        row = await db.fetch_one(conn, """update secret_access_requests set status = 'cancelled', decided_at = now()
                                          where id = %s and requester_id = %s and status = 'pending'
                                          returning secret_id""", (request_id, admin.user_id))
        if row is None:
            raise HTTPException(404, "Ingen åben anmodning fra dig med det id")
        await audit(conn, "secret.access_cancelled", actor_id=admin.user_id, meta=admin.meta, table="secrets",
                    row_id=row["secret_id"], request_id=request_id)
    return {"ok": True}


@router.post("/{secret_id}/grants/{grant_id}/revoke")
async def revoke_grant(secret_id: int, grant_id: int, admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        secret = await ss.get(conn, secret_id, lock=True)
        await _need_roles(conn, secret, admin, {"A", "R"}, "A og R")
        await ss.end_grant(conn, secret, grant_id, reason="revoked", actor_id=admin.user_id, meta=admin.meta)
    return {"ok": True}


# ── Notification rules per group ───────────────────────────────────────────

async def _may_edit_rules(conn, group_id: int, admin: Principal) -> bool:
    return _full(admin) or await groups.is_member(conn, group_id, admin.user_id) == "manager"


@router.get("/groups/{group_id}/notify")
async def get_notify(group_id: int, admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        group = await groups.get(conn, group_id)
        rules = await ss.rules_for(conn, group_id)
        return {"group": group, "can_edit": await _may_edit_rules(conn, group_id, admin),
                "events": [{"key": k, "label": v[0], "modes": rules[k]} for k, v in ss.NOTIFY_EVENTS.items()],
                "audiences": list(ss.AUDIENCES)}


@router.put("/groups/{group_id}/notify")
async def put_notify(group_id: int, body: NotifyPut, admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        await groups.get(conn, group_id)
        if not await _may_edit_rules(conn, group_id, admin):
            raise HTTPException(403, "Kun gruppens ansvarlige eller en admin med fuld adgang kan ændre beskederne")
        before = await ss.rules_for(conn, group_id)
        for r in body.rules:
            if r.event not in ss.NOTIFY_EVENTS:
                raise HTTPException(400, f"Ukendt hændelse: {r.event}")
            if r.audience == "channel" and r.mode == "digest":
                raise HTTPException(400, "Gruppens kanal får beskeder med det samme eller slet ikke")
            await conn.execute("""insert into group_notify_rules (group_id, event, audience, mode) values (%s, %s, %s, %s)
                                  on conflict (group_id, event, audience) do update set mode = excluded.mode, updated_at = now()""",
                               (group_id, r.event, r.audience, r.mode))
        after = await ss.rules_for(conn, group_id)
        b, a = changed(before, after)
        await audit(conn, "update", actor_id=admin.user_id, meta=admin.meta, table="group_notify_rules", row_id=group_id,
                    before=b, after=a)
        return {"ok": True}
