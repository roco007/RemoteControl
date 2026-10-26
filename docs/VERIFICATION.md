# Verification record

Recorded during development on **26 October 2026**. This record distinguishes source/build checks, a real native loopback connection, actual app UI/input, and the physical-phone checks still required.

## Environment inspected

| Item | Observed |
| --- | --- |
| Initial workspace | Empty folder, no existing application or Git repository |
| Host | Apple Silicon macOS 26.6.2 |
| JavaScript | Node.js 22.23.2; npm 12.1.0 |
| Swift | Apple Swift 6.2; command-line tools selected |
| Full Xcode / iOS simulator | Unavailable; `simctl` not installed |
| Android build tools | No Android SDK or Java runtime. Initially no connected phone; follow-up used an authorized USB-connected Nothing A024 running Android 16 / API 36 and Expo Go. |
| App stack | Expo 58.0.19, React 19.3.0, React Native 0.88.0, Gesture Handler 3.3 |

## Completed checks

| Boundary | Check | Result and meaning |
| --- | --- | --- |
| Shared protocol | Generator drift check; valid/invalid/malformed fixtures consumed by TypeScript and Swift | Passed. Confirms contract validation and generated constants match source. |
| Transmitter logic | TypeScript and Vitest | Passed: 121 tests across nine files. Covers authentication, permission state, heartbeat/reconnect, stale sockets, platform WebSocket headers, coalescing, two-finger scrolling, pinch arbitration, three/four-finger swipe lifecycle, keyboard lifecycle and discovery fallback. |
| Receiver logic | `npm run test:receiver` through the command-line-toolchain wrapper | Passed: 26 Swift tests. Uses injectable permission, trust storage and recording input; no OS input or production Keychain writes. |
| Native network integration | `npm run test:integration` | Passed: 9 reported tests, comprising one parent test and eight subtests. Real Network.framework WebSockets communicate with Node clients over loopback. |
| Expo dependency/configuration | `npx expo-doctor` | Passed all 20 checks. |
| Bundling | Expo exports for iOS, Android and web | Passed. Produces JavaScript/assets; does not compile native phone code. |
| Native discovery configuration | Expo config/introspection and Apple/Android autolinking | Passed. Both platforms discover the local module; permissions and Bonjour service are present. |
| Native discovery source | Swift syntax parse, Foundation Bonjour-helper typecheck, podspec syntax, facade tests | Passed. Kotlin/iOS app linking and execution still need platform toolchains. |
| macOS packaging | Release Swift build, `.app` creation, ad-hoc signing and strict signature verification | Passed. Output is `dist/Remote Mac Control.app`, built for this host architecture. |
| Actual receiver UI | Opened the packaged app and inspected its visible window | Window opened and missing Accessibility was explicitly displayed as `permission_required`. |
| Actual native input | Packaged executable's `--verify-input` under its CLI launch identity | Passed: physical cursor moved/restored, Unicode text arrived, Backspace down/up worked, and Command-A selected text in its own focused window. |
| Actual transmitter UI | Browser inspection of Mouse, Keyboard and Connection/settings | Rendered and inspected; pairing → permission required → connected was exercised against an ephemeral native loopback recording harness. UI-delivered Q, Shift-Q, exact Command-Z with sticky Shift, Unicode, left/right clicks and double-click counts were verified in recorded actions. Temporary credentials/address and harness state were cleaned up. |
| Physical Android connection | Nothing A024 / Expo Go → packaged receiver over Wi-Fi | Passed after the connection fixes below. Phone UI showed **PAIRED & CONNECTED**; receiver UI showed **Connected: Android phone**, a trusted-device entry and Accessibility allowed. |
| Physical Android USB transport | Phone-side WebSocket upgrade through `adb reverse tcp:9876 tcp:9876` | Passed: HTTP 101 from `127.0.0.1:9876` on the phone. The same probe passed against the Mac's LAN address. The app's paired session remained on its saved LAN address. |

The native integration suite verifies rejected browser origins, malformed/unauthenticated input, code pairing, permission gating, single-controller ownership, heartbeats, protocol-to-input dispatch, release on disconnect, release on permission loss, revocation, replay rejection and oversized-frame handling. Its `ReceiverIntegrationHarness` binds **127.0.0.1 only**, uses in-memory credentials and records actions instead of posting them. Temporary state is private to the test and cleaned up afterward.

