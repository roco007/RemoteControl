import Foundation
import Testing
@testable import ReceiverCore

final class SessionCoordinatorTests {
    private let deviceID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    private func makeCoordinator(_ sink: RecordingSink, pairing: PairingManager) -> ReceiverSessionCoordinator {
        ReceiverSessionCoordinator(pairing: pairing, sink: sink, serverID: deviceID,
                                   name: "Test Mac", permission: { true }, log: { _ in })
    }

    @Test func testWiFiAndBluetoothShareControllerOwnershipAndTrust() throws {
        let sink = RecordingSink(), pairing = try PairingManager(store: MemoryTrustStore())
        let coordinator = makeCoordinator(sink, pairing: pairing)
        var wifiResponses: [WireMessage] = [], bluetoothResponses: [WireMessage] = []
        let wifi = try unwrap(coordinator.makeSession(transport: .wifi, send: { wifiResponses.append(try! WireProtocol.decode($0)) }, cancel: {}))
        let bluetooth = try unwrap(coordinator.makeSession(transport: .bluetooth, send: { bluetoothResponses.append(try! WireProtocol.decode($0)) }, cancel: {}))
        wifi.receive(WireProtocol.encode(.authentication, seq: 1, fields: ["deviceId": deviceID, "deviceName": "Phone", "code": pairing.code]))
        let token = try unwrap(wifiResponses.first { $0.kind == .authenticationResult }?.fields["token"] as? String)
        bluetooth.receive(WireProtocol.encode(.authentication, seq: 1, fields: ["deviceId": deviceID, "deviceName": "Phone", "token": token]))
        expectEqual(bluetoothResponses.last?.string("code"), "receiver_busy")
        expectTrue(bluetooth.closed); expectEqual(coordinator.activeTransport, .wifi)
        wifi.receive(WireProtocol.encode(.mouseDown, seq: 2, fields: ["button": "left"]))
        wifi.disconnect()
        expectEqual(sink.actions.last, .button("left", down: false, clickCount: 1))
        let resumed = try unwrap(coordinator.makeSession(transport: .bluetooth, send: { _ in }, cancel: {}))
        resumed.receive(WireProtocol.encode(.authentication, seq: 1, fields: ["deviceId": deviceID, "deviceName": "Phone", "token": token]))
        expectTrue(resumed.authenticated); expectEqual(coordinator.activeTransport, .bluetooth)
        resumed.receive(WireProtocol.encode(.mouseMove, seq: 2, fields: ["dx": 3, "dy": 4]))
        expectEqual(sink.actions.last, .move(3, 4, dragging: nil))
    }

    @Test func testBluetoothRejectsUnauthenticatedInputThroughSharedSession() throws {
        let sink = RecordingSink(), pairing = try PairingManager(store: MemoryTrustStore())
        let coordinator = makeCoordinator(sink, pairing: pairing)
        let bluetooth = try unwrap(coordinator.makeSession(transport: .bluetooth, send: { _ in }, cancel: {}))
        bluetooth.receive(WireProtocol.encode(.mouseMove, seq: 1, fields: ["dx": 1, "dy": 1]))
        expectTrue(bluetooth.closed); expectTrue(sink.actions.isEmpty); expectEqual(coordinator.count, 0)
    }

    @Test func testConnectionLimitAndRevocationApplyAcrossTransports() throws {
        let sink = RecordingSink(), pairing = try PairingManager(store: MemoryTrustStore())
        let coordinator = makeCoordinator(sink, pairing: pairing)
        let bluetooth = try unwrap(coordinator.makeSession(transport: .bluetooth, send: { _ in }, cancel: {}))
        bluetooth.receive(WireProtocol.encode(.authentication, seq: 1, fields: ["deviceId": deviceID, "deviceName": "Phone", "code": pairing.code]))
        for _ in 0..<7 { expectTrue(coordinator.makeSession(transport: .wifi, send: { _ in }, cancel: {}) != nil) }
        expectNil(coordinator.makeSession(transport: .bluetooth, send: { _ in }, cancel: {}))
        try coordinator.revoke(deviceID)
        expectTrue(bluetooth.closed); expectTrue(pairing.devices.isEmpty)
        coordinator.disconnectAll(); expectEqual(coordinator.count, 0)
    }
}
