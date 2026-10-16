// iPhone screenshots in the iOS simulator (see the "Screenshots" step in .github/workflows/build.yml).
// Runs as the app's self-test script with DATA (docs/demo/demo-box.json) prepended. It shows one
// screen every 8 seconds while the workflow takes `simctl io screenshot` from outside.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const until = (s) => wait(Math.max(0, t0 + s * 1000 - Date.now()));
for (let i = 0; i < 100 && !document.querySelector('#list'); i++) await wait(50);

const still = document.createElement('style');
still.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }';
document.head.append(still);

const backend = await import('./js/backend.js');
const store = await import('./js/store.js');
await backend.createBox('卡片盒方法');
await store.importCards(DATA.cards);
document.querySelector('.box-name').textContent = '卡片盒方法';
const uid = (z) => DATA.cards.find((c) => c.zid === z).uid;
const go = async (hash) => {
  const changed = new Promise((r) => window.addEventListener('hashchange', r, { once: true }));
  location.hash = hash;
  await changed;
  await wait(300);
};
const theme = (t) => { document.documentElement.dataset.theme = t; };

// 1. the Folgezettel tree (shot at ~8 s)
theme('light');
await go('#/list/tree');
document.querySelector('[data-act=expand-all]')?.click();
await until(10);

// 2. a card with its sequence, links and backlinks (shot at ~16 s)
await go(`#/card/${uid('3')}`);
await until(18);

// 3. the relation graph, dark (shot at ~24 s)
theme('dark');
await go(`#/card/${uid('1')}`);
document.querySelector('[data-act=graph]')?.click();
await until(26);

// 4. the keyword register (shot at ~32 s)
document.querySelector('.modal-wrap')?.remove();
theme('light');
await go('#/list/index');
await until(36);
return 'shots done';
