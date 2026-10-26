import Foundation
import Testing
@testable import ReceiverCore

final class TestClock { var time = Date(timeIntervalSince1970: 1000) }
final class AuthenticationTests {
    @Test func testPairingPersistsHashAndAuthenticatesToken() throws {
        let store = MemoryTrustStore(), manager = try PairingManager(store: store)
        let result = manager.authenticate(deviceID: "phone", name: "Phone", code: manager.code, token: nil)
        expectTrue(result.accepted)
        let token = try unwrap(result.token); expectEqual(token.count, 64)
        expectNotEqual(store.load().first?.tokenHash, token)
        let reloaded = try PairingManager(store: store)
        expectTrue(reloaded.authenticate(deviceID: "phone", name: "Phone", code: nil, token: token).accepted)
        expectFalse(reloaded.authenticate(deviceID: "other", name: "Imposter", code: nil, token: token).accepted)
    }
    @Test func testWrongCodeAndExpiredCodeAreRejected() throws {
        let clock = TestClock(); let manager = try PairingManager(store: MemoryTrustStore(), now: { clock.time })
        let code = manager.code
        expectFalse(manager.authenticate(deviceID: "phone", name: "Phone", code: "wrong", token: nil).accepted)
        clock.time.addTimeInterval(PairingManager.codeLifetime + 1)
        expectFalse(manager.authenticate(deviceID: "phone", name: "Phone", code: code, token: nil).accepted)
        try manager.refreshCodeIfNeeded(); expectGreaterThan(manager.codeExpiresAt, clock.time)
    }
    @Test func testRateLimitIsGlobalAcrossDevicesAndConnections() throws {
        let clock = TestClock(); let manager = try PairingManager(store: MemoryTrustStore(), now: { clock.time })
        for index in 0..<5 { expectFalse(manager.authenticate(deviceID: "\(index)", name: "Phone", code: "wrong", token: nil).accepted) }
        expectFalse(manager.authenticate(deviceID: "phone", name: "Phone", code: manager.code, token: nil).accepted)
        clock.time.addTimeInterval(61)
        expectTrue(manager.authenticate(deviceID: "phone", name: "Phone", code: manager.code, token: nil).accepted)
    }
    @Test func testRevocationRejectsPreviouslyValidToken() throws {
        let manager = try PairingManager(store: MemoryTrustStore())
        let token = try unwrap(manager.authenticate(deviceID: "phone", name: "Phone", code: manager.code, token: nil).token)
        try manager.revoke("phone")
        expectFalse(manager.authenticate(deviceID: "phone", name: "Phone", code: nil, token: token).accepted)
        expectTrue(manager.devices.isEmpty)
    }
    @Test func testSecureStorageFailureNeverAuthenticates() throws {
        final class FailingStore: TrustStore {
            func load() -> [TrustedDevice] { [] }
            func save(_ devices: [TrustedDevice]) throws { throw NSError(domain: "Test", code: 1) }
        }
        let manager = try PairingManager(store: FailingStore())
        expectFalse(manager.authenticate(deviceID: "phone", name: "Phone", code: manager.code, token: nil).accepted)
        expectTrue(manager.devices.isEmpty)
    }
}