The packaged receiver also advertised `_remotemac._tcp` successfully, observed using macOS `dns-sd` on this Mac. This is registration evidence, not a physical-phone discovery test.

## Native permission and input boundary

The packaged executable provides an explicit `--verify-input` check. It opens its own focused AppKit field and verifies actual CGEvent cursor movement/restoration, Unicode, Backspace down/up and Command-A. It posts no events if Accessibility is unavailable, cancels on focus loss and never starts a listener or loads pairing credentials.

The CLI-launched executable reported Accessibility permission and passed this bounded input check. The normally launched app bundle initially showed permission required; during the Android connection follow-up it showed **Allowed** and accepted the phone's paired session. macOS privacy authorization can differ by launch/executable identity: **grant Accessibility to the actual app bundle before using it from a phone**. The successful CLI input result alone does not imply that macOS granted the normally launched application access.

This proves that the implemented CoreGraphics sink can deliver real input on this host under an authorized launch identity. The subsequent phone connection check establishes networking and pairing; native phone gesture recognition and every application's response to synthetic events remain separate checks.

## Android connection fix

React Native Android automatically supplied an HTTP Origin that the receiver rejected. Native sockets now send the shared `remote-mac-control://native` Origin, and the receiver accepts exactly that value while retaining browser allowlisting and device authentication. The native integration suite now pairs using this Origin and rejects hostile, lookalike and `null` origins.

The running Metro server also served stale generated constants because Expo's default workspace watchers did not include the sibling `shared/` source directory. `transmitter/metro.config.js` now watches that folder explicitly. Restarting Metro with a cleared cache and reloading Expo Go delivered the corrected protocol constant and resolved the phone's connection error. Metro was left running on port 8082 and the receiver on 9876; USB reverse mappings were installed for both ports.

## Three-finger navigation correction

The user clarified that three-finger gestures should navigate desktops and Mission Control, rather than scroll page content. Continuous horizontal/vertical scrolling is now exclusive to two fingers. Three- and four-finger swipes each emit one system gesture on release, including Android's staggered pointer-up sequence. Starting navigation clears queued scrolling and releases drag/pinch state. Pinch and swipe cancellation survive iOS touch callbacks that arrive before BEGAN.

Regression checks exercise registered recognizer callbacks through the real gesture interpreter and input engine. They verify two-finger `mouse_scroll` in both axes, all four three-finger navigation directions, exactly-once dispatch, queued-scroll removal, and pinch conflicts. TypeScript and all 121 tests pass. The phone was reloaded through Metro on port 8082; its actual UI showed **Connection: Connected**, **TWO FINGERS Scroll**, and **3-FINGER SWIPE: desktops & overview**. Physical desktop direction and Mission Control up/down behavior await the user's check because macOS screen capture failed during automated UI verification. The receiver's existing Control-arrow mappings have not been changed without that evidence.

## Direct navigation buttons

The user subsequently reported that multi-finger system navigation was not working and requested direct arrow buttons. The mouse pad now includes Left, Right, Up and Down buttons outside the touch recognizer. Each uses the keyboard controller to send real Control-down, arrow-down/up and Control-up events, rather than relying on swipe recognition. All four buttons were clicked in the browser UI against the isolated native recording receiver: exactly 16 key actions arrived, with the correct direction and no mouse-click or repeating events. Portrait (420 × 900) and landscape (900 × 420) layouts were visually checked. The temporary pairing/address and receiver were cleaned up. See `docs/screenshots/mouse-navigation.png` for the portrait result. These checks verify the button-to-native-dispatch path; macOS desktop/overview responses remain dependent on enabled system shortcuts.

## Not yet verified

