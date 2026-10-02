import Foundation
import Testing
@testable import BoardKit

/// Builds a `Store` backed by a throwaway SQLite file under a fresh temporary
/// directory, and removes that directory afterwards. Never touches
/// `Store.defaultDirectory` (`~/.claude/plan-sdd`), which holds the user's real board.
private func withTempStoreAndPath(_ body: (Store, URL) throws -> Void) throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("boss-sdd-store-tests-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let path = directory.appendingPathComponent("board.sqlite3")
    let store = try Store(path: path)
    try body(store, path)
}

private func withTempStore(_ body: (Store) throws -> Void) throws {
    try withTempStoreAndPath { store, _ in try body(store) }
}

@Suite struct StoreTests {

    // MARK: - Event history cap

    @Test func eventHistoryTruncatesToLimitAndDropsOldestEvents() throws {
        try withTempStore { store in
            let run = try store.createRun(title: "trunc", project: "")

            // createRun already appended one "init" event. Push well past the cap.
            let updateCount = eventHistoryLimit + 50
            for i in 0..<updateCount {
                _ = try store.updateRun(run.id, status: nil, summary: "note-\(i)")
            }

            let reloaded = try store.run(run.id)
            #expect(reloaded.events.count == eventHistoryLimit)

            // Every event ever appended, in order: index 0 is the "init" event from
            // createRun, index k (k >= 1) is the update carrying summary "note-(k-1)".
            let totalAppended = updateCount + 1
            let droppedCount = totalAppended - eventHistoryLimit
            // If nothing were dropped, the oldest surviving event would be createRun's
            // own "init" event, whose note is the run title ("trunc"), not "".
            let expectedOldestNote = droppedCount == 0 ? "trunc" : "note-\(droppedCount - 1)"

            #expect(reloaded.events.first?.note == expectedOldestNote)
            #expect(reloaded.events.first?.action == "update")
            #expect(reloaded.events.last?.note == "note-\(updateCount - 1)")
            #expect(!reloaded.events.contains { $0.action == "init" })
            #expect(!reloaded.events.contains { $0.note == "note-0" })
        }
    }

    // MARK: - Write guards (tested directly against Store.guardTransition)

    @Test func runningRequiresAllDependenciesDone() throws {
        let upstream = BoardTask(id: "T1", title: "upstream", status: .pending)
        let downstream = BoardTask(id: "T2", title: "downstream", status: .pending, dependsOn: ["T1"])
        let run = Run(id: "r1", title: "r", tasks: [upstream, downstream])

        do {
            try Store.guardTransition(
                run: run,
                taskID: "T2",
                requestedStatus: .running,
                previousStatus: .pending,
                previousResources: []
            )
            Issue.record("expected guardTransition to throw while T1 is not done")
        } catch let error as BoardError {
            guard case .conflict(let message) = error else {
                Issue.record(Comment(rawValue: "expected .conflict, got \(error)"))
                return
            }
            #expect(message.contains("T1"))
        }
    }

    @Test func runningIsAllowedOnceDependenciesAreDone() throws {
        let upstream = BoardTask(id: "T1", title: "upstream", status: .done)
        let downstream = BoardTask(id: "T2", title: "downstream", status: .pending, dependsOn: ["T1"])
        let run = Run(id: "r1", title: "r", tasks: [upstream, downstream])

        // Should not throw: T1 is done, so T2 is ready to start.
        try Store.guardTransition(
            run: run,
            taskID: "T2",
            requestedStatus: .running,
            previousStatus: .pending,
            previousResources: []
        )
    }

    @Test func exclusiveResourceHeldByAnotherActiveTaskIsRejected() throws {
        let holder = BoardTask(id: "T1", title: "holder", status: .running, exclusiveResource: ["pytest"])
        let contender = BoardTask(id: "T2", title: "contender", status: .pending, exclusiveResource: ["pytest"])
        let run = Run(id: "r1", title: "r", tasks: [holder, contender])

        do {
            try Store.guardTransition(
                run: run,
                taskID: "T2",
                requestedStatus: .running,
                previousStatus: .pending,
                previousResources: []
            )
            Issue.record("expected guardTransition to throw over the shared exclusive resource")
        } catch let error as BoardError {
            guard case .conflict(let message) = error else {
                Issue.record(Comment(rawValue: "expected .conflict, got \(error)"))
                return
            }
            #expect(message.contains("pytest"))
            #expect(message.contains("T1"))
        }
    }

