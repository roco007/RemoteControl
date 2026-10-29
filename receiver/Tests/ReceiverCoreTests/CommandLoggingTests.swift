import Foundation
import Testing
@testable import ReceiverCore

final class CommandLoggingTests {
    private func record(_ h: SessionHarness, index: Int? = nil) throws -> [String: Any] {
        let line = h.commandLogs[index ?? (h.commandLogs.count - 1)]
        expectFalse(line.contains("\n"))
        return try unwrap(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
    }

    @Test func testEveryCommandIsLoggedOnceWithShortcutDetailsAndSession() throws {
        let h = try SessionHarness(); h.pair()
        let commands: [(MessageKind, [String: Any])] = [
            (.mouseMove, ["dx": 12, "dy": -4]),
            (.mouseDown, ["button": "left"]), (.mouseUp, ["button": "left"]),
            (.mouseClick, ["button": "right", "count": 2]),
            (.mouseScroll, ["dx": -3, "dy": 20]),
            (.mouseGesture, ["gesture": "swipe", "direction": "up", "fingers": 3]),
            (.keyboardDown, ["key": "up", "modifiers": ["control"], "repeat": false]),
            (.keyboardUp, ["key": "up", "modifiers": ["control"]]),
            (.keyboardText, ["text": "Private composed text"]),
            (.systemAction, ["action": "screenshot"]),
            (.systemActionStatus, ["id": "status-probe", "action": "screenshot"]),
            (.appsList, ["id": "catalog-probe"]),
            (.systemAdjust, ["control": "brightness", "steps": -3]),
            (.releaseAll, [:]), (.ping, ["id": "probe\nsecond line"])
        ]
        for (offset, command) in commands.enumerated() {
            h.receive(command.0, seq: Int64(offset + 2), command.1)
        }
        expectEqual(h.commandLogs.count, commands.count + 1)
        var kinds = Set<String>()
        for index in h.commandLogs.indices {
            let entry = try record(h, index: index)
            let command = try unwrap(entry["command"] as? [String: Any])
            kinds.insert(try unwrap(command["type"] as? String))
            expectEqual(entry["sessionId"] as? String, h.session.id.uuidString.lowercased())
            expectEqual(entry["deviceId"] as? String, h.session.deviceID)
            expectTrue(entry["receivedAt"] is String)
            expectEqual((command["seq"] as? NSNumber)?.intValue, index + 1)
            if command["type"] as? String == "system_action" {
                expectEqual(command["action"] as? String, "screenshot")
                expectEqual(entry["result"] as? String, "dispatched")
            }
            if command["type"] as? String == "system_adjust" {
                expectEqual(command["control"] as? String, "brightness")
                expectEqual((command["steps"] as? NSNumber)?.intValue, -3)
                expectEqual(entry["result"] as? String, "dispatched")
            }
            if command["type"] as? String == "keyboard_down" {
                expectEqual(command["key"] as? String, "up")
                expectEqual(command["modifiers"] as? [String], ["control"])
                expectEqual(entry["result"] as? String, "dispatched")
            }
        }
        expectEqual(kinds, Set(MessageKind.allCases.filter(\.isClient).map(\.rawValue)))
        expectEqual(try record(h)["result"] as? String, "pong")
    }

    @Test func testCredentialsAndComposedTextAreRedacted() throws {
        let h = try SessionHarness(); let code = h.pairing.code; h.pair()
        let auth = try unwrap(try record(h)["command"] as? [String: Any])
        expectEqual(auth["code"] as? String, "<redacted>")
        expectFalse(h.commandLogs[0].contains("\"code\":\"\(code)\""))
        let token = try unwrap(h.responses.first(where: { $0.kind == .authenticationResult })?.fields["token"] as? String)
        h.receive(.authentication, seq: 2, ["deviceId": h.session.deviceID!, "deviceName": "Phone", "token": token])
        expectFalse(h.commandLogs.last!.contains(token))
        expectEqual((try record(h)["command"] as? [String: Any])?["token"] as? String, "<redacted>")
        h.receive(.keyboardText, seq: 3, ["text": "Private\n👋"])
        let text = try unwrap(try record(h)["command"] as? [String: Any])
        expectEqual(text["text"] as? String, "<redacted>")
        expectEqual((text["textLength"] as? NSNumber)?.intValue, "Private\n👋".utf16.count)
        expectFalse(h.commandLogs.last!.contains("Private"))
    }

    @Test func testDroppedCommandsLogTheirReason() throws {
        let unauthenticated = try SessionHarness()
        unauthenticated.receive(.mouseMove, seq: 1, ["dx": 1, "dy": 2])
        expectEqual(try record(unauthenticated)["result"] as? String, "authentication_required")
        let h = try SessionHarness(); h.pair(); h.permission = false
        h.receive(.keyboardDown, seq: 2, ["key": "up", "modifiers": ["control"], "repeat": false])
        expectEqual(try record(h)["result"] as? String, "permission_required")
        h.receive(.releaseAll, seq: 3)
        expectEqual(try record(h)["result"] as? String, "released")
        h.permission = true
        h.receive(.mouseGesture, seq: 4, ["gesture": "swipe", "direction": "up", "fingers": 2])
        expectEqual(try record(h)["result"] as? String, "unsupported_gesture")
        h.receive(.mouseMove, seq: 4, ["dx": 1, "dy": 2])
        expectEqual(try record(h)["result"] as? String, "replayed_message")
        expectEqual(h.commandLogs.count, 5)
    }

    @Test func testFailedPairingAndBusyReceiverAreLogged() throws {
        let h = try SessionHarness()
        h.receive(.authentication, seq: 1, ["deviceId": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "deviceName": "Phone", "code": h.pairing.code == "000000" ? "111111" : "000000"])
        expectEqual(try record(h)["result"] as? String, "authentication_failed")
        let busy = try SessionHarness(); busy.owner = UUID(); busy.pair()
        expectEqual(try record(busy)["result"] as? String, "receiver_busy")
    }

    @Test func testMalformedAndRateLimitedPayloadsDoNotLogRawContent() throws {
        let h = try SessionHarness()
        let raw = Data("{\"token\":\"secret-invalid-token\",\"extra\":\"private\"}".utf8)
        h.session.receive(raw)
        let entry = try record(h)
        expectEqual(entry["result"] as? String, "malformed_message")
        expectNil(entry["command"])
        expectEqual((entry["messageBytes"] as? NSNumber)?.intValue, raw.count)
        expectFalse(h.commandLogs[0].contains("secret-invalid-token"))
        expectFalse(h.commandLogs[0].contains("private"))
        let limited = try SessionHarness()
        for sequence in 1...301 { limited.receive(.ping, seq: Int64(sequence), ["id": "probe"]) }
        expectEqual(limited.commandLogs.count, 301)
        expectEqual(try record(limited)["result"] as? String, "rate_limited")
        expectNil(try record(limited)["command"])
    }
}
