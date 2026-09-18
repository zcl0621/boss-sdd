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
