import Foundation
import Testing
@testable import BoardKit

/// Builds a `Store` backed by a throwaway SQLite file under a fresh temporary
/// directory, and removes that directory afterwards. Never touches
/// `Store.defaultDirectory` (`~/.claude/plan-sdd`), which holds the user's real board.
private func withTempStore(_ body: (Store) throws -> Void) throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("boss-sdd-legacy-store-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = try Store(path: directory.appendingPathComponent("board.sqlite3"))
    try body(store)
}

/// Builds a fresh, empty temporary directory for legacy run JSON files, and
/// removes it afterwards.
private func withTempDirectory(_ body: (URL) throws -> Void) throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("boss-sdd-legacy-runs-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    try body(directory)
}

@Suite struct LegacyImportTests {

    // MARK: - parseRun tolerance

    @Test func parseRunToleratesMissingFields() throws {
        let json = #"{"id":"legacy-minimal"}"#
        let run = try LegacyImport.parseRun(data: Data(json.utf8))

        #expect(run.id == "legacy-minimal")
        #expect(run.title == "未命名运行")
        #expect(run.project == "")
        #expect(run.status == .planning)
        #expect(run.summary == "")
        #expect(run.tasks.isEmpty)
        #expect(run.events.isEmpty)
        #expect(run.updatedAt == run.createdAt)
    }

    @Test func parseRunFallsBackOnUnrecognisedStatus() throws {
        let json = #"{"id":"legacy-status","status":"vanished_status_from_the_old_board"}"#
        let run = try LegacyImport.parseRun(data: Data(json.utf8))

        #expect(run.id == "legacy-status")
        #expect(run.status == .planning)
    }

    @Test func parseRunHonoursARecognisedStatus() throws {
        // Contrasts with parseRunFallsBackOnUnrecognisedStatus: without this case,
        // nothing pins that a *valid* status is actually read rather than always
        // reset to .planning (missing and unrecognised both happen to yield .planning,
        // so those two tests alone can't tell "ignored" apart from "defaulted").
        let json = #"{"id":"legacy-status-ok","status":"running"}"#
        let run = try LegacyImport.parseRun(data: Data(json.utf8))

        #expect(run.id == "legacy-status-ok")
        #expect(run.status == .running)
    }

    @Test func parseRunSkipsNonObjectTaskEntries() throws {
        let json = """
            {
                "id": "legacy-tasks",
                "tasks": [
                    "this is a string, not a task object",
                    42,
                    ["nested", "array"],
                    {"id": "T1", "title": "ok task"}
                ]
            }
            """
        let run = try LegacyImport.parseRun(data: Data(json.utf8))

        #expect(run.tasks.count == 1)
        #expect(run.tasks.first?.id == "T1")
        #expect(run.tasks.first?.title == "ok task")
    }

    // MARK: - importAll resilience

    @Test func importAllSkipsMalformedFilesButKeepsImportingTheRest() throws {
        try withTempStore { store in
            try withTempDirectory { directory in
                let good1 = #"{"id":"legacy-good-1","title":"Good Run One"}"#
                let good2 = #"{"id":"legacy-good-2","title":"Good Run Two"}"#
                // Not valid JSON at all -- exercises the "skip and keep going" path
                // against a genuinely corrupt file, not just a semantically odd one.
                let bad = "this is not json"

                try Data(good1.utf8).write(to: directory.appendingPathComponent("a-good1.json"))
                try Data(bad.utf8).write(to: directory.appendingPathComponent("b-bad.json"))
                try Data(good2.utf8).write(to: directory.appendingPathComponent("c-good2.json"))

                let result = LegacyImport.importAll(from: directory, into: store)

                #expect(Set(result.imported) == Set(["legacy-good-1", "legacy-good-2"]))
                #expect(result.skipped.count == 1)
                #expect(result.skipped.first?.contains("b-bad.json") == true)

                // The good runs from the same directory actually landed in the store.
                let importedGood1 = try store.run("legacy-good-1")
                #expect(importedGood1.title == "Good Run One")
                let importedGood2 = try store.run("legacy-good-2")
                #expect(importedGood2.title == "Good Run Two")

                let allRuns = try store.allRuns()
                #expect(allRuns.count == 2)
            }
        }
    }

    @Test func importAllSkipsAFileThatIsAJSONArrayNotAnObject() throws {
        try withTempStore { store in
            try withTempDirectory { directory in
                let good = #"{"id":"legacy-good-3","title":"Still Good"}"#
                let badArray = "[1, 2, 3]"

                try Data(good.utf8).write(to: directory.appendingPathComponent("a-good.json"))
                try Data(badArray.utf8).write(to: directory.appendingPathComponent("b-array.json"))

                let result = LegacyImport.importAll(from: directory, into: store)

                #expect(result.imported == ["legacy-good-3"])
                #expect(result.skipped.count == 1)
                #expect(result.skipped.first?.contains("b-array.json") == true)

                let imported = try store.run("legacy-good-3")
                #expect(imported.title == "Still Good")
            }
        }
    }
}
