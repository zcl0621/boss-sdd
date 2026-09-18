import SwiftUI
import BoardKit

struct MenuBarContent: View {
    let model: BoardModel?
    let startupError: String?
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        if let model {
            Text(model.serverIsHealthy ? "写入接口 \(model.serverSummary)" : model.serverSummary)
            Divider()
            ForEach(model.runs.prefix(8)) { run in
                Button("\(run.title) — \(progress(run))") {
                    model.selectedRunID = run.id
                    model.selectedTaskID = nil
                    show()
                }
            }
            if model.runs.isEmpty { Text("还没有运行记录").foregroundStyle(.secondary) }
            Divider()
            Button("打开看板") { show() }.keyboardShortcut("0", modifiers: .command)
            Button("从旧 JSON 导入") { model.importLegacyRuns() }
            Toggle("开机自动启动", isOn: Binding(
                get: { model.launchesAtLogin },
                set: { model.setLaunchesAtLogin($0) }
            ))
        } else {
            Text(startupError ?? "正在启动…")
            Button("打开看板") { show() }
        }
        Divider()
        Button("退出 Plan SDD") { NSApplication.shared.terminate(nil) }
            .keyboardShortcut("q", modifiers: .command)
    }

    private func progress(_ run: Run) -> String {
        "\(run.tasks.count { $0.status == .done })/\(run.tasks.count)"
    }

    /// The app has no Dock icon, so opening the window has to raise the app too.
    private func show() {
        openWindow(id: "board")
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
}
