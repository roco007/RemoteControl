import Foundation
import Testing
@testable import RemoteMacReceiver

struct YouTubeWebAppLauncherTests {
    @Test func modernSharedShimUsesActiveRegisteredProfileInsteadOfDash() throws {
        let fixture = try YouTubeWebAppFixture()
        try fixture.writeRegistration(installed: ["Default", "Profile 2"], active: ["Removed profile", "Profile 2"])
        try fixture.createProfile("Profile 2")

        let app = try YouTubeWebAppLauncher.discover(fixture.target, roots: fixture.roots)

        #expect(app.appID == fixture.appID)
        #expect(app.userDataDirectory == fixture.userDataDirectory)
        #expect(app.profile == "Profile 2")
    }

    @Test func fallsBackToFirstInstalledProfileWhenActiveRegistrationIsStale() throws {
        let fixture = try YouTubeWebAppFixture(application: "YouTube")
        try fixture.writeRegistration(installed: ["Default", "Profile 2"], active: ["Removed profile"])
        let app = try YouTubeWebAppLauncher.discover(fixture.target, roots: fixture.roots)
        #expect(app.profile == "Default")
    }

    @Test func supportsOlderProfileSpecificShimPaths() throws {
        let fixture = try YouTubeWebAppFixture()
        fixture.plist["CrAppModeUserDataDir"] = fixture.userDataDirectory.appendingPathComponent("Default/Web Applications/_crx_\(fixture.appID)").path
        try fixture.writePlist()
        let app = try YouTubeWebAppLauncher.discover(fixture.target, roots: fixture.roots)
        #expect(app.userDataDirectory == fixture.userDataDirectory)
        #expect(app.profile == "Default")
    }

    @Test func discoversSystemAppWhenUserAppIsAbsent() throws {
        let fixture = try YouTubeWebAppFixture()
        try fixture.writePlist(root: 1)
        try FileManager.default.removeItem(at: fixture.plistURL())
        let app = try YouTubeWebAppLauncher.discover(fixture.target, roots: fixture.roots)
        #expect(app.appID == fixture.appID)
    }

    @Test func missingAppNeverRunsLaunchOperation() throws {
        let fixture = try YouTubeWebAppFixture()
        try FileManager.default.removeItem(at: fixture.plistURL())
        var launches = 0
        expectFailure(.notInstalled(fixture.target.application)) {
            try YouTubeWebAppLauncher.requestPlayback(fixture.target, roots: fixture.roots) { _, _, _ in launches += 1 }
        }
        #expect(launches == 0)
    }

    @Test(arguments: ["browser", "executable", "shortID", "invalidID", "newlineID", "wrongOrigin", "spoofedOrigin", "httpOrigin", "wrongPort", "unparseableOrigin"])
    func rejectsInvalidAppMetadata(_ mutation: String) throws {
        let fixture = try YouTubeWebAppFixture()
        switch mutation {
        case "browser": fixture.plist["CrBundleIdentifier"] = "org.chromium.Chromium"
        case "executable": fixture.plist["CFBundleExecutable"] = "/bin/sh"
        case "shortID": fixture.plist["CrAppModeShortcutID"] = "aaa"
        case "invalidID": fixture.plist["CrAppModeShortcutID"] = String(repeating: "z", count: 32)
        case "newlineID": fixture.plist["CrAppModeShortcutID"] = fixture.appID + "\n"
        case "wrongOrigin": fixture.plist["CrAppModeShortcutURL"] = "https://www.youtube.com/"
        case "spoofedOrigin": fixture.plist["CrAppModeShortcutURL"] = "https://music.youtube.com.evil.test/"
        case "httpOrigin": fixture.plist["CrAppModeShortcutURL"] = "http://music.youtube.com/"
        case "wrongPort": fixture.plist["CrAppModeShortcutURL"] = "https://music.youtube.com:8443/"
        default: fixture.plist["CrAppModeShortcutURL"] = "%%%"
        }
        try fixture.writePlist()
        expectFailure(.invalidApplication(fixture.target.application, fixture.target.origin)) {
            try YouTubeWebAppLauncher.discover(fixture.target, roots: fixture.roots)
        }
    }

    @Test func acceptsDefaultHTTPSPortInShortcutOrigin() throws {
        let fixture = try YouTubeWebAppFixture()
        fixture.plist["CrAppModeShortcutURL"] = "https://music.youtube.com:443/some/start/path"
        try fixture.writePlist()
        let app = try YouTubeWebAppLauncher.discover(fixture.target, roots: fixture.roots)
        #expect(app.appID == fixture.appID)
    }

    @Test func firstInstalledAppIsValidatedRatherThanSilentlyTryingAnother() throws {
        let fixture = try YouTubeWebAppFixture()
        try fixture.writePlist(root: 1)
        fixture.plist["CrBundleIdentifier"] = "invalid.browser"
        try fixture.writePlist()
        expectFailure(.invalidApplication(fixture.target.application, fixture.target.origin)) {
            try YouTubeWebAppLauncher.discover(fixture.target, roots: fixture.roots)
        }
    }

