/**
 * dsh-memory 宿主半「激活」测试：假装自己是 cordis，把 apply() 真跑一遍。
 *   node test/activate.test.mjs
 *
 * 为什么要有这个套件：单个 bundle 激活失败会让整个 DSH 外壳起不来
 * （web 实例里 dsh-doctor 挂在 settingsScope 上就是这个后果），而 host.test.mjs 只测了
 * 导出与 Config。这里用假 ctx + 假 req/res 走完 apply() 的每一条注册路径，
 * 并验证注册出来的东西真的能用：模型工具能存取记忆、系统提示段真的产出简报、
 * webServer 路由真的应答、数据目录不可用时只告警不抛错。
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
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
 * 夹具：假 cordis 上下文 / 假 HTTP 请求响应
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

/**
 * 假 LLM 服务。块契约照抄 @deepseek-ai/dsh-llm 的 BlockAssembler：
 * block-start / text-delta / block-end / finish。每次调用把 options 记进 seen，
 * 方便断言 provider/model 路由确实跟着会话走。
 */
function fakeLlm(reply, seen = []) {
  return {
    stream(options) {
      seen.push(options);
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: reply.slice(0, 12) },
        { type: 'text-delta', index: 0, text: reply.slice(12) },
        { type: 'block-end', index: 0, block: { type: 'text', text: reply } },
        { type: 'finish', reason: { kind: 'stop' } },
      ];
      return (async function* stream() {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

/**
 * 依次吐出不同回复的假 LLM：用来测「第一次坏、第二次好」的重试路径。
 * 回复用完后一直重复最后一条。
 */
function seqLlm(replies, seen = []) {
  let index = 0;
  return {
    stream(options) {
      seen.push(options);
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: reply.slice(0, 12) },
        { type: 'text-delta', index: 0, text: reply.slice(12) },
        { type: 'block-end', index: 0, block: { type: 'text', text: reply } },
        { type: 'finish', reason: { kind: 'stop' } },
      ];
      return (async function* stream() {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

function makeReq({ method = 'GET', url = '/', body = '', headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress };
  req.destroy = () => {};
  // route() 在第一个 await 之前就同步挂好了 data/end 监听，所以这里可以立刻投递。
  queueMicrotask(() => {
    if (body) req.emit('data', Buffer.from(body, 'utf8'));
    req.emit('end');
  });
  return req;
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    text: '',
    setHeader(key, value) {
      res.headers[String(key).toLowerCase()] = String(value);
    },
    end(text) {
      res.text = String(text ?? '');
    },
  };
  return res;
}

/** 走一遍真实的 webServer handler，返回 {status, body}。 */
async function callRoute(handler, options) {
  const res = makeRes();
  await handler(makeReq(options), res);
  let body = null;
  try {
    body = JSON.parse(res.text);
  } catch {
    body = res.text;
  }
  return { status: res.statusCode, body };
}

async function listRecords(route, workspace) {
  const q = `?workspace=${encodeURIComponent(workspace)}`;
  const res = await callRoute(route, { url: `/memory/api/list${q}` });
  return res.body?.records || [];
}

/**
 * 假宿主跑一遍 `agent/pre-step`：把 claimed 交给插件的 waterfall 监听器，
 * `next()` 返回宿主的原生 decision（claimed 即「这一 step 要进入的批次」）。
 * 返回的就是宿主随后会落进会话、并发给模型的那份 decision。
 */
async function runPreStep(calls, payload) {
  const handler = calls.events.find(([name]) => name === 'agent/pre-step')[1];
  const claimed = payload.messages || [];
  const next = async () => ({ kind: 'enter', messages: claimed.slice() });
  return handler({ ...payload, messages: claimed }, next);
}

/**
 * 轮询等待一个异步条件成立。自动提炼是「发出去就不管」的后台任务，
 * 断言前必须等它自己跑完，不能靠固定 sleep 猜时间。
 */
async function waitFor(predicate, { timeout = 3000, step = 15 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-activate-'));
/* 版本号断言不写死——对着 package.json 比（bump 时不需要回来改测试）。 */
const pkgVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const workspace = path.join(tmp, 'workspace');
fs.mkdirSync(workspace, { recursive: true });

/** 每项测试都拿一份干净的插件实例（自己的数据目录 + 自己的假 ctx）。 */
function activate({ services = {}, briefingRebuildMinNew = 1, briefingRebuildCooldownMs = 0, ...config } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'data-'));
  const { ctx, calls } = createFakeCtx(services);
  // 启动整理 / 自动刷新画像默认关：这些用例测的是其它路径，不让后台整理在断言之间插进来。
  // 专项用例会显式传 autoDreamDays / autoPortraitHours 打开。
  // 简报重算闸默认关（1 条 / 0ms）：本套用例写一条就断言可见；闸本身由 briefing-stability 验证。
  mod.apply(ctx, {
    directory: dir,
    autoDreamDays: 0,
    autoPortraitHours: 0,
    briefingRebuildMinNew,
    briefingRebuildCooldownMs,
    ...config,
  });
  const tool = calls.tools[0];
  const route = calls.routes[0]?.handler;
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '插件 UI 想跟 DeepSeek 官网一个色调，用哪个蓝？'.repeat(3) }] },
    { role: 'assistant', content: [{ type: 'text', text: '用鲸鱼蓝 #4d6bfe，浅色深色都能用。'.repeat(3) }] },
  ];
  const session = {
    id: 'session-1',
    header: { cwd: workspace },
    requestHeader: () => ({ config: { provider: 'deepseek-account', model: 'deepseek-flash' } }),
    deriveMessages: () => messages,
  };
  const exec = { agent: { session }, callId: 'call-1', signal: undefined };
  return { ctx, calls, dir, tool, route, session, exec, messages };
}

const DISTILL_REPLY = JSON.stringify([
  {
    title: '插件基调用 DeepSeek 鲸鱼蓝',
    content: 'UI 视觉基调用 #4d6bfe，浅色与深色都成立。',
    category: 'preference',
    tags: ['ui', 'color'],
    confidence: 0.9,
  },
]);

/* ------------------------------------------------------------------ *
 * 测试
 * ------------------------------------------------------------------ */

await test('apply() 不抛错，工具 / 提示段 / 路由 / 事件都注册到位', () => {
  const { calls, tool, route } = activate();

  assert.equal(mod.name, 'dsh-memory');
  assert.deepEqual(mod.inject, ['tools']);

  assert.equal(calls.tools.length, 1);
  assert.equal(tool.name, 'memory');
  assert.equal(typeof tool.execute, 'function');
  // defineTool 在定义时就把简化 DSL 编译成 JSON Schema。
  assert.equal(tool.parameters.type, 'object');
  assert.equal(tool.parameters.properties.action.type, 'string');
  assert.deepEqual(
    tool.parameters.properties.action.enum,
    [
      'save',
      'search',
      'sessions',
      'promote',
      'derivations',
      'review',
      'distill-global',
      'list',
      'get',
      'update',
      'forget',
      'stats',
      'journal',
    ],
  );
  assert.ok(tool.parameters.required.includes('action'));

  assert.equal(calls.sections.length, 1);
  assert.equal(calls.sections[0].name, 'dsh-memory:workspace-briefing');
  assert.equal(typeof calls.sections[0].text, 'function');

  assert.equal(calls.routes.length, 1);
  assert.equal(calls.routes[0].kind, 'prefix');
  assert.equal(route && typeof route, 'function');

  assert.deepEqual(
    calls.events.map(([name]) => name).sort(),
    ['agent/pre-step', 'session/created', 'session/event', 'tools/pre-execute'],
  );
  assert.deepEqual(calls.injects.map((deps) => deps[0]).sort(), ['sessions', 'systemPrompt', 'webServer']);
  assert.deepEqual(calls.warn, []);
  assert.equal(calls.info.length, 1);
  assert.match(calls.info[0], /^dsh-memory ready \(dir=/);
});

await test('模型工具 save / search / list / stats 走真实 store 并落盘', async () => {
  const { tool, exec, dir } = activate();

  const saved = await tool.execute(
    {
      action: 'save',
      title: '用户偏好鲸鱼蓝',
      content: '插件 UI 视觉基调用 DeepSeek 鲸鱼蓝 #4d6bfe。',
      category: 'preference',
      tags: ['ui', 'color'],
    },
    exec,
  );
  assert.equal(saved.count, 1);
  assert.match(saved.text, /已保存记忆/);

  const id = /`(mem_[A-Za-z0-9_]+)`/.exec(saved.text)?.[1];
  assert.ok(id, '返回文本里应带记忆 id');

  const searched = await tool.execute({ action: 'search', query: '鲸鱼蓝' }, exec);
  assert.equal(searched.count, 1);
  assert.match(searched.text, /用户偏好鲸鱼蓝/);

  const listed = await tool.execute({ action: 'list', limit: 5 }, exec);
  assert.equal(listed.count, 1);

  const got = await tool.execute({ action: 'get', id }, exec);
  assert.equal(got.count, 1);
  assert.match(got.text, /#4d6bfe/);

  const stats = await tool.execute({ action: 'stats' }, exec);
  assert.match(stats.text, /本工作区 1 条/);
  // 主库里的存储文件和人看的镜像文件是两个路径，stats 不能把前者标成「镜像文件」。
  assert.match(stats.text, /本工作区存储：`[^`]*memories\.json`/);
  assert.match(stats.text, /镜像文件：`[^`]*\.dsh-memory[\\/]MEMORY\.md`/);

  const forgotten = await tool.execute({ action: 'forget', id }, exec);
  assert.equal(forgotten.count, 1);
  assert.match(forgotten.text, /已删除记忆/);
  assert.equal((await tool.execute({ action: 'list' }, exec)).count, 0);

  // 输出渲染契约：结构值走 UI，纯文本走模型。
  assert.deepEqual(tool.output.render({}, { action: 'list', count: 0, text: 'x' }), [{ type: 'text', text: 'x' }]);
  assert.ok(fs.existsSync(path.join(dir, 'index.json')) || fs.existsSync(dir));
});

await test('没有工作区目录时工具给的是可读提示，而不是抛错', async () => {
  const { tool } = activate();
  const result = await tool.execute({ action: 'stats' }, { agent: { session: { header: {} } } });
  assert.equal(result.count, 0);
  assert.match(result.text, /没有工作区目录/);
});

await test('会话一开始，系统提示段就带上本工作区的记忆简报', async () => {
  const { calls, tool, exec, session } = activate();

  // 会话建立 → activeWorkspace() 应该认到这个工作区。
  calls.events.find(([name]) => name === 'session/created')[1](session);
  const empty = calls.sections[0].text({ agent: { session } });
  assert.equal(typeof empty, 'string');

  await tool.execute(
    { action: 'save', title: '构建命令是 pnpm build', content: '改完客户端半要重跑 pnpm build。', category: 'convention' },
    exec,
  );
  const briefing = calls.sections[0].text({ agent: { session } });
  assert.equal(typeof briefing, 'string');
  assert.match(briefing, /构建命令是 pnpm build/);
  assert.match(briefing, /长期记忆/);
  // 装得下的时候不该出现「只列了…」的说明。
  assert.doesNotMatch(briefing, /只列了/);

  // 没有 agent 上下文（比如别处的渲染）也不能炸。
  assert.equal(typeof calls.sections[0].text(undefined), 'string');
});

await test('记忆装不下时，简报会说明「只列了几条」而不是假装列全了', async () => {
  // 把字数上限压到刚好只能放 3 条（briefing 的规则：至少 3 条，之后看字数）。
  // 关掉 dedupe，否则这 5 条太像会被合并成 1 条（那是另一条测试覆盖的行为）。
  // 截断说明只在全文模式里出现（索引模式一行一条，默认另测）。
  const { calls, tool, exec, session } = activate({
    briefingMaxChars: 260,
    briefingLimit: 12,
    dedupe: false,
    briefMode: 'full',
  });
  calls.events.find(([name]) => name === 'session/created')[1](session);

  for (let index = 0; index < 5; index += 1) {
    await tool.execute(
      {
        action: 'save',
        title: `约定 ${index}：${'长标题'.repeat(12)}`,
        content: '内容'.repeat(90),
        category: 'convention',
      },
      exec,
    );
  }

  const briefing = calls.sections[0].text({ agent: { session } });
  assert.match(briefing, /只列了最相关的 3 \/ 5 条/);
  assert.match(briefing, /action=list/);
});

await test('webServer 路由：state 认工作区、save 落库、list 回读', async () => {
  const { calls, route, session } = activate();
  calls.events.find(([name]) => name === 'session/created')[1](session);

  const state = await callRoute(route, { url: '/memory/api/state' });
  assert.equal(state.status, 200);
  assert.equal(state.body.ok, true);
  assert.equal(state.body.workspace.root, workspace);
  assert.equal(state.body.settings.briefing, true);
  assert.equal(state.body.version, pkgVersion);

  const saved = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/save',
    headers: { 'content-type': 'application/json', host: '127.0.0.1:19387' },
    body: JSON.stringify({ workspace, title: '面板写入', content: '从设置面板保存的记忆。', tags: ['panel'] }),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.ok, true);

  const list = await callRoute(route, { url: `/memory/api/list?workspace=${encodeURIComponent(workspace)}` });
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 1);
  assert.equal(list.body.records[0].title, '面板写入');
  assert.deepEqual(list.body.records[0].tags, ['panel']);
});

await test('webServer 路由：面板改设置会真的作用到工具行为', async () => {
  const { route, tool, exec } = activate();

  const off = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/settings',
    headers: { host: '127.0.0.1:19387' },
    body: JSON.stringify({ settings: { enabled: false, briefingLimit: 7 } }),
  });
  assert.equal(off.status, 200);
  assert.equal(off.body.settings.enabled, false);
  assert.equal(off.body.settings.briefingLimit, 7);
  assert.match((await tool.execute({ action: 'stats' }, exec)).text, /已在设置中关闭/);

  const on = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/settings',
    headers: { host: '127.0.0.1:19387' },
    body: JSON.stringify({ settings: { enabled: true } }),
  });
  assert.equal(on.body.settings.enabled, true);
  assert.match((await tool.execute({ action: 'stats' }, exec)).text, /本工作区 0 条/);
});

