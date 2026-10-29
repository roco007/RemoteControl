import Foundation
import Darwin

/// Gesture links are HTTP(S) only. The editor may trim; wire values are strict.
public enum HTTPURL {
    public static let maxLength = 4096
    public static func parse(_ value: String) -> URL? {
        guard !value.isEmpty, value.utf16.count <= maxLength,
              !value.unicodeScalars.contains(where: {
                  $0.value <= 0x20 || (0x7f...0x9f).contains($0.value) || $0 == "\\" || "<>\"{}|^`".unicodeScalars.contains($0) ||
                      CharacterSet.whitespacesAndNewlines.contains($0) || $0.value == 0xfeff
              }),
              value.range(of: "%(?![a-fA-F0-9]{2})", options: .regularExpression) == nil,
              let separator = value.range(of: "://"), ["http", "https"].contains(value[..<separator.lowerBound].lowercased()) else { return nil }
        let authority = String(value[separator.upperBound...].prefix { !"/?#".contains($0) })
        let suffix = value[separator.upperBound...].dropFirst(authority.count)
        guard !suffix.contains("["), !suffix.contains("]") else { return nil }
        let host: String, port: String?
        if authority.hasPrefix("[") {
            guard let end = authority.firstIndex(of: "]") else { return nil }
            host = String(authority[authority.index(after: authority.startIndex)..<end])
            var address = in6_addr()
            guard inet_pton(AF_INET6, host, &address) == 1 else { return nil }
            let remainder = authority[authority.index(after: end)...]
            if remainder.isEmpty { port = nil }
            else { guard remainder.hasPrefix(":") else { return nil }; port = String(remainder.dropFirst()) }
        } else {
            let parts = authority.split(separator: ":", omittingEmptySubsequences: false)
            guard (1...2).contains(parts.count) else { return nil }
            host = String(parts[0]); port = parts.count == 2 ? String(parts[1]) : nil
            guard validHostname(host) else { return nil }
        }
        if let port {
            guard !port.isEmpty, port.allSatisfy({ $0 >= "0" && $0 <= "9" }), let number = Int(port), number <= 65535 else { return nil }
        }
        guard let components = URLComponents(string: value), components.user == nil, components.password == nil else { return nil }
        return components.url
    }
    private static func validHostname(_ host: String) -> Bool {
        guard !host.isEmpty, host.utf16.count <= 253 else { return false }
        if host.contains("."), host.allSatisfy({ "0123456789.".contains($0) }) {
            let parts = host.split(separator: ".", omittingEmptySubsequences: false)
            return parts.count == 4 && parts.allSatisfy {
                $0.range(of: "^(0|[1-9][0-9]{0,2})$", options: .regularExpression) != nil && (Int($0) ?? 256) <= 255
            }
        }
        let name = host.hasSuffix(".") ? String(host.dropLast()) : host
        guard !name.isEmpty else { return false }
        return name.split(separator: ".", omittingEmptySubsequences: false).allSatisfy {
            $0.range(of: "^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$", options: .regularExpression) != nil
        }
    }
}
