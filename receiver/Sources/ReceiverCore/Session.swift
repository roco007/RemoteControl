import Foundation

/// Called serially by the listener. Sessions never post input before authentication and permission checks.
public final class ReceiverSession {
    public let id = UUID()
    public private(set) var deviceID: String?
    public private(set) var deviceName: String?
    public private(set) var lastActivity: Date
    public let createdAt: Date
    public private(set) var closed = false
    private var lastSequence: Int64 = -1
    private var rateWindow: Date
    private var rateCount = 0
    private var catalogSnapshot: [InstalledApplication]?
    private var catalogPending = false
    private var lastPermission: Bool
    private let pairing: PairingManager
    private let input: InputController
    private let serverID: String
    private let name: String
    private let hasPermission: () -> Bool
    private let acquire: (UUID) -> Bool
    private let relinquish: (UUID) -> Void
    private let send: (Data) -> Void
    private let cancel: () -> Void
    private let now: () -> Date
    private let log: (String) -> Void
    private let executeCompletion: (@escaping () -> Void) -> Void
    public var onChange: (() -> Void)?
    public var authenticated: Bool { deviceID != nil }

    public init(pairing: PairingManager, input: InputController, serverID: String, name: String,
                permission: @escaping () -> Bool, acquire: @escaping (UUID) -> Bool,
                relinquish: @escaping (UUID) -> Void, send: @escaping (Data) -> Void,
                cancel: @escaping () -> Void, now: @escaping () -> Date = Date.init,
                log: @escaping (String) -> Void = ReceiverCommandLog.write,
                executeCompletion: @escaping (@escaping () -> Void) -> Void = { $0() }) {
        self.pairing = pairing; self.input = input; self.serverID = serverID; self.name = name
        self.hasPermission = permission; self.acquire = acquire; self.relinquish = relinquish
        self.send = send; self.cancel = cancel; self.now = now; self.log = log
        self.executeCompletion = executeCompletion
        createdAt = now(); lastActivity = createdAt; rateWindow = createdAt; lastPermission = permission()
    }

    public func hello() { connection("hello") }

    public func receive(_ data: Data) {
        guard !closed else { return }
        let time = now()
        var loggedMessage: WireMessage?
        var result = "received"
        defer {
            log(ReceiverCommandLog.format(receivedAt: time, sessionID: id, deviceID: deviceID,
                                          message: loggedMessage, byteCount: data.count, result: result))
        }
        func reject(_ code: String, _ message: String, close: Bool = false) {
            result = code
            fail(code, message, close: close)
        }
        if time.timeIntervalSince(rateWindow) >= 1 { rateWindow = time; rateCount = 0 }
        rateCount += 1
        guard rateCount <= 300 else { reject("rate_limited", "Input rate exceeded. Reconnect and try again.", close: true); return }
        let message: WireMessage
        do { message = try WireProtocol.decode(data) }
        catch { reject("malformed_message", "Invalid protocol message.", close: true); return }
        loggedMessage = message
        guard message.kind.isClient else { reject("invalid_direction", "Expected a client message.", close: true); return }
        guard message.sequence > lastSequence else { reject("replayed_message", "Message sequence must increase.", close: true); return }
        lastSequence = message.sequence; lastActivity = time
        switch message.kind {
        case .authentication:
            guard !authenticated else { reject("already_authenticated", "This connection is already authenticated."); return }
            // Acquire before pairing so a busy receiver neither consumes the code nor grants a new credential.
            guard acquire(id) else { connection("busy"); reject("receiver_busy", "Another phone currently controls this Mac.", close: true); return }
            let authentication = pairing.authenticate(deviceID: message.string("deviceId"), name: message.string("deviceName"), code: message.fields["code"] as? String, token: message.fields["token"] as? String)
            result = authentication.accepted ? "authenticated" : "authentication_failed"
            var fields: [String: Any] = ["ok": authentication.accepted, "serverId": serverID, "permission": hasPermission()]
            if let token = authentication.token { fields["token"] = token }
            if let error = authentication.error { fields["error"] = error }
            if authentication.accepted {
                deviceID = message.string("deviceId"); deviceName = message.string("deviceName")
            } else { relinquish(id) }
            send(WireProtocol.encode(.authenticationResult, seq: message.sequence, fields: fields))
            if authentication.accepted { connection(hasPermission() ? "ready" : "permission_required") }
            onChange?()
        case .ping:
            send(WireProtocol.encode(.pong, seq: message.sequence, fields: ["id": message.string("id")]))
            result = "pong"
        default:
            guard authenticated else { reject("authentication_required", "Pair this phone before controlling the Mac.", close: true); return }
            if message.kind == .appsList { listApplications(message); result = "catalog_requested"; return }
            if message.kind == .releaseAll { input.releaseAll(); result = "released"; return }
            if message.kind == .systemActionStatus, let deviceID, let action = SystemAction(rawValue: message.string("action")) {
                actionResult(message, input.actionStatus(device: deviceID, id: message.string("id"), action: action))
                result = "action_status"; return
            }
            guard hasPermission() else {
                result = "permission_required"; input.releaseAll(); connection("permission_required")
                if message.kind == .systemAction { handleInput(message, systemActionAllowed: false) }
                return
            }
            if message.kind == .mouseGesture && message.string("gesture") == "swipe" && message.number("fingers") == 2 && ["up", "down"].contains(message.string("direction")) {
                reject("unsupported_gesture", "Two-finger vertical swipes are scrolling; send mouse_scroll instead."); return
            }
            handleInput(message)
            result = "dispatched"
        }
    }

