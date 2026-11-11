"""/api/admin/meta — /admin/meta: dimensions (the roots of the trees), and editing shared nodes: rename, move (rewrites
the subtree's paths), sort, archive, delete. Section "/meta" (admin role Indhold). Reads are logged as admin.read by
require_admin; every change is audited by app/meta.py or here."""

from fastapi import APIRouter, Depends, HTTPException
from psycopg import errors
from pydantic import BaseModel, Field

from app import db, meta
from app.logs import audit, changed
from app.routes.meta import NodeIn, NodePatch, patch_dict
from app.sessions import Principal, require_admin

router = APIRouter(prefix="/api/admin/meta", tags=["admin"], dependencies=[Depends(require_admin)])

COLOR = r"^#[0-9a-fA-F]{6}$"


class DimensionIn(BaseModel):
    slug: str = Field(min_length=1, max_length=meta.MAX_SLUG)
    label: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    color: str | None = Field(default=None, pattern=COLOR)
    locked: bool = False


class DimensionPatch(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    color: str | None = Field(default=None, pattern=COLOR)
    locked: bool | None = None


DIM_FIELDS = ("slug", "label", "description", "color", "locked")


@router.get("/dimensions")
async def dimensions(admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        rows = await db.fetch_all(conn, """
            select d.*, count(n.id) filter (where n.archived_at is null) as nodes,
                   count(n.id) filter (where n.archived_at is not null) as archived
            from meta_dimensions d left join meta_nodes n on n.dimension_id = d.id
            group by d.id order by lower(d.label)""")
        private = await db.fetch_one(conn, "select count(*) as nodes, count(distinct owner_id) as owners from meta_nodes where owner_id is not null")
    return {"dimensions": [{k: r[k] for k in ("id", *DIM_FIELDS, "nodes", "archived", "created_at")} for r in rows],
            "private": private}


@router.post("/dimensions")
async def create_dimension(body: DimensionIn, admin: Principal = Depends(require_admin)):
    slug = body.slug.strip().lower()
    if slug == meta.PRIVATE or not meta.valid_slug(slug):
        raise HTTPException(400, "Slug må kun indeholde små bogstaver, tal og bindestreg")
    async with db.connection() as conn:
        try:
            row = await db.fetch_one(conn, """insert into meta_dimensions (slug, label, description, color, locked, created_by)
                values (%s, %s, %s, %s, %s, %s) returning *""",
                (slug, body.label.strip(), body.description, body.color, body.locked, admin.user_id))
        except errors.UniqueViolation:
            raise HTTPException(409, "Der findes allerede en dimension med den slug") from None
        await audit(conn, "create", actor_id=admin.user_id, meta=admin.meta, table="meta_dimensions", row_id=row["id"],
                    after={k: row[k] for k in DIM_FIELDS})
    return {k: row[k] for k in ("id", *DIM_FIELDS)}


@router.patch("/dimensions/{dim_id}")
async def update_dimension(dim_id: int, body: DimensionPatch, admin: Principal = Depends(require_admin)):
    fields = body.model_dump(exclude_unset=True)
    async with db.connection() as conn:
        cur = await db.fetch_one(conn, "select * from meta_dimensions where id = %s for update", (dim_id,))
        if cur is None:
            raise HTTPException(404, "Dimensionen findes ikke")
        new = {k: cur[k] for k in DIM_FIELDS} | {k: v for k, v in fields.items() if v is not None or k == "color"}
        before, after = changed({k: cur[k] for k in DIM_FIELDS}, new)
        if after:
            await conn.execute("""update meta_dimensions set label = %(label)s, description = %(description)s,
                                  color = %(color)s, locked = %(locked)s, updated_at = now() where id = %(id)s""",
                               new | {"id": dim_id})
            await audit(conn, "update", actor_id=admin.user_id, meta=admin.meta, table="meta_dimensions", row_id=dim_id,
                        before=before, after=after)
    return {"id": dim_id, **new}


@router.delete("/dimensions/{dim_id}")
async def delete_dimension(dim_id: int, force: bool = False, admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        cur = await db.fetch_one(conn, """select d.slug, d.label, (select count(*) from meta_nodes n where n.dimension_id = d.id) as n
                                          from meta_dimensions d where d.id = %s for update""", (dim_id,))
        if cur is None:
            raise HTTPException(404, "Dimensionen findes ikke")
        if cur["n"] and not force:
            raise HTTPException(409, f"Dimensionen har {cur['n']} noder. Slet dem først, eller slet det hele.")
        await conn.execute("delete from meta_dimensions where id = %s", (dim_id,))
        await audit(conn, "delete", actor_id=admin.user_id, meta=admin.meta, table="meta_dimensions", row_id=dim_id,
                    before={"slug": cur["slug"], "label": cur["label"]}, nodes=cur["n"])
    return {"ok": True, "nodes": cur["n"]}


@router.post("/nodes")
async def create_node(body: NodeIn, admin: Principal = Depends(require_admin)):
    """Same as POST /api/meta/nodes, but as admin (top level and locked dimensions)."""
    async with db.connection() as conn:
        node = await meta.create_node(conn, admin, dim_slug=body.dimension, parent_id=body.parent_id, label=body.label,
                                      slug=body.slug, description=body.description, as_admin=True)
    await meta.count_event("meta.node_created", node["id"])
    return node


@router.patch("/nodes/{node_id}")
async def update_node(node_id: int, body: NodePatch, admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        return await meta.update_node(conn, admin, node_id, patch_dict(body), admin=True)


@router.delete("/nodes/{node_id}")
async def delete_node(node_id: int, force: bool = False, admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        return await meta.delete_node(conn, admin, node_id, admin=True, force=force)
