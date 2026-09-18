import SwiftUI
import BoardKit

/// A content-layer surface: opaque fill, hairline rim, no material and no accent rail.
struct TaskCard: View {
    static let height: CGFloat = 78

    let task: BoardTask
    let state: VisualState
    let waitingCount: Int
    let isSelected: Bool
    let isDimmed: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 5) {
                    StatusGlyph(state: state)
                    Text(task.id)
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(state.label)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .fixedSize()
                }
                Text(task.title)
                    .font(.system(size: 12))
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Spacer(minLength: 0)
                Text(subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(width: Metrics.cardWidth, height: Self.height, alignment: .topLeading)
            .background(Color(nsColor: .controlBackgroundColor), in: shape)
            .overlay {
                shape.strokeBorder(
                    isSelected ? Color.accentColor.opacity(0.7) : Color(nsColor: .separatorColor),
                    lineWidth: isSelected ? 1 : Metrics.hairline
                )
            }
            .overlay {
                if isSelected {
                    shape.strokeBorder(Color.accentColor.opacity(0.25), lineWidth: 2.5)
                        .padding(-1.5)
                }
            }
            .shadow(color: .black.opacity(0.05), radius: 0.75, y: 1)
        }
        .buttonStyle(.plain)
        .opacity(isDimmed ? 0.32 : 1)
        .accessibilityLabel(loc("card.accessibility", task.id, task.title, state.label))
    }

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: Metrics.card, style: .continuous)
    }

    private var subtitle: String {
        if !task.agent.isEmpty { return task.agent }
        if waitingCount > 0 { return loc("card.waiting", waitingCount) }
        return loc(state == .ready ? "card.dispatchable" : "card.unassigned")
    }
}
