#!/bin/bash
set -euo pipefail
RECEIVER_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$RECEIVER_ROOT/.." && pwd)"
swift build --package-path "$RECEIVER_ROOT" -c release --product RemoteMacReceiver
BIN_DIR="$(swift build --package-path "$RECEIVER_ROOT" -c release --show-bin-path)"
APP_PATH="$REPO_ROOT/dist/Remote Mac Control.app"
mkdir -p "$APP_PATH/Contents/MacOS" "$APP_PATH/Contents/Resources"
cp "$BIN_DIR/RemoteMacReceiver" "$APP_PATH/Contents/MacOS/RemoteMacReceiver"
cp "$RECEIVER_ROOT/Info.plist" "$APP_PATH/Contents/Info.plist"
cp "$RECEIVER_ROOT/Resources/AppIcon.icns" "$APP_PATH/Contents/Resources/AppIcon.icns"
chmod +x "$APP_PATH/Contents/MacOS/RemoteMacReceiver"
SIGNING_IDENTITY="${REMOTE_MAC_SIGNING_IDENTITY:--}"
codesign --force --sign "$SIGNING_IDENTITY" --options runtime "$APP_PATH"
codesign --verify --strict "$APP_PATH"
printf 'Built %s\n' "$APP_PATH"
