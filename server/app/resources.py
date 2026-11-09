"""/admin/resources: every resource the instance uses, with how much is used, the limit and an estimated price.

Measured live on each request; nothing is stored except the admin's own limits and prices (setting "resources").
Each source is measured on its own, so one that fails (NATS down, ClickHouse not set up) shows as an error row
and the rest of the page still works.

- Server and container: cgroup v2 (/sys/fs/cgroup: cpu.max, cpu.stat, memory.max, memory.current), else the load
  average and /proc/meminfo; disk from the container's root filesystem.
- Postgres: pg_database_size, pg_stat_activity, max_connections.
- ClickHouse: system.parts, system.disks, system.metrics, system.server_settings; TTL of every table; rows older
  than clickhouse.TTL_DAYS.
- Object Storage: the sizes the app recorded (files, knowledge_documents) — the bucket itself is not listed.
- NATS: varz from the monitoring port (app.nats_monitor).
- AI: ai_usage this calendar month. E-mail and SMS: one-time codes sent this month (auth_log otp.sent).
- Jobs: the queue in Postgres.

Prices: per resource a fixed amount per month (`monthly`, e.g. the server) and/or a price per unit of use
(`unit_price`: per GB, per million tokens, per mail or SMS). Limits: `max` overrides or supplies a limit the app
cannot measure (Object Storage quota, a mail plan). Both are set in /admin/resources and audited.
"""

import asyncio
import os
import pathlib
import shutil
import time
from datetime import datetime, timezone

from app import ai, clickhouse, config, db, nats_monitor, settings_store

CGROUP = pathlib.Path("/sys/fs/cgroup")
PROC_MEMINFO = pathlib.Path("/proc/meminfo")
DISK_PATH = "/"
CPU_SAMPLE_SECONDS = 0.25

GB = 1_000_000_000

# key → (category, unit, price unit). unit: bytes | vcpu | count | tokens | seconds.
# price unit: gb (per GB in use), mtokens (per million tokens), piece (per mail/SMS), None (only a fixed price).
RESOURCES: dict[str, tuple[str, str, str | None]] = {
    "cpu": ("server", "vcpu", None),
    "memory": ("server", "bytes", None),
    "disk": ("server", "bytes", "gb"),
    "pg_storage": ("database", "bytes", "gb"),
    "pg_connections": ("database", "count", None),
    "ch_storage": ("clickhouse", "bytes", "gb"),
    "ch_memory": ("clickhouse", "bytes", None),
    "ch_retention": ("clickhouse", "seconds", None),
    "ch_ingest": ("clickhouse", "count", None),
    "s3_storage": ("storage", "bytes", "gb"),
    "nats_storage": ("nats", "bytes", "gb"),
    "nats_memory": ("nats", "bytes", None),
    "nats_connections": ("nats", "count", None),
    "ai_tokens": ("ai", "tokens", "mtokens"),
    "email": ("comms", "count", "piece"),
    "sms": ("comms", "count", "piece"),
    "jobs": ("jobs", "count", None),
}

CATEGORIES: dict[str, str] = {
    "server": "Server og container",
    "database": "Database",
    "clickhouse": "ClickHouse",
    "storage": "Object Storage",
    "nats": "NATS",
    "ai": "AI",
    "comms": "Kommunikation",
    "jobs": "Jobs",
}

DEFAULT_CONFIG: dict = {"items": {}}


# ── Building rows ───────────────────────────────────────────────────────────

def item(key: str, name: str, source: str, used: float | None, max_: float | None = None, *,
         note: str | None = None, status: str | None = None, status_label: str | None = None) -> dict:
    category, unit, price_unit = RESOURCES[key]
    return {"key": key, "category": category, "name": name, "source": source, "unit": unit, "price_unit": price_unit,
            "used": used, "max": max_, "max_measured": max_ is not None, "note": note,
            "status": status, "status_label": status_label}


def failed(category: str, error: BaseException | str) -> dict:
    return {"key": f"{category}_error", "category": category, "name": "Kunne ikke måles", "source": str(error)[:300],
            "unit": "count", "price_unit": None, "used": None, "max": None, "max_measured": False, "note": None,
            "status": "error", "status_label": "Fejl"}


