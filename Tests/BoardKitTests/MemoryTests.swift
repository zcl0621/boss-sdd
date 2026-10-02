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

    // MARK: - Per-project cap

    /// Filling a project to `memoryLimit` distinct keys, then trying to add one
    /// more, is refused — and the refusal leaves the store exactly as it was:
    /// still `memoryLimit` rows, none of them the rejected key.
    @Test func the101stDistinctKeyIsRefused() throws {
        try withTempStore { store in
            for i in 0..<memoryLimit {
                _ = try store.upsertMemory(
                    project: "p", key: "k\(i)", value: "v\(i)", kind: .note, source: "x:\(i)"
                )
            }
            #expect(try store.memories(project: "p").count == memoryLimit)

            #expect(throws: BoardError.self) {
                _ = try store.upsertMemory(
                    project: "p", key: "one-too-many", value: "v", kind: .note, source: "x:1"
                )
            }

            // Refused, not partially applied: still exactly the original set.
            let after = try store.memories(project: "p")
            #expect(after.count == memoryLimit)
            #expect(!after.contains { $0.key == "one-too-many" })
        }
    }

    /// The refusal message is the caller's only way to know what to do next: it
    /// must name the current count and point at deleting something, not just
    /// say "limit reached".
    ///
    /// At exactly the cap, `count` and `memoryLimit` are the same literal value
    /// (100), so `message.contains("\(memoryLimit)")` alone cannot tell "the
    /// message states the count" apart from "the message states only the
    /// constant" — deleting the count clause and leaving `at the limit of 100`
    /// behind still contains "100". Asserting on the count clause's own text
    /// closes that gap here; `theCountClauseNamesActualRowsNotJustTheLimit`
    /// below closes it completely, with a count that differs from the limit.
    @Test func theCapRefusalNamesTheCountAndTellsTheCallerToDelete() throws {
        try withTempStore { store in
            for i in 0..<memoryLimit {
                _ = try store.upsertMemory(
                    project: "p", key: "k\(i)", value: "v\(i)", kind: .note, source: "x:\(i)"
                )
            }
            do {
                _ = try store.upsertMemory(
                    project: "p", key: "one-too-many", value: "v", kind: .note, source: "x:1"
                )
                Issue.record("expected the cap to refuse this write")
            } catch let error as BoardError {
                #expect(error.httpStatus == 400)
                #expect(error.message.contains("already has \(memoryLimit) memories"))
                #expect(error.message.contains("at the limit of \(memoryLimit)"))
                #expect(error.message.lowercased().contains("delete"))
            }
        }
    }

    /// The one case that can actually distinguish "the message names the
    /// current count" from "the message just echoes `memoryLimit`": a database
    /// that already holds more rows than the limit before this write is even
    /// attempted, the way a database that predates the cap (or was seeded by
    /// some other path) could. Seeded by writing directly through a raw
    /// `Database` connection, bypassing `Store.upsertMemory` — and therefore
    /// its cap — entirely, since going through the cap could never produce
    /// more than `memoryLimit` rows in the first place.
    @Test func theCountClauseNamesActualRowsNotJustTheLimit() throws {
        try withTempDatabaseFile { path in
            let seededCount = memoryLimit + 5

            // 1. A real `Store` lays down the schema, including `memories`,
            // then is released so the file is free for the next connection.
            do {
                _ = try Store(path: path)
            }

            // 2. Seed past the limit directly, with no cap in the way.
            do {
                let seed = try Database(path: path.path)
                let now = Date().timeIntervalSince1970
                for i in 0..<seededCount {
                    try seed.run(
                        #"""
                        INSERT INTO memories(project, "key", value, kind, source, created_at, updated_at)
                        VALUES(?,?,?,?,?,?,?)
                        """#,
                        [
                            .text("p"), .text("seed\(i)"), .text("v"), .text(MemoryKind.note.rawValue),
                            .text("x:1"), .double(now), .double(now),
                        ]
                    )
                }
            }

            // 3. Reopen through `Store` and try to add one more new key.
            // `count` (105) and `memoryLimit` (100) are now genuinely
            // different numbers.
            let store = try Store(path: path)
            #expect(try store.memories(project: "p").count == seededCount)
            do {
                _ = try store.upsertMemory(
                    project: "p", key: "one-more", value: "v", kind: .note, source: "x:1"
                )
                Issue.record("expected the cap to refuse this write")
            } catch let error as BoardError {
                #expect(error.message.contains("already has \(seededCount) memories"))
                #expect(error.message.contains("at the limit of \(memoryLimit)"))
            }
        }
    }

    /// The part most likely to be gotten wrong: an upsert onto a key the
    /// project already has must keep working at the cap. An agent that hits
    /// the limit must be able to fix the one entry that is actually wrong
    /// (say, a stale gate command) without deleting something else first.
    @Test func anUpsertOntoAnExistingKeyStillSucceedsAtTheCap() throws {
        try withTempStore { store in
            for i in 0..<memoryLimit {
                _ = try store.upsertMemory(
                    project: "p", key: "k\(i)", value: "v\(i)", kind: .note, source: "x:\(i)"
                )
            }
            #expect(try store.memories(project: "p").count == memoryLimit)

            // Correcting an existing entry, not adding a new one: must not throw.
            let updated = try store.upsertMemory(
                project: "p", key: "k0", value: "corrected", kind: .gate, source: "y:2"
            )
            #expect(updated.value == "corrected")
            #expect(updated.kind == .gate)

            let after = try store.memories(project: "p")
            #expect(after.count == memoryLimit)
            #expect(try store.memory(project: "p", key: "k0").value == "corrected")
        }
    }

    /// The cap is per-project. One project sitting at its limit must not stop
    /// a different project from writing its first entry.
    @Test func theCapIsPerProject() throws {
        try withTempStore { store in
            for i in 0..<memoryLimit {
                _ = try store.upsertMemory(
                    project: "full", key: "k\(i)", value: "v\(i)", kind: .note, source: "x:\(i)"
                )
            }
            #expect(try store.memories(project: "full").count == memoryLimit)

            // A different project, well under the limit, is unaffected.
            let written = try store.upsertMemory(
                project: "other", key: "gate", value: "swift test", kind: .gate, source: "README:1"
            )
            #expect(written.value == "swift test")
            #expect(try store.memories(project: "other").count == 1)

            // The full project is still refused.
            #expect(throws: BoardError.self) {
                _ = try store.upsertMemory(
                    project: "full", key: "one-too-many", value: "v", kind: .note, source: "x:1"
                )
            }
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

/// Counts how many times a store observer has fired. `notify()` delivers on a global
/// queue, so tests wait on a semaphore rather than assuming the handler already ran.
private final class ObserverProbe: @unchecked Sendable {
    private let lock = NSLock()
    private let semaphore = DispatchSemaphore(value: 0)
    private var fired = 0

    var handler: @Sendable () -> Void {
        { [self] in
            lock.lock(); fired += 1; lock.unlock()
            semaphore.signal()
        }
    }

    /// How many times the handler has run so far.
    var count: Int {
        lock.lock(); defer { lock.unlock() }
        return fired
    }

    /// True if an observer call arrives within `seconds`.
    func fires(within seconds: Double = 2) -> Bool {
        semaphore.wait(timeout: .now() + seconds) == .success
    }
}

@Suite struct MemoryNotificationTests {

    // MARK: - Memory writes wake observers (D6)

    @Test func upsertMemoryNotifiesObservers() throws {
        try withTempStore { store in
            let probe = ObserverProbe()
            _ = store.addObserver(probe.handler)
            try store.upsertMemory(
                project: "boss-sdd", key: "gate", value: "swift test", kind: .gate, source: "README:1"
            )
            #expect(probe.fires())
        }
    }

    @Test func deleteMemoryNotifiesObservers() throws {
        try withTempStore { store in
            try store.upsertMemory(
                project: "boss-sdd", key: "gate", value: "swift test", kind: .gate, source: "README:1"
            )
            let probe = ObserverProbe()
            _ = store.addObserver(probe.handler)
            try store.deleteMemory(project: "boss-sdd", key: "gate")
            #expect(probe.fires())
        }
    }

    /// A write that throws changed nothing, so it must not wake the window.
    @Test func refusedMemoryWritesDoNotNotify() throws {
        try withTempStore { store in
            let probe = ObserverProbe()
            _ = store.addObserver(probe.handler)
            #expect(throws: BoardError.self) {
                try store.upsertMemory(project: "p", key: "gate", value: "v", kind: .gate, source: " ")
            }
            #expect(throws: BoardError.self) {
                try store.deleteMemory(project: "p", key: "missing")
            }
            #expect(!probe.fires(within: 0.3))
        }
    }

    /// The empty-`source` refusal above throws before `queue.sync` is entered, so it
    /// cannot show where `notify()` sits. The 100-key cap throws from inside the
    /// transaction: a `notify()` placed inside `queue.sync` would fire here.
    @Test func anUpsertRefusedByTheCapInsideTheTransactionDoesNotNotify() throws {
        try withTempStore { store in
            for i in 0..<memoryLimit {
                try store.upsertMemory(
                    project: "full", key: "k\(i)", value: "v", kind: .note, source: "x:\(i)"
                )
            }
            // Registered after the fill, so only the refused write could reach it.
            let probe = ObserverProbe()
            _ = store.addObserver(probe.handler)
            #expect(throws: BoardError.self) {
                try store.upsertMemory(
                    project: "full", key: "one-too-many", value: "v", kind: .note, source: "x:1"
                )
            }
            #expect(!probe.fires(within: 0.3))
            #expect(probe.count == 0)
        }
    }

    // MARK: - Project resolution (D7)

    @Test func aWorktreePathResolvesToItsRepository() {
        #expect(Store.repository(ofRunProject: "/x/repo/.worktrees/t1") == "/x/repo")
        #expect(Store.repository(ofRunProject: "/x/repo/.worktrees/t1/") == "/x/repo")
    }

    @Test func aPlainRepositoryPathIsLeftAlone() {
        #expect(Store.repository(ofRunProject: "/x/repo") == "/x/repo")
        #expect(Store.repository(ofRunProject: "boss-sdd") == "boss-sdd")
        // Only a *trailing* worktree segment is stripped, and only one level of it.
        #expect(Store.repository(ofRunProject: "/x/.worktrees/repo/src") == "/x/.worktrees/repo/src")
        #expect(Store.repository(ofRunProject: "/x/repo/.worktrees/t1/sub") == "/x/repo/.worktrees/t1/sub")
        // Nothing to resolve to: an empty repository part is not a repository.
        #expect(Store.repository(ofRunProject: "/.worktrees/t1") == "/.worktrees/t1")
        #expect(Store.repository(ofRunProject: "/x/repo/.worktrees/") == "/x/repo/.worktrees")
    }

    /// A trailing slash or stray whitespace must not change which bucket a path
    /// reads: every return path canonicalises the same way.
    @Test func trailingSlashesAndWhitespaceAreCanonicalisedOnEveryPath() {
        #expect(Store.repository(ofRunProject: "/x/repo/") == "/x/repo")
        #expect(Store.repository(ofRunProject: "/x/repo//") == "/x/repo")
        #expect(Store.repository(ofRunProject: "  /x/repo/ ") == "/x/repo")
        #expect(Store.repository(ofRunProject: "/") == "/")
        #expect(
            Store.repository(ofRunProject: "/x/repo/")
                == Store.repository(ofRunProject: "/x/repo/.worktrees/t1/")
        )
    }

    /// `/x/repo/` and `/x/repo/.worktrees/t1/` are one repository, and a plain path
    /// that only differs by a slash was not resolved from anything, so `differed`
    /// must stay false for it.
    @Test func aTrailingSlashOnAPlainPathSharesTheBucketAndDidNotDiffer() throws {
        try withTempStore { store in
            try store.upsertMemory(
                project: "/x/repo", key: "gate", value: "swift test", kind: .gate, source: "README:1"
            )
            let plain = try store.projectMemories(forRunProject: "/x/repo/")
            #expect(plain.repository == "/x/repo")
            #expect(!plain.differed)
            #expect(plain.memories.map(\.key) == ["gate"])

            let worktree = try store.projectMemories(forRunProject: "/x/repo/.worktrees/t1/")
            #expect(worktree.repository == "/x/repo")
            #expect(worktree.differed)
            #expect(worktree.memories == plain.memories)
        }
    }

    @Test func aWorktreeRunReadsTheRepositorysMemories() throws {
        try withTempStore { store in
            try store.upsertMemory(
                project: "/x/repo", key: "gate", value: "swift test", kind: .gate, source: "README:1"
            )
            // A memory filed under the worktree path itself must not leak in.
            try store.upsertMemory(
                project: "/x/repo/.worktrees/t1", key: "stray", value: "v", kind: .note, source: "x:1"
            )

            let view = try store.projectMemories(forRunProject: "/x/repo/.worktrees/t1")
            #expect(view.repository == "/x/repo")
            #expect(view.runProject == "/x/repo/.worktrees/t1")
            #expect(view.differed)
            #expect(view.memories.map(\.key) == ["gate"])
        }
    }

    @Test func aRunOnTheRepositoryItselfDidNotDiffer() throws {
        try withTempStore { store in
            try store.upsertMemory(
                project: "/x/repo", key: "gate", value: "swift test", kind: .gate, source: "README:1"
            )
            let view = try store.projectMemories(forRunProject: "/x/repo")
            #expect(view.repository == "/x/repo")
            #expect(!view.differed)
            #expect(view.memories.map(\.key) == ["gate"])
        }
    }

    @Test func aRunWithNoProjectIsRefused() throws {
        try withTempStore { store in
            #expect(throws: BoardError.self) { _ = try store.projectMemories(forRunProject: "  ") }
        }
    }

    // MARK: - One bucket key for reads and writes alike

    /// The spelling a write files a memory under and the spelling the pane reads
    /// must be the same one, or a memory written as `/x/repo/` is invisible to the
    /// very run it belongs to — which is what D7 exists to prevent.
    @Test func aSlashSuffixedProjectWritesTheBucketThePaneReads() throws {
        try withTempStore { store in
            try store.upsertMemory(
                project: "/x/repo/", key: "gate", value: "swift test", kind: .gate, source: "README:1"
            )
            let plain = try store.projectMemories(forRunProject: "/x/repo/")
            #expect(plain.repository == "/x/repo")
            #expect(!plain.differed)
            #expect(plain.memories.map(\.key) == ["gate"])

            // And a worktree run under that repository reads the same row.
            let worktree = try store.projectMemories(forRunProject: "/x/repo/.worktrees/t1")
            #expect(worktree.memories == plain.memories)
        }
    }

    /// All four memory operations pass through one canonicalisation, so a trailing
    /// slash or stray whitespace cannot split a project into two buckets no matter
    /// which operation writes it.
    @Test func trailingSlashesDoNotSplitAProjectAcrossOperations() throws {
        try withTempStore { store in
            try store.upsertMemory(
                project: "/x/repo", key: "gate", value: "v1", kind: .gate, source: "a:1"
            )
            // The slashed spelling updates that row in place rather than adding a second.
            let updated = try store.upsertMemory(
                project: "/x/repo/", key: "gate", value: "v2", kind: .gate, source: "a:2"
            )
            #expect(updated.project == "/x/repo")
            #expect(try store.memories(project: "/x/repo").map(\.value) == ["v2"])
            #expect(try store.memory(project: "/x/repo//", key: "gate").value == "v2")

            let deleted = try store.deleteMemory(project: "  /x/repo/ ", key: "gate")
            #expect(deleted.project == "/x/repo")
            #expect(try store.memories(project: "/x/repo").isEmpty)
        }
    }

    /// The degenerate paths, since canonicalisation now runs before the emptiness
    /// check: `"/"` is still a (strange but non-empty) path, `"///"` collapses onto
    /// it rather than becoming a second bucket, and whitespace is still refused.
    @Test func degenerateProjectPathsCanonicaliseWithoutBecomingEmpty() throws {
        try withTempStore { store in
            let written = try store.upsertMemory(
                project: "///", key: "gate", value: "v", kind: .gate, source: "a:1"
            )
            #expect(written.project == "/")
            #expect(try store.memories(project: "/").map(\.value) == ["v"])
            #expect(try store.memory(project: "///", key: "gate").project == "/")
            #expect(throws: BoardError.self) { _ = try store.memories(project: "  ") }
            #expect(throws: BoardError.self) {
                _ = try store.upsertMemory(
                    project: "  ", key: "gate", value: "v", kind: .gate, source: "a:1"
                )
            }
        }
    }
}

// MARK: - The canonical spelling of a project, pinned vector by vector

/// Transcribed, entry for entry, in `mcp/tools_test.go` (`canonicalProjectVectors`).
/// The Go binary validates every memory echo against its own copy of the board's
/// rule; the two copies are held together only by both passing this one table.
/// Change the rule, this table and that table together, never one alone.
///
/// An empty `canonical` means the board refuses the project (`project must not be
/// empty`), where the Go copy returns "" and leaves the refusal to the board.
private let canonicalProjectVectors: [(input: String, canonical: String)] = [
    // Nothing but whitespace: refused.
    ("", ""),
    ("  ", ""),
    ("\t\n", ""),
    // A lone slash is a path; more slashes collapse onto it.
    ("/", "/"),
    ("//", "/"),
    ("///", "/"),
    // Whitespace behind a trailing slash: one trim-then-strip pass leaves it exposed.
    ("/ /", "/"),
    ("/a/ /", "/a"),
    ("/x/repo /", "/x/repo"),
    ("/x/repo/ \n/ ", "/x/repo"),
    // Trailing slashes and outer whitespace, including a non-breaking space.
    ("/x/repo/", "/x/repo"),
    ("  /x/repo/ ", "/x/repo"),
    ("\u{00A0}/x/repo/\u{00A0}", "/x/repo"),
    // Leading slashes, case and inner whitespace are all kept.
    ("//a//", "//a"),
    ("/x/Repo", "/x/Repo"),
    ("/x/my repo", "/x/my repo"),
    ("boss-sdd", "boss-sdd"),
]

@Suite struct ProjectCanonicalisationTests {

    /// Spellings outside the set where a single trim-then-strip pass already happens
    /// to be idempotent. The write path applies the rule once and the pane's read
    /// path applies it twice; unless the rule is a fixpoint those are two buckets,
    /// the memory is invisible to its own run, and `differed` is false so the pane
    /// cannot even say so.
    @Test func whitespaceBehindATrailingSlashReadsTheBucketItWrote() throws {
        for spelling in ["/x/repo /", "/ /", "/a/\n/"] {
            try withTempStore { store in
                let written = try store.upsertMemory(
                    project: spelling, key: "gate", value: "v", kind: .gate, source: "a:1"
                )
                let view = try store.projectMemories(forRunProject: spelling)
                #expect(view.repository == written.project, "\(spelling.debugDescription)")
                #expect(!view.differed, "\(spelling.debugDescription)")
                #expect(view.memories.map(\.key) == ["gate"], "\(spelling.debugDescription)")
            }
        }
    }

    /// Every operation that turns a project string into a bucket key agrees with the
    /// table, and the canonical spelling is its own canonical spelling on each of
    /// them. That second half is what makes applying the rule once on the write
    /// path and twice on the read path harmless.
    @Test func everyVectorCanonicalisesTheSameWayOnEveryPathAndIsAFixpoint() throws {
        for vector in canonicalProjectVectors {
            let label = "\(vector.input.debugDescription)"
            try withTempStore { store in
                if vector.canonical.isEmpty {
                    #expect(throws: BoardError.self, "\(label)") {
                        try store.upsertMemory(
                            project: vector.input, key: "gate", value: "v", kind: .gate, source: "a:1"
                        )
                    }
                    #expect(throws: BoardError.self, "\(label)") {
                        _ = try store.projectMemories(forRunProject: vector.input)
                    }
                    return
                }
                let written = try store.upsertMemory(
                    project: vector.input, key: "gate", value: "v", kind: .gate, source: "a:1"
                )
                #expect(written.project == vector.canonical, "\(label)")
                // Fixpoint, on the write path and on the resolution path.
                let again = try store.upsertMemory(
                    project: vector.canonical, key: "gate", value: "v2", kind: .gate, source: "a:2"
                )
                #expect(again.project == vector.canonical, "\(label)")
                #expect(Store.repository(ofRunProject: vector.canonical) == vector.canonical, "\(label)")
                // The read paths land in the bucket the write filled.
                #expect(try store.memory(project: vector.input, key: "gate").value == "v2", "\(label)")
                #expect(try store.memories(project: vector.input).count == 1, "\(label)")
                let view = try store.projectMemories(forRunProject: vector.input)
                #expect(view.runProject == vector.canonical, "\(label)")
                #expect(view.repository == vector.canonical, "\(label)")
                #expect(!view.differed, "\(label)")
                #expect(view.memories.map(\.value) == ["v2"], "\(label)")
                #expect(try store.deleteMemory(project: vector.input, key: "gate").project == vector.canonical, "\(label)")
            }
        }
    }
}