- A compiled iOS or Android development/preview build on a physical phone.
- Phone discovery of the Mac through mDNS and real local-network permission prompts.
- iPhone connectivity and Android connectivity on other access points/firewall configurations.
- Physical one/two/three/four-finger recognition, drag arbitration, pinch/scroll arbitration, haptics and landscape ergonomics.
- Full mouse click/drag/scroll behavior in real applications and multi-display operation.
- Real-application shortcuts across different keyboard layouts or customized macOS bindings.
- Sustained latency, packet loss/reconnect and battery behavior on an actual wireless link.
- Intel/universal packaging, Developer ID signing, notarization, EAS builds or store distribution.

## Dependency audit

The dependency audit reported five high-severity advisories in upstream Expo CLI dependency paths involving `node-forge` and Zod 3. A compatible automatic remediation was not available during this check; no forced major-version overrides were applied. Recheck upstream fixes before distributing a release. The standalone macOS receiver does not use these Node dependencies.

## Receiver command logging (2026-10-26)

- All 31 Swift tests pass, including five command-logging tests covering every client command kind, rejection paths, and credential/composed-text redaction.
- The native WebSocket integration suite passes all nine scenarios (10 Node test results including the parent), with stdout assertions for received command details, outcomes, and redaction.
- The release app was rebuilt, code-signature verification passed, and the running receiver was restarted. A live unauthenticated JSON ping/pong on port 9876 was observed in the `com.remotemac.receiver` / `commands` unified log stream.
- The restarted app reported Accessibility permission disabled. Native input requires the user to re-enable the rebuilt app; logging and ping/pong do not require that permission.

## Control-arrow navigation fix (2026-10-26)

The Mac's physical Control-Up shortcut opened Mission Control, while the connected Android phone's Up button did not. Receiver command logs confirmed that Control-down, Up-down, Up-up and release-all arrived and were dispatched in order. Native event construction replaced Quartz's arrow classification flags with the requested modifiers, discarding `maskNumericPad` and `maskSecondaryFn`.

The receiver now preserves those two native flags for all four arrow keys. Regression tests capture actual constructed `CGEvent` objects without posting OS input: 16 missing-flag assertions failed before the correction; afterward all 33 Swift tests passed. The release app built and passed code-signature verification, and the modified Swift files had no IDE diagnostics. Focused code review found no blocking issues.

After the rebuilt receiver reported Accessibility allowed and the Android phone reconnected, the user confirmed that all four phone buttons worked: Up for Mission Control, Down for application windows, and Left/Right for switching spaces. This verifies the reported arrow-button issue on that Mac and phone; other physical acceptance cases below remain separate.

## Reproduce checks

From the repository root:

```sh
npm install
npm run check
npm run test:integration
npm run build:receiver
```

From `transmitter/`:

```sh
npx expo-doctor
npx expo export --platform all
npx expo config --type introspect
npx expo-modules-autolinking resolve --platform apple
npx expo-modules-autolinking resolve --platform android
```

From the root, for diagnostic status and explicit native input verification:

```sh
"dist/Remote Mac Control.app/Contents/MacOS/RemoteMacReceiver" --diagnostics
"dist/Remote Mac Control.app/Contents/MacOS/RemoteMacReceiver" --verify-input
```

The second command requires a grant for the actual executable identity. Do not count a permission refusal or focus-cancellation result as a passed input test. Ordinary automated tests use recording sinks and do not move the user's cursor.

## Physical acceptance sequence

1. Install a development build on one iPhone and one Android phone when available; use the same trusted LAN as the Mac.
2. Start the packaged receiver, grant Accessibility/Local Network, and discover it from the phone.
3. Pair with the current code; confirm an incorrect code and an unpaired client cannot control input.
4. In a disposable document, exercise pointer motion, tap/double tap, both click buttons, hold-drag, two-axis scroll and two-finger right click.
5. Verify pinch shortcut behavior and three/four-finger system actions with the corresponding macOS shortcuts enabled.
6. Exercise normal/repeating keys, punctuation, Shift/Control/Option/Command combinations, arrows, function keys and Unicode composition.
7. Switch modes, background the phone, disconnect Wi-Fi and revoke the phone while keys/buttons are held; confirm no stuck input and no replay after reconnect.
8. Reconnect using the saved token, then revoke it and confirm re-pairing is required. Remove any disposable trusted test device afterward.

Record device/OS versions, network setup and observed results before claiming end-to-end phone support.
