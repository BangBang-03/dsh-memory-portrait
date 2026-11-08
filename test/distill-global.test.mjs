/**
 * dsh-memory 全局原则晋升判定测试：脱离 DSH 直接跑。
 *   node test/distill-global.test.mjs
 *
 * 这一套只测纯判定逻辑（准入 → 聚类 → 分层门槛），不碰模型与磁盘。
 * 夹具取自 docs/global-distill-trial-2026-11-05.md 的真实试跑产物。
 */

import assert from 'node:assert/strict';

const mod = await import('../lib/distill-global.js');
const { PROMOTION_RULES, DISTILLABLE_CATEGORIES, candidateRejection, evaluateCluster, clusterCandidates, promotionReport } = mod;

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

/* ---------------- 准入：项目载体与套话 ---------------- */

test('准入：带路径 / 文件名 / 版本号 / 包名 / 命令的原则一律拒绝', () => {
  assert.equal(candidateRejection('改动前先备份 C:\\Users\\me\\project 下的数据'), 'carries-path');
  assert.equal(candidateRejection('发布前先改 package.json 里的版本号'), 'carries-filename');
  assert.equal(candidateRejection('正式版必须对齐 v0.6.9 这个标签'), 'carries-version');
  assert.equal(candidateRejection('安装时用 @bangbang-03/dsh-memory 这个包名'), 'carries-package');
  assert.equal(candidateRejection('每次提交前都跑 npm publish 检查一遍'), 'carries-command');
});

test('准入：正确的废话被挡掉，有约束力的不挡', () => {
  assert.equal(candidateRejection('写测试很重要'), 'cliche');
  assert.equal(candidateRejection('注意安全，别泄露凭据'), 'cliche');
  assert.equal(candidateRejection('保持代码整洁清晰'), 'cliche');
  assert.equal(candidateRejection('改动必须验证再提交，不接受「应该没问题」'), null);
  assert.equal(candidateRejection('不可逆操作前先做可回滚的快照'), null);
});

test('准入：长度不达标的拒绝', () => {
  assert.equal(candidateRejection('要备份'), 'too-short');
  assert.equal(candidateRejection('长'.repeat(241)), 'too-long');
});

/* ---------------- 分层门槛 ---------------- */

test('门槛：用户亲口说的三类单项目即可晋升', () => {
  for (const category of ['constraint', 'feedback', 'preference']) {
    assert.equal(PROMOTION_RULES[category].projects, 0, `${category} 不该要求跨项目`);
  }
  assert.deepEqual(
    evaluateCluster({ category: 'constraint', projects: ['a'], anchors: 0 }),
    { promote: true, reason: 'ok' },
  );
  assert.equal(evaluateCluster({ category: 'feedback', projects: ['a'], anchors: 2 }).promote, true);
});

test('门槛：feedback 至少要一个锚点，preference 要两个', () => {
  const noAnchor = evaluateCluster({ category: 'feedback', projects: ['a'], anchors: 0 });
  assert.equal(noAnchor.promote, false);
  assert.equal(noAnchor.reason, 'need-more-anchors');

  const oneAnchor = evaluateCluster({ category: 'preference', projects: ['a'], anchors: 1 });
  assert.equal(oneAnchor.promote, false);
  assert.equal(oneAnchor.missing, 1);
});

test('门槛：推断出来的两类要第二个项目交叉验证', () => {
  const single = evaluateCluster({ category: 'decision', projects: ['a'], anchors: 5 });
  assert.equal(single.promote, false, '单项目锚点再多也不够——decision 需要外部验证');
  assert.equal(single.reason, 'need-more-projects');
  assert.equal(single.missing, 1);

  assert.equal(evaluateCluster({ category: 'decision', projects: ['a', 'b'], anchors: 2 }).promote, true);
  assert.equal(evaluateCluster({ category: 'convention', projects: ['a', 'b'], anchors: 3 }).promote, true);
  assert.equal(evaluateCluster({ category: 'convention', projects: ['a', 'b'], anchors: 2 }).promote, false);
});

