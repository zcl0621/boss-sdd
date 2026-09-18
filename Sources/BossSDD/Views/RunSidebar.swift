import SwiftUI
import BoardKit

/// The plan switcher. NavigationSplitView gives this column the system sidebar
/// material, so it picks up Liquid Glass without a custom effect.
struct RunSidebar: View {
    @Bindable var model: BoardModel

    var body: some View {
        List(selection: $model.selectedRunID) {
            Section("运行") {
                ForEach(model.runs) { run in
                    RunRow(run: run).tag(run.id)
                }
            }
        }
        .listStyle(.sidebar)
        .overlay {
            if model.runs.isEmpty {
                ContentUnavailableView {
                    Label("还没有运行记录", systemImage: "list.bullet.indent")
                } description: {
                    Text("agent 调用 POST /api/runs 后会出现在这里。")
                }
            }
        }
    }
}

private struct RunRow: View {
    let run: Run

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            RunStatusGlyph(status: run.status)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 1) {
                Text(run.title)
                    .font(.system(size: 13, weight: .medium))
                    .lineLimit(1)
                Text(shortPath(run.project.isEmpty ? "未指定项目" : run.project))
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text("\(doneCount) / \(run.tasks.count) 完成")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .padding(.top, 2)
            }
        }
        .padding(.vertical, 2)
    }

    private var doneCount: Int {
        run.tasks.count { $0.status == .done }
    }
}
