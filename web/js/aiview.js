// AI screens: organize a note, map the relations of one card or of the whole box,
// and chat with the slip box. The model is only started by the buttons here.
import * as ai from './ai.js';
import * as backend from './backend.js';
import * as sim from './similarity.js';
import * as Z from './luhmann.js';
import { S, index, run } from './store.js';
import { renderMarkdown } from './markdown.js';
import { renderNetwork, relLegend, attachPanZoom, REL_CLASS, THEME_COLORS, nodeLabel } from './graph.js';
import { esc, lsGet, lsSet, timeAgo, uuid } from './util.js';

let H; // helpers from app.js: cardRow, linkCtx, toast, openModal, cardHref, titleOf, label
export function setup(helpers) {
  H = helpers;
}

const $ = (sel, root = document) => root.querySelector(sel);

// ---------- shared ----------

function isLinked(ix, a, b) {
  const refA = ai.cardRef(a);
  const refB = ai.cardRef(b);
  const outA = ix.outlinks.get(a.uid);
  const outB = ix.outlinks.get(b.uid);
  const has = (out, ref) => (ref.startsWith('@') ? out?.lits.has(ref.slice(1)) : out?.notes.has(ref));
  if (has(outA, refB) || has(outB, refA)) return true;
  return a.kind === 'note' && b.kind === 'note' && (Z.parent(a.zid) === b.zid || Z.parent(b.zid) === a.zid);
}

// Runs an AI task inside `box`: progress, a stop button and readable errors.
async function job(box, fn) {
  const ctrl = new AbortController();
  box.innerHTML = `<div class="ai-job"><span class="spinner"></span><div class="ai-job-text"><b class="ai-step">准备中…</b><div class="muted small ai-sub"></div></div>
    <button type="button" class="ai-stop">停止</button></div>`;
  $('.ai-stop', box).onclick = () => ctrl.abort();
  const step = (t) => { const el = $('.ai-step', box); if (el) el.textContent = t; };
  const sub = (t) => { const el = $('.ai-sub', box); if (el) el.textContent = t; };
  setBusy(1);
  try {
    await ai.ensureReady(step);
    return await fn({ signal: ctrl.signal, step, onToken: (text) => sub(`已生成 ${text.length} 字`) });
  } catch (e) {
    if (e.code === 'no_model') showDownload(box);
    else box.innerHTML = `<p class="${e.code === 'aborted' ? 'muted' : 'err'}">${esc(ai.aiErrorText(e))}</p>`;
    return null;
  } finally {
    setBusy(-1);
  }
}

function showDownload(box) {
  box.innerHTML = `<div class="ai-job"><div class="ai-job-text"><b>还没有下载模型 ${esc(ai.cfg.model)}</b>
    <div class="muted small">只需下载一次（约 3–4 GB），之后完全离线运行。</div></div>
    <button type="button" class="primary ai-pull">下载</button></div>`;
  $('.ai-pull', box).onclick = async () => {
    const ctrl = new AbortController();
    box.innerHTML = `<div class="ai-job"><span class="spinner"></span><div class="ai-job-text"><b class="ai-step">正在下载…</b>
      <div class="progress"><i style="width:0"></i></div></div><button type="button" class="ai-stop">取消</button></div>`;
    $('.ai-stop', box).onclick = () => ctrl.abort();
    try {
      await ai.pull((statusText, frac) => {
        $('.ai-step', box).textContent = frac === null ? statusText : `正在下载… ${(frac * 100).toFixed(0)}%`;
        if (frac !== null) $('.progress i', box).style.width = `${frac * 100}%`;
      }, ctrl.signal);
      box.innerHTML = '<p>下载完成。请再点一次刚才的 AI 功能。</p>';
    } catch (e) {
      box.innerHTML = `<p class="err">${esc(ai.aiErrorText(e))}</p>`;
    }
    refreshStatus();
  };
}

// ---------- model status (never loads the model) ----------
// Polls Ollama every few seconds while an AI task runs, while the model is loaded,
// or while the AI page is open, and paints the AI page header and the sidebar dot.

