// swift-tools-version: 6.0
import PackageDescription
import Foundation
// Apple's standalone CLT contains Swift Testing but does not add its framework search path.
let cltFrameworks = "/Library/Developer/CommandLineTools/Library/Developer/Frameworks"
let usesCLT = FileManager.default.fileExists(atPath: cltFrameworks + "/Testing.framework")
let package = Package(
    name: "RemoteMacReceiver",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "RemoteMacReceiver", targets: ["RemoteMacReceiver"]), .executable(name: "ReceiverIntegrationHarness", targets: ["ReceiverIntegrationHarness"])],
    targets: [
        .target(name: "ReceiverCore"),
        .executableTarget(name: "RemoteMacReceiver", dependencies: ["ReceiverCore"]),
        .executableTarget(name: "ReceiverIntegrationHarness", dependencies: ["ReceiverCore"]),
        .testTarget(name: "ReceiverCoreTests", dependencies: ["ReceiverCore"],
                    swiftSettings: usesCLT ? [.unsafeFlags(["-F", cltFrameworks, "-Xfrontend", "-disable-cross-import-overlays"])] : [],
                    linkerSettings: usesCLT ? [.unsafeFlags(["-F", cltFrameworks, "-Xlinker", "-rpath", "-Xlinker", cltFrameworks])] : []),
        .testTarget(name: "NativeInputTests", dependencies: ["RemoteMacReceiver", "ReceiverCore"],
                    swiftSettings: usesCLT ? [.unsafeFlags(["-F", cltFrameworks, "-Xfrontend", "-disable-cross-import-overlays"])] : [],
                    linkerSettings: usesCLT ? [.unsafeFlags(["-F", cltFrameworks, "-Xlinker", "-rpath", "-Xlinker", cltFrameworks])] : [])
    ],
    swiftLanguageModes: [.v5]
)