def _max_from_config(row: dict, cfg: dict) -> None:
    value = cfg.get("max")
    if value is None:
        return
    row["max"] = value * GB if row["unit"] == "bytes" else value
    row["max_measured"] = False


def _cost(row: dict, cfg: dict) -> float | None:
    monthly, unit_price = cfg.get("monthly"), cfg.get("unit_price")
    cost = None
    if monthly is not None:
        cost = float(monthly)
    if unit_price is not None and row["price_unit"] and row["used"] is not None:
        scale = {"gb": GB, "mtokens": 1_000_000, "piece": 1}[row["price_unit"]]
        cost = (cost or 0.0) + float(unit_price) * row["used"] / scale
    return None if cost is None else round(cost, 2)


def _status(row: dict) -> None:
    if row["status"] == "error":
        row["pct"] = None
        return
    used, max_ = row["used"], row["max"]
    row["pct"] = round(used / max_ * 100, 1) if used is not None and max_ else None
    if row["status"]:
        return
    if row["pct"] is None:
        row["status"], row["status_label"] = "none", "Ingen grænse"
    elif row["pct"] >= 90:
        row["status"], row["status_label"] = "crit", "Tæt på grænsen"
    elif row["pct"] >= 75:
        row["status"], row["status_label"] = "warn", "Hold øje"
    else:
        row["status"], row["status_label"] = "ok", "OK"


# ── Measuring ───────────────────────────────────────────────────────────────

def _read(name: str) -> str:
    return (CGROUP / name).read_text().strip()


def _cpu_usage_usec() -> int:
    for line in _read("cpu.stat").splitlines():
        key, _, value = line.partition(" ")
        if key == "usage_usec":
            return int(value)
    raise OSError("usage_usec missing in cpu.stat")


def _meminfo() -> dict[str, int]:
    out = {}
    for line in PROC_MEMINFO.read_text().splitlines():
        key, _, rest = line.partition(":")
        parts = rest.split()
        if parts:
            out[key] = int(parts[0]) * 1024
    return out


async def measure_server() -> list[dict]:
    rows = []
    # CPU: the quota in cpu.max ("max" = every core), usage from cpu.stat sampled over a short interval.
    cores = float(os.cpu_count() or 1)
    try:
        quota, period = _read("cpu.max").split()
        if quota != "max":
            cores = int(quota) / int(period)
    except (OSError, ValueError):
        pass
    try:
        u1, t1 = _cpu_usage_usec(), time.monotonic()
        await asyncio.sleep(CPU_SAMPLE_SECONDS)
        u2, t2 = _cpu_usage_usec(), time.monotonic()
        used, source = (u2 - u1) / 1_000_000 / (t2 - t1), "app-container (cgroup)"
    except OSError:
        used, source = os.getloadavg()[0], "load average, 1 min"
    rows.append(item("cpu", "CPU", source, round(used, 2), round(cores, 2)))

    # Memory: cgroup first, then the whole machine.
    try:
        current = int(_read("memory.current"))
        limit = _read("memory.max")
        total = int(limit) if limit != "max" else _meminfo().get("MemTotal")
        rows.append(item("memory", "Hukommelse", "app-container (cgroup)", current, total))
    except (OSError, ValueError):
        try:
            info = _meminfo()
            rows.append(item("memory", "Hukommelse", "serveren (/proc/meminfo)",
                             info["MemTotal"] - info.get("MemAvailable", info.get("MemFree", 0)), info["MemTotal"]))
        except (OSError, KeyError):
            pass

    disk = shutil.disk_usage(DISK_PATH)
    rows.append(item("disk", "Disk", "containerens filsystem", disk.used, disk.total))
    return rows


async def measure_postgres() -> list[dict]:
    async with db.connection() as conn:
        row = await db.fetch_one(conn, """
            select pg_database_size(current_database()) as size,
                   current_setting('max_connections')::int as max_conn,
                   (select count(*) from pg_stat_activity where backend_type = 'client backend') as conns,
                   current_database() as name""")
    return [
        item("pg_storage", "Lagring", f"pg_database_size({row['name']})", row["size"]),
        item("pg_connections", "Forbindelser", "pg_stat_activity", row["conns"], row["max_conn"]),
    ]


