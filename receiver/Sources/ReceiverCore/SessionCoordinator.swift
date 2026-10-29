import Foundation

public enum ReceiverTransport: String { case wifi = "Wi-Fi", bluetooth = "Bluetooth" }

/// All entry points run on the receiver's serial queue, including both transport delegates.
/// Neither transport can obtain its own controller lock or trust store.
final class ReceiverSessionCoordinator {
    private struct Entry { let session: ReceiverSession; let transport: ReceiverTransport }
    private var entries: [UUID: Entry] = [:]
    private var controller: UUID?
    private let pairing: PairingManager
    private let sink: InputSink
    private let serverID: String
    private let name: String
    private let permission: () -> Bool
    private let log: (String) -> Void
    private let actionGate = SystemActionGate()
    private let executeCompletion: (@escaping () -> Void) -> Void
    var onChange: (() -> Void)?
    var count: Int { entries.count }
    var activeSession: ReceiverSession? { controller.flatMap { entries[$0]?.session }.flatMap { $0.authenticated ? $0 : nil } }
    var activeTransport: ReceiverTransport? { activeSession.flatMap { entries[$0.id]?.transport } }

    init(pairing: PairingManager, sink: InputSink, serverID: String, name: String,
         permission: @escaping () -> Bool, log: @escaping (String) -> Void = ReceiverCommandLog.write,
         executeCompletion: @escaping (@escaping () -> Void) -> Void = { $0() }) {
        self.pairing = pairing; self.sink = sink; self.serverID = serverID; self.name = name
        self.permission = permission; self.log = log
        self.executeCompletion = executeCompletion
    }

    func makeSession(transport: ReceiverTransport, send: @escaping (Data) -> Void, cancel: @escaping () -> Void) -> ReceiverSession? {
        guard entries.count < 8 else { return nil }
        var sessionID: UUID?
        let session = ReceiverSession(pairing: pairing, input: InputController(sink: sink, actionGate: actionGate), serverID: serverID, name: name,
            permission: permission,
            acquire: { [weak self] id in
                guard let self, self.controller == nil || self.controller == id else { return false }
                self.controller = id; return true
            }, relinquish: { [weak self] id in if self?.controller == id { self?.controller = nil } },
            send: send,
            cancel: { [weak self] in
                if let sessionID { self?.entries.removeValue(forKey: sessionID) }
                cancel()
            }, log: log, executeCompletion: executeCompletion)
        sessionID = session.id
        entries[session.id] = Entry(session: session, transport: transport)
        session.onChange = { [weak self] in self?.onChange?() }
        return session
    }

    func tick() { for entry in Array(entries.values) { entry.session.tick() } }
    func disconnectController() { for entry in Array(entries.values) where entry.session.authenticated { entry.session.disconnect() } }
    func disconnectAll() { for entry in Array(entries.values) { entry.session.disconnect() } }
    func revoke(_ deviceID: String) throws {
        try pairing.revoke(deviceID)
        for entry in Array(entries.values) where entry.session.deviceID == deviceID { entry.session.revoke() }
    }
}