    @Test(arguments: ["relative", "wrongID", "wrongParent", "missing"])
    func rejectsInvalidUserDataLocation(_ mutation: String) throws {
        let fixture = try YouTubeWebAppFixture()
        switch mutation {
        case "relative": fixture.plist["CrAppModeUserDataDir"] = "Chrome/-/Web Applications/_crx_\(fixture.appID)"
        case "wrongID": fixture.plist["CrAppModeUserDataDir"] = fixture.userDataDirectory.appendingPathComponent("-/Web Applications/_crx_wrong").path
        case "wrongParent": fixture.plist["CrAppModeUserDataDir"] = fixture.userDataDirectory.appendingPathComponent("-/Wrong Folder/_crx_\(fixture.appID)").path
        default: fixture.plist.removeValue(forKey: "CrAppModeUserDataDir")
        }
        try fixture.writePlist()
        expectFailure(.unlocatableProfile(fixture.target.application)) {
            try YouTubeWebAppLauncher.discover(fixture.target, roots: fixture.roots)
        }
    }

    @Test(arguments: ["missing", "malformed", "notObject"])
    func rejectsUnreadableLocalState(_ mutation: String) throws {
        let fixture = try YouTubeWebAppFixture()
        let url = fixture.userDataDirectory.appendingPathComponent("Local State")
        if mutation == "missing" { try FileManager.default.removeItem(at: url) }
        else { try Data((mutation == "malformed" ? "invalid JSON" : "[]").utf8).write(to: url) }
        expectFailure(.unreadableRegistration(fixture.target.application)) {
            try YouTubeWebAppLauncher.discover(fixture.target, roots: fixture.roots)
        }
    }

    @Test(arguments: ["", ".", "..", "../Default", "Default/child", "Profile\\1", "Profile\u{0}2", "Profile\u{7f}2", "Profile\n2"])
    func rejectsUnsafeProfileNames(_ profile: String) throws {
        let fixture = try YouTubeWebAppFixture()
        try fixture.writeRegistration(installed: [profile], active: [profile])
        expectFailure(.unregisteredProfile(fixture.target.application)) {
            try YouTubeWebAppLauncher.discover(fixture.target, roots: fixture.roots)
        }
    }

    @Test func rejectsUnregisteredProfile() throws {
        let fixture = try YouTubeWebAppFixture()
        try fixture.writeRegistration(installed: [], active: ["Default"])
        expectFailure(.unregisteredProfile(fixture.target.application)) {
            try YouTubeWebAppLauncher.discover(fixture.target, roots: fixture.roots)
        }
    }

    @Test(arguments: [false, true])
    func requiresProfileDirectoryToExist(_ replaceWithFile: Bool) throws {
        let fixture = try YouTubeWebAppFixture()
        let profile = fixture.userDataDirectory.appendingPathComponent("Default")
        try FileManager.default.removeItem(at: profile)
        if replaceWithFile { try Data().write(to: profile) }
        expectFailure(.missingProfile(fixture.target.application)) {
            try YouTubeWebAppLauncher.discover(fixture.target, roots: fixture.roots)
        }
    }

