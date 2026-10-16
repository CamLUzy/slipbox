// One iPhone screenshot in the iOS simulator (see the "Screenshots" step in .github/workflows/build.yml).
// Runs as the app's self-test script with DATA (docs/demo/demo-box.json) and SCREEN prepended, shows
// that screen and keeps it for 10 seconds while the workflow takes `simctl io screenshot`.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
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
document.documentElement.dataset.theme = SCREEN === 'graph' ? 'dark' : 'light';

if (SCREEN === 'list') {
  await go('#/list/tree');
  document.querySelector('[data-act=expand-all]')?.click();
} else if (SCREEN === 'card') {
  await go(`#/card/${uid('3')}`);
} else if (SCREEN === 'graph') {
  await go(`#/card/${uid('1')}`);
  document.querySelector('[data-act=graph]')?.click();
} else if (SCREEN === 'index') {
  await go('#/list/index');
}
await wait(10000);
return `shot ${SCREEN}`;
