import CoreBluetooth
import Foundation

/// State and CoreBluetooth delegates are confined to the main queue. Each
/// connection must finish disconnecting before another peripheral is connected.
final class BluetoothCentral: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  typealias Completion = (String?) -> Void
  private let emit: (String, [String: Any]) -> Void
  private var foreground = true
  private var manager: CBCentralManager?
  private var discovered: [UUID: CBPeripheral] = [:]
  private var devices: [UUID: [String: Any]] = [:]
  private var scanUUID: CBUUID?
  private var scanCompletion: Completion?
  private var scanTimer: Timer?
  private var scanRequested = false

  private struct ConnectionRequest {
    let id: UUID
    let service: CBUUID
    let write: CBUUID
    let notify: CBUUID
    let completion: Completion
  }
  private var pendingConnection: ConnectionRequest?
  private var connectionCompletion: Completion?
  private var peripheral: CBPeripheral?
  private var closingPeripheral: CBPeripheral?
  private var disconnectCompletions: [Completion] = []
  private var serviceUUID: CBUUID?
  private var writeUUID: CBUUID?
  private var notifyUUID: CBUUID?
  private var writeCharacteristic: CBCharacteristic?
  private var notifyCharacteristic: CBCharacteristic?
  private var ready = false
  private var generation = 0
  private var requestGeneration = 0
  private var connectionTimer: Timer?
  private var disconnectTimer: Timer?

  private struct OutgoingFrame {
    let data: Data
    let created: TimeInterval
    let completion: Completion
    var offset = 0
  }
  private var writes: [OutgoingFrame] = []
  private var queuedBytes = 0
  private var pendingChunkBytes = 0
  private var writeTimer: Timer?
  private var input = BluetoothFrameStream()
  private var assemblyTimer: Timer?

  init(emit: @escaping (String, [String: Any]) -> Void) {
    self.emit = emit
    super.init()
  }

  private func ensureManager() {
    if manager == nil {
      manager = CBCentralManager(delegate: self, queue: .main, options: [CBCentralManagerOptionShowPowerAlertKey: true])
    }
  }

  private func uuid(_ value: String) -> CBUUID? {
    guard UUID(uuidString: value) != nil else { return nil }
    return CBUUID(string: value)
  }

  func setForeground(_ active: Bool) {
    foreground = active
    if !active { shutdown(reason: "Bluetooth disconnected while the app is in the background.") }
  }

  func startScan(serviceUUID: String, completion: @escaping Completion) {
    guard foreground else { completion("Keep Remote Mac open to use Bluetooth."); return }
    stopScan()
    guard let service = uuid(serviceUUID) else { completion("Invalid Bluetooth service UUID."); return }
    scanUUID = service
    scanRequested = true
    scanCompletion = completion
    devices.removeAll()
    discovered.removeAll()
    publishDevices()
    ensureManager()
    scanTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { [weak self] _ in self?.stopScan() }
    continueScan()
  }

  private func continueScan() {
    guard scanRequested, let manager, let scanUUID else { return }
    switch manager.state {
    case .unknown, .resetting: return
    case .poweredOn:
      manager.scanForPeripherals(withServices: [scanUUID], options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
      let completion = scanCompletion
      scanCompletion = nil
      completion?(nil)
    default:
      let message = stateMessage(manager.state)
      let completion = scanCompletion
      scanCompletion = nil
      stopScan()
      completion?(message)
      emit("onError", ["message": message])
    }
  }

  func stopScan(reason: String = "Bluetooth scan was stopped before it could start.") {
    scanRequested = false
    scanTimer?.invalidate(); scanTimer = nil
    manager?.stopScan()
    scanUUID = nil
    let completion = scanCompletion
    scanCompletion = nil
    completion?(reason)
  }

  func connect(id: String, service: String, write: String, notify: String, completion: @escaping Completion) {
    guard foreground else { completion("Keep Remote Mac open to use Bluetooth."); return }
    guard let identifier = UUID(uuidString: id), let service = uuid(service), let write = uuid(write), let notify = uuid(notify) else {
      completion("Invalid Bluetooth device or service identifier."); return
    }
    stopScan()
    pendingConnection?.completion("Bluetooth connection was replaced.")
    pendingConnection = ConnectionRequest(id: identifier, service: service, write: write, notify: notify, completion: completion)
    ensureManager()
    if peripheral != nil { closeCurrent(reason: "Bluetooth connection was replaced.") }
    beginPendingConnection()
    requestGeneration += 1
    let attempt = requestGeneration
    connectionTimer?.invalidate(); connectionTimer = nil
    if pendingConnection != nil || connectionCompletion != nil {
      connectionTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
        guard let self, self.requestGeneration == attempt else { return }
        let message = "Bluetooth connection timed out. Accept the system pairing request and try again."
        self.pendingConnection?.completion(message)
        self.pendingConnection = nil
        if self.peripheral != nil { self.fail(message) }
      }
    }
  }

  private func beginPendingConnection() {
    guard closingPeripheral == nil, peripheral == nil, let request = pendingConnection, let manager else { return }
    switch manager.state {
    case .unknown, .resetting: return
    case .poweredOn: break
    default:
      pendingConnection = nil
      request.completion(stateMessage(manager.state))
      return
    }
    pendingConnection = nil
    guard let candidate = discovered[request.id] ?? manager.retrievePeripherals(withIdentifiers: [request.id]).first else {
      request.completion("This Mac is no longer known to Bluetooth. Search again with the receiver open.")
      return
    }
    generation += 1
    peripheral = candidate
    candidate.delegate = self
    connectionCompletion = request.completion
    serviceUUID = request.service
    writeUUID = request.write
    notifyUUID = request.notify
    input = BluetoothFrameStream()
    manager.connect(candidate, options: nil)
  }

  func send(_ message: String, completion: @escaping Completion) {
    guard foreground, ready, peripheral != nil, writeCharacteristic != nil else { completion("Bluetooth is not connected."); return }
    let frame: Data
    do { frame = try BluetoothFrameStream.encode(message) }
    catch { completion("Bluetooth messages must contain 1 to 16384 UTF-8 bytes."); return }
    guard queuedBytes + frame.count <= 32_768 else {
      completion("Bluetooth input queue is full.")
      fail("Bluetooth input queue is full. The connection was closed to discard stale input.")
      return
    }
    writes.append(OutgoingFrame(data: frame, created: ProcessInfo.processInfo.systemUptime, completion: completion))
    queuedBytes += frame.count
    armWriteDeadline()
    pumpWrite()
  }

  private func armWriteDeadline() {
    writeTimer?.invalidate(); writeTimer = nil
    guard let first = writes.first else { return }
    let attempt = generation
    let delay = max(0.001, 2 - (ProcessInfo.processInfo.systemUptime - first.created))
    writeTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
      guard let self, self.generation == attempt, !self.writes.isEmpty else { return }
      self.fail("Bluetooth input could not be delivered within 2 seconds. Reconnect to continue.")
    }
  }

  private func pumpWrite() {
    guard ready, pendingChunkBytes == 0, let peripheral, let characteristic = writeCharacteristic, let frame = writes.first else { return }
    guard ProcessInfo.processInfo.systemUptime - frame.created < 2 else {
      fail("Bluetooth input expired before delivery. Reconnect to continue."); return
    }
    // withResponse may permit a 512-byte ATT long write even when the negotiated
    // MTU is smaller. Cap to the unfragmented payload to keep each offset zero.
    let maximum = min(peripheral.maximumWriteValueLength(for: .withResponse),
      peripheral.maximumWriteValueLength(for: .withoutResponse), 512)
    guard maximum > 0 else { fail("Bluetooth did not provide a usable write size."); return }
    let length = min(maximum, frame.data.count - frame.offset)
    pendingChunkBytes = length
    peripheral.writeValue(frame.data.subdata(in: frame.offset..<(frame.offset + length)), for: characteristic, type: .withResponse)
  }

  func disconnect(completion: @escaping Completion) {
    stopScan()
    connectionTimer?.invalidate(); connectionTimer = nil
    pendingConnection?.completion("Bluetooth connection cancelled.")
    pendingConnection = nil
    if peripheral == nil && closingPeripheral == nil { completion(nil); return }
    disconnectCompletions.append(completion)
    closeCurrent(reason: "Bluetooth disconnected.")
  }

  func shutdown(reason: String) {
    stopScan(reason: reason)
    connectionTimer?.invalidate(); connectionTimer = nil
    pendingConnection?.completion(reason)
    pendingConnection = nil
    closeCurrent(reason: reason)
  }

  private func fail(_ message: String) {
    emit("onError", ["message": message])
    closeCurrent(reason: message)
  }

  private func closeCurrent(reason: String) {
    guard let old = peripheral else { return }
    generation += 1
    peripheral = nil
    closingPeripheral = old
    old.delegate = nil
    ready = false
    writeCharacteristic = nil
    notifyCharacteristic = nil
    serviceUUID = nil; writeUUID = nil; notifyUUID = nil
    connectionTimer?.invalidate(); connectionTimer = nil
    writeTimer?.invalidate(); writeTimer = nil
    assemblyTimer?.invalidate(); assemblyTimer = nil
    let connect = connectionCompletion
    connectionCompletion = nil
    let abandoned = writes
    writes.removeAll()
    queuedBytes = 0; pendingChunkBytes = 0
    input = BluetoothFrameStream()
    connect?(reason)
    abandoned.forEach { $0.completion(reason) }
    emit("onDisconnected", ["message": reason])
    manager?.cancelPeripheralConnection(old)
    disconnectTimer?.invalidate()
    disconnectTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { [weak self] _ in
      guard let self, self.closingPeripheral === old else { return }
      // CoreBluetooth may omit cancellation callbacks after a radio reset.
      // Retire this manager so late callbacks have a different owner, then
      // permit a pending reconnect through a freshly initialized manager.
      self.retireManager()
      self.finishClosing(old)
      self.ensureManager()
    }
  }

  private func finishClosing(_ old: CBPeripheral) {
    guard closingPeripheral === old else { return }
    closingPeripheral = nil
    disconnectTimer?.invalidate(); disconnectTimer = nil
    let completions = disconnectCompletions
    disconnectCompletions.removeAll()
    completions.forEach { $0(nil) }
    beginPendingConnection()
  }

  private func retireManager() {
    manager?.delegate = nil
    manager = nil
    discovered.removeAll()
    devices.removeAll()
    publishDevices()
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    guard central === manager else { return }
    emit("onState", ["state": stateName(central.state)])
    if central.state != .poweredOn && central.state != .unknown {
      let hadConnection = peripheral != nil || closingPeripheral != nil
      shutdown(reason: stateMessage(central.state))
      if hadConnection {
        // Power loss/reset can invalidate peripherals without a disconnect
        // callback. A new manager gives subsequent callbacks a distinct owner,
        // so acknowledging cleanup here cannot affect a future connection.
        retireManager()
        if let old = closingPeripheral { finishClosing(old) }
        ensureManager()
        return
      }
    }
    continueScan()
    beginPendingConnection()
  }

  func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
    guard central === manager, scanRequested else { return }
    discovered[peripheral.identifier] = peripheral
    devices[peripheral.identifier] = ["id": peripheral.identifier.uuidString,
      "name": (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name ?? "Remote Mac",
      "rssi": RSSI.intValue]
    publishDevices()
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    guard central === manager else { return }
    if closingPeripheral === peripheral { central.cancelPeripheralConnection(peripheral); return }
    guard self.peripheral === peripheral, let serviceUUID else { return }
    peripheral.discoverServices([serviceUUID])
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    guard central === manager else { return }
    if closingPeripheral === peripheral { finishClosing(peripheral); return }
    guard self.peripheral === peripheral else { return }
    closeCurrent(reason: error?.localizedDescription ?? "Could not connect to this Mac over Bluetooth.")
    finishClosing(peripheral)
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    guard central === manager else { return }
    if closingPeripheral === peripheral { finishClosing(peripheral); return }
    guard self.peripheral === peripheral else { return }
    closeCurrent(reason: error?.localizedDescription ?? "Bluetooth connection lost.")
    finishClosing(peripheral)
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    guard self.peripheral === peripheral else { return }
    guard error == nil, let service = peripheral.services?.first(where: { $0.uuid == serviceUUID }), let writeUUID, let notifyUUID else {
      fail(error?.localizedDescription ?? "This device does not provide the Remote Mac Bluetooth service."); return
    }
    peripheral.discoverCharacteristics([writeUUID, notifyUUID], for: service)
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    guard self.peripheral === peripheral, service.uuid == serviceUUID else { return }
    guard error == nil,
          let write = service.characteristics?.first(where: { $0.uuid == writeUUID }), write.properties.contains(.write),
          let notify = service.characteristics?.first(where: { $0.uuid == notifyUUID }),
          notify.properties.contains(.notify) || notify.properties.contains(.indicate) else {
      fail(error?.localizedDescription ?? "The Mac's Bluetooth service is missing its input or response characteristic."); return
    }
    writeCharacteristic = write
    notifyCharacteristic = notify
    // The receiver requires encryption for this subscription. CoreBluetooth
    // handles OS pairing before didUpdateNotificationState reports success.
    peripheral.setNotifyValue(true, for: notify)
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
    guard self.peripheral === peripheral, characteristic === notifyCharacteristic else { return }
    guard error == nil, characteristic.isNotifying else {
      fail(error?.localizedDescription ?? "Bluetooth pairing or encrypted notifications were not accepted."); return
    }
    ready = true
    connectionTimer?.invalidate(); connectionTimer = nil
    let completion = connectionCompletion
    connectionCompletion = nil
    completion?(nil)
  }

  func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
    guard self.peripheral === peripheral, characteristic === writeCharacteristic, pendingChunkBytes > 0, !writes.isEmpty else { return }
    guard error == nil else { fail(error!.localizedDescription); return }
    writes[0].offset += pendingChunkBytes
    pendingChunkBytes = 0
    if writes[0].offset == writes[0].data.count {
      let completed = writes.removeFirst()
      queuedBytes -= completed.data.count
      completed.completion(nil)
      armWriteDeadline()
    }
    pumpWrite()
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    guard self.peripheral === peripheral, characteristic === notifyCharacteristic else { return }
    guard error == nil, let bytes = characteristic.value else { fail(error?.localizedDescription ?? "Bluetooth returned an empty notification."); return }
    do {
      let messages = try input.append(bytes)
      messages.forEach { emit("onData", ["data": $0]) }
      if !input.hasPartialFrame {
        assemblyTimer?.invalidate(); assemblyTimer = nil
      } else if assemblyTimer == nil || !messages.isEmpty {
        assemblyTimer?.invalidate()
        let attempt = generation
        assemblyTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { [weak self] _ in
          guard let self, self.generation == attempt, self.input.hasPartialFrame else { return }
          self.fail("Bluetooth response was incomplete for 5 seconds.")
        }
      }
    } catch { fail("The Mac sent an invalid Bluetooth frame.") }
  }

  func peripheral(_ peripheral: CBPeripheral, didModifyServices invalidatedServices: [CBService]) {
    guard self.peripheral === peripheral, invalidatedServices.contains(where: { $0.uuid == serviceUUID }) else { return }
    fail("The Mac's Bluetooth service changed. Reconnect to continue.")
  }

  private func publishDevices() {
    emit("onDevices", ["devices": devices.values.sorted { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }])
  }

  private func stateName(_ state: CBManagerState) -> String {
    switch state {
    case .unknown: return "unknown"
    case .resetting: return "resetting"
    case .unsupported: return "unsupported"
    case .unauthorized: return "unauthorized"
    case .poweredOff: return "poweredOff"
    case .poweredOn: return "poweredOn"
    @unknown default: return "unknown"
    }
  }

  private func stateMessage(_ state: CBManagerState) -> String {
    switch state {
    case .unauthorized: return "Bluetooth permission was denied. Allow Remote Mac to use Bluetooth in Settings."
    case .unsupported: return "Bluetooth Low Energy is not supported on this device."
    case .poweredOff: return "Bluetooth is turned off. Turn it on in Settings and try again."
    default: return "Bluetooth is not ready. Try again in a moment."
    }
  }
}
