import Foundation

public struct SystemActionOutcome: Equatable {
    public let ok: Bool
    public let message: String?
    public let state: String?
    public init(ok: Bool, message: String? = nil, state: String? = nil) {
        self.ok = ok; self.message = message; self.state = state
    }
}

/// Shared by all transport sessions. Native callbacks may arrive on any queue.
/// Disconnecting a client never cancels or releases an executing Mac operation.
public final class SystemActionGate {
    private struct Key: Hashable { let device: String; let id: String; let action: SystemAction; let fingerprint: String }
    private let lock = NSLock()
    private var running: (token: UUID, key: Key?)?
    private var completed: [Key: SystemActionOutcome] = [:]
    private var order: [Key] = []
    public init() {}

    public func status(device: String, id: String, action: SystemAction) -> SystemActionOutcome {
        lock.lock(); defer { lock.unlock() }
        if let result = completed.first(where: { $0.key.device == device && $0.key.id == id && $0.key.action == action })?.value { return result }
        if running?.key.map({ $0.device == device && $0.id == id && $0.action == action }) == true { return SystemActionOutcome(ok: false, state: "running") }
        return SystemActionOutcome(ok: false, state: "unknown")
    }

    func perform(device: String?, id: String?, action: SystemAction, fingerprint: String = "",
                 start: (@escaping (Bool, String?) -> Void) -> Void,
                 completion: @escaping (SystemActionOutcome) -> Void) {
        let key = device.flatMap { device in id.map { Key(device: device, id: $0, action: action, fingerprint: fingerprint) } }
        lock.lock()
        if let key {
            let otherAction = completed.keys.contains { $0.device == key.device && $0.id == key.id && ($0.action != key.action || $0.fingerprint != key.fingerprint) } ||
                running?.key.map { $0.device == key.device && $0.id == key.id && ($0.action != key.action || $0.fingerprint != key.fingerprint) } == true
            if otherAction { lock.unlock(); completion(SystemActionOutcome(ok: false, message: "This operation id belongs to a different action or parameters.")); return }
        }
        if let key, let result = completed[key] { lock.unlock(); completion(result); return }
        if let running {
            let result = key != nil && running.key == key
                ? SystemActionOutcome(ok: false, state: "running")
                : SystemActionOutcome(ok: false, message: "Another Mac action is still running.")
            if let key, result.state == nil { remember(key, result) }
            lock.unlock(); completion(result); return
        }
        let token = UUID(); running = (token, key); lock.unlock()
        start { [self] ok, message in
            lock.lock()
            guard running?.token == token else { lock.unlock(); return }
            running = nil
            let outcome = SystemActionOutcome(ok: ok, message: message.map { String(decoding: $0.utf16.prefix(240), as: UTF16.self) }.flatMap { $0.isEmpty ? nil : $0 })
            if let key { remember(key, outcome) }
            lock.unlock()
            completion(outcome)
        }
    }
    /// Called with the lock held; cache contains outcomes only, never credentials.
    private func remember(_ key: Key, _ result: SystemActionOutcome) {
        if completed[key] == nil { order.append(key) }
        completed[key] = result
        while order.count > 64 { completed.removeValue(forKey: order.removeFirst()) }
    }
}
