import Foundation
import CoreBluetooth
import Testing
@testable import ReceiverCore

final class BluetoothFramingTests {
    @Test func testGATTRequiresEncryptedWritesAndSubscriptions() {
        let characteristics = BluetoothPeripheral.makeCharacteristics()
        expectTrue(characteristics.receive.properties.contains(.write))
        expectFalse(characteristics.receive.properties.contains(.writeWithoutResponse))
        expectTrue(characteristics.receive.permissions.contains(.writeEncryptionRequired))
        expectTrue(characteristics.transmit.properties.contains(.notifyEncryptionRequired))
        expectFalse(characteristics.transmit.properties.contains(.read))
    }

    @Test func testFragmentedUTF8AndCoalescedFramesReassembleExactlyOnce() throws {
        let first = Data("Hello 👋 नमस्ते".utf8), second = Data("{}".utf8)
        let bytes = try BluetoothFraming.encode(first) + BluetoothFraming.encode(second)
        var decoder = BluetoothFrameDecoder()
        var received: [Data] = []
        for byte in bytes { received += try decoder.append(Data([byte]), now: 0) }
        expectEqual(received, [first, second])
        expectEqual(try decoder.append(Data(), now: 10), [])
    }

    @Test func testHeaderUsesBigEndianLengthAndAcceptsMaximumMessage() throws {
        let message = Data(repeating: 65, count: Wire.maxMessageBytes)
        let encoded = try BluetoothFraming.encode(message)
        expectEqual(Array(encoded.prefix(4)), [0, 0, 64, 0])
        var decoder = BluetoothFrameDecoder()
        expectEqual(try decoder.append(encoded, now: 0), [message])
    }

    @Test func testRejectsEmptyAndOversizedFramesBeforeBodyAllocation() {
        expectThrows(try BluetoothFraming.encode(Data()))
        expectThrows(try BluetoothFraming.encode(Data(repeating: 0, count: Wire.maxMessageBytes + 1)))
        var zero = BluetoothFrameDecoder(), huge = BluetoothFrameDecoder()
        expectThrows(try zero.append(Data([0, 0, 0, 0]), now: 0))
        expectThrows(try huge.append(Data([255, 255, 255, 255]), now: 0))
    }

    @Test func testPartialHeaderAndBodyHaveAbsoluteFiveSecondDeadline() throws {
        var header = BluetoothFrameDecoder()
        _ = try header.append(Data([0]), now: 0)
        expectThrows(try header.checkTimeout(now: 5))
        var body = BluetoothFrameDecoder()
        _ = try body.append(Data([0, 0, 0, 3, 65]), now: 1)
        _ = try body.append(Data([66]), now: 5)
        expectThrows(try body.append(Data([67]), now: 6))
    }

    @Test func testCompletedMessageResetsPartialFrameDeadline() throws {
        var decoder = BluetoothFrameDecoder()
        _ = try decoder.append(Data([0, 0, 0, 1]), now: 0)
        expectEqual(try decoder.append(Data([65, 0]), now: 4), [Data([65])])
        expectNoThrow(try decoder.checkTimeout(now: 8))
        expectThrows(try decoder.checkTimeout(now: 9))
    }

    @Test func testOutputWaitsForAcceptanceAndChunksToNegotiatedSize() throws {
        var output = BluetoothOutputQueue()
        try output.enqueue(Data(repeating: 42, count: 41), now: 0)
        let first = try unwrap(output.next(maximumLength: 20, now: 0))
        expectEqual(first.count, 20)
        expectEqual(try output.next(maximumLength: 20, now: 1), first)
        output.consume(first.count)
        let second = try unwrap(output.next(maximumLength: 20, now: 1))
        expectEqual(second.count, 20); output.consume(second.count)
        let last = try unwrap(output.next(maximumLength: 20, now: 1))
        expectEqual(last.count, 5); output.consume(last.count)
        expectNil(try output.next(maximumLength: 20, now: 3))
    }

    @Test func testOutputQueueRejectsOverflowAndStalePackets() throws {
        var output = BluetoothOutputQueue()
        try output.enqueue(Data(repeating: 1, count: Wire.maxMessageBytes), now: 0)
        expectThrows(try output.enqueue(Data(repeating: 1, count: Wire.maxMessageBytes), now: 0))
        expectThrows(try output.next(maximumLength: 20, now: 2))
    }
}
