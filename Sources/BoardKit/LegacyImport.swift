import Foundation

/// Reads runs written by the previous Python board (`~/.claude/plan-sdd/runs/*.json`).
///
/// Legacy files are tolerated the way the Python projection tolerated them:
/// unreadable entries are skipped rather than failing the whole import.
public enum LegacyImport {
    /// The runs directory that belongs to a given board home. Derived from the
    /// home the store actually opened, not from `Store.defaultDirectory`, so an
    /// overridden home cannot import from the real one.
    public static func runsDirectory(in home: URL) -> URL {
        home.appendingPathComponent("runs", isDirectory: true)
    }

    public struct Result: Sendable {
        public var imported: [String] = []
        public var skipped: [String] = []
    }

    public static func parseRun(data: Data) throws -> Run {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw BoardError.invalid("run file is not a JSON object")
        }
        guard let id = object["id"] as? String, isValidRunID(id) else {
            throw BoardError.invalid("run file has no usable id")
        }

        let tasks = (object["tasks"] as? [Any] ?? []).compactMap { entry -> BoardTask? in
            guard let task = entry as? [String: Any],
                  let taskID = task["id"] as? String, !taskID.isEmpty
            else { return nil }
            return BoardTask(
                id: taskID,
                title: task["title"] as? String ?? "",
                status: TaskStatus(rawValue: task["status"] as? String ?? "") ?? .pending,
                detail: task["detail"] as? String ?? "",
                agent: task["agent"] as? String ?? "",
                dependsOn: strings(task["depends_on"]),
                writeScope: strings(task["write_scope"]),
                exclusiveResource: strings(task["exclusive_resource"]),
                updatedAt: (task["updated_at"] as? String).flatMap(BoardJSON.date(from:))
            )
        }

        let events = (object["events"] as? [Any] ?? []).compactMap { entry -> RunEvent? in
            guard let event = entry as? [String: Any] else { return nil }
            let at = (event["at"] as? String).flatMap(BoardJSON.date(from:)) ?? Date()
            return RunEvent(
                at: at,
                action: event["action"] as? String ?? "update",
                task: event["task"] as? String,
                status: event["status"] as? String,
                note: event["note"] as? String ?? ""
            )
        }

        let created = (object["created_at"] as? String).flatMap(BoardJSON.date(from:)) ?? Date()
        return Run(
            id: id,
            title: object["title"] as? String ?? "未命名运行",
            project: object["project"] as? String ?? "",
            status: RunStatus(rawValue: object["status"] as? String ?? "") ?? .planning,
            summary: object["summary"] as? String ?? "",
            tasks: tasks,
            events: events,
            createdAt: created,
            updatedAt: (object["updated_at"] as? String).flatMap(BoardJSON.date(from:)) ?? created
        )
    }

    @discardableResult
    public static func importAll(from directory: URL, into store: Store) -> Result {
        var result = Result()
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        for file in files.sorted(by: { $0.lastPathComponent < $1.lastPathComponent })
        where file.pathExtension == "json" {
            do {
                let run = try parseRun(data: try Data(contentsOf: file))
                try store.importRun(run)
                result.imported.append(run.id)
            } catch {
                result.skipped.append("\(file.lastPathComponent): \(error)")
            }
        }
        return result
    }

    private static func strings(_ value: Any?) -> [String] {
        (value as? [Any] ?? []).compactMap { $0 as? String }
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    }
}
