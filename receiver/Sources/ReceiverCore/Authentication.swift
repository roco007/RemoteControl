import Foundation
import CryptoKit
import Security

public struct TrustedDevice: Codable, Equatable {
    public let id: String
    public var name: String
    public let tokenHash: String
    public let pairedAt: Date
}

public protocol TrustStore: AnyObject {
    func load() throws -> [TrustedDevice]
    func save(_ devices: [TrustedDevice]) throws
}

public final class MemoryTrustStore: TrustStore {
    private var devices: [TrustedDevice] = []
    public init() {}
    public func load() -> [TrustedDevice] { devices }
    public func save(_ devices: [TrustedDevice]) { self.devices = devices }
}

public final class KeychainTrustStore: TrustStore {
    private let service: String
    public init(service: String = "com.remotemac.receiver.trusted-devices") { self.service = service }
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "trusted-devices-v1"]
    }
    public func load() throws -> [TrustedDevice] {
        var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let data = result as? Data else { throw KeychainError(status: status) }
        return try JSONDecoder().decode([TrustedDevice].self, from: data)
    }
    public func save(_ devices: [TrustedDevice]) throws {
        let data = try JSONEncoder().encode(devices)
        let attributes: [String: Any] = [kSecValueData as String: data]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var q = query; q[kSecValueData as String] = data
            q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(q as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }
    public struct KeychainError: LocalizedError {
        let status: OSStatus
        public var errorDescription: String? { "Keychain error \(status). Unlock your login keychain and retry pairing." }
    }
}

public struct AuthenticationResult {
    public let accepted: Bool
    public let token: String?
    public let error: String?
}

public final class PairingManager {
    public private(set) var devices: [TrustedDevice]
    public private(set) var code = ""
    public private(set) var codeExpiresAt = Date.distantPast
    public private(set) var lockedUntil = Date.distantPast
    private var failures: [Date] = []
    private let store: TrustStore
    private let now: () -> Date
    private let random: (Int) throws -> Data
    public static let codeLifetime: TimeInterval = 120

    public init(store: TrustStore, now: @escaping () -> Date = Date.init, random: @escaping (Int) throws -> Data = PairingManager.randomBytes) throws {
        self.store = store; self.now = now; self.random = random
        devices = try store.load()
        try rotateCode()
    }

    public func rotateCode() throws {
        // Rejection sampling avoids modulo bias in the six-digit pairing code.
        var value: UInt32 = .max
        while value >= 4_294_000_000 {
            let bytes = try random(4)
            guard bytes.count == 4 else { throw RandomError.unavailable }
            value = bytes.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        }
        code = String(format: "%06u", value % 1_000_000)
        codeExpiresAt = now().addingTimeInterval(Self.codeLifetime)
    }

    public func refreshCodeIfNeeded() throws { if now() >= codeExpiresAt { try rotateCode() } }

    public func authenticate(deviceID: String, name: String, code suppliedCode: String?, token: String?) -> AuthenticationResult {
        let time = now()
        if let token, let device = devices.first(where: { $0.id == deviceID }), Self.constantTimeEqual(device.tokenHash, Self.hash(token)) {
            return AuthenticationResult(accepted: true, token: nil, error: nil)
        }
        if time < lockedUntil { return rejected("Too many attempts. Try again in a minute.") }
        if token == nil, let suppliedCode, time < codeExpiresAt, Self.constantTimeEqual(code, suppliedCode) {
            do {
                let newToken = try random(32).map { String(format: "%02x", $0) }.joined()
                guard newToken.count == 64 else { throw RandomError.unavailable }
                var updated = devices.filter { $0.id != deviceID }
                guard updated.count < 32 else { return rejected("Trusted-device limit reached. Revoke an old device on the Mac.") }
                updated.append(TrustedDevice(id: deviceID, name: name, tokenHash: Self.hash(newToken), pairedAt: time))
                // Rotate before persisting: an entropy failure must never save an unusable pairing.
                try rotateCode()
                try store.save(updated); devices = updated; failures.removeAll()
                return AuthenticationResult(accepted: true, token: newToken, error: nil)
            } catch { return rejected("Could not securely save this device. Check the Mac receiver.") }
        }
        failures = failures.filter { time.timeIntervalSince($0) < 60 }; failures.append(time)
        if failures.count >= 5 { lockedUntil = time.addingTimeInterval(60) }
        return rejected(token != nil ? "Device is not trusted. Pair again using the Mac's code." : "Invalid or expired pairing code.")
    }

    public func revoke(_ id: String) throws {
        let updated = devices.filter { $0.id != id }
        try store.save(updated); devices = updated
    }
    private func rejected(_ error: String) -> AuthenticationResult { AuthenticationResult(accepted: false, token: nil, error: error) }
    private static func hash(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
    private static func constantTimeEqual(_ lhs: String, _ rhs: String) -> Bool {
        let a = Array(lhs.utf8), b = Array(rhs.utf8)
        guard a.count == b.count else { return false }
        return zip(a, b).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }
    public static func randomBytes(_ count: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else { throw RandomError.unavailable }
        return Data(bytes)
    }
    enum RandomError: Error { case unavailable }
}
