import Foundation

/// A BLE notification/write is a fragment of a stream, never a JSON boundary.
struct BluetoothFrameStream {
  static let maximumMessageBytes = 16_384
  private var buffer = Data()
  var hasPartialFrame: Bool { !buffer.isEmpty }

  static func encode(_ message: String) throws -> Data {
    let payload = Data(message.utf8)
    guard (1...maximumMessageBytes).contains(payload.count) else { throw FrameError.invalidLength }
    let length = UInt32(payload.count)
    var frame = Data([UInt8((length >> 24) & 255), UInt8((length >> 16) & 255), UInt8((length >> 8) & 255), UInt8(length & 255)])
    frame.append(payload)
    return frame
  }

  mutating func append(_ bytes: Data) throws -> [String] {
    // A single ATT value cannot exceed 512 bytes. The allowance also permits
    // direct codec tests containing multiple frames without unbounded allocation.
    guard bytes.count <= Self.maximumMessageBytes + 4 else { throw FrameError.invalidLength }
    buffer.append(bytes)
    var messages: [String] = []
    while buffer.count >= 4 {
      let prefix = Array(buffer.prefix(4))
      let length = prefix.reduce(0) { ($0 << 8) | Int($1) }
      guard (1...Self.maximumMessageBytes).contains(length) else { throw FrameError.invalidLength }
      guard buffer.count >= length + 4 else { break }
      guard let message = String(data: buffer.dropFirst(4).prefix(length), encoding: .utf8) else { throw FrameError.invalidUTF8 }
      buffer.removeFirst(length + 4)
      messages.append(message)
    }
    guard buffer.count <= Self.maximumMessageBytes + 4 else { throw FrameError.invalidLength }
    return messages
  }

  enum FrameError: Error { case invalidLength, invalidUTF8 }
}
