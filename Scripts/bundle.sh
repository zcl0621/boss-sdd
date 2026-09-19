#!/bin/bash
# Assembles BossSDD.app from the SwiftPM executable.
#   ./Scripts/bundle.sh            build into .build/BossSDD.app
#   ./Scripts/bundle.sh --install  also replace /Applications/BossSDD.app
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/.build/BossSDD.app"
# Read out of BoardKit rather than kept as a second literal here. The bundle's
# CFBundleShortVersionString and the version /api/health reports have to be the
# same number — the MCP server holds a floor against that number to catch a
# stale installed app — and two hand-maintained copies agree only by luck.
# Scripts/verify.sh reads the same declaration the same way.
VERSION="$(awk -F'"' '/^public let boardKitVersion/{print $2}' "$ROOT/Sources/BoardKit/HTTPServer.swift")"
[[ -n "$VERSION" ]] || { echo "bundle.sh: no boardKitVersion in Sources/BoardKit/HTTPServer.swift" >&2; exit 1; }

cd "$ROOT"
swift build -c release --product BossSDD

# Apple silicon only, by design — this is a single-machine tool.
( cd "$ROOT/mcp" && GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags "-s -w" -o "$ROOT/.build/plan-sdd-mcp" . )

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ROOT/.build/release/BossSDD" "$APP/Contents/MacOS/BossSDD"
# The MCP server ships inside the bundle so installing the app installs the agent
# interface too; the skill points at this path.
cp "$ROOT/.build/plan-sdd-mcp" "$APP/Contents/Resources/plan-sdd-mcp"

# Interface strings. They go straight into Contents/Resources rather than through a
# SwiftPM resource rule, because that is the only place Bundle.main looks — and
# Bundle.main is what Sources/BossSDD/Localization.swift asks. A SwiftPM rule would
# put them in Bundle.module instead, which this hand-assembled bundle does not have,
# and the app would run untranslated while `swift build` still looked fine.
cp -R "$ROOT/Resources/"*.lproj "$APP/Contents/Resources/"

# The application icon. It is a committed artifact, not built here: design/icon/
# holds the generator that draws it and the iconutil command that packs it, and
# both are run by hand when the artwork changes. A build must not depend on
# compiling and running a drawing program.
cp "$ROOT/Resources/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Plan SDD</string>
  <key>CFBundleDisplayName</key><string>Plan SDD</string>
  <key>CFBundleExecutable</key><string>BossSDD</string>
  <key>CFBundleIdentifier</key><string>com.zhang.boss-sdd</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <!-- The Dock tile, and what Finder, Spotlight, "Open with" and Login Items show. -->
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <!-- English is the base language; Chinese is a translation of it. A launch can
       pick either without touching any system setting:
         .../BossSDD.app/Contents/MacOS/BossSDD -AppleLanguages '(en)' -->
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleLocalizations</key>
  <array><string>en</string><string>zh-Hans</string></array>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <!-- Deliberately NOT LSUIElement, though this is a menu bar app and that key is
       the obvious fit. It was set, and the menu bar item was then the only way to
       reach the window. macOS hides that item whenever the menu bar runs out of
       room — a crowded bar, or the notch on a built-in display — and a window that
       had been closed could not be reopened at all: nothing else calls show().
       A Dock tile and a Cmd+Tab entry cost one Dock slot and cannot be hidden. -->
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticTermination</key><false/>
  <key>NSSupportsSuddenTermination</key><false/>
</dict>
</plist>
PLIST

# Ad-hoc signature. Enough for local use and for SMAppService to register a login item;
# distribution would need a Developer ID and notarisation.
codesign --force --sign - --identifier com.zhang.boss-sdd "$APP" >/dev/null 2>&1

echo "built $APP"

if [[ "${1:-}" == "--install" ]]; then
  pkill -x BossSDD 2>/dev/null || true
  rm -rf /Applications/BossSDD.app
  cp -R "$APP" /Applications/BossSDD.app
  echo "installed /Applications/BossSDD.app"
fi
