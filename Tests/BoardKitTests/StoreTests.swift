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

    // MARK: - deleteTask

    private func taskListCount(_ database: Database, runID: String, taskID: String) throws -> Int {
        try database.query(
            "SELECT COUNT(*) AS n FROM task_lists WHERE run_id = ? AND task_id = ?",
            [.text(runID), .text(taskID)]
        ).first?.int("n") ?? -1
    }

    /// Runs `body`, expecting a `.conflict`, and hands back its message.
    private func conflictMessage(_ body: () throws -> Void) -> String? {
        do {
            try body()
            Issue.record("expected the delete to be refused with .conflict, but it succeeded")
        } catch let error as BoardError {
            guard case .conflict(let message) = error else {
                Issue.record("expected .conflict, got \(error)")
                return nil
            }
            return message
        } catch {
            Issue.record("expected a BoardError, got \(error)")
        }
        return nil
    }

    @Test func deletingAFreeTaskRemovesItAndItsListRowsFromTheDatabase() throws {
        try withTempStoreAndPath { store, path in
            let run = try store.createRun(title: "r", project: "")
            _ = try store.upsertTask(runID: run.id, taskID: "T1", patch: TaskPatch(title: "one"))
            _ = try store.upsertTask(runID: run.id, taskID: "T2", patch: TaskPatch(
                title: "two", dependsOn: .replace(["T1"]),
                writeScope: .replace(["Sources/", "Tests/"]), exclusiveResource: .replace(["gate:full"])
            ))

            // Observe on a second connection; the before-count must be non-zero or the
            // after-count proves nothing.
            let observer = try Database(path: path.path)
            #expect(try taskListCount(observer, runID: run.id, taskID: "T2") == 4)

            let after = try store.deleteTask(runID: run.id, taskID: "T2")

            #expect(after.tasks.map(\.id) == ["T1"])
            #expect(try store.run(run.id).task("T2") == nil)
            #expect(try rowCount(observer, "tasks", runID: run.id) == 1)
            #expect(try taskListCount(observer, runID: run.id, taskID: "T2") == 0)
            #expect(deriveGraph(after).valid)
        }
    }

    /// `tasks.position` is written from a task's index in the loaded array, so a delete that
    /// leaves a hole lets the next appended task collide with, or sort ahead of, an older one.
    @Test func deletingMiddleTasksThenAddingKeepsInsertionOrderAndDensePositions() throws {
        try withTempStoreAndPath { store, path in
            let run = try store.createRun(title: "r", project: "")
            for id in ["T1", "T2", "T3", "T4"] {
                _ = try store.upsertTask(runID: run.id, taskID: id, patch: TaskPatch(title: id))
            }
            _ = try store.deleteTask(runID: run.id, taskID: "T2")
            _ = try store.upsertTask(runID: run.id, taskID: "T5", patch: TaskPatch(title: "T5"))
            #expect(try store.run(run.id).tasks.map(\.id) == ["T1", "T3", "T4", "T5"])

            _ = try store.deleteTask(runID: run.id, taskID: "T1")
            _ = try store.deleteTask(runID: run.id, taskID: "T4")
            let added = try store.upsertTask(runID: run.id, taskID: "T6", patch: TaskPatch(title: "T6"))
            #expect(added.tasks.map(\.id) == ["T3", "T5", "T6"])
            #expect(deriveGraph(added).topologicalOrder == ["T3", "T5", "T6"])

            // Positions are what ORDER BY reads: they must be distinct and gap-free.
            let observer = try Database(path: path.path)
            let positions = try observer.query(
                "SELECT position FROM tasks WHERE run_id = ? ORDER BY position", [.text(run.id)]
            ).map { $0.int("position") }
            #expect(positions == [0, 1, 2])
        }
    }

    @Test func aSuccessfulDeleteBumpsTheRunsUpdatedAt() throws {
        try withTempStore { store in
            let run = try store.createRun(title: "r", project: "")
            _ = try store.upsertTask(runID: run.id, taskID: "T1", patch: TaskPatch(title: "one"))
            let before = try store.run(run.id)
            Thread.sleep(forTimeInterval: 0.02)

            let after = try store.deleteTask(runID: run.id, taskID: "T1")

            #expect(after.updatedAt > before.updatedAt)
            #expect(try store.run(run.id).updatedAt == after.updatedAt)
        }
    }

    @Test func deletingATaskLeavesSiblingsAndOtherRunsAlone() throws {
        try withTempStore { store in
            let run = try store.createRun(title: "r", project: "")
            let other = try store.createRun(title: "other", project: "")
            _ = try store.upsertTask(runID: run.id, taskID: "T1", patch: TaskPatch(title: "one", writeScope: .replace(["a/"])))
            _ = try store.upsertTask(runID: run.id, taskID: "T2", patch: TaskPatch(title: "two", writeScope: .replace(["b/"])))
            _ = try store.upsertTask(runID: other.id, taskID: "T2", patch: TaskPatch(title: "same id elsewhere", writeScope: .replace(["c/"])))

            _ = try store.deleteTask(runID: run.id, taskID: "T2")

            #expect(try store.run(run.id).task("T1")?.writeScope == ["a/"])
            #expect(try store.run(other.id).task("T2")?.writeScope == ["c/"])
        }
    }

    @Test func aTaskWithDependentsIsRefusedAndTheMessageNamesEveryBlocker() throws {
        try withTempStore { store in
            let run = try store.createRun(title: "r", project: "")
            _ = try store.upsertTask(runID: run.id, taskID: "T1", patch: TaskPatch(title: "base"))
            _ = try store.upsertTask(runID: run.id, taskID: "T5", patch: TaskPatch(title: "five", dependsOn: .replace(["T1"])))
            _ = try store.upsertTask(runID: run.id, taskID: "T9", patch: TaskPatch(title: "nine", dependsOn: .replace(["T1"])))
            _ = try store.upsertTask(runID: run.id, taskID: "T7", patch: TaskPatch(title: "seven"))
            let before = try store.run(run.id)

            let message = conflictMessage { _ = try store.deleteTask(runID: run.id, taskID: "T1") }
            let text = try #require(message)
            #expect(text.contains("T1"))
            #expect(text.contains("T5"))
            #expect(text.contains("T9"))
            #expect(!text.contains("T7"))

            // The refusal wrote nothing.
            let after = try store.run(run.id)
            #expect(after.tasks.map(\.id) == before.tasks.map(\.id))
            #expect(after.task("T5")?.dependsOn == ["T1"])
            #expect(after.updatedAt == before.updatedAt)
        }
    }

    @Test func aDependentInAnotherRunDoesNotBlockTheDelete() throws {
        try withTempStore { store in
            let run = try store.createRun(title: "r", project: "")
            let other = try store.createRun(title: "other", project: "")
            _ = try store.upsertTask(runID: run.id, taskID: "T1", patch: TaskPatch(title: "base"))
            _ = try store.upsertTask(runID: other.id, taskID: "T2", patch: TaskPatch(title: "elsewhere", dependsOn: .replace(["T1"])))

            let after = try store.deleteTask(runID: run.id, taskID: "T1")
            #expect(after.tasks.isEmpty)
        }
    }

    @Test func aRunningTaskIsRefusedAndNamesItsStatus() throws {
        try withTempStore { store in
            let run = try store.createRun(title: "r", project: "")
            _ = try store.upsertTask(runID: run.id, taskID: "T1", patch: TaskPatch(title: "one", status: .running))

            let message = conflictMessage { _ = try store.deleteTask(runID: run.id, taskID: "T1") }
            let text = try #require(message)
            #expect(text.contains("running"))
            #expect(text.contains("T1"))
            #expect(try store.run(run.id).task("T1")?.status == .running)
        }
    }

    @Test func aTaskInReviewIsRefusedAndNamesItsStatus() throws {
        try withTempStore { store in
            let run = try store.createRun(title: "r", project: "")
            _ = try store.upsertTask(runID: run.id, taskID: "T1", patch: TaskPatch(title: "one", status: .review))

            let message = conflictMessage { _ = try store.deleteTask(runID: run.id, taskID: "T1") }
            let text = try #require(message)
            #expect(text.contains("review"))
            #expect(text.contains("T1"))
            #expect(try store.run(run.id).task("T1")?.status == .review)
        }
    }

    @Test func refusalMessagesDoNotSuggestMarkingTheTaskDone() throws {
        try withTempStore { store in
            let run = try store.createRun(title: "r", project: "")
            _ = try store.upsertTask(runID: run.id, taskID: "T1", patch: TaskPatch(title: "one", status: .running))
            _ = try store.upsertTask(runID: run.id, taskID: "T2", patch: TaskPatch(title: "two", status: .review))
            _ = try store.upsertTask(runID: run.id, taskID: "T3", patch: TaskPatch(title: "three", dependsOn: .replace(["T4"])))
            _ = try store.upsertTask(runID: run.id, taskID: "T4", patch: TaskPatch(title: "four"))

            for id in ["T1", "T2", "T4"] {
                let text = try #require(conflictMessage { _ = try store.deleteTask(runID: run.id, taskID: id) })
                #expect(!text.lowercased().contains("done"), "message for \(id) mentions done: \(text)")
            }
        }
    }

    @Test func everyTaskStatusButRunningAndReviewIsDeletable() throws {
        try withTempStore { store in
            let run = try store.createRun(title: "r", project: "")
            for status in TaskStatus.allCases where status != .running && status != .review {
                let id = "T-\(status.rawValue)"
                _ = try store.upsertTask(runID: run.id, taskID: id, patch: TaskPatch(title: id, status: status))
                _ = try store.deleteTask(runID: run.id, taskID: id)
                #expect(try store.run(run.id).task(id) == nil, "\(status.rawValue) should be deletable")
            }
        }
    }

    @Test func deletingAnUnknownTaskIsNotFound() throws {
        try withTempStore { store in
            let run = try store.createRun(title: "r", project: "")
            do {
                _ = try store.deleteTask(runID: run.id, taskID: "T404")
                Issue.record("deleteTask on an unknown task should have thrown")
            } catch let error as BoardError {
                guard case .notFound(let message) = error else {
                    Issue.record("expected .notFound, got \(error)")
                    return
                }
                #expect(message.contains("T404"))
            }
        }
    }

    @Test func deletingATaskOfAnUnknownRunIsNotFound() throws {
        try withTempStore { store in
            do {
                _ = try store.deleteTask(runID: "no-such-run", taskID: "T1")
                Issue.record("deleteTask on an unknown run should have thrown")
            } catch let error as BoardError {
                guard case .notFound = error else {
                    Issue.record("expected .notFound, got \(error)")
                    return
                }
            }
        }
    }
}
