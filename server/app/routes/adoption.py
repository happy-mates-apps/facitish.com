"""Adoption: journeys measured by the routes signed-in users visit (/admin/adoption).

    POST /api/adoption/visits            the app on / reports the pages a signed-in user opens (batched), while
                                         tracking is on (setting adoption_tracking, off by default)
    /api/admin/adoption/…                overview, journeys, dashboard, setup, members, nudges, routes and the live stream

Who may do what:
- The /adoption sections are opened by the admin roles Fuld adgang and Produkt (app/admin_roles.py).
- Fuld adgang sees and manages every journey. Other admins see the journeys they are a member of: reader (statistics),
  editor (setup and nudges) or owner (members and deleting). Whoever creates a journey becomes its owner.
- Turning tracking on or off is for Fuld adgang only and needs a recent second factor: it starts or stops recording
  which pages people open.
Every change is audited in the same transaction. Nudges are delivered as the webhook event adoption.nudge.sent (ids only).
"""

import asyncio
import json
import time
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from app import adoption, admin_roles, db, settings_store, webhooks
from app.adoption_match import MATCH_LABELS, StepMatcher, clean_path, normalize, surface, tracked, valid
from app.logs import audit, changed
from app.sessions import Principal, current_user, require_admin, require_admin_stepup

router = APIRouter(prefix="/api/adoption", tags=["adoption"])
admin_router = APIRouter(prefix="/api/admin/adoption", tags=["admin"], dependencies=[Depends(require_admin)])

SECTION = "/adoption"
ROLES = ("reader", "editor", "owner")
JOURNEY_COLUMNS = "id, name, status, audience, goal_pct, start_at, end_at, created_at, updated_at"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def sees_all(p: Principal) -> bool:
    return p.super_admin or admin_roles.FULL in admin_roles.clean(p.admin_roles)


def _has_section(roles) -> bool:
    return SECTION in admin_roles.sections(roles)


# ── Tracking (the app on /) ─────────────────────────────────────────────────

class VisitsIn(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=50)


@router.post("/visits")
async def record_visits(body: VisitsIn, p: Principal = Depends(current_user)):
    """Pages the user opened. Ignored while tracking is off, while an admin views the app as a test account, and for
    pages outside the app on / (sign-in, /admin, /w …)."""
    async with db.connection() as conn:
        if not await settings_store.get(conn, "adoption_tracking"):
            return {"tracking": False, "recorded": 0}
        if p.impersonator_id is not None:
            return {"tracking": True, "recorded": 0}
        paths, prev = [], None
        for raw in body.paths:
            path = clean_path(raw)
            if path and path != prev and tracked(path):
                paths.append(path)
            prev = path
        for path in paths:
            await conn.execute("insert into adoption_visits (user_id, path, surface) values (%s, %s, %s)",
                               (p.user_id, path, surface(path)))
    return {"tracking": True, "recorded": len(paths)}


# ── Settings ────────────────────────────────────────────────────────────────

async def _nudge_hooks(conn) -> int:
    row = await db.fetch_one(conn, """select count(*) as n from webhooks
                                      where active and ('*' = any(events) or 'adoption.nudge.sent' = any(events))""")
    return row["n"]


