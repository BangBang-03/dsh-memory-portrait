/**
 * dsh-memory — 持久化存储层。
 *
 * 纯 Node 实现（node:fs / node:path / node:crypto），不依赖任何 DSH 运行时 API，
 * 因此可以脱离 DSH 单独测试（见 test/store.test.mjs）。
 *
 * 磁盘布局（默认根目录 ~/.dsh/storages/dsh-memory）：
 *   index.json                          工作区索引
 *   workspaces/<slug>-<key8>/memories.json   该工作区的记忆记录
 *   workspaces/<slug>-<key8>/MEMORY.md       人类可读镜像（可选）
 *   workspaces/<slug>-<key8>/portrait.json   画像层（每工作区一份；_global 同构）
 *   workspaces/<slug>-<key8>/PORTRAIT.md     画像的人读正本（保存时同步刷）
 *   workspaces/<slug>-<key8>/portrait.history/v<N>.json  画像历史版本快照
 *   workspaces/<slug>-<key8>/derivations.json      跨层派生链（记忆→画像→AGENTS.md 的源快照）
 *   workspaces/_global/memories.json         跨工作区共享记忆
 *
 * 工作区另有一份可携带副本（受 mirror 控制，只装本工作区 active 记录）：
 *   <ws>/.dsh-memory/MEMORY.md               人读镜像（有损：只有标题 + 一句话）
 *   <ws>/.dsh-memory/memory-snapshot.json    结构化快照，供跨机器合并；剔除本机使用统计
 *
 * 画像（portrait）：每工作区 / 全局各一份、由「重写式合并」滚动维护的叙事文档。
 * 条目层只存「不会过期」的知识；「现在是什么样」（版本现状、进度、待办）进画像。
 * 段落模型与渲染在 lib/portrait.js（纯函数），这里只管读写、版本快照与正本同步。
 *
 * 记录（record）字段：
 *   id, title, content, category, tags[], scope, source,
 *   sessionId, files[], createdAt, updatedAt, lastUsedAt, useCount,
 *   exposedCount / lastExposedAt（被注入或检索选中的次数，只观察，不参与排序）,
 *   openedCount / citedCount（显式 get、答案引用 id 的次数；二者共同计入 useCount）,
 *   pinned, archived, confidence,
 *   keywords[]（检索加权词，提炼时顺带产出）,
 *   related[]（相关记忆 id，允许悬空）,
 *   reason（为什么记：人写的一句话，面板与导出可见）,
 *   evidence（从哪来：{ sessionId, turn, quote, url } 里的一到几项）,
 *   quality / qualityReasons（0–100 质量分与扣分理由，见 lib/quality.js）,
 *   archiveReason（自动归档的原因，如 'low_quality'）,
 *   supersedes / supersededBy（版本链：新条指旧条，旧条回指新条）,
 *   status（'active' | 'draft'，草稿不进简报/检索/镜像，等面板审批）,
 *   trust（'user'|'agent'|'auto'|'import'|'external'，写入路径推导，模型不能自封 user）,
 *   taint（命中注入模式；非 user 来源的新建记录会被隔离成草稿）,
 *   redactions（写入时被脱敏的密钥类型，如 'openai_key'；正文里对应部分已是 [REDACTED:*]）,
 *   falsifier（什么情况出现就说明这条记忆不再成立）,
 *   reviewAt / reviewedAt（复审到期时间与上次复审时间；带 falsifier 的记忆默认会排期）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { QUALITY_THRESHOLDS, qualityFactor, scoreQuality } from './quality.js';
import { TRUST_LEVELS, scanSecrets, computeTrust, assessTaint } from './security.js';
import { tokenize, uniqueTokens, similarity } from './text.js';
import {
  createBm25fIndex,
  scoreBm25f,
  exactPhraseBoost,
  expandQueryTokens,
  relatedBoostMap,
} from './retrieval.js';

export { tokenize, similarity };

import {
  PORTRAIT_HISTORY_LIMIT,
  normalizeSections,
  normalizePortraitEvidence,
  parsePortraitMarkdown,
  portraitSectionMeta,
  renderPortraitMarkdown,
} from './portrait.js';
import {
  derivationId,
  derivationSummary,
  evaluateEntries,
  memorySource,
  normalizeSource,
  portraitSource,
} from './derivation.js';

export const SCHEMA_VERSION = 2;
export const GLOBAL_KEY = '_global';

/** 注入审计日志最多保留的条数（个人使用量级：够回看几天的注入）。 */
export const INJECTION_LOG_LIMIT = 500;
/** 超上限后再攒这么多条才裁剪一次（滞回）：摊薄重写成本，读回仍封顶上限条。 */
const INJECTION_LOG_TRIM_SLACK = 32;

export const CATEGORIES = [
  'fact',
  'preference',
  'decision',
  'convention',
  'component',
  'task',
  'note',
  'feedback',
  'user',
  /* 红线：用户「以后绝对不要 X」类绝对禁令。治理特权见 isRedline。 */
  'constraint',
];

export const SOURCES = ['manual', 'agent', 'auto', 'import'];

/** 类别 -> 中文显示名（客户端也用它，避免两边不一致）。 */
export const CATEGORY_LABELS = {
  fact: '事实',
  preference: '偏好',
  decision: '决策',
  convention: '约定',
  component: '组件',
  task: '待办',
  note: '笔记',
  feedback: '反馈',
  user: '用户',
  constraint: '红线',
};

const CATEGORY_SET = new Set(CATEGORIES);

/** 红线判定：constraint 类别即红线（不用弱标签——红线的治理特权跟着类别走）。 */
export const isRedline = (record) => record?.category === 'constraint';

/** 答案引用里可识别的记忆 id 形状（mem_<stamp>_<rand>，允许旧数据的变体）。 */
const CITED_ID_RE = /\bmem_[a-z0-9]+(?:_[a-z0-9]+)*\b/gi;

/** 正文里的失效条件标记行：「失效条件：…」「证伪：…」「Falsifier: …」。 */
const FALSIFIER_MARKER_RE = /^\s*(?:失效条件|证伪|falsifier)\s*[:：]\s*(.+?)\s*$/im;

/* ------------------------------------------------------------------ *
 * 工具函数
 * ------------------------------------------------------------------ */

export function defaultRoot() {
  return path.join(os.homedir(), '.dsh', 'storages', 'dsh-memory');
}

/** 统一路径：绝对化 + 去掉尾部分隔符 + Windows 上统一小写比较用。 */
export function normalizeRoot(root) {
  if (!root || typeof root !== 'string') return '';
  let p = path.resolve(root.trim());
  // Windows 下去掉盘符大小写差异
  if (process.platform === 'win32') p = p.replace(/^([a-zA-Z]):/, (_, d) => d.toUpperCase() + ':');
  while (p.length > 3 && (p.endsWith(path.sep) || p.endsWith('/'))) p = p.slice(0, -1);
  return p;
}

/**
 * 工作区标识。
 *
 * 优先用 **git 身份**：同一个仓库的不同克隆、不同 worktree、两台机器上的同一
 * remote，都落到同一份记忆（取 `git rev-parse --git-common-dir` 的 realpath，
 * linked worktree 会归到主 worktree）。不是 git 仓库、git 不可用、或探测超时，
 * 回落到路径哈希——旧行为不丢，老数据也还能读。
 */
export function workspaceKey(root) {
  const norm = normalizeRoot(root);
  if (!norm) return GLOBAL_KEY;
  return gitWorkspaceKey(norm) || pathWorkspaceKey(norm);
}

/** 旧键（路径 sha1 前 10 位）：迁移兼容用，永不改变。 */
export function pathWorkspaceKey(root) {
  const norm = normalizeRoot(root);
  if (!norm) return GLOBAL_KEY;
  const canon = process.platform === 'win32' ? norm.toLowerCase().replace(/\\/g, '/') : norm;
  return crypto.createHash('sha1').update(canon).digest('hex').slice(0, 10);
}

const gitKeyCache = new Map(); // 归一化路径 -> `git-xxxxxxxx` | ''

