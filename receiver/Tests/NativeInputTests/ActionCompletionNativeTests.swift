import Foundation
import Testing
import ReceiverCore
@testable import RemoteMacReceiver

struct ActionCompletionNativeTests {
    @Test func appTerminationWaitsForObservedExit() {
        var exited = false, results: [Bool] = [], scheduled: [() -> Void] = []
        ApplicationTermination.perform(start: { true }, terminated: { exited }, schedule: { _, next in scheduled.append(next) }, completion: { ok, _ in results.append(ok) })
        #expect(results.isEmpty)
        exited = true
        if !scheduled.isEmpty { scheduled.removeFirst()() }
        #expect(results == [true])
    }
    @Test func applicationCallbacksDetermineOutcomeInsteadOfDispatch() {
        var pending: ((Bool, String?) -> Void)?, results: [Bool] = []
        let input = NativeInput(postEvent: { _ in Issue.record("No keys expected") }, forceQuitFrontmost: { pending = $0 }, openPhotoBooth: { pending = $0 })
        for action in [SystemAction.killApp, .photoBooth] {
            input.performSystemAction(action) { ok, _ in results.append(ok) }
            #expect(results.isEmpty)
            pending?(false, "Native operation failed.")
            #expect(results == [false]); results.removeAll()
        }
    }
    @Test func terminationFailureOrTimeoutDoesNotClaimSuccess() {
        var outcomes: [Bool] = [], scheduled: [() -> Void] = []
        ApplicationTermination.perform(start: { false }, terminated: { false }, schedule: { _, next in scheduled.append(next) }, completion: { ok, _ in outcomes.append(ok) })
        #expect(outcomes == [false]); #expect(scheduled.isEmpty)
        outcomes.removeAll()
        ApplicationTermination.perform(start: { true }, terminated: { false }, schedule: { _, next in scheduled.append(next) }, completion: { ok, _ in outcomes.append(ok) })
        for _ in 0..<110 { if !scheduled.isEmpty { scheduled.removeFirst()() } }
        #expect(outcomes == [false]); #expect(scheduled.isEmpty)
    }
}
