"""Tools for /mcp — the app. Always as the signed-in user, and only their own rows (`where user_id = %s`).
Clips, the ring level and the profile (name, language, time zone) are written directly (with audit); deleting a clip
and a GDPR export are drafts. Security (passkeys, authenticator apps, "Kræv passkey") is read only here.
"""

from fastapi import HTTPException

from app import config, db, gdpr, mfa
from app.logs import audit
from app.mcp.common import absolute, limit, masked, store_file
from app.mcp.links import link_for, links_for
from app.mcp.registry import Caller, DraftPlan, ToolError, ToolOutput, draft, tool
from app.routes.features import DEFAULT_LEVEL, _set_level, user_level
from app.routes.me import LOCALES, ProfileIn, clean_profile, update_profile_fields
from app.storage import get_storage

S = "app"
RING_NAMES = {1: "Internt", 2: "Beta", 3: "Preview", 4: "Stabilt"}
# The catalog's source names → the sources stored on clips.
SOURCE_FILTER = {"web": ["manual"], "extension": ["extension"], "office": ["word", "outlook"], "mobile": ["mobile"],
                 "mcp": ["mcp"]}
CLIP_COLUMNS = "id, source, title, body, url, created_at, updated_at"


def _clip_row(c: dict, full: bool = False) -> dict:
    out = {**c, "clipId": c["id"]}
    if not full and len(c.get("body") or "") > 300:
        out["body"] = c["body"][:300] + "…"
    return out


async def _own_clip(conn, caller: Caller, clip_id: int, lock: bool = False) -> dict:
    row = await db.fetch_one(conn, f"select {CLIP_COLUMNS} from clips where id = %s and user_id = %s"
                             + (" for update" if lock else ""), (clip_id, caller.user_id))
    if row is None:
        raise ToolError("Klippet findes ikke")
    return row


# ── Me ──────────────────────────────────────────────────────────────────────

@tool(S, "whoami")
async def whoami(args, caller: Caller) -> ToolOutput:
    async with db.connection() as conn:
        user = await db.fetch_one(conn, "select id, display_name, email, phone, role, created_at from users where id = %s",
                                  (caller.user_id,))
        session = await db.fetch_one(conn, """
            select s.id, s.created_at, c.name as client from sessions s left join mcp_clients c on c.id = s.mcp_client_id
            where s.id = %s""", (caller.principal.session_id,))
        level = await user_level(conn, caller.user_id)
    return ToolOutput({"user": {"id": user["id"], "displayName": user["display_name"], "email": masked(user["email"]),
                                "phone": masked(user["phone"]),
                                "role": user["role"], "createdAt": user["created_at"]},
                       "ring": {"level": level, "name": RING_NAMES[level]}, "session": session},
                      links=[x for x in [link_for(S, "whoami", {})] if x])


@tool(S, "me_sessions")
async def me_sessions(args, caller: Caller) -> ToolOutput:
    async with db.connection() as conn:
        rows = await db.fetch_all(conn, """
            select s.id, s.created_at, s.last_seen_at, s.expires_at, s.user_agent, c.name as mcp_client, s.mcp_scope
            from sessions s left join mcp_clients c on c.id = s.mcp_client_id
            where s.user_id = %s and s.revoked_at is null and s.expires_at > now() and s.impersonator_id is null
            order by s.last_seen_at desc""", (caller.user_id,))
    for r in rows:
        r["current"] = r["id"] == caller.principal.session_id
    return ToolOutput({"sessions": rows}, links=[x for x in [link_for(S, "me_sessions", {})] if x])


@tool(S, "me_features")
async def me_features(args, caller: Caller) -> ToolOutput:
    async with db.connection() as conn:
        level = await user_level(conn, caller.user_id)
        rows = await db.fetch_all(conn, "select key, title, description, ring from features order by ring desc, key")
    visible = [{**r, "ringName": RING_NAMES[r["ring"]]} for r in rows if r["ring"] >= level]
    return ToolOutput({"level": level, "features": visible, "hidden": len(rows) - len(visible)})


