// Network drawings: a card's neighbourhood (Folgezettel sequence + [[links]]) and the
// AI relation maps. Force-directed layout, drawn as SVG, with drag-to-pan and wheel zoom.
import * as Z from './luhmann.js';
import { esc } from './util.js';

export const REL_CLASS = { 支持: 'support', 反驳: 'oppose', 举例: 'example', 延伸: 'extend', 前提: 'premise', 对比: 'contrast', 相似: 'similar' };
export const THEME_COLORS = ['#c0503a', '#2c6a96', '#4c7a3f', '#a87a1c', '#7d4f9a', '#2f8a8a', '#b5527a', '#5d6b2f', '#8a5a3c', '#3f5ab5', '#9a3f3f', '#4f8a5f'];

const nodeLabel = (c) => (c.kind === 'literature' ? '@' + c.zid : c.zid || '闪念');

export function neighbourhood(center, ix, maxDepth = 2, maxNodes = 60) {
  const nodes = new Map([[center.uid, { card: center, depth: 0 }]]);
  const edges = new Map();
  const addEdge = (a, b, type) => {
    const key = [a, b].sort().join('|') + type;
    if (!edges.has(key)) edges.set(key, { a, b, cls: type });
  };
  let frontier = [center];
  for (let d = 1; d <= maxDepth && nodes.size < maxNodes; d++) {
    const next = [];
    for (const c of frontier) {
      const near = [];
      if (c.kind === 'note' && c.zid) {
        const p = Z.parent(c.zid);
        if (p && ix.byZid.has(p)) near.push([ix.byZid.get(p), 'seq']);
        for (const z of ix.children.get(c.zid) || []) if (ix.byZid.has(z)) near.push([ix.byZid.get(z), 'seq']);
        for (const b of ix.backlinks.get(c.zid) || []) near.push([b, 'link']);
      }
      if (c.kind === 'literature') for (const b of ix.citedBy.get(c.zid) || []) near.push([b, 'cite']);
      const out = ix.outlinks.get(c.uid);
      for (const z of out?.notes || []) if (ix.byZid.has(z)) near.push([ix.byZid.get(z), 'link']);
      for (const k of out?.lits || []) if (ix.byKey.has(k)) near.push([ix.byKey.get(k), 'cite']);
      for (const [n, type] of near) {
        if (n.uid === c.uid) continue;
        if (!nodes.has(n.uid)) {
          if (nodes.size >= maxNodes) continue;
          nodes.set(n.uid, { card: n, depth: d });
          next.push(n);
        }
        addEdge(c.uid, n.uid, type);
      }
    }
    frontier = next;
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function layout(nodes, edges, spread = 1) {
  const pos = new Map();
  const n = nodes.length;
  nodes.forEach((node, i) => {
    const a = (i / n) * Math.PI * 2 + i * 0.7;
    const r = node.center ? 0 : 60 + Math.sqrt(i + 1) * 40 * spread;
    pos.set(node.id, { x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0, fixed: node.center });
  });
  const list = [...pos.values()];
  const rep = 6000 * spread;
  const len = 130 * spread;
  const iters = n > 120 ? 220 : 300;
  for (let it = 0; it < iters; it++) {
    const t = 1 - it / iters;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const p = list[i], q = list[j];
        let dx = p.x - q.x, dy = p.y - q.y;
        const d2 = dx * dx + dy * dy + 0.01;
        if (d2 > 250000) continue;
        const f = rep / d2;
        const d = Math.sqrt(d2);
        dx /= d; dy /= d;
        p.vx += dx * f; p.vy += dy * f;
        q.vx -= dx * f; q.vy -= dy * f;
      }
    }
    for (const e of edges) {
      const p = pos.get(e.a), q = pos.get(e.b);
      if (!p || !q) continue;
      const dx = q.x - p.x, dy = q.y - p.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - len) * 0.03 * (e.weight ?? 1);
      p.vx += (dx / d) * f; p.vy += (dy / d) * f;
      q.vx -= (dx / d) * f; q.vy -= (dy / d) * f;
    }
    for (const p of list) {
      if (p.fixed) { p.vx = p.vy = 0; continue; }
      p.vx -= p.x * 0.004; p.vy -= p.y * 0.004;
      p.x += Math.max(-20, Math.min(20, p.vx)) * t;
      p.y += Math.max(-20, Math.min(20, p.vy)) * t;
      p.vx *= 0.5; p.vy *= 0.5;
    }
  }
  return pos;
}

