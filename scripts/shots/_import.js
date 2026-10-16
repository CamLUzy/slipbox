for (let i = 0; i < 100 && !document.querySelector('#list'); i++) await new Promise((r) => setTimeout(r, 50));
const store = await import('/js/store.js');
await store.importCards(DATA.cards);
const zid = (z) => DATA.cards.find((c) => c.zid === z).uid;
// Navigate and wait until the route has rendered (hashchange arrives asynchronously).
const go = async (hash) => {
  const changed = new Promise((r) => window.addEventListener('hashchange', r, { once: true }));
  location.hash = hash;
  await changed;
  await new Promise((r) => setTimeout(r, 300));
};
// Off-screen snapshots miss elements on their own compositing layer while they animate.
const still = document.createElement('style');
still.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }';
document.head.append(still);