const live = { busy: 0, st: null, timer: null, controls: '' };

export function setBusy(delta) {
  live.busy = Math.max(0, live.busy + delta);
  paintStatus();
  watchStatus();
}

export function refreshStatus() {
  watchStatus();
}

function watchStatus() {
  if (!live.timer) live.timer = setInterval(pollStatus, 3000);
  pollStatus();
}

let polling = false;
async function pollStatus() {
  if (polling) return;
  polling = true;
  try {
    live.st = await ai.status();
  } finally {
    polling = false;
  }
  paintStatus();
  const pageOpen = !!document.getElementById('ai-status');
  if (!live.busy && !live.st.loaded && !pageOpen && live.timer) {
    clearInterval(live.timer);
    live.timer = null;
  }
}

function untilText(ts) {
  if (!ts) return '';
  const s = Math.round((ts - Date.now()) / 1000);
  if (s > 3600 * 24) return ''; // keep_alive forever
  if (s <= 0) return ' · 即将释放';
  return s < 60 ? ` · ${s} 秒后自动释放` : ` · 约 ${Math.ceil(s / 60)} 分钟后自动释放`;
}

function paintStatus() {
  const st = live.st;
  const foot = document.querySelector('.ai-link-foot');
  if (foot) {
    foot.classList.toggle('on', !!st?.loaded && !live.busy);
    foot.classList.toggle('busy', live.busy > 0);
    foot.title = live.busy ? 'AI 正在运行' : st?.loaded ? `${ai.cfg.model} 已加载，占用内存` : '';
  }
  const el = document.getElementById('ai-status');
  if (!el || !st) return;
  const model = esc(ai.cfg.model);
  let text;
  let state;
  if (live.busy) {
    state = 'busy';
    text = `<i class="dot busy"></i>${model} ${st.loaded ? '正在运行' : '正在加载…'}`;
  } else if (!st.running) {
    state = 'off';
    text = backend.platform === 'ios'
      ? '<i class="dot"></i>连接不到 Ollama · 在“设置与数据 → AI”里填写电脑上 Ollama 的局域网地址'
      : '<i class="dot"></i>Ollama 未运行 · 使用 AI 功能时会自动启动';
  } else if (!st.installed) {
    state = 'missing';
    text = `<i class="dot"></i>未下载 ${model}`;
  } else if (st.loaded) {
    state = 'loaded';
    const gb = st.vram ? ` · 占用 ${(st.vram / 1e9).toFixed(1)} GB` : '';
    text = `<i class="dot on"></i>${model} 已加载${gb}${untilText(st.expiresAt)}`;
  } else {
    state = 'idle';
    text = `<i class="dot"></i>${model} 未加载 · 点 AI 功能时才会启动`;
  }
  // Rebuild the controls only when they change, so an open dropdown is not closed by polling.
  const keep = ai.cfg.keepAlive;
  const controls = (state === 'loaded' ? '<button type="button" data-ai="unload">释放内存</button>' : '') +
    (st.running && st.installed ? `<select data-ai="keep" title="闲置多久后自动释放内存">${[['1m', '闲置 1 分钟后释放'], ['5m', '闲置 5 分钟后释放'], ['30m', '闲置 30 分钟后释放']].map(([v, t]) =>
      `<option value="${v}"${v === keep ? ' selected' : ''}>${t}</option>`).join('')}</select>` : '');
  if (!el.querySelector('.ai-st-text')) el.innerHTML = '<span class="ai-st-text"></span><span class="ai-st-controls"></span>';
  el.querySelector('.ai-st-text').innerHTML = text;
  if (live.controls !== controls || !el.querySelector('.ai-st-controls').innerHTML) {
    live.controls = controls;
    el.querySelector('.ai-st-controls').innerHTML = controls;
  }
}

function bindStatus(root) {
  live.controls = '';
  root.addEventListener('click', async (e) => {
    if (e.target.closest('[data-ai=unload]')) {
      await ai.unload().catch(() => {});
      H.toast('已释放模型内存');
      pollStatus();
    }
  });
  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-ai=keep]')) {
      ai.setCfg({ keepAlive: e.target.value });
      H.toast('下次使用 AI 时生效');
    }
  });
}

