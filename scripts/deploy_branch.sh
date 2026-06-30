#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash scripts/deploy_branch.sh [branch] [config_dir]

Deploy a GitHub branch on the server, then recopy server-local config files.
When branch is omitted, it defaults to dev.

Arguments:
  branch      Optional Git branch to deploy. Default: dev
  config_dir  Optional directory outside the repo containing server-local config files.
              Default: /home/ubuntu/sunsq/debateall-config
              Every file/directory inside config_dir is copied into the repo
              root, preserving relative paths. Typical layout:

                /srv/jixia-config/
                  .env
                  runtime/storage/tokens.json

Environment overrides:
  JIXIA_GIT_REMOTE          Git remote name. Default: origin
  JIXIA_HEALTH_URL          Health URL. Default: http://127.0.0.1:12234/api/health
  JIXIA_CONFIG_DIR          Config directory. Default: /home/ubuntu/sunsq/debateall-config
  JIXIA_SUPERVISOR_PROGRAMS Space-separated supervisor programs to restart.
                            Default: jixia-debate
  JIXIA_PYTHON_BIN          Python executable used to create .venv. Default: python3
  JIXIA_INSTALL_VOICE_AGENT Set to 1 to install apps/voice_agent/requirements.txt.
  JIXIA_RUN_SMOKE           Set to 1 to run npm run smoke after health check.
  JIXIA_SMOKE_BASE_URL      Base URL for smoke. Default: health URL without /api/health
  JIXIA_SKIP_RESTART        Set to 1 to skip supervisor restart.
EOF
}

log() {
  printf '[%s] %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$*"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

run() {
  log "+ $*"
  "$@"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

validate_branch() {
  local branch="$1"
  [[ -n "$branch" ]] || die "branch is required"
  [[ "$branch" != -* ]] || die "branch must not start with '-'"
  [[ "$branch" =~ ^[A-Za-z0-9._/-]+$ ]] || die "branch contains unsupported characters: $branch"
  [[ "$branch" != *..* ]] || die "branch must not contain '..'"
  [[ "$branch" != */. && "$branch" != *.lock && "$branch" != *"/."* ]] || die "invalid branch name: $branch"
}

copy_config_dir() {
  local config_dir="$1"
  local app_dir="$2"

  [[ -d "$config_dir" ]] || die "config directory does not exist: $config_dir"

  local config_real app_real
  config_real="$(cd "$config_dir" && pwd -P)"
  app_real="$(cd "$app_dir" && pwd -P)"

  if [[ ("$config_real" == "$app_real" || "$config_real" == "$app_real"/*) && "${JIXIA_ALLOW_CONFIG_IN_APP:-0}" != "1" ]]; then
    die "config_dir should be outside the repo to avoid committing secrets: $config_real"
  fi

  log "Copying server-local config from $config_real"
  shopt -s dotglob nullglob
  local item base dest
  for item in "$config_real"/*; do
    base="$(basename "$item")"
    case "$base" in
      .git|node_modules|.venv)
        die "refusing to copy unsafe config entry: $base"
        ;;
    esac
    dest="$app_real/$base"
    if [[ -d "$item" ]]; then
      mkdir -p "$dest"
      cp -a "$item"/. "$dest"/
    else
      mkdir -p "$(dirname "$dest")"
      cp -a "$item" "$dest"
    fi
  done
  shopt -u dotglob nullglob

  [[ -f "$app_real/.env" ]] || die "missing .env after copying config from $config_real"
  mkdir -p "$app_real/runtime/logs" "$app_real/apps/backend/storage"
}

supervisor_restart_or_start() {
  local program="$1"
  if [[ "${JIXIA_SKIP_RESTART:-0}" == "1" ]]; then
    log "Skipping supervisor restart for $program"
    return
  fi

  require_cmd supervisorctl
  if [[ "$(id -u)" == "0" ]]; then
    supervisorctl restart "$program" || supervisorctl start "$program"
  else
    require_cmd sudo
    sudo supervisorctl restart "$program" || sudo supervisorctl start "$program"
  fi
}

wait_for_health() {
  local url="$1"
  local attempts="${JIXIA_HEALTH_ATTEMPTS:-30}"
  local delay="${JIXIA_HEALTH_DELAY_SECONDS:-2}"

  log "Waiting for health check: $url"
  local i
  for ((i = 1; i <= attempts; i += 1)); do
    if curl -fsS "$url" >/tmp/jixia-health-response.json; then
      cat /tmp/jixia-health-response.json
      printf '\n'
      log "Health check passed"
      return 0
    fi
    sleep "$delay"
  done
  die "health check failed after $attempts attempts: $url"
}

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi

  local branch="${1:-${JIXIA_BRANCH:-dev}}"
  local config_dir="${2:-${JIXIA_CONFIG_DIR:-/home/ubuntu/sunsq/debateall-config}}"

  if [[ -d "$branch" && $# -eq 1 ]]; then
    config_dir="$branch"
    branch="${JIXIA_BRANCH:-dev}"
  fi

  validate_branch "$branch"

  require_cmd git
  require_cmd curl
  require_cmd npm
  require_cmd "${JIXIA_PYTHON_BIN:-python3}"

  local app_dir remote health_url
  app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
  remote="${JIXIA_GIT_REMOTE:-origin}"
  health_url="${JIXIA_HEALTH_URL:-http://127.0.0.1:12234/api/health}"

  cd "$app_dir"
  log "Deploying branch '$branch' in $app_dir"

  git diff --quiet || die "tracked working tree has local modifications; commit or discard them before deploying"
  git diff --cached --quiet || die "git index has staged changes; commit or unstage them before deploying"

  run git fetch --prune "$remote" "+refs/heads/$branch:refs/remotes/$remote/$branch"
  run git checkout -B "$branch" "$remote/$branch"
  run git reset --hard "$remote/$branch"

  copy_config_dir "$config_dir" "$app_dir"

  if [[ ! -x ".venv/bin/python" ]]; then
    run "${JIXIA_PYTHON_BIN:-python3}" -m venv .venv
  fi
  run .venv/bin/python -m pip install -r apps/backend/requirements.txt
  if [[ "${JIXIA_INSTALL_VOICE_AGENT:-0}" == "1" ]]; then
    run .venv/bin/python -m pip install -r apps/voice_agent/requirements.txt
  fi

  if [[ -f package-lock.json ]]; then
    run npm ci
  else
    run npm install
  fi

  if [[ -f apps/frontend/package-lock.json ]]; then
    run npm --prefix apps/frontend ci
  else
    run npm --prefix apps/frontend install
  fi

  run npm run build:frontend

  local programs="${JIXIA_SUPERVISOR_PROGRAMS:-jixia-debate}"
  local program
  for program in $programs; do
    log "Restarting supervisor program: $program"
    supervisor_restart_or_start "$program"
  done

  wait_for_health "$health_url"

  if [[ "${JIXIA_RUN_SMOKE:-0}" == "1" ]]; then
    local smoke_base="${JIXIA_SMOKE_BASE_URL:-${health_url%/api/health}}"
    log "Running smoke against $smoke_base"
    PHDEBATE_BASE_URL="$smoke_base" npm run smoke
  fi

  log "Deployment complete: branch=$branch"
}

main "$@"
