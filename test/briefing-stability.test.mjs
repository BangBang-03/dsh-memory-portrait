/**
 * 简报稳定性套件：冻结快照、确定性排序、尾部召回注入。
 *   node test/briefing-stability.test.mjs
 *
 * 这一套守的是「系统提示必须是稳定前缀」——系统提示排在请求最前面，
 * 它一变整段 prompt 前缀缓存就废了。三条硬约束：
 *   1. 同一会话里反复渲染必须逐字节相同（跨 TTL、跨 useCount 增长）；
 *   2. 落库顺序不影响简报文本（排序必须只由字段决定，不读时间/使用次数）；
 *   3. 轮末召回不进系统提示，只通过 agent/pre-step 折进进入批次，且一轮只发一次。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 相对 specifier：Windows 下动态 import() 不接受裸绝对路径。
const mod = await import('../lib/index.js');
const { createMemoryStore } = await import('../lib/store.js');

let passed = 0;
let failed = 0;

async function test(name, fn) {
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

/* ------------------------------------------------------------------ *
 * 夹具：假 cordis 上下文 / 假 HTTP 请求响应 / 假 agent/pre-step 宿主
 * ------------------------------------------------------------------ */

function createFakeCtx(services = {}) {
  const calls = { effects: [], injects: [], events: [], tools: [], sections: [], routes: [], info: [], warn: [] };

  const base = {
    logger: {
      info: (m) => calls.info.push(String(m)),
      warn: (m) => calls.warn.push(String(m)),
    },
    get: (key) => services[key],
    effect(fn, label) {
      calls.effects.push(label);
      return fn();
    },
    inject(deps, callback) {
      calls.injects.push(deps);
      const child = { ...base };
      if (deps.includes('systemPrompt')) {
        child.systemPrompt = {
          section: (options) => {
            calls.sections.push(options);
            return () => {};
          },
          variable: () => () => {},
        };
      }
      if (deps.includes('webServer')) {
        child.webServer = {
          register: (route) => {
            calls.routes.push(route);
            return () => {};
          },
        };
      }
      if (deps.includes('sessions')) child.sessions = { list: () => [] };
      callback(child);
      return () => {};
    },
    on(name, fn) {
      calls.events.push([name, fn]);
      return () => {};
    },
    tools: {
      register: (tool) => {
        calls.tools.push(tool);
        return () => {};
      },
    },
  };

  return { ctx: base, calls };
}

function makeReq({ url = '/' } = {}) {
  // route() 只读 url / method / headers / socket，直接用普通对象就够。
  return { method: 'GET', url, headers: {}, socket: { remoteAddress: '127.0.0.1' } };
}

function makeRes() {
  const res = {
    statusCode: 0,
    text: '',
    setHeader() {},
    end(text) {
      res.text = String(text ?? '');
    },
  };
  return res;
}

/** 走一遍真实的 webServer handler，返回解析后的 body。 */
async function callRoute(handler, sub) {
  const res = makeRes();
  await handler(makeReq({ url: `/memory/api${sub}` }), res);
  try {
    return JSON.parse(res.text);
  } catch {
    return res.text;
  }
}

/** 假宿主跑一遍 agent/pre-step；nextKind='reject' 时模拟宿主拒绝这次 step。 */
async function runPreStep(calls, payload, { nextKind = 'enter', nextMessages = null } = {}) {
  const handler = calls.events.find(([name]) => name === 'agent/pre-step')[1];
  const claimed = payload.messages || [];
  const next = async () => ({
    kind: nextKind,
    messages: nextMessages === null ? claimed.slice() : nextMessages,
  });
  return handler({ signal: undefined, ...payload, messages: claimed }, next);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-stability-'));
const workspace = path.join(tmp, 'workspace');
fs.mkdirSync(workspace, { recursive: true });

/** 每项测试都拿一份干净的插件实例（自己的数据目录 + 自己的假 ctx）。 */
function activate({ services = {}, briefingRebuildMinNew = 1, briefingRebuildCooldownMs = 0, ...config } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'data-'));
  const { ctx, calls } = createFakeCtx(services);
  /* 老用例默认关掉重算闸（1 条 / 0ms），保持「写一条就重算」的旧语义；
     重算闸本身由下面专门的用例用生产默认值（3 条 / 30 分钟）验证。 */
  mod.apply(ctx, { directory: dir, briefingRebuildMinNew, briefingRebuildCooldownMs, ...config });
  const tool = calls.tools[0];
  const route = calls.routes[0]?.handler;
  const session = {
    id: 'session-1',
    header: { cwd: workspace },
    requestHeader: () => ({ config: { provider: 'deepseek-account', model: 'deepseek-flash' } }),
    deriveMessages: () => [],
  };
  const exec = { agent: { session }, callId: 'call-1', signal: undefined };
  /* 会话建立 → activeWorkspace() 认到这个工作区。 */
  calls.events.find(([name]) => name === 'session/created')[1](session);
  const render = (target = session) => calls.sections[0].text({ agent: { session: target } });
  return { ctx, calls, dir, tool, route, session, exec, render };
}

