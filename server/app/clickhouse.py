"""ClickHouse in the stack: short-lived events and analytics, deleted by ClickHouse itself after TTL_DAYS (7).

Rules (see .gaer/agents/instructions.md):
- Postgres is still the system of record. ClickHouse holds data that may disappear after 7 days: events, counters,
  metrics. Nothing in it is needed to run the app, so the app works when ClickHouse is down or not configured.
- No personal data: no user ids, e-mail addresses, phone numbers, IPs or free text from users. Store ids of objects
  and numbers. That keeps ClickHouse out of the GDPR export and erasure.
- Every table has a TTL of at most TTL_DAYS. The schema lives in app/clickhouse_migrations/*.sql (new files only,
  never edit an applied one) and is applied by `python -m app.migrate`. /admin/resources warns about a table
  without TTL and about rows older than TTL_DAYS.
- Write in batches (insert() takes many rows); ClickHouse prefers few large inserts to many small ones.

Talks to the HTTP interface (CLICKHOUSE_URL, port 8123) with httpx; no extra driver.
"""

import json
import pathlib
import re
import time

import httpx

from app import config

TTL_DAYS = 7
MIGRATIONS_DIR = pathlib.Path(__file__).parent / "clickhouse_migrations"
MIGRATIONS_TABLE = "gaer_migrations"

# Replaced in tests with an httpx.MockTransport.
transport: httpx.AsyncBaseTransport | None = None

_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")


class ClickHouseError(Exception):
    pass


def configured() -> bool:
    return bool(config.settings.clickhouse_url)


def _headers() -> dict:
    s = config.settings
    headers = {"X-ClickHouse-User": s.clickhouse_user}
    if s.clickhouse_password:
        headers["X-ClickHouse-Key"] = s.clickhouse_password
    return headers


def _params(params: dict | None, database: bool = True) -> dict:
    out = {"database": config.settings.clickhouse_database} if database else {}
    for key, value in (params or {}).items():
        if not _IDENT.match(key):
            raise ValueError(f"bad parameter name {key!r}")
        out[f"param_{key}"] = str(value)
    return out


def _error(r: httpx.Response) -> ClickHouseError:
    text = r.text.strip().splitlines()[0] if r.text.strip() else f"HTTP {r.status_code}"
    return ClickHouseError(text[:300])


async def _post(body: str, params: dict) -> httpx.Response:
    if not configured():
        raise ClickHouseError("ClickHouse er ikke sat op")
    s = config.settings
    try:
        async with httpx.AsyncClient(transport=transport, timeout=s.clickhouse_timeout) as client:
            r = await client.post(s.clickhouse_url.rstrip("/") + "/", params=params, content=body.encode(),
                                  headers=_headers())
    except httpx.HTTPError as e:
        raise ClickHouseError(f"ClickHouse svarer ikke ({type(e).__name__})") from e
    if r.status_code != 200:
        raise _error(r)
    return r


async def query(sql: str, params: dict | None = None) -> list[dict]:
    """A SELECT. Values go in as ClickHouse query parameters: `where kind = {kind:String}` with params={"kind": …}."""
    r = await _post(sql, {**_params(params), "default_format": "JSON", "output_format_json_quote_64bit_integers": "0"})
    return r.json().get("data", [])


async def command(sql: str, params: dict | None = None) -> None:
    await _post(sql, _params(params))


async def insert(table: str, rows: list[dict]) -> int:
    """Insert many rows at once (JSONEachRow). Returns the number of rows sent."""
    if not _IDENT.match(table):
        raise ValueError(f"bad table name {table!r}")
    if not rows:
        return 0
    body = f"INSERT INTO {table} FORMAT JSONEachRow\n" + "\n".join(json.dumps(r, default=str) for r in rows)
    await _post(body, _params(None))
    return len(rows)


# ── Schema (python -m app.migrate) ──────────────────────────────────────────

def migration_files() -> list[pathlib.Path]:
    return sorted(MIGRATIONS_DIR.glob("*.sql"))


def statements(sql: str) -> list[str]:
    """One file → its statements (the HTTP interface takes one per request). Comments and blank lines are dropped."""
    lines = [line for line in sql.splitlines() if not line.strip().startswith("--")]
    return [s.strip() for s in "\n".join(lines).split(";") if s.strip()]


def migrate(verbose: bool = True, wait_seconds: float = 60) -> list[str]:
    """Create the database and apply new files in app/clickhouse_migrations/. Waits for ClickHouse to start (deploy
    runs migrations right after `compose up`). Does nothing when CLICKHOUSE_URL is not set."""
    if not configured():
        if verbose:
            print("clickhouse: not configured (CLICKHOUSE_URL), skipped")
        return []
    s = config.settings
    if not _IDENT.match(s.clickhouse_database):
        raise ClickHouseError(f"bad CLICKHOUSE_DATABASE {s.clickhouse_database!r}")
    url = s.clickhouse_url.rstrip("/") + "/"
    with httpx.Client(timeout=max(s.clickhouse_timeout, 30), headers=_headers()) as client:
        def run(sql: str, database: bool = True, fmt: str | None = None) -> httpx.Response:
            params = {"database": s.clickhouse_database} if database else {}
            if fmt:
                params["default_format"] = fmt
            r = client.post(url, params=params, content=sql.encode())
            if r.status_code != 200:
                raise _error(r)
            return r

        deadline = time.monotonic() + wait_seconds
        while True:
            try:
                run("SELECT 1", database=False)
                break
            except (httpx.HTTPError, ClickHouseError):
                if time.monotonic() > deadline:
                    raise
                time.sleep(2)

        run(f"CREATE DATABASE IF NOT EXISTS {s.clickhouse_database}", database=False)
        run(f"""CREATE TABLE IF NOT EXISTS {MIGRATIONS_TABLE} (name String, applied_at DateTime DEFAULT now())
                ENGINE = ReplacingMergeTree ORDER BY name""")
        done = {row["name"] for row in run(f"SELECT name FROM {MIGRATIONS_TABLE}", fmt="JSON").json()["data"]}
        applied: list[str] = []
        for path in migration_files():
            if path.name in done:
                continue
            if verbose:
                print(f"clickhouse: migrating {path.name}")
            for statement in statements(path.read_text()):
                run(statement)
            run(f"INSERT INTO {MIGRATIONS_TABLE} (name) VALUES ('{path.name}')")
            applied.append(path.name)
    if verbose:
        print(f"clickhouse: {len(applied)} migration(s) applied" if applied else "clickhouse: up to date")
    return applied