test('门槛：同一项目报多次只算一个项目', () => {
  const repeated = evaluateCluster({ category: 'decision', projects: ['a', 'a', 'a'], anchors: 9 });
  assert.equal(repeated.promote, false, '同一项目重复上报不能冒充跨项目共振');
});

test('门槛：不可蒸馏的类别直接拒绝', () => {
  for (const category of ['fact', 'note', 'component', 'task']) {
    assert.equal(evaluateCluster({ category, projects: ['a', 'b', 'c'], anchors: 9 }).promote, false);
  }
  assert.deepEqual(DISTILLABLE_CATEGORIES.slice().sort(), ['constraint', 'convention', 'decision', 'feedback', 'preference']);
});

/* ---------------- 聚类 ---------------- */

test('聚类：同类别且相似才合并，跨类别不合并', () => {
  const clusters = clusterCandidates([
    { text: '不可逆操作前必须先做可回滚的快照', category: 'decision', project: 'a', anchors: ['m1', 'm2'] },
    { text: '不可逆操作之前，先留一份可回滚快照', category: 'decision', project: 'b', anchors: ['m3'] },
    { text: '不可逆操作前必须先做可回滚的快照', category: 'preference', project: 'a', anchors: ['m4'] },
  ]);
  assert.equal(clusters.length, 2, '同文本不同类别应分成两簇');
  const decision = clusters.find((c) => c.category === 'decision');
  assert.deepEqual(decision.projects.sort(), ['a', 'b']);
  assert.equal(decision.anchors, 3, '锚点跨成员去重后应为 3');
});

test('聚类：带项目载体的候选在成簇前就被剔除，不污染项目计数', () => {
  const clusters = clusterCandidates([
    { text: '改动前必须先做一份可回滚的快照', category: 'feedback', project: 'a', anchors: ['m1'] },
    { text: '改动前必须先做一份可回滚的快照，路径在 C:\\work\\x 下', category: 'feedback', project: 'b', anchors: ['m2'] },
  ]);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].projects, ['a'], '带载体那条不该把 b 带进项目计数');
});

test('聚类：主题词优先于文本相似度（长句也能合并）', () => {
  const clusters = clusterCandidates([
    {
      text: '改动真实数据前先留一份可回滚的快照，合并归档删除不能由系统自动决定',
      category: 'decision',
      project: 'a',
      anchors: ['m1'],
      topics: ['backup', 'irreversible'],
    },
    {
      text: '不可逆的批量操作之前必须先留可回滚快照，不要自动裁决',
      category: 'decision',
      project: 'b',
      anchors: ['m2'],
      topics: ['backup'],
    },
  ]);
  assert.equal(clusters.length, 1, '两句全文相似度只有 0.20，靠主题词才认得出来');
  assert.deepEqual(clusters[0].projects.sort(), ['a', 'b']);
});

test('聚类：主题词不同就不合并，哪怕文本很像', () => {
  const clusters = clusterCandidates([
    { text: '改动前必须先留一份可回滚的快照再动手', category: 'decision', project: 'a', anchors: ['m1'], topics: ['backup'] },
    { text: '改动前必须先留一份可回滚的快照再动手', category: 'decision', project: 'b', anchors: ['m2'], topics: ['privacy'] },
  ]);
  assert.equal(clusters.length, 2);
});

test('聚类：没有主题词时回落到文本相似度', () => {
  const clusters = clusterCandidates([
    { text: '不可逆操作前必须先做可回滚的快照', category: 'decision', project: 'a', anchors: ['m1'] },
    { text: '不可逆操作之前，先留一份可回滚快照', category: 'decision', project: 'b', anchors: ['m2'] },
  ]);
  assert.equal(clusters.length, 1, '相似度 0.44 应越过 0.40 阈值');
});

/* ---------------- 端到端：试跑产物 ---------------- */

