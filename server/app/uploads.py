"""Direct upload to Object Storage, and zip files unpacked into the file tree (migration 0021).

The bytes never pass through the server (or Cloudflare, which stops requests over 100 MB):

    POST   …/uploads                 {path, filename, size, content_type, overwrite, unzip, into_folder}
                                     → one presigned PUT link, or (big files) a multipart upload: part_size + parts
    POST   …/uploads/{id}/parts      {numbers: [1, 2, …]} → a presigned link per part (asked for as the upload goes)
    PUT    <link>                    the browser sends the bytes to the bucket (multipart: keeps each part's ETag)
    POST   …/uploads/{id}/complete   {parts: [{number, etag}]} → the file is put in the tree (file.upload, via 'direct')
                                     or, for unzip, the job files.unzip is queued
    GET    …/uploads/{id}            status (the app polls while a zip is unpacked)
    DELETE …/uploads/{id}            aborts it

`…` is /api/files (a user: own home and /shared) and /api/admin/files (admin=True). The rules for where a file may go
are filetree's: they are checked when the upload starts and again when it is completed.

A zip can be kept as it is (an ordinary upload) or unpacked: the zip lands on a temporary key (uploads/<id>), and
files.unzip puts every file in it into the target folder, keeping its folders, a batch at a time (a new job continues
where the last stopped). Every file is audited as file.upload (via 'unzip'); the whole run as file.unzip. The zip itself
is deleted afterwards. Limits: UNZIP_MAX_FILES files and UNZIP_MAX_MB unpacked; files that cannot be placed (bad name,
encrypted, too big) are skipped and listed in the result.

The bucket must let the app's origin PUT and read the ETag header (CORS): the job storage.cors sets that at start-up.
"""

import json
import logging
import math
import os
import re
import tempfile
import time
import uuid
import zipfile

from fastapi import HTTPException, UploadFile
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from app import config, db, filetree, jobs
from app.logs import RequestMeta, audit
from app.sessions import Principal
from app.storage import get_storage

log = logging.getLogger("gaer.uploads")

MB = 1024 * 1024
SINGLE_PUT_MAX = 64 * MB      # bigger files go as multipart
PART_SIZE = 32 * MB           # S3 wants 5 MB at least and at most 10 000 parts
MAX_PARTS = 10_000
OPEN_HOURS = 24               # an upload not completed by then is aborted by files.uploads_cleanup
UNPACK_DAYS = 7
SKIP_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}
_clock = time.monotonic       # tests replace it
_CONTENT_TYPE = re.compile(r"^[A-Za-z0-9][\w.+-]*/[\w.+-]+$")


class StartIn(BaseModel):
    path: str = Field(min_length=1, max_length=1000)
    filename: str = Field(min_length=1, max_length=200)
    size: int = Field(ge=0)
    content_type: str | None = Field(default=None, max_length=200)
    overwrite: bool = False
    unzip: bool = False
    into_folder: bool = False   # unzip: into a new folder named after the zip (else into the folder itself)


class PartsIn(BaseModel):
    numbers: list[int] = Field(min_length=1, max_length=100)


class PartIn(BaseModel):
    number: int = Field(ge=1, le=MAX_PARTS)
    etag: str = Field(min_length=1, max_length=200)


class CompleteIn(BaseModel):
    parts: list[PartIn] = Field(default_factory=list, max_length=MAX_PARTS)


def is_zip(filename: str) -> bool:
    return filename.lower().endswith(".zip")


def _content_type(value: str | None, filename: str) -> str:
    value = (value or "").strip()
    return value if _CONTENT_TYPE.match(value) else filetree.guess_type(filename)


def _target(loc: filetree.Loc, filename: str, into_folder: bool) -> filetree.Loc:
    if not into_folder:
        return loc
    stem = filename[:-4].strip() if is_zip(filename) else filename
    return loc.child(stem or "zip")


def _public(row: dict) -> dict:
    return {k: row[k] for k in ("id", "path", "filename", "size_bytes", "status", "unzip", "done", "result", "error",
                                "created_at", "finished_at")}


