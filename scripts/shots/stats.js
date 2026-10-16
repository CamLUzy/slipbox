// 写作记录 with a year of made-up writing history on top of the demo box (fleeting notes,
// deterministic), so the graph has something to show.
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const now = Date.now();
const extra = [];
for (let d = 364; d >= 1; d--) {
  const weekday = new Date(now - d * 864e5).getDay();
  const busy = weekday === 0 || weekday === 6 ? 0.45 : 0.75; // fewer cards at the weekend
  const streak = d < 12 ? 1 : busy;
  if (rnd() > streak) continue;
  const n = 1 + Math.floor(rnd() * rnd() * 7);
  for (let i = 0; i < n; i++) {
    const t = now - d * 864e5 + Math.floor(rnd() * 8) * 3600e3;
    extra.push({ uid: `hist-${d}-${i}`, kind: 'fleeting', title: '', body: `记录 ${d}-${i}`, createdAt: t, updatedAt: t, deleted: true });
  }
}
await store.importCards(extra);
await go(globalThis.SHOT_HASH || '#/stats');
