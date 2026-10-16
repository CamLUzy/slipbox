# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.0] - 2026-10-16

### 新增

- **iPhone / iPad 应用**（iOS 16+）：UIKit + WKWebView 外壳，和 Mac 版共用 `apple/Shared` 里的 Swift 核心（SQLite、卡片盒、备份、`zk` 消息桥）。数据放在“文件”App 里看得到的位置；导出用分享面板，导入用文件选择器；删除的卡片盒先放进“已删除的卡片盒”文件夹。
- iPhone 上的 AI 可以连接同一个 Wi-Fi 下电脑上的 Ollama（只允许局域网地址）。
- Release 里提供未签名的 `.ipa`，可用 Sideloadly / AltStore 安装；`docs/IOS.md` 写了安装步骤。
- CI 在 iOS 模拟器里运行应用自测，并自动截取 iPhone 截图。
- 多端互联（局域网同步）的方案：`docs/SYNC.md`。

## [1.0.0] - 2026-10-16

第一个公开版本：macOS 与 Windows 两个桌面应用，共用同一份界面。

### 新增

- **Windows 应用**：Rust + Tauri 2 + WebView2 外壳，提供安装版和便携版 exe。关闭了 F5 刷新、Ctrl+P 打印等浏览器快捷键，有完整的中文菜单栏，外部链接用默认浏览器打开，只允许运行一个实例。
- **macOS 应用**：Swift + WKWebView 外壳，约 1 MB，Apple 芯片与 Intel 通用。
- 卢曼卡片盒：闪念、文献卡片、永久卡片；Folgezettel 固定编号，“续写”和“分支”自动取号；整串分支改号并自动更新链接。
- `[[编号]]` 链接与 `[[@文献键]]` 引用，输入时自动补全；反向链接、关键词索引、编号树、随机漫步、全文搜索。
- 多个卡片盒：新建、切换、重命名，删除时移到废纸篓或回收站。
- 关系图：拖动、缩放；悬停节点时只高亮它和直接相连的卡片，节点多时只显示编号。
- 本地 AI（Ollama，默认 `qwen3.5:4b`）：AI 整理、单张卡片的关系分析、整个卡片盒的主题与联系图、AI 助手对话。只在点击时加载模型，状态实时显示，闲置自动释放。
- 每天自动备份（保留 30 份）、导出 JSON、导出 Markdown 文件夹、从 JSON 导入。
- 示例卡片盒 `docs/demo/demo-box.json`。
- CI：每次提交都在 Windows 和 macOS 上构建，并对打包好的应用运行无窗口自测；打标签后自动发布 Release 和 SHA256 校验文件。

### 修复

- 在设置里选择浅色或深色主题后，卡片页上的按钮点击会被当成“切换主题”而失效。
