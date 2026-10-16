//! 卡片盒 for Windows (Tauri + WebView2). The window shows the shared web UI from ../web
//! and the page talks to one `zk` command whose replies match the Swift bridge in
//! mac/main.swift, so web/js/backend.js works the same on both systems.
//!
//! Data: <data dir>/卡片盒/boxes/<name>.db (one SQLite file per slip box, same schema as the
//! Mac app), daily backups in <data dir>/卡片盒/backups/<name>/. On Windows <data dir> is %APPDATA%.
//!
//! Development: ZK_DATA_DIR=<folder> uses another data folder and does not touch settings;
//! ZK_SELFTEST=<script.js> runs the script in the page (body of an async function) without
//! showing the window, writes its result to ZK_SELFTEST_OUT (or stdout) and quits.

use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, RunEvent, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

mod sync;

type Res<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

const DEFAULT_BOX: &str = "我的卡片盒";
const KEEP_BACKUPS: usize = 30;
const HOMEPAGE: &str = "https://github.com/CamLUzy/slipbox";

// ---------- database ----------

struct Database {
    conn: Connection,
    path: PathBuf,
}

impl Database {
    fn open(path: &Path) -> Res<Self> {
        let conn = Connection::open(path).map_err(|e| format!("无法打开数据库 {}：{e}", path.display()))?;
        // `data` holds the full card as JSON; the other columns keep the file readable by other tools.
        // meta: boxId (the same box on every device) and sync.<deviceId> (last sync with that device);
        // purged: tombstones of permanently deleted cards, so a sync does not bring them back.
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
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
             CREATE TABLE IF NOT EXISTS purged (uid TEXT PRIMARY KEY, at INTEGER NOT NULL);",
        )
        .map_err(err)?;
        Ok(Self { conn, path: path.to_path_buf() })
    }

    /// All cards as one JSON array string.
    fn load_all(&self) -> Res<String> {
        let mut stmt = self.conn.prepare("SELECT data FROM cards").map_err(err)?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
        let mut parts = Vec::new();
        for r in rows {
            parts.push(r.map_err(err)?);
        }
        Ok(format!("[{}]", parts.join(",")))
    }

    fn count(&self) -> i64 {
        self.conn
            .query_row("SELECT COUNT(*) FROM cards", [], |r| r.get(0))
            .unwrap_or(0)
    }

    fn put(&mut self, json_text: &str) -> Res<()> {
        let cards: Vec<Value> = serde_json::from_str(json_text).map_err(|_| "卡片数据格式不正确".to_string())?;
        let tx = self.conn.transaction().map_err(err)?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO cards (uid, zid, kind, title, body, keywords, deleted, created_at, updated_at, data)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                     ON CONFLICT(uid) DO UPDATE SET zid = excluded.zid, kind = excluded.kind, title = excluded.title,
                       body = excluded.body, keywords = excluded.keywords, deleted = excluded.deleted,
                       created_at = excluded.created_at, updated_at = excluded.updated_at, data = excluded.data",
                )
                .map_err(err)?;
            for c in &cards {
                let Some(uid) = c.get("uid").and_then(Value::as_str) else { continue };
                let text = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                let num = |k: &str| c.get(k).and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))).unwrap_or(0);
                let keywords = c.get("keywords").cloned().unwrap_or_else(|| json!([]));
                stmt.execute(params![
                    uid,
                    c.get("zid").and_then(Value::as_str),
                    c.get("kind").and_then(Value::as_str).unwrap_or("fleeting"),
                    text("title"),
                    text("body"),
                    keywords.to_string(),
                    c.get("deleted").and_then(Value::as_bool).unwrap_or(false) as i64,
                    num("createdAt"),
                    num("updatedAt"),
                    c.to_string(),
                ])
                .map_err(err)?;
            }
        }
        tx.commit().map_err(err)
    }

    /// Permanently deletes cards and remembers them as purged (`at`: ms, default now).
    fn delete(&mut self, uids: &[String], at: &HashMap<String, i64>) -> Res<()> {
        let now = chrono::Utc::now().timestamp_millis();
        let tx = self.conn.transaction().map_err(err)?;
        for uid in uids {
            tx.execute("DELETE FROM cards WHERE uid = ?1", params![uid]).map_err(err)?;
            tx.execute("INSERT OR REPLACE INTO purged (uid, at) VALUES (?1, ?2)", params![uid, at.get(uid).copied().unwrap_or(now)])
                .map_err(err)?;
        }
        tx.commit().map_err(err)
    }

    /// Tombstones as a JSON array [{uid, at}].
    fn purged_json(&self) -> Res<String> {
        let mut stmt = self.conn.prepare("SELECT uid, at FROM purged").map_err(err)?;
        let rows = stmt
            .query_map([], |r| Ok(json!({ "uid": r.get::<_, String>(0)?, "at": r.get::<_, i64>(1)? })))
            .map_err(err)?;
        let list: Vec<Value> = rows.collect::<Result<_, _>>().map_err(err)?;
        Ok(Value::Array(list).to_string())
    }

    fn meta(&self, key: &str) -> Option<String> {
        self.conn.query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| r.get(0)).ok()
    }

    fn set_meta(&self, key: &str, value: &str) -> Res<()> {
        self.conn
            .execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)", params![key, value])
            .map(|_| ())
            .map_err(err)
    }

    /// The box's identity across devices, created on first use.
    fn box_id(&self) -> Res<String> {
        if let Some(id) = self.meta("boxId") {
            return Ok(id);
        }
        let id = sync::random_id();
        self.set_meta("boxId", &id)?;
        Ok(id)
    }

    fn backup(&self, to: &Path) -> Res<()> {
        let target = to.to_string_lossy().replace('\'', "''");
        self.conn.execute_batch(&format!("VACUUM INTO '{target}'")).map_err(err)
    }
}

