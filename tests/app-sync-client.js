// LAN sync between two running apps, the side where the user taps 同步 (see app-sync-host.js):
//   ZK_DATA_DIR=/tmp/zk-client ZK_SYNC_NO_BONJOUR=1 ZK_DEVICE_NAME=客户端 ZK_SELFTEST=$PWD/tests/app-sync-client.js <app>
// Pairs with the host on HOST (prepended by the test runner; default 127.0.0.1:51517), syncs, edits and deletes, syncs again and checks
// the result on this side; the host's report is checked by scripts/sync-selftest.sh.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 100 && !document.querySelector('#list'); i++) await wait(50);
const store = await import('./js/store.js');
const sync = await import('./js/sync.js');
const backend = await import('./js/backend.js');
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };
const address = typeof HOST === 'string' ? HOST : '127.0.0.1:51517';

// the same ID as a card on the host: one of them has to move
await store.run('create', { uid: 'c-1', kind: 'note', zid: '1', title: '客户端的 1', body: '客户端写的' });
await store.run('create', { uid: 'c-2', kind: 'fleeting', title: '客户端的闪念', body: '' });

let conn;
for (let i = 0; i < 60 && !conn; i++) {
  try { conn = await sync.connect({ address }); } catch { await wait(500); }
}
assert(conn, 'cannot connect to the host');
const out = { platform: backend.platform, firstPaired: conn.paired, code: /^\d{6}$/.test(conn.code), peer: conn.peer.name };
await sync.pair(conn, Promise.resolve(true));
let plan = await sync.plan(conn);
out.plan1 = plan.rows.map((r) => `${r.action}:${r.local}`).sort();
plan.rows.forEach((r) => { r.checked = true; });
let results = await sync.run(conn, plan);
await sync.close(conn);
assert(results.every((r) => !r.error), 'sync 1: ' + JSON.stringify(results));
out.sync1 = results.map((r) => ({ box: r.row.local, ...r.summary.added, renumbered: r.summary.renumbered.map((x) => `${x.from}->${x.to}`) }));
await wait(500); // the page reloads the box after a sync
const zids = [...store.S.cards.values()].filter((c) => c.kind === 'note' && !c.deleted).map((c) => c.zid);
assert(new Set(zids).size === zids.length, 'duplicate IDs after sync: ' + zids);
assert(store.S.cards.has('h-1') && store.S.cards.has('h-3'), 'host cards missing');
out.boxes = (await backend.boxes()).boxes.map((b) => b.name).sort();

// edit, move to the trash and purge, then sync again (already paired: no code this time).
// The host edits h-3 right after the first sync: wait until it has (reading its box over the
// connection), then edit here, later, so this edit wins.
for (let i = 0; i < 200; i++) {
  const c = await sync.connect({ address });
  const r = JSON.parse(await backend.call('sync', { op: 'request', session: c.session, msg: JSON.stringify({ op: 'read', box: '我的卡片盒' }) }));
  await sync.close(c);
  if (r.cards.find((x) => x.uid === 'h-3')?.body === '主机改过的闪念') break;
  await wait(250);
}
await wait(50);
await store.run('update', 'h-3', { body: '客户端改过的闪念' });
await store.run('update', 'c-1', { body: '客户端第二次写的' });
await store.run('remove', 'h-2');
await store.purge(['h-2']);
conn = await sync.connect({ address });
out.secondPaired = conn.paired;
plan = await sync.plan(conn);
out.plan2 = plan.rows.map((r) => `${r.action}:${r.local}`).sort();
results = await sync.run(conn, plan);
await sync.close(conn);
assert(results.every((r) => !r.error), 'sync 2: ' + JSON.stringify(results));
out.sync2 = results.map((r) => ({ box: r.row.local, conflicts: r.summary.conflicts.length, purged: r.summary.purged }));
await wait(500);
const h3 = store.S.cards.get('h-3');
out.h3 = h3.body;
out.conflictCopy = [...store.S.cards.values()].filter((c) => c.meta?.conflictOf === 'h-3').map((c) => c.body);
out.h2gone = !store.S.cards.has('h-2');
out.paired = (await sync.state()).paired.map((p) => p.name);
return JSON.stringify(out);
