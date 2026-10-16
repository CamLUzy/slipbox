// The 设备与同步 page. While it is open this device can be found by others on the same Wi-Fi;
// leaving the page stops listening. Tapping 同步 next to a device makes that device the host.
import * as sync from './sync.js';
import { esc, timeAgo } from './util.js';

let H; // helpers from app.js: toast
export function setup(helpers) {
  H = helpers;
}

const $ = (sel, root = document) => root.querySelector(sel);
const PLATFORM = { mac: 'Mac', ios: 'iPhone / iPad', windows: 'Windows' };
const ACTION = {
  sync: '同步',
  merge: '合并为一个（第一次同步）',
  toRemote: '复制到对方',
  toLocal: '复制到本机',
};

// Without this permission the system silently hides other devices.
const PERMISSION = {
  mac: '<br>系统问“是否允许卡片盒查找本地网络上的设备”时请点允许；如果之前拒绝了，到“系统设置 → 隐私与安全性 → 本地网络”里打开卡片盒。',
  ios: '<br>系统问“是否允许卡片盒查找本地网络上的设备”时请点允许；如果之前拒绝了，到“设置 → 隐私与安全性 → 本地网络”里打开卡片盒。',
  windows: '<br>Windows 防火墙询问时，请允许卡片盒在“专用网络”上通信。',
};

// Page state survives re-renders (the page is redrawn whenever cards change).
const st = {
  info: null, // sync.state()
  open: false,
  error: '',
  task: null, // what the panel shows: { kind: 'connecting' | 'pair' | 'plan' | 'running' | 'done' | 'error', ... }
  prompt: null, // the other device asks to pair: { id, code, peer }
  renaming: false,
  hosting: null, // the other device is syncing with this one: { peer }
};

let main = null;
let unsubscribe = null;

export function view() {
  if (!sync.available) {
    return `<div class="page"><h1>设备与同步</h1>
      <p>浏览器版不能和其他设备同步。请使用 Windows、macOS 或 iPhone 应用。</p></div>`;
  }
  return '<div class="page sync-page"></div>';
}

export function mount(el) {
  main = el;
  if (!sync.available) return;
  if (!st.open) {
    st.open = true;
    unsubscribe = sync.onEvent(onEvent);
    sync.start().then((info) => { st.info = info; st.error = ''; paint(); }, (e) => { st.error = e.message || String(e); paint(); });
  }
  paint();
}

/** Called when the user leaves the page: stop being discoverable. */
export function leave() {
  if (!st.open) return;
  st.open = false;
  unsubscribe?.();
  unsubscribe = null;
  sync.stop().catch(() => {});
  if (st.prompt) sync.answer(st.prompt.id, false).catch(() => {});
  st.prompt = null;
  st.hosting = null;
  if (st.task && !['running', 'connecting'].includes(st.task.kind)) st.task = null;
}

function onEvent(e) {
  if (st.renaming && e.type === 'state') { st.info = e.state; return; } // keep what is being typed
  switch (e.type) {
    case 'state': st.info = e.state; break;
    case 'pair': st.prompt = { id: e.id, code: e.code, peer: e.peer }; break;
    case 'pairEnd': if (st.prompt?.id === e.id) st.prompt = null; break;
    case 'hostStart': st.hosting = { peer: e.peer, done: false }; break;
    case 'hostDone':
      st.hosting = { peer: e.peer, done: true, at: Date.now() };
      H.toast(`已与“${e.peer.name}”同步`);
      break;
    case 'error': st.error = e.message; break;
    default: return;
  }
  paint();
}

