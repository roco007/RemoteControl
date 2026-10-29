import Foundation
import CoreGraphics
import Testing
@testable import RemoteMacReceiver

struct ScreenLockTests {
    @Test func lockingCompletesImmediatelyWhenTheTargetStateIsAlreadyObserved() {
        let fixture = LockFixture(state: .unlocked)
        fixture.stateAfterLock = .locked
        var outcomes: [Bool] = []
        fixture.controller.toggle { ok, _ in outcomes.append(ok) }
        #expect(outcomes == [true])
        #expect(fixture.pending.isEmpty)
        #expect(fixture.events == ["lock"])
        #expect(!fixture.controller.isBusy)
    }

    @Test func unlockingCompletesImmediatelyAfterReturnWhenTheSessionIsUnlocked() {
        let fixture = LockFixture(state: .locked)
        fixture.stateAfterSubmit = .unlocked
        var outcomes: [Bool] = []
        fixture.controller.toggle { ok, _ in outcomes.append(ok) }
        #expect(fixture.delays == [0.2])
        fixture.advance()
        #expect(fixture.delays == [0.2])
        #expect(outcomes.isEmpty)
        fixture.advance()
        #expect(outcomes == [true])
        #expect(fixture.pending.isEmpty)
        #expect(fixture.events == ["key:49", "text:test-password", "key:36"])
        #expect(fixture.time == 0.4)
    }

    @Test func pendingLockKeepsTheGuardUntilTheFirstSuccessfulPoll() {
        let fixture = LockFixture(state: .unlocked)
        var outcomes: [Bool] = [], duplicate: [Bool] = []
        fixture.controller.toggle { ok, _ in outcomes.append(ok) }
        #expect(fixture.delays == [0.05])
        fixture.advance(); fixture.advance()
        #expect(outcomes.isEmpty)
        #expect(fixture.controller.isBusy)
        fixture.controller.toggle { ok, _ in duplicate.append(ok) }
        #expect(duplicate == [false])
        #expect(fixture.events == ["lock"])
        fixture.state = .locked; fixture.advance()
        #expect(outcomes == [true])
        #expect(fixture.time < 0.2)
        #expect(fixture.pending.isEmpty)
    }

    @Test func lockConfirmationUsesTheFullOriginalDeadlineBeforeFailing() {
        let fixture = LockFixture(state: .unlocked)
        var outcomes: [Bool] = []
        fixture.controller.toggle { ok, _ in outcomes.append(ok) }
        fixture.time = 0.94; fixture.advance()
        #expect(outcomes.isEmpty)
        #expect(fixture.controller.isBusy)
        fixture.advance()
        #expect(outcomes == [false])
        #expect(fixture.time == 1)
        #expect(fixture.pending.isEmpty)
        #expect(fixture.events == ["lock"])
    }

    @Test func transientUnavailableSessionAfterSubmissionCanStillConfirmUnlock() {
        let fixture = LockFixture(state: .locked)
        fixture.stateAfterSubmit = .unavailable
        var outcomes: [Bool] = []
        fixture.controller.toggle { ok, _ in outcomes.append(ok) }
        fixture.advance(); fixture.advance()
        #expect(fixture.delays == [0.05])
        fixture.advance()
        #expect(outcomes.isEmpty)
        fixture.state = .unlocked; fixture.advance()
        #expect(outcomes == [true])
        #expect(fixture.time < 0.6)
        #expect(fixture.events == ["key:49", "text:test-password", "key:36"])
    }

    @Test func sleepCancellationFencesOldConfirmationPollFromANewAttempt() throws {
        let fixture = LockFixture(state: .unlocked)
        var original: [Bool] = [], next: [Bool] = []
        fixture.controller.toggle { ok, _ in original.append(ok) }
        let stale = try #require(fixture.pending.first)
        fixture.controller.cancelForSystemSleep()
        fixture.pending.removeAll(); fixture.delays.removeAll()
        fixture.controller.toggle { ok, _ in next.append(ok) }
        fixture.state = .locked
        stale(); stale()
        #expect(original == [false])
        #expect(next.isEmpty)
        #expect(fixture.controller.isBusy)
        fixture.advance()
        #expect(next == [true])
        #expect(fixture.events == ["lock", "lock"])
    }

