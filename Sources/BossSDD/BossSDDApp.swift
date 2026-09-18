import SwiftUI
import BoardKit

@main
struct BossSDDApp: App {
    @State private var model: BoardModel?
    @State private var startupError: String?

    // `App.init` is nonisolated, but SwiftUI runs it on the main thread before the
    // first scene exists, which is the only moment an appearance override still
    // reaches every window the app goes on to open.
    init() { MainActor.assumeIsolated { applyAppearanceOverride() } }

    var body: some Scene {
        Window("Plan SDD", id: "board") {
            Group {
                if let model {
                    BoardWindow(model: model)
                } else {
                    StartupFailureView(message: startupError ?? loc("app.starting"))
                }
            }
            .task { bootIfNeeded() }
        }
        .defaultSize(width: 1180, height: 700)
        .windowToolbarStyle(.unified)

        MenuBarExtra {
            MenuBarContent(model: model, startupError: startupError)
        } label: {
            Image(systemName: menuBarSymbol)
        }
    }

    private var menuBarSymbol: String {
        guard let model else { return "exclamationmark.triangle" }
        return model.serverIsHealthy ? "point.3.connected.trianglepath.dotted" : "exclamationmark.triangle"
    }

    private func bootIfNeeded() {
        guard model == nil, startupError == nil else { return }
        do {
            let model = try BoardModel()
            model.start()
            self.model = model
        } catch {
            startupError = String(describing: error)
        }
    }
}

/// `--appearance dark` / `--appearance light` pins this process to one appearance.
///
/// Kept because there is otherwise no way to see the window in dark without changing
/// the whole machine: `-AppleInterfaceStyle Dark` in argv is ignored, unlike
/// `-AppleLanguages`. Setting `NSApplication.appearance` is per-process and touches no
/// user default, so the board can be checked against the design document in either
/// appearance on a Mac that stays in the other. With no flag the app follows the system.
@MainActor
private func applyAppearanceOverride() {
    let arguments = CommandLine.arguments
    guard let flag = arguments.firstIndex(of: "--appearance"),
          let choice = arguments.dropFirst(flag + 1).first else { return }
    switch choice {
    case "dark": NSApplication.shared.appearance = NSAppearance(named: .darkAqua)
    case "light": NSApplication.shared.appearance = NSAppearance(named: .aqua)
    default: break
    }
}

struct StartupFailureView: View {
    let message: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "externaldrive.trianglebadge.exclamationmark")
                .font(.system(size: 26))
                .foregroundStyle(.secondary)
            Text(loc("app.startFailed")).font(.headline)
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
                .frame(maxWidth: 380)
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