await test('webServer 路由守好边界：非本插件路径 404、不可信来源 403', async () => {
  const { route } = activate();

  const foreign = await callRoute(route, { url: '/plugins/dsh-memory/client.js', headers: { host: '127.0.0.1:19387' } });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.error, 'unknown_route');

  const remote = await callRoute(route, {
    url: '/memory/api/state',
    remoteAddress: '10.0.0.5',
    headers: { host: 'evil.example' },
  });
  assert.equal(remote.status, 403);
  assert.equal(remote.body.error, 'forbidden');

  // 非回环但 Host 在可信表里 → 放行。
  const trusted = await callRoute(route, {
    url: '/memory/api/ping',
    remoteAddress: '10.0.0.5',
    headers: { host: 'localhost:19387' },
  });
  assert.equal(trusted.status, 200);

  // 跨站 Origin 一律挡掉。
  const crossSite = await callRoute(route, {
    url: '/memory/api/state',
    headers: { host: '127.0.0.1:19387', origin: 'https://evil.example' },
  });
  assert.equal(crossSite.status, 403);
});

await test('webServer 路由：超过 4MB 的请求体回 413 payload_too_large（P3-1）', async () => {
  const { route } = activate();
  const big = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/save',
    headers: { host: '127.0.0.1:19387' },
    body: 'x'.repeat(5 * 1024 * 1024), // 5MB > 4MB 上限；非 JSON 也无妨——413 在解析前就该答
  });
  assert.equal(big.status, 413);
  assert.equal(big.body.ok, false);
  assert.equal(big.body.error, 'payload_too_large');

  // 限内请求不受影响（选不落库的 scan 端点）。
  const normal = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/security/scan',
    headers: { host: '127.0.0.1:19387' },
    body: JSON.stringify({ text: 'normal size body' }),
  });
  assert.equal(normal.status, 200);
});

await test('数据目录不可用时只告警，apply() 仍然不抛错（外壳不会被拖垮）', () => {
  const file = path.join(tmp, 'a-file-not-a-dir');
  fs.writeFileSync(file, 'x', 'utf8');

  const { ctx, calls } = createFakeCtx();
  assert.doesNotThrow(() => mod.apply(ctx, { directory: file }));
  assert.equal(calls.tools.length, 1);
  assert.equal(calls.warn.length, 1);
  assert.match(calls.warn[0], /无法创建数据目录/);

  // 工具照样可用，只是读不到/写不进数据。
  const tool = calls.tools[0];
  const exec = { agent: { session: { id: 's', header: { cwd: workspace } } } };
  assert.doesNotReject(() => tool.execute({ action: 'stats' }, exec));
});

await test('Config 的默认值落到运行时设置里，且能被 settings.json 覆盖', async () => {
  const { route, dir } = activate({ briefingLimit: 3, mirror: false });

  const state = await callRoute(route, { url: '/memory/api/state' });
  assert.equal(state.body.settings.briefingLimit, 3);
  assert.equal(state.body.settings.mirror, false);

  // 面板改动写进 <dir>/settings.json，重启后仍然生效。
  await callRoute(route, {
    method: 'POST',
    url: '/memory/api/settings',
    headers: { host: '127.0.0.1:19387' },
    body: JSON.stringify({ settings: { briefingMaxChars: 900 } }),
  });
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(stored.briefingMaxChars, 900);
  assert.equal(stored.briefingLimit, 3);
  assert.equal(stored.mirror, false);
});

await test('接了 llm 服务：粘贴文本提炼出候选，且不落库', async () => {
  const seen = [];
  const { calls, route, session } = activate({ services: { llm: fakeLlm(DISTILL_REPLY, seen) } });
  calls.events.find(([name]) => name === 'session/created')[1](session);

  const result = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/distill',
    headers: { host: '127.0.0.1:19387' },
    body: JSON.stringify({ workspace, text: '用户说插件想用 DeepSeek 官网的蓝色。' }),
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.candidates.length, 1);
  assert.equal(result.body.candidates[0].title, '插件基调用 DeepSeek 鲸鱼蓝');
  assert.equal(result.body.candidates[0].category, 'preference');
  assert.deepEqual(result.body.candidates[0].tags, ['ui', 'color']);

  // 路由跟着当前会话走的 provider/model，且带上会话 id 做归属。
  assert.equal(seen.length, 1);
  assert.equal(seen[0].provider, 'deepseek-account');
  assert.equal(seen[0].model, 'deepseek-flash');
  assert.equal(seen[0].sessionId, 'session-1');
  assert.equal(seen[0].messages[0].role, 'user');
  assert.ok(seen[0].system.length > 0);

  // 提炼只是预览，不该写进记忆。
  const list = await callRoute(route, { url: `/memory/api/list?workspace=${encodeURIComponent(workspace)}` });
  assert.equal(list.body.total, 0);
});

await test('接了 llm 服务：提炼当前会话会把候选真的落库，并记进提炼日志', async () => {
  const { calls, route, session } = activate({ services: { llm: fakeLlm(DISTILL_REPLY) } });
  calls.events.find(([name]) => name === 'session/created')[1](session);

  const result = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/capture',
    headers: { host: '127.0.0.1:19387' },
    body: JSON.stringify({ workspace }),
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.capture.ok, true);
  assert.equal(result.body.capture.saved, 1);
  assert.equal(result.body.capture.candidates, 1);
  assert.equal(result.body.stats.total, 1);

  const list = await callRoute(route, { url: `/memory/api/list?workspace=${encodeURIComponent(workspace)}` });
  assert.equal(list.body.total, 1);
  assert.equal(list.body.records[0].source, 'auto');
  assert.equal(list.body.records[0].category, 'preference');

  const state = await callRoute(route, { url: '/memory/api/state' });
  assert.equal(state.body.captures.length, 1);
  assert.equal(state.body.captures[0].reason, 'captured');
  assert.equal(state.body.captures[0].saved, 1);

  // 落库后简报里就会出现它 —— 这正是「下一轮开场模型就知道」的那条通路。
  const briefing = calls.sections[0].text({ agent: { session } });
  assert.match(briefing, /插件基调用 DeepSeek 鲸鱼蓝/);
});

await test('没接 llm 服务时，提炼路径给可读错误而不是崩外壳', async () => {
  const { calls, route, session } = activate();
  calls.events.find(([name]) => name === 'session/created')[1](session);

  const distilled = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/distill',
    headers: { host: '127.0.0.1:19387' },
    body: JSON.stringify({ workspace, text: '随便一段话。' }),
  });
  assert.equal(distilled.status, 500);
  assert.equal(distilled.body.error, 'handler_failed');
  assert.equal(distilled.body.detail.message, 'llm 服务不可用');

  const captured = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/capture',
    headers: { host: '127.0.0.1:19387' },
    body: JSON.stringify({ workspace }),
  });
  assert.equal(captured.status, 200);
  assert.equal(captured.body.capture.ok, false);
  assert.equal(captured.body.capture.reason, 'error');
  assert.equal(captured.body.capture.error, 'llm 服务不可用');

  // 失败也要留痕，面板上能看到「为什么没提炼出来」。
  const state = await callRoute(route, { url: '/memory/api/state' });
  assert.equal(state.body.captures[0].reason, 'error');
  assert.match(state.body.captures[0].error, /llm 服务不可用/);

  // 提炼失败不该影响正常读写。
  assert.equal((await callRoute(route, { url: `/memory/api/list?workspace=${encodeURIComponent(workspace)}` })).status, 200);
});

await test('轮次结束的自动提炼：默认关着，一次 LLM 都不调', async () => {
  const seen = [];
  const { calls, session } = activate({ services: { llm: fakeLlm(DISTILL_REPLY, seen) } });
  const onEvent = calls.events.find(([name]) => name === 'session/event')[1];

  assert.equal(onEvent(session, { type: 'turn/end' }), undefined);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(seen.length, 0, 'autoCapture 默认 false，不该烧 token');
});

await test('轮次结束的自动提炼：开着的时候后台真的落库', async () => {
  const { calls, route, session } = activate({
    services: { llm: fakeLlm(DISTILL_REPLY) },
    autoCapture: true,
    captureCooldownMs: 0,
    // 夹具对话只有一百多字，把门槛压下来才能走到 LLM（门槛本身由 distill 套件守着）。
    autoCaptureMinChars: 100,
  });
  const onEvent = calls.events.find(([name]) => name === 'session/event')[1];
  const q = `?workspace=${encodeURIComponent(workspace)}`;

  onEvent(session, { type: 'turn/end' });

  const landed = await waitFor(async () => {
    const list = await callRoute(route, { url: `/memory/api/list${q}` });
    return list.body.records.some((record) => record.source === 'auto');
  });
  assert.ok(landed, '后台提炼应该把候选落库');

  const list = await callRoute(route, { url: `/memory/api/list${q}` });
  const record = list.body.records.find((item) => item.source === 'auto');
  assert.equal(record.title, '插件基调用 DeepSeek 鲸鱼蓝');
  assert.equal(record.sessionId, 'session-1');
  assert.equal(record.useCount, 0, '刚沉淀不等于被使用');
  assert.equal(record.exposedCount, 0, '落库本身不算曝光');

  // 面板上的「最近提炼」也要能看到这次自动提炼。
  const state = await callRoute(route, { url: `/memory/api/state${q}` });
  assert.equal(state.body.captures[0].reason, 'captured');
  assert.equal(state.body.captures[0].saved, 1);
});

await test('轮次结束的自动提炼：对话太短就直接跳过，不烧 token', async () => {
  const seen = [];
  const { calls, route, session, messages } = activate({
    services: { llm: fakeLlm(DISTILL_REPLY, seen) },
    autoCapture: true,
    captureCooldownMs: 0,
  });
  messages.length = 0;
  messages.push({ role: 'user', content: [{ type: 'text', text: '今天天气' }] });

  const onEvent = calls.events.find(([name]) => name === 'session/event')[1];
  onEvent(session, { type: 'turn/end' });

  const logged = await waitFor(async () => {
    const state = await callRoute(route, { url: `/memory/api/state?workspace=${encodeURIComponent(workspace)}` });
    return state.body.captures.length > 0;
  });
  assert.ok(logged, '跳过也要留痕');
  assert.equal(seen.length, 0, '太短就不该调用 LLM');
  const state = await callRoute(route, { url: `/memory/api/state?workspace=${encodeURIComponent(workspace)}` });
  assert.equal(state.body.captures[0].reason, 'too_short');
});

