#!/bin/bash
set -euo pipefail
RECEIVER_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$RECEIVER_ROOT/.." && pwd)"
bash "$RECEIVER_ROOT/scripts/package.sh"
exec "$REPO_ROOT/dist/Remote Mac Control.app/Contents/MacOS/RemoteMacReceiver" "$@"
