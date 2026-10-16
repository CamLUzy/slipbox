// The `zk` message bridge (window.webkit.messageHandlers.zk, see web/js/backend.js), shared by
// the macOS and iOS apps. Everything that needs system UI (file panels, share sheets, opening
// other apps) goes through a BridgeHost, implemented once per platform.
import Foundation
import WebKit

protocol BridgeHost: AnyObject {
    /// Show the data file in the system file browser.
    func reveal(_ url: URL)
    /// Let the user save `content` as a file called `name`; reply true if saved, false if cancelled.
    func saveFile(name: String, content: String, reply: @escaping (Any?, String?) -> Void)
    /// Let the user pick a JSON file; reply with its text, or nil if cancelled.
    func openFile(reply: @escaping (Any?, String?) -> Void)
    /// Let the user choose where the already written folder `dir` goes; reply with a path or nil.
    func exportFolder(_ dir: URL, reply: @escaping (Any?, String?) -> Void)
    /// Start Ollama in the background; false if it isn't available on this device.
    func startOllama() -> Bool
    /// Hosts the Ollama proxy may talk to.
    func allowsOllama(host: String) -> Bool
    /// Remove a deleted slip box's file in a recoverable way.
    func discard(_ url: URL) throws
}

final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    let boxes: Boxes
    private(set) var boxName: String
    private(set) var db: Database
    private(set) var backups: Backups
    weak var host: BridgeHost?
    weak var webView: WKWebView?
    private var ollamaTasks: [String: Task<Void, Never>] = [:]

    init(boxes: Boxes, name: String) throws {
        self.boxes = boxes
        boxName = name
        db = try Database(fileURL: boxes.file(name))
        try FileManager.default.createDirectory(at: boxes.backupDir(name), withIntermediateDirectories: true)
        backups = Backups(dir: boxes.backupDir(name), db: db)
    }

    func open(box name: String) throws {
        let next = try Database(fileURL: boxes.file(name))
        try FileManager.default.createDirectory(at: boxes.backupDir(name), withIntermediateDirectories: true)
        db.close()
        db = next
        backups = Backups(dir: boxes.backupDir(name), db: next)
        boxName = name
        // a development data dir (ZK_DATA_DIR) must not change the real app's remembered box
        if ZKApp.env["ZK_DATA_DIR"] == nil { UserDefaults.standard.set(name, forKey: "currentBox") }
    }

    static let badName = "名称不能为空，不能以 . 开头或结尾，也不能包含 / \\ : * ? \" < > |"

    private func boxCommand(_ cmd: String, _ body: [String: Any]) throws -> Any {
        let name = body["name"] as? String ?? ""
        switch cmd {
        case "boxes":
            let list = boxes.list().map { ["name": $0, "cards": $0 == boxName ? -1 : boxes.count($0)] as [String: Any] }
            return Self.jsonString(["current": boxName, "boxes": list])
        case "createBox":
            guard Boxes.isValid(name) else { throw AppError(message: Self.badName) }
            guard !boxes.exists(name) else { throw AppError(message: "已经有叫“\(name)”的卡片盒了") }
            try open(box: name)
            return true
        case "switchBox":
            guard boxes.exists(name) else { throw AppError(message: "找不到卡片盒“\(name)”") }
            try open(box: name)
            return true
        case "renameBox":
            let to = body["to"] as? String ?? ""
            guard Boxes.isValid(to) else { throw AppError(message: Self.badName) }
            guard boxes.exists(name), !boxes.exists(to) else { throw AppError(message: "名称“\(to)”已被使用") }
            let current = name == boxName
            if current { db.close() }
            try boxes.moveFiles(from: boxes.file(name), to: boxes.file(to))
            if FileManager.default.fileExists(atPath: boxes.backupDir(name).path) {
                try? FileManager.default.moveItem(at: boxes.backupDir(name), to: boxes.backupDir(to))
            }
            if current { try open(box: to) }
            return true
        case "deleteBox":
            guard name != boxName else { throw AppError(message: "不能删除正在使用的卡片盒") }
            guard boxes.exists(name) else { throw AppError(message: "找不到卡片盒“\(name)”") }
            for suffix in ["", "-wal", "-shm"] {
                let f = URL(fileURLWithPath: boxes.file(name).path + suffix)
                if FileManager.default.fileExists(atPath: f.path) { try host?.discard(f) }
            }
            return true
        default:
            throw AppError(message: "unknown command \(cmd)")
        }
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else {
            return replyHandler(nil, "bad message")
        }
        do {
            switch cmd {
            case "load":
                replyHandler(try db.loadAll(), nil)
            case "put":
                try db.put(json: body["cards"] as? String ?? "[]")
                replyHandler(true, nil)
            case "delete":
                try db.delete(uids: body["uids"] as? [String] ?? [])
                replyHandler(true, nil)
            case "boxes", "createBox", "switchBox", "renameBox", "deleteBox":
                replyHandler(try boxCommand(cmd, body), nil)
            case "info":
                let info: [String: Any] = ["dataPath": db.fileURL.path, "backups": backups.list(), "native": true, "box": boxName]
                replyHandler(Self.jsonString(info), nil)
            case "backup":
                replyHandler(try backups.make(), nil)
            case "reveal":
                host?.reveal(db.fileURL)
                replyHandler(true, nil)
            case "saveFile":
                guard let host else { return replyHandler(false, nil) }
                host.saveFile(name: body["name"] as? String ?? "export.json", content: body["content"] as? String ?? "", reply: replyHandler)
            case "openFile":
                guard let host else { return replyHandler(nil, nil) }
                host.openFile(reply: replyHandler)
            case "exportFiles":
                guard let host else { return replyHandler(nil, nil) }
                let dir = try writeExport(folder: body["folder"] as? String ?? "卡片盒导出", json: body["files"] as? String ?? "[]")
                host.exportFolder(dir, reply: replyHandler)
            case "ollama":
                ollama(body, reply: replyHandler)
            case "ollamaCancel":
                if let id = body["id"] as? String { ollamaTasks[id]?.cancel() }
                replyHandler(true, nil)
            case "startOllama":
                replyHandler(host?.startOllama() ?? false, nil)
            default:
                replyHandler(nil, "unknown command \(cmd)")
            }
        } catch {
            replyHandler(nil, error.localizedDescription)
        }
    }

    static func jsonString(_ obj: [String: Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes])) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    /// Writes an export (files: [{path, content}]) into a fresh temporary folder named `folder`.
    private func writeExport(folder: String, json: String) throws -> URL {
        let files = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [[String: String]] ?? []
        let base = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let dir = base.appendingPathComponent(folder, isDirectory: true)
        for f in files {
            guard let rel = f["path"], !rel.contains(".."), let content = f["content"] else { continue }
            let url = dir.appendingPathComponent(rel)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try content.write(to: url, atomically: true, encoding: .utf8)
        }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Proxy to Ollama (avoids browser CORS rules). The host decides which addresses are allowed:
    /// loopback only on the Mac, loopback or the local network on iOS. Streamed responses are
    /// pushed line by line to window.zkStream(id, line); the reply carries {status, text} or {error}.
    private func ollama(_ body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        let id = body["id"] as? String ?? UUID().uuidString
        let base = body["base"] as? String ?? "http://127.0.0.1:11434"
        let path = body["path"] as? String ?? "/api/tags"
        guard let url = URL(string: base + path), url.scheme == "http" || url.scheme == "https",
              let h = url.host, host?.allowsOllama(host: h) == true else {
            return reply(Self.jsonString(["error": "只允许连接本机或局域网里的 Ollama"]), nil)
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 900
        if let payload = body["body"] as? String {
            req.httpMethod = "POST"
            req.httpBody = Data(payload.utf8)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let stream = body["stream"] as? Bool ?? false
        ollamaTasks[id] = Task { [weak self] in
            var result: [String: Any]
            do {
                if stream {
                    let (bytes, response) = try await URLSession.shared.bytes(for: req)
                    for try await line in bytes.lines {
                        try Task.checkCancellation()
                        await MainActor.run {
                            self?.webView?.callAsyncJavaScript("window.zkStream(id, line)", arguments: ["id": id, "line": line],
                                                               in: nil, in: .page, completionHandler: nil)
                        }
                    }
                    result = ["status": (response as? HTTPURLResponse)?.statusCode ?? 0, "text": ""]
                } else {
                    let (data, response) = try await URLSession.shared.data(for: req)
                    result = ["status": (response as? HTTPURLResponse)?.statusCode ?? 0, "text": String(decoding: data, as: UTF8.self)]
                }
            } catch is CancellationError {
                result = ["error": "cancelled", "cancelled": true]
            } catch let e as URLError where e.code == .cancelled {
                result = ["error": "cancelled", "cancelled": true]
            } catch {
                result = ["error": error.localizedDescription]
            }
            let text = Self.jsonString(result)
            await MainActor.run {
                self?.ollamaTasks[id] = nil
                reply(text, nil)
            }
        }
    }
}

/// Start-up shared by both apps: data folder, remembered box, web view configuration, self-test.
///
/// Development: ZK_DATA_DIR=<folder> uses another data folder and leaves the remembered box alone;
/// ZK_BOX=<name> opens that box; ZK_SELFTEST=<script.js> runs the script in the page (body of an
/// async function), prints the result (and writes it to ZK_SELFTEST_OUT if set) and quits.
enum ZKApp {
    static let env = ProcessInfo.processInfo.environment
    static let startURL = URL(string: "zk://app/index.html")!

    static func makeBridge(defaultRoot: URL) throws -> Bridge {
        let root = env["ZK_DATA_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) } ?? defaultRoot
        let boxes = try Boxes(root: root)
        let saved = env["ZK_BOX"] ?? UserDefaults.standard.string(forKey: "currentBox")
        let name = saved.flatMap { boxes.exists($0) ? $0 : nil } ?? boxes.list().first ?? Boxes.defaultName
        return try Bridge(boxes: boxes, name: name)
    }

    static func configuration(for bridge: Bridge) -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(BundleSchemeHandler(root: Bundle.main.resourceURL!.appendingPathComponent("web")), forURLScheme: "zk")
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "zk")
        return config
    }

    /// Links that stay inside the app; everything else opens in the default browser.
    static func isAppURL(_ url: URL) -> Bool {
        ["zk", "about", "blob", "data"].contains(url.scheme ?? "")
    }

    static var isSelfTest: Bool { env["ZK_SELFTEST"] != nil }

    private static var selfTestStarted = false

    /// Call from webView(_:didFinish:). Runs the self-test once, prints its result and exits.
    static func runSelfTestIfRequested(in webView: WKWebView) {
        guard let path = env["ZK_SELFTEST"], !selfTestStarted else { return }
        selfTestStarted = true
        guard let js = try? String(contentsOfFile: path, encoding: .utf8) else {
            print("SELFTEST ERROR: cannot read \(path)")
            exit(2)
        }
        webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
            let (text, code): (String, Int32)
            switch result {
            case .success(let value): (text, code) = ("\(value)", 0)
            case .failure(let error): (text, code) = ("SELFTEST ERROR: \(error)", 1)
            }
            // ZK_SELFTEST_OUT: also write the result to a file (the iOS simulator has no usable stdout)
            if let out = env["ZK_SELFTEST_OUT"] { try? text.write(toFile: out, atomically: true, encoding: .utf8) }
            print(text)
            exit(code)
        }
    }
}
