import Foundation
import CoreGraphics

enum ScreenLockState: Equatable { case locked, unlocked, unavailable }

enum MacScreenLockState {
    static func current() -> ScreenLockState {
        resolve(CGSessionCopyCurrentDictionary() as? [String: Any], userID: Int(getuid()))
    }

    static func resolve(_ session: [String: Any]?, userID: Int) -> ScreenLockState {
        guard let session,
              (session[kCGSessionUserIDKey as String] as? NSNumber)?.intValue == userID,
              session[kCGSessionOnConsoleKey as String] as? Bool == true,
              session[kCGSessionLoginDoneKey as String] as? Bool == true else { return .unavailable }
        // WindowServer omits this key for an unlocked, logged-in console session.
        return session["CGSSessionScreenIsLocked"] as? Bool == true ? .locked : .unlocked
    }
}

/// Runs on NativeInput's serial queue. A repeated gesture never queues another password.
final class ScreenLockController {
    private let state: () -> ScreenLockState
    private let allowed: () -> Bool
    private let password: () throws -> String?
    private let lock: () -> Void
    private let key: (CGKeyCode) -> Void
    private let text: (String) -> Void
    private let display: DisplayWake
    private let now: () -> TimeInterval
    private let schedule: (TimeInterval, @escaping () -> Void) -> Void
    private let report: (String) -> Void
    private(set) var isBusy = false
    private(set) var isEnteringPassword = false
    private var completion: ((Bool, String?) -> Void)?
    private var attempt: UUID?
    private var ownsDisplayAssertion = false

    init(state: @escaping () -> ScreenLockState, allowed: @escaping () -> Bool,
         password: @escaping () throws -> String?, lock: @escaping () -> Void,
         key: @escaping (CGKeyCode) -> Void, text: @escaping (String) -> Void,
         display: DisplayWake, now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         schedule: @escaping (TimeInterval, @escaping () -> Void) -> Void,
         report: @escaping (String) -> Void) {
        self.state = state; self.allowed = allowed; self.password = password
        self.lock = lock; self.key = key; self.text = text
        self.display = display; self.now = now
        self.schedule = schedule; self.report = report
    }

    deinit {
        if ownsDisplayAssertion { display.release() }
        completion?(false, "Lock operation cancelled because the receiver stopped.")
    }

    /// A network disconnect does not cancel an executing action. Actual system sleep does:
    /// no delayed password or Return may survive into a later wake/session.
    func cancelForSystemSleep() {
        guard isBusy else { return }
        finish("Mac is going to sleep. Lock operation cancelled.")
    }

    func toggle(completion: ((Bool, String?) -> Void)? = nil) {
        guard !isBusy else { completion?(false, "A lock operation is already running."); return }
        let token = UUID()
        attempt = token; isBusy = true
        self.completion = completion
        guard allowed() else { finish("Enable Accessibility for Remote Mac Control first."); return }
        switch state() {
        case .unavailable:
            finish("Cannot determine this Mac's active login session. No keys were sent.")
        case .unlocked:
            lock()
            confirmState(.locked, token: token, deadline: now() + 1)
        case .locked:
            let value: String
            do {
                guard let saved = try password(), !saved.isEmpty else {
                    finish("Save this Mac's login password in the receiver to enable unlocking."); return
                }
                value = saved
            } catch {
                // Never echo errors from a credential provider; they could contain the secret.
                finish("Could not read the unlock password. Unlock manually and save it again in the receiver.")
                return
            }
            // Keychain access may have taken time; check again before waking or sending keys.
            guard canContinueUnlock(token) else { return }
            isEnteringPassword = true
            switch display.state() {
            case .awake:
                enterPassword(value, token: token)
            case .asleep:
                guard display.acquire() else {
                    finish("Could not wake this Mac's display. No password was sent."); return
                }
                ownsDisplayAssertion = true
                waitForDisplay(value, token: token, deadline: now() + 5)
            case .unavailable:
                finish("Cannot determine this Mac's display state. No password was sent.")
            }
        }
    }

    private func waitForDisplay(_ value: String, token: UUID, deadline: TimeInterval) {
        guard canContinueUnlock(token) else { return }
        guard now() < deadline else {
            finish("The Mac's display did not wake in time. No password was sent."); return
        }
        switch display.state() {
        case .awake:
            // Display power is not login-field readiness. Give the waking login UI time
            // to settle before Space; the already-awake path retains its original timing.
            schedule(0.5) { [weak self] in self?.enterPassword(value, token: token) }
        case .asleep:
            schedule(min(0.1, deadline - now())) { [weak self] in
                self?.waitForDisplay(value, token: token, deadline: deadline)
            }
        case .unavailable:
            finish("Cannot determine this Mac's display state. No password was sent.")
        }
    }

    private func enterPassword(_ value: String, token: UUID) {
        guard canContinueUnlock(token, requireAwake: true) else { return }
        key(49)
        schedule(0.2) { [weak self] in
            guard let self, self.canContinueUnlock(token, requireAwake: true) else { return }
            self.text(value)
            self.schedule(0.2) { [weak self] in
                guard let self, self.canContinueUnlock(token, requireAwake: true) else { return }
                self.key(36)
                self.confirmState(.unlocked, token: token, deadline: self.now() + 1)
            }
        }
    }

    /// Keep the action guard until the session confirms completion. Observe promptly,
    /// while retaining the original one-second limit and never repeating any input.
    private func confirmState(_ expected: ScreenLockState, token: UUID, deadline: TimeInterval) {
        guard attempt == token else { return }
        if state() == expected {
            finish(expected == .locked ? "Mac locked." : "Mac unlocked.", ok: true)
            return
        }
        let remaining = deadline - now()
        guard remaining > 0 else {
            finish(expected == .locked
                ? "Lock was not confirmed. Check the Mac's lock shortcut."
                : "Unlock was not confirmed. Check the Mac password and login screen.")
            return
        }
        // A temporarily unavailable session may be part of the transition. No more
        // keys are sent here; wait through the deadline instead of failing early.
        schedule(min(0.05, remaining)) { [weak self] in
            self?.confirmState(expected, token: token, deadline: deadline)
        }
    }

    private func canContinueUnlock(_ token: UUID, requireAwake: Bool = false) -> Bool {
        guard attempt == token else { return false }
        guard state() == .locked, allowed() else {
            finish("Login state changed or Accessibility was disabled. Unlock cancelled.")
            return false
        }
        guard !requireAwake || display.state() == .awake else {
            finish("The Mac's display is no longer ready. Unlock cancelled.")
            return false
        }
        return true
    }

    private func finish(_ message: String, ok: Bool = false) {
        attempt = nil
        isBusy = false; isEnteringPassword = false
        if ownsDisplayAssertion { ownsDisplayAssertion = false; display.release() }
        let callback = completion; completion = nil
        report(message)
        callback?(ok, message)
    }
}
