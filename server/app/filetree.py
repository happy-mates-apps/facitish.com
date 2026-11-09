"""A folder tree over the `files` table (migration 0015).

    /                       root: two folders
    /users/                 one home per user (an admin sees all, a user only their own)
    /users/<id>/a/b/x.md    a file in a user's home (files.space = 'user', files.user_id = <id>)
    /shared/a/x.md          common project files (files.space = 'shared', files.user_id is null)

`~` is short for the caller's own home (`~/noter/` = `/users/<me>/noter/`). Folders exist as rows in
`file_folders` (so an empty one can be made) and implicitly through the files in them.

Who may do what (`admin=True` is /api/admin/files and /mcp/admin; everything else is a user):
- admin: everything below /users/<id>/ and /shared/.
- user: read and write their own home; read and write /shared (writing over a shared file is allowed and audited);
  moving, renaming and deleting a shared file only if they uploaded it; deleting a shared folder only when it is empty.

Every change is audited in the same transaction (file.upload, file.write, file.move, file.delete,
file.folder_create, file.folder_delete). The routes (routes/files.py, routes/admin_files.py), the MCP tools and
the AI chat all go through this module, so the rules are the same everywhere.
"""

import mimetypes
import re
import uuid
from dataclasses import dataclass

from fastapi import HTTPException, UploadFile

from app import config, db
from app.logs import audit
from app.sessions import Principal
from app.storage import get_storage

TEXT_PREVIEW_BYTES = 512 * 1024
TEXT_TYPES = {"application/json", "application/xml", "application/javascript", "application/x-yaml", "application/yaml",
              "application/sql", "application/x-sh", "image/svg+xml"}
TEXT_EXTENSIONS = {".md", ".markdown", ".txt", ".csv", ".tsv", ".json", ".yml", ".yaml", ".xml", ".log", ".py", ".ts",
                   ".tsx", ".js", ".jsx", ".html", ".css", ".sql", ".sh", ".toml", ".ini", ".svg"}
IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml", "image/bmp"}
_BAD = re.compile(r"[\x00-\x1f\x7f\\]")
FILE_COLS = """f.id, f.space, f.user_id, f.folder, f.filename, f.content_type, f.size_bytes, f.created_at,
               f.updated_at, f.uploaded_by, f.storage_key, f.kind"""


@dataclass(frozen=True)
class Loc:
    kind: str                   # root | users | home | shared
    user_id: int | None = None  # the home's owner (kind home)
    folder: str = "/"           # inside the space: '/' or '/a/b/'

    @property
    def space(self) -> str | None:
        return {"home": "user", "shared": "shared"}.get(self.kind)

    @property
    def path(self) -> str:
        if self.kind == "root":
            return "/"
        if self.kind == "users":
            return "/users/"
        base = f"/users/{self.user_id}" if self.kind == "home" else "/shared"
        return base + self.folder

    @property
    def parent(self) -> str | None:
        if self.kind == "root":
            return None
        if self.kind == "users" or (self.kind == "shared" and self.folder == "/"):
            return "/"
        if self.kind == "home" and self.folder == "/":
            return "/users/"
        return Loc(self.kind, self.user_id, self.folder.rstrip("/").rsplit("/", 1)[0] + "/").path

    @property
    def in_space(self) -> bool:
        return self.kind in ("home", "shared")

    def child(self, name: str) -> "Loc":
        return Loc(self.kind, self.user_id, self.folder + clean_name(name) + "/")


def clean_name(name: str) -> str:
    name = (name or "").strip()
    if not name or name in (".", "..") or "/" in name or _BAD.search(name) or len(name) > 200:
        raise HTTPException(400, f"Ugyldigt navn: {name[:60]!r}" if name else "Navnet mangler")
    return name


