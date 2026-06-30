#!/usr/bin/env bash
set -euo pipefail

ROOT=/home/ubuntu/deployments/phdebate-4afb309-6016
BACKEND_SERVICE=phdebate-4afb309-6016.service
ASR_SERVICE=funasr-nano-asr
TTS_SERVICE=qwen3-tts

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
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
  while (( SECONDS < deadline )); do
    if curl -fsS --max-time 5 "$url" >/tmp/phdebate-start-health.json 2>/tmp/phdebate-start-health.err; then
      log "${name} health ok: $(cat /tmp/phdebate-start-health.json)"
      return 0
    fi
    sleep 3
  done
  log "ERROR: ${name} health check failed: ${url}"
  cat /tmp/phdebate-start-health.err 2>/dev/null || true
  return 1
}

require_paths() {
  test -d "$ROOT"
  sudo -n test -x /root/autodl-tmp/funasr-nano-venv/bin/python
  sudo -n test -f /root/autodl-tmp/funasr-nano-service/serve_realtime_ws_compat.py
  sudo -n test -x /root/autodl-tmp/qwen3-tts-openai/start_after_asr.sh
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
  sudo -n true
  require_paths

  log "stopping GPU services not used by this deployment"
  sudo -n supervisorctl stop lighttts >/dev/null 2>&1 || true
  sudo -n supervisorctl stop qwen3-asr >/dev/null 2>&1 || true

  log "reloading supervisor configuration"
  sudo -n supervisorctl reread >/dev/null || true
  sudo -n supervisorctl update >/dev/null || true

  log "starting local ASR and TTS on GPU 0"
  sudo -n supervisorctl restart "$ASR_SERVICE" >/dev/null || sudo -n supervisorctl start "$ASR_SERVICE" >/dev/null
  sudo -n supervisorctl restart "$TTS_SERVICE" >/dev/null || sudo -n supervisorctl start "$TTS_SERVICE" >/dev/null

  log "restarting phdebate backend"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  systemctl --user restart "$BACKEND_SERVICE"

  wait_tcp 127.0.0.1 10095 "FunASR ASR" 240
  wait_http http://127.0.0.1:12302/health "Qwen3 TTS" 240
  wait_http http://127.0.0.1:6016/api/health "phdebate backend" 120

  log "ASR websocket smoke test"
  smoke_asr

  log "active speech providers"
  grep -E 'PHDEBATE_FUNASR_ASR_URL|PHDEBATE_LOCAL_TTS_BASE_URL|PHDEBATE_LOCAL_ASR_BASE_URL' "$ROOT/config/phdebate-6016.env" || true

  log "GPU processes"
  nvidia-smi pmon -c 1 | sed -n '1,20p' || true

  log "startup complete"
}

main "$@"
