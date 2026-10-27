import AppKit
import ApplicationServices
import ReceiverCore

final class ActionButton: NSButton {
    var handler: (() -> Void)?
    convenience init(_ title: String, handler: @escaping () -> Void) {
        self.init(title: title, target: nil, action: #selector(performAction))
        self.handler = handler; target = self; bezelStyle = .rounded
    }
    @objc private func performAction() { handler?() }
}

private final class TopAlignedClipView: NSClipView {
    override var isFlipped: Bool { true }
}

final class ReceiverWindow: NSWindowController, NSWindowDelegate {
    private let server: ReceiverServer
    private let statusLabel = NSTextField(labelWithString: "Starting receiver…")
    private let bluetoothLabel = NSTextField(labelWithString: "Starting Bluetooth…")
    private let codeLabel = NSTextField(labelWithString: "••••••")
    private let expiresLabel = NSTextField(labelWithString: "")
    private let permissionLabel = NSTextField(wrappingLabelWithString: "Checking Accessibility…")
    private let sessionLabel = NSTextField(labelWithString: "No phone connected")
    private let errorLabel = NSTextField(wrappingLabelWithString: "")
    private let devicesStack = NSStackView()
    private var lastDevices: [TrustedDevice] = []

    init(server: ReceiverServer) {
        self.server = server
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 790), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Remote Mac Control"; window.center(); window.isReleasedWhenClosed = false
        super.init(window: window); window.delegate = self
        build(in: window)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    private func build(in window: NSWindow) {
        guard let content = window.contentView else { return }
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false; content.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 28), stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -28), stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 28)])
        let heading = label("Your Mac, within reach.", size: 26, weight: .semibold)
        stack.addArrangedSubview(heading)
        statusLabel.font = .systemFont(ofSize: 14, weight: .medium); statusLabel.textColor = .systemGreen
        stack.addArrangedSubview(statusLabel)
        bluetoothLabel.font = .systemFont(ofSize: 13, weight: .medium)
        stack.addArrangedSubview(bluetoothLabel)
        let addresses = LocalNetwork.advertisedAddresses()
        let connectionText = addresses.isEmpty ? "No Wi-Fi address. Use Bluetooth or join a local network." : addresses.map { "\($0):\(server.port)" }.joined(separator: "   ·   ")
        let addressLabel = label(connectionText, size: 13); addressLabel.isSelectable = true
        stack.addArrangedSubview(addressLabel)
        stack.addArrangedSubview(label("Bonjour: \(server.name)  •  \(Wire.serviceType)", size: 11, color: .secondaryLabelColor))
        stack.addArrangedSubview(separator())
        stack.addArrangedSubview(label("PAIR YOUR PHONE", size: 11, weight: .semibold, color: .secondaryLabelColor))
        codeLabel.font = .monospacedDigitSystemFont(ofSize: 48, weight: .medium)
        codeLabel.isSelectable = true; codeLabel.setAccessibilityLabel("Pairing code")
        stack.addArrangedSubview(codeLabel)
        expiresLabel.font = .systemFont(ofSize: 12); expiresLabel.textColor = .secondaryLabelColor
        stack.addArrangedSubview(expiresLabel)
        stack.addArrangedSubview(ActionButton("Generate a new code") { [weak server] in server?.rotateCode() })
        stack.addArrangedSubview(separator())
        stack.addArrangedSubview(label("ACCESSIBILITY", size: 11, weight: .semibold, color: .secondaryLabelColor))
        permissionLabel.font = .systemFont(ofSize: 13)
        stack.addArrangedSubview(permissionLabel)
        stack.addArrangedSubview(ActionButton("Open Accessibility Settings") {
            let prompt = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(prompt)
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") { NSWorkspace.shared.open(url) }
        })
        stack.addArrangedSubview(separator())
        let row = NSStackView(); row.orientation = .horizontal; row.spacing = 12
        sessionLabel.font = .systemFont(ofSize: 13, weight: .medium)
        row.addArrangedSubview(sessionLabel)
        row.addArrangedSubview(ActionButton("Disconnect") { [weak server] in server?.disconnectController() })
        stack.addArrangedSubview(row)
        stack.addArrangedSubview(label("TRUSTED PHONES", size: 11, weight: .semibold, color: .secondaryLabelColor))
        devicesStack.orientation = .vertical; devicesStack.alignment = .leading; devicesStack.spacing = 8
        let scroll = NSScrollView(); scroll.contentView = TopAlignedClipView(); scroll.hasVerticalScroller = true; scroll.drawsBackground = false; scroll.documentView = devicesStack
        devicesStack.translatesAutoresizingMaskIntoConstraints = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(scroll)
        NSLayoutConstraint.activate([scroll.widthAnchor.constraint(equalTo: stack.widthAnchor), scroll.heightAnchor.constraint(equalToConstant: 70), devicesStack.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor), devicesStack.topAnchor.constraint(equalTo: scroll.contentView.topAnchor), devicesStack.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor)])
        devicesStack.addArrangedSubview(label("No trusted phones yet.", size: 12, color: .secondaryLabelColor))
        errorLabel.font = .systemFont(ofSize: 12); errorLabel.textColor = .systemRed
        stack.addArrangedSubview(errorLabel)
        let note = label("Wi-Fi traffic is unencrypted; use a trusted private network.\nBluetooth requires encrypted pairing and this app's code.\nClosing this window keeps the receiver in the menu bar.", size: 11, color: .secondaryLabelColor)
        note.maximumNumberOfLines = 3; stack.addArrangedSubview(note)
    }

    func update(_ snapshot: ReceiverServer.Snapshot) {
        statusLabel.stringValue = "Wi-Fi: \(snapshot.status)"
        bluetoothLabel.stringValue = "Bluetooth: \(snapshot.bluetoothStatus)"
        codeLabel.stringValue = snapshot.code
        let remaining = max(0, Int(snapshot.expiresAt.timeIntervalSinceNow))
        expiresLabel.stringValue = "Enter this code in the phone app. Expires in \(remaining)s."
        permissionLabel.stringValue = snapshot.permission ? "Allowed. This Mac can receive mouse and keyboard input." : "Permission required. Enable Remote Mac Control in Accessibility to let your phone move the cursor and type."
        permissionLabel.textColor = snapshot.permission ? .systemGreen : .systemOrange
        sessionLabel.stringValue = snapshot.deviceName.map { "\($0) · \(snapshot.activeTransport?.rawValue ?? "Connected")" } ?? "No phone connected"
        errorLabel.stringValue = snapshot.error ?? ""
        if snapshot.devices != lastDevices {
            lastDevices = snapshot.devices
            devicesStack.arrangedSubviews.forEach { devicesStack.removeArrangedSubview($0); $0.removeFromSuperview() }
            if snapshot.devices.isEmpty { devicesStack.addArrangedSubview(label("No trusted phones yet.", size: 12, color: .secondaryLabelColor)) }
            for device in snapshot.devices {
                let row = NSStackView(); row.orientation = .horizontal; row.spacing = 16
                row.addArrangedSubview(label(device.name, size: 12))
                row.addArrangedSubview(ActionButton("Revoke") { [weak server] in server?.revoke(device.id) })
                devicesStack.addArrangedSubview(row)
            }
        }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); return false }
    private func label(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor = .labelColor) -> NSTextField {
        let field = NSTextField(labelWithString: text); field.font = .systemFont(ofSize: size, weight: weight); field.textColor = color; return field
    }
    private func separator() -> NSView { let box = NSBox(); box.boxType = .separator; return box }
}