    @Test func sleepingDisplayWaitsForWakeAndSettleBeforeAnyLoginInput() {
        let fixture = LockFixture(state: .locked)
        fixture.displayState = .asleep
        var outcomes: [Bool] = []
        fixture.controller.toggle { ok, _ in outcomes.append(ok) }
        #expect(fixture.wakeRequests == 1)
        #expect(fixture.controller.isEnteringPassword)
        #expect(fixture.events.isEmpty)
        fixture.advance(); fixture.advance()
        #expect(fixture.events.isEmpty)
        #expect(outcomes.isEmpty)
        fixture.displayState = .awake
        fixture.advance()
        #expect(fixture.events.isEmpty)
        #expect(fixture.delays == [0.5])
        fixture.advance()
        #expect(fixture.events == ["key:49"])
        fixture.advance(); fixture.advance()
        #expect(fixture.events == ["key:49", "text:test-password", "key:36"])
        fixture.state = .unlocked; fixture.advance()
        #expect(outcomes == [true])
        #expect(fixture.wakeReleases == 1)
        #expect(fixture.passwordReads == 1)
    }

    @Test func failedWakeDoesNotSendPasswordOrClaimSuccess() {
        let fixture = LockFixture(state: .locked)
        fixture.displayState = .asleep; fixture.wakeSucceeds = false
        var outcomes: [Bool] = []
        fixture.controller.toggle { ok, _ in outcomes.append(ok) }
        #expect(outcomes == [false])
        #expect(fixture.events.isEmpty)
        #expect(fixture.pending.isEmpty)
        #expect(fixture.wakeRequests == 1)
        #expect(fixture.wakeReleases == 0)
    }

    @Test func wakeTimeoutIsBoundedAndReleasesItsAssertionWithoutRetryingCredentials() {
        let fixture = LockFixture(state: .locked)
        fixture.displayState = .asleep
        var outcomes: [Bool] = []
        fixture.controller.toggle { ok, _ in outcomes.append(ok) }
        fixture.time = 6
        fixture.advance()
        #expect(outcomes == [false])
        #expect(fixture.events.isEmpty)
        #expect(fixture.pending.isEmpty)
        #expect(fixture.wakeReleases == 1)
        #expect(fixture.passwordReads == 1)
    }

    @Test(arguments: [ScreenLockState.unlocked, .unavailable])
    func changedSessionDuringWakeCancelsWithoutKeys(_ state: ScreenLockState) {
        let fixture = LockFixture(state: .locked)
        fixture.displayState = .asleep
        fixture.controller.toggle()
        fixture.state = state; fixture.advance()
        #expect(fixture.events.isEmpty)
        #expect(!fixture.controller.isBusy)
        #expect(fixture.wakeReleases == 1)
    }

    @Test func permissionRevocationDuringWakeCancelsWithoutKeys() {
        let fixture = LockFixture(state: .locked)
        fixture.displayState = .asleep
        fixture.controller.toggle()
        fixture.allowed = false; fixture.advance()
        #expect(fixture.events.isEmpty)
        #expect(!fixture.controller.isBusy)
        #expect(fixture.wakeReleases == 1)
    }

    @Test func systemSleepCancelsOnceAndOldCallbacksCannotAffectANewAttempt() throws {
        let fixture = LockFixture(state: .locked)
        fixture.displayState = .asleep
        var first: [Bool] = [], second: [Bool] = []
        fixture.controller.toggle { ok, _ in first.append(ok) }
        let old = try #require(fixture.pending.first)
        fixture.controller.cancelForSystemSleep()
        fixture.controller.cancelForSystemSleep()
        #expect(first == [false])
        #expect(fixture.wakeReleases == 1)
        fixture.pending.removeAll(); fixture.delays.removeAll()
        fixture.displayState = .awake
        fixture.controller.toggle { ok, _ in second.append(ok) }
        old(); old()
        #expect(fixture.events == ["key:49"])
        #expect(first == [false]); #expect(second.isEmpty)
        fixture.advance(); fixture.advance()
        fixture.state = .unlocked; fixture.advance()
        #expect(second == [true])
        #expect(fixture.wakeReleases == 1)
    }

