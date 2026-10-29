import Foundation
import OSLog

/// One structured line per incoming protocol command, usable from a terminal or Console.app.
public enum ReceiverCommandLog {
    private static let logger = Logger(subsystem: "com.remotemac.receiver", category: "commands")
    private static let timestampFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    public static func write(_ line: String) {
        // Explicit public visibility is safe only after format() has removed credentials/text.
        logger.info("\(line, privacy: .public)")
        // Avoid stdout buffering so piped/foreground logs appear as soon as a command arrives.
        try? FileHandle.standardOutput.write(contentsOf: Data((line + "\n").utf8))
    }

    static func format(receivedAt: Date, sessionID: UUID, deviceID: String?,
                       message: WireMessage?, byteCount: Int, result: String) -> String {
        var record: [String: Any] = [
            "receivedAt": timestampFormatter.string(from: receivedAt),
            "sessionId": sessionID.uuidString.lowercased(),
            "messageBytes": byteCount,
            "result": result
        ]
        if let deviceID { record["deviceId"] = deviceID }
        if let message {
            var command = message.fields
            if message.kind == .authentication, command["code"] != nil { command["code"] = "<redacted>" }
            if command["token"] != nil { command["token"] = "<redacted>" }
            if message.kind == .keyboardText {
                command["textLength"] = message.string("text").utf16.count
                command["text"] = "<redacted>"
            }
            if command["command"] != nil {
                command["commandLength"] = message.string("command").utf16.count
                command["command"] = "<redacted>"
            }
            if command["url"] != nil {
                command["urlLength"] = message.string("url").utf16.count
                command["url"] = "<redacted>"
            }
            record["command"] = command
        }
        // Invalid/rate-limited payloads are never copied into logs, even partially.
        guard let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) else {
            return "{\"result\":\"command_log_encoding_failed\"}"
        }
        return String(decoding: data, as: UTF8.self)
    }
}
