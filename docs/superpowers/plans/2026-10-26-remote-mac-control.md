# Remote Mac Control Implementation Plan

**Goal:** Build the two real applications described in the user's attached brief.

**Architecture:** Standalone Swift receiver and Expo transmitter communicate via an authenticated versioned WebSocket contract. Shared data defines the contract but neither application depends on the other application's runtime.

**Tech Stack:** Expo 58, React Native, TypeScript, Gesture Handler, Swift 6.2 (Swift 5 language mode), AppKit, Network, CoreGraphics, Security.

**Spec:** `docs/superpowers/specs/2026-10-26-remote-mac-design.md`

## Global constraints

- Two applications only, receiver independent of React Native.
- Real OS input APIs and real native discovery; no simulated success.
- Auth required before control, bounded protocol validation, graceful input release.
- Preserve user data and report physical-device and permission boundaries honestly.

## Tasks and verification

- [x] 1. Define protocol constants, typed messages, validation and shared fixtures; test invalid and valid messages and generator drift.
- [x] 2. Build native receiver transport, pairing, permissions, event engine, UI and packaging. Test protocol, authentication, session lifecycle and permission failure before network integration.
- [x] 3. Build phone connection, storage, coalescing, gesture interpreter and keyboard controller with tests for ordering, reconnect, taps, drag, pinch, scroll, shortcuts and cleanup.
- [x] 4. Build iOS/Android Bonjour module and Expo configuration; verify autolinking/config and document development-build requirements.
- [x] 5. Compose touchpad, keyboard, connection/settings UI. Typecheck and export; inspect real browser rendering and connection workflow.
- [x] 6. Run real WebSocket integration against the packaged receiver, inspect the native UI, validate packaging and document exact launch commands and remaining device checks.

Independent receiver, transmitter-core and discovery work can proceed in parallel after the protocol is fixed, with separate file ownership. Root owns shared protocol, UI composition, integration and final review. This follows the user-authorized implementation sequence without adding an approval stop.

## Final verification boundary

Implemented tasks are complete. Native receiver input and loopback WebSocket transport were exercised; phone builds and physical multitouch/discovery remain device acceptance checks. See `docs/VERIFICATION.md` for evidence and limitations. No native phone build or end-to-end phone success is claimed.
