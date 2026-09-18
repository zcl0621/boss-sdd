import SwiftUI
import BoardKit

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

    /// System colours only — they already carry light, dark and increased-contrast variants.
    var tint: Color {
        switch self {
        case .done: return .green
        case .running, .ready: return .accentColor
        case .review, .resourceBlocked: return .orange
        case .blocked: return .red
        case .pending, .upstreamBlocked: return .secondary
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
        case .pending, .planning: return .secondary
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
