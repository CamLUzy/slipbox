//! LAN sync (docs/SYNC.md) for the Windows app. The same protocol as apple/Shared/Sync.swift,
//! so a PC, a Mac and an iPhone can sync with each other.
//!
//! While the page's “设备与同步” screen is open, the app listens on TCP and announces itself over
//! mDNS as _slipbox._tcp. The device where the user taps 同步 connects to the other one (the
//! host), both run a Noise_XX_25519_ChaChaPoly_SHA256 handshake (prologue "slipbox-sync-v1")
//! and every message after that is encrypted. The page on the connecting side merges
//! (web/js/merge.js); the host only answers hello/read/write requests, and only from devices
//! the user paired by comparing a 6-digit code.
//!
//! Wire format: each Noise message is a 2-byte big-endian length plus the message. An
//! application message (UTF-8 JSON) is split into chunks; each chunk is one transport message
//! whose plaintext is one flag byte (1 = more chunks follow) plus up to 60000 bytes.

use crate::{err, make_backup, Boxes, Database, Res, BAD_NAME};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use snow::{Builder, TransportState};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{IpAddr, Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

const SERVICE_TYPE: &str = "_slipbox._tcp.local.";
const NOISE: &str = "Noise_XX_25519_ChaChaPoly_SHA256";
const PROLOGUE: &[u8] = b"slipbox-sync-v1";
const DEFAULT_PORT: u16 = 51515;
const MAX_MESSAGE: usize = 64 << 20;
const CHUNK: usize = 60000;

pub fn random_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "mac"
    } else {
        "linux"
    }
}

// ---------- identity and paired devices (<data>/sync.json) ----------

#[derive(Clone)]
struct Peer {
    id: String,
    name: String,
    platform: String,
    key: String, // base64 Curve25519 public key
}

impl Peer {
    fn json(&self) -> Value {
        json!({ "id": self.id, "name": self.name, "platform": self.platform, "key": self.key })
    }

    fn from_remote(remote: &Value, key: &str) -> Self {
        let s = |k: &str| remote[k].as_str().unwrap_or("").to_string();
        Peer { id: s("id"), name: s("name"), platform: s("platform"), key: key.to_string() }
    }
}

struct Identity {
    file: PathBuf,
    device_id: String,
    name: String,
    private: [u8; 32],
    peers: Vec<Peer>,
}

