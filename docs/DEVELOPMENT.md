# 开发指南

## 代码结构

```
web/                     共享界面：原生 HTML / CSS / JavaScript，没有构建步骤
  js/luhmann.js          Folgezettel 编号规则（纯函数）
  js/ops.js              新建、修改、删除、恢复、改号、导入（纯函数，返回改动的卡片）
  js/store.js            内存中的卡片与索引（树、反向链接、关键词）
  js/backend.js          存储与原生能力：Mac 走 WKWebView，Windows 走 Tauri，浏览器走 IndexedDB
  js/app.js              界面与路由
  js/ai.js, aiview.js    Ollama 调用、提示词与 AI 界面
  js/similarity.js       本地文本相似度
  js/graph.js            关系图（力导向布局、拖动缩放、悬停高亮）
apple/Shared/            Mac 与 iOS 共用的 Swift 核心：SQLite、卡片盒、备份、zk 消息桥、自测
mac/main.swift           macOS 外壳（窗口、菜单栏、存储面板）
ios/                     iPhone / iPad 外壳（UIKit，XcodeGen 工程 project.yml）
src-tauri/               Windows 外壳（Rust + Tauri 2 + WebView2 + rusqlite）
tests/                   单元测试与应用自测脚本
scripts/                 截图、横幅、架构图和产品视频（promo/）的生成脚本
docs/                    文档、示例卡片盒、架构图
```

## 消息协议

页面调用 `backend.call(cmd, args)`。Mac 和 iOS 上它是 `window.webkit.messageHandlers.zk.postMessage`（共享的 `apple/Shared/Bridge.swift`，系统界面相关的部分通过 `BridgeHost` 协议由各平台实现），Windows 上是 `window.__TAURI__.core.invoke('zk', { msg })`。所有外壳实现同一组命令，回复格式相同：

| 命令 | 参数 | 回复 |
|---|---|---|
| `load` | | 全部卡片的 JSON 数组字符串 |
| `put` / `delete` | `cards`（JSON 字符串）/ `uids` | `true` |
| `info` | | `{dataPath, backups, native, box}` 的 JSON 字符串 |
| `backup` / `reveal` | | 备份文件名 / `true` |
| `boxes` | | `{current, boxes: [{name, cards}]}` 的 JSON 字符串 |
| `createBox` / `switchBox` / `deleteBox` | `name` | `true` |
| `renameBox` | `name`, `to` | `true` |
| `saveFile` / `openFile` / `exportFiles` | 文件名与内容 / – / `folder`, `files` | 是否保存 / 文件内容或 `null` / 导出目录或 `null` |
| `ollama` | `id`, `base`, `path`, `body`, `stream` | `{status, text}` 或 `{error}`；流式时逐行调用 `window.zkStream(id, line)` |
| `ollamaCancel` / `startOllama` | `id` / – | `true` / 是否已安装 |
| `installOllama` | `id` | `{ok}` 或 `{error}`；进度 `{frac, text}` 逐条调用 `window.zkStream(id, …)`（macOS、Windows） |
| `appleAI` | `op: status` 或 `op: generate`, `id`, `messages`, `schema`, `temperature` | `{available, reason}` / `{content}` 或 `{error}`（macOS、iOS） |
| `sync` | `op`：`state` `start` `stop` `rename` `forget` `connect` `request` `trust` `answer` `close` `local` | 见 `web/js/sync.js`；事件通过 `window.zkSyncEvent(e)` 推给页面 |

Windows 外壳另有 `title`（窗口标题跟随页面）、`openUrl`（用默认浏览器打开）和 `selftestResult`。新增原生能力时，Swift（`apple/Shared` + 平台的 `BridgeHost`）和 Rust 两边都要实现。

## 测试

```bash
npm test                                          # 编号规则与数据操作（Node 22+）
cargo test --manifest-path src-tauri/Cargo.toml   # Rust：卡片盒命名规则、数据库读写、Noise 测试向量
swiftc apple/Shared/Noise.swift tests/noise/main.swift -o build/noise && build/noise   # Swift 的 Noise 与 Rust 逐字节一致
```

两个外壳都有无窗口自测模式，在真正打包好的应用里跑一段脚本：

