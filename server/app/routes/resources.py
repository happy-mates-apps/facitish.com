"""/admin/resources: resources in use, limits and estimated monthly price (section "Ressourcer", role Drift).

GET measures everything live (app.resources); like every /admin read it is logged as admin.read by require_admin.
PUT /config changes the admin's own limits and prices, audited in the same transaction.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app import db, resources, settings_store
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
