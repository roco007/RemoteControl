import Foundation
import CoreBluetooth

/// macOS peripheral / phone central. Only complete frames reach ReceiverSession.
/// CoreBluetooth calls and session calls share ReceiverServer's serial queue.
final class BluetoothPeripheral: NSObject, CBPeripheralManagerDelegate {
    private final class Peer {
        let central: CBCentral
        var decoder = BluetoothFrameDecoder()
        var output = BluetoothOutputQueue()
        var session: ReceiverSession?
        var accepting = true
        init(_ central: CBCentral) { self.central = central }
    }
    private let queue: DispatchQueue
    private let name: String
    private let makeSession: (@escaping (Data) -> Void, @escaping () -> Void) -> ReceiverSession?
    private var manager: CBPeripheralManager?
    private var receiveCharacteristic: CBMutableCharacteristic?
    private var transmitCharacteristic: CBMutableCharacteristic?
    private var peers: [UUID: Peer] = [:]
    private var started = false
    private var servicePublished = false
    private var blocked = false
    var onStatus: ((String) -> Void)?

    init(queue: DispatchQueue, name: String,
         makeSession: @escaping (@escaping (Data) -> Void, @escaping () -> Void) -> ReceiverSession?) {
        self.queue = queue; self.name = name; self.makeSession = makeSession
    }

    static func makeCharacteristics() -> (receive: CBMutableCharacteristic, transmit: CBMutableCharacteristic) {
        // OS link encryption is mandatory; the app code/token is still independently required.
        let receive = CBMutableCharacteristic(type: CBUUID(string: BluetoothWire.receiveUUID), properties: [.write], value: nil, permissions: [.writeable, .writeEncryptionRequired])
        let transmit = CBMutableCharacteristic(type: CBUUID(string: BluetoothWire.transmitUUID), properties: [.notify, .notifyEncryptionRequired], value: nil, permissions: [])
        return (receive, transmit)
    }

    func start() {
        guard !started else { return }
        started = true
        onStatus?("Starting Bluetooth…")
        manager = CBPeripheralManager(delegate: self, queue: queue, options: [CBPeripheralManagerOptionShowPowerAlertKey: false])
    }

    func stop() {
        started = false
        closeAll()
        manager?.stopAdvertising(); manager?.removeAllServices(); manager?.delegate = nil; manager = nil
        servicePublished = false; receiveCharacteristic = nil; transmitCharacteristic = nil
        onStatus?("Stopped")
    }

