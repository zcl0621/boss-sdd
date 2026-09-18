import SwiftUI
import BoardKit

/// The two content-layer surfaces the design document pins to a literal value.
///
/// The rest of that document's palette is already the macOS semantic palette it was
/// drawn from — its labels are `labelColor`/`secondaryLabelColor`/`tertiaryLabelColor`,
/// its separator is `separatorColor`, its accent and status colours are
/// `controlAccentColor`/`systemGreen`/`systemOrange`/`systemRed`/`systemGray`, and its
/// `--control-bg` is `controlBackgroundColor` in both appearances. Those stay semantic
/// here, so they keep adapting to increased contrast.
///
/// These two cannot. `--content-bg` has no semantic equivalent that renders it:
/// `underPageBackgroundColor` was the obvious candidate and draws mid-grey on screen
/// regardless of what its components report. `--raised` collides with `--control-bg`:
/// they are the same white in light and diverge in dark, so one `NSColor` cannot be
/// both. A named dynamic colour states each once and lets the appearance pick.
enum Palette {
    /// The graph/columns canvas — the content layer's ground.
    static let content = dynamic(name: "content-bg", light: 0xF6_F6_F6, dark: 0x25_25_25)
    /// A task card's face: lifted off the canvas, and in dark lighter than the
    /// inspector rather than darker.
    static let raised = dynamic(name: "raised", light: 0xFF_FF_FF, dark: 0x2D_2D_2D)

    private static func dynamic(name: String, light: UInt32, dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: name) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return srgb(isDark ? dark : light)
        })
    }

    private static func srgb(_ hex: UInt32) -> NSColor {
        NSColor(
            srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

/// Concentric radii, outermost first. A control nested in a card nested in the window
/// steps down so the curves stay visually parallel.
enum Metrics {
    static let card: CGFloat = 8
    static let control: CGFloat = 7
    static let chip: CGFloat = 5
    static let hairline: CGFloat = 0.5

    static let cardWidth: CGFloat = 190
    static let layerSpacing: CGFloat = 54
    static let rowSpacing: CGFloat = 9
}

/// What the board shows for a task, which is not what the store holds: `ready`,
/// `upstreamBlocked` and `resourceBlocked` are read off the graph projection.
enum VisualState: Equatable {
    case pending
    case ready
    case running
    case review
    case blocked
    case done
    case upstreamBlocked
    case resourceBlocked

    static func of(_ task: BoardTask, in graph: GraphProjection) -> VisualState {
        switch task.status {
        case .done: return .done
        case .running: return .running
        case .review: return .review
        case .blocked: return .blocked
        case .pending: break
        }
        if graph.blockedBy[task.id]?.dependencyTaskIDs.isEmpty == false { return .upstreamBlocked }
        if graph.blockedBy[task.id]?.resourceConflicts.isEmpty == false { return .resourceBlocked }
        return graph.readyTaskIDs.contains(task.id) ? .ready : .pending
    }

    var label: String {
        switch self {
        case .pending, .upstreamBlocked: return loc("state.waiting")
        case .ready: return loc("state.ready")
        case .running: return loc("state.running")
        case .review: return loc("state.review")
        case .blocked: return loc("state.blocked")
        case .done: return loc("state.done")
        case .resourceBlocked: return loc("state.resourceHeld")
        }
    }

    /// Shape carries the state; colour only reinforces it, so the board stays readable
    /// without colour vision. HIG: don't rely solely on colour to communicate state.
    var symbol: String {
        switch self {
        case .pending: return "circle"
        case .upstreamBlocked: return "circle.dashed"
        case .ready: return "arrow.right.circle"
        case .running: return "progress.indicator"
        case .review: return "exclamationmark.circle.fill"
        case .blocked: return "exclamationmark.octagon.fill"
        case .done: return "checkmark.circle.fill"
        case .resourceBlocked: return "lock.circle.fill"
        }
    }

    /// System colours only — they already carry light, dark and increased-contrast
    /// variants. Waiting states take `systemGray` rather than the secondary label
    /// colour: a label colour tracks the text around it, and this is a glyph fill.
    var tint: Color {
        switch self {
        case .done: return .green
        case .running, .ready: return .accentColor
        case .review, .resourceBlocked: return .orange
        case .blocked: return .red
        case .pending, .upstreamBlocked: return .gray
        }
    }
}

extension RunStatus {
    var label: String {
        switch self {
        case .pending: return loc("run.status.pending")
        case .planning: return loc("run.status.planning")
        case .awaitingConfirmation: return loc("run.status.awaitingConfirmation")
        case .running: return loc("run.status.running")
        case .review: return loc("run.status.review")
        case .blocked: return loc("run.status.blocked")
        case .done: return loc("run.status.done")
        }
    }

    var symbol: String {
        switch self {
        case .pending: return "circle"
        case .planning: return "pencil.circle"
        case .awaitingConfirmation: return "questionmark.circle"
        case .running: return "progress.indicator"
        case .review: return "exclamationmark.circle.fill"
        case .blocked: return "exclamationmark.octagon.fill"
        case .done: return "checkmark.circle.fill"
        }
    }

    var tint: Color {
        switch self {
        case .done: return .green
        case .running: return .accentColor
        case .review, .awaitingConfirmation: return .orange
        case .blocked: return .red
        case .pending, .planning: return .gray
        }
    }
}

extension View {
    /// Liquid Glass for a floating control. Only the functional layer gets this —
    /// HIG: "Don't use Liquid Glass in the content layer."
    @ViewBuilder
    func floatingControl(radius: CGFloat = 11) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        if #available(macOS 26.0, *) {
            glassEffect(.regular, in: shape)
        } else {
            background(.regularMaterial, in: shape)
                .overlay { shape.strokeBorder(.separator, lineWidth: Metrics.hairline) }
        }
    }
}

/// A path shown in a narrow column: the last segments are what tell two worktrees
/// of the same repository apart.
func shortPath(_ path: String, keeping count: Int = 2) -> String {
    let parts = path.split(separator: "/").map(String.init)
    guard parts.count > count else { return path }
    return "…/" + parts.suffix(count).joined(separator: "/")
}