// nodes: [{ id, label, title, kind, color?, center? }]
// edges: [{ a, b, cls, title?, dashed? }]   cls: seq | link | cite | rel-<type>
export function renderNetwork(nodes, edges, { legend = '', spread = 1, height } = {}) {
  if (!nodes.length) return '<p class="empty">没有可以显示的卡片。</p>';
  const pos = layout(nodes, edges, spread);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pos.values()) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const pad = 70;
  const vb = [minX - pad, minY - pad, maxX - minX + pad * 2, maxY - minY + pad * 2].map((v) => Math.round(v));
  const lines = edges.map((e) => {
    const p = pos.get(e.a), q = pos.get(e.b);
    if (!p || !q) return '';
    return `<line class="g-edge g-${e.cls}${e.dashed ? ' g-dashed' : ''}" data-a="${esc(e.a)}" data-b="${esc(e.b)}" x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${q.x.toFixed(1)}" y2="${q.y.toFixed(1)}">${e.title ? `<title>${esc(e.title)}</title>` : ''}</line>`;
  }).join('');
  const dots = nodes.map((nd) => {
    const p = pos.get(nd.id);
    const style = nd.color ? ` style="--node:${nd.color}"` : '';
    return `<g class="g-node g-k-${nd.kind}${nd.center ? ' g-center' : ''}${nd.color ? ' g-colored' : ''}" data-uid="${esc(nd.id)}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})"${style}>
      <circle r="${nd.center ? 11 : 7}"/>
      <text class="g-id" y="-13">${esc(nd.label)}</text>
      ${nd.title ? `<text class="g-title" y="21">${esc(nd.title.slice(0, 14))}</text>` : ''}
      <title>${esc(nd.label)} ${esc(nd.title || '')}</title></g>`;
  }).join('');
  return `<div class="graph-wrap"${height ? ` style="--gh:${height}"` : ''}>
    <svg class="graph${nodes.length > 40 ? ' g-dense' : ''}" viewBox="${vb.join(' ')}" data-vb="${vb.join(' ')}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="关系图">${lines}${dots}</svg>
    <div class="g-tools"><button type="button" data-g="in" aria-label="放大">＋</button><button type="button" data-g="out" aria-label="缩小">－</button><button type="button" data-g="fit">适应</button></div>
  </div>
  <div class="g-legend">${legend || '<span class="lg lg-seq"></span>序列（上级/分支）<span class="lg lg-link"></span>链接<span class="lg lg-cite"></span>文献引用'}</div>`;
}

export function relLegend(types = Object.keys(REL_CLASS)) {
  return `<span class="lg lg-seq"></span>序列<span class="lg lg-link"></span>已有链接` +
    types.map((t) => `<span class="lg lg-rel g-rel-${REL_CLASS[t]}"></span>AI：${t}`).join('');
}

export function renderGraph(center, ix) {
  const { nodes, edges } = neighbourhood(center, ix);
  return renderNetwork(
    nodes.map(({ card, depth }) => ({ id: card.uid, label: nodeLabel(card), title: card.title, kind: card.kind, center: depth === 0 })),
    edges,
  );
}

export { nodeLabel };

// Drag to pan, wheel / buttons to zoom. Call after the SVG is in the document.
export function attachPanZoom(root) {
  for (const wrap of root.querySelectorAll('.graph-wrap')) {
    const svg = wrap.querySelector('svg');
    attachHover(svg);
    const home = svg.dataset.vb.split(' ').map(Number);
    let vb = [...home];
    const apply = () => svg.setAttribute('viewBox', vb.map((v) => v.toFixed(1)).join(' '));
    const zoom = (k, cx = vb[0] + vb[2] / 2, cy = vb[1] + vb[3] / 2) => {
      const w = Math.min(Math.max(vb[2] * k, home[2] / 8), home[2] * 3);
      const h = (w / vb[2]) * vb[3];
      vb = [cx - ((cx - vb[0]) * w) / vb[2], cy - ((cy - vb[1]) * h) / vb[3], w, h];
      apply();
    };
    const toSvg = (e) => {
      const r = svg.getBoundingClientRect();
      const s = Math.max(vb[2] / r.width, vb[3] / r.height);
      const ox = (r.width * s - vb[2]) / 2, oy = (r.height * s - vb[3]) / 2;
      return [vb[0] - ox + (e.clientX - r.left) * s, vb[1] - oy + (e.clientY - r.top) * s, s];
    };
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = toSvg(e);
      zoom(Math.exp(e.deltaY * 0.0015), x, y);
    }, { passive: false });
    let drag = null;
    svg.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.g-node')) return;
      drag = { x: e.clientX, y: e.clientY, vb: [...vb], s: toSvg(e)[2], moved: false };
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = (e.clientX - drag.x) * drag.s, dy = (e.clientY - drag.y) * drag.s;
      if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
      vb = [drag.vb[0] - dx, drag.vb[1] - dy, vb[2], vb[3]];
      apply();
    });
    svg.addEventListener('pointerup', () => { drag = null; });
    wrap.querySelector('.g-tools').addEventListener('click', (e) => {
      const b = e.target.closest('[data-g]')?.dataset.g;
      if (b === 'in') zoom(0.7);
      if (b === 'out') zoom(1.4);
      if (b === 'fit') { vb = [...home]; apply(); }
    });
  }
}

// Hovering a node highlights it, its direct neighbours and the edges between them;
// everything else fades out. In dense graphs titles only show for highlighted nodes.
function attachHover(svg) {
  const nodes = new Map([...svg.querySelectorAll('.g-node')].map((n) => [n.dataset.uid, n]));
  const edgesOf = new Map();
  for (const line of svg.querySelectorAll('.g-edge')) {
    for (const id of [line.dataset.a, line.dataset.b]) {
      if (!edgesOf.has(id)) edgesOf.set(id, []);
      edgesOf.get(id).push(line);
    }
  }
  let current = null;
  const clear = () => {
    if (!current) return;
    svg.classList.remove('g-focus');
    for (const el of svg.querySelectorAll('.hl, .hl-center')) el.classList.remove('hl', 'hl-center');
    current = null;
  };
  const focus = (id) => {
    if (id === current) return;
    clear();
    current = id;
    svg.classList.add('g-focus');
    nodes.get(id)?.classList.add('hl', 'hl-center');
    for (const line of edgesOf.get(id) || []) {
      line.classList.add('hl');
      nodes.get(line.dataset.a === id ? line.dataset.b : line.dataset.a)?.classList.add('hl');
    }
  };
  svg.addEventListener('pointerover', (e) => {
    if (e.buttons) return; // panning
    const n = e.target.closest('.g-node');
    if (n) focus(n.dataset.uid);
  });
  svg.addEventListener('pointerout', (e) => {
    const n = e.target.closest('.g-node');
    if (n && !n.contains(e.relatedTarget)) clear();
  });
  svg.addEventListener('pointerleave', clear);
}