function paint() {
  const root = main && $('.sync-page', main);
  if (!root) return;
  const info = st.info;
  const nearby = info?.nearby || [];
  const busy = st.task && ['connecting', 'pair', 'plan', 'running'].includes(st.task.kind);
  const addr = info?.addresses?.length && info.port ? info.addresses.map((a) => `<code>${esc(a)}:${info.port}</code>`).join(' ') : '';
  root.innerHTML = `<h1>设备与同步</h1>
    <p class="muted small">两台设备都打开这个页面、连在同一个 Wi-Fi 下，在其中一台上点“同步”，另一台就作为主机。卡片直接在两台设备之间加密传输，不经过任何服务器。</p>
    ${st.error ? `<p class="err">${esc(st.error)}</p>` : ''}
    ${panel()}
    <section><h2>本机</h2>
      ${st.renaming ? `<form class="sync-me sync-rename"><input name="name" value="${esc(info?.device.name || '')}" maxlength="40" autocapitalize="off" aria-label="设备名称">
          <button type="submit" class="primary">保存</button><button type="button" data-sync="rename-cancel">取消</button></form>`
        : `<div class="sync-me">
        <div><b>${esc(info?.device.name || '…')}</b> <span class="muted small">${esc(PLATFORM[info?.device.platform] || '')}</span>
          <div class="muted small">${info?.listening ? `<i class="dot on"></i>其他设备现在可以找到这台设备${addr ? ` · 地址 ${addr}` : ''}` : '<i class="dot"></i>正在启动…'}</div></div>
        <button type="button" data-sync="rename">改名</button>
      </div>`}
    </section>
    <section><h2>附近的设备</h2>
      ${nearby.length ? `<div class="rows">${nearby.map((d) => `<div class="sync-dev">
          <div><b>${esc(d.name)}</b> <span class="muted small">${esc(PLATFORM[d.platform] || '')}${d.paired ? ' · 已配对' : ''}</span></div>
          <button type="button" class="primary" data-sync="go" data-peer="${esc(d.id)}" ${busy ? 'disabled' : ''}>${d.paired ? '同步' : '配对并同步'}</button>
        </div>`).join('')}</div>`
        : `<p class="empty small">还没有发现其他设备。请在另一台设备上也打开“设备与同步”，并确认两台设备连着同一个 Wi-Fi。${PERMISSION[info?.device.platform] || ''}</p>`}
      <details class="sync-manual"><summary class="small">找不到？输入对方页面上显示的地址</summary>
        <form class="sync-addr"><input name="address" placeholder="例如 192.168.1.20:51515" autocapitalize="off" autocorrect="off" spellcheck="false">
          <button type="submit" ${busy ? 'disabled' : ''}>连接</button></form>
      </details>
    </section>
    ${info?.paired?.length ? `<section><h2>已配对的设备</h2><div class="rows">${info.paired.map((d) => `<div class="sync-dev">
        <div><b>${esc(d.name)}</b> <span class="muted small">${esc(PLATFORM[d.platform] || '')}</span></div>
        <button type="button" data-sync="forget" data-peer="${esc(d.id)}">移除</button></div>`).join('')}</div>
      <p class="muted small">移除后，再同步需要重新配对。</p></section>` : ''}
    <p class="muted small">同步前两边都会自动备份。两边都改过的卡片保留较新的一份，较旧的一份作为“冲突副本”放进收件箱。</p>`;
  bind(root);
}

function panel() {
  if (st.prompt) {
    const p = st.prompt;
    return `<div class="sync-panel">
      <p><b>“${esc(p.peer.name)}”想和这台设备配对</b></p>
      <p class="sync-code">${esc(p.code.slice(0, 3))} ${esc(p.code.slice(3))}</p>
      <p class="muted small">请确认对方屏幕上显示的是同一组数字。数字不同说明有人冒充，请拒绝。</p>
      <div class="actions"><button type="button" class="primary" data-sync="accept">数字一致，确认配对</button><button type="button" data-sync="reject">拒绝</button></div>
    </div>`;
  }
  if (st.hosting && !st.hosting.done) {
    return `<div class="sync-panel"><span class="spinner"></span> “${esc(st.hosting.peer.name)}”正在和这台设备同步…</div>`;
  }
  const t = st.task;
  if (!t) {
    if (st.hosting?.done) return `<div class="sync-panel"><p>已与“${esc(st.hosting.peer.name)}”同步（${timeAgo(st.hosting.at)}）。</p></div>`;
    return '';
  }
  switch (t.kind) {
    case 'connecting':
      return `<div class="sync-panel"><span class="spinner"></span> 正在连接“${esc(t.name)}”…</div>`;
    case 'pair':
      return `<div class="sync-panel">
        <p><b>和“${esc(t.conn.peer.name)}”配对</b></p>
        <p class="sync-code">${esc(t.conn.code.slice(0, 3))} ${esc(t.conn.code.slice(3))}</p>
        <p class="muted small">对方屏幕上会出现一组数字。两边一样时，在两台设备上都点确认。只需要配对一次。</p>
        <div class="actions"><button type="button" class="primary" data-sync="pair-ok" ${t.waiting ? 'disabled' : ''}>${t.waiting ? '等待对方确认…' : '数字一致，确认'}</button>
          <button type="button" data-sync="cancel">取消</button></div>
      </div>`;
    case 'plan':
      return `<div class="sync-panel">
        <p><b>和“${esc(t.plan.peer.name)}”同步哪些卡片盒？</b></p>
        <div class="sync-plan">${t.plan.rows.map((r, i) => `<label class="sync-row">
          <input type="checkbox" data-row="${i}" ${r.checked ? 'checked' : ''}>
          <span><b>${esc(r.local)}</b>${r.remote !== r.local ? ` ⇄ <b>${esc(r.remote)}</b>` : ''}
          <span class="muted small">${ACTION[r.action]} · 本机 ${r.cards.local} 张 · 对方 ${r.cards.remote} 张</span></span></label>`).join('')}</div>
        <div class="actions"><button type="button" class="primary" data-sync="run">开始同步</button><button type="button" data-sync="cancel">取消</button></div>
      </div>`;
    case 'running':
      return `<div class="sync-panel"><span class="spinner"></span> 正在同步${t.row ? `“${esc(t.row.local)}”` : ''}…</div>`;
    case 'done':
      return `<div class="sync-panel">${t.results.map(resultHtml).join('')}
        <div class="actions"><button type="button" data-sync="dismiss">好</button></div></div>`;
    case 'error':
      return `<div class="sync-panel"><p class="err">${esc(t.message)}</p><div class="actions"><button type="button" data-sync="dismiss">好</button></div></div>`;
    default:
      return '';
  }
}

