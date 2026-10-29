import Foundation
import CoreFoundation

public enum MessageKind: String, CaseIterable {
    case connection, authentication, authenticationResult = "authentication_result"
    case mouseMove = "mouse_move", mouseDown = "mouse_down", mouseUp = "mouse_up", mouseClick = "mouse_click"
    case mouseScroll = "mouse_scroll", mouseGesture = "mouse_gesture"
    case keyboardDown = "keyboard_down", keyboardUp = "keyboard_up", keyboardText = "keyboard_text"
    case systemAction = "system_action", systemActionResult = "system_action_result", systemActionStatus = "system_action_status", systemAdjust = "system_adjust"
    case appsList = "apps_list", appsListResult = "apps_list_result"
    case releaseAll = "release_all", ping, pong, error

    public var isClient: Bool { ![.connection, .authenticationResult, .systemActionResult, .appsListResult, .pong, .error].contains(self) }
}

public struct WireMessage {
    public let kind: MessageKind
    public let sequence: Int64
    public let fields: [String: Any]
    public func string(_ key: String) -> String { fields[key] as? String ?? "" }
    public func number(_ key: String) -> Double { (fields[key] as? NSNumber)?.doubleValue ?? 0 }
    public func bool(_ key: String) -> Bool { fields[key] as? Bool ?? false }
    public var modifiers: [String] { fields["modifiers"] as? [String] ?? [] }
}

public enum ProtocolError: Error, Equatable { case malformed, oversized, invalid }

public enum WireProtocol {
    private static let base = Set(["v", "type", "seq", "timestamp"])
    private static let fields: [MessageKind: Set<String>] = [
        .connection: ["state", "serverId", "name", "permission", "capabilities"],
        .authentication: ["deviceId", "deviceName", "code", "token"],
        .authenticationResult: ["ok", "serverId", "permission", "token", "error"],
        .mouseMove: ["dx", "dy"], .mouseScroll: ["dx", "dy"], .mouseDown: ["button"], .mouseUp: ["button"], .mouseClick: ["button", "count"],
        .mouseGesture: ["gesture", "amount", "direction", "fingers"], .keyboardDown: ["key", "modifiers", "repeat"], .keyboardUp: ["key", "modifiers"],
        .keyboardText: ["text"], .systemAction: ["action", "id", "appId", "command", "url"], .systemActionStatus: ["action", "id"], .systemActionResult: ["action", "id", "ok", "message", "state"],
        .appsList: ["id", "cursor"], .appsListResult: ["id", "apps", "nextCursor", "error"],
        .systemAdjust: ["control", "steps"], .releaseAll: [], .ping: ["id"], .pong: ["id"], .error: ["code", "message"]
    ]

    public static func decode(_ data: Data) throws -> WireMessage {
        guard data.count <= Wire.maxMessageBytes else { throw ProtocolError.oversized }
        guard let parsed = try? JSONSerialization.jsonObject(with: data), let object = parsed as? [String: Any] else { throw ProtocolError.malformed }
        return try validate(object)
    }