async def _load(conn, upload_id, p: Principal, *, admin: bool, lock: bool = False) -> dict:
    try:
        uid = uuid.UUID(str(upload_id))
    except ValueError:
        raise HTTPException(404, "Uploaden findes ikke")
    row = await db.fetch_one(conn, "select * from file_uploads where id = %s and user_id = %s and admin = %s"
                             + (" for update" if lock else ""), (uid, p.user_id, admin))
    if row is None:
        raise HTTPException(404, "Uploaden findes ikke")
    return row


# ── The API (routes/files.py and routes/admin_files.py) ─────────────────────

async def start(conn, body: StartIn, p: Principal, *, admin: bool) -> dict:
    s = config.settings
    if not s.direct_upload:
        raise HTTPException(404, "Direkte upload er slået fra – filen sendes via serveren")
    loc = filetree.parse(body.path, me=p.user_id)
    await filetree.check_write(conn, loc, p, admin=admin)
    name = filetree.clean_name(body.filename.replace("\\", "/").rsplit("/", 1)[-1])
    if body.size > s.max_direct_upload_mb * MB:
        raise HTTPException(413, f"Filen er større end {s.max_direct_upload_mb} MB")
    if body.unzip and not is_zip(name):
        raise HTTPException(400, "Kun zip-filer kan pakkes ud")
    target = _target(loc, name, body.into_folder) if body.unzip else loc
    content_type = "application/zip" if body.unzip else _content_type(body.content_type, name)
    upload_id = uuid.uuid4()
    key = f"uploads/{upload_id}" if body.unzip else f"{filetree.prefix(loc)}/{upload_id}"
    storage = get_storage()
    out: dict = {"id": str(upload_id), "content_type": content_type}
    multipart_id = part_size = None
    if body.size > SINGLE_PUT_MAX:
        part_size = max(PART_SIZE, math.ceil(body.size / MAX_PARTS / MB) * MB)
        multipart_id = await storage.start_multipart(key, content_type)
        out.update(multipart=True, part_size=part_size, parts=math.ceil(body.size / part_size))
    else:
        out.update(multipart=False, url=await storage.presign_put(key, content_type))
    await conn.execute("""
        insert into file_uploads (id, user_id, admin, path, filename, content_type, size_bytes, storage_key,
                                  multipart_id, part_size, overwrite, unzip, expires_at)
        values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now() + make_interval(hours => %s))""",
        (upload_id, p.user_id, admin, target.path, name, content_type, body.size, key, multipart_id, part_size,
         body.overwrite, body.unzip, OPEN_HOURS))
    return out


async def part_links(conn, upload_id, body: PartsIn, p: Principal, *, admin: bool) -> dict:
    row = await _load(conn, upload_id, p, admin=admin)
    if row["status"] != "uploading" or not row["multipart_id"]:
        raise HTTPException(409, "Uploaden tager ikke imod flere dele")
    count = math.ceil(row["size_bytes"] / row["part_size"])
    if any(n < 1 or n > count for n in body.numbers):
        raise HTTPException(400, f"Delene hedder 1 til {count}")
    storage = get_storage()
    return {"urls": {str(n): await storage.presign_part(row["storage_key"], row["multipart_id"], n)
                     for n in sorted(set(body.numbers))}}


