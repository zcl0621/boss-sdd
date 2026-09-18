import SwiftUI
import BoardKit

/// Deterministic layer layout: cards are a fixed size, so every node's frame is known
/// from its column and row alone. Edges are drawn from those frames — no geometry
/// readers, no second layout pass.
struct GraphLayout {
    let frames: [String: CGRect]
    let size: CGSize
    let labels: [(text: String, point: CGPoint)]

    static let labelHeight: CGFloat = 20

    init(layers: [[String]]) {
        var frames: [String: CGRect] = [:]
        var labels: [(String, CGPoint)] = []
        var widest: CGFloat = 0
        var tallest: CGFloat = 0

        for (column, ids) in layers.enumerated() {
            let x = CGFloat(column) * (Metrics.cardWidth + Metrics.layerSpacing)
            labels.append(("第 \(column + 1) 层 · \(ids.count) 个可并行", CGPoint(x: x, y: 0)))
            for (row, id) in ids.enumerated() {
                let y = Self.labelHeight + CGFloat(row) * (TaskCard.height + Metrics.rowSpacing)
                frames[id] = CGRect(x: x, y: y, width: Metrics.cardWidth, height: TaskCard.height)
                tallest = max(tallest, y + TaskCard.height)
            }
            widest = max(widest, x + Metrics.cardWidth)
        }
        self.frames = frames
        self.labels = labels
        self.size = CGSize(width: widest, height: max(tallest, Self.labelHeight))
    }
}

struct GraphView: View {
    let run: Run
    let graph: GraphProjection
    @Binding var selectedTaskID: String?

    var body: some View {
        let layout = GraphLayout(layers: layers)
        let kin = relatives(of: selectedTaskID)

        ScrollView([.horizontal, .vertical]) {
            ZStack(alignment: .topLeading) {
                Canvas { context, _ in
                    for (child, parents) in graph.dependencies {
                        for parent in parents {
                            guard let from = layout.frames[parent], let to = layout.frames[child] else { continue }
                            let lit = selectedTaskID == parent || selectedTaskID == child
                            var path = Path()
                            let start = CGPoint(x: from.maxX, y: from.midY)
                            let end = CGPoint(x: to.minX, y: to.midY)
                            let mid = (start.x + end.x) / 2
                            path.move(to: start)
                            path.addCurve(
                                to: end,
                                control1: CGPoint(x: mid, y: start.y),
                                control2: CGPoint(x: mid, y: end.y)
                            )
                            context.stroke(
                                path,
                                with: .color(lit ? .accentColor : Color(nsColor: .tertiaryLabelColor)
                                    .opacity(selectedTaskID == nil || lit ? 1 : 0.3)),
                                lineWidth: lit ? 1.75 : 1
                            )
                        }
                    }
                }
                .frame(width: layout.size.width, height: layout.size.height)

                ForEach(layout.labels.indices, id: \.self) { index in
                    Text(layout.labels[index].text)
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                        .fixedSize()
                        .offset(x: layout.labels[index].point.x + 2, y: 1)
                }

                ForEach(run.tasks) { task in
                    if let frame = layout.frames[task.id] {
                        TaskCard(
                            task: task,
                            state: VisualState.of(task, in: graph),
                            waitingCount: graph.waitingOn[task.id]?.count ?? 0,
                            isSelected: selectedTaskID == task.id,
                            isDimmed: selectedTaskID != nil
                                && selectedTaskID != task.id
                                && !kin.contains(task.id)
                        ) {
                            selectedTaskID = selectedTaskID == task.id ? nil : task.id
                        }
                        .offset(x: frame.minX, y: frame.minY)
                    }
                }
            }
            .frame(width: layout.size.width, height: layout.size.height, alignment: .topLeading)
            .padding(.horizontal, 18)
            .padding(.top, 14)
            .padding(.bottom, 62)
        }
    }

    /// Tasks left out of the projection's layers (only possible on a cyclic graph)
    /// still get a column of their own, so nothing silently disappears from the board.
    private var layers: [[String]] {
        var placed = Set(graph.topologicalLayers.flatMap { $0 })
        var layers = graph.topologicalLayers
        let orphans = run.tasks.map(\.id).filter { !placed.contains($0) }
        if !orphans.isEmpty {
            layers.append(orphans)
            placed.formUnion(orphans)
        }
        return layers
    }

    private func relatives(of id: String?) -> Set<String> {
        guard let id else { return [] }
        var seen: Set<String> = []
        func walk(_ current: String, _ edges: [String: [String]]) {
            for next in edges[current] ?? [] where !seen.contains(next) {
                seen.insert(next)
                walk(next, edges)
            }
        }
        walk(id, graph.dependencies)
        walk(id, graph.dependents)
        return seen
    }
}
