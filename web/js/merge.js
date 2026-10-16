// Merging two copies of one slip box (LAN sync, docs/SYNC.md). Pure: takes both sides' cards
// and tombstones and returns what each side has to write, so the same rules run on every
// platform and are covered by tests/merge.test.js.
import * as Z from './luhmann.js';
import { uuid } from './util.js';

// Key-order independent JSON, so two copies of the same card compare equal.
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export const sameCard = (a, b) => stable(a) === stable(b);
const sameContent = (a, b) => a.title === b.title && a.body === b.body && stable(a.keywords || []) === stable(b.keywords || []);
const newer = (a, b) => (a.updatedAt !== b.updatedAt ? a.updatedAt > b.updatedAt : stable(a) > stable(b));

/**
 * local / remote: all cards of the box on each side (trashed ones included).
 * localPurged / remotePurged: tombstones [{uid, at}] of permanently deleted cards.
 * lastSync: when these two devices last synced this box (0 = never).
 *
 * Returns { local: {put, purge}, remote: {put, purge}, summary }, where put is the cards to
 * write and purge the tombstones [{uid, at}] to record (their cards are deleted).
 */
export function mergeBoxes({
  local, remote, localPurged = [], remotePurged = [], lastSync = 0, now = Date.now(),
  localName = '本机', remoteName = '另一台设备', newId = uuid,
}) {
  const L = new Map(local.map((c) => [c.uid, c]));
  const R = new Map(remote.map((c) => [c.uid, c]));
  const tomb = new Map();
  for (const t of [...localPurged, ...remotePurged]) tomb.set(t.uid, Math.max(tomb.get(t.uid) || 0, t.at || 0));

  const summary = { conflicts: [], renumbered: [], revived: [], purged: 0 };
  const final = new Map(); // uid -> card
  const side = new Map(); // uid -> 'local' | 'remote' | 'both': where the content came from
  const fresh = (c) => c.updatedAt > lastSync;

  for (const uid of new Set([...L.keys(), ...R.keys()])) {
    if (tomb.has(uid)) continue;
    const a = L.get(uid);
    const b = R.get(uid);
    if (!b) { final.set(uid, a); side.set(uid, 'local'); continue; }
    if (!a) { final.set(uid, b); side.set(uid, 'remote'); continue; }
    if (sameCard(a, b)) { final.set(uid, a); side.set(uid, 'both'); continue; }

    let win;
    let lose = null;
    if (fresh(a) && fresh(b)) {
      if (a.deleted !== b.deleted) {
        // edited on one device, moved to the trash on the other: the edit wins
        win = a.deleted ? b : a;
        summary.revived.push({ uid, title: win.title, zid: win.zid });
      } else {
        [win, lose] = newer(a, b) ? [a, b] : [b, a];
      }
    } else if (fresh(a)) win = a;
    else if (fresh(b)) win = b;
    else win = newer(a, b) ? a : b;
    final.set(uid, win);
    side.set(uid, win === a ? 'local' : 'remote');

    // both edited: the older version is kept as a fleeting note in the inbox
    if (lose && !win.deleted && !lose.deleted && !sameContent(win, lose)) {
      const from = lose === a ? localName : remoteName;
      const copy = {
        uid: newId(), kind: 'fleeting', zid: null,
        title: `【冲突副本】${lose.title || ''}`.trim(),
        body: lose.body || '',
        keywords: [...(lose.keywords || [])],
        meta: { conflictOf: uid, formerZid: lose.zid || null, from },
        createdAt: now, updatedAt: now, deleted: false,
      };
      final.set(copy.uid, copy);
      side.set(copy.uid, 'both');
      summary.conflicts.push({ uid, copyUid: copy.uid, title: win.title, zid: win.zid, from });
    }
  }

  renumberDuplicates(final, side, L, R, lastSync, now, summary);

  const out = { local: { put: [], purge: [] }, remote: { put: [], purge: [] }, summary };
  for (const c of final.values()) {
    if (!L.has(c.uid) || !sameCard(L.get(c.uid), c)) out.local.put.push(c);
    if (!R.has(c.uid) || !sameCard(R.get(c.uid), c)) out.remote.put.push(c);
  }
  const lp = new Set(localPurged.map((t) => t.uid));
  const rp = new Set(remotePurged.map((t) => t.uid));
  for (const [uid, at] of tomb) {
    if (!lp.has(uid)) out.local.purge.push({ uid, at });
    if (!rp.has(uid)) out.remote.purge.push({ uid, at });
    if (L.has(uid) || R.has(uid)) summary.purged++;
  }
  summary.added = {
    local: out.local.put.filter((c) => !L.has(c.uid)).length,
    remote: out.remote.put.filter((c) => !R.has(c.uid)).length,
  };
  summary.updated = {
    local: out.local.put.length - summary.added.local,
    remote: out.remote.put.length - summary.added.remote,
  };
  return out;
}

