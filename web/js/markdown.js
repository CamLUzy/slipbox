// A small Markdown renderer covering what slip-box cards need, plus [[wiki links]].
// ctx.link(target, aliasHtml) returns the HTML for a [[link]].
import { esc } from './util.js';

const BLOCK_START = /^(```|#{1,6}\s|>|\s*([-*+]|\d+[.)])\s+|\s*([-*_])(\s*\3){2,}\s*$)/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

export function renderMarkdown(src, ctx) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if ((m = line.match(/^```(.*)$/))) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      html += `<pre><code>${esc(buf.join('\n'))}</code></pre>`;
    } else if (!line.trim()) {
      i++;
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      const n = Math.min(m[1].length + 1, 6); // the card title is the h1
      html += `<h${n}>${inline(m[2], ctx)}</h${n}>`;
      i++;
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      html += '<hr>';
      i++;
    } else if (/^>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      html += `<blockquote>${renderMarkdown(buf.join('\n'), ctx)}</blockquote>`;
    } else if (LIST_RE.test(line)) {
      const items = [];
      while (i < lines.length) {
        const lm = lines[i].match(LIST_RE);
        if (lm) items.push({ indent: lm[1].replace(/\t/g, '    ').length, ordered: /\d/.test(lm[2]), text: lm[3], kids: [] });
        else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) items[items.length - 1].text += '\n' + lines[i].trim();
        else break;
        i++;
      }
      html += renderList(nest(items), ctx);
    } else {
      const buf = [];
      while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i])) buf.push(lines[i++]);
      if (!buf.length) buf.push(lines[i++]);
      html += `<p>${buf.map((l) => inline(l, ctx)).join('<br>')}</p>`;
    }
  }
  return html;
}

function nest(items) {
  const root = { indent: -1, kids: [] };
  const stack = [root];
  for (const it of items) {
    while (stack.length > 1 && it.indent <= stack[stack.length - 1].indent) stack.pop();
    stack[stack.length - 1].kids.push(it);
    stack.push(it);
  }
  return root.kids;
}

function renderList(items, ctx) {
  if (!items.length) return '';
  const tag = items[0].ordered ? 'ol' : 'ul';
  const lis = items.map((it) => {
    let text = it.text;
    let box = '';
    const t = text.match(/^\[([ xX])\]\s+(.*)$/s);
    if (t) {
      box = `<input type="checkbox" disabled${t[1] === ' ' ? '' : ' checked'}> `;
      text = t[2];
    }
    const body = text.split('\n').map((l) => inline(l, ctx)).join('<br>');
    return `<li${box ? ' class="task"' : ''}>${box}${body}${renderList(it.kids, ctx)}</li>`;
  });
  return `<${tag}>${lis.join('')}</${tag}>`;
}

const safeUrl = (u) => (/^(https?:|mailto:|\/|#|\.)/i.test(u) ? u : '#');

export function inline(text, ctx) {
  const tokens = [];
  const hold = (html) => `\u0001${tokens.push(html) - 1}\u0001`;
  let s = String(text);
  s = s.replace(/`([^`]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`));
  s = s.replace(/\[\[([^[\]|\n]+?)(?:\|([^[\]\n]*))?\]\]/g, (_, t, alias) =>
    hold(ctx?.link ? ctx.link(t.trim(), alias === undefined ? null : esc(alias)) : esc(alias ?? t)));
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) =>
    hold(`<img src="${esc(safeUrl(url))}" alt="${esc(alt)}" loading="lazy">`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) =>
    hold(`<a href="${esc(safeUrl(url))}" target="_blank" rel="noopener">${esc(label)}</a>`));
  s = s.replace(/\bhttps?:\/\/[^\s<>()　-〿＀-￯]+/g, (url) =>
    hold(`<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`));
  s = esc(s);
  s = s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/==(.+?)==/g, '<mark>$1</mark>');
  return s.replace(/\u0001(\d+)\u0001/g, (_, n) => tokens[n]);
}
