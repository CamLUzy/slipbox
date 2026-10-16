// LAN sync (docs/SYNC.md), shared by the macOS and iOS apps. The Windows app implements the
// same protocol in src-tauri/src/sync.rs.
//
// While the page's “设备与同步” screen is open, the app listens on TCP and announces itself over
// Bonjour as _slipbox._tcp. The device where the user taps 同步 connects to the other one (the
// host), both run a Noise_XX handshake and every message after that is encrypted. The page on
// the connecting side merges (web/js/merge.js); the host only answers hello/read/write requests
// for its slip boxes, and only from devices the user has paired by comparing a 6-digit code.
//
// Wire format: each Noise message is sent as a 2-byte big-endian length plus the message. An
// application message (UTF-8 JSON) is split into chunks; each chunk is one transport message
// whose plaintext is one flag byte (1 = more chunks follow) plus up to 60000 bytes.
import CryptoKit
import Foundation
import Network

enum SyncError: LocalizedError {
    case closed, tooLarge, busy, message(String)
    var errorDescription: String? {
        switch self {
        case .closed: return "连接已断开"
        case .tooLarge: return "消息太大"
        case .busy: return "对方正在和另一台设备同步"
        case .message(let m): return m
        }
    }
}

private func jsonString(_ obj: Any) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes])) ?? Data("{}".utf8)
    return String(decoding: data, as: UTF8.self)
}

private func jsonObject(_ text: String) -> [String: Any]? {
    (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
}

private let nowMs = { Int64(Date().timeIntervalSince1970 * 1000) }

// MARK: - Identity and paired devices (<data>/sync.json)

struct SyncPeer {
    var id: String
    var name: String
    var platform: String
    var key: String // base64 Curve25519 public key
    var json: [String: Any] { ["id": id, "name": name, "platform": platform, "key": key] }
}

final class SyncIdentity {
    let file: URL
    private(set) var deviceId: String
    private(set) var name: String
    let platform: String
    let privateKey: Curve25519.KeyAgreement.PrivateKey
    private(set) var peers: [SyncPeer]

    init(file: URL, defaultName: String, platform: String) {
        self.file = file
        self.platform = platform
        let saved = (try? String(contentsOf: file, encoding: .utf8)).flatMap(jsonObject) ?? [:]
        deviceId = saved["deviceId"] as? String ?? UUID().uuidString.lowercased()
        name = ZKApp.env["ZK_DEVICE_NAME"] ?? saved["name"] as? String ?? defaultName
        privateKey = (saved["key"] as? String).flatMap { Data(base64Encoded: $0) }
            .flatMap { try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: $0) } ?? Curve25519.KeyAgreement.PrivateKey()
        peers = (saved["peers"] as? [[String: Any]] ?? []).compactMap { p in
            guard let id = p["id"] as? String, let key = p["key"] as? String else { return nil }
            return SyncPeer(id: id, name: p["name"] as? String ?? "", platform: p["platform"] as? String ?? "", key: key)
        }
        if saved["deviceId"] == nil { save() }
    }

    var publicKey: String { privateKey.publicKey.rawRepresentation.base64EncodedString() }
    var info: [String: Any] { ["id": deviceId, "name": name, "platform": platform] }

    func save() {
        let obj: [String: Any] = ["deviceId": deviceId, "name": name, "key": privateKey.rawRepresentation.base64EncodedString(),
                                  "peers": peers.map(\.json)]
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? jsonString(obj).write(to: file, atomically: true, encoding: .utf8)
    }

    func rename(_ newName: String) {
        name = newName
        save()
    }

    func peer(_ id: String) -> SyncPeer? { peers.first { $0.id == id } }

    func remember(_ p: SyncPeer) {
        peers.removeAll { $0.id == p.id }
        peers.append(p)
        save()
    }

    func forget(_ id: String) {
        peers.removeAll { $0.id == id }
        save()
    }
}

