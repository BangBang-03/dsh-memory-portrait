/**
 * dsh-memory 提炼层测试。
 *   node test/distill.test.mjs
 */

import assert from 'node:assert/strict';

const {
  DISTILL_SYSTEM,
  buildDistillInput,
  extractJson,
  parseDistillResponse,
  selectTranscript,
  shouldDistill,
  hasExplicitHint,
  isInjectedContext,
} = await import('../lib/distill.js');

const {
  clusterKey,
  buildAdjudicateInput,
  verifyVerdict,
  parseAdjudicateResponse,
  ADJUDICATE_RELATIONS,
} = await import('../lib/adjudicate.js');

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

console.log('\ndsh-memory distill tests\n');

/* ---------------- 提示词 ---------------- */

test('DISTILL_SYSTEM: 列出全部类别且要求纯 JSON', () => {
  assert.ok(DISTILL_SYSTEM.includes('preference'));
  assert.ok(DISTILL_SYSTEM.includes('convention'));
  assert.ok(DISTILL_SYSTEM.includes('ONLY a JSON object'));
  assert.ok(DISTILL_SYSTEM.includes('"memories"'));
});

test('buildDistillInput: 含工作区、已有标题与对话', () => {
  const input = buildDistillInput({
    workspace: 'C:\\proj\\alpha',
    transcript: '[{"role":"user","text":"用 pnpm"}]',
    existingTitles: ['用户偏好中文回复'],
  });
  assert.ok(input.includes('C:\\proj\\alpha'));
  assert.ok(input.includes('用户偏好中文回复'));
  assert.ok(input.includes('[{"role":"user","text":"用 pnpm"}]'));
  assert.ok(input.includes('do NOT repeat'));
});

test('buildDistillInput: 无已有标题时不出现去重段', () => {
  const input = buildDistillInput({ workspace: 'X', transcript: '[]' });
  assert.ok(!input.includes('do NOT repeat'));
  assert.ok(input.includes('(unknown)') === false);
});

test('buildDistillInput: 未知工作区显示 (unknown)', () => {
  assert.ok(buildDistillInput({}).includes('(unknown)'));
});

test('buildDistillInput: 已有标题超过 24 条被截断', () => {
  const titles = Array.from({ length: 100 }, (_, i) => `t${i}`);
  const input = buildDistillInput({ workspace: 'X', transcript: '[]', existingTitles: titles });
  assert.ok(input.includes('- t23'));
  assert.ok(!input.includes('- t24'));
});

/* ---------------- extractJson ---------------- */

test('extractJson: 裸 JSON', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test('extractJson: ```json 围栏', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
});

test('extractJson: 无语言标注的围栏', () => {
  assert.deepEqual(extractJson('```\n{"a":1}\n```'), { a: 1 });
});

test('extractJson: 前后有解释性文字', () => {
  assert.deepEqual(extractJson('好的，结果如下：\n{"a":1}\n希望有帮助。'), { a: 1 });
});

test('extractJson: 非法输入返回 null', () => {
  assert.equal(extractJson('完全没有 json'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson(null), null);
  assert.equal(extractJson(undefined), null);
});

test('extractJson: 顶层数组原样返回（由上层决定是否可用）', () => {
  assert.deepEqual(extractJson('[1,2,3]'), [1, 2, 3]);
});

/* ---------------- parseDistillResponse ---------------- */

const SAMPLE = JSON.stringify({
  memories: [
    { title: '包管理器用 pnpm', content: '本工作区统一使用 pnpm，不要用 npm 或 yarn。', category: 'convention', tags: ['tooling'], confidence: 0.9 },
    { title: '回复用中文', content: '用户要求所有回复使用简体中文。', category: 'preference', tags: [], confidence: 0.95 },
  ],
});

test('parseDistillResponse: 正常解析两条', () => {
  const out = parseDistillResponse(SAMPLE);
  assert.equal(out.length, 2);
  assert.equal(out[0].title, '包管理器用 pnpm');
  assert.equal(out[0].category, 'convention');
  assert.deepEqual(out[0].tags, ['tooling']);
  assert.equal(out[1].confidence, 0.95);
});

test('parseDistillResponse: 围栏输出也能解析', () => {
  assert.equal(parseDistillResponse(`\`\`\`json\n${SAMPLE}\n\`\`\``).length, 2);
});

test('parseDistillResponse: 空列表', () => {
  assert.deepEqual(parseDistillResponse('{"memories":[]}'), []);
});

test('parseDistillResponse: 垃圾输入返回空数组而不是抛错', () => {
  assert.deepEqual(parseDistillResponse('模型胡说八道'), []);
  assert.deepEqual(parseDistillResponse(null), []);
});

test('parseDistillResponse: 非法类别回落到 note', () => {
  const out = parseDistillResponse(JSON.stringify({ memories: [{ title: 'x', content: 'y', category: '瞎写' }] }));
  assert.equal(out[0].category, 'note');
});

test('parseDistillResponse: 置信度低于阈值被丢弃', () => {
  const out = parseDistillResponse(JSON.stringify({ memories: [
    { title: 'a', content: 'a', confidence: 0.1 },
    { title: 'b', content: 'b', confidence: 0.9 },
  ] }));
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'b');
});

