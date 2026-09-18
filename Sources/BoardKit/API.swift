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

/// Maps HTTP requests onto the store. Transport concerns (parsing, framing) stay
/// in `HTTPServer`; everything policy-shaped lives here.
public struct API: Sendable {
    let store: Store
    let port: UInt16

    public init(store: Store, port: UInt16) {
        self.store = store
        self.port = port
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
                HealthResponse(ok: true, version: boardKitVersion, port: Int(port), runs: runs.count)
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

        case ("PUT", let parts)
            where parts.count == 5 && parts[0] == "api" && parts[1] == "runs" && parts[3] == "tasks":
            let payload = try decode(TaskPatchRequest.self, from: request)
            let run = try store.upsertTask(runID: parts[2], taskID: parts[4], patch: payload.patch)
            return try encode(RunWithGraph(run: run))

        default:
            throw BoardError.notFound("no route for \(request.method) \(path)")
        }
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