    public static func validate(_ m: [String: Any]) throws -> WireMessage {
        guard numeric(m["v"]) == Double(Wire.version), let type = m["type"] as? String,
              let kind = MessageKind(rawValue: type), integer(m["seq"]), integer(m["timestamp"]),
              Set(m.keys).isSubset(of: base.union(fields[kind] ?? [])) else { throw ProtocolError.invalid }
        let valid: Bool
        switch kind {
        case .authentication:
            let code = matches(m["code"], pattern: "^[0-9]{6}$") && m["token"] == nil
            let token = validToken(m["token"]) && m["code"] == nil
            valid = uuid(m["deviceId"]) && string(m["deviceName"], max: 80) && (code || token)
        case .connection:
            valid = member(m["state"], ["hello", "ready", "permission_required", "busy"]) && uuid(m["serverId"]) && string(m["name"], max: 80) && boolean(m["permission"]) && stringArray(m["capabilities"], maxCount: 20, maxLength: 40)
        case .authenticationResult:
            valid = boolean(m["ok"]) && uuid(m["serverId"]) && boolean(m["permission"]) && (m["token"] == nil || validToken(m["token"])) && (m["error"] == nil || string(m["error"], max: 240))
        case .mouseMove, .mouseScroll:
            valid = bounded(m["dx"], max: Double(Wire.maxDelta)) && bounded(m["dy"], max: Double(Wire.maxDelta))
        case .mouseDown, .mouseUp:
            valid = member(m["button"], Wire.buttons)
        case .mouseClick:
            valid = member(m["button"], Wire.buttons) && [1.0, 2.0].contains(numeric(m["count"]) ?? -1)
        case .mouseGesture:
            if m["gesture"] as? String == "zoom" {
                valid = bounded(m["amount"], max: 1) && m["direction"] == nil && m["fingers"] == nil
            } else {
                valid = m["gesture"] as? String == "swipe" && member(m["direction"], Wire.directions) && [2.0, 3.0, 4.0].contains(numeric(m["fingers"]) ?? -1) && m["amount"] == nil
            }
        case .keyboardDown, .keyboardUp:
            let modifiers = m["modifiers"] as? [String]
            valid = member(m["key"], Wire.keys) && modifiers != nil && modifiers!.count <= 4 && Set(modifiers!).count == modifiers!.count && modifiers!.allSatisfy { Wire.modifiers.contains($0) } && (kind != .keyboardDown || boolean(m["repeat"]))
        case .keyboardText: valid = string(m["text"], max: Wire.maxTextLength)
        case .systemAction:
            let action = m["action"] as? String
            let parameters: Bool
            if action == "open_app" {
                parameters = string(m["id"], max: 64) && string(m["appId"], max: 2048) && !(m["appId"] as? String ?? "").contains("\0") && m["command"] == nil && m["url"] == nil
            } else if action == "run_command" {
                parameters = string(m["id"], max: 64) && string(m["command"], max: 4096) && !(m["command"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !(m["command"] as? String ?? "").contains("\0") && m["appId"] == nil && m["url"] == nil
            } else if action == "open_url" {
                parameters = string(m["id"], max: 64) && (m["url"] as? String).flatMap(HTTPURL.parse) != nil && m["appId"] == nil && m["command"] == nil
            } else { parameters = m["appId"] == nil && m["command"] == nil && m["url"] == nil }
            valid = member(m["action"], Wire.systemActions) && (m["id"] == nil || string(m["id"], max: 64)) && parameters
        case .appsList:
            valid = string(m["id"], max: 64) && (m["cursor"] == nil || integer(m["cursor"]))
        case .appsListResult:
            let apps = m["apps"] as? [[String: Any]]
            valid = string(m["id"], max: 64) && apps != nil && apps!.count <= 100 && apps!.allSatisfy { app in
                Set(app.keys).isSubset(of: ["id", "name", "icon"]) && string(app["id"], max: 2048) && string(app["name"], max: 160) &&
                    (app["icon"] == nil || (string(app["icon"], max: 8192) && matches(app["icon"], pattern: "^data:image/png;base64,[A-Za-z0-9+/]+=*$")))
            } && (m["nextCursor"] == nil || integer(m["nextCursor"])) && (m["error"] == nil || string(m["error"], max: 240))
        case .systemActionStatus: valid = member(m["action"], Wire.systemActions) && string(m["id"], max: 64)
        case .systemActionResult:
            valid = member(m["action"], Wire.systemActions) && string(m["id"], max: 64) && boolean(m["ok"]) &&
                (m["message"] == nil || string(m["message"], max: 240)) &&
                (m["state"] == nil || (member(m["state"], ["running", "unknown"]) && m["ok"] as? Bool == false))
        case .systemAdjust:
            let steps = numeric(m["steps"])
            valid = member(m["control"], Wire.systemControls) && steps.map { $0 != 0 && abs($0) <= Double(Wire.maxSystemAdjustSteps) && $0.rounded(.towardZero) == $0 } == true
        case .releaseAll: valid = true
        case .ping, .pong: valid = string(m["id"], max: 64)
        case .error: valid = string(m["code"], max: 64) && string(m["message"], max: 240)
        }
        guard valid else { throw ProtocolError.invalid }
        return WireMessage(kind: kind, sequence: Int64(numeric(m["seq"])!), fields: m)
    }

    public static func encode(_ kind: MessageKind, seq: Int64 = 0, fields: [String: Any] = [:]) -> Data {
        var body = fields
        body["v"] = Wire.version; body["type"] = kind.rawValue
        body["seq"] = seq; body["timestamp"] = Int64(Date().timeIntervalSince1970 * 1000)
        return (try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])) ?? Data()
    }

    private static func numeric(_ value: Any?) -> Double? {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { return nil }
        let d = value.doubleValue
        return d.isFinite ? d : nil
    }
    private static func integer(_ value: Any?) -> Bool {
        guard let d = numeric(value) else { return false }
        return d >= 0 && d <= 9_007_199_254_740_991 && d.rounded(.towardZero) == d
    }
    private static func bounded(_ value: Any?, max: Double) -> Bool {
        guard let d = numeric(value) else { return false }; return abs(d) <= max
    }
    private static func boolean(_ value: Any?) -> Bool {
        guard let n = value as? NSNumber else { return false }; return CFGetTypeID(n) == CFBooleanGetTypeID()
    }
    private static func string(_ value: Any?, max: Int) -> Bool {
        guard let value = value as? String else { return false }; return !value.isEmpty && value.utf16.count <= max
    }
    private static func member(_ value: Any?, _ values: [String]) -> Bool { (value as? String).map(values.contains) ?? false }
    private static func stringArray(_ value: Any?, maxCount: Int, maxLength: Int) -> Bool {
        guard let values = value as? [String] else { return false }
        return values.count <= maxCount && values.allSatisfy { string($0, max: maxLength) }
    }
    private static func matches(_ value: Any?, pattern: String) -> Bool {
        guard let text = value as? String else { return false }; return text.range(of: pattern, options: .regularExpression) != nil
    }
    private static func uuid(_ value: Any?) -> Bool { matches(value, pattern: "^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$") }
    private static func validToken(_ value: Any?) -> Bool { matches(value, pattern: "^[a-f0-9]{64}$") }
}