/**
 * 工具落库用的「好记忆」：store 的质量闸门会归档「agent 来源 + 低质量」的新条目，
 * 测试数据得像一条真记忆（正文够长、标题够长、不带元话术）。
 */
function memory(title, content = '这条正文足够长，不会被质量闸门归档，也不是元记忆。') {
  return { action: 'save', title, content, category: 'convention' };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * 1. 确定性排序（store 层）
 * ------------------------------------------------------------------ */

const ORDER_ROWS = [
  { title: '甲：构建约定', category: 'convention', createdAt: '2026-01-01T00:00:00.000Z' },
  { title: '乙：接口偏好', category: 'preference', createdAt: '2026-01-02T00:00:00.000Z' },
  { title: '丙：随手笔记', category: 'note', createdAt: '2026-01-03T00:00:00.000Z' },
  { title: '丁：发布约定', category: 'convention', createdAt: '2026-01-04T00:00:00.000Z' },
];

await test('briefing 排序：同一批记录换个落库顺序，取出的顺序与文本完全一致', () => {
  const wsA = path.join(tmp, 'order-ws-a');
  const wsB = path.join(tmp, 'order-ws-b');
  const storeA = createMemoryStore({ dir: path.join(tmp, 'order-a') });
  const storeB = createMemoryStore({ dir: path.join(tmp, 'order-b') });

  for (const row of ORDER_ROWS) {
    const index = ORDER_ROWS.indexOf(row);
    storeA.upsert(
      { ...row, id: `mem_order_${index}`, content: '内容正文（排序测试用，正文长度不影响顺序）。' },
      { workspace: wsA, dedupe: false },
    );
  }
  for (const row of [...ORDER_ROWS].reverse()) {
    const index = ORDER_ROWS.indexOf(row);
    storeB.upsert(
      { ...row, id: `mem_order_${index}`, content: '内容正文（排序测试用，正文长度不影响顺序）。' },
      { workspace: wsB, dedupe: false },
    );
  }

  const idsA = storeA.briefing({ workspace: wsA }).map((r) => r.id);
  const idsB = storeB.briefing({ workspace: wsB }).map((r) => r.id);
  assert.deepEqual(idsB, idsA, '落库顺序不该影响简报顺序');
  assert.equal(idsA.length, ORDER_ROWS.length);

  /* 置顶 → 类别权重 → createdAt **降序** → id 的全序：preference 权重最高排最前，
     两条 convention 里新写的（01-04）排在旧的（01-01）前面——这是 latest-write-wins 的落点，
     note 最后。 */
  assert.deepEqual(idsA, ['mem_order_1', 'mem_order_3', 'mem_order_0', 'mem_order_2']);
});

await test('briefing 排序：使用次数增长不改顺序（useCount 不参与简报排序）', () => {
  const ws = path.join(tmp, 'order-ws-use');
  const store = createMemoryStore({ dir: path.join(tmp, 'order-use') });
  for (const row of ORDER_ROWS) {
    const index = ORDER_ROWS.indexOf(row);
    store.upsert({ ...row, id: `mem_use_${index}`, content: '使用次数不该影响简报排序，正文足够长。' }, { workspace: ws });
  }
  const before = store.briefing({ workspace: ws }).map((r) => r.id);
  /* 把排在最后的那条刷成「用过 9 次」：按旧打分它会被顶上来。 */
  store.markUsed([before.at(-1)], { workspace: ws });
  store.markUsed([before.at(-1)], { workspace: ws });
  const after = store.briefing({ workspace: ws }).map((r) => r.id);
  assert.deepEqual(after, before, 'useCount 涨了也不该重排简报');
});

await test('briefing 排序：置顶压过类别权重', () => {
  const ws = path.join(tmp, 'order-ws-pin');
  const store = createMemoryStore({ dir: path.join(tmp, 'order-pin') });
  store.upsert({ id: 'mem_pin_note', title: '被置顶的笔记', content: '置顶就该排最前，正文足够长。', category: 'note', pinned: true }, { workspace: ws });
  store.upsert({ id: 'mem_pin_pref', title: '没置顶的偏好', content: '类别权重再高也不该压过置顶。', category: 'preference' }, { workspace: ws });
  assert.deepEqual(
    store.briefing({ workspace: ws }).map((r) => r.id),
    ['mem_pin_note', 'mem_pin_pref'],
  );
});

/* ------------------------------------------------------------------ *
 * 2. 会话级冻结快照（activate 层）
 * ------------------------------------------------------------------ */

await test('系统提示段：同一会话跨 1.5s + useCount 增长，仍然逐字节相同', async () => {
  const { tool, exec, session, render } = activate();
  const saved = await tool.execute(memory('构建命令是 pnpm build'), exec);
  const id = /`(mem_[A-Za-z0-9_]+)`/.exec(saved.text)?.[1];
  assert.ok(id, '保存应返回 id');

  const first = render();
  assert.match(first, /构建命令是 pnpm build/);

  /* 只读 + 引用计数增长：都不该改文本，也不该触发重建。 */
  await tool.execute({ action: 'get', id }, exec);
  await tool.execute({ action: 'search', query: '构建命令' }, exec);
  await sleep(1600);

  const second = render();
  assert.equal(second, first, '同一会话的系统提示必须逐字节稳定');
  assert.match(second, /上面是索引/);
  assert.equal(session.id, 'session-1');
});

await test('记忆真写入时重算一次、之后重新冻结；重建原因记进 /state 的简报诊断', async () => {
  const { tool, exec, route, render } = activate();

  const first = render();
  assert.equal(first, '', '一开始没有记忆也没有画像，简报为空');

  const state0 = await callRoute(route, '/state');
  assert.equal(state0.briefing.reason, 'first', '第一次装配的原因就是 first');
  assert.equal(state0.briefing.builds, 1);

  await tool.execute(memory('第一条约定：改完客户端半要重跑 pnpm build'), exec);
  const afterFirstSave = render();
  assert.match(afterFirstSave, /第一条约定/);

  const state1 = await callRoute(route, '/state');
  assert.equal(state1.briefing.sessionId, 'session-1');
  assert.equal(state1.briefing.reason, 'memory', '写入后的重算原因是「记忆变了」');
  assert.equal(state1.briefing.builds, 2);

  /* 再写一条：下一次渲染重算一次，然后重新冻结。 */
  await tool.execute(memory('第二条约定：发布走 npm 双线 main/lab'), exec);
  const afterSecondSave = render();
  assert.match(afterSecondSave, /第二条约定/);
  assert.notEqual(afterSecondSave, afterFirstSave);
  assert.equal(render(), afterSecondSave, '重算之后必须重新冻结');

  const state2 = await callRoute(route, '/state');
  assert.equal(state2.briefing.builds, 3, '空 → 第一条 → 第二条');
  assert.equal(state2.briefing.reason, 'frozen', '最后一次是命中快照，不是重算');
  const reasons = state2.briefing.rebuilds.map((row) => row.reason);
  assert.deepEqual(reasons.slice(0, 3), ['memory', 'memory', 'first'], '重建日志按时间倒序');
  assert.equal(state2.briefing.rebuilds[0].chars, afterSecondSave.length, '日志记下字符数');
  assert.equal(state2.briefing.rebuilds[0].sessionId, 'session-1', '日志记下会话 id');
  assert.equal(state2.briefing.rebuilds[0].changed, true, '这次文本真的变了');
  assert.equal(state2.briefing.rebuilds[1].changed, true);
  assert.equal(state2.briefing.rebuilds[2].chars, 0, '空的首次装配字符数为 0');

  /* 只读不再产生重建记录。 */
  await tool.execute({ action: 'search', query: '约定' }, exec);
  render();
  const state3 = await callRoute(route, '/state');
  assert.equal(state3.briefing.builds, 3, '纯读不重建');
  assert.equal(state3.briefing.reason, 'frozen');
});

await test('简报重算闸：冷却期内即使攒够 3 条也不重算，单条写入只合并不追加', async () => {
  /* 生产默认值 3 条 / 30 分钟；这里显式设 10 分钟，断言不依赖默认值漂移。
     每次重算都会让宿主把整份系统提示再追加进历史，所以冷却期必须是硬间隔——
     条数只决定「冷却结束后值不值得重算」，不能反过来击穿冷却。 */
  const { tool, exec, route, render } = activate({ briefingRebuildMinNew: 3, briefingRebuildCooldownMs: 600000 });
  assert.equal(render(), '', '空库先装配一次空简报');
  const base = await callRoute(route, '/state');
  assert.equal(base.briefing.reason, 'first');

  await tool.execute(memory('重算闸甲：构建命令', '改完客户端半要重跑 pnpm build，别拿旧产物验收。'), exec);
  assert.equal(render(), '', '1 条未达门槛，继续用冻结字节');
  const one = await callRoute(route, '/state');
  assert.equal(one.briefing.reason, 'coalesced', '合并等待的原因要可见');
  assert.equal(one.briefing.pendingNew, 1);
  assert.equal(one.briefing.builds, 1, '合并等待不算一次重算');

  await tool.execute(memory('重算闸乙：发布顺序', '发布前先推 main 并跑完全量测试，再打 v* 标签。'), exec);
  await tool.execute(memory('重算闸丙：截图规范', '文档配图不要用真实记忆面板截图，避免泄露用户数据。'), exec);
  assert.equal(render(), '', '冷却期内攒够 3 条也继续冻结');
  const three = await callRoute(route, '/state');
  assert.equal(three.briefing.reason, 'coalesced');
  assert.equal(three.briefing.pendingNew, 3);
  assert.equal(three.briefing.builds, 1, '一次重算都没发生');

  /* 红线例外：新增红线绕过条数与冷却，立刻进简报（安全边界）。 */
  await tool.execute(
    {
      action: 'save',
      title: '红线：绝不 force push main',
      content: 'main 已开保护；任何情况下都不要 amend / rebase / force push。',
      category: 'constraint',
    },
    exec,
  );
  const withRedline = render();
  assert.match(withRedline, /绝不 force push main/, '红线新增立刻重算，不等冷却');
  const redlineState = await callRoute(route, '/state');
  assert.equal(redlineState.briefing.reason, 'memory');
  assert.equal(redlineState.briefing.builds, 2);
});

await test('简报重算闸：冷却结束后，攒够条数才一次性重算', async () => {
  /* 用可控时钟跨过冷却，避免 sleep 抖动：真实机器上 3 次落库偶尔就能超过 50ms。 */
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    const { tool, exec, route, render } = activate({ briefingRebuildMinNew: 3, briefingRebuildCooldownMs: 600000 });
    render();
    await tool.execute(memory('冷却后甲：构建命令'), exec);
    await tool.execute(memory('冷却后乙：发布顺序'), exec);
    await tool.execute(memory('冷却后丙：截图规范'), exec);
    assert.equal(render(), '', '冷却期内先合并');

    clock += 600001;
    const built = render();
    assert.match(built, /冷却后甲：构建命令/);
    assert.match(built, /冷却后丙：截图规范/, '同一批写入一起出现');
    const state = await callRoute(route, '/state');
    assert.equal(state.briefing.reason, 'memory');
    assert.equal(state.briefing.builds, 2);

    await tool.execute(memory('冷却后丁：日志入口'), exec);
    assert.equal(render(), built, '刚重算过，下一条又回到合并等待');
  } finally {
    Date.now = realNow;
  }
});

