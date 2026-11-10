/**
 * dsh-memory 跨层派生链测试：记忆 → 画像 → AGENTS.md，源失效时反向标脏。
 *   node test/derivation.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemoryStore } from '../lib/store.js';
import { fingerprint, derivationId, evaluateEntries } from '../lib/derivation.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err && err.message}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-derivation-'));
const store = createMemoryStore({ dir: path.join(tmp, 'storage'), mirror: false });

console.log(`\ndsh-memory derivation tests  (tmp=${tmp})\n`);

/* 每个用例一个独立工作区目录（AGENTS.md 要真写盘）。 */
let seq = 0;
function makeWorkspace() {
  seq += 1;
  const dir = path.join(tmp, `ws-${seq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ---------------- 纯函数 ---------------- */

test('fingerprint：同内容同指纹，改一个字就变', () => {
  assert.equal(fingerprint('hello'), fingerprint('hello'));
  assert.notEqual(fingerprint('hello'), fingerprint('hello!'));
  assert.equal(fingerprint('hello').length, 16);
});

test('derivationId：同 layer+target 恒定，不同则不同', () => {
  assert.equal(derivationId('portrait', 'portrait'), derivationId('portrait', 'portrait'));
  assert.notEqual(derivationId('portrait', 'portrait'), derivationId('agents', 'portrait'));
});

test('evaluateEntries：上游脏，下游跟着脏（链式传递）', () => {
  const records = new Map();
  const entries = [
    { id: 'drv_parent', layer: 'portrait', target: 'portrait', parent: null, sources: [{ id: 'mem_gone', kind: 'memory', hash: '' }] },
    { id: 'drv_child', layer: 'agents', target: 'AGENTS.md#x', parent: 'drv_parent', sources: [] },
  ];
  const evaluated = evaluateEntries(entries, { records, portrait: null });
  assert.equal(evaluated[0].state, 'dirty');
  assert.equal(evaluated[1].state, 'dirty');
  assert.match(evaluated[1].reason, /上游失效/);
});

/* ---------------- 画像层派生 ---------------- */

test('画像：保存后派生链里有一条 portrait 条目，源是它引用的记忆', () => {
  const ws = makeWorkspace();
  const rec = store.upsert({ title: '发版前先跑测试', content: '这条是硬约定', category: 'convention' }, { workspace: ws });
  store.savePortrait(ws, {
    sections: [
      { key: 'background', text: '独立开发者' },
      { key: 'preference', text: '发版前先跑测试' },
      { key: 'focus', text: '记忆插件对齐' },
      { key: 'recent', text: '刚做完检索层' },
    ],
    evidence: { preference: [rec.record.id] },
  });
  const list = store.derivationList(ws);
  const portrait = list.find((e) => e.layer === 'portrait');
  assert.ok(portrait, '派生链里应有 portrait 层');
  assert.equal(portrait.state, 'fresh');
  assert.equal(portrait.sources.length, 1);
  assert.equal(portrait.sources[0].id, rec.record.id);
  assert.equal(portrait.sources[0].section, 'preference');
});

test('画像：源记忆被归档 → 画像派生标脏', () => {
  const ws = makeWorkspace();
  const rec = store.upsert({ title: '约定 A', content: '正文 A', category: 'convention' }, { workspace: ws });
  store.savePortrait(ws, {
    sections: [{ key: 'preference', text: '约定 A' }],
    evidence: { preference: [rec.record.id] },
  });
  assert.equal(store.derivationList(ws).find((e) => e.layer === 'portrait').state, 'fresh');

  store.update(rec.record.id, { archived: true }, { workspace: ws });

  const entry = store.derivationList(ws).find((e) => e.layer === 'portrait');
  assert.equal(entry.state, 'dirty');
  assert.match(entry.reason, /已归档/);
});

test('画像：源记忆正文被改 → 画像派生标脏', () => {
  const ws = makeWorkspace();
  const rec = store.upsert({ title: '约定 B', content: '正文 B', category: 'convention' }, { workspace: ws });
  store.savePortrait(ws, {
    sections: [{ key: 'preference', text: '约定 B' }],
    evidence: { preference: [rec.record.id] },
  });
  store.update(rec.record.id, { content: '正文 B（改了）' }, { workspace: ws });
  const entry = store.derivationList(ws).find((e) => e.layer === 'portrait');
  assert.equal(entry.state, 'dirty');
  assert.match(entry.reason, /内容已改/);
});

test('画像：源记忆被删 → 画像派生标脏', () => {
  const ws = makeWorkspace();
  const rec = store.upsert({ title: '约定 C', content: '正文 C', category: 'convention' }, { workspace: ws });
  store.savePortrait(ws, {
    sections: [{ key: 'preference', text: '约定 C' }],
    evidence: { preference: [rec.record.id] },
  });
  store.remove(rec.record.id, { workspace: ws });
  const entry = store.derivationList(ws).find((e) => e.layer === 'portrait');
  assert.equal(entry.state, 'dirty');
  assert.match(entry.reason, /已不存在/);
});

test('画像：journal: 引用不入链（它不是条目，删不掉也不该标脏）', () => {
  const ws = makeWorkspace();
  store.savePortrait(ws, {
    sections: [{ key: 'recent', text: '今天做了检索层' }],
    evidence: { recent: ['journal:2026-10-20'] },
  });
  const entry = store.derivationList(ws).find((e) => e.layer === 'portrait');
  assert.equal(entry.sources.length, 0);
  assert.equal(entry.state, 'fresh');
});

/* ---------------- 记忆 → AGENTS.md ---------------- */

test('AGENTS.md：晋升一条记忆后有派生条目，源记忆改写即标脏', () => {
  const ws = makeWorkspace();
  const rec = store.upsert({ title: '用 pnpm 不用 npm', content: '本仓库统一用 pnpm', category: 'convention' }, { workspace: ws });
  const promoted = store.promoteToAgents(ws, { id: rec.record.id });
  assert.equal(promoted.ok, true);
  const agentsFile = fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8');
  assert.match(agentsFile, /pnpm/);

  const entry = store.derivationList(ws).find((e) => e.layer === 'agents');
  assert.ok(entry, '派生链里应有 agents 层');
  assert.equal(entry.state, 'fresh');

  store.update(rec.record.id, { content: '本仓库统一用 npm' }, { workspace: ws });
  const dirty = store.derivationList(ws).find((e) => e.layer === 'agents');
  assert.equal(dirty.state, 'dirty');
  assert.match(dirty.reason, /内容已改/);
});

test('AGENTS.md：重复晋升幂等（派生条目不重复，文件不重复行）', () => {
  const ws = makeWorkspace();
  const rec = store.upsert({ title: '提交信息用中文', content: 'scope: 摘要', category: 'convention' }, { workspace: ws });
  store.promoteToAgents(ws, { id: rec.record.id });
  store.promoteToAgents(ws, { id: rec.record.id });
  const agents = store.derivationList(ws).filter((e) => e.layer === 'agents');
  assert.equal(agents.length, 1);
  const text = fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8');
  const hits = text.split('\n').filter((l) => l.includes('提交信息用中文'));
  assert.equal(hits.length, 1, '同一行只应出现一次');
});

test('AGENTS.md：托管块以 --> 收尾（文件无末尾换行）时不重复写正文', () => {
  const ws = makeWorkspace();
  /*
   * 触发条件：托管块是文件最后一行，且结束标记后没有换行符（手工编辑 / 其它工具写出的
   * 常见形态）。旧实现用 indexOf('\n', bodyStart) + 1 求块内起点，找不到换行时得到 0，
   * 于是把「整个文件」当成块内正文，写回去就是文件内容重复一遍 + 块重复一遍。
   */
  const START = '<!-- dsh-memory:promoted 开始（由 dsh-memory 维护，请勿手工编辑本块） -->';
  const END = '<!-- dsh-memory:promoted 结束 -->';
  fs.writeFileSync(path.join(ws, 'AGENTS.md'), `# AGENTS\n\n${START}${END}`, 'utf8');

  const rec = store.upsert({ title: '改动前先备份', content: '任何批量改写前先留快照', category: 'convention' }, { workspace: ws });
  assert.equal(store.promoteToAgents(ws, { id: rec.record.id }).ok, true);

  const text = fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8');
  assert.equal((text.match(/promoted 开始/g) || []).length, 1, '开始标记只应出现一次');
  assert.equal((text.match(/^# AGENTS$/gm) || []).length, 1, '块外正文不该被复制');
  assert.match(text, /改动前先备份/);
});

/* ---------------- 链：记忆 → 画像 → AGENTS.md ---------------- */

test('链：画像段被改写 → 从它派生的 AGENTS.md 标脏', () => {
  const ws = makeWorkspace();
  store.savePortrait(ws, {
    sections: [{ key: 'preference', text: '回答用中文' }],
    evidence: { preference: [] },
  });
  const promoted = store.promotePortraitToAgents(ws, { section: 'preference' });
  assert.equal(promoted.ok, true);
  const text = fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8');
  assert.match(text, /回答用中文/);

  const before = store.derivationList(ws).find((e) => e.layer === 'agents');
  assert.equal(before.state, 'fresh');

  store.savePortrait(ws, {
    sections: [{ key: 'preference', text: '回答用中文，但代码注释用英文' }],
    evidence: { preference: [] },
  });

  const after = store.derivationList(ws).find((e) => e.layer === 'agents');
  assert.equal(after.state, 'dirty');
  assert.match(after.reason, /段已改写/);
});

test('链：画像本身证据失效 → 从它派生的 AGENTS.md 跟着失效', () => {
  const ws = makeWorkspace();
  const rec = store.upsert({ title: '底层约定', content: '正文', category: 'convention' }, { workspace: ws });
  store.savePortrait(ws, {
    sections: [{ key: 'preference', text: '底层约定' }],
    evidence: { preference: [rec.record.id] },
  });
  store.promotePortraitToAgents(ws, { section: 'preference' });
  assert.equal(store.derivationList(ws).find((e) => e.layer === 'agents').state, 'fresh');

  store.update(rec.record.id, { archived: true }, { workspace: ws });

  const portrait = store.derivationList(ws).find((e) => e.layer === 'portrait');
  const agents = store.derivationList(ws).find((e) => e.layer === 'agents');
  assert.equal(portrait.state, 'dirty');
  assert.equal(agents.state, 'dirty');
  assert.match(agents.reason, /上游失效/);
});

/* ---------------- 体检 ---------------- */

test('老画像（这功能之前保存的）会被补派生条目，派生它的 AGENTS.md 不被误判', () => {
  const ws = makeWorkspace();
  /* 直接落一份 portrait.json，绕开 savePortrait——模拟「这功能之前保存的画像」。 */
  const info = store.portraitInfo(ws);
  fs.mkdirSync(path.dirname(info.file), { recursive: true });
  fs.writeFileSync(
    info.file,
    JSON.stringify({
      schemaVersion: 1,
      scope: 'workspace',
      version: 3,
      updatedAt: new Date().toISOString(),
      source: 'manual',
      sections: [{ key: 'preference', title: '协作约定', text: '老画像里的约定' }],
    }),
    'utf8',
  );
  store.promotePortraitToAgents(ws, { section: 'preference' });

  const list = store.derivationList(ws);
  assert.ok(
    list.some((e) => e.layer === 'portrait'),
    '老画像应被补一条 portrait 派生',
  );
  const agents = list.find((e) => e.layer === 'agents');
  assert.equal(agents.state, 'fresh', '老画像不该让下游被误判为失效');
});

test('体检：失效的派生条目会被列出来', () => {
  const ws = makeWorkspace();
  const rec = store.upsert({ title: '会被归档的约定', content: '正文', category: 'convention' }, { workspace: ws });
  store.savePortrait(ws, {
    sections: [{ key: 'preference', text: '会被归档的约定' }],
    evidence: { preference: [rec.record.id] },
  });
  let health = store.health({ workspace: ws });
  assert.equal(health.derivations.dirty, 0);

  store.update(rec.record.id, { archived: true }, { workspace: ws });
  health = store.health({ workspace: ws });
  assert.equal(health.derivations.dirty, 1);
  assert.equal(health.derivations.entries[0].layer, 'portrait');
  assert.equal(health.derivations.entries[0].sources[0], rec.record.id);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
