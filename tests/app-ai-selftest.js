// AI self-test inside the Mac app (needs Ollama + the model; loads it for ~1 minute):
//   ZK_DATA_DIR=/tmp/zk-ai ZK_SELFTEST=$PWD/tests/app-ai-selftest.js "dist/卡片盒.app/Contents/MacOS/Zettelkasten"
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 100 && !document.querySelector('#list'); i++) await wait(50);
const store = await import('./js/store.js');
const ai = await import('./js/ai.js');
const sim = await import('./js/similarity.js');
const out = {};
const t0 = performance.now();
const lap = () => `${((performance.now() - t0) / 1000).toFixed(1)}s`;

await store.importCards([
  { uid: 'n1', kind: 'note', zid: '1', title: '卡片盒是沟通伙伴', body: '卡片之间的链接足够多时，卡片盒会给出意料之外的回答。', keywords: ['卡片盒'] },
  { uid: 'n1a', kind: 'note', zid: '1a', title: '固定编号让卡片可以被引用', body: '每张卡片的编号永不改变，因此别的卡片可以链接到它。' },
  { uid: 'n2', kind: 'note', zid: '2', title: '一张卡片只写一个观点', body: '原子性：每张卡片只写一个观点，并且用自己的话写，脱离上下文也能读懂。', keywords: ['原子性'] },
  { uid: 'n3', kind: 'note', zid: '3', title: '摘抄不等于理解', body: '把书里的句子直接复制进卡片盒，只是在堆资料，没有经过自己的思考。' },
  { uid: 'f1', kind: 'fleeting', body: '今天想到：链接比卡片本身更重要，一张孤立的卡片几乎没有价值，要和已有的卡片连起来' },
]);
const ix = store.index();
out.status0 = await ai.status();
ai.setCfg({ keepAlive: '1m' });

// streaming chat through the bridge
let chunks = 0;
const ctx = sim.search(ix, '为什么要用自己的话写卡片', 3).map(([, c]) => c);
const r = await ai.chat(ai.chatMessages([], '为什么要用自己的话写卡片？一句话回答。', ctx), { onToken: () => chunks++ });
out.chat = { ctx: ctx.map((c) => c.zid), chunks, answer: r.content.slice(0, 160), at: lap() };

// organize a fleeting note
const cands = sim.related(ix, ix.fleeting[0], 8, (c) => c.kind === 'note').map(([, c]) => c);
const o = await ai.organize(ix.fleeting[0], { candidates: cands, keywords: [...ix.keywords.keys()] });
out.organize = { ...o, at: lap() };

// relations of one card
const rel = await ai.relate(ix.byZid.get('2'), [ix.byZid.get('3'), ix.byZid.get('1'), ix.byZid.get('1a')]);
out.relate = { summary: rel.summary, relations: rel.relations.map((x) => `${x.card.zid} ${x.type}：${x.reason}`), at: lap() };

// cancellation
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 700);
try {
  await ai.chat([{ role: 'user', content: '写一篇 800 字的文章。' }], { signal: ctrl.signal });
  out.cancel = 'not cancelled';
} catch (e) {
  out.cancel = e.code;
}
out.status1 = await ai.status();
await ai.unload();
await wait(500);
out.status2 = (await ai.status()).loaded;
return JSON.stringify(out, null, 1);