async def measure_storage() -> list[dict]:
    async with db.connection() as conn:
        row = await db.fetch_one(conn, """
            select (select coalesce(sum(size_bytes), 0) from files)
                 + (select coalesce(sum(size_bytes), 0) from knowledge_documents) as bytes,
                   (select count(*) from files) + (select count(*) from knowledge_documents) as objects""")
    s = config.settings
    where = f"bucket “{s.s3_bucket}”" if s.storage_backend == "s3" else s.storage_backend
    return [item("s3_storage", "Lagring", f"{where} · {row['objects']:,} objekter".replace(",", "."), int(row["bytes"]))]


async def measure_nats() -> list[dict]:
    if not nats_monitor.configured():
        return []
    _, varz = await nats_monitor.fetch("varz")
    js = varz.get("jetstream") or {}
    js_config, js_stats = js.get("config") or {}, js.get("stats") or {}
    rows = []
    if js_config:
        rows.append(item("nats_storage", "JetStream-lager", "varz · max_storage",
                         js_stats.get("storage", 0), js_config.get("max_storage") or None))
        rows.append(item("nats_memory", "JetStream-hukommelse", "varz · max_memory",
                         js_stats.get("memory", 0), js_config.get("max_memory") or None))
    rows.append(item("nats_connections", "Forbindelser", "varz · max_connections",
                     varz.get("connections", 0), varz.get("max_connections") or None))
    return rows


async def measure_clickhouse() -> list[dict]:
    if not clickhouse.configured():
        return [item("ch_storage", "Ikke sat op", "CLICKHOUSE_URL mangler", None,
                     status="none", status_label="Ikke sat op")]
    parts, disks, memory, settings, tables = await asyncio.gather(
        clickhouse.query("SELECT sum(bytes_on_disk) AS bytes, sum(rows) AS rows FROM system.parts WHERE active"),
        clickhouse.query("SELECT total_space FROM system.disks WHERE name = 'default'"),
        clickhouse.query("SELECT value FROM system.metrics WHERE metric = 'MemoryTracking'"),
        clickhouse.query("""SELECT name, value FROM system.server_settings
                            WHERE name IN ('max_server_memory_usage', 'max_server_memory_usage_to_ram_ratio')"""),
        clickhouse.query("""SELECT name, position(create_table_query, ' TTL ') > 0 AS has_ttl FROM system.tables
                            WHERE database = currentDatabase() AND engine LIKE '%MergeTree' AND name != {skip:String}""",
                         {"skip": clickhouse.MIGRATIONS_TABLE}),
    )
    rows = []
    stored = int((parts[0] if parts else {}).get("bytes") or 0)
    rows.append(item("ch_storage", "Lagring", "system.parts · bytes_on_disk", stored,
                     int(disks[0]["total_space"]) if disks else None))

    values = {r["name"]: r["value"] for r in settings}
    limit = int(float(values.get("max_server_memory_usage") or 0))
    if not limit:
        total = await clickhouse.query("SELECT value FROM system.asynchronous_metrics WHERE metric = 'OSMemoryTotal'")
        ratio = float(values.get("max_server_memory_usage_to_ram_ratio") or 0.9)
        limit = int(float(total[0]["value"]) * ratio) if total else 0
    rows.append(item("ch_memory", "Hukommelse", "MemoryTracking · max_server_memory_usage",
                     int(float(memory[0]["value"])) if memory else 0, limit or None))

    # Retention: every table must have a TTL, and nothing may be older than TTL_DAYS (plus a day for merges).
    missing = [t["name"] for t in tables if not t["has_ttl"]]
    oldest = None
    if any(t["name"] == "events" for t in tables):
        res = await clickhouse.query("SELECT toUnixTimestamp(min(ts)) AS oldest, count() AS n FROM events")
        if res and int(res[0]["n"]):
            oldest = max(0, int(time.time()) - int(res[0]["oldest"]))
    ttl = clickhouse.TTL_DAYS * 86400
    if missing:
        status, label, note = "crit", "Mangler TTL", "Uden TTL: " + ", ".join(missing)
    elif oldest is not None and oldest > ttl + 86400:
        status, label, note = "crit", "Sletning halter", "Ældste række er ældre end TTL"
    else:
        status, label, note = "info", "TTL aktiv", None
    rows.append(item("ch_retention", "Retention", f"TTL på {len(tables)} tabel(ler) · ældste række",
                     oldest, ttl, note=note, status=status, status_label=label))

    if any(t["name"] == "events" for t in tables):
        res = await clickhouse.query("SELECT count() AS n FROM events WHERE ts > now() - INTERVAL 1 DAY")
        rows.append(item("ch_ingest", "Indtag", "events · seneste døgn", int(res[0]["n"]) if res else 0))
    return rows


