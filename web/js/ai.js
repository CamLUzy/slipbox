// Local AI through Ollama. Nothing here runs on its own: the model is only loaded
// when one of these functions is called from an "AI" button, and Ollama unloads it
// again after `keepAlive` of inactivity (or immediately via unload()).
import * as backend from './backend.js';
import { lsGet, lsSet, uuid } from './util.js';
import * as Z from './luhmann.js';

export const cfg = {
  base: lsGet('zk.ai.base', 'http://127.0.0.1:11434'),
  model: lsGet('zk.ai.model', 'qwen3.5:4b'),
  keepAlive: lsGet('zk.ai.keep', '5m'),
};

export function setCfg(patch) {
  Object.assign(cfg, patch);
  lsSet('zk.ai.base', cfg.base);
  lsSet('zk.ai.model', cfg.model);
  lsSet('zk.ai.keep', cfg.keepAlive);
}

export class AIError extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.code = code;
  }
}

export function aiErrorText(e) {
  return {
    offline: backend.platform === 'ios'
      ? '连接不到 Ollama。请在“设置与数据 → AI”里填写电脑上 Ollama 的局域网地址。'
      : '连接不到 Ollama。请确认已安装并打开 Ollama。',
    no_model: `还没有下载模型 ${cfg.model}。`,
    aborted: '已停止',
    bad_json: 'AI 返回的格式不对，请再试一次。',
  }[e?.code] || `AI 出错：${e?.message || e}`;
}

// ---------- transport ----------

const streams = new Map();
window.zkStream = (id, line) => streams.get(id)?.(line);

// Returns { status, text }. With onLine, calls it for every line of a streamed response.
async function request(path, body, { onLine, signal } = {}) {
  if (backend.isNative) {
    const id = uuid();
    if (onLine) streams.set(id, onLine);
    const abort = () => backend.call('ollamaCancel', { id });
    signal?.addEventListener('abort', abort);
    try {
      const r = JSON.parse(await backend.call('ollama', {
        id, base: cfg.base, path, body: body === undefined ? null : JSON.stringify(body), stream: !!onLine,
      }));
      if (r.error) throw new AIError(r.cancelled ? 'aborted' : 'offline', r.error);
      return r;
    } finally {
      streams.delete(id);
      signal?.removeEventListener('abort', abort);
    }
  }
  let res;
  try {
    res = await fetch(cfg.base + path, {
      method: body === undefined ? 'GET' : 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    throw new AIError(e.name === 'AbortError' ? 'aborted' : 'offline', e.message);
  }
  if (!onLine) return { status: res.status, text: await res.text() };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) onLine(line);
      }
    }
  } catch (e) {
    throw new AIError(e.name === 'AbortError' ? 'aborted' : 'offline', e.message);
  }
  if (buf.trim()) onLine(buf);
  return { status: res.status, text: '' };
}

// ---------- model lifecycle ----------

// { running, installed, loaded, version } — does not load the model.
export async function status() {
  try {
    const tags = JSON.parse((await request('/api/tags')).text);
    const ps = JSON.parse((await request('/api/ps')).text);
    const names = (tags.models || []).map((m) => m.name);
    const same = (m) => [m.name, m.model].some((n) => n === cfg.model || n === cfg.model + ':latest');
    const loaded = (ps.models || []).find(same);
    return {
      running: true,
      installed: names.includes(cfg.model) || names.includes(cfg.model + ':latest'),
      loaded: !!loaded,
      expiresAt: loaded?.expires_at ? Date.parse(loaded.expires_at) : null,
      vram: loaded?.size_vram || loaded?.size || 0,
      models: names,
    };
  } catch {
    return { running: false, installed: false, loaded: false, expiresAt: null, vram: 0, models: [] };
  }
}

// Make sure Ollama is up (starting the app if needed) and the model is downloaded.
export async function ensureReady(onState = () => {}) {
  let st = await status();
  if (!st.running && backend.isNative) {
    onState('正在启动 Ollama…');
    await backend.call('startOllama').catch(() => {});
    for (let i = 0; i < 30 && !st.running; i++) {
      await new Promise((r) => setTimeout(r, 500));
      st = await status();
    }
  }
  if (!st.running) throw new AIError('offline');
  if (!st.installed) throw new AIError('no_model');
  if (!st.loaded) onState('正在加载模型（首次约几秒）…');
  return st;
}

export async function unload() {
  await request('/api/generate', { model: cfg.model, keep_alive: 0 });
}

