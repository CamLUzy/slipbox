// 卡片盒 — macOS app. A window with the shared web UI (Resources/web) in a WKWebView; the
// store, slip boxes and the `zk` bridge live in apple/Shared and are shared with the iOS app.
// Build with mac/build.sh (only the Xcode Command Line Tools are needed).
import Cocoa
import WebKit

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var bridge: Bridge!
    var titleObservation: NSKeyValueObservation?
    var backupTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        do {
            bridge = try ZKApp.makeBridge(defaultRoot: support.appendingPathComponent("卡片盒", isDirectory: true))
        } catch {
            let alert = NSAlert(error: error)
            alert.messageText = "无法打开卡片盒数据"
            alert.runModal()
            NSApp.terminate(nil)
            return
        }

        let config = ZKApp.configuration(for: bridge)
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsMagnification = true
        if #available(macOS 13.3, *) { webView.isInspectable = true }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 780),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "卡片盒"
        window.minSize = NSSize(width: 420, height: 400)
        window.tabbingMode = .disallowed
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("MainWindow")
        bridge.host = self
        bridge.webView = webView
        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] wv, _ in
            let t = wv.title ?? ""
            let box = self?.bridge.boxName ?? "卡片盒"
            self?.window.title = t.isEmpty || t == "卡片盒" ? box : "\(t) — \(box)"
        }

        buildMenu()
        webView.load(URLRequest(url: ZKApp.startURL))
        if ZKApp.isSelfTest { return }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        bridge.backups.makeIfDue()
        backupTimer = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { [weak self] _ in self?.bridge.backups.makeIfDue() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) { bridge?.backups.makeIfDue() }

    // MARK: menu

    private func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
        let it = NSMenuItem(title: title, action: action, keyEquivalent: key)
        it.keyEquivalentModifierMask = mods
        return it
    }

    private func jsItem(_ title: String, _ menuAction: String, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
        let it = item(title, #selector(runJsMenu(_:)), key, mods)
        it.target = self
        it.representedObject = menuAction
        return it
    }

    @objc func runJsMenu(_ sender: NSMenuItem) {
        guard let action = sender.representedObject as? String else { return }
        window.makeKeyAndOrderFront(nil)
        webView.evaluateJavaScript("window.zkMenu && window.zkMenu('\(action)')")
    }

    @objc func zoomIn(_ sender: Any?) { webView.pageZoom = min(webView.pageZoom + 0.1, 2) }
    @objc func zoomOut(_ sender: Any?) { webView.pageZoom = max(webView.pageZoom - 0.1, 0.6) }
    @objc func zoomReset(_ sender: Any?) { webView.pageZoom = 1 }

    private func buildMenu() {
        let main = NSMenu()
        func sub(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let m = NSMenu(title: title)
            items.forEach { m.addItem($0) }
            let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            holder.submenu = m
            main.addItem(holder)
            return m
        }
        let hideOthers = item("隐藏其他", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option])
        _ = sub("卡片盒", [
            item("关于卡片盒", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            jsItem("设置与数据…", "settings", ","),
            .separator(),
            item("隐藏卡片盒", #selector(NSApplication.hide(_:)), "h"),
            hideOthers,
            item("全部显示", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("退出卡片盒", #selector(NSApplication.terminate(_:)), "q"),
        ])
        _ = sub("文件", [
            jsItem("切换卡片盒…", "boxes", "o"),
            .separator(),
            jsItem("记录闪念", "capture", "n"),
            jsItem("新主题卡片", "new-top", "n", [.command, .shift]),
            jsItem("新文献卡片", "new-lit", "n", [.command, .option]),
            .separator(),
            jsItem("从 JSON 导入…", "import-json"),
            jsItem("导出 JSON…", "export-json", "e", [.command, .shift]),
            jsItem("导出为 Markdown 文件…", "export-md"),
            .separator(),
            jsItem("设备与同步…", "sync", "y", [.command, .shift]),
            jsItem("立即备份", "backup", "b", [.command, .shift]),
            .separator(),
            item("关闭窗口", #selector(NSWindow.performClose(_:)), "w"),
        ])
        _ = sub("编辑", [
            item("撤销", Selector(("undo:")), "z"),
            item("重做", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("剪切", #selector(NSText.cut(_:)), "x"),
            item("拷贝", #selector(NSText.copy(_:)), "c"),
            item("粘贴", #selector(NSText.paste(_:)), "v"),
            item("粘贴并匹配样式", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift]),
            item("全选", #selector(NSText.selectAll(_:)), "a"),
            .separator(),
            jsItem("搜索", "search", "f"),
        ])
        let zoomIn = item("放大", #selector(zoomIn(_:)), "+")
        let zoomOut = item("缩小", #selector(zoomOut(_:)), "-")
        let zoomReset = item("实际大小", #selector(zoomReset(_:)), "0")
        [zoomIn, zoomOut, zoomReset].forEach { $0.target = self }
        _ = sub("显示", [zoomReset, zoomIn, zoomOut, .separator(),
                       item("进入全屏幕", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])])
        _ = sub("前往", [jsItem("随机漫步", "random", "r"), jsItem("回收站", "trash")])
        _ = sub("AI", [
            jsItem("AI 助手", "ai", "j"),
            jsItem("梳理整个卡片盒", "ai-map", "j", [.command, .shift]),
            .separator(),
            jsItem("释放模型内存", "ai-unload"),
        ])
        let win = sub("窗口", [
            item("最小化", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("缩放", #selector(NSWindow.performZoom(_:))),
        ])
        NSApp.mainMenu = main
        NSApp.windowsMenu = win
    }

    // MARK: web view delegates

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, !ZKApp.isAppURL(url) {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, url.scheme != "zk" { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        ZKApp.runSelfTestIfRequested(in: webView)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "确定")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }
}

// MARK: - BridgeHost (file panels, Finder, Ollama.app)

extension AppDelegate: BridgeHost {
    func reveal(_ url: URL) {
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    private func present(_ panel: NSSavePanel, _ done: @escaping (Bool) -> Void) {
        if let window { panel.beginSheetModal(for: window) { done($0 == .OK) } } else { done(panel.runModal() == .OK) }
    }

    func saveFile(name: String, content: String, reply: @escaping (Any?, String?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        panel.canCreateDirectories = true
        present(panel) { ok in
            guard ok, let url = panel.url else { return reply(false, nil) }
            do {
                try content.write(to: url, atomically: true, encoding: .utf8)
                reply(true, nil)
            } catch { reply(nil, error.localizedDescription) }
        }
    }

    func openFile(reply: @escaping (Any?, String?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        present(panel) { ok in
            guard ok, let url = panel.url else { return reply(nil, nil) }
            do { reply(try String(contentsOf: url, encoding: .utf8), nil) } catch { reply(nil, error.localizedDescription) }
        }
    }

    func exportFolder(_ dir: URL, reply: @escaping (Any?, String?) -> Void) {
        let folder = dir.lastPathComponent
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.prompt = "导出到这里"
        panel.message = "选择导出位置，会在其中新建文件夹“\(folder)”"
        present(panel) { ok in
            guard ok, let base = panel.url else { return reply(nil, nil) }
            do {
                var target = base.appendingPathComponent(folder)
                var i = 2
                while FileManager.default.fileExists(atPath: target.path) {
                    target = base.appendingPathComponent("\(folder) \(i)")
                    i += 1
                }
                try FileManager.default.moveItem(at: dir, to: target)
                NSWorkspace.shared.activateFileViewerSelecting([target])
                reply(target.path, nil)
            } catch { reply(nil, error.localizedDescription) }
        }
    }

    /// Opens the Ollama app (or `ollama serve`) in the background. Returns false if not installed.
    func startOllama() -> Bool {
        let fm = FileManager.default
        for app in ["/Applications/Ollama.app", NSHomeDirectory() + "/Applications/Ollama.app"] where fm.fileExists(atPath: app) {
            let config = NSWorkspace.OpenConfiguration()
            config.activates = false
            NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: app), configuration: config)
            return true
        }
        for bin in ["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama"] where fm.isExecutableFile(atPath: bin) {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: bin)
            p.arguments = ["serve"]
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            if (try? p.run()) != nil { return true }
        }
        return false
    }

    /// The official Ollama.app from GitHub into /Applications (or ~/Applications), then start it.
    func installOllama(progress: @escaping (Double?, String) -> Void) async throws {
        let url = URL(string: "https://github.com/ollama/ollama/releases/latest/download/Ollama-darwin.zip")!
        progress(0, "正在下载 Ollama…")
        let zip = try await Downloader.download(url) { progress($0, "正在下载 Ollama…") }
        defer { try? FileManager.default.removeItem(at: zip) }
        progress(nil, "正在安装 Ollama…")
        try await Task.detached {
            let fm = FileManager.default
            let tmp = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
            defer { try? fm.removeItem(at: tmp) }
            let ditto = Process()
            ditto.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
            ditto.arguments = ["-x", "-k", zip.path, tmp.path]
            try ditto.run()
            ditto.waitUntilExit()
            let app = tmp.appendingPathComponent("Ollama.app")
            guard ditto.terminationStatus == 0, fm.fileExists(atPath: app.path) else { throw AppError(message: "下载的 Ollama 安装包不完整，请重试") }
            let system = URL(fileURLWithPath: "/Applications", isDirectory: true)
            let dir = fm.isWritableFile(atPath: system.path) ? system : fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications", isDirectory: true)
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            let target = dir.appendingPathComponent("Ollama.app")
            if fm.fileExists(atPath: target.path) { try fm.trashItem(at: target, resultingItemURL: nil) }
            try fm.moveItem(at: app, to: target)
        }.value
        progress(nil, "正在启动 Ollama…")
        await MainActor.run { _ = self.startOllama() }
    }

    var deviceName: String { Host.current().localizedName ?? "Mac" }
    var platform: String { "mac" }

    /// Card contents never leave this Mac: only Ollama on loopback.
    func allowsOllama(host: String) -> Bool {
        ["127.0.0.1", "localhost", "::1"].contains(host)
    }

    func discard(_ url: URL) throws {
        try FileManager.default.trashItem(at: url, resultingItemURL: nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()

// MARK: - Download with progress (one-click Ollama install)

final class Downloader: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private var continuation: CheckedContinuation<URL, Error>?
    private var task: URLSessionDownloadTask?
    private var saved: URL?
    private var lastReport = Date.distantPast
    private let progress: (Double) -> Void

    private init(progress: @escaping (Double) -> Void) { self.progress = progress }

    static func download(_ url: URL, progress: @escaping (Double) -> Void) async throws -> URL {
        let d = Downloader(progress: progress)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<URL, Error>) in
                d.continuation = c
                let session = URLSession(configuration: .default, delegate: d, delegateQueue: nil)
                d.task = session.downloadTask(with: url)
                d.task?.resume()
            }
        } onCancel: {
            d.task?.cancel()
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard totalBytesExpectedToWrite > 0, Date().timeIntervalSince(lastReport) > 0.25 else { return }
        lastReport = Date()
        progress(Double(totalBytesWritten) / Double(totalBytesExpectedToWrite))
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // the file is deleted when this returns, so keep it
        let keep = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".zip")
        if (try? FileManager.default.moveItem(at: location, to: keep)) != nil { saved = keep }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        session.finishTasksAndInvalidate()
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        if let error {
            continuation?.resume(throwing: error)
        } else if let saved, status == 200 {
            continuation?.resume(returning: saved)
        } else {
            continuation?.resume(throwing: AppError(message: "下载失败（HTTP \(status)），请检查网络后重试"))
        }
        continuation = nil
    }
}
