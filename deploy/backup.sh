#!/bin/sh
# Daily backup of the database and the uploaded files; keeps the last 14 days.
# cron: 0 3 * * * /opt/elecico/asico-server/deploy/backup.sh >> /var/log/elecico-backup.log 2>&1
set -eu
DIR=$(cd "$(dirname "$0")" && pwd)
# Only the two values the dump needs, read without running the file as a script.
POSTGRES_USER=$(sed -n 's/^POSTGRES_USER=//p' "$DIR/.env.production")
POSTGRES_DB=$(sed -n 's/^POSTGRES_DB=//p' "$DIR/.env.production")
BACKUPS=/opt/elecico/backups
STAMP=$(date +%Y-%m-%d_%H%M)
mkdir -p "$BACKUPS"
"$DIR/compose.sh" exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom > "$BACKUPS/db_$STAMP.dump"
docker run --rm -v elecico_uploads:/data:ro -v "$BACKUPS":/backup alpine tar czf "/backup/uploads_$STAMP.tar.gz" -C /data .
find "$BACKUPS" -type f -mtime +14 -delete
echo "$STAMP backup done"