function resultHtml({ row, summary: s, error }) {
  if (error) return `<p><b>${esc(row.local)}</b>：<span class="err">${esc(error)}</span></p>`;
  const parts = [];
  if (s.added.local) parts.push(`本机新增 ${s.added.local} 张`);
  if (s.updated.local) parts.push(`本机更新 ${s.updated.local} 张`);
  if (s.added.remote) parts.push(`对方新增 ${s.added.remote} 张`);
  if (s.updated.remote) parts.push(`对方更新 ${s.updated.remote} 张`);
  if (s.purged) parts.push(`永久删除 ${s.purged} 张`);
  const notes = [
    ...s.conflicts.map((c) => `“${esc(c.title || c.zid || '')}”两边都改过：保留了较新的一份，${esc(c.from)}的版本放进了收件箱（【冲突副本】）`),
    ...s.renumbered.map((r) => `“${esc(r.title || '')}”的编号和对方的卡片重复，已从 ${esc(r.from)} 改为 ${esc(r.to)}`),
    ...s.revived.map((r) => `“${esc(r.title || r.zid || '')}”在一台设备上被删除、在另一台上被修改，已保留修改后的卡片`),
  ];
  return `<div class="sync-result"><p><b>${esc(row.local)}</b>：${parts.join('，') || '两边已经一致'}${s.created ? '（新建的卡片盒）' : ''}</p>
    ${notes.length ? `<ul class="small">${notes.map((n) => `<li>${n}</li>`).join('')}</ul>` : ''}</div>`;
}

function bind(root) {
  root.onclick = async (e) => {
    const b = e.target.closest('[data-sync]');
    if (!b) return;
    const act = b.dataset.sync;
    if (act === 'go') {
      const d = st.info.nearby.find((x) => x.id === b.dataset.peer);
      return begin({ peer: d.id }, d.name);
    }
    if (act === 'accept' || act === 'reject') {
      const p = st.prompt;
      st.prompt = null;
      paint();
      if (p) await sync.answer(p.id, act === 'accept');
      return;
    }
    if (act === 'pair-ok') return st.task?.confirm?.(true);
    if (act === 'cancel') {
      st.task?.confirm?.(false);
      const conn = st.task?.conn;
      st.task = null;
      if (conn) sync.close(conn);
      return paint();
    }
    if (act === 'run') {
      const t = st.task;
      t.plan.rows.forEach((r, i) => { r.checked = !!root.querySelector(`[data-row="${i}"]`)?.checked; });
      return runPlan(t.conn, t.plan);
    }
    if (act === 'dismiss') {
      st.task = null;
      return paint();
    }
    if (act === 'forget') {
      st.info = await sync.forget(b.dataset.peer);
      return paint();
    }
    if (act === 'rename' || act === 'rename-cancel') {
      st.renaming = act === 'rename';
      paint();
      $('.sync-rename input', root)?.select();
      return;
    }
  };
  const rename = $('.sync-rename', root);
  if (rename) {
    rename.onsubmit = async (e) => {
      e.preventDefault();
      const name = rename.name.value.trim();
      if (!name) return;
      try { st.info = await sync.rename(name); st.renaming = false; } catch (ex) { H.toast(ex.message || String(ex), 'warn'); }
      paint();
    };
  }
  const form = $('.sync-addr', root);
  if (form) {
    form.onsubmit = (e) => {
      e.preventDefault();
      const address = form.address.value.trim();
      if (address) begin({ address }, address);
    };
  }
}

// Connect, pair if needed, then show which boxes will be synced.
async function begin(target, name) {
  st.task = { kind: 'connecting', name };
  paint();
  let conn;
  try {
    conn = await sync.connect(target);
    if (!conn.paired) {
      let confirm;
      const confirmed = new Promise((r) => { confirm = r; });
      st.task = { kind: 'pair', conn, confirm: (ok) => { st.task.waiting = ok; paint(); confirm(ok); } };
      paint();
      await sync.pair(conn, confirmed);
    }
    const p = await sync.plan(conn);
    // boxes that already belong together are synced right away; anything new is asked first
    if (p.rows.every((r) => r.action === 'sync')) return runPlan(conn, p);
    st.task = { kind: 'plan', conn, plan: p };
    paint();
  } catch (e) {
    if (conn) sync.close(conn);
    st.task = e.code === 'cancelled' ? null : { kind: 'error', message: e.message || String(e) };
    paint();
  }
}

async function runPlan(conn, p) {
  st.task = { kind: 'running', conn };
  paint();
  try {
    const results = await sync.run(conn, p, (row) => { st.task.row = row; paint(); });
    st.task = { kind: 'done', results };
    const failed = results.filter((r) => r.error).length;
    H.toast(failed ? `同步完成，${failed} 个卡片盒出错` : `已与“${p.peer.name}”同步`, failed ? 'warn' : 'info');
    if (results.some((r) => r.row.action === 'toLocal' && !r.error)) H.boxesChanged?.();
  } catch (e) {
    st.task = { kind: 'error', message: e.message || String(e) };
  } finally {
    sync.close(conn);
  }
  paint();
}
