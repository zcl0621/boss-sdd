import SwiftUI
import BoardKit

struct BoardWindow: View {
    @Bindable var model: BoardModel
    @State private var inspectorShown = true
    /// Which memory row is selected. Local to the window rather than on `BoardModel`:
    /// it is view state with no meaning outside the memory view, and a memory's key
    /// is only unique within one project, so a run change, a repository change or the
    /// entry's deletion clears it.
    @State private var selectedMemoryKey: String?

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
                .onChange(of: model.selectedRunID) { selectedMemoryKey = nil }
                .onChange(of: model.selectedProjectMemories) { old, new in
                    // The key is only meaningful inside one project's set. Drop it when the
                    // repository changes, and when the entry is gone, so a key deleted and
                    // later written again does not come back already selected.
                    guard let key = selectedMemoryKey else { return }
                    if old?.repository != new?.repository
                        || new?.memories.contains(where: { $0.key == key }) != true {
                        selectedMemoryKey = nil
                    }
                }
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
                    case .memory:
                        MemoryView(memories: model.selectedProjectMemories, selectedKey: $selectedMemoryKey)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                ScrollEdge()

                // The graph's problems are about scheduling, which the memory view has
                // no part in, so its banner stays out of that view.
                if model.view != .memory, !graph.valid {
                    GraphProblemBanner(errors: graph.errors)
                }
                if model.view == .memory {
                    if let memories = model.selectedProjectMemories {
                        MemoryTally(memories: memories)
                            .padding(.leading, 18)
                            .padding(.bottom, 14)
                    }
                } else {
                    FloatingTally(graph: graph, run: run)
                        .padding(.leading, 18)
                        .padding(.bottom, 14)
                }
            }
            .background(Palette.content)
        } else {
            ContentUnavailableView {
                Label(loc("board.noRunSelected"), systemImage: "square.grid.3x3")
            } description: {
                Text(model.loadError ?? loc("board.noRunSelected.detail"))
            }
        }
    }

    @ViewBuilder
    private var inspector: some View {
        if let run = model.selectedRun, let graph = model.graph {
            if model.view == .memory {
                MemoryInspector(
                    run: run, memories: model.selectedProjectMemories, selectedKey: selectedMemoryKey
                )
            } else {
                InspectorView(run: run, graph: graph, task: model.selectedTask)
            }
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

            Picker(loc("board.view"), selection: $model.view) {
                ForEach(BoardModel.BoardView.allCases) { view in
                    Text(view.label).tag(view)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 210)

            Button {
                inspectorShown.toggle()
            } label: {
                Label(loc("board.details"), systemImage: "sidebar.trailing")
            }
            .help(loc("board.details.help"))
        }
    }

    private var subtitle: String {
        guard let run = model.selectedRun, let graph = model.graph else { return "" }
        if model.view == .memory { return memorySubtitle }
        let done = run.tasks.count { $0.status == .done }
        let active = run.tasks.count { $0.status.isActive }
        return loc(
            "board.subtitle",
            run.project, done, run.tasks.count, active, graph.readyTaskIDs.count
        )
    }

    /// The memory store is the project's, so the subtitle names the repository and
    /// leaves out the run's own counters, which would read as if memory belonged to
    /// the run. A run whose project resolved to a different repository says so.
    private var memorySubtitle: String {
        guard let memories = model.selectedProjectMemories else { return loc("sidebar.noProject") }
        return loc(
            memories.differed ? "memory.subtitle.resolved" : "memory.subtitle",
            memories.repository, memories.memories.count, memoryLimit,
            loc("memory.kinds", memories.kindCount)
        )
    }
}

/// Rows scrolling past the floating cluster fade into the canvas instead of being
/// clipped mid-glyph behind it. Painted in the canvas colour, which is why it can only
/// exist now that the canvas has a stated colour to fade to.
private struct ScrollEdge: View {
    var body: some View {
        LinearGradient(
            stops: [
                .init(color: Palette.content, location: 0),
                .init(color: Palette.content, location: 0.18),
                .init(color: Palette.content.opacity(0), location: 1),
            ],
            startPoint: .bottom,
            endPoint: .top
        )
        .frame(height: 64)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .allowsHitTesting(false)
    }
}

/// Glass, because it floats above the content as a control cluster would.
private struct FloatingTally: View {
    let graph: GraphProjection
    let run: Run

    var body: some View {
        HStack(spacing: 10) {
            entry(state: .ready, text: loc("board.tally.ready", graph.readyTaskIDs.count))
            divider
            entry(state: .running,
                  text: loc("board.tally.active", run.tasks.count { $0.status.isActive }))
            divider
            Text(loc("board.tally.layers", graph.topologicalLayers.count))
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
            label(symbol: loc("server.badge.port", String(port)), tint: .orange,
                  help: loc("server.badge.port.help"))
        case .stopped:
            label(symbol: loc("server.badge.down"), tint: .orange,
                  help: loc("server.badge.down.help"))
        case .failed(let reason):
            label(symbol: reason, tint: .red, help: loc("server.badge.failed.help"))
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
            Label(loc("board.graphInvalid"), systemImage: "exclamationmark.triangle.fill")
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
