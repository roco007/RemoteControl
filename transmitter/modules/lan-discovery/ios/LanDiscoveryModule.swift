import ExpoModulesCore
import Foundation
import Darwin

public final class LanDiscoveryModule: Module {
  private var browser: MacServiceBrowser?

  public func definition() -> ModuleDefinition {
    Name("LanDiscovery")
    Events("onChange", "onError")
    AsyncFunction("requestLocalNetworkAccess") { true }
    AsyncFunction("start") { (serviceType: String) in
      self.browser?.stop()
      let browser = MacServiceBrowser(
        onChange: { [weak self] macs in self?.sendEvent("onChange", ["macs": macs]) },
        onError: { [weak self] message in self?.sendEvent("onError", ["message": message]) }
      )
      self.browser = browser
      browser.start(type: serviceType)
    }.runOnQueue(.main)
    AsyncFunction("stop") {
      self.browser?.stop()
      self.browser = nil
    }.runOnQueue(.main)
    OnAppEntersBackground {
      DispatchQueue.main.async { [weak self] in
        self?.browser?.stop()
        self?.browser = nil
      }
    }
    OnDestroy {
      let browser = self.browser
      DispatchQueue.main.async { browser?.stop() }
    }
  }
}

private final class MacServiceBrowser: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
  private var browser: NetServiceBrowser?
  private var services: [String: NetService] = [:]
  private var resolved: [String: [String: Any]] = [:]
  private let onChange: ([[String: Any]]) -> Void
  private let onError: (String) -> Void

  init(onChange: @escaping ([[String: Any]]) -> Void, onError: @escaping (String) -> Void) {
    self.onChange = onChange
    self.onError = onError
    super.init()
  }

  func start(type: String) {
    stop()
    guard type.range(of: #"^_[a-zA-Z0-9-]+\._tcp$"#, options: .regularExpression) != nil else {
      onError("Invalid discovery service type.")
      return
    }
    let browser = NetServiceBrowser()
    browser.delegate = self
    self.browser = browser
    browser.searchForServices(ofType: type + ".", inDomain: "local.")
  }

  func stop() {
    browser?.delegate = nil
    browser?.stop()
    browser = nil
    services.values.forEach { $0.delegate = nil; $0.stop() }
    services.removeAll()
    resolved.removeAll()
    publish()
  }

  private func identifier(_ service: NetService) -> String {
    "\(service.name).\(service.type)\(service.domain)"
  }
  private func publish() {
    onChange(resolved.values.sorted { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") })
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
    guard browser === self.browser else { return }
    let id = identifier(service)
    services[id]?.stop()
    services[id] = service
    service.delegate = self
    service.resolve(withTimeout: 8)
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
    guard browser === self.browser else { return }
    let id = identifier(service)
    services.removeValue(forKey: id)?.stop()
    resolved.removeValue(forKey: id)
    publish()
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) {
    guard browser === self.browser else { return }
    let code = errorDict[NetService.errorCode]?.intValue ?? 0
    onError(code == -72008
      ? "Local network access is denied. Enable Local Network for Remote Mac in iOS Settings."
      : "Unable to search for Macs (Bonjour \(code)). Check Wi-Fi and Local Network permission.")
    stop()
  }

  func netServiceDidResolveAddress(_ service: NetService) {
    let id = identifier(service)
    guard services[id] === service, service.port > 0, service.port <= 65535 else { return }
    // Prefer IPv4. Bonjour hostname fallback also supports IPv6-only LANs without
    // exposing platform-specific numeric IPv6 scope-id syntax to the URL builder.
    let host = service.addresses?.compactMap(Self.ipv4).first ?? service.hostName
    guard let host, !host.isEmpty else {
      onError("Found \(service.name), but its network address could not be resolved.")
      return
    }
    resolved[id] = ["id": id, "name": service.name, "host": host, "port": service.port]
    publish()
  }

  func netService(_ service: NetService, didNotResolve errorDict: [String: NSNumber]) {
    let id = identifier(service)
    guard services[id] === service else { return }
    services.removeValue(forKey: id)
    resolved.removeValue(forKey: id)
    publish()
    onError("Found \(service.name), but could not resolve it. Keep the receiver open and try Search again.")
  }

  private static func ipv4(_ data: Data) -> String? {
    data.withUnsafeBytes { bytes -> String? in
      guard bytes.count >= MemoryLayout<sockaddr_in>.size,
            let address = bytes.baseAddress?.assumingMemoryBound(to: sockaddr.self),
            address.pointee.sa_family == sa_family_t(AF_INET) else { return nil }
      var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      let result = getnameinfo(address, socklen_t(data.count), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST)
      return result == 0 ? String(cString: host) : nil
    }
  }
}
