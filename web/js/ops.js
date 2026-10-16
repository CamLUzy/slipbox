// Every change to the slip box goes through these functions. They take the current
// cards (Map uid -> card), never mutate it, and return the cards that changed;
// store.js applies and persists them.
import * as Z from './luhmann.js';

export const CITEKEY_RE = /^[\p{L}\p{N}_\-.:]{1,64}$/u;
const KINDS = new Set(['note', 'fleeting', 'literature']);

export class OpError extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.code = code;
    this.extra = extra;
  }
}

export function errorText(e) {
  const code = e?.code || e;
  const t = {
    zid_taken: '编号已被占用',
    bad_zid: '编号格式不正确',
    bad_citekey: '文献键只能包含字母、数字、汉字和 - _ . :',
    citekey_taken: '文献键已被使用',
    not_found: '卡片不存在',
    move_into_self: '不能移到自己的分支下',
    bad_kind: '不支持的类型转换',
    empty: '卡片是空的',
  }[code];
  return t ? t + (e?.extra?.zid ? `：${e.extra.zid}` : '') : String(e?.message || e);
}

function clean(f) {
  const out = {};
  if ('title' in f) out.title = String(f.title ?? '').slice(0, 500);
  if ('body' in f) out.body = String(f.body ?? '');
  if ('keywords' in f) out.keywords = [...new Set((f.keywords || []).map((k) => String(k).trim()).filter(Boolean))];
  if ('meta' in f) out.meta = f.meta && typeof f.meta === 'object' ? f.meta : {};
  return out;
}

export function zidSet(cards, kind, exceptUid) {
  const s = new Set();
  for (const c of cards.values()) if (c.kind === kind && c.zid && !c.deleted && c.uid !== exceptUid) s.add(c.zid);
  return s;
}

// intent: { rel: 'top' | 'continue' | 'branch' | 'exact', ref }
function resolveZid(cards, kind, requested, intent, selfUid) {
  if (kind === 'fleeting') return null;
  const taken = zidSet(cards, kind, selfUid);
  if (kind === 'literature') {
    const key = String(requested ?? '').trim();
    if (!CITEKEY_RE.test(key)) throw new OpError('bad_citekey');
    if (taken.has(key)) throw new OpError('citekey_taken', { zid: key });
    return key;
  }
  const rel = intent?.rel || (requested ? 'exact' : 'top');
  if (rel === 'exact') {
    if (!Z.isValid(requested)) throw new OpError('bad_zid', { zid: requested });
    if (taken.has(requested)) throw new OpError('zid_taken', { zid: requested });
    return requested;
  }
  return Z.suggest(rel, intent?.ref, taken);
}

export function create(cards, c, intent) {
  const kind = KINDS.has(c.kind) ? c.kind : 'fleeting';
  const f = clean({ title: '', body: '', keywords: [], meta: {}, ...c });
  if (!f.title.trim() && !f.body.trim()) throw new OpError('empty');
  const now = Date.now();
  const card = {
    uid: c.uid, kind, zid: resolveZid(cards, kind, c.zid, intent, null), ...f,
    createdAt: c.createdAt || now, updatedAt: now, deleted: false,
  };
  return [card];
}

export function update(cards, uid, fields, intent) {
  const cur = cards.get(uid);
  if (!cur || cur.deleted) throw new OpError('not_found');
  const next = { ...cur, ...clean(fields), updatedAt: Date.now() };
  const kind = fields.kind ?? cur.kind;
  if (!KINDS.has(kind) || (kind !== cur.kind && cur.kind !== 'fleeting')) throw new OpError('bad_kind');
  if (!next.title.trim() && !next.body.trim()) throw new OpError('empty');

  const zidChanged = 'zid' in fields && fields.zid !== cur.zid;
  if (kind !== cur.kind || zidChanged) {
    if (cur.kind === 'note') {
      // renumbering an existing note moves its whole branch
      const work = new Map(cards).set(uid, next);
      return move(work, uid, String(fields.zid ?? ''), next);
    }
    next.kind = kind;
    next.zid = resolveZid(cards, kind, fields.zid, intent, uid);
    if (cur.kind === 'literature' && cur.zid !== next.zid) {
      const changed = new Map([[uid, next]]);
      rewriteAll(cards, null, new Map([[cur.zid, next.zid]]), changed);
      return [...changed.values()];
    }
  }
  return [next];
}

