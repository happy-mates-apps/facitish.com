"""The review panel: notes about pages, test sessions as an archetype, and a zip for the developer.

Only logged-in users (current_user). Each user sees and changes their own notes and sessions; counts per
feature are shared, so /features in the panel shows how much feedback a feature has had. Screenshots and audio
are files of kind 'review' (Object Storage), linked to a note in review_attachments.
"""

import io
import json
import re
import uuid
import zipfile
from datetime import datetime

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator

from app import db, webhooks
from app.logs import audit, changed
from app.routes.features import user_level
from app.routes.files import delete_file, save_upload
from app.sessions import Principal, current_user
from app.storage import get_storage

router = APIRouter(prefix="/api/review", tags=["review"])

FEATURE_KEY = r"^[a-z0-9][a-z0-9-]*$"
IMPRESSIONS = "^(good|meh|bad)$"
TASK_STATUS = "^(open|done|stuck|skipped)$"
MAX_TARGET_JSON = 4000
MAX_PAGES = 500
MAX_TASKS = 30

IMAGE_TYPES = {b"\x89PNG\r\n\x1a\n": "image/png", b"\xff\xd8\xff": "image/jpeg"}
EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "audio/webm": "webm",
              "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/wav": "wav"}


def _sniff(kind: str, data: bytes) -> str | None:
    """The content type from the bytes themselves, never from the browser."""
    if kind == "screenshot":
        for magic, content_type in IMAGE_TYPES.items():
            if data.startswith(magic):
                return content_type
        if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            return "image/webp"
        return None
    if data.startswith(b"\x1a\x45\xdf\xa3"):
        return "audio/webm"
    if data.startswith(b"OggS"):
        return "audio/ogg"
    if data[4:8] == b"ftyp":
        return "audio/mp4"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio/wav"
    return None


def _clean_path(value: str) -> str:
    value = value.strip()
    if not value.startswith("/") or value.startswith("//"):
        raise ValueError("Stien skal starte med /")
    return value


# ── Features with feedback counts ───────────────────────────────────────────

@router.get("/features")
async def review_features(p: Principal = Depends(current_user)):
    """Every feature with its ring and how much feedback it has had (from everyone, and from you)."""
    async with db.connection() as conn:
        level = await user_level(conn, p.user_id)
        rows = await db.fetch_all(conn, """
            select f.key, f.title, f.description, f.area, f.ring,
                   count(r.id) as feedback, count(r.id) filter (where r.user_id = %s) as mine
            from features f left join review_feedback r on r.feature_key = f.key
            group by f.key order by f.ring, f.key""", (p.user_id,))
    return {"level": level, "features": rows}


# ── Notes (feedback) ────────────────────────────────────────────────────────

class FeedbackIn(BaseModel):
    path: str = Field(min_length=1, max_length=500)
    body: str = Field(default="", max_length=20_000)
    impression: str | None = Field(default=None, pattern=IMPRESSIONS)
    feature_key: str | None = Field(default=None, pattern=FEATURE_KEY, max_length=60)
    ring: int | None = Field(default=None, ge=1, le=4)
    target: dict | None = None
    session_id: int | None = None
    task_id: str | None = Field(default=None, max_length=60)

    @field_validator("path")
    @classmethod
    def _path(cls, value: str) -> str:
        return _clean_path(value)

    @field_validator("target")
    @classmethod
    def _small_target(cls, value: dict | None) -> dict | None:
        if value is not None and len(json.dumps(value)) > MAX_TARGET_JSON:
            raise ValueError("Målet er for stort")
        return value


class FeedbackPatch(BaseModel):
    body: str | None = Field(default=None, max_length=20_000)
    impression: str | None = Field(default=None, pattern="^(good|meh|bad|)$")  # "" clears it


FEEDBACK_COLUMNS = ("id, session_id, task_id, path, body, impression, feature_key, ring, target, "
                    "created_at, updated_at")


