import Testing
@testable import RemoteMacReceiver

struct DisplayWakeTests {
    @Test func inactiveOnlineMirrorCannotMakeASleepingConsoleReady() {
        #expect(DisplayWake.readiness(onlineDisplays: [(false, false), (true, true)]) == .asleep)
        #expect(DisplayWake.readiness(onlineDisplays: [(false, false)]) == .asleep)
    }

    @Test func anActiveAwakeDisplayIsRequiredAndNoDisplaysIsUnavailable() {
        #expect(DisplayWake.readiness(onlineDisplays: []) == .unavailable)
        #expect(DisplayWake.readiness(onlineDisplays: [(true, true)]) == .asleep)
        #expect(DisplayWake.readiness(onlineDisplays: [(false, true), (true, false)]) == .awake)
    }
}