// ---------- AI 整理 ----------

export function openOrganize(card) {
  H.openModal(`<h2>AI 整理 · ${esc(H.label(card))} ${esc(card.title || '')}</h2><div class="ai-box"></div>`, {
    wide: true,
    onMount(m, close) {
      const box = $('.ai-box', m);
      const go = async () => {
        const ix = index();
        const candidates = sim.related(ix, card, 8, (c) => c.kind === 'note').map(([, c]) => c);
        const keywords = [...ix.keywords.entries()].sort((a, b) => b[1].length - a[1].length).map(([k]) => k);
        const r = await job(box, ({ signal, step, onToken }) => {
          step('AI 正在整理这张卡片…');
          return ai.organize(card, { candidates, keywords, signal, onToken });
        });
        if (!r) return;
        const pos = r.position;
        const refCard = pos.ref && index().byZid.get(pos.ref);
        const newZid = card.kind === 'fleeting' ? Z.suggest(pos.rel, pos.ref, new Set(index().byZid.keys())) : null;
        const kw = card.kind === 'fleeting' ? r.keywords : [...new Set([...(card.keywords || []), ...r.keywords])];
        const posText = pos.rel === 'top' ? '开启新主题' : `${pos.rel === 'continue' ? '续写于' : '分支于'} ${esc(pos.ref)}「${esc(H.titleOf(refCard))}」`;
        box.innerHTML = `<div class="ai-result">
          <div class="ai-field"><label>标题</label><div class="ai-title">${esc(r.title)}</div></div>
          <div class="ai-field"><label>正文</label><div class="md">${renderMarkdown(r.body, H.linkCtx())}</div></div>
          <div class="ai-field"><label>关键词</label><div class="chips">${kw.map((k) => `<span class="chip">${esc(k)}</span>`).join('') || '<span class="muted">无</span>'}</div></div>
          ${newZid ? `<div class="ai-field"><label>建议位置</label><div><b class="zid">${esc(newZid)}</b> · ${posText}<div class="muted small">${esc(pos.reason || '')}</div></div></div>` : ''}
          <div class="ai-field"><label>建议链接</label><div>${r.links.length ? r.links.map((l) => {
            const c = index().byZid.get(l.zid);
            return `<div class="ai-link">${H.cardRow(c)}<div class="muted small">${esc(l.reason)}</div></div>`;
          }).join('') : '<span class="muted">没有找到明显相关的卡片</span>'}</div></div>
          <p class="muted small">AI 的结果只是建议。“用这个结果编辑”会把它填进编辑器，你检查修改后再保存。</p>
          <div class="actions"><button type="button" class="primary" data-x="apply">用这个结果编辑</button>
            <button type="button" data-x="again">重新整理</button><button type="button" data-close>关闭</button></div>
        </div>`;
        $('[data-x=again]', box).onclick = go;
        $('[data-x=apply]', box).onclick = () => {
          const body = r.body + (r.links.length ? `\n\n${r.links.map((l) => `- [[${l.zid}]] ${l.reason}`).join('\n')}` : '');
          lsSet(`zk.draft.${card.uid}`, { title: r.title, body, keywords: kw.join('，'), meta: card.meta || {}, ai: true });
          close();
          location.hash = card.kind === 'fleeting'
            ? `#/edit/${encodeURIComponent(card.uid)}?file=1&rel=${pos.rel}&ref=${encodeURIComponent(pos.ref || '')}`
            : `#/edit/${encodeURIComponent(card.uid)}`;
        };
      };
      go();
    },
  });
}

// ---------- AI 梳理联系（单张卡片） ----------

function appendLink(fromUid, toCard, type, reason) {
  const from = S.cards.get(fromUid);
  if (!from || from.deleted) return Promise.resolve(null);
  const line = `- ${type}：[[${ai.cardRef(toCard)}]] ${reason}`;
  return run('update', fromUid, { body: `${from.body.replace(/\s+$/, '')}\n\n${line}` });
}

