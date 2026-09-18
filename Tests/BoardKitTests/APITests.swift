import Foundation
import Testing
@testable import BoardKit

/// Reads `key` out of a decoded JSON object as `T`.
///
/// This replaces the force-cast chains this file used to read decoded JSON
/// with. A force cast on a missing or wrong-typed field aborts the whole test
/// process, so one failing case took every later case's report down with it.
/// `#require` fails the current case, names the field, and returns control,
/// leaving the rest of the run intact.
private func field<T>(
    _ object: [String: Any],
    _ key: String,
    _ type: T.Type = T.self,
    sourceLocation: SourceLocation = #_sourceLocation
) throws -> T {
    let value = try #require(
        object[key],
        Comment(rawValue: "missing field '\(key)'; keys present: \(object.keys.sorted())"),
        sourceLocation: sourceLocation
    )
    return try #require(
        value as? T,
        Comment(rawValue: "field '\(key)' is \(Swift.type(of: value)), not \(T.self)"),
        sourceLocation: sourceLocation
    )
}

/// `body.error.message` — the shape every refusal in this file asserts against.
private func errorMessage(
    _ body: [String: Any],
    sourceLocation: SourceLocation = #_sourceLocation
) throws -> String {
    let error = try field(body, "error", [String: Any].self, sourceLocation: sourceLocation)
    return try field(error, "message", String.self, sourceLocation: sourceLocation)
}

/// The entry for `id` in a response's `tasks` array.
private func taskEntry(
    in body: [String: Any],
    id: String,
    sourceLocation: SourceLocation = #_sourceLocation
) throws -> [String: Any] {
    let tasks = try field(body, "tasks", [[String: Any]].self, sourceLocation: sourceLocation)
    return try #require(
        tasks.first { $0["id"] as? String == id },
        Comment(rawValue: "no task '\(id)' in the response; ids: \(tasks.map { $0["id"] as? String })"),
        sourceLocation: sourceLocation
    )
}

/// Boots the real server on an ephemeral loopback port and drives it over HTTP.
private final class TestServer {
    let store: Store
    let server: HTTPServer
    private(set) var port: UInt16 = 0

    init() throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("boss-sdd-tests-\(UUID().uuidString)", isDirectory: true)
        store = try Store(path: directory.appendingPathComponent("board.sqlite3"))
        let api = API(store: store, port: 0)
        server = HTTPServer(port: 0) { api.handle($0) }
    }

    func start() async throws {
        let ready = AsyncStream<UInt16>.makeStream()
        server.onStateChange { state in
            if case .listening(let port) = state { ready.continuation.yield(port) }
        }
        server.start()
        for await port in ready.stream {
            self.port = port
            break
        }
    }

    func stop() { server.stop() }

    func send(
        _ method: String, _ path: String, json: String? = nil,
        contentType: String? = "application/json", origin: String? = nil
    ) async throws -> (status: Int, body: [String: Any]) {
        let url = try #require(
            URL(string: "http://127.0.0.1:\(port)\(path)"),
            Comment(rawValue: "could not build a URL for \(method) \(path)")
        )
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let json { request.httpBody = Data(json.utf8) }
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if let origin { request.setValue(origin, forHTTPHeaderField: "Origin") }
        let (data, response) = try await URLSession.shared.data(for: request)
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        let http = try #require(response as? HTTPURLResponse, "response was not an HTTP response")
        return (http.statusCode, body)
    }

    /// The whole run as a decoded value, for "this write changed nothing" assertions.
    ///
    /// Deliberately not the raw response bytes: `BoardJSON.encoder` does not set
    /// `.sortedKeys` and the graph projection is six dictionaries deep, so byte
    /// equality would ride on unspecified key ordering. `NSDictionary` equality is
    /// a deep compare — order-insensitive for objects, order-sensitive for arrays,
    /// which is exactly the distinction these assertions need.
    func snapshot(_ runID: String) async throws -> NSDictionary {
        let (status, body) = try await send("GET", "/api/runs/\(runID)", contentType: nil)
        #expect(status == 200)
        return body as NSDictionary
    }
}

@Suite(.serialized) struct APITests {
    private func withServer(_ body: (TestServer) async throws -> Void) async throws {
        let server = try TestServer()
        try await server.start()
        defer { server.stop() }
        try await body(server)
    }

    @Test func healthReportsVersionAndRunCount() async throws {
        try await withServer { server in
            let (status, body) = try await server.send("GET", "/api/health")
            #expect(status == 200)
            #expect(body["ok"] as? Bool == true)
            #expect(body["runs"] as? Int == 0)
        }
    }