@tool(S, "me_set_ring")
async def me_set_ring(args, caller: Caller) -> ToolOutput:
    ring = args["ring"]
    if ring not in RING_NAMES:
        raise ToolError("Niveauet skal være 1, 2, 3 eller 4")
    async with db.connection() as conn:
        await _set_level(conn, caller.user_id, None if ring == DEFAULT_LEVEL else ring, caller.principal)
    return ToolOutput({"level": ring, "name": RING_NAMES[ring]}, links=[x for x in [link_for(S, "me_set_ring", {})] if x],
                      text=f"Dit niveau er nu ring {ring} · {RING_NAMES[ring]}")


# ── Profile and security ────────────────────────────────────────────────────

@tool(S, "profile_get")
async def profile_get(args, caller: Caller) -> ToolOutput:
    async with db.connection() as conn:
        u = await db.fetch_one(conn, """select display_name, email, phone, locale, time_zone, avatar_file_id is not null
                                        as has_avatar, created_at from users where id = %s""", (caller.user_id,))
    return ToolOutput({"profile": {"displayName": u["display_name"], "email": masked(u["email"]), "phone": masked(u["phone"]),
                                   "locale": u["locale"], "timeZone": u["time_zone"], "hasAvatar": u["has_avatar"],
                                   "createdAt": u["created_at"]}, "locales": list(LOCALES)},
                      links=[x for x in [link_for(S, "profile_get", {})] if x])


@tool(S, "profile_update")
async def profile_update(args, caller: Caller) -> ToolOutput:
    """Name, language and time zone. E-mail, phone, avatar and security are changed in the app (they need a code,
    a file or a second factor)."""
    sent = {{"displayName": "display_name", "timeZone": "time_zone"}.get(k, k): args[k]
            for k in ("displayName", "locale", "timeZone") if k in args}
    if not sent:
        raise ToolError("Angiv mindst ét af displayName, locale og timeZone")
    try:
        values = clean_profile(ProfileIn(**sent))
    except HTTPException as e:
        raise ToolError(str(e.detail))
    async with db.connection() as conn:
        await update_profile_fields(conn, caller.user_id, values, actor_id=caller.user_id, meta=caller.principal.meta)
    return ToolOutput({"updated": values}, links=[x for x in [link_for(S, "profile_update", {})] if x],
                      text="Profilen er gemt")


@tool(S, "security_get")
async def security_get(args, caller: Caller) -> ToolOutput:
    """Read only: factors are added and removed in the browser (WebAuthn needs it, and a second factor is asked for)."""
    async with db.connection() as conn:
        user = await db.fetch_one(conn, "select role, mfa_required, grace_logins_used from users where id = %s",
                                  (caller.user_id,))
        f = await mfa.factors(conn, caller.user_id)
        keys = await db.fetch_all(conn, """select name, kind, created_at, last_used_at from passkeys where user_id = %s
                                           order by created_at""", (caller.user_id,))
        apps = await db.fetch_all(conn, """select name, created_at, last_used_at from totp_factors
                                           where user_id = %s and confirmed_at is not null order by created_at""",
                                  (caller.user_id,))
    s = config.settings
    admin = user["role"] == "admin"
    return ToolOutput({
        "mfaRequired": user["mfa_required"], "factors": f, "methods": mfa.methods(f),
        "passkeys": [k for k in keys if k["kind"] == "passkey"],
        "securityKeys": [k for k in keys if k["kind"] == "security_key"], "authenticatorApps": apps,
        "admin": {"graceLoginsLeft": max(0, s.grace_logins - user["grace_logins_used"]) if not f["total"] else 0,
                  "mfaHours": s.admin_mfa_hours} if admin else None,
        "changeIn": absolute("/konto#sikkerhed"),
    }, links=[x for x in [link_for(S, "security_get", {})] if x])


# ── Clips ───────────────────────────────────────────────────────────────────

