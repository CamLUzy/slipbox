# macOS

支持 macOS 12 及以上，Apple 芯片与 Intel 通用。

## 安装

1. 到 [Releases](https://github.com/CamLUzy/slipbox/releases/latest) 下载 `Slipbox-<版本>-macos.zip`，双击解压。
2. 把“卡片盒.app”拖进“应用程序”。
3. 应用没有 Apple 开发者签名，第一次打开如果被拦：到 **系统设置 → 隐私与安全性**，在下方点 **仍要打开**。也可以在终端运行：

```bash
xattr -dr com.apple.quarantine /Applications/卡片盒.app
```

## 自己编译

只需要 Xcode 命令行工具（`xcode-select --install`），不需要完整的 Xcode：

```bash
bash mac/build.sh             # 生成 dist/卡片盒.app
bash mac/build.sh --install   # 生成并安装到 /Applications（会先退出正在运行的卡片盒）
```

自己编译的应用不会被 Gatekeeper 拦。

## 数据在哪

`~/Library/Application Support/卡片盒`，也可以在应用里点 **设置与数据 → 在 Finder 中显示**。结构见 [数据](DATA.md)。

## 菜单

菜单栏有“文件 / 编辑 / 显示 / 前往 / AI / 窗口”。常用快捷键：⌘N 闪念、⇧⌘N 新主题卡片、⌘O 切换卡片盒、⌘F 搜索、⌘R 随机漫步、⌘J AI 助手、⌘+ / ⌘- 缩放。
