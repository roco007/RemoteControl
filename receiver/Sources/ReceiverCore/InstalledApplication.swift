import Foundation

public struct InstalledApplication: Equatable {
    public let id: String
    public let name: String
    public let icon: String?
    public init(id: String, name: String, icon: String? = nil) {
        self.id = id; self.name = name; self.icon = icon
    }
    var fields: [String: Any] {
        var value: [String: Any] = ["id": id, "name": name]
        if let icon { value["icon"] = icon }
        return value
    }
}
