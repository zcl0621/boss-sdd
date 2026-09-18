import Foundation
import Testing
@testable import BoardKit

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
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
        request.httpMethod = method
        if let json { request.httpBody = Data(json.utf8) }
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if let origin { request.setValue(origin, forHTTPHeaderField: "Origin") }
        let (data, response) = try await URLSession.shared.data(for: request)
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        return ((response as! HTTPURLResponse).statusCode, body)
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
            let runID = created["id"] as! String

            _ = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/T1",
                json: #"{"title":"打底","write_scope":["app/core/"]}"#
            )
            let (status, body) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/T2",
                json: #"{"title":"接入","depends_on":["T1"],"write_scope":["app/ui/"]}"#
            )
            #expect(status == 200)
            let graph = body["graph"] as! [String: Any]
            #expect(graph["valid"] as? Bool == true)
            #expect(graph["ready_task_ids"] as? [String] == ["T1"])
        }
    }

    @Test func startingABlockedTaskIsRejected() async throws {
        try await withServer { server in
            let (_, created) = try await server.send("POST", "/api/runs", json: #"{"title":"门禁"}"#)
            let runID = created["id"] as! String
            _ = try await server.send("PUT", "/api/runs/\(runID)/tasks/T1", json: #"{"title":"上游"}"#)
            _ = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/T2",
                json: #"{"title":"下游","depends_on":["T1"]}"#
            )
            let (status, body) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/T2", json: #"{"status":"running"}"#
            )
            #expect(status == 409)
            let error = body["error"] as! [String: Any]
            #expect((error["message"] as! String).contains("T1"))
        }
    }

    @Test func exclusiveResourceConflictIsRejected() async throws {
        try await withServer { server in
            let (_, created) = try await server.send("POST", "/api/runs", json: #"{"title":"资源"}"#)
            let runID = created["id"] as! String
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
            #expect(((body["error"] as! [String: Any])["message"] as! String).contains("pytest"))
        }
    }

    @Test func listFieldsKeepReplaceAndClear() async throws {
        try await withServer { server in
            let (_, created) = try await server.send("POST", "/api/runs", json: #"{"title":"三态"}"#)
            let runID = created["id"] as! String
            _ = try await server.send("PUT", "/api/runs/\(runID)/tasks/T1", json: #"{"title":"甲"}"#)
            _ = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/T2",
                json: #"{"title":"乙","depends_on":["T1"],"write_scope":["a/","b/"]}"#
            )

            // Absent keys keep the current lists.
            var (_, body) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/T2", json: #"{"detail":"只改说明"}"#
            )
            var task = (body["tasks"] as! [[String: Any]]).first { $0["id"] as! String == "T2" }!
            #expect(task["depends_on"] as? [String] == ["T1"])
            #expect(task["write_scope"] as? [String] == ["a/", "b/"])

            // An array replaces wholesale; null clears.
            (_, body) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/T2",
                json: #"{"write_scope":["c/"],"depends_on":null}"#
            )
            task = (body["tasks"] as! [[String: Any]]).first { $0["id"] as! String == "T2" }!
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
            #expect(((body["error"] as! [String: Any])["message"] as! String).contains("application/json"))
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
            let runID = created["id"] as! String
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
            #expect(((body["error"] as! [String: Any])["message"] as! String).contains("T1"))

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
            let runID = created["id"] as! String
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
            #expect(((body["error"] as! [String: Any])["message"] as! String).contains("pytest"))

            #expect(try await server.snapshot(runID) == before)
            #expect(try server.store.run(runID).tasks.isEmpty)
        }
    }

    @Test func aBatchWritesTheWholeDAGInOneRequest() async throws {
        try await withServer { server in
            let (_, created) = try await server.send("POST", "/api/runs", json: #"{"title":"整图"}"#)
            let runID = created["id"] as! String

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
            let graph = body["graph"] as! [String: Any]
            #expect(graph["valid"] as? Bool == true)
            #expect(graph["ready_task_ids"] as? [String] == ["T1"])
            #expect((body["tasks"] as! [[String: Any]]).map { $0["id"] as! String } == ["T1", "T2", "T3"])
        }
    }

    /// Guards run incrementally, in the order given: a batch may complete a
    /// dependency and start its dependent, because by the time the second entry is
    /// checked the first has already been applied to the in-batch state.
    @Test func aBatchMayFinishADependencyAndStartItsDependent() async throws {
        try await withServer { server in
            let (_, created) = try await server.send("POST", "/api/runs", json: #"{"title":"顺序"}"#)
            let runID = created["id"] as! String
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
            let runID = created["id"] as! String
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
            #expect(((body["error"] as! [String: Any])["message"] as! String).contains("T1"))

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
            let runID = created["id"] as! String
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
            let task = (body["tasks"] as! [[String: Any]]).first { $0["id"] as! String == "T2" }!
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
            let runID = created["id"] as! String
            let payload = #"{"tasks":[{"id":"T1","title":"甲"}]}"#

            let (typeStatus, typeBody) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks", json: payload, contentType: "text/plain"
            )
            #expect(typeStatus == 400)
            #expect(((typeBody["error"] as! [String: Any])["message"] as! String).contains("application/json"))

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
            let runID = created["id"] as! String
            _ = try await server.send("PUT", "/api/runs/\(runID)/tasks/T1", json: #"{"title":"甲"}"#)
            let before = try await server.snapshot(runID)

            let (status, body) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks", json: #"{"tasks":[]}"#
            )
            #expect(status == 200)
            #expect((body["tasks"] as! [[String: Any]]).count == 1)
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
            let runID = created["id"] as! String

            let (empty, emptyBody) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/", json: #"{"detail":"无 id"}"#
            )
            #expect(empty == 400)
            #expect(((emptyBody["error"] as! [String: Any])["message"] as! String).contains("tasks"))
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

    @Test func unknownStatusReportsTheAllowedSet() async throws {
        try await withServer { server in
            let (_, created) = try await server.send("POST", "/api/runs", json: #"{"title":"状态"}"#)
            let runID = created["id"] as! String
            let (status, body) = try await server.send(
                "PUT", "/api/runs/\(runID)/tasks/T1", json: #"{"title":"甲","status":"finished"}"#
            )
            #expect(status == 400)
            #expect(((body["error"] as! [String: Any])["message"] as! String).contains("review"))
        }
    }
}
