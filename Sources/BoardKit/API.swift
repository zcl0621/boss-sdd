import Foundation

/// Encodes a run with its derived graph alongside, matching the shape the board
/// has always published: graph fields sit next to the run's own fields.
struct RunWithGraph: Encodable {
    let run: Run

    enum Key: String, CodingKey { case graph }

    func encode(to encoder: Encoder) throws {
        try run.encode(to: encoder)
        var container = encoder.container(keyedBy: Key.self)
        try container.encode(deriveGraph(run), forKey: .graph)
    }
}

struct HealthResponse: Encodable {
    let ok: Bool
    let version: String
    let port: Int
    let runs: Int
}

struct CreateRunRequest: Decodable {
    var title: String
    var project: String?
}

struct UpdateRunRequest: Decodable {
    var status: RunStatus?
    var summary: String?

    enum CodingKeys: String, CodingKey { case status, summary }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        summary = try container.decodeIfPresent(String.self, forKey: .summary)
        if let raw = try container.decodeIfPresent(String.self, forKey: .status) {
            guard let parsed = RunStatus(rawValue: raw) else {
                throw BoardError.invalid(
                    "unknown run status '\(raw)'; expected one of "
                        + RunStatus.allCases.map(\.rawValue).joined(separator: ", ")
                )
            }
            status = parsed
        }
    }
}

struct TaskPatchRequest: Decodable {
    var patch = TaskPatch()

    enum CodingKeys: String, CodingKey {
        case title, status, detail, agent
        case dependsOn = "depends_on"
        case writeScope = "write_scope"
        case exclusiveResource = "exclusive_resource"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        patch.title = try container.decodeIfPresent(String.self, forKey: .title)
        patch.detail = try container.decodeIfPresent(String.self, forKey: .detail)
        patch.agent = try container.decodeIfPresent(String.self, forKey: .agent)
        if let raw = try container.decodeIfPresent(String.self, forKey: .status) {
            guard let parsed = TaskStatus(rawValue: raw) else {
                throw BoardError.invalid(
                    "unknown task status '\(raw)'; expected one of "
                        + TaskStatus.allCases.map(\.rawValue).joined(separator: ", ")
                )
            }
            patch.status = parsed
        }
        patch.dependsOn = try Self.list(container, .dependsOn)
        patch.writeScope = try Self.list(container, .writeScope)
        patch.exclusiveResource = try Self.list(container, .exclusiveResource)
    }

    /// Absent keeps the current list, `null` clears it, an array replaces it wholesale.
    private static func list(
        _ container: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys
    ) throws -> ListPatch {
        guard container.contains(key) else { return .keep }
        if try container.decodeNil(forKey: key) { return .clear }
        let values = try container.decode([String].self, forKey: key)
        guard values.allSatisfy({ !$0.trimmingCharacters(in: .whitespaces).isEmpty }) else {
            throw BoardError.invalid("\(key.rawValue) values must be non-empty strings")
        }
        return .replace(values)
    }
}

/// One entry of a batch task write: the task's own ID plus the same patch body the
/// single-task route accepts, decoded by the very same code so the list tri-state
/// (absent keeps, array replaces, null clears) cannot drift between the two paths.
struct TaskBatchItem: Decodable {
    var id: String
    var patch: TaskPatch

    enum CodingKeys: String, CodingKey { case id }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        patch = try TaskPatchRequest(from: decoder).patch
    }
}

struct TaskBatchRequest: Decodable {
    var tasks: [TaskBatchItem]
}

/// Body of `POST /api/memories`. `kind` and `source` are both required: `kind`
/// because an unfiltered memory is a memory nobody finds, and `source` because a
/// memory nobody can re-check is the failure this table exists to avoid.
struct MemoryUpsertRequest: Decodable {
    var project: String
    var key: String
    var value: String
    var kind: MemoryKind
    var source: String

    enum CodingKeys: String, CodingKey { case project, key, value, kind, source }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        project = try container.decode(String.self, forKey: .project)
        key = try container.decode(String.self, forKey: .key)
        value = try container.decode(String.self, forKey: .value)
        source = try container.decode(String.self, forKey: .source)
        let raw = try container.decode(String.self, forKey: .kind)
        guard let parsed = MemoryKind(rawValue: raw) else {
            throw BoardError.invalid(
                "unknown memory kind '\(raw)'; expected one of "
                    + MemoryKind.allCases.map(\.rawValue).joined(separator: ", ")
            )
        }
        kind = parsed
    }
}

/// Maps HTTP requests onto the store. Transport concerns (parsing, framing) stay
/// in `HTTPServer`; everything policy-shaped lives here.
public struct API: Sendable {
    let store: Store
    /// Read per request rather than captured: a server asked for port 0 does not
    /// know its port until the listener is ready, which is after this was built.
    let boundPort: BoundPort

