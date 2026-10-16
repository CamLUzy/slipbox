// 写作记录: a contribution graph of the slip box (one square per day), streaks, milestones,
// and the cards of a single day. The numbers come from activity.js.
import * as A from './activity.js';
import { S } from './store.js';
import { esc } from './util.js';

let H; // helpers from app.js: cardRow
export function setup(helpers) {
  H = helpers;
}

const WEEKDAY = ['一', '二', '三', '四', '五', '六', '日'];
const CELL = 11;
const STEP = 14;
const LEFT = 20;
const TOP = 16;

const cards = () => [...S.cards.values()];
const narrow = () => matchMedia('(max-width: 700px)').matches;
const dateText = (key) => {
  const d = A.parseDay(key);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
};
const dayTip = (key, d) => {
  const parts = [];
  if (d?.created.length) parts.push(`新建 ${d.created.length} 张`);
  if (d?.edited.length) parts.push(`修改 ${d.edited.length} 张`);
  return `${dateText(key)} · ${parts.join('，') || '没有写卡片'}`;
};

/** The graph as SVG: weeks × 7 days, Monday on top, newest week on the right. */
export function heatmap(days, weeks) {
  const today = A.dayKey(Date.now());
  const grid = A.weekGrid(weeks, today);
  let max = 0;
  for (const week of grid) for (const k of week) max = Math.max(max, A.countOf(days.get(k)));
  const w = LEFT + weeks * STEP;
  const h = TOP + 7 * STEP;
  let out = '';
  grid.forEach((week, i) => {
    const first = A.parseDay(week[0]);
    const prev = i ? A.parseDay(grid[i - 1][0]) : null;
    if (i < weeks - 1 && (!prev || prev.getMonth() !== first.getMonth())) {
      out += `<text class="hm-month" x="${LEFT + i * STEP}" y="10">${first.getMonth() + 1}月</text>`;
    }
    week.forEach((k, j) => {
      if (k > today) return;
      const d = days.get(k);
      const lv = A.level(A.countOf(d), max);
      out += `<a href="#/day/${k}"><rect class="hm-cell lv${lv}${k === today ? ' today' : ''}" x="${LEFT + i * STEP}" y="${TOP + j * STEP}"
        width="${CELL}" height="${CELL}" rx="2.5"><title>${esc(dayTip(k, d))}</title></rect></a>`;
    });
  });
  for (const j of [0, 2, 4]) out += `<text class="hm-wd" x="0" y="${TOP + j * STEP + 9}">${WEEKDAY[j]}</text>`;
  return `<svg class="heatmap" viewBox="0 0 ${w} ${h}" style="max-width:${Math.round(w * 1.25)}px" role="img" aria-label="写作记录">${out}</svg>`;
}

const legend = () => `<span class="hm-legend">少 ${[0, 1, 2, 3, 4].map((l) => `<i class="lv${l}"></i>`).join('')} 多</span>`;

function yearTotals(days, weeks) {
  const from = A.weekGrid(weeks)[0][0];
  let created = 0;
  let edited = 0;
  let active = 0;
  for (const [k, d] of days) {
    if (k < from) continue;
    created += d.created.length;
    edited += d.edited.length;
    if (A.countOf(d)) active++;
  }
  return { created, edited, active };
}

function nudge(st) {
  if (st.today) return st.current > 1 ? `今天已经写了，连续 ${st.current} 天` : '今天已经写了';
  if (st.current) return `已经连续 ${st.current} 天，今天再写一张就是 ${st.current + 1} 天`;
  return '今天还没有写卡片';
}

/** The section on the home page. */
export function homeSection() {
  const all = cards();
  if (!all.length) return '';
  const days = A.byDay(all);
  const weeks = narrow() ? 22 : 53;
  const st = A.streaks(days);
  const t = yearTotals(days, weeks);
  return `<section class="activity"><h2>写作记录 <a class="more" href="#/stats">更多</a></h2>
    <div class="hm-box">${heatmap(days, weeks)}
      <div class="hm-foot"><span class="muted small">${narrow() ? '近 5 个月' : '过去一年'}新建 ${t.created} 张${t.edited ? `、修改 ${t.edited} 张` : ''} · <b>${esc(nudge(st))}</b></span>${legend()}</div>
    </div></section>`;
}

/** 往日今天 on the home page: what was written a week, a month, a year ago today. */
export function onThisDaySection() {
  const groups = A.onThisDay(cards());
  if (!groups.length) return '';
  return `<section><h2>往日今天</h2><p class="muted small">回头读读过去写下的卡片，也许它们和今天想的事有联系。</p>
    ${groups.map((g) => `<div class="otd"><a class="otd-when" href="#/day/${g.key}">${g.label} · ${dateText(g.key)}</a>
      <div class="rows">${g.cards.slice(0, 3).map((c) => H.cardRow(c)).join('')}</div>
      ${g.cards.length > 3 ? `<a class="small" href="#/day/${g.key}">这一天还有 ${g.cards.length - 3} 张</a>` : ''}</div>`).join('')}
  </section>`;
}

