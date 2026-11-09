"""Files in Object Storage. Uploads go through the server; downloads use short-lived links."""

import uuid
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app import config, db, filetree
from app.logs import audit
from app.sessions import Principal, current_user
from app.storage import MemoryStorage, get_storage

router = APIRouter(prefix="/api/files", tags=["files"])


async def save_upload(conn, upload: UploadFile, *, owner_id: int | None, actor: Principal, prefix: str,
                      content_type: str | None = None, kind: str = "file") -> dict:
    """Stores an upload and writes file.upload in the audit log. Used by /api/files, /api/me/avatar and
    /admin/settings. content_type overrides what the browser sent (when the server checked the content itself)."""
    limit = config.settings.max_upload_mb * 1024 * 1024
    data = await upload.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(413, f"Filen er større end {config.settings.max_upload_mb} MB")
    file_id = uuid.uuid4()
    filename = (upload.filename or "fil").replace("/", "_")[:200]
    content_type = content_type or upload.content_type or "application/octet-stream"
    key = f"{prefix}/{file_id}"
    await get_storage().put(key, data, content_type)
    row = await db.fetch_one(conn, """
        insert into files (id, user_id, storage_key, filename, content_type, size_bytes, kind, uploaded_by)
        values (%s, %s, %s, %s, %s, %s, %s, %s)
        returning id, filename, content_type, size_bytes, created_at, storage_key""",
        (file_id, owner_id, key, filename, content_type, len(data), kind, actor.user_id))
    await audit(conn, "file.upload", actor_id=actor.user_id, meta=actor.meta, table="files", row_id=file_id,
                after={"filename": filename, "size_bytes": len(data), "content_type": content_type,
                       "user_id": owner_id, "kind": kind})
    return row


async def delete_file(conn, file_id, actor: Principal, owner_id: int | None = None) -> None:
    sql = "delete from files where id = %s" + (" and user_id = %s" if owner_id is not None else "") + \
          " returning id, user_id, storage_key, filename, size_bytes"
    params = (file_id, owner_id) if owner_id is not None else (file_id,)
    row = await db.fetch_one(conn, sql, params)
    if row is None:
        raise HTTPException(404, "Ikke fundet")
    await get_storage().delete(row["storage_key"])
    await audit(conn, "file.delete", actor_id=actor.user_id, meta=actor.meta, table="files", row_id=file_id,
                before={k: row[k] for k in ("filename", "size_bytes", "user_id")})


# ── The tree: your home (/users/<you>/, short ~) and /shared ────────────────
# All rules live in app/filetree.py; /api/admin/files uses the same functions with admin=True.

class FolderIn(BaseModel):
    path: str = Field(min_length=1, max_length=1000)


class TextFileIn(BaseModel):
    path: str = Field(min_length=1, max_length=1000)
    content: str = Field(max_length=5_000_000)
    content_type: str | None = Field(default=None, max_length=100)
    overwrite: bool = True


class MoveIn(BaseModel):
    folder: str | None = Field(default=None, max_length=1000)
    filename: str | None = Field(default=None, max_length=200)


def raw_response(row: dict, data: bytes) -> Response:
    """Inline preview of a file, from our own origin. Text is always sent as text/plain and everything runs in a
    sandbox, so an uploaded HTML or SVG file cannot run script on the app's origin."""
    kind = filetree.preview_kind(row["content_type"], row["filename"])
    if kind is None:
        raise HTTPException(415, "Filen kan ikke vises – hent den i stedet")
    media = "text/plain; charset=utf-8" if kind == "text" else row["content_type"]
    headers = {"Content-Disposition": f"inline; filename*=UTF-8''{quote(row['filename'])}",
               "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store"}
    # The browser's PDF viewer does not start inside a sandbox; a PDF cannot reach the page that frames it anyway.
    headers["Content-Security-Policy"] = (
        "default-src 'none'; object-src 'self'; frame-ancestors 'self'" if kind == "pdf" else
        "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox")
    return Response(data, media_type=media, headers=headers)


