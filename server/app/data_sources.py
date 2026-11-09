"""API sources for /admin → Data: the kildebeskrivelse (YAML) and the calls the server makes for it.

Rules (specs/admin-app/DATA.md):
- Only the server calls an API, and only over https to the hosts named in the description. Hosts that resolve to
  private, loopback or link-local addresses are refused, and redirects are not followed.
- The description never holds a secret. `auth.hemmelighed` names an environment variable, and only names that start
  with DATA_SECRET_ are allowed, so a description cannot send DATABASE_URL or SECRET_KEY to another host.
- Every call has a timeout, a size limit, a per-source limit per minute and a short in-memory cache.
"""

import asyncio
import ipaddress
import json
import re
import socket
import time
from collections import deque
from urllib.parse import urlencode, urlsplit

import httpx
import yaml

from app import config

CLASSIFICATION = {"hvid": "white", "grøn": "green", "groen": "green", "gul": "yellow", "rød": "red", "roed": "red",
                  "white": "white", "green": "green", "yellow": "yellow", "red": "red"}
DATA_TYPES = {"tekst": "text", "text": "text", "tal": "number", "number": "number", "heltal": "number",
              "uuid": "uuid", "dato": "date", "date": "date", "bool": "boolean", "boolean": "boolean", "json": "json"}
KEY_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
FIELD_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")
PATH_RE = re.compile(r"^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$")
ROWS_RE = re.compile(r"^\$(\.[A-Za-z0-9_]+)*(\[\*\])?$")
SECRET_NAME_RE = re.compile(r"^DATA_SECRET_[A-Z0-9_]{1,60}$")
SECRET_KEYS = {"token", "key", "api_key", "apikey", "password", "adgangskode", "secret", "bearer"}

MAX_SPEC_BYTES = 64_000
MAX_DATASETS = 30
MAX_FIELDS = 80
MAX_RESPONSE_BYTES = 5_000_000
MAX_ROWS = 1000
CACHE_ENTRIES = 200


class SpecError(ValueError):
    """A kildebeskrivelse that cannot be used. The message is Danish and shown to the admin."""


class FetchError(RuntimeError):
    """A call to the API failed. The message is Danish and shown to the admin."""


# ── The description ─────────────────────────────────────────────────────────

def _str(value, what: str, *, required: bool = True, max_len: int = 200) -> str:
    if value is None or value == "":
        if required:
            raise SpecError(f"Mangler {what}")
        return ""
    if not isinstance(value, (str, int, float)):
        raise SpecError(f"{what} skal være tekst")
    text = str(value).strip()
    if len(text) > max_len:
        raise SpecError(f"{what} er for lang (højst {max_len} tegn)")
    return text


def _classification(value, default: str, what: str) -> str:
    if value in (None, ""):
        return default
    c = CLASSIFICATION.get(str(value).strip().lower())
    if not c:
        raise SpecError(f"{what}: klassifikation skal være hvid, grøn, gul eller rød")
    return c


def _no_secrets(node, where: str = "", names: bool = False) -> None:
    """Refuses descriptions that carry a key instead of naming an environment variable. Under felter and parametre
    the keys are field names (a field may well be called key), so only their settings are checked."""
    if isinstance(node, dict):
        for k, v in node.items():
            name = str(k).strip().lower()
            if not names and name in SECRET_KEYS and v not in (None, ""):
                raise SpecError(f"{where}{k}: læg aldrig en nøgle i beskrivelsen. Brug auth.hemmelighed med navnet "
                                "på en miljøvariabel (DATA_SECRET_…)")
            _no_secrets(v, f"{where}{k}.", names=not names and name in ("felter", "parametre"))
    elif isinstance(node, list):
        for item in node:
            _no_secrets(item, where)


