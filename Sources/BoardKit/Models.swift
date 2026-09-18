import Foundation

public enum RunStatus: String, Codable, CaseIterable, Sendable {
    case pending
    case planning
    case awaitingConfirmation = "awaiting_confirmation"
    case running
    case review
    case blocked
    case done
}

public enum TaskStatus: String, Codable, CaseIterable, Sendable {
    case pending
    case running
    case review
    case blocked
    case done

    /// A task holds its declared write scope and exclusive resources while active.
    public var isActive: Bool { self == .running || self == .review }
}

public struct BoardTask: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String
    public var status: TaskStatus
    public var detail: String
    public var agent: String
    public var dependsOn: [String]
    public var writeScope: [String]
    public var exclusiveResource: [String]
    public var updatedAt: Date?

    public init(
        id: String,
        title: String,
        status: TaskStatus = .pending,
        detail: String = "",
        agent: String = "",
        dependsOn: [String] = [],
        writeScope: [String] = [],
        exclusiveResource: [String] = [],
        updatedAt: Date? = nil
    ) {
        self.id = id
        self.title = title
        self.status = status
        self.detail = detail
        self.agent = agent
        self.dependsOn = dependsOn
        self.writeScope = writeScope
        self.exclusiveResource = exclusiveResource
        self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey {
        case id, title, status, detail, agent
        case dependsOn = "depends_on"
        case writeScope = "write_scope"
        case exclusiveResource = "exclusive_resource"
        case updatedAt = "updated_at"
    }
}

public struct RunEvent: Codable, Sendable, Hashable {
    public var at: Date
    public var action: String
    public var task: String?
    public var status: String?
    public var note: String

    public init(at: Date, action: String, task: String? = nil, status: String? = nil, note: String = "") {
        self.at = at
        self.action = action
        self.task = task
        self.status = status
        self.note = note
    }
}

public struct Run: Codable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var project: String
    public var status: RunStatus
    public var summary: String
    public var tasks: [BoardTask]
    public var events: [RunEvent]
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: String,
        title: String,
        project: String = "",
        status: RunStatus = .planning,
        summary: String = "",
        tasks: [BoardTask] = [],
        events: [RunEvent] = [],
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.title = title
        self.project = project
        self.status = status
        self.summary = summary
        self.tasks = tasks
        self.events = events
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    enum CodingKeys: String, CodingKey {
        case id, title, project, status, summary, tasks, events
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    public func task(_ id: String) -> BoardTask? {
        tasks.first { $0.id == id }
    }
}

/// Maximum events retained per run, matching the previous board's cap.
public let eventHistoryLimit = 200

public enum BoardError: Error, Sendable, Equatable {
    case notFound(String)
    case invalid(String)
    case conflict(String)
    case forbidden(String)

    public var message: String {
        switch self {
        case .notFound(let text), .invalid(let text), .conflict(let text), .forbidden(let text):
            return text
        }
    }

    public var httpStatus: Int {
        switch self {
        case .notFound: return 404
        case .invalid: return 400
        case .conflict: return 409
        case .forbidden: return 403
        }
    }

    public var code: String {
        switch self {
        case .notFound: return "not_found"
        case .invalid: return "invalid_request"
        case .conflict: return "conflict"
        case .forbidden: return "forbidden"
        }
    }
}

/// Run IDs land in URLs and SQL; keep them to an unambiguous alphabet.
public func isValidRunID(_ id: String) -> Bool {
    !id.isEmpty && id.count <= 64 && id.allSatisfy {
        $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_")
    }
}

public func isValidTaskID(_ id: String) -> Bool {
    !id.isEmpty && id.count <= 64 && !id.contains(where: { $0.isNewline || $0.isWhitespace })
}
