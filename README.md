# Remote Mac Control

A phone touchpad and keyboard for your Mac, over the same local network. The repository contains two applications: an Expo transmitter for iPhone/Android and an independent native Swift receiver for macOS. The receiver posts real system mouse and keyboard events.

Bluetooth backup is available in rebuilt native phone apps. See the [Bluetooth setup, architecture and device verification guide](docs/BLUETOOTH.md).

The implementation, native receiver bundle, automated tests, and browser UI are available. An Android phone running Expo Go has paired and connected to the Mac over Wi-Fi; receiver handshakes also passed through Android USB forwarding. A standalone phone build, native discovery and physical multitouch verification are still required. See [verification evidence and boundaries](docs/VERIFICATION.md).

## Quick start

From this repository's root:

```sh
npm install
npm run receiver
```

This builds `dist/Remote Mac Control.app` and runs its executable in the foreground. Keep the receiver running. In its window, enable Accessibility using the Settings button and note the Mac address and six-digit pairing code.

In another terminal:

```sh
cd transmitter
npx expo start
```

Open the project in an installed **development build** to enable automatic Mac discovery. Because `expo-dev-client` is installed, the default Expo command targets a development build. If you only have a compatible Expo Go version:

```sh
cd transmitter
npx expo start --go
```

In Expo Go, open Connection & settings and enter the receiver's hostname or IP manually. Do not enter `http://`, `ws://`, a path, or credentials in the hostname field. The default port is **9876**. Enter the code from your Mac, then select **Start controlling**. Mouse and Keyboard remain one tap apart.

### Android development over USB

Keep the Mac receiver running, connect the Android phone by USB, enable USB debugging, and accept the phone's debugging authorization. From the repository root:

```sh
adb devices
adb reverse tcp:9876 tcp:9876
adb reverse tcp:8082 tcp:8082
cd transmitter
npx expo start --go --localhost --port 8082
```

The phone must appear as `device` in `adb devices`. In another terminal, open the project in the installed Expo Go app:

```sh
adb shell am start -a android.intent.action.VIEW -d exp://127.0.0.1:8082 -p host.exp.exponent
```

In **Connection & settings**, enter hostname **127.0.0.1** and port **9876**, then pair with the code shown on the Mac. Port **8082** serves the app from Metro; port **9876** connects to the Mac receiver. If Metro uses a different port, update its reverse command, Expo command, and launch URL together.

Rerun both `adb reverse` commands after reconnecting USB. With multiple devices or emulators connected, use `adb -s <serial>` for each reverse and launch command; copy the serial from `adb devices`.

## Requirements and dependencies

| Component | Requirements |
| --- | --- |
| JavaScript development | Node.js 22.13+; npm; install from the root workspace |
| Native receiver runtime | macOS 13+; Accessibility permission; reachable local network |
| Receiver build | Swift 6 and Apple command-line tools; no Node runtime needed by the built app |
| Receiver tests | macOS 14+ for the installed Swift Testing framework; use the supplied wrapper |
| iOS native development build | Full Xcode, iOS SDK and device signing; or EAS Build |
| Android native development build | Android SDK, suitable JDK and connected phone/emulator; or EAS Build |

The installed stack is Expo 58, React 19.3, React Native 0.88, TypeScript, and React Native Gesture Handler 3.3. Expo SecureStore holds phone credentials, AsyncStorage holds preferences, and Expo Crypto, Haptics, KeepAwake and SafeAreaContext support the mobile experience. The receiver uses only Apple frameworks: AppKit, Network, CoreGraphics, ApplicationServices, Security and CryptoKit.

This workspace was initialized on Apple Silicon macOS 26.6.2 with Node 22.23.2 and Swift 6.2. Full Xcode, an Android SDK and a Java runtime were unavailable; JavaScript bundle export is not a native phone build.

## Architecture

```text
RemoteControl/                         # remote-mac-control monorepo
├── transmitter/                       # Expo mobile application
│   ├── components/                    # Trackpad, keyboard, shared controls
│   ├── screens/                       # Connection and settings
│   ├── gestures/                      # Native recognizers + pure interpretation
│   ├── networking/                    # WebSocket session, endpoint validation
│   ├── services/                      # Coalescing, keyboard, settings, credentials
│   ├── modules/lan-discovery/          # Swift/iOS and Kotlin/Android Bonjour
│   └── plugins/                       # Native local-network configuration
├── receiver/                          # Standalone Swift package/application
│   ├── Sources/ReceiverCore/          # Protocol, auth, sessions, input dispatch
│   ├── Sources/RemoteMacReceiver/     # AppKit UI and actual CGEvent sink
│   ├── Tests/                         # Pure receiver tests
│   └── scripts/                       # Build, package, run and test
├── shared/                            # Language-neutral manifest + wire types
├── scripts/                           # Integration-test orchestration
└── docs/                              # Protocol, verification, design and plan
```