async def complete(conn, upload_id, body: CompleteIn, p: Principal, *, admin: bool) -> dict:
    row = await _load(conn, upload_id, p, admin=admin, lock=True)
    if row["status"] != "uploading":
        return _public(row)   # completed twice (a retry): the same answer
    storage = get_storage()
    if row["multipart_id"]:
        count = math.ceil(row["size_bytes"] / row["part_size"])
        numbers = sorted(x.number for x in body.parts)
        if numbers != list(range(1, count + 1)):
            raise HTTPException(400, f"Alle {count} dele skal være med")
        try:
            await storage.complete_multipart(row["storage_key"], row["multipart_id"],
                                             [{"PartNumber": x.number, "ETag": x.etag}
                                              for x in sorted(body.parts, key=lambda x: x.number)])
        except Exception as e:  # noqa: BLE001 — a part is missing or its ETag is wrong; the browser may try again
            log.info("multipart complete failed for %s: %s", row["id"], e)
            raise HTTPException(400, "Delene kunne ikke samles – prøv at uploade igen")
    size = await storage.head(row["storage_key"])
    if size is None:
        raise HTTPException(400, "Filen er ikke kommet frem til Object Storage endnu")
    if size != row["size_bytes"]:
        await discard(row)
        return await _finish(conn, row["id"], "failed", error="Filen har ikke den størrelse, der blev meldt")
    if row["unzip"]:
        await conn.execute("""update file_uploads set status = 'unpacking',
                              expires_at = now() + make_interval(days => %s) where id = %s""", (UNPACK_DAYS, row["id"]))
        await jobs.enqueue(conn, "files.unzip", {"upload_id": str(row["id"])}, max_attempts=3,
                           dedupe_key=f"files.unzip:{row['id']}:0")
        return _public(await db.fetch_one(conn, "select * from file_uploads where id = %s", (row["id"],)))
    loc = filetree.parse(row["path"])
    placed = await filetree.register(conn, loc, row["filename"], row["storage_key"], size, row["content_type"], p,
                                     admin=admin, overwrite=row["overwrite"], via="direct",
                                     audit_extra={"upload_id": str(row["id"])})
    return await _finish(conn, row["id"], "done", result={"file": filetree.out(placed, admin=admin)})


async def abort(conn, upload_id, p: Principal, *, admin: bool) -> dict:
    row = await _load(conn, upload_id, p, admin=admin, lock=True)
    if row["status"] != "uploading":
        return _public(row)
    await discard(row)
    return await _finish(conn, row["id"], "aborted")


async def status(conn, upload_id, p: Principal, *, admin: bool) -> dict:
    return _public(await _load(conn, upload_id, p, admin=admin))


async def unzip_via_server(conn, loc: filetree.Loc, file: UploadFile, p: Principal, *, admin: bool,
                           overwrite: bool = False, into_folder: bool = False) -> dict:
    """The fallback when the browser cannot reach the bucket: a zip (up to MAX_UPLOAD_MB) sent to the server is
    stored on a temporary key and unpacked by the same job."""
    await filetree.check_write(conn, loc, p, admin=admin)
    name = filetree.clean_name((file.filename or "fil.zip").replace("\\", "/").rsplit("/", 1)[-1][:200] or "fil.zip")
    if not is_zip(name):
        raise HTTPException(400, "Kun zip-filer kan pakkes ud")
    limit = config.settings.max_upload_mb * MB
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(413, f"Filen er større end {config.settings.max_upload_mb} MB")
    upload_id = uuid.uuid4()
    key = f"uploads/{upload_id}"
    await get_storage().put(key, data, "application/zip")
    target = _target(loc, name, into_folder)
    row = await db.fetch_one(conn, """
        insert into file_uploads (id, user_id, admin, path, filename, content_type, size_bytes, storage_key,
                                  overwrite, unzip, status, expires_at)
        values (%s, %s, %s, %s, %s, 'application/zip', %s, %s, %s, true, 'unpacking',
                now() + make_interval(days => %s)) returning *""",
        (upload_id, p.user_id, admin, target.path, name, len(data), key, overwrite, UNPACK_DAYS))
    await jobs.enqueue(conn, "files.unzip", {"upload_id": str(upload_id)}, max_attempts=3,
                       dedupe_key=f"files.unzip:{upload_id}:0")
    return _public(row)


async def discard(row: dict) -> None:
    """Removes what an upload left in the bucket (an open multipart upload and/or the object)."""
    storage = get_storage()
    if row["multipart_id"] and row["status"] == "uploading":
        try:
            await storage.abort_multipart(row["storage_key"], row["multipart_id"])
        except Exception as e:  # noqa: BLE001 — already completed or gone
            log.info("could not abort multipart upload %s: %s", row["id"], e)
    try:
        await storage.delete(row["storage_key"])
    except Exception as e:  # noqa: BLE001 — an orphaned object is harmless
        log.info("could not remove upload %s: %s", row["id"], e)


def _jsonb(value: dict) -> Jsonb:
    return Jsonb(json.loads(json.dumps(value, default=str)))  # ids and times as text


