import Foundation
import Testing
@testable import ReceiverCore

final class SessionHarness {
    let sink = RecordingSink()
    let clock = TestClock()
    let pairing: PairingManager
    var permission = true
    var owner: UUID?
    var responses: [WireMessage] = []
    var commandLogs: [String] = []
    var cancelled = false
    var session: ReceiverSession!
    init() throws {
        pairing = try PairingManager(store: MemoryTrustStore())
        session = ReceiverSession(pairing: pairing, input: InputController(sink: sink), serverID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", name: "Test Mac", permission: { [unowned self] in self.permission }, acquire: { [unowned self] id in
            guard self.owner == nil || self.owner == id else { return false }; self.owner = id; return true
        }, relinquish: { [unowned self] id in if self.owner == id { self.owner = nil } }, send: { [unowned self] data in self.responses.append(try! WireProtocol.decode(data)) }, cancel: { [unowned self] in self.cancelled = true }, now: { [unowned self] in self.clock.time }, log: { [unowned self] in self.commandLogs.append($0) })
    }
    func receive(_ kind: MessageKind, seq: Int64, _ fields: [String: Any] = [:]) { session.receive(WireProtocol.encode(kind, seq: seq, fields: fields)) }
    func pair() { receive(.authentication, seq: 1,["deviceId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","deviceName":"Phone","code":pairing.code]) }
}
final class SessionTests {
    @Test(arguments: ["volume", "brightness"])
    func testSystemAdjustmentsRequireAuthenticatedPermittedSession(_ control: String) throws {
        let data = try JSONSerialization.data(withJSONObject: ["v": 1, "type": "system_adjust", "seq": 2, "timestamp": 1, "control": control, "steps": -2])
        let unknown = try SessionHarness(); unknown.session.receive(data)
        expectTrue(unknown.sink.actions.isEmpty)
        expectEqual(unknown.responses.last?.string("code"), "authentication_required")

        let denied = try SessionHarness(); denied.permission = false; denied.pair(); denied.session.receive(data)
        expectTrue(denied.sink.actions.isEmpty)
        expectEqual(denied.responses.last?.string("state"), "permission_required")

        let ready = try SessionHarness(); ready.pair(); ready.session.receive(data)
        let expected: [InputAction] = [.systemAdjust(try unwrap(SystemControl(rawValue: control)), steps: -2)]
        expectEqual(ready.sink.actions, expected)
        ready.session.receive(data)
        expectEqual(ready.sink.actions, expected)
        expectEqual(ready.responses.last?.string("code"), "replayed_message")
    }
    @Test func testReceiverAdvertisesSystemAdjustments() throws {
        let h = try SessionHarness(); h.session.hello()
        expectTrue((h.responses.first?.fields["capabilities"] as? [String] ?? []).contains("system_adjust"))
    }
    @Test(arguments: ["screenshot", "kill_app", "lock", "photo_booth"])
    func testSystemActionsRequireAuthenticatedPermittedSession(_ action: String) throws {
        let unknown = try SessionHarness()
        unknown.receive(.systemAction, seq: 1, ["action": action])
        expectTrue(unknown.sink.actions.isEmpty)
        expectEqual(unknown.responses.last?.string("code"), "authentication_required")

        let denied = try SessionHarness(); denied.permission = false; denied.pair()
        denied.receive(.systemAction, seq: 2, ["action": action])
        expectTrue(denied.sink.actions.isEmpty)
        expectEqual(denied.responses.last?.string("state"), "permission_required")

        let ready = try SessionHarness(); ready.pair()
        ready.receive(.systemAction, seq: 2, ["action": action])
        expectEqual(ready.sink.actions, [.system(try unwrap(SystemAction(rawValue: action)))])
        ready.receive(.systemAction, seq: 2, ["action": action])
        expectEqual(ready.sink.actions, [.system(try unwrap(SystemAction(rawValue: action)))])
        expectEqual(ready.responses.last?.string("code"), "replayed_message")
    }
    @Test func testReceiverAdvertisesSystemActions() throws {
        let h = try SessionHarness(); h.session.hello()
        let capabilities = h.responses.first?.fields["capabilities"] as? [String] ?? []
        expectTrue(capabilities.contains("system_actions"))
        expectTrue(capabilities.contains("photo_booth"))
    }

