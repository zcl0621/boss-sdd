import Foundation
import Network

public let boardKitVersion = "0.1.0"

/// 18866 长期被已退役的 Python 看板占着；换一个端口比抢端口干净。
public let defaultBoardPort: UInt16 = 18888

public struct HTTPRequest: Sendable {
    public var method: String
    public var path: String
    public var headers: [String: String]
    public var body: Data

    public func header(_ name: String) -> String? { headers[name.lowercased()] }
}

public struct HTTPResponse: Sendable {
    public var status: Int
    public var headers: [String: String]
    public var body: Data

    public init(status: Int = 200, headers: [String: String] = [:], body: Data = Data()) {
        self.status = status
        self.headers = headers
        self.body = body
    }

    public static func json(_ body: Data, status: Int = 200) -> HTTPResponse {
        HTTPResponse(status: status, headers: ["Content-Type": "application/json; charset=utf-8"], body: body)
    }

    public static func text(_ body: String, status: Int = 200) -> HTTPResponse {
        HTTPResponse(
            status: status,
            headers: ["Content-Type": "text/plain; charset=utf-8"],
            body: Data(body.utf8)
        )
    }
}

public enum ServerState: Sendable, Equatable {
    case stopped
    case listening(port: UInt16)
    case failed(String)
}

/// Loopback-only HTTP/1.1 server. Small by design: one request per connection,
/// no keep-alive, no chunked bodies — the only client is a local agent running curl.
public final class HTTPServer: @unchecked Sendable {
    public typealias Handler = @Sendable (HTTPRequest) -> HTTPResponse

    private static let maximumBodyBytes = 1 << 20

    private let port: UInt16
    private let handler: Handler
    private let queue = DispatchQueue(label: "com.boss-sdd.http")
    private var listener: NWListener?
    private var stateHandler: (@Sendable (ServerState) -> Void)?

    public private(set) var state: ServerState = .stopped
    /// Actual bound port, which differs from `port` only when 0 was requested.
    public private(set) var boundPort: UInt16?

    public init(port: UInt16, handler: @escaping Handler) {
        self.port = port
        self.handler = handler
    }

    public func onStateChange(_ handler: @escaping @Sendable (ServerState) -> Void) {
        queue.async { self.stateHandler = handler }
    }

    public func start() {
        queue.async {
            guard self.listener == nil else { return }
            do {
                let parameters = NWParameters.tcp
                parameters.allowLocalEndpointReuse = true
                parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .init(rawValue: self.port)!)
                let listener = try NWListener(using: parameters)
                listener.stateUpdateHandler = { [weak self] state in
                    guard let self else { return }
                    switch state {
                    case .ready:
                        let bound = listener.port?.rawValue ?? self.port
                        self.boundPort = bound
                        self.update(.listening(port: bound))
                    case .failed(let error): self.update(.failed(Self.describe(error, port: self.port)))
                    case .cancelled: self.update(.stopped)
                    default: break
                    }
                }
                listener.newConnectionHandler = { [weak self] connection in
                    self?.accept(connection)
                }
                listener.start(queue: self.queue)
                self.listener = listener
            } catch {
                self.update(.failed(Self.describe(error, port: self.port)))
            }
        }
    }

    public func stop() {
        queue.async {
            self.listener?.cancel()
            self.listener = nil
        }
    }

    private static func describe(_ error: Error, port: UInt16) -> String {
        if let error = error as? NWError, case .posix(let code) = error, code == .EADDRINUSE {
            return "端口 \(port) 已被其他进程占用"
        }
        return String(describing: error)
    }

    private func update(_ state: ServerState) {
        self.state = state
        stateHandler?(state)
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(connection, buffer: Data())
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
            [weak self] chunk, _, isComplete, error in
            guard let self else { return }
            var buffer = buffer
            if let chunk { buffer.append(chunk) }
            if error != nil { connection.cancel(); return }

            guard let head = Self.headEnd(in: buffer) else {
                if isComplete || buffer.count > Self.maximumBodyBytes {
                    connection.cancel()
                } else {
                    self.receive(connection, buffer: buffer)
                }
                return
            }

            guard var request = Self.parseHead(buffer.prefix(upTo: head.start)) else {
                self.send(.text("bad request", status: 400), on: connection)
                return
            }
            let expected = Int(request.header("content-length") ?? "") ?? 0
            guard expected <= Self.maximumBodyBytes else {
                self.send(.text("payload too large", status: 413), on: connection)
                return
            }
            let available = buffer.count - head.end
            if available < expected {
                if isComplete { connection.cancel() } else { self.receive(connection, buffer: buffer) }
                return
            }
            request.body = buffer.subdata(in: head.end..<(head.end + expected))
            self.send(self.handler(request), on: connection)
        }
    }

    private static func headEnd(in buffer: Data) -> (start: Int, end: Int)? {
        let marker = Data("\r\n\r\n".utf8)
        guard let range = buffer.firstRange(of: marker) else { return nil }
        return (range.lowerBound, range.upperBound)
    }

    private static func parseHead(_ data: Data) -> HTTPRequest? {
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        var lines = text.components(separatedBy: "\r\n")
        guard !lines.isEmpty else { return nil }
        let requestLine = lines.removeFirst().split(separator: " ")
        guard requestLine.count >= 2 else { return nil }

        var headers: [String: String] = [:]
        for line in lines where line.contains(":") {
            guard let separator = line.firstIndex(of: ":") else { continue }
            let name = line[line.startIndex..<separator].lowercased()
            let value = line[line.index(after: separator)...].trimmingCharacters(in: .whitespaces)
            headers[name] = value
        }
        return HTTPRequest(
            method: String(requestLine[0]).uppercased(),
            path: String(requestLine[1]),
            headers: headers,
            body: Data()
        )
    }

    private func send(_ response: HTTPResponse, on connection: NWConnection) {
        var head = "HTTP/1.1 \(response.status) \(Self.reason(response.status))\r\n"
        var headers = response.headers
        headers["Content-Length"] = String(response.body.count)
        headers["Connection"] = "close"
        headers["Cache-Control"] = "no-store"
        headers["X-Content-Type-Options"] = "nosniff"
        for (name, value) in headers.sorted(by: { $0.key < $1.key }) {
            head += "\(name): \(value)\r\n"
        }
        head += "\r\n"
        var payload = Data(head.utf8)
        payload.append(response.body)
        connection.send(content: payload, completion: .contentProcessed { _ in connection.cancel() })
    }

    private static func reason(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 201: return "Created"
        case 400: return "Bad Request"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 405: return "Method Not Allowed"
        case 409: return "Conflict"
        case 413: return "Payload Too Large"
        case 415: return "Unsupported Media Type"
        default: return "Error"
        }
    }
}
