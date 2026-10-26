import Foundation

public enum InputAction: Equatable {
    case move(Double, Double, dragging: String?)
    case button(String, down: Bool, clickCount: Int)
    case scroll(Double, Double)
    case key(String, down: Bool, modifiers: [String], repeating: Bool)
    case text(String)
}

public protocol InputSink: AnyObject { func post(_ action: InputAction) }

public final class InputController {
    private let sink: InputSink
    public private(set) var heldButtons = Set<String>()
    public private(set) var heldKeys = Set<String>()
    private var modifiers: [String] = []
    public init(sink: InputSink) { self.sink = sink }

    public func handle(_ message: WireMessage) {
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
        case .mouseGesture: gesture(message)
        case .releaseAll: releaseAll()
        default: break
        }
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