export function openRelate(card) {
  H.openModal(`<h2>AI 梳理联系 · ${esc(H.label(card))} ${esc(card.title || '')}</h2><div class="ai-box"></div>`, {
    wide: true,
    onMount(m, close) {
      const box = $('.ai-box', m);
      const key = `zk.ai.rel.${card.uid}`;

      const render = (res, at) => {
        const ix = index();
        const center = S.cards.get(card.uid) || card;
        const rels = res.relations.map((r) => ({ ...r, card: S.cards.get(r.uid) })).filter((r) => r.card && !r.card.deleted);
        const nodes = [{ id: center.uid, label: nodeLabel(center), title: center.title, kind: center.kind, center: true }];
        const edges = [];
        for (const r of rels) {
          nodes.push({ id: r.card.uid, label: nodeLabel(r.card), title: r.card.title, kind: r.card.kind });
          edges.push({ a: center.uid, b: r.card.uid, cls: `rel-${REL_CLASS[r.type]}`, dashed: !isLinked(ix, center, r.card), title: `${r.type}：${r.reason}` });
        }
        const types = [...new Set(rels.map((r) => r.type))];
        box.innerHTML = `${rels.length ? renderNetwork(nodes, edges, { legend: relLegend(types) + '<span class="muted">（虚线 = 还没有链接）</span>' }) : ''}
          ${res.summary ? `<p class="ai-summary">${esc(res.summary)}</p>` : ''}
          <div class="rel-list">${rels.map((r) => `<div class="rel-item">
            <span class="rel-tag g-rel-${REL_CLASS[r.type]}">${r.type}</span>
            <div class="rel-main">${H.cardRow(r.card)}<div class="muted small">${esc(r.reason)}</div></div>
            ${isLinked(ix, center, r.card) ? '<span class="muted small">已链接</span>' : `<button type="button" data-link="${esc(r.card.uid)}" data-type="${r.type}">加入链接</button>`}
          </div>`).join('') || '<p class="muted">AI 没有找到明显相关的卡片。</p>'}</div>
          <p class="muted small">分析于 ${timeAgo(at)}。AI 的判断可能出错，“加入链接”会在本卡末尾写入一行 [[链接]] 和理由，你可以再编辑。</p>
          <div class="actions"><button type="button" data-x="again">重新分析</button><button type="button" data-close>关闭</button></div>`;
        attachPanZoom(box);
        $('[data-x=again]', box).onclick = go;
        box.onclick = async (e) => {
          const n = e.target.closest('.g-node');
          if (n) { close(); location.hash = `#/card/${encodeURIComponent(n.dataset.uid)}`; return; }
          const b = e.target.closest('[data-link]');
          if (!b) return;
          const r = rels.find((x) => x.card.uid === b.dataset.link);
          if (await appendLink(card.uid, r.card, r.type, r.reason)) {
            b.outerHTML = '<span class="muted small">已链接</span>';
            H.toast(`已加入链接 [[${ai.cardRef(r.card)}]]`);
          }
        };
      };

      const go = async () => {
        const ix = index();
        const linked = [];
        const out = ix.outlinks.get(card.uid);
        for (const z of out?.notes || []) if (ix.byZid.has(z)) linked.push(ix.byZid.get(z));
        for (const k of out?.lits || []) if (ix.byKey.has(k)) linked.push(ix.byKey.get(k));
        if (card.kind === 'note') for (const b of ix.backlinks.get(card.zid) || []) linked.push(b);
        if (card.kind === 'literature') for (const b of ix.citedBy.get(card.zid) || []) linked.push(b);
        const seen = new Set([card.uid]);
        const cands = [];
        for (const c of [...linked.slice(0, 5), ...sim.related(ix, card, 12, (c) => c.kind !== 'fleeting').map(([, c]) => c)]) {
          if (!seen.has(c.uid) && cands.length < 10) { seen.add(c.uid); cands.push(c); }
        }
        if (!cands.length) {
          box.innerHTML = '<p class="muted">卡片盒里还没有其他内容相近的卡片。多写几张再来试试。</p>';
          return;
        }
        const r = await job(box, ({ signal, step, onToken }) => {
          step(`AI 正在比较 ${cands.length} 张候选卡片…`);
          return ai.relate(card, cands, { signal, onToken });
        });
        if (!r) return;
        const res = { summary: r.summary, relations: r.relations.map((x) => ({ uid: x.card.uid, type: x.type, reason: x.reason })) };
        lsSet(key, { ...res, at: Date.now(), updatedAt: card.updatedAt });
        render(res, Date.now());
      };

      const cached = lsGet(key, null);
      if (cached) render(cached, cached.at);
      else go();
    },
  });
}

