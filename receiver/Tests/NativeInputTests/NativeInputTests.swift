import CoreGraphics
import Testing
import ReceiverCore
@testable import RemoteMacReceiver

struct NativeInputTests {
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
