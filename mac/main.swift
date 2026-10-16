// 卡片盒 — native macOS shell.
// Shows the web UI from the app bundle (Resources/web) in a WKWebView and stores the
// cards in SQLite at ~/Library/Application Support/卡片盒/zettel.db.
// Build with mac/build.sh (only the Xcode Command Line Tools are needed).
import Cocoa
import SQLite3
import WebKit

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

struct AppError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

// MARK: - Database

final class Database {
    let fileURL: URL
    private var db: OpaquePointer?

    init(fileURL: URL) throws {
        self.fileURL = fileURL
        guard sqlite3_open(fileURL.path, &db) == SQLITE_OK else { throw AppError(message: "无法打开数据库 \(fileURL.path)") }
        try exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")
        // `data` holds the full card as JSON; the other columns keep the file readable by other tools.
        try exec("""
            CREATE TABLE IF NOT EXISTS cards (
              uid        TEXT PRIMARY KEY,
              zid        TEXT,
              kind       TEXT NOT NULL,
              title      TEXT NOT NULL DEFAULT '',
              body       TEXT NOT NULL DEFAULT '',
              keywords   TEXT NOT NULL DEFAULT '[]',
              deleted    INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL DEFAULT 0,
              updated_at INTEGER NOT NULL DEFAULT 0,
              data       TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS cards_zid ON cards(kind, zid);
            """)
    }

    deinit { close() }

    func close() {
        if db != nil { sqlite3_close(db) }
        db = nil
    }

    private var lastError: String { String(cString: sqlite3_errmsg(db)) }

    func exec(_ sql: String) throws {
        var err: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &err) != SQLITE_OK {
            let msg = err.map { String(cString: $0) } ?? lastError
            sqlite3_free(err)
            throw AppError(message: msg)
        }
    }

    private func prepare(_ sql: String) throws -> OpaquePointer? {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { throw AppError(message: lastError) }
        return stmt
    }

    /// All cards as one JSON array string.
    func loadAll() throws -> String {
        let stmt = try prepare("SELECT data FROM cards")
        defer { sqlite3_finalize(stmt) }
        var parts: [String] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            parts.append(String(cString: sqlite3_column_text(stmt, 0)))
        }
        return "[" + parts.joined(separator: ",") + "]"
    }

    func count() -> Int {
        guard let stmt = try? prepare("SELECT COUNT(*) FROM cards") else { return 0 }
        defer { sqlite3_finalize(stmt) }
        return sqlite3_step(stmt) == SQLITE_ROW ? Int(sqlite3_column_int64(stmt, 0)) : 0
    }

    func put(json: String) throws {
        guard let cards = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [[String: Any]] else {
            throw AppError(message: "卡片数据格式不正确")
        }
        let stmt = try prepare("""
            INSERT INTO cards (uid, zid, kind, title, body, keywords, deleted, created_at, updated_at, data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(uid) DO UPDATE SET zid = excluded.zid, kind = excluded.kind, title = excluded.title,
              body = excluded.body, keywords = excluded.keywords, deleted = excluded.deleted,
              created_at = excluded.created_at, updated_at = excluded.updated_at, data = excluded.data
            """)
        defer { sqlite3_finalize(stmt) }
        try exec("BEGIN IMMEDIATE")
        do {
            for card in cards {
                guard let uid = card["uid"] as? String else { continue }
                let data = try JSONSerialization.data(withJSONObject: card, options: [.withoutEscapingSlashes])
                let keywords = try JSONSerialization.data(withJSONObject: card["keywords"] as? [String] ?? [])
                sqlite3_reset(stmt)
                sqlite3_bind_text(stmt, 1, uid, -1, SQLITE_TRANSIENT)
                if let zid = card["zid"] as? String { sqlite3_bind_text(stmt, 2, zid, -1, SQLITE_TRANSIENT) } else { sqlite3_bind_null(stmt, 2) }
                sqlite3_bind_text(stmt, 3, card["kind"] as? String ?? "fleeting", -1, SQLITE_TRANSIENT)
                sqlite3_bind_text(stmt, 4, card["title"] as? String ?? "", -1, SQLITE_TRANSIENT)
                sqlite3_bind_text(stmt, 5, card["body"] as? String ?? "", -1, SQLITE_TRANSIENT)
                sqlite3_bind_text(stmt, 6, String(decoding: keywords, as: UTF8.self), -1, SQLITE_TRANSIENT)
                sqlite3_bind_int(stmt, 7, (card["deleted"] as? Bool ?? false) ? 1 : 0)
                sqlite3_bind_int64(stmt, 8, (card["createdAt"] as? NSNumber)?.int64Value ?? 0)
                sqlite3_bind_int64(stmt, 9, (card["updatedAt"] as? NSNumber)?.int64Value ?? 0)
                sqlite3_bind_text(stmt, 10, String(decoding: data, as: UTF8.self), -1, SQLITE_TRANSIENT)
                guard sqlite3_step(stmt) == SQLITE_DONE else { throw AppError(message: lastError) }
            }
            try exec("COMMIT")
        } catch {
            try? exec("ROLLBACK")
            throw error
        }
    }

    func delete(uids: [String]) throws {
        let stmt = try prepare("DELETE FROM cards WHERE uid = ?")
        defer { sqlite3_finalize(stmt) }
        try exec("BEGIN IMMEDIATE")
        for uid in uids {
            sqlite3_reset(stmt)
            sqlite3_bind_text(stmt, 1, uid, -1, SQLITE_TRANSIENT)
            sqlite3_step(stmt)
        }
        try exec("COMMIT")
    }

    func backup(to url: URL) throws {
        try exec("VACUUM INTO '\(url.path.replacingOccurrences(of: "'", with: "''"))'")
    }
}

