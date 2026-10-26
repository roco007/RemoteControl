import AppKit
import CoreGraphics
import ReceiverCore

final class NativeInput: InputSink {
    private let source = CGEventSource(stateID: .privateState)
    private let postEvent: (CGEvent) -> Void
    private var scrollX = 0.0
    private var scrollY = 0.0
    private var capsLockState = CapsLockState(initial: CGEventSource.flagsState(.combinedSessionState).contains(.maskAlphaShift), physical: CGEventSource.flagsState(.hidSystemState).contains(.maskAlphaShift))

    init(postEvent: @escaping (CGEvent) -> Void = { $0.post(tap: .cghidEventTap) }) {
        self.postEvent = postEvent
    }

    func post(_ action: InputAction) {
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
