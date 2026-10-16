// Luhmann-style Folgezettel identifiers, shared by the server and the browser client.
//
// An ID alternates number and letter segments and always starts with a number:
//   1, 1a, 1a1, 1a2, 1b, 2, 21b3c ...
// Letters count bijectively in base 26 (a..z, aa, ab, ...), so a card can have
// unlimited branches. Sorting IDs segment by segment gives the depth-first order
// in which the cards would sit in a physical slip box.

const ID_RE = /^[1-9]\d*(?:[a-z]+[1-9]\d*)*[a-z]*$/;
const SEG_RE = /\d+|[a-z]+/g;

export function isValid(zid) {
  return typeof zid === 'string' && zid.length <= 64 && ID_RE.test(zid);
}

export function parse(zid) {
  return zid.match(SEG_RE) || [];
}

const isNum = (seg) => seg.charCodeAt(0) < 97;

function lettersToNum(s) {
  let n = 0;
  for (const c of s) n = n * 26 + (c.charCodeAt(0) - 96);
  return n;
}

function numToLetters(n) {
  let s = '';
  while (n > 0) {
    n--;
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

const segValue = (seg) => (isNum(seg) ? Number(seg) : lettersToNum(seg));

export function compare(a, b) {
  const A = parse(a);
  const B = parse(b);
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const d = segValue(A[i]) - segValue(B[i]);
    if (d) return d < 0 ? -1 : 1;
  }
  return A.length - B.length;
}

export function parent(zid) {
  const s = parse(zid);
  return s.length > 1 ? s.slice(0, -1).join('') : null;
}

export function depth(zid) {
  return parse(zid).length;
}

export function ancestors(zid) {
  const s = parse(zid);
  const out = [];
  for (let i = 1; i < s.length; i++) out.push(s.slice(0, i).join(''));
  return out;
}

// True when `a` is a proper ancestor of `b` (1a is an ancestor of 1a2, but 1a1 is not of 1a10).
export function isAncestor(a, b) {
  const A = parse(a);
  const B = parse(b);
  if (A.length >= B.length) return false;
  return A.every((s, i) => s === B[i]);
}

function incSeg(seg) {
  return isNum(seg) ? String(Number(seg) + 1) : numToLetters(lettersToNum(seg) + 1);
}

export function nextSibling(zid) {
  const s = parse(zid);
  s[s.length - 1] = incSeg(s[s.length - 1]);
  return s.join('');
}

export function firstChild(zid) {
  const s = parse(zid);
  return zid + (isNum(s[s.length - 1]) ? 'a' : '1');
}

// The next free child of `zid`, placed after its existing children.
export function nextChild(zid, existing) {
  let last = null;
  for (const z of existing) {
    if (parent(z) === zid && (!last || compare(z, last) > 0)) last = z;
  }
  let c = last ? nextSibling(last) : firstChild(zid);
  while (existing.has(c)) c = nextSibling(c);
  return c;
}

export function nextTop(existing) {
  let max = 0;
  for (const z of existing) {
    const top = Number(parse(z)[0]);
    if (top > max) max = top;
  }
  let c = String(max + 1);
  while (existing.has(c)) c = nextSibling(c);
  return c;
}

// Luhmann's insertion rule: continue a train of thought right after `zid`;
// if the next position is already taken, branch off instead.
export function continueAfter(zid, existing) {
  const n = nextSibling(zid);
  return existing.has(n) ? nextChild(zid, existing) : n;
}

// rel: 'top' | 'continue' | 'branch'
export function suggest(rel, ref, existing) {
  if (rel === 'continue' && isValid(ref)) return continueAfter(ref, existing);
  if (rel === 'branch' && isValid(ref)) return nextChild(ref, existing);
  return nextTop(existing);
}

// Map `zid` from the subtree rooted at oldRoot into the subtree rooted at newRoot.
// Segment values are kept; their type (number/letter) is re-encoded to keep the
// alternation valid, e.g. moving 3 -> 1a turns 3a2 into 1a1b.
export function remap(oldRoot, newRoot, zid) {
  if (zid !== oldRoot && !isAncestor(oldRoot, zid)) return zid;
  const rest = parse(zid).slice(parse(oldRoot).length);
  const rootSegs = parse(newRoot);
  let num = !isNum(rootSegs[rootSegs.length - 1]);
  let out = newRoot;
  for (const seg of rest) {
    const v = segValue(seg);
    out += num ? String(v) : numToLetters(v);
    num = !num;
  }
  return out;
}

// [[1a2]], [[1a2|alias]], [[@citekey]]
export const LINK_RE = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]*))?\]\]/g;

export function extractLinks(body) {
  const notes = new Set();
  const lits = new Set();
  for (const m of String(body || '').matchAll(LINK_RE)) {
    const t = m[1].trim();
    if (t.startsWith('@')) lits.add(t.slice(1));
    else notes.add(t);
  }
  return { notes, lits };
}

export function rewriteLinks(body, noteMap, litMap) {
  return String(body || '').replace(LINK_RE, (whole, target, alias) => {
    const t = target.trim();
    let to;
    if (t.startsWith('@')) to = litMap?.get(t.slice(1)) && '@' + litMap.get(t.slice(1));
    else to = noteMap?.get(t);
    if (!to) return whole;
    return alias === undefined ? `[[${to}]]` : `[[${to}|${alias}]]`;
  });
}