    @Test func systemSleepAfterTypingNeverSubmitsPasswordLater() {
        let fixture = LockFixture(state: .locked)
        var outcomes: [Bool] = []
        fixture.controller.toggle { ok, _ in outcomes.append(ok) }
        fixture.advance()
        fixture.controller.cancelForSystemSleep()
        fixture.advance()
        #expect(fixture.events == ["key:49", "text:test-password"])
        #expect(outcomes == [false])
        #expect(fixture.pending.isEmpty)
    }

    @Test func unavailableOrSleepingAgainDisplayNeverReceivesPassword() {
        let fixture = LockFixture(state: .locked)
        fixture.displayState = .unavailable
        fixture.controller.toggle()
        #expect(fixture.events.isEmpty)
        #expect(!fixture.controller.isBusy)
        fixture.displayState = .awake
        fixture.controller.toggle()
        fixture.displayState = .asleep; fixture.advance()
        #expect(fixture.events == ["key:49"])
        #expect(!fixture.controller.isBusy)
    }

    @Test func repeatedRequestDuringWakeDoesNotQueueOrAcquireAgain() {
        let fixture = LockFixture(state: .locked)
        fixture.displayState = .asleep
        var original: [Bool] = [], duplicate: [Bool] = []
        fixture.controller.toggle { ok, _ in original.append(ok) }
        fixture.controller.toggle { ok, _ in duplicate.append(ok) }
        #expect(original.isEmpty)
        #expect(duplicate == [false])
        #expect(fixture.wakeRequests == 1)
        #expect(fixture.passwordReads == 1)
        #expect(fixture.pending.count == 1)
        fixture.controller.cancelForSystemSleep()
        fixture.advance()
        #expect(original == [false])
        #expect(fixture.events.isEmpty)
        #expect(fixture.wakeReleases == 1)
    }

    @Test func destroyingControllerReleasesWakeAndCompletesWithoutLaterInput() {
        var releases = 0, outcomes: [Bool] = [], pending: [() -> Void] = []
        var controller: ScreenLockController? = ScreenLockController(state: { .locked }, allowed: { true },
            password: { "secret" }, lock: { Issue.record("Unexpected lock") },
            key: { _ in Issue.record("Unexpected key") }, text: { _ in Issue.record("Unexpected password") },
            display: DisplayWake(state: { .asleep }, acquire: { true }, release: { releases += 1 }),
            schedule: { _, next in pending.append(next) }, report: { _ in })
        controller?.toggle { ok, _ in outcomes.append(ok) }
        #expect(outcomes.isEmpty)
        controller = nil
        pending.forEach { $0() }
        #expect(releases == 1)
        #expect(outcomes == [false])
    }

    @Test func displaySleepingAgainDuringWakeSettleCancelsBeforeSpace() {
        let fixture = LockFixture(state: .locked)
        fixture.displayState = .asleep
        fixture.controller.toggle()
        fixture.displayState = .awake; fixture.advance()
        fixture.displayState = .asleep; fixture.advance()
        #expect(fixture.events.isEmpty)
        #expect(fixture.pending.isEmpty)
        #expect(!fixture.controller.isBusy)
        #expect(fixture.wakeReleases == 1)
    }

