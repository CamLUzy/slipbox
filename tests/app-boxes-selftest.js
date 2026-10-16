// Slip box management inside the desktop app (creates, renames, switches and deletes boxes):
//   ZK_DATA_DIR=/tmp/zk-boxes ZK_SELFTEST=$PWD/tests/app-boxes-selftest.js <app binary>
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 100 && !document.querySelector('#list'); i++) await wait(50);
const store = await import('./js/store.js');
const backend = await import('./js/backend.js');
const out = { platform: backend.platform, start: (await backend.boxes()).current };
await store.run('create', { uid: 'b-1', kind: 'note', title: '默认盒里的卡片', body: 'x' }, { rel: 'top' });
await backend.createBox('课程-A');
out.afterCreate = await backend.boxes();
out.emptyNewBox = (await backend.loadCards()).length;
await backend.putCards([{ uid: 'b-2', kind: 'note', zid: '1', title: '新盒子', body: 'y', keywords: [], createdAt: 1, updatedAt: 1, deleted: false }]);
await backend.renameBox('课程-A', '课程-B');
out.afterRename = (await backend.boxes()).current;
out.renamedCards = (await backend.loadCards()).length;
try { await backend.createBox('bad:name'); out.badName = 'accepted'; } catch (e) { out.badName = String(e.message || e); }
await backend.switchBox(out.start);
out.backToStart = (await backend.loadCards()).map((c) => c.title);
await backend.deleteBox('课程-B');
out.afterDelete = (await backend.boxes()).boxes.map((b) => b.name);
return JSON.stringify(out);