test('parseDistillResponse: 缺少 confidence 时给 0.7', () => {
  const out = parseDistillResponse(JSON.stringify({ memories: [{ title: 'a', content: 'b' }] }));
  assert.equal(out[0].confidence, 0.7);
});

test('parseDistillResponse: 超出范围的 confidence 被夹紧', () => {
  const out = parseDistillResponse(JSON.stringify({ memories: [{ title: 'a', content: 'b', confidence: 5 }] }));
  assert.equal(out[0].confidence, 1);
});

test('parseDistillResponse: 无标题时用正文兜底，无正文时用标题兜底', () => {
  const out = parseDistillResponse(JSON.stringify({ memories: [
    { content: '只有正文' },
    { title: '只有标题' },
  ] }));
  assert.equal(out[0].title, '只有正文');
  assert.equal(out[1].content, '只有标题');
});

test('parseDistillResponse: 空条目被跳过', () => {
  const out = parseDistillResponse(JSON.stringify({ memories: [{ title: '', content: '' }, { title: 'ok', content: 'ok' }] }));
  assert.equal(out.length, 1);
});

test('parseDistillResponse: max 限制条数', () => {
  const many = { memories: Array.from({ length: 30 }, (_, i) => ({ title: `t${i}`, content: 'c', confidence: 0.9 })) };
  assert.equal(parseDistillResponse(JSON.stringify(many), { max: 3 }).length, 3);
});

test('parseDistillResponse: 容忍顶层数组与 items 键', () => {
  const arr = JSON.stringify([{ title: 'a', content: 'b', confidence: 1 }]);
  assert.equal(parseDistillResponse(arr).length, 1);
  const items = JSON.stringify({ items: [{ title: 'a', content: 'b', confidence: 1 }] });
  assert.equal(parseDistillResponse(items).length, 1);
});

test('parseDistillResponse: tags 为字符串时被接受', () => {
  const out = parseDistillResponse(JSON.stringify({ memories: [{ title: 'a', content: 'b', tags: 'solo' }] }));
  assert.deepEqual(out[0].tags, ['solo']);
});

test('parseDistillResponse: title 超长被截断到 160', () => {
  const out = parseDistillResponse(JSON.stringify({ memories: [{ title: 'x'.repeat(500), content: 'b' }] }));
  assert.equal(out[0].title.length, 160);
});

/* ---------------- selectTranscript ---------------- */

test('selectTranscript: 只保留 user/assistant 文本', () => {
  const json = selectTranscript([
    { role: 'user', content: [{ type: 'text', text: '问题' }] },
    { role: 'assistant', content: [{ type: 'text', text: '回答' }] },
    { role: 'system', content: [{ type: 'text', text: '系统' }] },
    { role: 'tool', content: [{ type: 'text', text: '工具' }] },
  ]);
  const parsed = JSON.parse(json);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map((m) => m.role), ['user', 'assistant']);
});

test('selectTranscript: 工具调用渲染为占位符', () => {
  const parsed = JSON.parse(selectTranscript([
    { role: 'assistant', content: [{ type: 'text', text: '我来查' }, { type: 'tool-call', name: 'grep' }] },
  ]));
  assert.ok(parsed[0].text.includes('[tool grep]'));
});