// Two devices may each have filed a new card under the same ID while apart. The card that
// both devices already knew keeps the ID (otherwise the older one); the other moves to the
// next free place by the "continue" rule, together with new cards in its branch, and links
// written on its device are updated.
function renumberDuplicates(final, side, L, R, lastSync, now, summary) {
  const shared = (c) => L.has(c.uid) && R.has(c.uid);
  for (let round = 0; round < 20; round++) {
    let moved = false;
    for (const kind of ['note', 'literature']) {
      const groups = new Map();
      for (const c of final.values()) {
        if (c.kind !== kind || !c.zid || c.deleted) continue;
        if (!groups.has(c.zid)) groups.set(c.zid, []);
        groups.get(c.zid).push(c);
      }
      for (const [zid, group] of groups) {
        if (group.length < 2) continue;
        group.sort((x, y) => (shared(y) - shared(x)) || (x.createdAt - y.createdAt) || (x.uid < y.uid ? -1 : 1));
        for (const c of group.slice(1)) {
          const origin = side.get(c.uid);
          const taken = new Set([...final.values()].filter((x) => x.kind === kind && x.zid && !x.deleted).map((x) => x.zid));
          const noteMap = new Map();
          const litMap = new Map();
          if (kind === 'note') {
            const to = Z.continueAfter(zid, taken);
            noteMap.set(zid, to);
            // new cards filed under it on the same device move with it
            for (const d of final.values()) {
              if (d.kind === 'note' && d.zid && !d.deleted && d.uid !== c.uid && Z.isAncestor(zid, d.zid)
                && !shared(d) && side.get(d.uid) === origin) {
                noteMap.set(d.zid, Z.remap(zid, to, d.zid));
              }
            }
          } else {
            let i = 2;
            while (taken.has(`${zid}-${i}`)) i++;
            litMap.set(zid, `${zid}-${i}`);
          }
          const map = kind === 'note' ? noteMap : litMap;
          for (const d of [...final.values()]) {
            const mine = d.uid === c.uid || (kind === 'note' && map.has(d.zid) && d.kind === 'note' && !shared(d) && side.get(d.uid) === origin);
            const writtenThere = side.get(d.uid) === origin && (d.updatedAt > lastSync || !shared(d));
            let next = d;
            if (mine) next = { ...next, zid: map.get(d.zid) };
            if (writtenThere && next.body?.includes('[[')) {
              const body = Z.rewriteLinks(next.body, kind === 'note' ? noteMap : null, kind === 'literature' ? litMap : null);
              if (body !== next.body) next = { ...next, body };
            }
            if (next !== d) {
              final.set(d.uid, { ...next, updatedAt: now });
              if (mine) summary.renumbered.push({ uid: d.uid, from: d.zid, to: next.zid, title: d.title, kind });
            }
          }
          moved = true;
          break; // recompute groups after each move
        }
        if (moved) break;
      }
      if (moved) break;
    }
    if (!moved) return;
  }
}
