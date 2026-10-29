import Foundation
import Security
import LocalAuthentication

/// The Mac's login password stays in the receiver process and this user's Keychain.
final class MacUnlockCredentialStore {
    enum Configuration: Equatable {
        case environment
        case keychain
        case notConfigured
    }

    enum CredentialError: LocalizedError {
        case emptyPassword
        case invalidPasswordData
        case keychain(OSStatus)

        var errorDescription: String? {
            switch self {
            case .emptyPassword:
                return "Enter this Mac's login password before saving."
            case .invalidPasswordData:
                return "The saved unlock password could not be read. Save it again on this Mac."
            case .keychain(let status):
                return "Unlock password unavailable (Keychain error \(status)). Unlock this Mac manually, then save the password again."
            }
        }
    }

    private let environment: [String: String]
    private let service: String

    var hasEnvironmentOverride: Bool { environment["MAC_UNLOCK_TEXT"] != nil }

    init(environment: [String: String] = ProcessInfo.processInfo.environment,
         service: String = "com.remotemac.receiver.mac-unlock") {
        self.environment = environment
        self.service = service
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: "mac-login-password-v1",
         kSecAttrSynchronizable as String: false]
    }

    func password() throws -> String? {
        // An explicitly empty override disables unlocking rather than falling back.
        if let override = environment["MAC_UNLOCK_TEXT"] {
            return override.isEmpty ? nil : override
        }
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        // A locked-screen gesture must never wait for an invisible Keychain prompt.
        request[kSecUseAuthenticationContext as String] = noninteractiveContext()
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw CredentialError.keychain(status) }
        guard let data = result as? Data,
              let password = String(data: data, encoding: .utf8), !password.isEmpty else {
            throw CredentialError.invalidPasswordData
        }
        return password
    }

    /// Reports setup without fetching or exposing the saved password.
    func configuration() throws -> Configuration {
        if let override = environment["MAC_UNLOCK_TEXT"] {
            return override.isEmpty ? .notConfigured : .environment
        }
        var request = query
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        request[kSecUseAuthenticationContext as String] = noninteractiveContext()
        let status = SecItemCopyMatching(request as CFDictionary, nil)
        if status == errSecItemNotFound { return .notConfigured }
        guard status == errSecSuccess else { throw CredentialError.keychain(status) }
        return .keychain
    }

    func save(_ password: String) throws {
        guard !password.isEmpty else { throw CredentialError.emptyPassword }
        let attributes: [String: Any] = [
            kSecValueData as String: Data(password.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item.merge(attributes) { _, new in new }
            item[kSecAttrLabel as String] = "Remote Mac Control unlock password"
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw CredentialError.keychain(status) }
    }

    func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw CredentialError.keychain(status)
        }
    }

    private func noninteractiveContext() -> LAContext {
        let context = LAContext()
        context.interactionNotAllowed = true
        return context
    }
}
