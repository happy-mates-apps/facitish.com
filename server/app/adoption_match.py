"""Which routes a step matches, and which paths adoption tracking records.

The same rules live in web/src/admin-app/adoption/match.ts for the live preview in the setup form; the test vectors
in server/tests/test_adoption.py (MATCH_CASES) keep the two in step.

    exact   only this path (a trailing / is ignored)            /klip
    prefix  every path that starts like this                    /extension
    glob    * = one segment, ** = the rest of the path          /klip/*
    regex   a regular expression against the path               ^/(m|extension)/klip$
"""

import re

from app import route_manifest

MATCH_TYPES = ("exact", "prefix", "glob", "regex")
MATCH_LABELS = {"exact": "Præcis", "prefix": "Starter med", "glob": "Mønster", "regex": "Regex"}

# Paths that are never recorded: sign-in, consent, deep links, the Office shell and everything not in the app on /.
NOT_TRACKED = re.compile(r"^/(login|go|forbind|office-addin|privatliv)(/|$)|^/(m|extension)/login(/|$)")
ID_SEGMENT = re.compile(r"^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,})$",
                        re.IGNORECASE)


def to_regex(match_type: str, pattern: str) -> re.Pattern | None:
    """The pattern as a compiled expression, or None when it is empty or invalid."""
    p = (pattern or "").strip()
    if not p or match_type not in MATCH_TYPES:
        return None
    try:
        if match_type == "exact":
            return re.compile("^" + re.escape(p.rstrip("/")) + "/?$")
        if match_type == "prefix":
            return re.compile("^" + re.escape(p.rstrip("*")))
        if match_type == "glob":
            body = ".*".join("[^/]+".join(re.escape(s) for s in part.split("*")) for part in p.split("**"))
            return re.compile("^" + body + "/?$")
        return re.compile(p)
    except re.error:
        return None


def valid(match_type: str, pattern: str) -> bool:
    return to_regex(match_type, pattern) is not None


def matches(match_type: str, pattern: str, path: str) -> bool:
    rx = to_regex(match_type, pattern)
    return bool(rx and rx.search(path))


class StepMatcher:
    """The step indices each path matches, cached (paths repeat across users and weeks)."""

    def __init__(self, steps: list[dict]):
        self.rules = [to_regex(s["match_type"], s["pattern"]) for s in steps]
        self.cache: dict[str, list[int]] = {}

    def __call__(self, path: str) -> list[int]:
        hit = self.cache.get(path)
        if hit is None:
            hit = [i for i, rx in enumerate(self.rules) if rx is not None and rx.search(path)]
            self.cache[path] = hit
        return hit


def clean_path(path: str) -> str | None:
    """The pathname without query, fragment and trailing slash, or None when it is not a path."""
    if not isinstance(path, str) or not path.startswith("/") or path.startswith("//"):
        return None
    p = path.split("?", 1)[0].split("#", 1)[0]
    p = p.rstrip("/") or "/"
    return p if len(p) <= 300 else None


def normalize(path: str) -> str:
    """/klip/1842 → /klip/:id. Ids, numbers and UUIDs become :id so routes group."""
    return "/".join(":id" if ID_SEGMENT.match(s) else s for s in path.split("/")) or "/"


def tracked(path: str) -> bool:
    """A page of the app on / (including /m and /extension) that is not sign-in plumbing."""
    if NOT_TRACKED.search(path):
        return False
    route = route_manifest.route_for(path)
    if route is None or route["app"] != "app":
        return False
    return route["path"] != "/" or path == "/"  # "/" is the home page, not a catch-all


def surface(path: str) -> str:
    if path == "/m" or path.startswith("/m/"):
        return "mobil"
    if path.startswith("/extension/tools"):
        return "office"
    if path == "/extension" or path.startswith("/extension/"):
        return "udvidelse"
    return "app"