    /// For a caller that pinned a port. A caller that asked the OS to choose
    /// should hand over the server's own cell instead.
    public init(store: Store, port: UInt16) {
        self.init(store: store, boundPort: BoundPort(requested: port))
    }

    public init(store: Store, boundPort: BoundPort) {
        self.store = store
        self.boundPort = boundPort
    }

    public func handle(_ request: HTTPRequest) -> HTTPResponse {
        do {
            try checkOrigin(request)
            return try route(request)
        } catch let error as BoardError {
            return failure(error)
        } catch let error as DecodingError {
            return failure(.invalid(Self.describe(error)))
        } catch {
            return failure(.invalid(String(describing: error)))
        }
    }

    // MARK: - Guards

    /// The server binds loopback only, so the remaining exposure is a web page in a
    /// browser on this machine. Requests carrying an `Origin` are exactly that, and
    /// write methods must use a content type that forces a CORS preflight — which
    /// fails, because no response here carries `Access-Control-Allow-*`.
    private func checkOrigin(_ request: HTTPRequest) throws {
        let host = (request.header("host") ?? "").split(separator: ":").first.map(String.init) ?? ""
        guard host == "127.0.0.1" || host == "localhost" else {
            throw BoardError.forbidden("unexpected Host header")
        }
        if request.header("origin") != nil {
            throw BoardError.forbidden("cross-origin requests are not accepted")
        }
        guard ["POST", "PUT", "PATCH"].contains(request.method) else { return }
        let contentType = (request.header("content-type") ?? "").lowercased()
        guard contentType.hasPrefix("application/json") else {
            throw BoardError.invalid("write requests require Content-Type: application/json")
        }
    }

    // MARK: - Routing

    private func route(_ request: HTTPRequest) throws -> HTTPResponse {
        let path = request.path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? "/"
        let segments = path.split(separator: "/").map {
            $0.removingPercentEncoding ?? String($0)
        }

        switch (request.method, segments) {
        case ("GET", []):
            return .text("boss-sdd board \(boardKitVersion) · see /api/health")

        case ("GET", ["api", "health"]):
            let runs = try store.allRuns()
            return try encode(
                HealthResponse(
                    ok: true, version: boardKitVersion,
                    port: Int(boundPort.current), runs: runs.count
                )
            )

        case ("GET", ["api", "runs"]):
            let runs = try store.allRuns().map(RunWithGraph.init)
            return try encode(["runs": runs])

        case ("POST", ["api", "runs"]):
            let payload = try decode(CreateRunRequest.self, from: request)
            let run = try store.createRun(title: payload.title, project: payload.project ?? "")
            return try encode(RunWithGraph(run: run), status: 201)

        case ("GET", let parts) where parts.count == 3 && parts[0] == "api" && parts[1] == "runs":
            return try encode(RunWithGraph(run: try store.run(parts[2])))

        case ("PATCH", let parts) where parts.count == 3 && parts[0] == "api" && parts[1] == "runs":
            let payload = try decode(UpdateRunRequest.self, from: request)
            let run = try store.updateRun(parts[2], status: payload.status, summary: payload.summary)
            return try encode(RunWithGraph(run: run))

        case ("DELETE", let parts) where parts.count == 3 && parts[0] == "api" && parts[1] == "runs":
            try store.deleteRun(parts[2])
            return try encode(["deleted": parts[2]])

        case ("GET", let parts)
            where parts.count == 4 && parts[0] == "api" && parts[1] == "runs" && parts[3] == "graph":
            return try encode(deriveGraph(try store.run(parts[2])))

        // Batch write: the whole list applies in one transaction, so a rejected
        // entry rolls back the ones before it instead of leaving a partial DAG.
        case ("PUT", let parts)
            where parts.count == 4 && parts[0] == "api" && parts[1] == "runs" && parts[3] == "tasks":
            let payload = try decode(TaskBatchRequest.self, from: request)
            let run = try store.upsertTasks(
                runID: parts[2],
                patches: payload.tasks.map { (taskID: $0.id, patch: $0.patch) }
            )
            return try encode(RunWithGraph(run: run))

        case ("PUT", let parts)
            where parts.count == 5 && parts[0] == "api" && parts[1] == "runs" && parts[3] == "tasks":
            let payload = try decode(TaskPatchRequest.self, from: request)
            let run = try store.upsertTask(runID: parts[2], taskID: parts[4], patch: payload.patch)
            return try encode(RunWithGraph(run: run))

        // Project memory. `project` rides in the query string, not the path: it is
        // "项目路径或名称" and may well be an absolute path, so it is not a safe path
        // segment. `key` is a constrained slug (`isValidMemoryKey`) and does sit in
        // the path, the way run and task IDs do.
        case ("GET", ["api", "memories"]):
            let project = try requiredQuery(request, "project")
            let kind = try optionalKind(request)
            return try encode(["memories": try store.memories(project: project, kind: kind)])

        // 200, not the 201 `POST /api/runs` answers: this is an upsert onto a
        // caller-chosen key, so it has no "created exactly now" to report — the
        // same request is a create the first time and an overwrite after, and a
        // status that flickered between 201 and 200 would tell a client nothing it
        // could act on. Stated here because the MCP layer is written against it.
        case ("POST", ["api", "memories"]):
            let payload = try decode(MemoryUpsertRequest.self, from: request)
            let memory = try store.upsertMemory(
                project: payload.project, key: payload.key, value: payload.value,
                kind: payload.kind, source: payload.source
            )
            return try encode(memory)

        case ("GET", let parts) where parts.count == 3 && parts[0] == "api" && parts[1] == "memories":
            let project = try requiredQuery(request, "project")
            return try encode(try store.memory(project: project, key: parts[2]))

        case ("DELETE", let parts)
            where parts.count == 3 && parts[0] == "api" && parts[1] == "memories":
            let project = try requiredQuery(request, "project")
            // Report what the store deleted, not what the caller typed: the raw
            // path segment and query value are pre-normalization, so echoing them
            // names a row that need not exist (`DELETE .../Gate` answered
            // `"Gate"` while deleting `gate`). GET and POST already answer with
            // the stored record; this keeps all three on the store's spelling
            // without `API.swift` owning a second copy of the folding rule.
            let removed = try store.deleteMemory(project: project, key: parts[2])
            return try encode(["deleted": removed.key, "project": removed.project])

        default:
            throw BoardError.notFound("no route for \(request.method) \(path)")
        }
    }

