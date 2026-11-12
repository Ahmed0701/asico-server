#!/usr/bin/env bash
# Shared by the deploy scripts (sourced, not run). Never prints a secret.

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$DEPLOY_DIR/.." && pwd)"
# Git Bash on Windows (a local test run): Docker needs C:/... paths. Linux has no cygpath and keeps the paths as they are.
if command -v cygpath >/dev/null 2>&1; then
  DEPLOY_DIR="$(cygpath -m "$DEPLOY_DIR")"
  REPO_DIR="$(cygpath -m "$REPO_DIR")"
  export MSYS_NO_PATHCONV=1
fi
ENV_FILE="$DEPLOY_DIR/.env.production"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.prod.yml"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

compose() {
  docker compose --project-directory "$DEPLOY_DIR" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

# One value from the env file, read as text (the file is never run as a script).
env_value() {
  local name="$1" line
  line="$(grep -E "^${name}=" "$ENV_FILE" | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"
  line="${line#\"}"
  printf '%s' "$line"
}

# The env file exists, is private, and has no CHANGE_ME left. Names the variables, never their values.
require_env_file() {
  [[ -f "$ENV_FILE" ]] || die "missing $ENV_FILE (cp .env.production.example .env.production, then fill it)"
  local mode
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*)
      # Git Bash on Windows (a local test run) cannot show Unix file modes; the server is Linux and checks them.
      log "warning: file mode not checked on Windows"
      ;;
    *)
      mode="$(stat -c '%a' "$ENV_FILE")"
      if [[ "$mode" != "600" && "$mode" != "400" ]]; then
        die "$ENV_FILE is readable by others (mode $mode): chmod 600 $ENV_FILE"
      fi
      ;;
  esac
  local placeholders
  placeholders="$(grep -E '^[A-Z_0-9]+=.*CHANGE_ME' "$ENV_FILE" | cut -d= -f1 | tr '\n' ' ' || true)"
  [[ -z "$placeholders" ]] || die "still CHANGE_ME in $ENV_FILE: $placeholders"
}

# Waits until the app container reports healthy (Docker HEALTHCHECK on /api/v1/health).
wait_for_app() {
  local timeout="${1:-180}" waited=0 id status
  while ((waited < timeout)); do
    id="$(compose ps -q app)"
    if [[ -n "$id" ]]; then
      status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id")"
      if [[ "$status" == "healthy" ]]; then
        return 0
      fi
    fi
    sleep 3
    waited=$((waited + 3))
  done
  compose logs --tail=50 app >&2 || true
  die "the app did not become healthy within ${timeout}s"
}

# The commit the working tree is on, read from .git without running git.
current_commit() {
  local git_dir="$REPO_DIR/.git" head ref
  [[ -f "$git_dir/HEAD" ]] || {
    printf 'unknown'
    return
  }
  head="$(cat "$git_dir/HEAD")"
  if [[ "$head" == ref:* ]]; then
    ref="${head#ref: }"
    if [[ -f "$git_dir/$ref" ]]; then
      printf '%s' "$(cut -c1-12 "$git_dir/$ref")"
    else
      printf '%s' "$(grep -E " ${ref}\$" "$git_dir/packed-refs" 2>/dev/null | cut -c1-12 || printf 'unknown')"
    fi
    printf ' (%s)' "${ref#refs/heads/}"
  else
    printf '%s (detached)' "${head:0:12}"
  fi
}

# Where backups go: the environment wins, then BACKUP_DIR in the env file, then /opt/asico/backups.
if [[ -z "${BACKUP_DIR:-}" && -f "$ENV_FILE" ]]; then
  BACKUP_DIR="$(env_value BACKUP_DIR)"
fi
BACKUP_DIR="${BACKUP_DIR:-/opt/asico/backups}"
