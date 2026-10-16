import * as Z from './luhmann.js';
import { S, open, index, onChange, run, zidSet, importCards, purge } from './store.js';
import { CITEKEY_RE, errorText } from './ops.js';
import * as backend from './backend.js';
import { renderMarkdown } from './markdown.js';
import { renderGraph, attachPanZoom } from './graph.js';
import * as aiv from './aiview.js';
import * as ai from './ai.js';
import { esc, uuid, timeAgo, fmtDate, debounce, splitKeywords, firstLine, lsGet, lsSet } from './util.js';

// Shortcut labels: ⌘ on the Mac, Ctrl+ elsewhere.
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const app = document.getElementById('app');
const KIND_NAME = { note: '卡片', fleeting: '闪念', literature: '文献' };
const SECTIONS = [
  ['tree', '卡片盒'],
  ['inbox', '收件箱'],
  ['index', '索引'],
  ['lit', '文献'],
];

const ui = {
  section: lsGet('zk.section', 'tree'),
  expanded: new Set(),
  box: '',
  query: '',
  indexFilter: '',
  main: { parts: [], q: new URLSearchParams() },
  currentUid: null,
  lastCardUid: null,
  suppress: new Set(), // branches the user collapsed although they lead to the current card
  editing: null,
  info: null,
};

// UI state that depends on card IDs is kept per slip box.
const boxKey = (k) => `${k}@${ui.box}`;

const label = (c) => (c.kind === 'literature' ? '@' + c.zid : c.kind === 'note' && c.zid ? c.zid : '闪念');
const titleOf = (c) => c.title || firstLine(c.body, 60) || '（无标题）';
const cardHref = (c) => `#/card/${encodeURIComponent(c.uid)}`;
const isWide = () => matchMedia('(min-width: 860px)').matches;

function cardRow(c, extra = '') {
  const active = c.uid === ui.currentUid ? ' active' : '';
  return `<a class="row${active}" href="${cardHref(c)}"><span class="zid k-${c.kind}">${esc(label(c))}</span><span class="row-title">${esc(titleOf(c))}</span>${extra}</a>`;
}

// Run a store operation and report errors as a toast. Returns the changed cards or null.
async function act(name, ...args) {
  try {
    return await run(name, ...args);
  } catch (e) {
    if (!e.code) console.error(e);
    toast(e.code ? errorText(e) : `保存失败：${e.message || e}`, 'error');
    return null;
  }
}

// ---------- boot ----------

async function boot() {
  applyTheme();
  try {
    ui.box = (await backend.boxes()).current;
    ui.expanded = new Set(lsGet(boxKey('zk.expanded'), []));
    await open();
  } catch (e) {
    app.innerHTML = `<div class="page"><h1>无法读取数据</h1><p class="err">${esc(e.message || e)}</p></div>`;
    return;
  }
  aiv.setup({ cardRow, linkCtx, toast, openModal, cardHref, titleOf, label, boxKey });
  renderShell();
  onChange(onStoreChange);
  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', onKey);
  route();
  aiv.refreshStatus(); // only asks Ollama what is loaded; never loads the model
  backend.info().then((i) => (ui.info = i)).catch(() => {});
}

// Called by the macOS menu bar (mac/main.swift).
window.zkMenu = (action) => {
  if (ui.editing && action !== 'search') return;
  switch (action) {
    case 'capture': openCapture(); break;
    case 'new-top': location.hash = '#/new?kind=note&rel=top'; break;
    case 'new-lit': location.hash = '#/new?kind=literature'; break;
    case 'search': document.body.dataset.mode = 'side'; $('#q')?.focus(); break;
    case 'random': goRandom(); break;
    case 'settings': location.hash = '#/settings'; break;
    case 'trash': location.hash = '#/trash'; break;
    case 'export-json': exportJson(); break;
    case 'export-md': exportMarkdown(); break;
    case 'import-json': importJson(); break;
    case 'backup': backupNow(); break;
    case 'reveal': backend.reveal(); break;
    case 'ai': location.hash = '#/ai'; break;
    case 'boxes': openBoxes(); break;
    case 'ai-map': location.hash = '#/ai/map'; break;
    case 'ai-unload': ai.unload().then(() => { toast('已释放模型内存'); aiv.refreshStatus(); }, () => toast('Ollama 未运行', 'warn')); break;
  }
};

function logo() {
  return `<svg viewBox="0 0 64 64" width="56" height="56" aria-hidden="true"><rect x="10" y="14" width="40" height="30" rx="4" fill="var(--paper-2)" stroke="var(--line)"/><rect x="14" y="20" width="40" height="30" rx="4" fill="var(--paper)" stroke="var(--ink-3)"/><line x1="14" y1="28" x2="54" y2="28" stroke="var(--accent)" stroke-width="2"/><line x1="20" y1="35" x2="46" y2="35" stroke="var(--line)" stroke-width="2"/><line x1="20" y1="41" x2="40" y2="41" stroke="var(--line)" stroke-width="2"/></svg>`;
}

// ---------- shell ----------

function renderShell() {
  app.innerHTML = `<div class="layout">
    <aside class="side">
      <header class="side-head">
        <button type="button" class="brand" id="box-btn" title="切换卡片盒 (${MOD}O)">${logo()}<span class="box-name">${esc(ui.box)}</span><span class="caret">▾</span></button>
        <button class="icon-btn" id="btn-capture" type="button" title="记录闪念 (N)" aria-label="记录闪念">＋</button>
      </header>
      <div class="search"><input id="q" type="search" placeholder="搜索编号、标题、正文…" autocomplete="off" enterkeyhint="search"></div>
      <nav class="tabs" id="tabs"></nav>
      <div class="list" id="list"></div>
      <footer class="side-foot"><a href="#/ai" class="ai-link-foot">✦ AI 助手</a><a href="#/trash">回收站</a><a href="#/settings">设置与数据</a></footer>
    </aside>
    <main class="main" id="main"></main>
  </div>
  <div id="toasts" aria-live="polite"></div>`;
  $('#btn-capture').onclick = openCapture;
  $('#box-btn').onclick = openBoxes;
  $('#q').addEventListener('input', (e) => {
    ui.query = e.target.value;
    renderSide();
  });
  $('#list').addEventListener('click', onListClick);
  $('#main').addEventListener('click', onMainClick);
}

function renderTabs() {
  const ix = index();
  const searching = !!ui.query.trim();
  $('#tabs').innerHTML = SECTIONS.map(([key, name]) => {
    const n = key === 'inbox' && ix.fleeting.length ? `<span class="badge">${ix.fleeting.length}</span>` : '';
    const active = !searching && ui.section === key ? ' active' : '';
    return `<a class="tab${active}" href="#/list/${key}">${name}${n}</a>`;
  }).join('') + '<a class="tab mobile-only" href="#/settings">设置</a>';
}

// ---------- routing ----------

function parseHash() {
  const h = location.hash.slice(1) || '/';
  const [p, qs] = h.split('?');
  return { parts: p.split('/').filter(Boolean).map(decodeURIComponent), q: new URLSearchParams(qs || '') };
}

function route() {
  const r = parseHash();
  ui.editing = null;
  if (r.parts[0] === 'list') {
    ui.section = SECTIONS.some(([k]) => k === r.parts[1]) ? r.parts[1] : 'tree';
    lsSet('zk.section', ui.section);
    if (r.q.has('k')) ui.indexFilter = r.q.get('k');
    ui.query = '';
    const q = $('#q');
    if (q) q.value = '';
    document.body.dataset.mode = 'side';
    if (!ui.main.parts.length || !isWide()) renderMain();
  } else {
    ui.main = r;
    document.body.dataset.mode = 'main';
    renderMain();
    $('#main').scrollTop = 0;
    window.scrollTo(0, 0);
  }
  renderSide();
}

