/**
 * dsh-memory 客户端半测试：把 lib/client.js 真的渲染出来，并接到真实的
 * lib/api.js + lib/store.js 上驱动交互（列表 / 搜索 / 新建 / 删除 / 国际化）。
 *
 *   node test/client.test.mjs
 *
 * 这里不需要 DSH，也不需要 React：test/mini-react.mjs 提供极小的 hook 运行时，
 * fetch 被换成直通 api.handle 的适配器。所以客户端页面里任何崩溃、契约错位、
 * 数据流断裂都会在这里暴露。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMiniReact } from './mini-react.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

const { createApi, API_PREFIX } = await import('../lib/api.js');
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ------------------------------------------------------------------ *
 * 真实后端：store + api，写在临时目录里
 * ------------------------------------------------------------------ */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-client-'));
const WS = process.platform === 'win32' ? 'C:\\proj\\记忆客户端' : '/proj/memory-client';

const store = createMemoryStore({ dir: path.join(tmp, 'storage'), mirror: true });

let settingsValue = {
  enabled: true,
  briefing: true,
  briefingLimit: 12,
  autoCapture: false,
  mirror: true,
  minConfidence: 0.4,
  hudIcon: 'a',
};
const settings = {
  get: () => ({ ...settingsValue }),
  set(patch) {
    for (const [key, value] of Object.entries(patch)) {
      if (key in settingsValue) settingsValue[key] = value;
    }
    return settings.get();
  },
};

const captures = [];
const api = createApi({
  store,
  settings,
  activeWorkspace: () => WS,
  listWorkspaces: () => [{ root: WS, key: 'k', count: 0, active: true }],
  activeSession: () => ({ id: 's-hud', workspace: WS }),
  captures: () => captures,
  version: '0.1.0',
  captureNow: async () => ({ ok: true, saved: 1, reason: 'test' }),
  distillNow: async ({ text }) => ({
    candidates: [{ title: text.slice(0, 20), content: text, category: 'note', tags: [], confidence: 0.9 }],
  }),
  rewriteNow: async ({ workspace, scope }) => {
    const saved = store.savePortrait(scope === 'global' ? '' : workspace, {
      sections: [{ key: 'background', text: '假重写背景。' }],
      source: 'auto',
    });
    return { ok: true, drafted: false, portrait: saved.portrait };
  },
  approveDraft: ({ workspace, scope }) => {
    const root = scope === 'global' ? '' : workspace;
    const draft = store.portraitDraftRead(root);
    if (!draft) return { ok: false, error: 'no_draft' };
    const saved = store.savePortrait(root, { sections: draft.sections, source: 'auto' });
    store.portraitDraftClear(root);
    return { ok: true, portrait: saved.portrait };
  },
});

/** 把浏览器的 fetch 直通到 api.handle。 */
const fetchCalls = [];
/* 客户端半在加载时就把 fetch 绑死了（new Function 的形参），所以换后端要换这个指针。 */
let activeApi = api;
async function fetchStub(target, init = {}) {
  const parsed = new URL(String(target));
  const query = {};
  for (const [key, value] of parsed.searchParams.entries()) query[key] = value;
  let body;
  if (typeof init.body === 'string' && init.body.length) body = JSON.parse(init.body);
  fetchCalls.push({ method: init.method || 'GET', pathname: parsed.pathname, body });
  const result = await activeApi.handle({
    method: init.method || 'GET',
    pathname: parsed.pathname,
    query,
    body,
  });
  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    async json() {
      return result.body;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 加载客户端半
 * ------------------------------------------------------------------ */

const mini = createMiniReact();

/** 外壳设置导航里的按钮（apply 时就要在位，用于验证标记逻辑）。 */
function navButton(text) {
  return {
    textContent: text,
    attrs: {},
    setAttribute(key, value) {
      this.attrs[key] = value;
    },
    removeAttribute(key) {
      delete this.attrs[key];
    },
  };
}
const navButtons = [navButton('通用设置'), navButton('记忆'), navButton('模型')];

/* 前台会话卡的位置 / 展开 / 「该对话记忆」都存 localStorage；Node 侧用内存表顶替。 */
const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    },
  },
});

const styleTags = [];
/* 前台会话卡的会话标记（宿主只在对话容器上打这个只读属性）。 */
const sessionNodes = [];
/* 宿主设置面板等模态层（真实 DOM 里是 body 上的 portal）。 */
const modalNodes = [];
const documentStub = {
  baseURI: 'http://127.0.0.1:19387/',
  body: {},
  head: {
    appendChild(node) {
      styleTags.push(node);
    },
  },
  createElement(tag) {
    return { tagName: tag, dataset: {}, textContent: '' };
  },
  querySelector(selector) {
    if (selector === '[data-shortcut-modal]') return modalNodes[0] || null;
    return null;
  },
  querySelectorAll(selector) {
    if (selector === '[role="dialog"] nav button') return navButtons;
    if (selector === '[data-dshmem-nav]') {
      return navButtons.filter((button) => 'data-dshmem-nav' in button.attrs);
    }
    if (selector === '[data-conversation-session]') return sessionNodes;
    return [];
  },
};

const observers = [];
class MutationObserverStub {
  constructor(callback) {
    this.callback = callback;
    this.target = null;
    observers.push(this);
  }
  observe(target, options) {
    this.target = target;
    this.options = options;
  }
  disconnect() {
    this.target = null;
  }
}

let confirmAnswer = true;
const confirmCalls = [];
const windowStub = {
  setTimeout,
  clearTimeout,
  confirm(message) {
    confirmCalls.push(message);
    return confirmAnswer;
  },
  __ModuleLoader__: {
    load(entry) {
      loaded = { id: entry.id, exports: entry.factory(requireStub) };
    },
  },
};
let loaded = null;

function requireStub(id) {
  if (id === 'react') return mini.react;
  throw new Error(`客户端半只允许 require("react")，实际为 ${id}`);
}

const source = fs.readFileSync(path.join(pkgRoot, 'lib', 'client.js'), 'utf8');
const factory = new Function(
  'window',
  'document',
  'fetch',
  'URL',
  'URLSearchParams',
  'AbortController',
  'navigator',
  'console',
  'MutationObserver',
  source,
);
factory(
  windowStub,
  documentStub,
  fetchStub,
  URL,
  URLSearchParams,
  AbortController,
  { clipboard: { writeText: async () => {} } },
  console,
  MutationObserverStub,
);

/* ------------------------------------------------------------------ *
 * 假 ctx：只实现 slots / locale / effect
 * ------------------------------------------------------------------ */

let lang = 'zh';
/* 设置页与前台会话卡各注册一个槽位：按 name 留档，设置页仍用 slotRegistration 别名。 */
const slotRegistration = { name: null, options: null, component: null, disposer: null };
const slotRegistrations = new Map();
const localeRegistration = { ns: null, dicts: null };

function dict(locale) {
  return (key) => {
    const table = localeRegistration.dicts?.[locale] || {};
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key;
  };
}

const effectDisposers = [];
let pendingSlot = null;
const ctx = {
  effect(fn) {
    const disposer = fn();
    effectDisposers.push(disposer);
    return typeof disposer === 'function' ? disposer : () => {};
  },
  locale: {
    bind: () => (key) => dict(lang)(key),
    register(ns, dicts) {
      localeRegistration.ns = ns;
      localeRegistration.dicts = dicts;
      return () => {};
    },
    getSnapshot: () => ({ revision: 1 }),
    subscribe: () => () => {},
  },
  slots: {
    inject(name, register) {
      /* register 在 inject 的回调里同步执行；先占位，再让 register 写进这一条。 */
      const current = { name, options: null, component: null, disposer: null };
      pendingSlot = current;
      current.disposer = register();
      pendingSlot = null;
      slotRegistrations.set(name, current);
      if (name === 'settings.section') {
        Object.assign(slotRegistration, {
          name,
          options: current.options,
          component: current.component,
          disposer: current.disposer,
        });
      }
      return () => {};
    },
    register(options, component) {
      if (pendingSlot) {
        pendingSlot.options = options;
        pendingSlot.component = component;
      }
      return () => {};
    },
  },
};

/* ------------------------------------------------------------------ *
 * 种子数据
 * ------------------------------------------------------------------ */

await api.handle({
  method: 'POST',
  pathname: `${API_PREFIX}/save`,
  body: {
    workspace: WS,
    title: '插件安装方式',
    content: 'package 进入 dsh.profile.bundles 后，其 cordis.patch.yml 会被自动应用。',
    category: 'convention',
    tags: ['dsh', 'plugin'],
    source: 'manual',
  },
});
await api.handle({
  method: 'POST',
  pathname: `${API_PREFIX}/save`,
  body: {
    workspace: WS,
    title: 'alpha 约定',
    content: '搜索测试用的独特标记 alpha-9f2c。',
    category: 'fact',
    source: 'manual',
  },
});
await api.handle({
  method: 'POST',
  pathname: `${API_PREFIX}/save`,
  body: {
    workspace: WS,
    title: '全局偏好',
    content: '用户偏好中文回答。',
    category: 'preference',
    scope: 'global',
    source: 'manual',
  },
});

/* ------------------------------------------------------------------ *
 * 测试
 * ------------------------------------------------------------------ */

console.log('dsh-memory client half');

await test('模块通过 __ModuleLoader__.load 注册，id 与包名一致', () => {
  assert.ok(loaded, 'client.js 没有调用 window.__ModuleLoader__.load');
  const pkgName = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).name;
  /* 模块系统按 manifest 包名认领浏览器模块：id 不一致时客户端半根本不会激活
     （宿主半照常工作，界面却整块消失）——所以这里必须对着 package.json 断言。 */
  assert.equal(loaded.id, pkgName, `模块 id 必须等于 package.json 的 name（${pkgName}）`);
  assert.equal(typeof loaded.exports.apply, 'function');
  assert.deepEqual(loaded.exports.inject, ['slots', 'locale']);
  assert.equal(loaded.exports.name, 'dsh-memory');
});

await test('CSS 只注入一次，且带 data-plugin-css 标记', () => {
  assert.equal(styleTags.length, 1);
  assert.equal(styleTags[0].tagName, 'style');
  assert.ok(styleTags[0].dataset.pluginCss, '缺少 dataset.pluginCss');
  assert.match(styleTags[0].textContent, /\.dshmem/);
  assert.match(styleTags[0].textContent, /--dsw-static-deepseek-450/);
});

await test('次级文字对比度：dim 级文本由 currentColor 派生（随主题/背景自适应）', () => {
  const css = styleTags[0].textContent;
  assert.match(
    css,
    /--dshmem-dim:color-mix\(in srgb,currentColor 68%,transparent\)/,
    '缺少 --dshmem-dim 派生色定义（亮色下宿主 dimmed=#e1e5ee 对比度仅 1.26:1）',
  );
  assert.ok(!css.includes('dsw-alias-label-dimmed'), '不应再直接使用宿主 dimmed 令牌');
});

await test('apply 注册 locale 字典（含 en）并挂到 settings.section', () => {
  loaded.exports.apply(ctx);
  assert.equal(localeRegistration.ns, 'settings.memory');
  assert.ok(localeRegistration.dicts.zh, '缺少 zh 字典');
  assert.ok(localeRegistration.dicts.en, '缺少 en 字典（DSH 要求回落链能到 en）');
  assert.equal(slotRegistration.name, 'settings.section');
  assert.equal(slotRegistration.options.name, 'settings.section');
  assert.equal(slotRegistration.options.id, 'memory');
  assert.equal(slotRegistration.options.order, 25, 'order 25 是唯一空档（20 已占用）');
  assert.equal(slotRegistration.options.locale, 'settings.memory');
  assert.equal(typeof slotRegistration.component, 'function');
  assert.equal(typeof slotRegistration.options.label, 'function');
  assert.equal(slotRegistration.options.label(), '记忆');
});

