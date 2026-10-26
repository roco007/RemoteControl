import AppKit
import ApplicationServices

/// Explicit, local verification only. This code never starts the receiver or opens credentials.
final class InputVerification: NSObject, NSApplicationDelegate {
    private let sink = NativeInput()
    private var window: NSWindow!
    private var field: NSTextField!
    private var originalCursor: CGPoint?
    private var controlledCursor: CGPoint?
    private var completed = false
    private var events: [[String: Any]] = []
    private var eventMonitor: Any?
    private var result: [String: Any] = ["permission": false, "mouseMoved": false, "mouseRestored": false, "unicode": false, "keyEvents": false, "shortcut": false, "passed": false]

    func applicationDidFinishLaunching(_ notification: Notification) {
        let permission = AXIsProcessTrusted(); result["permission"] = permission
        guard permission else { finish(error: "Accessibility permission is unavailable. No events were posted."); return }
        let menu = NSMenu()
        let applicationItem = NSMenuItem(); applicationItem.submenu = NSMenu(title: "Verification"); menu.addItem(applicationItem)
        let edit = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        edit.submenu = NSMenu(title: "Edit")
        edit.submenu?.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        menu.addItem(edit); NSApp.mainMenu = menu
        eventMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp, .flagsChanged]) { [weak self] event in
            if let self, event.window === self.window, self.events.count < 32 {
                self.events.append(["type": event.type.rawValue, "keyCode": event.keyCode, "flags": event.modifierFlags.rawValue])
            }
            return event
        }
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 530, height: 180), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Remote Mac — Native Input Verification"
        window.isReleasedWhenClosed = false; window.center()
        let title = NSTextField(labelWithString: "Verifying native mouse and keyboard input…")
        title.font = .systemFont(ofSize: 18, weight: .medium); title.frame = NSRect(x: 24, y: 122, width: 490, height: 28)
        window.contentView?.addSubview(title)
        field = NSTextField(frame: NSRect(x: 24, y: 68, width: 480, height: 32))
        field.font = .systemFont(ofSize: 18); field.placeholderString = "Native events will type here"
        window.contentView?.addSubview(field)
        let note = NSTextField(labelWithString: "No network connection or credentials. Moving focus cancels the check.")
        note.frame = NSRect(x: 24, y: 25, width: 490, height: 22); note.font = .systemFont(ofSize: 11)
        window.contentView?.addSubview(note)
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); window.makeFirstResponder(field)
        later { self.verifyMouse() }
    }

    private func focused() -> Bool {
        NSApp.isActive && NSApp.keyWindow === window && window.isVisible && field.currentEditor() != nil && window.firstResponder === field.currentEditor()
    }
    private func guardFocus() -> Bool {
        guard !completed else { return false }
        guard focused() else { finish(error: "Verification cancelled because focus changed. No further input was posted."); return false }
        return true
    }
    private var currentText: String { field.currentEditor()?.string ?? field.stringValue }
    private func verifyMouse() {
        guard guardFocus(), let original = CGEvent(source: nil)?.location else { return }
        originalCursor = original
        var displays = [CGDirectDisplayID](repeating: 0, count: 32); var count: UInt32 = 0
        CGGetActiveDisplayList(32, &displays, &count)
        let display = displays.prefix(Int(count)).map(CGDisplayBounds).first { $0.contains(original) }
        let dx = (display.map { original.x + 8 < $0.maxX } ?? true) ? 8.0 : -8.0
        controlledCursor = CGPoint(x: original.x + dx, y: original.y)
        sink.post(.move(dx, 0, dragging: nil))
        later {
            guard self.guardFocus(), let moved = CGEvent(source: nil)?.location, let expected = self.controlledCursor else { return }
            guard self.near(moved, expected) else { self.finish(error: "The physical cursor did not reach the expected position."); return }
            self.result["mouseMoved"] = true
            self.restoreCursor()
            self.later {
                guard self.guardFocus(), let restored = CGEvent(source: nil)?.location else { return }
                guard self.near(restored, original) else { self.finish(error: "The physical cursor did not restore to its original position."); return }
                self.result["mouseRestored"] = true
                self.sink.post(.text("Remote Mac ✓"))
                self.later { self.verifyUnicode() }
            }
        }
    }
    private func verifyUnicode() {
        guard guardFocus() else { return }
        guard currentText == "Remote Mac ✓" else { result["observedTextLength"] = currentText.utf16.count; finish(error: "Native Unicode events were not received by the focused field."); return }
        result["unicode"] = true
        sink.post(.key("backspace", down: true, modifiers: [], repeating: false))
        sink.post(.key("backspace", down: false, modifiers: [], repeating: false))
        later { self.verifyKeys() }
    }
    private func verifyKeys() {
        guard guardFocus() else { return }
        guard currentText == "Remote Mac " else { finish(error: "Native Backspace down/up events were not received correctly."); return }
        result["keyEvents"] = true
        sink.post(.key("command", down: true, modifiers: ["command"], repeating: false))
        sink.post(.key("a", down: true, modifiers: ["command"], repeating: false))
        sink.post(.key("a", down: false, modifiers: ["command"], repeating: false))
        sink.post(.key("command", down: false, modifiers: [], repeating: false))
        later {
            guard self.guardFocus() else { return }
            guard let editor = self.field.currentEditor() as? NSTextView, editor.selectedRange().length == "Remote Mac ".utf16.count else {
                self.finish(error: "Command-A did not select all text in the verification field."); return
            }
            self.result["shortcut"] = true
            self.finish(error: nil)
        }
    }
    private func restoreCursor() {
        guard let original = originalCursor, let controlled = controlledCursor, let current = CGEvent(source: nil)?.location else { return }
        // Preserve an intervening human movement instead of moving their cursor back unexpectedly.
        if near(current, controlled) { sink.post(.move(original.x - current.x, original.y - current.y, dragging: nil)) }
        controlledCursor = nil
    }
    private func near(_ a: CGPoint, _ b: CGPoint) -> Bool { hypot(a.x - b.x, a.y - b.y) <= 1 }
    private func later(_ block: @escaping () -> Void) { DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: block) }
    private func finish(error: String?) {
        guard !completed else { return }; completed = true
        restoreCursor(); window?.orderOut(nil)
        if let eventMonitor { NSEvent.removeMonitor(eventMonitor) }
        result["events"] = events
        result["passed"] = error == nil
        if let error { result["error"] = error }
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), let output = String(data: data, encoding: .utf8) { print(output); fflush(stdout) }
        exit(error == nil ? 0 : 1)
    }
}