function onStoreChange() {
  renderSide();
  if (ui.editing) return;
  const main = $('#main');
  const top = main.scrollTop;
  const wtop = window.scrollY;
  renderMain();
  main.scrollTop = top;
  window.scrollTo(0, wtop);
}

function renderMain() {
  const [r, a] = ui.main.parts;
  const q = ui.main.q;
  ui.currentUid = null;
  const main = $('#main');
  let html;
  switch (r) {
    case 'card': html = viewCard(S.cards.get(a)); break;
    case 'z': html = viewCard(index().byZid.get(a)); break;
    case 'edit': return mountEditor(S.cards.get(a), { file: q.get('file') === '1', rel: q.get('rel'), ref: q.get('ref') });
    case 'ai': html = a === 'map' ? aiv.viewMap() : aiv.viewChat(q); break;
    case 'new': return mountNew(q);
    case 'settings': html = viewSettings(); break;
    case 'trash': html = viewTrash(); break;
    default: html = viewHome();
  }
  main.innerHTML = topbar() + html;
  if (r === 'ai') aiv.mount(main, ui.main);
  const c = ui.currentUid && S.cards.get(ui.currentUid);
  document.title = c ? `${label(c)} ${titleOf(c)}` : '卡片盒';
}

function topbar() {
  return `<div class="topbar mobile-only"><a class="back" href="#/list/${ui.section}">‹ ${esc(SECTIONS.find(([k]) => k === ui.section)?.[1] || '列表')}</a></div>`;
}

// ---------- side list ----------

function renderSide() {
  if (!$('#list')) return;
  renderTabs();
  const list = $('#list');
  const top = list.scrollTop;
  if (ui.query.trim()) list.innerHTML = listSearch(ui.query);
  else list.innerHTML = { tree: listTree, inbox: listInbox, index: listIndex, lit: listLit }[ui.section]();
  list.scrollTop = top;
  const f = $('#idx-filter');
  if (f) {
    f.addEventListener('input', debounce(() => {
      ui.indexFilter = f.value;
      const pos = f.selectionStart;
      renderSide();
      const nf = $('#idx-filter');
      nf.focus();
      nf.setSelectionRange(pos, pos);
    }, 150));
  }
  const cap = $('#inbox-capture');
  if (cap) {
    cap.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        addFleeting(cap.value);
      }
    });
  }
}

function listTree() {
  const ix = index();
  const tools = `<div class="list-tools"><button type="button" data-act="new-top">＋ 新主题</button>
    <button type="button" data-act="expand-all">全部展开</button><button type="button" data-act="collapse-all">折叠</button></div>`;
  if (!ix.notes.length) return tools + `<p class="empty">卡片盒还是空的。<br>点“新主题”写第一张卡片，编号会是 <b>1</b>。</p>`;
  const cur = ui.currentUid && S.cards.get(ui.currentUid);
  const openSet = new Set(ui.expanded);
  if (cur?.kind === 'note' && cur.zid) for (const z of [...Z.ancestors(cur.zid), cur.zid]) if (!ui.suppress.has(z)) openSet.add(z);
  const node = (z, d) => {
    const c = ix.byZid.get(z);
    const kids = ix.children.get(z) || [];
    const isOpen = openSet.has(z);
    const tw = kids.length
      ? `<button type="button" class="tw${isOpen ? ' open' : ''}" data-toggle="${esc(z)}" aria-label="${isOpen ? '折叠' : '展开'}"><svg viewBox="0 0 10 10"><path d="M3 1.5 7 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`
      : '<span class="tw"></span>';
    const body = c
      ? `<a href="${cardHref(c)}"><span class="zid">${esc(z)}</span><span class="t">${esc(titleOf(c))}</span>${!isOpen && kids.length ? `<span class="count">${ix.subtreeSize(z)}</span>` : ''}</a>`
      : `<span class="gap"><span class="zid">${esc(z)}</span><span class="t">（空位）</span></span>`;
    const row = `<div class="tree-row${c && c.uid === ui.currentUid ? ' active' : ''}" style="--d:${d}">${tw}${body}</div>`;
    return row + (isOpen ? kids.map((k) => node(k, d + 1)).join('') : '');
  };
  return tools + `<div class="tree">${ix.roots.map((z) => node(z, 0)).join('')}</div>`;
}

function listInbox() {
  const ix = index();
  const box = `<div class="capture-inline"><textarea id="inbox-capture" rows="3" placeholder="随手记下一个想法… (${MOD}Enter 保存)"></textarea>
    <button type="button" class="primary" data-act="inbox-add">记下</button></div>`;
  if (!ix.fleeting.length) return box + `<p class="empty">收件箱是空的。<br>闪念笔记先放这里，之后再整理成卡片盒里的正式卡片。</p>`;
  return box + ix.fleeting.map((c) => cardRow(c, `<span class="row-meta">${timeAgo(c.createdAt)}</span>`)).join('');
}

function listIndex() {
  const ix = index();
  const f = ui.indexFilter.trim().toLowerCase();
  const keys = [...ix.keywords.keys()]
    .filter((k) => !f || k.toLowerCase().includes(f))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const head = `<div class="list-tools"><input id="idx-filter" type="search" placeholder="筛选关键词" value="${esc(ui.indexFilter)}"></div>`;
  if (!ix.keywords.size) return head + `<p class="empty">还没有关键词。<br>给卡片加关键词，它就会出现在这份索引（Schlagwortregister）里，作为进入思路的入口。</p>`;
  return head + (keys.map((k) => {
    const cards = ix.keywords.get(k).slice().sort((a, b) => (ix.order.get(a.uid) ?? 1e9) - (ix.order.get(b.uid) ?? 1e9));
    return `<div class="kw"><div class="kw-name">${esc(k)}<span class="count">${cards.length}</span></div>${cards.map((c) => cardRow(c)).join('')}</div>`;
  }).join('') || '<p class="empty">没有匹配的关键词。</p>');
}

function listLit() {
  const ix = index();
  const tools = `<div class="list-tools"><button type="button" data-act="new-lit">＋ 新文献</button></div>`;
  if (!ix.lits.length) return tools + `<p class="empty">文献卡片记录你读过的书和文章（卢曼的书目卡片盒）。<br>在正文里用 <code>[[@文献键]]</code> 引用。</p>`;
  return tools + ix.lits.map((c) => {
    const m = c.meta || {};
    const by = [m.author, m.year].filter(Boolean).join(' ');
    return cardRow(c, by ? `<span class="row-meta">${esc(by)}</span>` : '');
  }).join('');
}