// ---------- AI 梳理整个卡片盒 ----------

// Groups = Luhmann's own topic sequences: every top-level number with its branches.
// Literature joins the group of the cards that cite it most.
function groupsOf(ix) {
  const groups = new Map();
  for (const c of ix.notes) {
    const root = Z.parse(c.zid)[0];
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(c);
  }
  for (const l of ix.lits) {
    const votes = new Map();
    for (const c of ix.citedBy.get(l.zid) || []) if (c.kind === 'note') {
      const root = Z.parse(c.zid)[0];
      votes.set(root, (votes.get(root) || 0) + 1);
    }
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '@';
    if (!groups.has(best)) groups.set(best, []);
    groups.get(best).push(l);
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([root, cards]) => ({ root, cards }));
}

export function viewMap() {
  return `<div class="page ai-page">
    ${aiHeader('map')}
    <p class="muted small">AI 会给每个主题序列起名，并找出内容相关、却还没有链接的卡片，判断它们之间是什么关系。卡片多时需要一两分钟。</p>
    <div class="actions"><button type="button" class="primary" data-ai="map-run">${lsGet(H.boxKey('zk.ai.map'), null) ? '重新梳理' : '开始梳理'}</button></div>
    <div class="ai-box" id="map-box"></div>
  </div>`;
}

