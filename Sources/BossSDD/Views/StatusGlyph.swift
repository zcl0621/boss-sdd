import SwiftUI
import BoardKit

/// Status as a shape first. Work in flight gets the real indeterminate indicator
/// rather than a symbol pretending to spin.
struct StatusGlyph: View {
    let state: VisualState
    var size: CGFloat = 13

    var body: some View {
        if state == .running {
            ProgressView()
                .controlSize(.small)
                .scaleEffect(size / 16)
                .frame(width: size, height: size)
        } else {
            Image(systemName: state.symbol)
                .font(.system(size: size))
                .foregroundStyle(state.tint)
                .frame(width: size, height: size)
        }
    }
}

struct RunStatusGlyph: View {
    let status: RunStatus
    var size: CGFloat = 13

    var body: some View {
        if status == .running {
            ProgressView()
                .controlSize(.small)
                .scaleEffect(size / 16)
                .frame(width: size, height: size)
        } else {
            Image(systemName: status.symbol)
                .font(.system(size: size))
                .foregroundStyle(status.tint)
                .frame(width: size, height: size)
        }
    }
}