// MARK: - Slip boxes

/// Every slip box is its own SQLite file: <data>/boxes/<name>.db, with backups in <data>/backups/<name>/.
final class Boxes {
    let root: URL
    var dir: URL { root.appendingPathComponent("boxes", isDirectory: true) }
    static let defaultName = "我的卡片盒"

    init(root: URL) throws {
        self.root = root
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try migrateLegacy()
    }

    static func isValid(_ name: String) -> Bool {
        let n = name.trimmingCharacters(in: .whitespaces)
        return !n.isEmpty && n == name && n.count <= 60 && !n.hasPrefix(".") && n.rangeOfCharacter(from: CharacterSet(charactersIn: "/\\:")) == nil
    }

    func file(_ name: String) -> URL { dir.appendingPathComponent("\(name).db") }
    func backupDir(_ name: String) -> URL { root.appendingPathComponent("backups", isDirectory: true).appendingPathComponent(name, isDirectory: true) }
    func exists(_ name: String) -> Bool { FileManager.default.fileExists(atPath: file(name).path) }

    func list() -> [String] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        return names.filter { $0.hasSuffix(".db") }.map { String($0.dropLast(3)) }.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }

    /// Moves a database file together with its -wal/-shm companions.
    func moveFiles(from: URL, to: URL) throws {
        let fm = FileManager.default
        for suffix in ["", "-wal", "-shm"] {
            let a = URL(fileURLWithPath: from.path + suffix), b = URL(fileURLWithPath: to.path + suffix)
            if fm.fileExists(atPath: a.path) { try fm.moveItem(at: a, to: b) }
        }
    }

    /// Version 1 kept a single <data>/zettel.db; it becomes the default box.
    private func migrateLegacy() throws {
        let legacy = root.appendingPathComponent("zettel.db")
        guard FileManager.default.fileExists(atPath: legacy.path), list().isEmpty else { return }
        try moveFiles(from: legacy, to: file(Self.defaultName))
        let oldBackups = root.appendingPathComponent("backups", isDirectory: true)
        let items = (try? FileManager.default.contentsOfDirectory(atPath: oldBackups.path)) ?? []
        try FileManager.default.createDirectory(at: backupDir(Self.defaultName), withIntermediateDirectories: true)
        for f in items where f.hasPrefix("zettel-") && f.hasSuffix(".db") {
            try? FileManager.default.moveItem(at: oldBackups.appendingPathComponent(f), to: backupDir(Self.defaultName).appendingPathComponent(f))
        }
    }

    func count(_ name: String) -> Int {
        var db: OpaquePointer?
        guard sqlite3_open_v2(file(name).path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else { return 0 }
        defer { sqlite3_close(db) }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM cards WHERE deleted = 0", -1, &stmt, nil) == SQLITE_OK else { return 0 }
        defer { sqlite3_finalize(stmt) }
        return sqlite3_step(stmt) == SQLITE_ROW ? Int(sqlite3_column_int64(stmt, 0)) : 0
    }
}

// MARK: - Backups

final class Backups {
    let dir: URL
    let db: Database
    let keep = 30

    init(dir: URL, db: Database) {
        self.dir = dir
        self.db = db
    }

