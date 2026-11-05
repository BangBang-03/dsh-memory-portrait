/**
 * dsh-memory —— 宿主半。
 *
 * 职责：
 *  1. 按工作区落库的长期记忆（lib/store.js，纯文件，无 DSH 依赖）；
 *  2. 给模型一个 `memory` 工具（save / search / list / get / update / forget / stats）；
 *  3. 会话开始时把记忆注入系统提示——默认「索引模式」一行一条（省 token，正文按需取），
 *     可切回全文模式（briefMode=full）；
 *  4. 轮次结束后的相关召回：拿当轮用户消息做本地检索，下一轮注入「相关召回」块；
 *  5. 轮次结束时的可选自动提炼（用宿主 LLM 把有长期价值的事实归纳成记忆，
 *     captureMode=draft 时先进待审队列）；
 *  6. 给设置面板提供 HTTP API（lib/api.js），前缀 /memory/api。
 *
 * 客户端半在 lib/client.js，由「客户端模块宿主」按包名自动提供。
 */

import fs from 'node:fs';
import path from 'node:path';

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';

import {
  CATEGORIES,
  CATEGORY_LABELS,
  GLOBAL_KEY,
  createMemoryStore,
  defaultRoot,
  normalizeRoot,
  workspaceKey,
} from './store.js';
import { API_PREFIX, createApi } from './api.js';
import { createDreamRunner } from './dream.js';
import {
  DISTILL_SYSTEM,
  buildDistillInput,
  messageText,
  parseDistillResponse,
  selectTranscript,
  shouldDistill,
} from './distill.js';
import {
  REWRITE_SYSTEM,
  REWRITE_STRICT_SYSTEM,
  buildRewriteInput,
  parseRewriteResponse,
  renderPortraitInjection,
} from './portrait.js';
import { scanSecrets } from './security.js';
import { GLOBAL_DISTILL_SYSTEM, parseGlobalDistill } from './distill-global.js';

/** Cordis 插件名。 */
const name = 'dsh-memory';

/** 依赖的宿主服务：没有 tools 就没有这个插件。 */
const inject = ['tools'];

/** 插件版本，面板上展示。直接读 package.json——硬编码会在 bump 时漏改（0.6.2 就漏过一次）。 */
let VERSION = '0.0.0';
try {
  VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || VERSION;
} catch {
  /* 读不到（宿主打包形态变化）就退回 package.json 同步的兜底值 */
  VERSION = '0.8.0';
}

/** 设置面板注入系统提示的段落顺序：夹在 PLAN_POLICY(500) 与 TEAM_POLICY(600) 之间。 */
const DEFAULT_SECTION_ORDER = 550;

/** 捕获日志环形缓冲长度。 */
const CAPTURE_LOG_LIMIT = 30;

/** 简报快照上限：最多同时冻结 60 个会话，超出丢最久没碰过的那个。 */
const BRIEFING_FREEZE_LIMIT = 60;

/** 简报重建日志（环形）长度。 */
const BRIEFING_LOG_LIMIT = 30;

/** 顶部注入段的段落名：模型看到的一切「常驻」记忆都在这里。 */
const BRIEFING_SECTION = 'dsh-memory:workspace-briefing';

/** 尾部注召回消息的 source.kind：用来在会话日志里认出自己注入的那条，避免重复注入。 */
const TAIL_SOURCE_KIND = 'dsh-memory';

/** 轮末召回缓冲里的单条正文截断长度。 */
const RECALL_SNIPPET_CHARS = 200;

/** 上一次提炼 0 候选后的退避：下一轮不再立刻调模型（5 分钟，且不低于配置冷却）。 */
const CAPTURE_EMPTY_BACKOFF_MS = 5 * 60 * 1000;

const Config = z.object({
  /** 总开关：关掉后不注入提示、不自动提炼、工具报错。 */
  enabled: z.boolean().default(true),
  /**
   * 注入总开关：关掉后首轮简报、轮末召回、路径召回都不再往上下文里加任何记忆，
   * `memory` 工具照常读写（「只用工具」档）。与 `briefing` / `turnRecall` / `pathRecall`
   * 是「总闸 × 分闸」的关系：关分闸只关一项，关总闸全关。
   */
  autoInject: z.boolean().default(true),
  /** 数据目录，留空用 ~/.dsh/storages/dsh-memory。 */
  directory: z.string().default(''),
  /**
   * 停用自动记忆的工作区清单（绝对路径；归一后精确匹配）。
   * 命中的工作区：不注入、不自动提炼——一次性任务不该污染记忆库。
   * `memory` 工具的手动读写不受影响（显式意图不该被静默拒绝）。
   */
  disabledWorkspaces: z.array(z.string()).default([]),
  /** 是否在工作区生成 .dsh-memory/MEMORY.md 人类可读镜像。 */
  mirror: z.boolean().default(true),
  /** 是否在会话开始时把记忆摘要注入系统提示。 */
  briefing: z.boolean().default(true),
  /** 简报形态：index=一行一条索引（省 token，正文按需取）；full=标题+正文摘录；portrait=画像全量 + 索引清单。 */
  briefMode: z.string().default('index'),
  /** 注入的最大条数。 */
  briefingLimit: z.natural().min(1).max(50).default(12),
  /** 注入的最大字符数。 */
  briefingMaxChars: z.natural().min(200).max(20000).default(2000),
  /** 画像注入的字数预算（工作区 + 全局两份合计；仅 briefMode=portrait 时生效）。 */
  portraitMaxChars: z.natural().min(200).max(8000).default(1400),
  /** 注入「记忆纪律」一段（何时写什么、对话内指令触发规则）。 */
  discipline: z.boolean().default(true),
  /** 画像重写写入方式：direct=直接落库；draft=先存待审稿，面板批准后才生效。 */
  rewriteMode: z.string().default('direct'),
  /** 画像重写时读取最近多少天的日志作为原料。 */
  journalDays: z.natural().min(1).max(90).default(14),
  /** 轮次结束后按当轮内容把相关记忆注入下一轮（ZCode 式后台召回）。 */
  turnRecall: z.boolean().default(true),
  /** 每轮最多召回几条。 */
  turnRecallLimit: z.natural().min(1).max(10).default(3),
  /** 轮末召回块的总字符上限，防止多条长记忆把尾部撑大。 */
  turnRecallMaxChars: z.natural().min(200).max(4000).default(800),
  /** 轮次结束自动提炼开关。 */
  autoCapture: z.boolean().default(false),
  /** 提炼写入方式：direct=直接落库；draft=先进待审队列，面板批准后才生效。 */
  captureMode: z.string().default('direct'),
  /** 体检里「过期未用」的判定天数。 */
  staleDays: z.natural().min(7).max(365).default(60),
  /** 一轮对话至少多少字符才值得提炼。 */
  autoCaptureMinChars: z.natural().min(0).max(200000).default(600),
  /** 两次自动提炼之间的最小间隔（毫秒）。 */
  captureCooldownMs: z.natural().min(0).max(3600000).default(60000),
  /** 提炼结果的最低置信度。 */
  minConfidence: z.number().min(0).max(1).default(0.4),
  /** 每次提炼最多落库条数。 */
  maxPerTurn: z.natural().min(1).max(20).default(5),
  /** 送给模型的对话摘录字符上限。 */
  maxTranscriptChars: z.natural().min(500).max(60000).default(4000),
  /** 落库时对高度相似的既有记忆做合并。 */
  dedupe: z.boolean().default(true),
  /** 质量闸门：自动提炼 / agent 主动写入的低分条目（<30）直接归档，不进简报。 */
  qualityGate: z.boolean().default(true),
  /** 写入安全：密钥扫描与脱敏（sk-/ghp_/AKIA/私钥/带凭据 URI 等，命中替换为 [REDACTED:*]）。 */
  redactSecrets: z.boolean().default(true),
  /** 写入安全：非 user 来源的记录命中注入模式（taint）时自动隔离成草稿。 */
  quarantineTainted: z.boolean().default(true),
  /** 路径 JIT：工具触达 files 挂靠的文件时，把相关记忆注入下一步（尾部注入，不进系统提示）。 */
  pathRecall: z.boolean().default(true),
  /** 每次路径召回最多注入几条。 */
  pathRecallLimit: z.natural().min(1).max(10).default(3),
  /** 会话索引：把每轮的用户发言原文落进 sessions.jsonl，供 action=sessions 溯源。 */
  sessionSearch: z.boolean().default(true),
  /** 压缩协同：宿主压缩上下文（compaction/summary|prune）时把摘要照录进工作日志。 */
  compactionSalvage: z.boolean().default(true),
  /** 子代理会话（origin=subagent）是否也参与自动提炼。默认否，避免把派活的中间过程写成记忆。 */
  captureSubagents: z.boolean().default(false),
  /**
   * 启动整理：每次打开 DSH 后检查一次，距上次（自动或手动）整理满 N 天就在后台整理一次。
   * 0 = 关闭。没有常驻定时器，也不挂 agent/turn-stopping（C5）。
   */
  autoDreamDays: z.natural().min(0).max(365).default(7),
  /** 启动整理是否顺带重写画像（一次模型调用；落库方式跟随 rewriteMode）。默认关：画像由下面的自动刷新负责。 */
  autoDreamPortrait: z.boolean().default(false),
  /**
   * 二级蒸馏：Dream 时用一次模型调用，把本项目的记忆抽成「候选原则」写进全局候选池。
   * 关掉只是不再往上抽；已经进池的候选照常按门槛晋升。
   */
  globalDistill: z.boolean().default(true),
  /**
   * 自动刷新画像（WorkBuddy 式）：每 N 小时检查一次，有新素材时用当前会话模型重写全局画像。
   * 0 = 关闭。画像自动更新是主路径，手动「立即刷新」是兜底。
   */
  autoPortraitHours: z.natural().min(0).max(168).default(6),
  /** 复审周期（天）：带失效条件的记忆默认多少天后进复审队列。 */
  falsifierReviewDays: z.natural().min(1).max(3650).default(90),
  /** 系统提示段落顺序。 */
  sectionOrder: z.number().default(DEFAULT_SECTION_ORDER),
  /** 前台会话卡图标：a 官方鲸鱼标（默认）/ b 官方 App 图标 / c 可爱鲸鱼 / d 深蓝鲸鱼 / e–g 鲸鱼娘二创位图。 */
  hudIcon: z.string().default('a'),
});

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

function clamp(text, max) {
  const value = String(text ?? '').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * 简报行上的日期戳：只取记录的 **createdAt**（不可变），供模型判断新旧。
 *
 * ⚠️ 绝不能用 updatedAt / lastUsedAt：markUsed 会刷后者，一放进简报，
 * 同一会话的注入字节就逐轮变化，前缀缓存整段作废（见 briefing-stability 套件）。
 * 用本地时区，和 journal 的日期文件名保持一致；解析失败返回空串，行格式退回原样。
 */
function recordDay(record) {
  const raw = record?.createdAt;
  const time = Date.parse(String(raw ?? ''));
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 「续跑 / 确认」型发言：不带来新话题，为它跑一次轮末召回只会是噪声。
 * 这是 auto-memory 那条 activation eligibility（「是不是一个提问」比「有多相似」重要）的最小实现：
 * 纯本地判定，不调模型、不读库。
 *
 * 判定方式：归一（去标点 / 语气词）后剥掉续跑词与虚词，看还剩多少实义字符。
 * 剩 ≤2 个才算续跑——「继续」「好的，那就继续吧」会跳过；
 * 「好的，那就按 B 方案做」剩下「按b方案做」，照常召回。
 */
const CONTINUATION_TOKENS = [
  '继续', '接着', '往下', '下一步', '然后', '再来', '没问题', '谢谢', '收到', '明白', '知道',
  '好的', '可以', '行', '嗯', '对', '是', '好',
  '那就', '就这么', '就', '那', '都', '也', '再',
  'ok', 'okay', 'yes', 'yep', 'goon', 'continue', 'next', 'thanks', 'lgtm',
];

/** 归一去标点与句尾语气词，供续跑判定比对。 */
function normalizeUtterance(text) {
  return String(text ?? '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase()
    .replace(/[吧啊呀哈哦嘛呢啦的]+$/u, '');
}

/**
 * 这句话值不值得为它跑一次召回。两道条件**同时**满足才判为续跑：
 * 1) 归一后长度 < 12（长句一定有内容）；
 * 2) 剥掉续跑词与虚词后，剩下的实义字符 ≤ 2 个。
 *
 * 只满足一道不跳——宁可多召回一条，也别把「为什么？」「那就按 B 做」误判成续跑。
 * 注意它与 `userText.length < 8` 那道闸是互补的：那道看**原始**长度，
 * 「好的，那就继续吧」原始 9 字符过得去，归一后只剩虚词，由这里拦下。
 */
function isContinuation(text) {
  const plain = normalizeUtterance(text);
  if (!plain) return true;
  if (plain.length >= 12) return false;
  let rest = plain;
  for (const token of CONTINUATION_TOKENS) {
    if (rest.includes(token)) rest = rest.split(token).join('');
  }
  return rest.length <= 2;
}

/** 归一化停用名单：大小写、尾斜杠、相对路径都收敛掉，用于精确匹配。 */
function normalizedWorkspaceList(list) {
  const out = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const key = normalizeRoot(String(item ?? ''));
    if (key) out.add(key);
  }
  return out;
}

/**
 * 该工作区是否停用了自动记忆（不注入、不自动提炼）。
 * 手动 `memory` 工具读写不受影响——那是显式意图，静默拒绝只会让模型反复重试。
 */
function workspaceDisabled(workspace, cfg) {
  const list = cfg?.disabledWorkspaces;
  if (!Array.isArray(list) || !list.length) return false;
  const key = normalizeRoot(String(workspace ?? ''));
  if (!key) return false;
  return normalizedWorkspaceList(list).has(key);
}

/** 只保留 defaults 里声明过的键，并按默认值的类型做一次温和转换。 */
function coerceSettings(defaults, patch) {
  const next = {};
  for (const key of Object.keys(defaults)) {
    if (!Object.hasOwn(patch, key) || patch[key] === undefined) continue;
    const fallback = defaults[key];
    const raw = patch[key];
    if (typeof fallback === 'boolean') next[key] = Boolean(raw);
    else if (typeof fallback === 'number') {
      const num = Number(raw);
      if (Number.isFinite(num)) next[key] = num;
    } else if (Array.isArray(fallback)) {
      // 数组项也接受换行 / 逗号分隔的字符串，方便直接手写 settings.json 或 patch。
      const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\n,]/) : [];
      next[key] = list.map((item) => String(item ?? '').trim()).filter(Boolean);
    } else next[key] = String(raw);
  }
  return next;
}

