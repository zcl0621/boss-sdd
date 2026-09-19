import SwiftUI
import BoardKit

@main
struct BossSDDApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
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
            MenuBarLabel(symbol: menuBarSymbol)
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

/// The one way SwiftUI's `openWindow` reaches AppKit: an `NSApplicationDelegate`
/// has no environment to read it out of.
@MainActor
enum BoardWindowOpener {
    static var open: (() -> Void)?
}

/// The status item's glyph, and on the way the registration above. The menu bar
/// label hosts it because it is the one view that exists whether or not the board
/// window does — which is exactly the case the delegate has to handle.
private struct MenuBarLabel: View {
    let symbol: String
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Image(systemName: symbol)
            .onAppear { BoardWindowOpener.open = { openWindow(id: "board") } }
    }
}

/// Launching an app that is already running does not launch it again: the Dock
/// tile, Spotlight, `open -a` and a double click in Finder all arrive here instead.
/// Without this the gesture only raised the app, and a board window that had been
/// closed stayed closed — `show()` in the menu bar was the only caller that ever
/// opened one, and macOS hides that menu bar item whenever the bar runs out of room.
/// Between them that left no way back in, which is also why this app is no longer
/// `LSUIElement` (see the Info.plist in Scripts/bundle.sh).
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        if !hasVisibleWindows { BoardWindowOpener.open?() }
        sender.activate(ignoringOtherApps: true)
        return true
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