await test('导航项被标记成自有字形，且卸载时撤掉标记', () => {
  const mine = navButtons.find((button) => button.textContent === '记忆');
  const other = navButtons.find((button) => button.textContent === '通用设置');
  assert.ok('data-dshmem-nav' in mine.attrs, '本插件那一行没有被标记，齿轮图标换不掉');
  assert.ok(!('data-dshmem-nav' in other.attrs), '标记溢到了别的导航项上');
  assert.equal(observers.length, 1, '应只挂一个 MutationObserver');
  assert.equal(observers[0].target, documentStub.body);
  assert.ok(observers[0].options.childList && observers[0].options.subtree);
  assert.match(styleTags[0].textContent, /\[data-dshmem-nav\] svg:first-child\{display:none/);
  assert.match(styleTags[0].textContent, /--dshmem-nav-glyph:url\("data:image\/svg\+xml,/);

  // 卸载：标记撤掉、观察断开。apply 里的第二个 effect 就是它。
  const navDisposer = effectDisposers[1];
  assert.equal(typeof navDisposer, 'function');
  navDisposer();
  assert.equal(observers[0].target, null, 'disposer 没有断开 MutationObserver');
  assert.ok(!('data-dshmem-nav' in mine.attrs), 'disposer 没有撤掉标记');
});

await test('locale 字典键完全对齐：zh 与 en 的键集合一致', () => {
  const { zh, en } = localeRegistration.dicts;
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  const missingEn = zhKeys.filter((key) => !enKeys.includes(key));
  const missingZh = enKeys.filter((key) => !zhKeys.includes(key));
  assert.deepEqual(missingEn, [], `en 缺少键: ${missingEn.join(', ')}`);
  assert.deepEqual(missingZh, [], `zh 缺少键: ${missingZh.join(', ')}`);
  assert.ok(zhKeys.length >= 60, `字典太小：${zhKeys.length} 个键`);
});

/* ---------------- 渲染 ---------------- */

const makeT = (locale) => (key) => {
  const table = localeRegistration.dicts[locale] || {};
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key;
};

let handle = null;
let view = null;

function renderPage(locale = 'zh') {
  lang = locale;
  const bound = makeT(locale);
  handle = mini.render(
    mini.react.createElement(slotRegistration.component, {
      t: bound,
      close() {},
      useMemoryLocale: (selector) => selector({ revision: 1 }),
    }),
  );
  view = handle.tree;
  return view;
}

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    await sleep(25);
    await mini.flush(4);
  }
  // 每次重渲染都会产生新的树对象，测试里始终读最新的。
  view = handle.tree;
}

const text = () => mini.textOf(handle.tree);

/* 视图分段控件只有两个：档案（默认）/ 列表。卡片只在列表视图里出现。 */
const switchView = async (key, locale = 'zh') => {
  const button = mini.findByText(handle.tree, makeT(locale)(key), 'button');
  assert.ok(button, `找不到视图按钮：${key}`);
  mini.click(button);
  await settle(8);
};

/* 档案视图的排布下拉：整篇文档（默认）/ 按标签分组 / 按类型分组——同一份内容的两种排布。 */
const setLayout = async (value, locale = 'zh') => {
  const select = mini
    .findAllByTag(handle.tree, 'select')
    .find((node) => mini.textOf(node).includes(makeT(locale)('groupByTag')));
  assert.ok(select, '档案视图里找不到排布下拉');
  mini.type(select, value);
  await settle(8);
};

await test('首屏渲染出三条记忆与统计', async () => {
  renderPage('zh');
  await settle();
  const body = text();
  assert.match(body, /插件安装方式/);
  assert.match(body, /alpha 约定/);
  assert.match(body, /全局偏好/);
  // 档案视图是「一个工作区一份长记忆」：只有视图切换、两个开关和正文，
  // 条数统计、搜索框、排序、新建这些管理动作全部收进列表视图。
  assert.doesNotMatch(body, /共 \d+条/, '档案视图不该出现条数统计');
  assert.equal(
    mini.findAllByTag(view, 'input').some((node) => node.props.placeholder === makeT('zh')('search')),
    false,
    '档案视图不该出现搜索框',
  );
  assert.match(body, /直接在对话里说/, '档案视图缺少「在对话里加记忆」的提示');
  // 切到列表视图才能看到条数与范围统计（列表把「项目记忆 / 全局记忆」分开统计，和 Qoder 的划分一致）。
  await switchView('viewList');
  const list = text();
  assert.match(list, /共 3条/);
  assert.match(list, /项目记忆 2/);
  assert.match(list, /全局记忆 1/);
  assert.ok(list.includes(makeT('zh')('nav')), '缺少导航标签');
});

await test('页面确实读了宿主 /state 与 /list', () => {
  const paths = fetchCalls.map((call) => call.pathname);
  assert.ok(paths.some((p) => p === `${API_PREFIX}/state`), '/state 未被调用');
  assert.ok(paths.some((p) => p === `${API_PREFIX}/list`), '/list 未被调用');
  assert.ok(
    fetchCalls.every((call) => call.pathname.startsWith('/memory/api')),
    '客户端请求没有走 /memory/api 前缀',
  );
});

await test('顶部只留记忆/维护/设置三个页签，自动提炼并入维护', async () => {
  renderPage('zh');
  await settle(8);
  const tabs = mini.findAll(
    view,
    (node) => node.type === 'button' && String(node.props.className || '').split(/\s+/).includes('dshmem_tab'),
  );
  assert.equal(tabs.length, 3, '顶层页签应只剩三个');
  const labels = tabs.map((node) => mini.textOf(node).trim());
  assert.ok(labels.some((label) => label.startsWith(makeT('zh')('tabMemories'))));
  assert.ok(labels.some((label) => label.startsWith(makeT('zh')('tabMaintain'))));
  assert.ok(labels.some((label) => label.startsWith(makeT('zh')('tabSettings'))));
  assert.ok(!labels.some((label) => label.includes(makeT('zh')('tabCapture'))), '自动提炼不应再是顶层页签');
});

await test('原料与依据抽屉默认收起，点击后展开', async () => {
  renderPage('zh');
  await settle(8);
  const drawer = () =>
    mini.findAll(
      view,
      (node) => String(node.props?.className || '').split(/\s+/).includes('dshmem_toolsBody'),
    )[0];
  assert.ok(drawer(), '缺少原料抽屉');
  assert.equal(drawer().props['data-open'], '0', '原料抽屉应默认收起');
  const head = mini.findAll(
    view,
    (node) => String(node.props?.className || '').split(/\s+/).includes('dshmem_toolsHead'),
  )[0];
  assert.ok(head, '原料抽屉缺少标题行');
  mini.click(head);
  await settle(6);
  assert.equal(drawer().props['data-open'], '1', '点击后应展开');
});

await test('红线空态提供「添加红线」，打开专用编辑器', async () => {
  renderPage('zh');
  await settle(8);
  const add = mini.findByText(view, makeT('zh')('redlineAdd'), 'button');
  assert.ok(add, '缺少添加红线入口');
  mini.click(add);
  await settle(6);
  assert.ok(
    mini.findAllByTag(view, 'input').some((node) => node.props.placeholder === makeT('zh')('redlineTitlePh')),
    '添加红线应打开专用编辑器',
  );
  assert.ok(
    mini.findAllByTag(view, 'textarea').some((node) => node.props.placeholder === makeT('zh')('redlineContentPh')),
    '添加红线应提供正文输入',
  );
  mini.click(mini.findByText(view, makeT('zh')('cancel'), 'button'));
  await settle(4);
});

await test('首页「需要处理」显示待审数量并跳到维护', async () => {
  const draft = store.upsert(
    { title: '注意力草稿', content: '这是一条等待审批的草稿内容。', status: 'draft', source: 'auto' },
    { workspace: WS },
  ).record;
  renderPage('zh');
  await settle(16);
  const body = text();
  assert.match(body, new RegExp(escapeRe(makeT('zh')('attentionTitle'))), '缺少「需要处理」入口');
  const go = mini.findByText(view, makeT('zh')('attentionGo'), 'button');
  assert.ok(go, '有处理项时应给「去整理」按钮');
  mini.click(go);
  await settle(8);
  const activeTab = mini.findAll(
    view,
    (node) => node.type === 'button' && String(node.props.className || '').includes('dshmem_tab_on'),
  )[0];
  assert.ok(activeTab && mini.textOf(activeTab).includes(makeT('zh')('tabMaintain')), '应切到维护页');
  await api.handle({
    method: 'POST',
    pathname: `${API_PREFIX}/queue/reject`,
    body: { workspace: WS, id: draft.id },
  });
});

await test('需要处理收件箱：展开后可直接批准草稿', async () => {
  const draft = store.upsert(
    { title: '收件箱草稿', content: '这是一条可以就地批准的草稿。', status: 'draft', source: 'auto' },
    { workspace: WS },
  ).record;
  renderPage('zh');
  await settle(16);
  const main = mini.findAll(
    view,
    (node) => String(node.props?.className || '').split(/\s+/).includes('dshmem_attentionMain'),
  )[0];
  assert.ok(main, '缺少「需要处理」行');
  mini.click(main);
  await settle(16);
  assert.match(text(), /收件箱草稿/, '展开后应列出待审草稿');
  const approve = mini.findByText(view, makeT('zh')('queueApprove'), 'button');
  assert.ok(approve, '收件箱缺少批准按钮');
  mini.click(approve);
  await settle(16);
  assert.equal(
    store.get(draft.id, { workspace: WS, includeDrafts: true }).status,
    'active',
    '收件箱批准后草稿应转正',
  );
  await api.handle({
    method: 'POST',
    pathname: `${API_PREFIX}/delete`,
    body: { workspace: WS, id: draft.id },
  });
});

/* 卡片、标签云、删除/置顶/新建按钮都只在列表视图里，下面这一组先切过去。 */
renderPage('zh');
await settle(8);
await switchView('viewList');

await test('列表带上工作区、范围与类别标签', () => {
  const body = text();
  assert.match(body, /约定/); // 类别中文标签
  assert.match(body, /#dsh/); // 标签 chip
  assert.match(body, new RegExp(escapeRe(WS))); // 工作区路径
});

await test('搜索框过滤列表', async () => {
  const input = mini
    .findAllByTag(view, 'input')
    .find((node) => node.props.placeholder === makeT('zh')('search'));
  assert.ok(input, '找不到搜索输入框');
  mini.type(input, 'alpha');
  await settle(10);
  const body = text();
  assert.match(body, /alpha 约定/);
  assert.doesNotMatch(body, /插件安装方式/, '搜索后未过滤掉不匹配的记忆');
  assert.equal(store.list({ workspace: WS, query: '', includeGlobal: false }).total, 2);
});

await test('清空搜索后列表恢复', async () => {
  const input = mini
    .findAllByTag(view, 'input')
    .find((node) => node.props.placeholder === makeT('zh')('search'));
  mini.type(input, '');
  await settle(10);
  assert.match(text(), /插件安装方式/);
});

await test('点击卡片上的删除按钮会真的删掉记忆（走 /delete）', async () => {
  const title = makeT('zh')('remove');
  const cards = mini.findAll(
    view,
    (node) => node.type === 'div' && String(node.props.className || '').includes('dshmem_card'),
  );
  const target = cards.find((card) => mini.textOf(card).includes('alpha 约定'));
  assert.ok(target, '找不到 alpha 约定的卡片');
  const button = mini.findByText(target, title, 'button');
  assert.ok(button, '找不到删除按钮');

  const before = store.list({ workspace: WS, includeGlobal: false }).total;
  confirmAnswer = true;
  mini.click(button);
  await settle(10);
  assert.equal(store.list({ workspace: WS, includeGlobal: false }).total, before - 1);
  assert.equal(store.list({ workspace: WS, query: 'alpha' }).total, 0);
  assert.ok(confirmCalls.length >= 1, '删除前没有向用户确认');
  assert.doesNotMatch(text(), /alpha 约定/, '删除后列表没有刷新');
});

await test('取消确认时不删除', async () => {
  const cards = mini.findAll(
    view,
    (node) => node.type === 'div' && String(node.props.className || '').includes('dshmem_card'),
  );
  const target = cards.find((card) => mini.textOf(card).includes('插件安装方式'));
  assert.ok(target, '找不到目标卡片');
  const before = store.list({ workspace: WS, includeGlobal: false }).total;
  confirmAnswer = false;
  mini.click(mini.findByText(target, makeT('zh')('remove'), 'button'));
  await settle(6);
  assert.equal(store.list({ workspace: WS, includeGlobal: false }).total, before);
  confirmAnswer = true;
});

await test('置顶按钮切换 pinned 并让记录排到最前', async () => {
  const cards = mini.findAll(
    view,
    (node) => node.type === 'div' && String(node.props.className || '').includes('dshmem_card'),
  );
  const target = cards.find((card) => mini.textOf(card).includes('插件安装方式'));
  mini.click(mini.findByText(target, makeT('zh')('pin'), 'button'));
  await settle(10);
  const record = store.list({ workspace: WS, includeGlobal: false }).records.find(
    (item) => item.title === '插件安装方式',
  );
  assert.equal(record.pinned, true);
  const first = mini.findAll(
    view,
    (node) => node.type === 'div' && String(node.props.className || '').includes('dshmem_card'),
  )[0];
  assert.match(mini.textOf(first), /插件安装方式/, '置顶后没有排在最前');
});

await test('新建记忆：打开表单 → 填写 → 保存 → 落库', async () => {
  const newButton = mini.findByText(view, makeT('zh')('newMemory'), 'button');
  assert.ok(newButton, '找不到“新建记忆”按钮');
  mini.click(newButton);
  await settle(4);

  const titleInput = mini
    .findAllByTag(view, 'input')
    .find((node) => node.props.placeholder === makeT('zh')('fTitlePh'));
  const contentArea = mini
    .findAllByTag(view, 'textarea')
    .find((node) => node.props.placeholder === makeT('zh')('fContentPh'));
  assert.ok(titleInput && contentArea, '表单没有渲染出来');

  mini.type(titleInput, '端到端测试记忆');
  mini.type(contentArea, '由 test/client.test.mjs 写入。');
  await settle(4);

  const save = mini.findByText(view, makeT('zh')('save'), 'button');
  assert.ok(save, '找不到保存按钮');
  mini.click(save);
  await settle(10);

  const found = store.list({ workspace: WS, query: '端到端测试记忆' }).records;
  assert.equal(found.length, 1, '新建的记忆没有落库');
  assert.equal(found[0].source, 'manual');
  assert.match(text(), /端到端测试记忆/, '新建后列表没有刷新');
});

await test('空表单提交被拦下并提示', async () => {
  mini.click(mini.findByText(view, makeT('zh')('newMemory'), 'button'));
  await settle(3);
  const countBefore = store.list({ workspace: WS, includeGlobal: false }).total;
  mini.click(mini.findByText(view, makeT('zh')('save'), 'button'));
  await settle(4);
  assert.match(text(), new RegExp(makeT('zh')('errTitle').slice(0, 4)));
  assert.equal(store.list({ workspace: WS, includeGlobal: false }).total, countBefore);
  mini.click(mini.findByText(view, makeT('zh')('cancel'), 'button'));
  await settle(3);
});

/* ---------------- 其他两个 tab ---------------- */

await test('自动提炼并进维护页：展开分组后能手动触发 /capture', async () => {
  const maintainTab = mini
    .findAll(view, (node) => node.type === 'button' && mini.textOf(node).includes(makeT('zh')('tabMaintain')))
    .find((node) => mini.textOf(node).trim().startsWith(makeT('zh')('tabMaintain')));
  assert.ok(maintainTab, '缺少维护 tab');
  mini.click(maintainTab);
  await settle(8);
  const captureHead = mini
    .findAll(
      view,
      (node) => String(node.props?.className || '').split(/\s+/).includes('dshmem_blockGroupHead'),
    )
    .find((node) => mini.textOf(node).includes(makeT('zh')('tabCapture')));
  assert.ok(captureHead, '维护页缺少自动提炼分组');
  mini.click(captureHead);
  await settle(4);
  const run = mini.findByText(view, makeT('zh')('captureNow'), 'button');
  assert.ok(run, '找不到提炼按钮');
  mini.click(run);
  await settle(10);
  assert.ok(
    fetchCalls.some((call) => call.pathname === `${API_PREFIX}/capture`),
    '/capture 未被调用',
  );
});

await test('切到设置页会渲染开关与保存按钮', async () => {
  const tab = mini.findByText(view, makeT('zh')('tabSettings'), 'button');
  assert.ok(tab, '找不到设置 tab');
  mini.click(tab);
  await settle(8);
  const body = text();
  assert.match(body, new RegExp(makeT('zh')('sBriefing')));
  assert.match(body, new RegExp(makeT('zh')('sAuto')));
  assert.match(body, new RegExp(makeT('zh')('sessionMemory')), '缺少该对话记忆开关');
  assert.ok(mini.findByText(view, makeT('zh')('save'), 'button'), '找不到保存设置按钮');

  /* 会话卡图标：7 个选项，默认 a 官方鲸鱼标。 */
  const iconSelect = mini
    .findAll(view, (node) => node.type === 'select' && String(node.props?.value || '') === 'a')
    .find((node) => mini.textOf(node).includes(makeT('zh')('hudIconA')));
  assert.ok(iconSelect, '缺少会话卡图标选择器');
  assert.equal(String(iconSelect.props.value), 'a', '默认选中官方鲸鱼标');
  assert.equal(
    mini.findAll(iconSelect, (node) => node.type === 'option').length,
    7,
    '图标应提供 7 个选项',
  );

  /* 该对话记忆默认开启；关闭只写本会话的本地开关，不碰工作区配置。 */
  const sessionSwitch = mini
    .findAll(view, (node) => (node.props?.className || '').split(/\s+/).includes('dshmem_switch'))
    .find((node) => mini.textOf(node).includes(makeT('zh')('sessionMemory')));
  assert.ok(sessionSwitch, '找不到该对话记忆开关');
  const sessionInput = mini.findAll(sessionSwitch, (node) => node.type === 'input')[0];
  assert.ok(sessionInput, '该对话记忆开关缺少 checkbox');
  assert.equal(Boolean(sessionInput.props.checked), true, '该对话记忆默认应开启');
  assert.equal(Boolean(sessionInput.props.disabled), false, '有当前会话时开关应可用');
  sessionInput.props.onChange({ target: { checked: false } });
  await settle(4);
  assert.ok(
    (storage.get('dsh-memory/session-hud/off') || '').includes('s-hud'),
    '关闭后应把当前会话写进本地关闭列表',
  );
  sessionInput.props.onChange({ target: { checked: true } });
  await settle(4);
  assert.ok(
    !(storage.get('dsh-memory/session-hud/off') || '').includes('s-hud'),
    '重新开启后应移出关闭列表',
  );
  // 镜像区必须指向工作区里那份文件，而不是主库路径。
  assert.match(body, /\.dsh-memory/, '镜像区应显示工作区镜像路径');
  assert.match(body, new RegExp(makeT('zh')('mirrorStorage')), '镜像区应标出主库旁车');
  // 镜像已经存在时要自动把内容拉进预览区，不能一边显示「已生成」一边说没有文件。
  assert.ok(
    fetchCalls.some((call) => call.pathname === `${API_PREFIX}/mirror`),
    '镜像已存在时应自动拉一次 /mirror 填预览',
  );
  assert.doesNotMatch(
    body,
    new RegExp(escapeRe(makeT('zh')('mirrorEmpty'))),
    '镜像已存在时预览区不该再说「还没有生成镜像文件」',
  );
});

/* ---------------- 档案视图：项目/全局分区 + 可选的按标签分组 ---------------- */

/* 造两组同标签的记忆，才用得上「整合」；另外造一条全局的，验证分区不串。 */
for (const seed of [
  { title: '空间甲', content: '甲的内容', category: 'fact', tags: ['space'] },
  { title: '空间乙', content: '乙的内容', category: 'fact', tags: ['space'] },
  { title: '空间全局', content: '全局的内容', category: 'preference', tags: ['space'], scope: 'global' },
]) {
  await api.handle({
    method: 'POST',
    pathname: `${API_PREFIX}/save`,
    body: { workspace: WS, source: 'manual', ...seed },
  });
}

/* 注意要整词匹配：class 里 dshmem_section 是 dshmem_sectionHead/_Title 的前缀。 */
const byClass = (name) => (node) =>
  String((node && node.props && node.props.className) || '')
    .split(/\s+/)
    .includes(name);

await test('档案视图按「项目记忆 / 全局记忆」分区，可切成按标签归类', async () => {
  renderPage('zh');
  await settle(10);

  /* 默认排布是「整篇文档」：分区里只有标题与正文，没有分组卡片。 */
  assert.equal(mini.findAll(view, byClass('dshmem_group')).length, 0, '整篇文档排布不该有分组');
  assert.ok(mini.findAll(view, byClass('dshmem_docPara')).length > 0, '整篇文档排布没有正文段落');

  await setLayout('tag');

  const sections = mini.findAll(view, byClass('dshmem_section'));
  assert.equal(sections.length, 2, `应该有两个分区，实际 ${sections.length} 个`);
  const [project, global] = sections.map((node) => mini.textOf(node));
  assert.match(project, /项目记忆/);
  assert.match(global, /全局记忆/);
  assert.match(project, /空间甲/, '项目分区里没有本工作区的记忆');
  assert.match(global, /空间全局/, '全局分区里没有全局记忆');
  assert.doesNotMatch(project, /空间全局/, '全局记忆混进了项目分区');
  assert.doesNotMatch(global, /空间甲/, '项目记忆混进了全局分区');

  const groups = mini.findAll(view, byClass('dshmem_group'));
  const spaceGroups = groups.filter((node) => mini.textOf(node).startsWith('▾ #space'));
  assert.equal(spaceGroups.length, 2, '#space 应该分别在两个分区里各成一组');
  assert.match(mini.textOf(spaceGroups[0]), /空间甲/);
  assert.match(mini.textOf(spaceGroups[0]), /空间乙/);
  assert.match(mini.textOf(spaceGroups[1]), /空间全局/);
  assert.doesNotMatch(mini.textOf(spaceGroups[1]), /空间甲/);

  /* 没有标签的记忆落到「未归类」，且排在最后。 */
  const labels = groups.map((node) => mini.textOf(node).slice(0, 8));
  assert.ok(labels.some((label) => label.includes('未归类')), '缺少「未归类」分组');
  assert.ok(
    labels[labels.length - 1].includes('未归类'),
    `「未归类」应该排在最后，实际顺序：${labels.join(' | ')}`,
  );
});

await test('分区与分组都能折叠', async () => {
  renderPage('zh');
  await settle(10);
  await setLayout('tag');
  const spaceTitle = () =>
    mini
      .findAll(view, byClass('dshmem_groupTitle'))
      .find((node) => mini.textOf(node).includes('#space'));

  const open = spaceTitle();
  assert.ok(open, '找不到 #space 组标题');
  assert.match(mini.textOf(open), /^▾ /, '展开态应该带 ▾');
  mini.click(open);
  await settle(8);
  assert.match(mini.textOf(spaceTitle()), /^▸ /, '折叠后没有换成 ▸');
  assert.doesNotMatch(text(), /甲的内容/, '折叠后组内条目还在');
  mini.click(spaceTitle());
  await settle(8);
  assert.match(text(), /甲的内容/, '再点一次没能展开');

  const globalHead = mini.findAll(view, byClass('dshmem_sectionHead'))[1];
  assert.ok(globalHead, '找不到全局分区头');
  mini.click(globalHead);
  await settle(8);
  assert.doesNotMatch(text(), /空间全局/, '折叠分区后条目还在');
  assert.match(text(), /全局记忆/, '折叠分区后分区标题不该消失');
  mini.click(mini.findAll(view, byClass('dshmem_sectionHead'))[1]);
  await settle(8);
  assert.match(text(), /空间全局/, '分区没能重新展开');
});

await test('整合：同标签的记忆合并成一条，原条目自动归档', async () => {
  renderPage('zh');
  await settle(10);
  await setLayout('tag');

  const group = mini
    .findAll(view, byClass('dshmem_group'))
    .find((node) => mini.textOf(node).startsWith('▾ #space'));
  assert.ok(group, '找不到 #space 分组');
  const button = mini.findByText(group, makeT('zh')('consolidate'), 'button');
  assert.ok(button, '同组两条记忆时没有出现「整合」按钮');
  mini.click(button);
  await settle(6);

  assert.match(text(), new RegExp(escapeRe(makeT('zh')('consolidateHint').slice(0, 6))));
  const titleInput = mini
    .findAllByTag(view, 'input')
    .find((node) => node.props.placeholder === makeT('zh')('fTitlePh'));
  const contentArea = mini
    .findAllByTag(view, 'textarea')
    .find((node) => node.props.placeholder === makeT('zh')('fContentPh'));
  assert.ok(titleInput && contentArea, '整合没有打开编辑表单');
  assert.equal(titleInput.props.value, 'space', '标题没有预填成标签名');
  assert.ok(contentArea.props.value.includes('空间甲'), '合并正文没有列出第一条');
  assert.ok(contentArea.props.value.includes('空间乙'), '合并正文没有列出第二条');

  mini.click(mini.findByText(view, makeT('zh')('save'), 'button'));
  await settle(14);

  const all = store.list({ workspace: WS, includeArchived: true }).records;
  const merged = all.find((record) => record.title === 'space' && !record.archived);
  assert.ok(merged, '没有生成合并后的记忆');
  assert.deepEqual(merged.tags, ['space']);
  assert.equal(merged.scope, 'workspace');
  assert.ok(merged.content.includes('空间甲') && merged.content.includes('空间乙'), '合并正文不完整');
  for (const title of ['空间甲', '空间乙']) {
    assert.equal(all.find((record) => record.title === title).archived, true, `${title} 没有被归档`);
  }
  assert.match(text(), new RegExp(escapeRe(makeT('zh')('consolidated').slice(0, 6))));
  assert.equal(
    store.list({ workspace: WS }).records.some((record) => record.title === '空间甲'),
    false,
    '归档后的原条目不该留在默认列表里',
  );
});

await test('档案 / 列表两个视图互切，范围 chip 只留一个分区', async () => {
  renderPage('zh');
  await settle(10);

  /* 列表：卡片 + 标签云 + 范围 chip，没有分区，也没有档案页的排布下拉。 */
  mini.click(mini.findByText(view, makeT('zh')('viewList'), 'button'));
  await settle(8);
  assert.equal(mini.findAll(view, byClass('dshmem_section')).length, 0, '列表视图不该再有分区');
  assert.ok(mini.findAll(view, byClass('dshmem_card')).length > 0, '列表视图没有卡片');
  assert.match(text(), /#space/, '列表视图应该显示标签云');
  assert.equal(
    mini
      .findAllByTag(view, 'select')
      .some((node) => mini.textOf(node).includes(makeT('zh')('groupByTag'))),
    false,
    '列表视图不该出现档案页的排布下拉',
  );

  const chip = mini
    .findAll(view, byClass('dshmem_chip_click'))
    .find((node) => mini.textOf(node).startsWith(makeT('zh')('scopeGlobalFull')));
  assert.ok(chip, '找不到「全局记忆」范围 chip');
  mini.click(chip);
  await settle(12);

  /* 切回档案：分区回来了，而且只剩筛中的那一个。 */
  mini.click(mini.findByText(view, makeT('zh')('viewDoc'), 'button'));
  await settle(10);
  const sections = mini.findAll(view, byClass('dshmem_section'));
  assert.equal(sections.length, 1, '筛到全局后应该只剩一个分区');
  assert.match(mini.textOf(sections[0]), /全局记忆/);
  assert.ok(mini.textOf(sections[0]).includes('空间全局'), '全局分区里没有全局记忆');
  assert.doesNotMatch(text(), /端到端测试记忆/, '筛到全局后不该再出现项目记忆');
});

/* ---------------- 档案视图：照 WorkBuddy 的「记忆与进化」 ---------------- */

/* 开关不是 checkbox，是 role="switch" 的按钮，用 data-on 表达状态。 */
const switchNodes = () => mini.findAll(view, (node) => node.props && node.props.role === 'switch');

await test('档案视图默认打开：分区小标题 + 粗体标题 + 整段正文', async () => {
  renderPage('zh');
  await settle(10);

  const segments = mini.findAll(view, byClass('dshmem_seg_btn'));
  assert.deepEqual(
    segments.map((node) => mini.textOf(node)),
    ['档案', '列表'],
    '分段控件应该是两个视图（档案已把记忆空间收进来）',
  );
  assert.ok(byClass('dshmem_seg_on')(segments[0]), '默认应该选中「档案」');

  const sections = mini.findAll(view, byClass('dshmem_sectionTitle'));
  assert.deepEqual(sections.map((node) => mini.textOf(node)), ['项目记忆', '全局记忆']);

  const titles = mini.findAll(view, byClass('dshmem_docTitle')).map((node) => mini.textOf(node));
  assert.ok(titles.includes('插件安装方式'), `档案里缺少已有记忆：${titles.join(' | ')}`);
  const paras = mini.findAll(view, byClass('dshmem_docPara')).map((node) => mini.textOf(node));
  assert.ok(paras.some((para) => para.includes('cordis.patch.yml')), '档案里没有整段正文');

  /* 卡片、标签云是列表视图的东西；档案视图整篇文档排布下只有分区、标题与正文。 */
  assert.equal(mini.findAll(view, byClass('dshmem_card')).length, 0, '档案视图不该渲染卡片');
  assert.equal(mini.findAll(view, byClass('dshmem_section')).length, 2, '档案视图应该有项目/全局两个分区');

  const body = text();
  assert.match(body, new RegExp(escapeRe(makeT('zh')('manageMemory'))));
  for (const key of ['tidy', 'editDoc', 'importDo']) {
    assert.ok(mini.findByText(view, makeT('zh')(key), 'button'), `缺少按钮：${key}`);
  }
  assert.match(body, new RegExp(escapeRe(makeT('zh')('docAutoHint').slice(0, 10))));
  assert.match(body, new RegExp(escapeRe(makeT('zh')('docLocalHint').slice(0, 10))));
  assert.match(body, /仅保存在你的设备上/);

  /* 两行开关：对话记忆 → autoCapture（默认关），本地记忆与技能 → mirror（默认开）。 */
  const switches = switchNodes();
  assert.equal(switches.length, 2, '应该有两个开关');
  assert.deepEqual(switches.map((node) => node.props['data-on']), ['0', '1']);
});

await test('整篇编辑：改正文、加条目，文档里消失的归档', async () => {
  renderPage('zh');
  await settle(10);

  mini.click(mini.findByText(view, makeT('zh')('editDoc'), 'button'));
  await settle(6);
  const area = mini.findAllByTag(view, 'textarea').find(byClass('dshmem_area_doc'));
  assert.ok(area, '点「编辑」没有打开整篇文本框');
  assert.match(area.props.value, /^## 项目记忆$/m);
  assert.match(area.props.value, /\*\*插件安装方式\*\*/);

  const kept = 'package 进入 dsh.profile.bundles 后，其 cordis.patch.yml 会被自动应用。';
  mini.type(
    area,
    ['## 项目记忆', '**档案新条目**', '整篇编辑写进来的正文。', '', '**插件安装方式**', kept].join('\n'),
  );
  await settle(6);
  mini.click(mini.findByText(view, makeT('zh')('save'), 'button'));
  await settle(20);

  const all = store.list({ workspace: WS, includeGlobal: true, includeArchived: true }).records;
  const fresh = all.find((record) => record.title === '档案新条目');
  assert.ok(fresh, '整篇编辑新建的条目没进库');
  assert.equal(fresh.content, '整篇编辑写进来的正文。');
  assert.equal(fresh.scope, 'workspace');
  assert.equal(fresh.archived, false);
  assert.equal(
    all.find((record) => record.title === '插件安装方式').archived,
    false,
    '文档里保留的条目不该被归档',
  );
  assert.equal(
    all.find((record) => record.title === '全局偏好').archived,
    true,
    '文档里消失的条目应该被归档（而不是删除）',
  );
  assert.deepEqual(
    all.filter((record) => !record.archived).map((record) => record.title).sort(),
    ['插件安装方式', '档案新条目'],
  );
  assert.match(text(), new RegExp(escapeRe(makeT('zh')('docSaved').slice(0, 4))));
});

await test('整理：每个同标签分组各自合并，原条目归档', async () => {
  for (const seed of [
    { title: '整理甲', content: '甲的内容', category: 'fact', tags: ['tidy'] },
    { title: '整理乙', content: '乙的内容', category: 'fact', tags: ['tidy'] },
  ]) {
    await api.handle({
      method: 'POST',
      pathname: `${API_PREFIX}/save`,
      body: { workspace: WS, source: 'manual', ...seed },
    });
  }

  renderPage('zh');
  await settle(10);
  mini.click(mini.findByText(view, makeT('zh')('tidy'), 'button'));
  await settle(20);

  const all = store.list({ workspace: WS, includeArchived: true }).records;
  const merged = all.find((record) => record.title === 'tidy' && !record.archived);
  assert.ok(merged, '整理没有生成合并条');
  assert.deepEqual(merged.tags, ['tidy']);
  assert.ok(merged.content.includes('整理甲') && merged.content.includes('整理乙'), '合并正文不完整');
  for (const title of ['整理甲', '整理乙']) {
    assert.equal(all.find((record) => record.title === title).archived, true, `${title} 没有被归档`);
  }
  assert.match(text(), new RegExp(escapeRe(makeT('zh')('tidied').slice(0, 3))));
});

await test('整理/整合不把红线当普通条目合并', async () => {
  const red = store.upsert(
    { title: '红线不参与整合', content: '任何情况下都不得删除生产数据。', category: 'constraint', tags: ['redguard'], source: 'user' },
    { workspace: WS },
  ).record;
  for (const seed of [
    { title: '可整合甲', content: '甲的内容', category: 'fact', tags: ['redguard'] },
    { title: '可整合乙', content: '乙的内容', category: 'fact', tags: ['redguard'] },
  ]) {
    await api.handle({
      method: 'POST',
      pathname: `${API_PREFIX}/save`,
      body: { workspace: WS, source: 'manual', ...seed },
    });
  }

  renderPage('zh');
  await settle(10);
  await setLayout('tag');
  const group = mini
    .findAll(view, byClass('dshmem_group'))
    .find((node) => mini.textOf(node).includes('#redguard'));
  assert.ok(group, '找不到 redguard 分组');
  const consolidate = mini.findByText(group, makeT('zh')('consolidate'), 'button');
  assert.ok(consolidate, '两条可合并 + 一条红线时仍应有整合入口');
  mini.click(consolidate);
  await settle(6);

  const contentArea = mini
    .findAllByTag(view, 'textarea')
    .find((node) => node.props.placeholder === makeT('zh')('fContentPh'));
  assert.ok(contentArea, '整合没有打开编辑表单');
  assert.ok(
    contentArea.props.value.includes('可整合甲') && contentArea.props.value.includes('可整合乙'),
    '可合并条目应进入整合稿',
  );
  assert.ok(
    !contentArea.props.value.includes('红线不参与整合') && !contentArea.props.value.includes('不得删除生产数据'),
    '红线内容不应进入整合稿',
  );
  mini.click(mini.findByText(view, makeT('zh')('cancel'), 'button'));
  await settle(4);

  mini.click(mini.findByText(view, makeT('zh')('tidy'), 'button'));
  await settle(20);
  const all = store.list({ workspace: WS, includeArchived: true }).records;
  assert.equal(store.get(red.id, { workspace: WS }).archived, false, '红线不应被整理归档');
  const merged = all.find((record) => record.title === 'redguard' && !record.archived);
  assert.ok(merged, '整理应合并两条可合并记忆');
  assert.ok(
    !merged.content.includes('红线不参与整合') && !merged.content.includes('不得删除生产数据'),
    '红线内容不应进入整理稿',
  );
  await api.handle({
    method: 'POST',
    pathname: `${API_PREFIX}/delete`,
    body: { workspace: WS, id: red.id, overrideRedline: true },
  });
});

await test('没有可整理的标签分组时直说，不发写请求', async () => {
  // 重新挂载：提示条靠 2600ms 定时器自动消失，复用上一页实例会让上一条提示的定时器
  // 正好在这次断言前把新提示清掉（实测确实被清掉）。新实例没有待触发的定时器。
  renderPage('zh');
  await settle(10);
  const writes = fetchCalls.length;
  mini.click(mini.findByText(view, makeT('zh')('tidy'), 'button'));
  await settle(10);
  const made = fetchCalls.slice(writes).map((call) => call.pathname);
  assert.equal(made.length, 0, `没有可整的分组却发了请求：${made.join(', ')}`);
  assert.match(text(), new RegExp(escapeRe(makeT('zh')('tidyNothing').slice(0, 6))));
});

await test('整理跳过疑似矛盾的分组，不把正反结论揉成一条', async () => {
  for (const seed of [
    { title: '矛盾整理要', content: '项目统一使用 pnpm 安装依赖。', tags: ['contradict-tidy'] },
    { title: '矛盾整理不要', content: '项目不要统一使用 pnpm 安装依赖。', tags: ['contradict-tidy'] },
  ]) {
    await api.handle({
      method: 'POST',
      pathname: `${API_PREFIX}/save`,
      body: { workspace: WS, source: 'manual', ...seed },
    });
  }

  renderPage('zh');
  await settle(10);
  mini.click(mini.findByText(view, makeT('zh')('tidy'), 'button'));
  await settle(20);

  const all = store.list({ workspace: WS, includeArchived: true }).records;
  assert.ok(
    !all.some((record) => record.title === 'contradict-tidy' && !record.archived),
    '矛盾分组不应生成合并条',
  );
  for (const title of ['矛盾整理要', '矛盾整理不要']) {
    assert.equal(all.find((record) => record.title === title).archived, false, `${title} 不应被归档`);
  }
});

await test('档案页的两个开关即时写入设置（走 /settings）', async () => {
  const before = fetchCalls.filter((call) => call.pathname === `${API_PREFIX}/settings`).length;

  mini.click(switchNodes()[0]);
  await settle(10);
  assert.equal(settings.get().autoCapture, true, '对话记忆开关没有落库');
  mini.click(switchNodes()[1]);
  await settle(10);
  assert.equal(settings.get().mirror, false, '本地记忆与技能开关没有落库');

  const after = fetchCalls.filter((call) => call.pathname === `${API_PREFIX}/settings`).length;
  assert.equal(after - before, 2, '两个开关应该各发一次 /settings');

  /* 重新挂载后开关状态来自后端，而不是只改了本地 state。 */
  renderPage('zh');
  await settle(10);
  assert.deepEqual(switchNodes().map((node) => node.props['data-on']), ['1', '0']);
});

/* ---------------- 英文 ---------------- */

await test('英文界面不带中文残留（导航/按钮走 en 字典）', async () => {
  renderPage('en');
  await settle();
  const body = text();
  assert.match(body, /Memories/);
  assert.match(body, /No form needed to add a memory/);
  assert.doesNotMatch(body, /直接在对话里说/);
  // 新建按钮只在管理视图里，切过去再断言它也是英文。
  await switchView('viewList', 'en');
  const list = text();
  assert.match(list, /New memory/);
  assert.doesNotMatch(list, /新建记忆/);
});

await test('所有 t(...) 键都在 zh 与 en 字典里', async () => {
  const used = new Set();
  const pattern = /(?<![\w$.])t\("([A-Za-z0-9_]+)"\)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) used.add(match[1]);
  const { zh, en } = localeRegistration.dicts;
  const missingZh = [...used].filter((key) => !(key in zh));
  const missingEn = [...used].filter((key) => !(key in en));
  assert.deepEqual(missingZh, [], `zh 缺少: ${missingZh.join(', ')}`);
  assert.deepEqual(missingEn, [], `en 缺少: ${missingEn.join(', ')}`);
  assert.ok(used.size >= 60, `只用到 ${used.size} 个键，可能解析失败`);
});

await test('后端出错时页面显示错误而不是白屏', async () => {
  const originalHandle = api.handle;
  api.handle = async () => ({
    status: 500,
    body: { ok: false, error: 'boom', detail: { message: '炸了' } },
  });
  try {
    handle = mini.render(
      mini.react.createElement(slotRegistration.component, {
        t: makeT('zh'),
        close() {},
        useMemoryLocale: (selector) => selector({ revision: 1 }),
      }),
    );
    view = handle.tree;
    await settle(8);
    assert.match(text(), /boom|炸了/, '错误没有呈现给用户');
    assert.doesNotMatch(text(), /新建记忆/, '出错时仍然渲染了正常内容');
  } finally {
    api.handle = originalHandle;
  }
});

/* ---------------- v0.3.3：变化横幅 / 注入预览 / 时间线排布 / 维护页 ---------------- */

/** tab 按钮可能带数量徽标（如「维护 2」），用 includes 而不是全等。 */
const clickTab = async (key, locale = 'zh') => {
  const label = makeT(locale)(key);
  const button = mini
    .findAll(view, (node) => node.type === 'button' && mini.textOf(node).includes(label))
    .find((node) => mini.textOf(node).trim().startsWith(label));
  assert.ok(button, `找不到 tab：${label}`);
  mini.click(button);
  await settle(8);
};

await test('记忆库顶部：变化横幅 + 注入预览（/briefing-preview 被调用，简报条目带标记）', async () => {
  await api.handle({
    method: 'POST',
    pathname: `${API_PREFIX}/save`,
    body: { workspace: WS, title: '横幅专用记忆', content: '二十四小时内的变化。' },
  });

  renderPage('zh');
  await settle(8);
  const body = text();
  assert.match(body, new RegExp(escapeRe(makeT('zh')('recentTitle'))), '缺少「刚刚记了什么」横幅');
  /* 「下次会话将注入」预览区已按用户要求撤下，但 ids 拉取仍发生（✓ 简报 标记依赖）。 */
  assert.doesNotMatch(body, new RegExp(escapeRe(makeT('zh')('briefPreviewTitle'))), '注入预览区不应再渲染');
  assert.ok(
    fetchCalls.some((call) => call.pathname === `${API_PREFIX}/briefing-preview`),
    '/briefing-preview 未被调用',
  );
  /* 索引模式、条数远小于上限：所有可见条目都应带「✓ 简报」标记。 */
  assert.match(body, /✓ 简报/, '简报内条目应带标记');

  /* 变化横幅默认收起：标题在档案索引里出现 1 次；点「展开」后横幅会再列一次（≥2 次）。 */
  const countOccurrences = (hay, needle) => hay.split(needle).length - 1;
  assert.equal(
    countOccurrences(body, '横幅专用记忆'),
    1,
    '收起时该条目只应出现在档案索引里',
  );
  const expand = mini.findByText(view, makeT('zh')('recentOpen'), 'button');
  assert.ok(expand, '缺少展开按钮');
  mini.click(expand);
  await settle(6);
  assert.ok(
    countOccurrences(text(), '横幅专用记忆') >= 2,
    '展开后变化横幅应额外列出这条新记忆',
  );
});

await test('时间线排布：档案视图下拉切到时间线，含归档记忆，点条目打开编辑器', async () => {
  const saved = await api.handle({
    method: 'POST',
    pathname: `${API_PREFIX}/save`,
    body: { workspace: WS, title: '时间线专用记忆', content: '时间线正文第一行。\n第二行细节。' },
  });
  await api.handle({
    method: 'POST',
    pathname: `${API_PREFIX}/update`,
    body: { workspace: WS, id: saved.body.record.id, archived: true },
  });

  renderPage('zh');
  await settle(8);
  /* 档案视图的工具栏里只有排布下拉这一个 select。 */
  const groupBySelect = mini
    .findAllByTag(view, 'select')
    .find((node) => ['none', 'tag', 'category', 'timeline'].includes(node.props.value));
  assert.ok(groupBySelect, '找不到排布下拉');
  assert.ok(
    fetchCalls.some((call) => call.pathname === `${API_PREFIX}/timeline`),
    '/timeline 应随页面加载（时间线排布的数据源）',
  );
  groupBySelect.props.onChange({ target: { value: 'timeline' } });
  await settle(10);

  assert.match(text(), /时间线专用记忆/, '归档条目也应出现在时间线里');
  const findItem = () =>
    mini
      .findAll(view, byClass('dshmem_tlItem'))
      .find((node) => mini.textOf(node).includes('时间线专用记忆'));
  assert.ok(findItem(), '找不到时间线条目');

  /* 折叠语言与档案条目一致：点 chevron/标题 = 展开全文（内容不默认铺开）。 */
  assert.ok(mini.textOf(findItem()).includes('时间线正文第一行。'), '收起态应显示一句话钩子');
  assert.ok(!mini.textOf(findItem()).includes('第二行细节。'), '时间线正文默认应收起（只显示钩子）');
  const chev = mini.findAll(findItem(), byClass('dshmem_chev'))[0];
  assert.ok(chev, '时间线条目应有展开箭头');
  mini.click(chev);
  await settle(6);
  assert.ok(mini.textOf(findItem()).includes('第二行细节。'), '点开应展开全文');

  /* 编辑走 hover 小按钮（不再点整卡打开编辑器）。 */
  const editLink = mini.findAll(findItem(), byClass('dshmem_docFree'))[0];
  assert.ok(editLink, '时间线条目应有编辑入口');
  mini.click(editLink);
  await settle(6);
  assert.ok(
    mini.findAllByTag(view, 'textarea').some((node) => node.props.placeholder === makeT('zh')('fContentPh')),
    '点编辑入口应打开编辑器',
  );
});

await test('维护 tab：KPI 与体检结果渲染，/health 真被调用', async () => {
  const exposed = store.upsert(
    { title: '面板曝光未用示例', content: '被注入多次但从未被打开或引用。' },
    { workspace: WS },
  ).record;
  for (let i = 0; i < 3; i += 1) store.markExposed([exposed.id], { workspace: WS });
  /* 体检新增项的种子：一对真矛盾 + 一条挂靠文件已不存在的记忆。 */
  store.upsert({ title: '面板包管理器约定', content: '这个项目统一使用 pnpm 安装依赖。', tags: ['tooling'] }, { workspace: WS });
  store.upsert({ title: '面板包管理器迁移', content: '不要再用 pnpm 了，改用 npm 安装依赖。', tags: ['tooling'] }, { workspace: WS });
  store.upsert(
    { title: '面板失效文件引用', content: '挂在一个已不存在的文件上的记忆。', files: [path.join(tmp, 'gone-folder', 'gone.ts')] },
    { workspace: WS },
  );
  renderPage('zh');
  await settle(8);
  await clickTab('tabMaintain');
  const body = text();
  assert.match(body, new RegExp(escapeRe(makeT('zh')('healthKpiTotal'))), '缺少记忆总数 KPI');
  assert.match(body, new RegExp(escapeRe(makeT('zh')('healthToken'))), '缺少简报注入 KPI');
  assert.match(body, new RegExp(escapeRe(makeT('zh')('healthProblems'))), '缺少体检结果区');
  assert.match(body, new RegExp(escapeRe(makeT('zh')('healthExposedUnused'))), '缺少曝光未用提示');
  assert.match(body, /面板曝光未用示例 ×3/, '应显示曝光次数');
  assert.match(body, new RegExp(escapeRe(makeT('zh')('healthContradictions'))), '缺少疑似矛盾区');
  /* a 是含否定句的一方（迁移），b 是被指涉的一方（约定），面板按 a ⇄ b 展示。 */
  assert.match(body, /面板包管理器迁移 ⇄ 面板包管理器约定/, '矛盾对应显示双方标题');
  assert.match(body, new RegExp(escapeRe(makeT('zh')('healthDeadFiles'))), '缺少文件引用失效区');
  assert.match(body, /面板失效文件引用/, '失效文件条目应显示标题');
  assert.ok(fetchCalls.some((call) => call.pathname === `${API_PREFIX}/health`), '/health 未被调用');
});

await test('维护页：Dream 按钮调用 /dream 并显示报告', async () => {
  store.upsert({ title: 'Dream 重复 A', content: 'dream 整理测试 identical-content' }, { workspace: WS });
  store.upsert({ title: 'Dream 重复 B', content: 'dream 整理测试 identical-content' }, { workspace: WS });
  const unused = store.upsert(
    { title: 'Dream 曝光未用', content: '只被注入过，从未被打开或引用。' },
    { workspace: WS },
  ).record;
  for (let i = 0; i < 3; i += 1) store.markExposed([unused.id], { workspace: WS });
  fetchCalls.length = 0;
  renderPage('zh');
  await settle(8);
  await clickTab('tabMaintain');

  const btn = mini.findByText(view, makeT('zh')('dreamRun'), 'button');
  assert.ok(btn, '缺少 Dream 按钮');
  mini.click(btn);
  await settle(16);

  assert.ok(fetchCalls.some((call) => call.pathname === `${API_PREFIX}/dream`), '/dream 应被调用');
  const body = text();
  assert.match(body, /合并 1 簇/, '应显示合并簇数');
  assert.match(body, /曝光未用 [1-9]\d* 条/, '应显示曝光未用数');
  assert.match(body, /Dream 完成/, '应有完成提示');
});

await test('维护页：自动整理卡显示间隔、上次结果与到期日', async () => {
  settingsValue.autoDreamDays = 7;
  settingsValue.autoDreamPortrait = true;
  store.noteMaintenance(WS, {
    at: '2026-10-01T00:00:00.000Z',
    source: 'auto',
    report: { merged: 2, contradictionsResolved: 1, portrait: 'saved' },
  });
  try {
    renderPage('zh');
    await settle(8);
    await clickTab('tabMaintain');
    await settle(8);

    const body = text();
    assert.match(body, /自动整理 · 打开 DSH 时/, '应有自动整理卡');
    assert.match(body, /距上次整理满 7 天/, '应显示间隔');
    assert.match(body, /上次整理：2026-10-01/, '应显示上次整理日期');
    assert.match(body, /到期日：2026-10-08/, '应显示下次到期日');
    assert.match(body, /合并 2 簇/, '应显示上次合并结果');
  } finally {
    delete settingsValue.autoDreamDays;
    delete settingsValue.autoDreamPortrait;
  }
});

await test('维护页：Dream 画像不可用时跳过，真实失败显示明细', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'client-dream-skip-'));
  const dreamStore = createMemoryStore({ dir, mirror: false });
  const ws = path.join(tmp, 'client-dream-ws');
  fs.mkdirSync(ws, { recursive: true });
  dreamStore.upsert({ title: '客户端跳过重复甲', content: '客户端跳过重复内容' }, { workspace: ws });
  dreamStore.upsert({ title: '客户端跳过重复乙', content: '客户端跳过重复内容' }, { workspace: ws });

  const base = {
    store: dreamStore,
    settings,
    activeWorkspace: () => ws,
    listWorkspaces: () => [{ root: ws, key: 'k', count: 0, active: true }],
  };
  const skipApi = createApi({
    ...base,
    rewriteNow: async () => ({ ok: false, error: 'no_model_route', detail: '当前没有可用的模型路由' }),
  });

  activeApi = skipApi;
  try {
    renderPage('zh');
    await settle(10);
    await clickTab('tabMaintain');
    await settle(8);
    mini.click(mini.findByText(view, makeT('zh')('dreamRun'), 'button'));
    await settle(16);

    const body = text();
    assert.match(body, /合并 1 簇/, '画像跳过不应影响合并');
    assert.match(
      body,
      new RegExp(
        escapeRe(
          makeT('zh')('dreamPortraitSkipped').replace('{reason}', makeT('zh')('dreamSkipNoRoute')),
        ),
      ),
      '无模型会话应显示跳过原因',
    );
    assert.doesNotMatch(body, /步出错/, '无模型会话不应算失败');

    dreamStore.upsert({ title: '客户端失败重复甲', content: '客户端失败重复内容' }, { workspace: ws });
    dreamStore.upsert({ title: '客户端失败重复乙', content: '客户端失败重复内容' }, { workspace: ws });
    const failApi = createApi({
      ...base,
      rewriteNow: async () => ({ ok: false, error: 'rewrite_failed', detail: '模型输出解析失败' }),
    });
    activeApi = failApi;
    renderPage('zh');
    await settle(10);
    await clickTab('tabMaintain');
    await settle(8);
    mini.click(mini.findByText(view, makeT('zh')('dreamRun'), 'button'));
    await settle(16);

    const failedBody = text();
    assert.match(failedBody, /1 步出错/);
    assert.match(failedBody, /模型输出解析失败/, '真实失败应显示明细');
  } finally {
    activeApi = api;
  }
});

