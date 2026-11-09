"""/api/ai — the optional chat used by /extension, the Office tools and /m. See app/ai.py.
Which limit applies (budget, own limit or default) is decided in app/consumption.py."""

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from app import ai, consumption, db, settings_store
from app.routes.features import user_level
from app.sessions import Principal, current_user

router = APIRouter(prefix="/api/ai", tags=["ai"])


@router.get("/status")
async def status(p: Principal = Depends(current_user)):
    if not ai.enabled():
        return {"enabled": False}
    async with db.connection() as conn:
        pol = await consumption.policy(conn, p.user_id)
    return {"enabled": pol["limit"] > 0, "used": pol["used"], "limit": pol["limit"], "hard": pol["hard"],
            "warning": pol["warning"], "blocked": pol["blocked"] is not None, "status": pol["status"]}


@router.get("/usage")
async def usage(p: Principal = Depends(current_user)):
    """The user's own consumption (/konto/forbrug). Budget notes are for admins and are not included."""
    async with db.connection() as conn:
        report = await consumption.user_report(conn, p.user_id)
    return {"enabled": ai.enabled(), **report}


@router.post("/chat")
async def chat(body: ai.ChatIn, p: Principal = Depends(current_user)):
    if not ai.enabled():
        raise HTTPException(404, "AI er ikke slået til på denne instans")
    async with db.connection() as conn:
        pol = await consumption.policy(conn, p.user_id)
        app_name = await settings_store.get(conn, "app_name")
        level = await user_level(conn, p.user_id)
        off = await db.fetch_all(conn, "select key from features where ring < %s", (level,))
    who = ai.SignedIn(name=p.display_name, role=p.role, disabled_features=frozenset(r["key"] for r in off),
                      impersonated=p.impersonator_id is not None)
    if pol["blocked"] == "off":
        raise HTTPException(403, consumption.BLOCKED_TEXT["off"])
    if pol["blocked"]:
        raise HTTPException(429, consumption.BLOCKED_TEXT[pol["blocked"]])
    return StreamingResponse(ai.stream_chat(body, p.user_id, app_name, who), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
