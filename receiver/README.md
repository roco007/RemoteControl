# Native macOS receiver

This is a standalone Swift/AppKit application. It does not load Node.js, React Native, Expo, or any transmitter code. Runtime support is macOS 13+; building requires Swift 6 and Apple command-line tools. The tests use Swift Testing (the installed framework requires macOS 14+).

From the repository root:

```sh
bash receiver/scripts/test.sh
bash receiver/scripts/package.sh
open "dist/Remote Mac Control.app"
```

Alternatively `npm run receiver` rebuilds and runs the packaged application in the foreground. A menu-bar mouse icon provides the main window, disconnect, and quit commands. Closing the window leaves the receiver running.

The bundle is signed ad hoc by default. Set `REMOTE_MAC_SIGNING_IDENTITY` to your Developer ID identity for a distributable signature; notarization is a separate release step. Move the bundle to a stable location such as `/Applications` before enabling Accessibility. Replacing an ad-hoc-signed binary can invalidate a previous Accessibility grant; remove/re-add the app if macOS stops recognizing it after a rebuild.

## Permissions

Enable **Remote Mac Control** in **System Settings → Privacy & Security → Accessibility**. The receiver checks permission continuously, reports its status to the phone, and releases held input when permission is lost. Its Settings button opens that pane; the application never changes permission itself. Modern macOS can also request **Local Network** access. Permit the receiver and allow incoming local-network connections if the firewall prompts. Input Monitoring and Screen Recording are not required by this implementation.

## Network and security

- Defaults to TCP 9876; override with `REMOTE_MAC_PORT=9877 npm run receiver`.
- Advertises `_remotemac._tcp` using Network.framework Bonjour, with protocol version and persistent server ID in TXT metadata.
- Accepts only private IPv4, IPv6 ULA/link-local, and loopback peers. It never creates router forwarding rules. The source filter also permits private-address VPN peers, so only run on networks you trust.
- Random six-digit pairing codes expire after two minutes and rotate after successful pairing. Five failed attempts within one minute globally impose a one-minute lockout. Valid saved tokens still work while code pairing is locked.
- Each device receives a random 256-bit bearer token. The receiver stores only its SHA-256 hash, device name, ID, and pair time in the login Keychain. Revoke a device from the receiver window to immediately disconnect it and invalidate its token.
- Only one authenticated phone controls input at a time. Unauthenticated connections time out after 30 seconds; authenticated clients must send input or ping at least every 20 seconds.
- Every client frame has a strictly increasing sequence, is at most 16 KiB, and passes strict field/value validation. More than 300 messages per second closes the session. At most eight transport connections are accepted.
- Browser WebSocket origins are rejected by default. For deliberate browser development only, launch with an exact allowlist, for example `REMOTE_MAC_ALLOWED_ORIGINS=http://localhost:8081 npm run receiver`. Do not use `*`; it is not interpreted as a wildcard.
- Version 1 uses plaintext `ws://` on the trusted LAN. Pairing prevents unauthenticated control but does not prevent local traffic interception. Do not forward the port, use public/guest Wi-Fi, or treat this as an encrypted remote-access service. TLS belongs at the isolated Network transport boundary in a later protocol version.

## Input semantics

The validated session calls a testable `InputController`, which tracks pressed keys/buttons. The real `NativeInput` sink posts CoreGraphics `CGEvent` mouse movement, button/down/up/click-count, continuous two-axis scrolling, keyboard down/up/repeat, modifier flags, and Unicode events. Relative movement uses the current system cursor and clamps to active displays. Physical key codes use ANSI positions and the current macOS input source; the Unicode composition channel is layout independent.

Pinch messages map to one Command-plus/minus application zoom step. Two-finger horizontal navigation maps to Command-[ / Command-]. Three/four-finger swipes map to Control-arrow system shortcuts (Spaces, Mission Control, App Exposé); those shortcuts must be enabled in macOS and may be customized by the user. These are public native keyboard actions, not undocumented multitouch-event synthesis. Apps that do not support the shortcut may ignore it. There is no synthetic momentum scroll or force touch.

Disconnect, explicit `release_all`, timeout, sleep, revocation, malformed/replayed frames, and permission loss release tracked keys/buttons. Composed Unicode is ignored while a shortcut modifier is held to avoid accidental commands.

## Diagnostics and tests

Every incoming JSON command produces one structured log line containing the receive time, session/device ID, command type and fields (including keys, modifiers, mouse deltas, and sequence), and result. `dispatched` means the command reached the input handler; it does not confirm that macOS or the target app acted on it. Rejected commands include a result such as `permission_required` or `replayed_message`. Invalid or rate-limited payloads log only metadata and the rejection reason, never the raw payload.

Logs appear immediately in the terminal when running `npm run receiver`. For an app opened from Finder, watch the same logs in Console.app (subsystem `com.remotemac.receiver`, category `commands`, with Info messages enabled), or run:

```sh
/usr/bin/log stream --level info --style compact --predicate 'subsystem == "com.remotemac.receiver" AND category == "commands"'
```

Pairing codes, authentication tokens, and composed `keyboard_text` content are redacted; composed text includes its UTF-16 length. Individual physical key names and modifiers are included. WebSocket control frames and transport rejections before JSON command handling are outside this command log.

```sh
"dist/Remote Mac Control.app/Contents/MacOS/RemoteMacReceiver" --diagnostics
"dist/Remote Mac Control.app/Contents/MacOS/RemoteMacReceiver" --verify-input
bash receiver/scripts/test.sh
```

Diagnostics reports permission, network addresses, default port, Bonjour service and protocol version without starting a listener. Tests use an in-memory trust store and recording input sink; they never post input or modify the Keychain. The test wrapper handles the standalone command-line toolchain's missing XCTest and incomplete Swift Testing Foundation overlay. A full Xcode toolchain uses the regular `swift test` path.

`--verify-input` explicitly tests real native input in its own focused text field: eight-pixel cursor movement and restoration, Unicode insertion, Backspace, and Command-A. It starts no listener and touches no credentials. Results are printed as JSON. It aborts on focus loss and posts no events if permission is missing. Run it while you are not using the mouse/keyboard. A CLI check does not grant permission to the separately opened app. Physical Caps Lock changes are reconciled before remote key events; the phone's Caps indicator reflects its own toggle, not a two-way hardware state display.

For browser integration tests only, the harness below accepts an exact preview origin via `REMOTE_MAC_TEST_ORIGIN=http://localhost:8084`.

`ReceiverIntegrationHarness` is a test-only executable, never bundled in the production app. Build with `swift build --package-path receiver --product ReceiverIntegrationHarness`. Run `receiver/.build/debug/ReceiverIntegrationHarness /absolute/new/state.json`. It binds **127.0.0.1 only** on an OS-selected port with actual Network.framework WebSocket transport, in-memory credentials and a recording sink. It writes a private mode-0600 state file containing port, temporary code, permission, session and recorded actions. `SIGUSR1` toggles test permission, `SIGUSR2` revokes test devices, and `SIGTERM` cleans up the file. It neither advertises Bonjour nor posts native events. This harness verifies transport/session behavior, not physical-device reachability or actual OS input delivery.
