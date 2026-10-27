#!/usr/bin/env bash
set -euo pipefail
module_dir="$(cd "$(dirname "$0")/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
swiftc "$module_dir/ios/BluetoothFrame.swift" "$module_dir/tests/BluetoothFrameTests.swift" -o "$test_dir/frames"
"$test_dir/frames"
swiftc -typecheck "$module_dir/ios/BluetoothFrame.swift" "$module_dir/ios/BluetoothCentral.swift"
swiftc -frontend -parse "$module_dir/ios/BluetoothTransportModule.swift"
