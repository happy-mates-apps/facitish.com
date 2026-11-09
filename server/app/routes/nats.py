"""/admin/nats: monitoring of the NATS server in the stack (section "NATS", role Drift).

Read only. The app reads NATS' HTTP monitoring port (NATS_MONITOR_URL) and passes on whitelisted endpoints
(app.nats_monitor.ENDPOINTS). Every GET is logged as admin.read by require_admin, as everywhere in /admin.
"""

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request

from app import config, nats_monitor
from app.sessions import require_admin

router = APIRouter(prefix="/api/admin/nats", tags=["admin"], dependencies=[Depends(require_admin)])


def _setup() -> dict:
    s = config.settings
    return {
        "configured": nats_monitor.configured(),
        "monitor_url": s.nats_monitor_url,
        "client_url": nats_monitor.redact_url(s.nats_url),
        "endpoints": [{"key": k, "description": d} for k, (d, _) in nats_monitor.ENDPOINTS.items()],
    }


@router.get("")
async def overview():
    """Everything the front tab needs in one request (and one audit line): server, health and JetStream."""
    out = {**_setup(), "reachable": False, "error": None, "fetched_at": nats_monitor.now()}
    if not out["configured"]:
        return out
    varz, health, jsz = await asyncio.gather(
        nats_monitor.fetch("varz"),
        nats_monitor.fetch("healthz"),
        nats_monitor.fetch("jsz", {"accounts": "true"}),
        return_exceptions=True,
    )
    if isinstance(varz, nats_monitor.MonitorError):
        out["error"] = varz.message
        return out
    if isinstance(varz, BaseException):
        raise varz
    out["reachable"] = True
    out["varz"] = varz[1]
    if isinstance(health, tuple):
        out["health"] = {"http_status": health[0], **health[1]}
    else:
        out["health"] = {"http_status": None, "status": "unavailable", "error": str(health)}
    out["jsz"] = jsz[1] if isinstance(jsz, tuple) else None
    return out


@router.get("/{endpoint}")
async def endpoint(endpoint: str, request: Request):
    """One monitoring endpoint (connz, routez, gatewayz, leafz, subsz, jsz, accountz, accstatz, varz, healthz)."""
    params = dict(request.query_params)
    try:
        status, data = await nats_monitor.fetch(endpoint, params)
    except nats_monitor.MonitorError as e:
        raise HTTPException(e.status, e.message)
    return {"endpoint": endpoint, "http_status": status, "fetched_at": nats_monitor.now(), "data": data}
