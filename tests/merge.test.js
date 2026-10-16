import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeBoxes, sameCard } from '../web/js/merge.js';

const T0 = 1_000; // last sync
const card = (uid, extra = {}) => ({
  uid, kind: 'note', zid: null, title: uid, body: '', keywords: [], meta: {}, createdAt: 100, updatedAt: 500, deleted: false, ...extra,
});
let n = 0;
const merge = (local, remote, opts = {}) => mergeBoxes({ local, remote, lastSync: T0, now: 9_000, newId: () => `copy${++n}`, ...opts });
const byUid = (list) => Object.fromEntries(list.map((c) => [c.uid, c]));

test('cards only on one side are copied to the other', () => {
  const r = merge([card('a', { zid: '1' })], [card('b', { zid: '2' })]);
  assert.deepEqual(r.local.put.map((c) => c.uid), ['b']);
  assert.deepEqual(r.remote.put.map((c) => c.uid), ['a']);
  assert.deepEqual(r.summary.added, { local: 1, remote: 1 });
});

test('identical cards are left alone, whatever the key order', () => {
  const a = card('a', { zid: '1' });
  const b = Object.fromEntries(Object.entries(a).reverse());
  assert.ok(sameCard(a, b));
  const r = merge([a], [b]);
  assert.equal(r.local.put.length + r.remote.put.length, 0);
});

test('a card changed on one side only takes that version', () => {
  const old = card('a', { zid: '1', body: 'old' });
  const edited = { ...old, body: 'new', updatedAt: 2_000 };
  const r = merge([old], [edited]);
  assert.equal(r.local.put[0].body, 'new');
  assert.equal(r.remote.put.length, 0);
  assert.equal(r.summary.conflicts.length, 0);
  const r2 = merge([edited], [old]);
  assert.equal(r2.remote.put[0].body, 'new');
});

test('changed on both sides: newer wins, the older becomes a conflict copy in the inbox', () => {
  const base = card('a', { zid: '1', title: '标题', body: 'base', keywords: ['k'] });
  const mine = { ...base, body: 'mine', updatedAt: 2_000 };
  const theirs = { ...base, body: 'theirs', updatedAt: 3_000 };
  const r = merge([mine], [theirs], { localName: 'Mac' });
  const local = byUid(r.local.put);
  assert.equal(local.a.body, 'theirs');
  const copy = local.copy1 || Object.values(local).find((c) => c.uid !== 'a');
  assert.equal(copy.kind, 'fleeting');
  assert.equal(copy.zid, null);
  assert.equal(copy.title, '【冲突副本】标题');
  assert.equal(copy.body, 'mine');
  assert.deepEqual(copy.keywords, ['k']);
  assert.deepEqual(copy.meta, { conflictOf: 'a', formerZid: '1', from: 'Mac' });
  // the copy goes to both devices, the winner only to the side that lacked it
  assert.deepEqual(r.remote.put.map((c) => c.uid), [copy.uid]);
  assert.equal(r.summary.conflicts.length, 1);
});

test('no conflict copy when both sides only renumbered or the content is equal', () => {
  const base = card('a', { zid: '1', body: 'same' });
  const r = merge([{ ...base, zid: '2', updatedAt: 2_000 }], [{ ...base, zid: '3', updatedAt: 3_000 }]);
  assert.equal(r.summary.conflicts.length, 0);
  assert.equal(r.local.put.length, 1);
  assert.equal(r.local.put[0].zid, '3');
});

test('edited on one side, trashed on the other: the edit wins and the card is restored', () => {
  const base = card('a', { zid: '1', body: 'base' });
  const trashed = { ...base, deleted: true, updatedAt: 3_000 };
  const edited = { ...base, body: 'edited', updatedAt: 2_000 };
  const r = merge([trashed], [edited]);
  assert.equal(r.local.put[0].deleted, false);
  assert.equal(r.local.put[0].body, 'edited');
  assert.equal(r.summary.revived.length, 1);
  assert.equal(r.summary.conflicts.length, 0);
});

test('trashed on one side only: trashed on both', () => {
  const base = card('a', { zid: '1' });
  const r = merge([base], [{ ...base, deleted: true, updatedAt: 2_000 }]);
  assert.equal(r.local.put[0].deleted, true);
});

test('permanently deleted cards are deleted on both sides and stay deleted', () => {
  const a = card('a', { zid: '1' });
  const r = merge([a], [], { remotePurged: [{ uid: 'a', at: 1_500 }] });
  assert.deepEqual(r.local.purge, [{ uid: 'a', at: 1_500 }]);
  assert.equal(r.local.put.length + r.remote.put.length, 0);
  assert.equal(r.remote.purge.length, 0);
  assert.equal(r.summary.purged, 1);
  // tombstones travel to the side that has none, even without the card
  const r2 = merge([], [], { localPurged: [{ uid: 'x', at: 5 }] });
  assert.deepEqual(r2.remote.purge, [{ uid: 'x', at: 5 }]);
});

