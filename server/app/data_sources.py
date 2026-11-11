"""API sources for /admin → Data: the kildebeskrivelse (YAML) and the calls the server makes for it.

Rules (specs/admin-app/DATA.md):
- Only the server calls an API, and only over https to the hosts named in the description. Hosts that resolve to
  private, loopback or link-local addresses are refused, and redirects are not followed.
- The description never holds a secret. `auth.hemmelighed` (and `headers.<navn>.hemmelighed`) names a secret in
  Hemmeligheder as "gruppe/navn" or "gruppe/navn@miljø", which the source may only use while it holds an approved grant
  "Brug i kilde" (app/source_secrets.py), or an environment variable starting with DATA_SECRET_ (the older way). A
  description can therefore never send DATABASE_URL or SECRET_KEY to another host.
- Sign-in: ingen, bearer, header, basic (brugernavn + hemmelighed) or oauth2 (client credentials: token_url,
  client_id, hemmelighed = client secret, scope). The token host is checked like the API host and is one of the
  source's hosts. Tokens are kept in memory until shortly before they expire.
- Every call has a timeout, a size limit, a per-source limit per minute and a short in-memory cache.
"""

import asyncio
import base64
import hashlib
import ipaddress
import json
import re
import socket
import time
from collections import deque
from urllib.parse import urlencode, urlsplit

import httpx
import yaml

from app import config, integrations

CLASSIFICATION = {"hvid": "white", "grøn": "green", "groen": "green", "gul": "yellow", "rød": "red", "roed": "red",
                  "white": "white", "green": "green", "yellow": "yellow", "red": "red"}
DATA_TYPES = {"tekst": "text", "text": "text", "tal": "number", "number": "number", "heltal": "number",
              "uuid": "uuid", "dato": "date", "date": "date", "bool": "boolean", "boolean": "boolean", "json": "json"}
KEY_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
FIELD_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")
PATH_RE = re.compile(r"^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$")
ROWS_RE = re.compile(r"^\$(\.[A-Za-z0-9_]+)*(\[\*\])?$")
SECRET_NAME_RE = re.compile(r"^DATA_SECRET_[A-Z0-9_]{1,60}$")
# gruppe/navn or gruppe/navn@miljø: the group's slug, the secret's name (no / or @) and its optional environment.
SECRET_REF_RE = re.compile(r"^(?P<group>[a-z0-9][a-z0-9-]{0,62})/(?P<name>[^/@\s][^/@\n]{0,118}[^/@\s]|[^/@\s])"
                           r"(?:@(?P<env>[^/@\s]{1,40}))?$")
HEADER_RE = re.compile(r"^[A-Za-z0-9-]{1,60}$")
FORBIDDEN_HEADERS = {"host", "cookie", "content-length", "transfer-encoding", "connection"}
AUTH_TYPES = ("ingen", "bearer", "header", "basic", "oauth2")
MAX_HEADERS = 5
TOKEN_MARGIN_S = 60
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
                raise SpecError(f"{where}{k}: læg aldrig en nøgle i beskrivelsen. Brug hemmelighed: gruppe/navn "
                                "fra Hemmeligheder")
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

    auth, auth_hosts = _parse_auth(raw.get("auth") or {})

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
    secrets = ([{"ref": auth["secret"], "used_as": "auth"}] if auth["secret"] else []) \
        + [{"ref": h["secret"], "used_as": f"header:{h['name']}"} for h in auth["headers"]]
    hosts = [host] + [h for h in auth_hosts if h != host]
    return {"key": key, "name": _str(raw.get("navn"), "navn", max_len=120), "kind": kind, "base_url": base_url,
            "host": host, "hosts": hosts, "auth": auth, "secrets": secrets, "limits": limits, "datasets": datasets}


def parse_secret_ref(value: str, what: str) -> str:
    """A secret's name in a description: gruppe/navn[@miljø] (Hemmeligheder) or DATA_SECRET_… (environment)."""
    ref = _str(value, what, max_len=200)
    if SECRET_NAME_RE.match(ref) or SECRET_REF_RE.match(ref):
        return ref
    raise SpecError(f"{what} skal være en hemmelighed som gruppe/navn (eller gruppe/navn@miljø) fra Hemmeligheder, "
                    "eller en miljøvariabel, der starter med DATA_SECRET_")


