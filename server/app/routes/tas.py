"""TAS — the Terminal Assistance Simulator (app/tas.py, specs/tas/README.md).

Pages
  /w/                    the simulator for everyone, when the setting web_front is "tas" (routes/web.py)
  /w/tas/backoffice      the same simulator with the Admin Portal, framed by the app's /backoffice page
  /w/tas/env.js          who is looking (signed in, editor, AI) — per request, never cached
  /w/tas/<file>.js       the simulator's scripts (web_static/tas/)

API (/api/tas, used by web_static/tas/gaer.js in place of claude.ai's window.claude)
  GET    /rev                         a fingerprint per readable collection, for polling
  GET    /docs/{col}                  all documents of a collection
  GET    /docs/{col}/{id}             one document
  PUT    /docs/{col}/{id}             replace (editors)          — audited
  PATCH  /docs/{col}/{id}             merge top-level fields (editors) — audited
  DELETE /docs/{col}/{id}             delete (editors)           — audited
  POST   /assets                      upload an image (editors)  — audited
  GET    /assets/{id}                 an image (everyone: the published accessories use them)
  POST   /ai                          {prompt} → {result}: the simulator's sample.json, for signed-in users
  POST   /profiles                    {ids} → names of the people behind updatedBy/publishedBy (editors)
"""

import json
import os
import secrets

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response
from pydantic import BaseModel, Field

from app import ai, consumption, db, events, killswitch, mfa, tas
from app.logs import audit
from app.sessions import Principal, current_user, optional_principal

router = APIRouter(tags=["tas"])

STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "web_static", "tas")
SCRIPTS = {"gaer.js", "mark.js", "soon.js", "models.js", "lane3600.js", "engine.js", "assistant.js", "app.js"}


async def require_editor(principal: Principal = Depends(current_user)) -> Principal:
    """The editor rule of app/tas.py, with the same answers as /admin when the second factor is missing."""
    if not tas.has_editor_role(principal):
        raise HTTPException(403, "Kræver admin-rollen Fuld adgang eller Indhold")
    if not tas.can_edit(principal):
        async with db.connection() as conn:
            if (await mfa.factors(conn, principal.user_id))["total"]:
                raise mfa.mfa_error("mfa_required", "Bekræft med din passkey, sikkerhedsnøgle eller godkendelsesapp")
            raise mfa.mfa_error("mfa_setup_required", "Redigering kræver en passkey, sikkerhedsnøgle eller godkendelsesapp")
    return principal


def _check(collection: str, doc_id: str | None = None) -> None:
    if collection not in tas.COLLECTIONS:
        raise HTTPException(404, "Ukendt samling")
    if doc_id is not None and not tas.valid_id(doc_id):
        raise HTTPException(400, "Ugyldigt dokument-id")


# ── Pages ──────────────────────────────────────────────────────────────────

_html: tuple[float, str] | None = None


def page_html(mode: str) -> str:
    """index.html of the simulator for /w/ ("public") or the backoffice frame ("backoffice")."""
    global _html
    path = os.path.join(STATIC_DIR, "index.html")
    mtime = os.path.getmtime(path)
    if _html is None or _html[0] != mtime:
        with open(path, encoding="utf-8") as f:
            _html = (mtime, f.read())
    return _html[1].replace("__MODE__", "backoffice" if mode == "backoffice" else "public")


def page_response(mode: str) -> HTMLResponse:
    return HTMLResponse(page_html(mode), headers={"Cache-Control": "no-cache"})


@router.get("/w/tas/backoffice", include_in_schema=False)
async def backoffice_page(request: Request):
    p = await optional_principal(request)
    if p is None or p.scope != "full":
        return RedirectResponse("/login?next=/backoffice", status_code=302)
    return page_response("backoffice")


