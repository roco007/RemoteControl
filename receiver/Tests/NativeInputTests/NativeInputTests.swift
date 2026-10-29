import AppKit
import CoreGraphics
import Foundation
import Testing
import ReceiverCore
@testable import RemoteMacReceiver

struct NativeInputTests {
    @Test func missingUnlockCredentialReportsFailureInsteadOfSuccessfulDispatch() {
        var result: Bool?
        let input = NativeInput(postEvent: { _ in Issue.record("No real keys should be sent") }, screenLockState: { .locked }, unlockPassword: { nil }, displayWake: fakeAwakeDisplay(), accessibilityAllowed: { true })
        input.performSystemAction(.lock) { ok, _ in result = ok }
        #expect(result == false)
    }
    @Test(arguments: ["volume", "brightness"], [1, -1, 3, -16])
    func fineAdjustmentsEmitBalancedNativeMediaEvents(_ control: String, _ steps: Int) throws {
        var events: [CGEvent] = []
        let native = NativeInput(postEvent: { events.append($0) })
        let input = InputController(sink: native)
        input.handle(try WireProtocol.validate(["v": 1, "type": "system_adjust", "seq": 1, "timestamp": 1, "control": control, "steps": steps]))
        try #require(events.count == abs(steps) * 2)
        // IOKit auxiliary keys: sound up/down = 0/1, brightness up/down = 2/3.
        let keyCode = (control == "volume" ? 0 : 2) + (steps > 0 ? 0 : 1)
        for (index, cgEvent) in events.enumerated() {
            let event = try #require(NSEvent(cgEvent: cgEvent))
            #expect(event.type == .systemDefined)
            #expect(event.subtype.rawValue == 8)
            #expect(event.data1 == (keyCode << 16) | (index.isMultiple(of: 2) ? 0x0a00 : 0x0b00))
            #expect(event.data2 == -1)
            #expect(event.modifierFlags.contains(.shift))
            #expect(event.modifierFlags.contains(.option))
            #expect(!event.modifierFlags.contains(.command))
            #expect(!event.modifierFlags.contains(.control))
        }
    }
    @Test func fineAdjustmentsReleaseHeldRemoteInputBeforeMediaEvents() throws {
        var events: [CGEvent] = []
        let input = InputController(sink: NativeInput(postEvent: { events.append($0) }))
        input.handle(try WireProtocol.validate(["v": 1, "type": "keyboard_down", "seq": 1, "timestamp": 1, "key": "command", "modifiers": ["command"], "repeat": false]))
        input.handle(try WireProtocol.validate(["v": 1, "type": "system_adjust", "seq": 2, "timestamp": 1, "control": "brightness", "steps": -1]))
        try #require(events.count == 4)
        #expect(input.heldKeys.isEmpty)
        #expect(events[1].type == .flagsChanged)
        #expect(!events[1].flags.contains(.maskCommand))
        #expect(try #require(NSEvent(cgEvent: events[2])).type == .systemDefined)
    }
    @Test func unlockReplacesExistingPasswordFieldTextAndSuppressesOtherInput() async throws {
        let recorded = RecordedEvents()
        let input = NativeInput(postEvent: { recorded.append($0) }, screenLockState: { .locked },
                                unlockPassword: { "test-password" }, displayWake: fakeAwakeDisplay(), accessibilityAllowed: { true })
        input.post(.system(.lock))
        input.post(.text("must-not-reach-login"))
        input.post(.key("x", down: true, modifiers: [], repeating: false))
        for _ in 0..<100 {
            if recorded.events.count >= 8 { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        let events = recorded.events
        try #require(events.count == 8)
        #expect(events.map { $0.getIntegerValueField(.keyboardEventKeycode) } == [49, 49, 0, 0, 0, 0, 36, 36])
        #expect(events[2].type == .keyDown)
        #expect(events[2].flags.contains(.maskCommand))
        #expect(events[3].type == .keyUp)
        #expect(events[3].flags.intersection([.maskCommand, .maskControl, .maskShift, .maskAlternate]).isEmpty)
        var units = [UniChar](repeating: 0, count: 64)
        var count = 0
        events[4].keyboardGetUnicodeString(maxStringLength: units.count, actualStringLength: &count, unicodeString: &units)
        #expect(String(decoding: units.prefix(count), as: UTF16.self) == "test-password")
        #expect(events[4].flags.isEmpty)
    }

    @Test func sleepingDisplaySuppressesAllInputUntilSleepCancellationAndNeverReplaysIt() async throws {
        let recorded = RecordedEvents()
        var requests = 0, releases = 0, unlockResults: [Bool] = [], otherResults: [Bool] = []
        let display = DisplayWake(state: { .asleep }, acquire: { requests += 1; return true }, release: { releases += 1 })
        let input = NativeInput(postEvent: { recorded.append($0) }, screenLockState: { .locked },
                                unlockPassword: { "test-password" }, displayWake: display, accessibilityAllowed: { true })
        input.performSystemAction(.lock) { ok, _ in unlockResults.append(ok) }
        input.post(.text("must-not-reach-login"))
        input.post(.move(10, 10, dragging: nil))
        input.performSystemAction(.screenshot) { ok, _ in otherResults.append(ok) }
        #expect(requests == 1)
        #expect(recorded.events.isEmpty)
        #expect(unlockResults.isEmpty)
        #expect(otherResults == [false])
        input.cancelForSystemSleep()
        input.cancelForSystemSleep()
        try await Task.sleep(nanoseconds: 200_000_000)
        #expect(recorded.events.isEmpty)
        #expect(releases == 1)
        #expect(unlockResults == [false])
        input.post(.text("new input"))
        #expect(recorded.events.count == 2)
    }

    @Test(arguments: [SystemAction.screenshot, SystemAction.lock])
    func systemShortcutsUseExpectedKeyAndReleaseModifiers(_ action: SystemAction) throws {
        var events: [CGEvent] = []
        let input = NativeInput(postEvent: { events.append($0) }, screenLockState: { .unlocked }, displayWake: fakeAwakeDisplay(), accessibilityAllowed: { true })
        input.post(.system(action))

        #expect(events.count == 2)
        let down = try #require(events.first), up = try #require(events.last)
        #expect(down.type == .keyDown)
        #expect(up.type == .keyUp)
        let key = action == .screenshot ? "3" : "q"
        #expect(down.getIntegerValueField(.keyboardEventKeycode) == Int64(try #require(KeyCodes.values[key])))
        #expect(up.getIntegerValueField(.keyboardEventKeycode) == down.getIntegerValueField(.keyboardEventKeycode))
        #expect(down.flags.contains(.maskCommand))
        #expect(down.flags.contains(action == .screenshot ? .maskShift : .maskControl))
        #expect(!down.flags.contains(action == .screenshot ? .maskControl : .maskShift))
        #expect(up.flags.intersection([.maskCommand, .maskShift, .maskControl, .maskAlternate]).isEmpty)
    }

    @Test func killAppDispatchesOnlyToForegroundAppHandler() {
        var events: [CGEvent] = []
        var kills = 0
        let input = NativeInput(postEvent: { events.append($0) }, forceQuitFrontmost: { done in kills += 1; done(true, nil) })
        input.post(.system(.killApp))
        #expect(kills == 1)
        #expect(events.isEmpty)
    }

    @Test func photoBoothDispatchesOnceWithoutKeyboardOrTermination() {
        var events: [CGEvent] = []
        var kills = 0
        var launches = 0
        let input = NativeInput(postEvent: { events.append($0) }, forceQuitFrontmost: { done in kills += 1; done(true, nil) },
                                openPhotoBooth: { done in launches += 1; done(true, nil) })
        input.post(.system(.photoBooth))
        #expect(launches == 1)
        #expect(kills == 0)
        #expect(events.isEmpty)
    }

    @Test func forceQuitProtectsReceiverAndSystemUIWithoutBlockingOrdinaryApps() {
        #expect(NativeInput.canForceQuit(processID: 42, bundleIdentifier: "com.apple.Safari", regular: true, ownProcessID: 10))
        #expect(NativeInput.canForceQuit(processID: 42, bundleIdentifier: nil, regular: true, ownProcessID: 10))
        #expect(!NativeInput.canForceQuit(processID: 10, bundleIdentifier: "org.test.App", regular: true, ownProcessID: 10))
        #expect(!NativeInput.canForceQuit(processID: 42, bundleIdentifier: "org.test.Agent", regular: false, ownProcessID: 10))
        #expect(!NativeInput.canForceQuit(processID: 1, bundleIdentifier: nil, regular: true, ownProcessID: 10))
        for bundle in ["com.apple.finder", "com.apple.loginwindow", "com.apple.dock", "com.apple.SystemUIServer", "com.apple.controlcenter", "com.remotemac.receiver"] {
            #expect(!NativeInput.canForceQuit(processID: 42, bundleIdentifier: bundle, regular: true, ownProcessID: 10))
        }
    }

    @Test(arguments: ["left", "right", "up", "down"])
    func controlArrowPreservesNativeKeyClassification(_ key: String) throws {
        var events: [CGEvent] = []
        let input = NativeInput(postEvent: { events.append($0) })

        input.post(.key(key, down: true, modifiers: ["control"], repeating: false))
        input.post(.key(key, down: false, modifiers: ["control"], repeating: false))

        #expect(events.count == 2)
        for event in events {
            #expect(event.flags.contains(.maskControl))
            #expect(event.flags.contains(.maskNumericPad))
            #expect(event.flags.contains(.maskSecondaryFn))
        }
        #expect(try #require(events.first).type == .keyDown)
        #expect(try #require(events.last).type == .keyUp)
    }

    @Test func arrowClassificationDoesNotChangeRequestedModifiersOrOrdinaryKeys() throws {
        var events: [CGEvent] = []
        let input = NativeInput(postEvent: { events.append($0) })

        input.post(.key("up", down: true, modifiers: ["control"], repeating: false))
        input.post(.key("up", down: false, modifiers: [], repeating: false))
        input.post(.key("a", down: true, modifiers: ["command"], repeating: false))

        #expect(events.count == 3)
        let releasedArrow = try #require(events.dropFirst().first)
        #expect(releasedArrow.type == .keyUp)
        #expect(!releasedArrow.flags.contains(.maskControl))
        #expect(releasedArrow.flags.contains(.maskNumericPad))
        #expect(releasedArrow.flags.contains(.maskSecondaryFn))
        let letter = try #require(events.last)
        #expect(letter.flags.contains(.maskCommand))
        #expect(!letter.flags.contains(.maskControl))
        #expect(!letter.flags.contains(.maskNumericPad))
        #expect(!letter.flags.contains(.maskSecondaryFn))
    }
}

private final class RecordedEvents {
    private let lock = NSLock()
    private var values: [CGEvent] = []
    var events: [CGEvent] { lock.lock(); defer { lock.unlock() }; return values }
    func append(_ event: CGEvent) { lock.lock(); defer { lock.unlock() }; values.append(event) }
}

private func fakeAwakeDisplay() -> DisplayWake {
    DisplayWake(state: { .awake }, acquire: { Issue.record("An awake display should not need waking"); return false }, release: {})
}