    @Test func completionWaitsForObservedLockStateAndReportsFailure() {
        let fixture = LockFixture(state: .unlocked)
        var results: [Bool] = []
        fixture.controller.toggle { ok, _ in results.append(ok) }
        #expect(results.isEmpty)
        fixture.state = .locked; fixture.advance()
        #expect(results == [true])
        fixture.password = nil
        fixture.controller.toggle { ok, _ in results.append(ok) }
        #expect(results == [true, false])
    }
    @Test func cancelledUnlockCompletesOnceWithoutReportingSuccess() {
        let fixture = LockFixture(state: .locked)
        var results: [Bool] = []
        fixture.controller.toggle { ok, _ in results.append(ok) }
        #expect(results.isEmpty)
        fixture.allowed = false; fixture.advance()
        #expect(results == [false])
    }
    @Test func unlockedSessionLocksOnceWithoutReadingPassword() {
        let fixture = LockFixture(state: .unlocked)
        fixture.controller.toggle()
        fixture.controller.toggle()
        #expect(fixture.events == ["lock"])
        #expect(fixture.passwordReads == 0)
        fixture.state = .locked
        fixture.advance()
        #expect(!fixture.controller.isBusy)
        #expect(fixture.messages.last == "Mac locked.")
    }

    @Test func lockedSessionSendsSpacePasswordReturnInOrderWithoutOverlapping() {
        let fixture = LockFixture(state: .locked)
        fixture.controller.toggle()
        fixture.controller.toggle()
        #expect(fixture.events == ["key:49"])
        #expect(fixture.delays == [0.2])
        fixture.advance()
        #expect(fixture.events == ["key:49", "text:test-password"])
        #expect(fixture.delays == [0.2])
        fixture.advance()
        #expect(fixture.events == ["key:49", "text:test-password", "key:36"])
        #expect(fixture.controller.isBusy)
        fixture.state = .unlocked
        fixture.advance()
        #expect(!fixture.controller.isBusy)
        #expect(fixture.messages.last == "Mac unlocked.")
        #expect(fixture.wakeRequests == 0)
        #expect(fixture.wakeReleases == 0)
    }

    @Test func missingPasswordNeverSendsKeysAndCanBeConfiguredLater() {
        let fixture = LockFixture(state: .locked)
        fixture.password = nil
        fixture.controller.toggle()
        #expect(fixture.events.isEmpty)
        #expect(!fixture.controller.isBusy)
        fixture.password = "configured"
        fixture.controller.toggle()
        #expect(fixture.events == ["key:49"])
    }

    @Test func failedCredentialReadDoesNotRevealErrorOrSendKeys() {
        let fixture = LockFixture(state: .locked)
        fixture.passwordError = true
        fixture.controller.toggle()
        #expect(fixture.events.isEmpty)
        #expect(!fixture.messages.joined().contains("private-error-text"))
        #expect(!fixture.controller.isBusy)
    }

    @Test(arguments: [ScreenLockState.unlocked, .unavailable])
    func changedSessionBeforeTypingCancelsPassword(_ state: ScreenLockState) {
        let fixture = LockFixture(state: .locked)
        fixture.controller.toggle()
        fixture.state = state
        fixture.advance()
        #expect(fixture.events == ["key:49"])
        #expect(!fixture.controller.isBusy)
    }

    @Test func changedSessionAfterTypingNeverSubmitsIntoDesktop() {
        let fixture = LockFixture(state: .locked)
        fixture.controller.toggle()
        fixture.advance()
        fixture.state = .unlocked
        fixture.advance()
        #expect(fixture.events == ["key:49", "text:test-password"])
        #expect(!fixture.controller.isBusy)
    }

    @Test func unavailableSessionOrPermissionNeverSendsInput() {
        let fixture = LockFixture(state: .unavailable)
        fixture.controller.toggle()
        fixture.state = .locked
        fixture.allowed = false
        fixture.controller.toggle()
        #expect(fixture.events.isEmpty)
        #expect(fixture.passwordReads == 0)
    }

    @Test func permissionRevocationDuringDelayCancelsPassword() {
        let fixture = LockFixture(state: .locked)
        fixture.controller.toggle()
        fixture.allowed = false
        fixture.advance()
        #expect(fixture.events == ["key:49"])
        #expect(!fixture.controller.isBusy)
    }

    @Test func sentKeysDoNotClaimUnlockWhenMacRemainsLocked() {
        let fixture = LockFixture(state: .locked)
        fixture.controller.toggle()
        fixture.advance(); fixture.advance()
        // The confirmation deadline starts after Return, with no password retry.
        fixture.time += 1
        fixture.advance()
        #expect(fixture.messages.last == "Unlock was not confirmed. Check the Mac password and login screen.")
        #expect(!fixture.controller.isBusy)
    }

