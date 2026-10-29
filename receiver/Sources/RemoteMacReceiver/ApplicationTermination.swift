import Foundation

enum ApplicationTermination {
    static func perform(start: () -> Bool, terminated: @escaping () -> Bool,
                        schedule: @escaping (TimeInterval, @escaping () -> Void) -> Void,
                        completion: @escaping (Bool, String?) -> Void) {
        guard start() else { completion(false, "The application refused termination."); return }
        func check(_ remaining: Int) {
            if terminated() { completion(true, nil); return }
            guard remaining > 0 else { completion(false, "Application termination was not confirmed."); return }
            schedule(0.05) { check(remaining - 1) }
        }
        check(100)
    }
}