const TRIAL = [
  {
    text: '任何对外声明都必须有实测依据，没测过的写 unknown，不靠推断补齐',
    category: 'feedback',
    project: 'proj-a',
    anchors: ['m1', 'm2', 'm3'],
    topics: ['verification', 'evidence'],
  },
  {
    text: '文档、截图、演示一律使用构造数据并标注来源，真实用户数据只在本地出现',
    category: 'feedback',
    project: 'proj-a',
    anchors: ['m4', 'm5'],
    topics: ['privacy', 'sample-data'],
  },
  {
    text: '改动真实数据前先留一份可回滚的快照，合并归档删除不能由系统自动决定',
    category: 'decision',
    project: 'proj-a',
    anchors: ['m6', 'm7', 'm8'],
    topics: ['backup', 'irreversible'],
  },
  {
    text: '自动整理与自动重写一律在轮次之外跑，失败要冷却，不阻塞当前对话',
    category: 'decision',
    project: 'proj-a',
    anchors: ['m9', 'm10'],
    topics: ['background-task', 'non-blocking'],
  },
];

test('端到端：试跑的四条产物，两条 feedback 立即晋升，两条 decision 等第二个项目', () => {
  const report = promotionReport(TRIAL);
  const promoted = report.filter((item) => item.verdict.promote);
  assert.equal(promoted.length, 2, `只有 feedback 两条该晋升，实际晋升 ${promoted.length}`);
  assert.ok(promoted.every((item) => item.category === 'feedback'));

  const blocked = report.filter((item) => !item.verdict.promote);
  assert.equal(blocked.length, 2);
  assert.ok(blocked.every((item) => item.verdict.reason === 'need-more-projects'));
});

test('端到端：第二个项目出现同主题后，decision 也能晋升', () => {
  const report = promotionReport([
    ...TRIAL,
    {
      text: '不可逆的批量操作之前必须先留可回滚快照，不要自动裁决',
      category: 'decision',
      project: 'proj-b',
      anchors: ['n1', 'n2'],
      topics: ['backup'],
    },
  ]);
  const promoted = report.filter((item) => item.verdict.promote);
  assert.equal(promoted.length, 3, '三个项目里那个 decision 簇应达标');
  assert.ok(promoted.some((item) => item.category === 'decision'));
});

/* ---------------- 素材覆盖：决定「还要不要提炼」 ---------------- */

const { uncoveredMaterials } = mod;

test('素材覆盖：没有候选时，全部素材都算未提炼', () => {
  const materials = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }];
  assert.equal(uncoveredMaterials(materials, [], 'ws-a').length, 3);
});

test('素材覆盖：被候选 anchors 引用过的就不再算新素材', () => {
  const materials = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }, { id: 'm4' }];
  const candidates = [{ project: 'ws-a', anchors: ['m1', 'm2'], text: 'x' }];
  const fresh = uncoveredMaterials(materials, candidates, 'ws-a');
  assert.deepEqual(fresh.map((m) => m.id), ['m3', 'm4']);
});

test('素材覆盖：别的项目的候选不算覆盖（各项目独立提炼）', () => {
  const materials = [{ id: 'm1' }, { id: 'm2' }];
  const candidates = [{ project: 'ws-b', anchors: ['m1'], text: 'x' }];
  assert.equal(uncoveredMaterials(materials, candidates, 'ws-a').length, 2);
});

/* ---------------- 模型输出解析 ---------------- */

const { GLOBAL_DISTILL_SYSTEM, parseGlobalDistill } = mod;

test('解析：正常 JSON 数组解析出候选，category 与 topics 保留', () => {
  const reply = JSON.stringify([
    { text: '对外素材一律使用构造数据并标注来源', category: 'feedback', topics: ['privacy'], anchors: ['m1', 'm2'] },
    { text: '后台任务不阻塞主流程，失败要冷却', category: 'decision', topics: ['non-blocking'], anchors: ['m3', 'm4'] },
  ]);
  const items = parseGlobalDistill(reply);
  assert.equal(items.length, 2);
  assert.equal(items[0].category, 'feedback');
  assert.deepEqual(items[0].topics, ['privacy']);
  assert.deepEqual(items[0].anchors, ['m1', 'm2']);
});

