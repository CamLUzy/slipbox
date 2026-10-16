#!/bin/bash
# The one-minute product video: dist/slipbox-intro.mp4 (1920×1080, 30 fps, with music).
# Needs ffmpeg (brew install ffmpeg), Python 3 with numpy and scipy, and the Xcode Command Line Tools.
#   bash scripts/promo/make.sh            record the whole video
#   bash scripts/promo/make.sh 12 30.5    only still frames at these seconds (build/stills/)
# The scenes are scripts/promo/index.html (open it with ?play in a browser to preview);
# scripts/promo/assets/graph.png comes from scripts/screenshots.sh (scripts/shots/promo-graph.js).
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p build dist
swiftc -O scripts/promo/record.swift -o build/record -framework Cocoa -framework WebKit
if [ $# -gt 0 ]; then
  build/record --page scripts/promo/index.html --stills "$(IFS=,; echo "$*")" --out build/stills
  exit
fi
python3 scripts/promo/music.py build/music.wav
build/record --page scripts/promo/index.html --audio build/music.wav --out dist/slipbox-intro.mp4
