# 安全

## 支持的版本

只有最新发布的版本会收到安全修复。

## 报告漏洞

请不要在公开 issue 里描述安全问题。用 GitHub 的 [私密漏洞报告](https://github.com/CamLUzy/slipbox/security/advisories/new) 提交，写清楚影响范围和复现步骤，我会尽快回复。

## 设计上的安全边界

- 卡片只保存在本机的 SQLite 文件里，应用不联网、不收集任何数据。
- AI 请求由应用外壳转发，并且只允许连接本机回环地址（`127.0.0.1`、`localhost`、`::1`）上的 Ollama，卡片内容不会被发到别的机器。
- 卡片正文渲染 Markdown 时会转义 HTML，链接只允许 `http`、`https`、`mailto` 和应用内地址，外部链接交给系统默认浏览器打开。
- 发布的安装包没有代码签名证书，请从本仓库的 Releases 下载，并用 `SHA256SUMS.txt` 校验。