def parse_spec(text: str) -> dict:
    """Validates a kildebeskrivelse and returns it normalized. Raises SpecError."""
    if len(text.encode()) > MAX_SPEC_BYTES:
        raise SpecError("Beskrivelsen er for stor")
    try:
        raw = yaml.safe_load(text)
    except yaml.YAMLError as e:
        mark = getattr(e, "problem_mark", None)
        where = f" (linje {mark.line + 1})" if mark else ""
        raise SpecError(f"Beskrivelsen er ikke gyldig YAML{where}")
    if not isinstance(raw, dict):
        raise SpecError("Beskrivelsen skal være et YAML-objekt med kilde, navn, type, base_url og datasæt")
    _no_secrets(raw)

    key = _str(raw.get("kilde"), "kilde").lower()
    if not KEY_RE.match(key):
        raise SpecError("kilde må kun indeholde små bogstaver, tal, - og _ (højst 40 tegn)")
    kind = _str(raw.get("type", "rest"), "type").lower()
    if kind != "rest":
        raise SpecError(f"type: {kind} er ikke understøttet endnu. Brug rest")

    base_url = _str(raw.get("base_url"), "base_url", max_len=300).rstrip("/")
    parts = urlsplit(base_url)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        raise SpecError("base_url skal være en https-adresse uden brugernavn, ? eller #")
    host = parts.hostname.lower()

    auth_raw = raw.get("auth") or {}
    if not isinstance(auth_raw, dict):
        raise SpecError("auth skal være et objekt")
    auth_type = _str(auth_raw.get("type", "ingen"), "auth.type").lower()
    if auth_type not in ("ingen", "bearer", "header"):
        raise SpecError("auth.type skal være ingen, bearer eller header")
    auth = {"type": auth_type, "secret": None, "header": None}
    if auth_type != "ingen":
        secret = _str(auth_raw.get("hemmelighed"), "auth.hemmelighed")
        if not SECRET_NAME_RE.match(secret):
            raise SpecError("auth.hemmelighed skal være navnet på en miljøvariabel, der starter med DATA_SECRET_")
        auth["secret"] = secret
        if auth_type == "header":
            header = _str(auth_raw.get("header"), "auth.header", max_len=60)
            if not re.match(r"^[A-Za-z0-9-]+$", header) or header.lower() in ("host", "cookie", "content-length"):
                raise SpecError("auth.header er ikke et gyldigt headernavn")
            auth["header"] = header

    limits_raw = raw.get("grænser") or raw.get("graenser") or {}
    if not isinstance(limits_raw, dict):
        raise SpecError("grænser skal være et objekt")
    try:
        limits = {"per_minute": max(1, min(int(limits_raw.get("kald_pr_minut", 60)), 600)),
                  "timeout": max(1, min(float(limits_raw.get("timeout_s", 10)), 30)),
                  "cache_min": max(0, min(int(limits_raw.get("cache_min", 10)), 1440))}
    except (TypeError, ValueError):
        raise SpecError("grænser skal være tal")

    sets_raw = raw.get("datasæt") or raw.get("datasaet")
    if not isinstance(sets_raw, list) or not sets_raw:
        raise SpecError("datasæt skal være en liste med mindst ét datasæt")
    if len(sets_raw) > MAX_DATASETS:
        raise SpecError(f"Højst {MAX_DATASETS} datasæt pr. kilde")
    default_class = _classification(raw.get("klassifikation"), "yellow", "kilde")
    datasets, seen = [], set()
    for i, d in enumerate(sets_raw, 1):
        datasets.append(_parse_dataset(d, i, default_class, seen))
    return {"key": key, "name": _str(raw.get("navn"), "navn", max_len=120), "kind": kind, "base_url": base_url,
            "host": host, "auth": auth, "limits": limits, "datasets": datasets}