async def measure_usage() -> list[dict]:
    """AI tokens, e-mails, SMS and the job queue, all from Postgres."""
    s = config.settings
    async with db.connection() as conn:
        tokens = await db.fetch_one(conn, """select coalesce(sum(prompt_tokens + completion_tokens), 0) as n
                                             from ai_usage where ts >= date_trunc('month', now())""")
        sent = await db.fetch_all(conn, """select detail->>'channel' as channel, count(*) as n from auth_log
                                           where event = 'otp.sent' and result = 'ok'
                                             and ts >= date_trunc('month', now()) group by 1""")
        jobs = await db.fetch_one(conn, """select count(*) filter (where status = 'queued') as queued,
                                                  count(*) filter (where status = 'dead') as dead from jobs""")
    by_channel = {r["channel"]: r["n"] for r in sent}
    rows = []
    if ai.enabled() or tokens["n"]:
        rows.append(item("ai_tokens", "Tokens", f"{s.ai_model} · denne måned", int(tokens["n"])))
    rows.append(item("email", "E-mail", f"{s.mail_provider} · login-koder denne måned", by_channel.get("email", 0)))
    if s.sms_login or s.sms_provider != "console" or by_channel.get("sms"):
        rows.append(item("sms", "SMS", f"{s.sms_provider} · login-koder denne måned", by_channel.get("sms", 0)))
    dead = jobs["dead"]
    rows.append(item("jobs", "Jobkø", "ventende jobs", jobs["queued"],
                     note=f"{dead} døde jobs" if dead else None,
                     status="warn" if dead else None, status_label="Døde jobs" if dead else None))
    return rows


MEASURES = {
    "server": measure_server,
    "database": measure_postgres,
    "clickhouse": measure_clickhouse,
    "storage": measure_storage,
    "nats": measure_nats,
    "usage": measure_usage,
}


async def overview() -> dict:
    async with db.connection() as conn:
        cfg = await settings_store.get(conn, "resources") or DEFAULT_CONFIG
    results = await asyncio.gather(*(fn() for fn in MEASURES.values()), return_exceptions=True)
    rows: list[dict] = []
    for name, result in zip(MEASURES, results):
        if isinstance(result, BaseException):
            rows.append(failed("comms" if name == "usage" else name, result))
        else:
            rows.extend(result)

    items_cfg = cfg.get("items", {})
    for row in rows:
        c = items_cfg.get(row["key"], {})
        _max_from_config(row, c)
        row["config"] = {"max": c.get("max"), "monthly": c.get("monthly"), "unit_price": c.get("unit_price")}
        row["cost"] = _cost(row, c)
        _status(row)

    categories = []
    for key, label in CATEGORIES.items():
        members = [r for r in rows if r["category"] == key]
        if not members:
            continue
        costs = [r["cost"] for r in members if r["cost"] is not None]
        categories.append({"key": key, "label": label, "items": members,
                           "cost": round(sum(costs), 2) if costs else None})
    costs = [r["cost"] for r in rows if r["cost"] is not None]
    return {
        "measured_at": datetime.now(timezone.utc).isoformat(),
        "currency": "kr.",
        "categories": categories,
        "total_cost": round(sum(costs), 2) if costs else None,
        "count": sum(1 for r in rows if r["status"] != "error"),
        "near_limit": sum(1 for r in rows if r["status"] in ("warn", "crit")),
        "clickhouse": {"configured": clickhouse.configured(), "ttl_days": clickhouse.TTL_DAYS},
    }