await test('简报重算闸：条数没攒够时，时间闸到点也会重算（编辑/归档/画像兜底）', async () => {
  const { tool, exec, route, render } = activate({ briefingRebuildMinNew: 50, briefingRebuildCooldownMs: 1 });
  render();
  await tool.execute(memory('时间闸到点的记忆'), exec);
  await sleep(5);
  const text = render();
  assert.match(text, /时间闸到点的记忆/);
  const state = await callRoute(route, '/state');
  assert.equal(state.briefing.reason, 'memory');
  assert.equal(state.briefing.builds, 2);
});

await test('快照边界：会话 id 被复用即重建；快照最多 60 个（最旧的被淘汰）', async () => {
  const { calls, tool, exec, session, render, route } = activate();
  await tool.execute(memory('快照边界用的记忆'), exec);
  const first = render();
  assert.match(first, /快照边界用的记忆/);

  /* 同一 id 的会话重新创建 → 丢掉旧快照（新会话不能顺延旧字节）。 */
  calls.events.find(([name]) => name === 'session/created')[1]({ ...session });
  const again = render();
  assert.equal(again, first, '内容没变，重建出来的字节当然相同');
  const stateAfterReuse = await callRoute(route, '/state');
  assert.equal(stateAfterReuse.briefing.builds, 1, '会话 id 复用后重新记数（从 1 开始）');

  /* 灌满 61 个会话：最旧的那个被挤出去，再渲染它就是新装配。 */
  for (let index = 0; index < 61; index += 1) render({ ...session, id: `session-${index}` });
  const warm = render({ ...session, id: 'session-1' });
  assert.equal(warm, first);
  const state = await callRoute(route, '/state');
  assert.equal(state.briefing.sessionId, 'session-1');
  assert.equal(state.briefing.builds, 1, '被淘汰过的会话重新装配，不是命中缓存');
});

