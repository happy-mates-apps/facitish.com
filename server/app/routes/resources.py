"""/admin/resources: resources in use, limits and estimated monthly price (section "Ressourcer", role Drift).

GET measures everything live (app.resources); like every /admin read it is logged as admin.read by require_admin.
PUT /config changes the admin's own limits and prices, audited in the same transaction.
GET /control: kill switches, rules and events by kind. PUT /killswitches/{key} closes or opens a switch,
PUT /rules replaces the automatic rules (app.events); both audited.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import config, db, events, killswitch, resources, settings_store
from app.logs import audit, changed
from app.sessions import Principal, require_admin

router = APIRouter(prefix="/api/admin/resources", tags=["admin"], dependencies=[Depends(require_admin)])


class ItemConfig(BaseModel):
    max: float | None = Field(default=None, ge=0, le=1e15)          # GB for storage, otherwise the resource's unit
    monthly: float | None = Field(default=None, ge=0, le=1e9)       # fixed price per month
    unit_price: float | None = Field(default=None, ge=0, le=1e9)    # per GB, per million tokens, per mail/SMS


class ConfigIn(BaseModel):
    items: dict[str, ItemConfig]


@router.get("")
async def overview():
    return await resources.overview()


@router.put("/config")
async def put_config(body: ConfigIn, admin: Principal = Depends(require_admin)):
    unknown = sorted(set(body.items) - set(resources.RESOURCES))
    if unknown:
        raise HTTPException(422, f"Ukendt ressource: {', '.join(unknown)}")
    after = {k: v.model_dump() for k, v in body.items.items() if any(x is not None for x in v.model_dump().values())}
    async with db.connection() as conn:
        before = (await settings_store.get(conn, "resources") or {}).get("items", {})
        await settings_store.set_many(conn, {"resources": {"items": after}})
        b, a = changed(before, after)
        for key in before:
            if key not in after:
                b[key], a[key] = before[key], None
        await audit(conn, "update", actor_id=admin.user_id, meta=admin.meta, table="settings", row_id="resources",
                    before=b, after=a)
    return {"ok": True}


# ── Kill switches, rules and events ─────────────────────────────────────────

@router.get("/control")
async def control():
    async with db.connection() as conn:
        rows = {r["key"]: r for r in await db.fetch_all(conn, """
            select k.key, k.active, k.reason, k.auto, k.set_at, k.expires_at,
                   k.active and (k.expires_at is null or k.expires_at > now()) as closed,
                   coalesce(u.display_name, u.email, u.phone) as set_by_name
            from kill_switches k left join users u on u.id = k.set_by""")}
        rules = await settings_store.get(conn, "kill_rules") or []
        kinds = await db.fetch_all(conn, """
            select kind,
                   count(*) filter (where ts > now() - interval '5 minutes') as m5,
                   count(*) filter (where ts > now() - interval '1 hour') as h1,
                   count(*) as d1,
                   max(ts) as last_seen
            from events where ts > now() - interval '1 day' group by kind order by count(*) desc""")
    switches = []
    for s in killswitch.catalog():
        r = rows.get(s["key"])
        switches.append({**s, "closed": bool(r and r["closed"]), "reason": r["reason"] if r else "",
                         "auto": bool(r and r["auto"]), "set_at": r["set_at"] if r else None,
                         "expires_at": r["expires_at"] if r and r["closed"] else None,
                         "set_by_name": r["set_by_name"] if r else None})
    seen = {k["kind"] for k in kinds}
    known = [{"kind": k, "description": d} for k, d in events.KINDS.items()]
    return {
        "switches": switches,
        "rules": rules,
        "kinds": [{**k, "description": events.KINDS.get(k["kind"])} for k in kinds],
        "known_kinds": known + [{"kind": k, "description": None} for k in sorted(seen - set(events.KINDS))],
        "bus": events.bus(),
        "nats_configured": bool(config.settings.nats_url),
        "rules_seconds": config.settings.events_rules_seconds,
    }


class SwitchIn(BaseModel):
    closed: bool
    reason: str = Field(default="", max_length=500)
    minutes: int | None = Field(default=None, ge=1, le=60 * 24 * 30)   # None = until opened again


@router.put("/killswitches/{key}")
async def set_killswitch(key: str, body: SwitchIn, admin: Principal = Depends(require_admin)):
    if key not in killswitch.SWITCHES:
        raise HTTPException(404, "Ukendt nødstop")
    if body.closed and not body.reason.strip():
        raise HTTPException(422, "Skriv hvorfor du lukker")
    async with db.connection() as conn:
        changed_now = await events.set_switch(conn, key, body.closed, reason=body.reason.strip(),
                                              minutes=body.minutes if body.closed else None,
                                              actor_id=admin.user_id, meta=admin.meta)
    killswitch.invalidate()
    return {"ok": True, "changed": changed_now}


class RuleIn(BaseModel):
    kind: str = Field(pattern=events.KIND.pattern, max_length=100)
    threshold: int = Field(ge=1, le=10_000_000)
    window_seconds: int = Field(ge=10, le=86_400)
    switch: str
    minutes: int | None = Field(default=15, ge=1, le=60 * 24 * 30)
    enabled: bool = True


class RulesIn(BaseModel):
    rules: list[RuleIn] = Field(max_length=50)


@router.put("/rules")
async def put_rules(body: RulesIn, admin: Principal = Depends(require_admin)):
    bad = sorted({r.switch for r in body.rules} - set(killswitch.SWITCHES))
    if bad:
        raise HTTPException(422, f"Ukendt nødstop: {', '.join(bad)}")
    after = [r.model_dump() for r in body.rules]
    async with db.connection() as conn:
        before = await settings_store.get(conn, "kill_rules") or []
        await settings_store.set_many(conn, {"kill_rules": after})
        if before != after:
            await audit(conn, "update", actor_id=admin.user_id, meta=admin.meta, table="settings", row_id="kill_rules",
                        before={"rules": before}, after={"rules": after})
    return {"ok": True}
