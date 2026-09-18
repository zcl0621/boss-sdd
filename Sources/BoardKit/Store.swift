import Foundation

public enum ListPatch: Sendable, Equatable {
    case keep
    case replace([String])
    case clear
}

public struct TaskPatch: Sendable {
    public var title: String?
    public var status: TaskStatus?
    public var detail: String?
    public var agent: String?
    public var dependsOn: ListPatch = .keep
    public var writeScope: ListPatch = .keep
    public var exclusiveResource: ListPatch = .keep

    public init(
        title: String? = nil,
        status: TaskStatus? = nil,
        detail: String? = nil,
        agent: String? = nil,
        dependsOn: ListPatch = .keep,
        writeScope: ListPatch = .keep,
        exclusiveResource: ListPatch = .keep
    ) {
        self.title = title
        self.status = status
        self.detail = detail
        self.agent = agent
        self.dependsOn = dependsOn
        self.writeScope = writeScope
        self.exclusiveResource = exclusiveResource
    }
}

/// Serialized SQLite-backed store. Every mutation validates the resulting DAG
/// before it commits, so an invalid graph is never observable.
public final class Store: @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.boss-sdd.store")
    private let database: Database
    private var observers: [UUID: @Sendable () -> Void] = [:]

    public static let defaultDirectory = FileManager.default
        .homeDirectoryForCurrentUser
        .appendingPathComponent(".claude/plan-sdd", isDirectory: true)

    public init(path: URL) throws {
        try FileManager.default.createDirectory(
            at: path.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        database = try Database(path: path.path)
        try database.execute(Self.schema)
    }

    public convenience init(directory: URL = Store.defaultDirectory) throws {
        try self.init(path: directory.appendingPathComponent("board.sqlite3"))
    }

    private static let schema = """
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

    // MARK: - Observation

    public func addObserver(_ handler: @escaping @Sendable () -> Void) -> UUID {
        let token = UUID()
        queue.sync { observers[token] = handler }
        return token
    }

    public func removeObserver(_ token: UUID) {
        queue.sync { observers[token] = nil }
    }

    private func notify() {
        let handlers = Array(observers.values)
        DispatchQueue.global(qos: .userInitiated).async {
            for handler in handlers { handler() }
        }
    }

    // MARK: - Reads

    public func allRuns() throws -> [Run] {
        try queue.sync {
            let rows = try database.query("SELECT id FROM runs ORDER BY updated_at DESC")
            return try rows.map { try loadRun($0.string("id")) }
        }
    }

    public func run(_ id: String) throws -> Run {
        try queue.sync { try loadRun(id) }
    }

    // MARK: - Writes

    public func createRun(title: String, project: String) throws -> Run {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw BoardError.invalid("title must not be empty") }
        let id = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let now = Date()
        let result: Run = try queue.sync {
            try database.transaction {
                try database.run(
                    "INSERT INTO runs(id, title, project, status, summary, created_at, updated_at) VALUES(?,?,?,?,?,?,?)",
                    [
                        .text(id), .text(trimmed), .text(project),
                        .text(RunStatus.planning.rawValue), .text(""),
                        .double(now.timeIntervalSince1970), .double(now.timeIntervalSince1970),
                    ]
                )
                try appendEvent(runID: id, at: now, action: "init", task: nil, status: nil, note: trimmed)
                return try loadRun(id)
            }
        }
        notify()
        return result
    }

    public func updateRun(_ id: String, status: RunStatus?, summary: String?) throws -> Run {
        let now = Date()
        let result: Run = try queue.sync {
            try database.transaction {
                var run = try loadRun(id)
                if let status { run.status = status }
                if let summary { run.summary = summary }
                try database.run(
                    "UPDATE runs SET status = ?, summary = ?, updated_at = ? WHERE id = ?",
                    [.text(run.status.rawValue), .text(run.summary), .double(now.timeIntervalSince1970), .text(id)]
                )
                try appendEvent(
                    runID: id, at: now, action: "update", task: nil,
                    status: status?.rawValue, note: summary ?? ""
                )
                return try loadRun(id)
            }
        }
        notify()
        return result
    }

    public func deleteRun(_ id: String) throws {
        try queue.sync {
            _ = try loadRun(id)
            try database.transaction {
                try database.run("DELETE FROM runs WHERE id = ?", [.text(id)])
            }
        }
        notify()
    }

    public func upsertTask(runID: String, taskID: String, patch: TaskPatch) throws -> Run {
        try upsertTasks(runID: runID, patches: [(taskID: taskID, patch: patch)])
    }

    /// Applies a whole batch of task patches inside a single transaction: either
    /// every patch lands or none does, so a rejected patch can never leave a
    /// half-written DAG for the scheduler to read.
    ///
    /// Guards are evaluated *incrementally*, in the order given: patch `n` is
    /// checked against the pre-batch state plus patches `0..<n` of this same
    /// batch. That makes a batch behave exactly like the sequence of single-task
    /// writes it replaces — same guards, same verdicts, same order-sensitivity —
    /// and differ only in that a rejection rolls the earlier ones back too.
    public func upsertTasks(runID: String, patches: [(taskID: String, patch: TaskPatch)]) throws -> Run {
        for entry in patches {
            guard isValidTaskID(entry.taskID) else {
                throw BoardError.invalid("invalid task id: \(entry.taskID)")
            }
        }
        // An empty batch writes nothing at all, not even a timestamp bump.
        guard !patches.isEmpty else { return try queue.sync { try loadRun(runID) } }

        let now = Date()
        let result: Run = try queue.sync {
            try database.transaction {
                var run = try loadRun(runID)
                for entry in patches {
                    try applyTaskPatch(entry.patch, toTask: entry.taskID, in: &run, at: now)
                }
                try database.run(
                    "UPDATE runs SET updated_at = ? WHERE id = ?",
                    [.double(now.timeIntervalSince1970), .text(runID)]
                )
                return try loadRun(runID)
            }
        }
        notify()
        return result
    }

    /// Applies one patch to the in-memory run and persists that one task. The
    /// caller owns the transaction and the run's `updated_at` bump; `run` carries
    /// every earlier patch of the same batch, which is what the guards see.
    private func applyTaskPatch(
        _ patch: TaskPatch, toTask taskID: String, in run: inout Run, at now: Date
    ) throws {
        let existingIndex = run.tasks.firstIndex { $0.id == taskID }
        if existingIndex == nil {
            guard let title = patch.title, !title.trimmingCharacters(in: .whitespaces).isEmpty else {
                throw BoardError.invalid("a new task requires a title")
            }
            run.tasks.append(BoardTask(id: taskID, title: title))
        }
        let index = run.tasks.firstIndex { $0.id == taskID }!
        let previousStatus = run.tasks[index].status
        let previousResources = run.tasks[index].exclusiveResource

        if let title = patch.title { run.tasks[index].title = title }
        if let detail = patch.detail { run.tasks[index].detail = detail }
        if let agent = patch.agent { run.tasks[index].agent = agent }
        run.tasks[index].dependsOn = apply(patch.dependsOn, to: run.tasks[index].dependsOn)
        run.tasks[index].writeScope = apply(patch.writeScope, to: run.tasks[index].writeScope)
        run.tasks[index].exclusiveResource = apply(
            patch.exclusiveResource, to: run.tasks[index].exclusiveResource
        )

        try Self.guardTransition(
            run: run,
            taskID: taskID,
            requestedStatus: patch.status,
            previousStatus: previousStatus,
            previousResources: previousResources
        )

        if let status = patch.status { run.tasks[index].status = status }
        run.tasks[index].updatedAt = now
        try writeTask(runID: run.id, task: run.tasks[index], position: index)
        try appendEvent(
            runID: run.id, at: now, action: "task", task: taskID,
            status: patch.status?.rawValue, note: patch.detail ?? ""
        )
    }

    /// Imports a run wholesale, preserving its ID. Used by the legacy JSON migration.
    public func importRun(_ run: Run) throws {
        try queue.sync {
            try database.transaction {
                try database.run("DELETE FROM runs WHERE id = ?", [.text(run.id)])
                try database.run(
                    "INSERT INTO runs(id, title, project, status, summary, created_at, updated_at) VALUES(?,?,?,?,?,?,?)",
                    [
                        .text(run.id), .text(run.title), .text(run.project),
                        .text(run.status.rawValue), .text(run.summary),
                        .double(run.createdAt.timeIntervalSince1970),
                        .double(run.updatedAt.timeIntervalSince1970),
                    ]
                )
                for (position, task) in run.tasks.enumerated() {
                    try writeTask(runID: run.id, task: task, position: position)
                }
                for event in run.events.suffix(eventHistoryLimit) {
                    try appendEvent(
                        runID: run.id, at: event.at, action: event.action,
                        task: event.task, status: event.status, note: event.note, trim: false
                    )
                }
            }
        }
        notify()
    }

    // MARK: - Mutation guards

    /// Ported from the Python board: a task may only enter `running` on a valid graph
    /// with satisfied dependencies, and may not hold an exclusive resource another
    /// active task already holds.
    static func guardTransition(
        run: Run,
        taskID: String,
        requestedStatus: TaskStatus?,
        previousStatus: TaskStatus,
        previousResources: [String]
    ) throws {
        var graph: GraphProjection?
        if requestedStatus == .running && previousStatus != .running {
            let projection = deriveGraph(run)
            graph = projection
            guard projection.valid else {
                let messages = projection.errors.map(\.message).joined(separator: "; ")
                throw BoardError.invalid("cannot start task \(taskID): invalid graph: \(messages)")
            }
            let waiting = projection.waitingOn[taskID] ?? []
            var dependencyReady = waiting.isEmpty
                && [TaskStatus.pending, .blocked, .review].contains(previousStatus)
            if previousStatus == .pending {
                dependencyReady = projection.readyTaskIDs.contains(taskID)
            }
            guard dependencyReady else {
                let reason = waiting.isEmpty
                    ? "task status \(previousStatus.rawValue) cannot transition to running"
                    : waiting.joined(separator: ", ")
                throw BoardError.conflict("cannot start task \(taskID): not ready (\(reason))")
            }
        }

        let finalStatus = requestedStatus ?? previousStatus
        let statusChanged = requestedStatus != nil && requestedStatus != previousStatus
        let resourcesChanged = run.task(taskID)?.exclusiveResource != previousResources
        guard finalStatus.isActive, statusChanged || resourcesChanged else { return }

        let projection = graph ?? deriveGraph(run)
        let conflicts = projection.blockedBy[taskID]?.resourceConflicts ?? []
        guard conflicts.isEmpty else {
            let described = conflicts
                .map { "\($0.taskID) [\($0.resources.joined(separator: ", "))]" }
                .joined(separator: "; ")
            throw BoardError.conflict(
                "cannot update task \(taskID): exclusive resource conflict with \(described)"
            )
        }
    }

    private func apply(_ patch: ListPatch, to current: [String]) -> [String] {
        switch patch {
        case .keep: return current
        case .clear: return []
        case .replace(let values): return values
        }
    }

    // MARK: - Persistence helpers

    private func writeTask(runID: String, task: BoardTask, position: Int) throws {
        try database.run(
            """
            INSERT INTO tasks(run_id, id, title, status, detail, agent, position, updated_at)
            VALUES(?,?,?,?,?,?,?,?)
            ON CONFLICT(run_id, id) DO UPDATE SET
                title = excluded.title, status = excluded.status, detail = excluded.detail,
                agent = excluded.agent, position = excluded.position, updated_at = excluded.updated_at
            """,
            [
                .text(runID), .text(task.id), .text(task.title), .text(task.status.rawValue),
                .text(task.detail), .text(task.agent), .int(Int64(position)),
                task.updatedAt.map { SQLValue.double($0.timeIntervalSince1970) } ?? .null,
            ]
        )
        try database.run(
            "DELETE FROM task_lists WHERE run_id = ? AND task_id = ?", [.text(runID), .text(task.id)]
        )
        let lists: [(String, [String])] = [
            ("depends_on", task.dependsOn),
            ("write_scope", task.writeScope),
            ("exclusive_resource", task.exclusiveResource),
        ]
        for (kind, values) in lists {
            for (position, value) in values.enumerated() {
                try database.run(
                    "INSERT INTO task_lists(run_id, task_id, kind, position, value) VALUES(?,?,?,?,?)",
                    [.text(runID), .text(task.id), .text(kind), .int(Int64(position)), .text(value)]
                )
            }
        }
    }

    private func appendEvent(
        runID: String, at: Date, action: String, task: String?,
        status: String?, note: String, trim: Bool = true
    ) throws {
        try database.run(
            "INSERT INTO events(run_id, at, action, task_id, status, note) VALUES(?,?,?,?,?,?)",
            [
                .text(runID), .double(at.timeIntervalSince1970), .text(action),
                task.map { SQLValue.text($0) } ?? .null,
                status.map { SQLValue.text($0) } ?? .null,
                .text(note),
            ]
        )
        guard trim else { return }
        try database.run(
            """
            DELETE FROM events WHERE run_id = ? AND seq NOT IN (
                SELECT seq FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT ?
            )
            """,
            [.text(runID), .text(runID), .int(Int64(eventHistoryLimit))]
        )
    }

    private func loadRun(_ id: String) throws -> Run {
        guard isValidRunID(id) else { throw BoardError.invalid("invalid run id") }
        let runRows = try database.query("SELECT * FROM runs WHERE id = ?", [.text(id)])
        guard let runRow = runRows.first else { throw BoardError.notFound("run \(id) not found") }

        var lists: [String: [String: [String]]] = [:]
        for row in try database.query(
            "SELECT task_id, kind, value FROM task_lists WHERE run_id = ? ORDER BY kind, position",
            [.text(id)]
        ) {
            lists[row.string("task_id"), default: [:]][row.string("kind"), default: []]
                .append(row.string("value"))
        }

        let tasks = try database.query(
            "SELECT * FROM tasks WHERE run_id = ? ORDER BY position", [.text(id)]
        ).map { row -> BoardTask in
            let taskID = row.string("id")
            let taskLists = lists[taskID] ?? [:]
            return BoardTask(
                id: taskID,
                title: row.string("title"),
                status: TaskStatus(rawValue: row.string("status")) ?? .pending,
                detail: row.string("detail"),
                agent: row.string("agent"),
                dependsOn: taskLists["depends_on"] ?? [],
                writeScope: taskLists["write_scope"] ?? [],
                exclusiveResource: taskLists["exclusive_resource"] ?? [],
                updatedAt: row.optionalDouble("updated_at").map { Date(timeIntervalSince1970: $0) }
            )
        }

        let events = try database.query(
            "SELECT * FROM events WHERE run_id = ? ORDER BY seq", [.text(id)]
        ).map { row in
            RunEvent(
                at: Date(timeIntervalSince1970: row.double("at")),
                action: row.string("action"),
                task: row.optionalString("task_id"),
                status: row.optionalString("status"),
                note: row.string("note")
            )
        }

        return Run(
            id: runRow.string("id"),
            title: runRow.string("title"),
            project: runRow.string("project"),
            status: RunStatus(rawValue: runRow.string("status")) ?? .planning,
            summary: runRow.string("summary"),
            tasks: tasks,
            events: events,
            createdAt: Date(timeIntervalSince1970: runRow.double("created_at")),
            updatedAt: Date(timeIntervalSince1970: runRow.double("updated_at"))
        )
    }
}
