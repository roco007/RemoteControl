# Native LAN discovery

This local Expo module uses `NetServiceBrowser` on iOS and `NsdManager` on Android. The service type is passed from the shared protocol manifest, so native source does not duplicate it. Resolved results contain `{ id, name, host, port }`. Results are removed when Bonjour announces a service loss. Android resolves one service at a time to support older NSD implementations, prefers IPv4, and ignores callbacks belonging to stopped scans. Both platforms stop on background/destruction; Android also releases its multicast lock.

Use `subscribeDiscovery(onChange, onError)` before `startDiscovery()`. Call its unsubscribe callback and `stopDiscovery()` when leaving connection settings. `requestLocalNetworkAccess()` can also precede a manual connection. The iOS permission prompt is triggered by the actual network operation; the request function itself returns true on iOS.

Expo Go does not load local native modules. `discoveryAvailable` is false there and on web, and the wrapper reports an explicit development-build requirement instead of inventing discovered devices. Manual hostname/IP connections remain available.

## Build and permissions

From `transmitter/`, run `npx expo run:ios` (full Xcode needed) or `npx expo run:android` (Android SDK and JDK needed). Alternatively build the `development` or `preview` EAS profile. The local module is automatically linked from `modules/`; no npm publication is necessary.

The config plugin sets iOS Local Network usage text and `_remotemac._tcp`, permits local networking through ATS, and enables Android cleartext traffic for the v1 LAN WebSocket transport. Android declares Internet, network/Wi-Fi state and multicast permissions. Use a trusted LAN: v1 transport does not encrypt input or pairing traffic.

Expo 58 currently targets Android API 36. Android 17 grants LAN access implicitly to target-36 apps. If raising the app target to 37 or later, pass `{ targetSdk37: true }` to `./plugins/withLocalNetwork`; the module then requests `ACCESS_LOCAL_NETWORK` at runtime. The app must await `requestLocalNetworkAccess()` before opening a manual connection as well as discovery. See [Android's local network permission guidance](https://developer.android.com/privacy-and-security/local-network-permission).

Android numeric IPv6 addresses with a scope identifier are not returned because cross-platform WebSocket implementations differ in scoped-URL handling; use the Mac's IPv4 address for that configuration. iOS falls back to the Bonjour hostname when IPv4 is absent. Guest networks and access-point client isolation may prevent both discovery and direct connections.

## Verification performed here

- Expo config and config introspection resolve successfully.
- Expo autolinking discovers this module for Apple and Android.
- Swift source syntax parse and the Foundation/Bonjour helper's macOS typecheck pass.
- Facade tests verify Expo Go fallback, native service type, denied permission, listener cleanup, and cancellation during a permission prompt.

These checks do not compile the full iOS/Android app. This machine has command-line Swift tools but no full Xcode/iOS SDK; it also has no Java runtime or Android SDK. A physical phone build is still required to verify native discovery and local-network permission prompts end to end.