@admin_router.get("/settings")
async def get_settings(p: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        policy = await db.fetch_one(conn, "select days, enabled from retention_policies where key = 'adoption_visits'")
        return {"tracking": bool(await settings_store.get(conn, "adoption_tracking")),
                "retention_days": policy["days"] if policy and policy["enabled"] else None,
                "nudge_webhooks": await _nudge_hooks(conn), "sees_all": sees_all(p),
                "match_types": MATCH_LABELS}


class SettingsIn(BaseModel):
    tracking: bool


@admin_router.put("/settings")
async def put_settings(body: SettingsIn, p: Principal = Depends(require_admin_stepup)):
    if not sees_all(p):
        raise HTTPException(403, "Kun admins med Fuld adgang kan slå sporingen til og fra")
    async with db.connection() as conn:
        before = bool(await settings_store.get(conn, "adoption_tracking"))
        if before != body.tracking:
            await settings_store.set_many(conn, {"adoption_tracking": body.tracking})
            await audit(conn, "update", actor_id=p.user_id, meta=p.meta, table="settings", row_id="adoption_tracking",
                        before={"tracking": before}, after={"tracking": body.tracking})
    return {"tracking": body.tracking}


# ── Journeys ────────────────────────────────────────────────────────────────

async def _journey(conn, p: Principal, journey_id: int, need: Literal["read", "edit", "manage"] = "read") -> tuple[dict, str]:
    """The journey and the caller's role in it ('admin' for Fuld adgang). 404 when it is not theirs to see."""
    j = await db.fetch_one(conn, f"select {JOURNEY_COLUMNS} from adoption_journeys where id = %s", (journey_id,))
    if j is None:
        raise HTTPException(404, "Forløbet findes ikke")
    if sees_all(p):
        role = "admin"
    else:
        m = await db.fetch_one(conn, "select role from adoption_members where journey_id = %s and user_id = %s",
                               (journey_id, p.user_id))
        if m is None:
            raise HTTPException(404, "Forløbet findes ikke")
        role = m["role"]
    if need == "edit" and role not in ("editor", "owner", "admin"):
        raise HTTPException(403, "Kræver rollen Redaktør eller Ejer i forløbet")
    if need == "manage" and role not in ("owner", "admin"):
        raise HTTPException(403, "Kræver rollen Ejer i forløbet")
    return j, role


async def _visible(conn, p: Principal) -> list[tuple[dict, str]]:
    if sees_all(p):
        rows = await db.fetch_all(conn, f"select {JOURNEY_COLUMNS} from adoption_journeys order by created_at")
        return [(r, "admin") for r in rows]
    rows = await db.fetch_all(conn, f"""select {", ".join("j." + c.strip() for c in JOURNEY_COLUMNS.split(","))}, m.role
                                        from adoption_journeys j join adoption_members m on m.journey_id = j.id
                                        where m.user_id = %s order by j.created_at""", (p.user_id,))
    return [({k: v for k, v in r.items() if k != "role"}, r["role"]) for r in rows]


async def _view(conn, j: dict, role: str, now: datetime) -> dict:
    steps = await adoption.load_steps(conn, j["id"])
    s = await adoption.summary(conn, j, steps, now)
    return {**j, "audience_text": adoption.audience_text(j["audience"]), "steps": steps, **s,
            "my_role": role, "can_edit": role in ("editor", "owner", "admin"), "can_manage": role in ("owner", "admin")}


@admin_router.get("/journeys")
async def list_journeys(p: Principal = Depends(require_admin)):
    now = _now()
    async with db.connection() as conn:
        return {"items": [await _view(conn, j, role, now) for j, role in await _visible(conn, p)], "sees_all": sees_all(p)}


class JourneyIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


@admin_router.post("/journeys", status_code=201)
async def create_journey(body: JourneyIn, p: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        j = await db.fetch_one(conn, f"""insert into adoption_journeys (name, created_by) values (%s, %s)
                                         returning {JOURNEY_COLUMNS}""", (body.name.strip(), p.user_id))
        await conn.execute("insert into adoption_members (journey_id, user_id, role, added_by) values (%s, %s, 'owner', %s)",
                           (j["id"], p.user_id, p.user_id))
        await audit(conn, "create", actor_id=p.user_id, meta=p.meta, table="adoption_journeys", row_id=j["id"],
                    after={"name": j["name"], "status": j["status"]})
        return await _view(conn, j, "admin" if sees_all(p) else "owner", _now())


@admin_router.get("/journeys/{journey_id}")
async def get_journey(journey_id: int, p: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        j, role = await _journey(conn, p, journey_id)
        return await _view(conn, j, role, _now())


class StepIn(BaseModel):
    label: str = Field(min_length=1, max_length=120)
    match_type: Literal["exact", "prefix", "glob", "regex"]
    pattern: str = Field(min_length=1, max_length=300)


class AudienceIn(BaseModel):
    kind: Literal["all", "role", "users"]
    roles: list[Literal["user", "admin"]] = Field(default_factory=list, max_length=2)
    user_ids: list[int] = Field(default_factory=list, max_length=500)


class JourneyPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    status: Literal["draft", "active", "paused"] | None = None
    audience: AudienceIn | None = None
    goal_pct: int | None = Field(default=None, ge=1, le=100)
    start_at: datetime | None = None
    end_at: datetime | None = None
    steps: list[StepIn] | None = Field(default=None, max_length=20)


def _audience(a: AudienceIn) -> dict:
    if a.kind == "role":
        if not a.roles:
            raise HTTPException(400, "Vælg mindst én rolle")
        return {"kind": "role", "roles": sorted(set(a.roles))}
    if a.kind == "users":
        if not a.user_ids:
            raise HTTPException(400, "Vælg mindst én bruger")
        return {"kind": "users", "user_ids": sorted(set(a.user_ids))}
    return {"kind": "all"}


@admin_router.patch("/journeys/{journey_id}")
async def update_journey(journey_id: int, body: JourneyPatch, p: Principal = Depends(require_admin)):
    fields = body.model_fields_set
    async with db.connection() as conn:
        j, role = await _journey(conn, p, journey_id, "edit")
        new = {}
        if body.name is not None:
            new["name"] = body.name.strip()
        if body.status is not None:
            new["status"] = body.status
        if body.goal_pct is not None:
            new["goal_pct"] = body.goal_pct
        if body.audience is not None:
            new["audience"] = _audience(body.audience)
        if body.start_at is not None:
            new["start_at"] = body.start_at
        if "end_at" in fields:
            new["end_at"] = body.end_at
        start, end = new.get("start_at", j["start_at"]), new.get("end_at", j["end_at"])
        if end is not None and end <= start:
            raise HTTPException(400, "Slutdatoen skal ligge efter starten")
        before, after = changed(j, new)
        if after:
            sets = ", ".join(f"{k} = %s" for k in after)
            values = [Jsonb(v) if k == "audience" else v for k, v in after.items()]
            await conn.execute(f"update adoption_journeys set {sets}, updated_at = now() where id = %s", (*values, journey_id))
        if body.steps is not None:
            for i, s in enumerate(body.steps):
                if not valid(s.match_type, s.pattern):
                    raise HTTPException(400, f"Trin {i + 1}: ugyldigt mønster")
            old = await adoption.load_steps(conn, journey_id)
            new_steps = [{"label": s.label.strip(), "match_type": s.match_type, "pattern": s.pattern.strip()} for s in body.steps]
            if [{k: o[k] for k in ("label", "match_type", "pattern")} for o in old] != new_steps:
                await conn.execute("delete from adoption_steps where journey_id = %s", (journey_id,))
                for i, s in enumerate(new_steps):
                    await conn.execute("""insert into adoption_steps (journey_id, position, label, match_type, pattern)
                                          values (%s, %s, %s, %s, %s)""", (journey_id, i, s["label"], s["match_type"], s["pattern"]))
                before["steps"] = [f"{o['match_type']} {o['pattern']}" for o in old]
                after["steps"] = [f"{s['match_type']} {s['pattern']}" for s in new_steps]
                await conn.execute("update adoption_journeys set updated_at = now() where id = %s", (journey_id,))
        if after:
            await audit(conn, "update", actor_id=p.user_id, meta=p.meta, table="adoption_journeys", row_id=journey_id,
                        before=before, after=after)
        j, role = await _journey(conn, p, journey_id)
        return await _view(conn, j, role, _now())


@admin_router.delete("/journeys/{journey_id}")
async def delete_journey(journey_id: int, p: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        j, _ = await _journey(conn, p, journey_id, "manage")
        await conn.execute("delete from adoption_journeys where id = %s", (journey_id,))
        await audit(conn, "delete", actor_id=p.user_id, meta=p.meta, table="adoption_journeys", row_id=journey_id,
                    before={"name": j["name"], "status": j["status"]})
    return {"ok": True}


# ── Dashboard and nudges ────────────────────────────────────────────────────

@admin_router.get("/journeys/{journey_id}/dashboard")
async def dashboard(journey_id: int, dim: Literal["role", "surface", "locale"] = "role", p: Principal = Depends(require_admin)):
    now = _now()
    async with db.connection() as conn:
        j, role = await _journey(conn, p, journey_id)
        steps = await adoption.load_steps(conn, journey_id)
        rows, cohort = await adoption.load_activity(conn, j, now)
        users = await adoption.user_info(conn, cohort, rows)
        nudges = {r["user_id"]: r["sent_at"] for r in await db.fetch_all(conn, """
            select distinct on (user_id) user_id, sent_at from adoption_nudges where journey_id = %s
            order by user_id, sent_at desc""", (journey_id,))}
        match = StepMatcher(steps)
        recent = await adoption.recent_visits(conn, since=max(j["start_at"], now - timedelta(days=1)), limit=500)
        live = [{**v, "step": match(v["path"])[0] + 1} for v in recent if v["user_id"] in cohort and match(v["path"])]
        names = await adoption.names(conn, {v["user_id"] for v in live[:6]})
        out = adoption.build_dashboard(steps=steps, start_at=j["start_at"], goal_pct=j["goal_pct"], rows=rows, cohort=cohort,
                                       users=users, live_hits=live, nudges=nudges, dim=dim, now=now)
        out["live_hits"] = [{"id": v["id"], "at": v["at"], "path": v["path"], "user": names.get(v["user_id"]), "step": v["step"]}
                            for v in live[:6]]
        out["nudge_webhooks"] = await _nudge_hooks(conn)
        out["can_edit"] = role in ("editor", "owner", "admin")
        return out


class NudgeIn(BaseModel):
    user_ids: list[int] = Field(min_length=1, max_length=200)


@admin_router.post("/journeys/{journey_id}/nudges")
async def nudge(journey_id: int, body: NudgeIn, p: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        j, _ = await _journey(conn, p, journey_id, "edit")
        _, cohort = await adoption.load_activity(conn, j, _now())
        ids = sorted(set(body.user_ids))
        outside = [i for i in ids if i not in cohort]
        if outside:
            raise HTTPException(400, "Skub kan kun sendes til brugere i forløbets målgruppe")
        for uid in ids:
            await conn.execute("insert into adoption_nudges (journey_id, user_id, sent_by) values (%s, %s, %s)",
                               (journey_id, uid, p.user_id))
        await audit(conn, "create", actor_id=p.user_id, meta=p.meta, table="adoption_nudges", row_id=journey_id,
                    users=len(ids))
        hooks = await webhooks.emit(conn, "adoption.nudge.sent", {"journey_id": journey_id, "user_ids": ids})
    return {"sent": len(ids), "webhooks": hooks}


# ── Members ─────────────────────────────────────────────────────────────────

@admin_router.get("/journeys/{journey_id}/members")
async def members(journey_id: int, p: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        _, role = await _journey(conn, p, journey_id)
        items = await db.fetch_all(conn, """
            select m.user_id, m.role, m.created_at, u.display_name,
                   case when m.added_by = m.user_id then null else a.display_name end as added_by
            from adoption_members m join users u on u.id = m.user_id left join users a on a.id = m.added_by
            where m.journey_id = %s order by m.created_at""", (journey_id,))
        admins = await db.fetch_all(conn, """select id, display_name, admin_roles, super_admin from users
                                             where role = 'admin' and blocked_at is null and not impersonation_only
                                             order by display_name nulls last, id""")
    taken = {m["user_id"] for m in items}
    candidates = [{"id": a["id"], "display_name": a["display_name"] or f"Bruger {a['id']}"} for a in admins
                  if a["id"] not in taken and (a["super_admin"] or _has_section(a["admin_roles"]))]
    return {"items": items, "candidates": candidates, "can_manage": role in ("owner", "admin")}


class MemberIn(BaseModel):
    role: Literal["reader", "editor", "owner"]


async def _owners(conn, journey_id: int) -> int:
    return (await db.fetch_one(conn, "select count(*) as n from adoption_members where journey_id = %s and role = 'owner'",
                               (journey_id,)))["n"]


@admin_router.put("/journeys/{journey_id}/members/{user_id}")
async def set_member(journey_id: int, user_id: int, body: MemberIn, p: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        await _journey(conn, p, journey_id, "manage")
        u = await db.fetch_one(conn, """select id, admin_roles, super_admin from users where id = %s and role = 'admin'
                                        and blocked_at is null and not impersonation_only""", (user_id,))
        if u is None or not (u["super_admin"] or _has_section(u["admin_roles"])):
            raise HTTPException(400, "Kun admins med adgang til Adoption (Produkt eller Fuld adgang) kan tildeles en rolle")
        old = await db.fetch_one(conn, "select role from adoption_members where journey_id = %s and user_id = %s",
                                 (journey_id, user_id))
        await conn.execute("""insert into adoption_members (journey_id, user_id, role, added_by) values (%s, %s, %s, %s)
                              on conflict (journey_id, user_id) do update set role = excluded.role""",
                           (journey_id, user_id, body.role, p.user_id))
        if await _owners(conn, journey_id) == 0:
            raise HTTPException(409, "Forløbet skal have mindst én ejer")
        if old is None or old["role"] != body.role:
            await audit(conn, "create" if old is None else "update", actor_id=p.user_id, meta=p.meta,
                        table="adoption_members", row_id=f"{journey_id}:{user_id}",
                        before=None if old is None else {"role": old["role"]}, after={"role": body.role})
    return {"ok": True}


@admin_router.delete("/journeys/{journey_id}/members/{user_id}")
async def remove_member(journey_id: int, user_id: int, p: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        await _journey(conn, p, journey_id, "manage")
        old = await db.fetch_one(conn, "delete from adoption_members where journey_id = %s and user_id = %s returning role",
                                 (journey_id, user_id))
        if old is None:
            raise HTTPException(404, "Personen har ingen rolle i forløbet")
        if await _owners(conn, journey_id) == 0:
            raise HTTPException(409, "Den sidste ejer kan ikke fjernes. Gør en anden til ejer først.")
        await audit(conn, "delete", actor_id=p.user_id, meta=p.meta, table="adoption_members",
                    row_id=f"{journey_id}:{user_id}", before={"role": old["role"]})
    return {"ok": True}


@admin_router.get("/access")
async def access(p: Principal = Depends(require_admin)):
    """Admins and whether their admin roles open Adoption, with the number of journeys they have a role in."""
    async with db.connection() as conn:
        rows = await db.fetch_all(conn, """
            select u.id, u.display_name, u.admin_roles, u.super_admin,
                   (select count(*) from adoption_members m where m.user_id = u.id) as journeys
            from users u where u.role = 'admin' and u.blocked_at is null and not u.impersonation_only
            order by u.display_name nulls last, u.id""")
    labels = {k: v["label"] for k, v in admin_roles.ROLES.items()}
    return {"items": [{"id": r["id"], "display_name": r["display_name"] or f"Bruger {r['id']}",
                       "admin_roles": [labels.get(x, x) for x in admin_roles.clean(r["admin_roles"])],
                       "access": "all" if r["super_admin"] or admin_roles.FULL in (r["admin_roles"] or [])
                       else ("assigned" if _has_section(r["admin_roles"]) else "none"),
                       "journeys": r["journeys"]} for r in rows]}


@admin_router.get("/people")
async def people(q: str = Query("", max_length=80), p: Principal = Depends(require_admin)):
    """Users to pick for an audience: id and display name only."""
    async with db.connection() as conn:
        rows = await db.fetch_all(conn, """select id, display_name, role from users
                                           where not impersonation_only and blocked_at is null
                                             and (%s = '' or display_name ilike %s)
                                           order by display_name nulls last, id limit 25""", (q, f"%{q}%"))
    return {"items": [{"id": r["id"], "display_name": r["display_name"] or f"Bruger {r['id']}", "role": r["role"]} for r in rows]}


# ── Overview and routes ─────────────────────────────────────────────────────

def _days(days: int) -> int:
    if days not in (7, 30, 90):
        raise HTTPException(422, "Perioden skal være 7, 30 eller 90 dage")
    return days


def _trend(cur: int, prev: int) -> int | None:
    return round((cur - prev) / prev * 100) if prev else None


@admin_router.get("/overview")
async def overview(days: int = Query(30, ge=7, le=90), p: Principal = Depends(require_admin)):
    now, days = _now(), _days(days)
    since, prev = now - timedelta(days=days), now - timedelta(days=2 * days)
    async with db.connection() as conn:
        daily = {r["d"].date(): r for r in await db.fetch_all(conn, """
            select date_trunc('day', at) as d, count(*) as visits, count(distinct user_id) as users
            from adoption_visits where at >= %s group by 1""", (since,))}
        cur = await db.fetch_one(conn, "select count(*) as v, count(distinct user_id) as u from adoption_visits where at >= %s",
                                 (since,))
        old = await db.fetch_one(conn, """select count(*) as v, count(distinct user_id) as u from adoption_visits
                                          where at >= %s and at < %s""", (prev, since))
        paths = await db.fetch_all(conn, "select path, count(*) as n from adoption_visits where at >= %s group by path", (since,))
        journeys = [await _view(conn, j, role, now) for j, role in await _visible(conn, p)]
        tracking = bool(await settings_store.get(conn, "adoption_tracking"))
    routes: dict[str, int] = {}
    for r in paths:
        key = normalize(r["path"])
        routes[key] = routes.get(key, 0) + r["n"]
    days_list = [(since + timedelta(days=i + 1)).date() for i in range(days)]
    active = [j for j in journeys if j["status"] == "active"]
    return {
        "tracking": tracking, "days": days,
        "active_users": {"value": cur["u"], "trend": _trend(cur["u"], old["u"]),
                         "series": [daily[d]["users"] if d in daily else 0 for d in days_list]},
        "tracked_visits": {"value": cur["v"], "trend": _trend(cur["v"], old["v"]),
                           "series": [daily[d]["visits"] if d in daily else 0 for d in days_list]},
        "avg_completion": round(sum(j["done_pct"] for j in active) / len(active)) if active else 0,
        "journeys_active": len(active), "journeys_total": len(journeys), "tracked_routes": len(routes),
        "top_routes": [{"route": k, "visits": v} for k, v in sorted(routes.items(), key=lambda kv: -kv[1])[:8]],
        "journeys": journeys,
    }


@admin_router.get("/routes")
async def routes(days: int = Query(30, ge=7, le=90), p: Principal = Depends(require_admin)):
    now, days = _now(), _days(days)
    since, prev = now - timedelta(days=days), now - timedelta(days=2 * days)
    async with db.connection() as conn:
        rows = await db.fetch_all(conn, """select path, user_id, count(*) filter (where at >= %s) as n,
                                                  count(*) filter (where at < %s) as prev
                                           from adoption_visits where at >= %s group by path, user_id""", (since, since, prev))
        journeys = [(j, await adoption.load_steps(conn, j["id"])) for j, _ in await _visible(conn, p)]
    agg: dict[str, dict] = {}
    for r in rows:
        key = normalize(r["path"])
        a = agg.setdefault(key, {"route": key, "surface": adoption.SURFACE_LABELS[surface(r["path"])], "visits": 0,
                                 "prev": 0, "users": set()})
        a["visits"] += r["n"]
        a["prev"] += r["prev"]
        if r["n"]:
            a["users"].add(r["user_id"])
    out = []
    for a in sorted(agg.values(), key=lambda a: -a["visits"]):
        if not a["visits"]:
            continue
        measured = [{"id": j["id"], "name": j["name"]} for j, steps in journeys if StepMatcher(steps)(a["route"])]
        out.append({"route": a["route"], "surface": a["surface"], "visits": a["visits"], "users": len(a["users"]),
                    "trend": _trend(a["visits"], a["prev"]), "journeys": measured})
    return {"rows": out[:500], "total": sum(r["visits"] for r in out), "days": days}


# ── Live ────────────────────────────────────────────────────────────────────

async def _live_lines(conn, p: Principal, after_id: int, limit: int = 40) -> list[dict]:
    visits = await adoption.recent_visits(conn, after_id=after_id, limit=limit)
    if not visits:
        return []
    active = [(j, await adoption.load_steps(conn, j["id"])) for j, _ in await _visible(conn, p) if j["status"] == "active"]
    matchers = [(j, StepMatcher(steps)) for j, steps in active]
    names = await adoption.names(conn, {v["user_id"] for v in visits})
    lines = []
    for v in visits:
        hits = [{"journey_id": j["id"], "journey_name": j["name"], "step": m(v["path"])[0] + 1}
                for j, m in matchers if v["at"] >= j["start_at"] and m(v["path"])]
        lines.append({"id": v["id"], "at": v["at"], "path": v["path"], "surface": v["surface"],
                      "user": names.get(v["user_id"]), "hits": hits})
    return lines


@admin_router.get("/live")
async def live(after: int = Query(0, ge=0), p: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        lines = await _live_lines(conn, p, after)
    return {"lines": lines, "last_id": lines[0]["id"] if lines else after}


@admin_router.get("/stream")
async def stream(request: Request, after: int = Query(0, ge=0), seconds: int = Query(300, ge=0, le=600),
                 p: Principal = Depends(require_admin)):
    """Server-sent events: new visits every two seconds for at most `seconds`, then the browser reconnects (and the
    caller's access is checked again). One admin.read per connection, not per poll."""
    async def events():
        last = after
        deadline = time.monotonic() + seconds
        yield "retry: 3000\n\n"
        while True:
            async with db.connection() as conn:
                lines = await _live_lines(conn, p, last)
            if lines:
                last = lines[0]["id"]
                yield f"data: {json.dumps({'lines': lines, 'last_id': last}, default=str, ensure_ascii=False)}\n\n"
            else:
                yield ": ping\n\n"
            if time.monotonic() >= deadline or await request.is_disconnected():
                return
            await asyncio.sleep(2)

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
