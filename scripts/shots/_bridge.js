// A stand-in for the native shell (the Windows app's `zk` command), injected before the page
// loads, so the 设备与同步 page can be shot without two devices. DATA (the demo box) is prepended.
// This Mac has the demo box with one edit; "lu 的 iPhone" has two new notes and another edit.
(() => {
  const now = Date.now();
  const day = 86400e3;
  const BOX = '卡片盒方法';
  const copy = (list) => list.map((c) => ({ ...c, keywords: [...(c.keywords || [])], meta: { ...(c.meta || {}) } }));
  const local = copy(DATA.cards);
  const remote = copy(DATA.cards);
  const byZid = (list, z) => list.find((c) => c.zid === z);
  Object.assign(byZid(local, '3'), { body: byZid(local, '3').body + '\n\n在 Mac 上补了一句：链接旁边写一句理由。', updatedAt: now - 600e3 });
  Object.assign(byZid(remote, '3'), { body: byZid(remote, '3').body + '\n\n在手机上补了一句。', updatedAt: now - 1200e3 });
  Object.assign(byZid(remote, '2'), { body: byZid(remote, '2').body + '\n\n（地铁上补充：一张卡片要能脱离上下文读懂。）', updatedAt: now - 1800e3 });
  const note = (uid, body, ago) => ({ uid, kind: 'fleeting', zid: null, title: '', body, keywords: [], meta: {}, createdAt: now - ago, updatedAt: now - ago, deleted: false });
  remote.push(note('ip-1', '读《卡片笔记写作法》第 4 章：索引只记入口，不记全部。', 3 * 3600e3));
  remote.push(note('ip-2', '散步时想到：随机漫步也是一种提问。', 2 * 3600e3));

  const device = { id: 'mac', name: 'lu 的 MacBook Air', platform: 'mac' };
  const iphone = { id: 'ip', name: 'lu 的 iPhone', platform: 'ios' };
  const state = {
    device, listening: true, port: 51515, addresses: ['192.168.1.20'], problem: '',
    paired: [{ ...iphone }],
    nearby: [{ ...iphone, paired: true }, { id: 'pc', name: 'DESKTOP-书房', platform: 'windows', paired: false }],
  };
  const upsert = (list, cards) => {
    for (const c of cards) {
      const i = list.findIndex((x) => x.uid === c.uid);
      if (i >= 0) list[i] = c; else list.push(c);
    }
  };
  const op = (list, me, m) => {
    if (m.op === 'hello') return { ok: true, device: me, boxes: [{ name: BOX, boxId: 'box-1', cards: list.length }] };
    if (m.op === 'read') return { ok: true, boxId: 'box-1', lastSync: now - day, purged: [], cards: copy(list) };
    if (m.op === 'write') {
      upsert(list, m.cards || []);
      if (list === local && (m.cards || []).length) setTimeout(() => window.zkSyncEvent?.({ type: 'changed', box: BOX }), 0);
      return { ok: true };
    }
    return { ok: false, error: 'unknown op' };
  };
  const json = JSON.stringify;
  const handle = (msg) => {
    switch (msg.cmd) {
      case 'load': return json(local);
      case 'put': upsert(local, JSON.parse(msg.cards)); return true;
      case 'boxes': return json({ current: BOX, boxes: [{ name: BOX, cards: -1 }] });
      case 'info': return json({ dataPath: `~/Library/Application Support/卡片盒/boxes/${BOX}.db`, backups: [], native: true, box: BOX });
      case 'ollama': return json({ error: 'offline' });
      case 'startOllama': return false;
      case 'sync':
        switch (msg.op) {
          case 'state': case 'start': return json(state);
          case 'connect': return json({ session: 's1', code: '482913', peer: iphone, paired: true });
          case 'request': return json(op(remote, iphone, JSON.parse(msg.msg)));
          case 'local': return json(op(local, device, JSON.parse(msg.msg)));
          default: return json({ ok: true });
        }
      default: return true;
    }
  };
  window.__TAURI__ = { core: { invoke: async (_cmd, { msg }) => handle(msg) } };
})();
