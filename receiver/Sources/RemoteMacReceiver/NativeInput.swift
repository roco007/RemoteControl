import AppKit
import CoreGraphics
import ApplicationServices
import IOKit.hidsystem
import ReceiverCore

final class NativeInput: InputSink {
    private let inputQueue = DispatchQueue(label: "com.remotemac.receiver.input", qos: .userInteractive)
    private var screenLock: ScreenLockController!
    var onLockStatus: ((String) -> Void)?
    private let applicationCatalog = ApplicationCatalog()
    private let source = CGEventSource(stateID: .privateState)
    private let postEvent: (CGEvent) -> Void
    private let forceQuitFrontmost: (@escaping (Bool, String?) -> Void) -> Void
    private let openURL: (URL, @escaping (Bool) -> Void) -> Void
    private let playYouTube: (YouTubeMediaTarget, @escaping (Bool, String?) -> Void) -> Void
    private let openPhotoBooth: (@escaping (Bool, String?) -> Void) -> Void
    private var scrollX = 0.0
    private var scrollY = 0.0
    private var capsLockState = CapsLockState(initial: CGEventSource.flagsState(.combinedSessionState).contains(.maskAlphaShift), physical: CGEventSource.flagsState(.hidSystemState).contains(.maskAlphaShift))

    init(postEvent: @escaping (CGEvent) -> Void = { $0.post(tap: .cghidEventTap) },
         forceQuitFrontmost: @escaping (@escaping (Bool, String?) -> Void) -> Void = NativeInput.forceQuitFrontmostApplication,
         openPhotoBooth: @escaping (@escaping (Bool, String?) -> Void) -> Void = NativeInput.openPhotoBoothApplication,
         openURL: @escaping (URL, @escaping (Bool) -> Void) -> Void = NativeInput.openWebURL,
         playYouTube: @escaping (YouTubeMediaTarget, @escaping (Bool, String?) -> Void) -> Void = YouTubeWebAppLauncher.open,
         screenLockState: @escaping () -> ScreenLockState = MacScreenLockState.current,
         unlockPassword: @escaping () throws -> String? = { try MacUnlockCredentialStore().password() },
         displayWake: DisplayWake = .system(),
         accessibilityAllowed: @escaping () -> Bool = { AXIsProcessTrusted() }) {
        self.postEvent = postEvent
        self.forceQuitFrontmost = forceQuitFrontmost
        self.openPhotoBooth = openPhotoBooth
        self.openURL = openURL
        self.playYouTube = playYouTube
        screenLock = ScreenLockController(state: screenLockState, allowed: accessibilityAllowed,
            password: unlockPassword,
            lock: { [weak self] in _ = self?.systemShortcut("q", modifiers: ["control", "command"]) },
            key: { [weak self] in self?.postUnlockKey($0) },
            text: { [weak self] password in
                // An already-awake login field may contain Space or a partial password.
                // Replace its contents, releasing Command before the Unicode events.
                self?.systemShortcut("a", modifiers: ["command"])
                self?.emit(.text(password))
            },
            display: displayWake,
            schedule: { [weak self] delay, step in self?.inputQueue.asyncAfter(deadline: .now() + delay, execute: step) },
            report: { [weak self] message in
                DispatchQueue.main.async { [weak self] in self?.onLockStatus?(message) }
            })
    }

    func cancelForSystemSleep() {
        inputQueue.sync { screenLock.cancelForSystemSleep() }
    }

    func post(_ action: InputAction) {
        if case .system(let system) = action { performSystemAction(system) { _, _ in }; return }
        if case .openApplication(let id) = action { performSystemAction(.openApp, parameters: ["appId": id]) { _, _ in }; return }
        if case .openURL(let url) = action { performSystemAction(.openURL, parameters: ["url": url]) { _, _ in }; return }
        if case .runCommand(let command) = action { performSystemAction(.runCommand, parameters: ["command": command]) { _, _ in }; return }
        inputQueue.sync {
            // Keep remote cursor/keyboard/shortcuts from changing focus during password entry.
            guard !screenLock.isEnteringPassword else { return }
            emit(action)
        }
    }