def is_env_ref(ref: str) -> bool:
    return bool(SECRET_NAME_RE.match(ref))


def _secret_of(node, what: str) -> str:
    if isinstance(node, dict):
        return parse_secret_ref(node.get("hemmelighed"), f"{what}.hemmelighed")
    return parse_secret_ref(node, what)


def _parse_auth(auth_raw) -> tuple[dict, list[str]]:
    if not isinstance(auth_raw, dict):
        raise SpecError("auth skal være et objekt")
    auth_type = _str(auth_raw.get("type", "ingen"), "auth.type").lower()
    if auth_type not in AUTH_TYPES:
        raise SpecError("auth.type skal være ingen, bearer, header, basic eller oauth2")
    auth = {"type": auth_type, "secret": None, "header": None, "username": None, "token_url": None, "client_id": None,
            "scope": None, "headers": []}
    hosts: list[str] = []
    if auth_type != "ingen":
        auth["secret"] = parse_secret_ref(auth_raw.get("hemmelighed"), "auth.hemmelighed")
    if auth_type == "header":
        header = _str(auth_raw.get("header"), "auth.header", max_len=60)
        if not HEADER_RE.match(header) or header.lower() in FORBIDDEN_HEADERS:
            raise SpecError("auth.header er ikke et gyldigt headernavn")
        auth["header"] = header
    elif auth_type == "basic":
        auth["username"] = _str(auth_raw.get("brugernavn"), "auth.brugernavn", max_len=120)
    elif auth_type == "oauth2":
        token_url = _str(auth_raw.get("token_url"), "auth.token_url", max_len=300)
        parts = urlsplit(token_url)
        if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or parts.fragment:
            raise SpecError("auth.token_url skal være en https-adresse uden brugernavn eller #")
        auth["token_url"] = token_url
        auth["client_id"] = _str(auth_raw.get("client_id"), "auth.client_id", max_len=200)
        auth["scope"] = _str(auth_raw.get("scope"), "auth.scope", required=False, max_len=300) or None
        hosts.append(parts.hostname.lower())
    headers_raw = auth_raw.get("headers") or {}
    if not isinstance(headers_raw, dict):
        raise SpecError("auth.headers skal være et objekt med headernavn: { hemmelighed: gruppe/navn }")
    if len(headers_raw) > MAX_HEADERS:
        raise SpecError(f"Højst {MAX_HEADERS} ekstra headers")
    taken = {"authorization", (auth["header"] or "").lower()}
    for name, node in headers_raw.items():
        name = str(name).strip()
        if not HEADER_RE.match(name) or name.lower() in FORBIDDEN_HEADERS or name.lower() in taken:
            raise SpecError(f"auth.headers: {name} er ikke et gyldigt headernavn her")
        taken.add(name.lower())
        auth["headers"].append({"name": name, "secret": _secret_of(node, f"auth.headers.{name}")})
    return auth, hosts


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


async def http_post_form(url: str, data: dict, timeout: float) -> dict:
    """The OAuth 2 token call: one POST without redirects. Returns the parsed JSON. Replaced in tests."""
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            r = await client.post(url, data=data, headers={"Accept": "application/json", "User-Agent": "Gaer-data/1"})
    except httpx.TimeoutException:
        raise FetchError(f"Token-adressen svarede ikke inden for {timeout:g} sekunder")
    except httpx.HTTPError:
        raise FetchError("Kunne ikke forbinde til token-adressen")
    if r.status_code >= 300:
        raise FetchError(f"Token-adressen svarede {r.status_code}. Tjek client_id, hemmeligheden og scope")
    if len(r.content) > 100_000:
        raise FetchError("Svaret fra token-adressen er for stort")
    try:
        body = r.json()
    except ValueError:
        raise FetchError("Svaret fra token-adressen er ikke JSON")
    if not isinstance(body, dict) or not isinstance(body.get("access_token"), str):
        raise FetchError("Svaret fra token-adressen har intet access_token")
    return body


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


_tokens: dict[str, tuple[float, str]] = {}


def _value(secrets: dict[str, str], ref: str) -> str:
    value = secrets.get(ref) or (config.data_secret(ref) if is_env_ref(ref) else None)
    if not value:
        if is_env_ref(ref):
            raise FetchError(f"Miljøvariablen {ref} er ikke sat på instansen")
        raise FetchError(f"Kilden har ikke adgang til hemmeligheden {ref}. Anmod om Brug i kilde under Forbind API")
    return value


