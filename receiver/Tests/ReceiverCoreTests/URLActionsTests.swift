import Foundation
import Testing
@testable import ReceiverCore

private final class URLRecordingSink: InputSink {
    var actions: [InputAction] = []
    func post(_ action: InputAction) { actions.append(action) }
}

struct URLActionsTests {
    private let device = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    private func request(_ url: String, id: String = "url-request") throws -> WireMessage {
        try WireProtocol.validate(["v": 1, "type": "system_action", "seq": 1, "timestamp": 1, "action": "open_url", "id": id, "url": url])
    }
    @Test func sharedURLFixturesAgreeWithNativeValidation() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("shared/open-url-fixtures.json"))
        let fixtures = try #require(JSONSerialization.jsonObject(with: data) as? [String: [String]])
        for url in fixtures["valid"] ?? [] {
            #expect(HTTPURL.parse(url) != nil, "Valid URL: \(url)")
            #expect(throws: Never.self) { try request(url) }
        }
        for url in fixtures["invalid"] ?? [] {
            #expect(HTTPURL.parse(url) == nil, "Invalid URL: \(url)")
            #expect(throws: ProtocolError.self) { try request(url) }
        }
    }
    @Test func duplicateURLRequestDoesNotOpenTwiceAndChangedURLIsRejected() throws {
        let sink = URLRecordingSink(), input = InputController(sink: sink)
        let url = "https://example.com/one?q=private"
        input.handle(try request(url), deviceID: device)
        input.handle(try request(url), deviceID: device)
        var rejection: SystemActionOutcome?
        input.handle(try request("https://example.com/two?q=private"), deviceID: device) { rejection = $0 }
        #expect(sink.actions == [.openURL(url)])
        #expect(rejection?.ok == false)
        #expect(input.actionStatus(device: device, id: "url-request", action: .openURL).ok)
    }
    @Test func URLLogsNeverContainPathQueryOrFragment() throws {
        let message = try request("https://example.com/private-path?token=secret-token#private-fragment")
        let line = ReceiverCommandLog.format(receivedAt: Date(), sessionID: UUID(), deviceID: device, message: message, byteCount: 180, result: "dispatched")
        for value in ["example.com", "private-path", "secret-token", "private-fragment"] { #expect(!line.contains(value)) }
        #expect(line.contains("<redacted>"))
        #expect(line.contains("urlLength"))
    }
    @Test func URLLengthLimitUsesUTF16AndNativeParserDoesNotRepairWireWhitespace() {
        let prefix = "https://example.com/"
        #expect(HTTPURL.parse(prefix + String(repeating: "a", count: 4096 - prefix.utf16.count)) != nil)
        #expect(HTTPURL.parse(prefix + String(repeating: "a", count: 4097 - prefix.utf16.count)) == nil)
        #expect(HTTPURL.parse(" https://example.com") == nil)
        #expect(HTTPURL.parse("https://example.com ") == nil)
        #expect(HTTPURL.parse("https://example.com/🎵") != nil)
    }
    @Test func sessionAdvertisesURLCapabilityAndRoutesAuthenticatedCompletion() throws {
        let sink = URLRecordingSink(), pairing = try PairingManager(store: MemoryTrustStore())
        var responses: [Data] = []
        let session = ReceiverSession(pairing: pairing, input: InputController(sink: sink), serverID: device, name: "Mac", permission: { true }, acquire: { _ in true }, relinquish: { _ in }, send: { responses.append($0) }, cancel: {}, log: { _ in })
        session.hello()
        let hello = try WireProtocol.decode(try #require(responses.last))
        #expect((hello.fields["capabilities"] as? [String])?.contains("open_url") == true)
        session.receive(WireProtocol.encode(.authentication, seq: 1, fields: ["deviceId": device, "deviceName": "Phone", "code": pairing.code]))
        session.receive(WireProtocol.encode(.systemAction, seq: 2, fields: ["action": "open_url", "url": "https://example.com", "id": "paired-url"]))
        let outcome = try WireProtocol.decode(try #require(responses.last))
        #expect(outcome.kind == .systemActionResult)
        #expect(outcome.string("id") == "paired-url")
        #expect(outcome.string("action") == "open_url")
        #expect(outcome.bool("ok"))
        #expect(sink.actions == [.openURL("https://example.com")])
    }
}