fn count_cards(path: &Path) -> i64 {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .and_then(|c| c.query_row("SELECT COUNT(*) FROM cards WHERE deleted = 0", [], |r| r.get(0)))
        .unwrap_or(0)
}

/// `foo.db` + `-wal` → `foo.db-wal`
fn sidecar(path: &Path, suffix: &str) -> PathBuf {
    let mut s: OsString = path.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

// ---------- slip boxes ----------

struct Boxes {
    root: PathBuf,
}

impl Boxes {
    fn dir(&self) -> PathBuf {
        self.root.join("boxes")
    }

    fn file(&self, name: &str) -> PathBuf {
        self.dir().join(format!("{name}.db"))
    }

    fn backup_dir(&self, name: &str) -> PathBuf {
        self.root.join("backups").join(name)
    }

    fn exists(&self, name: &str) -> bool {
        self.file(name).exists()
    }

    fn list(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(self.dir())
            .map(|it| {
                it.filter_map(|e| e.ok())
                    .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".db")).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        names.sort_by_key(|n| n.to_lowercase());
        names
    }

    /// Names must be valid file names on Windows and macOS.
    fn is_valid(name: &str) -> bool {
        const RESERVED: [&str; 22] = [
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
            "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ];
        !name.is_empty()
            && name.trim() == name
            && name.chars().count() <= 60
            && !name.starts_with('.')
            && !name.ends_with('.')
            && !name.chars().any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
            && !RESERVED.contains(&name.to_uppercase().as_str())
    }

    fn move_files(&self, from: &Path, to: &Path) -> Res<()> {
        for suffix in ["", "-wal", "-shm"] {
            let a = sidecar(from, suffix);
            if a.exists() {
                fs::rename(&a, sidecar(to, suffix)).map_err(err)?;
            }
        }
        Ok(())
    }
}

const BAD_NAME: &str = "名称不能为空，不能以 . 开头或结尾，也不能包含 / \\ : * ? \" < > |";

// ---------- backups ----------

fn backup_list(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .map(|it| {
            it.filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| n.starts_with("zettel-") && n.ends_with(".db"))
                .collect()
        })
        .unwrap_or_default();
    names.sort_by(|a, b| b.cmp(a));
    names
}

fn make_backup(db: &Database, dir: &Path) -> Res<String> {
    fs::create_dir_all(dir).map_err(err)?;
    let stamp = chrono::Local::now().format("%Y-%m-%d-%H%M%S").to_string();
    // two backups in the same second (e.g. two quick syncs) must not collide
    let mut name = format!("zettel-{stamp}.db");
    let mut n = 2;
    while dir.join(&name).exists() {
        name = format!("zettel-{stamp}-{n}.db");
        n += 1;
    }
    db.backup(&dir.join(&name))?;
    for old in backup_list(dir).into_iter().skip(KEEP_BACKUPS) {
        let _ = fs::remove_file(dir.join(old));
    }
    Ok(name)
}

/// Once a day, and only when there is something to back up.
fn backup_if_due(state: &AppState) {
    let Ok(cur) = state.current.lock() else { return };
    if cur.db.count() == 0 {
        return;
    }
    let dir = state.boxes.backup_dir(&cur.name);
    if let Some(latest) = backup_list(&dir).first() {
        let fresh = fs::metadata(dir.join(latest))
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .map(|age| age < Duration::from_secs(20 * 3600))
            .unwrap_or(false);
        if fresh {
            return;
        }
    }
    let _ = make_backup(&cur.db, &dir);
}

// ---------- state ----------

struct Current {
    name: String,
    db: Database,
}

struct AppState {
    boxes: Boxes,
    current: Mutex<Current>,
    settings: PathBuf,
    dev: bool,
    zoom: Mutex<f64>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    selftest_out: Option<PathBuf>,
    sync: OnceLock<Arc<sync::SyncService>>,
}

impl AppState {
    fn open_box(&self, name: &str) -> Res<()> {
        let db = Database::open(&self.boxes.file(name))?;
        fs::create_dir_all(self.boxes.backup_dir(name)).map_err(err)?;
        let mut cur = self.current.lock().map_err(err)?;
        *cur = Current { name: name.to_string(), db };
        drop(cur);
        self.remember(name);
        Ok(())
    }

    /// A development data dir (ZK_DATA_DIR) never changes the real app's remembered box.
    fn remember(&self, name: &str) {
        if !self.dev {
            let _ = fs::write(&self.settings, json!({ "currentBox": name }).to_string());
        }
    }

    fn box_name(&self) -> String {
        self.current.lock().map(|c| c.name.clone()).unwrap_or_default()
    }
}

fn init_state(root: PathBuf, dev: bool, selftest_out: Option<PathBuf>) -> Res<AppState> {
    let boxes = Boxes { root: root.clone() };
    fs::create_dir_all(boxes.dir()).map_err(err)?;
    let settings = root.join("settings.json");
    let saved = std::env::var("ZK_BOX").ok().or_else(|| {
        fs::read_to_string(&settings)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v["currentBox"].as_str().map(str::to_string))
    });
    let name = saved
        .filter(|n| boxes.exists(n))
        .or_else(|| boxes.list().into_iter().next())
        .unwrap_or_else(|| DEFAULT_BOX.to_string());
    let db = Database::open(&boxes.file(&name))?;
    fs::create_dir_all(boxes.backup_dir(&name)).map_err(err)?;
    Ok(AppState {
        boxes,
        current: Mutex::new(Current { name, db }),
        settings,
        dev,
        zoom: Mutex::new(1.0),
        cancels: Mutex::new(HashMap::new()),
        selftest_out,
        sync: OnceLock::new(),
    })
}