    func listApplications(refresh: Bool, completion: @escaping ([InstalledApplication], String?) -> Void) {
        applicationCatalog.list(refresh: refresh, completion: completion)
    }

    func performSystemAction(_ action: SystemAction, completion: @escaping (Bool, String?) -> Void) {
        performSystemAction(action, parameters: [:], completion: completion)
    }

    func performSystemAction(_ action: SystemAction, parameters: [String: String], completion: @escaping (Bool, String?) -> Void) {
        inputQueue.sync {
            guard !screenLock.isEnteringPassword else { completion(false, "Unlock is still running."); return }
            switch action {
            case .screenshot:
                let sent = systemShortcut("3", modifiers: ["command", "shift"])
                // macOS exposes no completion callback for this keyboard shortcut.
                // Confirm balanced emission only, never claim a capture/file was saved.
                completion(sent, sent ? "Screenshot shortcut sent. macOS does not report capture completion." : "Could not send the screenshot shortcut.")
            case .lock: screenLock.toggle(completion: completion)
            case .killApp: forceQuitFrontmost(completion)
            case .photoBooth: openPhotoBooth(completion)
            case .openApp:
                guard let id = parameters["appId"], !id.isEmpty else { completion(false, "Choose a Mac app first."); return }
                applicationCatalog.open(id: id, completion: completion)
            case .openURL:
                guard let value = parameters["url"], let url = HTTPURL.parse(value) else { completion(false, "Enter a valid HTTP or HTTPS URL."); return }
                do {
                    if let target = try YouTubeMediaTarget.resolve(url) {
                        playYouTube(target, completion)
                        return
                    }
                } catch {
                    completion(false, (error as? LocalizedError)?.errorDescription ?? "Could not open this YouTube media link.")
                    return
                }
                openURL(url) { ok in
                    completion(ok, ok ? "URL handed to macOS. Page loading is not tracked." : "No application could open this URL.")
                }
            case .runCommand:
                guard let command = parameters["command"], !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { completion(false, "Enter a command first."); return }
                ShellCommandRunner.run(command, completion: completion)
            }
        }
    }

