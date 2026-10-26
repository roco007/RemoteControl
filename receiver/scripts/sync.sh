#!/bin/bash
set -euo pipefail

RECEIVER_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$RECEIVER_ROOT/.." && pwd)"
APP_PATH="$REPO_ROOT/dist/Remote Mac Control.app"
RECEIVER_PORT="${REMOTE_MAC_PORT:-9876}"

if ! [[ "$RECEIVER_PORT" =~ ^[1-9][0-9]{0,4}$ ]] || (( RECEIVER_PORT > 65535 )); then
  printf 'Invalid REMOTE_MAC_PORT: %s\n' "$RECEIVER_PORT" >&2
  exit 1
fi

# Keep the current receiver running if the updated source fails to compile.
swift build --package-path "$RECEIVER_ROOT" -c release --product RemoteMacReceiver

# Quit only this checkout's app and wait before replacing its signed executable.
swift - "$APP_PATH/Contents/MacOS/RemoteMacReceiver" <<'SWIFT'
import AppKit

let executablePath = URL(fileURLWithPath: CommandLine.arguments[1])
    .resolvingSymlinksInPath().path
let applications = NSWorkspace.shared.runningApplications.filter {
    $0.executableURL?.resolvingSymlinksInPath().path == executablePath
}
for application in applications {
    guard application.terminate() else {
        fputs("Could not quit this checkout's receiver. Quit it from its menu and retry.\n", stderr)
        exit(1)
    }
}

let deadline = Date().addingTimeInterval(10)
while applications.contains(where: { !$0.isTerminated }) && Date() < deadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
}
guard applications.allSatisfy({ $0.isTerminated }) else {
    fputs("Receiver did not quit within 10 seconds. Its app bundle was not replaced.\n", stderr)
    exit(1)
}
SWIFT

if /usr/sbin/lsof -nP -iTCP:"$RECEIVER_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  printf 'Port %s is still in use. Quit the other receiver/process and retry.\n' "$RECEIVER_PORT" >&2
  exit 1
fi

# The second Swift build is incremental; reuse the existing packaging/signing flow.
bash "$RECEIVER_ROOT/scripts/package.sh"
/usr/bin/open -n \
  --env "REMOTE_MAC_PORT=$RECEIVER_PORT" \
  --env "REMOTE_MAC_ALLOWED_ORIGINS=${REMOTE_MAC_ALLOWED_ORIGINS:-}" \
  "$APP_PATH"

printf 'Updated and opened %s\n' "$APP_PATH"