async def _oauth_token(spec: dict, client_secret: str) -> str:
    auth = spec["auth"]
    fingerprint = hashlib.sha256(f"{auth['token_url']}|{auth['client_id']}|{client_secret}".encode()).hexdigest()
    hit = _tokens.get(fingerprint)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    await check_host(urlsplit(auth["token_url"]).hostname)
    data = {"grant_type": "client_credentials", "client_id": auth["client_id"], "client_secret": client_secret}
    if auth["scope"]:
        data["scope"] = auth["scope"]
    start = time.monotonic()
    try:
        body = await http_post_form(auth["token_url"], data, spec["limits"]["timeout"])
    except FetchError as e:
        status = int(m.group(1)) if (m := re.search(r"svarede (\d{3})", str(e))) else 0
        await integrations.record_source_call(spec["key"], "POST", "token", (time.monotonic() - start) * 1000, status)
        raise
    await integrations.record_source_call(spec["key"], "POST", "token", (time.monotonic() - start) * 1000, 200)
    try:
        lifetime = max(0, int(body.get("expires_in") or 300) - TOKEN_MARGIN_S)
    except (TypeError, ValueError):
        lifetime = 240
    if lifetime:
        _tokens[fingerprint] = (time.monotonic() + lifetime, body["access_token"])
    return body["access_token"]


async def build_headers(spec: dict, secrets: dict[str, str]) -> dict:
    """The request headers with the secrets filled in. `secrets` maps each name in spec["secrets"] to its value
    (app/source_secrets.py resolves them); a missing one stops the call with a Danish message."""
    headers = {"Accept": "application/json", "User-Agent": "Gaer-data/1"}
    auth = spec["auth"]
    extra = {h["name"]: _value(secrets, h["secret"]) for h in auth["headers"]}  # all present before any call
    if auth["type"] == "bearer":
        headers["Authorization"] = f"Bearer {_value(secrets, auth['secret'])}"
    elif auth["type"] == "header":
        headers[auth["header"]] = _value(secrets, auth["secret"])
    elif auth["type"] == "basic":
        pair = f"{auth['username']}:{_value(secrets, auth['secret'])}".encode()
        headers["Authorization"] = "Basic " + base64.b64encode(pair).decode()
    elif auth["type"] == "oauth2":
        headers["Authorization"] = f"Bearer {await _oauth_token(spec, _value(secrets, auth['secret']))}"
    headers.update(extra)
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


async def fetch(spec: dict, ds: dict, params: dict[str, str], page: int | None = None, size: int | None = None,
                secrets: dict[str, str] | None = None) -> dict:
    """Calls the dataset's endpoint and returns {"url", "rows" (by field name), "raw", "ms", "cached"}. The secrets are
    checked before the cache, so a source that loses its access stops answering at once."""
    query = {k: v for k, v in params.items() if k in ds["params"] and v not in (None, "")}
    if ds["paging"] and page is not None:
        query[ds["paging"]["param"]] = str(page)
        query[ds["paging"]["size_param"]] = str(min(size or 50, ds["paging"]["max"]))
    url = spec["base_url"] + ds["path"] + (("?" + urlencode(query)) if query else "")
    if urlsplit(url).hostname != spec["host"]:
        raise FetchError("Adressen peger uden for kildens vært")

    headers = await build_headers(spec, secrets or {})
    hit = _cache.get(url)
    if hit and hit[0] > time.monotonic():
        payload, cached, ms = hit[1], True, 0
    else:
        await check_host(spec["host"])
        _rate_limit(spec["key"], spec["limits"]["per_minute"])
        start = time.monotonic()
        try:
            payload = await http_get_json(url, headers, spec["limits"]["timeout"])
        except FetchError as e:
            status = int(m.group(1)) if (m := re.search(r"svarede (\d{3})", str(e))) else 0
            await integrations.record_source_call(spec["key"], "GET", ds["path"], (time.monotonic() - start) * 1000, status)
            raise
        ms, cached = round((time.monotonic() - start) * 1000), False
        await integrations.record_source_call(spec["key"], "GET", ds["path"], ms, 200)
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
    _tokens.clear()