/** 探测 git 身份键；不是仓库或探测失败返回空串（结果按路径缓存，不反复起进程）。 */
export function gitWorkspaceKey(root) {
  const norm = normalizeRoot(root);
  if (!norm) return '';
  if (gitKeyCache.has(norm)) return gitKeyCache.get(norm);
  let key = '';
  try {
    const out = execFileSync('git', ['-C', norm, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      timeout: 1500,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const raw = String(out || '').trim();
    if (raw) {
      // --git-common-dir 可能是相对路径（相对仓库根），先解析再取 realpath 消掉 worktree 差异。
      const common = path.resolve(norm, raw);
      const real = fs.realpathSync.native ? fs.realpathSync.native(common) : fs.realpathSync(common);
      const canon = process.platform === 'win32' ? real.toLowerCase().replace(/\\/g, '/') : real.replace(/\\/g, '/');
      key = `git-${crypto.createHash('sha1').update(canon).digest('hex').slice(0, 10)}`;
    }
  } catch {
    key = '';
  }
  gitKeyCache.set(norm, key);
  return key;
}

/** 目录友好名：取 basename，非法字符替换成 `-`。 */
export function slugify(root) {
  const norm = normalizeRoot(root);
  if (!norm) return 'global';
  const base = path.basename(norm) || norm.replace(/[:\\/]+/g, '-');
  const slug = base
    .replace(/[^0-9A-Za-z\u4e00-\u9fff._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48);
  return slug || 'workspace';
}

export function folderName(root) {
  const key = workspaceKey(root);
  if (key === GLOBAL_KEY) return GLOBAL_KEY;
  return `${slugify(root)}-${key.slice(0, 8)}`;
}

function newId() {
  const stamp = Date.now().toString(36);
  const rand = crypto.randomBytes(3).toString('hex');
  return `mem_${stamp}_${rand}`;
}

/** 候选原则的 id：和记忆条目分前缀，避免面板与日志里混淆。 */
function newCandidateId() {
  return `cand_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function now() {
  return new Date().toISOString();
}

/** 原子写：先写同目录临时文件再 rename，避免断电/崩溃产生半截 JSON。 */
/**
 * 同步小睡：Node 没有同步 sleep，用 Atomics.wait 在主线程上等。
 * 只在 rename 重试之间用，最多几十毫秒。
 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 环境不支持就退化成立即重试 */
  }
}

/**
 * rename 的退避重试。
 *
 * Windows 上杀软 / 索引器会短暂占住刚写完的文件，`rename` 抛 EPERM / EBUSY / EACCES：
 * 这不是逻辑错误，只是对方松手晚了几毫秒。退避重试几次就把这类抖动吃掉；
 * 真失败（跨盘、目录被删等）照旧抛出，不掩盖。
 */
function renameWithRetry(from, to, attempts = 6) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      return fs.renameSync(from, to);
    } catch (error) {
      const code = error?.code;
      const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!retryable || i === attempts - 1) throw error;
      sleepSync(8 * (i + 1));
    }
  }
  return undefined;
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    renameWithRetry(tmp, file);
  } catch (error) {
    // 重试也没成：把临时文件擦掉再抛。否则崩溃点旁边会留一堆 .tmp（Windows 上见过残留）。
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 擦不掉也不影响把原始错误抛出去 */
    }
    throw error;
  }
}

/**
 * 损坏 JSON 的兜底：先把原文件原样备份成 `<file>.broken-<stamp>`，再返回一个
 * 带备份路径的错误（不抛在备份失败上——连备份都做不了也要把「损坏」报出去）。
 * 同一版损坏文件（mtime+size 没变）只备份一份：面板轮询反复撞上损坏库时
 * 不会把目录塞满重复备份。
 */
const brokenJsonBackups = new Map(); // file -> { stamp, path }

function backupBrokenJson(file, cause) {
  const stamp = fileStamp(file);
  const known = brokenJsonBackups.get(file);
  let broken = known?.stamp === stamp ? known.path : null;
  if (!broken) {
    broken = `${file}.broken-${Date.now().toString(36)}`;
    try {
      fs.copyFileSync(file, broken);
      brokenJsonBackups.set(file, { stamp, path: broken });
    } catch {
      broken = null;
    }
  }
  const error = new Error(
    `记忆库文件损坏${broken ? `，原文件已备份到 ${broken}` : ''}：${file}（${cause?.message || cause}）`,
  );
  error.code = 'EDAMAGED';
  error.backupPath = broken;
  return error;
}

/**
 * 读 JSON。默认宽松：文件不存在 / 为空 / 解析失败都返回 fallback——画像、索引、
 * 派生链等辅助文件可再生，坏一份不该拖垮主流程。
 * strict 模式（主库 memories.json 专用）：文件存在但读不动 / 解析失败时
 * 备份原文件后抛错。绝不能把损坏当空库——否则下一次写入会静默抹掉全部历史（D7）。
 */
function readJson(file, fallback, { strict = false } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || !strict) return fallback;
    throw backupBrokenJson(file, error);
  }
  if (!raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    if (!strict) return fallback;
    throw backupBrokenJson(file, error);
  }
}

function fileStamp(file) {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 体检扩充（2026-10，竞品增量 §4-A/B）：疑似矛盾对 + files 引用失效。
 * 都只报告不处理；纯词法 / 文件系统检查，不调模型。
 * ------------------------------------------------------------------ */

/** 否定/迁移线索（中文 + 英文常见形态）。非全局正则：只取每句第一个命中。 */
const CONTRADICTION_NEG_RE =
  /(不要|别用|禁用|禁止|停用|不再|避免|改用|换成|换用|切换到|迁移到|never|don't|dont|do not|avoid|instead of|no longer|stop using)/i;

/**
 * 否定邻接 token 黑名单：命中「对方关键词」时排除否定词自身及其二元组碎片
 * （「不要用」会切出「要用」这类碎片，拿它当关键词等于拿否定词本身当证据）。
 */
const CONTRADICTION_NEG_TOKENS = new Set([
  '不要', '要用', '别用', '禁用', '禁止', '停用', '不再', '避免', '改用', '换成', '换用',
  '切换', '迁移', 'never', 'dont', 'avoid',
]);

/**
 * 显著内容 token：英文/数字词取 ≥3 字符，中文（含假名/谚文）取二元组。
 * 一元单字太碎、两个字母的英文词（of/to/go）没有区分度，都不算——
 * 这是矛盾对「共享 ≥3 个内容关键词」与「对方关键词命中」的计量口径。
 */
function salientTokensOf(text) {
  return new Set(
    uniqueTokens(text).filter((t) => (/^[a-z0-9_]+$/.test(t) ? t.length >= 3 : t.length >= 2)),
  );
}

/** 把标题与正文切成句（句号级；逗号不切，保留「不要 X，改用 Y」的完整否定语境）。 */
function sentencesOf(record) {
  return [
    String(record.title || '').trim(),
    ...String(record.content || '').split(/[。！？!?；;\n]+/).map((s) => s.trim()),
  ].filter(Boolean);
}

/**
 * 疑似矛盾对（只报告）：
 * 1) 候选对 = 共享 ≥3 个显著 token（倒排共现计数，DF>50 的高频词不计入）或共享标签
 *    （标签同样只认 DF≤50 的——几百条共挂一个大标签的两两组合没有区分度，只有噪声）；
 * 2) 候选内若一方某句命中否定线索、且该句显著词与对方显著词有交集 → 报一对。
 * 纯词法，上限 limit 对防刷屏；池超过 2000 条（倒排两两计数开始变贵）直接放弃。
 * hint 评估是逐对的纯 CPU 开销（每对两轮正则 + 分词），共享 token 最多的对最可疑，
 * 按共享数降序评估并给评估对数封顶——最坏库（近千条模板复制的记忆）也不会卡秒级。
 */
const CONTRADICTION_PAIR_BUDGET = 4000;

function detectContradictions(pool, limit = 10) {
  if (pool.length < 2 || pool.length > 2000) return [];
  const salient = pool.map((r) => salientTokensOf(`${r.title} ${r.content}`));

  const pairKey = (i, j) => (i < j ? `${i}|${j}` : `${j}|${i}`);
  const sharedCount = new Map();
  const postings = new Map();
  salient.forEach((set, idx) => {
    for (const t of set) {
      if (!postings.has(t)) postings.set(t, []);
      postings.get(t).push(idx);
    }
  });
  for (const list of postings.values()) {
    // 高频 token（>50 条都有）没有区分度，只贡献噪声，跳过。
    if (list.length < 2 || list.length > 50) continue;
    for (let x = 0; x < list.length; x += 1) {
      for (let y = x + 1; y < list.length; y += 1) {
        const key = pairKey(list[x], list[y]);
        sharedCount.set(key, (sharedCount.get(key) || 0) + 1);
      }
    }
  }
  // 候选带优先级：共享 token 数（≥3 才入围），标签对没有共享计数记 0。
  const candidates = new Map();
  for (const [key, count] of sharedCount) {
    if (count >= 3) candidates.set(key, count);
  }
  const byTag = new Map();
  pool.forEach((r, idx) => {
    for (const tag of asArray(r.tags, 32)) {
      const t = String(tag || '').trim().toLowerCase();
      if (!t) continue;
      if (!byTag.has(t)) byTag.set(t, []);
      byTag.get(t).push(idx);
    }
  });
  for (const list of byTag.values()) {
    // 大标签（>50 条共用）与高频 token 同理：两两组合全是噪声，跳过。
    if (list.length < 2 || list.length > 50) continue;
    for (let x = 0; x < list.length; x += 1) {
      for (let y = x + 1; y < list.length; y += 1) {
        const key = pairKey(list[x], list[y]);
        if (!candidates.has(key)) candidates.set(key, 0);
      }
    }
  }

  const ordered = [...candidates.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const results = [];
  let evaluated = 0;
  for (const [key] of ordered) {
    if (results.length >= limit) break;
    // 评估预算：正常库候选几百对内照常全量；候选爆炸时按共享数降序评估，长尾放弃。
    if (evaluated >= CONTRADICTION_PAIR_BUDGET) break;
    evaluated += 1;
    const [i, j] = key.split('|').map(Number);
    const hintAtoB = contradictionHint(pool[i], salient[j]);
    const hintBtoA = contradictionHint(pool[j], salient[i]);
    if (!hintAtoB && !hintBtoA) continue;
    results.push(
      hintAtoB
        ? { a: pool[i].id, b: pool[j].id, hint: hintAtoB }
        : { a: pool[j].id, b: pool[i].id, hint: hintBtoA },
    );
  }
  return results;
}

/** 一方（negator）的否定句是否命中对方（otherSalient）的关键词；命中给 hint 文案。 */
function contradictionHint(negator, otherSalient) {
  for (const sentence of sentencesOf(negator)) {
    if (!CONTRADICTION_NEG_RE.test(sentence)) continue;
    const hits = [...salientTokensOf(sentence)]
      .filter((t) => otherSalient.has(t) && !CONTRADICTION_NEG_TOKENS.has(t))
      .slice(0, 3);
    if (!hits.length) continue;
    const word = CONTRADICTION_NEG_RE.exec(sentence)?.[0] || '';
    const clip = sentence.length > 48 ? `${sentence.slice(0, 48)}…` : sentence;
    return `「${word}」+ 对方关键词「${hits.join('、')}」：${clip}`;
  }
  return '';
}

/**
 * files 引用失效（只报告）：active 且 files 非空的条目逐路径 fs.existsSync。
 * - 绝对路径直接查；相对路径按工作区根解析；解析不了（相对路径 + 无工作区）跳过不裁决；
 * - 单条文件数上限 maxFiles、受检条目上限 maxEntries（health 可能被面板轮询，existsSync 次数要封顶）；
 * - 只列「全部被查路径都不存在」的条目，部分失效不报（最小噪声）；
 * - 扫描抛错静默跳过该路径，不造目录（D2 精神）。
 */
function detectDeadFiles(pool, workspaceRoot, { maxEntries = 400, maxFiles = 8 } = {}) {
  const dead = [];
  let checked = 0;
  for (const record of pool) {
    const files = asArray(record.files, 32).map((f) => String(f || '').trim()).filter(Boolean).slice(0, maxFiles);
    if (!files.length) continue;
    checked += 1;
    if (checked > maxEntries) break;
    const missing = [];
    for (const file of files) {
      let resolved = '';
      if (path.isAbsolute(file)) resolved = file;
      else if (workspaceRoot) resolved = path.resolve(workspaceRoot, file);
      else continue; // 相对路径但没有工作区根可依：无法裁决
      let exists = false;
      try {
        exists = fs.existsSync(resolved);
      } catch {
        continue;
      }
      if (!exists) missing.push(file);
    }
    if (missing.length && missing.length === files.length) dead.push({ id: record.id, files: missing });
  }
  return dead;
}

/**
 * 工作区内那份人读镜像的路径：`<工作区>/.dsh-memory/MEMORY.md`。
 * 全局记忆（没有工作区）没有工作区镜像，返回 null。
 */
export function workspaceMirrorFile(workspace) {
  const root = normalizeRoot(workspace);
  if (!root) return null;
  return path.join(root, '.dsh-memory', 'MEMORY.md');
}

/* ------------------------------------------------------------------ *
 * 记录规整
 * ------------------------------------------------------------------ */

function asArray(value, limit = 64) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of arr) {
    const s = String(item == null ? '' : item).trim();
    if (s && !out.includes(s)) out.push(s.slice(0, 200));
    if (out.length >= limit) break;
  }
  return out;
}

function clampText(value, max) {
  const s = String(value == null ? '' : value).trim();
  return s.length > max ? `${value.slice(0, max - 1)}…` : s;
}

/** 正文里显式写的失效条件（没有就返回 null）。 */
function extractFalsifier(text) {
  const match = String(text ?? '').match(FALSIFIER_MARKER_RE);
  return match ? clampText(match[1], 240) || null : null;
}

/** 复审到期时间：接受 ISO / YYYY-MM-DD，存成规范 ISO；解析不了返回 null。 */
function normalizeReviewAt(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toISOString();
}

/* 路径召回（path JIT）用的路径归一：小写、反斜杠转正斜杠、去盘符、合并重复斜杠。 */
function normalizeFilePath(p) {
  let s = String(p == null ? '' : p).trim().toLowerCase().replace(/\\/g, '/');
  if (!s) return '';
  s = s.replace(/^[a-z]:/, '');
  s = s.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return s;
}

function basenameOf(p) {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

/** 读 JSONL（坏行跳过）；文件不存在返回空数组。 */
function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry && typeof entry === 'object');
  } catch {
    return [];
  }
}

/**
 * 解析一条记录应落的范围。`user`（用户画像）类别强制 global——画像跟着人走，
 * 不属于任何一个工作区；显式传 scope='global' 照常生效。
 */
export function scopeFor(input = {}, existing = null) {
  if (input.scope === 'global') return 'global';
  const category = CATEGORY_SET.has(input.category) ? input.category : existing?.category;
  if (category === 'user') return 'global';
  if (input.scope === 'workspace') return 'workspace';
  return existing?.scope === 'global' ? 'global' : 'workspace';
}

/** 证据字段：字符串视为「引用原文」，对象只收四个已知键；空值返回 null。 */
export function normalizeEvidence(value) {
  if (value == null) return null;
  const out = {};
  if (typeof value === 'string') {
    const quote = clampText(value, 400);
    if (quote) out.quote = quote;
  } else if (typeof value === 'object') {
    for (const key of ['sessionId', 'turn', 'quote', 'url']) {
      if (value[key] == null) continue;
      const text = clampText(value[key], 400);
      if (text) out[key] = text;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** 证据里的引用原文也要过一遍脱敏；命中的密钥类型记进 collected。 */
function secureEvidence(value, collected) {
  if (value == null) return null;
  const redactQuote = (quote) => {
    const { text, findings } = scanSecrets(quote);
    for (const f of findings) collected.add(f.kind);
    return text;
  };
  if (typeof value === 'string') return normalizeEvidence(redactQuote(value));
  if (typeof value === 'object' && !Array.isArray(value)) {
    const copy = { ...value };
    if (copy.quote != null) copy.quote = redactQuote(copy.quote);
    return normalizeEvidence(copy);
  }
  return normalizeEvidence(value);
}

const REDLINE_HISTORY_LIMIT = 20;

/** 红线旧版本：只留措辞与替换时间，供面板看历史 / 回滚；不是可检索的记忆。 */
function normalizeRedlineHistory(value) {
  const list = Array.isArray(value) ? value.slice(-REDLINE_HISTORY_LIMIT) : [];
  return list
    .map((entry) => ({
      title: clampText(entry?.title, 160),
      content: clampText(entry?.content, 8000),
      replacedAt: entry?.replacedAt ? String(entry.replacedAt) : '',
    }))
    .filter((entry) => entry.title || entry.content);
}

export function normalizeRecord(input = {}, existing = null, { redact = true } = {}) {
  const created = existing?.createdAt || input.createdAt || now();
  const category = CATEGORY_SET.has(input.category)
    ? input.category
    : existing?.category || 'note';
  const source = SOURCES.includes(input.source) ? input.source : existing?.source || 'manual';

  /* ---- 写入安全：先脱敏再截断；命中的密钥类型记进 redactions ---- */
  const secretKinds = new Set();
  const secure = (value) => {
    if (!redact) return String(value == null ? '' : value);
    const { text, findings } = scanSecrets(value);
    for (const f of findings) secretKinds.add(f.kind);
    return text;
  };

  const rawTitle = secure(input.title ?? existing?.title);
  const rawContent = secure(input.content ?? existing?.content ?? '');
  const rawReason = input.reason != null ? secure(input.reason) : null;

  const title = clampText(rawTitle, 160) || clampText(rawContent, 60) || '未命名记忆';
  const content = clampText(rawContent, 8000);

  const trust = computeTrust(input, existing);
  const evidence =
    input.evidence !== undefined
      ? secureEvidence(input.evidence, secretKinds)
      : existing?.evidence || null;
  const reason = rawReason != null ? clampText(rawReason, 240) : existing?.reason || null;

  /* 失效条件与复审排期：显式字段优先，其次是正文里的「失效条件：…」标记行。 */
  const rawFalsifier = input.falsifier != null ? secure(input.falsifier) : null;
  const falsifier =
    rawFalsifier != null
      ? clampText(rawFalsifier, 240) || null
      : existing?.falsifier || extractFalsifier(rawContent);
  const reviewAt =
    input.reviewAt != null ? normalizeReviewAt(input.reviewAt) : existing?.reviewAt || null;

  /* 注入检测：命中记 taint；隔离策略在 store 的创建路径执行（见 applySecurityGate）。 */
  const taint = assessTaint([title, content, reason, falsifier]).tainted;
  const status = (input.status ?? existing?.status) === 'draft' ? 'draft' : 'active';

  const quality = qualityFields({
    title,
    content: rawContent,
    category,
    tags: input.tags ?? existing?.tags,
    keywords: input.keywords ?? existing?.keywords,
    related: input.related ?? existing?.related,
    files: input.files ?? existing?.files,
    confidence:
      typeof input.confidence === 'number' ? input.confidence : existing?.confidence ?? (source === 'auto' ? 0.6 : 1),
    seenCount: (Number.isFinite(existing?.seenCount) ? existing.seenCount : 0) + 1,
    pinned: Boolean(input.pinned ?? existing?.pinned ?? false),
    // 只有调用方显式给了分（导入旧库/迁移）才沿用，其余一律按内容现算。
    quality: typeof input.quality === 'number' ? input.quality : undefined,
    qualityReasons: Array.isArray(input.qualityReasons) ? input.qualityReasons : undefined,
  });
  if (secretKinds.size && !quality.qualityReasons.includes('secrets_redacted')) {
    quality.qualityReasons = [...quality.qualityReasons, 'secrets_redacted'].slice(0, 8);
  }

  return {
    id: existing?.id || input.id || newId(),
    title,
    content,
    category,
    tags: asArray(input.tags ?? existing?.tags),
    scope: scopeFor(input, existing),
    source,
    trust,
    taint,
    // redactions 是「这条内容历史上被脱敏过什么」的审计记录：更新时正文已是
    // [REDACTED:*]，重扫不会命中，必须并入既有值，否则一编辑就被清空。
    redactions: [...new Set([...(existing?.redactions ?? []), ...secretKinds])],
    sessionId: input.sessionId ?? existing?.sessionId ?? null,
    files: asArray(input.files ?? existing?.files, 32),
    keywords: asArray(input.keywords ?? existing?.keywords, 12),
    related: asArray(input.related ?? existing?.related, 16),
    reason,
    evidence,
    falsifier,
    reviewAt,
    reviewedAt: input.reviewedAt ?? existing?.reviewedAt ?? null,
    supersedes: existing?.supersedes ?? (input.supersedes ? clampText(input.supersedes, 80) : null),
    supersededBy: existing?.supersededBy ?? (input.supersededBy ? clampText(input.supersededBy, 80) : null),
    promotedTo: input.promotedTo ?? existing?.promotedTo ?? null,
    promotedAt: input.promotedAt ?? existing?.promotedAt ?? null,
    redlineHistory: normalizeRedlineHistory(input.redlineHistory ?? existing?.redlineHistory),
    status,
    createdAt: created,
    updatedAt: now(),
    lastUsedAt: existing?.lastUsedAt ?? input.lastUsedAt ?? null,
    useCount: Number.isFinite(existing?.useCount) ? existing.useCount : 0,
    exposedCount: Number.isFinite(existing?.exposedCount) ? existing.exposedCount : 0,
    openedCount: Number.isFinite(existing?.openedCount) ? existing.openedCount : 0,
    citedCount: Number.isFinite(existing?.citedCount) ? existing.citedCount : 0,
    lastExposedAt: existing?.lastExposedAt ?? input.lastExposedAt ?? null,
    seenCount: (Number.isFinite(existing?.seenCount) ? existing.seenCount : 0) + 1,
    pinned: Boolean(input.pinned ?? existing?.pinned ?? false),
    archived: Boolean(input.archived ?? existing?.archived ?? false),
    archiveReason: input.archiveReason ?? existing?.archiveReason ?? null,
    ...quality,
    confidence:
      typeof input.confidence === 'number' && input.confidence >= 0 && input.confidence <= 1
        ? input.confidence
        : existing?.confidence ?? (source === 'auto' ? 0.6 : 1),
  };
}

/**
 * 质量分字段：显式传入的 quality 优先（导入旧库时保留原分），
 * 否则按 lib/quality.js 现算——纯函数，因此同一条记录每次算出来一样。
 */
function qualityFields(record) {
  if (typeof record.quality === 'number' && record.quality >= 0 && record.quality <= 100) {
    return { quality: Math.round(record.quality), qualityReasons: Array.isArray(record.qualityReasons) ? record.qualityReasons.slice(0, 8) : [] };
  }
  const scored = scoreQuality(record);
  return { quality: scored.score, qualityReasons: scored.reasons };
}

/* ------------------------------------------------------------------ *
 * 相关度打分
 *
 * 文本相关性走 lib/retrieval.js 的 BM25F（字段权重 + IDF + 长度归一），
 * 再叠加 exactPhraseBoost（短语/路径）与 relatedBoostMap（一跳扩展）。
 * 这里保留「置顶 / 类别 / 使用次数 / 衰减 / 质量」的排序政策：
 * 换检索算法时，排序政策不动，简报的稳定路径也不受影响。
 * ------------------------------------------------------------------ */

/** 用于「会话开始注入」的排序：置顶 > 类别权重 > 相关度 > 新鲜度 > 使用次数。 */
/** 时效衰减的默认参数：半衰期 30 天、地板 0.5；约定/偏好一类的地板更高（0.75），不让长期约定沉底。 */
export const DECAY = { halfLifeDays: 30, floor: 0.5, protectedFloor: 0.75 };

const PROTECTED_CATEGORIES = new Set(['preference', 'feedback', 'convention', 'user']);

/** 0.5^(天/半衰期)，带地板；时间取「最后一次被用」，没有就退到「最后被改」。 */
/**
 * 时间衰减系数：越久没被用过，权重越低，但不低于地板。
 *
 * `now` 可注入（默认 `Date.now()`）。测试必须注入固定时刻——否则「刚用过 →
 * 系数恰好为 1」这条断言会随调用间隔的毫秒数漂移（CI 上已实测 0.9999999997）。
 */
export function decayFactor(stamp, { halfLifeDays = DECAY.halfLifeDays, floor = DECAY.floor, now = Date.now() } = {}) {
  const ts = Date.parse(stamp || '') || 0;
  if (!ts) return floor;
  const days = Math.max(0, (now - ts) / 86400000);
  const value = Math.pow(0.5, days / Math.max(1, halfLifeDays));
  return Math.max(floor, Math.min(1, value));
}

/**
 * 自适应命中阈值。固定阈值（>0）在很短的查询上太严——一两个 token 时
 * 所有记录的打分都低；长查询又太松。改成「看 Top1 的相对比例」：
 * 短查询要求达到 Top1 的一半，长查询放宽到四分之一，同时保留绝对下限 1。
 */
export function adaptiveRelevanceFloor(tokens, ranked) {
  const n = Array.isArray(tokens) ? tokens.length : 0;
  const top = ranked[0]?.relevance ?? 0;
  if (!(top > 0)) return Number.POSITIVE_INFINITY;
  const ratio = n <= 2 ? 0.5 : n <= 8 ? 0.35 : 0.25;
  return Math.max(1, top * ratio);
}

/**
 * 排序。两种模式：
 * - `stable: true`（简报专用）：只按 置顶 → 类别权重 → createdAt → id 排，
 *   不读 useCount、不读当前时间——同一份记录任何时候都排出同一个顺序，
 *   系统提示因此字节稳定，前缀缓存不会被顺序漂移打穿。
 * - 默认（检索/召回）：相关度 × 使用次数 × 时效衰减 × 质量系数。
 */
export function rankRecords(
  records,
  { query = '', limit = 20, stable = false, halfLifeDays = DECAY.halfLifeDays } = {},
) {
  const catWeight = {
    constraint: 2,
    preference: 1.5,
    feedback: 1.45,
    convention: 1.4,
    decision: 1.3,
    user: 1.2,
    fact: 1.15,
    component: 1.1,
    task: 1.05,
    note: 1,
  };
  const eligible = records.filter((r) => !r.archived && r.status !== 'draft');

  if (stable) {
    return eligible
      .map((r) => ({
        record: r,
        relevance: 0,
        score: (r.pinned ? 1000 : 0) + (catWeight[r.category] ?? 1) * 10,
      }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          String(a.record.createdAt).localeCompare(String(b.record.createdAt)) ||
          String(a.record.id).localeCompare(String(b.record.id)),
      )
      .slice(0, Math.max(0, limit));
  }

  const queryTokens = expandQueryTokens(uniqueTokens(query));
  const index = queryTokens.length ? createBm25fIndex(eligible) : null;
  const rawScores = new Map(
    eligible.map((r) => [r.id, index ? scoreBm25f(r, queryTokens, index) : 0]),
  );
  const maxRaw = Math.max(0, ...rawScores.values());
  const relatedRaw = maxRaw > 0 ? relatedBoostMap(eligible, rawScores) : new Map();
  const maxRelated = Math.max(0, ...relatedRaw.values());

  return eligible
    .map((r) => {
      const lexical = maxRaw > 0 ? (rawScores.get(r.id) || 0) / maxRaw : 0;
      const phrase = queryTokens.length ? exactPhraseBoost(r, query) : 0;
      const related = maxRelated > 0 ? (relatedRaw.get(r.id) || 0) / maxRelated : 0;
      const relevance = lexical * 10 + phrase * 2 + related * 6;
      const cat = catWeight[r.category] ?? 1;
      const confidence = typeof r.confidence === 'number' ? r.confidence : 0.8;
      const usage = 1 + Math.log1p(r.useCount || 0) * 0.15;
      const decay = isRedline(r)
        ? 1 // 红线永不衰减：禁令不因「很久没触发」而淡出
        : decayFactor(r.lastUsedAt || r.updatedAt || r.createdAt, {
            halfLifeDays,
            floor: PROTECTED_CATEGORIES.has(r.category) ? DECAY.protectedFloor : DECAY.floor,
          });
      const qf = qualityFactor(typeof r.quality === 'number' ? r.quality : 80);
      const base = relevance * 10 * cat * confidence + cat * 4 + confidence * 2;
      return {
        record: r,
        relevance,
        score: (r.pinned ? 1000 : 0) + base * usage * decay * qf,
        signals: { lexical, phrase, related },
      };
    })

    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit));
}

/* ------------------------------------------------------------------ *
 * Markdown 镜像 + 可携带快照
 * ------------------------------------------------------------------ */

/** 工作区快照文件名。刻意不叫 memories.json：它是副本，不是正本。 */
export const SNAPSHOT_FILE_NAME = 'memory-snapshot.json';

const CATEGORY_ORDER = ['constraint', 'user', 'feedback', 'preference', 'convention', 'decision', 'fact', 'component', 'task', 'note'];

/**
 * 快照保留的字段。刻意**不含**本机使用统计：
 *   useCount / lastUsedAt / exposedCount / lastExposedAt / openedCount / citedCount
 * 它们描述的是「这台机器用过几次」，跟着项目同步到另一台机器会把对方的排序污染掉。
 * MEMORY.md 是有损的（只有标题 + 一句话），合并需要 id / trust / taint / supersedes，
 * 所以必须另有一份结构化快照。
 */
const SNAPSHOT_FIELDS = [
  'id', 'title', 'content', 'category', 'tags', 'keywords', 'files', 'related',
  'scope', 'source', 'createdAt', 'updatedAt',
  'pinned', 'confidence', 'quality', 'qualityReasons',
  'status', 'trust', 'taint', 'redactions',
  'supersedes', 'supersededBy',
  'falsifier', 'reviewAt', 'reviewedAt',
  'reason', 'evidence', 'archiveReason',
];

/**
 * 生成可携带快照（纯函数，不落盘）。
 *
 * 三条硬约束：
 *   1. **只装本工作区**：`scope === 'global'` 的记录一律剔除。项目记忆只记这个工作区里
 *      发生的事，全局记忆留在本地，不能被顺手带进某个项目的仓库。
 *   2. 只含 active：draft 是待审的、archived 是不要的，跨机器搬过去没有意义。
 *   3. 按 id 稳定排序：内容不变时字节不变，git 里不会产生噪声 diff。
 *
 * @param records 该工作区的记录集（调用方负责传入，这里再做一次 scope 兜底过滤）
 * @param opts.root 工作区根路径
 */
export function portableSnapshot(records, { root = '', generatedAt = null } = {}) {
  const list = Array.isArray(records) ? records : [];
  const rows = list
    .filter((r) => r && r.id && !r.archived && r.status !== 'draft' && r.scope !== 'global')
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((record) => {
      const out = {};
      for (const key of SNAPSHOT_FIELDS) {
        if (record[key] === undefined) continue;
        out[key] = record[key];
      }
      return out;
    });
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'dsh-memory-snapshot',
    workspace: normalizeRoot(root),
    generatedAt: generatedAt || now(),
    count: rows.length,
    records: rows,
  };
}

/**
 * 写快照，内容没变就不落盘。
 *
 * 关键在于比对时**排除 generatedAt**：否则每次 markUsed 刷新时间戳都会让文件
 * 变一次，用户在 git 里看到的就是永远 dirty 的快照。排除它之后，generatedAt 的
 * 语义自然变成「内容最后一次变化的时刻」，比「最后一次写盘的时刻」更有用。
 *
 * @returns {boolean} 是否真的写了
 */
function writeSnapshotFile(target, payload) {
  const comparable = (obj) =>
    JSON.stringify({ v: obj?.schemaVersion, w: obj?.workspace, r: obj?.records });
  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    previous = null; // 没有旧文件，或旧文件坏了：照写
  }
  if (previous && comparable(previous) === comparable(payload)) return false;
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return true;
}

/** 从画像里取一段正文（只读，不做归一化，免得渲染层依赖画像层的默认值）。 */
function portraitSectionText(portrait, key) {
  const list = Array.isArray(portrait?.sections) ? portrait.sections : [];
  for (const section of list) {
    if (section && section.key === key) return String(section.text || '').trim();
  }
  return '';
}

/**
 * 渲染工作区镜像。读者有两类，写法必须同时伺候：
 *   1. 装了插件的人 / agent —— 它只是副本，权威在条目库；
 *   2. **没装插件的人 / agent** —— 它是唯一入口，得能独立讲清「这个项目是什么、
 *      做到哪了、哪些规矩不能碰」。
 *
 * 刻意**不截断、不分页、不按日期拆文件**：WorkBuddy 的 MEMORY.md 能只有 50 行，是因为
 * 细节散在按日期切分的日志里；这里只有这一份文件承载全部，压缩就等于丢信息。
 * 每次写入都整份重写，内容不变时字节也不变（顺序确定），所以 git 里只会在真变更时出现 diff。
 *
 * 文件头刻意不写「请勿手工编辑」：离线场景下那句话会劝退唯一能维护它的人。
 * 改成边界声明——说清权威在哪、改了会怎样。
 */
export function renderMarkdown(records, { root = '', updatedAt = now(), portrait = null } = {}) {
  const active = records.filter((r) => !r.archived && r.status !== 'draft');
  // 标题索引只用可见记录：related / supersedes 行不得把 draft 或归档条目的标题带进镜像（C6）。
  const titleOf = new Map(active.map((r) => [r.id, r.title]));
  const lines = [];
  lines.push(`# 项目记忆 — ${slugify(root) || 'global'}`);
  lines.push('');
  lines.push(
    '> 由 dsh-memory 维护。装插件时自动更新；**没装插件时可以直接改**，插件下次上线会以条目库为准合并，不会静默丢弃。',
  );
  lines.push('> 完整条目（含 id、置信度、版本链）在同目录 `memory-snapshot.json`。');
  lines.push(`> 工作区：\`${root || '(全局)'}\` ｜ 条数：${active.length} ｜ 更新：${updatedAt}`);
  lines.push('');

  /* 画像在前：离线时「这是什么项目、现在在做什么」比 50 条条目更有用。 */
  const background = portraitSectionText(portrait, 'background');
  const focus = portraitSectionText(portrait, 'focus');
  if (background) {
    lines.push('## 项目概况');
    lines.push('');
    lines.push(background);
    lines.push('');
  }
  if (focus) {
    lines.push('## 当前关注');
    lines.push('');
    lines.push(focus);
    lines.push('');
  }

  /* 红线单独成节、措辞逐字、附带理由：它是绝对禁令，不能被任何「摘要」软化。 */
  const redlines = active.filter((r) => isRedline(r));
  const redlineIds = new Set(redlines.map((r) => r.id));
  if (redlines.length) {
    lines.push('## 不能碰的规矩');
    lines.push('');
    for (const r of redlines) {
      lines.push(`- **${r.title}** — ${oneLine(r.content)}`);
      if (r.reason) lines.push(`  为什么：${oneLine(r.reason)}`);
    }
    lines.push('');
  }

  const pinned = active.filter((r) => r.pinned && !redlineIds.has(r.id));
  if (pinned.length) {
    lines.push('## 置顶');
    lines.push('');
    for (const r of pinned) lines.push(`- **${r.title}** — ${oneLine(r.content)}`);
    lines.push('');
  }

  const pinnedIds = new Set(pinned.map((r) => r.id));
  for (const category of CATEGORY_ORDER) {
    const group = active
      .filter((r) => r.category === category && !pinnedIds.has(r.id) && !redlineIds.has(r.id))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    if (!group.length) continue;
    lines.push(`## ${CATEGORY_LABELS[category]}（${category}）`);
    lines.push('');
    for (const r of group) {
      const meta = [];
      if (r.tags?.length) meta.push(r.tags.map((t) => `\`${t}\``).join(' '));
      if (r.updatedAt) meta.push(r.updatedAt.slice(0, 10));
      lines.push(`- **${r.title}**${meta.length ? ` — ${meta.join(' · ')}` : ''}`);
      const body = oneLine(r.content);
      if (body && body !== r.title) lines.push(`  ${body}`);
      // 理由：离线读者靠它判断这条约定现在还成不成立。
      if (r.reason) lines.push(`  为什么：${oneLine(r.reason)}`);
      // 版本链与关联：给人看的线索，帮助判断这条记忆的新旧与脉络。
      if (r.supersedes && titleOf.has(r.supersedes)) lines.push(`  ↩ 替代了「${titleOf.get(r.supersedes)}」`);
      const relatedTitles = (r.related || [])
        .map((id) => titleOf.get(id))
        .filter(Boolean)
        .slice(0, 4);
      if (relatedTitles.length) lines.push(`  ⇔ 关联：${relatedTitles.join('、')}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function oneLine(text) {
  return String(text || '')
    .replace(/\s*\n+\s*/g, ' ')
    .trim();
}

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

export function createMemoryStore({ dir = defaultRoot(), mirror = true, qualityGate = true, security = {}, review = {} } = {}) {
  const indexFile = path.join(dir, 'index.json');
  const cache = new Map(); // folder -> { file, records, stamp }
  // 注入日志的行数缓存：file -> 已知行数。首次追加前数一遍，之后纯追加只累加，
  // 累计超过上限才做一次读 + 裁剪 + 重写（平时不再全量读写整个 jsonl）。
  const injectionLogCounts = new Map();

  // 质量闸门可以是布尔值，也可以是 getter（设置面板改完立即生效，不重建 store）。
  const gateOn = () => Boolean(typeof qualityGate === 'function' ? qualityGate() : qualityGate);
  // 写入安全同样支持 getter：redact=密钥脱敏；quarantine=非 user 来源的 taint 自动进草稿。
  const securityFlag = (name, fallback = true) => {
    const value = security?.[name];
    if (typeof value === 'function') return Boolean(value());
    return value === undefined ? fallback : Boolean(value);
  };
  /** normalizeRecord 的安全选项：redact 关掉时保留原文（不推荐），taint 照常计算。 */
  const secOpts = () => ({ redact: securityFlag('redact') });
  /** 创建路径的隔离闸：taint 且非 user 来源 → 草稿（更新/批准路径不适用）。 */
  const applySecurityGate = (record, isNew) => {
    if (!isNew || !record?.taint || record.trust === 'user' || record.status === 'draft') return record;
    if (!securityFlag('quarantine')) return record;
    return { ...record, status: 'draft' };
  };
  // 复审排期：带失效条件的记忆默认多久后要复审一次（支持 getter，设置面板改完立即生效）。
  const reviewDays = () => {
    const value = typeof review?.days === 'function' ? review.days() : review?.days;
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.min(3650, Math.floor(n)) : 90;
  };
  /**
   * 有失效条件但没排期时，按默认 TTL 排一次。
   * baseAt 用于「读的时候补排」：那种情况从今天起算，免得升级瞬间涌出一堆历史欠账。
   */
  const applyReviewPolicy = (record, baseAt = null) => {
    if (!record?.falsifier || record.reviewAt) return record;
    const base = baseAt || Date.parse(record.updatedAt || record.createdAt || '') || Date.now();
    return { ...record, reviewAt: new Date(base + reviewDays() * 86400000).toISOString() };
  };
  const AUTO_SOURCES = new Set(['auto', 'agent']);

  const folderFor = (root) => folderName(root || '');
  const dataDirFor = (root) => path.join(dir, 'workspaces', folderFor(root));
  const dataFileFor = (root) => path.join(dataDirFor(root), 'memories.json');

  /* ---------------- 全局候选原则池 ---------------- */

  /**
   * 项目内蒸馏产出的「可能跨项目成立」的原则先落这里，等 Dream 巡检时按
   * `lib/distill-global.js` 的门槛判定晋升。放在 `_global` 目录下，跟着整库快照一起备份。
   *
   * 与主库的关键区别：**允许损坏降级**。候选池丢了只是丢一批待审原则，
   * 而主库损坏必须抛错（否则下一次写入会抹掉全部历史），所以这里读用宽松模式。
   */
  const candidatesFile = path.join(dir, 'workspaces', GLOBAL_KEY, 'candidates.json');

  /** 候选去重键：同一项目里同样的表述只留一条；不同项目各自保留（共振要按项目计数）。 */
  function candidateKey(project, text) {
    return `${String(project || '')}::${String(text || '').replace(/\s+/g, '').toLowerCase()}`;
  }

  function readCandidatePool() {
    const raw = readJson(candidatesFile, null);
    const list = Array.isArray(raw?.candidates) ? raw.candidates : [];
    return list.filter((item) => item && item.id && item.text);
  }

  /**
   * 已裁决候选的保留上限。pending 全留，历史只留最近的这些。
   *
   * 候选池每次轮末都会被读一遍，如果不裁剪，已晋升 / 已否的记录会无限堆积，
   * 文件一年后可能几千条——那时每轮的读取与解析都成了固定开销。
   * 历史只是审计线索，不是活跃数据，裁掉不影响判定（重复晋升由全局库那句去重兜着）。
   */
  const CANDIDATE_HISTORY_LIMIT = 200;

  function trimCandidatePool(list) {
    const pending = list.filter((item) => item.status === 'pending');
    if (pending.length === list.length) return list;
    const decided = list
      .filter((item) => item.status !== 'pending')
      .sort((a, b) =>
        String(b.decidedAt || b.at || '').localeCompare(String(a.decidedAt || a.at || '')),
      )
      .slice(0, CANDIDATE_HISTORY_LIMIT);
    return [...pending, ...decided];
  }

  function writeCandidatePool(list) {
    fs.mkdirSync(path.dirname(candidatesFile), { recursive: true });
    writeJsonAtomic(candidatesFile, {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: now(),
      candidates: trimCandidatePool(list),
    });
  }

  /* ---------------- 画像层：内部工具 ---------------- */

  function readTextFile(file) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  }

  function portraitInfoFor(root) {
    const r = normalizeRoot(root);
    const base = dataDirFor(r);
    return {
      root: r,
      scope: folderFor(r) === GLOBAL_KEY ? 'global' : 'workspace',
      folder: folderFor(r),
      file: path.join(base, 'portrait.json'),
      mdFile: path.join(base, 'PORTRAIT.md'),
      draftFile: path.join(base, 'portrait.draft.json'),
      historyDir: path.join(base, 'portrait.history'),
    };
  }

  /* ---------------- 日志层：内部工具 ---------------- */

  /** 日志目录：workspaces/<folder>/journal/YYYY-MM-DD.md（append-only）。 */
  function journalInfoFor(root) {
    const r = normalizeRoot(root);
    return { root: r, dir: path.join(dataDirFor(r), 'journal') };
  }

  function sessionLogInfoFor(root) {
    const r = normalizeRoot(root);
    return { root: r, dir: dataDirFor(r), file: path.join(dataDirFor(r), 'sessions.jsonl') };
  }

  /** 注入审计日志：这次真正进 prompt 的字节、带了哪些 id、谁被预算挤掉。 */
  function injectionLogInfoFor(root) {
    const r = normalizeRoot(root);
    return { root: r, dir: dataDirFor(r), file: path.join(dataDirFor(r), 'injections.jsonl') };
  }

  /** 跨层派生链：每条派生记下它是从哪些源抄来的。 */
  function derivationInfoFor(root) {
    const r = normalizeRoot(root);
    return { root: r, file: path.join(dataDirFor(r), 'derivations.json') };
  }

  function readDerivations(root) {
    const info = derivationInfoFor(root);
    const raw = readJson(info.file, null);
    const entries = Array.isArray(raw?.entries) ? raw.entries : [];
    return entries
      .filter((entry) => entry && typeof entry === 'object' && entry.id)
      .map((entry) => ({
        id: String(entry.id),
        layer: String(entry.layer || 'portrait'),
        target: String(entry.target || ''),
        parent: entry.parent || null,
        sources: (Array.isArray(entry.sources) ? entry.sources : []).map(normalizeSource).filter(Boolean),
        createdAt: entry.createdAt || now(),
        updatedAt: entry.updatedAt || entry.createdAt || now(),
      }));
  }

  function writeDerivations(root, entries) {
    const info = derivationInfoFor(root);
    try {
      fs.mkdirSync(path.dirname(info.file), { recursive: true });
      writeJsonAtomic(info.file, { schemaVersion: 1, updatedAt: now(), entries });
    } catch {
      /* 派生链写不进去不阻断主流程：它是审计层，不是数据层 */
    }
  }

  /** 记一条派生：同一条路径反复写入只更新同一条记录。 */
  function derivationUpsertFor(root, { layer = 'portrait', target = '', sources = [], parent = null } = {}) {
    const entries = readDerivations(root);
    const id = derivationId(layer, target);
    const idx = entries.findIndex((entry) => entry.id === id);
    const entry = {
      id,
      layer,
      target,
      parent: parent || null,
      sources: sources.map(normalizeSource).filter(Boolean),
      createdAt: idx >= 0 ? entries[idx].createdAt : now(),
      updatedAt: now(),
    };
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
    writeDerivations(root, entries);
    return entry;
  }

  /* ---------------- 维护台账：启动整理 ---------------- */

  /** 维护台账文件（每个工作区一份）：上次自动 / 手动整理的时间与摘要。 */
  function maintenanceInfoFor(root) {
    const r = normalizeRoot(root);
    return { root: r, file: path.join(dataDirFor(r), 'maintenance.json') };
  }

  /** 读维护台账；损坏 / 缺失一律返回空台账（不抛，面板照常渲染）。 */
  function readMaintenance(root) {
    const raw = readJson(maintenanceInfoFor(root).file, null);
    const runs = (Array.isArray(raw?.runs) ? raw.runs : [])
      .filter((run) => run && typeof run === 'object' && run.at)
      .slice(0, 10)
      .map((run) => ({
        at: String(run.at),
        source: run.source === 'manual' ? 'manual' : 'auto',
        report: run.report && typeof run.report === 'object' ? run.report : null,
      }));
    return {
      lastAutoAt: typeof raw?.lastAutoAt === 'string' ? raw.lastAutoAt : null,
      lastManualAt: typeof raw?.lastManualAt === 'string' ? raw.lastManualAt : null,
      lastReport: raw?.lastReport && typeof raw.lastReport === 'object' ? raw.lastReport : null,
      runs,
    };
  }

  /**
   * full 导入：派生链合并式写回——同 id 取 updatedAt 新者（同刻算新），本地独有的条目保留。
   * 选择合并而非整体覆盖：目标库可能已有自己的派生链，覆盖会把别人的链抹掉。
   */
  function importDerivationsFor(root, raw) {
    const incoming = Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : [];
    if (!incoming.length) return 0;
    const current = readDerivations(root);
    const byId = new Map(current.map((entry) => [entry.id, entry]));
    let merged = 0;
    for (const item of incoming) {
      if (!item || typeof item !== 'object' || !item.id) continue;
      const entry = {
        id: String(item.id),
        layer: String(item.layer || 'portrait'),
        target: String(item.target || ''),
        parent: item.parent || null,
        sources: (Array.isArray(item.sources) ? item.sources : []).map(normalizeSource).filter(Boolean),
        createdAt: item.createdAt || now(),
        updatedAt: item.updatedAt || item.createdAt || now(),
      };
      const prev = byId.get(entry.id);
      if (!prev || String(entry.updatedAt) >= String(prev.updatedAt)) {
        byId.set(entry.id, entry);
        merged += 1;
      }
    }
    if (merged) writeDerivations(root, [...byId.values()]);
    return merged;
  }

  /** 派生链 + 实时对账：谁派生了什么、现在还成不成立。 */
  function derivationListFor(root) {
    let entries = readDerivations(root);
    const portrait = readPortraitFor(root);
    /*
     * 这功能之前保存的画像没有派生条目：补一条，源快照按当前画像算。
     * 不补的话，它派生出来的 AGENTS.md 会因为「上游派生层不存在」被误判为失效。
     */
    if (portrait && !entries.some((entry) => entry.layer === 'portrait' && entry.target === 'portrait')) {
      derivationUpsertFor(root, {
        layer: 'portrait',
        target: 'portrait',
        sources: portraitSourcesFor(root, portrait),
      });
      entries = readDerivations(root);
    }
    const records = new Map(
      gather({ workspace: root, includeArchived: true, includeDrafts: true }).map((r) => [r.id, r]),
    );
    return evaluateEntries(entries, { records, portrait });
  }

  /** 画像引用的记忆条目作为派生源（journal: 引用不是条目，不入链）。 */
  function portraitSourcesFor(root, portrait, evidence) {
    const refs = evidence || portrait?.evidence || {};
    const sources = [];
    const seen = new Set();
    for (const [sectionKey, list] of Object.entries(refs)) {
      for (const ref of list || []) {
        if (!ref.startsWith('mem_')) continue;
        const key = `${ref}|${sectionKey}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const record = findRecordAnywhere(root, ref);
        sources.push(
          record
            ? memorySource(record, { section: sectionKey })
            : { id: ref, kind: 'memory', section: sectionKey, hash: '', title: '' },
        );
      }
    }
    return sources;
  }

  /** 在本工作区与全局库里找一条记录。 */
  function findRecordAnywhere(root, id) {
    const own = load(root).records.find((r) => r.id === id);
    if (own) return own;
    return load('').records.find((r) => r.id === id) || null;
  }

  /** AGENTS.md 托管块：幂等追加，块外的内容永不触碰。 */
  function appendAgentsBlock(file, lines) {
    const START = '<!-- dsh-memory:promoted 开始（由 dsh-memory 维护，请勿手工编辑本块） -->';
    const END = '<!-- dsh-memory:promoted 结束 -->';
    const existing = readTextFile(file);
    let content;
    if (existing.includes(START) && existing.includes(END)) {
      const bodyStart = existing.indexOf(START) + START.length;
      const end = existing.indexOf(END);
      const current = existing
        .slice(existing.indexOf('\n', bodyStart) + 1, end)
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      for (const line of lines) if (!current.includes(line)) current.push(line);
      content = `${existing.slice(0, bodyStart)}\n${current.join('\n')}\n${existing.slice(end)}`;
    } else {
      const head = existing.trim() ? `${existing.replace(/\s+$/u, '')}\n\n` : '# AGENTS.md\n\n';
      content = `${head}${START}\n${lines.join('\n')}\n${END}\n`;
    }
    fs.writeFileSync(file, content, 'utf8');
    return content;
  }

  function localDateString(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function journalDatesFor(info) {
    try {
      return fs
        .readdirSync(info.dir)
        .map((name) => (name.match(/^(\d{4}-\d{2}-\d{2})\.md$/) || [])[1])
        .filter(Boolean)
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  /** full 导出：最近 N 天的日志原文（{date, text}，按日期升序；单日截 256KB 防载荷失控）。 */
  function journalExportFor(root, days = 30) {
    const info = journalInfoFor(root);
    const cutoff = localDateString(new Date(Date.now() - Math.max(1, days) * 86400000));
    return journalDatesFor(info)
      .filter((date) => date >= cutoff)
      .sort()
      .map((date) => ({ date, text: clampText(readTextFile(path.join(info.dir, `${date}.md`)), 262144) }))
      .filter((day) => day.text.trim());
  }

  /**
   * full 导入：日志按天合并回灌——目标日文件不存在则原样落盘；已存在则做行级去重追加，
   * 只补目标里没有的行，绝不改写既有内容（append-only 语义，重复导入不产生重复行）。
   */
  function importJournalFor(root, days) {
    if (!Array.isArray(days)) return 0;
    const info = journalInfoFor(root);
    let touched = 0;
    for (const day of days.slice(0, 62)) {
      if (!day || typeof day !== 'object') continue;
      // 日期形状不对直接丢：journal 文件名要拼进路径，不能放任意串进来。
      const date = /^\d{4}-\d{2}-\d{2}$/u.test(String(day.date)) ? String(day.date) : '';
      if (!date) continue;
      const text = typeof day.text === 'string' ? day.text.replace(/\r\n/g, '\n').trim().slice(0, 262144) : '';
      if (!text) continue;
      const file = path.join(info.dir, `${date}.md`);
      const prev = readTextFile(file);
      if (!prev.trim()) {
        const body = /^# /u.test(text) ? text : `# ${date}\n\n${text}`;
        fs.mkdirSync(info.dir, { recursive: true });
        fs.writeFileSync(file, `${body.replace(/\s+$/u, '')}\n`, 'utf8');
        touched += 1;
        continue;
      }
      const seen = new Set(
        prev
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      );
      const fresh = [];
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('# ')) continue;
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        fresh.push(line.replace(/\s+$/u, ''));
      }
      if (!fresh.length) continue;
      fs.writeFileSync(file, `${prev.replace(/\s+$/u, '')}\n${fresh.join('\n')}\n`, 'utf8');
      touched += 1;
    }
    return touched;
  }

  /** 读画像：portrait.json 优先；缺失时回落解析 PORTRAIT.md（不落盘，persistent=false）。 */
  function readPortraitFor(root) {
    const info = portraitInfoFor(root);
    const raw = readJson(info.file, null);
    if (raw && typeof raw === 'object' && Array.isArray(raw.sections)) {
      const evidence = normalizePortraitEvidence(raw.evidence, { scope: info.scope });
      return {
        scope: info.scope,
        version: Number(raw.version) || 1,
        updatedAt: raw.updatedAt || null,
        source: SOURCES.includes(raw.source) ? raw.source : 'manual',
        sections: normalizeSections(raw.sections, { scope: info.scope }),
        evidence,
        sectionMeta: portraitSectionMeta(evidence, { scope: info.scope }),
        persistent: true,
      };
    }
    const md = readTextFile(info.mdFile);
    if (md) {
      const parsed = parsePortraitMarkdown(md);
      if (parsed && parsed.sections.some((s) => s.text)) {
        const evidence = normalizePortraitEvidence(parsed.evidence, { scope: parsed.scope });
        return {
          scope: parsed.scope,
          version: 0,
          updatedAt: null,
          source: 'import',
          sections: parsed.sections,
          evidence,
          sectionMeta: portraitSectionMeta(evidence, { scope: parsed.scope }),
          persistent: false,
        };
      }
    }
    return null;
  }

  function prunePortraitHistory(historyDir) {
    try {
      const files = fs
        .readdirSync(historyDir)
        .map((name) => ({ name, version: Number((name.match(/^v(\d+)\.json$/) || [])[1]) }))
        .filter((item) => Number.isFinite(item.version))
        .sort((a, b) => b.version - a.version);
      for (const item of files.slice(PORTRAIT_HISTORY_LIMIT)) {
        try {
          fs.rmSync(path.join(historyDir, item.name));
        } catch {
          /* 单个快照删不掉不影响主体 */
        }
      }
    } catch {
      /* 无历史目录/权限问题时忽略 */
    }
  }

  /** full 导出：当前画像的存储形状（persistent 是读盘时的瞬时标记，不进载荷）；没有画像返回 null。 */
  function portraitExportFor(root) {
    const portrait = readPortraitFor(root);
    if (!portrait) return null;
    const { persistent, ...stored } = portrait;
    return stored;
  }

  /**
   * full 导入：画像回灌——有正文的段才算非空画像，全空/缺段不写（空不覆盖既有）。
   * 写回走 savePortraitFor 同一条路径：版本 +1、旧版留档、PORTRAIT.md 正本同步、
   * 派生链随手更新，与手动保存的行为完全一致。
   */
  function importPortraitFor(root, portrait) {
    if (!portrait || typeof portrait !== 'object' || !Array.isArray(portrait.sections)) return false;
    const hasBody = portrait.sections.some(
      (section) => section && typeof section.text === 'string' && section.text.trim(),
    );
    if (!hasBody) return false;
    savePortraitFor(root, {
      sections: portrait.sections,
      evidence: portrait.evidence,
      source: SOURCES.includes(portrait.source) ? portrait.source : 'import',
    });
    return true;
  }

  /**
   * 保存画像（手动编辑 / 重写管线 / full 导入共用）。
   * 版本 +1；旧版落 portrait.history/v<N>.json（保留最近 PORTRAIT_HISTORY_LIMIT 版）；
   * 同步刷新 PORTRAIT.md 正本。
   */
  function savePortraitFor(root, { sections = [], evidence, source = 'manual' } = {}) {
    const info = portraitInfoFor(root);
    const scope = info.scope;
    const prev = readJson(info.file, null);
    const prevVersion = Number(prev?.version) || 0;
    if (prev && prevVersion > 0) {
      try {
        fs.mkdirSync(info.historyDir, { recursive: true });
        writeJsonAtomic(path.join(info.historyDir, `v${prevVersion}.json`), prev);
        prunePortraitHistory(info.historyDir);
      } catch {
        /* 快照留不住不阻断保存 */
      }
    }
    const nextSections = normalizeSections(sections, { scope });
    /*
     * 证据的继承规则：给了 evidence（自动重写 / full 导入）就以它为准，没给的段一律未溯源；
     * 手工保存没给 evidence 时，正文没变的段沿用旧证据，改过的段清空。
     */
    const prevSections = new Map(
      normalizeSections(prev?.sections ?? [], { scope }).map((s) => [s.key, s.text]),
    );
    const prevEvidence = normalizePortraitEvidence(prev?.evidence, { scope });
    const provided = evidence !== undefined && evidence !== null;
    const incoming = normalizePortraitEvidence(evidence, { scope });
    const nextEvidence = {};
    for (const section of nextSections) {
      const prevText = prevSections.get(section.key) || '';
      const refs = provided
        ? incoming[section.key] || []
        : section.text && section.text === prevText
          ? prevEvidence[section.key] || []
          : [];
      if (refs.length) nextEvidence[section.key] = refs;
    }
    const next = {
      schemaVersion: 1,
      scope,
      version: prevVersion + 1,
      updatedAt: now(),
      source: SOURCES.includes(source) ? source : 'manual',
      sections: nextSections,
      evidence: nextEvidence,
      sectionMeta: portraitSectionMeta(nextEvidence, { scope }),
    };
    writeJsonAtomic(info.file, next);
    let mdWritten = true;
    try {
      fs.writeFileSync(
        info.mdFile,
        renderPortraitMarkdown(next, { scopeLabel: slugify(info.root) }),
        'utf8',
      );
    } catch {
      mdWritten = false;
    }
    /*
     * 派生链：画像这一层记下它引用了哪些记忆条目（journal: 引用不是条目，不入链）。
     * 之后这些条目被归档/被改写/被删除，画像这层在派生链里就会被标脏。
     */
    derivationUpsertFor(info.root, {
      layer: 'portrait',
      target: 'portrait',
      sources: portraitSourcesFor(info.root, next, nextEvidence),
    });
    return { ok: true, portrait: { ...next, persistent: true }, mdWritten };
  }

  function load(root) {
    const folder = folderFor(root);
    const file = dataFileFor(root);
    migratePathKeyedData(root, folder, file);
    const stamp = fileStamp(file);
    const hit = cache.get(folder);
    if (hit && hit.stamp === stamp) return hit;

    // 主库损坏必须向上抛（readJson 已备份原文件）：把损坏当空库的话，
    // 下一次 mutate 会把全部历史静默抹掉。
    const raw = readJson(file, null, { strict: true });
    const records = Array.isArray(raw?.records) ? raw.records.map((r) => normalizeLoaded(r)) : [];
    const entry = { folder, file, records, stamp };
    cache.set(folder, entry);
    return entry;
  }

  /**
   * 键从「路径哈希」换成「git 身份」之后，老数据还在旧目录里。
   * 首次访问新目录时把 old memories.json / portrait.json 复制过来；
   * 旧目录原样保留（回退旧版本或用旧键读都不会丢数据）。
   */
  function migratePathKeyedData(root, folder, file) {
    if (folder === GLOBAL_KEY || fs.existsSync(file)) return;
    const legacyKey = pathWorkspaceKey(root).slice(0, 8);
    if (!legacyKey) return;
    const legacyFolder = `${slugify(root)}-${legacyKey}`;
    if (legacyFolder === folder) return;
    const legacyDir = path.join(dir, 'workspaces', legacyFolder);
    if (!fs.existsSync(path.join(legacyDir, 'memories.json'))) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(path.join(legacyDir, 'memories.json'), file);
      const portrait = path.join(legacyDir, 'portrait.json');
      if (fs.existsSync(portrait)) fs.copyFileSync(portrait, path.join(path.dirname(file), 'portrait.json'));
    } catch {
      /* 迁移失败就维持空库，旧数据仍在旧目录里 */
    }
  }

  function normalizeLoaded(record) {
    const base = {
      id: record.id || newId(),
      title: clampText(record.title, 160) || '未命名记忆',
      content: clampText(record.content, 8000),
      category: CATEGORY_SET.has(record.category) ? record.category : 'note',
      tags: asArray(record.tags),
      scope: record.scope === 'global' ? 'global' : 'workspace',
      source: SOURCES.includes(record.source) ? record.source : 'manual',
      /* 写入安全元数据读盘不能丢：trust/taint/redactions 丢了，重启后面板的
       * 安全徽标全部消失、taint 隔离状态无从审计（P1-2）。 */
      trust: TRUST_LEVELS.includes(record.trust) ? record.trust : 'agent',
      taint: Boolean(record.taint),
      redactions: asArray(record.redactions, 16),
      sessionId: record.sessionId ?? null,
      files: asArray(record.files, 32),
      keywords: asArray(record.keywords, 12),
      related: asArray(record.related, 16),
      reason: record.reason ? clampText(record.reason, 240) : null,
      falsifier: record.falsifier ? clampText(record.falsifier, 240) : null,
      reviewAt: normalizeReviewAt(record.reviewAt),
      reviewedAt: record.reviewedAt || null,
      evidence: normalizeEvidence(record.evidence),
      supersedes: record.supersedes || null,
      supersededBy: record.supersededBy || null,
      promotedTo: record.promotedTo ?? null,
      promotedAt: record.promotedAt ?? null,
      redlineHistory: normalizeRedlineHistory(record.redlineHistory),
      status: record.status === 'draft' ? 'draft' : 'active',
      createdAt: record.createdAt || now(),
      updatedAt: record.updatedAt || record.createdAt || now(),
      lastUsedAt: record.lastUsedAt ?? null,
      useCount: Number.isFinite(record.useCount) ? record.useCount : 0,
      exposedCount: Number.isFinite(record.exposedCount) ? record.exposedCount : 0,
      openedCount: Number.isFinite(record.openedCount) ? record.openedCount : 0,
      citedCount: Number.isFinite(record.citedCount) ? record.citedCount : 0,
      lastExposedAt: record.lastExposedAt ?? null,
      seenCount: Number.isFinite(record.seenCount) ? record.seenCount : 1,
      pinned: Boolean(record.pinned),
      archived: Boolean(record.archived),
      archiveReason: record.archiveReason || null,
      confidence: typeof record.confidence === 'number' ? record.confidence : 0.8,
    };
    if (typeof record.quality === 'number' && record.quality >= 0 && record.quality <= 100) {
      base.quality = Math.round(record.quality);
      base.qualityReasons = Array.isArray(record.qualityReasons) ? record.qualityReasons.slice(0, 8) : [];
    } else {
      // 旧库没有这一列：读的时候补算一次（纯函数，算完写回时随记录落盘）。
      const scored = scoreQuality(base);
      base.quality = scored.score;
      base.qualityReasons = scored.reasons;
    }
    /* 旧库里有失效条件但没排期的，读的时候补排一次（从今天起算，不翻旧账）。 */
    return applyReviewPolicy(base, Date.now());
  }

  /**
   * 读改写：写入前若发现文件被别的进程改过（mtime/size 变了），
   * 先重新读取并按 id 合并，避免多开 DSH 会话时互相覆盖。
   */
  function mutate(root, fn) {
    const entry = load(root);
    const latest = fileStamp(entry.file);
    if (latest !== entry.stamp && latest !== 'missing') {
      const disk = readJson(entry.file, null, { strict: true });
      if (Array.isArray(disk?.records)) {
        const merged = new Map(entry.records.map((r) => [r.id, r]));
        for (const rec of disk.records) {
          const norm = normalizeLoaded(rec);
          const prev = merged.get(norm.id);
          if (!prev || String(prev.updatedAt) <= String(norm.updatedAt)) merged.set(norm.id, norm);
        }
        entry.records = [...merged.values()];
      }
    }

    const result = fn(entry.records);
    const next = result && Array.isArray(result.records) ? result.records : entry.records;

    writeJsonAtomic(entry.file, {
      schemaVersion: SCHEMA_VERSION,
      key: workspaceKey(root),
      root: normalizeRoot(root),
      updatedAt: now(),
      records: next,
    });
    entry.records = next;
    entry.stamp = fileStamp(entry.file);
    writeIndex(root, next);
    // mirror 可以是布尔值，也可以是 getter，便于设置面板实时开关而不重建 store。
    // 主库旁车始终写（它是数据自己的一份人读副本）；只有工作区镜像受开关控制。
    writeMirror(root, next, { workspace: Boolean(typeof mirror === 'function' ? mirror() : mirror) });
    // 后悔药：每天第一次写入之后做一次整库快照。失败静默，绝不让快照拖住写入。
    dailySnapshot();
    return result;
  }

  function writeIndex(root, records) {
    const index = readJson(indexFile, { schemaVersion: SCHEMA_VERSION, workspaces: {} });
    index.schemaVersion = SCHEMA_VERSION;
    index.workspaces = index.workspaces || {};
    const key = workspaceKey(root);
    // 迁移兼容：同一个 root 只保留当前键的那一条，旧的路径键条目顺手删掉。
    const normRoot = normalizeRoot(root);
    for (const [oldKey, entry] of Object.entries(index.workspaces)) {
      if (oldKey !== key && entry && normalizeRoot(entry.root) === normRoot) delete index.workspaces[oldKey];
    }
    index.workspaces[key] = {
      key,
      root: normalizeRoot(root),
      slug: slugify(root),
      folder: folderFor(root),
      count: records.filter((r) => !r.archived && r.status !== 'draft').length,
      total: records.length,
      updatedAt: now(),
    };
    writeJsonAtomic(indexFile, index);
  }

  /* ---------------- 整库快照（后悔药） ---------------- */

  /**
   * 已经做过日快照的那一天（YYYY-MM-DD，进程内记账）。
   * 只在 mutate 里判一次：一天最多一次，重启后第一次写入再做一次。
   */
  let lastSnapshotDay = '';

  /** 目录总字节 + 文件数（只用于备份清单展示，失败不计）。 */
  function dirUsage(target) {
    let bytes = 0;
    let files = 0;
    const walk = (current) => {
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else {
          files += 1;
          try {
            bytes += fs.statSync(full).size;
          } catch {
            /* 文件刚好被删，忽略 */
          }
        }
      }
    };
    walk(target);
    return { bytes, files };
  }

  const backupsDir = path.join(dir, 'backups');

  /** 备份目录名可排序：2026-10-22T14-23-45-678[-reason]。 */
  function snapshotName(reason = '') {
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-').replace(/Z$/u, '');
    const tag = String(reason || '')
      .replace(/[^a-z0-9_-]/giu, '')
      .slice(0, 16)
      .toLowerCase();
    return tag ? `${stamp}-${tag}` : stamp;
  }

  /**
   * 把整个库复制到 `<库根>/backups/<时间戳>-<reason>/`，只留最近 keep 份。
   *
   * 边界（对应 AGENTS.md D1/D2）：
   *   - 只写库根下的 `backups/`，任何情况下都不碰工作区目录；
   *   - 不含 `backups/` 自己（否则快照会指数增长）；
   *   - 失败一律返回 `{ ok: false }`，**绝不抛**：它挂在写入 / dream 收尾旁边，不能拖住主线。
   */
  function snapshotLibrary({ keep = 7, reason = '' } = {}) {
    try {
      if (!fs.existsSync(dir)) return { ok: false, error: 'no_library' };
      const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.name !== 'backups');
      if (!entries.length) return { ok: false, error: 'empty_library' };

      const base = snapshotName(reason);
      let name = base;
      let target = path.join(backupsDir, name);
      let seq = 1;
      /* 同一毫秒内连点（或两个进程同时备份）：加序号，别互相覆盖。 */
      while (fs.existsSync(target)) {
        seq += 1;
        name = `${base}-${seq}`;
        target = path.join(backupsDir, name);
      }
      fs.mkdirSync(target, { recursive: true });
      for (const entry of entries) {
        try {
          fs.cpSync(path.join(dir, entry.name), path.join(target, entry.name), {
            recursive: true,
            force: true,
            errorOnExist: false,
          });
        } catch {
          /* 单个文件复制失败（被杀软占住）不影响其它文件，也不影响快照本身 */
        }
      }

      const limit = Math.max(1, Math.min(60, Number(keep) || 7));
      const all = fs
        .readdirSync(backupsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      const removed = [];
      while (all.length > limit) {
        const victim = all.shift();
        try {
          fs.rmSync(path.join(backupsDir, victim), { recursive: true, force: true });
          removed.push(victim);
        } catch {
          /* 删不掉就留着，下次再删 */
        }
      }
      const usage = dirUsage(target);
      return { ok: true, name, dir: target, keep: limit, files: usage.files, bytes: usage.bytes, removed };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }

  /** 一天最多一次；挂在每次写入之后，失败静默。 */
  function dailySnapshot() {
    try {
      const day = new Date().toISOString().slice(0, 10);
      if (lastSnapshotDay === day) return null;
      lastSnapshotDay = day;
      if (!fs.existsSync(indexFile)) return null;
      return snapshotLibrary({ reason: 'daily' });
    } catch {
      return null;
    }
  }

  /**
   * Markdown 镜像，两处都写：
   *   1. 主库旁边 `~/.dsh/storages/dsh-memory/workspaces/<slug>/MEMORY.md`（面板与 /mirror 读这里）；
   *   2. 工作区内 `<工作区>/.dsh-memory/MEMORY.md` —— 设置里承诺的那份人读文件，
   *      可直接被 read/grep 与 git 使用。
   * 工作区目录不存在时跳过第 2 处：会话 cwd 已失效时绝不凭空造目录。
   *
   * 工作区那一侧同时落一份 `memory-snapshot.json`（结构化、可跨机器合并）。
   * 两份文件都只装**本工作区**的记录：全局记忆留在本地，不跟着项目进仓库。
   */
  function writeMirror(root, records, { workspace: alsoWorkspace = true } = {}) {
    const active = records.filter((r) => !r.archived && r.status !== 'draft');
    const markdown = renderMarkdown(records, {
      root: normalizeRoot(root),
      // 画像段落前置：离线读者先要知道「这是什么项目」，再去看条目。
      portrait: readPortraitFor(root),
    });
    const result = {
      storageFile: path.join(dataDirFor(root), 'MEMORY.md'),
      workspaceFile: null,
      snapshotFile: null,
      snapshotWritten: false,
    };
    try {
      fs.mkdirSync(path.dirname(result.storageFile), { recursive: true });
      fs.writeFileSync(result.storageFile, markdown, 'utf8');
    } catch {
      /* 镜像失败不影响主流程 */
    }
    // 一条有效记忆都没有、或用户在设置里关了工作区镜像：别在工作区留过期文件。
    if (!active.length || !alsoWorkspace) {
      removeWorkspaceMirror(root);
      return result;
    }
    if (isDirectory(normalizeRoot(root))) {
      try {
        const target = workspaceMirrorFile(root);
        if (!target) return result; // 全局库没有工作区镜像
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, markdown, 'utf8');
        result.workspaceFile = target;
        const snapshotTarget = path.join(path.dirname(target), SNAPSHOT_FILE_NAME);
        result.snapshotFile = snapshotTarget;
        result.snapshotWritten = writeSnapshotFile(
          snapshotTarget,
          portableSnapshot(records, { root }),
        );
      } catch {
        /* 工作区只读或无权限：镜像与快照一起降级，不影响主库 */
      }
    }
    return result;
  }

  /**
   * 撤掉工作区镜像与快照；`.dsh-memory` 空目录一并收掉。设置里关掉镜像时调用。
   * 两份文件必须一起删：只删 MEMORY.md 会留下一个没人读的 JSON，用户会以为镜像没关干净。
   */
  function removeWorkspaceMirror(workspace) {
    const target = workspaceMirrorFile(workspace);
    if (!target) return false;
    let removed = false;
    try {
      for (const file of [target, path.join(path.dirname(target), SNAPSHOT_FILE_NAME)]) {
        if (fileExists(file)) {
          fs.rmSync(file, { force: true });
          removed = true;
        }
      }
      const dir = path.dirname(target);
      if (isDirectory(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch {
      /* 删不掉就算了，不是致命错误 */
    }
    return removed;
  }

  /** 重复簇核心（闭包级，health 与公开方法共用）：并查集 + 同 scope 两两 Jaccard。 */
  function clusterDuplicates({ workspace = '', threshold = 0.72 } = {}) {
    /* 红线是用户的绝对禁令，措辞必须逐字保留；不参与自动重复簇，也不给面板合并入口。 */
    const pool = gather({ workspace }).filter((r) => !isRedline(r));
    /*
     * 预分词一次：两两阶段只做集合交并，不再每对现场 tokenize（similarity 的等价
     * 改写）。几百条库的两两对在十万级，每对重复分词会把 health 拖到秒级。
     */
    const tokenSets = pool.map((r) => new Set(uniqueTokens(`${r.title} ${r.content}`)));
    const jaccard = (sa, sb) => {
      if (!sa.size || !sb.size) return 0;
      let inter = 0;
      for (const t of sa) if (sb.has(t)) inter += 1;
      return inter / (sa.size + sb.size - inter);
    };
    const parent = new Map(pool.map((r) => [r.id, r.id]));
    const find = (id) => {
      while (parent.get(id) !== id) {
        parent.set(id, parent.get(parent.get(id)));
        id = parent.get(id);
      }
      return id;
    };
    for (let i = 0; i < pool.length; i += 1) {
      for (let j = i + 1; j < pool.length; j += 1) {
        if (pool[i].scope !== pool[j].scope) continue;
        if (jaccard(tokenSets[i], tokenSets[j]) >= threshold) parent.set(find(pool[i].id), find(pool[j].id));
      }
    }
    const groups = new Map();
    for (const r of pool) {
      const root = find(r.id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(r);
    }
    return [...groups.values()]
      .filter((group) => group.length > 1)
      /* 近似但语义相反的条目要交给「疑似矛盾」处理，不能当重复项自动合并。 */
      .filter((group) => detectContradictions(group, 1).length === 0);
  }

  /**
   * 更新核心（闭包级）：public update 与 unlink / markReviewed / promoteToAgents 共用，
   * 含 user 类别挪库。
   * 状态机保护：普通更新一律不带 status——当前是草稿就保持草稿，只有审批路径
   * （allowStatusChange: true，如 POST /queue/approve）能转正，防止任何调用方
   * 绕过待审队列把 draft 直接改成 active。
   */
  function patchRecord(
    id,
    patch = {},
    { workspace = '', allowStatusChange = false, overrideRedline = false } = {},
  ) {
    const all = gather({ workspace, includeArchived: true, includeDrafts: true });
    const current = all.find((r) => r.id === id);
    if (!current) return { ok: false, error: 'not_found' };
    /* 红线的归档/降级保护：归档即退出注入，等于变相删红线——与 remove 同一道闸。 */
    if (isRedline(current) && !overrideRedline) {
      if (patch.archived === true) return { ok: false, error: 'redline_protected' };
      if (patch.category !== undefined && patch.category !== 'constraint') {
        return { ok: false, error: 'redline_protected' };
      }
    }
    const patchForRecord = { ...patch };
    if (!allowStatusChange) {
      delete patchForRecord.status;
      if (current.status === 'draft') patchForRecord.status = 'draft';
    }
    const record = applyReviewPolicy(normalizeRecord({ ...patchForRecord, id }, current, secOpts()));
    /*
     * 显式传 null 表示清空：normalizeRecord 对 supersedes / supersededBy 优先沿用 existing，
     * 不补这一刀的话 unlink 会返回 ok 但链接纹丝不动（面板「摘除断链」踩过）。
     */
    for (const key of ['supersedes', 'supersededBy', 'archiveReason']) {
      if (Object.hasOwn(patchForRecord, key) && patchForRecord[key] == null) record[key] = null;
    }
    /*
     * 更新路径的 taint 闸：与 upsert 的 applySecurityGate 用同一个 quarantine 开关。
     * 只有内容确实被改写、且命中注入特征、且 trust 不是 user 时才隔离成草稿——
     * 改类别 / 置顶等非内容字段不触发；user 来源的内容更新不隔离（同创建路径）。
     */
    const contentChanged = patch.content !== undefined && patch.content !== current.content;
    if (contentChanged && record.taint && record.trust !== 'user' && securityFlag('quarantine')) {
      record.status = 'draft';
    }
    record.createdAt = current.createdAt;
    record.updatedAt = now();
    const currentRoot = current.scope === 'global' ? '' : workspace;
    const homeRoot = record.scope === 'global' ? '' : currentRoot;
    if (homeRoot !== currentRoot) {
      mutate(currentRoot, (records) => ({ records: records.filter((r) => r.id !== id) }));
    }
    return mutate(homeRoot, (records) => {
      const idx = records.findIndex((r) => r.id === id);
      const next = idx >= 0 ? records.map((r, i) => (i === idx ? record : r)) : [...records, record];
      return { ok: true, record, records: next };
    });
  }

  /**
   * 按时序处理一对矛盾：保留新结论，归档旧结论，并留下 supersededBy 可回滚链接。
   * 安全边界：同 scope；红线 / 置顶 / 草稿 / 已归档不自动处理；旧条是用户手写而新条不是时不覆盖；
   * 新条来自外部内容而旧条不是时也不覆盖。返回 error 让调用方展示原因。
   */
  function archiveOlderContradiction(left, right, { workspace = '' } = {}) {
    if (!left || !right) return { ok: false, error: 'not_found' };
    if (left.archived || right.archived) return { ok: false, error: 'archived' };
    if (left.status === 'draft' || right.status === 'draft') return { ok: false, error: 'draft' };
    if (left.scope !== right.scope) return { ok: false, error: 'mixed_scope' };
    const changedAt = (record) => Date.parse(record.createdAt) || 0;
    const older =
      changedAt(left) === changedAt(right)
        ? String(left.id) <= String(right.id)
          ? left
          : right
        : changedAt(left) < changedAt(right)
          ? left
          : right;
    const newer = older === left ? right : left;
    if (isRedline(older)) return { ok: false, error: 'redline_protected', older, newer };
    if (older.pinned) return { ok: false, error: 'pinned_older', older, newer };
    if (older.trust === 'user' && newer.trust !== 'user') {
      return { ok: false, error: 'user_older', older, newer };
    }
    if (newer.trust === 'external' && older.trust !== 'external') {
      return { ok: false, error: 'external_newer', older, newer };
    }
    const result = patchRecord(
      older.id,
      { archived: true, supersededBy: newer.id, archiveReason: 'time-order' },
      { workspace },
    );
    if (!result.ok) return { ok: false, error: result.error || 'archive_failed', older, newer };
    return { ok: true, archived: older, kept: newer };
  }

  /** 合并全局记忆 + 本工作区记忆。草稿默认不可见：要进审批队列必须显式带上 includeDrafts。 */
  function gather({ workspace = '', includeGlobal = true, includeArchived = false, includeDrafts = false } = {}) {
    const own = workspace ? load(workspace).records.map((r) => ({ ...r, scope: 'workspace' })) : [];
    const global = includeGlobal
      ? load('').records.map((r) => ({ ...r, scope: 'global' }))
      : [];
    let all = [...global, ...own];
    if (!includeArchived) all = all.filter((r) => !r.archived);
    if (!includeDrafts) all = all.filter((r) => r.status !== 'draft');
    return all;
  }

  /**
   * 统一的计数入口。counter 为空 = 曝光（只写 exposedCount/lastExposedAt）；
   * 否则写 useCount/lastUsedAt 与指定细分计数器。
   */
  function bump(ids = [], { workspace = '', counter = null } = {}) {
    if (!Array.isArray(ids) || !ids.length) return { ok: true, affected: 0 };
    const all = gather({ workspace, includeArchived: true, includeDrafts: true });
    const byRoot = new Map();
    for (const id of ids) {
      const record = all.find((x) => x.id === id);
      if (!record) continue;
      const root = record.scope === 'global' ? '' : workspace;
      if (!byRoot.has(root)) byRoot.set(root, new Set());
      byRoot.get(root).add(id);
    }
    let affected = 0;
    for (const [root, idSet] of byRoot) {
      affected += idSet.size;
      mutate(root, (records) => ({
        records: records.map((record) => {
          if (!idSet.has(record.id)) return record;
          if (!counter) {
            return {
              ...record,
              exposedCount: (record.exposedCount || 0) + 1,
              lastExposedAt: now(),
            };
          }
          return {
            ...record,
            lastUsedAt: now(),
            useCount: (record.useCount || 0) + 1,
            [counter]: (record[counter] || 0) + 1,
          };
        }),
      }));
    }
    return { ok: true, affected };
  }

  return {
    dir,
    indexPath: indexFile,

    /** 工作区元信息（不需要先有记忆）。 */
    workspaceInfo(workspace) {
      return {
        key: workspaceKey(workspace),
        root: normalizeRoot(workspace),
        slug: slugify(workspace),
        folder: folderFor(workspace),
        dataFile: dataFileFor(workspace),
        mirrorFile: workspaceMirrorFile(workspace),
      };
    },

    /**
     * 镜像现状：主库旁车与工作区镜像各自的路径与存在性。
     * 面板用它显示「镜像文件」一栏，并在镜像关掉时给出明确提示。
     */
    mirrorInfo(workspace) {
      const root = normalizeRoot(workspace);
      const storageFile = path.join(dataDirFor(root), 'MEMORY.md');
      const workspaceFile = workspaceMirrorFile(root);
      const snapshotFile = workspaceFile
        ? path.join(path.dirname(workspaceFile), SNAPSHOT_FILE_NAME)
        : null;
      return {
        storageFile,
        storageExists: fileExists(storageFile),
        workspaceFile,
        workspaceExists: workspaceFile ? fileExists(workspaceFile) : false,
        snapshotFile,
        snapshotExists: snapshotFile ? fileExists(snapshotFile) : false,
        workspaceDirExists: isDirectory(root),
      };
    },

    /** 关掉工作区镜像时撤掉文件（见 removeWorkspaceMirror）。 */
    removeWorkspaceMirror(workspace) {
      return removeWorkspaceMirror(workspace);
    },

    /**
     * 重写某个工作区的工作区镜像与快照。只读主库、不产生新记录。
     *
     * 用途是「历史工作区补写」：主库里有这个工作区的记忆，但目录下还没有
     * `.dsh-memory/`（例如在那段镜像关着的时候写入过，或项目移动后才首次打开）。
     * 没有 active 记录时直接返回，绝不凭空造目录（D2）。
     */
    refreshMirror(workspace = '') {
      const root = normalizeRoot(workspace);
      if (!root) return { ok: false, error: 'no_workspace' };
      const entry = load(root);
      const active = entry.records.filter((r) => !r.archived && r.status !== 'draft');
      if (!active.length) return { ok: false, error: 'empty', count: 0 };
      const written = writeMirror(root, entry.records, {
        workspace: Boolean(typeof mirror === 'function' ? mirror() : mirror),
      });
      return { ok: Boolean(written.workspaceFile), count: active.length, ...written };
    },

    /* ---------------- 全局候选原则池（二级蒸馏的中间层） ---------------- */

    candidates: {
      /**
       * 追加候选原则。
       *
       * 去重按「项目 + 表述」：同一项目重复蒸馏不会堆出一堆同义条；不同项目
       * 各自留一条，因为晋升判定看的是「几个不同项目都报过」。
       *
       * @param items [{ text, category, topics, anchors, project, at }]
       * @returns {{ok: boolean, added: number, skipped: number}}
       */
      add(items = []) {
        const incoming = (Array.isArray(items) ? items : []).filter((item) => item && item.text);
        if (!incoming.length) return { ok: true, added: 0, skipped: 0 };

        const pool = readCandidatePool();
        const seen = new Set(pool.map((item) => candidateKey(item.project, item.text)));
        let added = 0;
        let skipped = 0;

        for (const item of incoming) {
          const text = String(item.text).trim().slice(0, 240);
          const project = String(item.project || '');
          const key = candidateKey(project, text);
          if (seen.has(key)) {
            skipped += 1;
            continue;
          }
          seen.add(key);
          pool.push({
            id: newCandidateId(),
            text,
            category: String(item.category || 'convention'),
            topics: asArray(item.topics, 6).map((topic) => String(topic).toLowerCase()),
            anchors: asArray(item.anchors, 16).map(String),
            project,
            at: item.at || now(),
            status: 'pending',
            promotedId: null,
            rejectReason: null,
            decidedAt: null,
          });
          added += 1;
        }

        if (added) writeCandidatePool(pool);
        return { ok: true, added, skipped };
      },

      /** 按状态读；不传 status 返回全部。 */
      list({ status = '' } = {}) {
        const pool = readCandidatePool();
        return status ? pool.filter((item) => item.status === status) : pool;
      },

      /** 标记候选的处理结果。`rejected` 会记住原因，之后同主题不再提议。 */
      mark(ids = [], { status = '', promotedId = null, rejectReason = null } = {}) {
        if (!['promoted', 'rejected'].includes(status)) {
          return { ok: false, error: 'bad_status', affected: 0 };
        }
        const set = new Set((Array.isArray(ids) ? ids : []).map(String));
        if (!set.size) return { ok: true, affected: 0 };

        const pool = readCandidatePool();
        let affected = 0;
        const next = pool.map((item) => {
          if (!set.has(String(item.id))) return item;
          affected += 1;
          return {
            ...item,
            status,
            promotedId: status === 'promoted' ? promotedId || null : item.promotedId || null,
            rejectReason: status === 'rejected' ? String(rejectReason || '') : null,
            decidedAt: now(),
          };
        });
        if (affected) writeCandidatePool(next);
        return { ok: true, affected };
      },

      /** 池子概览：面板显示「待判定 N 条」。 */
      stats() {
        const pool = readCandidatePool();
        const by = { pending: 0, promoted: 0, rejected: 0 };
        for (const item of pool) {
          if (by[item.status] !== undefined) by[item.status] += 1;
        }
        return { total: pool.length, ...by };
      },
    },

    list(options = {}) {
      const {
        workspace = '',
        query = '',
        category = '',
        scope = '',
        tag = '',
        includeGlobal = true,
        includeArchived = false,
        includeDrafts = false,
        sort = 'updated',
        limit = 500,
        offset = 0,
      } = options;

      let records = gather({ workspace, includeGlobal, includeArchived, includeDrafts });
      if (category) records = records.filter((r) => r.category === category);
      if (scope) records = records.filter((r) => r.scope === scope);
      if (tag) records = records.filter((r) => (r.tags || []).includes(tag));

      if (query) {
        const tokens = uniqueTokens(query);
        const index = createBm25fIndex(records);
        const scored = records
          .map((r) => ({ r, s: scoreBm25f(r, tokens, index) + exactPhraseBoost(r, query) * 0.5 }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s || String(b.r.updatedAt).localeCompare(String(a.r.updatedAt)));
        records = scored.map((x) => x.r);
      } else if (sort === 'updated') {
        records = [...records].sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return String(b.updatedAt).localeCompare(String(a.updatedAt));
        });
      } else if (sort === 'created') {
        records = [...records].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      } else if (sort === 'title') {
        records = [...records].sort((a, b) => String(a.title).localeCompare(String(b.title)));
      }

      const total = records.length;
      return { total, records: records.slice(offset, offset + limit) };
    },

    get(id, { workspace = '', includeDrafts = false } = {}) {
      return gather({ workspace, includeArchived: true, includeDrafts }).find((r) => r.id === id) || null;
    },

    /**
     * 新增或更新。传入 id 时按 id 更新；否则按 workspaceKey 落库。
     * 当 `dedupe` 为真且发现高度相似的既有记录时，合并进那条记录。
     * `user` 类别强制落全局库：目标库不对时先从旧库摘出来再写入新库。
     */
    upsert(input = {}, { workspace = '', dedupe = false } = {}) {
      let targetRoot = input.scope === 'global' ? '' : workspace;
      let existing = null;
      if (input.id) {
        existing =
          load(targetRoot).records.find((r) => r.id === input.id) ||
          (targetRoot ? load('').records.find((r) => r.id === input.id) : null) ||
          null;
        if (existing?.scope === 'global') targetRoot = '';
      }

      let merged = null;
      if (!existing && dedupe) {
        const probe = `${input.title || ''} ${input.content || ''}`;
        let best = null;
        for (const r of load(targetRoot).records.filter((r) => r.status !== 'draft')) {
          const s = similarity(probe, `${r.title} ${r.content}`);
          if (!best || s > best.s) best = { r, s };
        }
        if (best && best.s >= 0.72) merged = best.r;
      }

      const record = applyReviewPolicy(
        applySecurityGate(normalizeRecord(input, existing || merged || null, secOpts()), !existing && !merged),
      );
      if (existing || merged) record.createdAt = (existing || merged).createdAt;

      // 质量闸门：只拦「新建 + 自动提炼/agent 主动写」的低分条目；
      // 草稿（等人审批）、手工与导入的记忆人已经看过，不因分数被藏起来。
      // 红线不受闸门管辖：短促的禁令（「绝不提交 .env」）天然拿不到高分，但必须在场。
      if (
        !existing &&
        !merged &&
        !isRedline(record) &&
        record.status !== 'draft' &&
        gateOn() &&
        AUTO_SOURCES.has(record.source) &&
        record.quality < QUALITY_THRESHOLDS.archive
      ) {
        record.archived = true;
        record.archiveReason = 'low_quality';
      }

      const homeRoot = record.scope === 'global' ? '' : targetRoot;
      if (homeRoot !== targetRoot) {
        mutate(targetRoot, (records) => ({ records: records.filter((r) => r.id !== record.id) }));
      }
      const result = mutate(homeRoot, (records) => {
        const idx = records.findIndex((r) => r.id === record.id);
        const next = idx >= 0 ? records.map((r, i) => (i === idx ? record : r)) : [...records, record];
        return { record, mergedInto: Boolean(merged), records: next };
      });
      return result;
    },

    /**
     * 局部更新（置顶/归档/改类别/改正文）。类别改动触发挪库时同样走摘除+写入。
     * allowStatusChange 只给审批路径用（POST /queue/approve）：普通更新不许改 status。
     */
    update(id, patch = {}, { workspace = '', allowStatusChange = false, overrideRedline = false } = {}) {
      return patchRecord(id, patch, { workspace, allowStatusChange, overrideRedline });
    },

    remove(id, { workspace = '', overrideRedline = false } = {}) {
      const all = gather({ workspace, includeArchived: true, includeDrafts: true });
      const current = all.find((r) => r.id === id);
      if (!current) return { ok: false, error: 'not_found' };
      /* 红线只能由用户显式撤销（面板确认走 overrideRedline）；模型工具与普通删除一律拒绝。 */
      if (isRedline(current) && !overrideRedline) return { ok: false, error: 'redline_protected' };
      const targetRoot = current.scope === 'global' ? '' : workspace;
      return mutate(targetRoot, (records) => ({
        ok: true,
        removed: current,
        records: records.filter((r) => r.id !== id),
      }));
    },

    /** 批量删除 / 归档 / 置顶。 */
    bulk(action, ids = [], { workspace = '' } = {}) {
      const all = gather({ workspace, includeArchived: true, includeDrafts: true });
      const targets = ids
        .map((id) => all.find((r) => r.id === id))
        .filter(Boolean)
        /* 批量清理不碰红线：跳过而不是整批失败，让面板清理动作照常完成。 */
        .filter((r) => !isRedline(r));
      if (!targets.length) return { ok: true, affected: 0 };

      const byRoot = new Map();
      for (const r of targets) {
        const root = r.scope === 'global' ? '' : workspace;
        if (!byRoot.has(root)) byRoot.set(root, new Set());
        byRoot.get(root).add(r.id);
      }

      let affected = 0;
      for (const [root, idSet] of byRoot) {
        mutate(root, (records) => {
          let next = records;
          if (action === 'delete') {
            next = records.filter((r) => !idSet.has(r.id));
          } else {
            next = records.map((r) => {
              if (!idSet.has(r.id)) return r;
              const patch = {};
              if (action === 'archive') patch.archived = true;
              if (action === 'unarchive') patch.archived = false;
              if (action === 'pin') patch.pinned = true;
              if (action === 'unpin') patch.pinned = false;
              return { ...r, ...patch, updatedAt: now() };
            });
          }
          affected += idSet.size;
          return { records: next };
        });
      }
      return { ok: true, affected: targets.length };
    },

    /** 检索：给 agent 工具与会话注入用，按相关度排序。带 query 时只返回真命中的记录。 */
    search({ workspace = '', query = '', limit = 10, includeGlobal = true } = {}) {
      const pool = gather({ workspace, includeGlobal });
      const ranked = rankRecords(pool, { query, limit });
      const trimmed = String(query).trim();
      if (!trimmed) return ranked.map((x) => ({ ...x.record, _score: Number(x.score.toFixed(3)) }));
      const floor = adaptiveRelevanceFloor(uniqueTokens(trimmed), ranked);
      return ranked
        .filter((x) => x.relevance >= floor)
        .map((x) => ({ ...x.record, _score: Number(x.score.toFixed(3)) }));
    },

    /**
     * 路径召回（path JIT）：按「文件被触达」找挂在该文件上的记忆。
     * 匹配强度：全路径 > 目录后缀 > 同名文件；置顶与时效参与排序；
     * archived/draft 与 excludeIds（简报里已有的、本轮已注入的）一律排除。
     */
    recallByFiles({ workspace = '', files = [], limit = 3, excludeIds = [] } = {}) {
      const wanted = (Array.isArray(files) ? files : [])
        .map((f) => normalizeFilePath(f))
        .filter(Boolean)
        .slice(0, 8);
      if (!wanted.length) return [];
      const exclude = new Set(Array.isArray(excludeIds) ? excludeIds : []);
      const pool = gather({ workspace }).filter((r) => !exclude.has(r.id));
      const scored = [];
      for (const r of pool) {
        const list = (r.files || []).map((f) => normalizeFilePath(f)).filter(Boolean);
        if (!list.length) continue;
        let best = 0;
        for (const p of wanted) {
          for (const f of list) {
            if (p === f) best = Math.max(best, 3);
            else if (p.endsWith(`/${f}`) || f.endsWith(`/${p}`)) best = Math.max(best, 2);
            else if (basenameOf(p) && basenameOf(p) === basenameOf(f)) best = Math.max(best, 1);
          }
        }
        if (best) scored.push({ r, best });
      }
      return scored
        .sort((a, b) => {
          const pa = a.r.pinned ? 1 : 0;
          const pb = b.r.pinned ? 1 : 0;
          if (pa !== pb) return pb - pa;
          if (a.best !== b.best) return b.best - a.best;
          const decayOf = (r) => (isRedline(r) ? 1 : decayFactor(r.lastUsedAt || r.updatedAt || r.createdAt));
          const da = decayOf(a.r);
          const db = decayOf(b.r);
          if (da !== db) return db - da;
          return String(a.r.id).localeCompare(String(b.r.id));
        })
        .slice(0, Math.max(0, limit))
        .map((x) => x.r);
    },

    /**
     * 会话开始注入用：不需要 query，按重要度取前 N 条。index 模式一行一条，成本按行算。
     * 红线（constraint）先于一切挑选：不占 limit / maxChars 预算、不受排序影响——
     * 禁令必须每轮在场，挤掉它的是注入的失败而不是预算的取舍。
     */
    briefing({ workspace = '', limit = 12, maxChars = 2400, mode = 'full' } = {}) {
      const pool = gather({ workspace, includeGlobal: true });
      const redlines = pool.filter((r) => isRedline(r) && !r.archived && r.status !== 'draft');
      const picked = [...redlines];
      let used = 0;
      for (const { record } of rankRecords(pool, { limit: 200, stable: true })) {
        if (isRedline(record) || picked.includes(record)) continue;
        const cost =
          mode === 'index'
            ? record.title.length + (record.tags || []).join('').length + 30
            : record.title.length + record.content.length + 24;
        if (used + cost > maxChars && picked.length - redlines.length >= 3) break;
        picked.push(record);
        used += cost;
        if (picked.length - redlines.length >= limit) break;
      }
      return picked;
    },

    /**
     * 版本链：新观察推翻旧结论时，旧条归档并回指新条，新条指回旧条。
     * 归档不是删除——链一直在，面板可以一键回滚。
     */
    supersede(oldId, input = {}, { workspace = '' } = {}) {
      const all = gather({ workspace, includeArchived: true, includeDrafts: true });
      const old = all.find((r) => r.id === oldId);
      if (!old) return { ok: false, error: 'not_found' };
      const seed = { ...input, supersedes: old.id, scope: old.scope, status: 'active' };
      if (!CATEGORY_SET.has(seed.category)) seed.category = old.category;
      const record = applyReviewPolicy(applySecurityGate(normalizeRecord(seed, null, secOpts()), true));
      const targetRoot = old.scope === 'global' ? '' : workspace;
      return mutate(targetRoot, (records) => {
        const next = records.map((r) =>
          r.id === old.id ? { ...r, archived: true, supersededBy: record.id, updatedAt: now() } : r,
        );
        return { ok: true, record, superseded: old, records: [...next, record] };
      });
    },

    /**
     * 回滚版本链。传新条 id：收起新条、恢复旧条；传旧条 id（带 supersededBy）：
     * 恢复自己、收起指向的新条。
     */
    rollback(id, { workspace = '' } = {}) {
      const all = gather({ workspace, includeArchived: true, includeDrafts: true });
      const record = all.find((r) => r.id === id);
      if (!record) return { ok: false, error: 'not_found' };
      const oldId = record.supersedes || null;
      const newerId = record.supersededBy || null;
      if (!oldId && !newerId) return { ok: false, error: 'no_chain' };
      const targetRoot = record.scope === 'global' ? '' : workspace;
      return mutate(targetRoot, (records) => ({
        ok: true,
        restored: oldId || id,
        archived: oldId ? id : newerId,
        records: records.map((r) => {
          if (oldId && r.id === id) return { ...r, archived: true, updatedAt: now() };
          if (!oldId && r.id === id) return { ...r, archived: false, supersededBy: null, updatedAt: now() };
          if (oldId && r.id === oldId) return { ...r, archived: false, supersededBy: null, updatedAt: now() };
          if (!oldId && r.id === newerId) return { ...r, archived: true, updatedAt: now() };
          return r;
        }),
      }));
    },

    /**
     * 红线改稿：保留上一版措辞、替换时间与历史，供面板对照 / 回滚。
     * 只接受 constraint；其余记录走普通 update。历史最多留 20 版。
     */
    updateRedline(id, { title = '', content = '' } = {}, { workspace = '' } = {}) {
      const all = gather({ workspace, includeArchived: true, includeDrafts: true });
      const current = all.find((r) => r.id === id);
      if (!current) return { ok: false, error: 'not_found' };
      if (!isRedline(current)) return { ok: false, error: 'not_redline' };
      const nextTitle = clampText(String(title || '').trim(), 160);
      const nextContent = clampText(String(content || '').trim(), 8000);
      if (!nextTitle || !nextContent) return { ok: false, error: 'empty_redline' };
      if (nextTitle === current.title && nextContent === current.content) {
        return { ok: true, record: current, unchanged: true };
      }
      const redlineHistory = normalizeRedlineHistory([
        ...(current.redlineHistory || []),
        { title: current.title, content: current.content, replacedAt: now() },
      ]);
      return patchRecord(id, { title: nextTitle, content: nextContent, redlineHistory }, { workspace });
    },

    /** 回滚到某一版历史；当前版本会先写回历史，回滚本身可再回滚。 */
    rollbackRedline(id, index, { workspace = '' } = {}) {
      const all = gather({ workspace, includeArchived: true, includeDrafts: true });
      const current = all.find((r) => r.id === id);
      if (!current) return { ok: false, error: 'not_found' };
      if (!isRedline(current)) return { ok: false, error: 'not_redline' };
      const history = normalizeRedlineHistory(current.redlineHistory);
      const at = Number(index);
      if (!Number.isInteger(at) || at < 0 || at >= history.length) return { ok: false, error: 'bad_version' };
      const version = history[at];
      const rest = history.filter((_, i) => i !== at);
      const redlineHistory = normalizeRedlineHistory([
        ...rest,
        { title: current.title, content: current.content, replacedAt: now() },
      ]);
      return patchRecord(
        id,
        { title: version.title, content: version.content, redlineHistory },
        { workspace },
      );
    },

    /** 新红线保存前的冲突检查：与现有红线做同一套「疑似矛盾」词法判定。 */
    redlineConflicts({ workspace = '', title = '', content = '', excludeId = '' } = {}) {
      const nextTitle = clampText(String(title || '').trim(), 160);
      const nextContent = clampText(String(content || '').trim(), 8000);
      if (!nextTitle || !nextContent) return { ok: false, error: 'empty_redline' };
      const pool = gather({ workspace }).filter((r) => isRedline(r) && r.id !== excludeId);
      const draft = {
        id: '__redline_draft__',
        title: nextTitle,
        content: nextContent,
        category: 'constraint',
        tags: [],
        scope: 'workspace',
      };
      const pairs = detectContradictions([...pool, draft], 20);
      const byId = new Map(pool.map((r) => [r.id, r]));
      const conflicts = pairs
        .filter((pair) => pair.a === draft.id || pair.b === draft.id)
        .map((pair) => {
          const otherId = pair.a === draft.id ? pair.b : pair.a;
          return { id: otherId, title: byId.get(otherId)?.title || otherId, hint: pair.hint };
        });
      return { ok: true, conflicts };
    },

    /**
     * 矛盾对的时序治理：默认 `apply: true` 时保留新结论、归档旧结论并留 `supersededBy` 回滚链接。
     * 传 `apply: false` 只报告（Dream 用这个：词法线索会误报，自动归档会误伤无关记忆；
     * 真正归档只走面板逐对确认的 `resolveContradictionPair`）。
     */
    resolveContradictionsByTime({ workspace = '', limit = 50, apply = true } = {}) {
      const active = gather({ workspace });
      const pairs = detectContradictions(active, limit);
      const all = gather({ workspace, includeArchived: true, includeDrafts: true });
      const byId = new Map(all.map((r) => [r.id, r]));
      const resolved = [];
      const pending = [];
      const processed = new Set();
      for (const pair of pairs) {
        if (processed.has(pair.a) || processed.has(pair.b)) continue;
        const left = byId.get(pair.a);
        const right = byId.get(pair.b);
        if (!left || !right) continue;
        if (!apply) {
          pending.push({
            a: pair.a,
            b: pair.b,
            aTitle: left.title,
            bTitle: right.title,
            hint: pair.hint,
            reason: 'needs_confirmation',
          });
          continue;
        }
        const result = archiveOlderContradiction(left, right, { workspace });
        if (result.ok) {
          processed.add(result.archived.id);
          resolved.push({
            archivedId: result.archived.id,
            archivedTitle: result.archived.title,
            keptId: result.kept.id,
            keptTitle: result.kept.title,
            hint: pair.hint,
          });
        } else {
          pending.push({
            a: pair.a,
            b: pair.b,
            aTitle: left.title,
            bTitle: right.title,
            hint: pair.hint,
            reason: result.error,
          });
        }
      }
      return { ok: true, resolved, pending };
    },

    /** 面板「按时序归档旧条」：只处理指定的一对，仍走同一套保护规则。 */
    resolveContradictionPair(aId, bId, { workspace = '' } = {}) {
      const all = gather({ workspace, includeArchived: true, includeDrafts: true });
      const left = all.find((r) => r.id === aId) || null;
      const right = all.find((r) => r.id === bId) || null;
      const result = archiveOlderContradiction(left, right, { workspace });
      if (!result.ok) return result;
      return { ok: true, archived: result.archived, kept: result.kept };
    },

    /** 相关记忆的双链是悬空允许的；这里把指向不存在记录的链接摘掉（体检的修复动作）。 */
    unlink(id, target = '', { workspace = '' } = {}) {
      const all = gather({ workspace, includeArchived: true, includeDrafts: true });
      const current = all.find((r) => r.id === id);
      if (!current) return { ok: false, error: 'not_found' };
      const patch = {};
      if (target && current.supersedes === target) patch.supersedes = null;
      if (target && current.supersededBy === target) patch.supersededBy = null;
      if (!target || current.related?.includes(target)) {
        patch.related = target ? (current.related || []).filter((x) => x !== target) : [];
      }
      if (!Object.keys(patch).length) return { ok: false, error: 'nothing_to_unlink' };
      return patchRecord(id, patch, { workspace });
    },

    /** 重复簇：同 scope 内两两 Jaccard ≥ threshold 的记录归成一个簇（并查集）。 */
    findDuplicateClusters({ workspace = '', threshold = 0.72 } = {}) {
      return clusterDuplicates({ workspace, threshold });
    },

    /**
     * 合并标签变体：把 from 里的每个标签（原样匹配）统一替换成 to。
     * 用于治理「DSH / dsh / Dsh」这类大小写漂移。返回改动的条数。
     */
    mergeTag(from = [], to = '', { workspace = '' } = {}) {
      const names = asArray(from).filter((t) => t && t !== to);
      if (!names.length || !to) return { ok: false, error: 'nothing_to_merge' };
      const all = gather({ workspace, includeArchived: true, includeDrafts: true });
      const byRoot = new Map();
      for (const r of all) {
        if (!(r.tags || []).some((t) => names.includes(t))) continue;
        const root = r.scope === 'global' ? '' : workspace;
        if (!byRoot.has(root)) byRoot.set(root, new Set());
        byRoot.get(root).add(r.id);
      }
      let affected = 0;
      for (const [root, ids] of byRoot) {
        mutate(root, (records) => ({
          records: records.map((r) => {
            if (!ids.has(r.id)) return r;
            const next = [...new Set((r.tags || []).map((t) => (names.includes(t) ? to : t)))];
            return { ...r, tags: next, updatedAt: now() };
          }),
        }));
        affected += ids.size;
      }
      return { ok: true, affected };
    },

    /**
     * 把一簇重复记忆合并成一条新记忆并归档源条目（与面板「整合」同一套语义：
     * 归档可恢复，不真删）。ids 至少两条且同 scope。
     */
    consolidateCluster(ids = [], { workspace = '', title = '', content = '', category = '', tags = null, source = 'manual' } = {}) {
      const all = gather({ workspace, includeArchived: true, includeDrafts: true });
      const targets = ids
        .map((id) => all.find((r) => r.id === id))
        .filter(Boolean)
        .filter((r) => !r.archived && r.status !== 'draft');
      if (targets.length < 2) return { ok: false, error: 'need_two' };
      /* 防御直连调用：clusterDuplicates 已排除红线，这里再挡一次，保证任何合并入口都绕不过红线治理。 */
      if (targets.some((r) => isRedline(r))) return { ok: false, error: 'redline_protected' };
      /* 矛盾对不是重复项：合并会把「要」和「不要」揉成一条，必须先由人裁决。 */
      if (detectContradictions(targets, 1).length) return { ok: false, error: 'contradiction_pair' };
      if (new Set(targets.map((r) => r.scope)).size > 1) return { ok: false, error: 'mixed_scope' };

      const tally = new Map();
      for (const r of targets) tally.set(r.category, (tally.get(r.category) || 0) + 1);
      const modeCategory = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'note';
      const base = [...targets].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
      const record = applySecurityGate(
        normalizeRecord(
          {
            title: title || base.title,
            content: content || targets
              .map((r) => {
                const body = String(r.content || '').replace(/\s+/g, ' ').trim();
                return `- **${r.title}**${body ? ` — ${body}` : ''}`;
              })
              .join('\n'),
            category: CATEGORY_SET.has(category) ? category : modeCategory,
            tags: tags ?? [...new Set(targets.flatMap((r) => r.tags || []))],
            scope: base.scope,
            /* 来源里只要有一条置顶，合并结果就保持置顶——自动整理不该把用户钉住的东西降级。 */
            pinned: targets.some((r) => r.pinned),
            source,
            confidence: Math.max(...targets.map((r) => r.confidence ?? 0.8)),
          },
          null,
          secOpts(),
        ),
        true,
      );
      const targetRoot = base.scope === 'global' ? '' : workspace;
      return mutate(targetRoot, (records) => {
        const idSet = new Set(targets.map((r) => r.id));
        // 源条目归档（可恢复），不真删——与面板「整合」同一语义。
        return {
          ok: true,
          record,
          archivedIds: targets.map((r) => r.id),
          records: [
            ...records.map((r) => (idSet.has(r.id) ? { ...r, archived: true, updatedAt: now() } : r)),
            record,
          ],
        };
      });
    },

    /**
     * 记忆体检：重复簇、过期未用、断链（related/supersedes 指向不存在的记录）、
     * 待审草稿数、疑似矛盾对、files 引用失效、库规模超预算信号。
     * 只报告，不动手——修复走 /health/resolve（矛盾对走 supersede）。
     */
    health({ workspace = '', staleDays = 60, briefingLimit = 12 } = {}) {
      const pool = gather({ workspace });
      const everything = gather({ workspace, includeArchived: true, includeDrafts: true });
      const byId = new Map(everything.map((r) => [r.id, r]));
      const cutoff = Date.now() - staleDays * 86400000;
      /* 红线不进过期/复核口径：禁令「很久没用到」恰是常态，不是失效信号。 */
      const stale = pool
        .filter((r) => !isRedline(r) && !r.pinned && !r.useCount && (Date.parse(r.updatedAt) || 0) < cutoff)
        .map((r) => r.id);
      // 被反复注入/检索到，却从未被显式打开或引用：排序不再奖励曝光后，这批人最该被复核。
      const exposedButUnused = pool
        .filter((r) => !isRedline(r) && !r.pinned && !r.useCount && (r.exposedCount || 0) >= 3)
        .map((r) => r.id);
      const duplicates = clusterDuplicates({ workspace }).map((group) => group.map((r) => r.id));
      const broken = [];
      for (const r of everything) {
        for (const target of r.related || []) {
          if (!byId.has(target)) broken.push({ id: r.id, field: 'related', target });
        }
        if (r.supersedes && !byId.has(r.supersedes)) broken.push({ id: r.id, field: 'supersedes', target: r.supersedes });
        if (r.supersededBy && !byId.has(r.supersededBy)) {
          broken.push({ id: r.id, field: 'supersededBy', target: r.supersededBy });
        }
      }
      // 派生链失效：证据没了但派生物还在（画像、AGENTS.md 里的内容可能已经过时）。
      const derivations = derivationListFor(workspace);
      const dirtyDerivations = derivations
        .filter((entry) => entry.state === 'dirty')
        .map((entry) => ({ layer: entry.layer, target: entry.target, reason: entry.reason, sources: entry.sources.map((s) => s.id) }));
      // 复审到期：带失效条件、且到期时间已过的记忆。
      const reviewDue = pool
        .filter((r) => r.falsifier && r.reviewAt && Date.parse(r.reviewAt) <= Date.now())
        .map((r) => r.id);
      // 疑似矛盾对与 files 引用失效：纯词法 / 文件系统检查，只报告。
      const contradictions = detectContradictions(pool);
      const deadFiles = detectDeadFiles(pool, normalizeRoot(workspace));
      // 库规模 vs 简报预算：5 倍取的是「≥80% 的 active 记忆永远分不到简报席位」的口径
      // （简报每轮只装 top briefingLimit 条），越过就该合并/归档/调预算了。不动注入路径（C4）。
      // 红线不占简报预算席位（briefing 先于预算挑选），超预算口径相应排除。
      const activeCount = pool.filter((r) => !isRedline(r)).length;
      const overBudget = activeCount > briefingLimit * 5;
      return {
        workspace: normalizeRoot(workspace),
        staleDays,
        stale,
        exposedButUnused,
        duplicates,
        broken,
        drafts: everything.filter((r) => r.status === 'draft' && !r.archived).length,
        derivations: { total: derivations.length, dirty: dirtyDerivations.length, entries: dirtyDerivations },
        reviewDue,
        contradictions,
        deadFiles,
        activeCount,
        briefingLimit,
        overBudget,
        overBudgetAdvice: overBudget
          ? `active 记忆 ${activeCount} 条，已超过简报上限（${briefingLimit}）的 5 倍，多数记忆分不到简报席位。建议合并同标签的记忆组、归档过期条目，或在设置中调高 briefingLimit。`
          : '',
      };
    },

    /**
     * 曝光：被注入、被检索选中，只说明「模型看见过」，不代表用过。
     * 不写 useCount / lastUsedAt，因此不会抬高后续排序。
     */
    markExposed(ids = [], { workspace = '' } = {}) {
      return bump(ids, { workspace, counter: null });
    },

    /** 显式打开（memory get）：计入 openedCount 与 useCount。 */
    markOpened(ids = [], { workspace = '' } = {}) {
      return bump(ids, { workspace, counter: 'openedCount' });
    },

    /** 答案里显式引用 id：计入 citedCount 与 useCount。 */
    markCited(ids = [], { workspace = '' } = {}) {
      return bump(ids, { workspace, counter: 'citedCount' });
    },

    /** 兼容旧调用：显式使用等同于打开。 */
    markUsed(ids = [], { workspace = '' } = {}) {
      return bump(ids, { workspace, counter: 'openedCount' });
    },

    /**
     * 从一段文本里找出真实存在的记忆 id 并记为「被引用」。
     * 只认当前可见记录，避免把示例文本里的假 id 算进去。
     */
    markCitations(text = '', { workspace = '' } = {}) {
      const ids = [...new Set(String(text || '').match(CITED_ID_RE) || [])].slice(0, 20);
      if (!ids.length) return { ok: true, affected: 0, ids: [] };
      const visible = new Set(gather({ workspace }).map((r) => r.id));
      const hit = ids.filter((id) => visible.has(id));
      if (!hit.length) return { ok: true, affected: 0, ids: [] };
      const result = bump(hit, { workspace, counter: 'citedCount' });
      return { ...result, ids: hit };
    },

    stats({ workspace = '' } = {}) {
      const active = gather({ workspace, includeGlobal: false });
      const global = load('').records.filter((r) => !r.archived && r.status !== 'draft');
      const pool = gather({ workspace });
      const drafts = gather({ workspace, includeArchived: true, includeDrafts: true }).filter(
        (r) => r.status === 'draft' && !r.archived,
      ).length;
      const used = pool.filter((r) => (r.useCount || 0) > 0).length;
      const neverUsed = pool.filter(
        (r) => !r.pinned && !r.useCount && (r.exposedCount || 0) >= 3,
      ).length;
      const byCategory = {};
      for (const r of active) byCategory[r.category] = (byCategory[r.category] || 0) + 1;
      return {
        workspace: normalizeRoot(workspace),
        key: workspaceKey(workspace),
        folder: folderFor(workspace),
        total: active.length,
        archived: load(workspace).records.filter((r) => r.archived).length,
        pinned: active.filter((r) => r.pinned).length,
        global: global.length,
        drafts,
        utilization: pool.length ? used / pool.length : 0,
        neverUsed,
        byCategory,
        updatedAt: active.reduce((acc, r) => (String(r.updatedAt) > acc ? String(r.updatedAt) : acc), ''),
      };
    },

    /** 所有已知工作区（设置面板的「工作区切换」用）。 */
    workspaces() {
      const index = readJson(indexFile, { workspaces: {} });
      return Object.values(index.workspaces || {}).sort((a, b) =>
        String(b.updatedAt).localeCompare(String(a.updatedAt)),
      );
    },

    /** 所有出现过的标签。 */
    tags({ workspace = '' } = {}) {
      const counts = new Map();
      for (const r of gather({ workspace })) {
        for (const t of r.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
      }
      return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
    },

    /**
     * 导出（备份 / 迁移）。full=true 时并入画像 / 派生链 / 最近 30 天日志，
     * 供换机整库恢复；既有顶层字段（records 等）保持不变，只增不改。
     */
    export({ workspace = '', full = false } = {}) {
      const base = {
        schemaVersion: SCHEMA_VERSION,
        exportedAt: now(),
        workspace: normalizeRoot(workspace),
        key: workspaceKey(workspace),
        records: gather({ workspace, includeArchived: true }),
      };
      if (!full) return base;
      return {
        ...base,
        full: true,
        portrait: portraitExportFor(workspace),
        derivations: readDerivations(workspace),
        journal: journalExportFor(workspace, 30),
      };
    },

    import(payload = {}, { workspace = '', mode = 'merge' } = {}) {
      const incoming = Array.isArray(payload.records) ? payload.records : [];
      const targetRoot = workspace || '';
      /* 记录自带 scope：global 的进全局库，workspace 的进本工作区库。 */
      const groups = new Map();
      for (const raw of incoming) {
        const norm = normalizeLoaded(raw);
        const root = norm.scope === 'global' ? '' : targetRoot;
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(norm);
      }
      let added = 0;
      let replaced = 0;
      for (const [root, records] of groups) {
        mutate(root, (current) => {
          const byId = new Map(current.map((r) => [r.id, r]));
          if (mode === 'replace') byId.clear();
          for (const norm of records) {
            if (byId.has(norm.id)) replaced += 1;
            else added += 1;
            byId.set(norm.id, norm);
          }
          return { records: [...byId.values()] };
        });
      }
      const result = { ok: true, added, replaced, total: incoming.length };
      /*
       * full 载荷（GET /export?full=1 的产物）：records 之外还带画像 / 派生链 / 日志。
       * records 走的正是上面这条既有导入路径（security 元数据照常保留，D3 不削弱）；
       * 其余三类分流回灌：派生链先并（否则画像保存顺手 upsert 的同 id 条目会以
       * 更新的 updatedAt 把导入条目挡在外面）、画像空不覆盖既有、日志去重追加。
       */
      if (payload.full === true) {
        result.full = {
          derivations: importDerivationsFor(workspace, payload.derivations),
          portrait: importPortraitFor(workspace, payload.portrait),
          journal: importJournalFor(workspace, payload.journal),
        };
      }
      return result;
    },

    /* ---------------- 注入审计（append-only） ---------------- */

    /**
     * 记一条注入：进 prompt 的文本摘要（sha256 前 16 位 + 真实长度 + 前 200 字符）、
     * 带了哪些记忆 id、哪些条目被预算挤掉。平时只追加一行（append-only），
     * 累计超过上限才做一次读 + 裁剪 + 重写——不再每次追加都全量读写整个 jsonl。
     */
    injectionLogAppend(root, entry = {}) {
      const info = injectionLogInfoFor(root);
      const text = String(entry.text ?? '');
      const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
      const row = {
        at: entry.at || now(),
        sessionId: String(entry.sessionId || ''),
        turn: Number(entry.turn) || 0,
        kind: String(entry.kind || 'briefing'),
        mode: entry.mode ? String(entry.mode) : null,
        ids: asArray(entry.ids, 200),
        chars: text.length,
        hash,
        // 审计要的是可对账的凭据而不是全文：hash + 长度可精确比对，前 200 字符够肉眼定位。
        text: clampText(text, 200),
        dropped: Array.isArray(entry.dropped) ? entry.dropped.slice(0, 50) : [],
        files: asArray(entry.files, 20),
        fingerprint: entry.fingerprint ? String(entry.fingerprint) : null,
        reason: entry.reason ? String(entry.reason) : null,
      };
      fs.mkdirSync(info.dir, { recursive: true });
      if (!injectionLogCounts.has(info.file)) {
        injectionLogCounts.set(info.file, readJsonl(info.file).length);
      }
      fs.appendFileSync(info.file, `${JSON.stringify(row)}\n`, 'utf8');
      let count = injectionLogCounts.get(info.file) + 1;
      // 到上限后不立刻裁：攒够滞回量再一次性裁回上限，避免到顶后每条都全量重写。
      if (count >= INJECTION_LOG_LIMIT + INJECTION_LOG_TRIM_SLACK) {
        const kept = readJsonl(info.file).slice(-INJECTION_LOG_LIMIT);
        fs.writeFileSync(info.file, `${kept.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
        count = INJECTION_LOG_LIMIT;
      }
      injectionLogCounts.set(info.file, count);
      return { ok: true, entry: row };
    },

    /** 读最近的注入记录（新的在前）；可按 kind 过滤。 */
    injectionLogRead(root, { limit = 20, kind = '' } = {}) {
      const info = injectionLogInfoFor(root);
      const capped = Math.max(1, Math.min(INJECTION_LOG_LIMIT, Number(limit) || 20));
      return readJsonl(info.file)
        .filter((row) => !kind || row.kind === kind)
        .slice(-capped)
        .reverse();
    },

    /* ---------------- 跨层派生链（记忆 → 画像 → AGENTS.md） ---------------- */

    /**
     * 派生链（带实时对账结果）：每一层派生了什么、它的源现在还成不成立。
     * 状态是算出来的，不是存出来的：源被删/被归档/被取代/被改写，派生层立刻标脏。
     */
    derivationList(root) {
      return derivationListFor(root);
    },

    /** 派生链汇总：总数、失效数、按层分布。 */
    derivationSummary(root) {
      return derivationSummary(derivationListFor(root));
    },

    /* ---------------- 可执行校验：失效条件与复审 ---------------- */

    /**
     * 复审队列：带失效条件且排了期的记忆。
     * due=已到期，soon=withinDays 天内到期（默认 30 天）。
     */
    reviewQueue(root, { withinDays = 30 } = {}) {
      const pool = gather({ workspace: root });
      const nowMs = Date.now();
      const soonMs = nowMs + Math.max(0, Number(withinDays) || 30) * 86400000;
      const scheduled = pool.filter((r) => r.falsifier && r.reviewAt);
      return {
        due: scheduled.filter((r) => Date.parse(r.reviewAt) <= nowMs),
        soon: scheduled.filter((r) => {
          const at = Date.parse(r.reviewAt);
          return at > nowMs && at <= soonMs;
        }),
      };
    },

    /**
     * 复审：记一次「看过，还成立」，并把到期时间推后一个 TTL。
     * 显式给了 reviewAt 就用它。
     */
    markReviewed(id, { workspace = '', reviewAt = null } = {}) {
      const all = gather({ workspace, includeArchived: true, includeDrafts: true });
      const current = all.find((r) => r.id === id);
      if (!current) return { ok: false, error: 'not_found' };
      const explicit = normalizeReviewAt(reviewAt);
      const next = explicit || new Date(Date.now() + reviewDays() * 86400000).toISOString();
      const patched = patchRecord(id, { reviewAt: next, reviewedAt: now() }, { workspace });
      return { ok: true, record: patched?.record ?? null, reviewAt: next };
    },

    /* ---------------- 画像层（portrait） ---------------- */

    /**
     * 画像的路径与状态信息（不读内容）。
     * root 传 '' 即全局画像（workspaces/_global/）。
     */
    portraitInfo(root) {
      return portraitInfoFor(root);
    },

    /**
     * 读画像：portrait.json 优先；缺失时回落解析 PORTRAIT.md（不落盘，persistent=false）。
     * 两份都没有时返回 null。
     */
    portrait(root) {
      return readPortraitFor(root);
    },

    /**
     * 保存画像（手动编辑 / 重写管线共用；实现见内部 savePortraitFor）。
     * 版本 +1；旧版落 portrait.history/v<N>.json（保留最近 PORTRAIT_HISTORY_LIMIT 版）；
     * 同步刷新 PORTRAIT.md 正本。
     */
    savePortrait(root, opts = {}) {
      return savePortraitFor(root, opts);
    },

    /** 画像版本列表（含当前版本；降序）。 */
    portraitHistory(root) {
      const info = portraitInfoFor(root);
      const out = [];
      const current = readPortraitFor(root);
      if (current && current.persistent) {
        out.push({ version: current.version, updatedAt: current.updatedAt, source: current.source, current: true });
      }
      try {
        for (const name of fs.readdirSync(info.historyDir)) {
          const m = name.match(/^v(\d+)\.json$/);
          if (!m) continue;
          const raw = readJson(path.join(info.historyDir, name), null);
          out.push({
            version: Number(m[1]),
            updatedAt: raw?.updatedAt || null,
            source: SOURCES.includes(raw?.source) ? raw.source : 'manual',
            current: false,
          });
        }
      } catch {
        /* 无历史目录 */
      }
      out.sort((a, b) => b.version - a.version);
      return out;
    },

    /** 读某个画像版本（当前版或历史快照）；不存在返回 null。 */
    portraitVersion(root, version) {
      const info = portraitInfoFor(root);
      const n = Number(version);
      if (!Number.isInteger(n) || n < 1) return null;
      const current = readPortraitFor(root);
      if (current?.persistent && current.version === n) return current;
      const raw = readJson(path.join(info.historyDir, `v${n}.json`), null);
      if (!raw) return null;
      const scope = raw.scope === 'global' ? 'global' : info.scope;
      const evidence = normalizePortraitEvidence(raw.evidence, { scope });
      return {
        ...raw,
        scope,
        evidence,
        sectionMeta: portraitSectionMeta(evidence, { scope }),
        persistent: true,
      };
    },

    /* ---------------- 日志层（journal） ---------------- */

    /**
     * 追加一条工作日志（append-only，只追加绝不改写旧内容）。
     * 文件按天分：journal/YYYY-MM-DD.md——低门槛流水账，是画像重写与蒸馏的上游原料。
     */
    journalAppend(root, { text = '', at = null } = {}) {
      const body = String(text ?? '').trim();
      if (!body) return { ok: false, error: 'empty' };
      const info = journalInfoFor(root);
      const time = at ? new Date(at) : new Date();
      const date = localDateString(time);
      const hhmm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
      const file = path.join(info.dir, `${date}.md`);
      const prev = readTextFile(file);
      const head = prev.trim() ? `${prev.replace(/\s+$/u, '')}\n` : `# ${date}\n`;
      const lines = body.split(/\r?\n/u);
      const entry = [`- ${hhmm} ${lines[0]}`];
      for (const line of lines.slice(1)) entry.push(line.trim() ? `  ${line}` : '');
      fs.mkdirSync(info.dir, { recursive: true });
      fs.writeFileSync(file, `${head}\n${entry.join('\n')}\n`, 'utf8');
      return { ok: true, date, time: hhmm, chars: body.length };
    },

    /** 读某天的日志原文（默认今天）。 */
    journalRead(root, { date = '' } = {}) {
      const info = journalInfoFor(root);
      const day = /^\d{4}-\d{2}-\d{2}$/u.test(String(date)) ? String(date) : localDateString(new Date());
      return { date: day, text: readTextFile(path.join(info.dir, `${day}.md`)) };
    },

    /** 有日志的日期列表（降序）。 */
    journalDates(root) {
      return journalDatesFor(journalInfoFor(root));
    },

    /* ---------------- 会话索引（溯源：按原文搜回当时那一轮） ---------------- */

    /**
     * 追加一条会话索引（每轮的用户发言原文，截断到 2000 字）。
     * 单文件 JSONL，超过 2000 行丢最老的——个人使用量级下这就是全部成本。
     */
    sessionLogAppend(root, { sessionId = '', turn = 0, text = '' } = {}) {
      /* 会话索引也是写入路径（D3）：先脱敏再落盘，别把用户贴进来的 token 原样存下来。 */
      const raw = String(text ?? '');
      const safe = securityFlag('redact') ? scanSecrets(raw).text : raw;
      const body = safe.replace(/\s+/gu, ' ').trim();
      if (body.length < 8) return { ok: false, error: 'too_short' };
      const info = sessionLogInfoFor(root);
      fs.mkdirSync(info.dir, { recursive: true });
      const lines = readJsonl(info.file);
      lines.push({
        at: new Date().toISOString(),
        sessionId: String(sessionId || ''),
        turn: Number(turn) || 0,
        text: clampText(body, 2000),
      });
      while (lines.length > 2000) lines.shift();
      fs.writeFileSync(info.file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
      return { ok: true, count: lines.length };
    },

    /** 会话检索：BM25 不至于，词重叠足够——返回当时的原话与 sessionId/turn。传 sessionId 时只在该会话内检索。 */
    sessionSearch({ workspace = '', query = '', limit = 8, sessionId = '' } = {}) {
      const info = sessionLogInfoFor(workspace);
      const wanted = String(sessionId ?? '').trim();
      const lines = readJsonl(info.file).filter(
        (entry) => !wanted || String(entry.sessionId || '') === wanted,
      );
      const trimmed = String(query ?? '').trim();
      if (!trimmed) {
        return lines
          .slice(-Math.max(1, limit))
          .reverse()
          .map((entry) => ({ ...entry, score: 0 }));
      }
      const tokens = new Set(uniqueTokens(trimmed));
      const scored = [];
      for (const entry of lines) {
        const entryTokens = new Set(uniqueTokens(entry.text));
        let score = 0;
        for (const token of tokens) if (entryTokens.has(token)) score += 1;
        if (!score) continue;
        scored.push({ entry, score: score / tokens.size });
      }
      return scored
        .sort((a, b) => b.score - a.score || String(b.entry.at).localeCompare(String(a.entry.at)))
        .slice(0, Math.max(1, limit))
        .map(({ entry, score }) => ({ ...entry, score: Number(score.toFixed(3)) }));
    },

    /* ---------------- 程序记忆晋升（记忆 → AGENTS.md） ---------------- */

    /**
     * 把一条 convention / decision / preference / feedback 晋升进工作区 AGENTS.md 的
     * 托管块（`<!-- dsh-memory:promoted -->`）。重复晋升不会产生重复行；
     * 块外的内容用户随便改，插件永不触碰。global 记忆不晋升（AGENTS.md 是工作区文件）。
     */
    promoteToAgents(root, { id = '' } = {}) {
      const target = normalizeRoot(root);
      if (!target) return { ok: false, error: 'global_scope' };
      if (!fs.existsSync(target)) return { ok: false, error: 'no_workspace' };
      const all = gather({ workspace: target, includeArchived: true, includeDrafts: true });
      const record = all.find((r) => r.id === id);
      if (!record) return { ok: false, error: 'not_found' };
      if (record.scope === 'global') return { ok: false, error: 'global_scope' };
      if (!['convention', 'decision', 'preference', 'feedback'].includes(record.category)) {
        return { ok: false, error: 'not_promotable' };
      }

      const file = path.join(target, 'AGENTS.md');
      const line = `- **${oneLine(record.title)}** — ${oneLine(record.content)}`;
      appendAgentsBlock(file, [line]);

      const updated = patchRecord(record.id, {
        promotedTo: 'AGENTS.md',
        promotedAt: new Date().toISOString(),
      }, { workspace: target });
      // 派生链：AGENTS.md 这一行是从这条记忆抄来的，源变了这里就该标脏。
      derivationUpsertFor(target, {
        layer: 'agents',
        target: `AGENTS.md#${record.id}`,
        sources: [memorySource(record)],
      });
      return { ok: true, file, line, record: updated?.record ?? null };
    },

    /**
     * 把画像里的一段（默认「协作约定」）晋升进 AGENTS.md。
     * 这是派生链的第二跳：AGENTS.md ← 画像 ← 记忆。
     * 画像那一段被改写时，AGENTS.md 里抄来的旧内容会被标脏。
     */
    promotePortraitToAgents(root, { section = 'preference' } = {}) {
      const target = normalizeRoot(root);
      if (!target) return { ok: false, error: 'global_scope' };
      if (!fs.existsSync(target)) return { ok: false, error: 'no_workspace' };
      const portrait = readPortraitFor(target);
      if (!portrait) return { ok: false, error: 'no_portrait' };
      const sec = (portrait.sections || []).find((s) => s.key === section);
      if (!sec || !sec.text) return { ok: false, error: 'no_section' };
      const lines = sec.text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => `- ${line}`);
      if (!lines.length) return { ok: false, error: 'no_section' };

      const file = path.join(target, 'AGENTS.md');
      appendAgentsBlock(file, lines);

      derivationUpsertFor(target, {
        layer: 'agents',
        target: `AGENTS.md#画像·${sec.title}`,
        sources: [portraitSource(section, portrait)],
        parent: derivationId('portrait', 'portrait'),
      });
      return { ok: true, file, lines, section: section, portraitVersion: portrait.version || 0 };
    },

    /** 最近 N 天的日志（{date, text}，降序）——画像重写与面板用。 */
    journalRecent(root, { days = 7 } = {}) {
      const info = journalInfoFor(root);
      const limit = Math.max(1, Math.min(90, Number(days) || 7));
      return journalDatesFor(info)
        .slice(0, limit)
        .map((date) => ({ date, text: readTextFile(path.join(info.dir, `${date}.md`)) }));
    },

    /* ---------------- 画像重写稿（draft） ---------------- */

    /** 存放一份待审的重写稿（rewriteMode=draft 的中间态，批准前对模型不可见）。 */
    portraitDraftWrite(root, { sections = [], evidence, basedOn = null } = {}) {
      const info = portraitInfoFor(root);
      const scope = info.scope;
      const nextEvidence = normalizePortraitEvidence(evidence, { scope });
      const draft = {
        schemaVersion: 1,
        scope,
        createdAt: now(),
        basedOn: basedOn || null,
        sections: normalizeSections(sections, { scope }),
        evidence: nextEvidence,
        sectionMeta: portraitSectionMeta(nextEvidence, { scope }),
      };
      fs.mkdirSync(path.dirname(info.draftFile), { recursive: true });
      writeJsonAtomic(info.draftFile, draft);
      return { ok: true, draft };
    },

    /** 读待审重写稿；没有返回 null。 */
    portraitDraftRead(root) {
      const info = portraitInfoFor(root);
      const raw = readJson(info.draftFile, null);
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sections)) return null;
      const evidence = normalizePortraitEvidence(raw.evidence, { scope: info.scope });
      return {
        scope: info.scope,
        createdAt: raw.createdAt || null,
        basedOn: raw.basedOn || null,
        sections: normalizeSections(raw.sections, { scope: info.scope }),
        evidence,
        sectionMeta: portraitSectionMeta(evidence, { scope: info.scope }),
      };
    },

    /** 清掉待审重写稿（批准或丢弃后调用）。 */
    portraitDraftClear(root) {
      const info = portraitInfoFor(root);
      try {
        fs.rmSync(info.draftFile);
      } catch {
        /* 本就不存在 */
      }
      return { ok: true };
    },

    /** 强制丢弃内存缓存（设置面板刷新 / 手工改了 json 之后）。 */
    invalidate(root) {
      if (root === undefined) cache.clear();
      else cache.delete(folderFor(root));
    },

    /* ---------------- 整库快照（后悔药） ---------------- */

    /** 立刻做一次整库快照；返回 { ok, name, files, bytes, removed }，失败不抛。 */
    snapshotLibrary(options = {}) {
      return snapshotLibrary(options);
    },

    /** 现有快照清单，新的在前。名字即时间戳，可按字典序排。 */
    snapshots({ limit = 20 } = {}) {
      try {
        if (!fs.existsSync(backupsDir)) return [];
        const max = Math.max(1, Math.min(200, Number(limit) || 20));
        return fs
          .readdirSync(backupsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => {
            const usage = dirUsage(path.join(backupsDir, entry.name));
            return { name: entry.name, bytes: usage.bytes, files: usage.files };
          })
          .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
          .slice(0, max);
      } catch {
        return [];
      }
    },

    /** 快照目录（面板只读展示用，不暴露父目录）。 */
    snapshotRoot() {
      return backupsDir;
    },

    /* ---------------- 维护台账：启动整理 ---------------- */

    /** 维护台账：上次自动 / 手动整理时间、最近一次摘要、最近 10 次记录。 */
    maintenanceState(workspace = '') {
      return readMaintenance(workspace);
    },

    /**
     * 记一次整理。auto 只更新 lastAutoAt，manual 只更新 lastManualAt；
     * 两者都更新 lastReport / runs，面板据此显示「上次自动整理 / 下次到期」。
     * 台账只写本工作区数据目录，不碰工作区镜像（D2）。
     */
    noteMaintenance(workspace = '', entry = {}) {
      const info = maintenanceInfoFor(workspace);
      const prev = readMaintenance(workspace);
      const at = typeof entry.at === 'string' && entry.at ? entry.at : now();
      const source = entry.source === 'manual' ? 'manual' : 'auto';
      const report = entry.report && typeof entry.report === 'object' ? entry.report : null;
      const next = {
        schemaVersion: 1,
        lastAt: at,
        lastSource: source,
        lastAutoAt: source === 'auto' ? at : prev.lastAutoAt,
        lastManualAt: source === 'manual' ? at : prev.lastManualAt,
        lastReport: report,
        runs: [{ at, source, report }, ...prev.runs].slice(0, 10),
      };
      writeJsonAtomic(info.file, next);
      return next;
    },

    renderMarkdown(workspace) {
      return renderMarkdown(gather({ workspace, includeArchived: true }), {
        root: workspace,
        portrait: readPortraitFor(workspace),
      });
    },
  };
}

export default { createMemoryStore, workspaceKey, defaultRoot, CATEGORIES, CATEGORY_LABELS };