def parse(path: str | None, *, me: int | None = None) -> Loc:
    raw = (path or "/").strip()
    if raw.startswith("~"):
        if me is None:
            raise HTTPException(400, "~ betyder dit eget hjem og kan ikke bruges her")
        raw = f"/users/{me}/" + raw[1:]
    parts = [clean_name(p) for p in raw.split("/") if p not in ("", ".")]
    if not parts:
        return Loc("root")
    if parts[0] == "users":
        if len(parts) == 1:
            return Loc("users")
        if not parts[1].isdigit():
            raise HTTPException(404, "Mappen findes ikke – et hjem hedder /users/<bruger-id>/")
        return Loc("home", int(parts[1]), _folder(parts[2:]))
    if parts[0] == "shared":
        return Loc("shared", None, _folder(parts[1:]))
    raise HTTPException(404, "Stien findes ikke – brug /users/<id>/… eller /shared/…")


def _folder(parts: list[str]) -> str:
    return "/" + "".join(p + "/" for p in parts)


def split_file(path: str, *, me: int | None = None) -> tuple[Loc, str]:
    """A file path (`/shared/a/x.md`) → (its folder, the file name)."""
    raw = (path or "").strip()
    if not raw or raw.endswith("/"):
        raise HTTPException(400, "Angiv en sti til en fil, fx /shared/projekt/noter.md")
    head, _, name = raw.rpartition("/")
    loc = parse(head or "/", me=me)
    if not loc.in_space:
        raise HTTPException(400, "Filer ligger i et hjem (/users/<id>/…) eller i /shared/…")
    return loc, clean_name(name)


def file_path(row: dict) -> str | None:
    if row.get("kind", "file") != "file":
        return None
    if row["space"] == "shared":
        return "/shared" + row["folder"] + row["filename"]
    return f"/users/{row['user_id']}" + row["folder"] + row["filename"] if row["user_id"] else None


def preview_kind(content_type: str, filename: str) -> str | None:
    ct = (content_type or "").split(";")[0].strip().lower()
    ext = ("." + filename.rsplit(".", 1)[-1].lower()) if "." in filename else ""
    if ct in IMAGE_TYPES:
        return "image"
    if ct == "application/pdf" or ext == ".pdf":
        return "pdf"
    if ct.startswith("text/") or ct in TEXT_TYPES or ext in TEXT_EXTENSIONS:
        return "text"
    return None


def guess_type(filename: str, fallback: str = "application/octet-stream") -> str:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return {"md": "text/markdown", "markdown": "text/markdown", "csv": "text/csv", "json": "application/json",
            "yml": "application/yaml", "yaml": "application/yaml"}.get(ext) or mimetypes.guess_type(filename)[0] or fallback


# ── Access ──────────────────────────────────────────────────────────────────

def _check(p: Principal, loc: Loc, admin: bool, *, write: bool = False) -> None:
    if write and not loc.in_space:
        raise HTTPException(400, "Her kan der ikke gemmes noget – vælg et hjem under /users/<id>/ eller /shared/")
    if admin or loc.kind in ("root", "users", "shared"):
        return
    if loc.user_id != p.user_id:
        raise HTTPException(404, "Mappen findes ikke")


async def _home_owner(conn, loc: Loc) -> dict | None:
    if loc.kind != "home":
        return None
    row = await db.fetch_one(conn, "select id, display_name, email, phone from users where id = %s", (loc.user_id,))
    if row is None:
        raise HTTPException(404, "Brugeren findes ikke")
    return row


def _scope(loc: Loc) -> tuple[str, list]:
    if loc.kind == "home":
        return "f.space = 'user' and f.user_id = %s and f.kind = 'file'", [loc.user_id]
    return "f.space = 'shared' and f.kind = 'file'", []


def _folder_scope(loc: Loc) -> tuple[str, list]:
    if loc.kind == "home":
        return "space = 'user' and user_id = %s", [loc.user_id]
    return "space = 'shared' and user_id is null", []


def _label(u: dict | None, admin: bool) -> str | None:
    if u is None:
        return None
    return u.get("display_name") or ((u.get("email") or u.get("phone")) if admin else None) or f"Bruger #{u['id']}"


def out(row: dict, *, admin: bool = False) -> dict:
    """A file row as the API, the chat and MCP return it."""
    data = {k: row[k] for k in ("id", "filename", "content_type", "size_bytes", "created_at", "updated_at") if k in row}
    data.update({"path": file_path(row), "space": row.get("space"), "user_id": row.get("user_id"),
                 "folder": row.get("folder"), "preview": preview_kind(row["content_type"], row["filename"]),
                 "uploaded_by": row.get("uploaded_by")})
    if "uploader_name" in row:
        data["uploaded_by_name"] = row["uploader_name"] if (admin or row.get("uploader_display")) else None
    return data


