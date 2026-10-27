# Bluetooth backup transport

Remote Mac supports a custom Bluetooth Low Energy (BLE) connection between a native iPhone/Android app and the running macOS receiver. Wi-Fi remains the preferred transport in **Automatic** mode. Its WebSocket listener, default port **9876**, Bonjour discovery and JSON v1 protocol are unchanged.

Both transports feed the same authorization, validation and native input pipeline. The phone sends input through one active session, and the receiver independently allows only one authenticated controller across both transports.

## Technology choice

| Option | Decision |
| --- | --- |
| **BLE GATT** | Implemented. The phone is the central and the Mac is the peripheral. A custom write characteristic and notification characteristic carry existing JSON messages. This fits the same receiver, permission checks and input handler on iOS, Android and macOS. |
| Bluetooth Classic / RFCOMM serial | Not implemented. It would need a separate transport and platform integration. Apple's External Accessory framework targets supported MFi accessories; this project does not use that accessory path or assume that generic RFCOMM is a portable iPhone API. |
| Bluetooth HID keyboard/mouse | Not implemented. The phone does not impersonate an OS keyboard or mouse. HID would change the command and authorization model; this feature preserves the Mac app's authenticated input pipeline. |

The Apple implementation uses [Core Bluetooth](https://developer.apple.com/documentation/corebluetooth). Apple's [External Accessory documentation](https://developer.apple.com/documentation/externalaccessory) describes the separate MFi accessory route. Android uses the platform `BluetoothGatt` APIs. The local Expo module adds **no new npm dependencies**; it uses the project's existing Expo Modules infrastructure and platform frameworks.

## Build and run

Bluetooth requires a **rebuilt native development or release app on a physical phone**. Expo Go and the browser preview do not contain this project's Bluetooth module. Installing JavaScript updates into an old app binary does not add native code. See [Expo's custom native code guidance](https://docs.expo.dev/workflow/customizing/).

From the repository root, install the workspace and start the Mac receiver:

```sh
npm install
npm run receiver
```

`npm run receiver` packages and runs `dist/Remote Mac Control.app` in the foreground. To package it and launch through Finder instead:

```sh
npm run build:receiver
open "dist/Remote Mac Control.app"
```

To rebuild and restart this checkout's existing receiver while preserving saved pairings:

```sh
npm run sync:receiver
```

For a local phone build, install the appropriate toolchain, then run **one** platform command from `transmitter/`:

```sh
cd transmitter
npx expo run:ios --device
```

```sh
cd transmitter
npx expo run:android --device
```

iOS requires full Xcode, the iOS SDK and signing for the phone. Android requires a suitable JDK and Android SDK. These commands generate the native projects and include the local Bluetooth module. Rebuild after changing native Swift/Kotlin, the module manifest or Expo native configuration. For ordinary JavaScript iteration in an installed development build:

```sh
cd transmitter
npx expo start --dev-client
```

EAS Build can supply the platform build environment. Sign in and build the platform you need:

```sh
cd transmitter
npx eas-cli login
npx eas-cli build --platform android --profile development
npx eas-cli build --platform ios --profile development
```

For a standalone app with its JavaScript bundle included, use the existing `preview` profile:

```sh
cd transmitter
npx eas-cli build --platform android --profile preview
npx eas-cli build --platform ios --profile preview
```

The [EAS configuration](../transmitter/eas.json) also has `production` and `development-simulator` profiles. `development` and `preview` produce Android APKs; iOS internal distribution requires valid Apple signing/provisioning. `development-simulator` is for simulator development, not physical Bluetooth acceptance. `production` is the release profile; building it does not submit the app to a store.

**Use a preview/release build for the Wi-Fi-off acceptance test.** A development client may still need LAN access to Metro even though its control transport is Bluetooth. A successful JavaScript export or browser preview does not establish that a phone app can start and operate without Wi-Fi.

## Permissions and first connection

On the Mac, allow **Bluetooth** when requested and enable the packaged receiver under **System Settings → Privacy & Security → Accessibility**. Bluetooth permits discovery and communication; Accessibility permits actual mouse and keyboard events. Allow Local Network/incoming connections for the Wi-Fi path when prompted. Input Monitoring and Screen Recording are not required. Keep the receiver running and the Mac awake. Its window shows Wi-Fi and Bluetooth status separately, including Bluetooth being off, unauthorized or unavailable.

The iOS app declares `NSBluetoothAlwaysUsageDescription`; allow Bluetooth access when prompted. Allow Local Network separately for Wi-Fi discovery/connections. The Android app requests **Nearby devices** (`BLUETOOTH_SCAN` and `BLUETOOTH_CONNECT`) on Android 12+, or Location for scanning on Android 11 and earlier. Legacy Bluetooth permissions are limited to Android API 30 and below. Scanning declares `neverForLocation` on newer Android versions; the app does not derive location from scan results. These permissions follow [Android's Bluetooth permission model](https://developer.android.com/develop/connectivity/bluetooth/bt-permissions).

To set up backup control:

1. Open **Connection & settings** on the phone. Under **Bluetooth · Nearby Macs**, choose **Search**.
2. Select your Mac and choose **Connect**. Accept the system Bluetooth pairing request if presented.
3. Enter the six-digit code shown by the receiver if the phone is not already authorized for that Mac. Wait for **Connected · Bluetooth**, or enable Accessibility if **Permission required** appears.
4. Save the same Mac's Wi-Fi address and port, then choose **Automatic**. The selected Bluetooth device and authorized server identity are remembered for backup use.

The UI offers **Automatic**, **Wi-Fi** and **Bluetooth**. Manual modes stay on the selected transport. Automatic mode prefers Wi-Fi, falls back to the explicitly selected Bluetooth Mac, and checks Wi-Fi recovery while Bluetooth is active. It does not choose a random nearby receiver. The active transport is shown on both phone and Mac; the Wi-Fi connection summary includes the IP/hostname and port.

## Two separate authorizations

The GATT write characteristic requires encrypted writes; the response characteristic requires encrypted notification subscriptions. This asks the operating system to establish a protected Bluetooth link. The app uses CoreBluetooth's encryption-required flags, described by [CBAttributePermissions](https://developer.apple.com/documentation/corebluetooth/cbattributepermissions). It does not provide its own Bluetooth cryptography or claim protection beyond the OS pairing/link guarantees.

System Bluetooth pairing does **not** authorize control of the Mac. The existing application authorization still requires a current six-digit code or a valid saved token. Codes expire after two minutes and rotate after successful pairing; five failed attempts within one minute impose a one-minute code lockout. The phone stores its 256-bit per-Mac token in SecureStore, and the receiver stores its hash and trusted-device metadata in Keychain. The same credentials work over Wi-Fi and Bluetooth. Credentials are not advertised over Bluetooth or included in command logs.

These actions have different effects:

| Action | Effect |
| --- | --- |
| **Revoke** in the Mac receiver | Invalidates app authorization and closes the phone's active session on either transport. Pair again with a new app code to regain control. |
| **Forget pairing on this phone** | Deletes the phone's local app token and disconnects. It does not remove the Mac's trust record or the OS Bluetooth bond. |
| **Forget device** in Bluetooth settings inside the app | Clears the selected backup device. It does not revoke the token or remove the OS bond. |
| Forget/unpair in the operating system's Bluetooth/Connected devices settings | Removes the system Bluetooth bond where the device is listed. This is separate from app authorization; revoke on the Mac too when removing a phone's access. The app does not silently unpair OS devices. |

Wi-Fi remains plaintext `ws://` and still requires a trusted private network. Adding encrypted BLE does not encrypt the Wi-Fi transport. The saved server ID detects accidental receiver mismatches; it is not a replacement for cryptographic server authentication on Wi-Fi.

## Connection behavior and limits

On transport failure, input stops immediately. Reconnection discards queued input; it does not replay clicks, keystrokes or motion. Switching sends `release_all` when possible and completes the old transport's teardown before starting the replacement. The receiver releases held inputs on disconnect, timeout, revocation, permission loss and Mac sleep.

Automatic retries use exponential backoff with jitter: a 500 ms initial base delay growing to a 15-second base delay. While Bluetooth is connected, an unauthenticated Wi-Fi probe runs about every 15 seconds with a four-second budget. The probe sends no authentication or input. A matching receiver greeting permits a switch back to Wi-Fi. A busy receiver retries the attempted transport; a broken connection can retain the receiver's controller slot until its heartbeat timeout, so takeover is not necessarily instant.

The shared session allows up to eight transport sessions, one authenticated controller, 300 client messages per second and strictly increasing client sequence numbers. Unauthenticated sessions expire after 30 seconds. Authenticated sessions expire after 20 seconds without input or ping; the phone sends application heartbeats every five seconds.

Control is **foreground-only**. Actual app backgrounding disconnects and releases input; foregrounding reconnects if the user still intends to connect. Native lifecycle events distinguish real backgrounding from temporary system permission/pairing dialogs. The receiver cannot control a sleeping or unavailable Mac, and this implementation does not promise to wake it. It requests no phone background Bluetooth service. Rebuilding an ad hoc signed Mac app may require re-enabling Accessibility for the new binary.

CoreBluetooth's peripheral interface does not offer this receiver a force-disconnect operation for an arbitrary central. Closing the application session rejects further writes from that subscription; the phone must reconnect. Unsubscribe and the shared heartbeat timeout handle connection loss.

## BLE wire contract

| Attribute | UUID | Operation |
| --- | --- | --- |
| Service | `9D4B0001-7A8B-4E9A-AF33-6C7D8E9F0010` | Advertised by Mac |
| Commands / RX | `9D4B0002-7A8B-4E9A-AF33-6C7D8E9F0010` | Phone writes with response; encryption required |
| Responses / TX | `9D4B0003-7A8B-4E9A-AF33-6C7D8E9F0010` | Mac notifies the subscribed phone; encryption required |

Each message is a **four-byte unsigned big-endian byte length**, followed by **1–16,384 UTF-8 bytes** containing one unchanged [JSON v1 protocol message](PROTOCOL.md). The frame limit counts UTF-8 bytes, not characters. GATT operations may split a header/body or contain several frames. Receivers reassemble complete messages before JSON parsing; no fragment becomes an input command.

Writes are ordered and acknowledged. Native clients size fragments to the negotiated ATT payload, avoiding long writes with nonzero offsets. Mac notifications respect the central's `maximumUpdateValueLength`. When CoreBluetooth cannot accept an outgoing notification, the receiver retains the fragment and resumes on its readiness callback.

An incomplete header/body has a five-second deadline. Outgoing input/response queues are bounded to 32,768 bytes and two seconds of age; invalid lengths, overflow, stale output or incomplete-frame timeouts close the session. Bluetooth connection setup has a 30-second native timeout with a 45-second client envelope for setup/permission handling. These limits keep lost data from later becoming delayed input.

The existing input engine coalesces pointer/scroll deltas outside React at approximately 60 Hz. The Bluetooth adapter additionally combines only adjacent **unsent** movement messages of the same kind, within the protocol delta bound. It preserves button/key/gesture/ping/release boundaries and never rewrites an in-flight frame. Sequence numbers may skip after coalescing; they must still increase. Discrete input events are neither coalesced nor duplicated across transports.

## Physical acceptance checklist

Use a newly built standalone preview/release app, a physical iPhone or Android phone, and the packaged receiver. Record phone model/OS, Mac/OS, build identifiers, selected Mac, connection mode and active-transport labels. Keep a harmless text editor and a scrollable document open for input checks. Run these six scenarios independently on each mobile platform:

| Scenario | Procedure and expected result |
| --- | --- |
| 1. Healthy Wi-Fi | Select Automatic with both radios available. Wi-Fi remains active; input arrives once and Bluetooth does not take control. |
| 2. Wi-Fi unavailable at startup | Disable Wi-Fi before launching the standalone phone app. The remembered Bluetooth Mac connects, authenticates and accepts input without Metro or a LAN connection. |
| 3. Wi-Fi drops during control | Start on Wi-Fi, hold a drag/modifier, then interrupt Wi-Fi. Held input releases; the app reconnects over Bluetooth without replaying the unfinished action. Allow failure detection/controller expiry rather than expecting an instantaneous handoff. |
| 4. Neither transport available | Disable Wi-Fi and Bluetooth or stop the receiver. Show disconnected/retrying state, send no input, back off without a tight retry loop, and recover when a configured transport returns. |
| 5. Bluetooth drops | While controlling over Bluetooth, disable the radio or leave range. Release held inputs and discard queued events. Automatic mode tries usable Wi-Fi first; a manual Bluetooth selection keeps retrying Bluetooth. |
| 6. Wi-Fi returns during Bluetooth control | Restore Wi-Fi. The recovery probe identifies the same Mac without authentication/input; Bluetooth tears down before Wi-Fi authenticates. The active label changes and every subsequent action arrives once. |

On both transports, verify pointer movement; left/right click and double-click; button hold/drag/release; horizontal/vertical two-finger scrolling; two-finger right-click; pinch zoom; three/four-finger navigation; all four direct Control-arrow buttons; physical key down/up/repeat; Shift/Control/Option/Command combinations; Caps Lock; arrows and editing keys; Fn/F1–F12/punctuation; Unicode composition; and **Release all**. Check the actual Mac behavior, not only a `dispatched` log line. System navigation and zoom depend on the Mac's configured shortcuts and foreground app.

Repeat manual Wi-Fi → Bluetooth → Wi-Fi switching while holding a button/key. For a single click, shortcut or Unicode submission, confirm exactly one corresponding action in the target app and one input sequence in receiver command logs, with no second action after reconnect. The protocol may generate several native key events for one shortcut; count that complete sequence, not just raw log-line totals. Moving events may be combined, but their accumulated delta and transition ordering must remain correct.

Also test: deny then allow Bluetooth permission; cancel then accept OS pairing; wrong/expired app code; saved-token reconnect; revocation during a held drag; a second phone attempting control; Mac Accessibility removal/restoration; screen lock/background/foreground; Mac sleep/wake; power-cycle Bluetooth; and receiver restart. Confirm permission dialogs do not create a retry loop. OS pairing alone must never dispatch input. A mismatched saved Mac identity must stop authentication.

## Verification evidence and commands

Receiver-side checks completed during this implementation:

| Check | Observed result |
| --- | --- |
| `bash receiver/scripts/test.sh` | **44 tests in 8 suites passed**, including framing, encrypted-characteristic requirements, shared controller ownership, authentication, revocation and cleanup. Repeated after stale CoreBluetooth callback guards were added. |
| `node --test scripts/integration.test.mjs` against the built harness | **10 tests passed**, exercising the actual Network.framework WebSocket listener, pairing, input dispatch, origin checks, permission changes and revocation. This is not an over-the-air BLE test. |
| `swift build --package-path receiver -c release --product RemoteMacReceiver` | Release executable compiled successfully. This is build evidence, not a packaged-app UI or physical-input test. |
| `plutil -lint receiver/Info.plist` and `git diff --check -- receiver` | Passed. |

The installed CLT test linker reports its existing duplicate-rpath and macOS deployment-target warnings; the tests complete successfully. Tests use recording sinks and temporary/in-memory trust, not production mouse/keyboard control or Keychain credentials.

**Physical Android follow-up:** the user's installed native app on Nothing A024 / Android 16 connected to the packaged Mac receiver over encrypted BLE, authenticated, maintained heartbeats for more than three minutes and delivered touch-surface mouse commands to the shared input pipeline. Both apps visibly showed Bluetooth as the active transport. See the [GATT 22 verification record](VERIFICATION.md#android-gatt-22-follow-up-27-october-2026) for the precise evidence and limits.

**Pending:** physical iOS execution, fresh-pairing cancellation/recovery, radio loss and all six scenarios, repeated transport switching, complete real-application BLE input checks and sustained performance. This workspace lacks full Xcode/iOS SDK, JDK and Android SDK; the successful Android follow-up used the app already installed by the user, without rebuilding it. The completed aggregate TypeScript tests and live packaged-app/browser evidence are recorded in [VERIFICATION.md](VERIFICATION.md#bluetooth-backup-addition-27-october-2026); the counts above describe only the receiver checks recorded here.

### If Android reports GATT 22

Android defines status 22 (`0x16`) as [connection terminated by the local host](https://android.googlesource.com/platform/packages/modules/Bluetooth/+/refs/heads/main/system/stack/include/hci_error_code.h). It is a disconnect status, not a specific diagnosis. Check the preceding bonding/security events before changing the transport implementation.

Keep the receiver open and finish any OS pairing prompt, then return to Remote Mac on the phone and connect to the remembered Mac. Returning from a backgrounded app starts a fresh connection. Wait for **Connected / Transport: Bluetooth** on the phone and **Android phone · Bluetooth** on the Mac; merely appearing in the system's paired-device list is not application authentication. If an application code is requested, use the current six-digit code in the receiver. Avoid repeatedly pressing Connect while a pairing/connection attempt is still pending.

For USB diagnosis, use `adb shell pidof com.remotemac.transmitter` and scope `adb logcat --pid=<pid>` to that app. On the Mac, `log stream --info --predicate 'subsystem == "com.remotemac.receiver"'` shows redacted command outcomes. Successful `authentication` followed by regular `ping`/`pong` establishes the application session; actual input delivery needs a separate test. Do not clear app data or revoke working authorizations just because the numeric status appeared once.

Commands for the broader verification pass from the repository root:

```sh
npm run check
npm run test:integration
bash transmitter/modules/bluetooth-transport/tests/test-apple.sh
npm run build:receiver
```

The Apple module script checks its framing code and available CoreBluetooth Swift types; it does not compile a signed iOS Expo app. Browser preview can verify settings/status layout and Wi-Fi behavior, but it has no BLE bridge.

## Files by area

| Area | Main files |
| --- | --- |
| Transport selection and shared client | `transmitter/networking/Transport.ts`, `ConnectionManager.ts`, `RemoteClient.ts`, `WiFiTransport.ts`, `BluetoothTransport.ts` and their tests |
| Native phone bridge | `transmitter/modules/bluetooth-transport/index.ts`, `expo-module.config.json`, `ios/BluetoothCentral.swift`, `ios/BluetoothFrame.swift`, `ios/BluetoothTransportModule.swift`, Android `BluetoothTransportModule.kt` and `AndroidManifest.xml` |
| UI, persistence and lifecycle | `transmitter/components/BluetoothConnectionSection.tsx`, `transmitter/screens/SettingsScreen.tsx`, `transmitter/services/settings.ts`, `transmitter/App.tsx`, `transmitter/app.config.ts` |
| Mac transport and ownership | `receiver/Sources/ReceiverCore/BluetoothPeripheral.swift`, `BluetoothFraming.swift`, `SessionCoordinator.swift`, `ReceiverServer.swift` |
| Mac status and permissions | `receiver/Sources/RemoteMacReceiver/ReceiverWindow.swift`, `main.swift`, `receiver/Info.plist` |
| Tests and existing protocol | `receiver/Tests/ReceiverCoreTests/BluetoothFramingTests.swift`, `SessionCoordinatorTests.swift`, native module `tests/`, `shared/protocol.ts`, `docs/PROTOCOL.md` |

`InputController`, the native `CGEvent` sink and JSON v1 input semantics are shared with Wi-Fi. No second input engine or HID path was added.
