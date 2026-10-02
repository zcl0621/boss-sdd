import SwiftUI
import BoardKit

// Shared chrome for the two inspectors (run/task and memory). Kept out of
// `InspectorView.swift` so neither consumer owns what both use. The `Inspector`
// prefix keeps these module-scope names from claiming generic nouns like `Field`.

/// The top of an inspector page: a mono eyebrow, a title and a row of pills over a
/// hairline. Shared with the memory inspector so the two read as one pane.
struct InspectorHeader<Pills: View>: View {
    let eyebrow: String
    let title: String
    @ViewBuilder let pills: Pills

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(eyebrow)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
            Text(title)
                .font(.system(size: 15, weight: .semibold))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            // A page with no pills passes `EmptyView`; without this the empty row would
            // still contribute its top padding and the stack spacing as dead space.
            if Pills.self != EmptyView.self {
                HStack(spacing: 7) { pills }.padding(.top, 6)
            }
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

struct InspectorPill: View {
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

struct InspectorField<Content: View>: View {
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

struct InspectorValues: View {
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