# ── Reading ─────────────────────────────────────────────────────────────────

async def list_dir(conn, loc: Loc, p: Principal, *, admin: bool, q: str | None = None) -> dict:
    _check(p, loc, admin)
    result = {"path": loc.path, "parent": loc.parent, "kind": loc.kind, "folders": [], "files": [],
              "can_write": loc.in_space}
    if loc.kind == "root":
        shared = await db.fetch_one(conn, """select count(*) as files, coalesce(sum(size_bytes), 0) as bytes
                                             from files where space = 'shared' and kind = 'file'""")
        homes = await db.fetch_one(conn, """select count(*) as files, coalesce(sum(size_bytes), 0) as bytes from files
                                            where space = 'user' and kind = 'file' and user_id is not null"""
                                   + ("" if admin else " and user_id = %s"), () if admin else (p.user_id,))
        result["folders"] = [{"name": "users", "path": "/users/", "label": "Brugere", **homes},
                             {"name": "shared", "path": "/shared/", "label": "Fælles", **shared}]
        return result
    if loc.kind == "users":
        where, params = "where (not u.impersonation_only or u.impersonation_owner_id = %s)", [p.user_id]
        if not admin:
            where, params = "where u.id = %s", [p.user_id]
        if q:
            where += " and (u.email ilike %s or u.phone ilike %s or coalesce(u.display_name, '') ilike %s)"
            params += [f"%{q.strip()}%"] * 3
        rows = await db.fetch_all(conn, f"""
            select u.id, u.display_name, u.email, u.phone, count(f.id) as files, coalesce(sum(f.size_bytes), 0) as bytes
            from users u left join files f on f.user_id = u.id and f.space = 'user' and f.kind = 'file'
            {where} group by u.id order by lower(coalesce(u.display_name, u.email, u.phone)) limit 500""", params)
        result["folders"] = [{"name": str(r["id"]), "path": f"/users/{r['id']}/", "label": _label(r, admin),
                              "user_id": r["id"], "files": r["files"], "bytes": r["bytes"]} for r in rows]
        result["can_write"] = False
        return result

    owner = await _home_owner(conn, loc)
    if owner:
        result["home"] = {"user_id": owner["id"], "label": _label(owner, admin)}
    scope, params = _scope(loc)
    fscope, fparams = _folder_scope(loc)
    sizes = await db.fetch_all(conn, f"""select f.folder, count(*) as files, sum(f.size_bytes) as bytes from files f
                                         where {scope} and starts_with(f.folder, %s) group by f.folder""",
                               params + [loc.folder])
    folders = await db.fetch_all(conn, f"select path from file_folders where {fscope} and starts_with(path, %s)",
                                 fparams + [loc.folder])
    exists = loc.folder == "/" or sizes or folders
    if not exists:
        raise HTTPException(404, "Mappen findes ikke")
    children: dict[str, dict] = {}
    for r in folders:
        rest = r["path"][len(loc.folder):]
        if rest:
            name = rest.split("/", 1)[0]
            children.setdefault(name, {"files": 0, "bytes": 0})
    for r in sizes:
        rest = r["folder"][len(loc.folder):]
        if rest:
            c = children.setdefault(rest.split("/", 1)[0], {"files": 0, "bytes": 0})
            c["files"] += r["files"]
            c["bytes"] += r["bytes"]
    result["folders"] = [{"name": n, "path": loc.child(n).path, "label": n, **c}
                         for n, c in sorted(children.items(), key=lambda kv: kv[0].lower())]
    rows = await db.fetch_all(conn, f"""
        select {FILE_COLS}, coalesce(u.display_name, u.email, u.phone) as uploader_name, u.display_name as uploader_display
        from files f left join users u on u.id = f.uploaded_by
        where {scope} and f.folder = %s order by lower(f.filename)""", params + [loc.folder])
    result["files"] = [out(r, admin=admin) for r in rows]
    return result