    // MARK: - Query parameters

    private func query(_ request: HTTPRequest, _ name: String) -> String? {
        // `request.path` is the raw request target; parse it as a relative
        // reference so URLComponents does the percent-decoding.
        guard let components = URLComponents(string: "http://127.0.0.1" + request.path) else {
            return nil
        }
        return components.queryItems?.first { $0.name == name }?.value
    }

    /// Absent and present-but-empty are different mistakes and get different
    /// messages: `?project=` is a caller who built the URL and lost the value,
    /// which "missing" would send looking in the wrong place.
    private func requiredQuery(_ request: HTTPRequest, _ name: String) throws -> String {
        guard let value = query(request, name) else {
            throw BoardError.invalid("missing query parameter '\(name)'")
        }
        guard !value.isEmpty else {
            throw BoardError.invalid("query parameter '\(name)' must not be empty")
        }
        return value
    }

    private func optionalKind(_ request: HTTPRequest) throws -> MemoryKind? {
        guard let raw = query(request, "kind"), !raw.isEmpty else { return nil }
        guard let parsed = MemoryKind(rawValue: raw) else {
            throw BoardError.invalid(
                "unknown memory kind '\(raw)'; expected one of "
                    + MemoryKind.allCases.map(\.rawValue).joined(separator: ", ")
            )
        }
        return parsed
    }

    // MARK: - Serialization

    private func decode<T: Decodable>(_ type: T.Type, from request: HTTPRequest) throws -> T {
        guard !request.body.isEmpty else { throw BoardError.invalid("request body is empty") }
        return try BoardJSON.decoder.decode(type, from: request.body)
    }

    private func encode(_ value: some Encodable, status: Int = 200) throws -> HTTPResponse {
        .json(try BoardJSON.encoder.encode(value), status: status)
    }

    private func failure(_ error: BoardError) -> HTTPResponse {
        let body = ["error": ["code": error.code, "message": error.message]]
        let data = (try? BoardJSON.encoder.encode(body)) ?? Data(#"{"error":{"code":"internal"}}"#.utf8)
        return .json(data, status: error.httpStatus)
    }

    private static func describe(_ error: DecodingError) -> String {
        switch error {
        case .keyNotFound(let key, _): return "missing field '\(key.stringValue)'"
        case .typeMismatch(_, let context), .valueNotFound(_, let context):
            let path = context.codingPath.map(\.stringValue).joined(separator: ".")
            return path.isEmpty ? context.debugDescription : "field '\(path)': \(context.debugDescription)"
        case .dataCorrupted(let context):
            return context.underlyingError.map { String(describing: $0) } ?? context.debugDescription
        @unknown default: return "malformed request body"
        }
    }
}
