# Remote Mac Control

The supplied brief authorizes implementation of an Expo phone transmitter and an independent native macOS receiver in this empty workspace. The current folder is the monorepo root; there are exactly two applications, `transmitter/` and `receiver/`, with a language-neutral contract under `shared/`.

## Architecture

- Expo SDK 58, TypeScript, React Native Gesture Handler. Gesture interpretation, input lifecycle, coalescing, and connection management are independently testable classes outside React rendering.
- Swift Package with an AppKit status/window app, Network.framework WebSockets and Bonjour, CoreGraphics input posting, and Keychain credential storage. No Node runtime is needed by the receiver.
- `shared/protocol-manifest.json` generates TypeScript/Swift constants. JSON messages carry `v`, `type`, `seq`, and `timestamp`; validators reject wrong types, out-of-range values, unknown fields and unknown message names. Common fixtures verify both runtimes.
- Pairing: short-lived six-digit code, attempt limits, random per-device 256-bit token, secure storage on both ends, revocation in the Mac UI, one authenticated controlling client. Only loopback/private/link-local peers; no port forwarding or UPnP. Plain local WebSockets in v1 are not encrypted; trusted LAN only. Transport is isolated for future WSS.
- Pointer deltas are coalesced at about 60 Hz; button/key transitions flush preceding movement. Disconnect, backgrounding, mode changes and permission loss release held inputs.
- Bonjour uses a local native Expo module (iOS NetServiceBrowser and Android NsdManager). Expo Go has a clear discovery-unavailable state and manual hostname fallback. Development builds enable discovery.
- Native limitations: pinch becomes Command +/- application zoom; three/four-finger directional swipes become Control-arrow Mission Control/Spaces shortcuts. Two-finger pan provides horizontal/vertical native scrolling; modifier-assisted app navigation is explicit. No private multitouch injection API.

## Experience

A dark, restrained trackpad occupies the main screen, with connection status, a compact settings sheet, explicit left/right buttons, and a persistent Mouse/Keyboard switch. Keyboard mode includes physical key down/up, sticky modifiers, arrows, function keys, repeat, Unicode composition field, haptics and landscape layout. Settings persist sensitivity, natural scroll, taps, haptics and last endpoint. Pairing is available in the connection sheet. The receiver shows network address, code, permissions, session and trusted devices.

## Validation boundaries

Automated tests cover wire validation, auth/session failure paths, gesture interpretation, input ordering, modifier lifecycle and reconnection. Swift build, app bundle launch, WebSocket integration, Expo typecheck/export and visible web UI are validated locally. Physical phone multitouch, discovery and actual CGEvent injection require the relevant device and user-granted Accessibility. Report unverified boundaries explicitly.
