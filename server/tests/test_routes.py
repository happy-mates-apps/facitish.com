"""web/src/routes.json is the one description of the routes; the server, the frontends and the docs follow it."""

import json
import pathlib

from app import route_manifest as rm
from app.main import create_app

ROOT = pathlib.Path(__file__).parents[2]
INFRA = ("/assets", "/docs/", "/{full_path:path}")  # static files, OpenAPI helpers and the SPA fallback


def _paths(routes):
    for r in routes:
        if type(r).__name__ == "_IncludedRouter":
            yield from _paths(r.original_router.routes)
        elif getattr(r, "path", ""):
            yield r.path


def test_server_copy_is_the_manifest():
    source = json.loads((ROOT / "web" / "src" / "routes.json").read_text(encoding="utf-8"))
    assert rm.MANIFEST["routes"] == source["routes"] and rm.MANIFEST["groups"] == source["groups"], \
        "run npm run app-map --prefix web"


def test_every_server_path_is_described():
    for path in set(_paths(create_app().routes)):
        if path.startswith("/api/") or path.startswith(INFRA):
            continue
        route = rm.route_for(path)
        assert route is not None and route["path"] != "/", f"{path} is not in web/src/routes.json"


def test_embeddable_and_which_app_answers():
    assert {"/extension", "/office-addin", "/login", "/api/", "/assets/"} <= set(rm.EMBEDDABLE)
    assert not any(p.startswith(("/admin", "/konto", "/m")) for p in rm.EMBEDDABLE)
    assert rm.app_for("/admin") == rm.app_for("/admin/users") == rm.app_for("/admin/ukendt") == "admin"
    assert rm.app_for("/administration") == rm.app_for("/klip/7") == rm.app_for("/") == "app"
    assert rm.route_for("/w")["path"] == rm.route_for("/w/om")["path"] == "/w/{slug}"