    @Test func reviewIsAlsoConsideredActiveForResourceConflicts() throws {
        // Both "running" and "review" hold their declared exclusive resources per
        // TaskStatus.isActive, so a review-status holder must also block a contender.
        let holder = BoardTask(id: "T1", title: "holder", status: .review, exclusiveResource: ["pytest"])
        let contender = BoardTask(id: "T2", title: "contender", status: .pending, exclusiveResource: ["pytest"])
        let run = Run(id: "r1", title: "r", tasks: [holder, contender])

        do {
            try Store.guardTransition(
                run: run,
                taskID: "T2",
                requestedStatus: .running,
                previousStatus: .pending,
                previousResources: []
            )
            Issue.record("expected guardTransition to throw over the shared exclusive resource")
        } catch let error as BoardError {
            guard case .conflict(let message) = error else {
                Issue.record(Comment(rawValue: "expected .conflict, got \(error)"))
                return
            }
            #expect(message.contains("pytest"))
        }
    }

    @Test func resourceConflictIsCaughtEvenWithoutAStatusChange() throws {
        // Mirrors upsertTask's real shape when only exclusive_resource is patched on a
        // task that is already running: requestedStatus is nil (no "status" key sent),
        // so statusChanged is false and resourcesChanged is the only thing that can
        // still catch a newly-declared resource clashing with another active holder.
        let holder = BoardTask(id: "T1", title: "holder", status: .running, exclusiveResource: ["pytest"])
        let contender = BoardTask(id: "T2", title: "contender", status: .running, exclusiveResource: ["pytest"])
        let run = Run(id: "r1", title: "r", tasks: [holder, contender])

        do {
            try Store.guardTransition(
                run: run,
                taskID: "T2",
                requestedStatus: nil,
                previousStatus: .running,
                previousResources: []
            )
            Issue.record("expected guardTransition to throw over the shared exclusive resource")
        } catch let error as BoardError {
            guard case .conflict(let message) = error else {
                Issue.record(Comment(rawValue: "expected .conflict, got \(error)"))
                return
            }
            #expect(message.contains("pytest"))
            #expect(message.contains("T1"))
        }
    }

    // MARK: - ListPatch tri-state (.keep / .replace / .clear)

    @Test func listPatchKeepReplaceAndClearAcrossAllThreeListKinds() throws {
        try withTempStore { store in
            let run = try store.createRun(title: "lists", project: "")
            _ = try store.upsertTask(runID: run.id, taskID: "T0", patch: TaskPatch(title: "dep target one"))
            _ = try store.upsertTask(runID: run.id, taskID: "T2", patch: TaskPatch(title: "dep target two"))
            _ = try store.upsertTask(
                runID: run.id,
                taskID: "T1",
                patch: TaskPatch(
                    title: "main",
                    dependsOn: .replace(["T0"]),
                    writeScope: .replace(["a/", "b/"]),
                    exclusiveResource: .replace(["res1"])
                )
            )

            // .keep (the default) leaves all three lists untouched.
            var updated = try store.upsertTask(
                runID: run.id, taskID: "T1", patch: TaskPatch(detail: "only detail changed")
            )
            var task = try #require(updated.task("T1"))
            #expect(task.dependsOn == ["T0"])
            #expect(task.writeScope == ["a/", "b/"])
            #expect(task.exclusiveResource == ["res1"])

            // .replace overwrites each list wholesale.
            updated = try store.upsertTask(
                runID: run.id,
                taskID: "T1",
                patch: TaskPatch(
                    dependsOn: .replace(["T2"]),
                    writeScope: .replace(["c/"]),
                    exclusiveResource: .replace(["res2", "res3"])
                )
            )
            task = try #require(updated.task("T1"))
            #expect(task.dependsOn == ["T2"])
            #expect(task.writeScope == ["c/"])
            #expect(task.exclusiveResource == ["res2", "res3"])

            // .clear empties each list.
            updated = try store.upsertTask(
                runID: run.id,
                taskID: "T1",
                patch: TaskPatch(dependsOn: .clear, writeScope: .clear, exclusiveResource: .clear)
            )
            task = try #require(updated.task("T1"))
            #expect(task.dependsOn == [])
            #expect(task.writeScope == [])
            #expect(task.exclusiveResource == [])

            // Confirm the cleared state actually persisted, not just the in-memory return value.
            let reloadedTask = try #require(try store.run(run.id).task("T1"))
            #expect(reloadedTask.dependsOn == [])
            #expect(reloadedTask.writeScope == [])
            #expect(reloadedTask.exclusiveResource == [])
        }
    }

