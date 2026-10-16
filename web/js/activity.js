// Writing activity, like a contribution graph: what was written on which day, streaks and
// milestones. Pure functions over the cards (dates in the device's local time zone).

const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const parseDay = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const addDays = (key, n) => {
  const d = parseDay(key);
  d.setDate(d.getDate() + n);
  return dayKey(d);
};

/**
 * Map day -> { created: [cards], edited: [cards] }. A card counts on the day it was created and,
 * if it was last changed on another day, on that day too (only the last change is known).
 */
export function byDay(cards) {
  const days = new Map();
  const at = (k) => {
    if (!days.has(k)) days.set(k, { created: [], edited: [] });
    return days.get(k);
  };
  for (const c of cards) {
    if (!c.createdAt) continue;
    const made = dayKey(c.createdAt);
    at(made).created.push(c);
    if (c.updatedAt && dayKey(c.updatedAt) !== made) at(dayKey(c.updatedAt)).edited.push(c);
  }
  return days;
}

export const countOf = (d) => (d ? d.created.length + d.edited.length : 0);

/** Current streak (ending today, or yesterday if nothing yet today) and the longest one. */
export function streaks(days, today = dayKey(Date.now())) {
  const active = (k) => countOf(days.get(k)) > 0;
  let current = 0;
  let k = active(today) ? today : addDays(today, -1);
  while (active(k)) {
    current++;
    k = addDays(k, -1);
  }
  let longest = 0;
  let longestEnd = null;
  for (const key of [...days.keys()].filter(active).sort()) {
    if (active(addDays(key, -1))) continue; // not the start of a run
    let n = 0;
    let end = key;
    while (active(addDays(key, n))) end = addDays(key, n++);
    if (n > longest) [longest, longestEnd] = [n, end];
  }
  return { current, longest, longestEnd, today: active(today) };
}

/** 0–4 for the colour of a day, relative to the busiest day in view (like GitHub's quartiles). */
export function level(n, max) {
  if (!n) return 0;
  if (max <= 4) return Math.min(n, 4);
  return Math.min(4, Math.ceil((n / max) * 4));
}

/** Weeks (Monday first) covering the last `weeks` weeks up to today: [[dayKey × 7]]. */
export function weekGrid(weeks, today = dayKey(Date.now())) {
  const t = parseDay(today);
  const monday = addDays(today, -((t.getDay() + 6) % 7));
  const start = addDays(monday, -7 * (weeks - 1));
  return Array.from({ length: weeks }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d)));
}

export const MILESTONES = [1, 10, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000];

/** The day each milestone of permanent cards was reached, and the next one. */
export function milestones(notes) {
  const sorted = notes.filter((c) => c.createdAt).map((c) => c.createdAt).sort((a, b) => a - b);
  const reached = MILESTONES.filter((n) => n <= sorted.length).map((n) => ({ n, at: sorted[n - 1] }));
  const next = MILESTONES.find((n) => n > sorted.length) || null;
  return { reached, next, left: next ? next - sorted.length : 0 };
}

/** Cards written per weekday (0 = Monday) over the given days. */
export function weekdays(days) {
  const out = [0, 0, 0, 0, 0, 0, 0];
  for (const [k, d] of days) out[(parseDay(k).getDay() + 6) % 7] += countOf(d);
  return out;
}

export const STREAK_MILESTONES = [3, 7, 14, 30, 100, 365];

/** Cards created on this day a week, a month and whole years ago. */
export function onThisDay(cards, today = dayKey(Date.now())) {
  const t = parseDay(today);
  const back = (months, years) => {
    const d = new Date(t.getFullYear() - years, t.getMonth() - months, t.getDate());
    return d.getDate() === t.getDate() ? dayKey(d) : null; // no 31 February
  };
  const when = [['一周前', addDays(today, -7)], ['一个月前', back(1, 0)]];
  const first = Math.min(...cards.map((c) => c.createdAt || Infinity));
  for (let y = 1; Number.isFinite(first) && y <= 30 && new Date(t.getFullYear() - y, 11, 31) >= new Date(first); y++) {
    when.push([y === 1 ? '一年前' : `${y} 年前`, back(0, y)]);
  }
  const days = byDay(cards.filter((c) => !c.deleted));
  return when.filter(([, k]) => k).map(([label, key]) => ({ label, key, cards: days.get(key)?.created || [] })).filter((g) => g.cards.length);
}