test('selectTranscript: 超预算时丢弃最早的消息', () => {
  const messages = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: [{ type: 'text', text: `#${i} ${'x'.repeat(100)}` }] }));
  const parsed = JSON.parse(selectTranscript(messages, { maxChars: 500, maxMessages: 40 }));
  assert.ok(parsed.length < 20);
  assert.ok(parsed[parsed.length - 1].text.startsWith('#19'), '保留最新的');
});

test('selectTranscript: 单条超预算时仍然保留它，但必须截到预算内', () => {
  const parsed = JSON.parse(selectTranscript([{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(9999) }] }], { maxChars: 100 }));
  assert.equal(parsed.length, 1, '至少保留最新一条，摘录不能为空');
  assert.ok(parsed[0].text.length <= 100, `单条也要受预算约束，实际 ${parsed[0].text.length}`);
});

test('selectTranscript: 插件注入的召回块不会混进对话摘录', () => {
  const recall = {
    role: 'user',
    source: { kind: 'dsh-memory', form: 'turn-recall' },
    content: [{ type: 'text', text: '### 与当前话题相关的召回（尾部注入）\n\n- [约定] 构建命令是 pnpm build' }],
  };
  const parsed = JSON.parse(selectTranscript([
    { role: 'user', content: [{ type: 'text', text: '真正的问题' }] },
    recall,
    { role: 'assistant', content: [{ type: 'text', text: '真正的回答' }] },
  ]));
  assert.deepEqual(parsed.map((m) => m.text), ['真正的问题', '真正的回答']);
  assert.equal(isInjectedContext(recall), true);
  /* 宿主丢了 source 时按固定标题兜底识别。 */
  assert.equal(isInjectedContext({ role: 'user', content: [{ type: 'text', text: recall.content[0].text }] }), true);
});

test('selectTranscript: 空输入得到空数组', () => {
  assert.equal(selectTranscript([]), '[]');
  assert.equal(selectTranscript(null), '[]');
});

/* ---------------- shouldDistill ---------------- */

test('shouldDistill: 琐碎轮次不提炼', () => {
  const result = shouldDistill([{ role: 'user', content: [{ type: 'text', text: 'ls' }] }]);
  assert.equal(result.distill, false);
});

test('shouldDistill: 内容充分的轮次提炼', () => {
  const result = shouldDistill([
    { role: 'user', content: [{ type: 'text', text: '这个项目的构建流程是什么？'.repeat(5) }] },
    { role: 'assistant', content: [{ type: 'text', text: '构建流程细节说明……'.repeat(60) }] },
  ]);
  assert.equal(result.distill, true);
  assert.ok(result.total > 600);
});

test('shouldDistill: 只有助手输出、没有足够用户输入时不提炼', () => {
  const result = shouldDistill([{ role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(2000) }] }]);
  assert.equal(result.distill, false);
});

test('shouldDistill: 空输入不提炼', () => {
  assert.equal(shouldDistill([]).distill, false);
  assert.equal(shouldDistill(null).distill, false);
});

test('shouldDistill: 历史很长但本轮很短时不提炼（只看当前轮）', () => {
  const history = Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: [{ type: 'text', text: `历史第 ${i} 轮：${'旧内容'.repeat(400)}` }],
  }));
  const result = shouldDistill([
    ...history,
    { role: 'user', content: [{ type: 'text', text: '跑一下测试' }] },
    { role: 'assistant', content: [{ type: 'text', text: '好。' }] },
  ]);
  assert.equal(result.distill, false, '不能拿整段历史充数');
  assert.ok(result.total < 600, `本轮实际只有 ${result.total} 字符`);
});

test('shouldDistill: 召回块不算本轮素材，也不能把琐碎轮次顶过门槛', () => {
  const recall = {
    role: 'user',
    source: { kind: 'dsh-memory' },
    content: [{ type: 'text', text: `### 与当前话题相关的召回（尾部注入）\n\n${'记忆正文'.repeat(400)}` }],
  };
  const result = shouldDistill([
    { role: 'user', content: [{ type: 'text', text: '跑一下测试' }] },
    recall,
    { role: 'assistant', content: [{ type: 'text', text: '好。' }] },
  ]);
  assert.equal(result.distill, false);
  assert.ok(result.total < 100, `召回块不该计入，实际 ${result.total}`);
});

