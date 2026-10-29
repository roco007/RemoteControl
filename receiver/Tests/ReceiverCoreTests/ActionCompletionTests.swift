import Foundation
import Testing
@testable import ReceiverCore

private final class DeferredActionSink: InputSink {
    var actions: [InputAction] = []
    var pending: [(Bool, String?) -> Void] = []
    func post(_ action: InputAction) { actions.append(action) }
    func performSystemAction(_ action: SystemAction, completion: @escaping (Bool, String?) -> Void) {
        actions.append(.system(action)); pending.append(completion)
    }
}

struct ActionCompletionTests {
    private let device = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    @Test func statusAndDuplicateIdsRecoverWithoutExecutingAgain() {
        let gate = SystemActionGate(); var starts = 0; var finish: ((Bool, String?) -> Void)?
        gate.perform(device: device, id: "same", action: .lock, start: { starts += 1; finish = $0 }, completion: { _ in })
        #expect(gate.status(device: device, id: "same", action: .lock).state == "running")
        #expect(gate.status(device: "another", id: "same", action: .lock).state == "unknown")
        gate.perform(device: device, id: "same", action: .lock, start: { _ in starts += 1 }, completion: { #expect($0.state == "running") })
        finish?(true, "Mac locked.")
        #expect(gate.status(device: device, id: "same", action: .lock).ok)
        gate.perform(device: device, id: "same", action: .lock, start: { _ in starts += 1 }, completion: { #expect($0.ok) })
        gate.perform(device: device, id: "same", action: .photoBooth, start: { _ in starts += 1 }, completion: { #expect(!$0.ok) })
        #expect(starts == 1)
        #expect(gate.status(device: device, id: "same", action: .photoBooth).state == "unknown")
    }
    @Test func completedResultsAreBoundedAndOldIdsBecomeUnknown() {
        let gate = SystemActionGate()
        for i in 0..<65 { gate.perform(device: device, id: "\(i)", action: .lock, start: { $0(true, nil) }, completion: { _ in }) }
        #expect(gate.status(device: device, id: "0", action: .lock).state == "unknown")
        #expect(gate.status(device: device, id: "64", action: .lock).ok)
    }
    @Test func permissionFailureCanBeRecoveredWithoutReplayingTheAction() throws {
        let h = try SessionHarness(); h.permission = false; h.pair()
        h.receive(.systemAction, seq: 2, ["id": "denied", "action": "lock"])
        #expect(h.responses.last?.kind == .systemActionResult)
        #expect(h.responses.last?.bool("ok") == false)
        h.receive(.systemActionStatus, seq: 3, ["id": "denied", "action": "lock"])
        #expect(h.responses.last?.fields["state"] == nil)
        #expect(h.responses.last?.bool("ok") == false)
        #expect(h.sink.actions.isEmpty)
    }
    @Test func queuedCompletionChecksSessionLifetimeOnListenerQueue() throws {
        let sink = DeferredActionSink(), pairing = try PairingManager(store: MemoryTrustStore())
        var delivery: [() -> Void] = [], responses: [WireMessage] = []
        let coordinator = ReceiverSessionCoordinator(pairing: pairing, sink: sink, serverID: device, name: "Test Mac", permission: { true }, log: { _ in }, executeCompletion: { delivery.append($0) })
        let session = try #require(coordinator.makeSession(transport: .wifi, send: { responses.append(try! WireProtocol.decode($0)) }, cancel: {}))
        session.receive(WireProtocol.encode(.authentication, seq: 1, fields: ["deviceId": device, "deviceName": "Phone", "code": pairing.code]))
        session.receive(WireProtocol.encode(.systemAction, seq: 2, fields: ["action": "lock", "id": "queued"]))
        let finish = try #require(sink.pending.first)
        finish(true, nil)
        #expect(delivery.count == 1)
        #expect(responses.allSatisfy { $0.kind != .systemActionResult })
        session.disconnect(); delivery.removeFirst()()
        #expect(responses.allSatisfy { $0.kind != .systemActionResult })
    }
    @Test func idlessActionsAlsoRemainSingleInFlight() throws {
        let sink = DeferredActionSink(), input = InputController(sink: sink)
        let action = try WireProtocol.validate(["v": 1, "type": "system_action", "seq": 1, "timestamp": 1, "action": "lock"])
        input.handle(action); input.handle(action)
        #expect(sink.actions == [.system(.lock)])
        let completion = try #require(sink.pending.first)
        completion(true, "Mac locked.")
        input.handle(action)
        #expect(sink.actions == [.system(.lock), .system(.lock)])
    }
    @Test func completionIsCorrelatedAndBusyRejectionDoesNotQueue() throws {
        let sink = DeferredActionSink(), pairing = try PairingManager(store: MemoryTrustStore())
        let coordinator = ReceiverSessionCoordinator(pairing: pairing, sink: sink, serverID: device, name: "Test Mac", permission: { true }, log: { _ in })
        var responses: [WireMessage] = []
        let session = try #require(coordinator.makeSession(transport: .wifi, send: { responses.append(try! WireProtocol.decode($0)) }, cancel: {}))
        session.receive(WireProtocol.encode(.authentication, seq: 1, fields: ["deviceId": device, "deviceName": "Phone", "code": pairing.code]))
        session.receive(WireProtocol.encode(.systemAction, seq: 2, fields: ["action": "photo_booth", "id": "first"]))
        #expect(!session.closed)
        #expect(responses.filter { $0.kind.rawValue == "system_action_result" }.isEmpty)
        session.receive(WireProtocol.encode(.systemAction, seq: 3, fields: ["action": "lock", "id": "second"]))
        #expect(sink.actions == [.system(.photoBooth)])
        #expect(responses.last?.string("id") == "second")
        #expect(responses.last?.bool("ok") == false)
        let finish = try #require(sink.pending.first)
        finish(false, "Photo Booth could not open.")
        #expect(responses.last?.string("id") == "first")
        #expect(responses.last?.string("action") == "photo_booth")
        #expect(responses.last?.bool("ok") == false)
        let count = responses.count; finish(true, nil)
        #expect(responses.count == count)
    }
    @Test func reconnectCannotBypassBusyAndLateCompletionDoesNotReachOldSession() throws {
        let sink = DeferredActionSink(), pairing = try PairingManager(store: MemoryTrustStore())
        let coordinator = ReceiverSessionCoordinator(pairing: pairing, sink: sink, serverID: device, name: "Test Mac", permission: { true }, log: { _ in })
        var old: [WireMessage] = [], fresh: [WireMessage] = []
        let first = try #require(coordinator.makeSession(transport: .wifi, send: { old.append(try! WireProtocol.decode($0)) }, cancel: {}))
        first.receive(WireProtocol.encode(.authentication, seq: 1, fields: ["deviceId": device, "deviceName": "Phone", "code": pairing.code]))
        let token = try #require(old.first { $0.kind == .authenticationResult }?.fields["token"] as? String)
        first.receive(WireProtocol.encode(.systemAction, seq: 2, fields: ["action": "lock", "id": "old"]))
        first.disconnect(); let oldCount = old.count
        let second = try #require(coordinator.makeSession(transport: .bluetooth, send: { fresh.append(try! WireProtocol.decode($0)) }, cancel: {}))
        second.receive(WireProtocol.encode(.authentication, seq: 1, fields: ["deviceId": device, "deviceName": "Phone", "token": token]))
        second.receive(WireProtocol.encode(.systemAction, seq: 2, fields: ["action": "photo_booth", "id": "busy"]))
        #expect(sink.actions == [.system(.lock)])
        #expect(fresh.last?.string("id") == "busy")
        let finish = try #require(sink.pending.first); finish(true, nil)
        #expect(old.count == oldCount)
        second.receive(WireProtocol.encode(.systemAction, seq: 3, fields: ["action": "photo_booth", "id": "new"]))
        #expect(sink.actions == [.system(.lock), .system(.photoBooth)])
    }
}
