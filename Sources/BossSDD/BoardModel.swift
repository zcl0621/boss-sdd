import Foundation
import Observation
import ServiceManagement
import SwiftUI
import BoardKit

/// Owns the store and the HTTP server, and projects both into the window.
/// Writes only ever arrive over HTTP; the UI is a read-only view of the store.
@MainActor
@Observable
final class BoardModel {
    private(set) var runs: [Run] = []
    private(set) var serverState: ServerState = .stopped
    private(set) var loadError: String?
    private(set) var importReport: String?

    var selectedRunID: String?
    var selectedTaskID: String?
    var view: BoardView = .graph

    enum BoardView: String, CaseIterable, Identifiable {
        case graph, columns
        var id: String { rawValue }
        var label: String { self == .graph ? "依赖图" : "分栏" }
    }

    let port: UInt16
    private let store: Store
    private let server: HTTPServer
    private var observerToken: UUID?

    /// BOSS_SDD_PORT overrides the default, so a second instance can run beside
    /// whatever already holds the default port.
    static var configuredPort: UInt16 {
        ProcessInfo.processInfo.environment["BOSS_SDD_PORT"].flatMap(UInt16.init) ?? defaultBoardPort
    }

    init(port: UInt16 = BoardModel.configuredPort) throws {
        self.port = port
        // BOSS_SDD_HOME, read inside Store, moves the board and the legacy runs
        // together. It throws rather than falling back when it is unusable, so a
        // misconfigured override surfaces as a startup failure instead of quietly
        // opening the user's real board.
        store = try Store()
        // The server publishes the port it actually binds here, so /api/health
        // answers with the live socket even when 0 was requested.
        let boundPort = BoundPort(requested: port)
        let api = API(store: store, boundPort: boundPort)
        server = HTTPServer(port: port, reporting: boundPort) { api.handle($0) }
    }

    func start() {
        observerToken = store.addObserver { [weak self] in
            Task { @MainActor in self?.reload() }
        }
        server.onStateChange { [weak self] state in
            Task { @MainActor in self?.serverState = state }
        }
        server.start()
        importLegacyRunsIfEmpty()
        reload()
    }

    func reload() {
        do {
            runs = try store.allRuns()
            loadError = nil
            if let id = selectedRunID, !runs.contains(where: { $0.id == id }) { selectedRunID = nil }
            if selectedRunID == nil { selectedRunID = runs.first?.id }
            if let task = selectedTaskID, selectedRun?.task(task) == nil { selectedTaskID = nil }
        } catch {
            loadError = String(describing: error)
        }
    }

    var selectedRun: Run? {
        guard let id = selectedRunID else { return runs.first }
        return runs.first { $0.id == id } ?? runs.first
    }

    var graph: GraphProjection? {
        selectedRun.map(deriveGraph)
    }

    var selectedTask: BoardTask? {
        guard let id = selectedTaskID else { return nil }
        return selectedRun?.task(id)
    }

    // MARK: - Status line

    var serverSummary: String {
        switch serverState {
        case .listening(let port): return "127.0.0.1:\(port)"
        case .stopped: return "服务未启动"
        case .failed(let reason): return reason
        }
    }

    var serverIsHealthy: Bool {
        if case .listening = serverState { return true }
        return false
    }

    // MARK: - Legacy import

    /// One-time lift of the runs the Python board wrote. The JSON files are left in
    /// place — this reads them, it does not take them over.
    func importLegacyRunsIfEmpty() {
        guard (try? store.allRuns())?.isEmpty == true else { return }
        let directory = LegacyImport.runsDirectory(in: store.directory)
        guard FileManager.default.fileExists(atPath: directory.path) else { return }
        importLegacyRuns()
    }

    func importLegacyRuns() {
        let result = LegacyImport.importAll(
            from: LegacyImport.runsDirectory(in: store.directory), into: store
        )
        var lines = ["导入 \(result.imported.count) 个运行"]
        if !result.skipped.isEmpty { lines.append("跳过 \(result.skipped.count) 个：" + result.skipped.joined(separator: "；")) }
        importReport = lines.joined(separator: "\n")
        reload()
    }

    // MARK: - Login item

    var launchesAtLogin: Bool {
        SMAppService.mainApp.status == .enabled
    }

    func setLaunchesAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            importReport = "开机自启设置失败：\(error)"
        }
    }
}
