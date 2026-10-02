import SwiftUI
import BoardKit

/// The selected run's project memories, grouped by kind. A list rather than cards:
/// an entry is a claim about the project, and `source` is what lets someone disprove
/// it with one file read, so source is a line of the row rather than a footnote. The
/// kind is carried by the group header, so a row never repeats it.
///
/// Read-only by design: memories are written over HTTP and this only renders them.
struct MemoryView: View {
    /// Nil when the run has no project, which is a state of its own rather than an
    /// empty store: there is no repository whose memories could be listed.
    let memories: ProjectMemories?
    @Binding var selectedKey: String?

    var body: some View {
        if let memories {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    MemoryNote()
                    if memories.memories.isEmpty {
                        Text(loc("memory.empty"))
                            .font(.system(size: 11))
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 2)
                    }
                    ForEach(memories.groups, id: \.kind) { kind, items in
                        MemoryGroup(kind: kind, items: items, selectedKey: $selectedKey)
                    }
                }
                .frame(maxWidth: 720, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 18)
                .padding(.top, 14)
                .padding(.bottom, 62)
            }
        } else {
            ContentUnavailableView {
                Label(loc("sidebar.noProject"), systemImage: "tray")
            } description: {
                Text(loc("memory.noProject.detail"))
            }
        }
    }
}

// MARK: - Derived from ProjectMemories

extension ProjectMemories {
    /// Non-empty kinds only, in `MemoryKind.allCases` order, which is the order the
    /// pane shows them in. Within a kind the store's own order (by key) is kept.
    var groups: [(kind: MemoryKind, items: [Memory])] {
        MemoryKind.allCases.compactMap { kind in
            let items = memories.filter { $0.kind == kind }
            return items.isEmpty ? nil : (kind, items)
        }
    }

    var kindCount: Int { groups.count }

    /// Where the count turns orange. At `memoryLimit` a new key is refused outright,
    /// so the warning has to come early enough to act on.
    var isNearLimit: Bool { memories.count >= memoryLimit * 4 / 5 }
}

extension MemoryKind {
    var label: String {
        switch self {
        case .gate: return loc("memory.kind.gate")
        case .runRecipe: return loc("memory.kind.runRecipe")
        case .convention: return loc("memory.kind.convention")
        case .hardRule: return loc("memory.kind.hardRule")
        case .exclusiveResource: return loc("memory.kind.exclusiveResource")
        case .note: return loc("memory.kind.note")
        }
    }
}

// MARK: - Pieces

/// Says whose memory this is. A run is not the owner, and without this line the pane
/// reads as if starting a new run would start from nothing.
private struct MemoryNote: View {
    /// One sentence-complete string per language, with `**…**` marking what to
    /// emphasise, so a translation controls its own order, spacing and emphasis. The
    /// emphasised runs also take the primary label colour, as the mock's `<b>` does.
    static var note: AttributedString {
        let raw = loc("memory.note")
        guard var text = try? AttributedString(markdown: raw) else { return AttributedString(raw) }
        let strong = text.runs
            .filter { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true }
            .map(\.range)
        for range in strong { text[range].foregroundColor = .primary }
        return text
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "doc.text")
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
            Text(Self.note)
                .font(.system(size: 11.5))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 11)
        .padding(.vertical, 9)
        .background(
            Color(nsColor: .quaternaryLabelColor).opacity(0.5),
            in: RoundedRectangle(cornerRadius: Metrics.card, style: .continuous)
        )
    }
}

/// Header in the shape of a `StatusColumnsView` column header: name, then the
/// stored spelling agents use for the kind, then a two-digit count.
private struct MemoryGroup: View {
    let kind: MemoryKind
    let items: [Memory]
    @Binding var selectedKey: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text(kind.label).font(.system(size: 11, weight: .semibold))
                Text(kind.rawValue)
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(.tertiary)
                Spacer(minLength: 4)
                Text(String(format: "%02d", items.count))
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

            ForEach(Array(items.enumerated()), id: \.element.key) { index, memory in
                MemoryRow(
                    memory: memory,
                    isSelected: selectedKey == memory.key,
                    showsSeparator: index < items.count - 1
                ) {
                    selectedKey = selectedKey == memory.key ? nil : memory.key
                }
            }
        }
    }
}

private struct MemoryRow: View {
    let memory: Memory
    let isSelected: Bool
    let showsSeparator: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 2) {
                Text(memory.key)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(isSelected ? AnyShapeStyle(.white) : AnyShapeStyle(.secondary))
                    .lineLimit(1)
                Text(memory.value)
                    .font(.system(size: 12))
                    .foregroundStyle(valueStyle)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                HStack(spacing: 4) {
                    Image(systemName: "doc.text").font(.system(size: 10.5)).opacity(0.7)
                    Text(memory.source).lineLimit(1)
                }
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(isSelected ? AnyShapeStyle(.white.opacity(0.72)) : AnyShapeStyle(.secondary))
                .padding(.top, 3)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 9)
            .padding(.vertical, 8)
            .background(background, in: RoundedRectangle(cornerRadius: Metrics.control, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .overlay(alignment: .bottom) {
            if showsSeparator && !isSelected {
                Rectangle()
                    .fill(Color(nsColor: .separatorColor))
                    .frame(height: Metrics.hairline)
            }
        }
    }

    private var valueStyle: AnyShapeStyle {
        if isSelected { return AnyShapeStyle(.white) }
        return memory.kind == .note ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary)
    }

    private var background: Color {
        if isSelected { return .accentColor }
        return hovering ? Color(nsColor: .quaternaryLabelColor).opacity(0.5) : .clear
    }
}

/// The memory view's counterpart to the floating tally the other two views carry:
/// the same glass cluster, saying what this view guarantees and how full the store is.
struct MemoryTally: View {
    let memories: ProjectMemories

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 5) {
                Image(systemName: "doc.text").font(.system(size: 11)).foregroundStyle(.secondary)
                Text(loc("memory.tally.source")).font(.system(size: 11)).foregroundStyle(.secondary)
            }
            divider
            Text(loc("memory.cap", memories.memories.count, memoryLimit))
                .font(.system(size: 11))
                .foregroundStyle(memories.isNearLimit ? Color.orange : Color.secondary)
                .monospacedDigit()
            divider
            Text(loc("memory.tally.grouped")).font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 6)
        .floatingControl()
    }

    private var divider: some View {
        Rectangle().fill(Color(nsColor: .separatorColor)).frame(width: Metrics.hairline, height: 14)
    }
}