async def get_file(conn, file_id, p: Principal, *, admin: bool, lock: bool = False) -> dict:
    """A file the caller may read (404 otherwise). Admins may read every file, also avatars and system files."""
    try:
        fid = uuid.UUID(str(file_id))
    except ValueError:
        raise HTTPException(404, "Filen findes ikke")
    row = await db.fetch_one(conn, f"""
        select {FILE_COLS}, coalesce(u.display_name, u.email, u.phone) as uploader_name, u.display_name as uploader_display
        from files f left join users u on u.id = f.uploaded_by where f.id = %s""" + (" for update of f" if lock else ""),
        (fid,))
    if row is None:
        raise HTTPException(404, "Filen findes ikke")
    if admin:
        return row
    own = row["space"] == "user" and row["user_id"] == p.user_id
    shared = row["space"] == "shared" and row["kind"] == "file"
    if not (own or shared):
        raise HTTPException(404, "Filen findes ikke")
    return row


async def get_by_path(conn, path: str, p: Principal, *, admin: bool, lock: bool = False) -> dict:
    loc, name = split_file(path, me=p.user_id)
    _check(p, loc, admin)
    scope, params = _scope(loc)
    row = await db.fetch_one(conn, f"select f.id from files f where {scope} and f.folder = %s and f.filename = %s "
                                   "order by f.created_at desc limit 1", params + [loc.folder, name])
    if row is None:
        raise HTTPException(404, f"Filen {path} findes ikke")
    return await get_file(conn, row["id"], p, admin=admin, lock=lock)


async def read_text(row: dict, max_bytes: int = TEXT_PREVIEW_BYTES) -> dict:
    """The text of a text file (cut at max_bytes). Raises 415 for other files."""
    if preview_kind(row["content_type"], row["filename"]) != "text":
        raise HTTPException(415, "Filen er ikke en tekstfil – hent den via et link i stedet")
    data, _ = await get_storage().get(row["storage_key"])
    return {"text": data[:max_bytes].decode("utf-8", errors="replace"), "truncated": len(data) > max_bytes}


async def download_link(row: dict) -> dict:
    url = await get_storage().download_url(row["storage_key"], row["filename"])
    return {"url": url, "expires_in": config.settings.download_link_seconds}


# ── Writing ─────────────────────────────────────────────────────────────────

async def _ensure_folders(conn, loc: Loc, actor_id: int | None) -> list[str]:
    """Creates loc's folder and every folder above it. Returns the paths that were new."""
    parts = [x for x in loc.folder.split("/") if x]
    new = []
    for i in range(1, len(parts) + 1):
        path = "/" + "".join(x + "/" for x in parts[:i])
        row = await db.fetch_one(conn, """
            insert into file_folders (space, user_id, path, created_by) values (%s, %s, %s, %s)
            on conflict (space, coalesce(user_id, 0), path) do nothing returning id""",
            (loc.space, loc.user_id, path, actor_id))
        if row:
            new.append(path)
    return new


async def make_folder(conn, loc: Loc, p: Principal, *, admin: bool, via: str | None = None) -> dict:
    _check(p, loc, admin, write=True)
    if loc.folder == "/":
        raise HTTPException(400, "Angiv navnet på den nye mappe")
    await _home_owner(conn, loc)
    new = await _ensure_folders(conn, loc, p.user_id)
    if new:
        await audit(conn, "file.folder_create", actor_id=p.user_id, meta=p.meta, table="file_folders", row_id=loc.path,
                    after={"path": loc.path, "created": new}, **({"via": via} if via else {}))
    return {"path": loc.path, "created": bool(new)}


def _unique_name(name: str, taken: set[str]) -> str:
    if name not in taken:
        return name
    stem, dot, ext = name.rpartition(".") if "." in name.lstrip(".") else (name, "", "")
    for i in range(2, 1000):
        candidate = f"{stem} ({i}){dot}{ext}"
        if candidate not in taken:
            return candidate
    raise HTTPException(409, "Der er for mange filer med det navn")


