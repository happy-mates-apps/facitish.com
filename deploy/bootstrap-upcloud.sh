#!/usr/bin/env bash
# One-time setup of a Gær instance on a plain Docker host (UpCloud), run as the deploy user in ~/gaer
# next to infra.compose.yml:
#
#   ./bootstrap-upcloud.sh <domain> <name> <admin-phone>     e.g. facitish.com facitish +4512345678
#
# Creates .env (app + Caddy), infra.env and garage.toml (never given to the app) with generated secrets
# (never printed), starts Postgres + Garage, creates database gaer_<name> with the owner/app/purge roles
# (same layout as provision_database.py), the S3 key and the bucket.
# Safe to re-run: existing env files are kept, existing roles/database/key/bucket are left alone.

set -euo pipefail
cd "$(dirname "$0")"

DOMAIN=${1:?domain required}
NAME=${2:?name required}
ADMIN_PHONE=${3:?admin phone required}
[[ $NAME =~ ^[a-z][a-z0-9_]{1,40}$ ]] || { echo "name must be lowercase letters, digits and _" >&2; exit 2; }
DB="gaer_$NAME"

log() { echo "[bootstrap] $*"; }
secret() { openssl rand -hex "${1:-24}"; }

if [ ! -f .env ]; then
  log "writing .env and infra.env"
  owner_pw=$(secret) app_pw=$(secret) purge_pw=$(secret)
  s3_key=GK$(secret 12) s3_secret=$(secret 32)
  umask 077
  cat > garage.toml <<EOF
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"
replication_factor = 1
rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret = "$(secret 32)"

[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
EOF
  cat > infra.env <<EOF
POSTGRES_PASSWORD=$(secret)
DB_OWNER_PASSWORD=$owner_pw
DB_APP_PASSWORD=$app_pw
DB_PURGE_PASSWORD=$purge_pw
S3_ACCESS_KEY=$s3_key
S3_SECRET_KEY=$s3_secret
EOF
  cat > .env <<EOF
GAER_ENV=production
DOMAIN=$DOMAIN
ORIGIN=https://$DOMAIN
RP_ID=$DOMAIN
RP_NAME=Facit
SECRET_KEY=$(secret 32)
BOOTSTRAP_ADMIN_PHONE=$ADMIN_PHONE

# Postgres container gaer-postgres (deploy/infra.compose.yml)
DATABASE_URL=postgresql://${DB}_app:$app_pw@gaer-postgres:5432/$DB
PURGE_DATABASE_URL=postgresql://${DB}_purge:$purge_pw@gaer-postgres:5432/$DB
MIGRATION_DATABASE_URL=postgresql://${DB}_owner:$owner_pw@gaer-postgres:5432/$DB

# OVHcloud SMS - required for login in production. After editing .env re-create the app container
# (env is read at start): ./deploy.sh release "\$(cat .current_image)"
SMS_PROVIDER=ovh
SMS_SENDER=Facit
OVH_ENDPOINT=https://eu.api.ovh.com/1.0
OVH_APPLICATION_KEY=
OVH_APPLICATION_SECRET=
OVH_CONSUMER_KEY=
OVH_SMS_SERVICE=

# Garage container gaer-garage, reached by app and browsers through Caddy on s3.$DOMAIN
STORAGE_BACKEND=s3
S3_ENDPOINT=https://s3.$DOMAIN
S3_REGION=garage
S3_BUCKET=${DB//_/-}
S3_ACCESS_KEY=$s3_key
S3_SECRET_KEY=$s3_secret

# Optional AI chat (OVHcloud AI Endpoints). Empty = off.
AI_API_KEY=
AI_BASE_URL=https://oai.endpoints.kepler.ai.cloud.ovh.net/v1
AI_MODEL=Meta-Llama-3_3-70B-Instruct
EOF
  umask 022
else
  log ".env exists - keeping it"
fi

set -a; . ./infra.env; S3_BUCKET=$(sed -n 's/^S3_BUCKET=//p' .env); set +a

docker network inspect gaer >/dev/null 2>&1 || docker network create gaer >/dev/null
log "starting Postgres and Garage"
docker compose --env-file infra.env -f infra.compose.yml up -d --wait

psql() { docker exec -i gaer-postgres psql -v ON_ERROR_STOP=1 -U postgres -qtA "$@"; }

if [ -z "$(psql -c "select 1 from pg_database where datname = '$DB'")" ]; then
  log "creating database $DB and roles"
  psql <<SQL
create role ${DB}_owner login password '$DB_OWNER_PASSWORD';
create role ${DB}_app login password '$DB_APP_PASSWORD';
create role ${DB}_purge login password '$DB_PURGE_PASSWORD';
create database $DB owner ${DB}_owner;
revoke all on database $DB from public;
grant connect on database $DB to ${DB}_owner, ${DB}_app, ${DB}_purge;
SQL
  psql -d "$DB" -c "revoke create on schema public from public"
else
  log "database $DB exists"
fi

garage() { docker exec -e RUST_LOG=warn gaer-garage /garage "$@"; }

if garage status 2>/dev/null | grep -q 'NO ROLE ASSIGNED'; then
  log "assigning Garage storage layout"
  node=$(garage node id -q 2>/dev/null | cut -d@ -f1)
  garage layout assign -z dc1 -c 15G "$node" >/dev/null
  garage layout apply --version 1 >/dev/null
fi
if ! garage key info "$S3_ACCESS_KEY" >/dev/null 2>&1; then
  log "importing S3 key"
  garage key import --yes -n gaer "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null
fi
if ! garage bucket info "$S3_BUCKET" >/dev/null 2>&1; then
  log "creating bucket $S3_BUCKET"
  garage bucket create "$S3_BUCKET" >/dev/null
fi
garage bucket allow --read --write --owner "$S3_BUCKET" --key "$S3_ACCESS_KEY" >/dev/null

if ! crontab -l 2>/dev/null | grep -q 'gaer/backup.sh'; then
  log "installing nightly database backup (03:15)"
  mkdir -p backups
  { crontab -l 2>/dev/null || true; echo "15 3 * * * $PWD/backup.sh >> $PWD/backups/backup.log 2>&1"; } | crontab -
fi

log "done - next: push to main (deploy workflow) or ./deploy.sh migrate|release <image>"