await test('轮次结束的自动提炼：续跑发言不触发，白跑一次都不给', async () => {
  const seen = [];
  const { calls, route, session, messages } = activate({
    services: { llm: fakeLlm(DISTILL_REPLY, seen) },
    autoCapture: true,
    captureCooldownMs: 0,
    autoCaptureMinChars: 0,
  });
  messages.length = 0;
  messages.push({ role: 'user', content: [{ type: 'text', text: '继续' }] });
  const onEvent = calls.events.find(([name]) => name === 'session/event')[1];

  onEvent(session, { type: 'turn/end' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(seen.length, 0, '续跑发言不该调用模型');
  const state = await callRoute(route, { url: `/memory/api/state?workspace=${encodeURIComponent(workspace)}` });
  assert.equal(state.body.captures.length, 0, '连一条提炼日志都不该产生');
});

await test('轮次结束的自动提炼：0 候选后退避，下一轮不立刻再调', async () => {
  const seen = [];
  const { calls, route, session, messages } = activate({
    services: { llm: fakeLlm('[]', seen) },
    autoCapture: true,
    captureCooldownMs: 0,
    autoCaptureMinChars: 0,
  });
  const onEvent = calls.events.find(([name]) => name === 'session/event')[1];
  const q = `?workspace=${encodeURIComponent(workspace)}`;

  onEvent(session, { type: 'turn/end' });
  const first = await waitFor(async () => {
    const state = await callRoute(route, { url: `/memory/api/state${q}` });
    return state.body.captures.some((entry) => entry.candidates === 0);
  });
  assert.ok(first, '第一次提炼应真的调用模型并记 0 候选');
  assert.equal(seen.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));

  // 换一段内容再触发：冷却为 0，但 0 候选退避应挡住第二次调用。
  messages.length = 0;
  messages.push({
    role: 'user',
    content: [{ type: 'text', text: '这段对话里有没有值得长期记住的决策或约定？请检查一下。' }],
  });
  onEvent(session, { type: 'turn/end' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(seen.length, 1, '0 候选后下一轮不该立刻再调模型');
});

await test('轮次结束的自动提炼：LLM 卡住时轮次收尾照样立刻返回', () => {
  const stalling = { stream: () => (async function* stream() { await new Promise(() => {}); })() };
  const { calls, session } = activate({ services: { llm: stalling }, autoCapture: true, captureCooldownMs: 0 });
  const onEvent = calls.events.find(([name]) => name === 'session/event')[1];

  const started = Date.now();
  onEvent(session, { type: 'turn/end' });
  // 真的把 LLM await 在轮次收尾里的话，这里会永远回不来。
  assert.ok(Date.now() - started < 500, '不能同步等 LLM');
});

await test('轮次结束的自动提炼：LLM 报错时只记 reason=error，不影响读写', async () => {
  const boom = { stream: () => (async function* stream() { throw new Error('boom'); })() };
  const { calls, route, session } = activate({
    services: { llm: boom },
    autoCapture: true,
    captureCooldownMs: 0,
    autoCaptureMinChars: 100,
  });
  const q = `?workspace=${encodeURIComponent(workspace)}`;
  const onEvent = calls.events.find(([name]) => name === 'session/event')[1];

  onEvent(session, { type: 'turn/end' });

  const logged = await waitFor(async () => {
    const state = await callRoute(route, { url: `/memory/api/state${q}` });
    return state.body.captures.some((entry) => entry.reason === 'error');
  });
  assert.ok(logged, '失败要留痕：' + JSON.stringify(calls.warn));
  const list = await callRoute(route, { url: `/memory/api/list${q}` });
  assert.equal(list.status, 200);
  assert.equal(list.body.records.length, 0);
});

await test('镜像：面板保存的记忆真的落到工作区 .dsh-memory/MEMORY.md，关掉开关后撤回', async () => {
  const { calls, route } = activate();
  // 用独立工作区：本套件其它测试共用同一个目录，镜像会互相看见。
  const ws = path.join(tmp, 'mirror-workspace');
  fs.mkdirSync(ws, { recursive: true });
  // P2-1 白名单：显式 workspace 必须注册过（活跃会话或落过库的工作区）——
  // 先像真实流程一样在这个工作区里开一个会话。
  calls.events.find(([name]) => name === 'session/created')[1]({ id: 'mirror-ws-session', header: { cwd: ws } });
  const q = `?workspace=${encodeURIComponent(ws)}`;
  const mirrorFile = path.join(ws, '.dsh-memory', 'MEMORY.md');

  // 一开始还没有记忆：路径已经知道，但文件没生成、也没凭空造目录。
  const before = await callRoute(route, { url: `/memory/api/state${q}` });
  assert.equal(before.status, 200);
  assert.ok(before.body.mirror.workspaceFile.endsWith(path.join('.dsh-memory', 'MEMORY.md')));
  assert.equal(before.body.mirror.workspaceExists, false);
  assert.equal(fs.existsSync(mirrorFile), false);

  // 面板保存一条 → 主库与工作区镜像同时出现。
  const saved = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/save',
    body: JSON.stringify({ workspace: ws, title: '镜像落地', content: '这条应该出现在工作区镜像里。', tags: ['mirror'] }),
  });
  assert.equal(saved.status, 200);
  assert.equal(fs.existsSync(mirrorFile), true, '工作区镜像未生成');
  assert.match(fs.readFileSync(mirrorFile, 'utf8'), /镜像落地/);

  const after = await callRoute(route, { url: `/memory/api/state${q}` });
  assert.equal(after.body.mirror.workspaceExists, true);
  assert.equal(after.body.mirror.storageExists, true);

  // /mirror 端点同时给出两个路径与 markdown 预览。
  const mirror = await callRoute(route, { url: `/memory/api/mirror${q}` });
  assert.match(mirror.body.mirror.markdown, /镜像落地/);
  assert.equal(mirror.body.mirror.workspaceFile, mirrorFile);

  // 设置里关掉镜像 → 文件当场撤回，主库与旁车不受影响。
  const off = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/settings',
    body: JSON.stringify({ workspace: ws, settings: { mirror: false } }),
  });
  assert.equal(off.status, 200);
  assert.equal(off.body.settings.mirror, false);
  assert.equal(off.body.mirror.workspaceExists, false);
  assert.equal(fs.existsSync(mirrorFile), false, '关掉开关后工作区镜像该消失');
  assert.equal(fs.existsSync(path.join(ws, '.dsh-memory')), false, '空目录也应收掉');
  assert.equal((await callRoute(route, { url: `/memory/api/list${q}` })).body.total, 1);
});

await test('历史工作区补写：主库有记忆但项目里没有 .dsh-memory 时，打开项目就补上', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'backfill-'));
  const ws = fs.mkdtempSync(path.join(tmp, 'backfill-ws-'));

  // 前提：这条记忆是在镜像关着的状态下写进去的——主库有，工作区什么都没有。
  const seed = createMemoryStore({ dir, mirror: false });
  seed.upsert({ title: '历史约定', content: '这条是在镜像关着的时候写进去的。' }, { workspace: ws });
  assert.equal(fs.existsSync(path.join(ws, '.dsh-memory')), false, '前提：工作区里还没有目录');

  // 以镜像打开的状态激活，并模拟在这个项目里开会话。
  const { calls, session } = activate({ directory: dir, mirror: true });
  calls.events.find(([name]) => name === 'session/created')[1]({ ...session, header: { cwd: ws } });

  const md = path.join(ws, '.dsh-memory', 'MEMORY.md');
  assert.ok(fs.existsSync(md), '打开项目后应补写镜像');
  assert.match(fs.readFileSync(md, 'utf8'), /历史约定/);
  assert.ok(
    fs.existsSync(path.join(ws, '.dsh-memory', 'memory-snapshot.json')),
    '结构化快照也要一起补，否则换机器仍然合并不了',
  );
});

await test('历史工作区补写：主库没有记忆的项目不会被凭空建目录（D2）', async () => {
  const ws = fs.mkdtempSync(path.join(tmp, 'backfill-empty-'));
  const { calls, session } = activate({ mirror: true });
  calls.events.find(([name]) => name === 'session/created')[1]({ ...session, header: { cwd: ws } });
  assert.equal(fs.existsSync(path.join(ws, '.dsh-memory')), false, '空库不该造目录');
});

await test('既有记忆导入：扫描本机来源 → 按来源导入 → 真的落库', async () => {
  const { calls, route } = activate();
  const ws = path.join(tmp, 'import-workspace');
  const home = path.join(tmp, 'import-home');
  // P2-1 白名单：先注册工作区（在这个工作区里开一个会话），显式 workspace 才可用。
  calls.events.find(([name]) => name === 'session/created')[1]({ id: 'import-ws-session', header: { cwd: ws } });
  fs.mkdirSync(path.join(ws, '.workbuddy', 'memory'), { recursive: true });
  fs.mkdirSync(path.join(home, '.qoder', 'memory'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, '.workbuddy', 'memory', 'MEMORY.md'),
    '# dsh 工作区 — 项目长期笔记\n\n## 环境坑\n\n- 改 profile 前必须备份。\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(home, '.qoder', 'memory', 'user-delivery-expectations.md'),
    '---\nname: user-delivery-expectations\ndescription: 用户与交付期望\nmetadata:\n  type: user\n---\n\n要真跑的权重。\n',
    'utf8',
  );
  // 让扫描器去找这个临时 home。
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const scan = await callRoute(route, { url: `/memory/api/import-scan?workspace=${encodeURIComponent(ws)}` });
    assert.equal(scan.status, 200);
    const byId = new Map(scan.body.scan.sources.map((source) => [source.id, source]));
    assert.equal(byId.get('workspace-workbuddy').exists, true);
    assert.equal(byId.get('user-qoder').exists, true);

    const imported = await callRoute(route, {
      method: 'POST',
      url: '/memory/api/import-scan',
      body: JSON.stringify({ workspace: ws, sources: ['workspace-workbuddy', 'user-qoder'] }),
    });
    assert.equal(imported.status, 200);
    assert.equal(imported.body.imported.added, 2);

    const list = await callRoute(route, { url: `/memory/api/list?workspace=${encodeURIComponent(ws)}` });
    const titles = list.body.records.map((record) => record.title).sort();
    assert.deepEqual(titles, ['用户与交付期望', '环境坑'].sort());
    // 用户级来源进全局库，工作区级进本工作区库。
    assert.equal(list.body.records.find((r) => r.title === '环境坑').scope, 'workspace');
    // 注册会话后 activeWorkspace 指向本工作区，无参 /list 会带出工作区条目——
    // 这里要看的是「用户级来源进全局库」，用 scope=global 过滤。
    const global = await callRoute(route, { url: '/memory/api/list?scope=global' });
    assert.equal(global.body.records.length, 1);
    assert.equal(global.body.records[0].scope, 'global');
    // 来源文件是只读的：导入不改动它们。
    assert.match(fs.readFileSync(path.join(ws, '.workbuddy', 'memory', 'MEMORY.md'), 'utf8'), /改 profile 前必须备份/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
  }
});

