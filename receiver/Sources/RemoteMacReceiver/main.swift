import AppKit
import ApplicationServices
import ReceiverCore

final class ApplicationDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var receiverWindow: ReceiverWindow?
    private var server: ReceiverServer?
    private var sleepObserver: NSObjectProtocol?
    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let configured = ProcessInfo.processInfo.environment["REMOTE_MAC_PORT"] ?? String(Wire.defaultPort)
            guard let port = UInt16(configured), port > 0 else { throw StartupError.invalidPort }
            let pairing = try PairingManager(store: KeychainTrustStore())
            let origins = Set((ProcessInfo.processInfo.environment["REMOTE_MAC_ALLOWED_ORIGINS"] ?? "").split(separator: ",").map(String.init))
            let unlockCredentials = MacUnlockCredentialStore()
            let input = NativeInput(unlockPassword: unlockCredentials.password)
            let server = ReceiverServer(port: port, pairing: pairing, sink: input, origins: origins, bluetoothEnabled: true)
            self.server = server
            let controller = ReceiverWindow(server: server, unlockCredentials: unlockCredentials); self.receiverWindow = controller
            input.onLockStatus = { [weak controller] in controller?.showLockStatus($0) }
            server.onUpdate = { [weak self, weak controller] snapshot in
                controller?.update(snapshot)
                self?.statusItem?.button?.toolTip = snapshot.deviceName.map { "Remote Mac: \($0) connected via \(snapshot.activeTransport?.rawValue ?? "local connection")" } ?? "Remote Mac: Wi-Fi \(snapshot.status) · Bluetooth \(snapshot.bluetoothStatus)"
            }
            let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
            item.button?.image = NSImage(systemSymbolName: "computermouse", accessibilityDescription: "Remote Mac Control")
            let menu = NSMenu()
            menu.addItem(withTitle: "Open Remote Mac Control", action: #selector(showWindow), keyEquivalent: "").target = self
            menu.addItem(withTitle: "Disconnect phone", action: #selector(disconnect), keyEquivalent: "").target = self
            menu.addItem(.separator())
            menu.addItem(withTitle: "Quit Remote Mac Control", action: #selector(quit), keyEquivalent: "q").target = self
            item.menu = menu; statusItem = item
            sleepObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak input, weak server] _ in
                input?.cancelForSystemSleep()
                server?.disconnectController()
            }
            server.start(); showWindow()
        } catch {
            let alert = NSAlert(); alert.messageText = "Remote Mac Control could not start"; alert.informativeText = error.localizedDescription; alert.runModal()
            NSApp.terminate(nil)
        }
    }
    @objc private func showWindow() { receiverWindow?.showWindow(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc private func disconnect() { server?.disconnectController() }
    @objc private func quit() { NSApp.terminate(nil) }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return true }
    func applicationWillTerminate(_ notification: Notification) {
        if let sleepObserver { NSWorkspace.shared.notificationCenter.removeObserver(sleepObserver) }
        server?.stop()
    }
    enum StartupError: LocalizedError {
        case invalidPort
        var errorDescription: String? { "REMOTE_MAC_PORT must be an integer between 1 and 65535." }
    }
}

if CommandLine.arguments.contains("--diagnostics") {
    let data = try JSONSerialization.data(withJSONObject: ["permission": AXIsProcessTrusted(), "addresses": LocalNetwork.advertisedAddresses(), "port": Wire.defaultPort, "protocolVersion": Wire.version, "serviceType": Wire.serviceType, "bluetoothServiceUUID": BluetoothWire.serviceUUID], options: [.prettyPrinted, .sortedKeys])
    print(String(decoding: data, as: UTF8.self))
} else if CommandLine.arguments.contains("--verify-input") {
    let app = NSApplication.shared
    let delegate = InputVerification()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
} else {
    let app = NSApplication.shared
    let delegate = ApplicationDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}