    private func handleInput(_ message: WireMessage, systemActionAllowed: Bool = true) {
        input.handle(message, deviceID: deviceID, systemActionAllowed: systemActionAllowed) { [weak self] outcome in
            self?.executeCompletion { [weak self] in
                guard let self, !self.closed else { return }
                self.actionResult(message, outcome)
            }
        }
    }

    public func tick() {
        guard !closed else { return }
        if !authenticated && now().timeIntervalSince(createdAt) > 30 { fail("authentication_timeout", "Pairing timed out. Reconnect to try again.", close: true); return }
        if authenticated && now().timeIntervalSince(lastActivity) > 20 { fail("heartbeat_timeout", "Connection timed out.", close: true); return }
        let permitted = hasPermission()
        if permitted != lastPermission {
            lastPermission = permitted
            if authenticated {
                if !permitted { input.releaseAll() }
                connection(permitted ? "ready" : "permission_required")
            }
            onChange?()
        }
    }

    public func disconnect() {
        guard !closed else { return }; closed = true
        if authenticated { input.releaseAll() }
        relinquish(id); cancel(); onChange?()
    }
    public func revoke() { fail("device_revoked", "This phone was revoked on the Mac. Pair again.", close: true) }
    private func connection(_ state: String) {
        send(WireProtocol.encode(.connection, fields: ["state": state, "serverId": serverID, "name": name, "permission": hasPermission(), "capabilities": ["pointer", "buttons", "scroll", "keyboard", "unicode", "zoom_shortcuts", "space_shortcuts", "system_actions", "photo_booth", "system_adjust", "action_completion", "app_catalog", "open_app", "run_command", "open_url"]]))
    }
    private func listApplications(_ request: WireMessage) {
        let cursor = Int(request.number("cursor"))
        guard !catalogPending else { catalogPage(request, cursor: 0, apps: [], error: "An application refresh is already running."); return }
        if cursor > 0 {
            guard let apps = catalogSnapshot, cursor <= apps.count else { catalogPage(request, cursor: 0, apps: [], error: "Refresh the application list and try again."); return }
            catalogPage(request, cursor: cursor, apps: apps); return
        }
        catalogPending = true
        input.listApplications(refresh: true) { [weak self] apps, error in
            self?.executeCompletion { [weak self] in
                guard let self, !self.closed else { return }
                self.catalogPending = false
                let validApps = apps.filter { !$0.id.isEmpty && $0.id.utf16.count <= 2048 && !$0.name.isEmpty && $0.name.utf16.count <= 160 }.map { app in
                    let icon = app.icon.flatMap { $0.utf16.count <= 8192 && $0.range(of: "^data:image/png;base64,[A-Za-z0-9+/]+=*$", options: .regularExpression) != nil ? $0 : nil }
                    return InstalledApplication(id: app.id, name: app.name, icon: icon)
                }
                self.catalogSnapshot = error == nil ? validApps : nil
                self.catalogPage(request, cursor: 0, apps: error == nil ? validApps : [], error: error)
            }
        }
    }
    private func catalogPage(_ request: WireMessage, cursor: Int, apps: [InstalledApplication], error: String? = nil) {
        var fields: [String: Any] = ["id": request.string("id"), "apps": [[String: Any]]()]
        if let error { fields["error"] = String(decoding: error.utf16.prefix(240), as: UTF16.self) }
        var page: [[String: Any]] = [], end = cursor
        while end < apps.count && page.count < 100 {
            var candidate = apps[end].fields
            fields["apps"] = page + [candidate]; fields["nextCursor"] = end + 1
            if WireProtocol.encode(.appsListResult, seq: request.sequence, fields: fields).count > Wire.maxMessageBytes {
                if !page.isEmpty { break }
                candidate.removeValue(forKey: "icon")
            }
            page.append(candidate); end += 1
        }
        fields["apps"] = page
        if end < apps.count { fields["nextCursor"] = end } else { fields.removeValue(forKey: "nextCursor") }
        send(WireProtocol.encode(.appsListResult, seq: request.sequence, fields: fields))
    }
    private func actionResult(_ request: WireMessage, _ outcome: SystemActionOutcome) {
        guard let id = request.fields["id"] as? String else { return }
        var fields: [String: Any] = ["id": id, "action": request.string("action"), "ok": outcome.ok]
        if let message = outcome.message { fields["message"] = message }
        if let state = outcome.state { fields["state"] = state }
        send(WireProtocol.encode(.systemActionResult, seq: request.sequence, fields: fields))
    }
    private func fail(_ code: String, _ message: String, close: Bool = false) {
        send(WireProtocol.encode(.error, fields: ["code": code, "message": message]))
        if close { disconnect() }
    }
}