@tool(S, "clips_list")
async def clips_list(args, caller: Caller) -> ToolOutput:
    where, params = "user_id = %s", [caller.user_id]
    if args.get("source"):
        sources = SOURCE_FILTER.get(args["source"])
        if sources is None:
            raise ToolError("Kilde skal være web, extension, office, mobile eller mcp")
        where += " and source = any(%s)"
        params.append(sources)
    async with db.connection() as conn:
        rows = await db.fetch_all(conn, f"select {CLIP_COLUMNS} from clips where {where} order by created_at desc limit %s",
                                  params + [limit(args.get("limit"), 20, 100)])
    clips = [_clip_row(c) for c in rows]
    return ToolOutput({"clips": clips}, links=links_for(S, "clip_get", clips, label="title") + [x for x in [
        link_for(S, "clips_list", {"source": args.get("source")})] if x])


@tool(S, "clips_search")
async def clips_search(args, caller: Caller) -> ToolOutput:
    q = f"%{args['q'].strip()}%"
    async with db.connection() as conn:
        rows = await db.fetch_all(conn, f"""
            select {CLIP_COLUMNS} from clips
            where user_id = %s and (title ilike %s or body ilike %s or coalesce(url, '') ilike %s)
            order by created_at desc limit %s""", (caller.user_id, q, q, q, limit(args.get("limit"), 20, 50)))
    clips = [_clip_row(c) for c in rows]
    return ToolOutput({"q": args["q"], "clips": clips},
                      links=[x for x in [link_for(S, "clips_search", {"q": args["q"]})] if x] + links_for(S, "clip_get", clips, label="title"))


@tool(S, "clip_get")
async def clip_get(args, caller: Caller) -> ToolOutput:
    async with db.connection() as conn:
        clip = await _own_clip(conn, caller, args["clipId"])
    return ToolOutput({"clip": _clip_row(clip, full=True)},
                      links=[x for x in [link_for(S, "clip_get", {"clipId": clip["id"]})] if x])


@tool(S, "clip_create")
async def clip_create(args, caller: Caller) -> ToolOutput:
    title, body = args["title"].strip()[:300], args["body"][:100_000]
    if not title:
        raise ToolError("Titlen må ikke være tom")
    async with db.connection() as conn:
        row = await db.fetch_one(conn, f"""
            insert into clips (user_id, source, title, body, url) values (%s, 'mcp', %s, %s, %s) returning {CLIP_COLUMNS}""",
            (caller.user_id, title, body, args.get("url")))
        await audit(conn, "create", actor_id=caller.user_id, meta=caller.principal.meta, table="clips", row_id=row["id"],
                    after={"source": "mcp", "title": title, "url": args.get("url"), "chars": len(body)}, client=caller.client_id)
    return ToolOutput({"clip": _clip_row(row, full=True)}, text=f"Klippet „{title}“ er gemt",
                      links=[x for x in [link_for(S, "clip_create", {"clipId": row["id"]})] if x])


@tool(S, "clip_update")
async def clip_update(args, caller: Caller) -> ToolOutput:
    if "title" not in args and "body" not in args:
        raise ToolError("Angiv title eller body")
    async with db.connection() as conn:
        before = await _own_clip(conn, caller, args["clipId"], lock=True)
        title = args.get("title", before["title"]).strip()[:300] or before["title"]
        body = args.get("body", before["body"])[:100_000]
        row = await db.fetch_one(conn, f"""
            update clips set title = %s, body = %s, updated_at = now() where id = %s and user_id = %s returning {CLIP_COLUMNS}""",
            (title, body, before["id"], caller.user_id))
        await audit(conn, "update", actor_id=caller.user_id, meta=caller.principal.meta, table="clips", row_id=row["id"],
                    before={"title": before["title"], "chars": len(before["body"])}, after={"title": title, "chars": len(body)},
                    client=caller.client_id)
    return ToolOutput({"clip": _clip_row(row, full=True)}, text="Klippet er opdateret",
                      links=[x for x in [link_for(S, "clip_update", {"clipId": row["id"]})] if x])


