import SwiftUI
import BoardKit

struct InspectorView: View {
    /// Fixed 24-hour clock rather than the locale's own short time: several locales
    /// prefix an AM/PM marker, which pushes the 38pt timestamp column onto two lines.
    nonisolated(unsafe) static let clock: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    let run: Run
    let graph: GraphProjection
    let task: BoardTask?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let task {
                    taskDetail(task)
                } else {
                    runOverview
                }
            }
        }
        .background(Color(nsColor: .controlBackgroundColor))
    }

    // MARK: - Run

    @ViewBuilder
    private var runOverview: some View {
        header(eyebrow: String(run.id.prefix(10)), title: loc("inspector.runOverview")) {
            InspectorPill(symbol: run.symbolForPill, tint: run.status.tint, text: run.status.label)
            InspectorPill(text: loc("inspector.layers", graph.topologicalLayers.count))
            InspectorPill(text: loc("inspector.ready", graph.readyTaskIDs.count))
        }
        InspectorField(loc("inspector.summary")) {
            if run.summary.isEmpty {
                Text(loc("inspector.summary.empty")).font(.system(size: 12)).foregroundStyle(.tertiary)
            } else {
                Text(run.summary).font(.system(size: 12)).textSelection(.enabled)
            }
        }
        InspectorField(loc("inspector.activity")) {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(run.events.suffix(12).reversed().enumerated()), id: \.offset) { _, event in
                    HStack(alignment: .top, spacing: 9) {
                        Text(Self.clock.string(from: event.at))
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .monospacedDigit()
                            .frame(width: 38, alignment: .leading)
                        Text(describe(event))
                            .font(.system(size: 11.5))
                            .foregroundStyle(.secondary)
                            .lineLimit(4)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }

    private func describe(_ event: RunEvent) -> String {
        var parts: [String] = []
        if let task = event.task { parts.append(task) }
        parts.append(event.status.flatMap { TaskStatus(rawValue: $0) }.map { VisualState.of(
            BoardTask(id: "_", title: "", status: $0), in: graph).label } ?? actionLabel(event.action))
        let head = parts.joined(separator: " · ")
        return event.note.isEmpty ? head : "\(head) — \(event.note)"
    }

    private func actionLabel(_ action: String) -> String {
        switch action {
        case "init": return loc("inspector.event.init")
        case "task": return loc("inspector.event.task")
        case "update": return loc("inspector.event.update")
        default: return action
        }
    }

    // MARK: - Task

    @ViewBuilder
    private func taskDetail(_ task: BoardTask) -> some View {
        let state = VisualState.of(task, in: graph)
        let conflicts = graph.blockedBy[task.id]?.resourceConflicts ?? []

        header(eyebrow: task.id, title: task.title) {
            InspectorPill(symbol: state == .running ? nil : state.symbol, tint: state.tint, text: state.label)
            InspectorPill(text: task.agent.isEmpty ? loc("inspector.unassigned") : task.agent)
        }
        InspectorField(loc("inspector.progress")) {
            if task.detail.isEmpty {
                Text(loc("inspector.progress.empty")).font(.system(size: 12)).foregroundStyle(.tertiary)
            } else {
                Text(task.detail).font(.system(size: 12)).textSelection(.enabled)
            }
        }
        InspectorField(loc("inspector.dependsOn")) { InspectorValues(task.dependsOn) }
        InspectorField(loc("inspector.waitingOn")) { InspectorValues(graph.waitingOn[task.id] ?? []) }
        InspectorField(loc("inspector.writeScope")) { InspectorValues(task.writeScope) }
        InspectorField(loc("inspector.exclusiveResources")) {
            InspectorValues(task.exclusiveResource, warning: !conflicts.isEmpty)
        }
        if !conflicts.isEmpty {
            InspectorField(loc("inspector.resourceConflicts")) {
                InspectorValues(conflicts.map { "\($0.taskID) · \($0.resources.joined(separator: " / "))" },
                       warning: true)
            }
        }
        InspectorField(loc("inspector.dependents")) { InspectorValues(graph.dependents[task.id] ?? []) }
    }

    // MARK: - Chrome

    @ViewBuilder
    private func header(
        eyebrow: String, title: String, @ViewBuilder pills: () -> some View
    ) -> some View {
        InspectorHeader(eyebrow: eyebrow, title: title, pills: pills)
    }
}

private extension Run {
    var symbolForPill: String? { status == .running ? nil : status.symbol }
}