    func tick() {
        let now = ProcessInfo.processInfo.systemUptime
        for (id, peer) in Array(peers) {
            do { try peer.decoder.checkTimeout(now: now); try peer.output.checkTimeout(now: now) }
            catch { close(id) }
        }
    }

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        guard started, peripheral === manager else { return }
        if peripheral.state != .poweredOn {
            closeAll(); servicePublished = false
            receiveCharacteristic = nil; transmitCharacteristic = nil
        }
        switch peripheral.state {
        case .poweredOn:
            guard !servicePublished else { return }
            let (receive, transmit) = Self.makeCharacteristics()
            receiveCharacteristic = receive; transmitCharacteristic = transmit
            let service = CBMutableService(type: CBUUID(string: BluetoothWire.serviceUUID), primary: true)
            service.characteristics = [receive, transmit]
            servicePublished = true
            onStatus?("Publishing Bluetooth service…")
            peripheral.removeAllServices()
            peripheral.add(service)
        case .poweredOff: onStatus?("Bluetooth is off")
        case .unauthorized: onStatus?("Bluetooth permission required")
        case .unsupported: onStatus?("Bluetooth LE is unavailable")
        case .resetting: onStatus?("Bluetooth is restarting…")
        case .unknown: onStatus?("Checking Bluetooth…")
        @unknown default: onStatus?("Bluetooth is unavailable")
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        guard started, peripheral === manager, peripheral.state == .poweredOn,
              service.characteristics?.contains(where: { $0 === receiveCharacteristic }) == true else { return }
        guard error == nil else { servicePublished = false; onStatus?("Bluetooth service could not start"); return }
        peripheral.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [CBUUID(string: BluetoothWire.serviceUUID)],
                                     CBAdvertisementDataLocalNameKey: String(name.prefix(24))])
    }

    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        guard started, peripheral === manager else { return }
        onStatus?(error == nil ? "Ready for a phone" : "Bluetooth advertising failed")
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        guard started, peripheral === manager, characteristic === transmitCharacteristic, peers[central.identifier] == nil, peers.count < 8 else { return }
        let id = central.identifier
        let peer = Peer(central)
        peers[id] = peer
        guard let session = makeSession({ [weak self] data in self?.send(data, to: id) }, { [weak self] in self?.finishSession(id) }) else {
            peers.removeValue(forKey: id); return
        }
        peer.session = session
        session.hello()
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        guard started, peripheral === manager, characteristic === transmitCharacteristic else { return }
        close(central.identifier)
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        guard let first = requests.first else { return }
        let id = first.central.identifier
        guard started, peripheral === manager, let peer = peers[id], peer.accepting, let session = peer.session, !session.closed else {
            peripheral.respond(to: first, withResult: .insufficientAuthorization); return
        }
        // Treat the entire ATT batch atomically. Never dispatch the valid prefix of an invalid batch.
        guard requests.allSatisfy({ $0.central.identifier == id && $0.characteristic === receiveCharacteristic && $0.offset == 0 && $0.value?.isEmpty == false }) else {
            peripheral.respond(to: first, withResult: .invalidPdu); close(id); return
        }
        var decoder = peer.decoder
        var messages: [Data] = []
        do {
            let now = ProcessInfo.processInfo.systemUptime
            for request in requests { messages += try decoder.append(request.value!, now: now) }
        } catch {
            peripheral.respond(to: first, withResult: .invalidAttributeValueLength); close(id); return
        }
        peer.decoder = decoder
        peripheral.respond(to: first, withResult: .success)
        for message in messages {
            guard !session.closed else { break }
            session.receive(message)
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
        peripheral.respond(to: request, withResult: .readNotPermitted)
    }

    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
        guard started, peripheral === manager else { return }
        blocked = false
        drain()
    }

    private func send(_ data: Data, to id: UUID) {
        guard let peer = peers[id], peer.accepting else { return }
        do { try peer.output.enqueue(data, now: ProcessInfo.processInfo.systemUptime); drain() }
        catch { close(id) }
    }

    private func drain() {
        guard !blocked, let manager, let transmitCharacteristic, manager.state == .poweredOn else { return }
        for (id, peer) in Array(peers) {
            do {
                while let fragment = try peer.output.next(maximumLength: peer.central.maximumUpdateValueLength, now: ProcessInfo.processInfo.systemUptime) {
                    guard manager.updateValue(fragment, for: transmitCharacteristic, onSubscribedCentrals: [peer.central]) else {
                        blocked = true; return
                    }
                    peer.output.consume(fragment.count)
                }
                if !peer.accepting { peers.removeValue(forKey: id) }
            } catch { close(id) }
        }
    }

    private func finishSession(_ id: UUID) {
        guard let peer = peers[id] else { return }
        peer.accepting = false; peer.session = nil
        // There is no peripheral API to disconnect a central. Reject subsequent writes until
        // it unsubscribes/reconnects, while allowing a queued final protocol error to drain.
        if peer.output.queuedBytes == 0 { peers.removeValue(forKey: id) }
    }

    private func close(_ id: UUID) {
        guard let peer = peers.removeValue(forKey: id) else { return }
        peer.accepting = false; peer.session?.disconnect(); peer.session = nil
    }

    private func closeAll() {
        for id in Array(peers.keys) { close(id) }
        blocked = false
    }
}