await test('索引模式简报（默认）：一行一条带 id、不展开正文、页脚提示验证', async () => {
  const { calls, tool, exec, session } = activate();
  calls.events.find(([name]) => name === 'session/created')[1](session);
  await tool.execute(
    { action: 'save', title: '索引模式的记忆', content: '这条正文不该出现在索引简报里。'.repeat(3), category: 'fact' },
    exec,
  );
  const briefing = calls.sections[0].text({ agent: { session } });
  assert.match(briefing, /索引模式的记忆/, '索引应有标题');
  // 日期戳：供模型在注入时判断新旧。必须来自 createdAt，不能是 updatedAt（后者会被 markUsed 刷）。
  const line = briefing.split('\n').find((item) => item.includes('索引模式的记忆')) || '';
  assert.match(line, /^- (?:\S+ )?\d{4}-\d{2}-\d{2} \[/, '索引行应以日期戳开头');
  const stamp = /\d{4}-\d{2}-\d{2}/.exec(line)?.[0] || '';
  const localDay = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const expectedDays = new Set([localDay(new Date()), localDay(new Date(Date.now() - 86400000))]);
  assert.ok(expectedDays.has(stamp), `日期戳应是创建当天（实际 ${stamp}）`);
  assert.match(briefing, /`mem_[A-Za-z0-9_]+`/, '索引应带 id 供按需取正文');
  assert.doesNotMatch(briefing, /这条正文不该出现在索引简报里/, '索引模式不该展开正文');
  assert.match(briefing, /上面是索引/);
  assert.match(briefing, /先验证它们现在还存在/, '页脚应有验证式过期提示');
  // full 模式仍展开正文。
  const { calls: fullCalls, tool: fullTool, exec: fullExec, session: fullSession } = activate({ briefMode: 'full' });
  fullCalls.events.find(([name]) => name === 'session/created')[1](fullSession);
  await fullTool.execute({ action: 'save', title: '全文模式的记忆', content: '全文正文在这里。', category: 'fact' }, fullExec);
  assert.match(fullCalls.sections[0].text({ agent: { session: fullSession } }), /全文正文在这里。/);
});

await test('路径 JIT：工具触达 files 挂靠的文件时，相关记忆在下一个 pre-step 尾部注入', async () => {
  const { calls, tool, exec, session, route } = activate({ briefing: false, turnRecall: false });
  calls.events.find(([name]) => name === 'session/created')[1](session);
  await tool.execute(
    {
      action: 'save',
      title: '存储层分库约定',
      content: '每个工作区一个 memories.json；改存储层前先看这个文件。',
      category: 'convention',
      files: ['lib/store.js'],
    },
    exec,
  );

  /* 工具触达挂靠文件：pre-execute 只观察（原样放行 next()），把路径记进 stash。 */
  const preExecute = calls.events.find(([name]) => name === 'tools/pre-execute')[1];
  const passthrough = Symbol('passthrough');
  const released = await preExecute(
    { agent: { session }, name: 'read', args: { path: `${workspace}/lib/store.js` } },
    async () => passthrough,
  );
  assert.equal(released, passthrough, 'pre-execute 不拥有决策，必须原样放行 next()');

  /* 下一个 pre-step：路径召回作为尾部消息进入本 step。 */
  const userMessage = { role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } };
  const entered = await runPreStep(calls, { agent: { session }, messages: [userMessage], turn: 1, step: 2 });
  assert.equal(entered.messages.length, 2, '路径召回应作为一条额外消息进入本 step');
  assert.equal(entered.messages[0], userMessage, '被认领的消息保持原样在前');
  const tail = entered.messages[1];
  assert.equal(tail.source.kind, 'dsh-memory');
  assert.equal(tail.source.form, 'path-recall');
  assert.ok(
    tail.source.files.some((file) => /lib[\\/]+store\.js$/.test(file)),
    '触达的 store.js 应进入召回批次',
  );
  const tailText = tail.content.map((block) => block.text).join('');
  assert.match(tailText, /相关记忆（按文件触达）/);
  assert.match(tailText, /只是背景参考/, '路径召回同样要写清是背景参考');
  assert.match(tailText, /存储层分库约定/);

  const recalled = (await listRecords(route, workspace)).find((r) => r.title === '存储层分库约定');
  assert.equal(recalled.exposedCount, 1, '路径 JIT 注入应记曝光');
  assert.equal(recalled.useCount, 0, '曝光不是使用');

  /* 同一次触达只注入一次：stash 已弹出，后续 pre-step 不再带出。 */
  const again = await runPreStep(calls, {
    agent: { session },
    messages: [{ role: 'user', content: [{ type: 'text', text: '再继续' }], source: { kind: 'user' } }],
    turn: 1,
    step: 3,
  });
  assert.equal(again.messages.length, 1, '同一次文件触达不该重复注入');

  /* 触达没有挂靠记忆的文件：不出额外消息。 */
  await preExecute(
    { agent: { session }, name: 'read', args: { path: `${workspace}/README.md` } },
    async () => null,
  );
  const clean = await runPreStep(calls, {
    agent: { session },
    messages: [{ role: 'user', content: [{ type: 'text', text: '换文件' }], source: { kind: 'user' } }],
    turn: 1,
    step: 4,
  });
  assert.equal(clean.messages.length, 1, '没有命中时不注入');
});

