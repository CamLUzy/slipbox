<div align="center">

<img src="assets/banner.png" alt="Slipbox" width="720">

**A Luhmann-style slip box that you actually own.**

Permanent card IDs, links and backlinks, a keyword register, relation graphs and a local AI,<br>
on Windows, macOS and iPhone / iPad, with every card kept on your own devices.

[Download](https://github.com/CamLUzy/slipbox/releases/latest) · [中文说明](README.md) · [Changelog](CHANGELOG.md) · [Roadmap](ROADMAP.md)

</div>

> The app itself is in Chinese; this page is a short English summary.

## What it is

Niklas Luhmann wrote more than seventy books with a wooden box of index cards. Every card had a
fixed address (`1`, `1a`, `1a1` …), cards pointed to each other with reasons, and a thin keyword
register gave entry points into trains of thought. Slipbox brings exactly that to the desktop:

- Fleeting notes, literature cards and permanent cards; *continue* and *branch* compute the next
  free Folgezettel ID; renumbering moves a whole branch and rewrites every link to it.
- `[[1a2]]` links and `[[@citekey]]` citations with autocomplete, backlinks on every card, a
  keyword register, an ID tree, random walks, full-text search and several slip boxes.
- Relation graphs with hover highlighting, and an optional local AI through
  [Ollama](https://ollama.com) (`qwen3.5:4b` by default) that suggests how to turn a note into a
  permanent card, how cards relate, and answers questions citing your cards. The model is only
  loaded when you click an AI button, and the app only talks to Ollama on `localhost`. Without
  Ollama, the app installs it (and the model) in one click on macOS and Windows; on macOS / iOS 26
  with Apple Intelligence it can use Apple's on-device model instead, with nothing to install.
- LAN sync between any two devices (Windows, Mac, iPhone): open *设备与同步* on both, tap *同步* on
  one and the other acts as host. Direct, end-to-end encrypted (Noise XX), paired once by comparing
  a 6-digit code; edits on both sides keep the newer version and file the older one as a conflict
  copy. See [docs/SYNC.md](docs/SYNC.md).
- A writing log like GitHub's contribution graph (one square per day), streaks, milestones and
  "on this day" cards from a week, a month and a year ago.
- One SQLite file per slip box, the same format on every platform, daily backups, JSON and
  Markdown export. No account, no server, no telemetry.

<table align="center">
<tr>
<td align="center"><img src="assets/screenshots/ios-list.png" alt="Number tree" width="180"><br><sub>Number tree</sub></td>
<td align="center"><img src="assets/screenshots/ios-card.png" alt="Card" width="180"><br><sub>Card</sub></td>
<td align="center"><img src="assets/screenshots/ios-graph.png" alt="Graph" width="180"><br><sub>Graph</sub></td>
<td align="center"><img src="assets/screenshots/ios-index.png" alt="Keyword index" width="180"><br><sub>Keyword index</sub></td>
</tr>
</table>

## Install

From the [latest release](https://github.com/CamLUzy/slipbox/releases/latest):

- **Windows 10/11:** `Slipbox-<version>-windows-x64-setup.exe` (installer) or
  `Slipbox-<version>-windows-x64-portable.exe` (single file, needs WebView2, which Windows 11
  ships with). The files are not code-signed: choose *More info → Run anyway* in SmartScreen.
- **macOS 12+:** `Slipbox-<version>-macos.zip`, a universal app. If macOS refuses to open it, use
  *System Settings → Privacy & Security → Open Anyway*.
- **iPhone / iPad (iOS 16+):** `Slipbox-<version>-ios-unsigned.ipa`, installed with Sideloadly or
  AltStore and a free Apple ID (re-sign every 7 days), or built from source with Xcode. See
  [docs/IOS.md](docs/IOS.md).

To try it with sample cards, use *设置与数据 → 从 JSON 导入* and pick
[`docs/demo/demo-box.json`](docs/demo/demo-box.json).

## How it is built

`web/` is the whole UI in plain HTML, CSS and JavaScript (no build step). `apple/Shared` holds the
Swift store and bridge used by `mac/` (a WKWebView window, about 1 MB) and `ios/` (UIKit);
`src-tauri/` wraps the UI in Tauri 2 with WebView2 on Windows. All three
shells answer the same `zk` messages (cards, slip boxes, backups, export, the Ollama proxy), and
each has a headless self-test mode that CI runs against the packaged app on Windows, macOS and the
iOS simulator. LAN sync between devices is planned next ([docs/SYNC.md](docs/SYNC.md)). See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

[MIT](LICENSE).
