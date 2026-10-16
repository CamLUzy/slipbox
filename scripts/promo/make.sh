#!/bin/bash
# The one-minute product video: dist/slipbox-intro.mp4 (1920×1080, 30 fps, music and narration).
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
AUDIO=build/music.wav
# Narration (optional): a local Kokoro model in its own Python 3.12 environment, created once with
#   conda create -p build/tts-env python=3.12 && build/tts-env/bin/pip install "kokoro>=0.9.4" "misaki[zh,en]>=0.9.4" soundfile scipy
# VOICE picks the speaker (default zm_033, a calm male voice).
if [ -x build/tts-env/bin/python ]; then
  build/tts-env/bin/python scripts/promo/voice.py build/voice.wav "${VOICE:-zm_033}"
  python3 scripts/promo/mix.py build/music.wav build/voice.wav build/mix.wav
  AUDIO=build/mix.wav
fi
build/record --page scripts/promo/index.html --audio "$AUDIO" --out dist/slipbox-intro.mp4
