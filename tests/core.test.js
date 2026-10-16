import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Z from '../web/js/luhmann.js';
import * as ops from '../web/js/ops.js';

test('validates Folgezettel IDs', () => {
  for (const ok of ['1', '12', '1a', '1a2', '21b3c', '1aa', '3z10']) assert.ok(Z.isValid(ok), ok);
  for (const bad of ['', 'a', '0', '01', '1a0', '1A', '1-2', '1a02']) assert.ok(!Z.isValid(bad), bad);
});

test('sorts in slip-box order', () => {
  const ids = ['2', '1b', '1a10', '1a2', '1', '1a', '1a1', '10', '1z', '1aa'];
  assert.deepEqual(ids.sort(Z.compare), ['1', '1a', '1a1', '1a2', '1a10', '1b', '1z', '1aa', '2', '10']);
});

test('ancestry is segment based', () => {
  assert.ok(Z.isAncestor('1a', '1a2'));
  assert.ok(!Z.isAncestor('1a1', '1a10'));
  assert.equal(Z.parent('1a2'), '1a');
  assert.equal(Z.parent('1'), null);
  assert.deepEqual(Z.ancestors('1a2b'), ['1', '1a', '1a2']);
});

test('suggests next IDs', () => {
  const s = new Set(['1', '1a', '1b', '2', '2a', '2a1']);
  assert.equal(Z.nextTop(s), '3');
  assert.equal(Z.continueAfter('2', s), '3');
  assert.equal(Z.continueAfter('1a', s), '1a1'); // 1b taken -> branch
  assert.equal(Z.continueAfter('1b', s), '1c');
  assert.equal(Z.nextChild('1', s), '1c');
  assert.equal(Z.nextChild('2a1', s), '2a1a');
  assert.equal(Z.nextSibling('1z'), '1aa');
});

test('remaps subtrees across segment types', () => {
  assert.equal(Z.remap('3', '1a', '3'), '1a');
  assert.equal(Z.remap('3', '1a', '3a2'), '1a1b');
  assert.equal(Z.remap('1a', '4b', '1a3c'), '4b3c');
  assert.equal(Z.remap('1a', '4b', '1b'), '1b');
});

test('extracts and rewrites links', () => {
  const body = 'see [[1a]] and [[1a2|this]] and [[@Luhmann1981]]';
  const { notes, lits } = Z.extractLinks(body);
  assert.deepEqual([...notes], ['1a', '1a2']);
  assert.deepEqual([...lits], ['Luhmann1981']);
  assert.equal(
    Z.rewriteLinks(body, new Map([['1a2', '5b']]), new Map([['Luhmann1981', 'L81']])),
    'see [[1a]] and [[5b|this]] and [[@L81]]',
  );
});

const box = (...cards) => new Map(cards.map((c) => [c.uid, { title: '', body: '', keywords: [], meta: {}, deleted: false, createdAt: 1, updatedAt: 1, ...c }]));
const apply = (cards, changed) => { for (const c of changed) cards.set(c.uid, c); return changed; };

test('ops: create resolves IDs from intent', () => {
  const cards = box({ uid: 'a', kind: 'note', zid: '1', title: 'one' }, { uid: 'b', kind: 'note', zid: '2', title: 'two' });
  assert.equal(ops.create(cards, { uid: 'c', kind: 'note', title: 'x' }, { rel: 'continue', ref: '1' })[0].zid, '1a');
  assert.equal(ops.create(cards, { uid: 'c', kind: 'note', title: 'x' }, { rel: 'top' })[0].zid, '3');
  assert.throws(() => ops.create(cards, { uid: 'c', kind: 'note', zid: '2', title: 'x' }, { rel: 'exact' }), /zid_taken/);
  assert.throws(() => ops.create(cards, { uid: 'c', kind: 'note', title: ' ' }), /empty/);
  assert.equal(ops.create(cards, { uid: 'f', kind: 'fleeting', body: 'idea' })[0].zid, null);
});

test('ops: move renumbers the branch and rewrites links', () => {
  const cards = box(
    { uid: 'n1', kind: 'note', zid: '1', title: 'a' },
    { uid: 'n1a', kind: 'note', zid: '1a', title: 'b' },
    { uid: 'n1a1', kind: 'note', zid: '1a1', title: 'c' },
    { uid: 'n2', kind: 'note', zid: '2', title: 'd', body: 'links [[1a1]] and [[1a|x]]' },
  );
  const byUid = Object.fromEntries(apply(cards, ops.move(cards, 'n1a', '2a')).map((c) => [c.uid, c]));
  assert.equal(byUid.n1a.zid, '2a');
  assert.equal(byUid.n1a1.zid, '2a1');
  assert.equal(byUid.n2.body, 'links [[2a1]] and [[2a|x]]');
  assert.throws(() => ops.move(cards, 'n1', '2a'), /zid_taken/);
  assert.throws(() => ops.move(cards, 'n2', '2a1b'), /move_into_self/);
  assert.equal(ops.move(cards, 'n1a1', '2b').find((c) => c.uid === 'n1a1').zid, '2b');
});

test('ops: filing, literature rename, restore, import', () => {
  const cards = box(
    { uid: 'f', kind: 'fleeting', body: 'idea' },
    { uid: 'l', kind: 'literature', zid: 'Old2020', title: 'book' },
    { uid: 'n', kind: 'note', zid: '1', title: 'n', body: 'see [[@Old2020]]' },
  );
  const filed = apply(cards, ops.update(cards, 'f', { kind: 'note', title: 't' }, { rel: 'continue', ref: '1' }))[0];
  assert.deepEqual([filed.kind, filed.zid], ['note', '2']);
  apply(cards, ops.update(cards, 'l', { zid: 'New2020' }));
  assert.equal(cards.get('n').body, 'see [[@New2020]]');
  assert.throws(() => ops.update(cards, 'n', { kind: 'fleeting' }), /bad_kind/);

  apply(cards, ops.remove(cards, 'f'));
  apply(cards, ops.create(cards, { uid: 'g', kind: 'note', zid: '2', title: 'taken' }, { rel: 'exact' }));
  const back = apply(cards, ops.restore(cards, 'f'))[0];
  assert.deepEqual([back.kind, back.zid, back.meta.formerZid], ['fleeting', null, '2']);

  const r = ops.importCards(cards, [{ uid: 'x', kind: 'note', zid: '2', title: 'dup' }, { uid: 'y', kind: 'note', zid: '9', title: 'ok' }, { uid: 'n' }]);
  assert.deepEqual(r.cards.map((c) => [c.uid, c.kind, c.zid]), [['x', 'fleeting', null], ['y', 'note', '9']]);
  assert.equal(r.toInbox, 1);
});
