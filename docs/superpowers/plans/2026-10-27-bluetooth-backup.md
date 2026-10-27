# Bluetooth Backup Implementation Plan

> Execution: parallel receiver and mobile native module tasks, with connection management, UI, integration and verification in the main task.

**Goal:** Add real BLE as a backup to the existing WebSocket connection without changing JSON v1 or port 9876.

**Architecture:** Phone is a BLE central; Mac is a CoreBluetooth peripheral. Both paths feed the existing authenticated protocol session and input engine. A single mobile connection manager owns the active input session; Wi-Fi is preferred, and unauthenticated Wi-Fi probes can detect recovery while Bluetooth controls the Mac.

**Tech stack:** Existing Expo development build and local Expo Swift/Kotlin modules; macOS CoreBluetooth; TypeScript; Swift Testing and Vitest.

**Spec:** User's Bluetooth backup requirements in this task. BLE transport contract is recorded in `docs/BLUETOOTH.md`.

## Constraints and decisions

- Preserve WebSocket v1 messages, native Origin, discovery, endpoint editing and port 9876.
- Use BLE GATT for iOS/Android/macOS. Do not implement Bluetooth HID or generic RFCOMM.
- Require encrypted GATT writes/notifications and retain app code/token authorization.
- Save explicit receiver selection; never automatically control a random nearby Mac.
- Disconnect/release the active session before authenticating another transport. Receiver independently enforces one controller.
- No queued input replay after reconnect; retain 16 ms input coalescing outside React.
- Support foreground control. Backgrounding releases input and disconnects.
- Physical BLE/phone acceptance is separate from automated tests and build checks.

## Tasks

- [x] Add `Transport`, `WiFiTransport`, and `BluetoothTransport`. Preserve the `RemoteClient` public Wi-Fi API and tests; run authentication over either transport.
- [x] Add `ConnectionManager` and deterministic failover tests for all six scenarios, manual modes, cancellation, identity pinning and no duplicate input.
- [x] Add native `bluetooth-transport` module (Swift/Kotlin), encrypted subscribe, ordered MTU-aware framing, deadlines, backpressure, permissions and lifecycle cleanup.
- [x] Add Mac BLE peripheral and framing tests. Create sessions on the existing receiver serial queue with shared controller ownership, pairing, revocation and input processing. Keep BLE independent of listener startup.
- [x] Add Automatic/Wi-Fi/Bluetooth selection, BLE device discovery, persisted target and active transport display to existing screens.
- [x] Verify protocol generation, TypeScript, unit suites, real WebSocket integration, Mac packaged app and web UI. Check native autolinking/config; record build-toolchain or hardware limits.
- [x] Document commands, permissions, pairing/unpairing, tradeoffs and physical acceptance procedure with exact verified/unverified boundaries.

## Verification boundary

All implementation and available local checks are complete. Physical BLE acceptance and full phone native compilation remain pending; see `docs/VERIFICATION.md` and `docs/BLUETOOTH.md`. No attached phone or complete mobile native toolchains were available.