```mermaid
flowchart LR
  subgraph Phone[Expo transmitter]
    UI[Touchpad / keyboard] --> G[Gesture and key controllers]
    G --> C[Delta coalescer]
    C --> W[Authenticated WebSocket client]
    D[Native Bonjour discovery] --> W
    S[SecureStore credentials] --> W
  end
  W <-->|Versioned JSON over local Wi-Fi| N
  subgraph Mac[Native macOS receiver]
    N[Network.framework WebSocket] --> V[Validation / authentication / session]
    K[Keychain trusted devices] --> V
    V --> I[InputController]
    I --> E[CGEvent system mouse / keyboard]
    P[Accessibility status] --> V
  end
```

The transmitter captures intent, maintains connection state and sends protocol messages. The receiver authenticates devices, validates every message and translates input into native events. Neither application imports the other application's runtime. `ReceiverIntegrationHarness` is a test utility, not a third application or production listener.

## Controls

| Interaction | Result |
| --- | --- |
| One-finger movement | Relative cursor movement with sensitivity and bounded acceleration |
| One-finger tap / double tap | Left click / double click |
| Hold one finger, then move | Hold left mouse button and drag; release on lift |
| Left / Right click buttons | Physical button down/up; hold a button while moving on the pad to drag |
| ×2 button | Explicit double click |
| Left / Right / Up / Down buttons inside the pad | Direct Control-arrow shortcuts for desktops and macOS overview, with complete modifier/key press and release |
| Two-finger movement | Horizontal and vertical native pixel scrolling |
| Two-finger tap | Right click, when enabled |
| Pinch | Application zoom through Command-plus/minus shortcuts |
| Three/four-finger swipe | Desktops, full-screen apps and Mission Control using macOS shortcuts |
| Keyboard keys | Real key down/up; holding a normal key repeats after a short delay |
| Modifier keys | Tap to latch Shift, Control, Option or Command; tap again to release |
| Fn / # | Punctuation, F1–F12, Home/End, Page Up/Down and forward Delete |
| Unicode composition | Compose on the phone and tap Send; separate from physical shortcut events |
| Release all | Clear held remote buttons/keys and sticky shortcut modifiers |

The keyboard also includes arrows, Tab, Escape, Backspace, Return, Space, Caps Lock and quick Command shortcuts. Portrait and landscape layouts are supported. The Mac uses its current keyboard input source for ANSI physical key positions; use the Unicode field for layout-independent text.

Multi-finger system actions are public keyboard shortcut mappings. They do not synthesize private macOS trackpad events. Enable the corresponding shortcuts under macOS Keyboard → Keyboard Shortcuts → Mission Control. Zoom depends on the foreground application's shortcut support. Two-finger movement on the phone scrolls in either axis. Three- or four-finger horizontal swipes switch desktops or full-screen apps; an upward swipe opens Mission Control. The protocol additionally supports two-finger horizontal navigation for alternative clients.

Pointer and scroll samples are coalesced outside React rendering at approximately 60 Hz. Key/button transitions flush preceding motion. Backpressure ends an unsafe session instead of queuing stale input. Backgrounding, mode changes, disconnect, sleep, timeout and permission loss release tracked inputs.

## Building the phone app

### VS Code launch commands

Open **Run and Debug**, choose an entry from [.vscode/launch.json](.vscode/launch.json), and press **F5**:

- **Transmitter: Build Android APK (EAS)** runs `eas build --platform android --profile preview --wait` from the transmitter directory. It builds a standalone APK on Expo's servers and prints its download link when complete. The `eas` CLI must be installed (`npm install -g eas-cli`); sign in with `eas login`. The first build may prompt to link the Expo project and set up Android signing.
- **Receiver: Sync latest code and restart** runs `npm run sync:receiver`. It compiles the latest Swift source, gracefully quits this checkout's running receiver, repackages/signs [dist/Remote Mac Control.app](<dist/Remote Mac Control.app>), and opens it again. Saved pairings are preserved. An unrelated process using the receiver port must be stopped separately. Rebuilding with ad hoc signing may require re-enabling Accessibility for the updated app.

