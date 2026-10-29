import Foundation
import Network
import ApplicationServices

public final class ReceiverServer {
    private let queue = DispatchQueue(label: "com.remotemac.receiver.network", qos: .userInteractive)
    private var listener: NWListener?
    private var timer: DispatchSourceTimer?
    private var sessions: [UUID: ReceiverSession] = [:]
    private var connections: [UUID: NWConnection] = [:]
    private let sink: InputSink
    public let pairing: PairingManager
    public let serverID: String
    public let name: String
    public let port: UInt16
    public var onUpdate: ((Snapshot) -> Void)?
    private var status = "Starting…"
    private var lastError: String?
    private let origins: Set<String>
    private let permission: () -> Bool
    private let loopbackOnly: Bool
    private let bluetoothEnabled: Bool
    private var bluetooth: BluetoothPeripheral?
    private var bluetoothStatus = "Disabled"
    private lazy var coordinator = ReceiverSessionCoordinator(pairing: pairing, sink: sink, serverID: serverID, name: name, permission: permission,
        executeCompletion: { [weak self] completion in self?.queue.async(execute: completion) })
    private var listeningPort: UInt16 = 0

    public struct Snapshot {
        public var port: UInt16
        public var status: String
        public var code: String
        public var expiresAt: Date
        public var permission: Bool
        public var deviceName: String?
        public var activeTransport: ReceiverTransport?
        public var bluetoothStatus: String
        public var devices: [TrustedDevice]
        public var error: String?
    }

