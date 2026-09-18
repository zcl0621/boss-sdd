import SwiftUI
import BoardKit

struct BoardWindow: View {
    @Bindable var model: BoardModel
    @State private var inspectorShown = true

    var body: some View {
        NavigationSplitView {
            RunSidebar(model: model)
                .navigationSplitViewColumnWidth(min: 200, ideal: 225, max: 300)
        } detail: {
            content
                .navigationTitle(model.selectedRun?.title ?? "Plan SDD")
                .navigationSubtitle(subtitle)
                .inspector(isPresented: $inspectorShown) {
                    inspector.inspectorColumnWidth(min: 260, ideal: 300, max: 420)
                }
                .toolbar { toolbar }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let run = model.selectedRun, let graph = model.graph {
            ZStack(alignment: .bottomLeading) {
                Group {
                    switch model.view {
                    case .graph:
                        GraphView(run: run, graph: graph, selectedTaskID: $model.selectedTaskID)
                    case .columns:
                        StatusColumnsView(run: run, graph: graph, selectedTaskID: $model.selectedTaskID)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                if !graph.valid {
                    GraphProblemBanner(errors: graph.errors)
                }
                FloatingTally(graph: graph, run: run)
                    .padding(.leading, 18)
                    .padding(.bottom, 14)
            }
            .background(Color(nsColor: .underPageBackgroundColor))
        } else {
            ContentUnavailableView {
                Label("没有选中的运行", systemImage: "square.grid.3x3")
            } description: {
                Text(model.loadError ?? "左侧选一个运行，或让 agent 建一个。")
            }
        }
    }

    @ViewBuilder
    private var inspector: some View {
        if let run = model.selectedRun, let graph = model.graph {
            InspectorView(run: run, graph: graph, task: model.selectedTask)
        } else {
            Color(nsColor: .controlBackgroundColor)
        }
    }

    /// Everything sits in the trailing group, the way Finder and Mail place a view
    /// switcher and an inspector toggle. `.principal` centres on the whole window,
    /// which reads as misaligned once the sidebar takes a third of the width.
    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            ServerBadge(state: model.serverState)

            Picker("视图", selection: $model.view) {
                ForEach(BoardModel.BoardView.allCases) { view in
                    Text(view.label).tag(view)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 150)

            Button {
                inspectorShown.toggle()
            } label: {
                Label("详情", systemImage: "sidebar.trailing")
            }
            .help("显示或隐藏详情栏")
        }
    }

    private var subtitle: String {
        guard let run = model.selectedRun, let graph = model.graph else { return "" }
        let done = run.tasks.count { $0.status == .done }
        let active = run.tasks.count { $0.status.isActive }
        return "\(run.project) · 完成 \(done)/\(run.tasks.count) · 活动 \(active) · 就绪 \(graph.readyTaskIDs.count)"
    }
}

/// Glass, because it floats above the content as a control cluster would.
private struct FloatingTally: View {
    let graph: GraphProjection
    let run: Run

    var body: some View {
        HStack(spacing: 10) {
            entry(state: .ready, text: "就绪 \(graph.readyTaskIDs.count)")
            divider
            entry(state: .running, text: "活动 \(run.tasks.count { $0.status.isActive })")
            divider
            Text("\(graph.topologicalLayers.count) 个并行层")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 6)
        .floatingControl()
    }

    private func entry(state: VisualState, text: String) -> some View {
        HStack(spacing: 5) {
            StatusGlyph(state: state, size: 12)
            Text(text).font(.system(size: 11)).foregroundStyle(.secondary).monospacedDigit()
        }
    }

    private var divider: some View {
        Rectangle().fill(Color(nsColor: .separatorColor)).frame(width: Metrics.hairline, height: 14)
    }
}

/// The address is a constant, so a healthy server earns no chrome — the menu bar
/// icon already carries that. This appears only when something is worth saying:
/// the server is down, or it is not on the port the skill expects.
private struct ServerBadge: View {
    let state: ServerState

    var body: some View {
        switch state {
        case .listening(let port) where port == defaultBoardPort:
            EmptyView()
        case .listening(let port):
            label(symbol: "网口 \(port)", tint: .orange,
                  help: "写入接口不在默认端口，调用方需要指定端口")
        case .stopped:
            label(symbol: "接口未启动", tint: .orange, help: "agent 现在无法写入看板")
        case .failed(let reason):
            label(symbol: reason, tint: .red, help: "写入接口启动失败")
        }
    }

    private func label(symbol: String, tint: Color, help: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 11))
                .foregroundStyle(tint)
            Text(symbol).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
        }
        .help(help)
    }
}

/// The projection refuses to schedule on a broken graph, so the board says why
/// rather than showing an empty ready queue.
private struct GraphProblemBanner: View {
    let errors: [GraphError]

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Label("依赖图无效，调度已停用", systemImage: "exclamationmark.triangle.fill")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.orange)
            ForEach(errors.prefix(4), id: \.message) { error in
                Text(error.message)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .floatingControl()
        .padding(.leading, 18)
        .padding(.bottom, 60)
    }
}
