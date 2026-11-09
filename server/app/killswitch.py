"""Kill switches: close all or part of the service in seconds, by hand in /admin/resources or by a rule (app.events).

The state lives in Postgres (kill_switches), so it is audited, survives restarts and is the same in every container.
Each process keeps it in memory and reads it again at most every CACHE_SECONDS (one small query), so a change
reaches every container within a couple of seconds; the process that made the change sees it at once.

A closed switch answers 503 for its paths (the guard middleware in app.main calls blocked()). /admin, login and
/health are never closed, so an admin can always open again. A switch with expires_at opens by itself.
Which switches exist, and what they close, is code (SWITCHES) — never configuration.
"""

import asyncio
import logging
import time
from datetime import datetime, timezone

from app import db

log = logging.getLogger("gaer.killswitch")

CACHE_SECONDS = 2.0

# key → label, description, closed paths as (methods or None for all, path prefix), exceptions (prefixes).
SWITCHES: dict[str, dict] = {
    "all": {
        "label": "Hele tjenesten",
        "description": "Lukker appen for brugere: API, MCP, webhooks og indsamling. /admin, login og /health virker stadig, "
                       "så du kan åbne igen.",
        "paths": [(None, "/api/"), (None, "/mcp")],
        "except": ["/api/admin", "/api/auth", "/api/impersonation", "/api/public/config"],
    },
    "ai": {
        "label": "AI",
        "description": "AI-chat og agenter. Knapperne skjules, fordi /api/ai/status siger, at AI er slået fra.",
        "paths": [(None, "/api/ai/"), ({"POST"}, "/api/knowledge/agents/")],
        "except": ["/api/ai/status"],
    },
    "files": {
        "label": "Upload og ændring af filer",
        "description": "Brugernes upload, flytning og sletning af filer. Filer kan stadig ses og hentes.",
        "paths": [({"POST", "PUT", "PATCH", "DELETE"}, "/api/files")],
        "except": [],
    },
    "mcp": {
        "label": "MCP-servere",
        "description": "/mcp og /mcp/admin, også login af nye MCP-klienter.",
        "paths": [(None, "/mcp")],
        "except": [],
    },
    "webhooks_in": {
        "label": "Indgående webhooks",
        "description": "POST /api/hooks/in/… svarer 503, så afsenderen prøver igen senere.",
        "paths": [(None, "/api/hooks/in")],
        "except": [],
    },
    "collect": {
        "label": "Analytics og heatmaps",
        "description": "Indsamling af sidevisninger og klik fra browseren.",
        "paths": [(None, "/api/collect")],
        "except": [],
    },
}

_state: dict[str, dict] = {}
_loaded_at = 0.0
_lock = asyncio.Lock()


def invalidate() -> None:
    global _loaded_at
    _loaded_at = 0.0


async def refresh(force: bool = False) -> dict[str, dict]:
    global _state, _loaded_at
    if not force and time.monotonic() - _loaded_at < CACHE_SECONDS:
        return _state
    async with _lock:
        if not force and time.monotonic() - _loaded_at < CACHE_SECONDS:
            return _state
        try:
            async with db.connection() as conn:
                rows = await db.fetch_all(conn, "select key, active, expires_at from kill_switches where active")
        except Exception:
            # Fail open on the last known state: a database hiccup must not turn into a 500 on every request.
            log.warning("kill switches could not be read, keeping the cached state", exc_info=True)
            _loaded_at = time.monotonic()
            return _state
        _state = {r["key"]: r for r in rows}
        _loaded_at = time.monotonic()
    return _state


def _active(key: str) -> bool:
    row = _state.get(key)
    if not row:
        return False
    return row["expires_at"] is None or row["expires_at"] > datetime.now(timezone.utc)


async def is_active(key: str) -> bool:
    await refresh()
    return _active(key)


def _matches(spec: dict, method: str, path: str) -> bool:
    if any(path == e or path.startswith(e.rstrip("/") + "/") for e in spec["except"]):
        return False
    for methods, prefix in spec["paths"]:
        if (methods is None or method in methods) and (path == prefix.rstrip("/") or path.startswith(prefix)):
            return True
    return False


def may_block(path: str) -> bool:
    """Cheap check first, so static files and /admin never wait for the cache."""
    return (path.startswith("/api/") or path.startswith("/mcp")) and not path.startswith("/api/admin")


async def blocked(method: str, path: str) -> dict | None:
    """The switch that closes this request, or None."""
    if not may_block(path):
        return None
    await refresh()
    for key, spec in SWITCHES.items():
        if _active(key) and _matches(spec, method, path):
            return {"key": key, "label": spec["label"]}
    return None


def catalog() -> list[dict]:
    return [{"key": k, "label": v["label"], "description": v["description"]} for k, v in SWITCHES.items()]
