import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../web/js/activity.js';

const at = (key, h = 12) => A.parseDay(key).getTime() + h * 3600e3;
const card = (made, changed = made) => ({ createdAt: at(made), updatedAt: at(changed, 15) });

test('day keys use the local calendar and step across months', () => {
  assert.equal(A.addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(A.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(A.dayKey(at('2026-10-16', 23)), '2026-10-16');
});

test('a card counts when created and again when last changed on another day', () => {
  const days = A.byDay([card('2026-10-10'), card('2026-10-10', '2026-10-12'), { createdAt: 0 }]);
  assert.equal(A.countOf(days.get('2026-10-10')), 2);
  assert.equal(days.get('2026-10-12').edited.length, 1);
  assert.equal(A.countOf(days.get('2026-10-11')), 0);
});

test('streaks: today or up to yesterday, and the longest run', () => {
  const days = A.byDay(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-14', '2026-10-15'].map((d) => card(d)));
  assert.deepEqual(A.streaks(days, '2026-10-16'), { current: 2, longest: 4, longestEnd: '2026-10-04', today: false });
  assert.equal(A.streaks(days, '2026-10-17').current, 0);
  const withToday = A.byDay([card('2026-10-15'), card('2026-10-16')]);
  assert.equal(A.streaks(withToday, '2026-10-16').current, 2);
});

test('levels are relative to the busiest day', () => {
  assert.equal(A.level(0, 10), 0);
  assert.equal(A.level(1, 3), 1);
  assert.equal(A.level(3, 3), 3);
  assert.equal(A.level(1, 20), 1);
  assert.equal(A.level(20, 20), 4);
});

test('the week grid starts on a Monday and ends in the current week', () => {
  const g = A.weekGrid(3, '2026-10-16'); // a Friday
  assert.equal(g.length, 3);
  assert.equal(g[0][0], '2026-09-28');
  assert.equal(A.parseDay(g[0][0]).getDay(), 1);
  assert.ok(g[2].includes('2026-10-16'));
});

test('milestones of permanent cards', () => {
  const notes = Array.from({ length: 12 }, (_, i) => ({ createdAt: at('2026-10-01') + i }));
  const m = A.milestones(notes);
  assert.deepEqual(m.reached.map((x) => x.n), [1, 10]);
  assert.equal(m.next, 50);
  assert.equal(m.left, 38);
});

test('on this day: a week, a month and years ago', () => {
  const cards = [card('2026-10-09'), card('2026-09-16'), card('2025-10-16'), { ...card('2025-10-16'), deleted: true }, card('2026-10-15')];
  const groups = A.onThisDay(cards, '2026-10-16');
  assert.deepEqual(groups.map((g) => [g.label, g.key, g.cards.length]), [['一周前', '2026-10-09', 1], ['一个月前', '2026-09-16', 1], ['一年前', '2025-10-16', 1]]);
  assert.deepEqual(A.onThisDay([card('2026-02-28')], '2026-03-31'), []); // there is no 31 February
});