export async function pull(onProgress, signal) {
  await request('/api/pull', { model: cfg.model, stream: true }, {
    signal,
    onLine(line) {
      try {
        const j = JSON.parse(line);
        if (j.error) throw new AIError('pull', j.error);
        onProgress(j.status, j.total ? j.completed / j.total : null);
      } catch (e) {
        if (e instanceof AIError) throw e;
      }
    },
  });
}

// Streamed chat. Returns the full reply text (and thinking, if enabled).
export async function chat(messages, { format, think = false, onToken, onThinking, signal, temperature = 0.4 } = {}) {
  let content = '';
  let thinking = '';
  let failure = null;
  const r = await request('/api/chat', {
    model: cfg.model,
    messages,
    stream: true,
    think,
    format,
    keep_alive: cfg.keepAlive,
    options: { num_ctx: 8192, temperature },
  }, {
    signal,
    onLine(line) {
      let j;
      try { j = JSON.parse(line); } catch { return; }
      if (j.error) failure = j.error;
      const t = j.message?.thinking;
      if (t) { thinking += t; onThinking?.(thinking); }
      const c = j.message?.content;
      if (c) { content += c; onToken?.(content); }
    },
  });
  if (failure || r.status === 404) {
    if (/not found/i.test(failure || '')) throw new AIError('no_model');
    throw new AIError('ollama', failure || `HTTP ${r.status}`);
  }
  return { content, thinking };
}

async function chatJson(messages, schema, opts) {
  const { content } = await chat(messages, { ...opts, format: schema, temperature: 0.2 });
  try {
    return JSON.parse(content);
  } catch {
    throw new AIError('bad_json', content.slice(0, 200));
  }
}

// ---------- prompts ----------

const SYSTEM = `你是用户的卢曼卡片盒（Zettelkasten）助手，用简体中文回答。
卡片盒规则：每张永久卡片只讲一个观点，用自己的话写，脱离上下文也能读懂；卡片有固定编号（如 1、1a、1a1），
数字与字母交替：“续写”接在某卡之后，“分支”从某卡岔出新的思路；卡片间用 [[编号]] 链接，文献用 [[@文献键]] 引用。`;

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
export const cardRef = (c) => (c.kind === 'literature' ? '@' + c.zid : c.zid || '闪念');
const brief = (c, n = 160) => `[${cardRef(c)}] ${c.title || ''}\n${clip((c.body || '').replace(/\s+/g, ' '), n)}`;

// Turn a note (usually a fleeting one) into a well-formed permanent card.
export async function organize(card, { candidates, keywords, signal, onToken }) {
  const schema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      body: { type: 'string' },
      keywords: { type: 'array', items: { type: 'string' } },
      position: {
        type: 'object',
        properties: { rel: { type: 'string', enum: ['top', 'continue', 'branch'] }, ref: { type: 'string' }, reason: { type: 'string' } },
        required: ['rel', 'ref', 'reason'],
      },
      links: { type: 'array', items: { type: 'object', properties: { zid: { type: 'string' }, reason: { type: 'string' } }, required: ['zid', 'reason'] } },
    },
    required: ['title', 'body', 'keywords', 'position', 'links'],
  };
  const prompt = `请把下面这条笔记整理成一张合格的永久卡片。
要求：
1. title：一句话写出这张卡片的核心观点（不是主题词）。
2. body：用清楚的中文重写正文，保留原意和原有的 [[链接]]，不要编造原文没有的事实，150 字以内为宜。
3. keywords：2 到 4 个关键词，优先复用已有关键词。
4. position：从候选卡片中选一个最合适的位置。rel 取 top（新主题，ref 留空）、continue（续写在 ref 之后）或 branch（从 ref 分支）；ref 必须是候选卡片的编号。
5. links：从候选卡片中挑出确实相关的（最多 4 个），说明理由；不相关就留空数组。

待整理的笔记：
${brief(card, 1500)}

已有关键词：${keywords.slice(0, 60).join('、') || '（无）'}

候选卡片：
${candidates.filter((c) => c.kind === 'note').map((c) => brief(c)).join('\n\n') || '（无）'}`;
  const r = await chatJson([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], schema, { signal, onToken });
  const valid = new Set(candidates.filter((c) => c.kind === 'note').map((c) => c.zid));
  const pos = r.position || {};
  if (pos.rel !== 'top' && !valid.has(pos.ref)) Object.assign(pos, { rel: 'top', ref: '' });
  return {
    title: String(r.title || '').trim(),
    body: String(r.body || '').trim(),
    keywords: [...new Set((r.keywords || []).map((k) => String(k).trim()).filter(Boolean))].slice(0, 5),
    position: pos,
    links: (r.links || []).filter((l) => valid.has(l.zid) && l.zid !== card.zid).slice(0, 4),
  };
}

