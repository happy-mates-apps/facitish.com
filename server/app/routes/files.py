"""Files in Object Storage. Uploads go through the server; downloads use short-lived links."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import Response

from app import config, db
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
        insert into files (id, user_id, storage_key, filename, content_type, size_bytes, kind)
        values (%s, %s, %s, %s, %s, %s, %s)
        returning id, filename, content_type, size_bytes, created_at, storage_key""",
        (file_id, owner_id, key, filename, content_type, len(data), kind))
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


@router.get("")
async def list_files(p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        return await db.fetch_all(conn, """
            select id, filename, content_type, size_bytes, created_at from files
            where user_id = %s and kind = 'file' order by created_at desc""", (p.user_id,))


@router.post("")
async def upload_file(file: UploadFile, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        row = await save_upload(conn, file, owner_id=p.user_id, actor=p, prefix=f"users/{p.user_id}")
    row.pop("storage_key")
    return row


@router.get("/{file_id}/link")
async def file_link(file_id: uuid.UUID, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        row = await db.fetch_one(conn, "select storage_key, filename, user_id from files where id = %s", (file_id,))
    if row is None or (row["user_id"] != p.user_id and not p.is_admin):
        raise HTTPException(404, "Ikke fundet")
    url = await get_storage().download_url(row["storage_key"], row["filename"])
    return {"url": url, "expires_in": config.settings.download_link_seconds}


@router.delete("/{file_id}")
async def remove_file(file_id: uuid.UUID, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        await delete_file(conn, file_id, p, owner_id=p.user_id)
    return {"ok": True}


memory_router = APIRouter()


@memory_router.get("/api/_memory-storage/{key:path}")
async def memory_download(key: str):
    storage = get_storage()
    if not isinstance(storage, MemoryStorage) or key not in storage.objects:
        raise HTTPException(404)
    data, content_type = storage.objects[key]
    return Response(data, media_type=content_type)
