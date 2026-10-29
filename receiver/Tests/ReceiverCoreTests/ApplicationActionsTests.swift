import Foundation
import Testing
@testable import ReceiverCore

private final class CatalogSink: InputSink {
    var requests = 0
    var actions: [InputAction] = []
    var apps = (0..<12).map { InstalledApplication(id: "/Applications/App\($0).app", name: "App \($0)", icon: "data:image/png;base64," + String(repeating: "A", count: 8000)) }
    func post(_ action: InputAction) { actions.append(action) }
    func listApplications(refresh: Bool, completion: @escaping ([InstalledApplication], String?) -> Void) { requests += 1; completion(apps, nil) }
}

struct ApplicationActionsTests {
    private let device = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    @Test func catalogsRequirePairingAndPagesStayWithinFrameBound() throws {
        let sink = CatalogSink(), pairing = try PairingManager(store: MemoryTrustStore())
        var data: [Data] = []
        func session() -> ReceiverSession {
            ReceiverSession(pairing: pairing, input: InputController(sink: sink), serverID: device, name: "Mac", permission: { false }, acquire: { _ in true }, relinquish: { _ in }, send: { data.append($0) }, cancel: {}, log: { _ in })
        }
        let unpaired = session()
        unpaired.receive(WireProtocol.encode(.appsList, seq: 1, fields: ["id": "bad"]))
        #expect(sink.requests == 0)
        #expect(unpaired.closed)
        let paired = session()
        paired.receive(WireProtocol.encode(.authentication, seq: 1, fields: ["deviceId": device, "deviceName": "Phone", "code": pairing.code]))
        var cursor = 0, sequence: Int64 = 2, received: [String] = []
        repeat {
            paired.receive(WireProtocol.encode(.appsList, seq: sequence, fields: ["id": "page", "cursor": cursor]))
            let page = try #require(data.last)
            #expect(page.count <= Wire.maxMessageBytes)
            let result = try WireProtocol.decode(page)
            #expect(result.kind == .appsListResult)
            let apps = try #require(result.fields["apps"] as? [[String: Any]])
            received += apps.compactMap { $0["id"] as? String }
            guard let next = result.fields["nextCursor"] as? Int else { break }
            #expect(next > cursor); cursor = next; sequence += 1
        } while sequence < 30
        #expect(received == sink.apps.map(\.id))
    }
    @Test func parameterizedActionsCannotReuseAnIdWithDifferentCommand() throws {
        let sink = CatalogSink(), input = InputController(sink: sink)
        func request(_ command: String) throws -> WireMessage {
            try WireProtocol.validate(["v": 1, "type": "system_action", "seq": 1, "timestamp": 1, "action": "run_command", "id": "same", "command": command])
        }
        input.handle(try request("printf one"), deviceID: device)
        input.handle(try request("printf one"), deviceID: device)
        var result: SystemActionOutcome?
        input.handle(try request("printf two"), deviceID: device) { result = $0 }
        #expect(sink.actions == [.runCommand("printf one")])
        #expect(result?.ok == false)
        #expect(input.actionStatus(device: device, id: "same", action: .runCommand).ok)
    }
    @Test func unicodeAndEscapedCatalogValuesRemainValidAndBounded() throws {
        let sink = CatalogSink(), pairing = try PairingManager(store: MemoryTrustStore())
        let icon = "data:image/png;base64," + String(repeating: "A", count: 8000)
        sink.apps = [
            InstalledApplication(id: "/" + String(repeating: "\u{1}", count: 2040) + ".app", name: String(repeating: "\u{2}", count: 160), icon: icon),
            InstalledApplication(id: "/" + String(repeating: "🧮", count: 1000) + ".app", name: String(repeating: "計", count: 160), icon: icon),
            InstalledApplication(id: "/Other.app", name: "Other", icon: "https://example.com/icon.png"),
            InstalledApplication(id: "", name: "Invalid"),
            InstalledApplication(id: "/Invalid.app", name: String(repeating: "x", count: 161)),
        ]
        var responses: [Data] = []
        let session = ReceiverSession(pairing: pairing, input: InputController(sink: sink), serverID: device, name: "Mac", permission: { true }, acquire: { _ in true }, relinquish: { _ in }, send: { responses.append($0) }, cancel: {}, log: { _ in })
        session.receive(WireProtocol.encode(.authentication, seq: 1, fields: ["deviceId": device, "deviceName": "Phone", "code": pairing.code]))
        var cursor = 0, sequence: Int64 = 2, returned: [[String: Any]] = []
        repeat {
            session.receive(WireProtocol.encode(.appsList, seq: sequence, fields: ["id": String(repeating: "\u{3}", count: 64), "cursor": cursor]))
            let data = try #require(responses.last)
            #expect(data.count <= Wire.maxMessageBytes)
            let page = try WireProtocol.decode(data)
            #expect(page.kind == .appsListResult)
            returned += try #require(page.fields["apps"] as? [[String: Any]])
            guard let next = page.fields["nextCursor"] as? Int else { break }
            #expect(next > cursor); cursor = next; sequence += 1
        } while sequence < 10
        #expect(returned.compactMap { $0["id"] as? String } == Array(sink.apps.prefix(3)).map(\.id))
        #expect(returned.first?["icon"] == nil)
        #expect(returned.last?["icon"] == nil)
        session.receive(WireProtocol.encode(.appsList, seq: sequence + 1, fields: ["id": "bad-cursor", "cursor": 9_007_199_254_740_991]))
        let invalidCursor = try WireProtocol.decode(try #require(responses.last))
        #expect(invalidCursor.fields["error"] != nil)
    }
    @Test func pendingRequestRejectsChangedParametersAndKeepsOriginalStatus() {
        let gate = SystemActionGate()
        var finish: ((Bool, String?) -> Void)?, starts = 0
        gate.perform(device: device, id: "command", action: .runCommand, fingerprint: "original", start: { starts += 1; finish = $0 }, completion: { _ in })
        gate.perform(device: device, id: "command", action: .runCommand, fingerprint: "changed", start: { _ in starts += 1 }, completion: { #expect(!$0.ok); #expect($0.state == nil) })
        #expect(starts == 1)
        #expect(gate.status(device: device, id: "command", action: .runCommand).state == "running")
        finish?(true, nil)
        #expect(gate.status(device: device, id: "command", action: .runCommand).ok)
    }
    @Test func commandLogRedactsCommandContents() throws {
        let message = try WireProtocol.validate(["v": 1, "type": "system_action", "seq": 1, "timestamp": 1, "action": "run_command", "id": "secret", "command": "export SECRET=private-value"])
        let line = ReceiverCommandLog.format(receivedAt: Date(), sessionID: UUID(), deviceID: device, message: message, byteCount: 100, result: "dispatched")
        #expect(!line.contains("private-value"))
        #expect(line.contains("<redacted>"))
    }
}