// ---------- the `zk` command ----------

#[tauri::command]
async fn zk(app: AppHandle, msg: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || handle(&app, &msg)).await.map_err(err)?
}

fn handle(app: &AppHandle, msg: &Value) -> Res<Value> {
    let state = app.state::<AppState>();
    let s = |k: &str| msg.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let cmd = s("cmd");
    match cmd.as_str() {
        "load" => Ok(Value::String(state.current.lock().map_err(err)?.db.load_all()?)),
        "put" => {
            state.current.lock().map_err(err)?.db.put(&s("cards"))?;
            Ok(Value::Bool(true))
        }
        "delete" => {
            let uids: Vec<String> = msg["uids"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            state.current.lock().map_err(err)?.db.delete(&uids, &HashMap::new())?;
            Ok(Value::Bool(true))
        }
        "info" => {
            let cur = state.current.lock().map_err(err)?;
            let info = json!({
                "dataPath": cur.db.path.to_string_lossy(),
                "backups": backup_list(&state.boxes.backup_dir(&cur.name)),
                "native": true,
                "box": cur.name,
            });
            Ok(Value::String(info.to_string()))
        }
        "backup" => {
            let cur = state.current.lock().map_err(err)?;
            Ok(Value::String(make_backup(&cur.db, &state.boxes.backup_dir(&cur.name))?))
        }
        "reveal" => {
            let path = state.current.lock().map_err(err)?.db.path.clone();
            app.opener().reveal_item_in_dir(path).map_err(err)?;
            Ok(Value::Bool(true))
        }
        "boxes" | "createBox" | "switchBox" | "renameBox" | "deleteBox" => box_command(&state, &cmd, msg),
        "saveFile" => {
            let picked = app.dialog().file().set_file_name(s("name")).blocking_save_file();
            match picked {
                Some(p) => {
                    fs::write(p.into_path().map_err(err)?, s("content")).map_err(err)?;
                    Ok(Value::Bool(true))
                }
                None => Ok(Value::Bool(false)),
            }
        }
        "openFile" => match app.dialog().file().add_filter("JSON", &["json"]).blocking_pick_file() {
            Some(p) => Ok(Value::String(fs::read_to_string(p.into_path().map_err(err)?).map_err(err)?)),
            None => Ok(Value::Null),
        },
        "exportFiles" => export_files(app, &s("folder"), &s("files")),
        "ollama" => Ok(Value::String(ollama(app, msg).to_string())),
        "ollamaCancel" => {
            if let Some(flag) = state.cancels.lock().map_err(err)?.get(&s("id")) {
                flag.store(true, Ordering::Relaxed);
            }
            Ok(Value::Bool(true))
        }
        "startOllama" => Ok(Value::Bool(start_ollama())),
        "installOllama" => Ok(Value::String(install_ollama(app, msg).to_string())),
        "sync" => {
            // LAN sync (sync.rs), started the first time the page asks for it
            let svc = state.sync.get_or_init(|| {
                let (to_page, for_box) = (app.clone(), app.clone());
                sync::SyncService::new(
                    state.boxes.root.clone(),
                    move |event| {
                        if let Some(w) = to_page.get_webview_window("main") {
                            let _ = w.eval(format!("window.zkSyncEvent && window.zkSyncEvent({event})"));
                        }
                    },
                    move || for_box.state::<AppState>().box_name(),
                )
            });
            svc.command(msg)
        }
        "title" => {
            let t = s("title");
            let name = state.box_name();
            let title = if t.is_empty() || t == "卡片盒" { name } else { format!("{t} — {name}") };
            if let Some(w) = app.get_webview_window("main") {
                w.set_title(&title).map_err(err)?;
            }
            Ok(Value::Bool(true))
        }
        "openUrl" => {
            let url = s("url");
            if url.starts_with("https://") || url.starts_with("http://") || url.starts_with("mailto:") {
                app.opener().open_url(url, None::<&str>).map_err(err)?;
            }
            Ok(Value::Bool(true))
        }
        "selftestResult" => {
            let value = s("value");
            match &state.selftest_out {
                Some(p) => fs::write(p, &value).map_err(err)?,
                None => println!("{value}"),
            }
            app.exit(if value.starts_with("SELFTEST ERROR") { 1 } else { 0 });
            Ok(Value::Bool(true))
        }
        _ => Err(format!("unknown command {cmd}")),
    }
}

fn box_command(state: &AppState, cmd: &str, msg: &Value) -> Res<Value> {
    let name = msg["name"].as_str().unwrap_or("").to_string();
    let boxes = &state.boxes;
    let current = state.box_name();
    match cmd {
        "boxes" => {
            let list: Vec<Value> = boxes
                .list()
                .into_iter()
                .map(|n| {
                    let cards = if n == current { -1 } else { count_cards(&boxes.file(&n)) };
                    json!({ "name": n, "cards": cards })
                })
                .collect();
            Ok(Value::String(json!({ "current": current, "boxes": list }).to_string()))
        }
        "createBox" => {
            if !Boxes::is_valid(&name) {
                return Err(BAD_NAME.into());
            }
            if boxes.exists(&name) {
                return Err(format!("已经有叫“{name}”的卡片盒了"));
            }
            state.open_box(&name)?;
            Ok(Value::Bool(true))
        }
        "switchBox" => {
            if !boxes.exists(&name) {
                return Err(format!("找不到卡片盒“{name}”"));
            }
            state.open_box(&name)?;
            Ok(Value::Bool(true))
        }
        "renameBox" => {
            let to = msg["to"].as_str().unwrap_or("").to_string();
            if !Boxes::is_valid(&to) {
                return Err(BAD_NAME.into());
            }
            if !boxes.exists(&name) || boxes.exists(&to) {
                return Err(format!("名称“{to}”已被使用"));
            }
            let is_current = name == current;
            if is_current {
                // close the open database before moving its files: swap in an in-memory placeholder
                let mut cur = state.current.lock().map_err(err)?;
                cur.db = Database { conn: Connection::open_in_memory().map_err(err)?, path: PathBuf::new() };
            }
            boxes.move_files(&boxes.file(&name), &boxes.file(&to))?;
            if boxes.backup_dir(&name).exists() {
                let _ = fs::rename(boxes.backup_dir(&name), boxes.backup_dir(&to));
            }
            if is_current {
                state.open_box(&to)?;
            }
            Ok(Value::Bool(true))
        }
        "deleteBox" => {
            if name == current {
                return Err("不能删除正在使用的卡片盒".into());
            }
            if !boxes.exists(&name) {
                return Err(format!("找不到卡片盒“{name}”"));
            }
            for suffix in ["", "-wal", "-shm"] {
                let f = sidecar(&boxes.file(&name), suffix);
                if f.exists() {
                    trash::delete(&f).map_err(err)?;
                }
            }
            Ok(Value::Bool(true))
        }
        _ => Err(format!("unknown command {cmd}")),
    }
}

fn export_files(app: &AppHandle, folder: &str, files_json: &str) -> Res<Value> {
    let Some(base) = app.dialog().file().set_title("选择导出位置").blocking_pick_folder() else {
        return Ok(Value::Null);
    };
    let base = base.into_path().map_err(err)?;
    let files: Vec<Value> = serde_json::from_str(files_json).map_err(err)?;
    let folder = if folder.is_empty() { "卡片盒导出" } else { folder };
    let mut dir = base.join(folder);
    let mut i = 2;
    while dir.exists() {
        dir = base.join(format!("{folder} {i}"));
        i += 1;
    }
    for f in &files {
        let (Some(rel), Some(content)) = (f["path"].as_str(), f["content"].as_str()) else { continue };
        if rel.contains("..") {
            continue;
        }
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(err)?;
        }
        fs::write(&path, content).map_err(err)?;
    }
    let _ = app.opener().reveal_item_in_dir(&dir);
    Ok(Value::String(dir.to_string_lossy().into_owned()))
}