async def _finish(conn, upload_id, status: str, *, result: dict | None = None, error: str | None = None) -> dict:
    row = await db.fetch_one(conn, """
        update file_uploads set status = %s, result = coalesce(%s, result), error = %s, finished_at = now()
        where id = %s returning *""", (status, _jsonb(result) if result is not None else None, error, upload_id))
    return _public(row)


# ── Unpacking a zip (job files.unzip) ───────────────────────────────────────

def plan(zf: zipfile.ZipFile) -> tuple[list[tuple[zipfile.ZipInfo, list[str], str]], list[dict]]:
    """The files in a zip in order, each with its folders and name; plus what is skipped and why.
    Raises ValueError when the zip is over the limits."""
    s = config.settings
    entries, skipped, total = [], [], 0
    for info in zf.infolist():
        if info.is_dir():
            continue
        raw = info.filename.replace("\\", "/")
        parts = [x for x in raw.split("/") if x not in ("", ".")]
        if not parts or parts[0] == "__MACOSX" or parts[-1] in SKIP_NAMES or parts[-1].startswith("._"):
            continue
        reason = None
        if ".." in parts:
            reason = "Ugyldig sti"
        elif info.flag_bits & 0x1:
            reason = "Krypteret – kan ikke pakkes ud"
        elif info.file_size > s.max_direct_upload_mb * MB:
            reason = f"Større end {s.max_direct_upload_mb} MB"
        else:
            try:
                parts = [filetree.clean_name(x) for x in parts]
            except HTTPException as e:
                reason = str(e.detail)
        if reason:
            skipped.append({"name": raw[:300], "reason": reason})
            continue
        entries.append((info, parts[:-1], parts[-1]))
        total += info.file_size
    if len(entries) > s.unzip_max_files:
        raise ValueError(f"Zip-filen har {len(entries)} filer – højst {s.unzip_max_files} kan pakkes ud")
    if total > s.unzip_max_mb * MB:
        raise ValueError(f"Zip-filen fylder {math.ceil(total / MB)} MB udpakket – højst {s.unzip_max_mb} MB")
    return entries, skipped


async def _principal(user_id: int) -> Principal | None:
    async with db.connection() as conn:
        user = await db.fetch_one(conn, "select id, email, phone, role, display_name from users where id = %s",
                                  (user_id,))
    if user is None:
        return None
    return Principal(session_id=0, user_id=user["id"], email=user["email"], phone=user["phone"], role=user["role"],
                     scope="full", display_name=user["display_name"], meta=RequestMeta())


async def _fail(up: dict, error: str) -> dict:
    await discard({**up, "status": "unpacking"})
    async with db.connection() as conn:
        await _finish(conn, up["id"], "failed", error=error)
    return {"failed": error}


