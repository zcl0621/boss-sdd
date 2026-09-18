import SwiftUI
import BoardKit

struct StatusColumnsView: View {
    let run: Run
    let graph: GraphProjection
    @Binding var selectedTaskID: String?

    private static let columns: [(status: TaskStatus, key: String)] = [
        (.pending, "columns.pending"), (.running, "columns.running"),
        (.review, "columns.review"), (.blocked, "columns.blocked"),
        (.done, "columns.done"),
    ]

    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            HStack(alignment: .top, spacing: 14) {
                ForEach(Self.columns, id: \.status) { status, key in
                    let tasks = run.tasks.filter { $0.status == status }
                    VStack(alignment: .leading, spacing: 9) {
                        HStack(spacing: 6) {
                            StatusGlyph(state: VisualState.of(
                                BoardTask(id: "_", title: "", status: status), in: graph
                            ))
                            Text(loc(key)).font(.system(size: 11, weight: .semibold))
                            Spacer(minLength: 4)
                            Text(String(format: "%02d", tasks.count))
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                        }
                        .padding(.horizontal, 2)
                        .padding(.bottom, 7)
                        .overlay(alignment: .bottom) {
                            Rectangle()
                                .fill(Color(nsColor: .separatorColor))
                                .frame(height: Metrics.hairline)
                        }

                        if tasks.isEmpty {
                            Text(loc("columns.empty")).font(.system(size: 11)).foregroundStyle(.tertiary)
                                .padding(.horizontal, 2)
                        }
                        ForEach(tasks) { task in
                            TaskCard(
                                task: task,
                                state: VisualState.of(task, in: graph),
                                waitingCount: graph.waitingOn[task.id]?.count ?? 0,
                                isSelected: selectedTaskID == task.id,
                                isDimmed: false
                            ) {
                                selectedTaskID = selectedTaskID == task.id ? nil : task.id
                            }
                        }
                    }
                    .frame(width: Metrics.cardWidth)
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 14)
            .padding(.bottom, 62)
        }
    }
}