    @Test func writingTasksProducesReadySetInTheSameResponse() async throws {
        try await withServer { server in
            let (createStatus, created) = try await server.send(
                "POST", "/api/runs", json: #"{"title":"示例计划","project":"demo"}"#
            )
            #expect(createStatus == 201)
            let runID = try field(created, "id", String.self)

            _ = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/T1",
                json: #"{"title":"打底","write_scope":["app/core/"]}"#
            )
            let (status, body) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/T2",
                json: #"{"title":"接入","depends_on":["T1"],"write_scope":["app/ui/"]}"#
            )
            #expect(status == 200)
            let graph = try field(body, "graph", [String: Any].self)
            #expect(graph["valid"] as? Bool == true)
            #expect(graph["ready_task_ids"] as? [String] == ["T1"])
        }
    }

    @Test func startingABlockedTaskIsRejected() async throws {
        try await withServer { server in
            let (_, created) = try await server.send("POST", "/api/runs", json: #"{"title":"门禁"}"#)
            let runID = try field(created, "id", String.self)
            _ = try await server.send("PUT", "/api/runs/\(runID)/tasks/T1", json: #"{"title":"上游"}"#)
            _ = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/T2",
                json: #"{"title":"下游","depends_on":["T1"]}"#
            )
            let (status, body) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/T2", json: #"{"status":"running"}"#
            )
            #expect(status == 409)
            let message = try errorMessage(body)
            #expect(message.contains("T1"))
        }
    }

    @Test func exclusiveResourceConflictIsRejected() async throws {
        try await withServer { server in
            let (_, created) = try await server.send("POST", "/api/runs", json: #"{"title":"资源"}"#)
            let runID = try field(created, "id", String.self)
            _ = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/T1",
                json: #"{"title":"甲","exclusive_resource":["pytest"]}"#
            )
            _ = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/T2",
                json: #"{"title":"乙","exclusive_resource":["pytest"]}"#
            )
            let (started, _) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/T1", json: #"{"status":"running"}"#
            )
            #expect(started == 200)
            let (status, body) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/T2", json: #"{"status":"running"}"#
            )
            #expect(status == 409)
            #expect(try errorMessage(body).contains("pytest"))
        }
    }

    @Test func listFieldsKeepReplaceAndClear() async throws {
        try await withServer { server in
            let (_, created) = try await server.send("POST", "/api/runs", json: #"{"title":"三态"}"#)
            let runID = try field(created, "id", String.self)
            _ = try await server.send("PUT", "/api/runs/\(runID)/tasks/T1", json: #"{"title":"甲"}"#)
            _ = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/T2",
                json: #"{"title":"乙","depends_on":["T1"],"write_scope":["a/","b/"]}"#
            )

            // Absent keys keep the current lists.
            var (_, body) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/T2", json: #"{"detail":"只改说明"}"#
            )
            var task = try taskEntry(in: body, id: "T2")
            #expect(task["depends_on"] as? [String] == ["T1"])
            #expect(task["write_scope"] as? [String] == ["a/", "b/"])

            // An array replaces wholesale; null clears.
            (_, body) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/T2",
                json: #"{"write_scope":["c/"],"depends_on":null}"#
            )
            task = try taskEntry(in: body, id: "T2")
            #expect(task["write_scope"] as? [String] == ["c/"])
            #expect(task["depends_on"] as? [String] == [])
        }
    }

    @Test func writesRequireJSONContentType() async throws {
        try await withServer { server in
            let (status, body) = try await server.send(
                "POST", "/api/runs", json: #"{"title":"x"}"#, contentType: "text/plain"
            )
            #expect(status == 400)
            #expect(try errorMessage(body).contains("application/json"))
        }
    }

    @Test func crossOriginRequestsAreRejected() async throws {
        try await withServer { server in
            let (status, _) = try await server.send(
                "GET", "/api/health", contentType: nil, origin: "https://example.com"
            )
            #expect(status == 403)
        }
    }

    // MARK: - Batch task writes (PUT /api/runs/{id}/tasks)

    /// The defect this route exists to fix: one rejected task used to leave every
    /// earlier task of the same write already committed. The batch is one
    /// transaction now, so a rejection must leave the run bit-identical.
    @Test func aRejectedBatchCommitsNothing() async throws {
        try await withServer { server in
            let (_, created) = try await server.send("POST", "/api/runs", json: #"{"title":"原子"}"#)
            let runID = try field(created, "id", String.self)
            _ = try await server.send("PUT", "/api/runs/\(runID)/tasks/T1", json: #"{"title":"上游"}"#)
            _ = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/T2",
                json: #"{"title":"下游","depends_on":["T1"]}"#
            )

            let before = try await server.snapshot(runID)

            // T3 is a perfectly good new task; T2 -> running is illegal while T1 is
            // not done. The illegal one is last, so the loop this replaces would
            // already have committed T3 by the time it failed.
            let (status, body) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks",
                json: #"""
                    {"tasks":[
                      {"id":"T3","title":"新任务","write_scope":["c/"]},
                      {"id":"T2","status":"running"}
                    ]}
                    """#
            )
            #expect(status == 409)
            #expect(try errorMessage(body).contains("T1"))

            // The whole run, compared value-for-value: no new task, no status change,
            // no updated_at bump, no event appended. Nothing about the run moved.
            #expect(try await server.snapshot(runID) == before)

            // Stated again directly, so a failure names the actual symptom.
            let reloaded = try server.store.run(runID)
            #expect(reloaded.task("T3") == nil)
            #expect(reloaded.task("T2")?.status == .pending)
            #expect(reloaded.tasks.count == 2)
        }
    }

    /// Same batch, same guard, the other guard: a resource clash inside one batch
    /// also has to roll the whole thing back.
    @Test func aBatchWithAnInternalResourceClashCommitsNothing() async throws {
        try await withServer { server in
            let (_, created) = try await server.send("POST", "/api/runs", json: #"{"title":"资源批"}"#)
            let runID = try field(created, "id", String.self)
            let before = try await server.snapshot(runID)

            let (status, body) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks",
                json: #"""
                    {"tasks":[
                      {"id":"T1","title":"甲","status":"running","exclusive_resource":["pytest"]},
                      {"id":"T2","title":"乙","status":"running","exclusive_resource":["pytest"]}
                    ]}
                    """#
            )
            #expect(status == 409)
            #expect(try errorMessage(body).contains("pytest"))

            #expect(try await server.snapshot(runID) == before)
            #expect(try server.store.run(runID).tasks.isEmpty)
        }
    }

    @Test func aBatchWritesTheWholeDAGInOneRequest() async throws {
        try await withServer { server in
            let (_, created) = try await server.send("POST", "/api/runs", json: #"{"title":"整图"}"#)
            let runID = try field(created, "id", String.self)

            let (status, body) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks",
                json: #"""
                    {"tasks":[
                      {"id":"T1","title":"打底","write_scope":["app/core/"]},
                      {"id":"T2","title":"接入","depends_on":["T1"],"write_scope":["app/ui/"]},
                      {"id":"T3","title":"收口","depends_on":["T2"]}
                    ]}
                    """#
            )
            #expect(status == 200)
            let graph = try field(body, "graph", [String: Any].self)
            #expect(graph["valid"] as? Bool == true)
            #expect(graph["ready_task_ids"] as? [String] == ["T1"])
            let ids = try field(body, "tasks", [[String: Any]].self).map { $0["id"] as? String }
            #expect(ids == ["T1", "T2", "T3"])
        }
    }

    /// Guards run incrementally, in the order given: a batch may complete a
    /// dependency and start its dependent, because by the time the second entry is
    /// checked the first has already been applied to the in-batch state.
    @Test func aBatchMayFinishADependencyAndStartItsDependent() async throws {
        try await withServer { server in
            let (_, created) = try await server.send("POST", "/api/runs", json: #"{"title":"顺序"}"#)
            let runID = try field(created, "id", String.self)
            _ = try await server.send("PUT", "/api/runs/\(runID)/tasks/T1", json: #"{"title":"上游"}"#)
            _ = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/T2",
                json: #"{"title":"下游","depends_on":["T1"]}"#
            )

            let (status, _) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks",
                json: #"""
                    {"tasks":[
                      {"id":"T1","status":"done"},
                      {"id":"T2","status":"running"}
                    ]}
                    """#
            )
            #expect(status == 200)
            let reloaded = try server.store.run(runID)
            #expect(reloaded.task("T1")?.status == .done)
            #expect(reloaded.task("T2")?.status == .running)
        }
    }

    /// The mirror of the test above: the same status changes in the other order are
    /// refused, because at the moment T2 is checked T1 is still pending. Order
    /// matters exactly as it does for two separate single-task writes — that 409 is
    /// what a post-batch final-state sweep would wrongly let through.
    ///
    /// A valid entry (new task T3) is deliberately placed *ahead* of the rejected
    /// one, so the "writes nothing" half has something to actually roll back; with
    /// the rejected entry first there would be nothing written yet and the state
    /// assertions would hold even under a per-entry-commit implementation.
    @Test func theSameBatchInTheWrongOrderIsRefusedAndWritesNothing() async throws {
        try await withServer { server in
            let (_, created) = try await server.send("POST", "/api/runs", json: #"{"title":"逆序"}"#)
            let runID = try field(created, "id", String.self)
            _ = try await server.send("PUT", "/api/runs/\(runID)/tasks/T1", json: #"{"title":"上游"}"#)
            _ = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/T2",
                json: #"{"title":"下游","depends_on":["T1"]}"#
            )
            let before = try await server.snapshot(runID)

            let (status, body) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks",
                json: #"""
                    {"tasks":[
                      {"id":"T3","title":"新任务"},
                      {"id":"T2","status":"running"},
                      {"id":"T1","status":"done"}
                    ]}
                    """#
            )
            #expect(status == 409)
            #expect(try errorMessage(body).contains("T1"))

            #expect(try await server.snapshot(runID) == before)
            let reloaded = try server.store.run(runID)
            #expect(reloaded.task("T3") == nil)
            #expect(reloaded.task("T1")?.status == .pending)
            #expect(reloaded.task("T2")?.status == .pending)
        }
    }

    @Test func batchListFieldsKeepReplaceAndClear() async throws {
        try await withServer { server in
            let (_, created) = try await server.send("POST", "/api/runs", json: #"{"title":"批量三态"}"#)
            let runID = try field(created, "id", String.self)
            _ = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks",
                json: #"""
                    {"tasks":[
                      {"id":"T1","title":"甲"},
                      {"id":"T2","title":"乙","depends_on":["T1"],"write_scope":["a/","b/"],
                       "exclusive_resource":["res1"]}
                    ]}
                    """#
            )

            // Absent keeps, an array replaces, null clears — all in one batch.
            let (status, body) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks",
                json: #"""
                    {"tasks":[
                      {"id":"T2","detail":"只改说明"},
                      {"id":"T2","write_scope":["c/"],"depends_on":null}
                    ]}
                    """#
            )
            #expect(status == 200)
            let task = try taskEntry(in: body, id: "T2")
            #expect(task["detail"] as? String == "只改说明")
            #expect(task["write_scope"] as? [String] == ["c/"])
            #expect(task["depends_on"] as? [String] == [])
            // exclusive_resource was named in neither entry, so it survives both.
            #expect(task["exclusive_resource"] as? [String] == ["res1"])
        }
    }

    /// `handle` runs `checkOrigin` before `route`, and `checkOrigin` never looks at
    /// the path — so the two refusals below would also hold if the batch route did
    /// not exist at all, and "the store is untouched" is trivially true for a
    /// request that never reached routing. The positive control at the end is what
    /// gives them meaning: the *same* payload and URL, with the guards satisfied,
    /// really does reach the batch route and write. Together they pin that the
    /// batch route is refused for the guard's reason and not for want of a route.
    @Test func batchWritesAreRefusedByTheSharedOriginAndContentTypeGuards() async throws {
        try await withServer { server in
            let (_, created) = try await server.send("POST", "/api/runs", json: #"{"title":"门禁批"}"#)
            let runID = try field(created, "id", String.self)
            let payload = #"{"tasks":[{"id":"T1","title":"甲"}]}"#

            let (typeStatus, typeBody) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks", json: payload, contentType: "text/plain"
            )
            #expect(typeStatus == 400)
            #expect(try errorMessage(typeBody).contains("application/json"))

            let (originStatus, _) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks", json: payload, origin: "https://example.com"
            )
            #expect(originStatus == 403)

            // Neither refusal wrote anything.
            #expect(try server.store.run(runID).tasks.isEmpty)

            // Positive control: same URL, same body, guards satisfied.
            let (allowed, _) = try await server.send("PUT", "/api/runs/\(runID)/tasks", json: payload)
            #expect(allowed == 200)
            #expect(try server.store.run(runID).task("T1")?.title == "甲")
        }
    }

    // MARK: - Batch edge cases

    /// An empty batch is a no-op, not an error and not a timestamp bump: the store
    /// returns before it ever opens a transaction.
    @Test func anEmptyBatchChangesNothing() async throws {
        try await withServer { server in
            let (_, created) = try await server.send("POST", "/api/runs", json: #"{"title":"空批"}"#)
            let runID = try field(created, "id", String.self)
            _ = try await server.send("PUT", "/api/runs/\(runID)/tasks/T1", json: #"{"title":"甲"}"#)
            let before = try await server.snapshot(runID)

            let (status, body) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks", json: #"{"tasks":[]}"#
            )
            #expect(status == 200)
            #expect(try field(body, "tasks", [[String: Any]].self).count == 1)
            // Not even updated_at moved, so the response equals the prior snapshot.
            #expect(body as NSDictionary == before)
            #expect(try await server.snapshot(runID) == before)
        }
    }

    /// Pins a consequence of how the router has always worked, so it stays a
    /// decision rather than an accident: `path.split(separator: "/")` drops empty
    /// subsequences, so a trailing slash is invisible to routing. That predates the
    /// batch route (`GET .../graph/` has always matched `.../graph`); what is new is
    /// that `PUT .../tasks/` now lands on the batch route and answers 400 "missing
    /// field 'tasks'" where it used to be 404. No guard is reachable either way and
    /// an empty task ID still cannot reach the single-task path.
    @Test func aTrailingSlashFallsThroughToTheBatchRoute() async throws {
        try await withServer { server in
            let (_, created) = try await server.send("POST", "/api/runs", json: #"{"title":"斜杠"}"#)
            let runID = try field(created, "id", String.self)

            let (empty, emptyBody) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/", json: #"{"detail":"无 id"}"#
            )
            #expect(empty == 400)
            #expect(try errorMessage(emptyBody).contains("tasks"))
            #expect(try server.store.run(runID).tasks.isEmpty)

            // A well-formed batch body on the same trailing-slash URL is accepted,
            // exactly as `GET .../graph/` has always been.
            let (status, _) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/", json: #"{"tasks":[{"id":"T1","title":"甲"}]}"#
            )
            #expect(status == 200)
            #expect(try server.store.run(runID).task("T1")?.title == "甲")
        }
    }

    // MARK: - Project memory (/api/memories)

    /// `project` rides in the query string because it may be an absolute path;
    /// `key` is a constrained slug and sits in the path like a run or task ID.
    @Test func memoryRoutesRoundTripOverHTTP() async throws {
        try await withServer { server in
            let (addStatus, added) = try await server.send(
                "POST", "/api/memories",
                json: #"""
                    {"project":"boss-sdd","key":"gate.swift-test","value":"swift test",
                     "kind":"gate","source":"README.md:82"}
                    """#
            )
            #expect(addStatus == 200)
            #expect(added["key"] as? String == "gate.swift-test")
            #expect(added["value"] as? String == "swift test")
            #expect(added["kind"] as? String == "gate")
            #expect(added["source"] as? String == "README.md:82")

            let (getStatus, got) = try await server.send(
                "GET", "/api/memories/gate.swift-test?project=boss-sdd", contentType: nil
            )
            #expect(getStatus == 200)
            #expect(got["value"] as? String == "swift test")
            // `source` is carried on the read path, not merely stored.
            #expect(got["source"] as? String == "README.md:82")

            let (listStatus, listed) = try await server.send(
                "GET", "/api/memories?project=boss-sdd", contentType: nil
            )
            #expect(listStatus == 200)
            let entries = try field(listed, "memories", [[String: Any]].self)
            #expect(entries.map { $0["key"] as? String } == ["gate.swift-test"])
            #expect(entries.map { $0["source"] as? String } == ["README.md:82"])

            // The same key again overwrites rather than duplicating.
            _ = try await server.send(
                "POST", "/api/memories",
                json: #"""
                    {"project":"boss-sdd","key":"gate.swift-test","value":"swift test --parallel",
                     "kind":"gate","source":"Package.swift:1"}
                    """#
            )
            let (_, relisted) = try await server.send(
                "GET", "/api/memories?project=boss-sdd", contentType: nil
            )
            let after = try field(relisted, "memories", [[String: Any]].self)
            #expect(after.count == 1)
            #expect(after[0]["value"] as? String == "swift test --parallel")

            let (deleteStatus, deleted) = try await server.send(
                "DELETE", "/api/memories/gate.swift-test?project=boss-sdd", contentType: nil
            )
            #expect(deleteStatus == 200)
            #expect(deleted["deleted"] as? String == "gate.swift-test")

            let (missing, _) = try await server.send(
                "GET", "/api/memories/gate.swift-test?project=boss-sdd", contentType: nil
            )
            #expect(missing == 404)
        }
    }

    /// The dimension, over the wire: an absolute path as the project survives
    /// percent-encoding in the query string, and the two projects stay separate.
    @Test func memoriesAreIsolatedPerProjectOverHTTP() async throws {
        try await withServer { server in
            let alpha = "/Users/someone/Project/alpha"
            let beta = "/Users/someone/Project/beta"
            _ = try await server.send(
                "POST", "/api/memories",
                json: #"{"project":"\#(alpha)","key":"gate","value":"swift test","kind":"gate","source":"a:1"}"#
            )
            _ = try await server.send(
                "POST", "/api/memories",
                json: #"{"project":"\#(beta)","key":"gate","value":"go test ./...","kind":"gate","source":"b:1"}"#
            )

            let encodedAlpha = try #require(alpha.addingPercentEncoding(withAllowedCharacters: .alphanumerics))
            let encodedBeta = try #require(beta.addingPercentEncoding(withAllowedCharacters: .alphanumerics))

            let (_, alphaBody) = try await server.send(
                "GET", "/api/memories/gate?project=\(encodedAlpha)", contentType: nil
            )
            #expect(alphaBody["value"] as? String == "swift test")
            #expect(alphaBody["project"] as? String == alpha)

            let (_, betaBody) = try await server.send(
                "GET", "/api/memories/gate?project=\(encodedBeta)", contentType: nil
            )
            #expect(betaBody["value"] as? String == "go test ./...")

            let (_, alphaList) = try await server.send(
                "GET", "/api/memories?project=\(encodedAlpha)", contentType: nil
            )
            #expect(try field(alphaList, "memories", [[String: Any]].self).count == 1)
        }
    }

    @Test func memoryListFiltersByKind() async throws {
        try await withServer { server in
            for (key, kind) in [("gate.swift", "gate"), ("gate.go", "gate"), ("start", "run_recipe")] {
                _ = try await server.send(
                    "POST", "/api/memories",
                    json: #"{"project":"p","key":"\#(key)","value":"v","kind":"\#(kind)","source":"s:1"}"#
                )
            }

            let (all, allBody) = try await server.send("GET", "/api/memories?project=p", contentType: nil)
            #expect(all == 200)
            #expect(try field(allBody, "memories", [[String: Any]].self).count == 3)

            let (_, gates) = try await server.send(
                "GET", "/api/memories?project=p&kind=gate", contentType: nil
            )
            let gateKeys = try field(gates, "memories", [[String: Any]].self).map { $0["key"] as? String }
            #expect(gateKeys == ["gate.go", "gate.swift"])

            let (_, recipes) = try await server.send(
                "GET", "/api/memories?project=p&kind=run_recipe", contentType: nil
            )
            let recipeKeys = try field(recipes, "memories", [[String: Any]].self).map { $0["key"] as? String }
            #expect(recipeKeys == ["start"])

            let (_, none) = try await server.send(
                "GET", "/api/memories?project=p&kind=convention", contentType: nil
            )
            #expect(try field(none, "memories", [[String: Any]].self).isEmpty)

            let (badKind, badBody) = try await server.send(
                "GET", "/api/memories?project=p&kind=gates", contentType: nil
            )
            #expect(badKind == 400)
            #expect(try errorMessage(badBody).contains("run_recipe"))
        }
    }

    /// Same argument as the batch-route guard test: `handle` runs `checkOrigin`
    /// before `route`, and `checkOrigin` never looks at the path, so the refusals
    /// alone would also hold for a route that does not exist. The positive control
    /// at the end is what gives them meaning — the same URL and body, guards
    /// satisfied, really does reach the memory route and write.
    @Test func memoryWritesAreRefusedByTheSharedOriginAndContentTypeGuards() async throws {
        try await withServer { server in
            let payload = #"{"project":"p","key":"gate","value":"swift test","kind":"gate","source":"s:1"}"#

            let (typeStatus, typeBody) = try await server.send(
                "POST", "/api/memories", json: payload, contentType: "text/plain"
            )
            #expect(typeStatus == 400)
            #expect(try errorMessage(typeBody).contains("application/json"))

            let (originStatus, _) = try await server.send(
                "POST", "/api/memories", json: payload, origin: "https://example.com"
            )
            #expect(originStatus == 403)

            // Neither refusal wrote anything.
            #expect(try server.store.memories(project: "p").isEmpty)

            // Positive control: same URL, same body, guards satisfied.
            let (allowed, _) = try await server.send("POST", "/api/memories", json: payload)
            #expect(allowed == 200)
            #expect(try server.store.memory(project: "p", key: "gate").value == "swift test")

            // DELETE is not content-type gated (nor is `DELETE /api/runs/{id}`),
            // but the Origin refusal covers every method, this one included.
            let (deleteOrigin, _) = try await server.send(
                "DELETE", "/api/memories/gate?project=p", contentType: nil, origin: "https://example.com"
            )
            #expect(deleteOrigin == 403)
            #expect(try server.store.memory(project: "p", key: "gate").value == "swift test")

            // Positive control for the delete route too.
            let (deleted, _) = try await server.send(
                "DELETE", "/api/memories/gate?project=p", contentType: nil
            )
            #expect(deleted == 200)
            #expect(try server.store.memories(project: "p").isEmpty)
        }
    }

    @Test func memoryWritesRequireASourceAndAKnownKind() async throws {
        try await withServer { server in
            let (noSource, noSourceBody) = try await server.send(
                "POST", "/api/memories",
                json: #"{"project":"p","key":"gate","value":"swift test","kind":"gate","source":"  "}"#
            )
            #expect(noSource == 400)
            #expect(try errorMessage(noSourceBody).contains("source"))

            let (missingSource, missingBody) = try await server.send(
                "POST", "/api/memories",
                json: #"{"project":"p","key":"gate","value":"swift test","kind":"gate"}"#
            )
            #expect(missingSource == 400)
            #expect(try errorMessage(missingBody).contains("source"))

            let (badKind, badKindBody) = try await server.send(
                "POST", "/api/memories",
                json: #"{"project":"p","key":"gate","value":"v","kind":"gates","source":"s:1"}"#
            )
            #expect(badKind == 400)
            #expect(try errorMessage(badKindBody).contains("exclusive_resource"))

            #expect(try server.store.memories(project: "p").isEmpty)
        }
    }

    /// The per-project cap (`Store.upsertMemory`) surfaces over HTTP as a plain
    /// 400, the same as the other memory validation errors, and an upsert onto
    /// an existing key keeps working right at the limit — the store-level
    /// tests in `MemoryTests` cover the cap itself in depth; this just checks
    /// the API wiring doesn't swallow or reshape it.
    @Test func theMemoryCapSurfacesAsA400OverHTTPAndSparesExistingKeyUpdates() async throws {
        try await withServer { server in
            for i in 0..<memoryLimit {
                let (status, _) = try await server.send(
                    "POST", "/api/memories",
                    json: #"{"project":"p","key":"k\#(i)","value":"v","kind":"note","source":"x:1"}"#
                )
                #expect(status == 200)
            }

            let (capped, cappedBody) = try await server.send(
                "POST", "/api/memories",
                json: #"{"project":"p","key":"one-too-many","value":"v","kind":"note","source":"x:1"}"#
            )
            #expect(capped == 400)
            let message = try errorMessage(cappedBody)
            // Pinned as two separate clauses, not just "contains the digits
            // 100": at the cap boundary `count` and `memoryLimit` are the same
            // literal value, so a message with the count clause deleted (e.g.
            // "project p is full, at the limit of 100") would still contain
            // "100" — this checks the count clause's own text is present.
            // `MemoryTests.theCountClauseNamesActualRowsNotJustTheLimit` pins
            // the count itself against a value that actually differs from the
            // limit; this test only needs to confirm the API doesn't reshape
            // the message the store already produced.
            #expect(message.contains("already has \(memoryLimit) memories"))
            #expect(message.contains("at the limit of \(memoryLimit)"))
            #expect(message.lowercased().contains("delete"))

            // Updating an existing key still works at the cap.
            let (updated, _) = try await server.send(
                "POST", "/api/memories",
                json: #"{"project":"p","key":"k0","value":"corrected","kind":"gate","source":"y:2"}"#
            )
            #expect(updated == 200)
            #expect(try server.store.memory(project: "p", key: "k0").value == "corrected")
            #expect(try server.store.memories(project: "p").count == memoryLimit)
        }
    }

    /// The percent-decode → validator seam. `route` splits the path on "/" and
    /// only *then* percent-decodes each segment, so `%2F` survives the split and
    /// arrives at the store as a key containing a slash. That is the one place a
    /// traversal-shaped key could slip past path structure, so it is pinned here
    /// rather than left to the store-level alphabet tests, which never go through
    /// a URL. Unicode covers the `isASCII` branch of `isValidMemoryKey`.
    @Test func encodedSeparatorsAndUnicodeInAKeyAreRefused() async throws {
        try await withServer { server in
            // A real key, so a bypass would have something to hit.
            _ = try await server.send(
                "POST", "/api/memories",
                json: #"{"project":"p","key":"gate","value":"swift test","kind":"gate","source":"s:1"}"#
            )

            // %2F decodes to "/" inside the segment: rejected, never routed around.
            let (slash, slashBody) = try await server.send(
                "GET", "/api/memories/gate%2Fx?project=p", contentType: nil
            )
            #expect(slash == 400)
            #expect(try errorMessage(slashBody).contains("key"))

            // %2E%2E%2F is "../": same refusal, not a path that climbs anywhere.
            let (dots, _) = try await server.send(
                "GET", "/api/memories/%2E%2E%2Fgate?project=p", contentType: nil
            )
            #expect(dots == 400)

            // 门禁, percent-encoded. Non-ASCII stays non-ASCII through the fold.
            let (unicode, _) = try await server.send(
                "GET", "/api/memories/%E9%97%A8%E7%A6%81?project=p", contentType: nil
            )
            #expect(unicode == 400)

            // The same refusals on the write and delete paths.
            let (writeStatus, _) = try await server.send(
                "POST", "/api/memories",
                json: #"{"project":"p","key":"gate/x","value":"v","kind":"gate","source":"s:1"}"#
            )
            #expect(writeStatus == 400)
            let (deleteStatus, _) = try await server.send(
                "DELETE", "/api/memories/gate%2Fx?project=p", contentType: nil
            )
            #expect(deleteStatus == 400)

            // Nothing above reached, changed or removed the real entry.
            #expect(try server.store.memories(project: "p").map(\.key) == ["gate"])
        }
    }

    /// Keys fold to lower case over the wire too, so the URL a caller builds from a
    /// capitalised key still reaches the one row.
    @Test func memoryKeysAreCaseFoldedOverHTTP() async throws {
        try await withServer { server in
            _ = try await server.send(
                "POST", "/api/memories",
                json: #"{"project":"p","key":"Gate.Swift-Test","value":"swift test","kind":"gate","source":"s:1"}"#
            )
            let (_, listed) = try await server.send("GET", "/api/memories?project=p", contentType: nil)
            let entries = try field(listed, "memories", [[String: Any]].self)
            #expect(entries.map { $0["key"] as? String } == ["gate.swift-test"])

            let (upper, upperBody) = try await server.send(
                "GET", "/api/memories/GATE.SWIFT-TEST?project=p", contentType: nil
            )
            #expect(upper == 200)
            #expect(upperBody["value"] as? String == "swift test")
        }
    }

    /// A recorded decision, not an accident, and the counterpart to
    /// `aTrailingSlashFallsThroughToTheBatchRoute`: `path.split(separator: "/")`
    /// drops empty subsequences, so `GET /api/memories/?project=p` — an agent whose
    /// `$KEY` variable came out empty — loses the empty segment and matches the
    /// *list* route, answering 200 with a list-shaped body rather than 404. A naive
    /// client reading `.value` off that gets null instead of an error.
    ///
    /// The fix belongs to the router, which is shared and out of this task's scope;
    /// pinned here so the behaviour is visible and any later router change has to
    /// come past this test on purpose.
    @Test func aTrailingSlashOnTheMemoryGetFallsThroughToTheListRoute() async throws {
        try await withServer { server in
            _ = try await server.send(
                "POST", "/api/memories",
                json: #"{"project":"p","key":"gate","value":"swift test","kind":"gate","source":"s:1"}"#
            )

            let (status, body) = try await server.send(
                "GET", "/api/memories/?project=p", contentType: nil
            )
            #expect(status == 200)
            // List-shaped, not memory-shaped: `memories` present, `value` absent.
            #expect(body["memories"] != nil)
            #expect(body["value"] == nil)
            #expect(try field(body, "memories", [[String: Any]].self).count == 1)

            // Without a project it is at least a 400 rather than a wrong-shaped 200.
            let (noProject, _) = try await server.send("GET", "/api/memories/", contentType: nil)
            #expect(noProject == 400)

            // The delete route has no such fallthrough: DELETE has no list route, so
            // the trailing slash 404s instead of doing something broader.
            let (deleted, _) = try await server.send(
                "DELETE", "/api/memories/?project=p", contentType: nil
            )
            #expect(deleted == 404)
            #expect(try server.store.memories(project: "p").count == 1)
        }
    }

    @Test func memoryReadsRequireAProject() async throws {
        try await withServer { server in
            let (list, listBody) = try await server.send("GET", "/api/memories", contentType: nil)
            #expect(list == 400)
            #expect(try errorMessage(listBody).contains("project"))

            let (get, _) = try await server.send("GET", "/api/memories/gate", contentType: nil)
            #expect(get == 400)

            let (remove, _) = try await server.send("DELETE", "/api/memories/gate", contentType: nil)
            #expect(remove == 400)

            // Present-but-empty (`?project=`) is a different mistake from absent —
            // the caller built the URL and lost the value — and gets its own message.
            //
            // The assertion has to name the API's exact wording, because both
            // layers refuse this request: with `requiredQuery`'s empty check gone,
            // `""` falls through to `Store.normalizedProject`, which throws
            // "project must not be empty" — also a 400, also accurate, also
            // containing "must not be empty" and not "missing". A test written
            // against those looser properties passes with the API branch deleted,
            // which makes it no test of the split at all.
            //
            // There is no structural discriminator to use instead: every route that
            // calls `requiredQuery("project")` hands the result straight to the
            // store, so no input reaches one guard without reaching the other. The
            // wording is the only thing that differs — and "query parameter" is a
            // durable discriminator rather than an arbitrary one, because it is a
            // fact only the HTTP layer knows. `Store` has no concept of a request,
            // so its message cannot legitimately acquire that phrase.
            let (empty, emptyBody) = try await server.send(
                "GET", "/api/memories?project=", contentType: nil
            )
            #expect(empty == 400)
            let emptyMessage = try errorMessage(emptyBody)
            #expect(emptyMessage.contains("query parameter 'project'"))
            #expect(emptyMessage.contains("must not be empty"))
            #expect(!emptyMessage.contains("missing"))
            // And the two mistakes really do read differently, not just accidentally.
            let (_, absentBody) = try await server.send("GET", "/api/memories", contentType: nil)
            let absentMessage = try errorMessage(absentBody)
            #expect(absentMessage != emptyMessage)
        }
    }

    @Test func unknownStatusReportsTheAllowedSet() async throws {
        try await withServer { server in
            let (_, created) = try await server.send("POST", "/api/runs", json: #"{"title":"状态"}"#)
            let runID = try field(created, "id", String.self)
            let (status, body) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/T1", json: #"{"title":"甲","status":"finished"}"#
            )
            #expect(status == 400)
            #expect(try errorMessage(body).contains("review"))
        }
    }
}