function listSearch(query) {
  const ix = index();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results = [];
  for (const c of [...ix.notes, ...ix.lits, ...ix.fleeting]) {
    const title = (c.title || '').toLowerCase();
    const body = (c.body || '').toLowerCase();
    const extra = [c.zid, ...(c.keywords || []), c.meta?.author].filter(Boolean).join(' ').toLowerCase();
    if (!terms.every((t) => title.includes(t) || body.includes(t) || extra.includes(t))) continue;
    let score = 0;
    for (const t of terms) {
      if (c.zid?.toLowerCase() === t) score += 20;
      if (title.includes(t)) score += 5;
      if (extra.includes(t)) score += 3;
      if (body.includes(t)) score += 1;
    }
    results.push([score, c]);
  }
  results.sort((a, b) => b[0] - a[0]);
  if (!results.length) return `<p class="empty">没有找到“${esc(query)}”。</p>`;
  return `<div class="list-note">${results.length} 条结果</div>` + results.slice(0, 200).map(([, c]) => {
    const body = c.body || '';
    const i = body.toLowerCase().indexOf(terms[0]);
    let snip = '';
    if (i >= 0) {
      const s = Math.max(0, i - 20);
      snip = esc(body.slice(s, i + 60).replace(/\n/g, ' '));
      for (const t of terms) snip = snip.replace(new RegExp(esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`);
      snip = `<span class="snip">${s > 0 ? '…' : ''}${snip}…</span>`;
    }
    return cardRow(c, snip);
  }).join('');
}

function onListClick(e) {
  const t = e.target.closest('[data-toggle]');
  if (t) {
    const z = t.dataset.toggle;
    if (t.classList.contains('open')) {
      ui.expanded.delete(z);
      ui.suppress.add(z);
    } else {
      ui.expanded.add(z);
      ui.suppress.delete(z);
    }
    lsSet(boxKey('zk.expanded'), [...ui.expanded]);
    renderSide();
    return;
  }
  const a = e.target.closest('[data-act]')?.dataset.act;
  if (a === 'new-top') location.hash = '#/new?kind=note&rel=top';
  if (a === 'new-lit') location.hash = '#/new?kind=literature';
  if (a === 'inbox-add') addFleeting($('#inbox-capture').value);
  if (a === 'expand-all') {
    ui.expanded = new Set(index().children.keys());
    ui.suppress.clear();
    lsSet(boxKey('zk.expanded'), [...ui.expanded]);
    renderSide();
  }
  if (a === 'collapse-all') {
    ui.expanded.clear();
    ui.suppress = new Set(index().children.keys());
    lsSet(boxKey('zk.expanded'), []);
    renderSide();
  }
}

// ---------- main views ----------

function viewHome() {
  const ix = index();
  const recent = [...ix.notes, ...ix.lits, ...ix.fleeting].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
  const noEntry = ix.notes.filter((c) =>
    Z.depth(c.zid) === 1 && !(c.keywords || []).length && !(ix.backlinks.get(c.zid) || []).length).slice(0, 8);
  const stat = (n, t, href) => `<a class="stat" href="${href}"><b>${n}</b><span>${t}</span></a>`;
  const empty = !ix.notes.length && !ix.fleeting.length && !ix.lits.length;
  return `<div class="page home">
    <h1>${esc(ui.box)}</h1>
    <p class="muted">卢曼卡片盒 · 数据保存在本机 · <a href="#" data-act="boxes">切换卡片盒</a></p>
    <div class="stats">
      ${stat(ix.notes.length, '永久卡片', '#/list/tree')}
      ${stat(ix.fleeting.length, '闪念待整理', '#/list/inbox')}
      ${stat(ix.lits.length, '文献', '#/list/lit')}
      ${stat(ix.keywords.size, '关键词', '#/list/index')}
    </div>
    <div class="actions">
      <button type="button" class="primary" data-act="new-top">新主题卡片</button>
      <button type="button" data-act="capture">记录闪念</button>
      <button type="button" data-act="new-lit">新文献</button>
      ${ix.notes.length ? '<button type="button" data-act="random">随机漫步</button>' : ''}
      <a class="btn ai-btn" href="#/ai">✦ AI 助手</a>
    </div>
    ${empty ? guide() : ''}
    ${recent.length ? `<section><h2>最近修改</h2><div class="rows">${recent.map((c) => cardRow(c, `<span class="row-meta">${timeAgo(c.updatedAt)}</span>`)).join('')}</div></section>` : ''}
    ${ix.fleeting.length ? `<section><h2>收件箱待整理 <a class="more" href="#/list/inbox">全部 ${ix.fleeting.length}</a></h2><div class="rows">${ix.fleeting.slice(0, 5).map((c) => cardRow(c)).join('')}</div></section>` : ''}
    ${noEntry.length ? `<section><h2>缺少入口的主题</h2><p class="muted small">这些主题卡片既没有关键词，也没有被其他卡片引用，只能靠翻阅找到。给它们加个关键词吧。</p><div class="rows">${noEntry.map((c) => cardRow(c)).join('')}</div></section>` : ''}
  </div>`;
}

function guide() {
  return `<section class="guide"><h2>怎么用</h2>
    <ol>
      <li><b>闪念</b>：随时点左上角 ＋ 或按 <kbd>N</kbd> 记下想法，放进收件箱。</li>
      <li><b>文献卡片</b>：读书时为每本书/文章建一张，用自己的话写摘要。</li>
      <li><b>永久卡片</b>：把闪念整理成一张只讲一个观点的卡片，放进卡片盒。每张卡片有固定编号：
        新主题是 <code>1</code>、<code>2</code>…；在 <code>1</code> 后续写是 <code>2</code> 或 <code>1a</code>；从 <code>1a</code> 分支是 <code>1a1</code>。</li>
      <li><b>链接</b>：正文里写 <code>[[1a2]]</code> 链接卡片，<code>[[@Luhmann1992]]</code> 引用文献。</li>
      <li><b>索引</b>：给少数关键卡片加关键词，作为进入一串思路的入口。</li>
    </ol></section>`;
}

function linkCtx() {
  const ix = index();
  return {
    link(t, alias) {
      if (t.startsWith('@')) {
        const l = ix.byKey.get(t.slice(1));
        return l
          ? `<a class="zl lit" href="${cardHref(l)}" title="${esc(titleOf(l))}">${alias ?? esc(t)}</a>`
          : `<span class="zl broken" title="文献不存在">${alias ?? esc(t)}</span>`;
      }
      const n = ix.byZid.get(t);
      return n
        ? `<a class="zl" href="${cardHref(n)}" title="${esc(titleOf(n))}">${alias ?? esc(t)}</a>`
        : `<span class="zl broken" title="卡片不存在">${alias ?? esc(t)}</span>`;
    },
  };
}

function viewCard(c) {
  if (c && c.uid !== ui.lastCardUid) {
    ui.lastCardUid = c.uid;
    ui.suppress.clear();
  }
  if (!c) return `<div class="page"><p class="empty">找不到这张卡片。</p><a href="#/">回首页</a></div>`;
  ui.currentUid = c.uid;
  const ix = index();
  const isNote = c.kind === 'note' && c.zid && !c.deleted;
  const crumbs = isNote && Z.depth(c.zid) > 1
    ? `<nav class="crumbs">${Z.ancestors(c.zid).map((z) => {
        const p = ix.byZid.get(z);
        return p ? `<a href="${cardHref(p)}" title="${esc(titleOf(p))}">${esc(z)}</a>` : `<span class="gap">${esc(z)}</span>`;
      }).join('<span class="sep">›</span>')}<span class="sep">›</span></nav>`
    : '';
  const m = c.meta || {};
  const litMeta = c.kind === 'literature'
    ? `<dl class="lit-meta">${[['作者', m.author], ['年份', m.year], ['出处', m.source]].filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}
       ${m.url ? `<dt>链接</dt><dd><a href="${esc(/^https?:/i.test(m.url) ? m.url : '#')}" target="_blank" rel="noopener">${esc(m.url)}</a></dd>` : ''}</dl>`
    : '';
  const kw = (c.keywords || []).length
    ? `<div class="chips">${c.keywords.map((k) => `<a class="chip" href="#/list/index?k=${encodeURIComponent(k)}">${esc(k)}</a>`).join('')}</div>`
    : '';

  let rel = '';
  const block = (title, cards, hint = '') => cards.length
    ? `<section class="rel"><h3>${title}${hint ? `<small>${hint}</small>` : ''}</h3><div class="rows">${cards.map((x) => cardRow(x)).join('')}</div></section>`
    : '';
  const out = ix.outlinks.get(c.uid) || { notes: new Set(), lits: new Set() };
  const outNotes = [...out.notes].map((z) => ix.byZid.get(z)).filter(Boolean).filter((x) => x.uid !== c.uid);
  const outLits = [...out.lits].map((k) => ix.byKey.get(k)).filter(Boolean);
  let seqNav = '';
  if (isNote) {
    const i = ix.order.get(c.uid);
    const prev = ix.notes[i - 1];
    const next = ix.notes[i + 1];
    seqNav = `<nav class="seq">
      ${prev ? `<a href="${cardHref(prev)}" class="prev" title="上一张 (K)"><span>‹ ${esc(prev.zid)}</span><small>${esc(titleOf(prev))}</small></a>` : '<span></span>'}
      ${next ? `<a href="${cardHref(next)}" class="next" title="下一张 (J)"><span>${esc(next.zid)} ›</span><small>${esc(titleOf(next))}</small></a>` : '<span></span>'}
    </nav>`;
    const parentCard = ix.byZid.get(Z.parent(c.zid));
    const kids = (ix.children.get(c.zid) || []).map((z) => ix.byZid.get(z)).filter(Boolean);
    rel += block('上级', parentCard ? [parentCard] : []);
    rel += block('后续 / 分支', kids);
    rel += block('被引用', (ix.backlinks.get(c.zid) || []).filter((x) => x.uid !== c.uid), '其他卡片里的 [[链接]]');
  }
  rel += block('链接到', outNotes);
  rel += block('引用文献', outLits);
  if (c.kind === 'literature' && !c.deleted) rel += block('引用此文献的卡片', ix.citedBy.get(c.zid) || []);

  let actions;
  if (c.deleted) {
    actions = `<button type="button" class="primary" data-act="restore">从回收站恢复</button>
      <button type="button" class="danger" data-act="purge">永久删除</button>`;
  } else if (c.kind === 'fleeting') {
    actions = `<button type="button" class="primary" data-act="file">整理进卡片盒</button>
      <button type="button" data-act="edit">编辑</button><button type="button" class="danger" data-act="delete">删除</button>`;
  } else if (c.kind === 'literature') {
    actions = `<button type="button" data-act="edit">编辑</button><button type="button" data-act="cite">基于此文献写卡片</button>
      <button type="button" data-act="graph">关系图</button><button type="button" class="danger" data-act="delete">删除</button>`;
  } else {
    actions = `<button type="button" data-act="edit" title="E">编辑</button>
      <button type="button" data-act="continue" title="C">续写</button>
      <button type="button" data-act="branch" title="B">分支</button>
      <button type="button" data-act="graph" title="G">关系图</button>
      <button type="button" data-act="move">改号</button>
      <button type="button" class="danger" data-act="delete">删除</button>`;
  }

  return `<div class="page card-page">
    ${c.deleted ? '<div class="banner">这张卡片在回收站里。</div>' : ''}
    ${crumbs}
    <article class="sheet k-${c.kind}">
      <header class="sheet-head">
        <span class="zid-big k-${c.kind}">${esc(label(c))}</span>
        <h1>${esc(c.title || (c.kind === 'fleeting' ? '' : '（无标题）'))}</h1>
      </header>
      ${litMeta}
      <div class="md">${renderMarkdown(c.body, linkCtx()) || '<p class="muted">（空）</p>'}</div>
      ${kw}
      <footer class="sheet-foot">创建于 ${fmtDate(c.createdAt)} · 修改于 ${timeAgo(c.updatedAt)}</footer>
    </article>
    <div class="actions card-actions">${actions}</div>
    ${c.deleted ? '' : `<div class="actions ai-actions"><span class="ai-label">✦ AI</span>
      ${c.kind !== 'literature' ? '<button type="button" data-act="ai-organize">整理</button>' : ''}
      ${c.kind !== 'fleeting' ? '<button type="button" data-act="ai-relate">梳理联系</button>' : ''}
      <a class="btn" href="#/ai?card=${encodeURIComponent(c.uid)}">就这张卡片提问</a></div>`}
    ${seqNav}
    ${rel}
  </div>`;
}

function viewSettings() {
  const theme = lsGet('zk.theme', 'auto');
  const info = ui.info;
  const native = backend.isNative;
  const backups = info?.backups || [];
  refreshInfo();
  return `<div class="page settings">
    <h1>设置与数据</h1>
    <section><h2>卡片盒</h2>
      <p>当前：<b>${esc(ui.box)}</b></p>
      <p class="muted small">每个卡片盒是一个独立的数据库文件，编号、链接、索引、AI 分析都各自独立，适合按课程或项目分开。</p>
      <div class="actions"><button type="button" data-act="boxes">管理卡片盒…</button></div>
    </section>
    <section><h2>数据</h2>
      <dl class="kv">
        <dt>卡片盒</dt><dd>${esc(ui.box)}</dd>
        <dt>保存位置</dt><dd><code>${esc(info?.dataPath || '…')}</code></dd>
        <dt>卡片总数</dt><dd>${index().notes.length} 张永久卡片 · ${index().fleeting.length} 条闪念 · ${index().lits.length} 篇文献 · 回收站 ${index().trash.length}</dd>
        ${native ? `<dt>自动备份</dt><dd>每天一次，保留最近 30 份${backups[0] ? ` · 最近一次 ${esc(backups[0])}` : ''}</dd>` : ''}
      </dl>
      <div class="actions">
        ${native ? `<button type="button" data-act="reveal">${{ mac: '在 Finder 中显示', ios: '在“文件”App 中显示' }[backend.platform] || '在资源管理器中显示'}</button><button type="button" data-act="backup">立即备份</button>` : ''}
        <button type="button" data-act="export-json">导出 JSON</button>
        ${native ? '<button type="button" data-act="export-md">导出为 Markdown 文件</button>' : ''}
        <button type="button" data-act="import-json">从 JSON 导入</button>
        <a class="btn" href="#/trash">回收站</a>
      </div>
      ${native ? '' : '<p class="muted small">你正在浏览器里使用卡片盒，数据保存在这个浏览器中。清除浏览器数据会删除它们，请定期导出 JSON。安装桌面应用后可以用“从 JSON 导入”迁移过去。</p>'}
    </section>
    <section><h2>AI（本地模型）</h2>
      ${backend.platform === 'ios'
        ? '<p class="muted small">iPhone / iPad 上跑不了 Ollama，但可以用家里电脑上的：在电脑上设置环境变量 <code>OLLAMA_HOST=0.0.0.0</code> 后重启 Ollama，再把下面的地址改成电脑的局域网地址，例如 <code>http://192.168.1.20:11434</code>。卡片只会发给局域网里的这台电脑。</p>'
        : '<p class="muted small">AI 通过本机的 Ollama 运行，数据不会离开这台电脑。只有点击 AI 功能时才会加载模型，闲置后自动释放内存。</p>'}
      <div class="grid2">
        <div class="field"><label>模型</label><input id="ai-model" value="${esc(ai.cfg.model)}" autocapitalize="off"></div>
        <div class="field"><label>Ollama 地址</label><input id="ai-base" value="${esc(ai.cfg.base)}" autocapitalize="off"></div>
      </div>
      <div class="actions"><button type="button" data-act="ai-save">保存</button><a class="btn" href="#/ai">打开 AI 助手</a></div>
    </section>
    <section><h2>外观</h2>
      <div class="seg" role="radiogroup">${[['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']].map(([v, t]) =>
        `<button type="button" data-theme="${v}" class="${theme === v ? 'active' : ''}">${t}</button>`).join('')}</div>
    </section>
    <section><h2>快捷键</h2>
      <ul class="plain small keys">
        <li><kbd>N</kbd> 记录闪念</li><li><kbd>/</kbd> 或 <kbd>${MOD}F</kbd> 搜索</li><li><kbd>E</kbd> 编辑当前卡片</li>
        <li><kbd>C</kbd> 续写</li><li><kbd>B</kbd> 分支</li><li><kbd>J</kbd>/<kbd>K</kbd> 下一张/上一张</li>
        <li><kbd>G</kbd> 关系图</li><li><kbd>A</kbd> AI 助手</li><li><kbd>R</kbd> 随机漫步</li><li><kbd>${MOD}S</kbd> 保存</li>
      </ul>
    </section>
  </div>`;
}

async function refreshInfo() {
  try {
    const i = await backend.info();
    const changed = JSON.stringify(i) !== JSON.stringify(ui.info);
    ui.info = i;
    if (changed && ui.main.parts[0] === 'settings' && !ui.editing) renderMain();
  } catch {
    /* ignore */
  }
}

function viewTrash() {
  const ix = index();
  return `<div class="page"><h1>回收站</h1>
    <p class="muted small">删除的卡片保留在这里，可以恢复，也可以永久删除。</p>
    ${ix.trash.length ? `<div class="actions"><button type="button" class="danger" data-act="empty-trash">清空回收站（${ix.trash.length}）</button></div>
      <div class="rows">${ix.trash.map((c) => cardRow(c, `<span class="row-meta">${timeAgo(c.updatedAt)}</span>`)).join('')}</div>` : '<p class="empty">回收站是空的。</p>'}
  </div>`;
}

// ---------- actions ----------

function currentCard() {
  return ui.currentUid ? S.cards.get(ui.currentUid) : null;
}

async function onMainClick(e) {
  const th = e.target.closest('button[data-theme]'); // not <html data-theme>
  if (th) {
    lsSet('zk.theme', th.dataset.theme);
    applyTheme();
    renderMain();
    return;
  }
  const a = e.target.closest('[data-act]')?.dataset.act;
  if (!a || ui.editing) return;
  const c = currentCard();
  switch (a) {
    case 'new-top': location.hash = '#/new?kind=note&rel=top'; break;
    case 'new-lit': location.hash = '#/new?kind=literature'; break;
    case 'capture': openCapture(); break;
    case 'random': goRandom(); break;
    case 'edit': location.hash = `#/edit/${encodeURIComponent(c.uid)}`; break;
    case 'file': location.hash = `#/edit/${encodeURIComponent(c.uid)}?file=1`; break;
    case 'continue': location.hash = `#/new?kind=note&rel=continue&ref=${encodeURIComponent(c.zid)}`; break;
    case 'branch': location.hash = `#/new?kind=note&rel=branch&ref=${encodeURIComponent(c.zid)}`; break;
    case 'cite': location.hash = `#/new?kind=note&rel=top&cite=${encodeURIComponent(c.zid)}`; break;
    case 'graph': openGraph(c); break;
    case 'ai-organize': aiv.openOrganize(c); break;
    case 'ai-relate': aiv.openRelate(c); break;
    case 'ai-save':
      ai.setCfg({ model: $('#ai-model').value.trim() || 'qwen3.5:4b', base: $('#ai-base').value.trim() || 'http://127.0.0.1:11434' });
      toast('AI 设置已保存');
      break;
    case 'move': openMove(c); break;
    case 'delete': confirmDelete(c); break;
    case 'restore': restore(c); break;
    case 'purge': confirmPurge([c]); break;
    case 'empty-trash': confirmPurge(index().trash); break;
    case 'reveal': backend.reveal(); break;
    case 'boxes': e.preventDefault(); openBoxes(); break;
    case 'backup': backupNow(); break;
    case 'export-json': exportJson(); break;
    case 'export-md': exportMarkdown(); break;
    case 'import-json': importJson(); break;
  }
}

function goRandom() {
  const notes = index().notes;
  if (!notes.length) return;
  let c = notes[Math.floor(Math.random() * notes.length)];
  if (notes.length > 1 && c.uid === ui.currentUid) c = notes[(notes.indexOf(c) + 1) % notes.length];
  location.hash = cardHref(c);
}

async function addFleeting(text) {
  if (!String(text).trim()) return false;
  const ok = await act('create', { uid: uuid(), kind: 'fleeting', body: text.trim() });
  if (ok) toast('已放入收件箱');
  return !!ok;
}

async function backupNow() {
  if (!backend.isNative) return toast('浏览器版本请使用“导出 JSON”备份', 'warn');
  try {
    toast(`已备份：${await backend.backupNow()}`);
    refreshInfo();
  } catch (e) {
    toast(`备份失败：${e.message || e}`, 'error');
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function exportJson() {
  const data = { app: 'zettelkasten', exportedAt: Date.now(), cards: [...S.cards.values()] };
  try {
    if (await backend.saveFile(`卡片盒-${stamp()}.json`, JSON.stringify(data, null, 1))) toast('已导出');
  } catch (e) {
    toast(`导出失败：${e.message || e}`, 'error');
  }
}

async function exportMarkdown() {
  if (!backend.isNative) return;
  const safe = (s) => s.replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').trim().slice(0, 80);
  const files = [];
  const used = new Set();
  for (const c of S.cards.values()) {
    if (c.deleted) continue;
    const dir = { note: '卡片盒', fleeting: '收件箱', literature: '文献' }[c.kind];
    let name = safe([c.kind === 'literature' ? '@' + c.zid : c.zid, c.title || (c.kind === 'fleeting' ? firstLine(c.body, 30) : '')].filter(Boolean).join(' ')) || c.uid;
    if (used.has(dir + name)) name += ' ' + c.uid.slice(0, 8);
    used.add(dir + name);
    const front = ['---', `uid: ${c.uid}`, c.zid ? `id: "${c.zid}"` : null, `kind: ${c.kind}`, `title: ${JSON.stringify(c.title)}`,
      `keywords: ${JSON.stringify(c.keywords || [])}`, Object.keys(c.meta || {}).length ? `meta: ${JSON.stringify(c.meta)}` : null,
      `created: ${new Date(c.createdAt).toISOString()}`, `updated: ${new Date(c.updatedAt).toISOString()}`, '---', ''].filter((l) => l !== null);
    files.push({ path: `${dir}/${name}.md`, content: front.join('\n') + c.body + '\n' });
  }
  try {
    const dir = await backend.exportFiles(`卡片盒导出-${stamp()}`, files);
    if (dir) toast(`已导出 ${files.length} 个文件`);
  } catch (e) {
    toast(`导出失败：${e.message || e}`, 'error');
  }
}

async function importJson() {
  const text = await backend.openTextFile();
  if (!text) return;
  let list;
  try {
    const data = JSON.parse(text);
    list = Array.isArray(data) ? data : data.cards;
    if (!Array.isArray(list)) throw new Error('文件里没有卡片');
  } catch (e) {
    return toast(`无法读取：${e.message}`, 'error');
  }
  const r = await importCards(list);
  toast(`已导入 ${r.cards.length} 张卡片${r.toInbox ? `，其中 ${r.toInbox} 张因编号冲突放进了收件箱` : ''}`, r.toInbox ? 'warn' : 'info');
}

async function openBoxes() {
  if (document.querySelector('.modal-wrap')) return;
  let data;
  try {
    data = await backend.boxes();
  } catch (e) {
    return toast(`无法读取卡片盒列表：${e.message || e}`, 'error');
  }
  const live = S.cards.size - index().trash.length;
  const row = (b) => {
    const cur = b.name === data.current;
    return `<div class="box-row${cur ? ' current' : ''}" data-name="${esc(b.name)}">
      <button type="button" class="box-open" ${cur ? 'disabled' : ''}><b>${esc(b.name)}</b>
        <span class="muted small">${cur ? `正在使用 · ${live} 张卡片` : `${b.cards} 张卡片`}</span></button>
      <button type="button" data-box="rename">重命名</button>
      ${cur ? '' : '<button type="button" class="danger" data-box="delete">删除</button>'}
    </div>`;
  };
  openModal(`<h2>卡片盒</h2>
    <div class="box-list">${data.boxes.map(row).join('')}</div>
    <form class="box-new"><input name="name" placeholder="新卡片盒的名字，例如 数据库课程" maxlength="60" autocapitalize="off">
      <button type="submit" class="primary">新建</button></form>
    <p class="err" role="alert"></p>
    <p class="muted small">每个卡片盒是一个独立的文件。删除会把文件移到废纸篓，自动备份也会保留。</p>`, {
    onMount(m) {
      const err = (t) => { $('.err', m).textContent = t; };
      const reload = () => { location.hash = '#/'; location.reload(); };
      $('.box-new input', m).focus();
      $('.box-new', m).addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = e.target.name.value.trim();
        try { await backend.createBox(name); reload(); } catch (ex) { err(ex.message || String(ex)); }
      });
      m.addEventListener('click', async (e) => {
        const rowEl = e.target.closest('.box-row');
        if (!rowEl) return;
        const name = rowEl.dataset.name;
        if (e.target.closest('.box-open')) {
          try { await backend.switchBox(name); reload(); } catch (ex) { err(ex.message || String(ex)); }
          return;
        }
        const act = e.target.closest('[data-box]')?.dataset.box;
        if (act === 'delete') {
          const b = e.target.closest('[data-box]');
          if (!b.dataset.sure) { b.dataset.sure = '1'; b.textContent = '确认移到废纸篓'; return; }
          try { await backend.deleteBox(name); rowEl.remove(); toast(`已删除“${name}”（在废纸篓里）`); } catch (ex) { err(ex.message || String(ex)); }
        }
        if (act === 'rename') {
          rowEl.innerHTML = `<form class="box-rename"><input name="to" value="${esc(name)}" maxlength="60" autocapitalize="off">
            <button type="submit" class="primary">保存</button><button type="button" data-box="cancel">取消</button></form>`;
          const f = $('form', rowEl);
          f.to.select();
          f.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const to = f.to.value.trim();
            if (to === name) return reload();
            try {
              await backend.renameBox(name, to);
              for (const k of ['zk.expanded', 'zk.ai.map', 'zk.ai.chat']) {
                const v = lsGet(`${k}@${name}`, null);
                if (v !== null) { lsSet(`${k}@${to}`, v); lsSet(`${k}@${name}`, undefined); }
              }
              reload();
            } catch (ex) { err(ex.message || String(ex)); }
          });
        }
        if (act === 'cancel') reload();
      });
    },
  });
}

function openCapture() {
  if (document.querySelector('.modal-wrap')) return;
  openModal(`<h2>记录闪念</h2>
    <textarea class="capture" rows="6" placeholder="写下想法，稍后再整理…"></textarea>
    <div class="actions"><button type="button" class="primary" data-ok>保存 <kbd>${MOD}↵</kbd></button><button type="button" data-close>取消</button></div>`, {
    onMount(m, close) {
      const ta = $('textarea', m);
      ta.focus();
      const save = async () => { if (await addFleeting(ta.value)) close(); };
      $('[data-ok]', m).onclick = save;
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
      });
    },
  });
}

