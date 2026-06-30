#!/usr/bin/env bash
set -euo pipefail

ROOT=/home/ubuntu/sunsq/phdebate
CERT_FILE=${PHDEBATE_TLS_CERT_FILE:-$ROOT/runtime/tls/ip-selfsigned.crt}
KEY_FILE=${PHDEBATE_TLS_KEY_FILE:-$ROOT/runtime/tls/ip-selfsigned.key}

mkdir -p "$ROOT/runtime/logs" "$ROOT/apps/backend/storage/audio"
cd "$ROOT/apps/backend"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  source "$ROOT/.env"
  set +a
fi

exec "$ROOT/.venv/bin/python" -m uvicorn app.main:app \
  --host 0.0.0.0 \
  --port 12292 \
  --ssl-certfile "$CERT_FILE" \
  --ssl-keyfile "$KEY_FILE" \
  --no-access-log