/** A short cheer when today's first card is written (called after every change). */
let wroteToday = null;
export function cheer(toast) {
  const st = A.streaks(A.byDay(cards()));
  if (wroteToday === false && st.today) {
    if (A.STREAK_MILESTONES.includes(st.current)) toast(`✓ 连续写了 ${st.current} 天！`);
    else toast(st.current > 1 ? `✓ 今天的第一张卡片，已经连续写了 ${st.current} 天` : '✓ 今天的第一张卡片');
  }
  wroteToday = st.today;
}

/** #/stats */
export function viewStats() {
  const all = cards();
  const days = A.byDay(all);
  const st = A.streaks(days);
  const t = yearTotals(days, 53);
  const notes = all.filter((c) => c.kind === 'note' && c.zid);
  const m = A.milestones(notes);
  const wd = A.weekdays(days);
  const wdMax = Math.max(1, ...wd);
  const best = wd.indexOf(Math.max(...wd));
  let busiest = null;
  for (const [k, d] of days) if (!busiest || A.countOf(d) > A.countOf(days.get(busiest))) busiest = k;
  const stat = (n, label) => `<div class="stat"><b>${n}</b><span>${label}</span></div>`;
  return `<div class="page stats-page">
    <h1>写作记录</h1>
    <p class="muted">${esc(nudge(st))}。每天写一张卡片，卡片盒会自己长起来。</p>
    <div class="stats">
      ${stat(`${st.current} 天`, '当前连续')}
      ${stat(`${st.longest} 天`, '最长连续')}
      ${stat(t.created, '过去一年新建')}
      ${stat(t.active, '过去一年有记录的天数')}
    </div>
    <section><h2>过去一年</h2><div class="hm-box">${heatmap(days, narrow() ? 22 : 53)}
      <div class="hm-foot"><span class="muted small">每格一天，颜色越深写得越多；点一格看那天的卡片。</span>${legend()}</div></div></section>
    ${all.length ? `<section><h2>星期几最常写</h2><div class="wd-bars">${wd.map((n, i) => `<div class="wd-bar${i === best && n ? ' best' : ''}">
        <div class="wd-track"><i style="height:${Math.round((n / wdMax) * 100)}%"></i></div><span>${WEEKDAY[i]}</span><b>${n}</b></div>`).join('')}</div>
      ${wd[best] ? `<p class="muted small">你最常在星期${WEEKDAY[best]}写卡片。${busiest ? `写得最多的一天是 <a href="#/day/${busiest}">${dateText(busiest)}</a>（${A.countOf(days.get(busiest))} 张）。` : ''}${st.longestEnd ? ` 最长连续 ${st.longest} 天，到 ${dateText(st.longestEnd)} 为止。` : ''}</p>` : ''}</section>` : ''}
    <section><h2>里程碑</h2><div class="milestones">
      ${m.reached.map((x) => `<div class="ms done"><b>${x.n}</b><span>第 ${x.n} 张永久卡片</span><a class="small" href="#/day/${A.dayKey(x.at)}">${dateText(A.dayKey(x.at))}</a></div>`).join('')}
      ${m.next ? `<div class="ms"><b>${m.next}</b><span>第 ${m.next} 张永久卡片</span><span class="small muted">还差 ${m.left} 张</span></div>` : ''}
    </div>
    <div class="milestones streak-ms">
      ${A.STREAK_MILESTONES.filter((n) => n <= st.longest).map((n) => `<div class="ms done"><b>${n} 天</b><span>连续写卡片</span></div>`).join('')}
      ${(() => { const n = A.STREAK_MILESTONES.find((x) => x > st.longest); return n ? `<div class="ms"><b>${n} 天</b><span>连续写卡片</span><span class="small muted">最长连续 ${st.longest} 天</span></div>` : ''; })()}
    </div></section>
  </div>`;
}

/** #/day/2026-10-16 */
export function viewDay(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key || '')) return '<div class="page"><p class="empty">日期不对。</p></div>';
  const d = A.byDay(cards()).get(key) || { created: [], edited: [] };
  const wd = WEEKDAY[(A.parseDay(key).getDay() + 6) % 7];
  const today = A.dayKey(Date.now());
  const next = A.addDays(key, 1);
  const rows = (list) => `<div class="rows">${list.sort((a, b) => a.createdAt - b.createdAt).map((c) => H.cardRow(c)).join('')}</div>`;
  return `<div class="page">
    <div class="day-nav"><a href="#/day/${A.addDays(key, -1)}">‹ 前一天</a><a href="#/stats">写作记录</a>${next <= today ? `<a href="#/day/${next}">后一天 ›</a>` : '<span></span>'}</div>
    <h1>${dateText(key)} 星期${wd}</h1>
    ${!d.created.length && !d.edited.length ? '<p class="empty">这一天没有写卡片。</p>' : ''}
    ${d.created.length ? `<section><h2>新建 ${d.created.length} 张</h2>${rows(d.created)}</section>` : ''}
    ${d.edited.length ? `<section><h2>修改 ${d.edited.length} 张</h2><p class="muted small">这些卡片最近一次修改在这一天。</p>${rows(d.edited)}</section>` : ''}
  </div>`;
}