function renderMap(box, res) {
  const ix = index();
  const groups = groupsOf(ix);
  const themeBy = new Map((res.themes || []).map((t) => [t.root, t]));
  const color = new Map();
  groups.forEach((g, i) => g.cards.forEach((c) => color.set(c.uid, THEME_COLORS[i % THEME_COLORS.length])));
  const cards = groups.flatMap((g) => g.cards).slice(0, 300);
  const shown = new Set(cards.map((c) => c.uid));
  const nodes = cards.map((c) => ({ id: c.uid, label: nodeLabel(c), title: c.title, kind: c.kind, color: color.get(c.uid) }));
  const edges = [];
  for (const c of cards) {
    if (c.kind === 'note' && Z.parent(c.zid) && ix.byZid.has(Z.parent(c.zid))) edges.push({ a: ix.byZid.get(Z.parent(c.zid)).uid, b: c.uid, cls: 'seq', weight: 1.5 });
    const out = ix.outlinks.get(c.uid);
    for (const z of out?.notes || []) { const t = ix.byZid.get(z); if (t && shown.has(t.uid) && t.uid !== c.uid) edges.push({ a: c.uid, b: t.uid, cls: 'link' }); }
    for (const k of out?.lits || []) { const t = ix.byKey.get(k); if (t && shown.has(t.uid)) edges.push({ a: c.uid, b: t.uid, cls: 'cite' }); }
  }
  const rels = (res.rels || []).map((r) => ({ ...r, A: S.cards.get(r.a), B: S.cards.get(r.b) }))
    .filter((r) => r.A && r.B && !r.A.deleted && !r.B.deleted);
  for (const r of rels) if (shown.has(r.a) && shown.has(r.b)) {
    edges.push({ a: r.a, b: r.b, cls: `rel-${REL_CLASS[r.type]}`, dashed: !isLinked(ix, r.A, r.B), title: `${r.type}：${r.reason}`, weight: 0.3 });
  }
  const themeLegend = groups.slice(0, THEME_COLORS.length).map((g, i) => {
    const t = themeBy.get(g.root);
    const name = t?.name || (g.root === '@' ? '未被引用的文献' : `${g.root} ${H.titleOf(g.cards[0])}`);
    return `<div class="theme"><i style="background:${THEME_COLORS[i]}"></i><div><b>${esc(name)}</b> <span class="muted small">${g.cards.length} 张${g.root !== '@' ? ` · 序列 ${esc(g.root)}` : ''}</span>${t?.summary ? `<div class="muted small">${esc(t.summary)}</div>` : ''}</div></div>`;
  }).join('');
  const types = [...new Set(rels.map((r) => r.type))];
  box.innerHTML = `${renderNetwork(nodes, edges, { legend: relLegend(types), spread: cards.length > 60 ? 0.8 : 1, height: '68vh' })}
    <section><h2>主题</h2><div class="themes">${themeLegend}</div></section>
    <section><h2>AI 发现的联系 <span class="muted small">${rels.length} 条</span></h2>
    <div class="rel-list">${rels.map((r, i) => `<div class="rel-item">
      <span class="rel-tag g-rel-${REL_CLASS[r.type]}">${r.type}</span>
      <div class="rel-main"><div class="pair">${H.cardRow(r.A)}<span class="arrow">↔</span>${H.cardRow(r.B)}</div><div class="muted small">${esc(r.reason)}</div></div>
      ${isLinked(ix, r.A, r.B) ? '<span class="muted small">已链接</span>' : `<button type="button" data-pair="${i}">加入链接</button>`}
    </div>`).join('') || '<p class="muted">没有发现新的联系。</p>'}</div></section>
    <p class="muted small">梳理于 ${timeAgo(res.at)}。“加入链接”会在左边那张卡片末尾写入 [[链接]] 和理由。AI 的判断可能出错，请自己确认。</p>`;
  attachPanZoom(box);
  box.onclick = async (e) => {
    const n = e.target.closest('.g-node');
    if (n) { location.hash = `#/card/${encodeURIComponent(n.dataset.uid)}`; return; }
    const b = e.target.closest('[data-pair]');
    if (!b) return;
    const r = rels[Number(b.dataset.pair)];
    if (await appendLink(r.a, r.B, r.type, r.reason)) {
      b.outerHTML = '<span class="muted small">已链接</span>';
      H.toast(`已在 ${H.label(r.A)} 中加入 [[${ai.cardRef(r.B)}]]`);
    }
  };
}

async function runMap(box) {
  const ix = index();
  if (ix.notes.length + ix.lits.length < 3) {
    box.innerHTML = '<p class="muted">卡片太少了，先写几张再来梳理。</p>';
    return;
  }
  const groups = groupsOf(ix).filter((g) => g.cards.length >= 2 && g.root !== '@').slice(0, THEME_COLORS.length);
  const pairs = sim.unlinkedPairs(ix, 18, (a, b) => isLinked(ix, a, b));
  const res = await job(box, async ({ signal, step, onToken }) => {
    let themes = [];
    if (groups.length) {
      step(`第 1 步：为 ${groups.length} 个主题序列命名…`);
      themes = (await ai.nameThemes(groups.map((g) => g.cards), { signal, onToken }))
        .filter((t) => groups[t.id]).map((t) => ({ root: groups[t.id].root, name: t.name, summary: t.summary }));
    }
    const rels = [];
    for (let i = 0; i < pairs.length; i += 6) {
      step(`第 2 步：判断卡片之间的关系（${Math.min(i + 6, pairs.length)}/${pairs.length}）…`);
      const batch = pairs.slice(i, i + 6).map(([, a, b]) => [a, b]);
      for (const p of await ai.relatePairs(batch, { signal, onToken })) {
        rels.push({ a: batch[p.id][0].uid, b: batch[p.id][1].uid, type: p.type, reason: p.reason });
      }
    }
    return { themes, rels, at: Date.now() };
  });
  if (!res) return;
  lsSet(H.boxKey('zk.ai.map'), res);
  renderMap(box, res);
}

