"""Read NATS' HTTP monitoring endpoints (NATS_MONITOR_URL, port 8222 in the stack) for /admin/nats.

Only the endpoints and query parameters listed in ENDPOINTS can be asked for, so /admin cannot be used to reach
anything else on the monitoring port. NATS' monitoring port is read only; nothing here changes the NATS server.
Values that look like secrets (tokens, passwords) are masked before they leave the app.
"""

import re
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit

import httpx

from app import config

# Replaced in tests with an httpx.MockTransport.
transport: httpx.AsyncBaseTransport | None = None

_BOOL = {"true", "false", "1", "0"}
_NAME = re.compile(r"^[A-Za-z0-9_.$:\-]{1,128}$")


def _int(lo: int, hi: int):
    def check(v: str) -> bool:
        return v.isdigit() and lo <= int(v) <= hi
    return check


def _one_of(*values: str):
    return lambda v: v in values


def _bool(v: str) -> bool:
    return v in _BOOL


def _name(v: str) -> bool:
    return bool(_NAME.match(v))


CONN_SORT = ("cid", "start", "subs", "pending", "msgs_to", "msgs_from", "bytes_to", "bytes_from", "last", "idle",
             "uptime", "stop", "reason", "rtt")

# Endpoint → (description, allowed query parameters with a validator each).
ENDPOINTS: dict[str, tuple[str, dict]] = {
    "varz": ("Server: version, ressourcer, beskeder og grænser", {}),
    "healthz": ("Sundhedstjek", {"js-enabled-only": _bool, "js-server-only": _bool}),
    "connz": ("Forbindelser", {
        "sort": _one_of(*CONN_SORT), "limit": _int(1, 1024), "offset": _int(0, 1_000_000),
        "state": _one_of("open", "closed", "any"), "subs": _one_of("true", "false", "1", "0", "detail"),
        "auth": _bool, "cid": _int(1, 10**12), "acc": _name,
    }),
    "routez": ("Cluster-ruter", {"subs": _one_of("true", "false", "1", "0", "detail")}),
    "gatewayz": ("Gateways (superclusters)", {"accs": _bool, "gw_name": _name, "acc_name": _name}),
    "leafz": ("Leaf nodes", {"subs": _bool}),
    "subsz": ("Abonnementer", {"subs": _bool, "limit": _int(1, 1024), "offset": _int(0, 1_000_000), "test": _name,
                               "acc": _name}),
    "jsz": ("JetStream: streams, consumers og lager", {
        "accounts": _bool, "streams": _bool, "consumers": _bool, "config": _bool, "leader-only": _bool,
        "limit": _int(1, 1024), "offset": _int(0, 1_000_000), "acc": _name, "raft": _bool,
    }),
    "accountz": ("Konti", {"acc": _name, "unused": _bool}),
    "accstatz": ("Statistik pr. konto", {"unused": _bool, "acc": _name}),
}

_SECRET_KEYS = {"token", "auth_token", "password", "pass", "secret"}


class MonitorError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def configured() -> bool:
    return bool(config.settings.nats_monitor_url)


def redact_url(url: str | None) -> str | None:
    """nats://token@nats:4222 → nats://••••@nats:4222 (never show credentials in /admin)."""
    if not url:
        return None
    parts = urlsplit(url)
    if parts.username or parts.password:
        host = parts.hostname or ""
        if parts.port:
            host = f"{host}:{parts.port}"
        return urlunsplit((parts.scheme, f"••••@{host}", parts.path, parts.query, ""))
    return url


def scrub(value):
    """Mask secret-looking fields anywhere in a monitoring response."""
    if isinstance(value, dict):
        return {k: ("••••" if k.lower() in _SECRET_KEYS and isinstance(v, str) and v else scrub(v))
                for k, v in value.items()}
    if isinstance(value, list):
        return [scrub(v) for v in value]
    return value


def check_params(endpoint: str, params: dict[str, str]) -> dict[str, str]:
    if endpoint not in ENDPOINTS:
        raise MonitorError(404, "Ukendt NATS-endpoint")
    allowed = ENDPOINTS[endpoint][1]
    clean = {}
    for key, value in params.items():
        check = allowed.get(key)
        if check is None:
            raise MonitorError(400, f"Parameteren {key} er ikke tilladt for {endpoint}")
        if not check(value):
            raise MonitorError(400, f"Ugyldig værdi for {key}")
        clean[key] = value
    return clean


async def fetch(endpoint: str, params: dict[str, str] | None = None) -> tuple[int, dict]:
    """GET one monitoring endpoint. Returns (HTTP status, JSON). healthz answers 503 with a JSON body when NATS is
    unhealthy; that is a result, not an error."""
    base = config.settings.nats_monitor_url
    if not base:
        raise MonitorError(503, "NATS er ikke sat op (NATS_MONITOR_URL mangler)")
    clean = check_params(endpoint, params or {})
    url = f"{base.rstrip('/')}/{endpoint}"
    try:
        async with httpx.AsyncClient(transport=transport, timeout=config.settings.nats_monitor_timeout) as client:
            r = await client.get(url, params=clean)
    except httpx.HTTPError as e:
        raise MonitorError(502, f"NATS svarer ikke ({type(e).__name__})")
    if r.status_code >= 400 and not (endpoint == "healthz" and r.status_code == 503):
        raise MonitorError(502, f"NATS svarede {r.status_code} på /{endpoint}")
    try:
        data = r.json()
    except ValueError:
        raise MonitorError(502, f"NATS svarede ikke med JSON på /{endpoint}")
    if not isinstance(data, dict):
        data = {"value": data}
    return r.status_code, scrub(data)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()