/**
 * 可运行时修改并落盘的插件设置（设置面板与 cordis config 的共同产物）。
 * cordis config 是初始值，用户在面板上的修改写入 <dir>/settings.json。
 */
function createSettings({ dir, defaults }) {
  const file = path.join(dir, 'settings.json');
  const stored = readJson(file, {});
  let state = { ...defaults, ...coerceSettings(defaults, stored && typeof stored === 'object' ? stored : {}) };

  return {
    file,
    get() {
      return { ...state };
    },
    set(patch = {}) {
      const clean = coerceSettings(defaults, patch && typeof patch === 'object' ? patch : {});
      if (Object.keys(clean).length > 0) {
        state = { ...state, ...clean };
        writeJson(file, state);
      }
      return { ...state };
    },
  };
}

/* ------------------------------------------------------------------ *
 * 插件
 * ------------------------------------------------------------------ */

/**
 * @param ctx — cordis 上下文（已注入 tools）。
 * @param config — 经 schemastery 校验后的 Config。
 */
function apply(ctx, config) {
  const defaults = { ...Config(config ?? {}) };
  const dir = defaults.directory ? path.resolve(defaults.directory) : defaultRoot();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    ctx.logger?.warn?.(`dsh-memory: 无法创建数据目录 ${dir}: ${error?.message || error}`);
  }

  const settings = createSettings({ dir, defaults });
  const store = createMemoryStore({
    dir,
    // 允许面板实时开关镜像，而不用重建 store。
    mirror: () => settings.get().mirror,
    // 质量闸门同样走 getter：设置面板一关就恢复「什么都收」。
    qualityGate: () => settings.get().qualityGate,
    // 写入安全走 getter：密钥脱敏与 taint 隔离都能在设置里实时开关。
    security: {
      redact: () => settings.get().redactSecrets,
      quarantine: () => settings.get().quarantineTainted,
    },
    // 复审排期走 getter：设置里改周期立即生效。
    review: { days: () => settings.get().falsifierReviewDays },
  });

  /* ---------------- 工作区跟踪 ---------------- */

  /** sessionId -> { root, at }，只保留最近 60 个会话。 */
  const sessionRoots = new Map();
  /** 最近一次产生事件的会话，用作「手动提炼」的目标。 */
  let lastSession = null;
  /** 最近一次主视图会话（排除子代理）：前台会话卡拿不到 DOM 标记时的兜底。 */
  let lastMainSession = null;

  function isSubagentSession(session) {
    return session?.header?.origin === 'subagent' || Boolean(session?.header?.parentSession);
  }
  /* 会话引用登记：resolveRoute 的兜底池——面板触发的重写/提炼可能没有活跃对话
     （刚开 DSH 直接进设置面板点按钮），此时从最近的会话里找可用的模型路由。 */
  const sessionRefs = new Map(); // id -> { session, at }

  /**
   * 历史工作区补写：主库里有这个工作区的记忆，但它的目录下还没有 `.dsh-memory/`
   * （镜像关着的时候写入过，或项目移动后第一次打开）。
   * 只在**确实有 active 记忆**时才写，所以不违反 D2——不凭空造目录。
   * 每个 root 在进程生命周期内只查一次，避免每个会话事件都 stat 一遍磁盘。
   */
  const mirrorBackfilled = new Set();

  function backfillWorkspaceMirror(root) {
    if (!root || mirrorBackfilled.has(root)) return;
    try {
      /* 开关关着就先不标记：用户之后打开镜像时，还要给它一次补写机会。 */
      if (!settings.get().mirror) return;
      mirrorBackfilled.add(root);
      if (store.mirrorInfo(root).workspaceExists) return;
      const result = store.refreshMirror(root);
      if (result?.ok) {
        ctx.logger?.info?.(`dsh-memory: 已为历史工作区补写记忆目录（${result.count} 条）`);
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-memory: 补写工作区记忆目录失败: ${error?.message || error}`);
    }
  }

  function noteSession(session) {
    if (!session) return;
    const cwd = session.header?.cwd;
    if (typeof cwd !== 'string' || !cwd.trim()) return;
    const root = normalizeRoot(cwd);
    sessionRoots.set(String(session.id), { root, at: Date.now() });
    sessionRefs.set(String(session.id), { session, at: Date.now() });
    backfillWorkspaceMirror(root);
    if (sessionRoots.size > 60) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, rec] of sessionRoots) {
        if (rec.at < oldestAt) {
          oldestAt = rec.at;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        sessionRoots.delete(oldestKey);
        sessionRefs.delete(oldestKey);
      }
    }
  }

  function activeWorkspace() {
    let best = '';
    let bestAt = -1;
    for (const rec of sessionRoots.values()) {
      if (rec.at > bestAt) {
        bestAt = rec.at;
        best = rec.root;
      }
    }
    return best;
  }

  /**
   * 面板的工作区切换器数据：活跃会话的工作区 + 历史上落过库的工作区。
   */
  function listWorkspaces() {
    const active = activeWorkspace();
    const activeKey = active ? workspaceKey(active) : '';
    const byKey = new Map();

    for (const rec of sessionRoots.values()) {
      const key = workspaceKey(rec.root);
      const prev = byKey.get(key);
      if (!prev || rec.at > prev.at) byKey.set(key, { root: rec.root, at: rec.at, live: true });
    }

    for (const info of store.workspaces()) {
      const key = info.key || workspaceKey(info.root || '');
      if (byKey.has(key)) continue;
      byKey.set(key, {
        root: info.root || '',
        at: Date.parse(info.updatedAt) || 0,
        live: false,
      });
    }

    const rows = [];
    for (const [key, rec] of byKey) {
      const info = store.workspaceInfo(rec.root);
      const stats = store.stats({ workspace: rec.root });
      rows.push({
        key,
        root: rec.root,
        slug: info.slug,
        folder: info.folder,
        live: Boolean(rec.live),
        active: key === activeKey,
        count: stats.total,
        pinned: stats.pinned,
        global: stats.global,
        updatedAt: stats.updatedAt || (rec.at ? new Date(rec.at).toISOString() : ''),
      });
    }

    rows.sort(
      (a, b) =>
        (b.active ? 1 : 0) - (a.active ? 1 : 0) ||
        (b.live ? 1 : 0) - (a.live ? 1 : 0) ||
        String(b.updatedAt).localeCompare(String(a.updatedAt)),
    );
    return rows;
  }

  /* ---------------- 提示词注入（简报快照 + 尾部召回） ---------------- */

  /**
   * 会话级简报快照：同一 (会话, 工作区) 只在首次装配时算一次，之后逐字节复用。
   * 只有「记忆 / 画像真的变了」才重算一次再重新冻结——系统提示在请求最前面，
   * 它一变整段前缀缓存就废了，所以默认必须是冻住的。
   */
  const briefingFreeze = new Map();
  /** 最近一次实际渲染的简报计量，供面板估算注入成本与 token 节省。 */
  let lastBriefing = {
    workspace: '',
    mode: 'index',
    chars: 0,
    count: 0,
    at: null,
    sessionId: '',
    reason: '',
    frozen: false,
    builds: 0,
  };
  /** 简报重建日志（环形、时间倒序）：/memory/api/state 与面板用来看「为什么重算了」。 */
  const briefingLog = [];
  /** 最近一次尾部注入（轮末召回）的计量。 */
  let lastTail = { sessionId: '', turn: 0, count: 0, chars: 0, mode: 'tail', at: null };
  /* 路径 JIT：pre-execute 收集文件路径并算好命中，下一个 pre-step 用尾部注入带出。 */
  let lastPathTail = { sessionId: '', turn: 0, count: 0, chars: 0, files: [], at: null };
  const pathRecallStash = new Map(); // sessionId -> { files, records }
  const pathRecallSeen = new Map(); // sessionId -> Set(已注入过的记忆 id)
  /** sessionId -> { ids, records, at, injectedTurn }：轮末召回缓冲，只为下一轮服务，每轮整体替换。 */
  const sessionRecalls = new Map();
  /** sessionId -> Set<记忆 id>：本会话已经尾部注入过的记忆，避免同一段内容反复占位。 */
  const sessionRecallSeen = new Map();
  /** sessionId -> 最近一次已扫描引用的 assistant 文本指纹，避免同一答案被重复计数。 */
  const citationSeen = new Map();

  const briefModeOf = () => {
    const mode = settings.get().briefMode;
    if (mode === 'full') return 'full';
    if (mode === 'portrait') return 'portrait';
    return 'index';
  };

  function pushBriefingLog(entry) {
    briefingLog.unshift({
      at: new Date(entry.at || Date.now()).toISOString(),
      sessionId: entry.sessionId,
      reason: entry.reason,
      chars: entry.chars,
      count: entry.count,
      workspace: entry.workspace,
      mode: entry.mode,
      changed: Boolean(entry.changed),
    });
    if (briefingLog.length > BRIEFING_LOG_LIMIT) briefingLog.length = BRIEFING_LOG_LIMIT;
  }

  /** 快照上限：丢最久没被读过的那个会话（Map 插入序不稳，按 at 找最旧）。 */
  function capBriefingFreeze() {
    while (briefingFreeze.size > BRIEFING_FREEZE_LIMIT) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [key, rec] of briefingFreeze) {
        if (rec.at < oldestAt) {
          oldestAt = rec.at;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      briefingFreeze.delete(oldestKey);
    }
  }

  /**
   * 简报的「内容指纹」：只由会出现在简报里的东西决定（记录集合、更新时间、状态、
   * 置顶、画像版本、工作日志）。它变了才重算简报；纯读、以及只改曝光/使用计数的
   * markExposed / markOpened 都不改指纹，所以反复 get/search 不会把系统提示弄成新文本。
   */
  function briefingFingerprint(workspace) {
    let records = [];
    try {
      records = store.list({ workspace, limit: 2000, includeArchived: true, includeDrafts: true }).records;
    } catch {
      records = [];
    }
    // 按 id 排序后再拼，保证「同一批记录、不同落库顺序」得到同一个指纹。
    const rows = records
      .map(
        (r) =>
          `${r.id}|${r.updatedAt || r.createdAt || ''}|${r.status || 'active'}|${r.archived ? 1 : 0}|${r.pinned ? 1 : 0}`,
      )
      .sort();
    const portraitOf = (root) => {
      try {
        const portrait = store.portrait(root);
        return portrait ? `${portrait.version}@${portrait.updatedAt || ''}` : '-';
      } catch {
        return '-';
      }
    };
    let journal = '-';
    try {
      const dates = store.journalDates(workspace);
      journal = `${dates[0] || '-'}#${store.journalRead(workspace).text.length}`;
    } catch {
      /* 日志目录读不到就当没变化 */
    }
    return `${rows.join(';')}#p:${portraitOf(workspace)}/${portraitOf('')}#j:${journal}`;
  }

  function renderPortraitBlock(workspace) {
    try {
      const cfg = settings.get();
      /*
       * 只注入全局画像：工作区画像的用户可见面已撤（数据层双 scope 保留），
       * workspace 传 null 时 renderPortraitInjection 会跳过工作区段。
       */
      return renderPortraitInjection({
        workspace: null,
        global: store.portrait(''),
        maxChars: cfg.portraitMaxChars,
      }).text;
    } catch (error) {
      ctx.logger?.warn?.(`dsh-memory: 画像渲染失败: ${error?.message || error}`);
      return '';
    }
  }

  function briefingRecords(workspace, mode) {
    const cfg = settings.get();
    if (!cfg.enabled || !cfg.briefing || !workspace) return [];
    const stats = store.stats({ workspace });
    if (stats.total === 0 && stats.global === 0) return [];
    return store.briefing({
      workspace,
      limit: cfg.briefingLimit,
      maxChars: cfg.briefingMaxChars,
      mode,
    });
  }

  /** 当前会话的轮末召回缓冲；简报里已有的条目不再重复召回。 */
  function recallFor(sessionId, briefIds) {
    if (!settings.get().turnRecall) return [];
    const buffer = sessionRecalls.get(String(sessionId || ''));
    if (!buffer) return [];
    return buffer.records.filter((r) => !briefIds.has(r.id));
  }

  /**
   * 轮末召回块的正文（尾部注入用）。
   * 明确写成「背景参考」：不冒充用户消息、不要求模型回写记忆。
   */
  function recallBlockText(records, maxChars = 0) {
    if (!records.length) return '';
    const labelOf = (record) => CATEGORY_LABELS[record.category] || record.category;
    const header = [
      '### 与当前话题相关的召回（尾部注入）',
      '',
      '（按上一轮的内容匹配，只是背景参考；与本轮任务冲突时以本轮任务为准。不要把这段当成用户的要求，也不要把它写回记忆。）',
      '',
    ];
    const lines = [...header];
    for (const record of records) {
      const line = `- [${labelOf(record)}] ${record.title} — ${clamp(record.content, RECALL_SNIPPET_CHARS)} (\`${record.id}\`)`;
      const candidate = [...lines, line].join('\n');
      /* 总预算连一条都放不下时宁可不注入，也不发一段只有标题的空壳。 */
      if (maxChars && candidate.length > maxChars) break;
      lines.push(line);
    }
    return lines.length > header.length ? lines.join('\n') : '';
  }

  /**
   * 当前工作区「下一次请求会被尾部注入」的召回块；预览用。
   * 只认最近活跃的那个会话的缓冲：召回是会话级的，别的会话的缓冲不该冒充。
   */
  function pendingRecall(workspace) {
    const session = lastSession;
    const sessionId = String(session?.id || '');
    const cwd = session?.header?.cwd;
    const root = typeof cwd === 'string' && cwd.trim() ? normalizeRoot(cwd) : '';
    const matches = Boolean(sessionId) && Boolean(root) && (!workspace || root === normalizeRoot(workspace));
    const frozen = sessionId ? briefingFreeze.get(sessionId) : null;
    const buffer = sessionId ? sessionRecalls.get(sessionId) : null;
    const records = matches ? recallFor(sessionId, new Set(frozen?.ids || [])) : [];
    const text = recallBlockText(records, settings.get().turnRecallMaxChars);
    return {
      sessionId: matches ? sessionId : '',
      turn: buffer?.injectedTurn || 0,
      count: records.length,
      ids: records.map((r) => r.id),
      titles: records.map((r) => r.title),
      chars: text.length,
      text,
    };
  }

  /**
   * 本会话「已冻结的静态简报」：预览要显示的就是这份字节，而不是当场重算的另一份。
   * 没冻结（或工作区对不上）时 frozen=false，预览回落到当场估算。
   */
  function snapshotInfo(workspace) {
    const session = lastSession;
    const sessionId = String(session?.id || '');
    const cwd = session?.header?.cwd;
    const root = typeof cwd === 'string' && cwd.trim() ? normalizeRoot(cwd) : '';
    const hit = sessionId ? briefingFreeze.get(sessionId) : null;
    const matches = Boolean(hit) && Boolean(root) && (!workspace || root === normalizeRoot(workspace)) && hit.workspace === root;
    if (!matches) return { sessionId: '', frozen: false, text: '', chars: 0, count: 0, reason: '' };
    return {
      sessionId,
      frozen: true,
      text: hit.text,
      chars: hit.text.length,
      count: hit.count,
      reason: lastBriefing.reason || '',
    };
  }

  /**
   * 简报正文（系统提示段）。冻结命中时直接返回上次的字节。
   * 读库异常（主库损坏 strict 抛 EDAMAGED 等）在这里兜底：本轮注入空段、
   * 错误只进 lastBriefing 与日志——系统提示路径绝不把异常抛回宿主。
   */
  function briefingText(workspace, sessionId = '') {
    try {
      return briefingTextCore(workspace, sessionId);
    } catch (error) {
      lastBriefing = {
        workspace,
        mode: briefModeOf(),
        chars: 0,
        count: 0,
        at: new Date().toISOString(),
        sessionId: String(sessionId || '') || '(none)',
        reason: 'store_error',
        frozen: false,
        builds: 0,
      };
      ctx.logger?.warn?.(`dsh-memory: 简报生成失败，本轮注入空段: ${error?.message || error}`);
      return '';
    }
  }

  function briefingTextCore(workspace, sessionId = '') {
    const cfg = settings.get();
    if (!cfg.enabled) return '';
    // 注入总闸 / 停用工作区：走「一条记忆都没有」的同一条返回路径，只给空正文。
    // 不在这里塞任何占位文本——空段与空工作区一致，提示字节不受影响（AGENTS.md C4）。
    if (!cfg.autoInject || workspaceDisabled(workspace, cfg)) {
      lastBriefing = {
        workspace,
        mode: briefModeOf(),
        chars: 0,
        count: 0,
        at: new Date().toISOString(),
        sessionId: String(sessionId || '') || '(none)',
        reason: cfg.autoInject ? 'workspace_disabled' : 'inject_off',
        frozen: false,
        builds: 0,
      };
      return '';
    }
    const key = String(sessionId || '') || '(none)';
    const mode = briefModeOf();
    const fingerprint = briefingFingerprint(workspace);

    const hit = briefingFreeze.get(key);
    if (hit && hit.workspace === workspace && hit.mode === mode && hit.fingerprint === fingerprint) {
      hit.at = Date.now();
      lastBriefing = {
        workspace,
        mode,
        chars: hit.text.length,
        count: hit.count,
        at: new Date(hit.at).toISOString(),
        sessionId: key,
        reason: 'frozen',
        frozen: true,
        builds: hit.builds,
      };
      return hit.text;
    }

    const reason = !hit ? 'first' : hit.workspace !== workspace ? 'workspace' : hit.mode !== mode ? 'mode' : 'memory';
    const rendered = renderBriefingStatic(workspace, mode);
    const at = Date.now();
    const builds = (hit?.builds || 0) + 1;
    briefingFreeze.set(key, {
      workspace,
      mode,
      fingerprint,
      text: rendered.text,
      count: rendered.count,
      ids: rendered.ids,
      at,
      builds,
    });
    capBriefingFreeze();
    pushBriefingLog({
      at,
      sessionId: key,
      reason,
      chars: rendered.text.length,
      count: rendered.count,
      workspace,
      mode,
      changed: hit ? hit.text !== rendered.text : false,
    });
    /* 注入审计：这次真正进 prompt 的字节、带了哪些 id、谁被挤掉。 */
    if (workspace && rendered.text) {
      try {
        store.injectionLogAppend(workspace, {
          sessionId: key,
          kind: 'briefing',
          mode,
          ids: rendered.ids,
          text: rendered.text,
          dropped: rendered.dropped,
          fingerprint,
          reason,
        });
      } catch (error) {
        ctx.logger?.warn?.(`dsh-memory: 注入审计写入失败: ${error?.message || error}`);
      }
    }
    lastBriefing = {
      workspace,
      mode,
      chars: rendered.text.length,
      count: rendered.count,
      at: new Date(at).toISOString(),
      sessionId: key,
      reason,
      frozen: true,
      builds,
    };
    return rendered.text;
  }

  /**
   * 静态简报正文：工作区统计 + 索引/全文 + 页脚 + 记忆纪律。
   * 这里**只放稳定内容**——轮末召回改走尾部注入（见 injectTailRecall），
   * 否则每次召回都改系统提示尾巴，整段前缀缓存作废。
   */
  function renderBriefingStatic(workspace, mode) {
    const cfg = settings.get();
    const portraitMode = mode === 'portrait';
    const portraitText = portraitMode && workspace ? renderPortraitBlock(workspace) : '';
    const records = briefingRecords(workspace, portraitMode ? 'index' : mode).filter(
      (record) => !(portraitMode && (record.tags || []).includes('portrait')),
    );
    if (!records.length && !portraitText) return { text: '', count: 0, ids: [], dropped: [] };
    /* 被预算挤掉的条目：审计要能回答「为什么这次没看到它」。 */
    const selectedIds = new Set(records.map((r) => r.id));
    let dropped = [];
    try {
      dropped = store
        .list({ workspace, limit: 2000 })
        .records.filter((r) => !selectedIds.has(r.id))
        .slice(0, 20)
        .map((r) => ({
          id: r.id,
          title: r.title,
          reason: portraitMode && (r.tags || []).includes('portrait') ? 'portrait' : 'budget',
        }));
    } catch {
      dropped = [];
    }

    const labelOf = (record) => CATEGORY_LABELS[record.category] || record.category;
    /* 红线拆出索引清单单独成段：正文逐字（禁令措辞不允许截断/改写），置顶于一切内容。 */
    const redlines = records
      .filter((record) => record.category === 'constraint')
      /* 与面板一致：按加入时间排序；createdAt 不可变，C4 的字节稳定不受影响。 */
      .sort(
        (a, b) =>
          String(a.createdAt || '').localeCompare(String(b.createdAt || '')) ||
          String(a.id).localeCompare(String(b.id)),
      );
    const normal = records.filter((record) => record.category !== 'constraint');
    const lines = [];
    lines.push('## 工作区长期记忆（dsh-memory）');
    lines.push('');
    if (redlines.length) {
      lines.push('### 红线（用户设定的绝对禁令，优先级最高）');
      lines.push('');
      for (const record of redlines) {
        lines.push(`- ${clamp(record.title, 200)} — ${clamp(record.content, 500)} (\`${record.id}\`)`);
      }
      lines.push('');
    }
    if (portraitText) {
      lines.push(portraitText);
      lines.push('');
    }
    if (normal.length) {
      const stats = store.stats({ workspace });
      lines.push(
        `工作区：\`${workspace}\` ｜ 本工作区 ${stats.total} 条（置顶 ${stats.pinned}）｜ 全局 ${stats.global} 条`,
      );
      lines.push('');
      if (mode !== 'full') {
        // 索引模式（含 portrait）：一行一条，只有日期、标题、标签与 id；正文靠 memory 工具按需取。
        for (const record of normal) {
          const pin = record.pinned ? '📌 ' : '';
          const day = recordDay(record);
          const stamp = day ? `${day} ` : '';
          const tags = record.tags?.length ? ` #${record.tags.join(' #')}` : '';
          lines.push(`- ${pin}${stamp}[${labelOf(record)}] ${clamp(record.title, 120)}${tags} (\`${record.id}\`)`);
        }
      } else {
        for (const record of normal) {
          const pin = record.pinned ? '📌 ' : '';
          const day = recordDay(record);
          const stamp = day ? `${day} ` : '';
          lines.push(
            `- ${pin}${stamp}[${labelOf(record)}] ${clamp(record.title, 120)} — ${clamp(record.content, 260)} (\`${record.id}\`)`,
          );
        }
      }
      lines.push('');
    }
    if (records.length || portraitText) {
      const stats = store.stats({ workspace });
      const available = stats.total + stats.global;
      const truncated = records.length < available;
      const toolHint =
        (truncated ? '完整清单用 `action=list` 浏览；' : '') +
        '完整正文用 `memory` 工具：`action=get` 取单条，`action=search` 按关键词检索，' +
        '`action=save` 保存新事实（先 search 再 save 以去重）。';
      const prefix = portraitMode
        ? '上面是画像（全貌）与索引（一行一条，正文没有展开）；'
        : mode === 'index'
          ? '上面是索引（一行一条），正文没有展开；'
          : truncated
            ? `上面只列了最相关的 ${records.length} / ${available} 条；`
            : '';
      lines.push(`${prefix}${toolHint}`);
      lines.push('记忆是写下时的快照：引用其中提到的函数、文件或配置前，先验证它们现在还存在。');
      if (cfg.discipline) {
        lines.push('');
        lines.push('### 记忆纪律（何时写什么）');
        lines.push(
          '- 完成实质工作（改代码 / 修 bug / 写文档 / 定方案）后，用 `memory` 工具 `action=journal` 追一条工作日志（一两句话即可）。',
        );
        lines.push(
          '- 用户明确要求记忆时立即动笔：「记住 X / 以后都…」→ `action=save`（先 search 去重）；「忘掉 X」→ 先 search 再 `action=forget`；「更新记忆 / 整理记忆」→ 先 search，再按需 update/save。',
        );
        lines.push(
          '- 用户偏好与纠正 → `feedback` 类；项目约定 → `convention` 类；「现在是什么样」的变化留给画像，不为进度状态新增条目。',
        );
        lines.push(
          '- 记「什么情况出现这条就不成立」→ `action=save` 带 `falsifier`（正文里写「失效条件：…」也行）；它会自动排期复审，到期提醒回看。',
        );
        lines.push(
          '- 草稿只能由**用户**在面板批准：不要自己批准，也不要绕过队列（例如直接把 status 写成 active）。',
        );
      }
    }

    return { text: lines.join('\n'), count: records.length, ids: records.map((r) => r.id), dropped };
  }

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(
      () =>
        promptCtx.systemPrompt.section({
          name: BRIEFING_SECTION,
          order: settings.get().sectionOrder,
          text: (context) => {
            const cwd = context?.agent?.session?.header?.cwd;
            return briefingText(
              typeof cwd === 'string' ? normalizeRoot(cwd) : '',
              context?.agent?.session?.id,
            );
          },
        }),
      'dsh-memory: prompt section',
    );
  });

  /* ---------------- 尾部注入：轮末召回走 agent/pre-step ---------------- */

  /**
   * 造一条「尾部召回」用户消息。
   * source.kind 固定成 TAIL_SOURCE_KIND，会话日志里据此认出自己注入过的那条
   * （重试 / 续跑的 step 不能再注入一次）。
   */
  function tailRecallMessage(text, { turn, ids }) {
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: TAIL_SOURCE_KIND, form: 'turn-recall', turn, ids },
    });
  }

  /** 会话日志里这个 turn 是不是已经注入过尾部召回了（重试/续跑的去重依据）。 */
  function tailAlreadyInSession(session, turn) {
    try {
      const nodes = session?.surface?.nodes;
      if (!Array.isArray(nodes) || typeof session.eventAt !== 'function') return false;
      for (const seq of nodes) {
        const event = session.eventAt(seq);
        if (event?.type !== 'user/message') continue;
        const source = event.data?.source;
        if (source?.kind === TAIL_SOURCE_KIND && source.turn === turn) return true;
      }
    } catch {
      /* 会话对象形状不同就退化成内存去重 */
    }
    return false;
  }

  /**
   * 把本轮召回折进即将进入的那批消息里（紧跟在被认领的批次后面）。
   * 与内建 agent-instructions 插件同一套机制：pre-step 的 decision.messages
   * 会被宿主当作 user/message 落进会话历史，模型这一 step 就看得见。
   */
  function injectTailRecall(decision, { agent, messages, turn, step, signal }) {
    if (!decision || decision.kind === 'reject') return decision;
    if (signal?.aborted) return decision;
    const entering = Array.isArray(decision.messages) ? decision.messages : null;
    // 没有「真消息」要进入就别注入：否则会凭空多出一个只有召回的 step。
    if (!entering || !entering.some((message) => message?.source?.kind !== 'runtime-context')) return decision;

    const session = agent?.session;
    const sessionId = String(session?.id || '');
    if (!sessionId) return decision;
    const cfg = settings.get();
    if (!cfg.enabled || !cfg.turnRecall) return decision;

    const buffer = sessionRecalls.get(sessionId);
    if (!buffer) return decision;
    // 同一轮只注入一次：缓冲里记了「这个 turn 发过了」，会话日志里也查一遍。
    if (buffer.injectedTurn === turn) return decision;
    if (tailAlreadyInSession(session, turn)) {
      buffer.injectedTurn = turn;
      return decision;
    }

    const frozen = briefingFreeze.get(sessionId);
    const records = recallFor(sessionId, new Set(frozen?.ids || []));
    const text = recallBlockText(records, cfg.turnRecallMaxChars);
    if (!text) {
      buffer.injectedTurn = turn;
      return decision;
    }
    /* 记下本会话已注入过的 id：同一段内容已经在会话历史里，下一轮不再重复占位。 */
    const recallSeen = sessionRecallSeen.get(sessionId) || new Set();
    for (const record of records) recallSeen.add(record.id);
    sessionRecallSeen.set(sessionId, recallSeen);

    const message = tailRecallMessage(text, { turn, ids: records.map((record) => record.id) });
    const anchor = entering.findLastIndex((candidate) => Array.isArray(messages) && messages.includes(candidate));
    const spliced =
      anchor >= 0
        ? entering.toSpliced(anchor + 1, 0, message)
        : [...entering, message];
    buffer.injectedTurn = turn;
    buffer.injectedAt = Date.now();
    lastTail = {
      sessionId,
      turn,
      step,
      count: records.length,
      chars: text.length,
      mode: 'tail',
      at: new Date().toISOString(),
    };
    try {
      const recallRoot = normalizeRoot(session?.header?.cwd || '');
      if (recallRoot) {
        store.markExposed(records.map((record) => record.id), { workspace: recallRoot });
        store.injectionLogAppend(recallRoot, {
          sessionId,
          turn,
          kind: 'turn-recall',
          mode: 'tail',
          ids: records.map((record) => record.id),
          text,
        });
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-memory: 轮末召回曝光记账失败: ${error?.message || error}`);
    }
    return { ...decision, messages: spliced };
  }

  /* ---------------- 路径 JIT：文件被触达时，相关记忆自己出现 ---------------- */

  const PATH_EXTENSIONS =
    'tsx?|jsx?|mjs|cjs|cts|mts|py|pyi|rs|go|java|kt|swift|c|h|cpp|hpp|cs|rb|php|md|markdown|json|jsonc|ya?ml|toml|ini|cfg|conf|csv|tsv|html?|css|scss|less|vue|svelte|sh|bash|zsh|ps1|psm1|bat|cmd|sql|proto|graphql|prisma|env|lock';
  const ABS_PATH_RE = /[A-Za-z]:[\\/][^\s"'`,;:)\]}{]{1,240}/g;
  const REL_PATH_RE = new RegExp(`(?:[\\w@.-]+[\\\\/]){0,6}[\\w@.-]+\\.(?:${PATH_EXTENSIONS})\\b`, 'gi');

  /** 从工具参数里挑出「像文件路径」的字符串（≤4 个）；URL 与 node_modules 一律不要。 */
  function extractToolPaths(value) {
    if (value == null) return [];
    let text = '';
    try {
      text = typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
      return [];
    }
    if (!text || text.length > 20000) return [];
    const found = new Set();
    const push = (raw) => {
      let p = String(raw || '').trim();
      p = p.replace(/[.,;:)\]}'"`]+$/u, '');
      if (p.length < 4 || p.length > 240) return;
      const lower = p.toLowerCase();
      if (lower.startsWith('http://') || lower.startsWith('https://')) return;
      if (lower.includes('node_modules')) return;
      found.add(p);
    };
    for (const match of text.matchAll(ABS_PATH_RE)) push(match[0]);
    for (const match of text.matchAll(REL_PATH_RE)) push(match[0]);
    return [...found].slice(0, 4);
  }

  /**
   * tools/pre-execute 只观察不裁决：把参数里的文件路径记下来，算好命中的记忆，
   * 存进本会话的 stash；真正的注入发生在下一个 agent/pre-step（同一套尾部机制）。
   */
  function noteToolPaths(exec) {
    const cfg = settings.get();
    if (!cfg.enabled || !cfg.pathRecall || !cfg.autoInject) return;
    const session = exec?.agent?.session;
    const sessionId = String(session?.id || '');
    if (!sessionId) return;
    const cwd = session?.header?.cwd;
    const workspace = typeof cwd === 'string' && cwd.trim() ? normalizeRoot(cwd) : '';
    if (!workspace) return;
    if (workspaceDisabled(workspace, cfg)) return;

    const rawArgs = exec?.args ?? exec?.input ?? exec?.params ?? exec?.arguments ?? null;
    const files = extractToolPaths(rawArgs);
    if (!files.length) return;

    const seen = pathRecallSeen.get(sessionId) || new Set();
    const frozenIds = new Set(briefingFreeze.get(sessionId)?.ids || []);
    const bufferIds = new Set((sessionRecalls.get(sessionId)?.records || []).map((r) => r.id));
    const records = store.recallByFiles({
      workspace,
      files,
      limit: cfg.pathRecallLimit ?? 3,
      excludeIds: [...seen, ...frozenIds, ...bufferIds],
    });
    if (records.length) pathRecallStash.set(sessionId, { files, records });
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      noteToolPaths(exec);
    } catch (error) {
      // 路径收集失败绝不影响工具执行。
      ctx.logger?.warn?.(`dsh-memory: 路径收集失败: ${error?.message || error}`);
    }
    // 不拥有决策：waterfall 礼仪是原样放行 next() 的结果。
    return next();
  });

  function pathRecallBlockText(records, files) {
    if (!records.length) return '';
    const labelOf = (record) => CATEGORY_LABELS[record.category] || record.category;
    const lines = [];
    lines.push('### 相关记忆（按文件触达）');
    lines.push('');
    lines.push(
      `（刚触达：${files.map((f) => `\`${f}\``).join('、')}。以下是挂在这些文件上的记忆，只是背景参考；与本轮任务冲突时以本轮任务为准。不要写回记忆。）`,
    );
    lines.push('');
    for (const record of records) {
      lines.push(
        `- [${labelOf(record)}] ${record.title} — ${clamp(record.content, RECALL_SNIPPET_CHARS)} (\`${record.id}\`)`,
      );
    }
    return lines.join('\n');
  }

  function pathRecallMessage(text, { turn, ids, files }) {
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: TAIL_SOURCE_KIND, form: 'path-recall', turn, ids, files },
    });
  }

  function injectPathRecall(decision, { agent, messages, turn, step, signal }) {
    if (!decision || decision.kind === 'reject') return decision;
    if (signal?.aborted) return decision;
    const cfg = settings.get();
    if (!cfg.enabled || !cfg.pathRecall) return decision;
    const entering = Array.isArray(decision.messages) ? decision.messages : null;
    if (!entering || !entering.some((message) => message?.source?.kind !== 'runtime-context')) return decision;

    const session = agent?.session;
    const sessionId = String(session?.id || '');
    if (!sessionId) return decision;
    const stash = pathRecallStash.get(sessionId);
    if (!stash?.records?.length) return decision;
    // 弹出 stash：同一次触达只注入一次（重试时 stash 已空，天然去重）。
    pathRecallStash.delete(sessionId);

    const seen = pathRecallSeen.get(sessionId) || new Set();
    const frozenIds = new Set(briefingFreeze.get(sessionId)?.ids || []);
    const records = stash.records.filter((r) => !seen.has(r.id) && !frozenIds.has(r.id));
    if (!records.length) return decision;

    const text = pathRecallBlockText(records, stash.files);
    if (!text) return decision;
    const ids = records.map((r) => r.id);
    for (const id of ids) seen.add(id);
    if (seen.size > 200) {
      pathRecallSeen.set(sessionId, new Set([...seen].slice(-100)));
    } else {
      pathRecallSeen.set(sessionId, seen);
    }

    const message = pathRecallMessage(text, { turn, ids, files: stash.files });
    // 锚点：已有尾部消息（轮末召回）之后；否则紧跟被认领的批次。
    const lastTailIdx = entering.findLastIndex((m) => m?.source?.kind === TAIL_SOURCE_KIND);
    const claimedIdx = entering.findLastIndex((candidate) => Array.isArray(messages) && messages.includes(candidate));
    const anchor = lastTailIdx >= 0 ? lastTailIdx : claimedIdx;
    const spliced = anchor >= 0 ? entering.toSpliced(anchor + 1, 0, message) : [...entering, message];
    lastPathTail = {
      sessionId,
      turn,
      step,
      count: records.length,
      chars: text.length,
      files: stash.files,
      at: new Date().toISOString(),
    };
    try {
      const recallRoot = normalizeRoot(session?.header?.cwd || '');
      if (recallRoot) {
        store.markExposed(ids, { workspace: recallRoot });
        store.injectionLogAppend(recallRoot, {
          sessionId,
          turn,
          kind: 'path-recall',
          mode: 'path',
          ids,
          files: stash.files,
          text,
        });
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-memory: 路径召回曝光记账失败: ${error?.message || error}`);
    }
    return { ...decision, messages: spliced };
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    try {
      const afterRecall = injectTailRecall(decision, payload);
      return injectPathRecall(afterRecall, payload);
    } catch (error) {
      // 注入失败不能拖垮整个 step：照常放行原生 decision。
      ctx.logger?.warn?.(`dsh-memory: 尾部召回注入失败: ${error?.message || error}`);
      return decision;
    }
  });

  /* ---------------- LLM 提炼 ---------------- */

  const captureLog = [];
  let capturing = false;
  let lastCaptureAt = 0;
  /* 0 候选后的退避截止时间（按会话）：避免同一段对话在冷却里一遍又一遍地空跑模型。 */
  const captureBackoff = new Map();

  function pushCapture(entry) {
    captureLog.unshift({ at: new Date().toISOString(), ...entry });
    if (captureLog.length > CAPTURE_LOG_LIMIT) captureLog.length = CAPTURE_LOG_LIMIT;
  }

  /**
   * 解析一次辅助调用要用的 provider/model 路由。
   * 兜底链：显式 session → lastSession → 最近登记的会话（面板按钮触发时往往没有
   * 活跃对话——刚开 DSH 就进设置面板点「重写画像」是最常见的空路由场景）。
   */
  function resolveRoute(session) {
    const routeOf = (candidate) => {
      try {
        const header = candidate?.requestHeader?.();
        const config = header?.config;
        if (config?.provider && config?.model) {
          return { provider: String(config.provider), model: String(config.model) };
        }
      } catch {
        /* 会话已关闭 / requestHeader 不可用就试下一个 */
      }
      return null;
    };
    return (
      routeOf(session) ||
      routeOf(lastSession) ||
      [...sessionRefs.values()]
        .sort((a, b) => b.at - a.at)
        .map((ref) => routeOf(ref.session))
        .find(Boolean) ||
      { provider: '', model: '' }
    );
  }

  /**
   * 用宿主 LLM 做一次「system + 单条 user」的辅助调用，返回纯文本。
   * 路由取当前会话的请求头，跟随用户选的模型。
   */
  async function callLlm({ session, system, userText, maxTokens = 1500, signal }) {
    const llm = ctx.get('llm');
    if (!llm || typeof llm.stream !== 'function') {
      const error = new Error('llm 服务不可用');
      error.code = 'llm_unavailable';
      throw error;
    }
    const route = resolveRoute(session);
    if (!route.provider || !route.model) {
      const error = new Error('当前没有可用的模型路由：先在 DSH 里随便发一条消息，再回来点这个按钮');
      error.code = 'no_model_route';
      throw error;
    }

    const assembler = new BlockAssembler();
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      maxTokens,
      ...(session?.id ? { sessionId: session.id } : {}),
      ...(signal ? { signal } : {}),
    });
    for await (const chunk of stream) assembler.push(chunk);
    const blocks = assembler.blocks();
    return blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
  }

  /** 把「supersedes」引用（id 或旧条标题）解析成既有记录；解析不到就当普通保存。 */
  function resolveSupersedeTarget(reference, workspace) {
    const ref = String(reference || '').trim();
    if (!ref) return null;
    const pool = store.list({ workspace, limit: 500 }).records;
    return pool.find((r) => r.id === ref) || pool.find((r) => r.title === ref) || null;
  }

  /**
   * 落库一条提炼候选。captureMode=draft 时先落草稿（supersedes 挂在记录上，
   * 批准时由 /queue/approve 兑现）；direct 模式下带 supersedes 的候选直接走版本链。
   */
  function applyCandidate(candidate, { workspace, cfg, sessionId, draft }) {
    const payload = {
      ...candidate,
      source: 'auto',
      sessionId,
      evidence: candidate.evidence || (sessionId ? { sessionId } : null),
      status: draft ? 'draft' : 'active',
    };
    if (!draft && candidate.supersedes) {
      const old = resolveSupersedeTarget(candidate.supersedes, workspace);
      if (old) return store.supersede(old.id, payload, { workspace });
    }
    return store.upsert(payload, { workspace, dedupe: cfg.dedupe });
  }

  /**
   * 对一段对话做提炼。`force` 为真时忽略开关与冷却（面板上的手动按钮）。
   * @returns {Promise<{ok:boolean, reason?:string, saved?:number, candidates?:number, titles?:string[]}>}
   */
  async function runCapture({ force = false, workspace = '', session = null, text = '' } = {}) {
    const cfg = settings.get();
    if (!cfg.enabled) return { ok: false, reason: 'disabled' };
    if (!force && !cfg.autoCapture) return { ok: false, reason: 'auto_off' };
    if (capturing) return { ok: false, reason: 'busy' };

    const target = session || lastSession;
    const targetRoot = normalizeRoot(workspace || target?.header?.cwd || activeWorkspace() || '');
    if (!targetRoot) return { ok: false, reason: 'no_workspace' };

    const messages = typeof target?.deriveMessages === 'function' ? target.deriveMessages() : [];
    if (!force) {
      const gate = shouldDistill(messages, { minChars: cfg.autoCaptureMinChars });
      if (!gate.distill) {
        pushCapture({ workspace: targetRoot, reason: 'too_short', saved: 0, candidates: 0, total: gate.total });
        return { ok: false, reason: 'too_short' };
      }
    }

    const transcript = text
      ? text.slice(0, cfg.maxTranscriptChars)
      : selectTranscript(messages, { maxChars: cfg.maxTranscriptChars });
    if (!transcript || transcript === '[]') {
      pushCapture({ workspace: targetRoot, reason: 'empty_transcript', saved: 0, candidates: 0 });
      return { ok: false, reason: 'empty_transcript' };
    }

    capturing = true;
    try {
      const existing = store.list({ workspace: targetRoot, limit: 24 }).records;
      const reply = await callLlm({
        session: target,
        system: DISTILL_SYSTEM,
        userText: buildDistillInput({
          workspace: targetRoot,
          transcript,
          existingRecords: existing.map((record) => ({ id: record.id, title: record.title })),
        }),
      });
      const candidates = parseDistillResponse(reply, {
        minConfidence: cfg.minConfidence,
        max: cfg.maxPerTurn,
      });

      const draft = cfg.captureMode === 'draft';
      const savedIds = [];
      let drafted = 0;
      let superseded = 0;
      for (const candidate of candidates) {
        const result = applyCandidate(candidate, {
          workspace: targetRoot,
          cfg,
          sessionId: target?.id ?? null,
          draft,
        });
        if (result?.record?.id) {
          savedIds.push(result.record.id);
          if (result.record.status === 'draft') drafted += 1;
          if (result.superseded?.id) superseded += 1;
        }
      }
      pushCapture({
        workspace: targetRoot,
        reason: draft && drafted ? 'drafted' : 'captured',
        candidates: candidates.length,
        saved: savedIds.length - drafted,
        drafts: drafted,
        superseded,
        titles: candidates.map((candidate) => candidate.title),
        ids: savedIds,
      });
      return { ok: true, saved: savedIds.length, candidates: candidates.length, ids: savedIds, drafts: drafted };
    } catch (error) {
      const message = error?.message || String(error);
      pushCapture({ workspace: targetRoot, reason: 'error', error: message, saved: 0, candidates: 0 });
      return { ok: false, reason: 'error', error: message };
    } finally {
      capturing = false;
    }
  }

  /** 面板上的「提炼这段文本」：只返回候选，不落库。 */
  async function distillNow({ workspace = '', text = '' } = {}) {
    const targetRoot = normalizeRoot(workspace || activeWorkspace() || '');
    const cfg = settings.get();
    const existing = targetRoot ? store.list({ workspace: targetRoot, limit: 24 }).records : [];
    const reply = await callLlm({
      session: lastSession,
      system: DISTILL_SYSTEM,
      userText: buildDistillInput({
        workspace: targetRoot,
        transcript: text.slice(0, cfg.maxTranscriptChars),
        existingRecords: existing.map((record) => ({ id: record.id, title: record.title })),
      }),
    });
    return parseDistillResponse(reply, {
      minConfidence: settings.get().minConfidence,
      max: settings.get().maxPerTurn,
    });
  }

  /** 面板上的「立即提炼当前会话」。 */
  async function captureNow({ force = true, workspace = '' } = {}) {
    return runCapture({ force, workspace, session: lastSession });
  }

  /* ---------------- 轮末召回 ---------------- */

  /**
   * 轮次结束后的相关召回：拿当轮最后一条用户消息做一次本地检索，
   * 把命中的记忆缓冲起来，下一轮的简报段会带上「相关召回」块。
   * 纯本地打分、不调模型；连续两轮不重复召回同一条（话题延续时靠简报索引即可）。
   */
  /** 最近一条用户消息的纯文本（轮末召回与会话索引共用）。 */
  function lastUserText(session) {
    const messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === 'user') {
        const text = messageText(messages[i]).trim();
        if (text) return text;
      }
    }
    return '';
  }

  /** 最近一条 assistant 文本（引用计数用；只看模型最终说出口的内容）。 */
  function lastAssistantText(session) {
    const messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === 'assistant') {
        const text = messageText(messages[i]).trim();
        if (text) {
          return { text, fingerprint: `${text.length}:${text.slice(0, 64)}:${text.slice(-32)}` };
        }
      }
    }
    return null;
  }

  function scheduleRecall(workspace, session) {
    const cfg = settings.get();
    // 注入总闸关掉、或该工作区在停用名单里：连缓冲区都不建，省下这次检索。
    if (!cfg.autoInject || workspaceDisabled(workspace, cfg)) return;
    const key = String(session?.id || '');
    const buffer = {
      ids: [],
      records: [],
      previous: sessionRecalls.get(key)?.ids || [],
      at: Date.now(),
    };
    sessionRecalls.set(key, buffer);
    if (sessionRecalls.size > 60) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [id, rec] of sessionRecalls) {
        if (rec.at < oldestAt) {
          oldestAt = rec.at;
          oldestKey = id;
        }
      }
      if (oldestKey && oldestKey !== key) sessionRecalls.delete(oldestKey);
    }

    try {
      const userText = lastUserText(session);
      if (userText.length < 8) return;
      // 「继续 / 好的 / 下一步」这类续跑发言不带来新话题：为它检索只会召回噪声。
      if (isContinuation(userText)) return;

      const exclude = new Set(
        briefingRecords(workspace, briefModeOf() === 'full' ? 'full' : 'index').map((r) => r.id),
      );
      const recent = new Set(buffer.previous);
      const alreadyInjected = sessionRecallSeen.get(key) || new Set();
      // search 带 query 时只返回相关度 > 0 的记录（store 层保证），这里只管排重。
      const found = store
        .search({ workspace, query: userText.slice(0, 2000), limit: cfg.turnRecallLimit * 3 })
        .filter((r) => !exclude.has(r.id) && !recent.has(r.id) && !alreadyInjected.has(r.id))
        .slice(0, cfg.turnRecallLimit);
      if (!found.length) return;
      buffer.ids = found.map((r) => r.id);
      buffer.records = found;
      // 这里只排期；真正进入 prompt 时才记曝光（见 injectTailRecall）。
    } catch (error) {
      ctx.logger?.warn?.(`dsh-memory: 轮末召回失败: ${error?.message || error}`);
    }
  }

  /* ---------------- 会话事件 ---------------- */

  ctx.on('session/created', (session) => {
    noteSession(session);
    /* 会话 id 被复用（续跑 / 重开同一 id）时，旧快照不能顺延给新会话。 */
    const reused = String(session?.id || '');
    if (reused) {
      briefingFreeze.delete(reused);
      citationSeen.delete(reused);
      sessionRecallSeen.delete(reused);
      captureBackoff.delete(reused);
    }
    // 会话刚建好、还没产生任何事件时，面板上的「提炼当前会话」也该有目标。
    if (session) {
      lastSession = session;
      if (!isSubagentSession(session)) lastMainSession = session;
    }
    /* 启动整理：打开 DSH 后的第一次会话就给一次机会（没有工作区 / 未到期时它自己跳过）。 */
    scheduleAutoDream(600);
  });

  ctx.on('session/event', (session, event) => {
    noteSession(session);
    lastSession = session;
    if (!isSubagentSession(session)) lastMainSession = session;
    /* 会话销毁时清掉它的简报快照与召回缓冲（Map 容量另有上限兜底）。 */
    if (event?.type === 'session/disposed') {
      const id = String(session?.id || '');
      if (id) {
        briefingFreeze.delete(id);
        sessionRecalls.delete(id);
        sessionRecallSeen.delete(id);
        captureBackoff.delete(id);
        pathRecallStash.delete(id);
        pathRecallSeen.delete(id);
        citationSeen.delete(id);
      }
      /* WorkBuddy 在会话结束时把画像刷新一次；会话销毁前再给自动刷新一次机会。 */
      const cwdDisposed = session?.header?.cwd;
      if (
        typeof cwdDisposed === 'string' &&
        cwdDisposed.trim() &&
        session?.header?.origin !== 'subagent' &&
        !session?.header?.parentSession
      ) {
        scheduleAutoPortrait(normalizeRoot(cwdDisposed), session, 'dispose');
      }
      return;
    }
    /* 压缩协同：宿主压缩上下文时把摘要照录进工作日志（compaction/summary|prune）。 */
    if (event?.type === 'compaction/summary' || event?.type === 'compaction/prune') {
      const cfgNow = settings.get();
      const cwdNow = session?.header?.cwd;
      if (cfgNow.enabled && cfgNow.compactionSalvage && typeof cwdNow === 'string' && cwdNow.trim()) {
        try {
          const summary = String(event?.data?.summary ?? event?.data?.text ?? '').trim();
          const line = summary
            ? `上下文已压缩；压缩摘要（原文照录）：${summary}`
            : '上下文已压缩；压缩前的结论如未写进记忆或日志，请在此补记。';
          store.journalAppend(normalizeRoot(cwdNow), { text: clamp(line, 1600) });
        } catch (error) {
          ctx.logger?.warn?.(`dsh-memory: 压缩协同失败: ${error?.message || error}`);
        }
      }
      return;
    }

    if (event?.type !== 'turn/end') return;

    const cwd = session?.header?.cwd;
    const cfg = settings.get();
    const subagent =
      session?.header?.origin === 'subagent' || Boolean(session?.header?.parentSession);

    /* 自动整理：启动时 / 会话建立时 / 每次轮末都检查到期（纯本地读，到期才跑）。 */
    if (cfg.enabled) scheduleAutoDream(0);

    // 会话索引：把这一轮的用户发言原文落库（溯源用，独立于轮末召回开关）。
    if (cfg.enabled && cfg.sessionSearch && typeof cwd === 'string' && cwd.trim()) {
      try {
        store.sessionLogAppend(normalizeRoot(cwd), {
          sessionId: String(session?.id || ''),
          turn: Number(event?.turn) || 0,
          text: lastUserText(session),
        });
      } catch (error) {
        ctx.logger?.warn?.(`dsh-memory: 会话索引写入失败: ${error?.message || error}`);
      }
    }

    // 引用计数：只看模型最后一条 assistant 文本里是否点名了记忆 id。
    if (cfg.enabled && typeof cwd === 'string' && cwd.trim()) {
      try {
        const last = lastAssistantText(session);
        const sessionId = String(session?.id || '');
        const fingerprint = `${event?.turn ?? ''}:${last?.fingerprint || ''}`;
        if (last && sessionId && citationSeen.get(sessionId) !== fingerprint) {
          citationSeen.set(sessionId, fingerprint);
          store.markCitations(last.text, { workspace: normalizeRoot(cwd) });
        }
      } catch (error) {
        ctx.logger?.warn?.(`dsh-memory: 引用记账失败: ${error?.message || error}`);
      }
    }

    // 轮末召回先跑：纯本地打分，跟自动提炼互相独立。
    if (cfg.enabled && cfg.turnRecall && typeof cwd === 'string' && cwd.trim()) {
      scheduleRecall(normalizeRoot(cwd), session);
    }

    /*
     * WorkBuddy 式主路径：轮末检查全局画像是否该自动刷新。
     * 条件不满足就什么都不做；满足时后台跑一次模型重写，不阻塞轮次。
     */
    if (cfg.enabled && !subagent && typeof cwd === 'string' && cwd.trim()) {
      scheduleAutoPortrait(normalizeRoot(cwd), session, 'turn');
    }

    if (!cfg.enabled || !cfg.autoCapture || capturing) return;
    if (Date.now() - lastCaptureAt < cfg.captureCooldownMs) return;
    const captureSessionId = String(session?.id || '');
    if (captureSessionId && Date.now() < (captureBackoff.get(captureSessionId) || 0)) return;
    if (typeof cwd !== 'string' || !cwd.trim()) return;
    // 停用名单同样挡自动提炼：一次性任务的工作区不该沉淀记忆。
    if (workspaceDisabled(normalizeRoot(cwd), cfg)) return;
    // 子代理会话是「派活的中间过程」：默认只在里面召回（只读），不把它的碎片写成记忆。
    if (subagent && !cfg.captureSubagents) return;
    // 「继续 / 好的 / 下一步」没有新素材；只为它调一次提炼是纯浪费。
    const turnUserText = lastUserText(session);
    if (!turnUserText || isContinuation(turnUserText)) return;

    lastCaptureAt = Date.now();
    // 不阻塞轮次收尾：提炼在后台跑，失败只记日志。
    void runCapture({ workspace: normalizeRoot(cwd), session })
      .then((result) => {
        if (!captureSessionId || !result?.ok) return;
        if (result.candidates === 0) {
          captureBackoff.set(captureSessionId, Date.now() + Math.max(CAPTURE_EMPTY_BACKOFF_MS, cfg.captureCooldownMs));
        } else {
          captureBackoff.delete(captureSessionId);
        }
      })
      .catch((error) => {
        ctx.logger?.warn?.(`dsh-memory: 自动提炼失败: ${error?.message || error}`);
      });
  });

  // 启动时把已有会话的工作区拉一遍，让面板在第一次打开前就有数据。
  ctx.inject(['sessions'], (sessionCtx) => {
    try {
      const list = sessionCtx.sessions?.list?.();
      if (Array.isArray(list)) {
        for (const session of list) {
          noteSession(session);
          if (!isSubagentSession(session)) lastMainSession = session;
        }
      }
    } catch {
      /* sessions 服务形态不同就忽略，事件路径仍然工作 */
    }
    /* 等会话登记完再检查启动整理（画像重写要从会话头里取模型路由）；一次性，不常驻。 */
    const timer = setTimeout(() => scheduleAutoDream(0), 1200);
    timer.unref?.();
  });

  /* ---------------- 画像重写管线（P1） ---------------- */

  /** 重写运行状态（内存态；面板用它显示「重写中」与错误）。 */
  let rewriteState = { running: false, startedAt: null, lastAt: null, lastError: null, lastResult: null };

  /** 解析失败码 → 人话说明（面板直接显示，别让用户对着 no_json 猜）。 */
  const REWRITE_PARSE_HINTS = {
    empty: '模型没有返回任何内容',
    no_json: '模型没有按 JSON 输出（已用严格提示重试过一次）',
    no_sections: '模型输出的 JSON 里没有 sections 字段',
    empty_sections: '模型输出的四段正文都是空的',
    truncated: '模型输出被截断（多半是画像太长没写完），可缩短日志范围后重试',
  };

  /**
   * 把失败的原始输出记一条脱敏摘要进宿主日志：下次再坏时能看出模型到底吐了什么。
   * 原文不落盘、不进面板；摘要先过密钥脱敏（写路径同样受「密钥不落盘」约束）。
   */
  function logRewriteExcerpt(reply, error) {
    try {
      const raw = String(reply ?? '').trim();
      if (!raw) return;
      const redacted = scanSecrets(raw.slice(0, 600)).text;
      ctx.logger?.warn?.(
        `dsh-memory: 画像重写解析失败（${error}），原始输出摘要：${JSON.stringify(redacted)}`,
      );
    } catch {
      /* 日志失败不能影响主流程 */
    }
  }

  /**
   * 自动画像的对话原料：最近几轮 user/assistant 原文。
   * WorkBuddy 的 User Memory Profile 就是吃对话生长出来的；只靠记忆标题 + 稀疏日志，
   * 画像会停在导入状态。这里只取最近几条、截断后作为 context，不作为 evidence。
   */
  function portraitTranscript(session = null) {
    const target = session || lastSession;
    if (!target || typeof target.deriveMessages !== 'function') return '';
    try {
      const messages = target.deriveMessages();
      const picked = [];
      for (let i = messages.length - 1; i >= 0 && picked.length < 8; i -= 1) {
        const role = messages[i]?.role;
        if (role !== 'user' && role !== 'assistant') continue;
        const text = scanSecrets(messageText(messages[i]).trim()).text;
        if (!text) continue;
        picked.unshift(`${role === 'user' ? 'User' : 'Assistant'}: ${clamp(text, 900)}`);
      }
      return clamp(picked.join('\n'), 5000);
    } catch {
      return '';
    }
  }

  /**
   * 用宿主 LLM 做一次「重写式合并」：旧画像 + 最近日志 + 条目摘要 → 新画像。
   * rewriteMode=direct 直接落库；draft 存待审稿（批准前对模型不可见）。防重复：running 时拒绝。
   */
  async function runPortraitRewrite({
    workspace = '',
    scope = 'workspace',
    mode = '',
    session = null,
    migrateText = '',
    contextWorkspace = '',
  } = {}) {
    const cfg = settings.get();
    if (!cfg.enabled) return { ok: false, error: 'disabled' };
    if (rewriteState.running) return { ok: false, error: 'already_running' };

    const targetRoot = scope === 'global' ? '' : normalizeRoot(workspace || '');
    const contextRoot = scope === 'global' && contextWorkspace ? normalizeRoot(contextWorkspace) : '';
    if (scope !== 'global' && !targetRoot) return { ok: false, error: 'no_workspace' };

    rewriteState = { ...rewriteState, running: true, startedAt: new Date().toISOString(), lastError: null };
    try {
      const oldPortrait = store.portrait(targetRoot);
      const globalJournal = store.journalRecent(targetRoot, { days: cfg.journalDays });
      let journal = globalJournal;
      /*
       * 重写原料的作用域要跟画像一致：全局画像的 root 是空串，而 `list({workspace:''})`
       * 本身取的就是全局库——此时 includeGlobal 必须开，否则一条原料都拿不到
       * （0.6.0 自查发现：全局画像重写此前只拿得到日志、拿不到全局条目）。
       *
       * WorkBuddy 式全局画像还要吸收「当前工作区近况」：全局条目往往很少，
       * 只看全局库的话画像永远停在导入时的状态，自动刷新就成了摆设。
       * 只借工作区的近况条目与日志，不借红线 / taint / 草稿；它们不该进用户画像。
       */
      let records = store
        .list({ workspace: targetRoot, includeGlobal: scope === 'global', limit: 200, sort: 'updated' })
        .records.filter((record) => record.status !== 'draft' && record.category !== 'constraint' && !record.taint);
      let contextCount = 0;
      if (contextRoot) {
        const contextRecords = store
          .list({ workspace: contextRoot, includeGlobal: false, limit: 120, sort: 'updated' })
          .records.filter(
            (record) => record.status !== 'draft' && record.category !== 'constraint' && !record.taint,
          );
        contextCount = contextRecords.length;
        const byId = new Map();
        for (const record of [...records, ...contextRecords]) byId.set(record.id, record);
        records = [...byId.values()]
          .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
          .slice(0, 200);
        /* 日志才是「近况」的正文来源；只给标题的话，模型没材料可写。 */
        const contextJournal = store.journalRecent(contextRoot, { days: cfg.journalDays });
        if (contextJournal.length) {
          const byDate = new Map(globalJournal.map((entry) => [entry.date, entry.text]));
          for (const entry of contextJournal) {
            const text = String(entry.text || '').trim();
            if (!text) continue;
            const prev = byDate.get(entry.date);
            byDate.set(entry.date, prev ? `${prev}\n\n[workspace]\n${text}` : `[workspace]\n${text}`);
          }
          journal = [...byDate.entries()]
            .sort((a, b) => b[0].localeCompare(a[0]))
            .map(([date, text]) => ({ date, text }));
        }
      }
      if (!oldPortrait && !journal.length && !records.length) {
        return {
          ok: false,
          error: 'no_material',
          detail: '没有可用的重写原料（画像 / 日志 / 条目都为空）',
        };
      }
      const contextNote =
        contextRoot && (contextCount || journal.length > globalJournal.length)
          ? 'Material may include recent memory entries and journal entries from the current workspace. Use them as context for the user\'s ongoing work; do not copy workspace-specific rules, secrets or paths into the global profile. In `evidence`, cite only global memory ids and journal:YYYY-MM-DD; workspace entries are context only.'
          : '';
      const scopeRule =
        scope === 'global'
          ? 'This is the user-level profile. The `preference` section is personal background and collaboration style only — never copy project-specific decisions, conventions, redlines, file paths or architecture rules into it. Put project context in `background` / `focus` / `recent`, and keep only durable user-level facts.'
          : '';
      const transcript = portraitTranscript(session);
      const transcriptNote = transcript
        ? `Recent conversation (context only; do not cite it as evidence):\n${transcript}`
        : '';
      const userText = [scopeRule, transcriptNote, contextNote, buildRewriteInput({ scope, oldPortrait, journal, records })]
        .filter(Boolean)
        .join('\n\n');
      /*
       * 跨 App 迁移原料：用户从其它应用拿回的画像 JSON（api 层已解析成四段文本），
       * 拼到重写输入尾部让模型按普通重写流程整合；为空时不附加任何内容。
       */
      const finalUserText = migrateText
        ? `${userText}\n\nImported portrait material from another app — merge it into the current portrait:\n${migrateText}`
        : userText;
      const reply = await callLlm({
        session: session || lastSession,
        system: REWRITE_SYSTEM,
        userText: finalUserText,
        maxTokens: 2600,
      });
      let parsed = parseRewriteResponse(reply, { scope });

      if (!parsed.ok) {
        /*
         * 第一次没按 JSON 输出：用更严格的提示词再要一次。
         * 只在失败时多花一次调用，成功路径的花费不变。
         */
        const retryReply = await callLlm({
          session: session || lastSession,
          system: REWRITE_STRICT_SYSTEM,
          userText: finalUserText,
          maxTokens: 4000,
        });
        const retryParsed = parseRewriteResponse(retryReply, { scope });
        if (retryParsed.ok) {
          parsed = retryParsed;
        } else {
          logRewriteExcerpt(reply, parsed.error);
          logRewriteExcerpt(retryReply, retryParsed.error);
          const error = new Error(
            `重写结果解析失败（${retryParsed.error}）：${REWRITE_PARSE_HINTS[retryParsed.error] || '模型输出无法解析'}`,
          );
          error.code = 'rewrite_parse_failed';
          throw error;
        }
      }

      /*
       * 有损抢救（输出被截断 / JSON 整体坏掉后按段捞）得到的画像不能直接覆盖用户手写的内容——
       * 一律改送待审，让人在面板里过一眼再决定。
       */
      const lossy = parsed.degraded === 'truncated' || parsed.degraded === 'salvaged';
      /* 画像写入同样受「密钥不落盘」约束：模型可能从对话里抄回密钥，落库前再过一次脱敏。 */
      parsed.sections = (parsed.sections || []).map((section) => ({
        ...section,
        text: scanSecrets(section.text).text,
      }));
      /*
       * 全局画像引用了工作区条目时，派生链只认全局库，会把证据判成「源记忆已不存在」。
       * 只保留能在全局画像作用域里对账的证据（全局条目 / 全局日志）；工作区素材只做上下文。
       */
      if (scope === 'global' && contextRoot) {
        const globalIds = new Set(records.filter((record) => record.scope === 'global').map((record) => record.id));
        const journalDates = new Set(globalJournal.map((entry) => entry.date));
        const evidence = {};
        for (const [key, refs] of Object.entries(parsed.evidence || {})) {
          evidence[key] = (Array.isArray(refs) ? refs : [])
            .map((ref) => String(ref))
            .filter((ref) =>
              ref.startsWith('journal:') ? journalDates.has(ref.slice(8)) : globalIds.has(ref),
            )
            .slice(0, 12);
        }
        parsed.evidence = evidence;
      }
      const useMode = lossy ? 'draft' : mode || cfg.rewriteMode;
      if (useMode === 'draft') {
        store.portraitDraftWrite(targetRoot, {
          sections: parsed.sections,
          evidence: parsed.evidence,
          basedOn: { version: oldPortrait?.version || 0, records: records.length, journalDates: journal.length },
        });
        rewriteState = { ...rewriteState, running: false, lastAt: new Date().toISOString(), lastResult: 'drafted' };
        return {
          ok: true,
          drafted: true,
          sections: parsed.sections,
          evidence: parsed.evidence,
          degraded: parsed.degraded || 'none',
        };
      }
      const saved = store.savePortrait(targetRoot, {
        sections: parsed.sections,
        evidence: parsed.evidence,
        source: 'auto',
      });
      /* 直写成功即代表这份画像比旧待审稿新：清掉旧稿，别让面板继续挂着一份过期草稿。 */
      store.portraitDraftClear(targetRoot);
      rewriteState = { ...rewriteState, running: false, lastAt: new Date().toISOString(), lastResult: 'saved' };
      return {
        ok: true,
        drafted: false,
        portrait: saved.portrait,
        degraded: parsed.degraded || 'none',
      };
    } catch (error) {
      const message = String(error?.message || error);
      const code = typeof error?.code === 'string' && error.code ? error.code : 'rewrite_failed';
      rewriteState = { ...rewriteState, running: false, lastError: message, lastAt: new Date().toISOString() };
      ctx.logger?.warn?.(`dsh-memory: 画像重写失败: ${message}`);
      return { ok: false, error: code, detail: message };
    }
  }

  /** 批准待审重写稿：落库（source=auto）→ 清掉待审文件。 */
  /**
   * 二级蒸馏：把本项目的记忆抽成「候选原则」，写进全局候选池。
   *
   * 只喂四类可能上行的类别（feedback / decision / preference / constraint）。
   * 试跑结论：fact / note / component / task 基本不可上行，喂进去只会稀释判断，
   * 把合格率从 3% 再往下拉。
   *
   * 失败一律软降级：没有模型路由、输出解析不出来、写入失败，都只返回原因，
   * 让 Dream 记进报告，不抛给调用方。
   */
  async function runGlobalDistill({ workspace = '', session = null } = {}) {
    const cfg = settings.get();
    if (!cfg.enabled || cfg.globalDistill === false) return { ok: false, error: 'disabled' };

    const root = normalizeRoot(workspace);
    if (!root) return { ok: false, error: 'no_workspace' };

    const records = store
      .list({ workspace: root, includeGlobal: false, limit: 200, sort: 'updated' })
      .records.filter(
        (record) =>
          record.status !== 'draft' &&
          !record.taint &&
          ['feedback', 'decision', 'preference', 'constraint'].includes(record.category),
      );
    /* 少于 3 条素材不值得蒸馏：凑不出两个锚点，也看不出模式。 */
    if (records.length < 3) return { ok: false, error: 'no_material', detail: records.length };

    const material = records
      .map((record) => {
        const body = String(record.content || '').replace(/\s+/g, ' ').slice(0, 70);
        const why = record.reason
          ? ` ｜ 理由：${String(record.reason).replace(/\s+/g, ' ').slice(0, 40)}`
          : '';
        return `- id=${record.id} [${record.category}] ${record.title}：${body}${why}`;
      })
      .join('\n');

    let reply;
    try {
      reply = await callLlm({
        session: session || lastSession,
        system: GLOBAL_DISTILL_SYSTEM,
        userText: `本项目共 ${records.length} 条候选素材：\n\n${material}`,
        maxTokens: 1200,
      });
    } catch (error) {
      return {
        ok: false,
        error: error?.code || 'llm_unavailable',
        detail: String(error?.message || error),
      };
    }

    const items = parseGlobalDistill(reply);
    if (!items.length) return { ok: false, error: 'no_candidate' };

    /* 项目标识用 workspaceKey：它是「同一个项目」的稳定身份，不含路径原文。 */
    const project = workspaceKey(root);
    const saved = store.candidates.add(items.map((item) => ({ ...item, project })));
    return { ok: true, added: saved.added, skipped: saved.skipped, parsed: items.length };
  }

  function approvePortraitDraft({ workspace = '', scope = 'workspace' } = {}) {
    const targetRoot = scope === 'global' ? '' : normalizeRoot(workspace || '');
    const draft = store.portraitDraftRead(targetRoot);
    if (!draft) return { ok: false, error: 'no_draft' };
    const saved = store.savePortrait(targetRoot, {
      sections: draft.sections,
      evidence: draft.evidence,
      source: 'auto',
    });
    store.portraitDraftClear(targetRoot);
    return { ok: true, portrait: saved.portrait };
  }

  /* ---------------- 自动刷新全局画像（WorkBuddy 式主路径） ---------------- */

  /**
   * WorkBuddy 的 User Memory Profile 是「自动重写的主记忆」：有新材料就更新，
   * 版本号与 Last updated 自己走，不需要用户点「整理」。
   * 这里用同样的主次：自动刷新是默认路径；面板「重写画像」降级为「立即刷新」兜底。
   *
   * 触发点：turn/end 与 session/disposed（不挂 agent/turn-stopping，C5）。
   * 节流：距上次画像更新满 autoPortraitHours（默认 6）；失败后 10 分钟内不重试。
   * 只借当前工作区的近况条目，不借红线 / taint / 草稿。
   */
  const AUTO_PORTRAIT_RETRY_MS = 10 * 60 * 1000;
  const autoPortraitState = { running: false, lastTryAt: 0, lastSuccessAt: 0 };

  function globalPortraitUpdatedAt() {
    const saved = Date.parse(store.portrait('')?.updatedAt || '') || 0;
    /* draft 模式不推进画像 updatedAt；用待审稿的 createdAt 也占住节流，避免重启后重复调用模型。 */
    const draft = Date.parse(store.portraitDraftRead('')?.createdAt || '') || 0;
    return Math.max(saved, draft);
  }

  /** 当前工作区是否有比全局画像更新的素材（只算会进画像的类别）；对话本身也算素材。 */
  function hasPortraitMaterial(workspace, session = null) {
    if (portraitTranscript(session)) return true;
    const portraitAt = globalPortraitUpdatedAt();
    try {
      const records = store.list({ workspace, includeGlobal: true, limit: 80, sort: 'updated' }).records;
      return records.some((record) => {
        if (record.status === 'draft' || record.category === 'constraint' || record.taint) return false;
        return (Date.parse(record.updatedAt) || 0) > portraitAt;
      });
    } catch {
      return false;
    }
  }

  function scheduleAutoPortrait(workspace, session, reason = 'turn') {
    const cfg = settings.get();
    const hours = Number(cfg.autoPortraitHours) || 0;
    if (!cfg.enabled || hours <= 0 || !workspace) return;
    if (workspaceDisabled(workspace, cfg)) return;
    if (autoPortraitState.running || rewriteState.running || capturing) return;
    const now = Date.now();
    const last = Math.max(globalPortraitUpdatedAt(), autoPortraitState.lastSuccessAt);
    if (last && now - last < hours * 3600000) return;
    if (autoPortraitState.lastTryAt && now - autoPortraitState.lastTryAt < AUTO_PORTRAIT_RETRY_MS) return;
    if (!hasPortraitMaterial(workspace, session)) return;

    autoPortraitState.running = true;
    autoPortraitState.lastTryAt = now;
    void runPortraitRewrite({
      workspace,
      scope: 'global',
      contextWorkspace: workspace,
      session,
      mode: cfg.rewriteMode,
    })
      .then((result) => {
        if (result?.ok) {
          autoPortraitState.lastSuccessAt = Date.now();
          ctx.logger?.info?.(
            `dsh-memory: 全局画像已自动刷新（${result.drafted ? '进待审' : `v${result.portrait?.version ?? '?'}`}，触发 ${reason}）`,
          );
        } else if (
          result?.error &&
          !['no_material', 'already_running', 'no_model_route', 'llm_unavailable', 'disabled', 'no_workspace'].includes(
            result.error,
          )
        ) {
          ctx.logger?.warn?.(
            `dsh-memory: 自动刷新画像失败: ${result.error}${result.detail ? ` — ${result.detail}` : ''}`,
          );
        }
      })
      .catch((error) => ctx.logger?.warn?.(`dsh-memory: 自动刷新画像失败: ${error?.message || error}`))
      .finally(() => {
        autoPortraitState.running = false;
      });
  }

  /* ---------------- 自动整理条目（启动时 + 轮末按到期检查，无常驻定时器） ---------------- */

  /**
   * 无感维护：打开 DSH 时与每轮结束时检查「距上次整理是否满 autoDreamDays 天」，
   * 满了就在后台跑一次 Dream 的安全子集。没有 setInterval、没有 daemon，
   * 也不占对话轮次（失败只记日志，绝不阻塞启动或轮次收尾；失败 10 分钟内不重试）。
   */
  const dream = createDreamRunner({
    store,
    settings,
    rewriteNow: runPortraitRewrite,
    distillNow: runGlobalDistill,
    logger: ctx.logger,
  });
  const autoDreamState = { running: false, lastTryAt: 0 };
  let autoDreamTimer = null;

  /** 一次性排期（没有 setInterval）；已有排期 / 正在跑 / 功能关闭就直接跳过。 */
  function scheduleAutoDream(delay = 0) {
    const cfg = settings.get();
    if (!cfg.enabled || !(Number(cfg.autoDreamDays) > 0)) return;
    if (autoDreamState.running || autoDreamTimer) return;
    autoDreamTimer = setTimeout(() => {
      autoDreamTimer = null;
      void runAutoDream().catch((error) => {
        /* 整理是后台增值动作，任何意外都不能变成 unhandled rejection 拖垮宿主。 */
        ctx.logger?.warn?.(`dsh-memory: 自动整理失败: ${error?.message || error}`);
      });
    }, Math.max(0, Number(delay) || 0));
    autoDreamTimer.unref?.();
  }

  /** 距上次（自动或手动）整理是否已满 autoDreamDays；工作区停用名单同样生效。 */
  function autoDreamDue(workspace) {
    const cfg = settings.get();
    const days = Number(cfg.autoDreamDays) || 0;
    if (!cfg.enabled || days <= 0 || !workspace) return false;
    if (workspaceDisabled(workspace, cfg)) return false;
    const state = store.maintenanceState(workspace);
    const last = Math.max(
      Date.parse(state.lastAutoAt || '') || 0,
      Date.parse(state.lastManualAt || '') || 0,
    );
    if (!last) return true;
    return Date.now() - last >= days * 86400000;
  }

  /** 没有活跃会话时从库里挑最近用过的一个（启动时可能还没有会话事件）。 */
  function startupWorkspace() {
    const live = normalizeRoot(lastSession?.header?.cwd || '');
    if (live) return live;
    const first = store.workspaces().find((item) => item && item.root);
    if (first) return normalizeRoot(first.root);
    return activeWorkspace();
  }

  async function runAutoDream() {
    if (autoDreamState.running) return;
    const cfg = settings.get();
    if (!cfg.enabled || !(Number(cfg.autoDreamDays) > 0)) return;
    const workspace = startupWorkspace();
    if (!workspace) return; // 还没有任何工作区：等 session/created 再试
    /* 空库 / 只有一条：没有可合并或可归档的东西；每轮只读检查，不写库。 */
    if (store.stats({ workspace }).total < 2 || !autoDreamDue(workspace)) return;
    /* 失败 10 分钟内不重试；正常成功后 autoDreamDue 会被 lastAutoAt 推后。 */
    if (autoDreamState.lastTryAt && Date.now() - autoDreamState.lastTryAt < AUTO_PORTRAIT_RETRY_MS) return;
    /* 正在自动提炼 / 画像重写 / 手动 Dream：让位，留给下一次事件重试。 */
    if (capturing || rewriteState.running || dream.state().running) return;

    autoDreamState.running = true;
    autoDreamState.lastTryAt = Date.now();
    try {
      /* 画像由 autoPortraitHours 的自动刷新负责；Dream 只在显式打开 autoDreamPortrait 时顺带重写。 */
      const route = resolveRoute(null);
      const hasRoute = Boolean(route.provider && route.model);
      const report = await dream.run({
        workspace,
        source: 'auto',
        portrait: cfg.autoDreamPortrait === true && hasRoute,
      });
      if (report?.ok) {
        ctx.logger?.info?.(
          `dsh-memory: 自动整理完成（合并 ${report.merged.length} 簇 / 待确认矛盾 ${report.contradictionsPending.length} 条 / 画像 ${report.portrait || '未触发'}）`,
        );
      } else {
        ctx.logger?.warn?.(`dsh-memory: 自动整理失败: ${report?.error || 'unknown'}`);
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-memory: 自动整理失败: ${error?.message || error}`);
    } finally {
      autoDreamState.running = false;
    }
  }

  /* ---------------- HTTP API（设置面板） ---------------- */

  const api = createApi({
    store,
    settings,
    activeWorkspace,
    listWorkspaces,
    workspaceForSession: (id) => sessionRoots.get(String(id))?.root || '',
    activeSession: () => {
      const id = String(lastMainSession?.id || '');
      if (!id) return null;
      return { id, workspace: normalizeRoot(lastMainSession?.header?.cwd || '') };
    },
    captures: () => captureLog.slice(0, 12),
    /* 简报计量 + 重建日志 + 尾部召回计量：面板据此显示「为什么重算了 / 尾部注了什么」。 */
    briefingInfo: () => ({
      ...lastBriefing,
      rebuilds: briefingLog.slice(0, 12),
      tail: { ...lastTail },
      pathTail: { ...lastPathTail },
    }),
    /* 「下次请求会尾部注入什么」：预览里单独一栏，不进系统提示。 */
    recallInfo: (workspace) => pendingRecall(workspace),
    /* 「已经冻结的静态简报是哪一份字节」：预览据此显示真正会注入的文本。 */
    snapshotInfo: (workspace) => snapshotInfo(workspace),
    version: VERSION,
    distillNow,
    captureNow,
    rewriteNow: runPortraitRewrite,
    rewriteState: () => ({ ...rewriteState }),
    dreamNow: dream.run,
    dreamInfo: () => dream.state(),
    approveDraft: approvePortraitDraft,
  });

  /** 本机回环 + 可信 Host 才放行；服务本身不带鉴权，这层是必须的。 */
  function trustedHosts() {
    try {
      const runtime = ctx.get('webRuntime');
      const list = runtime?.trustedHosts;
      if (Array.isArray(list)) return list.map(String);
      if (list && typeof list[Symbol.iterator] === 'function') return [...list].map(String);
    } catch {
      /* webRuntime 不存在时回落到回环白名单 */
    }
    return ['127.0.0.1', 'localhost', '::1'];
  }

  function isTrusted(req) {
    const address = String(req?.socket?.remoteAddress || '');
    const loopback =
      address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.');
    const hosts = trustedHosts();
    if (!loopback) {
      const host = String(req?.headers?.host || '').split(':')[0];
      if (!host || !hosts.includes(host)) return false;
    }
    // 有 Origin 时必须是同源/回环，挡掉浏览器里的跨站请求。
    const origin = req?.headers?.origin;
    if (origin) {
      try {
        const originHost = new URL(origin).hostname;
        if (!['127.0.0.1', 'localhost', '::1'].includes(originHost) && !hosts.includes(originHost)) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  function send(res, status, body) {
    const text = JSON.stringify(body ?? { ok: false, error: 'empty' });
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(text);
  }

  function readBody(req, limit = 4 * 1024 * 1024) {
    return new Promise((resolve) => {
      let size = 0;
      let settled = false;
      const chunks = [];
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      req.on('data', (chunk) => {
        if (settled) return; // 已超限：继续排水（丢弃），不再累计
        size += chunk.length;
        if (size > limit) {
          /*
           * 超限：回 tooLarge 信号让路由层答 413，而不是装作没有 body。
           * 不 destroy 连接——destroy 会让客户端看到连接重置而不是错误响应；
           * 后续数据由上面的 settled 分支继续丢弃。
           */
          chunks.length = 0;
          finish({ tooLarge: true });
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => finish(null));
    });
  }

  async function route(req, res) {
    if (!isTrusted(req)) {
      send(res, 403, { ok: false, error: 'forbidden' });
      return;
    }
    const url = new URL(String(req.url || '/'), 'http://127.0.0.1');
    if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) {
      send(res, 404, { ok: false, error: 'unknown_route' });
      return;
    }

    const method = String(req.method || 'GET').toUpperCase();
    let body = null;
    if (method !== 'GET' && method !== 'HEAD') {
      const raw = await readBody(req);
      if (raw && typeof raw === 'object' && raw.tooLarge) {
        send(res, 413, { ok: false, error: 'payload_too_large' });
        return;
      }
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = null;
        }
      }
    }

    const result = await api.handle({
      method,
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      body,
    });
    send(res, result.status, result.body);
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: route }),
      'dsh-memory: settings api',
    );
  });

  /* ---------------- 模型工具 ---------------- */

  const memoryTool = defineTool({
    name: 'memory',
    description: [
      'Long-term memory for the current workspace; persists across sessions and is keyed by workspace.',
      'Store durable facts (preferences, conventions, decisions, environment gotchas, failed approaches),',
      'never transient task state, file contents, or tool output.',
      'Actions: save (create/update one), search (keyword retrieval),',
      'sessions (search past user turns for original wording),',
      'promote (write into the AGENTS.md managed block; from=portrait writes the profile),',
      'derivations (source-chain health), review (falsifier due),',
      'list/get/update/forget/stats, journal (append or read the work log).',
      'Search before saving to dedupe. If a fact contradicts an existing memory,',
      'save with supersedes=old id instead of adding a second entry; related links topics.',
      'Drafts are approved only by the USER in Settings → Memory: never approve your own draft or bypass the queue.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: [
          'save',
          'search',
          'sessions',
          'promote',
          'derivations',
          'review',
          'list',
          'get',
          'update',
          'forget',
          'stats',
          'journal',
        ],
        description: 'What to do.',
      },
      text: {
        type: 'string',
        description: 'journal: the work-log line to append (one or two sentences is fine). Omit it to READ recent journal instead.',
      },
      days: {
        type: 'integer',
        description: 'journal (read mode): how many recent days to return (1-30, default 3).',
      },
      title: {
        type: 'string',
        description: 'save/update: one-line headline of the memory (<=160 chars). Required for save.',
      },
      content: {
        type: 'string',
        description: 'save/update: the fact itself, with the reasoning or evidence that makes it useful.',
      },
      category: {
        type: 'string',
        enum: [...CATEGORIES],
        description: `save/update: ${CATEGORIES.map((id) => `${id}=${CATEGORY_LABELS[id]}`).join(', ')}.`,
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'save/update: free-form tags for retrieval.',
      },
      keywords: {
        type: 'array',
        items: { type: 'string' },
        description: 'save/update: 3-6 extra retrieval keywords (boosts search hits).',
      },
      related: {
        type: 'array',
        items: { type: 'string' },
        description: 'save/update: ids of related memories (links may dangle).',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description:
          'save/update: file paths this memory is anchored to (relative or absolute). When a tool touches one of these files later, the memory is recalled automatically (path JIT).',
      },
      supersedes: {
        type: 'string',
        description: 'save: id of the existing memory this one replaces (it gets archived; rollback possible).',
      },
      reason: {
        type: 'string',
        description:
          'save/update: why this is worth remembering, in one sentence (shown in the panel and the export; also proves the memory was not written behind the user).',
      },
      falsifier: {
        type: 'string',
        description:
          'save/update: what would make this memory stop being true (a condition to check). With it, the memory is scheduled for periodic re-review.',
      },
      reviewAt: {
        type: 'string',
        description: 'save/update: when this memory should be re-reviewed (ISO date). Defaults to one review period after writing.',
      },
      from: {
        type: 'string',
        description: 'promote: set to "portrait" to write the profile section into AGENTS.md instead of one memory.',
      },
      section: {
        type: 'string',
        description: 'promote (from=portrait): which profile section to write (background | preference | focus | recent).',
      },
      evidence: {
        type: 'object',
        additionalProperties: false,
        description:
          'save/update: where it came from. Any of { quote, sessionId, turn, url }; quote is the user words or code that triggered it.',
        properties: {
          quote: { type: 'string' },
          sessionId: { type: 'string' },
          turn: { type: 'string' },
          url: { type: 'string' },
        },
      },
      scope: {
        type: 'string',
        enum: ['workspace', 'global'],
        description:
          'save/update: workspace (default, keyed to this directory) or global (every workspace). Category "user" always stores globally.',
      },
      id: { type: 'string', description: 'get/update/forget: exact memory id.' },
      query: { type: 'string', description: 'search: keywords. Empty returns the most recent memories.' },
      limit: { type: 'integer', description: 'search/list: max rows (1-50, default 10).' },
      tag: { type: 'string', description: 'list: only memories carrying this tag.' },
      pinned: { type: 'boolean', description: 'update: pin to the top of the injected briefing.' },
      archived: { type: 'boolean', description: 'list/update: include or set the archived flag.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          text: { type: 'string', required: true },
          count: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const cfg = settings.get();
      if (!cfg.enabled) return { action: 'stats', count: 0, text: 'dsh-memory 已在设置中关闭。' };

      const session = exec?.agent?.session;
      if (session) lastSession = session;
      const workspace = normalizeRoot(session?.header?.cwd || activeWorkspace() || '');
      if (!workspace) {
        return { action: args.action, count: 0, text: '当前会话没有工作区目录，无法使用工作区记忆。' };
      }
      const action = String(args.action || '').toLowerCase();
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));

      const row = (record) => {
        const label = CATEGORY_LABELS[record.category] || record.category;
        const flags = [
          record.pinned ? '置顶' : '',
          record.archived ? '已归档' : '',
          record.scope === 'global' ? '全局' : '',
          typeof record.quality === 'number' && record.quality < 60 ? `质量${record.quality}` : '',
        ]
          .filter(Boolean)
          .join('/');
        const tags = (record.tags || []).length ? ` #${record.tags.join(' #')}` : '';
        const lines = [
          `- [${label}${flags ? ` ${flags}` : ''}] ${record.title}${tags}`,
          `  ${clamp(record.content, 400)}`,
          `  id=\`${record.id}\``,
        ];
        if (record.reason) lines.push(`  理由：${clamp(record.reason, 200)}`);
        if (record.falsifier) {
          lines.push(`  失效条件：${clamp(record.falsifier, 200)}`);
          if (record.reviewAt) lines.push(`  复审到期：${String(record.reviewAt).slice(0, 10)}`);
        }
        if (record.evidence?.quote) lines.push(`  出处：${clamp(record.evidence.quote, 200)}`);
        return lines.join('\n');
      };

      if (action === 'save') {
        const title = String(args.title ?? '').trim();
        const content = String(args.content ?? '').trim();
        if (!title && !content) return { action, count: 0, text: 'save 需要 title 或 content。' };

        const probe = `${title} ${content}`;
        const similar = store.search({ workspace, query: probe, limit: 3 });
        const payload = {
          title: title || clamp(content, 160),
          content: content || title,
          category: CATEGORIES.includes(args.category) ? args.category : 'decision',
          tags: Array.isArray(args.tags) ? args.tags : [],
          keywords: Array.isArray(args.keywords) ? args.keywords : [],
          related: Array.isArray(args.related) ? args.related : [],
          scope: args.scope === 'global' ? 'global' : 'workspace',
          source: 'agent',
          sessionId: session?.id ?? null,
          files: Array.isArray(args.files) ? args.files : [],
          reason: typeof args.reason === 'string' ? args.reason : null,
          falsifier: typeof args.falsifier === 'string' ? args.falsifier : null,
          reviewAt: typeof args.reviewAt === 'string' ? args.reviewAt : null,
          evidence: args.evidence && typeof args.evidence === 'object' ? args.evidence : null,
        };

        let result;
        const supersedeId = String(args.supersedes ?? '').trim();
        if (supersedeId && !args.id) {
          const old = store.get(supersedeId, { workspace });
          if (!old) {
            return { action, count: 0, text: `要推翻的记忆 ${supersedeId} 不存在，请先 action=search 确认 id。` };
          }
          result = store.supersede(old.id, payload, { workspace });
        } else {
          result = store.upsert({ ...payload, id: args.id }, { workspace, dedupe: cfg.dedupe });
        }
        // 不用手工失效快照：下一次渲染会用内容指纹发现「记忆变了」并重算一次。

        const related = similar.filter((r) => r.id !== result.record.id).slice(0, 3);
        const lines = [
          result.mergedInto
            ? `已合并进高度相似的既有记忆 \`${result.record.id}\`：${result.record.title}`
            : result.superseded
              ? `已保存新记忆 \`${result.record.id}\` 并归档被推翻的旧记忆 \`${result.superseded.id}\`（可用回滚恢复）：${result.record.title}`
              : `已保存记忆 \`${result.record.id}\`：${result.record.title}`,
        ];
        if (result.record.archiveReason === 'low_quality') {
          lines.push(
            '',
            `质量分 ${result.record.quality}（低于 30），已自动归档、不进简报。若确实有用，用 action=update id=${result.record.id} archived=false 捞回来。`,
          );
        }
        if (!result.record.reason) {
          lines.push('', '提示：带一句 `reason`（为什么值得记）会让这条记忆在面板与导出里说得清来由。');
        }
        /* 只对「会过期」的那几类催失效条件，免得每条笔记都被追问。 */
        if (!result.record.falsifier && ['decision', 'convention', 'preference', 'feedback'].includes(result.record.category)) {
          lines.push('', '提示：带一句 `falsifier`（什么情况出现就说明它不再成立）会让它自动排期复审，到期提醒你回来看。');
        }
        if (related.length) {
          lines.push('', '可能相关的既有记忆（如有重复可用 action=update 或 action=forget 处理）：');
          for (const rel of related) lines.push(`- ${rel.title} (id=\`${rel.id}\`)`);
        }
        return { action, count: 1, text: lines.join('\n') };
      }

      if (action === 'search') {
        const query = String(args.query ?? '').trim();
        const found = query
          ? store.search({ workspace, query, limit })
          : store.list({ workspace, limit }).records;
        store.markExposed(found.map((r) => r.id), { workspace });
        if (!found.length) {
          return {
            action,
            count: 0,
            text: query
              ? `本工作区没有匹配「${query}」的记忆。可用 action=list 浏览，或 action=save 记录新事实。`
              : '本工作区还没有任何记忆。',
          };
        }
        return {
          action,
          count: found.length,
          text: [`本工作区命中 ${found.length} 条：`, ...found.map(row)].join('\n'),
        };
      }

      if (action === 'list') {
        const result = store.list({
          workspace,
          category: CATEGORIES.includes(args.category) ? args.category : '',
          tag: String(args.tag ?? ''),
          archived: Boolean(args.archived),
          limit,
        });
        const stats = store.stats({ workspace });
        if (!result.records.length) {
          return {
            action,
            count: 0,
            text: `本工作区还没有记忆（共 ${stats.total} 条）。用 action=save 记录第一条。`,
          };
        }
        return {
          action,
          count: result.records.length,
          text: [
            `本工作区 ${stats.total} 条（置顶 ${stats.pinned}），本次显示 ${result.records.length}/${result.total}：`,
            ...result.records.map(row),
          ].join('\n'),
        };
      }

      if (action === 'get') {
        const id = String(args.id ?? '').trim();
        const record = id ? store.get(id, { workspace }) : null;
        if (!record) return { action, count: 0, text: `找不到记忆 ${id || '(缺少 id)'}。` };
        store.markOpened([record.id], { workspace });
        const opened = store.get(record.id, { workspace }) || record;
        const lines = [
          `# ${record.title}`,
          `id=\`${record.id}\` ｜ 类别 ${CATEGORY_LABELS[record.category] || record.category} ｜ 范围 ${record.scope} ｜ 来源 ${record.source}`,
          `标签 ${(record.tags || []).join(', ') || '(无)'} ｜ 置顶 ${record.pinned ? '是' : '否'} ｜ 归档 ${record.archived ? '是' : '否'}`,
          `创建 ${record.createdAt} ｜ 更新 ${record.updatedAt} ｜ 打开 ${opened.openedCount || 0} ｜ 引用 ${opened.citedCount || 0}`,
        ];
        if (record.supersedes) lines.push(`推翻了 \`${record.supersedes}\`（版本链）`);
        if (record.supersededBy) lines.push(`已被 \`${record.supersededBy}\` 推翻（版本链）`);
        if (record.related?.length) lines.push(`关联记忆：${record.related.map((x) => `\`${x}\``).join('、')}`);
        lines.push('', record.content);
        return { action, count: 1, text: lines.join('\n') };
      }

      if (action === 'update') {
        const id = String(args.id ?? '').trim();
        if (!id) return { action, count: 0, text: 'update 需要 id。' };
        const patch = {};
        for (const key of ['title', 'content', 'category', 'tags', 'keywords', 'related', 'scope', 'pinned', 'archived']) {
          if (args[key] !== undefined) patch[key] = args[key];
        }
        if (typeof args.reason === 'string') patch.reason = args.reason;
        if (typeof args.falsifier === 'string') patch.falsifier = args.falsifier;
        if (typeof args.reviewAt === 'string') patch.reviewAt = args.reviewAt;
        if (args.evidence && typeof args.evidence === 'object') patch.evidence = args.evidence;
        if (Object.keys(patch).length === 0) {
          return { action, count: 0, text: 'update 没有给出任何要改的字段。' };
        }
        const result = store.update(id, patch, { workspace });
        if (!result?.ok) return { action, count: 0, text: `找不到记忆 ${id}。` };
        return { action, count: 1, text: `已更新 \`${id}\`：${result.record.title}` };
      }

      if (action === 'forget') {
        const id = String(args.id ?? '').trim();
        if (!id) return { action, count: 0, text: 'forget 需要 id。' };
        const result = store.remove(id, { workspace });
        if (!result?.ok) return { action, count: 0, text: `找不到记忆 ${id}。` };
        return { action, count: 1, text: `已删除记忆 \`${id}\`（${result.removed?.title ?? ''}）。` };
      }

      if (action === 'sessions') {
        const rows = store.sessionSearch({
          workspace,
          query: String(args.query ?? '').trim(),
          limit: Math.max(1, Math.min(50, Number(args.limit) || 8)),
        });
        if (!rows.length) {
          return {
            action,
            count: 0,
            text: '会话索引里没有相关原文（索引只收录开启后的轮次，且只记每轮的用户发言）。可以先 action=save 把它记成记忆。',
          };
        }
        const lines = [
          '与会话历史相关的原话（dsh-memory 会话索引；只是参考，不代表当前任务）：',
          '',
        ];
        for (const row of rows) {
          lines.push(
            `- ${String(row.at).slice(0, 16).replace('T', ' ')}（turn ${row.turn}）：${clamp(row.text, 240)}`,
          );
        }
        return { action, count: rows.length, text: lines.join('\n') };
      }

      if (action === 'promote') {
        const from = String(args.from ?? '').trim();
        if (from === 'portrait') {
          const section = String(args.section ?? 'preference').trim() || 'preference';
          const result = store.promotePortraitToAgents(workspace, { section });
          if (!result.ok) {
            const reasons = {
              no_portrait: '这个工作区还没有画像，先用 action=save 存几条记忆再重写画像。',
              no_section: `画像里没有可用的「${section}」段。`,
              global_scope: 'global 画像不晋升——AGENTS.md 是工作区文件。',
            };
            return { action, count: 0, text: reasons[result.error] || `晋升失败：${result.error}` };
          }
          return {
            action,
            count: result.lines.length,
            text: `已把画像「${section}」段写进 ${result.file}（来源：画像 v${result.portraitVersion}；画像改写后这里会被标脏）。`,
          };
        }
        const id = String(args.id ?? '').trim();
        if (!id) return { action, count: 0, text: 'promote 需要 id（先 action=get 或 search 确认）。' };
        const result = store.promoteToAgents(workspace, { id });
        if (!result.ok) {
          const reasons = {
            not_found: `找不到记忆 ${id}（先 action=get 确认）。`,
            global_scope: 'global 范围的记忆不晋升——AGENTS.md 是工作区文件。',
            not_promotable: '只有 convention / decision / preference / feedback 可以晋升到 AGENTS.md。',
          };
          return { action, count: 0, text: reasons[result.error] || `晋升失败：${result.error}` };
        }
        return {
          action,
          count: 1,
          text: `已晋升进 ${result.file}（重复晋升不会产生重复行；块外内容可自由手工编辑）。`,
        };
      }

      if (action === 'derivations') {
        const entries = store.derivationList(workspace);
        if (!entries.length) {
          return {
            action,
            count: 0,
            text: '这个工作区还没有派生链（画像与 AGENTS.md 托管块都还没建立）。',
          };
        }
        const lines = entries.map((entry) => {
          const flag = entry.state === 'dirty' ? `已失效：${entry.reason}` : '仍成立';
          const src = entry.sources.map((s) => s.id).join('、') || '（无）';
          return `- [${entry.layer}] ${entry.target} — ${flag}｜源：${src}`;
        });
        const dirty = entries.filter((e) => e.state === 'dirty').length;
        return {
          action,
          count: entries.length,
          text: [`派生链（${entries.length} 条，失效 ${dirty} 条）：`, ...lines].join('\n'),
        };
      }

      if (action === 'review') {
        const id = String(args.id ?? '').trim();
        if (id) {
          const result = store.markReviewed(id, { workspace, reviewAt: args.reviewAt ?? null });
          if (!result.ok) return { action, count: 0, text: `找不到记忆 ${id}（先 action=get 确认）。` };
          return {
            action,
            count: 1,
            text: `已复审 \`${id}\`，下次到期：${String(result.reviewAt).slice(0, 10)}。`,
          };
        }
        const queue = store.reviewQueue(workspace, { withinDays: 30 });
        if (!queue.due.length && !queue.soon.length) {
          return { action, count: 0, text: '没有到期或即将到期的复审项。' };
        }
        const lines = [
          `到期 ${queue.due.length} 条 ｜ 30 天内到期 ${queue.soon.length} 条：`,
          ...[...queue.due, ...queue.soon].map(
            (r) => `- ${r.title}（到期 ${String(r.reviewAt).slice(0, 10)}）— 失效条件：${r.falsifier || '（未写）'}`,
          ),
        ];
        return { action, count: queue.due.length + queue.soon.length, text: lines.join('\n') };
      }

      if (action === 'journal') {
        const hasTextArg = args.text !== undefined && args.text !== null;
        const text = String(args.text ?? '').trim();
        if (hasTextArg && !text) {
          return { action, count: 0, text: 'journal 内容为空，未写入（要读取日志请省略 text）。' };
        }
        if (text) {
          const result = store.journalAppend(workspace, { text });
          if (!result.ok) return { action, count: 0, text: 'journal 内容为空，未写入。' };
          return { action, count: 1, text: `已写入工作日志（${result.date} ${result.time}）。` };
        }
        const days = Math.min(30, Math.max(1, Number(args.days) || 3));
        const recent = store.journalRecent(workspace, { days });
        if (!recent.length) {
          return { action, count: 0, text: '还没有工作日志。用 `action=journal` 加 `text` 写第一条。' };
        }
        return {
          action,
          count: recent.length,
          text: recent.map((item) => `## ${item.date}\n${item.text.trim()}`).join('\n\n'),
        };
      }

      // stats
      const stats = store.stats({ workspace });
      const byCategory = Object.entries(stats.byCategory || {})
        .sort((a, b) => b[1] - a[1])
        .map(([id, count]) => `${CATEGORY_LABELS[id] || id} ${count}`)
        .join(' ｜ ');
      // dataFile 是主库里的存储文件，mirrorFile 才是给人看的镜像；两者别混为一谈。
      const info = store.workspaceInfo(workspace);
      return {
        action: 'stats',
        count: stats.total,
        text: [
          `工作区 \`${workspace}\``,
          `本工作区 ${stats.total} 条 ｜ 置顶 ${stats.pinned} ｜ 归档 ${stats.archived} ｜ 全局 ${stats.global}${stats.drafts ? ` ｜ 待审草稿 ${stats.drafts}` : ''}`,
          byCategory ? `分类：${byCategory}` : '还没有分类数据',
          `数据目录：\`${store.dir}\` ｜ 本工作区存储：\`${info.dataFile}\``,
          info.mirrorFile ? `镜像文件：\`${info.mirrorFile}\`` : '镜像文件：（全局记忆没有工作区镜像）',
          `最近更新：${stats.updatedAt || '(无)'}`,
        ].join('\n'),
      };
    },
  });

  ctx.effect(() => ctx.tools.register(memoryTool), 'dsh-memory: memory tool');

  ctx.logger?.info?.(`dsh-memory ready (dir=${dir})`);
}

export { API_PREFIX, Config, GLOBAL_KEY, apply, inject, isContinuation, name };
export default { Config, apply, inject, name, VERSION, API_PREFIX, GLOBAL_KEY };