// ---------- 聊天 ----------

const chat = { messages: [], box: null, busy: false, ctrl: null, think: false };

function loadChat() {
  const key = H.boxKey('zk.ai.chat');
  if (chat.box !== key) {
    chat.box = key;
    chat.messages = lsGet(key, []);
  }
}

function saveChat() {
  lsSet(H.boxKey('zk.ai.chat'), chat.messages.slice(-40));
}

function aiHeader(tab) {
  return `<div class="ai-head"><h1>AI 助手</h1><div class="ai-status" id="ai-status"></div></div>
    <nav class="ai-nav"><a href="#/ai"${tab === 'chat' ? ' class="active"' : ''}>对话</a><a href="#/ai/map"${tab === 'map' ? ' class="active"' : ''}>梳理整个卡片盒</a></nav>`;
}

function bubble(m, i) {
  if (m.role === 'user') return `<div class="msg user"><div class="bubble">${esc(m.content).replace(/\n/g, '<br>')}</div></div>`;
  const refs = (m.refs || []).map((u) => S.cards.get(u)).filter((c) => c && !c.deleted);
  return `<div class="msg bot" data-i="${i}">
    ${m.thinking ? `<details class="thinking"><summary>思考过程</summary><div>${esc(m.thinking).replace(/\n/g, '<br>')}</div></details>` : ''}
    <div class="bubble md">${m.content ? renderMarkdown(m.content, H.linkCtx()) : '<span class="muted">…</span>'}</div>
    ${m.error ? `<p class="err small">${esc(m.error)}</p>` : ''}
    ${refs.length ? `<div class="refs"><span class="muted small">参考卡片：</span>${refs.map((c) => `<a class="chip" href="${H.cardHref(c)}">${esc(H.label(c))} ${esc(H.titleOf(c).slice(0, 16))}</a>`).join('')}</div>` : ''}
    ${m.content && !chat.busy ? `<div class="msg-tools"><button type="button" data-ai="save" data-i="${i}">存为闪念</button><button type="button" data-ai="copy" data-i="${i}">复制</button></div>` : ''}
  </div>`;
}

export function viewChat(q) {
  loadChat();
  const pin = q.get('card') && S.cards.get(q.get('card'));
  const examples = ['我的卡片盒主要在讨论哪些问题？', '哪些观点之间互相矛盾？', '根据我的卡片，下一步值得写什么？'];
  return `<div class="page ai-page chat-page">
    ${aiHeader('chat')}
    ${pin ? `<div class="ai-pin">围绕这张卡片提问：${H.cardRow(pin)}<a href="#/ai">取消</a></div>` : ''}
    <div class="chat" id="chat">${chat.messages.map(bubble).join('') || `<div class="chat-empty">
      <p class="muted">AI 会先从你的卡片里找出相关的几张，再根据它们回答，回答里的 [[编号]] 可以直接点开。</p>
      <div class="examples">${examples.map((e) => `<button type="button" data-ai="ask" data-q="${esc(e)}">${esc(e)}</button>`).join('')}</div></div>`}</div>
    <form class="chat-input" id="chat-form">
      <textarea rows="2" placeholder="问问你的卡片盒…（Enter 发送，Shift+Enter 换行）"></textarea>
      <div class="chat-tools">
        <label class="small"><input type="checkbox" id="ai-think"${chat.think ? ' checked' : ''}> 深度思考（更慢）</label>
        <span class="spacer"></span>
        <button type="button" data-ai="clear">清空对话</button>
        <button type="button" data-ai="stop"${chat.busy ? '' : ' hidden'}>停止</button>
        <button type="submit" class="primary"${chat.busy ? ' disabled' : ''}>发送</button>
      </div>
    </form>
  </div>`;
}

function renderChat() {
  const box = document.getElementById('chat');
  if (!box) return;
  box.innerHTML = chat.messages.map(bubble).join('');
  const form = document.getElementById('chat-form');
  if (form) {
    $('[type=submit]', form).disabled = chat.busy;
    $('[data-ai=stop]', form).hidden = !chat.busy;
  }
  box.lastElementChild?.scrollIntoView({ block: 'end' });
}