// ---------- local Ollama ----------

/// Proxy to the local Ollama server (avoids browser CORS rules). Only loopback hosts are
/// allowed, so card contents never leave this computer. Streamed responses are pushed line by
/// line to window.zkStream(id, line); the reply is {status, text} or {error}.
fn ollama(app: &AppHandle, msg: &Value) -> Value {
    let state = app.state::<AppState>();
    let id = msg["id"].as_str().unwrap_or("").to_string();
    let base = msg["base"].as_str().unwrap_or("http://127.0.0.1:11434");
    let url = format!("{base}{}", msg["path"].as_str().unwrap_or("/api/tags"));
    let local = ["http://127.0.0.1:", "http://localhost:", "http://[::1]:"].iter().any(|p| url.starts_with(p));
    if !local {
        return json!({ "error": "只允许连接本机上的 Ollama" });
    }
    let stream = msg["stream"].as_bool().unwrap_or(false);
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut c) = state.cancels.lock() {
        c.insert(id.clone(), cancel.clone());
    }
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(None)
        .build()
        .new_agent();
    let run = || -> Res<Value> {
        let mut resp = match msg.get("body").and_then(Value::as_str) {
            Some(body) => agent.post(&url).header("Content-Type", "application/json").send(body),
            None => agent.get(&url).call(),
        }
        .map_err(err)?;
        let status = resp.status().as_u16();
        if !stream {
            let text = resp.body_mut().read_to_string().map_err(err)?;
            return Ok(json!({ "status": status, "text": text }));
        }
        let window = app.get_webview_window("main");
        for line in BufReader::new(resp.body_mut().as_reader()).lines() {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let line = line.map_err(err)?;
            if line.trim().is_empty() {
                continue;
            }
            if let Some(w) = &window {
                let js = format!("window.zkStream({}, {})", Value::String(id.clone()), Value::String(line));
                let _ = w.eval(js);
            }
        }
        Ok(json!({ "status": status, "text": "" }))
    };
    let result = run();
    if let Ok(mut c) = state.cancels.lock() {
        c.remove(&id);
    }
    if cancel.load(Ordering::Relaxed) {
        return json!({ "error": "cancelled", "cancelled": true });
    }
    result.unwrap_or_else(|e| json!({ "error": e }))
}