    private func emit(_ action: InputAction) {
        switch action {
        case let .move(dx, dy, dragging):
            guard let location = CGEvent(source: nil)?.location else { return }
            let target = clamped(CGPoint(x: location.x + dx, y: location.y + dy))
            let button = cgButton(dragging ?? "left")
            let type: CGEventType = dragging == nil ? .mouseMoved : (button == .left ? .leftMouseDragged : button == .right ? .rightMouseDragged : .otherMouseDragged)
            let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: target, mouseButton: button)
            event?.setIntegerValueField(.mouseEventDeltaX, value: Int64(dx.rounded()))
            event?.setIntegerValueField(.mouseEventDeltaY, value: Int64(dy.rounded()))
            if let event { postEvent(event) }
        case let .button(name, down, clickCount):
            guard let location = CGEvent(source: nil)?.location else { return }
            let button = cgButton(name)
            let type: CGEventType = button == .left ? (down ? .leftMouseDown : .leftMouseUp) : button == .right ? (down ? .rightMouseDown : .rightMouseUp) : (down ? .otherMouseDown : .otherMouseUp)
            let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: location, mouseButton: button)
            event?.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
            if let event { postEvent(event) }
        case let .scroll(dx, dy):
            scrollX += dx; scrollY += dy
            let x = Int32(scrollX.rounded(.towardZero)), y = Int32(scrollY.rounded(.towardZero))
            scrollX -= Double(x); scrollY -= Double(y)
            guard x != 0 || y != 0 else { return }
            let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: y, wheel2: x, wheel3: 0)
            event?.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
            if let event { postEvent(event) }
        case let .key(name, down, modifiers, repeating):
            guard let code = KeyCodes.values[name], let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { return }
            let capsLock = capsLockState.resolve(physical: CGEventSource.flagsState(.hidSystemState).contains(.maskAlphaShift), remoteToggle: name == "caps_lock" && down)
            var flags = flagsFor(modifiers)
            if Wire.directions.contains(name) {
                // Quartz marks arrows as navigation keys independently of held modifiers.
                flags.formUnion(event.flags.intersection([.maskNumericPad, .maskSecondaryFn]))
            }
            if capsLock { flags.insert(.maskAlphaShift) }
            if Wire.modifiers.contains(name) || name == "caps_lock" { event.type = .flagsChanged }
            event.flags = flags
            event.setIntegerValueField(.keyboardEventAutorepeat, value: repeating ? 1 : 0)
            postEvent(event)
        case .system, .openApplication, .runCommand, .openURL: break // Routed through performSystemAction before entering emit.
        case let .systemAdjust(control, steps):
            adjustSystem(control, steps: steps)
        case .text(let text):
            // Small UTF-16 chunks work across editors while preserving surrogate pairs.
            var chunk = ""
            for scalar in text.unicodeScalars {
                if chunk.utf16.count + scalar.utf16.count > 20 { postText(chunk); chunk = "" }
                chunk.unicodeScalars.append(scalar)
            }
            if !chunk.isEmpty { postText(chunk) }
        }
    }

    @discardableResult private func systemShortcut(_ key: String, modifiers: [String]) -> Bool {
        guard let code = KeyCodes.values[key],
              let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else { return false }
        down.flags = flagsFor(modifiers); up.flags = []
        postEvent(down); postEvent(up)
        return true
    }

    private func adjustSystem(_ control: SystemControl, steps: Int) {
        // Native media keys preserve macOS output/display selection and show its OSD.
        // Option-Shift requests the small increment instead of a full keyboard notch.
        guard steps != 0, (-Wire.maxSystemAdjustSteps...Wire.maxSystemAdjustSteps).contains(steps) else { return }
        let key = control == .volume
            ? (steps > 0 ? NX_KEYTYPE_SOUND_UP : NX_KEYTYPE_SOUND_DOWN)
            : (steps > 0 ? NX_KEYTYPE_BRIGHTNESS_UP : NX_KEYTYPE_BRIGHTNESS_DOWN)
        for _ in 0..<abs(steps) {
            let events = [NX_KEYDOWN, NX_KEYUP].compactMap { state in
                NSEvent.otherEvent(with: .systemDefined, location: .zero,
                    modifierFlags: [.shift, .option], timestamp: ProcessInfo.processInfo.systemUptime,
                    windowNumber: 0, context: nil, subtype: Int16(NX_SUBTYPE_AUX_CONTROL_BUTTONS),
                    data1: (Int(key) << 16) | (Int(state) << 8), data2: -1)?.cgEvent
            }
            // Construct the complete pair before posting so allocation failure cannot leave a key held.
            guard events.count == 2 else { return }
            events.forEach(postEvent)
        }
    }

    private func postUnlockKey(_ code: CGKeyCode) {
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { continue }
            event.flags = []
            postEvent(event)
        }
    }

    static func canForceQuit(processID: pid_t, bundleIdentifier: String?, regular: Bool,
                             ownProcessID: pid_t = ProcessInfo.processInfo.processIdentifier) -> Bool {
        guard regular, processID > 1, processID != ownProcessID else { return false }
        let protected = ["com.apple.finder", "com.apple.loginwindow", "com.apple.dock",
                         "com.apple.systemuiserver", "com.apple.controlcenter", "com.remotemac.receiver"]
        return !protected.contains(bundleIdentifier?.lowercased() ?? "")
    }

    private static func forceQuitFrontmostApplication(completion: @escaping (Bool, String?) -> Void) {
        DispatchQueue.main.async {
            guard let application = NSWorkspace.shared.frontmostApplication,
                  canForceQuit(processID: application.processIdentifier, bundleIdentifier: application.bundleIdentifier,
                               regular: application.activationPolicy == .regular) else {
                completion(false, "The frontmost application cannot be terminated."); return
            }
            ApplicationTermination.perform(start: application.forceTerminate, terminated: { application.isTerminated },
                schedule: { delay, next in DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: next) }, completion: completion)
        }
    }

    private static func openWebURL(_ url: URL, completion: @escaping (Bool) -> Void) {
        DispatchQueue.main.async { completion(NSWorkspace.shared.open(url)) }
    }

    private static func openPhotoBoothApplication(completion: @escaping (Bool, String?) -> Void) {
        DispatchQueue.main.async {
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.PhotoBooth") else {
                completion(false, "Photo Booth is not installed."); return
            }
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = true
            NSWorkspace.shared.openApplication(at: url, configuration: configuration) { application, error in
                completion(application != nil && error == nil, error == nil && application != nil ? nil : "Photo Booth could not open.")
            }
        }
    }

    private func postText(_ text: String) {
        let units = Array(text.utf16)
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { continue }
            event.flags = []
            units.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: $0.baseAddress) }
            postEvent(event)
        }
    }
    private func cgButton(_ name: String) -> CGMouseButton { name == "right" ? .right : name == "middle" ? .center : .left }
    private func flagsFor(_ modifiers: [String]) -> CGEventFlags {
        modifiers.reduce(into: CGEventFlags()) { flags, modifier in
            switch modifier {
            case "shift": flags.insert(.maskShift)
            case "control": flags.insert(.maskControl)
            case "option": flags.insert(.maskAlternate)
            case "command": flags.insert(.maskCommand)
            default: break
            }
        }
    }
    private func clamped(_ point: CGPoint) -> CGPoint {
        var ids = [CGDirectDisplayID](repeating: 0, count: 32)
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(32, &ids, &count) == .success else { return point }
        let rects = ids.prefix(Int(count)).map(CGDisplayBounds)
        if rects.contains(where: { $0.contains(point) }) { return point }
        return rects.map { rect in CGPoint(x: min(max(point.x, rect.minX), rect.maxX - 1), y: min(max(point.y, rect.minY), rect.maxY - 1)) }
            .min { hypot($0.x - point.x, $0.y - point.y) < hypot($1.x - point.x, $1.y - point.y) } ?? point
    }
}