Receiver sync updates the app in this checkout's `dist` folder. If you previously copied it to `/Applications`, that separate copy is not updated. The command supports the same `REMOTE_MAC_PORT`, `REMOTE_MAC_ALLOWED_ORIGINS`, and `REMOTE_MAC_SIGNING_IDENTITY` environment variables as the receiver scripts.

### Native builds

The local discovery module is real native code. Expo Go cannot dynamically load it; a development build includes it. See [Expo's development-build guide](https://docs.expo.dev/develop/development-builds/introduction/) and the [module notes](transmitter/modules/lan-discovery/README.md).

Local builds, after installing the relevant platform toolchain:

```sh
cd transmitter
npx expo run:ios --device
# Or:
npx expo run:android --device
```

These commands generate native projects and build the application. After installation, ordinary JavaScript changes use `npx expo start`. Rebuild after changing native modules or native configuration. Generated `ios/` and `android/` projects are ignored; native changes belong in the local module/config plugin.

EAS alternatives, after signing in to your Expo account and configuring project/signing credentials:

```sh
cd transmitter
npx eas-cli login
npx eas-cli build --platform android --profile development
npx eas-cli build --platform ios --profile development
```

Build only the platform you need. The Android development/preview profiles produce APKs. iOS physical-device distribution requires appropriate Apple signing/provisioning; `development-simulator` builds target the simulator. Use `--profile preview` for an internal standalone build without a development server. No EAS build or store submission was performed in this workspace.

`app.config.ts` sets the app identifiers, orientation, SecureStore and development-client plugins. `withLocalNetwork.js` declares iOS Local Network usage and `_remotemac._tcp`, permits local network loads, and enables Android cleartext LAN sockets plus network/multicast permissions. Expo 58 currently targets Android API 36; if upgrading to API 37+, enable the plugin's `targetSdk37` option and retain the runtime permission check before local connections.

## Receiver packaging and permissions

```sh
npm run build:receiver
open "dist/Remote Mac Control.app"
```

The bundle is signed ad hoc. Put it in a stable location such as `/Applications` before granting Accessibility. A Developer ID signature can be selected with `REMOTE_MAC_SIGNING_IDENTITY`; notarization and a universal/Intel release build are separate distribution work. Closing the window leaves the menu-bar receiver running; use its Quit command to stop it.

Enable **Remote Mac Control** in **System Settings → Privacy & Security → Accessibility**. The receiver checks permission and reports missing access to the phone instead of silently discarding control. The Settings button opens the relevant pane; the app never grants its own permissions. See [Apple's Accessibility instructions](https://support.apple.com/guide/mac-help/allow-accessibility-apps-to-access-your-mac-mh43185/mac).

Allow Local Network access on the phone and on macOS if prompted. Permit incoming connections for the receiver when the firewall asks. Do not disable your firewall globally. Input Monitoring and Screen Recording are not required by this implementation. Rebuilding an ad-hoc-signed app can invalidate an existing Accessibility grant; remove and re-add the new bundle if needed.

To use another port:

```sh
REMOTE_MAC_PORT=9877 npm run receiver
```

The receiver advertises its actual port. For manual connections, enter the same port on the phone. There are no hard-coded Mac addresses and no cloud relay.

## Pairing and security

Pair from the phone using the six-digit code visible in the Mac window. Codes expire after two minutes and rotate after a successful pairing. Five failed attempts within one minute impose a one-minute global code lockout. Saved valid tokens can still authenticate during that lockout.

The phone generates a device ID and stores its per-Mac random 256-bit token in SecureStore. The receiver stores token hashes and trusted-device metadata in the login Keychain. Browser preview credentials exist only in memory. Up to 32 devices may be trusted, but only one controls the Mac at a time. Revoke a device in the Mac window to disconnect it and invalidate its token; Forget pairing on the phone only deletes that phone's local credential.

Version 1 uses **unencrypted `ws://`**. Authentication prevents unknown clients from controlling input; it does not prevent another party on the LAN from observing traffic or stealing a bearer token. Use a trusted network, never forward the port to the Internet, and avoid public/guest Wi-Fi. Private-address filtering also admits private VPN peers. WSS with a verified receiver identity is a priority before use on untrusted networks.

The receiver rejects public-address peers and unapproved browser origins, bounds frames to 16 KiB, validates types/fields/ranges, rejects replayed sequence numbers, limits messages to 300 per second, and caps transport connections at eight. See the [wire protocol](docs/PROTOCOL.md) and [receiver details](receiver/README.md).

## Browser preview

```sh
npm run web
```

The preview is useful for UI and manual connection testing; it cannot provide phone Bonjour discovery or establish physical multitouch behavior. Browsers are rejected by the receiver by default. To deliberately connect a local preview, start the receiver with the exact page origin:

```sh
REMOTE_MAC_ALLOWED_ORIGINS=http://localhost:8081 npm run receiver
```

Use the actual port printed by Expo. Origins must match scheme, hostname and port; comma-separated exact origins are supported, `*` is not a wildcard. An HTTPS preview may block plaintext WebSockets as mixed content. Native phone connections do not need this browser allowlist.

## Testing and diagnostics

The receiver logs every incoming JSON command with its parameters and result. Run `npm run receiver` to see live terminal logs, or use the [macOS Console/log-stream instructions](receiver/README.md#diagnostics-and-tests) for the app opened from Finder. Pairing credentials and composed text are redacted; key names and modifiers remain visible for shortcut debugging.

```sh
npm run check
npm run test:integration
npm run build:receiver
```

`check` verifies generated protocol files, TypeScript, transmitter/shared tests and receiver tests. The Swift test wrapper accommodates Apple's standalone command-line toolchain. Integration tests use actual native WebSocket transport on loopback with in-memory trust and a recording input sink; they never move the cursor or write trusted devices to the production Keychain.

Additional checks:

```sh
cd transmitter
npx expo-doctor
npx expo export --platform all
```

From the root, inspect the packaged receiver without starting its listener:

```sh
"dist/Remote Mac Control.app/Contents/MacOS/RemoteMacReceiver" --diagnostics
```

For an explicit, bounded real-input check after granting Accessibility:

```sh
"dist/Remote Mac Control.app/Contents/MacOS/RemoteMacReceiver" --verify-input
```

That check creates its own focused window, moves the physical cursor eight points and restores it, then verifies Unicode, Backspace down/up and Command-A in its own field. It cancels if focus changes, starts no server, and accesses no saved credentials. It prints JSON and exits nonzero on failure. Ordinary automated tests use a recording sink instead.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No Mac found | Receiver running; same reachable LAN; phone Local Network permission; development build installed. Try manual IPv4. Guest/client-isolated Wi-Fi can block mDNS or peer traffic. |
| Manual connection times out | On Wi-Fi, use the address displayed by the receiver. For USB with `adb reverse tcp:9876 tcp:9876`, use `127.0.0.1` on the phone. Check the receiver port, forwarding, Wi-Fi, firewall, VPN and Mac sleep state. An Expo tunnel does not tunnel this receiver. |
| Pairing code rejected | Use the current code; it expires/rotates. Wait one minute after lockout and reconnect if the 30-second pairing session expired. |
| Permission required | Enable the actual packaged app under Accessibility; a command-line binary and an app bundle may have different grants. Re-add the app after a signature change. |
| Mac already controlled | Disconnect the other phone or use the receiver menu's Disconnect command. |
| Browser connection rejected | Opt in with the exact `REMOTE_MAC_ALLOWED_ORIGINS` value; check mixed-content restrictions. |
| Native module missing | Expo Go cannot load it. Rebuild/install a development client after native changes. |
| Shortcut/zoom ignored | Confirm the foreground app and macOS shortcut settings; ANSI key positions follow the Mac's active layout. |
| Reconnect stopped | After bounded automatic attempts, use Reconnect. Unlock the phone if secure credential storage is unavailable. |
| Port already in use | Quit the other receiver or use `REMOTE_MAC_PORT` and the matching phone setting. |

## Known limits and next improvements

- Physical iPhone/Android LAN discovery, permission prompts and multitouch still need real-device verification. Same-Mac integration and JavaScript exports do not establish those results.
- There is no TLS, screen streaming, Internet relay, clipboard synchronization, force touch, inertia/momentum model or private macOS multitouch injection.
- F1–F12 are function keys, not media/brightness controls. Apps and protected system contexts may reject synthetic input.
- Caps Lock presentation tracks this phone's toggles; it is not synchronized feedback from a physical Mac keyboard. Physical key labels assume ANSI positions; Unicode composition is the layout-independent path.
- Android discovery prefers IPv4 and skips numeric IPv6 addresses with scope IDs; use a manual IPv4 address in that configuration.
- The macOS bundle is an ad-hoc local build, not a notarized installer or App Store release.

Next priorities are physical-device test coverage, encrypted transport with receiver identity verification, stable release signing/notarization, native build CI, synchronized lock-key state, and measured latency/gesture tuning. A binary codec can replace JSON behind the existing transport/input boundary after profiling shows it is useful.

## Preview

![Remote Mac touchpad](docs/screenshots/transmitter.png)
