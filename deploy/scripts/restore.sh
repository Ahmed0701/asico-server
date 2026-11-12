#!/usr/bin/env bash
# Restores a database dump made by backup.sh, and optionally a documents archive.
#   Test restore into a NEW database (the live one is untouched):
#     ./restore.sh --db /opt/asico/backups/latest-db.dump --into asico_restore_test
#   Real restore into the live database (stops the API while it runs):
#     ./restore.sh --db FILE.dump [--documents FILE.tar.gz]
# Asks you to type the target database name before it changes anything.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  sed -n '2,7p' "$0"
  exit 1
}

db_dump=""
docs_archive=""
target=""
while (($# > 0)); do
  case "$1" in
    --db)
      db_dump="${2:-}"
      shift 2
      ;;
    --documents)
      docs_archive="${2:-}"
      shift 2
      ;;
    --into)
      target="${2:-}"
      shift 2
      ;;
    *) usage ;;
  esac
done

require_env_file
[[ -n "$db_dump" ]] || usage
[[ -f "$db_dump" ]] || die "no such dump: $db_dump"
[[ -z "$docs_archive" || -f "$docs_archive" ]] || die "no such archive: $docs_archive"

pg_user="$(env_value POSTGRES_USER)"
live_db="$(env_value POSTGRES_DB)"
target="${target:-$live_db}"
[[ "$target" =~ ^[a-z_][a-z0-9_]*$ ]] || die "the database name may only hold lower-case letters, digits and _"
if [[ "$target" != "$live_db" && -n "$docs_archive" ]]; then
  die "--documents restores into the live volume; use it only without --into"
fi

compose exec -T db pg_restore --list <"$db_dump" >/dev/null || die "$db_dump is not a valid pg_dump custom-format file"

if [[ "$target" == "$live_db" ]]; then
  printf 'This REPLACES the live database "%s"%s.\n' "$live_db" "${docs_archive:+ and the documents volume}"
else
  printf 'This restores into a NEW database "%s". The live database "%s" is not touched.\n' "$target" "$live_db"
fi
read -r -p "Type the database name ($target) to continue: " answer
[[ "$answer" == "$target" ]] || die "not confirmed, nothing changed"

if [[ "$target" == "$live_db" ]]; then
  log "stopping the API"
  compose stop app
  log "restoring into ${live_db}"
  compose exec -T db pg_restore -U "$pg_user" -d "$live_db" --clean --if-exists --no-owner --exit-on-error <"$db_dump"
  if [[ -n "$docs_archive" ]]; then
    log "restoring the documents volume"
    compose run --rm --no-deps -T --entrypoint sh app -c 'find /app/uploads -mindepth 1 -delete && tar -xzf - -C /app/uploads' <"$docs_archive"
  fi
  log "starting the API"
  compose up -d app
  wait_for_app 180
else
  compose exec -T db psql -v ON_ERROR_STOP=1 -U "$pg_user" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '${target}'" |
    grep -q 1 && die "database ${target} already exists; pick a new name or drop it first"
  log "creating ${target} and restoring into it"
  compose exec -T db createdb -U "$pg_user" "$target"
  compose exec -T db pg_restore -U "$pg_user" -d "$target" --no-owner --exit-on-error <"$db_dump"
  users="$(compose exec -T db psql -U "$pg_user" -d "$target" -tAc 'SELECT count(*) FROM "User"')"
  villas="$(compose exec -T db psql -U "$pg_user" -d "$target" -tAc 'SELECT count(*) FROM "Villa"')"
  log "restored: ${users} users, ${villas} villas in ${target}"
  log "drop it when done: docker compose -f docker-compose.prod.yml --env-file .env.production exec db dropdb -U ${pg_user} ${target}"
fi
log "restore done"