test('解析：剥掉 ```json 围栏与前后废话', () => {
  const reply = [
    '以下是结果：',
    '```json',
    JSON.stringify([{ text: '改动必须验证再提交，不接受应该没问题', category: 'feedback', topics: ['verification'], anchors: ['m1'] }]),
    '```',
    '希望有帮助。',
  ].join('\n');
  assert.equal(parseGlobalDistill(reply).length, 1);
});

test('解析：脏候选被逐条挡掉（载体 / topics 空 / 锚点空）', () => {
  const reply = JSON.stringify([
    { text: '发布前跑 node test/run-all.mjs 检查', category: 'convention', topics: ['release'], anchors: ['m1'] },
    { text: '这是一个没有主题词的原则示例文本', category: 'convention', topics: [], anchors: ['m2'] },
    { text: '这是一个没有锚点的原则示例文本', category: 'convention', topics: ['x'], anchors: [] },
    { text: '改动必须验证再提交，不接受应该没问题', category: 'feedback', topics: ['verification'], anchors: ['m4'] },
  ]);
  const items = parseGlobalDistill(reply);
  assert.equal(items.length, 1, '只有最后一条是干净的');
  assert.deepEqual(items[0].topics, ['verification']);
});

test('解析：非法 category 回落 convention，超量截断到 3 条', () => {
  const reply = JSON.stringify(
    Array.from({ length: 5 }, (_, i) => ({
      text: `第${i}条原则示例，内容足够长可以过长度检查`,
      category: 'nonsense',
      topics: [`topic${i}`],
      anchors: ['m1', 'm2'],
    })),
  );
  const items = parseGlobalDistill(reply);
  assert.equal(items.length, 3, '默认最多 3 条');
  assert.ok(items.every((item) => item.category === 'convention'));
});

test('解析：坏 JSON 返回空数组，不抛错', () => {
  assert.deepEqual(parseGlobalDistill('模型今天不想干活'), []);
  assert.deepEqual(parseGlobalDistill('[{"text":'), []);
  assert.deepEqual(parseGlobalDistill(''), []);
});

test('提示词：包含三类禁止与 topics 约束', () => {
  assert.match(GLOBAL_DISTILL_SYSTEM, /项目载体/);
  assert.match(GLOBAL_DISTILL_SYSTEM, /锚点/);
  assert.match(GLOBAL_DISTILL_SYSTEM, /constraint \/ feedback：至少 1 个锚点/, 'feedback/constraint 单锚即可');
  assert.match(GLOBAL_DISTILL_SYSTEM, /preference \/ decision：至少 2 个锚点/);
  assert.match(GLOBAL_DISTILL_SYSTEM, /常识套话/);
  assert.match(GLOBAL_DISTILL_SYSTEM, /topics/);
  assert.match(GLOBAL_DISTILL_SYSTEM, /0–3 条/);
});

/* ---------------- 诊断：为什么没产出 ---------------- */

const { analyzeGlobalDistill, ANCHOR_MINIMUMS } = mod;

test('诊断：模型回 [] 归成 empty，能看出是「模型觉得没有」', () => {
  const { items, stats } = analyzeGlobalDistill('[]');
  assert.equal(items.length, 0);
  assert.equal(stats.format, 'array');
  assert.equal(stats.parsed, 0);
  assert.equal(stats.accepted, 0);
  assert.deepEqual(stats.rejected, {});
});

test('诊断：坏 JSON / 纯文本 / 非数组分别归类，不再都是 no_candidate', () => {
  assert.equal(analyzeGlobalDistill('模型今天不想干活').stats.format, 'none');
  assert.equal(analyzeGlobalDistill('[{"text":').stats.format, 'bad_json');
  /* 取第一个 [ 到最后一个 ] 的切片本来就能把 {"principles":[...]} 的内层数组捞出来。 */
  const object = analyzeGlobalDistill(JSON.stringify({ principles: [] })).stats;
  assert.equal(object.format, 'array', '对象包一层数组也要认');
  assert.equal(object.parsed, 0);
  const badObject = analyzeGlobalDistill(JSON.stringify({ note: 'no array' })).stats;
  assert.equal(badObject.format, 'not_array');
});

