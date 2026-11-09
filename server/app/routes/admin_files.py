"""/api/admin/files — the file tree for /admin/files: every home under /users/<id>/ and /shared/.
Same rules and audit rows as /api/files (app/filetree.py), with admin=True. Reads are logged as admin.read by
require_admin; every change is audited by filetree."""

import uuid

from fastapi import APIRouter, Depends, UploadFile

from app import db, filetree
from app.routes.files import FolderIn, MoveIn, TextFileIn, raw_response
from app.sessions import Principal, require_admin
from app.storage import get_storage

router = APIRouter(prefix="/api/admin/files", tags=["admin"], dependencies=[Depends(require_admin)])


@router.get("/tree")
async def tree(path: str = "/", q: str | None = None, admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        listing = await filetree.list_dir(conn, filetree.parse(path, me=admin.user_id), admin, admin=True, q=q)
        listing["totals"] = await filetree.totals(conn)
    return listing


@router.post("/folders")
async def make_folder(body: FolderIn, admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        return await filetree.make_folder(conn, filetree.parse(body.path, me=admin.user_id), admin, admin=True)


@router.delete("/folders")
async def delete_folder(path: str, admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        return await filetree.delete_folder(conn, filetree.parse(path, me=admin.user_id), admin, admin=True)


@router.post("/upload")
async def upload(file: UploadFile, path: str, overwrite: bool = False, admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        row = await filetree.upload(conn, filetree.parse(path, me=admin.user_id), file, admin, admin=True,
                                    overwrite=overwrite)
    return filetree.out(row, admin=True)


@router.put("/text")
async def write_text(body: TextFileIn, admin: Principal = Depends(require_admin)):
    loc, name = filetree.split_file(body.path, me=admin.user_id)
    async with db.connection() as conn:
        row = await filetree.write(conn, loc, name, body.content.encode(), body.content_type, admin, admin=True,
                                   overwrite=body.overwrite)
    return filetree.out(row, admin=True)


@router.get("/item/{file_id}")
async def item(file_id: uuid.UUID, admin: Principal = Depends(require_admin)):
    """Metadata and, for text files, the first 512 kB of text."""
    async with db.connection() as conn:
        row = await filetree.get_file(conn, file_id, admin, admin=True)
    data = filetree.out(row, admin=True)
    data["kind"] = row["kind"]
    if data["preview"] == "text":
        data.update(await filetree.read_text(row))
    return data


@router.get("/item/{file_id}/raw")
async def item_raw(file_id: uuid.UUID, admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        row = await filetree.get_file(conn, file_id, admin, admin=True)
    data, _ = await get_storage().get(row["storage_key"])
    return raw_response(row, data)


@router.get("/item/{file_id}/link")
async def item_link(file_id: uuid.UUID, admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        row = await filetree.get_file(conn, file_id, admin, admin=True)
    return await filetree.download_link(row)


@router.patch("/item/{file_id}")
async def item_move(file_id: uuid.UUID, body: MoveIn, admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        row = await filetree.get_file(conn, file_id, admin, admin=True, lock=True)
        new = await filetree.move(conn, row, admin, admin=True, folder=body.folder, filename=body.filename)
    return filetree.out(new, admin=True)