/// One-click install: the official OllamaSetup.exe from GitHub, run silently for this user
/// (no administrator rights needed), then started. Progress {frac, text} goes to
/// window.zkStream(id, …); the reply is {ok} or {error}; ollamaCancel stops the download.
fn install_ollama(app: &AppHandle, msg: &Value) -> Value {
    let state = app.state::<AppState>();
    let id = msg["id"].as_str().unwrap_or("").to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut c) = state.cancels.lock() {
        c.insert(id.clone(), cancel.clone());
    }
    let window = app.get_webview_window("main");
    let report = |frac: Option<f64>, text: &str| {
        let mut p = json!({ "text": text });
        if let Some(f) = frac {
            p["frac"] = json!(f);
        }
        if let Some(w) = &window {
            let _ = w.eval(format!("window.zkStream({}, {})", Value::String(id.clone()), Value::String(p.to_string())));
        }
    };
    let run = || -> Res<()> {
        if !cfg!(windows) {
            return Err("这里只支持在 Windows 上一键安装".into());
        }
        report(Some(0.0), "正在下载 Ollama…");
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .tls_config(ureq::tls::TlsConfig::builder().provider(ureq::tls::TlsProvider::NativeTls).build())
            .http_status_as_error(false)
            .timeout_global(None)
            .build()
            .new_agent();
        let mut resp = agent.get("https://github.com/ollama/ollama/releases/latest/download/OllamaSetup.exe").call().map_err(err)?;
        if resp.status() != 200 {
            return Err(format!("下载失败（HTTP {}），请检查网络后重试", resp.status().as_u16()));
        }
        let total: u64 = resp.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).unwrap_or(0);
        let path = std::env::temp_dir().join("OllamaSetup.exe");
        {
            use std::io::{Read, Write};
            let mut file = fs::File::create(&path).map_err(err)?;
            let mut reader = resp.body_mut().as_reader();
            let mut buf = vec![0u8; 1 << 16];
            let (mut done, mut last) = (0u64, std::time::Instant::now());
            loop {
                if cancel.load(Ordering::Relaxed) {
                    drop(file);
                    let _ = fs::remove_file(&path);
                    return Err("cancelled".into());
                }
                let n = reader.read(&mut buf).map_err(err)?;
                if n == 0 {
                    break;
                }
                file.write_all(&buf[..n]).map_err(err)?;
                done += n as u64;
                if total > 0 && last.elapsed() > Duration::from_millis(250) {
                    last = std::time::Instant::now();
                    report(Some(done as f64 / total as f64), "正在下载 Ollama…");
                }
            }
        }
        report(None, "正在安装 Ollama…");
        let status = Command::new(&path).args(["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"]).status().map_err(err)?;
        let _ = fs::remove_file(&path);
        if !status.success() {
            return Err(format!("Ollama 安装程序没有完成（{status}）"));
        }
        report(None, "正在启动 Ollama…");
        start_ollama();
        Ok(())
    };
    let result = run();
    if let Ok(mut c) = state.cancels.lock() {
        c.remove(&id);
    }
    match result {
        Ok(()) => json!({ "ok": true }),
        Err(e) if e == "cancelled" => json!({ "error": "cancelled", "cancelled": true }),
        Err(e) => json!({ "error": e }),
    }
}

