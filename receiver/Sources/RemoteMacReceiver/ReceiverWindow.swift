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

private final class TopAlignedDocumentView: NSView {
    override var isFlipped: Bool { true }
}

final class ReceiverWindow: NSWindowController, NSWindowDelegate {
    private let server: ReceiverServer
    private let unlockCredentials: MacUnlockCredentialStore
    private let statusLabel = NSTextField(labelWithString: "Starting receiver…")
    private let bluetoothLabel = NSTextField(labelWithString: "Starting Bluetooth…")
    private let codeLabel = NSTextField(labelWithString: "••••••")
    private let expiresLabel = NSTextField(labelWithString: "")
    private let permissionLabel = NSTextField(wrappingLabelWithString: "Checking Accessibility…")
    private let sessionLabel = NSTextField(labelWithString: "No phone connected")
    private let errorLabel = NSTextField(wrappingLabelWithString: "")
    private let unlockPasswordField = NSSecureTextField()
    private let unlockConfigurationLabel = NSTextField(wrappingLabelWithString: "")
    private let lockStatusLabel = NSTextField(wrappingLabelWithString: "")
    private let devicesStack = NSStackView()
    private var lastDevices: [TrustedDevice] = []

    init(server: ReceiverServer, unlockCredentials: MacUnlockCredentialStore) {
        self.server = server
        self.unlockCredentials = unlockCredentials
        let screenHeight = NSScreen.main?.visibleFrame.height ?? 800
        let height = max(420, min(740, screenHeight - 80))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: height), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.contentMinSize = NSSize(width: 520, height: 420)
        window.title = "Remote Mac Control"; window.center(); window.isReleasedWhenClosed = false
        super.init(window: window); window.delegate = self
        build(in: window)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    private func build(in window: NSWindow) {
        guard let content = window.contentView else { return }
        let contentScroll = NSScrollView()
        contentScroll.contentView = TopAlignedClipView()
        contentScroll.hasVerticalScroller = true
        contentScroll.drawsBackground = false
        contentScroll.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(contentScroll)
        let document = TopAlignedDocumentView()
        document.translatesAutoresizingMaskIntoConstraints = false
        contentScroll.documentView = document
        NSLayoutConstraint.activate([
            contentScroll.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            contentScroll.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            contentScroll.topAnchor.constraint(equalTo: content.topAnchor),
            contentScroll.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            document.leadingAnchor.constraint(equalTo: contentScroll.contentView.leadingAnchor),
            document.topAnchor.constraint(equalTo: contentScroll.contentView.topAnchor),
            document.widthAnchor.constraint(equalTo: contentScroll.contentView.widthAnchor)
        ])
        let stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false; document.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 28),
            stack.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -28),
            stack.topAnchor.constraint(equalTo: document.topAnchor, constant: 28),
            stack.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -28)
        ])
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
        stack.addArrangedSubview(label("LOCK / UNLOCK MAC", size: 11, weight: .semibold, color: .secondaryLabelColor))
        let unlockNote = NSTextField(wrappingLabelWithString: "Save this Mac's login password to unlock with the Left gesture. It stays in this Mac's Keychain. Sign in manually once after restarting your Mac.")
        unlockNote.font = .systemFont(ofSize: 12)
        unlockNote.textColor = .secondaryLabelColor
        stack.addArrangedSubview(unlockNote)
        unlockPasswordField.placeholderString = "Mac login password"
        unlockPasswordField.setAccessibilityLabel("Mac login password")
        unlockPasswordField.font = .systemFont(ofSize: 13)
        unlockPasswordField.translatesAutoresizingMaskIntoConstraints = false
        stack.addArrangedSubview(unlockPasswordField)
        unlockPasswordField.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        let passwordActions = NSStackView(); passwordActions.orientation = .horizontal; passwordActions.spacing = 12
        passwordActions.addArrangedSubview(ActionButton("Save password") { [weak self] in self?.saveUnlockPassword() })
        passwordActions.addArrangedSubview(ActionButton("Remove password") { [weak self] in self?.removeUnlockPassword() })
        stack.addArrangedSubview(passwordActions)
        unlockConfigurationLabel.font = .systemFont(ofSize: 12)
        stack.addArrangedSubview(unlockConfigurationLabel)
        lockStatusLabel.font = .systemFont(ofSize: 12)
        lockStatusLabel.textColor = .secondaryLabelColor
        stack.addArrangedSubview(lockStatusLabel)
        refreshUnlockConfiguration()
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
        for field in [permissionLabel, unlockNote, unlockConfigurationLabel, lockStatusLabel, errorLabel] {
            field.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
    }

    private func saveUnlockPassword() {
        defer { unlockPasswordField.stringValue = "" }
        do {
            try unlockCredentials.save(unlockPasswordField.stringValue)
            refreshUnlockConfiguration()
            showLockStatus("Password saved. Use the Left gesture to lock or unlock this Mac.")
        } catch {
            showLockStatus(error.localizedDescription)
        }
    }

    private func removeUnlockPassword() {
        unlockPasswordField.stringValue = ""
        do {
            try unlockCredentials.clear()
            refreshUnlockConfiguration()
            showLockStatus("Saved password removed from this Mac's Keychain.")
        } catch {
            showLockStatus(error.localizedDescription)
        }
    }

    private func refreshUnlockConfiguration() {
        do {
            switch try unlockCredentials.configuration() {
            case .environment:
                unlockConfigurationLabel.stringValue = "Unlock uses the receiver's MAC_UNLOCK_TEXT environment override. Remove that override to use a saved password."
                unlockConfigurationLabel.textColor = .secondaryLabelColor
            case .keychain:
                unlockConfigurationLabel.stringValue = "Unlock password saved on this Mac."
                unlockConfigurationLabel.textColor = .systemGreen
            case .notConfigured:
                unlockConfigurationLabel.stringValue = unlockCredentials.hasEnvironmentOverride
                    ? "Unlock is disabled by an empty MAC_UNLOCK_TEXT environment override. Remove that override to use a saved password."
                    : "No unlock password configured. The Left gesture can still lock this Mac."
                unlockConfigurationLabel.textColor = .secondaryLabelColor
            }
        } catch {
            unlockConfigurationLabel.stringValue = error.localizedDescription
            unlockConfigurationLabel.textColor = .systemOrange
        }
    }

    func showLockStatus(_ message: String) {
        lockStatusLabel.stringValue = message
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
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        unlockPasswordField.stringValue = ""
        sender.orderOut(nil)
        return false
    }
    private func label(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor = .labelColor) -> NSTextField {
        let field = NSTextField(labelWithString: text); field.font = .systemFont(ofSize: size, weight: weight); field.textColor = color; return field
    }
    private func separator() -> NSView { let box = NSBox(); box.boxType = .separator; return box }
}