async def _with_attachments(conn, items: list[dict]) -> list[dict]:
    ids = [i["id"] for i in items]
    attachments = await db.fetch_all(conn, """
        select a.feedback_id, a.kind, f.id, f.content_type, f.size_bytes, f.created_at
        from review_attachments a join files f on f.id = a.file_id
        where a.feedback_id = any(%s) order by f.created_at""", (ids,)) if ids else []
    by_note: dict[int, list] = {}
    for a in attachments:
        note = a.pop("feedback_id")
        by_note.setdefault(note, []).append({**a, "url": f"/api/review/attachments/{a['id']}"})
    for i in items:
        i["attachments"] = by_note.get(i["id"], [])
    return items


@router.get("/feedback")
async def list_feedback(path: str | None = None, session_id: int | None = None, limit: int = 200,
                        p: Principal = Depends(current_user)):
    where, params = ["user_id = %s"], [p.user_id]
    if path:
        where.append("path = %s")
        params.append(path)
    if session_id is not None:
        where.append("session_id = %s")
        params.append(session_id)
    async with db.connection() as conn:
        items = await db.fetch_all(conn, f"""
            select {FEEDBACK_COLUMNS} from review_feedback where {' and '.join(where)}
            order by created_at desc limit %s""", params + [max(1, min(limit, 1000))])
        return await _with_attachments(conn, items)


async def _own_session(conn, session_id: int, p: Principal, *, lock: bool = False) -> dict:
    row = await db.fetch_one(conn, "select * from review_sessions where id = %s and user_id = %s"
                             + (" for update" if lock else ""), (session_id, p.user_id))
    if row is None:
        raise HTTPException(404, "Sessionen findes ikke")
    return row


@router.post("/feedback", status_code=201)
async def create_feedback(body: FeedbackIn, p: Principal = Depends(current_user)):
    if not body.body.strip() and body.impression is None and body.target is None:
        raise HTTPException(400, "Skriv en note, vælg et indtryk eller peg på noget")
    async with db.connection() as conn:
        if body.session_id is not None:
            session = await _own_session(conn, body.session_id, p)
            if session["ended_at"] is not None:
                raise HTTPException(409, "Sessionen er afsluttet")
        row = await db.fetch_one(conn, f"""
            insert into review_feedback (user_id, session_id, task_id, path, body, impression, feature_key, ring, target)
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s) returning {FEEDBACK_COLUMNS}""",
            (p.user_id, body.session_id, body.task_id, body.path, body.body.strip(), body.impression,
             body.feature_key, body.ring, json.dumps(body.target) if body.target is not None else None))
        await audit(conn, "create", actor_id=p.user_id, meta=p.meta, table="review_feedback", row_id=row["id"],
                    after={"path": body.path, "chars": len(row["body"]), "impression": body.impression,
                           "feature_key": body.feature_key, "session_id": body.session_id})
        await webhooks.emit(conn, "review.feedback.created", {
            "id": row["id"], "path": body.path, "feature_key": body.feature_key, "impression": body.impression,
            "session_id": body.session_id})
    return {**row, "attachments": []}


