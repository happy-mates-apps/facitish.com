#!/bin/bash
# Runs once, when the postgres volume is empty. Same role layout as deploy/provision_database.py:
#   <db>_owner (schema, migrations) · <db>_app (the app) · <db>_purge (deletes log data from /admin)
#   <db>_mcp_ro (SELECT only, for db_query in /mcp/admin) — only when DB_MCP_RO_PASSWORD is set
# Grants on tables are applied by the migrations (gaer_apply_grants), not here.
# An existing volume is not touched: add a missing <db>_mcp_ro by hand, see README "Deploy".
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v db="$DB_NAME" -v owner="${DB_NAME}_owner" -v app="${DB_NAME}_app" -v purge="${DB_NAME}_purge" \
  -v owner_pw="$DB_OWNER_PASSWORD" -v app_pw="$DB_APP_PASSWORD" -v purge_pw="$DB_PURGE_PASSWORD" <<'SQL'
create role :"owner" login password :'owner_pw';
create role :"app" login password :'app_pw';
create role :"purge" login password :'purge_pw';
create database :"db" owner :"owner";
revoke all on database :"db" from public;
grant connect on database :"db" to :"owner", :"app", :"purge";
\connect :"db"
revoke create on schema public from public;
SQL

if [ -n "${DB_MCP_RO_PASSWORD:-}" ]; then
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -v db="$DB_NAME" -v ro="${DB_NAME}_mcp_ro" -v ro_pw="$DB_MCP_RO_PASSWORD" <<'SQL'
create role :"ro" login password :'ro_pw';
grant connect on database :"db" to :"ro";
SQL
fi