enum KeyCodes {
    // Physical ANSI key positions; keyboard_text is layout-independent Unicode.
    static let values: [String: CGKeyCode] = [
        "a":0, "s":1, "d":2, "f":3, "h":4, "g":5, "z":6, "x":7, "c":8, "v":9, "b":11,
        "q":12, "w":13, "e":14, "r":15, "y":16, "t":17, "1":18, "2":19, "3":20, "4":21, "6":22, "5":23,
        "equal":24, "9":25, "7":26, "minus":27, "8":28, "0":29, "bracket_right":30, "o":31, "u":32, "bracket_left":33,
        "i":34, "p":35, "enter":36, "l":37, "j":38, "quote":39, "k":40, "semicolon":41, "backslash":42, "comma":43,
        "slash":44, "n":45, "m":46, "period":47, "tab":48, "space":49, "backtick":50, "backspace":51, "escape":53,
        "command":55, "shift":56, "caps_lock":57, "option":58, "control":59,
        "f5":96, "f6":97, "f7":98, "f3":99, "f8":100, "f9":101, "f11":103, "f10":109, "f12":111,
        "home":115, "page_up":116, "delete":117, "f4":118, "end":119, "f2":120, "page_down":121, "f1":122,
        "left":123, "right":124, "down":125, "up":126
    ]
}
