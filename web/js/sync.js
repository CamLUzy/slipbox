// LAN sync, the page's part (docs/SYNC.md). The native shell finds devices, runs the encrypted
// connection and answers hello/read/write for its slip boxes; this module decides which boxes
// go together and merges them with merge.js, on the device where the user tapped 同步.
import * as backend from './backend.js';
import { mergeBoxes } from './merge.js';

export const available = backend.isNative;

const call = (op, args = {}) => backend.call('sync', { op, ...args });
const parsed = async (p) => JSON.parse(await p);

// { device, listening, port, addresses, paired, nearby }
export const state = () => parsed(call('state'));
export const start = () => parsed(call('start'));
export const stop = () => call('stop');
export const rename = (name) => parsed(call('rename', { name }));
export const forget = (id) => parsed(call('forget', { id }));
export const answer = (id, ok) => call('answer', { id, ok });

// Events from the shell: state, pair, pairEnd, hostStart, hostDone, changed, error.
const handlers = new Set();
export function onEvent(fn) {
  handlers.add(fn);
  return () => handlers.delete(fn);
}
window.zkSyncEvent = (e) => {
  for (const fn of handlers) fn(e);
};

export class SyncError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// One request to this device (`local`) or the connected one; replies {ok, ...}.
async function rpc(target, msg) {
  const text = target.session
    ? await call('request', { session: target.session, msg: JSON.stringify(msg) })
    : await call('local', { msg: JSON.stringify({ ...msg, peer: target.peer }) });
  const r = JSON.parse(text);
  if (!r.ok) throw new SyncError(r.error || '同步失败', r.code);
  return r;
}

/**
 * Connects to a nearby device ({peer: id}) or an address ({address: 'host:port'}).
 * Returns a connection { session, code, peer, paired, local, remote }.
 */
export async function connect(target) {
  const r = JSON.parse(await call('connect', target));
  return { ...r, local: { peer: r.peer.id }, remote: { session: r.session } };
}

export const close = (conn) => call('close', { session: conn.session }).catch(() => {});

/**
 * Pairing: the other device shows the same code and asks its user. `confirmed` resolves
 * when the user here has compared the codes (true) or cancelled (false).
 */
export async function pair(conn, confirmed) {
  const theirs = rpc(conn.remote, { op: 'pair' });
  theirs.catch(() => {});
  if (!(await confirmed)) throw new SyncError('已取消配对', 'cancelled');
  await theirs;
  await rpc(conn.remote, { op: 'paired' });
  await call('trust', { session: conn.session });
}

/**
 * Which slip boxes go together. Rows: { action, local, remote, cards: {local, remote}, checked }
 * action: sync (same box, synced before), merge (same name, first time), toRemote, toLocal.
 */
export async function plan(conn) {
  const [mine, theirs] = await Promise.all([rpc(conn.local, { op: 'hello' }), rpc(conn.remote, { op: 'hello' })]);
  const rows = [];
  const left = new Map(theirs.boxes.map((b) => [b.name, b]));
  const byId = new Map(theirs.boxes.map((b) => [b.boxId, b]));
  for (const b of mine.boxes) {
    const same = byId.get(b.boxId);
    if (same && left.has(same.name)) {
      left.delete(same.name);
      rows.push({ action: 'sync', local: b.name, remote: same.name, cards: { local: b.cards, remote: same.cards }, checked: true });
    }
  }
  for (const b of mine.boxes) {
    if (rows.some((r) => r.local === b.name)) continue;
    const same = left.get(b.name);
    if (same) {
      left.delete(b.name);
      rows.push({ action: 'merge', local: b.name, remote: same.name, cards: { local: b.cards, remote: same.cards }, checked: true });
    } else {
      rows.push({ action: 'toRemote', local: b.name, remote: b.name, cards: { local: b.cards, remote: 0 }, checked: b.cards > 0 });
    }
  }
  for (const b of left.values()) {
    rows.push({ action: 'toLocal', local: b.name, remote: b.name, cards: { local: 0, remote: b.cards }, checked: b.cards > 0 });
  }
  return { device: mine.device, peer: theirs.device, rows };
}

/** Syncs the checked rows. Returns one result per row: { row, summary } or { row, error }. */
export async function run(conn, p, onStep = () => {}) {
  const results = [];
  for (const row of p.rows.filter((r) => r.checked)) {
    onStep(row);
    try {
      results.push({ row, summary: await syncRow(conn, p, row) });
    } catch (e) {
      results.push({ row, error: e.message || String(e) });
    }
  }
  return results;
}

async function syncRow(conn, p, row) {
  const syncedAt = Date.now();
  if (row.action === 'toRemote' || row.action === 'toLocal') {
    const [from, to, fromBox, toBox] = row.action === 'toRemote'
      ? [conn.local, conn.remote, row.local, row.remote]
      : [conn.remote, conn.local, row.remote, row.local];
    const src = await rpc(from, { op: 'read', box: fromBox });
    await rpc(to, { op: 'write', box: toBox, create: true, boxId: src.boxId, cards: src.cards, purged: src.purged, syncedAt });
    await rpc(from, { op: 'write', box: fromBox, cards: [], purged: [], syncedAt });
    const n = src.cards.length;
    return { added: row.action === 'toRemote' ? { local: 0, remote: n } : { local: n, remote: 0 }, updated: { local: 0, remote: 0 }, conflicts: [], renumbered: [], revived: [], purged: 0, created: true };
  }
  const [L, R] = await Promise.all([rpc(conn.local, { op: 'read', box: row.local }), rpc(conn.remote, { op: 'read', box: row.remote })]);
  const m = mergeBoxes({
    local: L.cards, remote: R.cards, localPurged: L.purged, remotePurged: R.purged,
    lastSync: row.action === 'merge' ? 0 : Math.min(L.lastSync || 0, R.lastSync || 0),
    localName: p.device.name, remoteName: p.peer.name,
    now: syncedAt, // cards the merge touches must not count as changed next time
  });
  // merging two separately created boxes: this one takes the other's identity
  await rpc(conn.local, { op: 'write', box: row.local, cards: m.local.put, purged: m.local.purge, syncedAt, boxId: row.action === 'merge' ? R.boxId : undefined });
  await rpc(conn.remote, { op: 'write', box: row.remote, cards: m.remote.put, purged: m.remote.purge, syncedAt });
  return m.summary;
}