// MARK: - Slip box requests (answered for the page itself and for paired devices)

enum SyncOps {
    /// hello / read / write. `peer` is the other device (whose last sync time is kept per box).
    /// Returns the reply and the box whose cards changed, if any.
    static func handle(_ msg: [String: Any], peer: String, boxes: Boxes, identity: SyncIdentity) throws -> (String, String?) {
        let op = msg["op"] as? String ?? ""
        let box = msg["box"] as? String ?? ""
        switch op {
        case "hello":
            let list: [[String: Any]] = try boxes.list().map { name in
                let db = try Database(fileURL: boxes.file(name))
                defer { db.close() }
                return ["name": name, "boxId": try db.boxId(), "cards": db.count()]
            }
            return (jsonString(["ok": true, "device": identity.info, "boxes": list]), nil)
        case "read":
            guard boxes.exists(box) else { throw SyncError.message("找不到卡片盒“\(box)”") }
            let db = try Database(fileURL: boxes.file(box))
            defer { db.close() }
            let last = Int64(db.meta("sync.\(peer)") ?? "") ?? 0
            // the cards are spliced in as stored, without parsing them
            let head = jsonString(["ok": true, "boxId": try db.boxId(), "lastSync": last])
            return (head.dropLast() + ",\"purged\":\(try db.purgedJSON()),\"cards\":\(try db.loadAll())}", nil)
        case "write":
            if !boxes.exists(box) {
                guard msg["create"] as? Bool == true else { throw SyncError.message("找不到卡片盒“\(box)”") }
                guard Boxes.isValid(box) else { throw SyncError.message(Bridge.badName) }
            }
            let db = try Database(fileURL: boxes.file(box))
            defer { db.close() }
            // a backup before every sync that changes something
            let cards = msg["cards"] as? [[String: Any]] ?? []
            let purged = msg["purged"] as? [[String: Any]] ?? []
            if db.count() > 0 && (!cards.isEmpty || !purged.isEmpty) {
                try FileManager.default.createDirectory(at: boxes.backupDir(box), withIntermediateDirectories: true)
                try Backups(dir: boxes.backupDir(box), db: db).make()
            }
            if !cards.isEmpty { try db.put(json: jsonString(cards)) }
            if !purged.isEmpty {
                var times: [String: Int64] = [:]
                for t in purged { if let uid = t["uid"] as? String { times[uid] = (t["at"] as? NSNumber)?.int64Value ?? nowMs() } }
                try db.delete(uids: Array(times.keys), at: times)
            }
            if let id = msg["boxId"] as? String, !id.isEmpty { try db.setMeta("boxId", id) }
            if let at = msg["syncedAt"] as? NSNumber { try db.setMeta("sync.\(peer)", "\(at.int64Value)") }
            return (jsonString(["ok": true]), cards.isEmpty && purged.isEmpty ? nil : box)
        default:
            throw SyncError.message("unknown op \(op)")
        }
    }
}

// MARK: - Encrypted channel

private final class Once: @unchecked Sendable {
    private var done = false
    func run(_ f: () -> Void) {
        if !done { done = true; f() }
    }
}

final class SyncChannel {
    let conn: NWConnection
    private let queue: DispatchQueue
    private var send = NoiseCipher()
    private var receive = NoiseCipher()
    private(set) var remote: [String: Any] = [:]
    private(set) var remoteKey = ""
    private(set) var code = ""
    static let prologue = Data("slipbox-sync-v1".utf8)
    static let maxMessage = 64 << 20

    init(_ conn: NWConnection, queue: DispatchQueue) {
        self.conn = conn
        self.queue = queue
    }