@jobs.handler("files.unzip")
async def unzip_job(payload: dict, job: dict) -> dict:
    async with db.connection() as conn:
        up = await db.fetch_one(conn, "select * from file_uploads where id = %s", (payload["upload_id"],))
    if up is None or up["status"] != "unpacking":
        return {"skipped": "not unpacking"}
    p = await _principal(up["user_id"])
    if p is None:
        return await _fail(up, "Brugeren findes ikke længere")
    if up["admin"] and p.role != "admin":
        return await _fail(up, "Kun en administrator kan pakke ud her")
    storage = get_storage()
    base = filetree.parse(up["path"])
    result = dict(up["result"] or {"files": 0, "bytes": 0, "skipped": []})
    budget = max(30, min(300, config.settings.job_timeout_seconds - 120))
    deadline = _clock() + budget
    with tempfile.TemporaryDirectory(prefix="gaer-unzip-") as tmp:
        path = os.path.join(tmp, "upload.zip")
        await storage.download_to(up["storage_key"], path)
        try:
            zf = zipfile.ZipFile(path)
        except zipfile.BadZipFile:
            return await _fail(up, "Filen er ikke en gyldig zip-fil")
        with zf:
            try:
                entries, skipped = plan(zf)
            except ValueError as e:
                return await _fail(up, str(e))
            if up["done"] == 0:
                result["skipped"] = skipped[:200]
                result["total"] = len(entries)
            for i in range(up["done"], len(entries)):
                if i > up["done"] and _clock() > deadline:
                    # Time for a new job, so one run never comes near JOB_TIMEOUT_SECONDS.
                    async with db.connection() as conn:
                        await jobs.enqueue(conn, "files.unzip", {"upload_id": str(up["id"])}, max_attempts=3,
                                           dedupe_key=f"files.unzip:{up['id']}:{i}")
                    return {"continues_at": i, "of": len(entries)}
                info, folders, name = entries[i]
                key = None
                try:
                    loc = base
                    for folder in folders:
                        loc = loc.child(folder)
                    key = f"{filetree.prefix(loc)}/{uuid.uuid4()}"
                    with zf.open(info) as f:
                        await storage.put_stream(key, f, filetree.guess_type(name))
                    async with db.connection() as conn:
                        await filetree.register(conn, loc, name, key, info.file_size, None, p, admin=up["admin"],
                                                overwrite=up["overwrite"], via="unzip",
                                                audit_extra={"upload_id": str(up["id"])})
                        result["files"] += 1
                        result["bytes"] += info.file_size
                        await conn.execute("update file_uploads set done = %s, result = %s where id = %s",
                                           (i + 1, Jsonb(result), up["id"]))
                    continue
                except HTTPException as e:
                    reason = str(e.detail)
                except (zipfile.BadZipFile, zipfile.LargeZipFile, NotImplementedError, OSError, EOFError) as e:
                    reason = "Kunne ikke læses" if not isinstance(e, NotImplementedError) else "Ukendt komprimering"
                if key:
                    try:
                        await storage.delete(key)
                    except Exception:  # noqa: BLE001
                        pass
                if len(result["skipped"]) < 200:
                    result["skipped"].append({"name": info.filename[:300], "reason": reason})
                async with db.connection() as conn:
                    await conn.execute("update file_uploads set done = %s, result = %s where id = %s",
                                       (i + 1, Jsonb(result), up["id"]))
    try:
        await storage.delete(up["storage_key"])
    except Exception:  # noqa: BLE001
        pass
    async with db.connection() as conn:
        await _finish(conn, up["id"], "done", result=result)
        await audit(conn, "file.unzip", actor_id=up["user_id"], meta=RequestMeta(), table="file_uploads",
                    row_id=up["id"], after={"zip": up["filename"], "path": up["path"], "files": result["files"],
                                            "bytes": result["bytes"], "skipped": len(result["skipped"])},
                    **({"via": "admin"} if up["admin"] else {}))
    return {"files": result["files"], "skipped": len(result["skipped"])}


async def _unzip_dead(conn, job: dict, error: str) -> None:
    """files.unzip gave up: the upload is marked failed (the files already placed stay)."""
    up = await db.fetch_one(conn, "select * from file_uploads where id = %s and status = 'unpacking'",
                            (job["payload"].get("upload_id"),))
    if up:
        await discard({**up, "status": "unpacking"})
        await _finish(conn, up["id"], "failed", error="Udpakningen fejlede – prøv igen")


jobs.DEAD_HOOKS["files.unzip"] = _unzip_dead


# ── Housekeeping ────────────────────────────────────────────────────────────

@jobs.handler("files.uploads_cleanup")
async def uploads_cleanup(payload: dict, job: dict) -> dict:
    """Aborts uploads that were never completed (and unpacking that never ended) and removes their objects."""
    async with db.connection() as conn:
        rows = await db.fetch_all(conn, """select * from file_uploads where status in ('uploading', 'unpacking')
                                           and expires_at < now() order by expires_at limit 500""")
    for row in rows:
        await discard(row)
        async with db.connection() as conn:
            await _finish(conn, row["id"], "aborted" if row["status"] == "uploading" else "failed",
                          error=None if row["status"] == "uploading" else "Udpakningen blev ikke færdig")
    return {"aborted": len(rows)}


@jobs.handler("storage.cors")
async def storage_cors(payload: dict, job: dict) -> dict:
    """Lets the browser upload straight to the bucket from ORIGIN (CORS: PUT, and the ETag header for multipart)."""
    import asyncio
    changed = await asyncio.to_thread(get_storage().ensure_cors, config.settings.origin)
    return {"origin": config.settings.origin, "changed": changed}
