#!/usr/bin/env bash
set -euo pipefail

ROOT=/home/ubuntu/sunsq/debateall
CERT_FILE=${PHDEBATE_TLS_CERT_FILE:-$ROOT/runtime/tls/ip-selfsigned.crt}
KEY_FILE=${PHDEBATE_TLS_KEY_FILE:-$ROOT/runtime/tls/ip-selfsigned.key}

mkdir -p "$ROOT/runtime/logs" "$ROOT/apps/backend/storage/audio"
cd "$ROOT/apps/backend"

set -a
source "$ROOT/.env"
set +a

exec "$ROOT/.venv/bin/uvicorn" app.main:app \
  --host 0.0.0.0 \
  --port 12292 \
  --ssl-certfile "$CERT_FILE" \
  --ssl-keyfile "$KEY_FILE" \
  --no-access-log