    func start(timeout: TimeInterval = 10) async throws {
        let conn = self.conn
        queue.asyncAfter(deadline: .now() + timeout) { if conn.state != .ready { conn.cancel() } }
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            let once = Once() // state updates arrive on `queue`, one at a time
            conn.stateUpdateHandler = { state in
                switch state {
                case .ready: once.run { cont.resume() }
                case .failed(let e), .waiting(let e): once.run { conn.cancel(); cont.resume(throwing: e) }
                case .cancelled: once.run { cont.resume(throwing: SyncError.closed) }
                default: break
                }
            }
            conn.start(queue: queue)
        }
    }

    func close() { conn.cancel() }

    private func read(_ n: Int) async throws -> Data {
        guard n > 0 else { return Data() }
        return try await withCheckedThrowingContinuation { cont in
            conn.receive(minimumIncompleteLength: n, maximumLength: n) { data, _, _, error in
                if let error { return cont.resume(throwing: error) }
                guard let data, data.count == n else { return cont.resume(throwing: SyncError.closed) }
                cont.resume(returning: data)
            }
        }
    }

    private func write(_ data: Data) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            conn.send(content: data, completion: .contentProcessed { error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            })
        }
    }

    private func readFrame() async throws -> Data {
        let len = try await read(2)
        return try await read(Int(len[0]) << 8 | Int(len[1]))
    }

    private func writeFrame(_ data: Data) async throws {
        try await write(Data([UInt8(data.count >> 8), UInt8(data.count & 0xff)]) + data)
    }

    /// Runs the handshake; `me` is this device's info, sent encrypted to the other side.
    func handshake(initiator: Bool, key: Curve25519.KeyAgreement.PrivateKey, me: [String: Any]) async throws {
        var hs = NoiseHandshake(initiator: initiator, staticKey: key, prologue: Self.prologue)
        let payload = Data(jsonString(me).utf8)
        let theirs: Data
        if initiator {
            try await writeFrame(try hs.write())
            theirs = try hs.read(try await readFrame())
            try await writeFrame(try hs.write(payload))
        } else {
            _ = try hs.read(try await readFrame())
            try await writeFrame(try hs.write(payload))
            theirs = try hs.read(try await readFrame())
        }
        (send, receive) = hs.split()
        remote = (try? JSONSerialization.jsonObject(with: theirs)) as? [String: Any] ?? [:]
        remoteKey = hs.rs?.rawRepresentation.base64EncodedString() ?? ""
        code = pairingCode(hs.handshakeHash)
    }

    func sendMessage(_ text: String) async throws {
        let data = Data(text.utf8)
        guard data.count <= Self.maxMessage else { throw SyncError.tooLarge }
        var offset = 0
        repeat {
            let end = min(offset + 60000, data.count)
            let flag: UInt8 = end < data.count ? 1 : 0
            try await writeFrame(try send.encrypt(Data([flag]) + data[offset..<end]))
            offset = end
        } while offset < data.count
    }

    func receiveMessage() async throws -> String {
        var out = Data()
        while true {
            let plain = try receive.decrypt(try await readFrame())
            guard let flag = plain.first else { throw SyncError.closed }
            out += plain.dropFirst()
            guard out.count <= Self.maxMessage else { throw SyncError.tooLarge }
            if flag == 0 { return String(decoding: out, as: UTF8.self) }
        }
    }

    func request(_ text: String) async throws -> String {
        try await sendMessage(text)
        return try await receiveMessage()
    }
}

// MARK: - Service: listening, discovery, sessions

@MainActor
final class SyncService {
    static let serviceType = "_slipbox._tcp"
    static let defaultPort: UInt16 = 51515

    let boxes: Boxes
    let identity: SyncIdentity
    /// Sends an event object to the page (window.zkSyncEvent).
    var emit: ([String: Any]) -> Void = { _ in }
    /// The page's current box changed through a sync.
    var currentBoxChanged: (String) -> Void = { _ in }
    var currentBox: () -> String = { "" }