function openGraph(c) {
  openModal(`<h2>关系图 · ${esc(label(c))} ${esc(c.title || '')}</h2>${renderGraph(c, index())}`, {
    wide: true,
    onMount(m, close) {
      attachPanZoom(m);
      m.addEventListener('click', (e) => {
        const n = e.target.closest('.g-node');
        if (n) { close(); location.hash = `#/card/${encodeURIComponent(n.dataset.uid)}`; }
      });
    },
  });
}

function confirmDelete(c) {
  const kids = c.kind === 'note' && c.zid ? index().subtreeSize(c.zid) : 0;
  const back = c.kind === 'note' && c.zid ? (index().backlinks.get(c.zid) || []).length : 0;
  const warn = [kids && `它有 ${kids} 张后续卡片，删除后编号 ${esc(c.zid)} 会留下空位`, back && `${back} 张卡片链接到它`].filter(Boolean);
  openModal(`<h2>删除${KIND_NAME[c.kind]}？</h2>
    <p>${esc(label(c))} ${esc(titleOf(c))}</p>
    ${warn.length ? `<p class="warn">${warn.join('；')}。</p>` : ''}
    <p class="muted small">卡片会移到回收站，可以恢复。</p>
    <div class="actions"><button type="button" class="danger" data-ok>删除</button><button type="button" data-close>取消</button></div>`, {
    onMount(m, close) {
      $('[data-ok]', m).onclick = async () => {
        close();
        const parent = c.kind === 'note' && c.zid ? index().byZid.get(Z.parent(c.zid)) : null;
        if (!(await act('remove', c.uid))) return;
        location.hash = parent ? cardHref(parent) : c.kind === 'fleeting' ? '#/list/inbox' : '#/';
        toast('已移到回收站');
      };
    },
  });
}