export const RELATIONS = ['支持', '反驳', '举例', '延伸', '前提', '对比', '相似', '无关'];

// How a card relates to each candidate card. Candidates are numbered 0..n-1 because
// small models copy integers far more reliably than card IDs.
export async function relate(card, candidates, { signal, onToken } = {}) {
  const schema = {
    type: 'object',
    properties: {
      relations: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'integer' }, type: { type: 'string', enum: RELATIONS }, reason: { type: 'string' } },
          required: ['id', 'type', 'reason'],
        },
      },
      summary: { type: 'string' },
    },
    required: ['relations', 'summary'],
  };
  const prompt = `中心卡片：
${brief(card, 1200)}

候选卡片：
${candidates.map((c, i) => `候选 ${i}：${brief(c)}`).join('\n\n')}

请逐一判断每张候选卡片与中心卡片的关系，relations 里每张候选卡片一项，id 填候选的序号（0 到 ${candidates.length - 1}）。
type 只能是：${RELATIONS.join('、')}（含义：候选卡片对中心卡片是 支持/反驳/举例/延伸/前提/对比/相似，或无关）。
reason 用一句话说明具体联系在哪里。最后用 summary 两三句话概括中心卡片在这些卡片中的位置。`;
  const r = await chatJson([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], schema, { signal, onToken });
  const seen = new Set();
  return {
    summary: String(r.summary || ''),
    relations: (r.relations || [])
      .filter((x) => candidates[x.id] && !seen.has(x.id) && seen.add(x.id) && RELATIONS.includes(x.type) && x.type !== '无关')
      .map((x) => ({ card: candidates[x.id], type: x.type, reason: String(x.reason || '') })),
  };
}

// Label a batch of card pairs (for the whole-box map).
export async function relatePairs(pairs, { signal, onToken } = {}) {
  const schema = {
    type: 'object',
    properties: {
      pairs: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'integer' }, type: { type: 'string', enum: RELATIONS }, reason: { type: 'string' } },
          required: ['id', 'type', 'reason'],
        },
      },
    },
    required: ['pairs'],
  };
  const prompt = `下面每一组是两张卡片。判断 B 对 A 的关系，type 只能是：${RELATIONS.join('、')}；reason 用一句话说明，直接写两张卡片的内容，不要用“A”“B”指代。

${pairs.map(([a, b], i) => `第 ${i} 组\nA ${brief(a, 120)}\nB ${brief(b, 120)}`).join('\n\n')}`;
  const r = await chatJson([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], schema, { signal, onToken });
  return (r.pairs || []).filter((p) => pairs[p.id] && RELATIONS.includes(p.type) && p.type !== '无关');
}

// Name the clusters of the whole-box map.
export async function nameThemes(groups, { signal, onToken } = {}) {
  const schema = {
    type: 'object',
    properties: {
      themes: {
        type: 'array',
        items: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, summary: { type: 'string' } }, required: ['id', 'name', 'summary'] },
      },
    },
    required: ['themes'],
  };
  const prompt = `下面是卡片盒里自动分出的几组卡片。请为每一组起一个 2 到 8 个字的主题名，并用一句话概括这组卡片在讨论什么。

${groups.map((g, i) => `第 ${i} 组：\n${g.slice(0, 8).map((c) => `- ${cardRef(c)} ${c.title || clip(c.body || '', 40)}`).join('\n')}`).join('\n\n')}`;
  const r = await chatJson([{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }], schema, { signal, onToken });
  return r.themes || [];
}

// Chat over the slip box: the question plus the most relevant cards as context.
export function chatMessages(history, question, contextCards) {
  const ctx = contextCards.map((c) => `[[${cardRef(c)}]] ${c.title || ''}\n${clip((c.body || '').replace(/\s+/g, ' '), 600)}`).join('\n\n');
  const system = `${SYSTEM}
回答时优先依据下面提供的卡片。提到某张卡片时，必须原样写出它开头的 [[编号]]，例如“正如 [[2]] 所说”，这样用户可以点开原卡片；不要编造不存在的编号。
卡片里没有的内容可以补充你自己的看法，但要说明那是你的看法。回答简洁。

相关卡片：
${ctx || '（没有找到相关卡片）'}`;
  return [{ role: 'system', content: system }, ...history.slice(-8), { role: 'user', content: question }];
}

export const validRef = (ix, ref) => (ref?.startsWith('@') ? ix.byKey.has(ref.slice(1)) : Z.isValid(ref) && ix.byZid.has(ref));
