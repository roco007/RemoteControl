import Foundation
import Testing
@testable import RemoteMacReceiver

struct YouTubeMediaTargetTests {
    @Test func videoAndMusicLinksChooseTheirInstalledApplication() throws {
        let cases = [
            ("https://www.youtube.com/watch?v=video_123-4&si=tracking", "YouTube", "https://www.youtube.com", "https://www.youtube.com/watch?v=video_123-4&autoplay=1"),
            ("https://youtube.com/watch?v=video_123-4&autoplay=0#ignored", "YouTube", "https://www.youtube.com", "https://www.youtube.com/watch?v=video_123-4&autoplay=1"),
            ("https://m.youtube.com/watch?v=video_123-4", "YouTube", "https://www.youtube.com", "https://www.youtube.com/watch?v=video_123-4&autoplay=1"),
            ("https://MUSIC.YOUTUBE.COM/watch?v=music_123-4&list=RD_music", "YouTube Music", "https://music.youtube.com", "https://music.youtube.com/watch?v=music_123-4&list=RD_music&autoplay=1"),
        ]
        for (raw, application, origin, expected) in cases {
            let source = try #require(URL(string: raw))
            let target = try #require(try YouTubeMediaTarget.resolve(source))
            #expect(target.application == application)
            #expect(target.origin == origin)
            #expect(target.url.absoluteString == expected)
        }
    }

    @Test func shortLiveEmbedAndPlaylistLinksPreserveMediaAndPlaybackPosition() throws {
        let cases = [
            ("https://youtu.be/video_123-4?si=tracking&t=1h2m3s", "https://www.youtube.com/watch?v=video_123-4&t=1h2m3s&autoplay=1"),
            ("https://youtu.be/video_123-4/?v=ignored&list=PL_123&start=12&index=3", "https://www.youtube.com/watch?v=video_123-4&list=PL_123&start=12&index=3&autoplay=1"),
            ("https://www.youtube.com/shorts/video_123-4", "https://www.youtube.com/watch?v=video_123-4&autoplay=1"),
            ("https://youtube.com/live/video_123-4/?t=120", "https://www.youtube.com/watch?v=video_123-4&t=120&autoplay=1"),
            ("https://m.youtube.com/embed/video_123-4?start=0", "https://www.youtube.com/watch?v=video_123-4&start=0&autoplay=1"),
            ("https://music.youtube.com/playlist?list=PL_music&index=12", "https://music.youtube.com/watch?list=PL_music&index=12&autoplay=1"),
            ("https://youtube.com/playlist?list=PL_video", "https://www.youtube.com/watch?list=PL_video&autoplay=1"),
            ("https://music.youtube.com/watch?list=RD_music", "https://music.youtube.com/watch?list=RD_music&autoplay=1"),
        ]
        for (raw, expected) in cases {
            let source = try #require(URL(string: raw))
            let target = try #require(try YouTubeMediaTarget.resolve(source))
            #expect(target.url.absoluteString == expected)
        }
    }

    @Test func HTTPAndExplicitDefaultPortsBecomeHTTPSMediaLinks() throws {
        for raw in ["http://youtube.com/watch?v=id", "http://youtube.com:80/watch?v=id", "https://youtube.com:443/watch?v=id"] {
            let source = try #require(URL(string: raw))
            let target = try #require(try YouTubeMediaTarget.resolve(source))
            #expect(target.url.absoluteString == "https://www.youtube.com/watch?v=id&autoplay=1")
        }
    }