@router.get("/w/tas/env.js", include_in_schema=False)
async def env_js(request: Request, mode: str = "public"):
    p = await optional_principal(request)
    signed_in = p is not None and p.scope == "full"
    ai_on = False
    if signed_in and ai.enabled() and not await killswitch.is_active("ai"):
        async with db.connection() as conn:
            pol = await consumption.policy(conn, p.user_id)
        ai_on = pol["limit"] > 0 and not pol["blocked"]
    env = {
        "mode": "backoffice" if mode == "backoffice" else "public",
        "signedIn": signed_in,
        "canEdit": signed_in and tas.can_edit(p),
        "needsMfa": signed_in and tas.has_editor_role(p) and not tas.can_edit(p),
        "uid": str(p.user_id) if signed_in else None,
        "name": (p.display_name or "") if signed_in else "",
        "ai": ai_on,
        "collections": sorted(tas.readable(p if signed_in else None)),
    }
    body = "window.TAS_ENV = " + json.dumps(env, ensure_ascii=False) + ";\n"
    return Response(body, media_type="text/javascript", headers={"Cache-Control": "no-store"})


@router.get("/w/tas/{name}", include_in_schema=False)
async def tas_static(name: str, request: Request):
    if name not in SCRIPTS:
        raise HTTPException(404)
    # The page names each script with ?v=<content hash> (specs/tas/port.py); gaer.js is ours and changes with Gær.
    cache = "public, max-age=31536000, immutable" if request.query_params.get("v") and name != "gaer.js" else "no-cache"
    return FileResponse(os.path.join(STATIC_DIR, name), media_type="text/javascript", headers={"Cache-Control": cache})


# ── Documents ──────────────────────────────────────────────────────────────

class DocIn(BaseModel):
    data: dict


@router.get("/api/tas/rev")
async def rev(request: Request):
    p = await optional_principal(request)
    async with db.connection() as conn:
        return {"revs": await tas.revs(conn, sorted(tas.readable(p)))}


@router.get("/api/tas/docs/{collection}")
async def list_docs(collection: str, request: Request):
    _check(collection)
    if not tas.may_read(await optional_principal(request), collection):
        raise HTTPException(403, "Kladder er kun for redaktører")
    async with db.connection() as conn:
        return await tas.list_docs(conn, collection)


@router.get("/api/tas/docs/{collection}/{doc_id}")
async def get_doc(collection: str, doc_id: str, request: Request):
    _check(collection, doc_id)
    if not tas.may_read(await optional_principal(request), collection):
        raise HTTPException(403, "Kladder er kun for redaktører")
    async with db.connection() as conn:
        data = await tas.get_doc(conn, collection, doc_id)
    if data is None:
        raise HTTPException(404, "Dokumentet findes ikke")
    return {"id": doc_id, "data": data}


async def _write(collection: str, doc_id: str, data: dict | None, merge: bool, p: Principal) -> dict | None:
    _check(collection, doc_id)
    async with db.connection() as conn:
        cur = await db.fetch_one(conn, "select data from tas_docs where collection = %s and id = %s for update",
                                 (collection, doc_id))
        before = cur["data"] if cur else None
        if data is None:
            if before is None:
                return None
            await conn.execute("delete from tas_docs where collection = %s and id = %s", (collection, doc_id))
            action, after = "tas.doc.delete", None
        else:
            if merge and before is None:
                raise HTTPException(404, "Dokumentet findes ikke")
            after = {**before, **data} if merge else data
            if tas.size_of(after) > tas.MAX_DOC_BYTES:
                raise HTTPException(413, "Dokumentet er for stort")
            await tas.put_doc(conn, collection, doc_id, after, p.user_id)
            action = "tas.doc.update" if merge else "tas.doc.set"
        b, a = tas.audit_view(before, after)
        await audit(conn, action, actor_id=p.user_id, meta=p.meta, table="tas_docs", row_id=f"{collection}/{doc_id}",
                    before=b, after=a)
    await events.emit("tas.write", ref=collection)
    return after


@router.put("/api/tas/docs/{collection}/{doc_id}")
async def put_doc(collection: str, doc_id: str, body: DocIn, p: Principal = Depends(require_editor)):
    return {"id": doc_id, "data": await _write(collection, doc_id, body.data, False, p)}


