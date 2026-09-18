// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "BossSDD",
    platforms: [.macOS(.v14)],
    targets: [
        .target(
            name: "BoardKit",
            path: "Sources/BoardKit",
            linkerSettings: [.linkedLibrary("sqlite3")]
        ),
        .executableTarget(
            name: "BossSDD",
            dependencies: ["BoardKit"],
            path: "Sources/BossSDD"
        ),
        .testTarget(
            name: "BoardKitTests",
            dependencies: ["BoardKit"],
            path: "Tests/BoardKitTests"
        ),
    ]
)
