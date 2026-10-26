import Foundation
import Testing
@testable import ReceiverCore

final class RecordingSink: InputSink { var actions: [InputAction] = []; func post(_ action: InputAction) { actions.append(action) } }
func message(_ kind: MessageKind, _ fields: [String: Any] = [:], seq: Int64 = 1) throws -> WireMessage {
    try WireProtocol.decode(WireProtocol.encode(kind, seq: seq, fields: fields))
}
final class InputTests {
    @Test func testCapsLockReconcilesPhysicalChangesAndPreservesRemoteToggle() {
        var state = CapsLockState(initial: false, physical: false)
        expectTrue(state.resolve(physical: false, remoteToggle: true))
        expectTrue(state.resolve(physical: false, remoteToggle: false))
        expectTrue(state.resolve(physical: true, remoteToggle: false))
        expectFalse(state.resolve(physical: false, remoteToggle: false))
        expectTrue(state.resolve(physical: false, remoteToggle: true))
        expectFalse(state.resolve(physical: false, remoteToggle: true))
    }
    @Test func testDragAndRelease() throws {
        let sink = RecordingSink(); let input = InputController(sink: sink)
        input.handle(try message(.mouseDown, ["button":"left"]))
        input.handle(try message(.mouseMove, ["dx":12,"dy":-3]))
        input.handle(try message(.mouseUp, ["button":"left"]))
        expectEqual(sink.actions, [.button("left", down: true, clickCount: 1), .move(12,-3,dragging:"left"), .button("left", down: false, clickCount: 1)])
        expectTrue(input.heldButtons.isEmpty)
    }
    @Test func testDoubleClickUsesNativeClickCount() throws {
        let sink = RecordingSink(); let controller = InputController(sink: sink)
        controller.handle(try message(.mouseClick,["button":"left","count":2]))
        expectEqual(sink.actions, [.button("left",down:true,clickCount:1),.button("left",down:false,clickCount:1),.button("left",down:true,clickCount:2),.button("left",down:false,clickCount:2)])
    }
    @Test func testShortcutRepeatAndReleaseLifecycle() throws {
        let sink = RecordingSink(); let input = InputController(sink: sink)
        input.handle(try message(.keyboardDown,["key":"command","modifiers":["command"],"repeat":false]))
        input.handle(try message(.keyboardDown,["key":"c","modifiers":["command"],"repeat":false]))
        input.handle(try message(.keyboardDown,["key":"c","modifiers":["command"],"repeat":false]))
        input.handle(try message(.keyboardDown,["key":"c","modifiers":["command"],"repeat":true]))
        expectEqual(sink.actions.count, 3)
        expectEqual(sink.actions.last, .key("c",down:true,modifiers:["command"],repeating:true))
        input.releaseAll()
        expectEqual(Array(sink.actions.suffix(2)), [.key("c",down:false,modifiers:[],repeating:false),.key("command",down:false,modifiers:[],repeating:false)])
        expectTrue(input.heldKeys.isEmpty)
    }
    @Test func testScrollUnicodeAndRightClick() throws {
        let sink = RecordingSink(); let input = InputController(sink: sink)
        input.handle(try message(.mouseScroll,["dx":-9.5,"dy":17]))
        input.handle(try message(.keyboardText,["text":"नमस्ते 👋"]))
        input.handle(try message(.mouseClick,["button":"right","count":1]))
        expectEqual(sink.actions[0], .scroll(-9.5,17)); expectEqual(sink.actions[1], .text("नमस्ते 👋"))
        expectEqual(sink.actions[2], .button("right",down:true,clickCount:1))
    }
    @Test func testGestureMappingUsesRealKeyboardActions() throws {
        let sink = RecordingSink(); let input = InputController(sink: sink)
        input.handle(try message(.mouseGesture,["gesture":"zoom","amount":1]))
        input.handle(try message(.mouseGesture,["gesture":"swipe","direction":"up","fingers":3]))
        input.handle(try message(.mouseGesture,["gesture":"swipe","direction":"left","fingers":2]))
        expectEqual(sink.actions.count, 6)
        expectEqual(sink.actions[0], .key("equal",down:true,modifiers:["command"],repeating:false))
        expectEqual(sink.actions[2], .key("up",down:true,modifiers:["control"],repeating:false))
        expectEqual(sink.actions[4], .key("bracket_left",down:true,modifiers:["command"],repeating:false))
    }
}
