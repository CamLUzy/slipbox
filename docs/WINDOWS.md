# Windows

支持 Windows 10（1809 以上）和 Windows 11，64 位。

## 安装

到 [Releases](https://github.com/CamLUzy/slipbox/releases/latest) 下载其中一个：

- **安装版** `Slipbox-<版本>-windows-x64-setup.exe`：装到当前用户（不需要管理员权限），开始菜单里叫“卡片盒”，可以在“设置 → 应用”里卸载。电脑上没有 WebView2 时，安装程序会自动下载补上。
- **便携版** `Slipbox-<版本>-windows-x64-portable.exe`：一个文件，放在哪里都能双击运行。需要系统已有 WebView2 运行时：Windows 11 自带，更新过的 Windows 10 通常也有；没有的话从 [微软官网](https://developer.microsoft.com/microsoft-edge/webview2/) 装“常青版引导程序”即可。

两种版本用的是同一个数据文件夹，可以随时互换。

## “Windows 已保护你的电脑”

安装包没有购买代码签名证书，第一次运行时 SmartScreen 可能拦一下：点 **更多信息 → 仍要运行**。下载后可以用 PowerShell 校验文件：

```powershell
Get-FileHash .\Slipbox-1.0.0-windows-x64-setup.exe -Algorithm SHA256
```

和 Release 里 `SHA256SUMS.txt` 对应的那一行比较。

## 数据在哪

`%APPDATA%\卡片盒`（在资源管理器地址栏输入这个路径即可打开），也可以在应用里点 **设置与数据 → 在资源管理器中显示**。结构见 [数据](DATA.md)。

## 升级

下载新版本直接安装（或替换便携版 exe）即可，数据文件夹不受影响。

## 卸载

“设置 → 应用 → 已安装的应用 → 卡片盒 → 卸载”，或删除便携版 exe。卸载不会删除 `%APPDATA%\卡片盒`，需要彻底清除时手动删掉它。

## 和浏览器的区别

应用用 WebView2 显示界面，但关闭了 F5 刷新、Ctrl+P 打印、Ctrl+J 下载等浏览器快捷键，复制粘贴照常可用；正文里的外部链接会用默认浏览器打开。同一时间只能打开一个卡片盒窗口，再次启动会切回已经打开的那个。
