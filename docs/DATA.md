# 数据

## 文件在哪

| 系统 | 位置 |
|---|---|
| Windows | `%APPDATA%\卡片盒` |
| macOS | `~/Library/Application Support/卡片盒` |
| iPhone / iPad | “文件”App → 我的 iPhone → 卡片盒 |

```
卡片盒/
├─ boxes/
│  ├─ 我的卡片盒.db          一个卡片盒一个 SQLite 文件
│  └─ 课程笔记.db
├─ backups/
│  └─ 我的卡片盒/zettel-2026-10-16-093000.db   每天一份，保留 30 份
├─ sync.json                  这台设备的同步身份（名称、密钥）和已配对的设备
└─ settings.json              （Windows）上次打开的卡片盒
```

`.db` 文件旁边可能有 `-wal`、`-shm` 两个临时文件，属于正常的 SQLite 运行文件。

## 数据库格式

表 `cards`，每张卡片一行：`uid`、`zid`（编号或文献键）、`kind`（`note` / `fleeting` / `literature`）、`title`、`body`（Markdown）、`keywords`（JSON 数组）、`deleted`、`created_at`、`updated_at`，以及 `data`（这张卡片完整的 JSON）。Mac、Windows、iPhone 完全一样，可以用任何 SQLite 工具打开查看。

同步用到另外两张表：`meta`（`boxId`：同一个卡片盒在各台设备上的身份；`sync.<设备 ID>`：上次和那台设备同步的时间）和 `purged`（永久删除的卡片 `uid` 与时间，让同步不会把它们“复活”）。

## 备份与恢复

- 应用每天自动备份一次当前卡片盒；也可以点 **设置与数据 → 立即备份**。
- 恢复：退出应用，把 `backups/<卡片盒名>/` 里想要的那份 `zettel-日期.db` 复制到 `boxes/<卡片盒名>.db`（先删掉旁边的 `-wal`、`-shm`），再打开应用。

## 导入导出

- **导出 JSON**：整个卡片盒一个文件，包含回收站里的卡片。
- **导出为 Markdown 文件**：每张卡片一个 `.md`，按“卡片盒 / 收件箱 / 文献”分文件夹，带 front matter，Obsidian 等工具可以直接打开。
- **从 JSON 导入**：导入到当前卡片盒；已有的卡片（按 uid）会跳过，编号冲突的卡片会放进收件箱。

## 换电脑、Mac 与 Windows 之间

最简单的是用 [局域网同步](SYNC.md)：新旧设备连同一个 Wi-Fi，同步一次，所有卡片盒都会过去。

也可以把整个 `卡片盒` 文件夹拷到新电脑的对应位置（拷完删掉新电脑上的 `sync.json`，否则两台设备的同步身份相同）；只想带走一个卡片盒，就拷 `boxes/<名字>.db`。或者导出 JSON 再在新电脑上导入。