test('the same new ID on both devices: the later card moves to the next free place', () => {
  const shared = card('s', { zid: '1' });
  const mine = card('m', { zid: '1a', createdAt: 1_200, updatedAt: 1_200 });
  const mineChild = card('mc', { zid: '1a1', createdAt: 1_300, updatedAt: 1_300 });
  const mineRef = card('mr', { zid: '2', body: '见 [[1a]] 与 [[1a1]]', createdAt: 1_400, updatedAt: 1_400 });
  const theirs = card('t', { zid: '1a', createdAt: 1_100, updatedAt: 1_100 });
  const theirsRef = card('tr', { zid: '3', body: '见 [[1a]]', createdAt: 1_400, updatedAt: 1_400 });
  const r = merge([shared, mine, mineChild, mineRef], [shared, theirs, theirsRef]);
  const final = byUid(r.remote.put);
  assert.equal(final.m.zid, '1b');
  assert.equal(final.mc.zid, '1b1');
  assert.equal(final.mr.body, '见 [[1b]] 与 [[1b1]]');
  assert.equal(final.tr, undefined); // their card keeps its link to their 1a
  assert.equal(byUid(r.local.put).tr.body, '见 [[1a]]');
  assert.equal(byUid(r.local.put).t.zid, '1a');
  assert.deepEqual(r.summary.renumbered.map((x) => [x.from, x.to]).sort(), [['1a', '1b'], ['1a1', '1b1']]);
  // the result has unique IDs on both sides
  const all = new Map([...[shared, mine, mineChild, mineRef].map((c) => [c.uid, c]), ...r.local.put.map((c) => [c.uid, c])]);
  const zids = [...all.values()].filter((c) => c.kind === 'note').map((c) => c.zid);
  assert.equal(new Set(zids).size, zids.length);
});

test('a card both devices knew keeps its ID over a newer one', () => {
  const known = card('k', { zid: '2', createdAt: 5_000, updatedAt: 5_000 });
  const other = card('o', { zid: '2', createdAt: 100, updatedAt: 1_500 });
  const r = merge([known, other], [known]);
  assert.equal(byUid(r.remote.put).o.zid, '3');
});

test('duplicate literature keys get a suffix', () => {
  const a = card('a', { kind: 'literature', zid: 'Luhmann1981', createdAt: 1_100, updatedAt: 1_100 });
  const b = card('b', { kind: 'literature', zid: 'Luhmann1981', createdAt: 1_200, updatedAt: 1_200 });
  const ref = card('r', { zid: '1', body: '[[@Luhmann1981]]', createdAt: 1_300, updatedAt: 1_300 });
  const r = merge([a], [b, ref]);
  assert.equal(byUid(r.local.put).b.zid, 'Luhmann1981-2');
  assert.equal(byUid(r.local.put).r.body, '[[@Luhmann1981-2]]');
});

test('first sync of two copies of the same file merges without duplicates', () => {
  const cards = [card('a', { zid: '1' }), card('b', { zid: '1a' }), card('c', { kind: 'fleeting' })];
  const r = merge(cards, cards.map((c) => ({ ...c })), { lastSync: 0 });
  assert.equal(r.local.put.length + r.remote.put.length, 0);
});

test('merging twice changes nothing more', () => {
  const local = [card('a', { zid: '1', body: 'x', updatedAt: 2_000 }), card('b', { zid: '1a', createdAt: 1_200, updatedAt: 1_200 })];
  const remote = [card('a', { zid: '1', body: 'y', updatedAt: 3_000 }), card('c', { zid: '1a', createdAt: 1_100, updatedAt: 1_100 })];
  const r = merge(local, remote, { localPurged: [{ uid: 'z', at: 1 }] });
  const apply = (cards, w) => {
    const m = new Map(cards.map((c) => [c.uid, c]));
    for (const c of w.put) m.set(c.uid, c);
    for (const t of w.purge) m.delete(t.uid);
    return [...m.values()];
  };
  const L2 = apply(local, r.local);
  const R2 = apply(remote, r.remote);
  const again = merge(L2, R2, { lastSync: 9_000, localPurged: [{ uid: 'z', at: 1 }], remotePurged: [{ uid: 'z', at: 1 }] });
  assert.equal(again.local.put.length + again.remote.put.length + again.local.purge.length + again.remote.purge.length, 0);
});