    @Test func dotSegmentsNormalizeWithoutDecodingMediaPaths() throws {
        let cases = [
            ("https://youtube.com/unused/../watch?v=id", "https://www.youtube.com/watch?v=id&autoplay=1"),
            ("https://music.youtube.com/unused/%2E%2e/watch?v=id", "https://music.youtube.com/watch?v=id&autoplay=1"),
            ("https://youtube.com/./shorts/id", "https://www.youtube.com/watch?v=id&autoplay=1"),
            ("https://youtu.be/unused/.%2e/id", "https://www.youtube.com/watch?v=id&autoplay=1"),
            ("https://youtu.be/id/.", "https://www.youtube.com/watch?v=id&autoplay=1"),
        ]
        for (raw, expected) in cases {
            let source = try #require(URL(string: raw))
            let target = try #require(try YouTubeMediaTarget.resolve(source))
            #expect(target.url.absoluteString == expected)
        }
        for raw in ["https://youtube.com/watch/..", "https://youtube.com/watch/%2e%2e", "https://youtu.be"] {
            let source = try #require(URL(string: raw))
            #expect(try YouTubeMediaTarget.resolve(source) == nil)
        }
    }

    @Test func unrelatedPagesAndLookalikeHostsKeepDefaultURLOpening() throws {
        for raw in [
            "https://example.com/watch?v=id", "https://youtube.com.example.com/watch?v=id",
            "https://notyoutube.com/watch?v=id", "https://music.youtube.com.example.com/watch?v=id",
            "https://www.youtu.be/id", "https://youtube.com./watch?v=id",
            "https://youtube.com", "https://music.youtube.com/", "https://youtu.be/",
            "https://youtube.com/results?search_query=music", "https://youtube.com/@artist",
            "https://youtube.com/channel/channel_id", "https://youtube.com/watching?v=id",
            "https://youtube.com/%77atch?v=id",
        ] {
            let source = try #require(URL(string: raw))
            #expect(try YouTubeMediaTarget.resolve(source) == nil)
        }
    }

    @Test func malformedMediaIsRejectedWithoutDisclosingTheURL() throws {
        for raw in [
            "https://youtube.com/watch", "https://youtube.com/watch?v=", "https://youtube.com/watch?v=&list=PL_id",
            "https://youtube.com/watch?v=id&list=", "https://youtube.com/watch?v=bad%2Fid",
            "https://youtube.com/playlist", "https://youtube.com/watch/?v=id", "https://youtube.com/playlist/extra?list=id",
            "https://youtube.com/shorts", "https://youtube.com/shorts/bad%2Fid", "https://youtube.com/live/id/extra",
            "https://youtube.com/shorts//id", "https://youtu.be//id",
            "https://youtu.be/id/extra", "https://youtu.be/%69d",
            "https://youtube.com/watch?v=id&v=other", "https://youtube.com/watch?v=id&%76=other",
            "https://youtube.com/watch?v=id&list=one&list=two", "https://youtube.com/watch?v=id&t=1&t=2",
            "https://youtube.com/watch?v=id&start=1&start=2", "https://youtube.com/watch?v=id&index=1&index=2",
            "https://youtube.com/watch?v=id&t=", "https://youtube.com/watch?v=id&t=1m2h",
            "https://youtube.com/watch?v=id&t=1.5", "https://youtube.com/watch?v=id&start=-1",
            "https://youtube.com/watch?v=id&index=1.5", "https://youtube.com/watch?v=id&start=",
            "https://youtube.com/watch?v=id&index=+1", "https://youtube.com:8443/watch?v=id",
            "http://youtube.com:443/watch?v=id", "https://youtube.com:80/watch?v=id",
            "https://user:password@youtube.com/watch?v=id", "ftp://youtube.com/watch?v=id",
            "https://youtube.com/watch?v=" + String(repeating: "a", count: 129),
            "https://youtube.com/playlist?list=" + String(repeating: "a", count: 257),
            "https://youtube.com/watch?v=id&t=" + String(repeating: "1", count: 33),
        ] {
            let url = try #require(URL(string: raw))
            do {
                _ = try YouTubeMediaTarget.resolve(url)
                Issue.record("Malformed media URL was accepted: \(raw)")
            } catch {
                #expect(!error.localizedDescription.contains(raw))
                #expect(!error.localizedDescription.contains("password"))
                #expect(!error.localizedDescription.contains("watch?"))
            }
        }
    }
}
