#!/bin/bash
# Builds dist/卡片盒.app with only the Xcode Command Line Tools.
#   bash mac/build.sh            build
#   bash mac/build.sh --install  build and copy to /Applications
set -euo pipefail
cd "$(dirname "$0")/.."

APP="dist/卡片盒.app"
TMP="build"
rm -rf "$APP" "$TMP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$TMP"

echo "• 编译 Swift…"
FLAGS=(-O -framework Cocoa -framework WebKit -lsqlite3)
swiftc "${FLAGS[@]}" -target arm64-apple-macos12 mac/main.swift -o "$TMP/arm64"
if swiftc "${FLAGS[@]}" -target x86_64-apple-macos12 mac/main.swift -o "$TMP/x86_64" 2>/dev/null; then
  lipo -create "$TMP/arm64" "$TMP/x86_64" -output "$APP/Contents/MacOS/Zettelkasten"   # Apple 芯片 + Intel
else
  cp "$TMP/arm64" "$APP/Contents/MacOS/Zettelkasten"
fi

echo "• 打包资源…"
cp mac/Info.plist "$APP/Contents/Info.plist"
cp -R web "$APP/Contents/Resources/web"
find "$APP/Contents/Resources/web" -name '.DS_Store' -delete

ICONSET="$TMP/AppIcon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s mac/AppIcon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) mac/AppIcon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

echo "• 签名（本机 ad-hoc）…"
codesign --force --sign - "$APP"
rm -rf "$TMP"
echo "✓ 已生成 $APP"

if [[ "${1:-}" == "--install" ]]; then
  pkill -x Zettelkasten 2>/dev/null && sleep 1 || true
  rm -rf "/Applications/卡片盒.app"
  cp -R "$APP" /Applications/
  echo "✓ 已安装到 /Applications/卡片盒.app"
fi