```bash
# macOS
ZK_DATA_DIR=/tmp/zk ZK_SELFTEST=$PWD/tests/app-selftest.js "dist/卡片盒.app/Contents/MacOS/Zettelkasten"
# Windows（PowerShell）
$env:ZK_DATA_DIR="$env:TEMP\zk"; $env:ZK_SELFTEST="$PWD\tests\app-selftest.js"; $env:ZK_SELFTEST_OUT="$env:TEMP\out.json"
.\src-tauri\target\release\Slipbox.exe
```

- `ZK_DATA_DIR` 换一个数据目录，不会碰到真实数据，也不会改变应用记住的卡片盒。
- `tests/app-selftest.js`：读写、改号、永久删除、备份、页面渲染。
- `tests/app-boxes-selftest.js`：新建、重命名、切换、删除卡片盒。
- `tests/app-ai-selftest.js`：需要本机 Ollama，测试流式对话、整理、关系分析、中途停止和释放内存。
- `tests/app-apple-ai-selftest.js`：Apple 端侧模型（macOS 26 并打开 Apple 智能）；没有模型时只报告原因。
- 局域网同步：`bash scripts/sync-selftest.sh <主机应用> [<客户端应用>]` 在本机启动两个实例（各用一个数据目录），配对、同步两次、核对两边数据（`tests/app-sync-*.js`、`scripts/check-sync-selftest.mjs`）。两个参数可以是不同的应用，比如 Mac 应用和 `cargo build --features tauri/custom-protocol` 编出来的 Rust 版，用来检查两种实现能互通。

iOS 版在模拟器里跑自测：用 `xcrun simctl launch` 并通过 `SIMCTL_CHILD_ZK_SELFTEST` 等环境变量传入，脚本要先拷进应用的数据容器（见 CI 配置）。

本地没有完整 Xcode 时，可以用 Mac Catalyst 的 UIKit 对 iOS 代码做类型检查：

```bash
SDK=$(xcrun --show-sdk-path)
xcrun swiftc -parse-as-library -typecheck -target arm64-apple-ios16.0-macabi -sdk $SDK \
  -Fsystem $SDK/System/iOSSupport/System/Library/Frameworks apple/Shared/*.swift ios/Sources/*.swift
```

CI（`.github/workflows/build.yml`）在每次提交时跑单元测试，在 Windows、macOS 和 iOS 模拟器里构建并对应用运行自测（包括 Windows ↔ Windows、Mac ↔ Mac、Mac ↔ Rust 的同步），检查 FoundationModels 是弱链接（老系统上也能打开），还会生成未签名的 `.ipa`；推送 `v*` 标签时自动发布 Release。

## 发布

1. 更新 `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`mac/Info.plist`、`ios/project.yml`、`package.json` 里的版本号，在 `CHANGELOG.md` 加一节。
2. 提交后打标签并推送：`git tag v1.2.3 && git push origin v1.2.3`。

## 截图与图片

```bash
bash scripts/screenshots.sh   # 用示例卡片盒生成 assets/screenshots/*.png（AI 截图会真的调用本机模型）
```

`scripts/snap.swift` 用离屏 WebKit 把网页渲染成 PNG；横幅和架构图的源文件在 `scripts/art/`。

## 产品介绍视频

```bash
bash scripts/promo/make.sh          # 生成 dist/slipbox-intro.mp4（1 分钟，1080p，带配乐）
bash scripts/promo/make.sh 12 30    # 只导出这几秒的静帧，用来检查画面
```

镜头都在 `scripts/promo/index.html` 里，每一帧只由时间决定（`seek(t)`），用浏览器打开并加上 `?play` 可以直接预览。`record.swift` 逐帧截图交给 ffmpeg 编码；配乐由 `music.py` 用 numpy 合成，没有采样，也没有版权问题；旁白由本地语音模型 Kokoro-82M-v1.1-zh 生成（`voice.py`，每句对准镜头时间），`mix.py` 在说话时把配乐压低。需要 ffmpeg 和带 numpy、scipy 的 Python；旁白另需一个 Python 3.12 环境，见 `make.sh` 里的说明，没有它时视频只有配乐。