await test('工作区换了就重建；setting 改了模式也重建', async () => {
  const { calls, tool, exec, session, render, route } = activate();
  await tool.execute(memory('换工作区用的记忆'), exec);
  const base = render();
  assert.match(base, /换工作区用的记忆/);

  const other = path.join(tmp, 'another-workspace');
  fs.mkdirSync(other, { recursive: true });
  const moved = render({ ...session, header: { cwd: other } });
  assert.doesNotMatch(moved, /换工作区用的记忆/, '别的工作区不该带上这条');
  assert.equal(render({ ...session, header: { cwd: other } }), moved, '新工作区自己也要冻住');

  /* P2-1 白名单：/state 显式 workspace 必须注册过——用独立会话 id 登记 other，
     不动主会话的冻结快照（同 id 的 session/created 会按复用规则清快照）。 */
  calls.events.find(([name]) => name === 'session/created')[1]({ id: 'ws-switch-session', header: { cwd: other } });
  const switched = await callRoute(
    route,
    `/state?workspace=${encodeURIComponent(other)}`,
  );
  assert.equal(switched.briefing.workspace, other, '诊断跟着最近这次装配走');
  assert.equal(switched.briefing.reason, 'frozen');
});

/* ------------------------------------------------------------------ *
 * 3. 尾部注入（agent/pre-step）
 * ------------------------------------------------------------------ */

