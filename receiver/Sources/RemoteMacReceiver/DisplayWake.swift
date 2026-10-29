import Foundation
import CoreGraphics
import IOKit.pwr_mgt

enum DisplayWakeState: Equatable { case awake, asleep, unavailable }

/// Injectable power boundary: tests must never change the host display's state.
struct DisplayWake {
    let state: () -> DisplayWakeState
    let acquire: () -> Bool
    let release: () -> Void

    static func system() -> DisplayWake {
        let power = MacDisplayWake()
        return DisplayWake(state: MacDisplayWake.state, acquire: power.acquire, release: power.release)
    }

    static func readiness(onlineDisplays: [(active: Bool, asleep: Bool)]) -> DisplayWakeState {
        guard !onlineDisplays.isEmpty else { return .unavailable }
        // Online mirrors may not be drawable even when their asleep flag is false.
        return onlineDisplays.contains { $0.active && !$0.asleep } ? .awake : .asleep
    }
}

/// Called only on NativeInput's serial queue. Merely constructing this adapter has no
/// power side effects. An assertion belongs to one unlock attempt and is always released.
private final class MacDisplayWake {
    private var assertion: IOPMAssertionID?

    func acquire() -> Bool {
        release()
        var identifier: IOPMAssertionID = 0
        // This request controls the physical console/display, so declare local user
        // activity rather than remote background resource access. Prevent-display-sleep
        // alone cannot turn an already sleeping display on.
        let result = IOPMAssertionDeclareUserActivity("Remote Mac unlock display" as CFString,
                                                    kIOPMUserActiveLocal, &identifier)
        guard result == kIOReturnSuccess else { return false }
        assertion = identifier
        return true
    }

    func release() {
        guard let identifier = assertion else { return }
        assertion = nil
        IOPMAssertionRelease(identifier)
    }

    deinit { release() }

    static func state() -> DisplayWakeState {
        var count: UInt32 = 0
        guard CGGetOnlineDisplayList(0, nil, &count) == .success, count > 0, count <= 64 else {
            return .unavailable
        }
        var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetOnlineDisplayList(count, &displays, &count) == .success, count > 0 else {
            return .unavailable
        }
        let online = displays.prefix(Int(count)).filter { CGDisplayIsOnline($0) != 0 }
        return DisplayWake.readiness(onlineDisplays: online.map {
            (active: CGDisplayIsActive($0) != 0, asleep: CGDisplayIsAsleep($0) != 0)
        })
    }
}
