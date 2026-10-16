// Shared by the macOS app (mac/main.swift) and the iOS app (ios/Sources): the SQLite store,
// slip boxes, backups and serving the web UI from the app bundle.
import Foundation
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
        try exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;")
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
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS purged (uid TEXT PRIMARY KEY, at INTEGER NOT NULL);
            """)
        // meta: boxId (the same box on every device) and sync.<deviceId> (last sync with that device);
        // purged: tombstones of permanently deleted cards, so a sync does not bring them back.
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

    /// Permanently deletes cards and remembers them as purged (at: when, ms; default now).
    func delete(uids: [String], at times: [String: Int64] = [:]) throws {
        let del = try prepare("DELETE FROM cards WHERE uid = ?")
        defer { sqlite3_finalize(del) }
        let tomb = try prepare("INSERT OR REPLACE INTO purged (uid, at) VALUES (?, ?)")
        defer { sqlite3_finalize(tomb) }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        try exec("BEGIN IMMEDIATE")
        for uid in uids {
            sqlite3_reset(del)
            sqlite3_bind_text(del, 1, uid, -1, SQLITE_TRANSIENT)
            sqlite3_step(del)
            sqlite3_reset(tomb)
            sqlite3_bind_text(tomb, 1, uid, -1, SQLITE_TRANSIENT)
            sqlite3_bind_int64(tomb, 2, times[uid] ?? now)
            sqlite3_step(tomb)
        }
        try exec("COMMIT")
    }

    /// Tombstones as a JSON array [{uid, at}].
    func purgedJSON() throws -> String {
        let stmt = try prepare("SELECT uid, at FROM purged")
        defer { sqlite3_finalize(stmt) }
        var list: [[String: Any]] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            list.append(["uid": String(cString: sqlite3_column_text(stmt, 0)), "at": sqlite3_column_int64(stmt, 1)])
        }
        return String(decoding: try JSONSerialization.data(withJSONObject: list), as: UTF8.self)
    }

    func meta(_ key: String) -> String? {
        guard let stmt = try? prepare("SELECT value FROM meta WHERE key = ?") else { return nil }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, key, -1, SQLITE_TRANSIENT)
        return sqlite3_step(stmt) == SQLITE_ROW ? String(cString: sqlite3_column_text(stmt, 0)) : nil
    }

    func setMeta(_ key: String, _ value: String) throws {
        let stmt = try prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_text(stmt, 1, key, -1, SQLITE_TRANSIENT)
        sqlite3_bind_text(stmt, 2, value, -1, SQLITE_TRANSIENT)
        guard sqlite3_step(stmt) == SQLITE_DONE else { throw AppError(message: lastError) }
    }

    /// The box's identity across devices, created on first use.
    func boxId() throws -> String {
        if let id = meta("boxId") { return id }
        let id = UUID().uuidString.lowercased()
        try setMeta("boxId", id)
        return id
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

    /// Names must also be valid file names on Windows, so boxes can move between systems.
    static func isValid(_ name: String) -> Bool {
        let reserved = Set(["CON", "PRN", "AUX", "NUL"] + (1...9).flatMap { ["COM\($0)", "LPT\($0)"] })
        let bad = CharacterSet(charactersIn: "/\\:*?\"<>|").union(.controlCharacters)
        return !name.isEmpty && name.trimmingCharacters(in: .whitespaces) == name && name.count <= 60
            && !name.hasPrefix(".") && !name.hasSuffix(".")
            && name.rangeOfCharacter(from: bad) == nil && !reserved.contains(name.uppercased())
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
