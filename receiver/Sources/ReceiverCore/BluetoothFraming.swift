import Foundation

/// GATT is an ordered byte stream. The JSON protocol inside it remains version 1.
public enum BluetoothWire {
    public static let serviceUUID = "9D4B0001-7A8B-4E9A-AF33-6C7D8E9F0010"
    public static let receiveUUID = "9D4B0002-7A8B-4E9A-AF33-6C7D8E9F0010"
    public static let transmitUUID = "9D4B0003-7A8B-4E9A-AF33-6C7D8E9F0010"
    static let partialFrameTimeout: TimeInterval = 5
    static let outputTimeout: TimeInterval = 2
    static let maximumQueuedBytes = 32_768
}

enum BluetoothFramingError: Error { case invalidLength, partialTimeout, outputOverflow, outputTimeout, invalidMTU }

enum BluetoothFraming {
    static func encode(_ message: Data) throws -> Data {
        guard !message.isEmpty, message.count <= Wire.maxMessageBytes else { throw BluetoothFramingError.invalidLength }
        let length = UInt32(message.count)
        var frame = Data([UInt8((length >> 24) & 255), UInt8((length >> 16) & 255), UInt8((length >> 8) & 255), UInt8(length & 255)])
        frame.append(message)
        return frame
    }
}

/// A partial header is also timed, so dribbling bytes cannot retain a session indefinitely.
struct BluetoothFrameDecoder {
    private var pending = Data()
    private var expectedLength: Int?
    private var startedAt: TimeInterval?

    mutating func append(_ fragment: Data, now: TimeInterval) throws -> [Data] {
        try checkTimeout(now: now)
        var messages: [Data] = []
        var cursor = fragment.startIndex
        while cursor < fragment.endIndex {
            if startedAt == nil { startedAt = now }
            let target = expectedLength ?? 4
            let count = min(target - pending.count, fragment.endIndex - cursor)
            pending.append(fragment[cursor..<(cursor + count)])
            cursor += count
            guard pending.count == target else { continue }
            if expectedLength == nil {
                let length = pending.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
                guard length > 0, length <= UInt32(Wire.maxMessageBytes) else { throw BluetoothFramingError.invalidLength }
                expectedLength = Int(length); pending.removeAll(keepingCapacity: true)
            } else {
                messages.append(pending)
                pending = Data(); expectedLength = nil; startedAt = nil
            }
        }
        return messages
    }

    func checkTimeout(now: TimeInterval) throws {
        if let startedAt, now - startedAt >= BluetoothWire.partialFrameTimeout { throw BluetoothFramingError.partialTimeout }
    }
}

/// The same fragment stays at the head until CoreBluetooth accepts it.
struct BluetoothOutputQueue {
    private struct Frame { let data: Data; var offset: Int; let queuedAt: TimeInterval }
    private var frames: [Frame] = []
    private(set) var queuedBytes = 0

    mutating func enqueue(_ message: Data, now: TimeInterval) throws {
        try checkTimeout(now: now)
        let encoded = try BluetoothFraming.encode(message)
        guard queuedBytes + encoded.count <= BluetoothWire.maximumQueuedBytes else { throw BluetoothFramingError.outputOverflow }
        frames.append(Frame(data: encoded, offset: 0, queuedAt: now)); queuedBytes += encoded.count
    }

    func next(maximumLength: Int, now: TimeInterval) throws -> Data? {
        try checkTimeout(now: now)
        guard maximumLength > 0 else { throw BluetoothFramingError.invalidMTU }
        guard let frame = frames.first else { return nil }
        return frame.data.subdata(in: frame.offset..<min(frame.data.count, frame.offset + maximumLength))
    }

    mutating func consume(_ count: Int) {
        guard let first = frames.first, count > 0, count <= first.data.count - first.offset else { return }
        frames[0].offset += count; queuedBytes -= count
        if frames[0].offset == first.data.count { frames.removeFirst() }
    }

    func checkTimeout(now: TimeInterval) throws {
        if let first = frames.first, now - first.queuedAt >= BluetoothWire.outputTimeout { throw BluetoothFramingError.outputTimeout }
    }
}
