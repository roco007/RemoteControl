import Foundation

struct YouTubeMediaTarget: Equatable {
    let application: String
    let url: URL
    let origin: String

    static func resolve(_ source: URL) throws -> YouTubeMediaTarget? {
        guard var components = URLComponents(url: source, resolvingAgainstBaseURL: false),
              let host = components.host?.lowercased(),
              ["music.youtube.com", "www.youtube.com", "youtube.com", "m.youtube.com", "youtu.be"].contains(host) else {
            return nil
        }
        let path = normalizedPath(components.percentEncodedPath)
        let isMedia = host == "youtu.be" ? path != "/" : matches(path, #"^/(?:watch|playlist|shorts|live|embed)(?:/|$)"#)
        guard isMedia else { return nil }
        guard let scheme = components.scheme?.lowercased(), ["http", "https"].contains(scheme),
              components.user == nil, components.password == nil, source.absoluteString.utf16.count <= 4096 else {
            throw YouTubeMediaError.invalidLink
        }
        if let port = components.port, port != (scheme == "http" ? 80 : 443) {
            throw YouTubeMediaError.nonstandardPort
        }

        // URLSearchParams uses form decoding; Foundation otherwise leaves '+' literal.
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%20")
        let items = components.queryItems ?? []
        var parameters: [String: String] = [:]
        for key in ["v", "list", "t", "start", "index"] {
            let values = items.filter { $0.name == key }
            guard values.count <= 1 else { throw YouTubeMediaError.duplicateParameter(key) }
            if let item = values.first { parameters[key] = item.value ?? "" }
        }

        var video = parameters["v"]
        let playlist = parameters["list"]
        if host == "youtu.be" {
            guard matches(path, #"^/[A-Za-z0-9_-]+/?\z"#) else { throw YouTubeMediaError.invalidLink }
            video = path.split(separator: "/").first.map(String.init)
        } else if path != "/watch" && path != "/playlist" {
            guard matches(path, #"^/(?:shorts|live|embed)/[A-Za-z0-9_-]+/?\z"#) else { throw YouTubeMediaError.invalidLink }
            video = path.split(separator: "/").last.map(String.init)
        }
        guard video != nil || playlist != nil,
              video.map({ matches($0, #"^[A-Za-z0-9_-]{1,128}\z"#) }) ?? true,
              playlist.map({ matches($0, #"^[A-Za-z0-9_-]{1,256}\z"#) }) ?? true else {
            throw YouTubeMediaError.invalidLink
        }

        var targetItems: [URLQueryItem] = []
        if let video { targetItems.append(URLQueryItem(name: "v", value: video)) }
        if let playlist { targetItems.append(URLQueryItem(name: "list", value: playlist)) }
        for key in ["t", "start", "index"] {
            if let value = parameters[key] {
                let pattern = key == "t" ? #"^(?:[0-9]+|(?:[0-9]+h)?(?:[0-9]+m)?(?:[0-9]+s)?)\z"# : #"^[0-9]+\z"#
                guard !value.isEmpty, value.utf16.count <= 32, matches(value, pattern) else {
                    throw YouTubeMediaError.invalidParameter(key)
                }
                targetItems.append(URLQueryItem(name: key, value: value))
            }
        }
        targetItems.append(URLQueryItem(name: "autoplay", value: "1"))
        let music = host == "music.youtube.com"
        let origin = music ? "https://music.youtube.com" : "https://www.youtube.com"
        var target = URLComponents(string: origin + "/watch")!
        target.queryItems = targetItems
        guard let url = target.url else { throw YouTubeMediaError.invalidLink }
        return YouTubeMediaTarget(application: music ? "YouTube Music" : "YouTube", url: url, origin: origin)
    }

    private static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: pattern, options: .regularExpression) != nil
    }

    /// WHATWG URLs collapse literal and percent-encoded dot segments, but retain other escapes.
    private static func normalizedPath(_ path: String) -> String {
        guard !path.isEmpty else { return "/" }
        let segments = path.split(separator: "/", omittingEmptySubsequences: false)
        var result: [String] = []
        for (index, segment) in segments.enumerated() {
            let dot = segment.replacingOccurrences(of: "%2e", with: ".", options: .caseInsensitive)
            if dot == "." || dot == ".." {
                if dot == "..", result.count > 1 { result.removeLast() }
                if index == segments.count - 1 { result.append("") }
            } else {
                result.append(String(segment))
            }
        }
        return result.joined(separator: "/")
    }
}

enum YouTubeMediaError: Error, LocalizedError {
    case invalidLink
    case nonstandardPort
    case duplicateParameter(String)
    case invalidParameter(String)

    var errorDescription: String? {
        switch self {
        case .invalidLink: return "Enter a valid YouTube video or playlist link."
        case .nonstandardPort: return "YouTube media links must use the standard HTTP or HTTPS port."
        case .duplicateParameter(let key): return "The YouTube link has duplicate \(key) parameters."
        case .invalidParameter(let key): return "The YouTube link has an invalid \(key) value."
        }
    }
}