function confirmPurge(cards) {
  if (!cards.length) return;
  openModal(`<h2>永久删除 ${cards.length} 张卡片？</h2>
    <p class="warn">此操作无法撤销（自动备份里仍保留着旧数据）。</p>
    <div class="actions"><button type="button" class="danger" data-ok>永久删除</button><button type="button" data-close>取消</button></div>`, {
    onMount(m, close) {
      $('[data-ok]', m).onclick = async () => {
        close();
        const n = await purge(cards.map((c) => c.uid));
        if (ui.main.parts[0] === 'card') location.hash = '#/trash';
        toast(`已永久删除 ${n} 张卡片`);
      };
    },
  });
}

async function restore(c) {
  const r = await act('restore', c.uid);
  if (!r) return;
  toast(r[0].kind === 'fleeting' && c.kind === 'note' ? `原编号 ${c.zid} 已被占用，卡片已放回收件箱` : '已恢复');
}

// Position picker: where in the Folgezettel tree a card goes.
function posRowHtml(rel, ref) {
  const opt = (v, t) => `<option value="${v}"${rel === v ? ' selected' : ''}>${t}</option>`;
  return `<div class="pos-row">
      <select name="rel">${opt('top', '新主题')}${opt('continue', '续写于')}${opt('branch', '分支于')}${opt('exact', '指定编号')}</select>
      <input name="ref" placeholder="参照编号，如 1a" value="${esc(ref)}" list="zid-list" autocomplete="off" autocapitalize="off">
      <span class="arrow">→</span>
      <input name="zid" class="zid-input" placeholder="编号" autocomplete="off" autocapitalize="off">
    </div>
    <small class="pos-hint"></small>
    <datalist id="zid-list">${index().notes.slice(0, 3000).map((c) => `<option value="${esc(c.zid)}">${esc(titleOf(c))}</option>`).join('')}</datalist>`;
}

