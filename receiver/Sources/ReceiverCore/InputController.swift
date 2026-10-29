import Foundation
import CryptoKit

public enum SystemAction: String, CaseIterable {
    case screenshot, killApp = "kill_app", lock, photoBooth = "photo_booth", openApp = "open_app", runCommand = "run_command", openURL = "open_url"
}

public enum SystemControl: String, CaseIterable {
    case volume, brightness
}

public enum InputAction: Equatable {
    case move(Double, Double, dragging: String?)
    case button(String, down: Bool, clickCount: Int)
    case scroll(Double, Double)
    case key(String, down: Bool, modifiers: [String], repeating: Bool)
    case text(String)
    case system(SystemAction)
    case openApplication(String)
    case runCommand(String)
    case openURL(String)
    case systemAdjust(SystemControl, steps: Int)
}

public protocol InputSink: AnyObject {
    func post(_ action: InputAction)
    func listApplications(refresh: Bool, completion: @escaping ([InstalledApplication], String?) -> Void)
    func performSystemAction(_ action: SystemAction, parameters: [String: String], completion: @escaping (Bool, String?) -> Void)
    func performSystemAction(_ action: SystemAction, completion: @escaping (Bool, String?) -> Void)
}
public extension InputSink {
    func listApplications(refresh: Bool, completion: @escaping ([InstalledApplication], String?) -> Void) { completion([], "Application listing is unavailable.") }
    func performSystemAction(_ action: SystemAction, parameters: [String: String], completion: @escaping (Bool, String?) -> Void) {
        switch action {
        case .openApp: post(.openApplication(parameters["appId"] ?? "")); completion(true, nil)
        case .runCommand: post(.runCommand(parameters["command"] ?? "")); completion(true, nil)
        case .openURL: post(.openURL(parameters["url"] ?? "")); completion(true, nil)
        default: performSystemAction(action, completion: completion)
        }
    }
    /// Synchronous sinks, including the recording integration harness, finish on return.
    func performSystemAction(_ action: SystemAction, completion: @escaping (Bool, String?) -> Void) {
        post(.system(action)); completion(true, nil)
    }
}

public final class InputController {
    private let sink: InputSink
    private let actionGate: SystemActionGate
    public private(set) var heldButtons = Set<String>()
    public private(set) var heldKeys = Set<String>()
    private var modifiers: [String] = []
    public init(sink: InputSink, actionGate: SystemActionGate = SystemActionGate()) { self.sink = sink; self.actionGate = actionGate }

    public func handle(_ message: WireMessage, deviceID: String? = nil, systemActionAllowed: Bool = true,
                       completion: @escaping (SystemActionOutcome) -> Void = { _ in }) {
        switch message.kind {
        case .mouseMove:
            let dragging = ["left", "right", "middle"].first { heldButtons.contains($0) }
            sink.post(.move(message.number("dx"), message.number("dy"), dragging: dragging))
        case .mouseDown:
            let button = message.string("button")
            if heldButtons.insert(button).inserted { sink.post(.button(button, down: true, clickCount: 1)) }
        case .mouseUp:
            let button = message.string("button")
            if heldButtons.remove(button) != nil { sink.post(.button(button, down: false, clickCount: 1)) }
        case .mouseClick:
            let button = message.string("button")
            guard !heldButtons.contains(button) else { return }
            for count in 1...Int(message.number("count")) {
                sink.post(.button(button, down: true, clickCount: count))
                sink.post(.button(button, down: false, clickCount: count))
            }
        case .mouseScroll: sink.post(.scroll(message.number("dx"), message.number("dy")))
        case .keyboardDown:
            let key = message.string("key")
            let alreadyHeld = heldKeys.contains(key)
            guard !alreadyHeld || message.bool("repeat") else { return }
            heldKeys.insert(key); modifiers = message.modifiers
            sink.post(.key(key, down: true, modifiers: modifiers, repeating: alreadyHeld))
        case .keyboardUp:
            let key = message.string("key")
            modifiers = message.modifiers
            if heldKeys.remove(key) != nil { sink.post(.key(key, down: false, modifiers: modifiers, repeating: false)) }
        case .keyboardText:
            // Composed Unicode is a separate channel; held shortcuts must not swallow it.
            guard modifiers.isEmpty else { return }
            sink.post(.text(message.string("text")))
        case .systemAction:
            guard let action = SystemAction(rawValue: message.string("action")) else { return }
            var parameters: [String: String] = [:]
            for key in ["appId", "command", "url"] { if let value = message.fields[key] as? String { parameters[key] = value } }
            let data = (try? JSONSerialization.data(withJSONObject: parameters, options: [.sortedKeys])) ?? Data()
            let fingerprint = parameters.isEmpty ? "" : SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            actionGate.perform(device: deviceID, id: message.fields["id"] as? String, action: action, fingerprint: fingerprint, start: { finish in
                guard systemActionAllowed else { finish(false, "Accessibility permission is required."); return }
                self.releaseAll()
                self.sink.performSystemAction(action, parameters: parameters, completion: finish)
            }, completion: completion)
        case .systemAdjust:
            guard let control = SystemControl(rawValue: message.string("control")) else { return }
            releaseAll()
            sink.post(.systemAdjust(control, steps: Int(message.number("steps"))))
        case .mouseGesture: gesture(message)
        case .releaseAll: releaseAll()
        default: break
        }
    }

    public func listApplications(refresh: Bool, completion: @escaping ([InstalledApplication], String?) -> Void) {
        sink.listApplications(refresh: refresh, completion: completion)
    }

    public func actionStatus(device: String, id: String, action: SystemAction) -> SystemActionOutcome {
        actionGate.status(device: device, id: id, action: action)
    }

    public func releaseAll() {
        for button in heldButtons.sorted() { sink.post(.button(button, down: false, clickCount: 1)) }
        for key in heldKeys.sorted() { sink.post(.key(key, down: false, modifiers: [], repeating: false)) }
        heldButtons.removeAll(); heldKeys.removeAll(); modifiers.removeAll()
    }

    private func shortcut(_ key: String, modifiers shortcutModifiers: [String]) {
        guard heldKeys.isEmpty, heldButtons.isEmpty else { return }
        sink.post(.key(key, down: true, modifiers: shortcutModifiers, repeating: false))
        sink.post(.key(key, down: false, modifiers: [], repeating: false))
    }
    private func gesture(_ message: WireMessage) {
        guard heldKeys.isEmpty, heldButtons.isEmpty else { return }
        if message.string("gesture") == "zoom" {
            // The transmitter recognizes pinch thresholds and emits one step per message.
            let amount = message.number("amount")
            if amount != 0 { shortcut(amount > 0 ? "equal" : "minus", modifiers: ["command"]) }
        } else {
            let direction = message.string("direction")
            if message.number("fingers") == 2 {
                if direction == "left" { shortcut("bracket_left", modifiers: ["command"]) }
                else if direction == "right" { shortcut("bracket_right", modifiers: ["command"]) }
            } else { shortcut(direction, modifiers: ["control"]) }
        }
    }
}
