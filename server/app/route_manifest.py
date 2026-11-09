"""The route manifest (web/src/routes.json, copied to app/routes.json by `npm run app-map --prefix web`).

The server uses it for two decisions, so they cannot drift from the frontends and the docs:
  EMBEDDABLE  path prefixes the browser extension and the Office hosts may frame (CSP frame-ancestors)
  app_for()   which app answers a path: "admin" → web/dist/admin.html, otherwise the app on / (index.html)
"""

import json
import re
from pathlib import Path

MANIFEST = json.loads((Path(__file__).parent / "routes.json").read_text(encoding="utf-8"))
ROUTES: list[dict] = MANIFEST["routes"]


def prefix(path: str) -> str:
    """/klip/:id -> /klip/ · /api/{path} -> /api/ · /extension -> /extension"""
    m = re.search(r"[:{]", path)
    return path[:m.start()] if m else path


# Static assets are framed together with the pages that load them.
EMBEDDABLE: tuple[str, ...] = tuple(sorted({prefix(r["path"]) for r in ROUTES if r.get("embeddable")} | {"/assets/"}))


def _matches(route_path: str, path: str) -> bool:
    p = prefix(route_path)
    if p.endswith("/"):
        return path.startswith(p) or (p != "/" and path == p[:-1])
    return path == p or (p != "/" and path.startswith(p + "/"))


def route_for(path: str) -> dict | None:
    """The most specific route for a path (longest matching prefix), or None."""
    hits = [r for r in ROUTES if _matches(r["path"], path)]
    return max(hits, key=lambda r: len(prefix(r["path"])), default=None)


def app_for(path: str) -> str:
    route = route_for(path)
    return route["app"] if route else "app"