impl Identity {
    fn load(file: PathBuf) -> Self {
        let saved: Value = fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}));
        let private = saved["key"]
            .as_str()
            .and_then(|k| B64.decode(k).ok())
            .and_then(|k| <[u8; 32]>::try_from(k.as_slice()).ok())
            .unwrap_or_else(|| {
                let kp = Builder::new(NOISE.parse().unwrap()).generate_keypair().expect("keypair");
                kp.private.as_slice().try_into().expect("32 bytes")
            });
        let default_name = std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "Windows 电脑".into());
        let peers = saved["peers"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|p| {
                        Some(Peer {
                            id: p["id"].as_str()?.to_string(),
                            name: p["name"].as_str().unwrap_or("").to_string(),
                            platform: p["platform"].as_str().unwrap_or("").to_string(),
                            key: p["key"].as_str()?.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let fresh = saved["deviceId"].as_str().is_none();
        let id = Identity {
            file,
            device_id: saved["deviceId"].as_str().map(str::to_string).unwrap_or_else(random_id),
            name: std::env::var("ZK_DEVICE_NAME")
                .ok()
                .or_else(|| saved["name"].as_str().map(str::to_string))
                .unwrap_or(default_name),
            private,
            peers,
        };
        if fresh {
            id.save();
        }
        id
    }

    fn save(&self) {
        let obj = json!({
            "deviceId": self.device_id,
            "name": self.name,
            "key": B64.encode(self.private),
            "peers": self.peers.iter().map(Peer::json).collect::<Vec<_>>(),
        });
        let _ = fs::write(&self.file, obj.to_string());
    }

    fn info(&self) -> Value {
        json!({ "id": self.device_id, "name": self.name, "platform": platform() })
    }

    fn peer(&self, id: &str) -> Option<&Peer> {
        self.peers.iter().find(|p| p.id == id)
    }

    fn remember(&mut self, p: Peer) {
        self.peers.retain(|x| x.id != p.id);
        self.peers.push(p);
        self.save();
    }

    fn forget(&mut self, id: &str) {
        self.peers.retain(|x| x.id != id);
        self.save();
    }
}

#[cfg(test)]
fn public_key(private: &[u8; 32]) -> [u8; 32] {
    x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(*private)).to_bytes()
}

// ---------- slip box requests (for the page itself and for paired devices) ----------

/// hello / read / write. `peer` is the other device (whose last sync time is kept per box).
/// Returns the reply and the box whose cards changed, if any.
fn handle_op(msg: &Value, peer: &str, root: &PathBuf, me: &Value) -> Res<(String, Option<String>)> {
    let boxes = Boxes { root: root.clone() };
    let name = msg["box"].as_str().unwrap_or("").to_string();
    match msg["op"].as_str().unwrap_or("") {
        "hello" => {
            let mut list = Vec::new();
            for n in boxes.list() {
                let db = Database::open(&boxes.file(&n))?;
                list.push(json!({ "name": n, "boxId": db.box_id()?, "cards": db.count() }));
            }
            Ok((json!({ "ok": true, "device": me, "boxes": list }).to_string(), None))
        }
        "read" => {
            if !boxes.exists(&name) {
                return Err(format!("找不到卡片盒“{name}”"));
            }
            let db = Database::open(&boxes.file(&name))?;
            let last: i64 = db.meta(&format!("sync.{peer}")).and_then(|v| v.parse().ok()).unwrap_or(0);
            // the cards are spliced in as stored, without parsing them
            Ok((
                format!(
                    "{{\"ok\":true,\"boxId\":{},\"lastSync\":{last},\"purged\":{},\"cards\":{}}}",
                    Value::String(db.box_id()?),
                    db.purged_json()?,
                    db.load_all()?
                ),
                None,
            ))
        }
        "write" => {
            if !boxes.exists(&name) {
                if msg["create"].as_bool() != Some(true) {
                    return Err(format!("找不到卡片盒“{name}”"));
                }
                if !Boxes::is_valid(&name) {
                    return Err(BAD_NAME.into());
                }
            }
            let mut db = Database::open(&boxes.file(&name))?;
            let cards = msg["cards"].as_array().cloned().unwrap_or_default();
            let purged = msg["purged"].as_array().cloned().unwrap_or_default();
            let changes = !cards.is_empty() || !purged.is_empty();
            // a backup before every sync that changes something
            if changes && db.count() > 0 {
                make_backup(&db, &boxes.backup_dir(&name))?;
            }
            if !cards.is_empty() {
                db.put(&Value::Array(cards).to_string())?;
            }
            if !purged.is_empty() {
                let mut at = HashMap::new();
                for t in &purged {
                    if let Some(uid) = t["uid"].as_str() {
                        at.insert(uid.to_string(), t["at"].as_i64().unwrap_or(0));
                    }
                }
                let uids: Vec<String> = at.keys().cloned().collect();
                db.delete(&uids, &at)?;
            }
            if let Some(id) = msg["boxId"].as_str().filter(|s| !s.is_empty()) {
                db.set_meta("boxId", id)?;
            }
            if let Some(t) = msg["syncedAt"].as_i64() {
                db.set_meta(&format!("sync.{peer}"), &t.to_string())?;
            }
            Ok((json!({ "ok": true }).to_string(), changes.then_some(name)))
        }
        other => Err(format!("unknown op {other}")),
    }
}

// ---------- encrypted channel ----------

struct Channel {
    stream: TcpStream,
    transport: TransportState,
    remote: Value,
    remote_key: String,
    code: String,
}

fn read_frame(s: &mut TcpStream) -> Res<Vec<u8>> {
    let mut len = [0u8; 2];
    s.read_exact(&mut len).map_err(err)?;
    let mut buf = vec![0u8; u16::from_be_bytes(len) as usize];
    s.read_exact(&mut buf).map_err(err)?;
    Ok(buf)
}

fn write_frame(s: &mut TcpStream, data: &[u8]) -> Res<()> {
    s.write_all(&(data.len() as u16).to_be_bytes()).map_err(err)?;
    s.write_all(data).map_err(err)
}

/// Six digits both devices show; they only match when nobody sits in the middle.
fn pairing_code(h: &[u8]) -> String {
    let d = Sha256::new().chain_update(b"slipbox-sas").chain_update(h).finalize();
    format!("{:06}", u32::from_be_bytes([d[0], d[1], d[2], d[3]]) % 1_000_000)
}

impl Channel {
    /// Runs the handshake; `me` is this device's info, sent encrypted to the other side.
    fn handshake(mut stream: TcpStream, initiator: bool, key: &[u8; 32], me: &Value) -> Res<Self> {
        stream.set_read_timeout(Some(Duration::from_secs(300))).map_err(err)?;
        stream.set_nodelay(true).map_err(err)?;
        let builder = Builder::new(NOISE.parse().map_err(err)?).local_private_key(key).prologue(PROLOGUE);
        let mut hs = if initiator { builder.build_initiator() } else { builder.build_responder() }.map_err(err)?;
        let mut buf = vec![0u8; 65535];
        let mut payload = vec![0u8; 65535];
        let mine = me.to_string();
        let theirs = if initiator {
            let n = hs.write_message(&[], &mut buf).map_err(err)?;
            write_frame(&mut stream, &buf[..n])?;
            let n = hs.read_message(&read_frame(&mut stream)?, &mut payload).map_err(err)?;
            let theirs = payload[..n].to_vec();
            let n = hs.write_message(mine.as_bytes(), &mut buf).map_err(err)?;
            write_frame(&mut stream, &buf[..n])?;
            theirs
        } else {
            hs.read_message(&read_frame(&mut stream)?, &mut payload).map_err(err)?;
            let n = hs.write_message(mine.as_bytes(), &mut buf).map_err(err)?;
            write_frame(&mut stream, &buf[..n])?;
            let n = hs.read_message(&read_frame(&mut stream)?, &mut payload).map_err(err)?;
            payload[..n].to_vec()
        };
        let code = pairing_code(hs.get_handshake_hash());
        let remote_key = hs.get_remote_static().map(|k| B64.encode(k)).unwrap_or_default();
        let transport = hs.into_transport_mode().map_err(err)?;
        Ok(Channel { stream, transport, remote: serde_json::from_slice(&theirs).unwrap_or(json!({})), remote_key, code })
    }

    fn send_message(&mut self, text: &str) -> Res<()> {
        let data = text.as_bytes();
        if data.len() > MAX_MESSAGE {
            return Err("消息太大".into());
        }
        let mut buf = vec![0u8; 65535];
        let mut offset = 0;
        loop {
            let end = (offset + CHUNK).min(data.len());
            let mut plain = Vec::with_capacity(end - offset + 1);
            plain.push(u8::from(end < data.len()));
            plain.extend_from_slice(&data[offset..end]);
            let n = self.transport.write_message(&plain, &mut buf).map_err(err)?;
            write_frame(&mut self.stream, &buf[..n])?;
            offset = end;
            if offset >= data.len() {
                return Ok(());
            }
        }
    }

    fn receive_message(&mut self) -> Res<String> {
        let mut out = Vec::new();
        let mut buf = vec![0u8; 65535];
        loop {
            let frame = read_frame(&mut self.stream)?;
            let n = self.transport.read_message(&frame, &mut buf).map_err(err)?;
            if n == 0 {
                return Err("连接已断开".into());
            }
            out.extend_from_slice(&buf[1..n]);
            if out.len() > MAX_MESSAGE {
                return Err("消息太大".into());
            }
            if buf[0] == 0 {
                return String::from_utf8(out).map_err(err);
            }
        }
    }

    fn request(&mut self, text: &str) -> Res<String> {
        self.send_message(text)?;
        self.receive_message()
    }

    fn close(&self) {
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}

// ---------- service: listening, discovery, sessions ----------

struct Found {
    name: String,
    platform: String,
    fullname: String,
    addrs: Vec<SocketAddr>,
}

#[derive(Default)]
struct Inner {
    stop: Option<Arc<AtomicBool>>,
    mdns: Option<ServiceDaemon>,
    port: u16,
    found: HashMap<String, Found>,
}

pub struct SyncService {
    root: PathBuf,
    identity: Mutex<Identity>,
    inner: Mutex<Inner>,
    sessions: Mutex<HashMap<String, Arc<Mutex<Channel>>>>,
    prompts: Mutex<HashMap<String, mpsc::Sender<bool>>>,
    hosting: AtomicBool,
    emit: Box<dyn Fn(Value) + Send + Sync>,
    current_box: Box<dyn Fn() -> String + Send + Sync>,
}

impl SyncService {
    pub fn new(
        root: PathBuf,
        emit: impl Fn(Value) + Send + Sync + 'static,
        current_box: impl Fn() -> String + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(SyncService {
            identity: Mutex::new(Identity::load(root.join("sync.json"))),
            root,
            inner: Mutex::new(Inner::default()),
            sessions: Mutex::new(HashMap::new()),
            prompts: Mutex::new(HashMap::new()),
            hosting: AtomicBool::new(false),
            emit: Box::new(emit),
            current_box: Box::new(current_box),
        })
    }

    /// The page's `sync` command; replies with a JSON string.
    pub fn command(self: &Arc<Self>, msg: &Value) -> Res<Value> {
        let s = |k: &str| msg[k].as_str().unwrap_or("").to_string();
        let reply = match s("op").as_str() {
            "state" => self.state(),
            "start" => {
                self.start()?;
                self.state()
            }
            "stop" => {
                self.stop();
                json!({ "ok": true })
            }
            "rename" => {
                let name = s("name").trim().to_string();
                if name.is_empty() || name.chars().count() > 40 {
                    return Err("设备名称不能为空，最多 40 个字".into());
                }
                {
                    let mut id = self.identity.lock().map_err(err)?;
                    id.name = name;
                    id.save();
                }
                if self.inner.lock().map_err(err)?.stop.is_some() {
                    self.stop();
                    self.start()?;
                }
                self.state()
            }
            "forget" => {
                self.identity.lock().map_err(err)?.forget(&s("id"));
                self.state()
            }
            "answer" => {
                if let Some(tx) = self.prompts.lock().map_err(err)?.remove(&s("id")) {
                    let _ = tx.send(msg["ok"].as_bool().unwrap_or(false));
                }
                json!({ "ok": true })
            }
            "connect" => return self.connect(msg["peer"].as_str(), msg["address"].as_str()).map(|v| Value::String(v.to_string())),
            "request" => {
                let ch = self.session(&s("session"))?;
                let text = ch.lock().map_err(err)?.request(&s("msg"))?;
                return Ok(Value::String(text));
            }
            "trust" => {
                let ch = self.session(&s("session"))?;
                let peer = {
                    let c = ch.lock().map_err(err)?;
                    Peer::from_remote(&c.remote, &c.remote_key)
                };
                self.identity.lock().map_err(err)?.remember(peer);
                self.state()
            }
            "close" => {
                let ch = self.sessions.lock().map_err(err)?.remove(&s("session"));
                if let Some(ch) = ch {
                    if let Ok(mut c) = ch.lock() {
                        let _ = c.send_message(&json!({ "op": "bye" }).to_string());
                        c.close();
                    }
                }
                json!({ "ok": true })
            }
            "local" => {
                let m: Value = serde_json::from_str(&s("msg")).map_err(err)?;
                let peer = m["peer"].as_str().unwrap_or("").to_string();
                return self.run_op(&m, &peer).map(Value::String);
            }
            other => return Err(format!("unknown sync op {other}")),
        };
        Ok(Value::String(reply.to_string()))
    }

    fn session(&self, id: &str) -> Res<Arc<Mutex<Channel>>> {
        self.sessions.lock().map_err(err)?.get(id).cloned().ok_or_else(|| "连接已断开".to_string())
    }

    fn state(&self) -> Value {
        let id = self.identity.lock().unwrap();
        let inner = self.inner.lock().unwrap();
        let mut nearby: Vec<Value> = inner
            .found
            .iter()
            .map(|(pid, f)| json!({ "id": pid, "name": f.name, "platform": f.platform, "paired": id.peer(pid).is_some() }))
            .collect();
        nearby.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        json!({
            "device": id.info(),
            "listening": inner.stop.is_some(),
            "port": inner.port,
            "addresses": local_addresses(),
            "paired": id.peers.iter().map(|p| json!({ "id": p.id, "name": p.name, "platform": p.platform })).collect::<Vec<_>>(),
            "nearby": nearby,
            "problem": "",
        })
    }

    fn emit_state(&self) {
        (self.emit)(json!({ "type": "state", "state": self.state() }));
    }

    fn run_op(&self, msg: &Value, peer: &str) -> Res<String> {
        let me = self.identity.lock().map_err(err)?.info();
        let (reply, changed) = handle_op(msg, peer, &self.root, &me)?;
        if let Some(b) = changed {
            if b == (self.current_box)() {
                (self.emit)(json!({ "type": "changed", "box": b }));
            }
        }
        Ok(reply)
    }

    // ----- listening and discovery -----

    fn start(self: &Arc<Self>) -> Res<()> {
        let mut inner = self.inner.lock().map_err(err)?;
        if inner.stop.is_some() {
            return Ok(());
        }
        let wanted = std::env::var("ZK_SYNC_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT);
        let listener = TcpListener::bind(("0.0.0.0", wanted)).or_else(|_| TcpListener::bind(("0.0.0.0", 0))).map_err(err)?;
        listener.set_nonblocking(true).map_err(err)?;
        let port = listener.local_addr().map_err(err)?.port();
        let stop = Arc::new(AtomicBool::new(false));
        {
            let svc = Arc::clone(self);
            let stop = stop.clone();
            std::thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((stream, _)) => svc.accept(stream),
                        Err(_) => std::thread::sleep(Duration::from_millis(150)),
                    }
                }
            });
        }
        inner.stop = Some(stop.clone());
        inner.port = port;
        if std::env::var("ZK_SYNC_NO_BONJOUR").is_err() {
            match self.announce_and_browse(port, stop) {
                Ok(daemon) => inner.mdns = Some(daemon),
                Err(e) => (self.emit)(json!({ "type": "error", "message": format!("局域网发现不可用：{e}") })),
            }
        }
        Ok(())
    }

    fn announce_and_browse(self: &Arc<Self>, port: u16, stop: Arc<AtomicBool>) -> Res<ServiceDaemon> {
        let (my_id, info) = {
            let id = self.identity.lock().map_err(err)?;
            (id.device_id.clone(), id.info())
        };
        let name = info["name"].as_str().unwrap_or("").to_string();
        let daemon = ServiceDaemon::new().map_err(err)?;
        // the instance name only has to be unique; the page shows the TXT name
        let short: String = my_id.chars().take(6).collect();
        let instance = format!("{}-{short}", name.replace('.', " "));
        let host = format!("slipbox-{}.local.", my_id.chars().take(8).collect::<String>());
        let props = [("id", my_id.as_str()), ("n", name.as_str()), ("p", platform()), ("v", "1")];
        let service = ServiceInfo::new(SERVICE_TYPE, &instance, &host, "", port, &props[..]).map_err(err)?.enable_addr_auto();
        daemon.register(service).map_err(err)?;
        let events = daemon.browse(SERVICE_TYPE).map_err(err)?;
        let svc = Arc::clone(self);
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let Ok(event) = events.recv_timeout(Duration::from_millis(500)) else { continue };
                let changed = match event {
                    ServiceEvent::ServiceResolved(r) => {
                        let Some(id) = r.get_property_val_str("id").map(str::to_string) else { continue };
                        if id == my_id {
                            continue;
                        }
                        let mut addrs: Vec<SocketAddr> = r.addresses.iter().map(|a| SocketAddr::new(a.to_ip_addr(), r.port)).collect();
                        addrs.sort_by_key(|a| !a.is_ipv4()); // IPv4 first
                        let found = Found {
                            name: r.get_property_val_str("n").unwrap_or(&r.fullname).to_string(),
                            platform: r.get_property_val_str("p").unwrap_or("").to_string(),
                            fullname: r.fullname.clone(),
                            addrs,
                        };
                        svc.inner.lock().map(|mut i| i.found.insert(id, found)).is_ok()
                    }
                    ServiceEvent::ServiceRemoved(_, fullname) => {
                        svc.inner.lock().map(|mut i| i.found.retain(|_, f| f.fullname != fullname)).is_ok()
                    }
                    _ => false,
                };
                if changed && !stop.load(Ordering::Relaxed) {
                    svc.emit_state();
                }
            }
        });
        Ok(daemon)
    }

    fn stop(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(stop) = inner.stop.take() {
                stop.store(true, Ordering::Relaxed);
            }
            if let Some(d) = inner.mdns.take() {
                let _ = d.shutdown();
            }
            inner.found.clear();
            inner.port = 0;
        }
        if let Ok(mut p) = self.prompts.lock() {
            for (_, tx) in p.drain() {
                let _ = tx.send(false);
            }
        }
    }

    // ----- connecting (this device taps 同步) -----

    fn connect(&self, peer: Option<&str>, address: Option<&str>) -> Res<Value> {
        let addrs: Vec<SocketAddr> = match (peer.and_then(|p| self.inner.lock().ok()?.found.get(p).map(|f| f.addrs.clone())), address) {
            (Some(a), _) => a,
            (None, Some(a)) => parse_address(a),
            _ => vec![],
        };
        if addrs.is_empty() {
            return Err("找不到这台设备，请确认它也打开了“设备与同步”".into());
        }
        let stream = addrs
            .iter()
            .find_map(|a| TcpStream::connect_timeout(a, Duration::from_secs(5)).ok())
            .ok_or_else(|| "连接失败：对方没有响应".to_string())?;
        let (key, me) = {
            let id = self.identity.lock().map_err(err)?;
            (id.private, id.info())
        };
        let ch = Channel::handshake(stream, true, &key, &me).map_err(|e| format!("连接失败：{e}"))?;
        let rid = ch.remote["id"].as_str().unwrap_or("").to_string();
        let paired = {
            let id = self.identity.lock().map_err(err)?;
            match id.peer(&rid) {
                Some(known) if known.key != ch.remote_key => {
                    ch.close();
                    return Err(format!("“{}”的密钥变了。如果它重装过卡片盒，请先在已配对设备里移除它，再重新配对。", known.name));
                }
                known => known.is_some(),
            }
        };
        let session = random_id();
        let reply = json!({ "session": session, "code": ch.code, "peer": ch.remote, "paired": paired });
        self.sessions.lock().map_err(err)?.insert(session, Arc::new(Mutex::new(ch)));
        Ok(reply)
    }

    // ----- hosting (the other device tapped 同步) -----

    fn accept(self: &Arc<Self>, stream: TcpStream) {
        if self.hosting.swap(true, Ordering::SeqCst) {
            let _ = stream.shutdown(Shutdown::Both); // busy with another device
            return;
        }
        let svc = Arc::clone(self);
        std::thread::spawn(move || {
            let _ = stream.set_nonblocking(false);
            svc.serve(stream);
            svc.hosting.store(false, Ordering::SeqCst);
        });
    }

    fn serve(&self, stream: TcpStream) {
        let Ok((key, me)) = self.identity.lock().map(|id| (id.private, id.info())) else { return };
        let Ok(mut ch) = Channel::handshake(stream, false, &key, &me) else { return };
        let peer = Peer::from_remote(&ch.remote, &ch.remote_key);
        let mut confirmed = false;
        let mut announced = false;
        while let Ok(text) = ch.receive_message() {
            let msg: Value = serde_json::from_str(&text).unwrap_or(json!({}));
            let reply = match msg["op"].as_str().unwrap_or("") {
                "bye" => break,
                "pair" => {
                    let id = random_id();
                    let (tx, rx) = mpsc::channel();
                    if let Ok(mut p) = self.prompts.lock() {
                        p.insert(id.clone(), tx);
                    }
                    (self.emit)(json!({ "type": "pair", "id": id, "code": ch.code,
                        "peer": { "id": peer.id, "name": peer.name, "platform": peer.platform } }));
                    confirmed = rx.recv_timeout(Duration::from_secs(120)).unwrap_or(false);
                    if let Ok(mut p) = self.prompts.lock() {
                        p.remove(&id);
                    }
                    (self.emit)(json!({ "type": "pairEnd", "id": id }));
                    if confirmed {
                        json!({ "ok": true })
                    } else {
                        json!({ "ok": false, "code": "rejected", "error": "对方没有确认配对" })
                    }
                    .to_string()
                }
                "paired" => {
                    if confirmed {
                        if let Ok(mut id) = self.identity.lock() {
                            id.remember(peer.clone());
                        }
                        self.emit_state();
                        json!({ "ok": true }).to_string()
                    } else {
                        json!({ "ok": false, "code": "rejected" }).to_string()
                    }
                }
                _ => {
                    let known = self.identity.lock().ok().and_then(|id| id.peer(&peer.id).map(|p| p.key == peer.key)).unwrap_or(false);
                    if !known {
                        json!({ "ok": false, "code": "unpaired", "error": "这两台设备还没有配对" }).to_string()
                    } else {
                        if !announced {
                            announced = true;
                            (self.emit)(json!({ "type": "hostStart", "peer": peer.json() }));
                        }
                        self.run_op(&msg, &peer.id).unwrap_or_else(|e| json!({ "ok": false, "error": e }).to_string())
                    }
                }
            };
            if ch.send_message(&reply).is_err() {
                break;
            }
        }
        ch.close();
        if announced {
            (self.emit)(json!({ "type": "hostDone", "peer": peer.json() }));
        }
    }
}

