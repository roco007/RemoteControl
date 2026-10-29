# Android USB sync

Use **Transmitter: Sync to Android via USB** from **Terminal → Run Task** or
**Run and Debug** whenever you want to install the current transmitter code on
your Android phone. This is a manual command; it does not watch for changes.

Connect the phone with a USB data cable, enable **Developer options → USB
debugging**, and accept the phone's **Allow USB debugging** prompt for this Mac.
Keep the phone unlocked while authorizing it. The command requires Python 3 and
Node.js 22.13+, installed npm dependencies, EAS CLI with your existing Expo login
and Android signing key, JDK 17, and Android SDK Build-Tools/Platform-Tools. It
reuses the toolchain already downloaded for this workspace. Check prerequisites and connected devices
without building or installing:

```sh
python3 .vscode/sync-android-usb.py --check
```

Run these commands from the repository root:

```sh
# Build current code and install it on the connected phone.
python3 .vscode/sync-android-usb.py

# Select a phone when more than one device is connected.
python3 .vscode/sync-android-usb.py --serial DEVICE_SERIAL

# Build the APK without installing it.
python3 .vscode/sync-android-usb.py --build-only
```

Each sync builds an APK from the current code, including native Android changes,
then updates the installed app with `adb install -r` to preserve its app data.
The APK uses the version configured in `transmitter/app.config.ts`; the command
does not change the source version. Reinstalling the same version is supported,
so a version bump is not required for each sync. An existing installation must
use a compatible signing key for an in-place update.

Build outputs, a private build log, and the verification report are saved in a
new folder under `dist/android-usb-sync/` for each run. The script refuses an
older versionCode, a signing mismatch, or source changes made during the build.
It never uninstalls the app. Temporary signing/build files are cleaned up on
completion or cancellation. EAS local builds may need Internet access for Expo
signing metadata and dependencies; installation itself uses USB.

For another Mac, set `ANDROID_HOME` and `JAVA_HOME` if the tools are not in their
standard locations. Optional overrides are `NODE_BINARY`, `EAS_BINARY`, `ADB`,
and `REMOTE_MAC_ANDROID_TOOLS` (a folder containing `android-sdk` and a
`jdk-17*/Contents/Home` installation).

Updating closes the Android app. Open **Remote Mac** on the phone again after
the command succeeds.

To update the Mac receiver, use the separate existing **Receiver: Sync latest
code and restart** Run and Debug entry. The **Transmitter: Build Android APK
(EAS)** entries remain available for cloud builds.
