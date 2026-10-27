import Foundation

@main
struct BluetoothFrameTests {
  static func main() throws {
    let message = #"{"type":"keyboard_text","text":"a🛰️é漢字"}"#
    let encoded = try BluetoothFrameStream.encode(message)
    for split in 0...encoded.count {
      var stream = BluetoothFrameStream()
      let first = try stream.append(encoded.prefix(split))
      let second = try stream.append(encoded.dropFirst(split))
      precondition(first + second == [message], "UTF-8 split at \(split)")
      precondition(!stream.hasPartialFrame)
    }
    var bytewise = BluetoothFrameStream()
    var decoded: [String] = []
    for byte in encoded { decoded += try bytewise.append(Data([byte])) }
    precondition(decoded == [message])

    var combined = encoded
    combined.append(try BluetoothFrameStream.encode(#"{"type":"pong"}"#))
    var coalesced = BluetoothFrameStream()
    let coalescedMessages = try coalesced.append(combined)
    precondition(coalescedMessages == [message, #"{"type":"pong"}"#])

    let maximum = String(repeating: "a", count: 16_384)
    let maximumFrame = try BluetoothFrameStream.encode(maximum)
    var full = BluetoothFrameStream()
    let fullMessages = try full.append(maximumFrame)
    precondition(fullMessages == [maximum])
    expectFailure { _ = try BluetoothFrameStream.encode("") }
    expectFailure { _ = try BluetoothFrameStream.encode(maximum + "a") }
    for bytes: [UInt8] in [[0, 0, 0, 0], [0, 0, 64, 1], [255, 255, 255, 255], [0, 0, 0, 1, 255]] {
      expectFailure { var invalid = BluetoothFrameStream(); _ = try invalid.append(Data(bytes)) }
    }
    print("Bluetooth frame tests passed: every UTF-8 split, bytewise fragments, coalesced frames, exact maximum, invalid lengths and UTF-8.")
  }

  static func expectFailure(_ operation: () throws -> Void) {
    do { try operation(); preconditionFailure("Expected malformed frame to be rejected") }
    catch { }
  }
}