function bindPosRow(root, exclude = new Set(), self = null) {
  const relEl = $('[name=rel]', root);
  const refEl = $('[name=ref]', root);
  const zidEl = $('[name=zid]', root);
  const hint = $('.pos-hint', root);
  const existing = () => {
    const s = zidSet();
    for (const z of exclude) s.delete(z);
    return s;
  };
  const update = () => {
    const rel = relEl.value;
    refEl.hidden = rel === 'top' || rel === 'exact';
    zidEl.readOnly = rel !== 'exact';
    const ix = index();
    hint.classList.remove('err');
    if (rel === 'exact') {
      const z = zidEl.value.trim();
      if (!z) hint.textContent = '输入编号，例如 3、1a、2b4';
      else if (!Z.isValid(z)) { hint.textContent = '编号格式：数字与字母交替，以数字开头，如 1a2'; hint.classList.add('err'); }
      else if (existing().has(z) && z !== self) { hint.textContent = `编号 ${z} 已被“${titleOf(ix.byZid.get(z))}”使用`; hint.classList.add('err'); }
      else hint.textContent = Z.parent(z) ? `位于 ${Z.parent(z)} 之下` : '新的主题';
      return;
    }
    const ref = refEl.value.trim();
    if (rel !== 'top' && !ix.byZid.has(ref)) {
      zidEl.value = '';
      hint.textContent = ref ? `没有编号为 ${ref} 的卡片` : '输入参照卡片的编号';
      hint.classList.toggle('err', !!ref);
      return;
    }
    zidEl.value = Z.suggest(rel, ref, existing());
    hint.textContent = rel === 'top' ? '开启一个新的主题序列'
      : `${rel === 'continue' ? '接在' : '从'} ${ref}“${titleOf(ix.byZid.get(ref))}”${rel === 'continue' ? '之后' : '分出'}`;
  };
  relEl.addEventListener('change', update);
  refEl.addEventListener('input', update);
  zidEl.addEventListener('input', update);
  update();
  return () => {
    update();
    const z = zidEl.value.trim();
    if (hint.classList.contains('err') || !Z.isValid(z)) return { error: hint.textContent || '请选择位置' };
    const rel = relEl.value;
    return { zid: z, intent: rel === 'exact' ? { rel: 'exact' } : { rel, ref: refEl.value.trim() } };
  };
}

