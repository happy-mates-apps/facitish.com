"""/admin/resources: every resource the instance uses, with how much is used, the limit and an estimated price.

Measured live on each request; nothing is stored except the admin's own limits and prices (setting "resources").
Each source is measured on its own, so one that fails (NATS down, a monitoring port not set up) shows as an error row
and the rest of the page still works.

- Server and container: cgroup v2 (/sys/fs/cgroup: cpu.max, cpu.stat, memory.max, memory.current), else the load
  average and /proc/meminfo; disk from the container's root filesystem.
- Postgres: pg_database_size, pg_stat_activity, max_connections.
- Events (app.events): the JetStream stream EVENTS (jsz), the events table in Postgres, events the last 24 hours and
  whether cleanup keeps them to the retention policy (7 days).
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

from app import ai, config, db, events, nats_monitor, settings_store

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
    "ev_stream": ("events", "bytes", None),
    "ev_table": ("events", "bytes", None),
    "ev_ingest": ("events", "count", None),
    "ev_retention": ("events", "seconds", None),
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
    "events": "Hændelser",
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
    if row["status"] == "info":
        row["pct"] = None  # e.g. retention: the age of the oldest event is not a share of anything to fill up
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


async def measure_events() -> list[dict]:
    rows = []
    if events.bus() == "nats" or nats_monitor.configured():
        try:
            _, jsz = await nats_monitor.fetch("jsz", {"accounts": "true", "streams": "true", "config": "true"})
            stream = next((sd for acc in jsz.get("account_details") or [] for sd in acc.get("stream_detail") or []
                           if sd.get("name") == events.STREAM), None)
            if stream:
                state, cfg = stream.get("state") or {}, stream.get("config") or {}
                msgs = f"{state.get('messages', 0):,}".replace(",", ".")
                rows.append(item("ev_stream", "Event-stream", f"NATS JetStream · {events.STREAM} · {msgs} beskeder",
                                 state.get("bytes", 0), (cfg.get("max_bytes") or 0) if (cfg.get("max_bytes") or 0) > 0 else None))
            else:
                rows.append(item("ev_stream", "Event-stream", f"NATS JetStream · {events.STREAM} findes ikke endnu", None,
                                 status="warn", status_label="Ikke oprettet"))
        except nats_monitor.MonitorError as e:
            rows.append(item("ev_stream", "Event-stream", e.message, None, status="error", status_label="Fejl"))
    else:
        rows.append(item("ev_stream", "Event-stream", "NATS er ikke sat op: hændelser skrives direkte i Postgres", None,
                         status="none", status_label="Uden NATS"))

    async with db.connection() as conn:
        row = await db.fetch_one(conn, """
            select pg_total_relation_size('events') as size,
                   (select count(*) from events where ts > now() - interval '1 day') as day,
                   (select extract(epoch from now() - min(ts))::bigint from events) as oldest,
                   (select days from retention_policies where key = 'events') as days,
                   (select enabled from retention_policies where key = 'events') as enabled""")
    rows.append(item("ev_table", "Event-tabel", "Postgres · pg_total_relation_size(events)", row["size"]))
    rows.append(item("ev_ingest", "Indtag", "hændelser · seneste døgn", row["day"]))
    days = row["days"] or events.TTL_DAYS
    keep = days * 86400
    if not row["enabled"]:
        status, label, note = "warn", "Oprydning slået fra", "Slå politikken »Hændelser« til under Jobs og oprydning"
    elif row["oldest"] is not None and row["oldest"] > keep + 2 * 86400:
        status, label, note = "crit", "Oprydning halter", "Ældste hændelse er ældre end politikken"
    else:
        status, label, note = "info", "Oprydning aktiv", None
    rows.append(item("ev_retention", "Retention", "retention_policies · events · ældste hændelse", row["oldest"], keep,
                     note=note, status=status, status_label=label))
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
    "events": measure_events,
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
        "events": {"bus": events.bus(), "nats_configured": bool(config.settings.nats_url), "stream": events.STREAM,
                   "ttl_days": events.TTL_DAYS},
    }
