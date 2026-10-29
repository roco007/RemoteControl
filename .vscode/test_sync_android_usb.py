"""Behavior tests for the manual USB sync helper; no Android tools are invoked."""

import hashlib
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "sync_android_usb", Path(__file__).with_name("sync-android-usb.py")
)
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)


class UsbDeviceSelectionTests(unittest.TestCase):
    def test_selects_one_authorized_usb_phone(self):
        output = (
            "List of devices attached\n"
            "PHONE123 device usb:1-2 product:phone model:Phone transport_id:1\n"
        )
        self.assertEqual(sync.choose_usb_device(output), "PHONE123")

    def test_multiple_usb_phones_require_serial(self):
        output = (
            "FIRST device usb:1-2 product:phone transport_id:1\n"
            "SECOND device usb:1-3 product:phone transport_id:2\n"
        )
        with self.assertRaisesRegex(sync.SyncError, "Multiple USB phones"):
            sync.choose_usb_device(output)
        self.assertEqual(sync.choose_usb_device(output, "SECOND"), "SECOND")

    def test_rejects_unauthorized_and_offline_usb_phones(self):
        for state in ("unauthorized", "offline"):
            with self.subTest(state=state):
                output = f"PHONE123 {state} usb:1-2 transport_id:1\n"
                with self.assertRaisesRegex(sync.SyncError, state):
                    sync.choose_usb_device(output)
                with self.assertRaisesRegex(sync.SyncError, state):
                    sync.choose_usb_device(output, "PHONE123")

    def test_wireless_devices_and_emulators_are_not_usb_candidates(self):
        entries = (
            "192.168.1.25:5555 device product:phone model:Phone transport_id:2",
            "adb-PHONE123-example._adb-tls-connect._tcp device product:phone transport_id:3",
            "emulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 transport_id:4",
        )
        for entry in entries:
            with self.subTest(entry=entry):
                with self.assertRaisesRegex(sync.SyncError, "No USB phone"):
                    sync.choose_usb_device(entry)
                with self.assertRaisesRegex(sync.SyncError, "was not found"):
                    sync.choose_usb_device(entry, entry.split()[0])

    def test_ignores_wireless_and_emulator_when_usb_phone_is_present(self):
        output = (
            "192.168.1.25:5555 device product:phone transport_id:1\n"
            "PHONE123 device usb:1-2 product:phone transport_id:2\n"
            "emulator-5554 device product:sdk_gphone64_arm64 transport_id:3\n"
        )
        self.assertEqual(sync.choose_usb_device(output), "PHONE123")

    def test_requested_missing_usb_serial_is_rejected(self):
        with self.assertRaisesRegex(sync.SyncError, "was not found"):
            sync.choose_usb_device("PHONE123 device usb:1-2", "MISSING")


class UpdateVersionTests(unittest.TestCase):
    def test_same_version_and_increased_version_are_allowed(self):
        installed = {"versionCode": 42}
        for candidate in (42, 43):
            with self.subTest(candidate=candidate):
                sync.ensure_update_version(installed, candidate)

    def test_first_install_is_allowed(self):
        sync.ensure_update_version(None, 1)

    def test_downgrade_is_rejected(self):
        with self.assertRaisesRegex(sync.SyncError, "newer versionCode"):
            sync.ensure_update_version({"versionCode": 42}, 41)


class SourceSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "checkout"
        self.root.mkdir()
        self.stage = Path(self.temporary.name) / "stage"
        self.stage.mkdir()
        self.git("init", "--quiet")
        self.write(
            ".gitignore",
            "node_modules/\ntransmitter/android/\ntransmitter/ios/\n"
            ".env*\ncredentials.json\n*.keystore\n*.jks\n*.p12\n*.p8\n"
            "*.mobileprovision\n*.provisionprofile\n",
        )
        self.write("package.json", '{"private":true}\n')
        self.write("transmitter/App.tsx", "export default 'committed app';\n")
        self.write("transmitter/app.config.ts", "export default {version: '1.0.0'};\n")
        self.write("shared/protocol.ts", "export const protocol = 1;\n")
        self.native_path = "transmitter/modules/example/android/src/Example.kt"
        self.write(self.native_path, "class Example\n")
        self.write("receiver/main.swift", "print(\"separate receiver\")\n")
        self.write(".vscode/settings.json", "{}\n")
        self.git("add", ".")
        self.git(
            "-c", "user.name=USB Sync Test", "-c", "user.email=usb-test@example.invalid",
            "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture",
        )
        (self.root / "node_modules").mkdir()

        original_capture = sync.capture

        def capture_in_fixture(args, *, env=None, cwd=None):
            # capture's default cwd is bound when the production module is imported.
            return original_capture(args, env=env, cwd=self.root if cwd is None else cwd)

        self.addCleanup(patch.stopall)
        patch.object(sync, "ROOT", self.root).start()
        patch.object(sync, "capture", side_effect=capture_in_fixture).start()

    def git(self, *args):
        return subprocess.run(
            ["git", *args], cwd=self.root, check=True, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        ).stdout

    def write(self, relative, content):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        return path

    def test_stages_current_unstaged_and_untracked_sources(self):
        updated = "export default 'current unstaged app';\n"
        untracked = "export const newFeature = true;\n"
        self.write("transmitter/App.tsx", updated)
        self.write("transmitter/new-feature.ts", untracked)
        self.write(self.native_path, "class Example { val current = true }\n")
        manifest = sync.stage_sources(self.stage)

        self.assertEqual((self.stage / "transmitter/App.tsx").read_text(), updated)
        self.assertEqual((self.stage / "transmitter/new-feature.ts").read_text(), untracked)
        self.assertEqual(
            manifest["transmitter/App.tsx"], hashlib.sha256(updated.encode()).hexdigest()
        )
        self.assertEqual(
            (self.stage / self.native_path).read_bytes(), (self.root / self.native_path).read_bytes()
        )
        self.assertIn(self.native_path, manifest)
        self.assertNotIn("receiver/main.swift", manifest)
        self.assertNotIn(".vscode/settings.json", manifest)
        self.assertTrue((self.stage / "node_modules").is_symlink())
        self.assertEqual((self.stage / "node_modules").resolve(), (self.root / "node_modules").resolve())
        sync.verify_current_sources(manifest)

    def test_generated_projects_and_force_tracked_credentials_are_excluded(self):
        excluded = (
            "transmitter/android/app/build.gradle",
            "transmitter/ios/Project.xcodeproj/project.pbxproj",
            ".env", "transmitter/.env.local", "transmitter/credentials.json",
            "transmitter/release.keystore", "shared/key.jks", "shared/certificate.p12",
            "shared/signing.p8", "shared/app.mobileprovision", "shared/app.provisionprofile",
        )
        for relative in excluded:
            self.write(relative, "synthetic excluded fixture\n")
        self.git("add", "--force", *excluded)
        manifest = sync.stage_sources(self.stage)

        for relative in excluded:
            with self.subTest(relative=relative):
                self.assertNotIn(relative, manifest)
                self.assertFalse((self.stage / relative).exists())
        self.assertIn(self.native_path, manifest)
        self.assertTrue((self.stage / self.native_path).is_file())

    def test_source_edit_after_staging_is_rejected(self):
        manifest = sync.stage_sources(self.stage)
        self.write("transmitter/App.tsx", "export default 'changed during build';\n")
        with self.assertRaisesRegex(sync.SyncError, "Source changed during the build"):
            sync.verify_current_sources(manifest)

    def test_untracked_source_addition_after_staging_is_rejected(self):
        manifest = sync.stage_sources(self.stage)
        self.write("shared/added.ts", "export const added = true;\n")
        with self.assertRaisesRegex(sync.SyncError, "added or removed"):
            sync.verify_current_sources(manifest)

    def test_source_removal_after_staging_is_rejected(self):
        manifest = sync.stage_sources(self.stage)
        (self.root / "shared/protocol.ts").unlink()
        with self.assertRaisesRegex(sync.SyncError, "added or removed"):
            sync.verify_current_sources(manifest)


if __name__ == "__main__":
    unittest.main()