    @Test func lockStateRequiresOwnLoggedInConsoleSession() {
        let own: [String: Any] = [kCGSessionUserIDKey as String: 501,
                                 kCGSessionOnConsoleKey as String: true,
                                 kCGSessionLoginDoneKey as String: true]
        #expect(MacScreenLockState.resolve(own, userID: 501) == .unlocked)
        #expect(MacScreenLockState.resolve(own.merging(["CGSSessionScreenIsLocked": true]) { _, new in new }, userID: 501) == .locked)
        #expect(MacScreenLockState.resolve(own, userID: 502) == .unavailable)
        #expect(MacScreenLockState.resolve(nil, userID: 501) == .unavailable)
        #expect(MacScreenLockState.resolve([:], userID: 501) == .unavailable)
        #expect(MacScreenLockState.resolve(own.merging([kCGSessionOnConsoleKey as String: false]) { _, new in new }, userID: 501) == .unavailable)
    }

    @Test func environmentPasswordPreservesExactCharactersAndEmptyOverrideDisablesFallback() throws {
        let configured = MacUnlockCredentialStore(environment: ["MAC_UNLOCK_TEXT": "  quotes\"\\$ 🗝️  "])
        #expect(try configured.password() == "  quotes\"\\$ 🗝️  ")
        #expect(try configured.configuration() == .environment)
        let disabled = MacUnlockCredentialStore(environment: ["MAC_UNLOCK_TEXT": ""])
        #expect(try disabled.password() == nil)
        #expect(try disabled.configuration() == .notConfigured)
    }

    @Test func clearingLockStateDuringCredentialReadSendsNoSpace() {
        var events: [String] = []
        var state = ScreenLockState.locked
        let controller = ScreenLockController(state: { state }, allowed: { true },
            password: { state = .unlocked; return "secret" }, lock: { events.append("lock") },
            key: { events.append("key:\($0)") }, text: { events.append($0) },
            display: DisplayWake(state: { .awake }, acquire: { Issue.record("No display wake expected"); return false }, release: {}),
            schedule: { _, _ in Issue.record("Should not schedule any input") }, report: { _ in })
        controller.toggle()
        #expect(events.isEmpty)
    }
}

private final class LockFixture {
    var state: ScreenLockState
    var stateAfterLock: ScreenLockState?
    var stateAfterSubmit: ScreenLockState?
    var allowed = true
    var password: String? = "test-password"
    var passwordError = false
    var passwordReads = 0
    var displayState = DisplayWakeState.awake
    var wakeSucceeds = true
    var wakeRequests = 0
    var wakeReleases = 0
    var time: TimeInterval = 0
    var events: [String] = []
    var messages: [String] = []
    var delays: [TimeInterval] = []
    var pending: [() -> Void] = []
    lazy var controller = ScreenLockController(
        state: { self.state }, allowed: { self.allowed }, password: {
            self.passwordReads += 1
            if self.passwordError { throw NSError(domain: "private-error-text", code: 1) }
            return self.password
        }, lock: {
            self.events.append("lock")
            if let next = self.stateAfterLock { self.state = next }
        },
        key: {
            self.events.append("key:\($0)")
            if $0 == 36, let next = self.stateAfterSubmit { self.state = next }
        }, text: { self.events.append("text:\($0)") },
        display: DisplayWake(state: { self.displayState }, acquire: { self.wakeRequests += 1; return self.wakeSucceeds }, release: { self.wakeReleases += 1 }),
        now: { self.time },
        schedule: { delay, callback in self.delays.append(delay); self.pending.append(callback) },
        report: { self.messages.append($0) })
    init(state: ScreenLockState) { self.state = state }
    func advance() {
        guard !pending.isEmpty else { Issue.record("Missing scheduled lock step"); return }
        time += delays.removeFirst(); pending.removeFirst()()
    }
}
