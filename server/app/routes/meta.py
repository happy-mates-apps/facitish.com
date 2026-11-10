"""/api/meta — træstrukturer for everyone logged in: browse, search, resolve stored ids, and create nodes where the
rules allow (app/meta.py). Owners also rename, move, archive and delete nodes in their private tree; shared nodes are
edited in /admin/meta (routes/admin_meta.py)."""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app import db, meta
from app.sessions import Principal, current_user

router = APIRouter(prefix="/api/meta", tags=["meta"])

DIM = r"^[^/\s]{1,64}$"


class NodeIn(BaseModel):
    dimension: str = Field(pattern=DIM)
    parent_id: int | None = None
    label: str = Field(min_length=1, max_length=120)
    slug: str | None = Field(default=None, max_length=meta.MAX_SLUG)
    description: str = Field(default="", max_length=2000)


class NodePatch(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    sort_order: int | None = Field(default=None, ge=0, le=1_000_000)
    archived: bool | None = None
    parent_id: int | None = None
    slug: str | None = Field(default=None, max_length=meta.MAX_SLUG)


def patch_dict(body: NodePatch) -> dict:
    """Only the fields sent; parent_id: null means 'move to the top level' when it is sent."""
    return body.model_dump(exclude_unset=True)


def parse_ids(ids: str) -> list[int]:
    try:
        out = [int(x) for x in ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(400, "ids skal være tal adskilt af komma") from None
    if len(out) > 500:
        raise HTTPException(400, "Højst 500 ids ad gangen")
    return out


@router.get("/dimensions")
async def dimensions(p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        rows = await db.fetch_all(conn, """select d.*, (select count(*) from meta_nodes n where n.dimension_id = d.id
                                                         and n.archived_at is null) as n
                                           from meta_dimensions d order by lower(d.label)""")
        mine = await db.fetch_one(conn, "select count(*) as n from meta_nodes where owner_id = %s and archived_at is null",
                                  (p.user_id,))
    admin = meta.is_meta_admin(p)
    return [meta.dim_out(d, p, admin=admin, count=d["n"]) for d in rows] + [
        meta.dim_out(None, p, admin=admin, count=mine["n"])]


@router.get("/tree")
async def tree(dimension: str | None = Query(default=None, pattern=DIM), root: int | None = None,
               depth: int = Query(default=2, ge=1, le=meta.MAX_DEPTH), include_archived: bool = False,
               p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        return await meta.tree(conn, p, dim_slug=dimension, root_id=root, depth=depth, include_archived=include_archived)


@router.get("/search")
async def search(q: str = Query(min_length=1, max_length=120), dimension: str | None = Query(default=None, pattern=DIM),
                 root: int | None = None, limit: int = 50, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        return await meta.search(conn, p, q.strip(), dim_slug=dimension, root_id=root, limit=limit)


@router.get("/nodes")
async def resolve(ids: str = Query(max_length=6000), p: Principal = Depends(current_user)):
    """Stored node ids → nodes with their trail ('Organisation › Drift'), for showing a saved value."""
    async with db.connection() as conn:
        return await meta.resolve(conn, p, parse_ids(ids))


@router.get("/expand")
async def expand(ids: str = Query(max_length=6000), p: Principal = Depends(current_user)):
    """A filter value with cascade="subtree" → every node id it covers."""
    async with db.connection() as conn:
        return {"ids": await meta.expand_subtree(conn, p, parse_ids(ids))}


@router.post("/nodes")
async def create(body: NodeIn, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        node = await meta.create_node(conn, p, dim_slug=body.dimension, parent_id=body.parent_id, label=body.label,
                                      slug=body.slug, description=body.description)
    await meta.count_event("meta.node_created", node["id"])
    return node


@router.patch("/nodes/{node_id}")
async def update(node_id: int, body: NodePatch, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        return await meta.update_node(conn, p, node_id, patch_dict(body), admin=False)


@router.delete("/nodes/{node_id}")
async def delete(node_id: int, force: bool = False, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        return await meta.delete_node(conn, p, node_id, admin=False, force=force)
