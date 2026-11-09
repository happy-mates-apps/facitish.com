"""POST /api/hooks/in/<key>: where other systems deliver webhooks (see app.webhooks_in).

Public by design: the key in the URL selects the endpoint, and the endpoint's verification decides. Exempt from
the X-Gaer CSRF header (senders cannot add it); there is no session cookie involved. Unknown keys answer 404 like
any other missing page, so keys cannot be probed.
"""

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app import db, webhooks_in
from app.security import client_ip

router = APIRouter(prefix="/api/hooks", tags=["hooks"])

HARD_LIMIT = 5 * 1024 * 1024  # above any endpoint's max_body_kb


async def _read_body(request: Request, limit: int) -> bytes | None:
    """The body, or None when it is larger than limit (read no further than that)."""
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        return None
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/in/{key}")
async def receive(key: str, request: Request):
    async with db.connection() as conn:
        endpoint = await db.fetch_one(conn, "select * from webhook_endpoints where key = %s", (key,))
    if endpoint is None or not endpoint["active"]:
        return JSONResponse({"detail": "Not Found"}, status_code=404)
    body = await _read_body(request, min(endpoint["max_body_kb"] * 1024, HARD_LIMIT))
    if body is None:
        await webhooks_in.reject(endpoint["id"], "too_large")
        return JSONResponse({"detail": "Body too large"}, status_code=413)
    headers = {k.lower(): v for k, v in request.headers.items()}
    try:
        result = await webhooks_in.receive(endpoint, headers, body, client_ip(request))
    except webhooks_in.Rejected as e:
        await webhooks_in.reject(endpoint["id"], e.reason)
        # The reason is in /admin; the sender only learns the status.
        return JSONResponse({"detail": {401: "Unauthorized", 403: "Forbidden", 413: "Body too large",
                                        429: "Too many requests"}.get(e.status, "Not Found")}, status_code=e.status)
    if result["duplicate"]:
        return JSONResponse({"id": str(result["id"]), "duplicate": True}, status_code=200)
    return JSONResponse({"id": str(result["id"])}, status_code=202)
