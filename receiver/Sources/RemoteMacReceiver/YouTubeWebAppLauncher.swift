import Foundation
import Darwin

enum YouTubeWebAppLauncher {
    typealias LaunchOperation = (String, [String], TimeInterval) throws -> Void

    struct InstalledApplication: Equatable {
        let appID: String
        let userDataDirectory: URL
        let profile: String
    }

    enum Failure: Error, LocalizedError, Equatable {
        case notInstalled(String)
        case invalidApplication(String, String)
        case unlocatableProfile(String)
        case unreadableRegistration(String)
        case unregisteredProfile(String)
        case missingProfile(String)
        case launchFailed
        case launchTimedOut

        var errorDescription: String? {
            switch self {
            case .notInstalled(let application):
                return "\(application) web app is not installed. Install it from Chrome first."
            case .invalidApplication(let application, let origin):
                return "The installed \(application) must be a Chrome web app for \(origin)."
            case .unlocatableProfile(let application):
                return "Cannot locate the Chrome profile for \(application). Reinstall the web app from Chrome."
            case .unreadableRegistration(let application):
                return "Cannot read the installed Chrome profile for \(application). Open the web app once, then retry."
            case .unregisteredProfile(let application):
                return "\(application) is not registered in an installed Chrome profile. Reinstall the web app from Chrome."
            case .missingProfile(let application):
                return "The Chrome profile for \(application) is missing. Reinstall the web app from Chrome."
            case .launchFailed:
                return "Could not launch the installed YouTube web app."
            case .launchTimedOut:
                return "The web app launch timed out."
            }
        }
    }

    static func applicationRoots(fileManager: FileManager = .default) -> [URL] {
        let home = fileManager.homeDirectoryForCurrentUser
        return [home.appendingPathComponent("Applications/Chrome Apps.localized", isDirectory: true),
                home.appendingPathComponent("Applications", isDirectory: true),
                URL(fileURLWithPath: "/Applications/Chrome Apps.localized", isDirectory: true),
                URL(fileURLWithPath: "/Applications", isDirectory: true)]
    }