function openMove(c) {
  const ix = index();
  const n = ix.subtreeSize(c.zid);
  const branch = new Set([c.zid, ...ix.notes.filter((x) => Z.isAncestor(c.zid, x.zid)).map((x) => x.zid)]);
  openModal(`<h2>改号 / 移动 ${esc(c.zid)}</h2>
    <p class="muted small">卢曼的编号原则上是固定地址。必要时可以把这张卡片${n ? `连同 ${n} 张后续卡片` : ''}整体移到新位置，所有指向它们的 [[链接]] 会自动更新。</p>
    <div class="field pos">${posRowHtml('exact', '')}</div>
    <p class="err" role="alert"></p>
    <div class="actions"><button type="button" class="primary" data-ok>移动</button><button type="button" data-close>取消</button></div>`, {
    onMount(m, close) {
      const get = bindPosRow(m, branch, c.zid);
      $('[name=zid]', m).focus();
      $('[data-ok]', m).onclick = async () => {
        const p = get();
        if (p.error) return ($('.err', m).textContent = p.error);
        try {
          await run('move', c.uid, p.zid);
          close();
          toast(`已移动到 ${p.zid}`);
        } catch (e) {
          $('.err', m).textContent = errorText(e);
        }
      };
    },
  });
}

// ---------- editor ----------

function mountNew(q) {
  const kind = ['note', 'literature', 'fleeting'].includes(q.get('kind')) ? q.get('kind') : 'note';
  const cite = q.get('cite');
  const card = { uid: uuid(), kind, zid: null, title: '', body: cite ? `\n\n参见 [[@${cite}]]` : '', keywords: [], meta: {} };
  const rel = q.get('rel') || 'top';
  const ref = q.get('ref') || '';
  mountEditor(card, { isNew: true, rel, ref, draftKey: `zk.draft.new.${kind}.${rel}.${ref}.${cite || ''}` });
}

function mountEditor(card, opts = {}) {
  const main = $('#main');
  if (!card || card.deleted) {
    main.innerHTML = topbar() + '<div class="page"><p class="empty">找不到这张卡片。</p></div>';
    return;
  }
  const isNew = !!opts.isNew;
  const kind = opts.file ? 'note' : card.kind;
  const needsPos = kind === 'note' && (!card.zid || card.kind !== 'note');
  const draftKey = opts.draftKey || `zk.draft.${card.uid}`;
  const draft = lsGet(draftKey, null);
  const v = draft || { title: card.title, body: card.body, keywords: (card.keywords || []).join('，'), meta: card.meta || {} };
  const m = v.meta || {};
  ui.editing = { uid: card.uid };
  ui.currentUid = card.uid;

  const heading = isNew ? `新建${KIND_NAME[kind]}` : opts.file ? '整理进卡片盒' : `编辑 ${esc(label(card))}`;
  document.title = heading.replace(/<[^>]+>/g, '');
  main.innerHTML = topbar() + `<form class="page editor" id="editor" autocomplete="off">
    <div class="ed-head"><h1>${heading}</h1></div>
    ${draft ? `<div class="banner info">${draft.ai ? '✦ AI 的整理结果已填入，检查修改后再保存。' : '已恢复上次未保存的草稿。'}<button type="button" data-ed="discard">${draft.ai ? '恢复原文' : '丢弃草稿'}</button></div>` : ''}
    ${opts.file ? '<p class="muted small">把这条闪念改写成一张只讲一个观点、脱离上下文也能看懂的卡片，然后为它选一个位置。</p>' : ''}
    ${needsPos ? `<div class="field pos"><label>位置</label>${posRowHtml(opts.rel || 'top', opts.ref || '')}</div>` : ''}
    ${kind === 'literature' ? `<div class="grid2">
      <div class="field"><label>文献键 <small>用于 [[@引用]]，如 Luhmann1992</small></label><input name="citekey" value="${esc(card.zid || m.citekey || '')}" required autocapitalize="off"></div>
      <div class="field"><label>作者</label><input name="author" value="${esc(m.author || '')}"></div>
      <div class="field"><label>年份</label><input name="year" value="${esc(m.year || '')}" inputmode="numeric"></div>
      <div class="field"><label>出处 <small>出版社 / 期刊</small></label><input name="source" value="${esc(m.source || '')}"></div>
      <div class="field span2"><label>链接</label><input name="url" value="${esc(m.url || '')}" inputmode="url"></div>
    </div>` : ''}
    <div class="field"><label>${kind === 'literature' ? '书名 / 篇名' : '标题'}</label><input name="title" value="${esc(v.title)}" placeholder="${kind === 'note' ? '一句话概括这张卡片的观点' : ''}"></div>
    <div class="field body-field"><label>正文 <small>Markdown；输入 <code>[[</code> 链接卡片，<code>[[@</code> 引用文献</small></label>
      <div class="ed-tabs"><button type="button" data-tab="write" class="active">编辑</button><button type="button" data-tab="preview">预览</button></div>
      <div class="ed-split"><div class="ta-wrap"><textarea name="body" rows="16">${esc(v.body)}</textarea><div class="ac" hidden></div></div><div class="preview md"></div></div>
    </div>
    <div class="field"><label>关键词 <small>逗号或顿号分隔；出现在“索引”里</small></label><input name="keywords" value="${esc(v.keywords)}" list="kw-list">
      <datalist id="kw-list">${[...index().keywords.keys()].map((k) => `<option value="${esc(k)}">`).join('')}</datalist></div>
    <p class="err" role="alert"></p>
    <div class="actions sticky"><button class="primary" type="submit">保存 <kbd>${MOD}S</kbd></button><button type="button" data-ed="cancel">取消</button></div>
  </form>`;

  const form = $('#editor');
  const ta = form.body;
  const preview = $('.preview', form);
  const getPos = needsPos ? bindPosRow(form) : null;
  const renderPreview = () => (preview.innerHTML = renderMarkdown(ta.value, linkCtx()) || '<p class="muted">预览</p>');
  const renderPreviewSoon = debounce(renderPreview, 200);
  renderPreview();

  const readMeta = () => kind === 'literature'
    ? { ...card.meta, author: form.author.value.trim(), year: form.year.value.trim(), source: form.source.value.trim(), url: form.url.value.trim() }
    : card.meta || {};
  const saveDraft = debounce(() => {
    if (!ui.editing) return;
    lsSet(draftKey, { title: form.title.value, body: ta.value, keywords: form.keywords.value, meta: readMeta() });
  }, 400);
  form.addEventListener('input', (e) => {
    if (e.target === ta) renderPreviewSoon();
    saveDraft();
  });

  // [[ autocomplete
  const ac = $('.ac', form);
  let acItems = [];
  let acActive = 0;
  let acTerm = '';
  const acHide = () => { ac.hidden = true; acItems = []; };
  const acUpdate = () => {
    const before = ta.value.slice(0, ta.selectionStart);
    const mm = before.match(/\[\[([^\][\n|]*)$/);
    if (!mm) return acHide();
    acTerm = mm[1];
    const ix = index();
    const t = acTerm.toLowerCase();
    if (t.startsWith('@')) {
      const k = t.slice(1);
      acItems = ix.lits.filter((c) => c.zid.toLowerCase().includes(k) || (c.title || '').toLowerCase().includes(k)).slice(0, 8);
    } else {
      acItems = ix.notes.filter((c) => c.uid !== card.uid && (c.zid.startsWith(t) || titleOf(c).toLowerCase().includes(t))).slice(0, 8);
    }
    if (!acItems.length) return acHide();
    acActive = Math.min(acActive, acItems.length - 1);
    const xy = caretXY(ta);
    ac.style.top = `${xy.top + 6}px`;
    ac.style.left = `${Math.max(4, Math.min(xy.left, ta.clientWidth - Math.min(300, ta.clientWidth - 8)))}px`;
    ac.innerHTML = acItems.map((c, i) => `<div class="ac-item${i === acActive ? ' active' : ''}" data-i="${i}"><span class="zid k-${c.kind}">${esc(label(c))}</span>${esc(titleOf(c))}</div>`).join('');
    ac.hidden = false;
  };
  const acChoose = (i) => {
    const c = acItems[i];
    if (!c) return;
    const pos = ta.selectionStart;
    const start = pos - acTerm.length;
    const insert = (c.kind === 'literature' ? '@' + c.zid : c.zid) + ']]';
    const after = ta.value.slice(pos).startsWith(']]') ? ta.value.slice(pos + 2) : ta.value.slice(pos);
    ta.value = ta.value.slice(0, start) + insert + after;
    ta.selectionStart = ta.selectionEnd = start + insert.length;
    acHide();
    ta.focus();
    renderPreview();
    saveDraft();
  };
  ta.addEventListener('input', () => { acActive = 0; acUpdate(); });
  ta.addEventListener('click', acUpdate);
  ta.addEventListener('blur', () => setTimeout(acHide, 150));
  ac.addEventListener('mousedown', (e) => {
    const it = e.target.closest('.ac-item');
    if (it) { e.preventDefault(); acChoose(Number(it.dataset.i)); }
  });
  ta.addEventListener('keydown', (e) => {
    if (ac.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      acActive = (acActive + (e.key === 'ArrowDown' ? 1 : acItems.length - 1)) % acItems.length;
      acUpdate();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      acChoose(acActive);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      acHide();
    }
  });

  const cancel = () => {
    lsSet(draftKey, undefined);
    ui.editing = null;
    const ref = opts.ref && index().byZid.get(opts.ref);
    location.hash = isNew ? (ref ? cardHref(ref) : '#/') : cardHref(card);
  };

  form.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ed],[data-tab]');
    if (!b) return;
    if (b.dataset.ed === 'cancel') cancel();
    if (b.dataset.ed === 'discard') {
      lsSet(draftKey, undefined);
      ui.editing = null;
      renderMain();
    }
    if (b.dataset.tab) {
      $$('.ed-tabs button', form).forEach((x) => x.classList.toggle('active', x === b));
      form.classList.toggle('show-preview', b.dataset.tab === 'preview');
      renderPreview();
    }
  });
  form.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); form.requestSubmit(); }
    if (e.key === 'Escape' && ac.hidden && !document.querySelector('.modal-wrap')) cancel();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = (t) => { $('.err', form).textContent = t; };
    const title = form.title.value.trim();
    const body = ta.value.replace(/\s+$/, '');
    const keywords = splitKeywords(form.keywords.value);
    const meta = readMeta();
    let zid = card.kind === kind ? card.zid : null;
    let intent;
    if (needsPos) {
      const p = getPos();
      if (p.error) return err(p.error);
      ({ zid, intent } = p);
    }
    if (kind === 'literature') {
      zid = form.citekey.value.trim();
      if (!CITEKEY_RE.test(zid)) return err(errorText('bad_citekey'));
    }
    try {
      if (isNew) {
        await run('create', { uid: card.uid, kind, zid, title, body, keywords, meta }, intent);
      } else {
        const cur = S.cards.get(card.uid) || card;
        const fields = {};
        if (title !== cur.title) fields.title = title;
        if (body !== cur.body) fields.body = body;
        if (JSON.stringify(keywords) !== JSON.stringify(cur.keywords || [])) fields.keywords = keywords;
        if (JSON.stringify(meta) !== JSON.stringify(cur.meta || {})) fields.meta = meta;
        if (kind !== cur.kind) fields.kind = kind;
        if (zid !== cur.zid) fields.zid = zid;
        if (Object.keys(fields).length) await run('update', cur.uid, fields, intent);
      }
    } catch (ex) {
      if (!ex.code) console.error(ex);
      return err(ex.code ? errorText(ex) : `保存失败：${ex.message || ex}`);
    }
    lsSet(draftKey, undefined);
    ui.editing = null;
    const target = cardHref(card);
    if (location.hash === target) route();
    else location.hash = target;
  });

  const first = needsPos && $('[name=rel]', form).value === 'exact' ? form.zid : form.title.value ? ta : form.title;
  first.focus();
}