let frame = 0;
function renderLastSoon() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const i = chat.messages.length - 1;
    const el = document.querySelector(`#chat .msg[data-i="${i}"]`);
    if (!el) return renderChat();
    el.outerHTML = bubble(chat.messages[i], i);
    document.querySelector(`#chat .msg[data-i="${i}"]`)?.scrollIntoView({ block: 'end' });
  });
}

async function ask(question, pinUid) {
  if (chat.busy || !question.trim()) return;
  const ix = index();
  const history = chat.messages.filter((m) => m.content).map(({ role, content }) => ({ role, content }));
  const lastUser = [...chat.messages].reverse().find((m) => m.role === 'user')?.content || '';
  const pinned = pinUid && S.cards.get(pinUid);
  const ctx = [];
  for (const c of [pinned, ...sim.search(ix, `${question} ${lastUser}`, 6).map(([, c]) => c)]) {
    if (c && !c.deleted && !ctx.includes(c) && ctx.length < 6) ctx.push(c);
  }
  chat.messages.push({ role: 'user', content: question.trim() });
  const msg = { role: 'assistant', content: '', refs: ctx.map((c) => c.uid) };
  chat.messages.push(msg);
  chat.busy = true;
  chat.ctrl = new AbortController();
  setBusy(1);
  renderChat();
  try {
    await ai.ensureReady((t) => { msg.content = `*${t}*`; renderLastSoon(); });
    msg.content = '';
    const r = await ai.chat(ai.chatMessages(history, question.trim(), ctx), {
      think: chat.think,
      signal: chat.ctrl.signal,
      onToken: (t) => { msg.content = t; renderLastSoon(); },
      onThinking: (t) => { msg.thinking = t; renderLastSoon(); },
    });
    msg.content = r.content;
  } catch (e) {
    if (e.code === 'no_model') msg.error = `还没有下载模型 ${ai.cfg.model}，请到“梳理整个卡片盒”或卡片上的 AI 功能里下载。`;
    else msg.error = ai.aiErrorText(e);
    if (msg.content.startsWith('*')) msg.content = '';
  } finally {
    chat.busy = false;
    chat.ctrl = null;
    saveChat();
    renderChat();
    setBusy(-1);
  }
}

// ---------- mounting ----------

export function mount(main, route) {
  const page = main.querySelector('.ai-page');
  bindStatus(page);
  refreshStatus();
  if (route.parts[1] === 'map') {
    const box = document.getElementById('map-box');
    const cached = lsGet(H.boxKey('zk.ai.map'), null);
    if (cached) renderMap(box, cached);
    page.querySelector('[data-ai=map-run]').onclick = () => runMap(box);
    return;
  }
  const pin = route.q.get('card');
  const form = document.getElementById('chat-form');
  const ta = $('textarea', form);
  document.getElementById('chat').lastElementChild?.scrollIntoView({ block: 'end' });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = ta.value;
    ta.value = '';
    ask(q, pin);
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  $('#ai-think', form).onchange = (e) => { chat.think = e.target.checked; };
  page.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ai]');
    if (!b) return;
    const act = b.dataset.ai;
    if (act === 'ask') ask(b.dataset.q, pin);
    if (act === 'stop') chat.ctrl?.abort();
    if (act === 'clear' && !chat.busy) { chat.messages = []; saveChat(); renderChat(); }
    if (act === 'copy') {
      await navigator.clipboard?.writeText(chat.messages[b.dataset.i].content).catch(() => {});
      H.toast('已复制');
    }
    if (act === 'save') {
      const m = chat.messages[b.dataset.i];
      const q = chat.messages[b.dataset.i - 1]?.content || '';
      await run('create', { uid: uuid(), kind: 'fleeting', body: `> ${q}\n\n${m.content}` });
      H.toast('已存入收件箱');
    }
  });
  ta.focus();
}