def _parse_dataset(d, i: int, default_class: str, seen: set) -> dict:
    if not isinstance(d, dict):
        raise SpecError(f"datasæt nr. {i} skal være et objekt")
    key = _str(d.get("id"), f"datasæt nr. {i}: id").lower()
    if not KEY_RE.match(key):
        raise SpecError(f"datasæt {key}: id må kun indeholde små bogstaver, tal, - og _")
    if key in seen:
        raise SpecError(f"datasæt {key} findes to gange")
    seen.add(key)
    where = f"datasæt {key}"
    call = _str(d.get("kald"), f"{where}: kald").split()
    if len(call) != 2 or call[0].upper() != "GET":
        raise SpecError(f"{where}: kald skal have formen 'GET /sti'")
    path = call[1]
    if not path.startswith("/") or "://" in path or ".." in path or "?" in path or "#" in path:
        raise SpecError(f"{where}: stien skal starte med / og må ikke indeholde ?, # eller ..")
    classification = _classification(d.get("klassifikation"), default_class, where)

    params = {}
    for name, p in (d.get("parametre") or {}).items():
        if not FIELD_RE.match(str(name)):
            raise SpecError(f"{where}: parameteren {name} har et ugyldigt navn")
        p = p or {}
        if not isinstance(p, dict):
            raise SpecError(f"{where}: parameteren {name} skal være et objekt")
        params[str(name)] = {"label": _str(p.get("navn"), "navn", required=False, max_len=80) or str(name),
                             "data_type": DATA_TYPES.get(str(p.get("type", "tekst")).lower(), "text")}

    paging = None
    if d.get("sider"):
        s = d["sider"]
        if not isinstance(s, dict) or s.get("type") != "side":
            raise SpecError(f"{where}: sider understøtter kun type: side")
        page_param, size_param = _str(s.get("parameter"), f"{where}: sider.parameter"), _str(s.get("størrelse"), f"{where}: sider.størrelse")
        if not FIELD_RE.match(page_param) or not FIELD_RE.match(size_param):
            raise SpecError(f"{where}: sider.parameter og sider.størrelse skal være parameternavne")
        paging = {"param": page_param, "size_param": size_param, "max": max(1, min(int(s.get("max", 100)), MAX_ROWS))}

    rows = _str(d.get("rækker", d.get("raekker", "$[*]")), f"{where}: rækker")
    if not ROWS_RE.match(rows):
        raise SpecError(f"{where}: rækker skal være en JSONPath som $[*] eller $.data.items[*]")

    fields_raw = d.get("felter")
    if not isinstance(fields_raw, dict) or not fields_raw:
        raise SpecError(f"{where}: felter skal være et objekt med mindst ét felt")
    if len(fields_raw) > MAX_FIELDS:
        raise SpecError(f"{where}: højst {MAX_FIELDS} felter")
    fields = []
    for pos, (name, f) in enumerate(fields_raw.items()):
        if not FIELD_RE.match(str(name)):
            raise SpecError(f"{where}: feltet {name} har et ugyldigt navn")
        f = f or {}
        if not isinstance(f, dict):
            raise SpecError(f"{where}: feltet {name} skal være et objekt")
        fpath = _str(f.get("sti"), "sti", required=False) or str(name)
        if not PATH_RE.match(fpath):
            raise SpecError(f"{where}: feltet {name} har en ugyldig sti")
        fields.append({"name": str(name), "path": fpath, "label": _str(f.get("navn"), "navn", required=False, max_len=80),
                       "description": _str(f.get("beskrivelse"), "beskrivelse", required=False, max_len=500),
                       "data_type": DATA_TYPES.get(str(f.get("type", "tekst")).lower(), "text"),
                       "classification": _classification(f.get("klassifikation"), classification, f"{where}: {name}"),
                       "position": pos})
    return {"key": key, "name": _str(d.get("navn"), f"{where}: navn", max_len=120),
            "description": _str(d.get("beskrivelse"), "beskrivelse", required=False, max_len=1000),
            "classification": classification, "method": "GET", "path": path, "params": params, "paging": paging,
            "rows": rows, "id_field": _str(d.get("nøgle", d.get("noegle")), "nøgle", required=False, max_len=63) or None,
            "fields": fields}


def dataset_spec(spec: dict, key: str) -> dict:
    for d in spec["datasets"]:
        if d["key"] == key:
            return d
    raise SpecError(f"Datasættet {key} findes ikke i beskrivelsen")


# ── Calling the API ─────────────────────────────────────────────────────────

_calls: dict[str, deque] = {}
_cache: dict[str, tuple[float, object]] = {}


def _is_public(address: str) -> bool:
    ip = ipaddress.ip_address(address)
    return not (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast
                or ip.is_unspecified)


async def check_host(host: str) -> None:
    """Refuses hosts that resolve to an address inside the network (the database, the metadata service …)."""
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except OSError:
        raise FetchError(f"Kan ikke slå {host} op")
    addresses = {i[4][0] for i in infos}
    if not addresses or not all(_is_public(a) for a in addresses):
        raise FetchError(f"{host} peger på en intern adresse og må ikke kaldes")