    @Test(arguments: ["YouTube", "YouTube Music"])
    func launchesExactAppProfileAndCanonicalURLAsSeparateArguments(_ application: String) throws {
        let fixture = try YouTubeWebAppFixture(application: application)
        var calls = 0
        try YouTubeWebAppLauncher.requestPlayback(fixture.target, roots: fixture.roots) { executable, arguments, timeout in
            calls += 1
            #expect(executable == "/usr/bin/open")
            #expect(arguments == ["-n", "-b", "com.google.Chrome", "--args",
                                  "--user-data-dir=\(fixture.userDataDirectory.path)", "--profile-directory=Default",
                                  "--app-id=\(fixture.appID)", "--app-launch-url-for-shortcuts-menu-item=\(fixture.target.url.absoluteString)"])
            #expect(timeout == 10)
        }
        #expect(calls == 1)
    }

    @Test func asynchronousLaunchReportsRequestWithoutClaimingPlayback() async throws {
        let fixture = try YouTubeWebAppFixture()
        let result: (Bool, String?) = await withCheckedContinuation { continuation in
            YouTubeWebAppLauncher.open(fixture.target, roots: fixture.roots, launch: { _, _, _ in
                #expect(!Thread.isMainThread)
            }) { ok, message in continuation.resume(returning: (ok, message)) }
        }
        #expect(result.0)
        #expect(result.1 == "Playback requested in YouTube Music. YouTube may require pressing Play.")
    }

    @Test func unknownLaunchErrorDoesNotExposeURLOrCredentials() async throws {
        let fixture = try YouTubeWebAppFixture()
        let result: (Bool, String?) = await withCheckedContinuation { continuation in
            YouTubeWebAppLauncher.open(fixture.target, roots: fixture.roots, launch: { _, _, _ in
                throw NSError(domain: "secret-url-and-token", code: 7, userInfo: [NSLocalizedDescriptionKey: "secret-url-and-token"])
            }) { ok, message in continuation.resume(returning: (ok, message)) }
        }
        #expect(!result.0)
        #expect(result.1 == YouTubeWebAppLauncher.Failure.launchFailed.localizedDescription)
    }

    @Test func asynchronousLaunchPreservesTimeoutFailure() async throws {
        let fixture = try YouTubeWebAppFixture()
        let result: (Bool, String?) = await withCheckedContinuation { continuation in
            YouTubeWebAppLauncher.open(fixture.target, roots: fixture.roots, launch: { _, _, _ in
                throw YouTubeWebAppLauncher.Failure.launchTimedOut
            }) { ok, message in continuation.resume(returning: (ok, message)) }
        }
        #expect(!result.0)
        #expect(result.1 == "The web app launch timed out.")
    }

    @Test func processRunnerRecognizesSuccessAndNonzeroExit() throws {
        try YouTubeWebAppLauncher.runProcess("/usr/bin/true", arguments: [], timeout: 1)
        expectFailure(.launchFailed) { try YouTubeWebAppLauncher.runProcess("/usr/bin/false", arguments: [], timeout: 1) }
    }

    @Test func launchEnvironmentExcludesMacUnlockSecret() {
        let source = ["MAC_UNLOCK_TEXT": "synthetic-test-only", "PATH": "/usr/bin:/bin", "LC_ALL": "fr_FR.UTF-8"]
        let environment = YouTubeWebAppLauncher.launchEnvironment(source)
        #expect(environment["MAC_UNLOCK_TEXT"] == nil)
        #expect(environment["PATH"] == source["PATH"])
        #expect(environment["LC_ALL"] == "C")
    }

    @Test func processRunnerBoundsAndReapsTimedOutProcess() {
        let start = ProcessInfo.processInfo.systemUptime
        expectFailure(.launchTimedOut) { try YouTubeWebAppLauncher.runProcess("/bin/sleep", arguments: ["2"], timeout: 0.05) }
        #expect(ProcessInfo.processInfo.systemUptime - start < 1)
    }
}

private func expectFailure<T>(_ expected: YouTubeWebAppLauncher.Failure, _ operation: () throws -> T) {
    do {
        _ = try operation()
        Issue.record("Expected YouTube web app failure: \(expected)")
    } catch {
        #expect(error as? YouTubeWebAppLauncher.Failure == expected)
    }
}

private final class YouTubeWebAppFixture {
    let directory: URL
    let roots: [URL]
    let userDataDirectory: URL
    let appID = String(repeating: "a", count: 32)
    let target: YouTubeMediaTarget
    var plist: [String: Any]

    init(application: String = "YouTube Music") throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("youtube-launcher-\(UUID().uuidString)", isDirectory: true)
        roots = [directory.appendingPathComponent("User Applications", isDirectory: true), directory.appendingPathComponent("System Applications", isDirectory: true)]
        userDataDirectory = directory.appendingPathComponent("Chrome User Data", isDirectory: true)
        let origin = application == "YouTube Music" ? "https://music.youtube.com" : "https://www.youtube.com"
        target = YouTubeMediaTarget(application: application, url: URL(string: "\(origin)/watch?v=abc123&list=PL_test&t=2m&autoplay=1")!, origin: origin)
        plist = [
            "CrBundleIdentifier": "com.google.Chrome",
            "CFBundleExecutable": "app_mode_loader",
            "CrAppModeShortcutID": appID,
            "CrAppModeShortcutURL": "\(origin)/",
            "CrAppModeUserDataDir": userDataDirectory.appendingPathComponent("-/Web Applications/_crx_\(appID)").path
        ]
        try writePlist()
        try writeRegistration(installed: ["Default"], active: ["Default"])
        try createProfile("Default")
    }

    deinit { try? FileManager.default.removeItem(at: directory) }

    func plistURL(root: Int = 0) -> URL {
        roots[root].appendingPathComponent("\(target.application).app/Contents/Info.plist")
    }

    func writePlist(root: Int = 0) throws {
        let url = plistURL(root: root)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try PropertyListSerialization.data(fromPropertyList: plist, format: .binary, options: 0).write(to: url)
    }

    func writeRegistration(installed: [String], active: [String]) throws {
        try FileManager.default.createDirectory(at: userDataDirectory, withIntermediateDirectories: true)
        let state = ["app_shims": [appID: ["installed_profiles": installed, "last_active_profiles": active]]]
        try JSONSerialization.data(withJSONObject: state).write(to: userDataDirectory.appendingPathComponent("Local State"))
    }

    func createProfile(_ profile: String) throws {
        try FileManager.default.createDirectory(at: userDataDirectory.appendingPathComponent(profile), withIntermediateDirectories: true)
    }
}
