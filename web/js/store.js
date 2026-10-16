// All cards in memory, persisted through backend.js. Derived indexes are rebuilt lazily.
import * as Z from './luhmann.js';
import * as ops from './ops.js';
import * as backend from './backend.js';

export const S = { cards: new Map() };

let idx = null;
const listeners = new Set();

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  idx = null;
  for (const fn of listeners) fn();
}

export async function open() {
  const cards = await backend.loadCards();
  S.cards = new Map(cards.map((c) => [c.uid, c]));
  emit();
}

// Run one of the functions in ops.js and save what it changed. Throws ops.OpError.
export async function run(name, ...args) {
  const changed = ops[name](S.cards, ...args);
  for (const c of changed) S.cards.set(c.uid, c);
  emit();
  await backend.putCards(changed);
  return changed;
}

export async function importCards(list) {
  const r = ops.importCards(S.cards, list);
  for (const c of r.cards) S.cards.set(c.uid, c);
  emit();
  await backend.putCards(r.cards);
  return r;
}

// Permanently remove cards that are already in the trash.
export async function purge(uids) {
  const gone = uids.filter((u) => S.cards.get(u)?.deleted);
  gone.forEach((u) => S.cards.delete(u));
  emit();
  await backend.deleteCards(gone);
  return gone.length;
}

// ---------- derived indexes ----------

export function index() {
  return (idx ||= build());
}

export const zidSet = () => new Set(index().byZid.keys());

function push(map, key, val) {
  let arr = map.get(key);
  if (!arr) map.set(key, (arr = []));
  if (!arr.includes(val)) arr.push(val);
}

function build() {
  const notes = [];
  const fleeting = [];
  const lits = [];
  const trash = [];
  for (const c of S.cards.values()) {
    if (c.deleted) trash.push(c);
    else if (c.kind === 'note' && c.zid) notes.push(c);
    else if (c.kind === 'literature' && c.zid) lits.push(c);
    else fleeting.push(c);
  }
  notes.sort((a, b) => Z.compare(a.zid, b.zid));
  lits.sort((a, b) => a.zid.localeCompare(b.zid));
  fleeting.sort((a, b) => b.createdAt - a.createdAt);
  trash.sort((a, b) => b.updatedAt - a.updatedAt);

  const byZid = new Map(notes.map((c) => [c.zid, c]));
  const byKey = new Map(lits.map((c) => [c.zid, c]));
  const order = new Map(notes.map((c, i) => [c.uid, i]));

  // Folgezettel tree. Missing ancestors (deleted cards) appear as gaps.
  const nodes = new Set(byZid.keys());
  for (const z of byZid.keys()) for (const a of Z.ancestors(z)) nodes.add(a);
  const children = new Map();
  const roots = [];
  for (const z of nodes) {
    const p = Z.parent(z);
    if (p === null) roots.push(z);
    else push(children, p, z);
  }
  roots.sort(Z.compare);
  for (const arr of children.values()) arr.sort(Z.compare);

  const backlinks = new Map(); // zid -> [card]
  const citedBy = new Map(); // citekey -> [card]
  const outlinks = new Map(); // uid -> { notes, lits }
  const keywords = new Map(); // keyword -> [card]
  for (const c of [...notes, ...lits, ...fleeting]) {
    const links = Z.extractLinks(c.body);
    outlinks.set(c.uid, links);
    for (const z of links.notes) push(backlinks, z, c);
    for (const k of links.lits) push(citedBy, k, c);
    for (const k of c.keywords || []) push(keywords, k, c);
  }

  const subtreeSize = (zid) => {
    let n = 0;
    for (const z of children.get(zid) || []) n += (byZid.has(z) ? 1 : 0) + subtreeSize(z);
    return n;
  };

  return { notes, fleeting, lits, trash, byZid, byKey, order, roots, children, backlinks, citedBy, outlinks, keywords, subtreeSize };
}