    public init(port: UInt16, pairing: PairingManager, sink: InputSink, origins: Set<String> = [], permission: @escaping () -> Bool = { AXIsProcessTrusted() }, loopbackOnly: Bool = false, identity: String? = nil, bluetoothEnabled: Bool = false) {
        self.port = port; self.pairing = pairing; self.sink = sink; self.origins = origins; self.permission = permission; self.loopbackOnly = loopbackOnly
        self.bluetoothEnabled = bluetoothEnabled && !loopbackOnly
        name = String((Host.current().localizedName ?? "Mac").prefix(80))
        let key = "RemoteMacServerUUID"
        serverID = identity ?? UserDefaults.standard.string(forKey: key) ?? UUID().uuidString.lowercased()
        if identity == nil { UserDefaults.standard.set(serverID, forKey: key) }
    }
    public func start() { queue.async { [weak self] in self?.startOnQueue() } }
    private func startOnQueue() {
        guard timer == nil else { return }
        coordinator.onChange = { [weak self] in self?.publish() }
        // Bluetooth and session deadlines remain available even if the TCP listener fails.
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(250))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            do { try self.pairing.refreshCodeIfNeeded() } catch { self.lastError = "Could not generate a pairing code." }
            self.coordinator.tick(); self.bluetooth?.tick(); self.publish()
        }
        timer.resume(); self.timer = timer
        if bluetoothEnabled {
            let bluetooth = BluetoothPeripheral(queue: queue, name: name) { [weak self] send, cancel in
                self?.coordinator.makeSession(transport: .bluetooth, send: send, cancel: cancel)
            }
            self.bluetooth = bluetooth
            bluetooth.onStatus = { [weak self] value in self?.bluetoothStatus = value; self?.publish() }
            bluetooth.start()
        }
        let options = NWProtocolWebSocket.Options()
        options.autoReplyPing = true; options.maximumMessageSize = Wire.maxMessageBytes
        let allowedOrigins = origins
        options.setClientRequestHandler(queue) { _, headers in
            let originHeaders = headers.filter { $0.name.lowercased() == "origin" }
            let accepted = originHeaders.isEmpty || (originHeaders.count == 1 &&
                (originHeaders[0].value == Wire.nativeClientOrigin || allowedOrigins.contains(originHeaders[0].value)))
            return NWProtocolWebSocket.Response(status: accepted ? .accept : .reject, subprotocol: nil)
        }
        let tcp = NWProtocolTCP.Options(); tcp.noDelay = true; tcp.enableKeepalive = true; tcp.keepaliveIdle = 15
        let parameters = NWParameters(tls: nil, tcp: tcp)
        parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0)
        if loopbackOnly { parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any) }
        parameters.includePeerToPeer = false; parameters.allowLocalEndpointReuse = true
        do {
            guard let port = NWEndpoint.Port(rawValue: port) else { throw ServerError.invalidPort }
            let listener = try NWListener(using: parameters, on: port)
            self.listener = listener
            if !loopbackOnly { listener.service = NWListener.Service(name: name, type: Wire.serviceType, domain: "local.", txtRecord: NWTXTRecord(["id": serverID, "v": String(Wire.version)])) }
            listener.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready: self.listeningPort = listener.port?.rawValue ?? self.port; self.status = "Ready for a phone"; self.lastError = nil
                case .failed(let error): self.status = "Receiver unavailable"; self.lastError = error.localizedDescription
                case .waiting(let error): self.status = "Waiting for network"; self.lastError = error.localizedDescription
                case .cancelled: self.status = "Stopped"
                default: break
                }
                self.publish()
            }
            listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
            listener.start(queue: queue)
        } catch { status = "Receiver unavailable"; lastError = error.localizedDescription; publish() }
    }

    private func accept(_ connection: NWConnection) {
        guard LocalNetwork.isAllowed(connection.endpoint), coordinator.count < 8 else { connection.cancel(); return }
        let connectionID = UUID()
        connections[connectionID] = connection
        guard let session = coordinator.makeSession(transport: .wifi,
            send: { [weak self, weak connection] data in
                guard let connection else { return }
                let context = NWConnection.ContentContext(identifier: "json", metadata: [NWProtocolWebSocket.Metadata(opcode: .text)])
                connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { error in
                    if error != nil { self?.sessions[connectionID]?.disconnect() }
                })
            }, cancel: { [weak self, weak connection] in
                // Give the final protocol error a chance to drain before closing transport.
                self?.sessions.removeValue(forKey: connectionID)
                self?.connections.removeValue(forKey: connectionID)
                self?.queue.asyncAfter(deadline: .now() + 0.1) { connection?.cancel() }
            }) else { connections.removeValue(forKey: connectionID); connection.cancel(); return }
        sessions[connectionID] = session
        connection.stateUpdateHandler = { [weak self, weak session] state in
            guard let self, let session else { return }
            switch state {
            case .ready: session.hello(); self.receive(connection, session: session)
            case .failed, .cancelled: session.disconnect()
            default: break
            }
        }
        connection.start(queue: queue)
    }

    private func receive(_ connection: NWConnection, session: ReceiverSession) {
        connection.receiveMessage { [weak self, weak session] data, context, complete, error in
            guard let self, let session, !session.closed else { return }
            if error != nil { session.disconnect(); return }
            if let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata {
                switch metadata.opcode {
                case .close: session.disconnect(); return
                case .text:
                    guard complete, let data else { session.disconnect(); return }
                    session.receive(data)
                case .ping, .pong: break
                default: session.disconnect(); return
                }
            } else { session.disconnect(); return }
            if !session.closed { self.receive(connection, session: session) }
        }
    }

    public func disconnectController() { queue.async { [weak self] in
        guard let self else { return }; self.coordinator.disconnectController(); self.publish()
    } }
    public func revoke(_ id: String) { queue.async { [weak self] in
        guard let self else { return }
        do {
            try self.coordinator.revoke(id)
            self.lastError = nil
        } catch { self.lastError = error.localizedDescription }
        self.publish()
    } }
    public func rotateCode() { queue.async { [weak self] in
        guard let self else { return }; do { try self.pairing.rotateCode() } catch { self.lastError = "Could not generate a new code." }; self.publish()
    } }
    public func stop() {
        queue.sync {
            timer?.cancel(); timer = nil
            coordinator.disconnectAll(); bluetooth?.stop(); bluetooth = nil
            for connection in connections.values { connection.cancel() }
            connections.removeAll(); listener?.cancel(); listener = nil
        }
    }
    private func publish() {
        let snapshot = Snapshot(port: listeningPort, status: status, code: pairing.code, expiresAt: pairing.codeExpiresAt, permission: permission(), deviceName: coordinator.activeSession?.deviceName, activeTransport: coordinator.activeTransport, bluetoothStatus: bluetoothStatus, devices: pairing.devices, error: lastError)
        DispatchQueue.main.async { [weak self] in self?.onUpdate?(snapshot) }
    }
    private enum ServerError: Error { case invalidPort }
}
