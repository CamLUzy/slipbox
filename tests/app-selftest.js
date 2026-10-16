// Runs inside the Mac app's WebView (body of an async function):
//   ZK_DATA_DIR=/tmp/zk-test ZK_SELFTEST=tests/app-selftest.js "dist/卡片盒.app/Contents/MacOS/Zettelkasten"
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 100 && !document.querySelector('#list'); i++) await wait(50);
const store = await import('./js/store.js');
const backend = await import('./js/backend.js');
const out = { native: backend.isNative, shell: !!document.querySelector('#list') };

await store.run('create', { uid: 't-1', kind: 'note', title: '第一张', body: '见 [[1a]] 与 [[@Luhmann1981]]' }, { rel: 'top' });
await store.run('create', { uid: 't-2', kind: 'note', title: '第二张', body: '分支' }, { rel: 'branch', ref: '1' });
await store.run('create', { uid: 't-3', kind: 'literature', zid: 'Luhmann1981', title: '书', body: '摘要' });
await store.run('create', { uid: 't-4', kind: 'fleeting', body: '闪念' });
await store.run('move', 't-2', '5');
await store.run('remove', 't-4');
await store.purge(['t-4']);
out.persisted = (await backend.loadCards()).map((c) => `${c.uid}:${c.zid}:${c.body}`).sort();

try {
  localStorage.setItem('zk.selftest', '1');
  out.localStorage = localStorage.getItem('zk.selftest') === '1';
} catch (e) {
  out.localStorage = String(e);
}
out.info = await backend.info();
out.backup = await backend.backupNow();

location.hash = '#/card/t-1';
await wait(300);
out.cardTitle = document.querySelector('.sheet-head h1')?.textContent;
out.links = [...document.querySelectorAll('.md .zl')].map((a) => `${a.textContent}->${a.getAttribute('href') || 'broken'}`);
out.docTitle = document.title;
out.tree = [...document.querySelectorAll('.tree-row .zid')].map((e) => e.textContent);
// iPhone: the page itself never zooms, and fields are at least 16px (or iOS zooms into them)
out.viewport = document.querySelector('meta[name=viewport]')?.content;
const probe = document.createElement('div');
probe.className = 'chat-input';
probe.innerHTML = '<textarea></textarea>';
document.body.append(probe);
out.fieldFont = getComputedStyle(probe.firstChild).fontSize;
probe.remove();
return JSON.stringify(out, null, 1);
