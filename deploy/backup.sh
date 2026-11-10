#!/bin/sh
# Daily backup of the database and the uploaded files; keeps the last 14 days.
# cron: 0 3 * * * /opt/elecico/asico-server/deploy/backup.sh >> /var/log/elecico-backup.log 2>&1
set -eu
cd "$(dirname "$0")/.."
. ./.env
DIR=/opt/elecico/backups
STAMP=$(date +%Y-%m-%d_%H%M)
mkdir -p "$DIR"
docker compose -f docker-compose.prod.yml exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom > "$DIR/db_$STAMP.dump"
docker run --rm -v elecico_uploads:/data:ro -v "$DIR":/backup alpine tar czf "/backup/uploads_$STAMP.tar.gz" -C /data .
find "$DIR" -type f -mtime +14 -delete
echo "$STAMP backup done"