    func list() -> [String] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        return names.filter { $0.hasPrefix("zettel-") && $0.hasSuffix(".db") }.sorted(by: >)
    }

    @discardableResult
    func make() throws -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd-HHmmss"
        let name = "zettel-\(f.string(from: Date())).db"
        try db.backup(to: dir.appendingPathComponent(name))
        for old in list().dropFirst(keep) { try? FileManager.default.removeItem(at: dir.appendingPathComponent(old)) }
        return name
    }

    /// Once a day, and only when there is something to back up.
    func makeIfDue() {
        guard db.count() > 0 else { return }
        if let latest = list().first,
           let attrs = try? FileManager.default.attributesOfItem(atPath: dir.appendingPathComponent(latest).path),
           let date = attrs[.creationDate] as? Date, Date().timeIntervalSince(date) < 20 * 3600 { return }
        _ = try? make()
    }
}

// MARK: - Serving the web UI from the bundle

final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    let root: URL
    init(root: URL) { self.root = root.standardizedFileURL }

    private static let mime: [String: String] = [
        "html": "text/html", "js": "text/javascript", "css": "text/css", "json": "application/json",
        "svg": "image/svg+xml", "png": "image/png", "ico": "image/x-icon",
    ]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        let path = url.path.isEmpty || url.path == "/" ? "index.html" : String(url.path.dropFirst())
        let file = root.appendingPathComponent(path).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            task.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist))
            return
        }
        let type = Self.mime[file.pathExtension.lowercased()] ?? "application/octet-stream"
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "\(type); charset=utf-8", "Cache-Control": "no-cache"])!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

// MARK: - JavaScript bridge (window.webkit.messageHandlers.zk, see web/js/backend.js)