@router.get("")
async def list_files(p: Principal = Depends(current_user)):
    """All files in your home (every folder), newest first."""
    async with db.connection() as conn:
        rows = await db.fetch_all(conn, """
            select id, filename, content_type, size_bytes, created_at, updated_at, space, user_id, folder, uploaded_by, kind
            from files where user_id = %s and kind = 'file' order by created_at desc""", (p.user_id,))
    return [filetree.out(r) for r in rows]


@router.get("/tree")
async def tree(path: str = "~/", q: str | None = None, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        return await filetree.list_dir(conn, filetree.parse(path, me=p.user_id), p, admin=False, q=q)


@router.post("/folders")
async def make_folder(body: FolderIn, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        return await filetree.make_folder(conn, filetree.parse(body.path, me=p.user_id), p, admin=False)


@router.delete("/folders")
async def delete_folder(path: str, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        return await filetree.delete_folder(conn, filetree.parse(path, me=p.user_id), p, admin=False)


@router.post("")
async def upload_file(file: UploadFile, path: str = "~/", overwrite: bool = False, p: Principal = Depends(current_user)):
    """Upload to a folder in your home (default) or in /shared."""
    async with db.connection() as conn:
        row = await filetree.upload(conn, filetree.parse(path, me=p.user_id), file, p, admin=False, overwrite=overwrite)
    return filetree.out(row)


@router.put("/text")
async def write_text(body: TextFileIn, p: Principal = Depends(current_user)):
    """Writes a text file (used by the AI chat to keep project notes in /shared)."""
    loc, name = filetree.split_file(body.path, me=p.user_id)
    async with db.connection() as conn:
        row = await filetree.write(conn, loc, name, body.content.encode(), body.content_type, p, admin=False,
                                   overwrite=body.overwrite)
    return filetree.out(row)


@router.get("/by-path")
async def by_path(path: str, p: Principal = Depends(current_user)):
    """Metadata and, for text files, the text."""
    async with db.connection() as conn:
        row = await filetree.get_by_path(conn, path, p, admin=False)
    return {**filetree.out(row), **(await _text_if_any(row))}


async def _text_if_any(row: dict) -> dict:
    if filetree.preview_kind(row["content_type"], row["filename"]) != "text":
        return {}
    return await filetree.read_text(row)


@router.get("/{file_id}")
async def file_get(file_id: uuid.UUID, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        row = await filetree.get_file(conn, file_id, p, admin=False)
    return {**filetree.out(row), **(await _text_if_any(row))}


@router.get("/{file_id}/raw")
async def file_raw(file_id: uuid.UUID, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        row = await filetree.get_file(conn, file_id, p, admin=False)
    data, _ = await get_storage().get(row["storage_key"])
    return raw_response(row, data)


@router.get("/{file_id}/link")
async def file_link(file_id: uuid.UUID, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        row = await filetree.get_file(conn, file_id, p, admin=p.is_admin)
    return await filetree.download_link(row)


@router.patch("/{file_id}")
async def file_move(file_id: uuid.UUID, body: MoveIn, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        row = await filetree.get_file(conn, file_id, p, admin=False, lock=True)
        return filetree.out(await filetree.move(conn, row, p, admin=False, folder=body.folder, filename=body.filename))


@router.delete("/{file_id}")
async def remove_file(file_id: uuid.UUID, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        row = await filetree.get_file(conn, file_id, p, admin=False, lock=True)
        if row["kind"] != "file":
            raise HTTPException(404, "Ikke fundet")
        await filetree.delete(conn, row, p, admin=False)
    return {"ok": True}


memory_router = APIRouter()


@memory_router.get("/api/_memory-storage/{key:path}")
async def memory_download(key: str):
    storage = get_storage()
    if not isinstance(storage, MemoryStorage) or key not in storage.objects:
        raise HTTPException(404)
    data, content_type = storage.objects[key]
    return Response(data, media_type=content_type)