    private let queue = DispatchQueue(label: "slipbox.sync")
    private var listener: NWListener?
    private var browser: NWBrowser?
    private var found: [String: (endpoint: NWEndpoint, name: String, platform: String)] = [:]
    private var sessions: [String: SyncChannel] = [:]
    private var hosting: SyncChannel?
    private var prompts: [String: CheckedContinuation<Bool, Never>] = [:]
    private(set) var port: UInt16 = 0
    private var fixedPortFailed = false
    /// Why Bonjour does not work, e.g. no local network permission (shown on the page).
    private var browseProblem: String?

    init(boxes: Boxes, defaultName: String, platform: String) {
        self.boxes = boxes
        identity = SyncIdentity(file: boxes.root.appendingPathComponent("sync.json"), defaultName: defaultName, platform: platform)
    }

    /// The page's `sync` command. Replies with a JSON string, or throws.
    func command(_ body: [String: Any]) async throws -> String {
        let op = body["op"] as? String ?? ""
        switch op {
        case "state":
            return jsonString(state())
        case "start":
            try start()
            return jsonString(state())
        case "stop":
            stop()
            return jsonString(["ok": true])
        case "rename":
            let name = (body["name"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, name.count <= 40 else { throw SyncError.message("设备名称不能为空，最多 40 个字") }
            identity.rename(name)
            if listener != nil { stop(); try start() }
            return jsonString(state())
        case "forget":
            identity.forget(body["id"] as? String ?? "")
            return jsonString(state())
        case "answer":
            if let id = body["id"] as? String, let cont = prompts.removeValue(forKey: id) { cont.resume(returning: body["ok"] as? Bool ?? false) }
            return jsonString(["ok": true])
        case "connect":
            return try await connect(peerId: body["peer"] as? String, address: body["address"] as? String)
        case "request":
            guard let ch = sessions[body["session"] as? String ?? ""] else { throw SyncError.closed }
            return try await ch.request(body["msg"] as? String ?? "{}")
        case "trust":
            // after both users confirmed the pairing code
            guard let ch = sessions[body["session"] as? String ?? ""] else { throw SyncError.closed }
            identity.remember(SyncPeer(id: ch.remote["id"] as? String ?? "", name: ch.remote["name"] as? String ?? "",
                                       platform: ch.remote["platform"] as? String ?? "", key: ch.remoteKey))
            return jsonString(state())
        case "close":
            if let ch = sessions.removeValue(forKey: body["session"] as? String ?? "") {
                try? await ch.sendMessage(jsonString(["op": "bye"]))
                ch.close()
            }
            return jsonString(["ok": true])
        case "local":
            let msg = jsonObject(body["msg"] as? String ?? "") ?? [:]
            return try await runOps(msg, peer: msg["peer"] as? String ?? "")
        default:
            throw SyncError.message("unknown sync op \(op)")
        }
    }

    private func state() -> [String: Any] {
        [
            "device": identity.info,
            "listening": listener != nil,
            "port": Int(port),
            "addresses": Self.localAddresses(),
            "paired": identity.peers.map { ["id": $0.id, "name": $0.name, "platform": $0.platform] },
            "nearby": nearby(),
            "problem": browseProblem ?? "",
        ]
    }

    private func nearby() -> [[String: Any]] {
        found.map { id, f in ["id": id, "name": f.name, "platform": f.platform, "paired": identity.peer(id) != nil] }
            .sorted { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
    }

    private func runOps(_ msg: [String: Any], peer: String) async throws -> String {
        let boxes = self.boxes, identity = self.identity
        let (reply, changed) = try await Task.detached {
            try SyncOps.handle(msg, peer: peer, boxes: boxes, identity: identity)
        }.value
        if let changed, changed == currentBox() { currentBoxChanged(changed) }
        return reply
    }

    // MARK: listening and discovery

    func start() throws {
        guard listener == nil else { return }
        let wanted = fixedPortFailed ? 0 : UInt16(ZKApp.env["ZK_SYNC_PORT"] ?? "") ?? Self.defaultPort
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        let l: NWListener
        if wanted != 0, let p = NWEndpoint.Port(rawValue: wanted), let fixed = try? NWListener(using: params, on: p) {
            l = fixed
        } else {
            l = try NWListener(using: params)
        }
        let bonjour = ZKApp.env["ZK_SYNC_NO_BONJOUR"] == nil
        if bonjour {
            var txt = NWTXTRecord()
            txt["id"] = identity.deviceId
            txt["n"] = identity.name
            txt["p"] = identity.platform
            txt["v"] = "1"
            l.service = NWListener.Service(name: identity.name, type: Self.serviceType, domain: nil, txtRecord: txt)
        }
        l.newConnectionHandler = { [weak self] conn in
            Task { @MainActor in self?.accept(conn) }
        }
        l.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                guard let self else { return }
                if case .ready = state { self.port = l.port?.rawValue ?? 0; self.emitState() }
                guard case .failed(let e) = state, self.listener === l else { return }
                if wanted != 0 {
                    // the usual port is taken (another app, or a moment after the last run): any port will do
                    self.fixedPortFailed = true
                    self.stop()
                    try? self.start()
                } else {
                    self.emit(["type": "error", "message": "无法监听：\(e.localizedDescription)"])
                }
            }
        }
        l.start(queue: queue)
        listener = l
        if bonjour { browse() }
    }

    func stop() {
        listener?.cancel()
        listener = nil
        browser?.cancel()
        browser = nil
        found = [:]
        port = 0
        browseProblem = nil
        for (_, cont) in prompts { cont.resume(returning: false) }
        prompts = [:]
    }

    private func emitState() {
        emit(["type": "state", "state": state()])
    }

    private func browse() {
        let b = NWBrowser(for: .bonjourWithTXTRecord(type: Self.serviceType, domain: nil), using: .tcp)
        b.browseResultsChangedHandler = { [weak self] results, _ in
            var next: [String: (endpoint: NWEndpoint, name: String, platform: String)] = [:]
            for r in results {
                guard case .bonjour(let txt) = r.metadata, let id = txt["id"] else { continue }
                var name = txt["n"] ?? ""
                if name.isEmpty, case .service(let n, _, _, _) = r.endpoint { name = n }
                next[id] = (r.endpoint, name, txt["p"] ?? "")
            }
            Task { @MainActor in
                guard let self else { return }
                next.removeValue(forKey: self.identity.deviceId)
                self.found = next
                self.emitState()
            }
        }
        b.stateUpdateHandler = { [weak self] state in
            let problem: String?
            switch state {
            case .failed(let e), .waiting(let e): problem = "\(e)"
            default: problem = nil
            }
            Task { @MainActor in
                guard let self else { return }
                self.browseProblem = problem
                self.emitState()
            }
        }
        b.start(queue: queue)
        browser = b
    }

    // MARK: connecting (this device taps 同步)

    private func connect(peerId: String?, address: String?) async throws -> String {
        let endpoint: NWEndpoint
        if let peerId, let f = found[peerId] {
            endpoint = f.endpoint
        } else if let address, let ep = Self.endpoint(address) {
            endpoint = ep
        } else {
            throw SyncError.message("找不到这台设备，请确认它也打开了“设备与同步”")
        }
        let ch = SyncChannel(NWConnection(to: endpoint, using: .tcp), queue: queue)
        do {
            try await ch.start()
            try await ch.handshake(initiator: true, key: identity.privateKey, me: identity.info)
        } catch {
            ch.close()
            throw SyncError.message("连接失败：\(error.localizedDescription)")
        }
        let id = ch.remote["id"] as? String ?? ""
        if let known = identity.peer(id), known.key != ch.remoteKey {
            ch.close()
            throw SyncError.message("“\(known.name)”的密钥变了。如果它重装过卡片盒，请先在已配对设备里移除它，再重新配对。")
        }
        let session = UUID().uuidString
        sessions[session] = ch
        return jsonString(["session": session, "code": ch.code, "peer": ch.remote, "paired": identity.peer(id) != nil])
    }

    static func endpoint(_ address: String) -> NWEndpoint? {
        let a = address.trimmingCharacters(in: .whitespaces)
        guard let i = a.lastIndex(of: ":"), let port = NWEndpoint.Port(String(a[a.index(after: i)...])) else {
            return NWEndpoint.Port(rawValue: defaultPort).map { .hostPort(host: NWEndpoint.Host(a), port: $0) }
        }
        let host = a[..<i].trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        return host.isEmpty ? nil : .hostPort(host: NWEndpoint.Host(host), port: port)
    }

    // MARK: hosting (the other device tapped 同步)

    private func accept(_ conn: NWConnection) {
        let ch = SyncChannel(conn, queue: queue)
        guard hosting == nil else {
            conn.start(queue: queue)
            conn.cancel()
            return
        }
        hosting = ch
        Task { @MainActor in
            await self.serve(ch)
            if self.hosting === ch { self.hosting = nil }
        }
    }

    private func serve(_ ch: SyncChannel) async {
        defer { ch.close() }
        do {
            try await ch.start()
            try await ch.handshake(initiator: false, key: identity.privateKey, me: identity.info)
        } catch {
            return
        }
        let peer = SyncPeer(id: ch.remote["id"] as? String ?? "", name: ch.remote["name"] as? String ?? "另一台设备",
                            platform: ch.remote["platform"] as? String ?? "", key: ch.remoteKey)
        var confirmed = false
        var announced = false
        while true {
            guard let text = try? await ch.receiveMessage() else { break }
            let msg = jsonObject(text) ?? [:]
            let op = msg["op"] as? String ?? ""
            var reply: String
            switch op {
            case "bye":
                if announced { emit(["type": "hostDone", "peer": peer.json]) }
                return
            case "pair":
                let id = UUID().uuidString
                emit(["type": "pair", "id": id, "code": ch.code, "peer": ["id": peer.id, "name": peer.name, "platform": peer.platform]])
                confirmed = await withCheckedContinuation { cont in
                    prompts[id] = cont
                    queue.asyncAfter(deadline: .now() + 120) {
                        Task { @MainActor in self.prompts.removeValue(forKey: id)?.resume(returning: false) }
                    }
                }
                emit(["type": "pairEnd", "id": id])
                let answer: [String: Any] = confirmed ? ["ok": true] : ["ok": false, "code": "rejected", "error": "对方没有确认配对"]
                reply = jsonString(answer)
            case "paired":
                if confirmed {
                    identity.remember(peer)
                    emitState()
                    reply = jsonString(["ok": true])
                } else {
                    reply = jsonString(["ok": false, "code": "rejected"])
                }
            default:
                guard let known = identity.peer(peer.id), known.key == peer.key else {
                    reply = jsonString(["ok": false, "code": "unpaired", "error": "这两台设备还没有配对"])
                    break
                }
                if !announced {
                    announced = true
                    emit(["type": "hostStart", "peer": peer.json])
                }
                do {
                    reply = try await runOps(msg, peer: peer.id)
                } catch {
                    reply = jsonString(["ok": false, "error": error.localizedDescription])
                }
            }
            do { try await ch.sendMessage(reply) } catch { break }
        }
        if announced { emit(["type": "hostDone", "peer": peer.json]) }
    }

    // MARK: addresses shown for connecting by hand

    static func localAddresses() -> [String] {
        var out: [String] = []
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return out }
        defer { freeifaddrs(list) }
        for p in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let ifa = p.pointee
            guard let sa = ifa.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET),
                  (ifa.ifa_flags & UInt32(IFF_UP)) != 0, (ifa.ifa_flags & UInt32(IFF_LOOPBACK)) == 0 else { continue }
            let name = String(cString: ifa.ifa_name)
            guard name.hasPrefix("en") || name.hasPrefix("bridge") else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                out.append(String(cString: host))
            }
        }
        return out
    }
}
