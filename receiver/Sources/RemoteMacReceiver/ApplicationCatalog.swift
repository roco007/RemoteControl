import AppKit
import ReceiverCore

/// Mirrors the launcher project's user-facing app roots and bundle traversal rules.
final class ApplicationCatalog {
    private let queue = DispatchQueue(label: "com.remotemac.receiver.apps", qos: .userInitiated)
    private var snapshot: [InstalledApplication]?
    private var waiting: [([InstalledApplication], String?) -> Void] = []
    private let roots: [URL]

    init(roots: [URL] = [URL(fileURLWithPath: "/Applications"), URL(fileURLWithPath: "/System/Applications"), FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications")]) { self.roots = roots }

    func list(refresh: Bool, completion: @escaping ([InstalledApplication], String?) -> Void) {
        queue.async {
            if !refresh, let snapshot = self.snapshot { completion(snapshot, nil); return }
            self.waiting.append(completion)
            guard self.waiting.count == 1 else { return }
            let urls = Self.applicationURLs(roots: self.roots)
            DispatchQueue.main.async {
                let applications = urls.compactMap { url -> InstalledApplication? in
                    guard url.path.utf16.count <= 2048 else { return nil }
                    let bundle = Bundle(url: url)
                    let displayName = bundle?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
                    let bundleName = bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String
                    let fallback = url.deletingPathExtension().lastPathComponent
                    let name = [displayName, bundleName, fallback].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }.first { !$0.isEmpty } ?? fallback
                    return InstalledApplication(id: url.path, name: String(decoding: name.utf16.prefix(160), as: UTF16.self), icon: Self.icon(url))
                }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending || ($0.name == $1.name && $0.id < $1.id) }
                self.queue.async {
                    self.snapshot = applications
                    let callbacks = self.waiting; self.waiting.removeAll()
                    callbacks.forEach { $0(applications, nil) }
                }
            }
        }
    }

    func open(id: String, completion: @escaping (Bool, String?) -> Void) {
        // Re-scan names so a saved action works after receiver restart, without ever
        // interpreting a phone-provided path as a shell command or document URL.
        queue.async {
            let allowed = Self.applicationURLs(roots: self.roots).contains { $0.path == id }
            guard allowed else { completion(false, "This Mac app is no longer installed. Choose it again."); return }
            DispatchQueue.main.async {
                let configuration = NSWorkspace.OpenConfiguration()
                configuration.activates = true
                NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: id), configuration: configuration) { app, error in
                    completion(app != nil && error == nil, error == nil ? "Mac app opened." : "macOS could not open this app.")
                }
            }
        }
    }

    static func applicationURLs(roots: [URL]) -> [URL] {
        let manager = FileManager.default
        var visited = Set<String>(), apps = Set<URL>()
        func walk(_ directory: URL) {
            let canonical = directory.resolvingSymlinksInPath().standardizedFileURL
            guard visited.insert(canonical.path).inserted,
                  let entries = try? manager.contentsOfDirectory(at: canonical, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey], options: [.skipsHiddenFiles]) else { return }
            for entry in entries {
                let properties = try? entry.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                if entry.pathExtension.lowercased() == "app" {
                    let resolved = entry.resolvingSymlinksInPath().standardizedFileURL
                    if manager.fileExists(atPath: resolved.appendingPathComponent("Contents/Info.plist").path) { apps.insert(resolved) }
                    continue
                }
                if properties?.isDirectory == true && properties?.isSymbolicLink != true { walk(entry) }
            }
        }
        roots.forEach(walk)
        return apps.sorted { $0.path < $1.path }
    }

    private static func icon(_ url: URL) -> String? {
        let source = NSWorkspace.shared.icon(forFile: url.path)
        for size in [48, 32, 24] {
            guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
                  let context = NSGraphicsContext(bitmapImageRep: bitmap) else { continue }
            NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = context
            source.draw(in: NSRect(x: 0, y: 0, width: size, height: size), from: .zero, operation: .copy, fraction: 1)
            NSGraphicsContext.restoreGraphicsState()
            guard let data = bitmap.representation(using: .png, properties: [:]) else { continue }
            let uri = "data:image/png;base64," + data.base64EncodedString()
            if uri.utf16.count <= 8192 { return uri }
        }
        return nil
    }
}