/// Starts Ollama in the background. Returns false if it is not installed.
fn start_ollama() -> bool {
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let app = Path::new(&local).join("Programs").join("Ollama").join("ollama app.exe");
            if app.exists() && Command::new(app).spawn().is_ok() {
                return true;
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if Path::new("/Applications/Ollama.app").exists()
            && Command::new("open").args(["-g", "-a", "Ollama"]).spawn().is_ok()
        {
            return true;
        }
    }
    let mut cmd = Command::new("ollama");
    cmd.arg("serve").stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().is_ok()
}

// ---------- window, menu ----------

fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, text: &str, accel: Option<&str>| MenuItem::with_id(app, id, text, true, accel);
    let sep = || PredefinedMenuItem::separator(app);
    let file = Submenu::with_items(
        app,
        "文件",
        true,
        &[
            &item("zk:boxes", "切换卡片盒…", Some("CmdOrCtrl+O"))?,
            &sep()?,
            &item("zk:capture", "记录闪念", Some("CmdOrCtrl+N"))?,
            &item("zk:new-top", "新主题卡片", Some("CmdOrCtrl+Shift+N"))?,
            &item("zk:new-lit", "新文献卡片", Some("CmdOrCtrl+Alt+N"))?,
            &sep()?,
            &item("zk:import-json", "从 JSON 导入…", None)?,
            &item("zk:export-json", "导出 JSON…", Some("CmdOrCtrl+Shift+E"))?,
            &item("zk:export-md", "导出为 Markdown 文件…", None)?,
            &sep()?,
            &item("zk:sync", "设备与同步…", Some("CmdOrCtrl+Shift+Y"))?,
            &item("zk:backup", "立即备份", Some("CmdOrCtrl+Shift+B"))?,
            &item("zk:reveal", "打开数据文件夹", None)?,
            &item("zk:settings", "设置与数据…", Some("CmdOrCtrl+,"))?,
            &sep()?,
            &PredefinedMenuItem::quit(app, Some("退出"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("撤销"))?,
            &PredefinedMenuItem::redo(app, Some("重做"))?,
            &sep()?,
            &PredefinedMenuItem::cut(app, Some("剪切"))?,
            &PredefinedMenuItem::copy(app, Some("复制"))?,
            &PredefinedMenuItem::paste(app, Some("粘贴"))?,
            &PredefinedMenuItem::select_all(app, Some("全选"))?,
            &sep()?,
            &item("zk:search", "搜索", Some("CmdOrCtrl+F"))?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "显示",
        true,
        &[
            &item("zoom:reset", "实际大小", Some("CmdOrCtrl+0"))?,
            &item("zoom:in", "放大", Some("CmdOrCtrl+="))?,
            &item("zoom:out", "缩小", Some("CmdOrCtrl+-"))?,
            &sep()?,
            &item("win:fullscreen", "全屏", Some("F11"))?,
        ],
    )?;
    let go = Submenu::with_items(
        app,
        "前往",
        true,
        &[&item("zk:random", "随机漫步", Some("CmdOrCtrl+R"))?, &item("zk:trash", "回收站", None)?],
    )?;
    let ai = Submenu::with_items(
        app,
        "AI",
        true,
        &[
            &item("zk:ai", "AI 助手", Some("CmdOrCtrl+J"))?,
            &item("zk:ai-map", "梳理整个卡片盒", Some("CmdOrCtrl+Shift+J"))?,
            &sep()?,
            &item("zk:ai-unload", "释放模型内存", None)?,
        ],
    )?;
    let help = Submenu::with_items(
        app,
        "帮助",
        true,
        &[&item("app:home", "项目主页", None)?, &item("app:about", "关于卡片盒", None)?],
    )?;
    Menu::with_items(app, &[&file, &edit, &view, &go, &ai, &help])
}

fn on_menu(app: &AppHandle, id: &str) {
    let Some(window) = app.get_webview_window("main") else { return };
    if let Some(action) = id.strip_prefix("zk:") {
        let _ = window.set_focus();
        let _ = window.eval(format!("window.zkMenu && window.zkMenu({})", Value::String(action.into())));
        return;
    }
    let state = app.state::<AppState>();
    match id {
        "zoom:reset" | "zoom:in" | "zoom:out" => {
            if let Ok(mut z) = state.zoom.lock() {
                *z = match id {
                    "zoom:in" => (*z + 0.1).min(2.0),
                    "zoom:out" => (*z - 0.1).max(0.6),
                    _ => 1.0,
                };
                let _ = window.set_zoom(*z);
            }
        }
        "win:fullscreen" => {
            let full = window.is_fullscreen().unwrap_or(false);
            let _ = window.set_fullscreen(!full);
        }
        "app:home" => {
            let _ = app.opener().open_url(HOMEPAGE, None::<&str>);
        }
        "app:about" => {
            app.dialog()
                .message(format!(
                    "卡片盒 {}\n卢曼卡片笔记，所有卡片都保存在这台电脑上。\n\n{HOMEPAGE}",
                    app.package_info().version
                ))
                .title("关于卡片盒")
                .kind(MessageDialogKind::Info)
                .show(|_| {});
        }
        _ => {}
    }
}

fn is_app_url(url: &tauri::Url) -> bool {
    url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") || url.scheme() == "about"
}

/// Selftest: run the script after the page has started, report the result back.
fn selftest_script(path: &str) -> Res<String> {
    let body = fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))?;
    // injected scripts have no base URL, so relative module paths are made absolute
    let body = body.replace("import('./", "import(location.origin + '/");
    Ok(format!(
        "window.addEventListener('DOMContentLoaded', () => setTimeout(async () => {{
           let out;
           try {{ out = await (async () => {{\n{body}\n}})(); }}
           catch (e) {{ out = 'SELFTEST ERROR: ' + (e && e.message || e) + ' @ ' + (e && e.stack || ''); }}
           window.__TAURI__.core.invoke('zk', {{ msg: {{ cmd: 'selftestResult', value: String(out) }} }});
         }}, 0));"
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let selftest = std::env::var("ZK_SELFTEST").ok();
    let mut builder = tauri::Builder::default();
    // self-tests run several instances side by side (the LAN sync test needs two)
    #[cfg(desktop)]
    if selftest.is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![zk])
        .setup(move |app| {
            let dev_dir = std::env::var("ZK_DATA_DIR").ok().map(PathBuf::from);
            let root = match &dev_dir {
                Some(d) => d.clone(),
                None => app.path().data_dir()?.join("卡片盒"),
            };
            let out = std::env::var("ZK_SELFTEST_OUT").ok().map(PathBuf::from);
            let state = match init_state(root, dev_dir.is_some(), out) {
                Ok(s) => s,
                Err(e) => {
                    app.dialog().message(e.clone()).title("无法打开卡片盒数据").kind(MessageDialogKind::Error).blocking_show();
                    return Err(e.into());
                }
            };
            let title = state.box_name();
            app.manage(state);

            let handle = app.handle().clone();
            let external = handle.clone();
            let new_window = handle.clone();
            let mut window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title(title)
                .inner_size(1180.0, 780.0)
                .min_inner_size(420.0, 400.0)
                .visible(selftest.is_none() || std::env::var("ZK_SELFTEST_VISIBLE").is_ok())
                .on_navigation(move |url| {
                    if is_app_url(url) {
                        return true;
                    }
                    let _ = external.opener().open_url(url.as_str(), None::<&str>);
                    false
                })
                .on_new_window(move |url, _features| {
                    if !is_app_url(&url) {
                        let _ = new_window.opener().open_url(url.as_str(), None::<&str>);
                    }
                    NewWindowResponse::Deny
                });
            if let Some(path) = &selftest {
                window = window.initialization_script(selftest_script(path)?);
            }
            let window = window.build()?;

            // Browser shortcuts (F5 reload, Ctrl+P print, Ctrl+J downloads…) would make the app
            // feel like a web page and collide with the menu, so WebView2 gets them turned off.
            #[cfg(windows)]
            window.with_webview(|wv| unsafe {
                use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
                use windows::core::Interface;
                if let Ok(core) = wv.controller().CoreWebView2() {
                    if let Ok(settings) = core.Settings() {
                        if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                            let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
                        }
                    }
                }
            })?;
            #[cfg(not(windows))]
            let _ = &window;

            app.set_menu(build_menu(&handle)?)?;
            app.on_menu_event(|app, event| on_menu(app, event.id().as_ref()));

            if selftest.is_none() {
                let bg = handle.clone();
                std::thread::spawn(move || loop {
                    backup_if_due(&bg.state::<AppState>());
                    std::thread::sleep(Duration::from_secs(3600));
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building 卡片盒");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if std::env::var("ZK_SELFTEST").is_err() {
                backup_if_due(&app.state::<AppState>());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn box_names() {
        for ok in ["course-notes", "我的卡片盒", "a b"] {
            assert!(Boxes::is_valid(ok), "{ok}");
        }
        for bad in ["", " a", "a ", ".x", "x.", "a/b", "a\\b", "a:b", "a*b", "a?b", "a\"b", "a<b", "a|b", "CON", "lpt1"] {
            assert!(!Boxes::is_valid(bad), "{bad}");
        }
    }

    #[test]
    fn database_roundtrip() {
        let dir = std::env::temp_dir().join(format!("slipbox-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let mut db = Database::open(&dir.join("t.db")).unwrap();
        db.put(r#"[{"uid":"a","zid":"1","kind":"note","title":"t","body":"b","keywords":["k"],"createdAt":1,"updatedAt":2,"deleted":false}]"#).unwrap();
        db.put(r#"[{"uid":"a","zid":"1a","kind":"note","title":"t2","body":"b","createdAt":1,"updatedAt":3.0}]"#).unwrap();
        let all: Vec<Value> = serde_json::from_str(&db.load_all().unwrap()).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0]["zid"], "1a");
        db.backup(&dir.join("backup.db")).unwrap();
        // backups in the same second get distinct names
        let a = make_backup(&db, &dir.join("b")).unwrap();
        let b = make_backup(&db, &dir.join("b")).unwrap();
        assert_ne!(a, b);
        assert_eq!(count_cards(&dir.join("backup.db")), 1);
        db.delete(&["a".into()], &HashMap::new()).unwrap();
        assert!(db.purged_json().unwrap().contains("\"uid\":\"a\""));
        let id = db.box_id().unwrap();
        assert_eq!(db.box_id().unwrap(), id);
        assert_eq!(db.count(), 0);
        let _ = fs::remove_dir_all(&dir);
    }
}