await test('维护页：Dream 只报告矛盾，确认后才按时序归档', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'client-time-order-'));
  const s = createMemoryStore({ dir, mirror: false });
  const ws = path.join(tmp, 'client-time-order-ws');
  fs.mkdirSync(ws, { recursive: true });
  const add = (title, content, source, createdAt, tags) =>
    s.upsert({ title, content, source, createdAt, tags }, { workspace: ws }).record;
  const oldSafe = add('部署前必须跑完整测试。', '部署前必须跑完整测试。', 'agent', '2026-01-01T00:00:00.000Z', ['deploy-time-ui']);
  const newSafe = add('部署前不要跑完整测试。', '部署前不要跑完整测试。', 'manual', '2026-02-01T00:00:00.000Z', ['deploy-time-ui']);
  const timeApi = createApi({
    store: s,
    settings,
    activeWorkspace: () => ws,
    listWorkspaces: () => [{ root: ws, key: 'k', count: 0, active: true }],
  });

  activeApi = timeApi;
  try {
    renderPage('zh');
    await settle(10);
    await clickTab('tabMaintain');
    await settle(8);
    mini.click(mini.findByText(view, makeT('zh')('dreamRun'), 'button'));
    await settle(16);

    const body = text();
    assert.match(
      body,
      new RegExp(escapeRe(makeT('zh')('dreamContradictionsPending').replace('{n}', '1'))),
      'Dream 应把词法矛盾列为待确认',
    );
    assert.match(body, new RegExp(escapeRe(oldSafe.title)), '应显示旧结论');
    assert.match(body, new RegExp(escapeRe(newSafe.title)), '应显示新结论');
    assert.equal(s.get(oldSafe.id, { workspace: ws }).archived, false, 'Dream 不应自动归档');
    assert.equal(s.get(newSafe.id, { workspace: ws }).archived, false);

    const timeOrder = mini.findByText(view, makeT('zh')('healthTimeOrder'), 'button');
    assert.ok(timeOrder, '待确认矛盾应提供按时序归档按钮');
    mini.click(timeOrder);
    await settle(16);
    assert.equal(s.get(oldSafe.id, { workspace: ws }).archived, true, '确认后才归档旧条');
    assert.equal(s.get(newSafe.id, { workspace: ws }).archived, false);

    const oldTwo = add('数据库只读。', '数据库只读。', 'agent', '2026-01-01T00:00:00.000Z', ['db-time-ui']);
    const newTwo = add('数据库不要只读。', '数据库不要只读。', 'manual', '2026-02-01T00:00:00.000Z', ['db-time-ui']);
    renderPage('zh');
    await settle(10);
    await clickTab('tabMaintain');
    await settle(10);
    const timeOrderTwo = mini.findByText(view, makeT('zh')('healthTimeOrder'), 'button');
    assert.ok(timeOrderTwo, '第二对应仍提供按时序归档按钮');
    mini.click(timeOrderTwo);
    await settle(16);
    assert.equal(s.get(oldTwo.id, { workspace: ws }).archived, true);
    assert.equal(s.get(newTwo.id, { workspace: ws }).archived, false);
  } finally {
    activeApi = api;
  }
});