/**
 * 造出一个「下一轮会带召回」的现场。
 * 关键：召回只捞「简报索引里没有的」条目，所以这里把 briefingLimit 压到 1，
 * 再落两条 —— 索引里只有第一条，被召回的是第二条（构建那条）。
 */
async function seedRecall(config = {}) {
  const fixture = activate({ briefingLimit: 1, ...config });
  const { calls, tool, exec, session } = fixture;
  /* 先写构建命令、后写甲记忆：简报 limit=1 且新条优先，所以简报装甲记忆；
     用户接下来的问题命中构建命令，召回才有东西可注入（已在简报里的条目不重复注入）。 */
  await tool.execute(memory('构建命令是 pnpm build', '改完客户端半要重跑 pnpm build。'), exec);
  await tool.execute(memory('甲记忆：客户端半的样式基调用鲸鱼蓝'), exec);
  session.deriveMessages = () => [
    { role: 'user', content: [{ type: 'text', text: '帮我跑一下构建命令，然后告诉我结果' }] },
    { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
  ];
  calls.events.find(([name]) => name === 'session/event')[1](session, { type: 'turn/end' });
  return fixture;
}

const userSay = (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });

await test('召回不进系统提示；agent/pre-step 把它折进进入批次，且一轮只发一次', async () => {
  const { calls, session, render } = await seedRecall();
  const section = render();
  /* 简报索引里只有 1 条（limit=1），且是新写的那条——latest-write-wins；
     超预算的旧条不该挤进来。召回应完全是尾部的东西。 */
  assert.match(section, /甲记忆/);
  assert.doesNotMatch(section, /构建命令是 pnpm build/, '超预算的旧条不该挤进简报');
  assert.doesNotMatch(section, /### 与当前话题相关的召回/, '系统提示里不该再有召回块');
  assert.doesNotMatch(section, /只是背景参考/, '召回块的措辞也不该出现在系统提示里');
  assert.doesNotMatch(section, /改完客户端半要重跑/, '召回的正文摘录更不该出现在系统提示里');

  const claimed = userSay('那构建产物在哪');
  const entered = await runPreStep(calls, { agent: { session }, messages: [claimed], turn: 2, step: 1 });
  assert.equal(entered.messages.length, 2, '召回作为一条额外消息进入');
  assert.equal(entered.messages[0], claimed, '被认领的消息原样在前');

  const tail = entered.messages[1];
  assert.equal(tail.role, 'user');
  assert.equal(tail.source.kind, 'dsh-memory');
  assert.equal(tail.source.form, 'turn-recall');
  assert.equal(tail.source.turn, 2);
  const tailText = tail.content.map((block) => block.text).join('\n');
  assert.match(tailText, /### 与当前话题相关的召回（尾部注入）/);
  assert.match(tailText, /只是背景参考/);
  assert.match(tailText, /构建命令是 pnpm build/);
  assert.match(tailText, /改完客户端半要重跑/, '带正文摘录');
  assert.match(tailText, /不要把它写回记忆/, '要写清不能回写记忆');

  /* 同一轮第二个 step：不再注入。 */
  const step2 = await runPreStep(calls, { agent: { session }, messages: [userSay('继续')], turn: 2, step: 2 });
  assert.equal(step2.messages.length, 1, '同一轮只发一次');
});

await test('agent/pre-step 边界：reject / 空批次 / 只有 runtime-context 时都不注入', async () => {
  const { calls, session } = await seedRecall();
  const claimed = [userSay('构建又挂了')];

  const rejected = await runPreStep(calls, { agent: { session }, messages: claimed, turn: 2, step: 1 }, { nextKind: 'reject' });
  assert.equal(rejected.kind, 'reject');
  assert.equal(rejected.messages.length, 1, 'reject 的 step 不该被塞东西');

  const empty = await runPreStep(calls, { agent: { session }, messages: [], turn: 2, step: 1 });
  assert.equal(empty.messages.length, 0, '空批次不该被召回撑出一个 step');

  const contextOnly = await runPreStep(calls, {
    agent: { session },
    messages: [{ role: 'user', content: [], source: { kind: 'runtime-context' } }],
    turn: 2,
    step: 1,
  });
  assert.equal(contextOnly.messages.length, 1, '只有 runtime-context 时不该注入');
});

await test('重试 / 续跑：会话日志里已有本轮的召回就不重复注入', async () => {
  const { calls, session } = await seedRecall();
  const withLog = {
    ...session,
    surface: { nodes: [1, 2] },
    eventAt: (seq) =>
      seq === 2
        ? { type: 'user/message', data: { source: { kind: 'dsh-memory', form: 'turn-recall', turn: 5 } } }
        : { type: 'assistant/message', data: {} },
  };
  const entered = await runPreStep(calls, { agent: { session: withLog }, messages: [userSay('继续聊构建')], turn: 5, step: 1 });
  assert.equal(entered.messages.length, 1, '日志里已经有本轮的召回，就不要再塞一条');
});

await test('关掉 turnRecall / 关掉插件时，agent/pre-step 什么都不做', async () => {
  const off = await seedRecall({ turnRecall: false });
  const entered = await runPreStep(off.calls, {
    agent: { session: off.session },
    messages: [userSay('构建怎么跑')],
    turn: 2,
    step: 1,
  });
  assert.equal(entered.messages.length, 1, 'turnRecall=false 时不注入');

  const disabled = await seedRecall({ enabled: false });
  const nothing = await runPreStep(disabled.calls, {
    agent: { session: disabled.session },
    messages: [userSay('构建怎么跑')],
    turn: 2,
    step: 1,
  });
  assert.equal(nothing.messages.length, 1, '插件关掉时不注入');
});

await test('尾部注入的计量进 /state 诊断（面板据此显示尾部注了什么）', async () => {
  const { calls, session, route, render } = await seedRecall();
  render();
  await runPreStep(calls, { agent: { session }, messages: [userSay('那构建产物在哪')], turn: 2, step: 1 });
  const state = await callRoute(route, '/state');
  assert.equal(state.briefing.tail.sessionId, 'session-1');
  assert.equal(state.briefing.tail.turn, 2);
  assert.ok(state.briefing.tail.count >= 1, '记下注入了几条');
  assert.ok(state.briefing.tail.chars > 0, '记下注入了多少字符');
});

/* ------------------------------------------------------------------ *
 * 4. 预览对齐
 * ------------------------------------------------------------------ */

await test('/briefing-preview 的 ids 与冻结的静态简报一致（正文另算，不含召回）', async () => {
  const { tool, exec, route, render } = activate();
  await tool.execute(memory('预览要对齐的甲记忆'), exec);
  await tool.execute(memory('预览要对齐的乙记忆', '第二条正文也足够长，不会被质量闸门挡住。'), exec);

  const text = render();
  const idsInText = [...text.matchAll(/`(mem_[A-Za-z0-9_]+)`/g)].map((match) => match[1]);
  const preview = await callRoute(route, '/briefing-preview');
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.preview.ids, idsInText, '预览的 ids 必须与真正注入的条目一致');
  assert.equal(preview.preview.count, preview.preview.ids.length);
  for (const title of preview.preview.titles) assert.ok(text.includes(title), '预览里的标题都得在注入文本里');
});

await test('/briefing-preview：静态部分不含召回；补丁版预览的 staticText 就是真注入的字节', async () => {
  const { route, render } = await seedRecall();
  const text = render();
  const preview = await callRoute(route, '/briefing-preview');

  /* 静态部分（进系统提示的那份）绝不能出现召回块的任何痕迹。 */
  const staticPart = [
    JSON.stringify(preview.preview.ids),
    JSON.stringify(preview.preview.titles),
    String(preview.preview.staticText ?? ''),
  ].join('\n');
  assert.doesNotMatch(staticPart, /### 与当前话题相关的召回/);
  assert.doesNotMatch(staticPart, /只是背景参考/);

  /* 预览接口补上尾部一栏之后（见 docs/preview-tail.patch），还要对着冻结字节校验。 */
  if ('staticText' in preview.preview) {
    assert.equal(preview.preview.frozen, true, '预览应认出「已冻结」');
    assert.equal(preview.preview.staticText, text, 'staticText 必须是冻结的那份字节');
    assert.equal(preview.preview.staticChars, text.length);
    assert.ok(preview.preview.recall, '尾部召回要单列一栏');
    assert.match(preview.preview.recall.text, /### 与当前话题相关的召回（尾部注入）/);
    assert.ok(preview.preview.recall.count >= 1);
  }
});

/* ------------------------------------------------------------------ */

await test('主库损坏（EDAMAGED）时简报注入不抛错：本轮空段，异常不出插件', async () => {
  const { calls, tool, exec, session, render, dir } = activate();
  await tool.execute(memory('损坏兜底用记忆'), exec);
  const first = render();
  assert.match(first, /损坏兜底用记忆/, '前置：库完好时简报有内容');

  /* 把主库文件写坏（strict 模式会备份后抛 EDAMAGED，见 store 层）。 */
  const libFile = [];
  const walk = (folder) => {
    for (const name of fs.readdirSync(folder)) {
      const full = path.join(folder, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (name === 'memories.json') libFile.push(full);
    }
  };
  walk(dir);
  assert.ok(libFile.length >= 1, '应能找到主库文件');
  for (const file of libFile) fs.writeFileSync(file, '{corrupted!!', 'utf8');

  /* 系统提示路径：不抛错、给空段——异常绝不能顺着 section text 回调抛回宿主。 */
  let text = '';
  let threw = null;
  try {
    text = render();
  } catch (error) {
    threw = error;
  }
  assert.equal(threw, null, `render 不应抛错：${threw?.message}`);
  assert.equal(text, '', '损坏库的简报应是空段');

  /* 轮末召回同样不炸（内部已兜底），事件回调原样跑完。 */
  const turnEnd = calls.events.find(([name]) => name === 'session/event')[1];
  let eventThrew = null;
  try {
    turnEnd(session, { type: 'turn/end', turn: 9 });
  } catch (error) {
    eventThrew = error;
  }
  assert.equal(eventThrew, null, `turn/end 不应抛错：${eventThrew?.message}`);
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
if (failed > 0) {
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
