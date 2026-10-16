# 参与贡献

谢谢你愿意帮忙！下面是让改动顺利合并的几点约定。

## 开始之前

- bug：先在 [Issues](https://github.com/CamLUzy/slipbox/issues) 里搜一下，再用 bug 模板新建，写清楚系统、版本和复现步骤。
- 新功能：先开一个 issue 或 discussion 聊一下，确认它符合“卢曼卡片盒 + 数据只在本机”的方向，再动手写。

## 开发环境

```bash
npm install        # Tauri CLI
npm test           # 编号规则与数据操作的单元测试（Node 22+）
npm run dev        # 在浏览器里打开界面（数据存在浏览器的 IndexedDB）
```

- macOS 外壳：`bash mac/build.sh`，只需要 Xcode 命令行工具。
- Windows 外壳：安装 [Rust](https://rustup.rs) 后 `npx tauri build`；`cargo test --manifest-path src-tauri/Cargo.toml` 跑 Rust 测试。

更多细节（两个外壳的消息协议、自测模式、截图脚本）见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 代码约定

- 界面是原生 JavaScript 模块，不引入框架和构建步骤。改数据的逻辑放进 `web/js/ops.js` 的纯函数，并在 `tests/core.test.js` 里加测试。
- 新的原生能力要同时在 `mac/main.swift` 和 `src-tauri/src/lib.rs` 里实现同名的 `zk` 消息，回复格式保持一致。
- 写和周围代码一样风格的代码：同样的命名、同样的注释密度。
- 界面文字用简体中文。

## 提交 PR

1. 从 `main` 新建分支。
2. 确保 `npm test` 通过；如果改了外壳，CI 会在 Windows 和 macOS 上构建并自测。
3. PR 描述里写清楚改了什么、为什么、怎么测的；界面改动请附截图。