/// "192.168.1.20:51515", "192.168.1.20" (default port) or "[fe80::1]:51515".
fn parse_address(a: &str) -> Vec<SocketAddr> {
    let a = a.trim();
    let with_port = if a.parse::<IpAddr>().is_ok() || !a.contains(':') { format!("{a}:{DEFAULT_PORT}") } else { a.to_string() };
    with_port.to_socket_addrs().map(|it| it.collect()).unwrap_or_default()
}

/// IPv4 addresses shown for connecting by hand.
fn local_addresses() -> Vec<String> {
    if_addrs::get_if_addrs()
        .map(|list| {
            list.into_iter()
                .filter(|i| !i.is_loopback() && i.ip().is_ipv4())
                .map(|i| i.ip().to_string())
                .filter(|ip| !ip.starts_with("169.254."))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    /// The same vectors as tests/noise/main.swift (apple/Shared/Noise.swift), so the Windows and
    /// Apple apps agree byte for byte.
    #[test]
    fn noise_vectors_match_the_swift_implementation() {
        let p: snow::params::NoiseParams = NOISE.parse().unwrap();
        let mut i = Builder::new(p.clone())
            .local_private_key(&[1; 32])
            .fixed_ephemeral_key_for_testing_only(&[2; 32])
            .prologue(PROLOGUE)
            .build_initiator()
            .unwrap();
        let mut r = Builder::new(p)
            .local_private_key(&[3; 32])
            .fixed_ephemeral_key_for_testing_only(&[4; 32])
            .prologue(PROLOGUE)
            .build_responder()
            .unwrap();
        let (mut buf, mut pl) = ([0u8; 1024], [0u8; 1024]);
        let n = i.write_message(b"", &mut buf).unwrap();
        assert_eq!(hex(&buf[..n]), "ce8d3ad1ccb633ec7b70c17814a5c76ecd029685050d344745ba05870e587d59");
        r.read_message(&buf[..n], &mut pl).unwrap();
        let n = r.write_message(br#"{"id":"host"}"#, &mut buf).unwrap();
        assert!(hex(&buf[..n]).starts_with("ac01b2209e86354fb853237b5de0f4fab13c7fcb"));
        i.read_message(&buf[..n], &mut pl).unwrap();
        let n = i.write_message(br#"{"id":"init"}"#, &mut buf).unwrap();
        assert!(hex(&buf[..n]).ends_with("1c4dd432cf46a74c2"));
        r.read_message(&buf[..n], &mut pl).unwrap();
        assert_eq!(hex(i.get_handshake_hash()), "bf0082602ca6bbd90648f98e799b444850cf920fbdf5a3e4982200f09317a043");
        assert_eq!(pairing_code(i.get_handshake_hash()), "355424");
        assert_eq!(i.get_remote_static().unwrap(), public_key(&[3; 32]));
        let mut it = i.into_transport_mode().unwrap();
        let n = it.write_message(b"hello", &mut buf).unwrap();
        assert_eq!(hex(&buf[..n]), "f5c8fdccae8939c5a6d0d9be2753d6cf345c85961d");
    }

    #[test]
    fn pairing_code_is_six_digits() {
        let c = pairing_code(&[7; 32]);
        assert_eq!(c.len(), 6);
        assert!(c.chars().all(|d| d.is_ascii_digit()));
        assert_ne!(c, pairing_code(&[8; 32]));
    }

    #[test]
    fn addresses() {
        assert_eq!(parse_address("127.0.0.1"), vec!["127.0.0.1:51515".parse().unwrap()]);
        assert_eq!(parse_address("127.0.0.1:9"), vec!["127.0.0.1:9".parse().unwrap()]);
        assert_eq!(parse_address("[::1]:9"), vec!["[::1]:9".parse().unwrap()]);
    }
}
