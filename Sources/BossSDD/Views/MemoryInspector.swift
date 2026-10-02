import SwiftUI
import BoardKit

/// The inspector for the memory view. With nothing selected it describes the store
/// (how full, what kinds, why it has no search); with an entry selected it shows that
/// entry whole, because a row clips the value to two lines and the source to one.
struct MemoryInspector: View {
    /// Same fixed-format reasoning as `InspectorView.clock`: a locale's own short
    /// date would change the pill's width.
    static let stamp: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "MM-dd HH:mm"
        return formatter
    }()

    let run: Run
    let memories: ProjectMemories?
    let selectedKey: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let memories {
                    if let entry = memories.memories.first(where: { $0.key == selectedKey }) {
                        detail(entry, in: memories)
                    } else {
                        overview(memories)
                    }
                } else {
                    InspectorHeader(eyebrow: loc("sidebar.noProject"), title: loc("memory.overview.title")) {}
                    InspectorField(loc("memory.field.hint")) {
                        Text(loc("memory.noProject.detail")).font(.system(size: 12)).foregroundStyle(.tertiary)
                    }
                }
            }
        }
        .background(Color(nsColor: .controlBackgroundColor))
    }

    @ViewBuilder
    private func overview(_ memories: ProjectMemories) -> some View {
        InspectorHeader(eyebrow: shortPath(memories.repository), title: loc("memory.overview.title")) {
            InspectorPill(tint: memories.isNearLimit ? .orange : .secondary,
                 text: loc("memory.cap.pill", memories.memories.count, memoryLimit))
            InspectorPill(text: loc("memory.kinds", memories.kindCount))
        }
        InspectorField(loc("memory.field.distribution")) {
            InspectorValues(memories.groups.map { "\($0.kind.rawValue) \($0.items.count)" })
        }
        InspectorField(loc("memory.field.limit")) {
            Text(loc("memory.limit.body", memoryLimit)).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
        }
        InspectorField(loc("memory.field.noSearch")) {
            Text(loc("memory.noSearch.body")).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
        }
        InspectorField(loc("memory.field.hint")) {
            Text(loc("memory.hint.body")).font(.system(size: 12)).foregroundStyle(.tertiary)
        }
    }

    @ViewBuilder
    private func detail(_ entry: Memory, in memories: ProjectMemories) -> some View {
        InspectorHeader(eyebrow: entry.key, title: entry.kind.label) {
            InspectorPill(text: entry.kind.rawValue)
            InspectorPill(text: loc("memory.updated", Self.stamp.string(from: entry.updatedAt)))
        }
        InspectorField(loc("memory.field.value")) {
            Text(entry.value).font(.system(size: 12)).textSelection(.enabled)
        }
        InspectorField(loc("memory.field.source")) { Block(entry.source) }
        InspectorField(loc("memory.field.key")) {
            VStack(alignment: .leading, spacing: 6) {
                Block(entry.key)
                Text(loc("memory.key.note")).font(.system(size: 12)).foregroundStyle(.tertiary)
            }
        }
        InspectorField(loc("memory.field.scope")) {
            VStack(alignment: .leading, spacing: 6) {
                Text(memories.repository).font(.system(size: 12)).textSelection(.enabled)
                if memories.differed {
                    // `Run.project`, not `ProjectMemories.runProject`: the latter is the
                    // canonical spelling, and this line is about what the run recorded.
                    Text(loc("memory.scope.resolved", shortPath(run.project, keeping: 3)))
                        .font(.system(size: 12)).foregroundStyle(.tertiary)
                }
            }
        }
    }
}

/// A verbatim string — a source or a key — set apart so it can be copied and checked.
private struct Block: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.system(size: 11, design: .monospaced))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 9)
            .padding(.vertical, 7)
            .background(
                Color(nsColor: .quaternaryLabelColor).opacity(0.5),
                in: RoundedRectangle(cornerRadius: Metrics.chip, style: .continuous)
            )
    }
}