test('诊断：拒绝原因按条计数，能区分载体 / 缺主题 / 锚点不够', () => {
  const reply = JSON.stringify([
    { text: '发布前跑 node test/run-all.mjs 检查', category: 'feedback', topics: ['release'], anchors: ['m1'] },
    { text: '这是一条没有主题词的原则', category: 'feedback', topics: [], anchors: ['m2'] },
    { text: '这是一条 preference 但只有一个锚点', category: 'preference', topics: ['pref'], anchors: ['m3'] },
    { text: '这条 feedback 只有一个锚点也应该保留', category: 'feedback', topics: ['fb'], anchors: ['m4'] },
  ]);
  const { items, stats } = analyzeGlobalDistill(reply);
  assert.equal(stats.parsed, 4);
  assert.equal(stats.accepted, 1);
  assert.equal(items[0].category, 'feedback');
  assert.equal(
    (stats.rejected['carries-command'] || 0) + (stats.rejected['carries-filename'] || 0),
    1,
    '项目载体要单独计数',
  );
  assert.equal(stats.rejected['no-topics'], 1);
  assert.equal(stats.rejected['few-anchors'], 1);
});

test('诊断：锚点底线按类别分层（feedback 1 / decision 2）', () => {
  assert.equal(ANCHOR_MINIMUMS.feedback, 1);
  assert.equal(ANCHOR_MINIMUMS.constraint, 1);
  assert.equal(ANCHOR_MINIMUMS.decision, 2);
  const reply = JSON.stringify([
    { text: '这条 decision 只有一个锚点会被挡掉', category: 'decision', topics: ['d'], anchors: ['m1'] },
    { text: '这条 decision 有两个锚点可以保留', category: 'decision', topics: ['d'], anchors: ['m2', 'm3'] },
  ]);
  const { items, stats } = analyzeGlobalDistill(reply);
  assert.equal(stats.rejected['few-anchors'], 1);
  assert.equal(items.length, 1);
});

/* ---------------- 自适应节奏与素材闸 ---------------- */

const { distillCadence, distillDue } = mod;

test('节奏：基础间隔随连续空跑翻倍，上限 24 小时', () => {
  assert.equal(distillCadence({ emptyStreak: 0 }).intervalMinutes, 15);
  assert.equal(distillCadence({ emptyStreak: 1 }).intervalMinutes, 30);
  assert.equal(distillCadence({ emptyStreak: 2 }).intervalMinutes, 60);
  assert.equal(distillCadence({ emptyStreak: 10 }).intervalMinutes, 24 * 60);
  assert.equal(
    distillCadence({ emptyStreak: 0 }, { cooldownMinutes: 5 }).intervalMinutes,
    5,
    '基础间隔可配置',
  );
});

test('素材闸：未覆盖达到门槛才触发；用户亲口说的可以提前触发', () => {
  const materials = Array.from({ length: 4 }, (_, i) => ({ id: `m${i}`, category: 'decision' }));
  assert.equal(distillDue({ materials, candidates: [], project: 'p', minNew: 5 }).due, false);
  assert.equal(distillDue({ materials, candidates: [], project: 'p', minNew: 3 }).due, true, '存量素材也能触发');

  const user = [{ id: 'u1', category: 'feedback' }, { id: 'u2', category: 'preference' }];
  const gate = distillDue({ materials: user, candidates: [], project: 'p', minNew: 5 });
  assert.equal(gate.due, true, '两条用户证据可以越过总素材门槛');
  assert.equal(gate.userEvidence, 2);

  const covered = distillDue({
    materials,
    candidates: [{ project: 'p', anchors: ['m0', 'm1'] }],
    project: 'p',
    minNew: 3,
  });
  assert.equal(covered.uncovered, 2, '被候选引用过的不再算新素材');
  assert.equal(covered.due, false);
});

