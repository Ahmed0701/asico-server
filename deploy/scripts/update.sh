#!/usr/bin/env bash
# Deploys the code that is checked out now. Run "git pull" yourself first; this script never runs git.
#   backup -> build -> migrate deploy -> up -d -> wait for health -> print the deployed commit
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_env_file

log "deploying commit $(current_commit)"

log "backup before the update"
"$DEPLOY_DIR/scripts/backup.sh"

log "building the API image"
compose build app

log "applying the database migrations (with the new image)"
compose run --rm --no-deps app npx --no-install prisma migrate deploy

log "restarting the services"
compose up -d --remove-orphans

log "waiting for the API to be healthy"
wait_for_app 180

log "deployed: $(current_commit)"
cat <<'EOF'
Rollback: git checkout <older commit> && ./scripts/update.sh rebuilds the old code. A migration that dropped or
changed columns is NOT undone by the old image: to go back past one, restore the backup taken at the start of this
update (./scripts/restore.sh --db /opt/asico/backups/latest-db.dump) BEFORE running the old code.
EOF