/* ---------------- hasExplicitHint ---------------- */

test('hasExplicitHint: 命中中文显式记忆指令', () => {
  assert.equal(hasExplicitHint('记住：这个项目用 pnpm'), true);
  assert.equal(hasExplicitHint('以后都用中文回复'), true);
});

test('hasExplicitHint: 命中英文', () => {
  assert.equal(hasExplicitHint('Please remember this'), true);
  assert.equal(hasExplicitHint('ALWAYS use pnpm'), true);
});

test('hasExplicitHint: 普通文本不命中', () => {
  assert.equal(hasExplicitHint('帮我看看这个函数'), false);
  assert.equal(hasExplicitHint(''), false);
  assert.equal(hasExplicitHint(null), false);
});

/* ---------------- v0.3.0：keywords / supersedes / user 作用域 ---------------- */

test('parseDistillResponse：解析 keywords 与 supersedes，user 类别强制 global', () => {
  const reply = JSON.stringify({
    memories: [
      {
        title: '构建改用 vite',
        content: '新构建链已落地',
        category: 'decision',
        tags: ['build'],
        keywords: ['构建', 'vite', 'build'],
        supersedes: 'mem_old_1',
        confidence: 0.9,
      },
      { title: '用户是投研工程师', content: '角色画像', category: 'user', keywords: ['画像'], confidence: 0.8 },
    ],
  });
  const parsed = parseDistillResponse(reply, { minConfidence: 0.4 });
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0].keywords, ['构建', 'vite', 'build']);
  assert.equal(parsed[0].supersedes, 'mem_old_1');
  assert.equal(parsed[0].scope, 'workspace');
  assert.equal(parsed[1].scope, 'global', 'user 类别应强制 global');
  assert.equal(parsed[1].supersedes, null);
});

test('parseDistillResponse：keywords / supersedes 缺省与越界都安全', () => {
  const parsed = parseDistillResponse('{"memories":[{"title":"只有标题","category":"note","confidence":0.9}]}');
  assert.deepEqual(parsed[0].keywords, []);
  assert.equal(parsed[0].supersedes, null);
  const clipped = parseDistillResponse(
    '{"memories":[{"title":"t","category":"note","keywords":["a","b","c","d","e","f","g","h","i","j","k"],"confidence":0.9}]}',
  );
  assert.ok(clipped[0].keywords.length <= 8, 'keywords 越界应截断');
});

test('DISTILL_SYSTEM v2：要求 keywords、supersede 规则与 feedback/user 指引', () => {
  assert.ok(DISTILL_SYSTEM.includes('"keywords"'));
  assert.ok(DISTILL_SYSTEM.includes('supersedes'));
  assert.ok(DISTILL_SYSTEM.includes('feedback'));
  assert.ok(DISTILL_SYSTEM.includes('"user"'));
  assert.match(DISTILL_SYSTEM, /How to apply/);
});

test('buildDistillInput：existingRecords 带 id，supersede 只在真矛盾时用', () => {
  const input = buildDistillInput({
    workspace: 'C:\\x',
    transcript: '[]',
    existingRecords: [{ id: 'mem_a1', title: '旧记忆' }],
  });
  assert.match(input, /mem_a1/, '已有记忆应带 id');
  assert.match(input, /supersedes/i);
  assert.match(input, /ONLY if the excerpt proves one wrong/);
  // 兼容旧的 existingTitles 入参。
  const legacy = buildDistillInput({ workspace: 'C:\\x', transcript: '[]', existingTitles: ['旧记忆'] });
  assert.match(legacy, /旧记忆/);
});

test('buildDistillInput：已有记忆最多 24 条，控制输入 token', () => {
  const existingRecords = Array.from({ length: 30 }, (_, index) => ({
    id: `mem_${index}`,
    title: `旧记忆 ${index}`,
  }));
  const input = buildDistillInput({ workspace: 'C:\\x', transcript: '[]', existingRecords });
  const lines = input.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(lines.length, 24);
});

/* ---------------- L2 按需语义裁决：硬闸 ---------------- */

