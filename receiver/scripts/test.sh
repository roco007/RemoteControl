#!/bin/bash
set -euo pipefail
RECEIVER_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVELOPER_PATH="$(xcode-select -p)"
if [[ "$DEVELOPER_PATH" == *CommandLineTools ]]; then
  FRAMEWORK_PATH="$DEVELOPER_PATH/Library/Developer/Frameworks"
  exec swift test --package-path "$RECEIVER_ROOT" --disable-xctest \
    -Xswiftc "-F$FRAMEWORK_PATH" -Xswiftc -Xfrontend -Xswiftc -disable-cross-import-overlays \
    -Xlinker "-F$FRAMEWORK_PATH" -Xlinker -rpath -Xlinker "$FRAMEWORK_PATH" "$@"
else
  exec swift test --package-path "$RECEIVER_ROOT" "$@"
fi
