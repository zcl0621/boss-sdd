import SwiftUI
import BoardKit

@main
struct BossSDDApp: App {
    @State private var model: BoardModel?
    @State private var startupError: String?

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
