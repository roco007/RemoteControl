import Foundation
import AppKit
import Darwin
import Testing
import ReceiverCore
@testable import RemoteMacReceiver

struct ApplicationCommandTests {
    @Test func shellCommandDoesNotInheritReceiverFileDescriptors() async throws {
        let descriptor = open("/dev/null", O_RDONLY)
        #expect(descriptor >= 0)
        defer { close(descriptor) }
        let probe = fcntl(descriptor, F_DUPFD, 199)
        #expect(probe >= 199)
        defer { close(probe) }
        #expect(fcntl(probe, F_SETFD, 0) == 0)
        let outcome = await withCheckedContinuation { continuation in
            ShellCommandRunner.run("if [[ -e /dev/fd/\(probe) ]]; then exit 9; fi", timeout: 2) { ok, message in
                continuation.resume(returning: SystemActionOutcome(ok: ok, message: message))
            }
        }
        #expect(outcome.ok)
        #expect(fcntl(probe, F_GETFD) >= 0)
    }
    @Test(.enabled(if: ProcessInfo.processInfo.environment["REMOTE_MAC_ACTION_SMOKE"] == "1"))
    func installedCatalogAndNativeActionsSmoke() async throws {
        let input = NativeInput()
        let apps: [InstalledApplication] = await withCheckedContinuation { continuation in
            input.listApplications(refresh: true) { apps, error in
                #expect(error == nil)
                continuation.resume(returning: apps)
            }
        }
        #expect(!apps.isEmpty)
        #expect(apps.contains { $0.icon?.hasPrefix("data:image/png;base64,") == true })
        let calculator = try #require(apps.first { $0.id == "/System/Applications/Calculator.app" })
        let alreadyRunning = await MainActor.run { !NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.calculator").isEmpty }
        let command = await withCheckedContinuation { continuation in
            input.performSystemAction(.runCommand, parameters: ["command": "/usr/bin/true"]) { ok, _ in continuation.resume(returning: ok) }
        }
        #expect(command)
        let opened = await withCheckedContinuation { continuation in
            input.performSystemAction(.openApp, parameters: ["appId": calculator.id]) { ok, _ in continuation.resume(returning: ok) }
        }
        #expect(opened)
        await MainActor.run {
            let running = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.calculator")
            #expect(!running.isEmpty)
            if !alreadyRunning { running.forEach { _ = $0.terminate() } }
        }
        print("Native action smoke: \(apps.count) installed Mac apps; PNG icons present; /usr/bin/true exited successfully; Calculator launch observed; only test-launched Calculator closed.")
    }
    @Test func shellCommandReportsExitAndDoesNotExposeOutput() async {
        let success = await withCheckedContinuation { continuation in
            ShellCommandRunner.run("printf secret-output", timeout: 2) { ok, message in continuation.resume(returning: SystemActionOutcome(ok: ok, message: message)) }
        }
        #expect(success.ok)
        #expect(!(success.message ?? "").contains("secret-output"))
        let failure = await withCheckedContinuation { continuation in
            ShellCommandRunner.run("exit 7", timeout: 2) { ok, message in continuation.resume(returning: SystemActionOutcome(ok: ok, message: message)) }
        }
        #expect(!failure.ok)
        #expect(failure.message?.contains("7") == true)
    }
    @Test func shellCommandTimeoutStopsTheProcessGroup() async throws {
        let marker = FileManager.default.temporaryDirectory.appendingPathComponent("remote-mac-command-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: marker) }
        let result = await withCheckedContinuation { continuation in
            ShellCommandRunner.run("/bin/sleep 1; /usr/bin/touch '\(marker.path)'", timeout: 0.05) { ok, message in continuation.resume(returning: SystemActionOutcome(ok: ok, message: message)) }
        }
        #expect(!result.ok)
        #expect(result.message?.contains("timed out") == true)
        try await Task.sleep(nanoseconds: 1_100_000_000)
        #expect(!FileManager.default.fileExists(atPath: marker.path))
    }
    @Test func applicationDiscoverySkipsNestedBundlesAndUsesExactPaths() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("remote-mac-catalog-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        for path in ["Utilities/Visible.app", "Utilities/Visible.app/Contents/Helpers/Hidden.app", "Other.app"] {
            let contents = root.appendingPathComponent(path).appendingPathComponent("Contents")
            try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
            let plist = try PropertyListSerialization.data(fromPropertyList: ["CFBundleName": path, "CFBundleIdentifier": "test.app", "CFBundlePackageType": "APPL"], format: .xml, options: 0)
            try plist.write(to: contents.appendingPathComponent("Info.plist"))
        }
        let paths = ApplicationCatalog.applicationURLs(roots: [root]).map(\.path)
        #expect(paths.count == 2)
        #expect(paths.allSatisfy { !$0.contains("Hidden") })
    }
}