def _rate_limit(key: str, per_minute: int) -> None:
    now = time.monotonic()
    q = _calls.setdefault(key, deque())
    while q and now - q[0] > 60:
        q.popleft()
    if len(q) >= per_minute:
        raise FetchError(f"Grænsen på {per_minute} kald pr. minut er nået. Prøv igen om lidt")
    q.append(now)


async def http_get_json(url: str, headers: dict, timeout: float):
    """One GET without redirects. Returns the parsed JSON. Replaced in tests."""
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            async with client.stream("GET", url, headers=headers) as r:
                if r.status_code >= 300:
                    raise FetchError(f"API'et svarede {r.status_code}")
                body = b""
                async for chunk in r.aiter_bytes():
                    body += chunk
                    if len(body) > MAX_RESPONSE_BYTES:
                        raise FetchError("Svaret er for stort (over 5 MB)")
    except httpx.TimeoutException:
        raise FetchError(f"API'et svarede ikke inden for {timeout:g} sekunder")
    except httpx.HTTPError:
        raise FetchError("Kunne ikke forbinde til API'et")
    try:
        return json.loads(body)
    except ValueError:
        raise FetchError("Svaret er ikke JSON")


def _headers(spec: dict) -> dict:
    headers = {"Accept": "application/json", "User-Agent": "Gaer-data/1"}
    auth = spec["auth"]
    if auth["type"] == "ingen":
        return headers
    value = config.data_secret(auth["secret"])
    if not value:
        raise FetchError(f"Miljøvariablen {auth['secret']} er ikke sat på instansen")
    if auth["type"] == "bearer":
        headers["Authorization"] = f"Bearer {value}"
    else:
        headers[auth["header"]] = value
    return headers


def extract_rows(payload, rows_path: str) -> list:
    node = payload
    parts = rows_path[1:].replace("[*]", "")
    for name in [p for p in parts.split(".") if p]:
        if not isinstance(node, dict) or name not in node:
            raise FetchError(f"Svaret har ikke {rows_path}")
        node = node[name]
    if isinstance(node, dict):
        node = [node]
    if not isinstance(node, list):
        raise FetchError(f"{rows_path} peger ikke på en liste")
    return node


def pick(row, path: str):
    node = row
    for name in path.split("."):
        if not isinstance(node, dict):
            return None
        node = node.get(name)
    if isinstance(node, (dict, list)):
        return json.dumps(node, ensure_ascii=False)[:500]
    return node


async def fetch(spec: dict, ds: dict, params: dict[str, str], page: int | None = None, size: int | None = None) -> dict:
    """Calls the dataset's endpoint and returns {"url", "rows" (by field name), "raw", "ms", "cached"}."""
    query = {k: v for k, v in params.items() if k in ds["params"] and v not in (None, "")}
    if ds["paging"] and page is not None:
        query[ds["paging"]["param"]] = str(page)
        query[ds["paging"]["size_param"]] = str(min(size or 50, ds["paging"]["max"]))
    url = spec["base_url"] + ds["path"] + (("?" + urlencode(query)) if query else "")
    if urlsplit(url).hostname != spec["host"]:
        raise FetchError("Adressen peger uden for kildens vært")

    hit = _cache.get(url)
    if hit and hit[0] > time.monotonic():
        payload, cached, ms = hit[1], True, 0
    else:
        headers = _headers(spec)
        await check_host(spec["host"])
        _rate_limit(spec["key"], spec["limits"]["per_minute"])
        start = time.monotonic()
        payload = await http_get_json(url, headers, spec["limits"]["timeout"])
        ms, cached = round((time.monotonic() - start) * 1000), False
        if spec["limits"]["cache_min"]:
            if len(_cache) >= CACHE_ENTRIES:
                _cache.pop(next(iter(_cache)))
            _cache[url] = (time.monotonic() + spec["limits"]["cache_min"] * 60, payload)
    raw = extract_rows(payload, ds["rows"])[:MAX_ROWS]
    rows = [{f["name"]: pick(r, f["path"]) for f in ds["fields"]} for r in raw]
    return {"url": url, "rows": rows, "raw": raw[:3], "ms": ms, "cached": cached}


def clear_cache() -> None:
    _cache.clear()
    _calls.clear()
