#!/usr/bin/env bash
set -euo pipefail

ROOT=${ROOT:-$(pwd)}
APP_USER=${APP_USER:-ubuntu}
BACKEND_SERVICE=jixia-debate-6016.service
VOICE_AGENT_SERVICE=jixia-voice-agent-6008.service
ASR_SERVICE=funasr-nano-asr
TTS_SERVICE=lighttts

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

run_sudo() {
  if (( EUID == 0 )); then
    "$@"
  else
    sudo "$@"
  fi
}

user_systemctl() {
  if (( EUID == 0 )); then
    local app_uid
    app_uid=$(id -u "$APP_USER")
    runuser -l "$APP_USER" -c "XDG_RUNTIME_DIR=/run/user/${app_uid} systemctl --user $*"
  else
    export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
    systemctl --user "$@"
  fi
}

port_is_listening() {
  local host=$1
  local port=$2
  timeout 1 bash -lc ":</dev/tcp/${host}/${port}" 2>/dev/null
}

wait_tcp_closed() {
  local host=$1
  local port=$2
  local name=$3
  local timeout_seconds=${4:-60}
  local deadline=$((SECONDS + timeout_seconds))

  while (( SECONDS < deadline )); do
    if ! port_is_listening "$host" "$port"; then
      log "${name} stopped on ${host}:${port}"
      return 0
    fi
    sleep 2
  done

  log "WARNING: ${name} still appears to be listening on ${host}:${port} after ${timeout_seconds}s"
  return 1
}

main() {
  log "using ROOT=${ROOT}"
  log "stopping jixia backend and voice agent"
  user_systemctl daemon-reload >/dev/null 2>&1 || true
  user_systemctl stop "$VOICE_AGENT_SERVICE" || true
  user_systemctl stop "$BACKEND_SERVICE" || true

  log "stopping local ASR and LightTTS/CosyVoice3"
  run_sudo supervisorctl stop "$TTS_SERVICE" >/dev/null 2>&1 || true
  run_sudo supervisorctl stop "$ASR_SERVICE" >/dev/null 2>&1 || true

  log "waiting for ports to close"
  wait_tcp_closed 127.0.0.1 6008 "jixia voice agent" 60 || true
  wait_tcp_closed 127.0.0.1 6016 "jixia backend" 60 || true
  wait_tcp_closed 127.0.0.1 8080 "LightTTS/CosyVoice3" 90 || true
  wait_tcp_closed 127.0.0.1 10095 "FunASR ASR" 90 || true

  log "stop complete"
}

main "$@"
