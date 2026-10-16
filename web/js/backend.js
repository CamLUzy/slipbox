// Where the cards live. Inside the Mac app (mac/main.swift) they go to a SQLite file
// through the `zk` message handler; in a plain browser they go to IndexedDB.
import { lsGet, lsSet } from './util.js';

const native = window.webkit?.messageHandlers?.zk;
const DEFAULT_BOX = '我的卡片盒';

export const isNative = !!native;

export const call = (cmd, args = {}) => native.postMessage({ cmd, ...args });

// ---------- IndexedDB fallback ----------

let idb = null;

function req(r) {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function openIdb() {
  if (idb) return idb;
  idb = await new Promise((res, rej) => {
    const r = indexedDB.open(idbName(lsGet('zk.box', DEFAULT_BOX)), 1);
    r.onupgradeneeded = () => r.result.createObjectStore('cards', { keyPath: 'uid' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return idb;
}

function idbWrite(fn) {
  const tx = idb.transaction('cards', 'readwrite');
  fn(tx.objectStore('cards'));
  return new Promise((res, rej) => {
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

const idbName = (box) => (box === DEFAULT_BOX ? 'zettelkasten-local' : `zettelkasten-local:${box}`);

// ---------- slip boxes ----------
// The Mac app keeps one SQLite file per box; the browser keeps one IndexedDB database per box.

export async function boxes() {
  if (native) return JSON.parse(await call('boxes'));
  const names = lsGet('zk.boxes', [DEFAULT_BOX]);
  return { current: lsGet('zk.box', DEFAULT_BOX), boxes: names.map((name) => ({ name, cards: -1 })) };
}

const validName = (n) => n && n === n.trim() && n.length <= 60 && !n.startsWith('.') && !/[/\\:]/.test(n);

export async function createBox(name) {
  if (native) return call('createBox', { name });
  const names = lsGet('zk.boxes', [DEFAULT_BOX]);
  if (!validName(name)) throw new Error('名称不能为空，也不能包含 / \\ : 或以 . 开头');
  if (names.includes(name)) throw new Error(`已经有叫“${name}”的卡片盒了`);
  lsSet('zk.boxes', [...names, name]);
  lsSet('zk.box', name);
}

export async function switchBox(name) {
  if (native) return call('switchBox', { name });
  lsSet('zk.box', name);
}

export async function renameBox(name, to) {
  if (native) return call('renameBox', { name, to });
  const names = lsGet('zk.boxes', [DEFAULT_BOX]);
  if (!validName(to) || names.includes(to)) throw new Error(`名称“${to}”不可用`);
  const all = await new Promise((res, rej) => {
    const r = indexedDB.open(idbName(name), 1);
    r.onupgradeneeded = () => r.result.createObjectStore('cards', { keyPath: 'uid' });
    r.onsuccess = () => req(r.result.transaction('cards').objectStore('cards').getAll()).then((v) => { r.result.close(); res(v); }, rej);
    r.onerror = () => rej(r.error);
  });
  await new Promise((res, rej) => {
    const r = indexedDB.open(idbName(to), 1);
    r.onupgradeneeded = () => r.result.createObjectStore('cards', { keyPath: 'uid' });
    r.onsuccess = () => {
      const tx = r.result.transaction('cards', 'readwrite');
      all.forEach((c) => tx.objectStore('cards').put(c));
      tx.oncomplete = () => { r.result.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
    r.onerror = () => rej(r.error);
  });
  if (idb && lsGet('zk.box', DEFAULT_BOX) === name) { idb.close(); idb = null; }
  indexedDB.deleteDatabase(idbName(name));
  lsSet('zk.boxes', names.map((n) => (n === name ? to : n)));
  if (lsGet('zk.box', DEFAULT_BOX) === name) lsSet('zk.box', to);
}

export async function deleteBox(name) {
  if (native) return call('deleteBox', { name });
  if (name === lsGet('zk.box', DEFAULT_BOX)) throw new Error('不能删除正在使用的卡片盒');
  indexedDB.deleteDatabase(idbName(name));
  lsSet('zk.boxes', lsGet('zk.boxes', [DEFAULT_BOX]).filter((n) => n !== name));
}

// ---------- API ----------

export async function loadCards() {
  if (native) return JSON.parse((await call('load')) || '[]');
  await openIdb();
  return req(idb.transaction('cards').objectStore('cards').getAll());
}

export async function putCards(cards) {
  if (!cards.length) return;
  if (native) return call('put', { cards: JSON.stringify(cards) });
  return idbWrite((os) => cards.forEach((c) => os.put(c)));
}

export async function deleteCards(uids) {
  if (!uids.length) return;
  if (native) return call('delete', { uids });
  return idbWrite((os) => uids.forEach((u) => os.delete(u)));
}

export async function info() {
  if (native) return JSON.parse(await call('info'));
  return { dataPath: '浏览器本地存储（IndexedDB）', backups: [], native: false, box: lsGet('zk.box', DEFAULT_BOX) };
}

export const backupNow = () => call('backup');
export const reveal = (what = 'data') => call('reveal', { what });

// Returns true when the file was written (false if the user cancelled the save panel).
export async function saveFile(name, content) {
  if (native) return !!(await call('saveFile', { name, content }));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return true;
}

// files: [{ path: 'dir/name.md', content }]; returns the folder written, or null.
export const exportFiles = (folder, files) => call('exportFiles', { folder, files: JSON.stringify(files) });

// Lets the user pick a text file; resolves to its content or null.
export async function openTextFile() {
  if (native) return (await call('openFile')) ?? null;
  return new Promise((res) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => (input.files[0] ? input.files[0].text().then(res) : res(null));
    input.click();
  });
}
