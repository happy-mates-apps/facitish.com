"""Deep links into the app and /admin: <ORIGIN>/admin/go?path=/admin/users&userId=4&focus=user-block.

Built from the tool's `link` in catalog.json and checked against app_map.json (generated from the
data-deeplink anchors in web/src by `npm run app-map --prefix web`), so a dead link is never returned.
"""

import json
import pathlib
import re
from urllib.parse import urlencode

from app import config
from app.mcp.registry import CATALOG

MAP_FILE = pathlib.Path(__file__).parent / "app_map.json"
_map: dict | None = None
PLACEHOLDER = re.compile(r"\{(\w+)\}")


def app_map() -> dict:
    global _map
    if _map is None:
        _map = json.loads(MAP_FILE.read_text()) if MAP_FILE.exists() else {"routes": {}}
    return _map


def _route_for(path: str) -> dict | None:
    """The app_map route a concrete path belongs to (/klip/12 → /klip/:id)."""
    routes = app_map()["routes"]
    if path in routes:
        return routes[path]
    for pattern, route in routes.items():
        if ":" in pattern and re.fullmatch(re.sub(r":\w+", r"[^/]+", pattern), path):
            return route
    return None


def _focus_ok(route: dict, focus: str) -> bool:
    return any(re.fullmatch(PLACEHOLDER.sub(r"[\\w-]+", a), focus) for a in route.get("anchors", []))


def resolve(path: str, focus: str | None = None) -> bool:
    route = _route_for(path)
    return route is not None and (not focus or _focus_ok(route, focus))


def build(path: str, args: dict | None = None, focus: str | None = None) -> str:
    query = {"path": path, **{k: v for k, v in (args or {}).items() if v not in (None, "")}}
    if focus:
        query["focus"] = focus
    base = "/admin/go" if path == "/admin" or path.startswith("/admin/") else "/go"
    return config.settings.origin.rstrip("/") + base + "?" + urlencode(query, safe="/{}")


def _fill(template: str, values: dict) -> str | None:
    missing = [k for k in PLACEHOLDER.findall(template) if values.get(k) in (None, "")]
    return None if missing else PLACEHOLDER.sub(lambda m: str(values[m.group(1)]), template)


def link_for(server: str, tool: str, values: dict, label: str | None = None) -> dict | None:
    """The tool's catalog link filled with `values`, or None when it cannot be filled or does not resolve."""
    spec = next((t for t in CATALOG["tools"] if t["server"] == server and t["name"] == tool), None)
    link = spec and spec.get("link")
    if not link:
        return None
    path = _fill(link["section"], values)
    focus = _fill(link["focus"], values) if link.get("focus") else None
    if path is None or (link.get("focus") and focus is None) or not resolve(path, focus):
        return None
    args = {k: values.get(k) for k in link.get("args", [])}
    return {"label": label or link["label"], "url": build(path, args, focus)}


def links_for(server: str, tool: str, rows: list[dict], label: str | None = None, **extra) -> list[dict]:
    """One link for the list plus one per row (max 20). `label` names the row field used as link text."""
    out = [link_for(server, tool, extra)] + [link_for(server, tool, {**extra, **r}, str(r.get(label)) if label else None)
                                              for r in rows[:20]]
    seen, unique = set(), []
    for x in out:
        if x and x["url"] not in seen:
            seen.add(x["url"])
            unique.append(x)
    return unique
