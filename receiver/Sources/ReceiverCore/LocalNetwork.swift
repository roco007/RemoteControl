import Foundation
import Network

public enum LocalNetwork {
    public static func isAllowed(_ endpoint: NWEndpoint) -> Bool {
        guard case let .hostPort(host, _) = endpoint else { return false }
        switch host {
        case .ipv4(let address): return isPrivateIPv4(Array(address.rawValue))
        case .ipv6(let address):
            let b = Array(address.rawValue)
            if b.count != 16 { return false }
            if b.prefix(15).allSatisfy({ $0 == 0 }) && b[15] == 1 { return true }
            if b[0] & 0xfe == 0xfc || (b[0] == 0xfe && b[1] & 0xc0 == 0x80) { return true }
            if b.prefix(10).allSatisfy({ $0 == 0 }) && b[10] == 255 && b[11] == 255 { return isPrivateIPv4(Array(b.suffix(4))) }
            return false
        case .name: return false // Accepted peers are concrete addresses, never unverified DNS names.
        @unknown default: return false
        }
    }
    public static func isPrivateIPv4(_ b: [UInt8]) -> Bool {
        guard b.count == 4 else { return false }
        return b[0] == 127 || b[0] == 10 || (b[0] == 172 && (16...31).contains(b[1])) || (b[0] == 192 && b[1] == 168) || (b[0] == 169 && b[1] == 254)
    }

    public static func advertisedAddresses() -> [String] {
        var addresses: [String] = []
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0 else { return addresses }
        defer { freeifaddrs(list) }
        var current = list
        while let entry = current {
            defer { current = entry.pointee.ifa_next }
            guard let address = entry.pointee.ifa_addr, address.pointee.sa_family == UInt8(AF_INET),
                  (entry.pointee.ifa_flags & UInt32(IFF_LOOPBACK)) == 0,
                  (entry.pointee.ifa_flags & UInt32(IFF_UP)) != 0 else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 { addresses.append(String(cString: host)) }
        }
        return addresses.sorted()
    }
}
