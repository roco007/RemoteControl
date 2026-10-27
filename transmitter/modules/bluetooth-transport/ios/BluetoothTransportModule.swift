import ExpoModulesCore

public final class BluetoothTransportModule: Module {
  private var central: BluetoothCentral?
  private var foreground = true

  private func transport() -> BluetoothCentral {
    if let central { return central }
    let central = BluetoothCentral { [weak self] name, payload in self?.sendEvent(name, payload) }
    central.setForeground(foreground)
    self.central = central
    return central
  }

  private func completion(_ promise: Promise) -> BluetoothCentral.Completion {
    { message in
      if let message { promise.reject("ERR_BLUETOOTH", message) }
      else { promise.resolve() }
    }
  }

  public func definition() -> ModuleDefinition {
    Name("BluetoothTransport")
    Events("onDevices", "onData", "onDisconnected", "onError", "onState", "onAppState")
    AsyncFunction("startScan") { (uuid: String, promise: Promise) in
      self.transport().startScan(serviceUUID: uuid, completion: self.completion(promise))
    }.runOnQueue(.main)
    AsyncFunction("stopScan") {
      self.central?.stopScan()
    }.runOnQueue(.main)
    AsyncFunction("connect") { (id: String, service: String, write: String, notify: String, promise: Promise) in
      self.transport().connect(id: id, service: service, write: write, notify: notify, completion: self.completion(promise))
    }.runOnQueue(.main)
    AsyncFunction("send") { (message: String, promise: Promise) in
      self.transport().send(message, completion: self.completion(promise))
    }.runOnQueue(.main)
    AsyncFunction("disconnect") { (promise: Promise) in
      guard let central = self.central else { promise.resolve(); return }
      central.disconnect(completion: self.completion(promise))
    }.runOnQueue(.main)
    OnAppEntersBackground {
      DispatchQueue.main.async { [weak self] in
        self?.foreground = false
        self?.sendEvent("onAppState", ["active": false])
        self?.central?.setForeground(false)
      }
    }
    OnAppEntersForeground {
      DispatchQueue.main.async { [weak self] in
        self?.foreground = true
        self?.sendEvent("onAppState", ["active": true])
        self?.central?.setForeground(true)
      }
    }
    OnDestroy {
      let central = self.central
      DispatchQueue.main.async { central?.shutdown(reason: "Bluetooth transport closed.") }
    }
  }
}