    static func discover(_ target: YouTubeMediaTarget, roots: [URL], fileManager: FileManager = .default) throws -> InstalledApplication {
        guard let plistURL = roots.map({ $0.appendingPathComponent("\(target.application).app/Contents/Info.plist") })
            .first(where: { fileManager.fileExists(atPath: $0.path) }) else {
            throw Failure.notInstalled(target.application)
        }
        let info: [String: Any]
        do {
            let data = try Data(contentsOf: plistURL)
            guard let dictionary = try PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any] else {
                throw Failure.invalidApplication(target.application, target.origin)
            }
            info = dictionary
        } catch {
            throw Failure.invalidApplication(target.application, target.origin)
        }
        guard info["CrBundleIdentifier"] as? String == "com.google.Chrome",
              info["CFBundleExecutable"] as? String == "app_mode_loader",
              let appID = info["CrAppModeShortcutID"] as? String,
              appID.utf8.count == 32, appID.utf8.allSatisfy({ (97...112).contains($0) }),
              let shortcut = info["CrAppModeShortcutURL"] as? String,
              origin(of: shortcut) == target.origin else {
            throw Failure.invalidApplication(target.application, target.origin)
        }
        guard let appData = info["CrAppModeUserDataDir"] as? String,
              (appData as NSString).isAbsolutePath,
              !appData.unicodeScalars.contains(where: { $0.value == 0 }) else {
            throw Failure.unlocatableProfile(target.application)
        }
        let appDataURL = URL(fileURLWithPath: appData).standardizedFileURL
        guard appDataURL.lastPathComponent == "_crx_\(appID)",
              appDataURL.deletingLastPathComponent().lastPathComponent == "Web Applications" else {
            throw Failure.unlocatableProfile(target.application)
        }
        // Current Chrome shims use a shared '-' directory here. The real profile
        // comes from Local State, rather than that component of the bundle path.
        let userDataDirectory = appDataURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let state: [String: Any]
        do {
            let data = try Data(contentsOf: userDataDirectory.appendingPathComponent("Local State"))
            guard let dictionary = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw Failure.unreadableRegistration(target.application)
            }
            state = dictionary
        } catch {
            throw Failure.unreadableRegistration(target.application)
        }
        let shims = state["app_shims"] as? [String: Any]
        let registration = shims?[appID] as? [String: Any]
        let installed = registration?["installed_profiles"] as? [String] ?? []
        let active = registration?["last_active_profiles"] as? [String] ?? []
        guard let profile = active.first(where: installed.contains) ?? installed.first,
              !profile.isEmpty, profile != ".", profile != "..",
              !profile.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 || $0 == "/" || $0 == "\\" }) else {
            throw Failure.unregisteredProfile(target.application)
        }
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: userDataDirectory.appendingPathComponent(profile).path, isDirectory: &isDirectory), isDirectory.boolValue else {
            throw Failure.missingProfile(target.application)
        }
        return InstalledApplication(appID: appID, userDataDirectory: userDataDirectory, profile: profile)
    }

    static func open(_ target: YouTubeMediaTarget, completion: @escaping (Bool, String?) -> Void) {
        open(target, roots: applicationRoots(), launch: runProcess, completion: completion)
    }

    static func open(_ target: YouTubeMediaTarget, roots: [URL], fileManager: FileManager = .default,
                     launch: @escaping LaunchOperation, completion: @escaping (Bool, String?) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try requestPlayback(target, roots: roots, fileManager: fileManager, launch: launch)
                completion(true, "Playback requested in \(target.application). YouTube may require pressing Play.")
            } catch let error as Failure {
                completion(false, error.localizedDescription)
            } catch {
                // Never return subprocess errors, paths, or URLs to phone logs.
                completion(false, Failure.launchFailed.localizedDescription)
            }
        }
    }

    static func requestPlayback(_ target: YouTubeMediaTarget, roots: [URL], fileManager: FileManager = .default,
                                launch: LaunchOperation) throws {
        let app = try discover(target, roots: roots, fileManager: fileManager)
        // A URL passed directly to the macOS app shim can be ignored. Chrome's
        // shortcut URL override targets the installed PWA even when Chrome runs.
        try launch("/usr/bin/open", ["-n", "-b", "com.google.Chrome", "--args",
                                   "--user-data-dir=\(app.userDataDirectory.path)",
                                   "--profile-directory=\(app.profile)", "--app-id=\(app.appID)",
                                   "--app-launch-url-for-shortcuts-menu-item=\(target.url.absoluteString)"], 10)
    }

    private static func origin(of raw: String) -> String? {
        guard let url = URLComponents(string: raw), url.url != nil,
              let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else { return nil }
        let port = url.port
        let suffix = port == nil || (scheme == "https" && port == 443) || (scheme == "http" && port == 80) ? "" : ":\(port!)"
        return "\(scheme)://\(host)\(suffix)"
    }

    /// The optional unlock override belongs only to the receiver process.
    static func launchEnvironment(_ source: [String: String]) -> [String: String] {
        var environment = source
        environment.removeValue(forKey: "MAC_UNLOCK_TEXT")
        environment["LC_ALL"] = "C"
        return environment
    }

    /// Direct arguments avoid a shell. Only the short-lived launch process is
    /// awaited; a successful exit acknowledges the request, not media playback.
    static func runProcess(_ executable: String, arguments: [String], timeout: TimeInterval) throws {
        var actions: posix_spawn_file_actions_t?
        var attributes: posix_spawnattr_t?
        guard posix_spawn_file_actions_init(&actions) == 0 else { throw Failure.launchFailed }
        defer { posix_spawn_file_actions_destroy(&actions) }
        guard posix_spawnattr_init(&attributes) == 0 else { throw Failure.launchFailed }
        defer { posix_spawnattr_destroy(&attributes) }
        for descriptor in [STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO] {
            guard posix_spawn_file_actions_addopen(&actions, descriptor, "/dev/null", descriptor == STDIN_FILENO ? O_RDONLY : O_WRONLY, 0) == 0 else {
                throw Failure.launchFailed
            }
        }
        // Do not leak receiver sockets, logs, or credential-store descriptors.
        guard posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT)) == 0,
              posix_spawnattr_setpgroup(&attributes, 0) == 0 else { throw Failure.launchFailed }
        let argumentStrings = [executable] + arguments
        let environmentValues = launchEnvironment(ProcessInfo.processInfo.environment)
        let environmentStrings = environmentValues.map { "\($0.key)=\($0.value)" }
        var argv = argumentStrings.map { strdup($0) } + [nil]
        var environment = environmentStrings.map { strdup($0) } + [nil]
        defer { argv.forEach { free($0) }; environment.forEach { free($0) } }
        guard argv.dropLast().allSatisfy({ $0 != nil }), environment.dropLast().allSatisfy({ $0 != nil }) else { throw Failure.launchFailed }
        var pid: pid_t = 0
        guard posix_spawn(&pid, executable, &actions, &attributes, &argv, &environment) == 0 else { throw Failure.launchFailed }
        let deadline = ProcessInfo.processInfo.systemUptime + max(0.01, timeout)
        var status: Int32 = 0
        while true {
            let result = waitpid(pid, &status, WNOHANG)
            if result == pid { break }
            if result == -1 && errno != EINTR { throw Failure.launchFailed }
            if ProcessInfo.processInfo.systemUptime >= deadline {
                kill(-pid, SIGKILL)
                kill(pid, SIGKILL)
                while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
                throw Failure.launchTimedOut
            }
            Thread.sleep(forTimeInterval: 0.02)
        }
        guard status & 0x7f == 0, (status >> 8) & 0xff == 0 else { throw Failure.launchFailed }
    }
}
