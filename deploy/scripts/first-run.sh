#!/usr/bin/env bash
# First install, after "docker compose ... up -d --build": applies the migrations, seeds the permissions and the first
# administrator (ADMIN_EMAIL / ADMIN_PASSWORD), then checks the health endpoint. Safe to run again.
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_env_file

log "starting the database and the API (building the image if needed)"
compose up -d --build db app

log "applying the database migrations"
compose run --rm --no-deps app npx --no-install prisma migrate deploy

log "seeding the permissions and the first administrator"
compose run --rm --no-deps app node dist/cli/seed.js

log "starting Caddy"
compose up -d caddy

log "waiting for the API to be healthy"
wait_for_app 180

domain="$(env_value DOMAIN)"
if curl -fsS --max-time 20 "https://${domain}/api/v1/health" >/dev/null; then
  log "https://${domain}/api/v1/health answers. First run done."
else
  log "the API is healthy inside Docker, but https://${domain}/api/v1/health does not answer yet."
  log "Caddy may still be getting the certificate: check DNS, ports 80/443, then: docker compose -f docker-compose.prod.yml logs caddy"
fi
log "deployed commit: $(current_commit)"
log "remove ADMIN_PASSWORD from .env.production once you have signed in and changed the password."
