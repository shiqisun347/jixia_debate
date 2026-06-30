#!/usr/bin/env bash
set -euo pipefail

ROOT=/home/ubuntu/sunsq/debateall
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

wait_tcp() {
  local host=$1
  local port=$2
  local name=$3
  local timeout=${4:-180}
  local deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    if timeout 2 bash -lc ":</dev/tcp/${host}/${port}" 2>/dev/null; then
      log "${name} is listening on ${host}:${port}"
      return 0
    fi
    sleep 3
  done
  log "ERROR: ${name} did not open ${host}:${port} within ${timeout}s"
  return 1
}

wait_http() {
  local url=$1
  local name=$2
  local timeout=${3:-180}
  local deadline=$((SECONDS + timeout))
  local body
  local err
  body=$(mktemp -t jixia-start-health.XXXXXX)
  err=$(mktemp -t jixia-start-health.err.XXXXXX)
  while (( SECONDS < deadline )); do
    if curl -fsS --max-time 5 "$url" >"$body" 2>"$err"; then
      log "${name} health ok: $(cat "$body")"
      rm -f "$body" "$err"
      return 0
    fi
    sleep 3
  done
  log "ERROR: ${name} health check failed: ${url}"
  cat "$err" 2>/dev/null || true
  rm -f "$body" "$err"
  return 1
}

require_paths() {
  test -d "$ROOT"
  run_sudo test -x /root/autodl-tmp/funasr-nano-venv/bin/python
  run_sudo test -f /root/autodl-tmp/funasr-nano-service/serve_realtime_ws_compat.py
  run_sudo test -d /root/autodl-tmp/LightTTS
  run_sudo test -d /root/autodl-tmp/models/models/FunAudioLLM/Fun-CosyVoice3-0.5B-2512
  test -f "$ROOT/config.env"
}

smoke_asr() {
  sudo -n /root/autodl-tmp/funasr-nano-venv/bin/python - <<'PY'
import asyncio
import websockets

async def main():
    async with websockets.connect("ws://127.0.0.1:10095", max_size=None, open_timeout=10) as ws:
        first = await ws.recv()
        await ws.send("START")
        second = await ws.recv()
        await ws.send("STOP")
        final = await ws.recv()
        stopped = await ws.recv()
        print(first)
        print(second)
        print(final)
        print(stopped)

asyncio.run(main())
PY
}

main() {
  log "checking sudo and required paths"
  run_sudo true
  require_paths

  log "stopping services not used by this deployment"
  run_sudo supervisorctl stop qwen3-asr >/dev/null 2>&1 || true
  run_sudo supervisorctl stop qwen3-tts >/dev/null 2>&1 || true
  run_sudo supervisorctl stop qwen3-tts-webui >/dev/null 2>&1 || true

  log "reloading supervisor configuration"
  run_sudo supervisorctl reread >/dev/null || true
  run_sudo supervisorctl update >/dev/null || true

  log "starting local ASR and LightTTS/CosyVoice3"
  run_sudo supervisorctl restart "$ASR_SERVICE" >/dev/null || run_sudo supervisorctl start "$ASR_SERVICE" >/dev/null
  run_sudo supervisorctl restart "$TTS_SERVICE" >/dev/null || run_sudo supervisorctl start "$TTS_SERVICE" >/dev/null

  log "restarting jixia backend and voice agent"
  user_systemctl daemon-reload >/dev/null 2>&1 || true
  user_systemctl restart "$BACKEND_SERVICE"
  user_systemctl restart "$VOICE_AGENT_SERVICE"

  wait_tcp 127.0.0.1 10095 "FunASR ASR" 240
  wait_tcp 127.0.0.1 8080 "LightTTS/CosyVoice3" 300
  wait_http http://127.0.0.1:6016/api/health "jixia backend" 120
  wait_http http://127.0.0.1:6008/health "jixia voice agent" 120

  log "ASR websocket smoke test"
  smoke_asr

  log "active speech providers"
  grep -E 'PHDEBATE_FUNASR_ASR_URL|PHDEBATE_LOCAL_TTS_BASE_URL|PHDEBATE_VOICE_AGENT_BASE_URL' "$ROOT/config.env" || true

  log "GPU processes"
  nvidia-smi pmon -c 1 | sed -n '1,20p' || true

  log "startup complete"
}

main "$@"