await test('会话索引与溯源：turn/end 落原文，action=sessions 搜回原话', async () => {
  const { calls, tool, exec, session } = activate({ briefing: false, turnRecall: false });
  calls.events.find(([name]) => name === 'session/created')[1](session);
  const onEvent = calls.events.find(([name]) => name === 'session/event')[1];
  session.deriveMessages = () => [
    { role: 'user', content: [{ type: 'text', text: '我们决定检索层用 BM25F 加 RRF 融合' }] },
    { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
  ];
  onEvent(session, { type: 'turn/end', turn: 3 });

  const hit = await tool.execute({ action: 'sessions', query: 'BM25F 融合' }, exec);
  assert.ok(hit.text.includes('BM25F'), '应搜回当轮原话');
  assert.ok(hit.text.includes('turn 3'), '应带轮次');

  const miss = await tool.execute({ action: 'sessions', query: '完全不相关的长颈鹿话题' }, exec);
  assert.equal(miss.count, 0, '无命中时明说');
});

await test('程序记忆晋升：action=promote 写进 AGENTS.md 托管块，重复晋升幂等', async () => {
  const { tool, exec } = activate({ briefing: false });
  const saved = await tool.execute(
    { action: 'save', title: '发版前先跑测试', content: '改完任何一半都要重跑全部断言。', category: 'convention' },
    exec,
  );
  const id = (saved.text.match(/`([^`]+)`/) || [])[1];
  assert.ok(id, 'save 的返回文本里应带新记忆 id');

  const promoted = await tool.execute({ action: 'promote', id }, exec);
  assert.match(promoted.text, /已晋升进/);
  const agentsMd = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8');
  assert.match(agentsMd, /发版前先跑测试/);
  assert.match(agentsMd, /dsh-memory:promoted 开始/);

  const again = await tool.execute({ action: 'promote', id }, exec);
  assert.match(again.text, /已晋升进/);
  const twice = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8');
  assert.equal((twice.match(/发版前先跑测试/g) || []).length, 1, '重复晋升不产生重复行');

  const global = await tool.execute(
    { action: 'save', title: '全局偏好', content: '全局内容', category: 'preference', scope: 'global' },
    exec,
  );
  const globalId = (global.text.match(/`([^`]+)`/) || [])[1];
  const refused = await tool.execute({ action: 'promote', id: globalId }, exec);
  assert.match(refused.text, /不晋升/, 'global 记忆应拒绝晋升');

  const junk = await tool.execute(
    { action: 'save', title: '一条笔记', content: '普通笔记', category: 'note' },
    exec,
  );
  const junkId = (junk.text.match(/`([^`]+)`/) || [])[1];
  const notPromotable = await tool.execute({ action: 'promote', id: junkId }, exec);
  assert.match(notPromotable.text, /只有 convention/);
});

await test('压缩协同：compaction/summary 把摘要照录进工作日志', async () => {
  const { calls, route, session } = activate({ briefing: false, autoCapture: false });
  calls.events.find(([name]) => name === 'session/created')[1](session);
  const onEvent = calls.events.find(([name]) => name === 'session/event')[1];

  onEvent(session, { type: 'compaction/summary', data: { summary: '本轮敲定检索层用 BM25F' } });
  const read1 = await callRoute(route, { method: 'GET', url: '/memory/api/journal?days=1' });
  const text1 = (read1.body?.recent || []).map((item) => item.text).join('\n');
  assert.match(text1, /上下文已压缩；压缩摘要（原文照录）：本轮敲定检索层用 BM25F/);

  onEvent(session, { type: 'compaction/prune' });
  const read2 = await callRoute(route, { method: 'GET', url: '/memory/api/journal?days=1' });
  const text2 = (read2.body?.recent || []).map((item) => item.text).join('\n');
  assert.match(text2, /上下文已压缩；压缩前的结论如未写进记忆或日志/);
});

await test('轮末召回改走尾部注入：系统提示里没有召回，agent/pre-step 每轮只注入一次', async () => {
  const { calls, tool, exec, session } = activate({ briefing: false });
  const onEvent = calls.events.find(([name]) => name === 'session/event')[1];
  calls.events.find(([name]) => name === 'session/created')[1](session);
  await tool.execute(
    { action: 'save', title: '构建命令是 pnpm build', content: '改完客户端半要重跑 pnpm build。', category: 'convention' },
    exec,
  );

  // 当轮用户消息提到构建 → 命中该记忆 → 缓冲给下一轮。
  session.deriveMessages = () => [
    { role: 'user', content: [{ type: 'text', text: '帮我跑一下构建命令，然后告诉我结果' }] },
    { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
  ];
  onEvent(session, { type: 'turn/end' });

  // 系统提示段里不再有召回块——它已经挪到尾部注入。
  const sectionText = calls.sections[0].text({ agent: { session } });
  assert.equal(sectionText, '', '简报关着时系统提示段就是空的');
  assert.doesNotMatch(sectionText, /与当前话题相关的召回/);

  // 下一轮 step 1：召回作为一条额外的 user 消息折进进入批次（紧跟被认领的消息）。
  const userMessage = { role: 'user', content: [{ type: 'text', text: '那构建产物在哪' }], source: { kind: 'user' } };
  const entered = await runPreStep(calls, { agent: { session }, messages: [userMessage], turn: 2, step: 1 });
  assert.equal(entered.messages.length, 2, '召回应作为一条额外消息进入本 step');
  assert.equal(entered.messages[0], userMessage, '被认领的消息保持原样在前');
  const tail = entered.messages[1];
  assert.equal(tail.role, 'user');
  assert.equal(tail.source.kind, 'dsh-memory');
  assert.equal(tail.source.form, 'turn-recall');
  assert.equal(tail.source.turn, 2);
  const tailText = tail.content.map((block) => block.text).join('');
  assert.match(tailText, /与当前话题相关的召回/);
  assert.match(tailText, /只是背景参考/, '尾部注入要写清是背景参考');
  assert.match(tailText, /构建命令是 pnpm build/);
  assert.match(tailText, /改完客户端半要重跑/, '召回块带正文摘录');

  // 同一轮的后续 step 不再重复注入。
  const step2 = await runPreStep(calls, {
    agent: { session },
    messages: [{ role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }],
    turn: 2,
    step: 2,
  });
  assert.equal(step2.messages.length, 1, '同一轮第二次 pre-step 不该再注入');

  // 连续第二轮同样的话题：上轮已召回的不重复注入。
  onEvent(session, { type: 'turn/end' });
  const third = await runPreStep(calls, {
    agent: { session },
    messages: [{ role: 'user', content: [{ type: 'text', text: '构建又挂了' }], source: { kind: 'user' } }],
    turn: 3,
    step: 1,
  });
  assert.equal(third.messages.length, 1, '连续两轮不该重复召回同一条');
  assert.doesNotMatch(calls.sections[0].text({ agent: { session } }), /与当前话题相关的召回/);

  // 中间隔一个无关轮，再回到同一话题：本会话已经注入过的记忆仍不重复占位。
  session.deriveMessages = () => [
    { role: 'user', content: [{ type: 'text', text: '今天天气怎么样' }] },
    { role: 'assistant', content: [{ type: 'text', text: '晴' }] },
  ];
  onEvent(session, { type: 'turn/end' });
  const fourth = await runPreStep(calls, {
    agent: { session },
    messages: [{ role: 'user', content: [{ type: 'text', text: '那出门要不要带伞' }], source: { kind: 'user' } }],
    turn: 4,
    step: 1,
  });
  assert.equal(fourth.messages.length, 1, '无关轮不该带召回');

  session.deriveMessages = () => [
    { role: 'user', content: [{ type: 'text', text: '构建命令再跑一次' }] },
    { role: 'assistant', content: [{ type: 'text', text: '好' }] },
  ];
  onEvent(session, { type: 'turn/end' });
  const fifth = await runPreStep(calls, {
    agent: { session },
    messages: [{ role: 'user', content: [{ type: 'text', text: '构建结果呢' }], source: { kind: 'user' } }],
    turn: 5,
    step: 1,
  });
  assert.equal(fifth.messages.length, 1, '本会话已召回过的记忆不该在隔轮后重复注入');
});

await test('轮末召回：总字符上限 500，放不下的条目不注入', async () => {
  const { calls, tool, exec, session } = activate({
    briefing: false,
    dedupe: false,
    turnRecallLimit: 3,
    turnRecallMaxChars: 500,
  });
  const onEvent = calls.events.find(([name]) => name === 'session/event')[1];
  calls.events.find(([name]) => name === 'session/created')[1](session);
  for (let index = 0; index < 3; index += 1) {
    await tool.execute(
      {
        action: 'save',
        title: `构建约定 ${index}`,
        content: `构建命令是 pnpm build。第 ${index} 条细节：${'不要跳过客户端构建。'.repeat(20)}`,
        category: 'convention',
      },
      exec,
    );
  }
  session.deriveMessages = () => [
    { role: 'user', content: [{ type: 'text', text: '构建命令怎么跑，pnpm build 吗' }] },
    { role: 'assistant', content: [{ type: 'text', text: '是' }] },
  ];
  onEvent(session, { type: 'turn/end' });

  const entered = await runPreStep(calls, {
    agent: { session },
    messages: [{ role: 'user', content: [{ type: 'text', text: '构建产物在哪' }], source: { kind: 'user' } }],
    turn: 2,
    step: 1,
  });
  assert.equal(entered.messages.length, 2, '应注入一条召回消息');
  const tailText = entered.messages[1].content.map((block) => block.text).join('');
  assert.ok(tailText.includes('构建约定'), '至少保留一条命中');
  assert.ok(tailText.length <= 500, `召回块应受 500 字符上限约束，实际 ${tailText.length}`);
});

await test('门控：autoInject=false 只停注入、工具照常；停用工作区连召回都不排', async () => {
  /* 1) 总闸关掉：简报空，但 memory 工具照常读写（「只用工具」档）。 */
  const off = activate({ autoInject: false });
  off.calls.events.find(([name]) => name === 'session/created')[1](off.session);
  await off.tool.execute(
    { action: 'save', title: '总闸关掉仍可写', content: '注入关了，工具照常读写。', category: 'fact' },
    off.exec,
  );
  assert.equal(
    off.calls.sections[0].text({ agent: { session: off.session } }),
    '',
    'autoInject=false 时不注入任何正文（不是注一段空的）',
  );
  const found = await off.tool.execute({ action: 'search', query: '总闸关掉仍可写' }, off.exec);
  assert.equal(found.count, 1, '注入关掉不影响工具读写');

  /* 2) 停用工作区：简报空 + 轮末不排召回 + 工具仍可手动检索。 */
  const blocked = activate({ disabledWorkspaces: [workspace] });
  const onEvent = blocked.calls.events.find(([name]) => name === 'session/event')[1];
  blocked.calls.events.find(([name]) => name === 'session/created')[1](blocked.session);
  await blocked.tool.execute(
    {
      action: 'save',
      title: '停用工作区里的构建约定',
      content: '构建命令是 pnpm build；这个工作区在停用名单里，不该被自动注入。',
      category: 'convention',
    },
    blocked.exec,
  );
  assert.equal(
    blocked.calls.sections[0].text({ agent: { session: blocked.session } }),
    '',
    '停用工作区不注入简报',
  );

  blocked.session.deriveMessages = () => [
    { role: 'user', content: [{ type: 'text', text: '帮我跑一下构建命令，然后告诉我结果' }] },
    { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
  ];
  onEvent(blocked.session, { type: 'turn/end' });
  const entered = await runPreStep(blocked.calls, {
    agent: { session: blocked.session },
    messages: [{ role: 'user', content: [{ type: 'text', text: '那构建产物在哪' }], source: { kind: 'user' } }],
    turn: 2,
    step: 1,
  });
  assert.equal(entered.messages.length, 1, '停用工作区连轮末召回都不排');

  const manual = await blocked.tool.execute({ action: 'search', query: '构建约定' }, blocked.exec);
  assert.equal(manual.count, 1, '停用只挡自动路径，手动检索照常');
});

await test('轮末召回：排期不等于曝光，真正注入时才记 exposedCount', async () => {
  const { calls, tool, exec, session, route } = activate({ briefing: false, autoCapture: false });
  const onEvent = calls.events.find(([name]) => name === 'session/event')[1];
  calls.events.find(([name]) => name === 'session/created')[1](session);
  const saved = await tool.execute(
    { action: 'save', title: '构建命令是 pnpm build', content: '改完客户端半要重跑 pnpm build。', category: 'convention' },
    exec,
  );
  const id = /`(mem_[A-Za-z0-9_]+)`/.exec(saved.text)?.[1];

  session.deriveMessages = () => [
    { role: 'user', content: [{ type: 'text', text: '帮我跑一下构建命令，然后告诉我结果' }] },
    { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
  ];
  onEvent(session, { type: 'turn/end' });

  const scheduled = (await listRecords(route, workspace)).find((r) => r.id === id);
  assert.equal(scheduled.exposedCount, 0, '只是排期、还没注入，不该算曝光');
  assert.equal(scheduled.useCount, 0, '排期更不该算使用');

  const userMessage = { role: 'user', content: [{ type: 'text', text: '那构建产物在哪' }], source: { kind: 'user' } };
  const entered = await runPreStep(calls, { agent: { session }, messages: [userMessage], turn: 2, step: 1 });
  assert.equal(entered.messages.length, 2, '召回应该真的注入');

  const injected = (await listRecords(route, workspace)).find((r) => r.id === id);
  assert.equal(injected.exposedCount, 1, '真正进入 prompt 才记曝光');
  assert.equal(injected.useCount, 0, '曝光不能冒充使用');
});

await test('搜索只记曝光，get 记打开，assistant 引用 id 记 cited', async () => {
  const { calls, tool, exec, session, route } = activate({
    briefing: false,
    turnRecall: false,
    autoCapture: false,
  });
  const onEvent = calls.events.find(([name]) => name === 'session/event')[1];
  calls.events.find(([name]) => name === 'session/created')[1](session);

  const saved = await tool.execute(
    { action: 'save', title: '检索计数约定', content: '搜索命中只算看见，读过或引用才算使用。', category: 'convention' },
    exec,
  );
  const id = /`(mem_[A-Za-z0-9_]+)`/.exec(saved.text)?.[1];

  await tool.execute({ action: 'search', query: '检索计数' }, exec);
  const afterSearch = (await listRecords(route, workspace)).find((r) => r.id === id);
  assert.equal(afterSearch.exposedCount, 1);
  assert.equal(afterSearch.useCount, 0);
  assert.equal(afterSearch.openedCount, 0);

  const got = await tool.execute({ action: 'get', id }, exec);
  assert.match(got.text, /打开 1/);
  assert.match(got.text, /引用 0/);
  const afterGet = (await listRecords(route, workspace)).find((r) => r.id === id);
  assert.equal(afterGet.openedCount, 1);
  assert.equal(afterGet.useCount, 1);

  session.deriveMessages = () => [
    { role: 'assistant', content: [{ type: 'text', text: `结论见 ${id}。` }] },
  ];
  onEvent(session, { type: 'turn/end' });
  const afterCite = (await listRecords(route, workspace)).find((r) => r.id === id);
  assert.equal(afterCite.citedCount, 1);
  assert.equal(afterCite.useCount, 2);
});

await test('注入审计：简报与尾部召回都留下可复算的字节、hash 与取舍', async () => {
  const { calls, tool, exec, session, route } = activate({ autoCapture: false, briefingLimit: 1 });
  const onEvent = calls.events.find(([name]) => name === 'session/event')[1];
  calls.events.find(([name]) => name === 'session/created')[1](session);
  const q = `?workspace=${encodeURIComponent(workspace)}`;

  await tool.execute(
    { action: 'save', title: '审计用的记忆甲', content: '这条记忆用来验证注入审计确实记下了进 prompt 的字节。', category: 'fact' },
    exec,
  );

  calls.sections[0].text({ agent: { session } });
  calls.sections[0].text({ agent: { session } });

  let entries = (await callRoute(route, { url: `/memory/api/injections${q}` })).body.entries;
  assert.equal(entries.length, 1, '同一会话冻结后不应重复记账');
  assert.equal(entries[0].kind, 'briefing');
  assert.equal(entries[0].hash.length, 16);
  assert.ok(entries[0].chars > 0);
  assert.ok(entries[0].preview.includes('工作区长期记忆'), '审计应能看到真正注入的正文');
  assert.ok(entries[0].ids.length >= 1, '审计应记下带了哪些记忆 id');

  /* 简报已冻结：之后新增的记忆不在简报里，才可能被尾部召回带出去。 */
  await tool.execute(
    { action: 'save', title: '审计用的记忆乙', content: '这条在简报冻结之后写入，只有尾部召回才会带上它。', category: 'fact' },
    exec,
  );
  session.deriveMessages = () => [
    { role: 'user', content: [{ type: 'text', text: '帮我看看审计用的记忆乙' }] },
    { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
  ];
  onEvent(session, { type: 'turn/end' });
  const userMessage = { role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } };
  await runPreStep(calls, { agent: { session }, messages: [userMessage], turn: 2, step: 1 });

  entries = (await callRoute(route, { url: `/memory/api/injections${q}` })).body.entries;
  const kinds = entries.map((entry) => entry.kind);
  assert.ok(kinds.includes('turn-recall'), `应有尾部召回审计，实际=${kinds.join(',')}`);
  const tail = entries.find((entry) => entry.kind === 'turn-recall');
  assert.equal(tail.hash.length, 16);
  assert.ok(tail.ids.length >= 1, '尾部召回应记下 id');
});

await test('captureMode=draft：自动提炼先进队列，批准后才生效', async () => {
  const { calls, route, session } = activate({
    services: { llm: fakeLlm(DISTILL_REPLY) },
    autoCapture: true,
    captureMode: 'draft',
    captureCooldownMs: 0,
    autoCaptureMinChars: 100,
  });
  const onEvent = calls.events.find(([name]) => name === 'session/event')[1];
  const q = `?workspace=${encodeURIComponent(workspace)}`;

  onEvent(session, { type: 'turn/end' });

  const queued = await waitFor(async () => {
    const queue = await callRoute(route, { url: `/memory/api/queue${q}` });
    return queue.body.records.length > 0;
  });
  assert.ok(queued, '草稿应进待审队列');
  const draft = (await callRoute(route, { url: `/memory/api/queue${q}` })).body.records[0];
  assert.equal(draft.status, 'draft');

  // 草稿不进默认列表（不进简报、不进检索是同一道过滤）。
  const list = await callRoute(route, { url: `/memory/api/list${q}` });
  assert.equal(list.body.records.length, 0);
  // 提炼日志记 reason=drafted，与直接落库区分。
  const state = await callRoute(route, { url: `/memory/api/state${q}` });
  assert.equal(state.body.captures[0].reason, 'drafted');

  const approved = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/queue/approve',
    headers: { 'content-type': 'application/json', host: '127.0.0.1:19387' },
    body: JSON.stringify({ id: draft.id }),
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.record.status, 'active');

  const listAfter = await callRoute(route, { url: `/memory/api/list${q}` });
  assert.equal(listAfter.body.records.length, 1, '批准后进默认列表');
  assert.equal(listAfter.body.records[0].title, '插件基调用 DeepSeek 鲸鱼蓝');
});

await test('工具 save 带 supersedes：旧条归档，get 展示版本链', async () => {
  const { tool, exec } = activate();
  const old = await tool.execute(
    { action: 'save', title: '旧构建结论', content: '用 webpack 构建', category: 'decision' },
    exec,
  );
  const oldId = /`(mem_[A-Za-z0-9_]+)`/.exec(old.text)?.[1];
  assert.ok(oldId);

  const sup = await tool.execute(
    { action: 'save', title: '新构建结论', content: '改用 vite 构建', category: 'decision', supersedes: oldId },
    exec,
  );
  assert.match(sup.text, /归档被推翻的旧记忆/);

  const newId = /`(mem_[A-Za-z0-9_]+)`/.exec(sup.text)?.[1];
  const got = await tool.execute({ action: 'get', id: newId }, exec);
  assert.match(got.text, /推翻了/, 'get 应展示版本链');

  const listed = await tool.execute({ action: 'list' }, exec);
  assert.equal(listed.count, 1, '旧条归档后 list 只剩新条');
});

/* ------------------------------------------------------------------ *
 * 画像层（portrait）：注入、冻结、API
 * ------------------------------------------------------------------ */

await test('portrait 模式：简报里画像全量在前、索引清单在后', async () => {
  const { calls, tool, exec, session, route } = activate({ briefMode: 'portrait' });
  calls.events.find(([name]) => name === 'session/created')[1](session);

  /* 先没有画像也没有记录：简报为空但不炸。 */
  assert.equal(calls.sections[0].text({ agent: { session } }), '');

  const saved = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/save',
    body: JSON.stringify({
      workspace,
      scope: 'global',
      sections: [
        { key: 'background', text: '这是画像背景段落。' },
        { key: 'focus', text: '这是画像关注段落。' },
      ],
    }),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.portrait.version, 1);

  await tool.execute(
    { action: 'save', title: '画像模式下的普通条目', content: '正文。', category: 'fact' },
    exec,
  );

  /* 画像对 session-1 已冻结（当时为空），换新会话看新文本。 */
  const briefing = calls.sections[0].text({ agent: { session: { ...session, id: 'session-2' } } });
  assert.match(briefing, /### 全局画像（v1）/);
  assert.match(briefing, /这是画像背景段落。/);
  assert.match(briefing, /画像模式下的普通条目/, '索引清单也要在');
});

await test('portrait 快照：首次渲染为空，画像落库后的下一次渲染即生效并重新冻结', async () => {
  const { calls, route, session } = activate({ briefMode: 'portrait' });
  calls.events.find(([name]) => name === 'session/created')[1](session);

  /* 第一次渲染即冻结（此刻画像为空）。 */
  const first = calls.sections[0].text({ agent: { session } });
  assert.equal(first, '');

  await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/save',
    body: JSON.stringify({ workspace, scope: 'global', sections: [{ key: 'background', text: '会话一之后写入。' }] }),
  });

  /* 画像真的变了 → 下一次渲染重算一次（内容变了就该生效）。 */
  const again = calls.sections[0].text({ agent: { session } });
  assert.match(again, /会话一之后写入。/, '画像落库后下一次渲染应带上它');

  /* 重算之后再冻结：连续两次渲染逐字节相同。 */
  assert.equal(calls.sections[0].text({ agent: { session } }), again, '重新冻结后必须逐字节稳定');

  /* 新会话同样看得到。 */
  assert.match(
    calls.sections[0].text({ agent: { session: { ...session, id: 'session-fresh' } } }),
    /会话一之后写入。/,
  );
});

await test('portrait 快照：重写后重算一次，之后继续逐字节稳定（前缀缓存不受持续影响）', async () => {
  const { calls, route, session } = activate({ briefMode: 'portrait' });
  calls.events.find(([name]) => name === 'session/created')[1](session);

  await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/save',
    body: JSON.stringify({ workspace, scope: 'global', sections: [{ key: 'background', text: '第一版画像。' }] }),
  });
  const a = calls.sections[0].text({ agent: { session } });
  assert.match(a, /第一版画像。/);
  assert.equal(calls.sections[0].text({ agent: { session } }), a, '没有任何写入时逐字节稳定');

  await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/save',
    body: JSON.stringify({ workspace, scope: 'global', sections: [{ key: 'background', text: '第二版画像。' }] }),
  });
  const b = calls.sections[0].text({ agent: { session } });
  assert.match(b, /第二版画像。/, '重写是一次真实写入，下一次渲染应带上新版本');
  assert.notEqual(b, a, '内容变了，文本当然会变');
  assert.equal(calls.sections[0].text({ agent: { session } }), b, '重算之后重新冻结，后续请求逐字节相同');
});

await test('portrait API：GET 读取、save 版本递增、history 降序、坏请求 400', async () => {
  const { calls, route, session } = activate();
  calls.events.find(([name]) => name === 'session/created')[1](session);

  const empty = await callRoute(route, { url: '/memory/api/portrait' });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.workspace, null);
  assert.equal(empty.body.global, null);
  assert.equal(empty.body.sectionDefs.length, 4);

  const save1 = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/save',
    body: JSON.stringify({ workspace, sections: [{ key: 'focus', text: '一。' }] }),
  });
  assert.equal(save1.body.portrait.version, 1);

  const save2 = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/save',
    body: JSON.stringify({ workspace, sections: [{ key: 'focus', text: '二。' }] }),
  });
  assert.equal(save2.body.portrait.version, 2);

  const globalSave = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/save',
    body: JSON.stringify({ workspace, scope: 'global', sections: [{ key: 'preference', text: '全局段。' }] }),
  });
  assert.equal(globalSave.body.portrait.scope, 'global');

  const read = await callRoute(route, { url: '/memory/api/portrait' });
  assert.equal(read.body.workspace.version, 2);
  assert.equal(read.body.workspace.sections.find((s) => s.key === 'focus').text, '二。');
  assert.equal(read.body.global.version, 1);
  assert.equal(read.body.global.sections.find((s) => s.key === 'preference').text, '全局段。');

  const history = await callRoute(route, { url: '/memory/api/portrait/history' });
  assert.equal(history.body.history[0].version, 2);
  assert.equal(history.body.history[0].current, true);
  assert.equal(history.body.history[1].version, 1);

  const bad = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/save',
    body: JSON.stringify({ workspace }),
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'bad_sections');
});

await test('portrait 预览：/briefing-preview 给出画像计量并排除画像条目', async () => {
  const { calls, route, session } = activate({ briefMode: 'portrait' });
  calls.events.find(([name]) => name === 'session/created')[1](session);

  await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/save',
    body: JSON.stringify({ workspace, scope: 'global', sections: [{ key: 'background', text: '预览用背景。' }] }),
  });
  await callRoute(route, {
    method: 'POST',
    url: '/memory/api/save',
    body: JSON.stringify({ workspace, title: '画像条目样例', content: 'x', tags: ['portrait'], pinned: true }),
  });
  await callRoute(route, {
    method: 'POST',
    url: '/memory/api/save',
    body: JSON.stringify({ workspace, title: '普通条目样例', content: 'y' }),
  });

  const preview = await callRoute(route, { url: '/memory/api/briefing-preview' });
  assert.equal(preview.body.preview.mode, 'portrait');
  assert.ok(preview.body.preview.portrait.chars > 0, '画像计量应为正');
  assert.ok(!preview.body.preview.titles.includes('画像条目样例'), '画像条目不应进清单');
  assert.ok(preview.body.preview.titles.includes('普通条目样例'), '普通条目应在清单');
});

/* ------------------------------------------------------------------ *
 * M1：日志层 / 记忆纪律 / 画像重写管线
 * ------------------------------------------------------------------ */

const REWRITE_REPLY = JSON.stringify({
  sections: [
    { key: 'background', text: '重写后的背景。' },
    { key: 'focus', text: '重写后的关注。' },
  ],
  evidence: { background: ['journal:2026-10-20'], focus: [] },
});

await test('工具 journal：写一条、再读回来；空文本拒绝', async () => {
  const { tool, exec } = activate();
  const w = await tool.execute({ action: 'journal', text: '完成了 M1 日志层。' }, exec);
  assert.match(w.text, /已写入工作日志/);
  assert.equal(w.count, 1);
  const r = await tool.execute({ action: 'journal' }, exec);
  assert.match(r.text, /完成了 M1 日志层。/);
  const empty = await tool.execute({ action: 'journal', text: '   ' }, exec);
  assert.match(empty.text, /内容为空/);
});

await test('工具 derivations：列出派生链，源失效后标脏', async () => {
  const { calls, route, session, tool, exec } = activate();
  calls.events.find(([name]) => name === 'session/created')[1](session);
  const saved = await tool.execute(
    {
      action: 'save',
      title: '派生源条目',
      content: '这条正文足够长，不会被质量闸门归档，也不会被当成元记忆。',
      category: 'convention',
    },
    exec,
  );
  const id = /`(mem_[A-Za-z0-9_]+)`/.exec(saved.text)?.[1];
  assert.ok(id, '保存后应返回记忆 id');
  await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/save',
    body: JSON.stringify({
      workspace,
      sections: [{ key: 'preference', text: '派生段落' }],
      evidence: { preference: [id] },
    }),
  });

  const fresh = await tool.execute({ action: 'derivations' }, exec);
  assert.match(fresh.text, /派生链/);
  assert.match(fresh.text, /仍成立/);

  await tool.execute({ action: 'update', id, archived: true }, exec);
  const dirty = await tool.execute({ action: 'derivations' }, exec);
  assert.match(dirty.text, /已失效/);
});

await test('工具 review：列出到期项，标记后不再到期', async () => {
  const { tool, exec } = activate();
  const saved = await tool.execute(
    {
      action: 'save',
      title: '该复审的条目',
      content: '这条正文足够长，不会被质量闸门归档，也不会被当成元记忆。',
      category: 'decision',
      falsifier: '当接口变了这条就不成立',
      reviewAt: new Date(Date.now() - 86400000).toISOString(),
    },
    exec,
  );
  const id = /`(mem_[A-Za-z0-9_]+)`/.exec(saved.text)?.[1];
  assert.ok(id, '保存后应返回记忆 id');

  const list = await tool.execute({ action: 'review' }, exec);
  assert.match(list.text, /该复审的条目/);
  assert.match(list.text, /当接口变了这条就不成立/);

  const marked = await tool.execute({ action: 'review', id }, exec);
  assert.match(marked.text, /已复审/);
  const after = await tool.execute({ action: 'review' }, exec);
  assert.match(after.text, /没有到期/);
});

await test('工具 promote from=portrait：把画像段写进 AGENTS.md', async () => {
  const { calls, route, session, tool, exec } = activate();
  calls.events.find(([name]) => name === 'session/created')[1](session);
  await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/save',
    body: JSON.stringify({
      workspace,
      sections: [{ key: 'preference', text: '工具晋升的画像约定。' }],
    }),
  });

  const res = await tool.execute({ action: 'promote', from: 'portrait', section: 'preference' }, exec);
  assert.match(res.text, /已把画像/);
  const agents = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8');
  assert.match(agents, /工具晋升的画像约定/);
});

await test('记忆纪律：默认注入；discipline=false 时不出现', async () => {
  /* 正文要够长：store 的质量闸门会归档「自动/agent 来源 + 低质量」的新条目，
     而 tool.save 的来源就是 agent——测试数据得像一条真记忆。 */
  const good = {
    action: 'save',
    title: '记纪律用的样例记忆',
    content: '这条正文足够长，不会被质量闸门归档，也不会被当成元记忆。',
    category: 'fact',
  };
  const a1 = activate();
  a1.calls.events.find(([name]) => name === 'session/created')[1](a1.session);
  await a1.tool.execute(good, a1.exec);
  const withDiscipline = a1.calls.sections[0].text({ agent: { session: a1.session } });
  assert.match(withDiscipline, /记忆纪律/);
  assert.match(withDiscipline, /action=journal/);
  assert.match(withDiscipline, /记住/);

  const a2 = activate({ discipline: false });
  a2.calls.events.find(([name]) => name === 'session/created')[1](a2.session);
  await a2.tool.execute({ ...good, title: '记纪律用的样例记忆（二）' }, a2.exec);
  const without = a2.calls.sections[0].text({ agent: { session: a2.session } });
  assert.doesNotMatch(without, /记忆纪律/);
});

await test('画像重写 direct：落库版本 +1，提示词里带日志原料', async () => {
  const seen = [];
  const { calls, route, session, tool, exec } = activate({ services: { llm: fakeLlm(REWRITE_REPLY, seen) } });
  calls.events.find(([name]) => name === 'session/created')[1](session);
  await tool.execute({ action: 'journal', text: '重写原料日志。' }, exec);
  await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/save',
    body: JSON.stringify({ workspace, sections: [{ key: 'background', text: '旧背景。' }] }),
  });

  const res = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/rewrite',
    body: JSON.stringify({ workspace, scope: 'workspace' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.drafted, false);
  assert.equal(res.body.portrait.version, 2);
  assert.equal(res.body.portrait.sections.find((s) => s.key === 'background').text, '重写后的背景。');
  assert.deepEqual(res.body.portrait.evidence.background, ['journal:2026-10-20'], '重写的证据应落库');
  assert.equal(res.body.portrait.sectionMeta.background.untraced, false);
  assert.equal(res.body.portrait.sectionMeta.focus.untraced, true, '没有证据的段标未溯源');

  const prompt = seen.at(-1)?.messages?.[0]?.content?.[0]?.text || '';
  assert.match(prompt, /重写原料日志。/, '提示词应包含日志原料');
});

await test('画像重写：没有会话请求头时回落到宿主默认模型', async () => {
  const seen = [];
  const { calls, route } = activate({
    services: {
      llm: fakeLlm(REWRITE_REPLY, seen),
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-pro' }),
      },
    },
  });
  /* 会话登记过工作区、但还没产生任何请求头：模拟宿主刚启动、面板直接点「重写」。
     此时路由链的前三级全空，只能靠宿主的默认模型。 */
  const bare = {
    id: 'session-bare-1',
    header: { cwd: workspace },
    requestHeader: () => ({}),
  };
  calls.events.find(([name]) => name === 'session/created')[1](bare);
  await callRoute(route, {
    method: 'POST',
    url: '/memory/api/save',
    body: JSON.stringify({
      workspace,
      title: '默认模型回落的原料',
      content: '这条正文足够长，不会被质量闸门归档，也不会被当成元记忆。',
      category: 'fact',
      source: 'manual',
    }),
  });

  const res = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/rewrite',
    body: JSON.stringify({ workspace, scope: 'workspace' }),
  });
  assert.equal(res.status, 200, `应回落到默认模型，实际：${JSON.stringify(res.body)}`);
  assert.equal(seen.at(-1)?.provider, 'deepseek-account');
  assert.equal(seen.at(-1)?.model, 'deepseek-pro');
});

await test('画像重写：连默认模型都没有时，错误明细是一句可操作的话', async () => {
  const seen = [];
  const { calls, route } = activate({ services: { llm: fakeLlm(REWRITE_REPLY, seen) } });
  const bare = {
    id: 'session-bare-2',
    header: { cwd: workspace },
    requestHeader: () => ({}),
  };
  calls.events.find(([name]) => name === 'session/created')[1](bare);
  await callRoute(route, {
    method: 'POST',
    url: '/memory/api/save',
    body: JSON.stringify({
      workspace,
      title: '空路由的原料',
      content: '这条正文足够长，不会被质量闸门归档，也不会被当成元记忆。',
      category: 'fact',
      source: 'manual',
    }),
  });

  const res = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/rewrite',
    body: JSON.stringify({ workspace, scope: 'workspace' }),
  });
  assert.equal(res.status, 500);
  assert.equal(res.body.error, 'no_model_route');
  assert.equal(typeof res.body.detail, 'string', 'detail 必须是字符串，面板才能直接展示');
  assert.match(res.body.detail, /模型/);
  assert.equal(seen.length, 0, '没有路由时不应该调用模型');
});

await test('画像重写（全局）：原料里要带得上全局条目，不只是日志', async () => {
  const seen = [];
  const { calls, route, session, tool, exec } = activate({ services: { llm: fakeLlm(REWRITE_REPLY, seen) } });
  calls.events.find(([name]) => name === 'session/created')[1](session);
  await tool.execute(
    {
      action: 'save',
      title: '全局画像的重写原料',
      content: '这条是全局条目，正文足够长，不该被质量闸门拦掉。',
      category: 'preference',
      scope: 'global',
    },
    exec,
  );

  const res = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/rewrite',
    body: JSON.stringify({ workspace, scope: 'global' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true, `全局重写应能拿到原料，实际：${JSON.stringify(res.body)}`);

  const prompt = seen.at(-1)?.messages?.[0]?.content?.[0]?.text || '';
  assert.match(prompt, /全局画像的重写原料/, '提示词应包含全局条目');
});

await test('画像重写 draft：全局稿进待审 → 批准后生效 → 重复批准 404', async () => {
  const { calls, route, session } = activate({ services: { llm: fakeLlm(REWRITE_REPLY) } });
  calls.events.find(([name]) => name === 'session/created')[1](session);
  await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/save',
    body: JSON.stringify({ workspace, scope: 'global', sections: [{ key: 'background', text: '旧背景。' }] }),
  });

  const res = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/rewrite',
    body: JSON.stringify({ workspace, scope: 'global', mode: 'draft' }),
  });
  assert.equal(res.body.drafted, true);
  assert.equal(res.body.sections.find((s) => s.key === 'background').text, '重写后的背景。');

  const state = await callRoute(route, { url: '/memory/api/portrait' });
  assert.equal(state.body.draft, true, '面板只展示全局画像，待审稿也应是全局的');
  assert.equal(state.body.global.version, 1, '批准前全局画像不变');

  const draft = await callRoute(route, { url: '/memory/api/portrait/draft?scope=global' });
  assert.equal(draft.body.draft.sections.find((s) => s.key === 'background').text, '重写后的背景。');
  assert.deepEqual(
    draft.body.draft.evidence?.background || [],
    [],
    '全局稿只保留全局作用域能对账的证据（虚构 journal 应被过滤）',
  );

  const approve = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/draft/approve',
    body: JSON.stringify({ workspace, scope: 'global' }),
  });
  assert.equal(approve.status, 200);
  assert.equal(approve.body.portrait.version, 2);

  const after = await callRoute(route, { url: '/memory/api/portrait' });
  assert.equal(after.body.draft, false);
  assert.equal(after.body.global.sections.find((s) => s.key === 'background').text, '重写后的背景。');
  assert.deepEqual(after.body.global.evidence?.background || [], [], '全局稿证据只保留可对账的来源');

  const again = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/draft/approve',
    body: JSON.stringify({ workspace, scope: 'global' }),
  });
  assert.equal(again.status, 404, '没有待审稿时应 404');
});

await test('自动刷新画像：轮末把当前工作区近况写进全局画像，并在间隔内不重复调用', async () => {
  const seen = [];
  const { calls, route, session, tool, exec } = activate({
    autoPortraitHours: 6,
    services: { llm: fakeLlm(REWRITE_REPLY, seen) },
  });
  calls.events.find(([name]) => name === 'session/created')[1](session);
  await tool.execute(
    {
      action: 'save',
      title: '自动刷新原料条目',
      content: '这条工作区近况应该被自动画像重写读进全局画像。',
      category: 'preference',
    },
    exec,
  );

  const onEvent = calls.events.find(([name]) => name === 'session/event')[1];
  onEvent(session, { type: 'turn/end', turn: 1 });

  const deadline = Date.now() + 8000;
  let st = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    st = await callRoute(route, { url: '/memory/api/portrait' });
    if (st.body?.global?.version >= 1) break;
  }
  assert.equal(seen.length, 1, '应自动调用一次模型');
  assert.equal(st.body.global.version, 1, '全局画像应自动写入 v1');
  assert.equal(
    st.body.global.sections.find((s) => s.key === 'background')?.text,
    '重写后的背景。',
  );
  const prompt = seen[0]?.messages?.[0]?.content?.[0]?.text || '';
  assert.match(prompt, /Scope: global/, '自动刷新应写全局画像');
  assert.match(prompt, /自动刷新原料条目/, '应吸收当前工作区近况');
  assert.equal(st.body.workspace, null, '不应顺带写工作区画像');

  /* 6 小时节流：紧接着再结束一轮，不应再调用模型。 */
  onEvent(session, { type: 'turn/end', turn: 2 });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(seen.length, 1, '间隔内不应重复调用模型');
});

await test('画像重写：第一次没按 JSON 输出时用严格提示重试一次，然后照常落库', async () => {
  const seen = [];
  const { calls, route, session } = activate({
    services: { llm: seqLlm(['抱歉，我先说一句：这是重写后的背景。', REWRITE_REPLY], seen) },
  });
  calls.events.find(([name]) => name === 'session/created')[1](session);
  await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/save',
    body: JSON.stringify({ workspace, sections: [{ key: 'background', text: '旧背景。' }] }),
  });

  const res = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/rewrite',
    body: JSON.stringify({ workspace, scope: 'workspace' }),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.equal(seen.length, 2, '第一次解析失败应只重试一次');
  assert.match(seen[1].system, /could not be parsed/i, '重试要换成严格 JSON 提示');
  assert.equal(res.body.drafted, false);
  assert.equal(res.body.degraded, 'none');
  assert.equal(res.body.portrait.sections.find((s) => s.key === 'background').text, '重写后的背景。');
});

await test('画像重写：两次都解析不了时给出可读明细（不是只丢一个 no_json）', async () => {
  const seen = [];
  const { calls, route, session } = activate({
    services: { llm: seqLlm(['抱歉，无法完成这个请求。'], seen) },
  });
  calls.events.find(([name]) => name === 'session/created')[1](session);
  await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/save',
    body: JSON.stringify({ workspace, sections: [{ key: 'background', text: '旧背景。' }] }),
  });

  const res = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/rewrite',
    body: JSON.stringify({ workspace, scope: 'workspace' }),
  });
  assert.equal(res.status, 500);
  assert.equal(res.body.ok, false);
  assert.equal(seen.length, 2, '失败也要重试一次，不能只试一把');
  assert.match(res.body.detail, /解析失败/, '明细要能读懂');
  assert.match(res.body.detail, /没有按 JSON 输出/, 'no_json 要翻成人话');

  /* 失败也要留痕：宿主日志里得有这次失败的摘要（脱敏后）。 */
  const warned = calls.warn.filter((line) => /画像重写解析失败/.test(String(line)));
  assert.ok(warned.length >= 1, '失败要在宿主日志里留摘要');
});

await test('画像重写：输出被截断时不直写，改送待审等人确认', async () => {
  const seen = [];
  const truncated = '{"sections":[{"key":"background","text":"- 半句话';
  const { calls, route, session } = activate({ services: { llm: seqLlm([truncated], seen) } });
  calls.events.find(([name]) => name === 'session/created')[1](session);
  await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/save',
    body: JSON.stringify({ workspace, scope: 'global', sections: [{ key: 'background', text: '旧背景。' }] }),
  });

  const res = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/portrait/rewrite',
    body: JSON.stringify({ workspace, scope: 'global' }),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.degraded, 'truncated');
  assert.equal(res.body.drafted, true, '有损输出不能直写，得进待审');
  assert.equal(seen.length, 1, '能解析出来就不必重试');

  const state = await callRoute(route, { url: '/memory/api/portrait' });
  assert.equal(state.body.draft, true, '待审稿应在');
  assert.equal(state.body.global.version, 1, '批准前画像不变');
});

await test('journal API：写与读、空文本 400、指定日期校验', async () => {
  const { calls, route, session } = activate();
  calls.events.find(([name]) => name === 'session/created')[1](session);
  const w = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/journal',
    body: JSON.stringify({ workspace, text: 'API 写的日志。' }),
  });
  assert.equal(w.status, 200);
  const r = await callRoute(route, { url: '/memory/api/journal' });
  assert.ok(Array.isArray(r.body.dates));
  assert.match(r.body.recent[0].text, /API 写的日志。/);
  const bad = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/journal',
    body: JSON.stringify({ workspace, text: '' }),
  });
  assert.equal(bad.status, 400);
  const badDate = await callRoute(route, { url: '/memory/api/journal?date=20x5-13-99' });
  assert.equal(badDate.status, 400);
});

await test('启动整理：打开 DSH 后自动合并重复簇、写台账并留快照', async () => {
  const { calls, tool, exec, session, dir, route } = activate({
    autoDreamDays: 7,
    autoDreamPortrait: false,
    dedupe: false,
  });
  await tool.execute(
    { action: 'save', title: '启动整理重复甲', content: '启动整理相同的正文内容' },
    exec,
  );
  await tool.execute(
    { action: 'save', title: '启动整理重复乙', content: '启动整理相同的正文内容' },
    exec,
  );
  const before = await tool.execute({ action: 'stats' }, exec);
  assert.match(before.text, /本工作区 2 条/);

  /* 打开会话（真实宿主就是「打开 DSH → 建立会话」）→ 600ms 后自动整理一次。 */
  calls.events.find(([name]) => name === 'session/created')[1](session);

  const deadline = Date.now() + 8000;
  let maintenance = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 60));
    const res = await callRoute(route, { url: '/memory/api/health' });
    maintenance = res.body?.health?.maintenance || null;
    if (maintenance?.lastAutoAt) break;
  }
  assert.ok(maintenance?.lastAutoAt, '启动整理应写维护台账');
  assert.ok(maintenance.lastReport?.merged >= 1, '应合并重复簇');
  assert.equal(maintenance.lastReport?.portrait, null, '画像重写关掉时不应触发');

  const after = await tool.execute({ action: 'stats' }, exec);
  assert.match(after.text, /本工作区 1 条/);
  assert.match(after.text, /归档 2/);
  const snapshots = fs.readdirSync(path.join(dir, 'backups'));
  assert.ok(
    snapshots.some((name) => name.endsWith('-auto-dream')),
    '整理前应留一份 auto-dream 快照',
  );
});

await test('二级蒸馏：distill-global 动作是模型自己的时机入口，当场产候选并晋升', async () => {
  const reply = JSON.stringify([
    {
      text: '对外素材一律使用构造数据并标注来源',
      category: 'feedback',
      topics: ['privacy'],
      anchors: ['m1', 'm2'],
    },
  ]);
  const { tool, exec, session, calls, route } = activate({ services: { llm: seqLlm([reply]) } });
  calls.events.find(([name]) => name === 'session/created')[1](session);

  await tool.execute(
    { action: 'save', title: '用户拒绝真实截图', content: '不要用真实记忆面板截图，可能泄露用户数据。', category: 'feedback' },
    exec,
  );
  await tool.execute(
    { action: 'save', title: '失败方案别重复', content: '已判负的路线不要一句话拒绝，换新口径公平复测。', category: 'feedback' },
    exec,
  );
  await tool.execute(
    { action: 'save', title: '结论要自测', content: '审查结论必须自己重跑代码与数据给数字，不复述文档。', category: 'decision' },
    exec,
  );

  const result = await tool.execute({ action: 'distill-global' }, exec);
  assert.equal(result.count, 1, '应提炼出 1 条候选原则');
  assert.match(result.text, /提炼出 1 条候选原则/);
  assert.match(result.text, /本次晋升 1 条全局记忆/, 'feedback 是用户亲口说的，单项目就该晋升');

  const health = await callRoute(route, {
    url: `/memory/api/health?workspace=${encodeURIComponent(workspace)}`,
  });
  const info = health.body.health.globalDistill;
  assert.equal(info.lastResult, 'added', '成功也要落台账');
  assert.equal(info.lastAdded, 1);
  assert.equal(info.emptyStreak, 0, '有产出应把空跑计数清零');
});

await test('二级蒸馏：重复表述不新增候选时，不把连续空跑计数清零', async () => {
  const reply = JSON.stringify([
    {
      text: '对外素材一律使用构造数据并标注来源',
      category: 'feedback',
      topics: ['privacy'],
      anchors: ['m1', 'm2'],
    },
  ]);
  const { tool, exec, session, calls, route } = activate({ services: { llm: seqLlm([reply]) } });
  calls.events.find(([name]) => name === 'session/created')[1](session);
  const materials = [
    ['用户拒绝真实数据截图', '不要用真实数据截图，文档与演示一律使用构造数据并标注来源。', 'feedback'],
    ['失败方案要公平复测', '已判负的路线不要一句话拒绝，换新口径公平复测后再下结论。', 'feedback'],
    ['结论必须自测', '审查结论必须自己重跑代码与数据给出数字，不复述文档里的说法。', 'decision'],
  ];
  for (const [title, content, category] of materials) {
    await tool.execute({ action: 'save', title, content, category }, exec);
  }

  const first = await tool.execute({ action: 'distill-global' }, exec);
  assert.equal(first.count, 1, '第一次应新增候选');
  const second = await tool.execute({ action: 'distill-global' }, exec);
  assert.equal(second.count, 0);
  assert.match(second.text, /没有新的候选原则/);
  assert.match(second.text, /重复跳过 1 条/);

  const health = await callRoute(route, {
    url: `/memory/api/health?workspace=${encodeURIComponent(workspace)}`,
  });
  const info = health.body.health.globalDistill;
  assert.equal(info.lastResult, 'duplicate');
  assert.equal(info.emptyStreak, 1, '没有新增 = 没有进展，应进入退避');
  assert.equal(info.intervalMinutes, 30, '空跑一次后间隔翻倍到 30 分钟');
});

await test('轮末自动二级蒸馏：素材攒够后自动跑一次并落候选池', async () => {
  const captureReply = JSON.stringify([
    { title: '自动蒸馏素材甲', content: '用户纠正了甲行为，要求先验证再下结论。', category: 'feedback', tags: [], confidence: 0.9 },
    { title: '自动蒸馏素材乙', content: '用户纠正了乙行为，要求先备份再动手。', category: 'feedback', tags: [], confidence: 0.9 },
    { title: '自动蒸馏素材丙', content: '用户纠正了丙行为，要求后台任务失败要冷却。', category: 'feedback', tags: [], confidence: 0.9 },
  ]);
  const globalReply = JSON.stringify([
    {
      text: '改动前先备份并验证，再下结论',
      category: 'feedback',
      topics: ['backup', 'verification'],
      anchors: ['m1'],
    },
  ]);
  const { calls, route, session } = activate({
    services: { llm: seqLlm([captureReply, globalReply]) },
    autoCapture: true,
    captureCooldownMs: 0,
    autoCaptureMinChars: 100,
  });
  const onEvent = calls.events.find(([name]) => name === 'session/event')[1];
  onEvent(session, { type: 'turn/end' });

  const q = `?workspace=${encodeURIComponent(workspace)}`;
  const done = await waitFor(async () => {
    const health = await callRoute(route, { url: `/memory/api/health${q}` });
    return health.body.health.globalDistill.lastResult === 'added';
  });
  assert.ok(done, '轮末应自动跑一次二级蒸馏并落候选');

  const health = await callRoute(route, { url: `/memory/api/health${q}` });
  const info = health.body.health.globalDistill;
  assert.ok(info.lastMaterials >= 3, '应带上刚提炼出的 3 条素材');
  assert.ok(
    (health.body.health.candidates?.pending ?? 0) + (health.body.health.candidates?.promoted ?? 0) >= 1,
    '候选应进池（或已当场晋升）',
  );
});

await test('二级蒸馏：空产出时把原因写进台账，面板能看出是「模型回空」', async () => {
  const { tool, exec, session, calls, route, dir } = activate({ services: { llm: seqLlm(['[]']) } });
  calls.events.find(([name]) => name === 'session/created')[1](session);
  const materials = [
    ['用户拒绝真实数据截图', '不要用真实数据截图，文档与演示一律使用构造数据并标注来源。', 'feedback'],
    ['失败方案要公平复测', '已判负的路线不要一句话拒绝，换新口径公平复测后再下结论。', 'feedback'],
    ['结论必须自测', '审查结论必须自己重跑代码与数据给出数字，不复述文档里的说法。', 'decision'],
  ];
  for (const [title, content, category] of materials) {
    await tool.execute({ action: 'save', title, content, category }, exec);
  }

  const result = await tool.execute({ action: 'distill-global' }, exec);
  assert.equal(result.count, 0);
  assert.match(result.text, /没有给出合格原则/);
  assert.match(result.text, /empty/, '应说明是模型回了空数组');

  const health = await callRoute(route, {
    url: `/memory/api/health?workspace=${encodeURIComponent(workspace)}`,
  });
  const info = health.body.health.globalDistill;
  assert.equal(info.lastResult, 'no_candidate');
  assert.equal(info.lastReason, 'empty');
  assert.equal(info.lastMaterials, 3);
  assert.equal(info.lastParsed, 0);
  assert.equal(info.lastAdded, 0);
  assert.equal(info.attempts, 1);
  assert.equal(info.emptyStreak, 1, '空跑要累加，供指数退避用');

  const folders = fs.readdirSync(path.join(dir, 'workspaces')).filter((name) => name !== '_global');
  assert.ok(
    fs.existsSync(path.join(dir, 'workspaces', folders[0], 'global-distill.json')),
    '台账应落盘（宿主重启后仍能显示）',
  );
});

await test('二级蒸馏：候选全被准入挡掉时，台账记下拒绝原因与原文', async () => {
  const reply = JSON.stringify([
    { text: '这条 decision 只有一个锚点会被挡掉', category: 'decision', topics: ['d'], anchors: ['m1'] },
    { text: '这条没有主题词的原则也会被挡掉', category: 'feedback', topics: [], anchors: ['m2'] },
  ]);
  const { tool, exec, session, calls, route } = activate({ services: { llm: seqLlm([reply]) } });
  calls.events.find(([name]) => name === 'session/created')[1](session);
  const materials = [
    ['用户拒绝真实数据截图', '不要用真实数据截图，文档与演示一律使用构造数据并标注来源。', 'feedback'],
    ['失败方案要公平复测', '已判负的路线不要一句话拒绝，换新口径公平复测后再下结论。', 'feedback'],
    ['结论必须自测', '审查结论必须自己重跑代码与数据给出数字，不复述文档里的说法。', 'decision'],
  ];
  for (const [title, content, category] of materials) {
    await tool.execute({ action: 'save', title, content, category }, exec);
  }

  const result = await tool.execute({ action: 'distill-global' }, exec);
  assert.match(result.text, /all_rejected/, '应说明是候选被准入挡掉，而不是模型回空');
  assert.match(result.text, /few-anchors×1/);
  assert.match(result.text, /no-topics×1/);

  const health = await callRoute(route, {
    url: `/memory/api/health?workspace=${encodeURIComponent(workspace)}`,
  });
  const info = health.body.health.globalDistill;
  assert.equal(info.lastReason, 'all_rejected');
  assert.equal(info.lastParsed, 2);
  assert.equal(info.lastRejects['few-anchors'], 1);
  assert.equal(info.lastRejects['no-topics'], 1);
  assert.match(info.lastExcerpt, /decision 只有一个锚点/, '空产出要留脱敏摘要供排查');
});

await test('二级蒸馏：整理不再顺带蒸馏——时机交给模型与轮末，不是定时任务', async () => {
  const reply = JSON.stringify([
    {
      text: '这条原则不该在整理时被自动提炼出来',
      category: 'feedback',
      topics: ['privacy'],
      anchors: ['m1'],
    },
  ]);
  const { tool, exec, session, calls, route } = activate({ services: { llm: seqLlm([reply]) } });
  calls.events.find(([name]) => name === 'session/created')[1](session);
  await tool.execute(
    { action: 'save', title: '素材一', content: '第一条素材，正文足够长以便通过准入检查。', category: 'feedback' },
    exec,
  );
  await tool.execute(
    { action: 'save', title: '素材二', content: '第二条素材，正文足够长以便通过准入检查。', category: 'feedback' },
    exec,
  );
  await tool.execute(
    { action: 'save', title: '素材三', content: '第三条素材，正文足够长以便通过准入检查。', category: 'decision' },
    exec,
  );

  const dream = await callRoute(route, {
    method: 'POST',
    url: '/memory/api/dream',
    body: JSON.stringify({ workspace }),
  });
  assert.equal(dream.status, 200);

  const health = await callRoute(route, {
    url: `/memory/api/health?workspace=${encodeURIComponent(workspace)}`,
  });
  assert.equal(health.body.health.candidates.pending, 0, '整理不该再顺带蒸馏出候选');
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
if (failed > 0) {
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`${passed} passed, 0 failed`);
