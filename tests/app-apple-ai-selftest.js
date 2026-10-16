// The on-device Apple model inside the Mac or iOS app (macOS / iOS 26 with Apple Intelligence on):
//   ZK_DATA_DIR=/tmp/zk-apple ZK_SELFTEST=$PWD/tests/app-apple-ai-selftest.js "dist/卡片盒.app/Contents/MacOS/Zettelkasten"
// Without the model it only reports why it is unavailable.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 100 && !document.querySelector('#list'); i++) await wait(50);
const ai = await import('./js/ai.js');
const out = { status: await ai.appleStatus() };
if (!out.status.available) return JSON.stringify(out);

ai.cfg.provider = 'apple'; // for this run only (setCfg would remember it)
const t0 = performance.now();
const lap = () => `${((performance.now() - t0) / 1000).toFixed(1)}s`;
let chunks = 0;
const r = await ai.chat([{ role: 'system', content: '用简体中文回答，一两句话。' }, { role: 'user', content: '卢曼的卡片盒笔记法是什么？' }], { onToken: () => chunks++ });
out.chat = { answer: r.content, chunks, at: lap() };

const cards = [
  { uid: 'a', kind: 'note', zid: '1', title: '卡片盒是一个可以对话的伙伴', body: '卡片足够多之后，它会给出意想不到的组合。', keywords: [] },
  { uid: 'b', kind: 'note', zid: '2', title: '一张卡片只写一个观点', body: '原子化让卡片可以被重新组合。', keywords: [] },
];
const note = { uid: 'f', kind: 'fleeting', zid: null, title: '', body: '今天读书想到：链接比卡片本身更重要，孤立的卡片没什么用', keywords: [] };
const org = await ai.organize(note, { candidates: cards, keywords: ['卡片盒', '链接'] });
out.organize = { ...org, at: lap() };
out.relate = await ai.relate(cards[0], [cards[1]]).then((x) => ({ summary: x.summary, n: x.relations.length, at: lap() }), (e) => `error: ${e.message}`);
return JSON.stringify(out, null, 1);
