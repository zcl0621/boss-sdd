import Foundation
import Testing
@testable import BoardKit

/// `BOSS_SDD_HOME` is what lets anything other than the user's own board be
/// opened. These read the override out of an injected environment rather than
/// the process one, so nothing here can reach the real home.
@Suite struct HomeOverrideTests {

    @Test func anUnsetOverrideKeepsTheDefaultHome() throws {
        #expect(try Store.configuredDirectory(environment: [:]) == Store.defaultDirectory)
    }

    @Test func anAbsolutePathBecomesTheHome() throws {
        let directory = try Store.configuredDirectory(
            environment: [Store.homeEnvironmentKey: "/tmp/boss-sdd-home-check"]
        )
        #expect(directory.path == "/tmp/boss-sdd-home-check")
    }

    @Test func aTildePathIsExpandedRatherThanTakenLiterally() throws {
        let directory = try Store.configuredDirectory(
            environment: [Store.homeEnvironmentKey: "~/boss-sdd-home-check"]
        )
        #expect(!directory.path.contains("~"))
        #expect(directory.path.hasSuffix("/boss-sdd-home-check"))
    }

    /// The point of the whole override: set-but-unusable must be loud. A silent
    /// fallback here means a harness writes the user's real board.
    @Test(arguments: ["", "   ", "relative/path", "./board"])
    func anUnusableOverrideThrowsInsteadOfFallingBack(value: String) throws {
        #expect(throws: BoardError.self) {
            _ = try Store.configuredDirectory(environment: [Store.homeEnvironmentKey: value])
        }
    }

    @Test func aHomeThatCannotBeCreatedFailsTheStoreRatherThanRedirectingIt() throws {
        // /dev/null is a file, so no directory can be made under it.
        #expect(throws: (any Error).self) {
            _ = try Store(directory: URL(fileURLWithPath: "/dev/null/boss-sdd", isDirectory: true))
        }
    }

    /// The legacy import has to follow the home the store actually opened,
    /// otherwise an overridden board imports runs out of the real one.
    @Test func theLegacyRunsDirectoryFollowsTheStoresOwnHome() throws {
        let home = FileManager.default.temporaryDirectory
            .appendingPathComponent("boss-sdd-home-tests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: home) }

        let store = try Store(directory: home)
        #expect(store.directory.standardizedFileURL == home.standardizedFileURL)

        let runs = LegacyImport.runsDirectory(in: store.directory)
        #expect(runs.standardizedFileURL
            == home.appendingPathComponent("runs", isDirectory: true).standardizedFileURL)
        #expect(!runs.path.hasPrefix(Store.defaultDirectory.path))
    }
}
