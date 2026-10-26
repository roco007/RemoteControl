import Foundation
import Testing

func expectEqual<T: Equatable>(_ a: T, _ b: T) { #expect(a == b) }
func expectNotEqual<T: Equatable>(_ a: T, _ b: T) { #expect(a != b) }
func expectTrue(_ value: Bool) { #expect(value) }
func expectFalse(_ value: Bool) { #expect(!value) }
func expectNil<T>(_ value: T?) { #expect(value == nil) }
func expectGreaterThan<T: Comparable>(_ a: T, _ b: T) { #expect(a > b) }
func unwrap<T>(_ value: T?) throws -> T { try #require(value) }
func expectNoThrow<T>(_ action: @autoclosure () throws -> T, _ message: String = "") {
    do { _ = try action() } catch { Issue.record("Unexpected error \(error): \(message)") }
}
func expectThrows<T>(_ action: @autoclosure () throws -> T, _ message: String = "", handler: (Error) -> Void = { _ in }) {
    do { _ = try action(); Issue.record("Expected failure: \(message)") } catch { handler(error) }
}
