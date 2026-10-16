// Checks the two reports of scripts/sync-selftest.sh.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const read = (f) => {
  const t = readFileSync(f, 'utf8');
  if (t.startsWith('SELFTEST ERROR')) throw new Error(`${f}: ${t}`);
  return JSON.parse(t);
};
const client = read(process.argv[2]);
const host = read(process.argv[3]);

assert.equal(client.firstPaired, false);
assert.equal(client.code, true);
assert.equal(client.peer, '主机');
assert.deepEqual(client.plan1, ['merge:我的卡片盒', 'toLocal:只在主机上']);
assert.ok(client.boxes.includes('只在主机上'), 'box copied from the host');
// both created a card 1: the later one moves to 2 (with its branch 1a, if it was the host's)
assert.ok(client.sync1.find((s) => s.box === '我的卡片盒').renumbered.includes('1->2'));
assert.equal(client.secondPaired, true);
assert.deepEqual(client.plan2, ['sync:只在主机上', 'sync:我的卡片盒']);
assert.equal(client.h3, '客户端改过的闪念', 'the newer edit wins');
assert.deepEqual(client.conflictCopy, ['主机改过的闪念'], 'the older edit is kept as a conflict copy');
assert.equal(client.sync2.find((s) => s.box === '我的卡片盒').conflicts, 1, 'only h-3 was edited on both sides');
assert.equal(client.h2gone, true);
assert.deepEqual(client.paired, ['主机']);

assert.ok(host.syncs >= 2, 'two syncs reached the host');
assert.deepEqual(host.paired, ['客户端']);
const t = (title) => host.cards.find((c) => c.title === title);
assert.ok(!t('主机上的 1a'), 'purged on the client, gone on the host');
assert.equal(t('客户端的 1').body, '客户端第二次写的');
assert.equal(t('主机的闪念').body, '客户端改过的闪念');
assert.ok(host.cards.some((c) => c.title.startsWith('【冲突副本】') && c.body === '主机改过的闪念'));
assert.ok(!/\[\[1a\]\]/.test(host.cards.find((c) => c.title === '主机上的 1').body) || t('主机上的 1').zid === '1', 'links follow a moved card');
const zids = host.cards.filter((c) => c.kind === 'note' && !c.deleted).map((c) => c.zid);
assert.equal(new Set(zids).size, zids.length, 'unique IDs on the host');
console.log(`sync self-test ok (${client.platform} -> ${host.platform})`);