async def write(conn, loc: Loc, filename: str, data: bytes, content_type: str | None, p: Principal, *, admin: bool,
                overwrite: bool = False, via: str | None = None) -> dict:
    """Stores bytes at loc/filename. An existing file with that name is replaced when overwrite is true (it keeps
    its id and uploader; who wrote it is in the audit log), else the new file gets a free name ("x (2).md")."""
    _check(p, loc, admin, write=True)
    await _home_owner(conn, loc)
    filename = clean_name(filename)
    limit = config.settings.max_upload_mb * 1024 * 1024
    if len(data) > limit:
        raise HTTPException(413, f"Filen er større end {config.settings.max_upload_mb} MB")
    content_type = content_type or guess_type(filename)
    extra = {"via": via} if via else {}
    scope, params = _scope(loc)
    same = await db.fetch_all(conn, f"""select f.id, f.filename, f.storage_key, f.size_bytes from files f
                                        where {scope} and f.folder = %s for update""", params + [loc.folder])
    existing = next((r for r in same if r["filename"] == filename), None)
    storage = get_storage()
    if existing and overwrite:
        key = f"{_prefix(loc)}/{uuid.uuid4()}"
        await storage.put(key, data, content_type)
        row = await db.fetch_one(conn, f"""
            update files set storage_key = %s, content_type = %s, size_bytes = %s, updated_at = now()
            where id = %s returning {FILE_COLS.replace('f.', '')}""",
            (key, content_type, len(data), existing["id"]))
        await audit(conn, "file.write", actor_id=p.user_id, meta=p.meta, table="files", row_id=existing["id"],
                    before={"size_bytes": existing["size_bytes"]},
                    after={"path": file_path(row), "size_bytes": len(data), "content_type": content_type}, **extra)
        try:
            await storage.delete(existing["storage_key"])
        except Exception:
            pass  # the row points at the new object; an orphan is harmless
        return row
    filename = _unique_name(filename, {r["filename"] for r in same})
    if loc.folder != "/":
        await _ensure_folders(conn, loc, p.user_id)
    file_id = uuid.uuid4()
    key = f"{_prefix(loc)}/{file_id}"
    await storage.put(key, data, content_type)
    row = await db.fetch_one(conn, f"""
        insert into files (id, user_id, storage_key, filename, content_type, size_bytes, kind, space, folder, uploaded_by)
        values (%s, %s, %s, %s, %s, %s, 'file', %s, %s, %s) returning {FILE_COLS.replace('f.', '')}""",
        (file_id, loc.user_id, key, filename, content_type, len(data), loc.space, loc.folder, p.user_id))
    await audit(conn, "file.upload", actor_id=p.user_id, meta=p.meta, table="files", row_id=file_id,
                after={"filename": filename, "size_bytes": len(data), "content_type": content_type,
                       "user_id": loc.user_id, "kind": "file", "path": file_path(row)}, **extra)
    return row


def _prefix(loc: Loc) -> str:
    return f"users/{loc.user_id}" if loc.kind == "home" else "shared"


async def upload(conn, loc: Loc, file: UploadFile, p: Principal, *, admin: bool, overwrite: bool = False) -> dict:
    limit = config.settings.max_upload_mb * 1024 * 1024
    data = await file.read(limit + 1)
    name = (file.filename or "fil").replace("\\", "/").rsplit("/", 1)[-1][:200] or "fil"
    return await write(conn, loc, name, data, file.content_type, p, admin=admin, overwrite=overwrite)


def _may_change(row: dict, p: Principal, admin: bool) -> None:
    if admin:
        return
    if row["space"] == "shared" and row["uploaded_by"] != p.user_id:
        raise HTTPException(403, "Kun den, der har lagt filen i /shared, eller en administrator kan flytte eller slette den")


