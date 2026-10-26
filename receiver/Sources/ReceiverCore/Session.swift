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
    public var onChange: (() -> Void)?
    public var authenticated: Bool { deviceID != nil }

    public init(pairing: PairingManager, input: InputController, serverID: String, name: String,
                permission: @escaping () -> Bool, acquire: @escaping (UUID) -> Bool,
                relinquish: @escaping (UUID) -> Void, send: @escaping (Data) -> Void,
                cancel: @escaping () -> Void, now: @escaping () -> Date = Date.init,
                log: @escaping (String) -> Void = ReceiverCommandLog.write) {
        self.pairing = pairing; self.input = input; self.serverID = serverID; self.name = name
        self.hasPermission = permission; self.acquire = acquire; self.relinquish = relinquish
        self.send = send; self.cancel = cancel; self.now = now; self.log = log
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
            if message.kind == .releaseAll { input.releaseAll(); result = "released"; return }
            guard hasPermission() else {
                result = "permission_required"; input.releaseAll(); connection("permission_required"); return
            }
            if message.kind == .mouseGesture && message.string("gesture") == "swipe" && message.number("fingers") == 2 && ["up", "down"].contains(message.string("direction")) {
                reject("unsupported_gesture", "Two-finger vertical swipes are scrolling; send mouse_scroll instead."); return
            }
            input.handle(message)
            result = "dispatched"
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
        send(WireProtocol.encode(.connection, fields: ["state": state, "serverId": serverID, "name": name, "permission": hasPermission(), "capabilities": ["pointer", "buttons", "scroll", "keyboard", "unicode", "zoom_shortcuts", "space_shortcuts"]]))
    }
    private func fail(_ code: String, _ message: String, close: Bool = false) {
        send(WireProtocol.encode(.error, fields: ["code": code, "message": message]))
        if close { disconnect() }
    }
}
