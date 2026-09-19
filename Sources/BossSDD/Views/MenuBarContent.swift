import SwiftUI
import BoardKit

struct MenuBarContent: View {
    let model: BoardModel?
    let startupError: String?
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        if let model {
            Text(model.serverIsHealthy
                 ? loc("menu.writeAPI", model.serverSummary) : model.serverSummary)
            Divider()
            ForEach(model.runs.prefix(8)) { run in
                Button {
                    model.selectedRunID = run.id
                    model.selectedTaskID = nil
                    show()
                } label: {
                    // Run title and counts are data, never translated.
                    Text(verbatim: "\(run.title) — \(progress(run))")
                }
            }
            if model.runs.isEmpty { Text(loc("menu.noRuns")).foregroundStyle(.secondary) }
            Divider()
            Button(loc("menu.openBoard")) { show() }.keyboardShortcut("0", modifiers: .command)
            Button(loc("menu.importLegacy")) { model.importLegacyRuns() }
            Toggle(loc("menu.launchAtLogin"), isOn: Binding(
                get: { model.launchesAtLogin },
                set: { model.setLaunchesAtLogin($0) }
            ))
        } else {
            Text(startupError ?? loc("app.starting"))
            Button(loc("menu.openBoard")) { show() }
        }
        Divider()
        Button(loc("menu.quit")) { NSApplication.shared.terminate(nil) }
            .keyboardShortcut("q", modifiers: .command)
    }

    private func progress(_ run: Run) -> String {
        "\(run.tasks.count { $0.status == .done })/\(run.tasks.count)"
    }

    /// Picking from this menu does not make the app frontmost, so opening the
    /// window has to raise it too — otherwise the board appears behind whatever
    /// the user was in.
    private func show() {
        openWindow(id: "board")
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
}