    // MARK: - deleteRun

    /// Counts rows directly through a second connection (see `withTempStoreAndPath`):
    /// `Store.loadRun` throws not-found once the run row is gone, so it cannot tell
    /// "cascaded away" from "orphaned but unreachable".
    private func rowCount(_ database: Database, _ table: String, runID: String) throws -> Int {
        try database.query("SELECT COUNT(*) AS n FROM \(table) WHERE run_id = ?", [.text(runID)])
            .first?.int("n") ?? -1
    }

    @Test func deletingADoneRunRemovesItsTasksAndEventsToo() throws {
        try withTempStoreAndPath { store, path in
            let run = try store.createRun(title: "to delete", project: "")
            _ = try store.upsertTask(runID: run.id, taskID: "T1", patch: TaskPatch(title: "one", dependsOn: .replace([])))
            _ = try store.upsertTask(runID: run.id, taskID: "T2", patch: TaskPatch(title: "two", dependsOn: .replace(["T1"])))
            _ = try store.updateRun(run.id, status: .done, summary: "finished")

            // A second connection to the same file: observe the rows, do not assume them.
            let observer = try Database(path: path.path)
            #expect(try rowCount(observer, "tasks", runID: run.id) == 2)
            #expect(try rowCount(observer, "task_lists", runID: run.id) == 1)
            #expect(try rowCount(observer, "events", runID: run.id) >= 1)

            try store.deleteRun(run.id)

            #expect(throws: BoardError.self) { try store.run(run.id) }
            #expect(try observer.query("SELECT COUNT(*) AS n FROM runs WHERE id = ?", [.text(run.id)]).first?.int("n") == 0)
            #expect(try rowCount(observer, "tasks", runID: run.id) == 0)
            #expect(try rowCount(observer, "task_lists", runID: run.id) == 0)
            #expect(try rowCount(observer, "events", runID: run.id) == 0)
        }
    }

    @Test func deletingARunLeavesOtherRunsAlone() throws {
        try withTempStoreAndPath { store, path in
            let doomed = try store.createRun(title: "doomed", project: "")
            let kept = try store.createRun(title: "kept", project: "")
            _ = try store.upsertTask(runID: kept.id, taskID: "T1", patch: TaskPatch(title: "stays"))

            try store.deleteRun(doomed.id)

            let observer = try Database(path: path.path)
            #expect(try rowCount(observer, "tasks", runID: kept.id) == 1)
            #expect(try rowCount(observer, "events", runID: kept.id) >= 1)
            #expect(try store.run(kept.id).task("T1")?.title == "stays")
        }
    }

    @Test func deletingARunningRunIsRefusedAndLeavesItIntact() throws {
        try withTempStore { store in
            let run = try store.createRun(title: "in flight", project: "")
            _ = try store.upsertTask(runID: run.id, taskID: "T1", patch: TaskPatch(title: "one"))
            _ = try store.updateRun(run.id, status: .running, summary: nil)

            do {
                try store.deleteRun(run.id)
                Issue.record("deleteRun on a running run should have thrown")
            } catch let error as BoardError {
                guard case .conflict(let message) = error else {
                    Issue.record("expected .conflict, got \(error)")
                    return
                }
                #expect(message.contains("running"))
                #expect(message.contains(run.id))
            }

            let survivor = try store.run(run.id)
            #expect(survivor.status == .running)
            #expect(survivor.tasks.count == 1)
        }
    }

    @Test func everyStatusButRunningIsDeletable() throws {
        try withTempStore { store in
            for status in RunStatus.allCases where status != .running {
                let run = try store.createRun(title: "as \(status.rawValue)", project: "")
                _ = try store.updateRun(run.id, status: status, summary: nil)
                try store.deleteRun(run.id)
                #expect(throws: BoardError.self) { try store.run(run.id) }
            }
        }
    }

    @Test func deletingAnUnknownRunIsNotFound() throws {
        try withTempStore { store in
            do {
                try store.deleteRun("no-such-run")
                Issue.record("deleteRun on an unknown id should have thrown")
            } catch let error as BoardError {
                guard case .notFound = error else {
                    Issue.record("expected .notFound, got \(error)")
                    return
                }
            }
        }
    }
}