    @Test func testUnsupportedGestureReportsErrorWithoutClosingConnection() throws {
        let h = try SessionHarness(); h.pair()
        h.receive(.mouseGesture, seq: 2, ["gesture": "swipe", "fingers": 2, "direction": "up"])
        expectEqual(h.responses.last?.string("code"), "unsupported_gesture")
        expectTrue(h.sink.actions.isEmpty); expectFalse(h.cancelled)
        h.receive(.mouseMove, seq: 3, ["dx": 1, "dy": 0])
        expectEqual(h.sink.actions.last, .move(1, 0, dragging: nil))
    }
    @Test func testHelloAndPingWorkWithoutPostingInput() throws {
        let h = try SessionHarness(); h.session.hello(); h.receive(.ping,seq:1,["id":"probe"])
        expectEqual(h.responses.map(\.kind), [.connection,.pong]); expectTrue(h.sink.actions.isEmpty)
    }
    @Test func testUnknownClientsCannotControlMac() throws {
        let h = try SessionHarness(); h.receive(.mouseMove,seq:1,["dx":2,"dy":2])
        expectTrue(h.sink.actions.isEmpty); expectTrue(h.cancelled)
        expectEqual(h.responses.last?.string("code"), "authentication_required")
    }
    @Test func testPairAndDisconnectReleaseHeldInput() throws {
        let h = try SessionHarness(); h.pair(); expectTrue(h.session.authenticated)
        h.receive(.mouseDown,seq:2,["button":"left"])
        h.receive(.keyboardDown,seq:3,["key":"shift","modifiers":["shift"],"repeat":false])
        h.session.disconnect()
        expectEqual(Array(h.sink.actions.suffix(2)), [.button("left",down:false,clickCount:1), .key("shift",down:false,modifiers:[],repeating:false)])
        expectNil(h.owner)
    }
    @Test func testPermissionDenialReportsStateAndNoInput() throws {
        let h = try SessionHarness(); h.permission = false; h.pair(); h.receive(.mouseMove,seq:2,["dx":5,"dy":5])
        expectTrue(h.sink.actions.isEmpty); expectEqual(h.responses.last?.string("state"), "permission_required")
    }
    @Test func testPermissionLossReleasesDrag() throws {
        let h = try SessionHarness(); h.pair(); h.receive(.mouseDown,seq:2,["button":"left"])
        h.permission = false; h.session.tick()
        expectEqual(h.sink.actions.last, .button("left",down:false,clickCount:1))
        expectEqual(h.responses.last?.string("state"), "permission_required")
    }
    @Test func testReplayClosesAndReleases() throws {
        let h = try SessionHarness(); h.pair(); h.receive(.mouseDown,seq:2,["button":"left"])
        h.receive(.mouseMove,seq:2,["dx":4,"dy":4])
        expectTrue(h.cancelled); expectEqual(h.responses.last?.string("code"), "replayed_message")
        expectEqual(h.sink.actions.last, .button("left",down:false,clickCount:1))
    }
    @Test func testBusyReceiverDoesNotConsumePairingCode() throws {
        let h = try SessionHarness(); h.owner = UUID(); let code = h.pairing.code; h.pair()
        expectFalse(h.session.authenticated); expectTrue(h.pairing.devices.isEmpty); expectEqual(h.pairing.code,code)
        expectEqual(h.responses.last?.string("code"), "receiver_busy")
    }
    @Test func testHeartbeatTimeoutAndAuthenticationTimeout() throws {
        let h = try SessionHarness(); h.pair(); h.clock.time.addTimeInterval(21); h.session.tick()
        expectTrue(h.cancelled); expectEqual(h.responses.last?.string("code"), "heartbeat_timeout")
        let other = try SessionHarness(); other.clock.time.addTimeInterval(31); other.session.tick()
        expectEqual(other.responses.last?.string("code"), "authentication_timeout")
    }
    @Test func testMalformedPayloadNeverCrashes() throws {
        let h = try SessionHarness(); h.session.receive(Data("{bad".utf8))
        expectTrue(h.cancelled); expectEqual(h.responses.last?.string("code"), "malformed_message")
    }
}
