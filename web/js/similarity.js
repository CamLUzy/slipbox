// Lexical similarity between cards, computed locally without any model:
// TF-IDF over Chinese character bigrams and Latin words. Used to pick candidate
// cards before asking the AI, and to find context for chat questions.

const STOP = new Set(['的', '了', '是', '在', '和', '与', '也', '就', '都', '而', '及', '或', '一个', '我们', '这个', '可以', '因为', '所以', '如果', '没有', '不是', 'the', 'and', 'of', 'to', 'a', 'in', 'is', 'for']);

export function tokenize(text) {
  const out = [];
  const s = String(text || '')
    .replace(/\[\[[^\]]*\]\]/g, ' ') // links are relations, not content
    .replace(/[`*_#>~=\-\[\]()|!]/g, ' ')
    .toLowerCase();
  for (const m of s.matchAll(/[\p{Script=Han}]+|[a-z0-9]{2,}/gu)) {
    const w = m[0];
    if (/^[a-z0-9]/.test(w)) {
      if (!STOP.has(w)) out.push(w);
      continue;
    }
    if (w.length === 1) {
      if (!STOP.has(w)) out.push(w);
      continue;
    }
    for (let i = 0; i < w.length - 1; i++) {
      const bg = w.slice(i, i + 2);
      if (!STOP.has(bg)) out.push(bg);
    }
  }
  return out;
}

function vectorOf(c) {
  const tf = new Map();
  const add = (text, weight) => {
    for (const t of tokenize(text)) tf.set(t, (tf.get(t) || 0) + weight);
  };
  add(c.title, 3);
  add((c.keywords || []).join(' '), 3);
  add(c.body, 1);
  if (c.meta?.author) add(c.meta.author, 1);
  return tf;
}

const cache = new WeakMap();

// ix: the object from store.index(); rebuilt whenever the cards change.
export function model(ix) {
  if (cache.has(ix)) return cache.get(ix);
  const cards = [...ix.notes, ...ix.lits, ...ix.fleeting];
  const raw = cards.map(vectorOf);
  const df = new Map();
  for (const v of raw) for (const t of v.keys()) df.set(t, (df.get(t) || 0) + 1);
  const n = cards.length;
  const idf = (t) => Math.log((n + 1) / ((df.get(t) || 0) + 1)) + 1;
  const vecs = raw.map((v) => {
    const w = new Map();
    let norm = 0;
    for (const [t, f] of v) {
      const x = (1 + Math.log(f)) * idf(t);
      w.set(t, x);
      norm += x * x;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, x] of w) w.set(t, x / norm);
    return w;
  });
  const byUid = new Map(cards.map((c, i) => [c.uid, i]));
  const m = { cards, vecs, byUid, idf };
  cache.set(ix, m);
  return m;
}

function cosine(a, b) {
  if (a.size > b.size) [a, b] = [b, a];
  let s = 0;
  for (const [t, x] of a) {
    const y = b.get(t);
    if (y) s += x * y;
  }
  return s;
}

export function related(ix, card, k = 10, filter = () => true) {
  const m = model(ix);
  const i = m.byUid.get(card.uid);
  const v = i === undefined ? vectorOf(card) : m.vecs[i];
  return m.cards
    .map((c, j) => [cosine(v, m.vecs[j]), c])
    .filter(([s, c]) => s > 0.02 && c.uid !== card.uid && filter(c))
    .sort((a, b) => b[0] - a[0])
    .slice(0, k);
}

export function search(ix, text, k = 6) {
  const m = model(ix);
  const tf = new Map();
  for (const t of tokenize(text)) tf.set(t, (tf.get(t) || 0) + 1);
  const q = new Map();
  let norm = 0;
  for (const [t, f] of tf) {
    const x = (1 + Math.log(f)) * m.idf(t);
    q.set(t, x);
    norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [t, x] of q) q.set(t, x / norm);
  return m.cards
    .map((c, j) => [cosine(q, m.vecs[j]), c])
    .filter(([s]) => s > 0.03)
    .sort((a, b) => b[0] - a[0])
    .slice(0, k);
}

// The most similar pairs of notes/literature that are not linked yet.
export function unlinkedPairs(ix, max = 24, isLinked = () => false) {
  const m = model(ix);
  const pairs = [];
  const idxs = m.cards.map((c, i) => [c, i]).filter(([c]) => c.kind !== 'fleeting');
  for (let a = 0; a < idxs.length; a++) {
    for (let b = a + 1; b < idxs.length; b++) {
      const [ca, ia] = idxs[a];
      const [cb, ib] = idxs[b];
      const s = cosine(m.vecs[ia], m.vecs[ib]);
      if (s > 0.08 && !isLinked(ca, cb)) pairs.push([s, ca, cb]);
    }
  }
  return pairs.sort((x, y) => y[0] - x[0]).slice(0, max);
}
