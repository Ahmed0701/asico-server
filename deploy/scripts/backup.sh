#!/usr/bin/env bash
# Backup of the database (pg_dump, custom format) and of the documents volume (tar.gz), timestamped.
# Keeps 14 daily and 8 weekly (Sunday) copies, and latest-db.dump / latest-documents.tar.gz links to the newest.
# cron (as deploy): 15 2 * * * /opt/asico/asico-server/deploy/scripts/backup.sh >> /opt/asico/backups/backup.log 2>&1
# Exits non-zero on any failure, so cron mail or a monitor can tell.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_env_file
umask 077

daily="$BACKUP_DIR/daily"
weekly="$BACKUP_DIR/weekly"
mkdir -p "$daily" "$weekly"

stamp="$(date '+%Y-%m-%d_%H%M%S')"
db_file="$daily/db_${stamp}.dump"
docs_file="$daily/documents_${stamp}.tar.gz"
pg_user="$(env_value POSTGRES_USER)"
pg_db="$(env_value POSTGRES_DB)"

# Write to a .partial file first: a failed run never leaves a file that looks complete.
log "dumping database ${pg_db}"
compose exec -T db pg_dump -U "$pg_user" -d "$pg_db" --format=custom >"${db_file}.partial"
compose exec -T db pg_restore --list <"${db_file}.partial" >/dev/null
mv "${db_file}.partial" "$db_file"

log "archiving the documents volume"
compose exec -T app tar -czf - -C /app/uploads . >"${docs_file}.partial"
gzip -t "${docs_file}.partial"
mv "${docs_file}.partial" "$docs_file"

ln -sfn "$db_file" "$BACKUP_DIR/latest-db.dump"
ln -sfn "$docs_file" "$BACKUP_DIR/latest-documents.tar.gz"

# Sunday: keep a weekly copy too (hard link, no extra space).
if [[ "$(date '+%u')" == "7" ]]; then
  ln -f "$db_file" "$weekly/"
  ln -f "$docs_file" "$weekly/"
fi

# Keep the newest 14 daily and 8 weekly sets.
prune() {
  local dir="$1" keep="$2" pattern
  for pattern in 'db_*.dump' 'documents_*.tar.gz'; do
    find "$dir" -maxdepth 1 -type f -name "$pattern" -printf '%f\n' | sort -r | tail -n "+$((keep + 1))" |
      while IFS= read -r old; do rm -f -- "$dir/$old"; done
  done
}
prune "$daily" 14
prune "$weekly" 8
find "$BACKUP_DIR" -maxdepth 2 -name '*.partial' -mmin +60 -delete

log "backup done: $(du -h "$db_file" | cut -f1) database, $(du -h "$docs_file" | cut -f1) documents (${stamp})"