await test('维护页：注入审计显示最近进 prompt 的字节与 hash', async () => {
  store.injectionLogAppend(WS, {
    kind: 'briefing',
    mode: 'index',
    ids: ['mem_audit_demo'],
    text: '注入审计样例正文：这一行真的进过 prompt。',
  });
  fetchCalls.length = 0;
  renderPage('zh');
  await settle(8);
  await clickTab('tabMaintain');
  await settle(8);

  const body = text();
  assert.match(body, new RegExp(escapeRe(makeT('zh')('injectionTitle'))), '缺少注入审计卡');
  assert.match(body, /注入审计样例正文/, '应显示注入预览');
  assert.ok(
    fetchCalls.some((call) => call.pathname === `${API_PREFIX}/injections`),
    '/injections 应被调用',
  );
});

await test('维护页：整库快照卡列出备份，点「立即备份」调 /backup', async () => {
  fetchCalls.length = 0;
  renderPage('zh');
  await settle(8);
  await clickTab('tabMaintain');
  await settle(8);

  assert.match(text(), new RegExp(escapeRe(makeT('zh')('backupTitle'))), '缺少整库快照卡');
  assert.ok(
    fetchCalls.some((call) => call.pathname === `${API_PREFIX}/backups`),
    '/backups 应被调用',
  );

  const btn = mini.findByText(view, makeT('zh')('backupRun'), 'button');
  assert.ok(btn, '缺少「立即备份」按钮');
  mini.click(btn);
  await settle(14);

  assert.ok(
    fetchCalls.some((call) => call.pathname === `${API_PREFIX}/backup` && call.method === 'POST'),
    '/backup 应被调用',
  );
  const backups = store.snapshots({ limit: 50 });
  assert.ok(backups.length >= 1, '点完应该真的落了一份快照');
  assert.match(text(), new RegExp(escapeRe(makeT('zh')('backupDone').slice(0, 4))), '应有备份完成提示');
  assert.ok(text().includes(backups[0].name.slice(0, 10)), '清单应显示快照时间');
});

