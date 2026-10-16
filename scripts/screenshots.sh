#!/bin/bash
# Regenerates the README screenshots in assets/screenshots/ from the demo slip box
# (docs/demo/demo-box.json). The AI shots call the local Ollama model for real.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build assets/screenshots
swiftc -O scripts/snap.swift -o build/snap -framework Cocoa -framework WebKit
PORT=8791
(cd web && python3 -m http.server $PORT >/dev/null 2>&1) & SERVER=$!
trap 'kill $SERVER' EXIT
sleep 1

{ printf 'const DATA = '; cat docs/demo/demo-box.json; printf ';\n'; cat scripts/shots/_bridge.js; } > build/inject.js

shot() { # name theme script wait-for [width height]; INJECT=1 mocks the native shell (scripts/shots/_bridge.js)
  { printf 'const THEME = "%s";\n' "$2"; cat scripts/shots/_setup.js; } > build/setup.js
  { printf 'const DATA = '; cat docs/demo/demo-box.json; printf ';\n'; cat scripts/shots/_import.js "scripts/shots/$3"; } > build/script.js
  build/snap --url "http://localhost:$PORT/" --out "${OUT:-assets/screenshots/$1.png}" --width "${5:-1280}" --height "${6:-800}" \
    --setup build/setup.js --script build/script.js --wait-for "$4" ${INJECT:+--inject build/inject.js}
}

shot card light card.js "document.querySelector('.sheet-head')"
shot organize light organize.js "document.querySelector('.ai-result')"
shot map dark map.js "(() => { const svg = document.querySelector('#map-box svg.graph'); const n = svg && [...svg.querySelectorAll('.g-node')].find((g) => g.querySelector('.g-id')?.textContent === '3'); if (!n) return false; svg.classList.add('g-focus'); n.classList.add('hl', 'hl-center'); for (const l of svg.querySelectorAll('.g-edge')) if (l.dataset.a === n.dataset.uid || l.dataset.b === n.dataset.uid) { l.classList.add('hl'); svg.querySelector('.g-node[data-uid=\"' + (l.dataset.a === n.dataset.uid ? l.dataset.b : l.dataset.a) + '\"]')?.classList.add('hl'); } return true; })()"
shot chat light chat.js "document.querySelector('.msg.bot .msg-tools')"
shot stats light stats.js "document.querySelector('.milestones')" 1280 900
OUT=scripts/promo/assets/graph.png shot promo-graph dark promo-graph.js "document.querySelector('.modal svg .hl-center')"   # for the product video
INJECT=1 shot sync light sync.js "document.querySelector('.sync-result') && !document.querySelector('.toast')"
curl -s localhost:11434/api/generate -d '{"model":"qwen3.5:4b","keep_alive":0}' >/dev/null || true
