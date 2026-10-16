// 卡片盒 — iPhone / iPad app. One full-screen WKWebView with the shared web UI; the store,
// slip boxes and the `zk` bridge live in apple/Shared (the same code as the Mac app).
// Data lives in the app's Documents folder, so it shows up in the Files app.
import UIKit
import UniformTypeIdentifiers
import WebKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default", sessionRole: session.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = WebViewController()
        window.makeKeyAndVisible()
        self.window = window
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        (window?.rootViewController as? WebViewController)?.backupIfDue()
    }
}

final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, UIDocumentPickerDelegate {
    private var webView: WKWebView!
    private var bridge: Bridge!
    private var backupTimer: Timer?
    private var pickerReply: ((Any?, String?) -> Void)?
    private var pickerExports = false

    /// Documents/卡片盒 — visible in the Files app under “On My iPhone / 卡片盒”.
    static var dataRoot: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("卡片盒", isDirectory: true)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // Same paper colours as the web UI, so there is no white flash while it loads.
        view.backgroundColor = UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.086, green: 0.082, blue: 0.075, alpha: 1)
                : UIColor(red: 0.937, green: 0.914, blue: 0.867, alpha: 1)
        }
        do {
            bridge = try ZKApp.makeBridge(defaultRoot: Self.dataRoot)
        } catch {
            let alert = UIAlertController(title: "无法打开卡片盒数据", message: error.localizedDescription, preferredStyle: .alert)
            DispatchQueue.main.async { self.present(alert, animated: true) }
            return
        }
        webView = WKWebView(frame: view.bounds, configuration: ZKApp.configuration(for: bridge))
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.isOpaque = false
        webView.backgroundColor = .clear
        // The page handles the notch and home indicator itself with env(safe-area-inset-*).
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.navigationDelegate = self
        webView.uiDelegate = self
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        view.addSubview(webView)
        bridge.host = self
        bridge.webView = webView
        webView.load(URLRequest(url: ZKApp.startURL))

        if !ZKApp.isSelfTest {
            bridge.backups.makeIfDue()
            backupTimer = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { [weak self] _ in self?.backupIfDue() }
        }
    }

    func backupIfDue() {
        if !ZKApp.isSelfTest { bridge?.backups.makeIfDue() }
    }

    // MARK: web view delegates

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, !ZKApp.isAppURL(url) {
            UIApplication.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, !ZKApp.isAppURL(url) { UIApplication.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        ZKApp.runSelfTestIfRequested(in: webView)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    // MARK: document picker

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let reply = pickerReply, let url = urls.first else { return }
        pickerReply = nil
        if pickerExports { return reply(url.lastPathComponent, nil) }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do { reply(try String(contentsOf: url, encoding: .utf8), nil) } catch { reply(nil, error.localizedDescription) }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        pickerReply?(nil, nil)
        pickerReply = nil
    }

    /// Popovers on iPad need an anchor; centre of the screen is fine for sheets started from the page.
    private func anchor(_ vc: UIViewController) {
        if let pop = vc.popoverPresentationController {
            pop.sourceView = view
            pop.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
            pop.permittedArrowDirections = []
        }
    }
}

// MARK: - BridgeHost (share sheet, Files app, local-network Ollama)

extension WebViewController: BridgeHost {
    func reveal(_ url: URL) {
        let folder = url.deletingLastPathComponent().path
        if let encoded = folder.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
           let files = URL(string: "shareddocuments://" + encoded) {
            UIApplication.shared.open(files)
        }
    }

    func saveFile(name: String, content: String, reply: @escaping (Any?, String?) -> Void) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let file = dir.appendingPathComponent(name)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try content.write(to: file, atomically: true, encoding: .utf8)
        } catch { return reply(nil, error.localizedDescription) }
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, completed, _, _ in reply(completed, nil) }
        anchor(sheet)
        present(sheet, animated: true)
    }

    func openFile(reply: @escaping (Any?, String?) -> Void) {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.json], asCopy: true)
        picker.delegate = self
        pickerReply = reply
        pickerExports = false
        present(picker, animated: true)
    }

    func exportFolder(_ dir: URL, reply: @escaping (Any?, String?) -> Void) {
        let picker = UIDocumentPickerViewController(forExporting: [dir], asCopy: true)
        picker.delegate = self
        pickerReply = reply
        pickerExports = true
        present(picker, animated: true)
    }

    /// Ollama cannot run on the phone; a computer on the same network can serve it.
    func startOllama() -> Bool { false }

    /// Loopback or the local network only (Ollama on a computer at home started with OLLAMA_HOST=0.0.0.0).
    var deviceName: String { UIDevice.current.name }
    var platform: String { "ios" }

    func allowsOllama(host: String) -> Bool {
        let h = host.lowercased()
        if ["127.0.0.1", "localhost", "::1"].contains(h) || h.hasSuffix(".local") || h.hasPrefix("fe80:") { return true }
        let parts = h.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4 else { return false }
        return parts[0] == 10 || (parts[0] == 192 && parts[1] == 168) || (parts[0] == 172 && (16...31).contains(parts[1]))
    }

    /// Deleted slip boxes go to “已删除的卡片盒” next to the boxes, where the Files app can bring them back.
    func discard(_ url: URL) throws {
        let bin = bridge.boxes.root.appendingPathComponent("已删除的卡片盒", isDirectory: true)
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        try FileManager.default.moveItem(at: url, to: bin.appendingPathComponent("\(stamp) \(url.lastPathComponent)"))
    }
}