// Pixel position of the caret inside a textarea, measured with an invisible mirror element.
function caretXY(ta) {
  const cs = getComputedStyle(ta);
  const div = document.createElement('div');
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingRight',
    'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing', 'tabSize']) {
    div.style[p] = cs[p];
  }
  Object.assign(div.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', width: `${ta.offsetWidth}px`, top: '0', left: '0' });
  div.textContent = ta.value.slice(0, ta.selectionStart);
  const mark = document.createElement('span');
  mark.textContent = '​';
  div.append(mark);
  document.body.append(div);
  const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.6;
  const pos = { top: mark.offsetTop - ta.scrollTop + lh, left: mark.offsetLeft };
  div.remove();
  return pos;
}

// ---------- keyboard ----------

function onKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (document.querySelector('.modal-wrap') || ui.editing) return;
  const c = currentCard();
  const ix = index();
  const go = (h) => { e.preventDefault(); location.hash = h; };
  switch (e.key) {
    case '/': e.preventDefault(); document.body.dataset.mode = 'side'; $('#q').focus(); break;
    case 'n': e.preventDefault(); openCapture(); break;
    case 'r': e.preventDefault(); goRandom(); break;
    case 'e': if (c && !c.deleted) go(`#/edit/${encodeURIComponent(c.uid)}`); break;
    case 'c': if (c?.kind === 'note' && !c.deleted) go(`#/new?kind=note&rel=continue&ref=${encodeURIComponent(c.zid)}`); break;
    case 'b': if (c?.kind === 'note' && !c.deleted) go(`#/new?kind=note&rel=branch&ref=${encodeURIComponent(c.zid)}`); break;
    case 'g': if (c && !c.deleted) { e.preventDefault(); openGraph(c); } break;
    case 'a': go('#/ai'); break;
    case 'j':
    case 'k': {
      if (c?.kind !== 'note' || !ix.order.has(c.uid)) break;
      const n = ix.notes[ix.order.get(c.uid) + (e.key === 'j' ? 1 : -1)];
      if (n) go(cardHref(n));
      break;
    }
  }
}

// ---------- modal, toast, theme ----------

function openModal(html, { onMount, wide } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true"><button type="button" class="modal-x" data-close aria-label="关闭">×</button>${html}</div>`;
  document.body.append(wrap);
  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onEsc, true);
    window.removeEventListener('hashchange', close);
  };
  const onEsc = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };
  document.addEventListener('keydown', onEsc, true);
  window.addEventListener('hashchange', close);
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) close();
  });
  onMount?.(wrap.firstElementChild, close);
  return close;
}

function toast(msg, type = 'info') {
  const box = $('#toasts');
  if (!box) return;
  const t = document.createElement('div');
  t.className = `toast t-${type}`;
  t.textContent = msg;
  box.append(t);
  setTimeout(() => t.classList.add('out'), type === 'info' ? 2500 : 6000);
  setTimeout(() => t.remove(), type === 'info' ? 3000 : 6500);
}

function applyTheme() {
  const t = lsGet('zk.theme', 'auto');
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

boot();