const PAIR = [
  { id: 'mem_a', title: '包管理器约定', content: '这个项目统一使用 pnpm 安装依赖。' },
  { id: 'mem_b', title: '包管理器迁移', content: '不要再用 pnpm 了，改用 npm 安装依赖。' },
];
const GOOD_VERDICT = {
  key: clusterKey(PAIR),
  relation: 'contradicts',
  subject: '包管理器',
  predicate: '统一使用',
  values: ['pnpm', 'npm'],
  evidence: ['统一使用 pnpm 安装依赖', '改用 npm 安装依赖'],
  confidence: 0.92,
};

test('语义裁决：clusterKey 与簇内顺序无关', () => {
  assert.equal(clusterKey(PAIR), clusterKey([...PAIR].reverse()));
  assert.equal(clusterKey(PAIR), 'mem_a|mem_b');
  assert.ok(ADJUDICATE_RELATIONS.includes('unrelated'));
});

test('语义裁决：同一主谓宾 + 互斥取值 + 证据分落两条才准 contradicts', () => {
  const verdict = verifyVerdict(GOOD_VERDICT, PAIR);
  assert.equal(verdict.relation, 'contradicts');
  assert.equal(verdict.guard, null);
  assert.equal(verdict.confidence, 0.92);
});

test('语义裁决：真实库四种误报形态全部被硬闸降级为 unrelated', () => {
  const cases = [
    [{ subject: '' }, 'missing_subject_or_predicate'],
    [{ values: ['pnpm', 'pnpm'] }, 'values_not_exclusive'],
    [{ values: [] }, 'missing_values'],
    [{ evidence: ['统一使用 pnpm 安装依赖', '统一使用 pnpm 安装依赖'] }, 'evidence_same_record'],
    [{ evidence: ['统一使用 pnpm 安装依赖', '这句不在任何原文里'] }, 'evidence_not_in_source'],
    [{ values: ['webpack', 'vite'] }, 'values_not_grounded'],
  ];
  for (const [patch, guard] of cases) {
    const verdict = verifyVerdict({ ...GOOD_VERDICT, ...patch }, PAIR);
    assert.equal(verdict.relation, 'unrelated', `${guard} 应降级`);
    assert.equal(verdict.guard, guard);
  }
  /* 句内对比句：模型抽不出两个取值，就必须降级而不是硬判冲突。 */
  const intraSentence = verifyVerdict(
    { ...GOOD_VERDICT, values: ['turn/end'], evidence: [] },
    [
      { id: 'x', title: '自动巩固', content: '自动巩固必须挂 turn/end，不能挂 agent/turn-stopping。' },
      { id: 'y', title: '轮末处理', content: '自动巩固在 turn/end 里做，不占用收尾时间。' },
    ],
  );
  assert.equal(intraSentence.relation, 'unrelated');
});

test('语义裁决：解析容忍围栏与前后废话，未知 key 与漏答簇不裁决', () => {
  const reply = `好的，结果如下：\n\`\`\`json\n${JSON.stringify([GOOD_VERDICT])}\n\`\`\`\n以上。`;
  const parsed = parseAdjudicateResponse(reply, [PAIR]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.verdicts.get(clusterKey(PAIR)).relation, 'contradicts');
  assert.equal(parseAdjudicateResponse('不是 JSON', [PAIR]).ok, false);

  const withNoise = parseAdjudicateResponse(
    JSON.stringify([GOOD_VERDICT, { ...GOOD_VERDICT, key: 'unknown|key' }]),
    [PAIR],
  );
  assert.equal(withNoise.verdicts.size, 1, '未知 key 必须忽略');
});

test('语义裁决：多个簇打包进一次调用，且不夹带使用统计', () => {
  const input = buildAdjudicateInput([PAIR, PAIR.slice(0, 2)], { maxClusters: 8 });
  const payload = JSON.parse(input);
  assert.equal(payload.clusters.length, 2);
  assert.equal(payload.clusters[0].key, 'mem_a|mem_b');
  assert.ok(payload.clusters[0].records.every((r) => !('useCount' in r)));
  assert.ok(payload.clusters[0].records.every((r) => !('exposedCount' in r)));
});

/* ---------------- 结果 ---------------- */

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