export function remove(cards, uid) {
  const cur = cards.get(uid);
  if (!cur) throw new OpError('not_found');
  if (cur.deleted) return [];
  return [{ ...cur, deleted: true, updatedAt: Date.now() }];
}

// Returns the restored card; if its ID was taken meanwhile, a note goes back to the inbox.
export function restore(cards, uid) {
  const cur = cards.get(uid);
  if (!cur) throw new OpError('not_found');
  const next = { ...cur, deleted: false, updatedAt: Date.now() };
  if (cur.zid && zidSet(cards, cur.kind, uid).has(cur.zid)) {
    if (cur.kind === 'literature') {
      const taken = zidSet(cards, 'literature', uid);
      let i = 2;
      while (taken.has(`${cur.zid}-${i}`)) i++;
      next.zid = `${cur.zid}-${i}`;
    } else {
      Object.assign(next, { kind: 'fleeting', zid: null, meta: { ...cur.meta, formerZid: cur.zid } });
    }
  }
  return [next];
}

// Renumber a note together with its whole branch and rewrite every [[link]] into it.
export function move(cards, uid, newRoot, base) {
  const cur = base || cards.get(uid);
  if (!cur || cur.deleted) throw new OpError('not_found');
  if (cur.kind !== 'note' || !cur.zid) throw new OpError('bad_kind');
  const oldRoot = cur.zid;
  if (!Z.isValid(newRoot)) throw new OpError('bad_zid', { zid: newRoot });
  if (newRoot === oldRoot) return [cur];
  if (Z.isAncestor(oldRoot, newRoot)) throw new OpError('move_into_self');

  const notes = [...cards.values()].filter((c) => c.kind === 'note' && c.zid && !c.deleted);
  const branch = notes.filter((c) => c.zid === oldRoot || Z.isAncestor(oldRoot, c.zid));
  const map = new Map(branch.map((c) => [c.zid, Z.remap(oldRoot, newRoot, c.zid)]));
  const others = new Set(notes.filter((c) => !map.has(c.zid)).map((c) => c.zid));
  for (const z of map.values()) if (others.has(z)) throw new OpError('zid_taken', { zid: z });

  const now = Date.now();
  const changed = new Map();
  for (const c of branch) changed.set(c.uid, { ...c, zid: map.get(c.zid), updatedAt: now });
  rewriteAll(cards, map, null, changed);
  return [...changed.values()];
}

function rewriteAll(cards, noteMap, litMap, changed) {
  for (const c0 of cards.values()) {
    if (c0.deleted) continue;
    const c = changed.get(c0.uid) || c0;
    if (!c.body.includes('[[')) continue;
    const body = Z.rewriteLinks(c.body, noteMap, litMap);
    if (body !== c.body) changed.set(c.uid, { ...c, body, updatedAt: Date.now() });
  }
}

// Import cards from a JSON export (this app's or the earlier host version's).
// Existing uids are skipped; an ID that is already taken sends the card to the inbox.
export function importCards(cards, list) {
  const work = new Map(cards);
  const added = [];
  let toInbox = 0;
  for (const raw of list) {
    if (!raw || typeof raw.uid !== 'string' || work.has(raw.uid)) continue;
    let kind = KINDS.has(raw.kind) ? raw.kind : 'fleeting';
    let zid = kind === 'fleeting' ? null : raw.zid ?? null;
    const meta = raw.meta && typeof raw.meta === 'object' ? { ...raw.meta } : {};
    const okId = kind === 'note' ? Z.isValid(zid) : kind === 'literature' ? CITEKEY_RE.test(zid ?? '') : true;
    if (kind !== 'fleeting' && !raw.deleted && (!okId || zidSet(work, kind).has(zid))) {
      meta.formerZid = zid;
      kind = 'fleeting';
      zid = null;
      toInbox++;
    }
    const card = {
      uid: raw.uid, kind, zid, ...clean({ title: '', body: '', keywords: [], ...raw, meta }),
      createdAt: Number(raw.createdAt) || Date.now(), updatedAt: Number(raw.updatedAt) || Date.now(), deleted: !!raw.deleted,
    };
    work.set(card.uid, card);
    added.push(card);
  }
  return { cards: added, toInbox };
}