async def move(conn, row: dict, p: Principal, *, admin: bool, folder: str | None = None, filename: str | None = None,
               via: str | None = None) -> dict:
    """Renames and/or moves a tree file (also between a home and /shared)."""
    if row["kind"] != "file" or file_path(row) is None:
        raise HTTPException(400, "Kun filer i mappetræet kan flyttes")
    _may_change(row, p, admin)
    dest = parse(folder, me=p.user_id) if folder else parse(file_path(row).rsplit("/", 1)[0] + "/")
    _check(p, dest, admin, write=True)
    await _home_owner(conn, dest)
    name = clean_name(filename) if filename else row["filename"]
    scope, params = _scope(dest)
    clash = await db.fetch_one(conn, f"select f.id from files f where {scope} and f.folder = %s and f.filename = %s and f.id <> %s",
                               params + [dest.folder, name, row["id"]])
    if clash:
        raise HTTPException(409, f"Der findes allerede en fil med navnet {name} i {dest.path}")
    if dest.folder != "/":
        await _ensure_folders(conn, dest, p.user_id)
    before = {"path": file_path(row)}
    new = await db.fetch_one(conn, f"""update files set space = %s, user_id = %s, folder = %s, filename = %s, updated_at = now()
                                       where id = %s returning {FILE_COLS.replace('f.', '')}""",
                             (dest.space, dest.user_id, dest.folder, name, row["id"]))
    await audit(conn, "file.move", actor_id=p.user_id, meta=p.meta, table="files", row_id=row["id"],
                before=before, after={"path": file_path(new)}, **({"via": via} if via else {}))
    return new


async def delete(conn, row: dict, p: Principal, *, admin: bool, via: str | None = None) -> None:
    _may_change(row, p, admin)
    await conn.execute("delete from files where id = %s", (row["id"],))
    await audit(conn, "file.delete", actor_id=p.user_id, meta=p.meta, table="files", row_id=row["id"],
                before={"filename": row["filename"], "size_bytes": row["size_bytes"], "user_id": row["user_id"],
                        "path": file_path(row)}, **({"via": via} if via else {}))
    try:
        await get_storage().delete(row["storage_key"])
    except Exception:
        pass


async def folder_contents(conn, loc: Loc) -> dict:
    scope, params = _scope(loc)
    fscope, fparams = _folder_scope(loc)
    files = await db.fetch_one(conn, f"""select count(*) as files, coalesce(sum(f.size_bytes), 0) as bytes from files f
                                          where {scope} and starts_with(f.folder, %s)""", params + [loc.folder])
    folders = await db.fetch_one(conn, f"select count(*) as n from file_folders where {fscope} and starts_with(path, %s)",
                                 fparams + [loc.folder])
    return {"files": files["files"], "bytes": files["bytes"], "folders": folders["n"]}


async def delete_folder(conn, loc: Loc, p: Principal, *, admin: bool, via: str | None = None) -> dict:
    """Deletes a folder and everything in it. A user may only delete an empty folder in /shared."""
    _check(p, loc, admin, write=True)
    if loc.folder == "/":
        raise HTTPException(400, "Et hjem eller /shared kan ikke slettes – slet mapperne og filerne i det")
    counts = await folder_contents(conn, loc)
    if counts["files"] == 0 and counts["folders"] == 0:
        raise HTTPException(404, "Mappen findes ikke")
    if not admin and loc.kind == "shared" and counts["files"]:
        raise HTTPException(403, "En mappe i /shared skal være tom, før du kan slette den")
    scope, params = _scope(loc)
    fscope, fparams = _folder_scope(loc)
    gone = await db.fetch_all(conn, f"""delete from files f where {scope} and starts_with(f.folder, %s)
                                        returning f.id, f.storage_key""", params + [loc.folder])
    await conn.execute(f"delete from file_folders where {fscope} and starts_with(path, %s)", fparams + [loc.folder])
    await audit(conn, "file.folder_delete", actor_id=p.user_id, meta=p.meta, table="file_folders", row_id=loc.path,
                before={"path": loc.path, **counts}, file_ids=[str(r["id"]) for r in gone[:200]],
                **({"via": via} if via else {}))
    for r in gone:
        try:
            await get_storage().delete(r["storage_key"])
        except Exception:
            pass
    return {"path": loc.path, **counts}


async def totals(conn) -> dict:
    return await db.fetch_one(conn, """
        select count(*) as files, coalesce(sum(size_bytes), 0) as bytes,
               count(*) filter (where space = 'shared') as shared_files,
               coalesce(sum(size_bytes) filter (where space = 'shared'), 0) as shared_bytes,
               count(*) filter (where space = 'user' and kind = 'file' and user_id is not null) as home_files,
               coalesce(sum(size_bytes) filter (where space = 'user' and kind = 'file' and user_id is not null), 0) as home_bytes,
               count(*) filter (where kind <> 'file' or user_id is null and space = 'user') as system_files
        from files""")
