// LAN sync between two running apps, the host side. Start it first, then tests/app-sync-client.js
// with another data folder (scripts/sync-selftest.sh does both):
//   ZK_DATA_DIR=/tmp/zk-host ZK_SYNC_PORT=51517 ZK_SYNC_NO_BONJOUR=1 ZK_DEVICE_NAME=主机 ZK_SELFTEST=$PWD/tests/app-sync-host.js <app>
// Accepts the pairing request, waits for the client's two syncs and reports this box's cards.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 100 && !document.querySelector('#list'); i++) await wait(50);
const store = await import('./js/store.js');
const sync = await import('./js/sync.js');
const backend = await import('./js/backend.js');

await store.run('create', { uid: 'h-1', kind: 'note', zid: '1', title: '主机上的 1', body: '见 [[1a]]' });
await store.run('create', { uid: 'h-2', kind: 'note', zid: '1a', title: '主机上的 1a', body: '会被客户端删除' });
await store.run('create', { uid: 'h-3', kind: 'fleeting', title: '主机的闪念', body: '两边都会改' });
await backend.createBox('只在主机上');
await store.open();
await store.run('create', { uid: 'h-9', kind: 'note', zid: '1', title: '主机独有卡片盒里的卡片', body: '' });
await backend.switchBox('我的卡片盒');
await store.open();

let done = 0; // finished sync sessions (the client also connects to look, see app-sync-client.js)
const events = [];
sync.onEvent((e) => {
  events.push(e.type);
  if (e.type === 'pair') sync.answer(e.id, true);
  if (e.type === 'hostDone') done++;
});
location.hash = '#/sync'; // the page starts listening
// finished when the client's second sync has arrived (its second edit of c-1)
const second = () => store.S.cards.get('c-1')?.body === '客户端第二次写的';
let edited = false;
for (let i = 0; i < 1200 && !second(); i++) {
  await wait(100);
  // between the client's two syncs both devices edit h-3, the host first (once)
  if (done >= 1 && !edited) {
    edited = true;
    await store.run('update', 'h-3', { body: '主机改过的闪念' });
  }
}
await wait(500);
const cards = (await backend.loadCards()).map((c) => ({ zid: c.zid, title: c.title, body: c.body, kind: c.kind, deleted: c.deleted }));
cards.sort((a, b) => (a.title < b.title ? -1 : 1));
const st = await sync.state();
return JSON.stringify({ platform: backend.platform, syncs: done, paired: st.paired.map((p) => p.name), boxes: (await backend.boxes()).boxes.map((b) => b.name), events: [...new Set(events)].sort(), cards });
