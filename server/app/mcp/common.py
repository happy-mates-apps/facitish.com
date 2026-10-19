"""Small helpers shared by the tools of both servers."""

import uuid

from app import config, db
from app.logs import audit
from app.mcp.registry import Caller
from app.security import mask_phone
from app.storage import get_storage


def absolute(url: str) -> str:
    return config.settings.origin.rstrip("/") + url if url.startswith("/") else url


def masked(phone: str | None) -> str | None:
    """Test accounts have no phone number; their placeholder address is shown as it is."""
    return phone if phone and "@" in phone else mask_phone(phone)


def limit(value: int | None, default: int, maximum: int) -> int:
    return max(1, min(value or default, maximum))


async def store_file(conn, *, owner_id: int | None, filename: str, data: bytes, content_type: str, caller: Caller,
                     prefix: str) -> dict:
    """Stores generated content (a GDPR export) as a normal file, so it shows under Filer or /admin/files and is
    covered by deletion and erasure. Returns the row and a short-lived download link."""
    file_id = uuid.uuid4()
    key = f"{prefix}/{file_id}"
    await get_storage().put(key, data, content_type)
    row = await db.fetch_one(conn, """
        insert into files (id, user_id, storage_key, filename, content_type, size_bytes)
        values (%s, %s, %s, %s, %s, %s) returning id, filename, size_bytes, created_at""",
        (file_id, owner_id, key, filename, content_type, len(data)))
    await audit(conn, "file.upload", actor_id=caller.user_id, meta=caller.principal.meta, table="files", row_id=file_id,
                after={"filename": filename, "size_bytes": len(data), "user_id": owner_id, "via": "mcp"})
    url = absolute(await get_storage().download_url(key, filename))
    return {**row, "download_url": url, "expires_in": config.settings.download_link_seconds}
