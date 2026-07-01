#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

"$SCRIPT_DIR/stop-full-local-6016.sh"
"$SCRIPT_DIR/start-full-local-6016.sh"
