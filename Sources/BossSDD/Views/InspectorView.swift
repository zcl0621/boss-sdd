import SwiftUI
import BoardKit

struct InspectorView: View {
    /// Fixed 24-hour clock: the locale's own short time is "下午 6:28" here, which wraps
    /// the timestamp column onto two lines.
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
        header(eyebrow: String(run.id.prefix(10)), title: "运行概览") {
            Pill(symbol: run.symbolForPill, tint: run.status.tint, text: run.status.label)
            Pill(text: "\(graph.topologicalLayers.count) 层")
            Pill(text: "就绪 \(graph.readyTaskIDs.count)")
        }
        Field("摘要") {
            if run.summary.isEmpty {
                Text("尚无进度说明").font(.system(size: 12)).foregroundStyle(.tertiary)
            } else {
                Text(run.summary).font(.system(size: 12)).textSelection(.enabled)
            }
        }
        Field("最近活动") {
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
        case "init": return "创建计划"
        case "task": return "更新子任务"
        case "update": return "更新计划"
        default: return action
        }
    }

    // MARK: - Task

    @ViewBuilder
    private func taskDetail(_ task: BoardTask) -> some View {
        let state = VisualState.of(task, in: graph)
        let conflicts = graph.blockedBy[task.id]?.resourceConflicts ?? []

        header(eyebrow: task.id, title: task.title) {
            Pill(symbol: state == .running ? nil : state.symbol, tint: state.tint, text: state.label)
            Pill(text: task.agent.isEmpty ? "未指派" : task.agent)
        }
        Field("进展") {
            if task.detail.isEmpty {
                Text("尚无记录").font(.system(size: 12)).foregroundStyle(.tertiary)
            } else {
                Text(task.detail).font(.system(size: 12)).textSelection(.enabled)
            }
        }
        Field("依赖") { Values(task.dependsOn) }
        Field("仍在等待") { Values(graph.waitingOn[task.id] ?? []) }
        Field("写入范围") { Values(task.writeScope) }
        Field("独占资源") { Values(task.exclusiveResource, warning: !conflicts.isEmpty) }
        if !conflicts.isEmpty {
            Field("资源冲突") {
                Values(conflicts.map { "\($0.taskID) · \($0.resources.joined(separator: " / "))" },
                       warning: true)
            }
        }
        Field("下游") { Values(graph.dependents[task.id] ?? []) }
    }

    // MARK: - Chrome

    @ViewBuilder
    private func header(
        eyebrow: String, title: String, @ViewBuilder pills: () -> some View
    ) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(eyebrow)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
            Text(title)
                .font(.system(size: 15, weight: .semibold))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 7) { pills() }.padding(.top, 6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 15)
        .padding(.top, 13)
        .padding(.bottom, 11)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color(nsColor: .separatorColor)).frame(height: Metrics.hairline)
        }
    }
}

private extension Run {
    var symbolForPill: String? { status == .running ? nil : status.symbol }
}

private struct Pill: View {
    var symbol: String?
    var tint: Color = .secondary
    let text: String

    var body: some View {
        HStack(spacing: 4) {
            if let symbol {
                Image(systemName: symbol).font(.system(size: 11)).foregroundStyle(tint)
            }
            Text(text).font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 2)
        .background(Color(nsColor: .quaternaryLabelColor).opacity(0.5),
                    in: RoundedRectangle(cornerRadius: Metrics.control - 1, style: .continuous))
    }
}

private struct Field<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.system(size: 11)).foregroundStyle(.secondary)
            content.frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 15)
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color(nsColor: .separatorColor)).frame(height: Metrics.hairline)
        }
    }
}

private struct Values: View {
    let items: [String]
    var warning = false

    init(_ items: [String], warning: Bool = false) {
        self.items = items
        self.warning = warning
    }

    var body: some View {
        if items.isEmpty {
            Text("—").font(.system(size: 12)).foregroundStyle(.tertiary)
        } else {
            FlowLayout(spacing: 4) {
                ForEach(items, id: \.self) { item in
                    Text(item)
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(warning ? Color.orange : Color.primary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(
                            warning ? Color.orange.opacity(0.12)
                                : Color(nsColor: .quaternaryLabelColor).opacity(0.5),
                            in: RoundedRectangle(cornerRadius: Metrics.chip, style: .continuous)
                        )
                        .textSelection(.enabled)
                }
            }
        }
    }
}

/// Wraps chips onto as many rows as they need; `HStack` would clip them and a `Grid`
/// would give every chip the widest one's width.
struct FlowLayout: Layout {
    var spacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: proposal.width ?? x, height: y + rowHeight)
    }

    func placeSubviews(
        in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
    ) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: .unspecified)
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
