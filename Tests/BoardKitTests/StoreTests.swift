import Foundation
import Testing
@testable import BoardKit

/// Builds a `Store` backed by a throwaway SQLite file under a fresh temporary
/// directory, and removes that directory afterwards. Never touches
/// `Store.defaultDirectory` (`~/.claude/plan-sdd`), which holds the user's real board.
private func withTempStore(_ body: (Store) throws -> Void) throws {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("boss-sdd-store-tests-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = try Store(path: directory.appendingPathComponent("board.sqlite3"))
    try body(store)
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
}