@router.patch("/feedback/{feedback_id}")
async def update_feedback(feedback_id: int, body: FeedbackPatch, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        before = await db.fetch_one(conn, """select body, impression from review_feedback
                                             where id = %s and user_id = %s for update""", (feedback_id, p.user_id))
        if before is None:
            raise HTTPException(404, "Noten findes ikke")
        after = {"body": before["body"] if body.body is None else body.body.strip(),
                 "impression": before["impression"] if body.impression is None else (body.impression or None)}
        await conn.execute("update review_feedback set body = %s, impression = %s, updated_at = now() where id = %s",
                           (after["body"], after["impression"], feedback_id))
        b, a = changed(before, after)
        if "body" in a:  # log the length, not the text
            b["body"], a["body"] = len(b["body"]), len(a["body"])
        if a:
            await audit(conn, "update", actor_id=p.user_id, meta=p.meta, table="review_feedback", row_id=feedback_id,
                        before=b, after=a)
    return {"ok": True}


async def _delete_notes(conn, where: str, params: tuple, p: Principal) -> int:
    """Deletes notes and their files (storage + file.delete in the audit log). Returns the number of notes."""
    files = await db.fetch_all(conn, f"""
        select a.file_id from review_attachments a join review_feedback r on r.id = a.feedback_id
        where {where}""", params)
    for f in files:
        await delete_file(conn, f["file_id"], p, owner_id=p.user_id)
    rows = await db.fetch_all(conn, f"delete from review_feedback r where {where} returning id, path", params)
    for row in rows:
        await audit(conn, "delete", actor_id=p.user_id, meta=p.meta, table="review_feedback", row_id=row["id"],
                    before={"path": row["path"]})
    return len(rows)


@router.delete("/feedback/{feedback_id}")
async def delete_feedback(feedback_id: int, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        if not await _delete_notes(conn, "r.id = %s and r.user_id = %s", (feedback_id, p.user_id), p):
            raise HTTPException(404, "Noten findes ikke")
    return {"ok": True}


# ── Screenshots and audio ───────────────────────────────────────────────────

@router.post("/feedback/{feedback_id}/attachments", status_code=201)
async def add_attachment(feedback_id: int, file: UploadFile, kind: str = Form(pattern="^(screenshot|audio)$"),
                         p: Principal = Depends(current_user)):
    head = await file.read(16)
    content_type = _sniff(kind, head)
    if content_type is None:
        raise HTTPException(400, "Billeder skal være PNG, JPEG eller WebP; lyd WebM, Ogg, MP4 eller WAV")
    await file.seek(0)
    file.filename = f"{kind}-{feedback_id}.{EXTENSIONS[content_type]}"
    async with db.connection() as conn:
        if not await db.fetch_one(conn, "select 1 from review_feedback where id = %s and user_id = %s for update",
                                  (feedback_id, p.user_id)):
            raise HTTPException(404, "Noten findes ikke")
        row = await save_upload(conn, file, owner_id=p.user_id, actor=p, prefix=f"review/{p.user_id}",
                                content_type=content_type, kind="review")
        await conn.execute("insert into review_attachments (file_id, feedback_id, kind) values (%s, %s, %s)",
                           (row["id"], feedback_id, kind))
        await audit(conn, "create", actor_id=p.user_id, meta=p.meta, table="review_attachments", row_id=row["id"],
                    after={"feedback_id": feedback_id, "kind": kind, "size_bytes": row["size_bytes"]})
    return {"id": row["id"], "kind": kind, "content_type": content_type, "size_bytes": row["size_bytes"],
            "created_at": row["created_at"], "url": f"/api/review/attachments/{row['id']}"}


async def _attachment(conn, file_id: uuid.UUID, p: Principal) -> dict:
    row = await db.fetch_one(conn, """
        select f.storage_key, f.content_type, f.user_id, a.feedback_id, a.kind
        from review_attachments a join files f on f.id = a.file_id where a.file_id = %s""", (file_id,))
    if row is None or (row["user_id"] != p.user_id and not p.is_admin):
        raise HTTPException(404, "Ikke fundet")
    return row


@router.get("/attachments/{file_id}")
async def get_attachment(file_id: uuid.UUID, p: Principal = Depends(current_user)):
    """Served by the server, so <img> and <audio> work under the CSP and without public links."""
    async with db.connection() as conn:
        row = await _attachment(conn, file_id, p)
    data, _ = await get_storage().get(row["storage_key"])
    return Response(data, media_type=row["content_type"],
                    headers={"Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff"})


@router.delete("/attachments/{file_id}")
async def delete_attachment(file_id: uuid.UUID, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        row = await _attachment(conn, file_id, p)
        if row["user_id"] != p.user_id:
            raise HTTPException(404, "Ikke fundet")
        await delete_file(conn, file_id, p, owner_id=p.user_id)  # cascades to review_attachments
        await audit(conn, "delete", actor_id=p.user_id, meta=p.meta, table="review_attachments", row_id=file_id,
                    before={"feedback_id": row["feedback_id"], "kind": row["kind"]})
    return {"ok": True}


# ── Sessions ────────────────────────────────────────────────────────────────

class Persona(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    who: str = Field(default="", max_length=500)
    wants: str = Field(default="", max_length=500)
    worries: str = Field(default="", max_length=500)
    ring: int | None = Field(default=None, ge=1, le=4)


class TaskIn(BaseModel):
    id: str = Field(min_length=1, max_length=60)
    title: str = Field(min_length=1, max_length=300)


class SessionIn(BaseModel):
    persona_key: str = Field(default="", max_length=60)
    persona: Persona
    script_key: str = Field(default="", max_length=60)
    script_title: str = Field(default="", max_length=200)
    ring: int | None = Field(default=None, ge=1, le=4)
    tasks: list[TaskIn] = Field(default_factory=list, max_length=MAX_TASKS)


class TaskStatus(BaseModel):
    id: str = Field(min_length=1, max_length=60)
    status: str = Field(pattern=TASK_STATUS)


class SessionPatch(BaseModel):
    tasks: list[TaskStatus] | None = Field(default=None, max_length=MAX_TASKS)
    notes: str | None = Field(default=None, max_length=20_000)
    ring: int | None = Field(default=None, ge=1, le=4)
    end: bool = False


class VisitIn(BaseModel):
    path: str = Field(min_length=1, max_length=500)

    @field_validator("path")
    @classmethod
    def _path(cls, value: str) -> str:
        return _clean_path(value)


SESSION_COLUMNS = ("s.id, s.persona_key, s.persona, s.script_key, s.script_title, s.ring, s.tasks, s.pages, s.notes, "
                   "s.started_at, s.ended_at")


async def _session_out(conn, session_id: int) -> dict:
    return await db.fetch_one(conn, f"""
        select {SESSION_COLUMNS}, (select count(*) from review_feedback r where r.session_id = s.id) as feedback
        from review_sessions s where s.id = %s""", (session_id,))


@router.get("/sessions")
async def list_sessions(p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        return await db.fetch_all(conn, f"""
            select {SESSION_COLUMNS}, (select count(*) from review_feedback r where r.session_id = s.id) as feedback
            from review_sessions s where s.user_id = %s order by s.started_at desc limit 100""", (p.user_id,))


async def _end_session(conn, session_id: int, p: Principal) -> None:
    await conn.execute("update review_sessions set ended_at = now() where id = %s", (session_id,))
    await audit(conn, "update", actor_id=p.user_id, meta=p.meta, table="review_sessions", row_id=session_id,
                before={"ended": False}, after={"ended": True})


@router.post("/sessions", status_code=201)
async def start_session(body: SessionIn, p: Principal = Depends(current_user)):
    """Starts a session. A session that is still running is ended first: one at a time."""
    tasks = [{"id": t.id, "title": t.title, "status": "open"} for t in body.tasks]
    if len({t["id"] for t in tasks}) != len(tasks):
        raise HTTPException(400, "Opgaverne skal have hver sit id")
    async with db.connection() as conn:
        running = await db.fetch_one(conn, "select id from review_sessions where user_id = %s and ended_at is null"
                                           " for update", (p.user_id,))
        if running:
            await _end_session(conn, running["id"], p)
        row = await db.fetch_one(conn, """
            insert into review_sessions (user_id, persona_key, persona, script_key, script_title, ring, tasks)
            values (%s, %s, %s, %s, %s, %s, %s) returning id""",
            (p.user_id, body.persona_key, body.persona.model_dump_json(), body.script_key, body.script_title.strip(),
             body.ring, json.dumps(tasks)))
        await audit(conn, "create", actor_id=p.user_id, meta=p.meta, table="review_sessions", row_id=row["id"],
                    after={"persona_key": body.persona_key, "script_key": body.script_key, "tasks": len(tasks),
                           "ring": body.ring})
        return await _session_out(conn, row["id"])


@router.patch("/sessions/{session_id}")
async def update_session(session_id: int, body: SessionPatch, p: Principal = Depends(current_user)):
    async with db.connection() as conn:
        session = await _own_session(conn, session_id, p, lock=True)
        if session["ended_at"] is not None and (body.tasks is not None or body.ring is not None or body.end):
            raise HTTPException(409, "Sessionen er afsluttet")
        tasks = session["tasks"]
        if body.tasks is not None:
            status = {t.id: t.status for t in body.tasks}
            unknown = set(status) - {t["id"] for t in tasks}
            if unknown:
                raise HTTPException(400, "Ukendt opgave")
            tasks = [{**t, "status": status.get(t["id"], t["status"])} for t in tasks]
        before = {"tasks": {t["id"]: t["status"] for t in session["tasks"]}, "notes": len(session["notes"]),
                  "ring": session["ring"]}
        after = {"tasks": {t["id"]: t["status"] for t in tasks},
                 "notes": len(body.notes) if body.notes is not None else before["notes"],
                 "ring": body.ring if body.ring is not None else session["ring"]}
        await conn.execute("update review_sessions set tasks = %s, notes = %s, ring = %s where id = %s",
                           (json.dumps(tasks), body.notes if body.notes is not None else session["notes"],
                            after["ring"], session_id))
        b, a = changed(before, after)
        if a:
            await audit(conn, "update", actor_id=p.user_id, meta=p.meta, table="review_sessions", row_id=session_id,
                        before=b, after=a)
        if body.end:
            await _end_session(conn, session_id, p)
            await webhooks.emit(conn, "review.session.ended", {
                "id": session_id, "persona_key": session["persona_key"], "script_key": session["script_key"],
                "tasks": {t["id"]: t["status"] for t in tasks}})
        return await _session_out(conn, session_id)


@router.post("/sessions/{session_id}/visit")
async def visit(session_id: int, body: VisitIn, p: Principal = Depends(current_user)):
    """A page seen during the session. The same page twice in a row counts once."""
    async with db.connection() as conn:
        session = await _own_session(conn, session_id, p, lock=True)
        if session["ended_at"] is not None:
            raise HTTPException(409, "Sessionen er afsluttet")
        pages = session["pages"]
        if (pages and pages[-1]["path"] == body.path) or len(pages) >= MAX_PAGES:
            return {"pages": len(pages)}
        pages.append({"path": body.path, "at": datetime.now().astimezone().isoformat()})
        await conn.execute("update review_sessions set pages = %s where id = %s", (json.dumps(pages), session_id))
        await audit(conn, "update", actor_id=p.user_id, meta=p.meta, table="review_sessions", row_id=session_id,
                    after={"pages": len(pages), "path": body.path})
    return {"pages": len(pages)}


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: int, p: Principal = Depends(current_user)):
    """Deletes the session with its notes, screenshots and audio."""
    async with db.connection() as conn:
        session = await _own_session(conn, session_id, p, lock=True)
        notes = await _delete_notes(conn, "r.session_id = %s and r.user_id = %s", (session_id, p.user_id), p)
        await conn.execute("delete from review_sessions where id = %s", (session_id,))
        await audit(conn, "delete", actor_id=p.user_id, meta=p.meta, table="review_sessions", row_id=session_id,
                    before={"persona_key": session["persona_key"], "script_key": session["script_key"]}, notes=notes)
    return {"ok": True}


# ── Zip for the developer ───────────────────────────────────────────────────

STATUS_TEXT = {"open": "ikke afklaret", "done": "gennemført", "stuck": "gået i stå", "skipped": "sprunget over"}
IMPRESSION_TEXT = {"good": "Godt", "meh": "Så som så", "bad": "Dårligt"}


def _when(value) -> str:
    return value.astimezone().strftime("%d.%m.%Y %H:%M") if value else "–"


def _target_text(target: dict | None) -> str:
    if not target:
        return ""
    if target.get("kind") == "element":
        return f" · element `{target.get('selector', '')}`"
    if target.get("kind") == "area":
        return f" · område {target.get('w')}×{target.get('h')} px ved ({target.get('x')}, {target.get('y')})"
    return ""


def _readme(user: str, sessions: list[dict], notes: list[dict]) -> str:
    out = [f"# Review fra {user}", "", f"Pakket {datetime.now().astimezone():%d.%m.%Y %H:%M}.", ""]
    by_session: dict[int | None, list] = {}
    for n in notes:
        by_session.setdefault(n["session_id"], []).append(n)
    for s in sessions:
        persona = s["persona"] or {}
        out += [f"## {persona.get('name') or 'Session'} · {s['script_title'] or 'Fri gennemgang'}", ""]
        for label, key in (("Hvem", "who"), ("Vil", "wants"), ("Bekymret for", "worries")):
            if persona.get(key):
                out.append(f"- **{label}:** {persona[key]}")
        out += [f"- **Ring:** {s['ring'] or '–'}", f"- **Start:** {_when(s['started_at'])}",
                f"- **Slut:** {_when(s['ended_at'])}", f"- **Sider:** {len(s['pages'])}", ""]
        if s["tasks"]:
            out += ["### Opgaver", ""]
            out += [f"- [{'x' if t['status'] == 'done' else ' '}] {t['title']} ({STATUS_TEXT[t['status']]})"
                    for t in s["tasks"]]
            out.append("")
        if s["notes"]:
            out += ["### Noter", "", s["notes"], ""]
        out += _note_lines(by_session.get(s["id"], []))
    loose = by_session.get(None, [])
    if loose:
        out += ["## Noter uden session", ""] + _note_lines(loose)
    return "\n".join(out) + "\n"


def _note_lines(notes: list[dict]) -> list[str]:
    if not notes:
        return []
    out = ["### Feedback", ""]
    for n in notes:
        head = f"- **{n['path']}**"
        if n["impression"]:
            head += f" · {IMPRESSION_TEXT[n['impression']]}"
        if n["feature_key"]:
            head += f" · feature `{n['feature_key']}`"
        head += _target_text(n["target"])
        out.append(head)
        if n["body"]:
            out += [f"  {line}" for line in n["body"].splitlines()]
        for a in n["attachments"]:
            out.append(f"  - {a['kind']}: `{a['zip_path']}`")
    out.append("")
    return out


def _json(value) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, default=str)


async def _zip(p: Principal, session_id: int | None) -> bytes:
    async with db.connection() as conn:
        if session_id is not None:
            await _own_session(conn, session_id, p)
            sessions = await db.fetch_all(conn, f"select {SESSION_COLUMNS} from review_sessions s where s.id = %s",
                                          (session_id,))
            notes = await db.fetch_all(conn, f"""select {FEEDBACK_COLUMNS} from review_feedback
                                                 where session_id = %s order by created_at""", (session_id,))
        else:
            sessions = await db.fetch_all(conn, f"""select {SESSION_COLUMNS} from review_sessions s
                                                    where s.user_id = %s order by s.started_at""", (p.user_id,))
            notes = await db.fetch_all(conn, f"""select {FEEDBACK_COLUMNS} from review_feedback
                                                 where user_id = %s order by created_at""", (p.user_id,))
        notes = await _with_attachments(conn, notes)
        keys = {r["id"]: r["storage_key"] for r in await db.fetch_all(conn, """
            select f.id, f.storage_key from files f join review_attachments a on a.file_id = f.id
            join review_feedback r on r.id = a.feedback_id where r.user_id = %s""", (p.user_id,))}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for n in notes:
            for i, a in enumerate(n["attachments"], 1):
                folder = "screenshots" if a["kind"] == "screenshot" else "audio"
                a["zip_path"] = f"{folder}/note-{n['id']}-{i}.{EXTENSIONS.get(a['content_type'], 'bin')}"
                try:
                    content, _ = await get_storage().get(keys[a["id"]])
                except Exception:  # a missing object must not block the rest of the zip
                    a["zip_path"] += " (mangler)"
                    continue
                z.writestr(a["zip_path"], content)
        z.writestr("README.md", _readme(p.display_name or p.contact or f"bruger {p.user_id}", sessions, notes))
        z.writestr("session.json", _json(sessions[0] if session_id is not None else sessions))
        z.writestr("feedback.json", _json(notes))
    return buf.getvalue()


def _zip_response(data: bytes, name: str) -> Response:
    return Response(data, media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.get("/sessions/{session_id}/zip")
async def session_zip(session_id: int, p: Principal = Depends(current_user)):
    return _zip_response(await _zip(p, session_id), f"review-session-{session_id}.zip")


@router.get("/export.zip")
async def export_zip(p: Principal = Depends(current_user)):
    """„Zip alt“: every session and note of yours in one file."""
    slug = re.sub(r"[^a-z0-9]+", "-", (p.display_name or "review").lower()).strip("-") or "review"
    return _zip_response(await _zip(p, None), f"review-{slug}-{datetime.now():%Y%m%d}.zip")