@router.patch("/api/tas/docs/{collection}/{doc_id}")
async def patch_doc(collection: str, doc_id: str, body: DocIn, p: Principal = Depends(require_editor)):
    return {"id": doc_id, "data": await _write(collection, doc_id, body.data, True, p)}


@router.delete("/api/tas/docs/{collection}/{doc_id}", status_code=204)
async def delete_doc(collection: str, doc_id: str, p: Principal = Depends(require_editor)):
    await _write(collection, doc_id, None, False, p)
    return Response(status_code=204)


# ── Images ─────────────────────────────────────────────────────────────────

@router.post("/api/tas/assets")
async def upload_asset(file: UploadFile = File(...), p: Principal = Depends(require_editor)):
    data = await file.read(tas.MAX_ASSET_BYTES + 1)
    if len(data) > tas.MAX_ASSET_BYTES:
        raise HTTPException(413, "Billedet er større end 5 MB")
    content_type = tas.sniff(data[:16])
    if content_type not in tas.IMAGE_TYPES:
        raise HTTPException(400, "Billedet skal være PNG, JPEG, WebP eller GIF")
    asset_id = secrets.token_hex(16)
    async with db.connection() as conn:
        await conn.execute("""insert into tas_assets (id, content_type, data, size, created_by)
                              values (%s, %s, %s, %s, %s)""", (asset_id, content_type, data, len(data), p.user_id))
        await audit(conn, "tas.asset.upload", actor_id=p.user_id, meta=p.meta, table="tas_assets", row_id=asset_id,
                    content_type=content_type, size=len(data))
    return {"id": asset_id, "url": f"/api/tas/assets/{asset_id}"}


@router.get("/api/tas/assets/{asset_id}")
async def get_asset(asset_id: str):
    if not tas.valid_id(asset_id):
        raise HTTPException(404)
    async with db.connection() as conn:
        row = await db.fetch_one(conn, "select content_type, data from tas_assets where id = %s", (asset_id,))
    if row is None:
        raise HTTPException(404, "Billedet findes ikke")
    # An asset never changes: a new image gets a new id.
    return Response(bytes(row["data"]), media_type=row["content_type"],
                    headers={"Cache-Control": "public, max-age=31536000, immutable"})


# ── AI and names ───────────────────────────────────────────────────────────

class AiIn(BaseModel):
    prompt: str = Field(min_length=1, max_length=120_000)


@router.post("/api/tas/ai")
async def ai_json(body: AiIn, p: Principal = Depends(current_user)):
    if not ai.enabled() or await killswitch.is_active("ai"):
        raise HTTPException(404, "AI er ikke slået til på denne instans")
    async with db.connection() as conn:
        pol = await consumption.policy(conn, p.user_id)
    if pol["blocked"] == "off" or pol["limit"] <= 0:
        raise HTTPException(403, consumption.BLOCKED_TEXT["off"])
    if pol["blocked"]:
        raise HTTPException(429, consumption.BLOCKED_TEXT[pol["blocked"]])
    try:
        result, prompt_tokens, completion_tokens, estimated = await tas.complete_json(body.prompt)
    except tas.AiError as e:
        raise HTTPException(502, str(e)) from e
    await ai.record_usage(p.user_id, "tas", prompt_tokens, completion_tokens, estimated)
    return {"result": result}


class ProfilesIn(BaseModel):
    ids: list[str] = Field(max_length=64)


@router.post("/api/tas/profiles")
async def profiles(body: ProfilesIn, p: Principal = Depends(require_editor)):
    ids = sorted({int(i) for i in body.ids if i.isdigit()})
    async with db.connection() as conn:
        rows = await db.fetch_all(conn, "select id, display_name from users where id = any(%s)", (ids,))
    return {"profiles": {str(r["id"]): {"name": r["display_name"] or f"Bruger {r['id']}"} for r in rows}}

