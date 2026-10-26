// A test-only executable: no CGEvent sink, Keychain, Bonjour, or non-loopback listener.
import Foundation
import ReceiverCore
import Darwin

final class RecordingInput: InputSink {
    private let lock = NSLock()
    private var recorded: [String] = []
    func post(_ action: InputAction) { lock.lock(); recorded.append(String(describing: action)); lock.unlock() }
    func snapshot() -> [String] { lock.lock(); defer { lock.unlock() }; return recorded }
}
final class TestPermission {
    private let lock = NSLock()
    private var allowed = false
    func get() -> Bool { lock.lock(); defer { lock.unlock() }; return allowed }
    func toggle() { lock.lock(); allowed.toggle(); lock.unlock() }
}

guard CommandLine.arguments.count == 2 else {
    fputs("Usage: ReceiverIntegrationHarness /absolute/path/to/state.json\nSIGUSR1 toggles the test permission. SIGUSR2 revokes all test devices.\n", stderr)
    exit(2)
}
let statePath = CommandLine.arguments[1]
guard statePath.hasPrefix("/") else { fputs("State path must be absolute.\n", stderr); exit(2) }
let initialFD = open(statePath, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
guard initialFD >= 0 else { fputs("State file already exists or cannot be created.\n", stderr); exit(2) }
close(initialFD)
let sink = RecordingInput(), permission = TestPermission()
let pairing = try PairingManager(store: MemoryTrustStore())
let testOrigins = Set((ProcessInfo.processInfo.environment["REMOTE_MAC_TEST_ORIGIN"] ?? "").split(separator: ",").map(String.init))
let server = ReceiverServer(port: 0, pairing: pairing, sink: sink, origins: testOrigins, permission: { permission.get() }, loopbackOnly: true, identity: UUID().uuidString.lowercased())
var trustedIDs: [String] = []
server.onUpdate = { snapshot in
    trustedIDs = snapshot.devices.map(\.id)
    let state: [String: Any] = ["port": snapshot.port, "code": snapshot.code, "serverId": server.serverID, "permission": snapshot.permission, "status": snapshot.status, "deviceName": snapshot.deviceName ?? "", "trustedDeviceCount": snapshot.devices.count, "actions": sink.snapshot(), "error": snapshot.error ?? ""]
    do {
        let data = try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
        try data.write(to: URL(fileURLWithPath: statePath), options: .atomic)
        chmod(statePath, S_IRUSR | S_IWUSR)
    } catch { fputs("Could not write integration state.\n", stderr) }
}
signal(SIGUSR1, SIG_IGN); signal(SIGUSR2, SIG_IGN); signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
let toggle = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
toggle.setEventHandler { permission.toggle() }; toggle.resume()
let revoke = DispatchSource.makeSignalSource(signal: SIGUSR2, queue: .main)
revoke.setEventHandler { trustedIDs.forEach(server.revoke) }; revoke.resume()
let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
terminate.setEventHandler { server.stop(); try? FileManager.default.removeItem(atPath: statePath); exit(0) }; terminate.resume()
let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
interrupt.setEventHandler { server.stop(); try? FileManager.default.removeItem(atPath: statePath); exit(0) }; interrupt.resume()
server.start()
RunLoop.main.run()
