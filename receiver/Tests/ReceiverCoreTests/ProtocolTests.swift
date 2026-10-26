import Foundation
import Testing
@testable import ReceiverCore

final class ProtocolTests {
    @Test func testSharedFixtures() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("shared/fixtures.json"))
        let fixtures = try unwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        for (index, value) in (fixtures["valid"] as! [Any]).enumerated() {
            let data = try JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed)
            expectNoThrow(try WireProtocol.decode(data), "Valid fixture \(index)")
        }
        for (index, value) in (fixtures["invalid"] as! [Any]).enumerated() {
            let data = try JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed)
            expectThrows(try WireProtocol.decode(data), "Invalid fixture \(index)")
        }
        for value in fixtures["malformed"] as! [String] { expectThrows(try WireProtocol.decode(Data(value.utf8))) }
    }
    @Test func testOversizedMessages() {
        expectThrows(try WireProtocol.decode(Data(repeating: 32, count: Wire.maxMessageBytes + 1))) { expectEqual($0 as? ProtocolError, .oversized) }
    }
    @Test func testEnvelopeRejectsBooleanSequence() {
        expectThrows(try WireProtocol.validate(["v":1,"seq":true,"timestamp":123,"type":"release_all"]))
    }
    @Test func testTypesStayInSyncWithManifest() { expectEqual(Set(MessageKind.allCases.map(\.rawValue)), Set(Wire.messageTypes)) }
    @Test func testPrivatePeersOnly() {
        for address: [UInt8] in [[127,0,0,1],[10,1,2,3],[172,31,2,3],[192,168,2,3],[169,254,2,3]] { expectTrue(LocalNetwork.isPrivateIPv4(address)) }
        for address: [UInt8] in [[172,32,2,3],[8,8,8,8],[0,0,0,0]] { expectFalse(LocalNetwork.isPrivateIPv4(address)) }
    }
}