final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    let boxes: Boxes
    private(set) var boxName: String
    private(set) var db: Database
    private(set) var backups: Backups
    weak var window: NSWindow?
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
        if ProcessInfo.processInfo.environment["ZK_DATA_DIR"] == nil { UserDefaults.standard.set(name, forKey: "currentBox") }
    }

    private func boxCommand(_ cmd: String, _ body: [String: Any]) throws -> Any {
        let name = body["name"] as? String ?? ""
        switch cmd {
        case "boxes":
            let list = boxes.list().map { ["name": $0, "cards": $0 == boxName ? -1 : boxes.count($0)] as [String: Any] }
            return Self.jsonString(["current": boxName, "boxes": list])
        case "createBox":
            guard Boxes.isValid(name) else { throw AppError(message: "名称不能为空，也不能包含 / \\ : 或以 . 开头") }
            guard !boxes.exists(name) else { throw AppError(message: "已经有叫“\(name)”的卡片盒了") }
            try open(box: name)
            return true
        case "switchBox":
            guard boxes.exists(name) else { throw AppError(message: "找不到卡片盒“\(name)”") }
            try open(box: name)
            return true
        case "renameBox":
            let to = body["to"] as? String ?? ""
            guard Boxes.isValid(to) else { throw AppError(message: "名称不能为空，也不能包含 / \\ : 或以 . 开头") }
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
                if FileManager.default.fileExists(atPath: f.path) { try FileManager.default.trashItem(at: f, resultingItemURL: nil) }
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
                let data = try JSONSerialization.data(withJSONObject: info, options: [.withoutEscapingSlashes])
                replyHandler(String(decoding: data, as: UTF8.self), nil)
            case "backup":
                replyHandler(try backups.make(), nil)
            case "reveal":
                NSWorkspace.shared.activateFileViewerSelecting([db.fileURL])
                replyHandler(true, nil)
            case "saveFile":
                saveFile(name: body["name"] as? String ?? "export.json", content: body["content"] as? String ?? "") { replyHandler($0, $1) }
            case "openFile":
                openFile { replyHandler($0, $1) }
            case "ollama":
                ollama(body, reply: replyHandler)
            case "ollamaCancel":
                if let id = body["id"] as? String { ollamaTasks[id]?.cancel() }
                replyHandler(true, nil)
            case "startOllama":
                replyHandler(startOllama(), nil)
            case "exportFiles":
                exportFiles(folder: body["folder"] as? String ?? "卡片盒导出", json: body["files"] as? String ?? "[]") { replyHandler($0, $1) }
            default:
                replyHandler(nil, "unknown command \(cmd)")
            }
        } catch {
            replyHandler(nil, error.localizedDescription)
        }
    }

    private static func jsonString(_ obj: [String: Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    /// Proxy to the local Ollama server (avoids browser CORS rules). Only loopback hosts are
    /// allowed, so card contents never leave this Mac. Streamed responses are pushed line by
    /// line to window.zkStream(id, line); the reply carries {status, text} or {error}.
    private func ollama(_ body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        let id = body["id"] as? String ?? UUID().uuidString
        let base = body["base"] as? String ?? "http://127.0.0.1:11434"
        let path = body["path"] as? String ?? "/api/tags"
        guard let url = URL(string: base + path), ["127.0.0.1", "localhost", "::1"].contains(url.host ?? "") else {
            return reply(Self.jsonString(["error": "只允许连接本机上的 Ollama"]), nil)
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

    /// Opens the Ollama app (or `ollama serve`) in the background. Returns false if not installed.
    private func startOllama() -> Bool {
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

    private func present(_ panel: NSSavePanel, _ done: @escaping (Bool) -> Void) {
        if let window { panel.beginSheetModal(for: window) { done($0 == .OK) } } else { done(panel.runModal() == .OK) }
    }

    private func saveFile(name: String, content: String, reply: @escaping (Any?, String?) -> Void) {
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

    private func openFile(reply: @escaping (Any?, String?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        present(panel) { ok in
            guard ok, let url = panel.url else { return reply(nil, nil) }
            do { reply(try String(contentsOf: url, encoding: .utf8), nil) } catch { reply(nil, error.localizedDescription) }
        }
    }

    private func exportFiles(folder: String, json: String, reply: @escaping (Any?, String?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.prompt = "导出到这里"
        panel.message = "选择导出位置，会在其中新建文件夹“\(folder)”"
        present(panel) { ok in
            guard ok, let base = panel.url else { return reply(nil, nil) }
            do {
                let files = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [[String: String]] ?? []
                var dir = base.appendingPathComponent(folder)
                var i = 2
                while FileManager.default.fileExists(atPath: dir.path) {
                    dir = base.appendingPathComponent("\(folder) \(i)")
                    i += 1
                }
                for f in files {
                    guard let rel = f["path"], !rel.contains(".."), let content = f["content"] else { continue }
                    let url = dir.appendingPathComponent(rel)
                    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try content.write(to: url, atomically: true, encoding: .utf8)
                }
                NSWorkspace.shared.activateFileViewerSelecting([dir])
                reply(dir.path, nil)
            } catch { reply(nil, error.localizedDescription) }
        }
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    // For development: ZK_DATA_DIR points at another data folder; ZK_SELFTEST runs a JS file
    // in the page (see tests/app-selftest.js), prints its result and quits without showing a window.
    let env = ProcessInfo.processInfo.environment
    var selfTestStarted = false
    var window: NSWindow!
    var webView: WKWebView!
    var bridge: Bridge!
    var titleObservation: NSKeyValueObservation?
    var backupTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dataDir = env["ZK_DATA_DIR"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? support.appendingPathComponent("卡片盒", isDirectory: true)
        do {
            let boxes = try Boxes(root: dataDir)
            let saved = env["ZK_BOX"] ?? UserDefaults.standard.string(forKey: "currentBox")
            let name = saved.flatMap { boxes.exists($0) ? $0 : nil } ?? boxes.list().first ?? Boxes.defaultName
            bridge = try Bridge(boxes: boxes, name: name)
        } catch {
            let alert = NSAlert(error: error)
            alert.messageText = "无法打开卡片盒数据"
            alert.runModal()
            NSApp.terminate(nil)
            return
        }

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(BundleSchemeHandler(root: Bundle.main.resourceURL!.appendingPathComponent("web")), forURLScheme: "zk")
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "zk")
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
        bridge.window = window
        bridge.webView = webView
        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] wv, _ in
            let t = wv.title ?? ""
            let box = self?.bridge.boxName ?? "卡片盒"
            self?.window.title = t.isEmpty || t == "卡片盒" ? box : "\(t) — \(box)"
        }

        buildMenu()
        webView.load(URLRequest(url: URL(string: "zk://app/index.html")!))
        if env["ZK_SELFTEST"] != nil { return }
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
        if let url = action.request.url, let scheme = url.scheme, !["zk", "about", "blob", "data"].contains(scheme) {
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
        guard let path = env["ZK_SELFTEST"], !selfTestStarted else { return }
        selfTestStarted = true
        guard let js = try? String(contentsOfFile: path, encoding: .utf8) else { print("SELFTEST: cannot read \(path)"); exit(2) }
        webView.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success(let value): print(value); exit(0)
            case .failure(let error): print("SELFTEST ERROR: \(error)"); exit(1)
            }
        }
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

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
