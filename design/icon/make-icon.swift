// Draws the BossSDD application icon and writes design/icon/AppIcon.iconset.
//
// The motif is the board itself: one task feeding two that depend on it — a
// single node on the left joined by two curved edges to two nodes on the right.
// That is the smallest honest picture of a task DAG in topological layers,
// which is what this app shows.
//
// To re-run, from the repository root:
//
//     swift design/icon/make-icon.swift
//     iconutil -c icns design/icon/AppIcon.iconset -o Resources/AppIcon.icns
//
// Scripts/bundle.sh copies Resources/AppIcon.icns into the bundle; it does not
// run this file. Change a colour or a coordinate below, run both commands, and
// commit the regenerated Resources/AppIcon.icns along with the change.
//
// Every colour is a token from design/board-mock.html. The tile geometry
// (824pt artwork inset in a 1024pt canvas, ~22.5% continuous corner radius) was
// measured from the system icons on this machine, not taken from memory.

import AppKit
import SwiftUI

// MARK: - Tokens, all lifted from design/board-mock.html

/// `--accent` in the dark theme. Top of the tile gradient.
let accentDark = NSColor(srgbRed: 0x0A / 255, green: 0x84 / 255, blue: 0xFF / 255, alpha: 1)
/// `--accent` in the light theme. Bottom of the tile gradient.
let accentLight = NSColor(srgbRed: 0x00 / 255, green: 0x7A / 255, blue: 0xFF / 255, alpha: 1)
/// `--raised`, the colour of a task card on the board. The nodes and edges.
let raised = NSColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)
/// `--glass-edge`, the light catching the top lip of a surface.
let glassEdge = NSColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.7)
/// The colour of `--window-shadow`.
let shadowColor = NSColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.28)

// MARK: - Geometry, in a 1024-unit design space

let canvas: CGFloat = 1024
let tileInset: CGFloat = 100          // measured: opaque bbox is 100...923
let tileSide = canvas - 2 * tileInset // 824
let tileRadius = tileSide * 0.225     // 185.4, the system's continuous corner

let node: CGFloat = 210
let nodeRadius = node * 0.22          // same corner proportion as the tile
let sourceCenter = CGPoint(x: 320, y: 512)
let upperCenter = CGPoint(x: 700, y: 682)
let lowerCenter = CGPoint(x: 700, y: 342)
let edgeWidth: CGFloat = 54
/// The two edges leave the source at separated heights rather than a single
/// point. Sharing one tail made them merge into a solid wedge at 16pt, which is
/// the size that decides whether this icon works at all.
let tailSpread: CGFloat = 48

/// A rounded rect with Apple's continuous (squircle) corners, the shape every
/// system icon tile uses.
func squircle(_ rect: CGRect, _ radius: CGFloat) -> CGPath {
    Path(roundedRect: rect, cornerRadius: radius, style: .continuous).cgPath
}

/// One dependency edge, shaped like the connectors the board draws between
/// task cards: horizontal at both ends, easing through the middle.
func edge(from a: CGPoint, to b: CGPoint) -> CGPath {
    let p = CGMutablePath()
    let midX = (a.x + b.x) / 2
    p.move(to: a)
    p.addCurve(to: b, control1: CGPoint(x: midX, y: a.y), control2: CGPoint(x: midX, y: b.y))
    return p
}

func draw(into ctx: CGContext, pixels: CGFloat) {
    let s = pixels / canvas
    ctx.scaleBy(x: s, y: s)
    ctx.setShouldAntialias(true)

    let tileRect = CGRect(x: tileInset, y: tileInset, width: tileSide, height: tileSide)
    let tile = squircle(tileRect, tileRadius)

    // The soft shadow a macOS icon tile casts. It stays inside the 100-unit margin.
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -18), blur: 36, color: shadowColor.cgColor)
    ctx.addPath(tile)
    ctx.setFillColor(accentLight.cgColor)
    ctx.fillPath()
    ctx.restoreGState()

    ctx.saveGState()
    ctx.addPath(tile)
    ctx.clip()

    // Tile fill: the accent, dark value at the top easing to the light value at
    // the bottom. Both are real --accent tokens, one per theme.
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let fill = CGGradient(colorsSpace: space,
                          colors: [accentDark.cgColor, accentLight.cgColor] as CFArray,
                          locations: [0, 1])!
    ctx.drawLinearGradient(fill,
                           start: CGPoint(x: 0, y: tileRect.maxY),
                           end: CGPoint(x: 0, y: tileRect.minY),
                           options: [])

    // --glass-edge: the highlight along the top lip.
    let lip = CGGradient(colorsSpace: space,
                         colors: [glassEdge.withAlphaComponent(0.20).cgColor,
                                  glassEdge.withAlphaComponent(0).cgColor] as CFArray,
                         locations: [0, 1])!
    ctx.drawLinearGradient(lip,
                           start: CGPoint(x: 0, y: tileRect.maxY),
                           end: CGPoint(x: 0, y: tileRect.maxY - tileSide * 0.34),
                           options: [])
    ctx.restoreGState()

    // Edges first, so the nodes sit on top of them the way cards do on the board.
    ctx.saveGState()
    ctx.setStrokeColor(raised.cgColor)
    ctx.setLineWidth(edgeWidth)
    ctx.setLineCap(.round)
    let tailX = sourceCenter.x + node / 2
    for (target, spread) in [(upperCenter, tailSpread), (lowerCenter, -tailSpread)] {
        ctx.addPath(edge(from: CGPoint(x: tailX, y: sourceCenter.y + spread),
                         to: CGPoint(x: target.x - node / 2, y: target.y)))
    }
    ctx.strokePath()
    ctx.restoreGState()

    ctx.setFillColor(raised.cgColor)
    for c in [sourceCenter, upperCenter, lowerCenter] {
        let r = CGRect(x: c.x - node / 2, y: c.y - node / 2, width: node, height: node)
        ctx.addPath(squircle(r, nodeRadius))
    }
    ctx.fillPath()
}

func render(pixels: Int) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                               isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: pixels, height: pixels)
    let gc = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = gc
    draw(into: gc.cgContext, pixels: CGFloat(pixels))
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}

// MARK: - Write the iconset

// The member names iconutil expects; confirmed against a system .icns on this
// machine with `iconutil -c iconset`.
let members: [(String, Int)] = [
    ("icon_16x16", 16), ("icon_16x16@2x", 32),
    ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256),
    ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]

let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let out = here.appendingPathComponent("AppIcon.iconset")
try? FileManager.default.removeItem(at: out)
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

var cache: [Int: Data] = [:]
for (name, px) in members {
    let png = cache[px] ?? { let d = render(pixels: px); cache[px] = d; return d }()
    let url = out.appendingPathComponent("\(name).png")
    try png.write(to: url)
    print("wrote \(url.lastPathComponent) (\(px)x\(px), \(png.count) bytes)")
}
print("iconset: \(out.path)")
