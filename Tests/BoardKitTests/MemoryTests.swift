import Foundation
import Testing
@testable import BoardKit

/// Builds a `Store` backed by a throwaway SQLite file under a fresh temporary
/// directory, and removes that directory afterwards. Never touches
/// `Store.defaultDirectory` (`~/.claude/plan-sdd`), which holds the user's real board.
private func withTempStore(_ body: (Store) throws -> Void) throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("boss-sdd-memory-tests-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = try Store(path: directory.appendingPathComponent("board.sqlite3"))
    try body(store)
}

/// Same isolation, but the test needs the file path too (migration, raw queries).
private func withTempDatabaseFile(_ body: (URL) throws -> Void) throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("boss-sdd-memory-tests-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try body(directory.appendingPathComponent("board.sqlite3"))
}

@Suite struct MemoryTests {

    // MARK: - Round trip

    @Test func addGetListAndDeleteRoundTrip() throws {
        try withTempStore { store in
            let written = try store.upsertMemory(
                project: "boss-sdd", key: "gate.swift-test", value: "swift test",
                kind: .gate, source: "README.md:82"
            )
            #expect(written.project == "boss-sdd")
            #expect(written.key == "gate.swift-test")
            #expect(written.value == "swift test")
            #expect(written.kind == .gate)
            #expect(written.source == "README.md:82")

            let fetched = try store.memory(project: "boss-sdd", key: "gate.swift-test")
            #expect(fetched == written)

            let listed = try store.memories(project: "boss-sdd")
            #expect(listed == [written])

            try store.deleteMemory(project: "boss-sdd", key: "gate.swift-test")
            #expect(try store.memories(project: "boss-sdd").isEmpty)

            // Gone means gone: the read and the second delete both 404.
            #expect(throws: BoardError.self) {
                _ = try store.memory(project: "boss-sdd", key: "gate.swift-test")
            }
            #expect(throws: BoardError.self) {
                try store.deleteMemory(project: "boss-sdd", key: "gate.swift-test")
            }
        }
    }

    /// The same key twice overwrites in place. One row, the new value — not two
    /// rows the next reader has to disambiguate.
    @Test func writingTheSameKeyTwiceOverwritesInsteadOfDuplicating() throws {
        try withTempStore { store in
            let first = try store.upsertMemory(
                project: "boss-sdd", key: "gate.swift-test", value: "swift test",
                kind: .gate, source: "README.md:82"
            )
            let second = try store.upsertMemory(
                project: "boss-sdd", key: "gate.swift-test", value: "swift test --parallel",
                kind: .gate, source: "Package.swift:1"
            )

            let listed = try store.memories(project: "boss-sdd")
            #expect(listed.count == 1)
            #expect(listed.first?.value == "swift test --parallel")
            #expect(listed.first?.source == "Package.swift:1")

            // `created_at` survives the overwrite, so "when did we first learn this"
            // stays answerable; `updated_at` is what moves.
            #expect(second.createdAt == first.createdAt)
            #expect(second.updatedAt >= first.updatedAt)
        }
    }

    /// A rewrite may also change `kind`, and the filter must follow it rather than
    /// leaving the entry indexed under the category it used to have.
    @Test func overwritingCanChangeKind() throws {
        try withTempStore { store in
            _ = try store.upsertMemory(
                project: "p", key: "k", value: "v1", kind: .note, source: "a.md:1"
            )
            _ = try store.upsertMemory(
                project: "p", key: "k", value: "v2", kind: .gate, source: "b.md:2"
            )
            #expect(try store.memories(project: "p", kind: .note).isEmpty)
            #expect(try store.memories(project: "p", kind: .gate).map(\.value) == ["v2"])
        }
    }

    // MARK: - The dimension

    /// The whole point of keying on project: two projects may hold the same key
    /// with different values, and neither read, list nor delete may cross over.
    @Test func projectsDoNotSeeEachOthersMemories() throws {
        try withTempStore { store in
            _ = try store.upsertMemory(
                project: "alpha", key: "gate", value: "swift test", kind: .gate, source: "alpha/README:1"
            )
            _ = try store.upsertMemory(
                project: "beta", key: "gate", value: "go test ./...", kind: .gate, source: "beta/README:1"
            )

            #expect(try store.memory(project: "alpha", key: "gate").value == "swift test")
            #expect(try store.memory(project: "beta", key: "gate").value == "go test ./...")
            #expect(try store.memories(project: "alpha").map(\.value) == ["swift test"])
            #expect(try store.memories(project: "beta").map(\.value) == ["go test ./..."])

            // Deleting one project's entry leaves the other project's alone.
            try store.deleteMemory(project: "alpha", key: "gate")
            #expect(try store.memories(project: "alpha").isEmpty)
            #expect(try store.memory(project: "beta", key: "gate").value == "go test ./...")

            // A project nobody wrote to reads empty, not everybody else's entries.
            #expect(try store.memories(project: "gamma").isEmpty)
        }
    }

    /// An empty project would be a bucket every project shares, which defeats the
    /// dimension. `Run.project` defaults to "", so this is reachable by accident.
    @Test func anEmptyProjectIsRefused() throws {
        try withTempStore { store in
            #expect(throws: BoardError.self) {
                _ = try store.upsertMemory(
                    project: "   ", key: "k", value: "v", kind: .note, source: "x:1"
                )
            }
            #expect(throws: BoardError.self) { _ = try store.memories(project: "") }
        }
    }

    // MARK: - kind

    @Test func listFiltersByKind() throws {
        try withTempStore { store in
            _ = try store.upsertMemory(
                project: "p", key: "gate.swift", value: "swift test", kind: .gate, source: "README:82"
            )
            _ = try store.upsertMemory(
                project: "p", key: "gate.go", value: "cd mcp && go test -count=1 ./...",
                kind: .gate, source: "README:83"
            )
            _ = try store.upsertMemory(
                project: "p", key: "start", value: "./Scripts/bundle.sh --install",
                kind: .runRecipe, source: "README:27"
            )
            _ = try store.upsertMemory(
                project: "p", key: "port", value: "18888", kind: .hardRule, source: "HTTPServer.swift:8"
            )

            #expect(try store.memories(project: "p").count == 4)
            #expect(try store.memories(project: "p", kind: .gate).map(\.key) == ["gate.go", "gate.swift"])
            #expect(try store.memories(project: "p", kind: .runRecipe).map(\.key) == ["start"])
            #expect(try store.memories(project: "p", kind: .hardRule).map(\.key) == ["port"])
            #expect(try store.memories(project: "p", kind: .convention).isEmpty)
            #expect(try store.memories(project: "p", kind: .exclusiveResource).isEmpty)
            #expect(try store.memories(project: "p", kind: .note).isEmpty)
        }
    }

    // MARK: - source

    /// `source` is what makes a stale memory falsifiable. A gate command that has
    /// since changed, stored without a source, makes a later agent run the wrong
    /// gate and report green — so a sourceless entry is refused, not defaulted.
    @Test func sourceIsRequiredAndSurvivesEveryReadPath() throws {
        try withTempStore { store in
            #expect(throws: BoardError.self) {
                _ = try store.upsertMemory(
                    project: "p", key: "k", value: "v", kind: .gate, source: ""
                )
            }
            #expect(throws: BoardError.self) {
                _ = try store.upsertMemory(
                    project: "p", key: "k", value: "v", kind: .gate, source: "  \n "
                )
            }
            #expect(try store.memories(project: "p").isEmpty)

            let written = try store.upsertMemory(
                project: "p", key: "k", value: "swift test", kind: .gate, source: "README.md:82"
            )
            #expect(written.source == "README.md:82")
            #expect(try store.memory(project: "p", key: "k").source == "README.md:82")
            #expect(try store.memories(project: "p").map(\.source) == ["README.md:82"])
            #expect(try store.memories(project: "p", kind: .gate).map(\.source) == ["README.md:82"])
        }
    }

    // MARK: - Keys

    @Test func malformedKeysAreRefused() throws {
        try withTempStore { store in
            for key in ["", "has space", "has/slash", String(repeating: "x", count: 65)] {
                #expect(throws: BoardError.self) {
                    _ = try store.upsertMemory(
                        project: "p", key: key, value: "v", kind: .note, source: "x:1"
                    )
                }
            }
            // Dotted and dashed slugs are the intended shape and are accepted.
            _ = try store.upsertMemory(
                project: "p", key: "gate.swift-test_2", value: "v", kind: .note, source: "x:1"
            )
            #expect(try store.memories(project: "p").map(\.key) == ["gate.swift-test_2"])
        }
    }

    // MARK: - Key case folding

    /// Keys fold to lower case, so one fact is one row however it was capitalised.
    ///
    /// Without the fold SQLite's BINARY collation makes these two rows: both writes
    /// succeed, `kind=gate` returns both, and the reader cannot tell which is
    /// current. That is the same drift `MemoryKind` is closed to prevent.
    @Test func keysAreCaseFoldedSoOneFactIsOneRow() throws {
        try withTempStore { store in
            _ = try store.upsertMemory(
                project: "p", key: "gate.swift-test", value: "swift test",
                kind: .gate, source: "README:82"
            )
            // The same fact, typed by a different agent with different capitalisation.
            _ = try store.upsertMemory(
                project: "p", key: "Gate.Swift-Test", value: "swift test --parallel",
                kind: .gate, source: "Package.swift:1"
            )

            let listed = try store.memories(project: "p")
            #expect(listed.count == 1)
            #expect(listed.first?.key == "gate.swift-test")
            #expect(listed.first?.value == "swift test --parallel")

            // Every read path reaches the one row from either spelling.
            #expect(try store.memory(project: "p", key: "GATE.SWIFT-TEST").value == "swift test --parallel")
            #expect(try store.memory(project: "p", key: "gate.swift-test").value == "swift test --parallel")

            // And so does delete — the 404-with-the-row-right-there case.
            try store.deleteMemory(project: "p", key: "Gate.Swift-Test")
            #expect(try store.memories(project: "p").isEmpty)
        }
    }

    /// `project` is deliberately *not* folded: it is a filesystem path or name
    /// supplied verbatim by the caller and matched against `Run.project`, and macOS
    /// paths can differ in case. Pinned so the asymmetry with `key` stays a decision.
    @Test func projectsAreNotCaseFolded() throws {
        try withTempStore { store in
            _ = try store.upsertMemory(
                project: "Alpha", key: "gate", value: "upper", kind: .gate, source: "a:1"
            )
            _ = try store.upsertMemory(
                project: "alpha", key: "gate", value: "lower", kind: .gate, source: "a:2"
            )
            #expect(try store.memory(project: "Alpha", key: "gate").value == "upper")
            #expect(try store.memory(project: "alpha", key: "gate").value == "lower")
        }
    }

    /// Covers the `isASCII` branch of `isValidMemoryKey`, which the alphabet cases
    /// above never reach: lower-casing a non-ASCII key leaves it non-ASCII.
    @Test func nonASCIIKeysAreRefused() throws {
        try withTempStore { store in
            for key in ["门禁", "gate.门禁", "gaté", "gate\u{200B}x"] {
                #expect(throws: BoardError.self) {
                    _ = try store.upsertMemory(
                        project: "p", key: key, value: "v", kind: .note, source: "x:1"
                    )
                }
            }
            let stored = try store.memories(project: "p")
            #expect(stored.isEmpty)
        }
    }

    // MARK: - Schema migration

    /// The exact schema a database in the field was created with, frozen here on
    /// purpose: this is what `Store` has to keep opening after `memories` is added.
    private static let schemaBeforeMemories = """
        CREATE TABLE IF NOT EXISTS runs(
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            project TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL,
            summary TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tasks(
            run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            id TEXT NOT NULL,
            title TEXT NOT NULL,
            status TEXT NOT NULL,
            detail TEXT NOT NULL DEFAULT '',
            agent TEXT NOT NULL DEFAULT '',
            position INTEGER NOT NULL,
            updated_at REAL,
            PRIMARY KEY(run_id, id)
        );
        CREATE TABLE IF NOT EXISTS task_lists(
            run_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            position INTEGER NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY(run_id, task_id, kind, position),
            FOREIGN KEY(run_id, task_id) REFERENCES tasks(run_id, id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS events(
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
            at REAL NOT NULL,
            action TEXT NOT NULL,
            task_id TEXT,
            status TEXT,
            note TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS events_by_run ON events(run_id, seq);
        """

    /// A database that predates `memories` must still open, must keep the run data
    /// it already held, and must come back with the new table in place.
    @Test func aDatabaseCreatedBeforeMemoriesStillOpensAndGainsTheTable() throws {
        try withTempDatabaseFile { path in
            // 1. A database exactly as it exists in the field today. The `do` block
            // is for scoping, not for catching: it drops the last reference to
            // `legacy` at its closing brace, so `Database.deinit` runs
            // `sqlite3_close_v2` before `Store` opens the same file below. Errors
            // still propagate out of the test as usual.
            let runID = "legacyrun0001"
            do {
                let legacy = try Database(path: path.path)
                try legacy.execute(Self.schemaBeforeMemories)
                #expect(try Self.tableNames(legacy).contains("memories") == false)
                let now = Date().timeIntervalSince1970
                try legacy.run(
                    "INSERT INTO runs(id, title, project, status, summary, created_at, updated_at) VALUES(?,?,?,?,?,?,?)",
                    [
                        .text(runID), .text("旧计划"), .text("legacy-project"),
                        .text(RunStatus.running.rawValue), .text("留下来的"),
                        .double(now), .double(now),
                    ]
                )
                try legacy.run(
                    """
                    INSERT INTO tasks(run_id, id, title, status, detail, agent, position, updated_at)
                    VALUES(?,?,?,?,?,?,?,?)
                    """,
                    [
                        .text(runID), .text("T1"), .text("旧任务"), .text(TaskStatus.done.rawValue),
                        .text(""), .text(""), .int(0), .null,
                    ]
                )
            }

            // 2. Opening it with the current Store must not throw.
            let store = try Store(path: path)

            // 3. The old data is intact.
            let reloaded = try store.run(runID)
            #expect(reloaded.title == "旧计划")
            #expect(reloaded.project == "legacy-project")
            #expect(reloaded.tasks.map(\.id) == ["T1"])

            // 4. The new table exists and works on the upgraded database.
            _ = try store.upsertMemory(
                project: "legacy-project", key: "gate", value: "swift test",
                kind: .gate, source: "README.md:82"
            )
            #expect(try store.memory(project: "legacy-project", key: "gate").value == "swift test")

            // 5. Stated against sqlite_master directly, not only through the Store.
            let inspector = try Database(path: path.path)
            #expect(try Self.tableNames(inspector).contains("memories"))
        }
    }

    /// Opening the same database twice in a row is what actually happens every time
    /// the app restarts; `CREATE TABLE IF NOT EXISTS` must stay a no-op the second
    /// time and must not disturb rows already in `memories`.
    @Test func reopeningAnUpgradedDatabaseKeepsItsMemories() throws {
        try withTempDatabaseFile { path in
            // Scoping again: the first `Store` must be released — and its `Database`
            // closed — before the second opens the same file.
            do {
                let store = try Store(path: path)
                _ = try store.upsertMemory(
                    project: "p", key: "gate", value: "swift test", kind: .gate, source: "README:82"
                )
            }
            let reopened = try Store(path: path)
            #expect(try reopened.memory(project: "p", key: "gate").value == "swift test")
            #expect(try reopened.memories(project: "p").count == 1)
        }
    }

    private static func tableNames(_ database: Database) throws -> [String] {
        try database.query("SELECT name FROM sqlite_master WHERE type = 'table'").map {
            $0.string("name")
        }
    }
}