/* ---------------- 集成：候选池 → Dream 巡检 → 全局记忆 ---------------- */

const { createMemoryStore } = await import('../lib/store.js');
const { createDreamRunner } = await import('../lib/dream.js');
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');

async function atest(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err && err.message}`);
  }
}

function freshDream() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dg-'));
  const store = createMemoryStore({ dir: path.join(base, 'lib') });
  const workspace = path.join(base, 'ws');
  fs.mkdirSync(workspace, { recursive: true });
  const dream = createDreamRunner({
    store,
    settings: { get: () => ({ staleDays: 60, briefingLimit: 12 }) },
  });
  return { store, workspace, dream };
}

const PRIVACY_RULE = {
  text: '对外素材一律使用构造数据并标注来源，真实数据只在本地',
  category: 'feedback',
  topics: ['privacy'],
  anchors: ['m1', 'm2'],
  project: 'ws-a',
};

await atest('晋升：feedback 单项目达标后落库为全局记忆，不冒充 user', async () => {
  const { store, workspace, dream } = freshDream();
  store.candidates.add([PRIVACY_RULE]);
  const report = await dream.run({ workspace, source: 'manual', portrait: false });

  assert.equal(report.globalPromoted, 1);
  const globals = store.list({ workspace: '', includeGlobal: true, scope: 'global' }).records;
  assert.equal(globals.length, 1);
  assert.equal(globals[0].scope, 'global');
  assert.equal(globals[0].source, 'auto', '模型归纳的结论不能冒充 user');
  assert.deepEqual(globals[0].keywords, ['privacy'], 'topics 要落成 keywords，否则去重失效');
  assert.equal(store.candidates.stats().pending, 0, '晋升后候选不该还留在待判定里');
});

await atest('晋升：重复巡检不会重复落库', async () => {
  const { store, workspace, dream } = freshDream();
  store.candidates.add([PRIVACY_RULE]);
  await dream.run({ workspace, source: 'manual', portrait: false });
  const second = await dream.run({ workspace, source: 'manual', portrait: false });

  assert.equal(second.globalPromoted, 0);
  assert.equal(store.list({ workspace: '', includeGlobal: true, scope: 'global' }).records.length, 1);
});

await atest('晋升：换个说法的同一原则记到已有那条上，不新建', async () => {
  const { store, workspace, dream } = freshDream();
  store.candidates.add([PRIVACY_RULE]);
  await dream.run({ workspace, source: 'manual', portrait: false });

  store.candidates.add([
    {
      text: '文档和截图一律使用构造数据并标注来源，真实用户数据不出现',
      category: 'feedback',
      topics: ['privacy'],
      anchors: ['n1'],
      project: 'ws-c',
    },
  ]);
  const report = await dream.run({ workspace, source: 'manual', portrait: false });

  assert.equal(report.globalPromoted, 0, '同一主题不该建第二条');
  assert.equal(report.globalDuplicates, 1, '应记为重复并指向已有条目');
  assert.equal(store.list({ workspace: '', includeGlobal: true, scope: 'global' }).records.length, 1);
});

await atest('晋升：单项目的 decision 候选不晋升，留在池里等第二个项目', async () => {
  const { store, workspace, dream } = freshDream();
  store.candidates.add([
    {
      text: '不可逆操作前必须先留可回滚快照，合并归档删除不做自动裁决',
      category: 'decision',
      topics: ['backup', 'irreversible'],
      anchors: ['m1', 'm2', 'm3'],
      project: 'ws-a',
    },
  ]);
  const report = await dream.run({ workspace, source: 'manual', portrait: false });

  assert.equal(report.globalPromoted, 0);
  assert.equal(store.candidates.stats().pending, 1, '未达标要留在池里，不能丢');
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
