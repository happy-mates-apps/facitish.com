"""Applies SQL migrations in app/migrations/ in order.

    python -m app.migrate            # uses MIGRATION_DATABASE_URL, falls back to DATABASE_URL
    python -m app.migrate --status   # lists applied and pending migrations

Each file runs in its own transaction. An advisory lock stops two deploys migrating at once.
After the run, gaer_apply_grants() re-applies privileges for the app and purge users,
so new tables are covered automatically. Then ClickHouse's schema (app/clickhouse_migrations/) is applied when
CLICKHOUSE_URL is set (app.clickhouse.migrate).
"""

import pathlib
import sys

import psycopg

from app import clickhouse, config

MIGRATIONS_DIR = pathlib.Path(__file__).parent / "migrations"
LOCK_ID = 7_301_947  # arbitrary, constant


def migration_files() -> list[pathlib.Path]:
    return sorted(p for p in MIGRATIONS_DIR.glob("*.sql"))


def migrate(url: str | None = None, verbose: bool = True) -> list[str]:
    url = url or config.settings.migration_database_url or config.settings.database_url
    applied_now: list[str] = []
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute("select pg_advisory_lock(%s)", (LOCK_ID,))
        try:
            conn.execute("""create table if not exists schema_migrations (
                                name text primary key,
                                applied_at timestamptz not null default now())""")
            done = {r[0] for r in conn.execute("select name from schema_migrations").fetchall()}
            for path in migration_files():
                if path.name in done:
                    continue
                if verbose:
                    print(f"migrating {path.name}")
                with conn.transaction():
                    conn.execute(path.read_text())
                    conn.execute("insert into schema_migrations (name) values (%s)", (path.name,))
                applied_now.append(path.name)
            conn.execute("select gaer_apply_grants()")
        finally:
            conn.execute("select pg_advisory_unlock(%s)", (LOCK_ID,))
    if verbose:
        print(f"{len(applied_now)} migration(s) applied" if applied_now else "database is up to date")
    return applied_now


def status(url: str | None = None) -> None:
    url = url or config.settings.migration_database_url or config.settings.database_url
    with psycopg.connect(url) as conn:
        exists = conn.execute("select to_regclass('schema_migrations') is not null").fetchone()[0]
        done = {r[0] for r in conn.execute("select name from schema_migrations").fetchall()} if exists else set()
    for path in migration_files():
        print(f"{'applied' if path.name in done else 'pending'}  {path.name}")


if __name__ == "__main__":
    if "--status" in sys.argv:
        status()
    else:
        migrate()
        clickhouse.migrate()
