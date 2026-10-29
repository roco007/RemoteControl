import Foundation
import Testing
import ReceiverCore
@testable import RemoteMacReceiver

struct URLNativeTests {
    @Test func URLCompletionWaitsForNativeAcceptanceAndDoesNotClaimPageLoad() {
        var opened: [URL] = [], finish: ((Bool) -> Void)?, outcomes: [SystemActionOutcome] = []
        let input = NativeInput(postEvent: { _ in Issue.record("No keyboard events expected") }, openURL: { url, completion in opened.append(url); finish = completion })
        input.performSystemAction(.openURL, parameters: ["url": "https://example.com/path?q=one#two"]) { ok, message in outcomes.append(SystemActionOutcome(ok: ok, message: message)) }
        #expect(opened.map(\.absoluteString) == ["https://example.com/path?q=one#two"])
        #expect(outcomes.isEmpty)
        finish?(true)
        #expect(outcomes.count == 1)
        #expect(outcomes.first?.ok == true)
        #expect(outcomes.first?.message == "URL handed to macOS. Page loading is not tracked.")
    }
    @Test func NativeURLFailureAndInvalidInputDoNotClaimSuccess() {
        var starts = 0, results: [SystemActionOutcome] = []
        let input = NativeInput(postEvent: { _ in Issue.record("No keyboard events expected") }, openURL: { _, completion in starts += 1; completion(false) })
        input.performSystemAction(.openURL, parameters: ["url": "https://example.com/private?token=secret"]) { ok, message in results.append(SystemActionOutcome(ok: ok, message: message)) }
        for url in ["javascript:alert(1)", "https:///path", "https://user:password@example.com", "https://example.com/ bad"] {
            input.performSystemAction(.openURL, parameters: ["url": url]) { ok, message in results.append(SystemActionOutcome(ok: ok, message: message)) }
        }
        #expect(starts == 1)
        #expect(results.count == 5)
        #expect(results.allSatisfy { !$0.ok })
        #expect(results.allSatisfy { !($0.message ?? "").contains("secret") })
    }
}

struct YouTubeURLNativeRoutingTests {
    @Test func RoutesMusicAndVideoIntoTheirRespectiveAppsAndKeepsOrdinaryURLs() {
        var browser: [URL] = [], media: [YouTubeMediaTarget] = [], outcomes: [SystemActionOutcome] = []
        let input = NativeInput(postEvent: { _ in Issue.record("No keyboard events expected") },
            openURL: { url, done in browser.append(url); done(true) },
            playYouTube: { target, done in media.append(target); done(true, "Playback requested in the installed web app.") })
        for url in ["https://music.youtube.com/watch?v=music-id&list=PLone", "http://youtu.be/video-id?t=1m2s", "https://example.com/watch?v=normal", "https://youtube.com.example.com/watch?v=normal", "https://music.youtube.com/"] {
            input.performSystemAction(.openURL, parameters: ["url": url]) { ok, message in outcomes.append(SystemActionOutcome(ok: ok, message: message)) }
        }
        #expect(media.map(\.application) == ["YouTube Music", "YouTube"])
        #expect(media.map(\.url.absoluteString) == ["https://music.youtube.com/watch?v=music-id&list=PLone&autoplay=1", "https://www.youtube.com/watch?v=video-id&t=1m2s&autoplay=1"])
        #expect(browser.map(\.absoluteString) == ["https://example.com/watch?v=normal", "https://youtube.com.example.com/watch?v=normal", "https://music.youtube.com/"])
        #expect(outcomes.count == 5 && outcomes.allSatisfy(\.ok))
    }
    @Test func WaitsForYouTubeLaunchAndDoesNotFallbackAfterItsFailure() {
        var finish: ((Bool, String?) -> Void)?, browserCalls = 0, outcomes: [SystemActionOutcome] = []
        let input = NativeInput(postEvent: { _ in Issue.record("No keyboard events expected") },
            openURL: { _, done in browserCalls += 1; done(true) },
            playYouTube: { _, done in finish = done })
        input.performSystemAction(.openURL, parameters: ["url": "https://www.youtube.com/watch?v=video-id"]) { ok, message in outcomes.append(SystemActionOutcome(ok: ok, message: message)) }
        #expect(outcomes.isEmpty && browserCalls == 0)
        finish?(false, "YouTube web app is not installed. Install it from Chrome first.")
        #expect(outcomes.count == 1 && outcomes.first?.ok == false)
        #expect(outcomes.first?.message?.contains("not installed") == true)
        #expect(browserCalls == 0)
    }
    @Test func InvalidMediaDoesNotOpenEitherHandlerOrExposeItsParameters() {
        var calls = 0, outcomes: [SystemActionOutcome] = []
        let input = NativeInput(postEvent: { _ in Issue.record("No keyboard events expected") },
            openURL: { _, _ in calls += 1 }, playYouTube: { _, _ in calls += 1 })
        for url in ["https://www.youtube.com/watch?v=secret&v=duplicate", "https://music.youtube.com/playlist?list=bad%3Fsecret", "https://www.youtube.com:8443/watch?v=secret"] {
            input.performSystemAction(.openURL, parameters: ["url": url]) { ok, message in outcomes.append(SystemActionOutcome(ok: ok, message: message)) }
        }
        #expect(calls == 0 && outcomes.count == 3)
        #expect(outcomes.allSatisfy { !$0.ok && !($0.message ?? "").contains("secret") })
    }
}