@draft(S, "clip_delete")
async def clip_delete(args, caller: Caller, conn) -> DraftPlan:
    clip = await _own_clip(conn, caller, args["clipId"])

    async def execute(conn):
        await conn.execute("delete from clips where id = %s and user_id = %s", (clip["id"], caller.user_id))
        await audit(conn, "delete", actor_id=caller.user_id, meta=caller.principal.meta, table="clips", row_id=clip["id"],
                    before={"title": clip["title"], "source": clip["source"]})
        return {"deleted": clip["id"]}

    return DraftPlan(summary=f"Slet klippet „{clip['title']}“.",
                     impact={"bullets": [f"Oprettet {clip['created_at']:%d.%m.%Y} · kilde {clip['source']}",
                                         f"{len(clip['body'])} tegn slettes og kan ikke hentes igen"], "counts": {"clips": 1}},
                     state={"id": clip["id"], "updated_at": clip["updated_at"]}, execute=execute,
                     links=[x for x in [link_for(S, "clip_delete", {"clipId": clip["id"]})] if x])


# ── Files ───────────────────────────────────────────────────────────────────

@tool(S, "files_list")
async def files_list(args, caller: Caller) -> ToolOutput:
    async with db.connection() as conn:
        rows = await db.fetch_all(conn, """
            select id, filename, content_type, size_bytes, created_at from files where user_id = %s
            order by created_at desc limit %s""", (caller.user_id, limit(args.get("limit"), 50, 200)))
    files = [{**r, "fileId": str(r["id"])} for r in rows]
    return ToolOutput({"files": files}, links=[x for x in [link_for(S, "files_list", {})] if x] + links_for(S, "file_link", files, label="filename"))


@tool(S, "file_link")
async def file_link(args, caller: Caller) -> ToolOutput:
    async with db.connection() as conn:
        try:
            row = await db.fetch_one(conn, "select id, filename, storage_key from files where id = %s::uuid and user_id = %s",
                                     (args["fileId"], caller.user_id))
        except Exception:
            row = None
    if row is None:
        raise ToolError("Filen findes ikke")
    url = absolute(await get_storage().download_url(row["storage_key"], row["filename"]))
    return ToolOutput({"fileId": str(row["id"]), "filename": row["filename"], "download_url": url,
                       "expires_in": config.settings.download_link_seconds},
                      links=[x for x in [link_for(S, "file_link", {"fileId": str(row["id"])})] if x])


# ── Privacy ─────────────────────────────────────────────────────────────────

@draft(S, "privacy_export")
async def privacy_export(args, caller: Caller, conn) -> DraftPlan:
    counts = await db.fetch_one(conn, """
        select (select count(*) from clips where user_id = %(u)s) as clips,
               (select count(*) from files where user_id = %(u)s) as files,
               (select count(*) from sessions where user_id = %(u)s) as sessions""", {"u": caller.user_id})

    async def execute(conn):
        data = await gdpr.export_zip(conn, caller.user_id)
        stored = await store_file(conn, owner_id=caller.user_id, filename=gdpr.export_filename(caller.user_id), data=data,
                                  content_type="application/zip", caller=caller, prefix=f"users/{caller.user_id}/exports")
        await audit(conn, "gdpr.export", actor_id=caller.user_id, meta=caller.principal.meta, table="users",
                    row_id=caller.user_id, by_self=True, bytes=len(data), via="mcp")
        return stored

    return DraftPlan(summary="Lav en samlet eksport af alt, der er gemt om dig (GDPR-indsigt).",
                     impact={"bullets": [f"{counts['clips']} klip, {counts['files']} filer og {counts['sessions']} sessioner "
                                         "kommer med sammen med logs og samtykker",
                                         "Eksporten gemmes som en zip under Filer og kan hentes via et link, der udløber"],
                             "counts": counts},
                     state={"user": caller.user_id}, execute=execute,
                     links=[x for x in [link_for(S, "privacy_export", {})] if x])
