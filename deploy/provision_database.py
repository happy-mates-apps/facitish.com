"""Creates a container's own database in the shared managed PostgreSQL cluster.

Run once per new Gær instance by Happy Mates, with the cluster's admin user:

    python deploy/provision_database.py --admin-url "postgresql://avnadmin:...@host:port/defaultdb?sslmode=require" --name kunde

Creates database gaer_<name> and four users that can only reach that database:
    gaer_<name>_owner   owns the schema, runs migrations          -> MIGRATION_DATABASE_URL
    gaer_<name>_app     the application, append-only on log tables -> DATABASE_URL
    gaer_<name>_purge   deletes log data from /admin               -> PURGE_DATABASE_URL
    gaer_<name>_mcp_ro  SELECT only, for the db_query MCP tool     -> MCP_DB_QUERY_URL
Prints the four URLs for the instance's .env. Passwords are generated and shown only once.
"""

import argparse
import re
import secrets
import sys
from urllib.parse import quote, urlparse, urlunparse

import psycopg
from psycopg import sql


def url_for(admin_url: str, user: str, password: str, database: str) -> str:
    p = urlparse(admin_url)
    netloc = f"{quote(user)}:{quote(password)}@{p.hostname}" + (f":{p.port}" if p.port else "")
    return urlunparse(p._replace(netloc=netloc, path="/" + database))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--admin-url", required=True)
    parser.add_argument("--name", required=True, help="short instance name, e.g. kunde")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9_]{1,40}", args.name):
        parser.error("name must be lowercase letters, digits and _")

    db = f"gaer_{args.name}"
    roles = {suffix: (f"{db}_{suffix}", secrets.token_urlsafe(24)) for suffix in ("owner", "app", "purge", "mcp_ro")}

    with psycopg.connect(args.admin_url, autocommit=True) as conn:
        if conn.execute("select 1 from pg_database where datname = %s", (db,)).fetchone():
            print(f"database {db} already exists", file=sys.stderr)
            return 1
        for role, password in roles.values():
            conn.execute(sql.SQL("create role {} login password {}").format(sql.Identifier(role), sql.Literal(password)))
        owner = roles["owner"][0]
        # Managed clusters do not give the admin superuser; it must be a member to hand over ownership.
        conn.execute(sql.SQL("grant {} to current_user").format(sql.Identifier(owner)))
        conn.execute(sql.SQL("create database {} owner {}").format(sql.Identifier(db), sql.Identifier(owner)))
        conn.execute(sql.SQL("revoke all on database {} from public").format(sql.Identifier(db)))
        for role, _ in roles.values():
            conn.execute(sql.SQL("grant connect on database {} to {}").format(sql.Identifier(db), sql.Identifier(role)))

    with psycopg.connect(url_for(args.admin_url, owner, roles["owner"][1], db), autocommit=True) as conn:
        conn.execute("revoke create on schema public from public")

    print(f"# {db} — paste into ~/gaer/.env on the instance")
    print(f"DATABASE_URL={url_for(args.admin_url, *roles['app'], db)}")
    print(f"PURGE_DATABASE_URL={url_for(args.admin_url, *roles['purge'], db)}")
    print(f"MIGRATION_DATABASE_URL={url_for(args.admin_url, *roles['owner'], db)}")
    print(f"MCP_DB_QUERY_URL={url_for(args.admin_url, *roles['mcp_ro'], db)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