await test('画像卡：段落带证据标签，没有证据的段标「未溯源」（全局画像块）', async () => {
  const version = (store.portrait('')?.version || 0) + 1;
  await api.handle({
    method: 'POST',
    pathname: `${API_PREFIX}/portrait/save`,
    body: {
      workspace: WS,
      scope: 'global',
      sections: [
        { key: 'background', text: '有证据的背景段。' },
        { key: 'focus', text: '没有证据的关注段。' },
      ],
      evidence: { background: ['mem_evidence_demo', 'journal:2026-10-20'] },
    },
  });

  renderPage('zh');
  await settle(8);

  const body = text();
  assert.match(body, new RegExp(escapeRe(makeT('zh')('portraitGlobalLabel'))), '应有全局画像块');
  assert.match(body, /#mem_evidence_demo/, '默认展开的画像应显示记忆证据标签');
  assert.match(body, /2026-10-20 日志/, '应显示日志证据');
  assert.match(
    body,
    new RegExp(escapeRe(makeT('zh')('portraitUntraced'))),
    '没有证据的段应标未溯源',
  );
});

await test('画像依据下钻：点证据标签显示来源原文', async () => {
  const source = store.upsert(
    { title: '依据原文标题', content: '这是被画像引用的原文。', category: 'fact' },
    { workspace: WS },
  ).record;
  await api.handle({
    method: 'POST',
    pathname: `${API_PREFIX}/portrait/save`,
    body: {
      workspace: WS,
      scope: 'global',
      sections: [{ key: 'background', text: '有依据的背景。' }],
      evidence: { background: [source.id] },
    },
  });
  renderPage('zh');
  await settle(10);
  const chip = mini.findAll(
    view,
    (node) =>
      node.type === 'span' &&
      typeof node.props?.onClick === 'function' &&
      mini.textOf(node) === `#${source.id}`,
  )[0];
  assert.ok(chip, '找不到可点击的依据标签');
  mini.click(chip);
  await settle(10);
  assert.match(text(), /依据原文标题/, '依据面板应显示来源标题');
  assert.match(text(), /这是被画像引用的原文。/, '依据面板应显示来源正文');
  assert.ok(
    fetchCalls.some((call) => call.pathname === `${API_PREFIX}/record`),
    '/record 应被调用',
  );
  await api.handle({
    method: 'POST',
    pathname: `${API_PREFIX}/delete`,
    body: { workspace: WS, id: source.id },
  });
});

await test('维护页待审队列：草稿批准后生效、拒绝后消失，徽标随草稿数变化', async () => {
  const d1 = store.upsert(
    { title: '审批草稿甲', content: '甲草稿正文', status: 'draft', source: 'auto' },
    { workspace: WS },
  );
  const d2 = store.upsert(
    { title: '审批草稿乙', content: '乙草稿正文', status: 'draft', source: 'auto' },
    { workspace: WS },
  );

  renderPage('zh');
  await settle(8);
  const maintainTab = mini
    .findAll(view, (node) => node.type === 'button' && mini.textOf(node).includes(makeT('zh')('tabMaintain')))
    .find((node) => mini.textOf(node).includes('2'));
  assert.ok(maintainTab, '有草稿时维护 tab 应带数量徽标');
  mini.click(maintainTab);
  await settle(8);

  const cards = mini.findAll(view, byClass('dshmem_draftCard'));
  assert.equal(cards.length, 2, '应有两张草稿卡');

  const approveBtn = mini.findByText(
    cards.find((card) => mini.textOf(card).includes('甲')),
    makeT('zh')('queueApprove'),
    'button',
  );
  assert.ok(approveBtn, '找不到批准按钮');
  mini.click(approveBtn);
  await settle(12);
  assert.equal(
    store.get(d1.record.id, { workspace: WS, includeDrafts: true }).status,
    'active',
    '批准后草稿应转正',
  );

  const cardB = mini
    .findAll(view, byClass('dshmem_draftCard'))
    .find((card) => mini.textOf(card).includes('乙'));
  assert.ok(cardB, '乙草稿卡应还在队列里');
  confirmAnswer = true;
  mini.click(mini.findByText(cardB, makeT('zh')('queueReject'), 'button'));
  await settle(12);
  assert.equal(store.get(d2.record.id, { workspace: WS, includeDrafts: true }), null, '拒绝即删除');
  assert.match(text(), new RegExp(escapeRe(makeT('zh')('queueEmpty'))), '处理完后队列应显示为空');

  renderPage('zh');
  await settle(8);
  const bareTab = mini
    .findAll(view, (node) => node.type === 'button' && mini.textOf(node).includes(makeT('zh')('tabMaintain')))
    .find((node) => mini.textOf(node).trim() === makeT('zh')('tabMaintain'));
  assert.ok(bareTab, '维护 tab 常驻');
});

/* ------------------------------------------------------------------ *
 * 画像卡（portrait）
 * ------------------------------------------------------------------ */

await test('画像卡：只渲染全局画像块（工作区画像不再出现），编辑保存走 /portrait/save', async () => {
  /* Dream 测试可能已经触发过一次画像重写：基准版本号要在本测试写入前取。 */
  const baseGlVersion = store.portrait('')?.version || 0;

  /* 准备：工作区与全局各写一份画像——工作区那份数据在场，但面板不应再渲染它。 */
  await api.handle({
    method: 'POST',
    pathname: `${API_PREFIX}/portrait/save`,
    body: {
      workspace: WS,
      sections: [
        { key: 'background', text: '客户端测试背景。' },
        { key: 'focus', text: '客户端测试关注。' },
      ],
    },
  });
  await api.handle({
    method: 'POST',
    pathname: `${API_PREFIX}/portrait/save`,
    body: { workspace: WS, scope: 'global', sections: [{ key: 'preference', text: '全局偏好文本。' }] },
  });

  /* 版本号用动态值：本测试自己 +1，之前的 Dream/重写可能已经推过版本。 */
  fetchCalls.length = 0;
  renderPage('zh');
  await settle(8);

  /* 外层「画像」标题已删（与子块「全局画像」重复命名），改断言工具行按钮在场。 */
  assert.ok(mini.findByText(view, makeT('zh')('portraitRewrite'), 'button'), '缺少画像工具行按钮');
  assert.ok(
    fetchCalls.some((call) => call.pathname === `${API_PREFIX}/portrait`),
    '/portrait 应随页面加载',
  );

  /* 平铺结构：只铺「全局画像」一个子块，正文默认展开；工作区画像块不再出现。 */
  const opened = text();
  assert.match(opened, new RegExp(escapeRe(makeT('zh')('portraitGlobalLabel'))), '应有全局画像块');
  assert.doesNotMatch(
    opened,
    new RegExp(escapeRe(makeT('zh')('portraitWorkspaceLabel'))),
    '工作区画像块不应再出现',
  );
  assert.match(opened, /v\d+/, '应显示版本号');
  assert.ok(opened.includes('全局偏好文本。'), '画像正文应默认展开');

  /* 折叠语言仍可用：点标题收起，再点展开。 */
  const glTitle = mini.findByText(
    view,
    `${makeT('zh')('portraitGlobalLabel')} v${baseGlVersion + 1}`,
    'span',
  );
  assert.ok(glTitle, '找不到全局画像子行标题');
  mini.click(glTitle);
  await settle(6);
  assert.ok(!text().includes('全局偏好文本。'), '点标题应收起正文');
  mini.click(glTitle);
  await settle(6);
  assert.ok(text().includes('全局偏好文本。'), '再点标题应重新展开正文');

  /* 编辑全局画像（第一个「编辑」按钮 = 画像卡内的全局画像；全局段标题用 globalTitle）。 */
  const edit = mini.findByText(view, makeT('zh')('editDoc'), 'button');
  assert.ok(edit, '缺少编辑按钮');
  mini.click(edit);
  await settle(6);

  const area = mini
    .findAllByTag(view, 'textarea')
    .find((node) => String(node.props.value || '').includes('**个人背景**'));
  assert.ok(area, '点编辑应打开全局画像编辑框（含段标题）');
  area.props.onChange({ target: { value: '**个人背景**\n改过的偏好。' } });
  await settle(4);

  const save = mini.findByText(view, makeT('zh')('save'), 'button');
  assert.ok(save, '缺少保存按钮');
  mini.click(save);
  await settle(12);

  const after = store.portrait('');
  assert.equal(after.version, baseGlVersion + 2, '保存后版本递增（初始保存 + 编辑保存）');
  assert.equal(after.sections.find((s) => s.key === 'preference').text, '改过的偏好。');
  assert.ok(
    fetchCalls.some((call) => call.pathname === `${API_PREFIX}/portrait/save` && call.method === 'POST'),
    '/portrait/save 应被调用',
  );
  assert.match(text(), /画像已保存/, '保存后应出现提示');
});

await test('画像逐段编辑：只更新当前段，其他段不动', async () => {
  await api.handle({
    method: 'POST',
    pathname: `${API_PREFIX}/portrait/save`,
    body: {
      workspace: WS,
      scope: 'global',
      sections: [
        { key: 'background', text: '逐段编辑前。' },
        { key: 'focus', text: '另一段不动。' },
      ],
    },
  });
  renderPage('zh');
  await settle(10);

  const section = mini.findAll(
    view,
    (node) => String(node.props?.className || '').includes('dshmem_docPara') && mini.textOf(node).includes('逐段编辑前。'),
  )[0];
  assert.ok(section, '找不到待编辑的画像段落');
  const edit = mini.findByText(section, makeT('zh')('portraitEditSection'), 'button');
  assert.ok(edit, '段落缺少「编辑本段」入口');
  mini.click(edit);
  await settle(6);

  const area = mini
    .findAllByTag(view, 'textarea')
    .find((node) => node.props.value === '逐段编辑前。');
  assert.ok(area, '段落编辑框没有带出原文');
  mini.type(area, '逐段编辑后。');
  await settle(4);
  mini.click(mini.findByText(view, makeT('zh')('save'), 'button'));
  await settle(14);

  const portrait = store.portrait('');
  assert.equal(portrait.sections.find((item) => item.key === 'background').text, '逐段编辑后。');
  assert.equal(portrait.sections.find((item) => item.key === 'focus').text, '另一段不动。');
});

await test('画像卡：这次变了什么——拉 /portrait/diff 并渲染 +/- 行（全局画像）', async () => {
  /* 种两版全局画像：v+1 旧文案、v+2 新文案，diff 应显示这一对增删行。 */
  const baseGlVersion = store.portrait('')?.version || 0;
  await api.handle({
    method: 'POST',
    pathname: `${API_PREFIX}/portrait/save`,
    body: { workspace: WS, scope: 'global', sections: [{ key: 'background', text: '客户端测试背景。' }] },
  });
  await api.handle({
    method: 'POST',
    pathname: `${API_PREFIX}/portrait/save`,
    body: { workspace: WS, scope: 'global', sections: [{ key: 'background', text: '改过的背景。' }] },
  });

  fetchCalls.length = 0;
  renderPage('zh');
  await settle(8);

  const diffBtn = mini.findByText(view, makeT('zh')('portraitDiff'), 'button');
  assert.ok(diffBtn, '缺少「这次变了什么」按钮');
  mini.click(diffBtn);
  await settle(12);

  assert.ok(
    fetchCalls.some((call) => call.pathname === `${API_PREFIX}/portrait/diff`),
    '/portrait/diff 应被调用',
  );
  const now = text();
  /* 版本区间用种出来的全局版本号锁死：同时验证 diff 请求走的是全局而非工作区。 */
  assert.match(now, new RegExp(`v${baseGlVersion + 1} → v${baseGlVersion + 2}`), '应显示全局画像版本区间');
  assert.match(now, /\+ 改过的背景。/, '应显示新增行');
  assert.match(now, /− 客户端测试背景。/, '应显示删除行');
});

await test('红线专用编辑器：新增、逐字预览、编辑', async () => {
  renderPage('zh');
  await settle(10);
  mini.click(mini.findByText(view, makeT('zh')('redlineAdd'), 'button'));
  await settle(6);

  const titleInput = mini
    .findAllByTag(view, 'input')
    .find((node) => node.props.placeholder === makeT('zh')('redlineTitlePh'));
  const contentArea = mini
    .findAllByTag(view, 'textarea')
    .find((node) => node.props.placeholder === makeT('zh')('redlineContentPh'));
  assert.ok(titleInput && contentArea, '红线编辑器没有渲染标题与正文输入');
  mini.type(titleInput, '红线编辑器测试');
  mini.type(contentArea, '任何情况下都不得删除生产数据。');
  await settle(6);
  assert.match(text(), /任何情况下都不得删除生产数据。/, '注入预览应包含原文');

  const scopeSelect = mini
    .findAllByTag(view, 'select')
    .find((node) => mini.textOf(node).includes(makeT('zh')('scopeGlobalFull')));
  assert.ok(scopeSelect, '缺少生效范围选择');
  mini.type(scopeSelect, 'global');
  await settle(4);

  mini.click(mini.findByText(view, makeT('zh')('save'), 'button'));
  await settle(14);

  const record = store
    .list({ workspace: WS, includeArchived: true })
    .records.find((item) => item.title === '红线编辑器测试');
  assert.ok(record, '新增红线没有落库');
  assert.equal(record.category, 'constraint');
  assert.equal(record.scope, 'global');
  assert.equal(record.source, 'manual');
  assert.equal(record.content, '任何情况下都不得删除生产数据。');

  mini.click(mini.findByText(view, makeT('zh')('redlineEdit'), 'button'));
  await settle(6);
  const editArea = mini
    .findAllByTag(view, 'textarea')
    .find((node) => node.props.value === '任何情况下都不得删除生产数据。');
  assert.ok(editArea, '编辑红线没有带出原文');
  mini.type(editArea, '任何情况下都不得删除生产环境的数据。');
  await settle(4);
  mini.click(mini.findByText(view, makeT('zh')('save'), 'button'));
  await settle(14);
  assert.equal(
    store.get(record.id, { workspace: WS }).content,
    '任何情况下都不得删除生产环境的数据。',
    '编辑红线应更新正文',
  );
  const afterEdit = store.get(record.id, { workspace: WS });
  assert.equal(afterEdit.redlineHistory.length, 1, '编辑红线应保留旧版本');
  assert.equal(afterEdit.redlineHistory[0].content, '任何情况下都不得删除生产数据。');

  const historyButton = mini.findByText(view, makeT('zh')('redlineHistory'), 'button');
  assert.ok(historyButton, '红线行缺少历史入口');
  mini.click(historyButton);
  await settle(8);
  assert.match(text(), /任何情况下都不得删除生产数据。/, '历史面板应显示旧措辞');
  const rollbackButton = mini.findByText(view, makeT('zh')('rollback'), 'button');
  assert.ok(rollbackButton, '历史面板缺少回滚按钮');
  mini.click(rollbackButton);
  await settle(14);
  assert.equal(
    store.get(record.id, { workspace: WS }).content,
    '任何情况下都不得删除生产数据。',
    '回滚应恢复旧措辞',
  );

  await api.handle({
    method: 'POST',
    pathname: `${API_PREFIX}/delete`,
    body: { workspace: WS, id: record.id, overrideRedline: true },
  });
});

await test('红线冲突提示：命中后不静默保存，确认后才落库', async () => {
  const existing = store.upsert(
    {
      title: '项目统一使用 pnpm 安装依赖。',
      content: '项目统一使用 pnpm 安装依赖。',
      category: 'constraint',
      source: 'user',
    },
    { workspace: WS },
  ).record;
  renderPage('zh');
  await settle(10);
  mini.click(mini.findByText(view, makeT('zh')('redlineAdd'), 'button'));
  await settle(6);
  const titleInput = mini
    .findAllByTag(view, 'input')
    .find((node) => node.props.placeholder === makeT('zh')('redlineTitlePh'));
  const contentArea = mini
    .findAllByTag(view, 'textarea')
    .find((node) => node.props.placeholder === makeT('zh')('redlineContentPh'));
  mini.type(titleInput, '项目不要统一使用 pnpm 安装依赖。');
  mini.type(contentArea, '项目不要统一使用 pnpm 安装依赖。');
  await settle(6);

  const countRedlines = () =>
    store.list({ workspace: WS, includeArchived: true }).records.filter((r) => r.category === 'constraint' && !r.archived).length;
  const before = countRedlines();
  mini.click(mini.findByText(view, makeT('zh')('save'), 'button'));
  await settle(12);
  assert.match(text(), new RegExp(escapeRe(makeT('zh')('redlineConflictHit'))), '应提示红线冲突');
  assert.equal(countRedlines(), before, '未确认冲突时不应落库');

  const saveAnyway = mini.findByText(view, makeT('zh')('redlineSaveAnyway'), 'button');
  assert.ok(saveAnyway, '冲突提示缺少「仍然保存」');
  mini.click(saveAnyway);
  await settle(14);
  assert.equal(countRedlines(), before + 1, '确认后应落库');

  const fresh = store
    .list({ workspace: WS, includeArchived: true })
    .records.find((r) => r.title === '项目不要统一使用 pnpm 安装依赖。');
  for (const id of [existing.id, fresh.id]) {
    await api.handle({
      method: 'POST',
      pathname: `${API_PREFIX}/delete`,
      body: { workspace: WS, id, overrideRedline: true },
    });
  }
});

await test('红线卡：置顶渲染，解除走 overrideRedline 确认通道', async () => {
  store.upsert(
    { title: '绝不 force push', content: '禁止对受保护分支 force push。', category: 'constraint', source: 'agent' },
    { workspace: WS },
  );
  renderPage('zh');
  await settle(8);

  const body = text();
  assert.match(body, new RegExp(escapeRe(makeT('zh')('redlineTitle'))), '红线卡应在画像之上');
  assert.match(body, /绝不 force push/, '红线条目标题应显示');

  /* 解除：确认后 /delete 必须带 overrideRedline（模型没有这条通道，仅面板有）。 */
  confirmAnswer = true;
  const liftBtn = mini.findByText(view, makeT('zh')('redlineRemove'), 'button');
  assert.ok(liftBtn, '缺少解除按钮');
  mini.click(liftBtn);
  await settle(12);
  const deleteCall = fetchCalls.find((call) => call.pathname === `${API_PREFIX}/delete`);
  assert.ok(deleteCall, '/delete 应被调用');
  assert.equal(deleteCall.body.overrideRedline, true, '解除红线必须带 overrideRedline');
  assert.ok(!text().includes('禁止对受保护分支'), '解除后红线不再渲染');
});

await test('画像卡：全局画像缺失时显示空态引导（工作区画像已撤下）', async () => {
  /* 只删全局画像（workspaces/_global/ 下的 portrait.json 与 PORTRAIT.md）；
     面板只剩全局画像一块 → 缺失时应在原位给空态引导（重写生成或走迁移卡导入）。 */
  const walk = (folder) => {
    for (const name of fs.readdirSync(folder)) {
      const full = path.join(folder, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if ((name === 'portrait.json' || name === 'PORTRAIT.md') && full.includes('_global')) {
        fs.rmSync(full, { force: true });
      }
    }
  };
  walk(tmp);
  renderPage('zh');
  await settle(8);

  const body = text();
  assert.match(body, new RegExp(escapeRe(makeT('zh')('portraitWorkspaceEmptyHint'))), '全局画像缺失时应显示空态引导');
  assert.match(body, new RegExp(escapeRe(makeT('zh')('portraitGlobalLabel'))), '空态引导块以「全局画像」为标题');
});

await test('画像卡：重写按钮触发 /portrait/rewrite（scope=global），完成后出提示', async () => {
  fetchCalls.length = 0;
  renderPage('zh');
  await settle(8);
  const rewrite = mini.findByText(view, makeT('zh')('portraitRewrite'), 'button');
  assert.ok(rewrite, '缺少重写按钮');
  mini.click(rewrite);
  await settle(14);
  assert.ok(
    fetchCalls.some(
      (call) =>
        call.pathname === `${API_PREFIX}/portrait/rewrite` &&
        call.method === 'POST' &&
        call.body?.scope === 'global',
    ),
    '/portrait/rewrite 应以 scope=global 被调用',
  );
  assert.match(text(), /画像已重写/, '应有完成提示');
  assert.equal(
    store.portrait('').sections.find((s) => s.key === 'background').text,
    '假重写背景。',
    '重写应落在全局画像',
  );
});

await test('画像卡：待审重写稿——预览与批准（全局）', async () => {
  store.portraitDraftWrite('', {
    sections: [{ key: 'background', text: '待审背景。' }],
    basedOn: { version: store.portrait('')?.version || 0 },
  });
  fetchCalls.length = 0;
  renderPage('zh');
  await settle(8);
  assert.match(text(), new RegExp(escapeRe(makeT('zh')('portraitDraftHint'))), '应有待审提示');

  const preview = mini.findByText(view, makeT('zh')('portraitDraftView'), 'button');
  assert.ok(preview, '缺少预览按钮');
  mini.click(preview);
  await settle(8);
  assert.match(text(), /待审背景。/, '预览应显示重写稿内容');

  const approve = mini.findByText(view, makeT('zh')('portraitDraftApprove'), 'button');
  assert.ok(approve, '缺少批准按钮');
  mini.click(approve);
  await settle(12);
  assert.equal(store.portraitDraftRead(''), null, '批准后全局待审清空');
  assert.equal(
    store.portrait('').sections.find((s) => s.key === 'background').text,
    '待审背景。',
  );
  assert.ok(
    fetchCalls.some((call) => call.pathname === `${API_PREFIX}/portrait/draft/approve`),
    'approve 端点应被调用',
  );
});

await test('工作日志条：展开拉取并显示当天日志', async () => {
  await api.handle({
    method: 'POST',
    pathname: `${API_PREFIX}/journal`,
    body: { workspace: WS, text: '客户端日志条目。' },
  });
  fetchCalls.length = 0;
  renderPage('zh');
  await settle(8);
  /* 「展开」按钮有多个（变化横幅 / 注入预览 / 日志条），日志条在最末尾。 */
  const opens = mini.findAll(
    view,
    (node) => node.type === 'button' && mini.textOf(node).trim() === makeT('zh')('recentOpen'),
  );
  assert.ok(opens.length >= 1, '应有展开按钮');
  mini.click(opens[opens.length - 1]);
  await settle(10);
  assert.ok(
    fetchCalls.some((call) => call.pathname === `${API_PREFIX}/journal`),
    '/journal 应被拉取',
  );
  assert.match(text(), /客户端日志条目。/);
});

/* ------------------------------------------------------------------ *
 * 派生链与复审队列
 * ------------------------------------------------------------------ */

await test('维护页：派生链卡显示派生条目与失效状态', async () => {
  const source = store.upsert(
    { title: '派生链的源条目', content: '派生链测试正文' },
    { workspace: WS },
  ).record;
  store.savePortrait(WS, {
    sections: [{ key: 'preference', text: '派生链测试段落' }],
    evidence: { preference: [source.id] },
  });
  /* 源被归档 → 画像那一层派生就失效了。 */
  store.update(source.id, { archived: true }, { workspace: WS });

  fetchCalls.length = 0;
  renderPage('zh');
  await settle(8);
  await clickTab('tabMaintain');
  await settle(8);

  const body = text();
  assert.match(body, new RegExp(escapeRe(makeT('zh')('derivationTitle'))), '缺少派生链卡');
  assert.match(body, /已失效/, '应显示派生失效状态');
  assert.ok(
    fetchCalls.some((call) => call.pathname === `${API_PREFIX}/derivations`),
    '/derivations 应被调用',
  );
});

await test('维护页：复审队列列出到期项，标记后不再到期', async () => {
  const rec = store.upsert(
    {
      title: '该复审的条目',
      content: '复审测试正文',
      category: 'decision',
      falsifier: '当接口变了这条就不成立',
      reviewAt: new Date(Date.now() - 86400000).toISOString(),
    },
    { workspace: WS },
  ).record;

  fetchCalls.length = 0;
  renderPage('zh');
  await settle(8);
  await clickTab('tabMaintain');
  await settle(8);

  const body = text();
  assert.match(body, new RegExp(escapeRe(makeT('zh')('reviewTitle'))), '缺少复审队列卡');
  assert.match(body, /该复审的条目/, '应列出到期条目');
  assert.ok(
    fetchCalls.some((call) => call.pathname === `${API_PREFIX}/reviews`),
    '/reviews 应被调用',
  );

  const btn = mini.findByText(view, makeT('zh')('reviewDone'), 'button');
  assert.ok(btn, '应有「已复审」按钮');
  mini.click(btn);
  await settle(16);
  assert.ok(
    fetchCalls.some((call) => call.pathname === `${API_PREFIX}/review` && call.method === 'POST'),
    '/review 应被调用',
  );
  assert.equal(store.reviewQueue(WS).due.filter((r) => r.id === rec.id).length, 0, '复审后不应再到期');
});

await test('画像卡：晋升入口随工作区画像撤下（全局画像不晋升）', async () => {
  /* AGENTS.md 是工作区文件，「写进 AGENTS.md」原挂在工作区画像块上；块撤下后入口一并撤下。
     故意保留工作区画像数据：证明即便数据在场，面板也不再渲染晋升按钮。 */
  store.savePortrait(WS, {
    sections: [{ key: 'preference', text: '客户端画像约定。' }],
  });

  renderPage('zh');
  await settle(8);
  assert.ok(
    !mini.findByText(view, makeT('zh')('portraitPromote'), 'button'),
    '面板不应再渲染「写进 AGENTS.md」按钮',
  );
});

/* ------------------------------------------------------------------ *
 * 空库引导：安装后第一屏看到的就是它
 * ------------------------------------------------------------------ */

/* 用一个全新的空库 + 空工作区渲染，避免动到前面那些种子里程碑。
   autoCapture 默认关，所以这一屏如果不给「怎么开始」，用户装完只会看到一片空白。 */
await test('空库首屏：引导卡 + 一键开启自动提炼（POST /settings）', async () => {
  const emptyTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-firstrun-'));
  const emptyWs = process.platform === 'win32' ? 'C:\\proj\\空库' : '/proj/empty';
  const emptyStore = createMemoryStore({ dir: path.join(emptyTmp, 'storage'), mirror: false });
  const emptySettingsValue = { enabled: true, briefing: true, autoCapture: false, mirror: false };
  const emptyApi = createApi({
    store: emptyStore,
    settings: {
      get: () => ({ ...emptySettingsValue }),
      set(patch) {
        Object.assign(emptySettingsValue, patch);
        return { ...emptySettingsValue };
      },
    },
    activeWorkspace: () => emptyWs,
    listWorkspaces: () => [{ root: emptyWs, key: 'empty', count: 0, active: true }],
    captures: () => [],
    version: '0.1.0',
    captureNow: async () => ({ ok: true, saved: 0 }),
    distillNow: async () => ({ candidates: [] }),
    rewriteNow: async () => ({ ok: true }),
    approveDraft: () => ({ ok: false, error: 'no_draft' }),
  });

  const settingsBodies = [];
  const callsStart = fetchCalls.length;
  activeApi = emptyApi;

  try {
    renderPage('zh');
    await settle(12);
    const t = makeT('zh');
    const body = text();
    assert.match(body, new RegExp(escapeRe(t('firstRunTitle'))), '空库没有显示引导卡');
    assert.match(body, new RegExp(escapeRe(t('firstRunStep1').slice(0, 10))), '引导卡缺少第一步');
    assert.match(body, new RegExp(escapeRe(t('firstRunStep3').slice(0, 10))), '引导卡缺少导入那一步');

    const autoBtn = mini.findByText(handle.tree, t('firstRunAuto'), 'button');
    assert.ok(autoBtn, '引导卡缺少「开启自动提炼」按钮');
    mini.click(autoBtn);
    await settle(10);

    settingsBodies.push(
      ...fetchCalls
        .slice(callsStart)
        .filter((call) => call.pathname === `${API_PREFIX}/settings` && call.body)
        .map((call) => call.body.settings || call.body),
    );
    assert.ok(
      settingsBodies.some((patch) => patch.autoCapture === true),
      '/settings 没有收到 autoCapture:true',
    );
    assert.equal(emptySettingsValue.autoCapture, true, '自动提炼没有被真的打开');
    assert.doesNotMatch(text(), new RegExp(escapeRe(t('firstRunAuto'))), '开启后按钮应换成「已开启」');
    assert.match(text(), new RegExp(escapeRe(t('firstRunAutoOn').slice(0, 8))), '开启后应显示已开启状态');
  } finally {
    activeApi = api;
  }
});

/* ------------------------------------------------------------------ *
 * 前台会话记忆卡（shell.overlay）
 * ------------------------------------------------------------------ */

/* 种子放在这里而不是顶部：前台卡的三条记录会改变列表/搜索/收件箱的计数，
   提前种下去会让前面的界面断言全部漂移。 */
store.sessionLogAppend(WS, { sessionId: 's-hud', turn: 1, text: '帮我把设置面板的悬浮卡做出来' });
store.sessionLogAppend(WS, { sessionId: 's-hud', turn: 2, text: '顺便把草稿挡在前台之外' });
store.upsert(
  {
    title: '会话卡已沉淀',
    content: '前台会话卡只展示已生效的记忆。',
    category: 'fact',
    source: 'manual',
    sessionId: 's-hud',
    evidence: { sessionId: 's-hud' },
  },
  { workspace: WS },
);
store.upsert(
  {
    title: '会话卡草稿',
    content: '这条草稿不能出现在前台。',
    category: 'fact',
    source: 'auto',
    sessionId: 's-hud',
    status: 'draft',
  },
  { workspace: WS },
);
store.upsert(
  {
    title: '别的会话记忆',
    content: '不应出现在本会话卡里。',
    category: 'fact',
    source: 'manual',
    sessionId: 's-other',
  },
  { workspace: WS },
);

const nodesByClass = (root, className) =>
  mini.findAll(
    root,
    (node) =>
      typeof node?.props?.className === 'string' && node.props.className.split(/\s+/).includes(className),
  );

const conversationNode = (id) => ({
  attrs: { 'data-conversation-session': id },
  getAttribute(name) {
    return this.attrs[name] || null;
  },
  getClientRects() {
    return [{}];
  },
});

await test('前台会话卡：不在对话里时不渲染', async () => {
  const hud = slotRegistrations.get('shell.overlay');
  assert.ok(hud, '没有注册 shell.overlay');
  assert.equal(hud.options.id, 'session-hud');
  assert.equal(hud.options.locale, 'settings.memory');
  assert.equal(typeof hud.component, 'function');

  sessionNodes.length = 0;
  modalNodes.length = 0;
  const handle = mini.render(mini.react.createElement(hud.component, { t: makeT('zh') }));
  await settle(12);
  assert.equal(
    nodesByClass(handle.tree, 'dshmem_hud').length,
    0,
    '设置页 / 主面板没有对话容器时不应出现会话卡',
  );
});

await test('前台会话卡：设置弹窗盖住对话时不渲染', async () => {
  sessionNodes.length = 0;
  sessionNodes.push(conversationNode('s-hud'));
  modalNodes.push({ getClientRects: () => [{}] });
  try {
    const hud = slotRegistrations.get('shell.overlay');
    const handle = mini.render(mini.react.createElement(hud.component, { t: makeT('zh') }));
    await settle(12);
    assert.equal(
      nodesByClass(handle.tree, 'dshmem_hud').length,
      0,
      '设置弹窗打开时会话卡不应跟到设置页',
    );
  } finally {
    modalNodes.length = 0;
  }
});

await test('前台会话卡：该对话记忆关闭时不渲染', async () => {
  sessionNodes.length = 0;
  sessionNodes.push(conversationNode('s-hud'));
  storage.set('dsh-memory/session-hud/off', JSON.stringify(['s-hud']));
  try {
    const hud = slotRegistrations.get('shell.overlay');
    const handle = mini.render(mini.react.createElement(hud.component, { t: makeT('zh') }));
    await settle(12);
    assert.equal(nodesByClass(handle.tree, 'dshmem_hud').length, 0, '该对话关闭后卡片应隐藏');
  } finally {
    storage.delete('dsh-memory/session-hud/off');
  }
});

await test('前台会话卡：收起为胶囊，展开后只显示本会话已沉淀记忆', async () => {
  /* 前一个用例点开过卡片，展开状态会存下来；这里恢复到默认收起再断言胶囊。 */
  storage.delete('dsh-memory/session-hud/open');
  sessionNodes.length = 0;
  sessionNodes.push(conversationNode('s-hud'));
  const hud = slotRegistrations.get('shell.overlay');
  const hudHandle = mini.render(mini.react.createElement(hud.component, { t: makeT('zh') }));
  await settle(12);

  const pills = nodesByClass(hudHandle.tree, 'dshmem_hud_pill');
  assert.equal(pills.length, 1, '有会话时应渲染记忆胶囊');
  assert.match(mini.textOf(pills[0]), /会话记忆/, '胶囊应带标题');
  mini.click(pills[0]);
  await settle(12);

  const card = nodesByClass(hudHandle.tree, 'dshmem_hud_card')[0];
  assert.ok(card, '点击胶囊后应展开卡片');
  const body = mini.textOf(card);
  assert.match(body, /本会话记住了 1 条/, '摘要应以条数开头');
  assert.match(body, /会话卡已沉淀/, '缺少本会话已沉淀记忆');
  assert.match(body, /更新于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/, '应显示完整更新时间');
  assert.doesNotMatch(body, /帮我把设置面板的悬浮卡做出来/, '诉求列表不应再出现在卡片里');
  assert.doesNotMatch(body, /会话卡草稿/, '草稿不应出现在前台卡');
  assert.doesNotMatch(body, /别的会话记忆/, '其它会话的记忆不应出现');

  const glyph = nodesByClass(card, 'dshmem_hud_glyph')[0];
  assert.ok(glyph, '缺少会话卡图标');
  assert.match(
    String(glyph.props.style?.backgroundImage || ''),
    /^url\("data:image\/svg\+xml/,
    '默认图标应是官方鲸鱼矢量',
  );

  const close = nodesByClass(hudHandle.tree, 'dshmem_hud_iconbtn').find((button) => mini.textOf(button) === '×');
  assert.ok(close, '缺少收起按钮');
  mini.click(close);
  await settle(6);
  assert.equal(nodesByClass(hudHandle.tree, 'dshmem_hud_card').length, 0, '收起后不应保留卡片');
  assert.equal(nodesByClass(hudHandle.tree, 'dshmem_hud_pill').length, 1, '收起后应回到胶囊');
});

await test('前台会话卡：切换对话后只显示新会话', async () => {
  sessionNodes.length = 0;
  const node = conversationNode('s-hud');
  sessionNodes.push(node);
  storage.set('dsh-memory/session-hud/open', '1');
  const hud = slotRegistrations.get('shell.overlay');
  const hudHandle = mini.render(mini.react.createElement(hud.component, { t: makeT('zh') }));
  await settle(12);
  assert.match(mini.textOf(nodesByClass(hudHandle.tree, 'dshmem_hud_card')[0]), /会话卡已沉淀/);

  node.attrs['data-conversation-session'] = 's-other';
  const watcher = observers
    .slice()
    .reverse()
    .find((observer) => Array.isArray(observer.options?.attributeFilter)
      && observer.options.attributeFilter.includes('data-conversation-session'));
  assert.ok(watcher, '缺少对话切换监听');
  watcher.callback([]);
  await settle(12);

  const card = nodesByClass(hudHandle.tree, 'dshmem_hud_card')[0];
  assert.ok(card, '切换后仍应显示新会话的卡片');
  const body = mini.textOf(card);
  assert.match(body, /别的会话记忆/, '应换成新会话的记忆');
  assert.doesNotMatch(body, /会话卡已沉淀/, '不应继续显示上一个会话的记忆');
});

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
