#!/usr/bin/env bash
# Nightly dump of the instance's database to ~/gaer/backups, keeping KEEP_DAYS days.
# Installed as a cron job by bootstrap-upcloud.sh. Restore: see /gaer-recover (re-apply erasures after restore).
set -euo pipefail
cd "$(dirname "$0")"

KEEP_DAYS=${KEEP_DAYS:-14}
DB=$(sed -n 's|^DATABASE_URL=.*/\([^/?]*\).*|\1|p' .env)
mkdir -p backups
chmod 700 backups

out="backups/$DB-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker exec gaer-postgres pg_dump -U postgres -Fc "$DB" > "$out.tmp"
mv "$out.tmp" "$out"
find backups -name "$DB-*.dump" -mtime +"$KEEP_DAYS" -delete
echo "$(date -u +%FT%TZ) $out $(du -h "$out" | cut -f1)"
