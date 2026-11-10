/**
 * dsh-memory — 画像层（portrait）纯逻辑。
 *
 * 画像 = 每工作区 / 全局各一份、由「重写式合并」滚动维护的叙事文档。
 * 条目层只存「不会过期」的知识与坑；画像层承担「现在是什么样」。
 *
 * 本模块只做纯函数：段落模型、Markdown 渲染 / 解析、注入渲染与预算截断。
 * 读写（含版本快照与 PORTRAIT.md 同步）在 lib/store.js 的 portrait* 方法；
 * 重写管线（LLM）见设计稿 P1。测试见 test/portrait.test.mjs。
 */

import { clampText } from './text.js';

/** 固定四段；key 稳定，title 按 scope 取（global 版第二段叫「个人背景」）。 */
export const PORTRAIT_SECTIONS = [
  { key: 'background', title: '工作背景', globalTitle: '工作背景' },
  { key: 'preference', title: '协作约定', globalTitle: '个人背景' },
  { key: 'focus', title: '当前关注', globalTitle: '当前关注' },
  { key: 'recent', title: '近期动态', globalTitle: '近期动态' },
];

/** 版本快照保留上限。 */
export const PORTRAIT_HISTORY_LIMIT = 10;

/** 单段正文上限。 */
const SECTION_MAX = 4000;

/** 该 scope 下的四段定义（{key, title}）。 */
export function sectionsFor(scope = 'workspace') {
  const field = scope === 'global' ? 'globalTitle' : 'title';
  return PORTRAIT_SECTIONS.map((s) => ({ key: s.key, title: s[field] }));
}

/**
 * 画像证据：section key -> 引用列表（mem_… / journal:YYYY-MM-DD / session:…）。
 * 只保留固定四段，去重、裁剪，防止模型输出把画像撑爆。
 */
export function normalizePortraitEvidence(input = {}, { scope = 'workspace' } = {}) {
  const keys = new Set(sectionsFor(scope).map((s) => s.key));
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const [key, value] of Object.entries(src)) {
    if (!keys.has(key)) continue;
    const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    const refs = [];
    const seen = new Set();
    for (const raw of list) {
      const ref = String(raw ?? '').trim();
      if (!ref || ref.length > 160 || seen.has(ref)) continue;
      seen.add(ref);
      refs.push(ref);
      if (refs.length >= 12) break;
    }
    if (refs.length) out[key] = refs;
  }
  return out;
}

/** 每段的证据计数与「未溯源」标记；旧画像没有 evidence 时全部标未溯源。 */
export function portraitSectionMeta(evidence = {}, { scope = 'workspace' } = {}) {
  const normalized = normalizePortraitEvidence(evidence, { scope });
  const out = {};
  for (const def of sectionsFor(scope)) {
    const count = (normalized[def.key] || []).length;
    out[def.key] = { evidenceCount: count, untraced: count === 0 };
  }
  return out;
}

/**
 * 把任意输入归一成固定四段（缺失补空、未知忽略、标题统一按 scope）。
 * 输入支持：[{key?,title?,text?}] / {key: text} / {title: text}。
 */
export function normalizeSections(input, { scope = 'workspace' } = {}) {
  const defs = sectionsFor(scope);
  const byKey = new Map(defs.map((s) => [s.key, s]));
  const byTitle = new Map();
  for (const s of PORTRAIT_SECTIONS) {
    byTitle.set(s.title, s.key);
    byTitle.set(s.globalTitle, s.key);
  }

  const raw = Array.isArray(input)
    ? input
    : input && typeof input === 'object'
      ? Object.entries(input).map(([k, v]) => ({ key: k, text: v }))
      : [];

  const out = new Map();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const text = clampText(item.text ?? item.content ?? '', SECTION_MAX);
    let key = null;
    if (item.key && byKey.has(item.key)) key = item.key;
    else if (item.title && byTitle.has(String(item.title).trim())) key = byTitle.get(String(item.title).trim());
    if (!key || out.has(key)) continue;
    out.set(key, text);
  }
  return defs.map((s) => ({ key: s.key, title: s.title, text: out.get(s.key) ?? '' }));
}

/**
 * 解析 PORTRAIT.md 风格的 Markdown：`**段标题**` 起段，正文跟到下一段为止。
 * 返回 { scope, sections }；识别不出任何段时返回 null。
 */
export function parsePortraitMarkdown(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const keyByTitle = new Map();
  for (const s of PORTRAIT_SECTIONS) {
    keyByTitle.set(s.title, s.key);
    keyByTitle.set(s.globalTitle, s.key);
  }

  const found = new Map();
  let cur = null;
  let scope = null;
  for (const line of lines) {
    if (/^#\s*全局画像/.test(line)) scope = 'global';
    else if (/^#\s*工作区画像/.test(line) && !scope) scope = 'workspace';
    const m = line.match(/^\*\*(.+?)\*\*\s*$/);
    if (m) {
      const title = m[1].trim();
      const key = keyByTitle.get(title);
      if (key) {
        cur = { key, title, lines: [], evidence: [] };
        if (!found.has(key)) found.set(key, cur);
        continue;
      }
    }
    if (cur) {
      const ref = line.match(/^>\s*参考[:：]\s*(.+)$/u);
      if (ref) {
        for (const token of ref[1].split(/[、,，\s]+/u)) if (token) cur.evidence.push(token);
        continue;
      }
    }
    if (line.startsWith('#')) continue;
    if (cur) cur.lines.push(line);
  }
  if (!found.size) return null;

  /* 无 H1 标题时按段标题兜底：出现「个人背景」即全局版。 */
  if (!scope) {
    for (const item of found.values()) {
      if (item.title === '个人背景') {
        scope = 'global';
        break;
      }
    }
  }
  const resolved = scope || 'workspace';
  const sections = normalizeSections(
    [...found.values()].map((s) => ({ key: s.key, text: s.lines.join('\n').trim() })),
    { scope: resolved },
  );
  const evidence = {};
  for (const item of found.values()) {
    if (item.evidence.length) evidence[item.key] = item.evidence;
  }
  return {
    scope: resolved,
    sections,
    evidence: normalizePortraitEvidence(evidence, { scope: resolved }),
  };
}

/** 渲染 PORTRAIT.md 正本（人读）；内容与 portrait.json 同源。 */
export function renderPortraitMarkdown(portrait = {}, { scopeLabel = '' } = {}) {
  const scope = portrait.scope === 'global' ? 'global' : 'workspace';
  const sections = normalizeSections(portrait.sections, { scope });
  const evidence = normalizePortraitEvidence(portrait.evidence, { scope });
  const lines = [];
  lines.push(scope === 'global' ? '# 全局画像' : `# 工作区画像${scopeLabel ? ` — ${scopeLabel}` : ''}`);
  lines.push('');
  lines.push(
    `> 更新：${String(portrait.updatedAt || '').slice(0, 10)} ｜ 版本：v${portrait.version ?? 1} ｜ 由 dsh-memory 维护（portrait.json 的正本镜像）`,
  );
  lines.push('');
  for (const s of sections) {
    if (!s.text) continue;
    lines.push(`**${s.title}**`);
    lines.push('');
    lines.push(s.text);
    if (evidence[s.key]?.length) {
      lines.push('');
      lines.push(`> 参考：${evidence[s.key].join('、')}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}

function sectionCost(s) {
  return (s.title?.length || 0) + (s.text?.length || 0) + 8;
}

/** 单份画像的预算截断：按段累加，超预算的段截断（余量 >80 字符才保留），更后的段丢弃。 */
export function clampPortraitToBudget(sections = [], maxChars = 1200) {
  const out = [];
  let used = 0;
  let truncated = false;
  for (const s of sections) {
    if (!s.text) continue;
    const cost = sectionCost(s);
    if (used + cost <= maxChars) {
      out.push({ ...s });
      used += cost;
      continue;
    }
    const remain = maxChars - used - (s.title?.length || 0) - 8;
    if (remain > 80) {
      out.push({ ...s, text: `${String(s.text).slice(0, remain - 1)}…` });
      used += remain + (s.title?.length || 0) + 8;
    }
    truncated = true;
    break;
  }
  return { sections: out, chars: used, truncated };
}

/**
 * 渲染注入块：工作区 + 全局两份画像，合计受 maxChars 约束。
 * 预算分配：全局先取 min(600, 预算/3)（它通常更短），剩余给工作区（至少一半）。
 * 返回 { text, chars, truncated, hasWorkspace, hasGlobal }。
 */
export function renderPortraitInjection({ workspace = null, global = null, maxChars = 1400 } = {}) {
  const budget = Math.max(200, Math.floor(Number(maxChars) || 1400));
  const parts = [];
  let chars = 0;
  let truncated = false;

  let ws = null;
  let gl = null;
  if (global) {
    gl = clampPortraitToBudget(global.sections || [], Math.min(600, Math.floor(budget / 3)));
  }
  const wsCap = Math.max(budget - (gl ? gl.chars + 24 : 0), Math.floor(budget / 2));
  if (workspace) {
    ws = clampPortraitToBudget(workspace.sections || [], wsCap);
  }

  const render = (portrait, clamped, head) => {
    const body = clamped.sections
      .filter((s) => s.text)
      .map((s) => `**${s.title}**\n${s.text}`)
      .join('\n');
    if (!body) return null;
    return `${head}\n${body}`;
  };

  if (ws) {
    const block = render(workspace, ws, `### 工作区画像（v${workspace.version ?? 1}）`);
    if (block) {
      parts.push(block);
      chars += block.length + 2;
      truncated = truncated || ws.truncated;
    }
  }
  if (gl) {
    const block = render(global, gl, `### 全局画像（v${global.version ?? 1}）`);
    if (block) {
      parts.push(block);
      chars += block.length + 2;
      truncated = truncated || gl.truncated;
    }
  }
  if (!parts.length) return { text: '', chars: 0, truncated: false, hasWorkspace: false, hasGlobal: false };
  if (truncated) parts.push('（画像超出预算已截断，完整版见 设置 → 记忆。）');
  return {
    text: parts.join('\n\n'),
    chars,
    truncated,
    hasWorkspace: Boolean(ws && ws.sections.some((s) => s.text)),
    hasGlobal: Boolean(gl && gl.sections.some((s) => s.text)),
  };
}

/* ------------------------------------------------------------------ *
 * 重写管线（纯逻辑）：旧画像 + 日志 + 条目摘要 → 提示词；模型输出 → 四段。
 * ------------------------------------------------------------------ */

/** 重写管线的系统提示词（模型侧）。要求只输出 JSON。 */
export const REWRITE_SYSTEM = [
  "You maintain the rolling 'portrait' of a coding agent's long-term memory (one scope per call).",
  'Given the current portrait, recent journal entries, and a list of memory entries, REWRITE the portrait.',
  '',
  'Rules:',
  '- Keep the fixed sections; rewrite text WITHIN them, never append new sections or meta notes.',
  '- Merge durable facts from the material; correct what is outdated; compress redundancy.',
  '- Never invent facts. Only use what appears in the material provided.',
  '- Keep the same language as the material; plain markdown lines inside each section.',
  '- Stay close to the current portrait in length — rewrite, do not grow.',
  '- For every section, attach evidence copied from the material: memory ids (mem_…) or journal:YYYY-MM-DD.',
  '- Never invent an id; use an empty array for a section you cannot back with material.',
  '- Inside a string value, write a line break as the two characters \\n (backslash + n), never as a real newline.',
  '- Escape every double quote inside a string value with a backslash.',
  '',
  'Answer with ONLY a JSON object, no prose, no code fence:',
  '{"sections":[{"key":"background","text":"..."},{"key":"preference","text":"..."},{"key":"focus","text":"..."},{"key":"recent","text":"..."}],' +
    '"evidence":{"background":["mem_...","journal:2026-10-18"],"preference":[],"focus":[],"recent":[]}}',
].join('\n');

/**
 * 严格 JSON 重试提示词：第一次没按 JSON 输出时用。
 * 明确点名最容易犯的两个错（围栏、字符串里的裸换行），比重讲一遍规则管用。
 */
export const REWRITE_STRICT_SYSTEM = [
  REWRITE_SYSTEM,
  '',
  'Your previous answer could not be parsed as JSON. Answer again, and follow these rules exactly:',
  '- The first character of your reply must be { and the last character must be }.',
  '- No markdown, no code fence, no explanation before or after the JSON object.',
  '- No trailing comma after the last item of an object or an array.',
  '- Inside a string value, a line break must be written as the two characters \\n, never as a real newline.',
  '- Escape every double quote inside a string value with a backslash.',
].join('\n');

/** 把画像段落渲染成提示词里的「现状」部分。 */
export function renderProfileSections(sections, scope = 'workspace') {
  const body = normalizeSections(sections, { scope })
    .filter((s) => s.text)
    .map((s) => `**${s.title}**\n${s.text}`)
    .join('\n\n');
  return body || '(empty)';
}

/**
 * 构造「重写式合并」的提示词输入（user 侧文本）。
 * 原料 = 旧画像 + 最近日志 + 记忆条目摘要（标题级）；只允许使用给定材料，不许发明。
 */
export function buildRewriteInput({ scope = 'workspace', oldPortrait = null, journal = [], records = [] } = {}) {
  const defs = sectionsFor(scope);
  const keys = defs.map((s) => s.key);
  const parts = [];
  parts.push(
    [
      `Scope: ${scope}. Rewrite the profile below by MERGING in new material.`,
      `Rules:`,
      `- Keep the four fixed sections (keys: ${keys.join(', ')}); rewrite text WITHIN them, never add new sections.`,
      `- Incorporate durable facts from the journal and memory entries; correct what is outdated; compress redundancy.`,
      `- Never invent facts. Only use what appears in the material provided below.`,
      `- Keep the same language as the material; plain markdown lines inside each section.`,
      `- Attach evidence per section: memory ids exactly as given (id=mem_…), journal entries as journal:YYYY-MM-DD.`,
      `- Never invent an id; use [] when a section has no support in the material.`,
    ].join('\n'),
  );
  parts.push(`Current profile:\n${renderProfileSections(oldPortrait?.sections, scope)}`);
  if (Array.isArray(journal) && journal.length) {
    parts.push(
      `Journal (newest first):\n(cite journal entries as journal:YYYY-MM-DD)\n${journal
        .map((j) => `## ${j.date}\n${String(j.text || '').trim()}`)
        .join('\n\n')
        .slice(0, 6000)}`,
    );
  }
  if (Array.isArray(records) && records.length) {
    parts.push(
      `Memory entries (title — category — updated — id):\n${records
        .slice(0, 60)
        .map((r) => `- ${r.title} [${r.category}] ${String(r.updatedAt || '').slice(0, 10)} id=${r.id || 'mem_?'}`)
        .join('\n')}`,
    );
  }
  parts.push(
    `Answer with ONLY a JSON object: {"sections":[${keys
      .map((k) => `{"key":"${k}","text":"..."}`)
      .join(',')}],"evidence":{${keys.map((k) => `"${k}":[]`).join(',')}}}`,
  );
  return parts.join('\n\n');
}

/* ------------------------------------------------------------------ *
 * 画像 2.0：版本 diff
 *
 * 现在画像只有「整篇替换 + 版本快照」，用户看历史版本时只能自己逐字比对。
 * 这里补一层纯函数 diff：按段落做行级 LCS，输出 added / removed，
 * 供面板的「这次变了什么」横幅、版本回滚前的预览、以及以后的证据链使用。
 * ------------------------------------------------------------------ */

function splitSectionLines(text) {
  return String(text == null ? '' : text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** 行级 LCS diff；返回按出现顺序的 added / removed。 */
function lineDiff(before, after) {
  const a = splitSectionLines(before);
  const b = splitSectionLines(after);
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const removed = [];
  const added = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      removed.push(a[i]);
      i += 1;
    } else {
      added.push(b[j]);
      j += 1;
    }
  }
  while (i < m) removed.push(a[i++]);
  while (j < n) added.push(b[j++]);
  return { added, removed };
}

/**
 * 对比两份画像段落，返回逐段变化。
 * 返回：{ scope, sections:[{key,title,added,removed,changed}], changed:[...], summary }
 */
export function diffPortraitSections(beforeSections = [], afterSections = [], { scope = 'workspace' } = {}) {
  const before = new Map(normalizeSections(beforeSections, { scope }).map((s) => [s.key, s]));
  const after = new Map(normalizeSections(afterSections, { scope }).map((s) => [s.key, s]));
  const sections = sectionsFor(scope).map((def) => {
    const prev = before.get(def.key)?.text || '';
    const next = after.get(def.key)?.text || '';
    const { added, removed } = lineDiff(prev, next);
    return { key: def.key, title: def.title, added, removed, changed: added.length + removed.length };
  });
  const changed = sections.filter((s) => s.changed > 0);
  const summary = changed.length
    ? changed.map((s) => `${s.title} +${s.added.length} −${s.removed.length}`).join('；')
    : '无变化';
  return { scope, sections, changed, summary };
}

/** 把 diff 渲染成人类可读的 Markdown；默认跳过无变化的段。 */
export function renderPortraitDiff(diff, { includeUnchanged = false } = {}) {
  const scope = diff?.scope === 'global' ? 'global' : 'workspace';
  const list = Array.isArray(diff?.sections) ? diff.sections : [];
  const lines = [`### 画像变化（${scope === 'global' ? '全局' : '工作区'}）`];
  const shown = list.filter((s) => includeUnchanged || s.changed > 0);
  if (!shown.length) {
    lines.push('');
    lines.push('（无变化）');
    return `${lines.join('\n')}\n`;
  }
  for (const section of shown) {
    lines.push('');
    lines.push(`**${section.title}**${section.changed ? `（+${section.added.length} −${section.removed.length}）` : '（无变化）'}`);
    for (const line of section.removed) lines.push(`- ~~${line}~~`);
    for (const line of section.added) lines.push(`+ ${line}`);
  }
  return `${lines.join('\n')}\n`;
}

/** 一行摘要，给面板横幅/日志用；无变化时返回空串，方便 `if (line)`。 */
export function portraitChangeLine(diff) {
  const changed = Array.isArray(diff?.changed) ? diff.changed : [];
  if (!changed.length) return '';
  return changed.map((s) => `${s.title} +${s.added.length} −${s.removed.length}`).join('；');
}

/* ------------------------------------------------------------------ *
 * 模型输出的容错解析
 *
 * 模型吐 JSON 的常见翻车形态（按真实发生频率排）：
 *   1) 字符串里敲了裸换行 / 制表符 —— 画像正文是 markdown 列表，最容易犯；
 *   2) 对象或数组末尾留了逗号；
 *   3) 输出被 maxTokens 截断，尾部半个元素没写完；
 *   4) 字符串里的直引号没转义（中文引号没问题，直引号有问题）。
 *
 * 1) 2) 是无损的：修完直接用。3) 4) 有损：修完要在面板上标明，并且改送待审，
 * 不允许静默覆盖用户手写的画像（degraded 字段就是给调用方看的信号）。
 * ------------------------------------------------------------------ */

/** JSON 解析一次，失败返回 null。 */
function tryParseJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * 无损修复 JSON 文本：字符串字面量里的裸控制字符转义掉、对象 / 数组尾逗号去掉。
 * 键值与顺序都不动。返回 { text, fixes }；fixes 里有 'chars' / 'commas'。
 */
function repairJson(text) {
  const src = String(text ?? '');
  let out = '';
  let inString = false;
  let escaped = false;
  const fixes = new Set();
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (ch === '\n') {
        out += '\\n';
        fixes.add('chars');
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        fixes.add('chars');
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        fixes.add('chars');
        continue;
      }
      if (code < 0x20) {
        out += `\\u${code.toString(16).padStart(4, '0')}`;
        fixes.add('chars');
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j += 1;
      if (src[j] === '}' || src[j] === ']') {
        fixes.add('commas');
        continue;
      }
    }
    out += ch;
  }
  return { text: out, fixes: [...fixes] };
}

/** 扫一遍 JSON 文本的括号 / 字符串状态。 */
function scanJson(text) {
  const src = String(text ?? '');
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  const stack = [];
  const commas = [];
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      stringStart = i;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch);
      continue;
    }
    if (ch === '}' || ch === ']') {
      stack.pop();
      continue;
    }
    if (ch === ',') commas.push(i);
  }
  return { stack, inString, stringStart, commas, truncated: stack.length > 0 || inString };
}

/** 原文里配平的顶层 {…} 片段（字符串感知，免得被正文里的花括号带偏）。 */
function balancedSpans(raw) {
  const src = String(raw ?? '');
  const spans = [];
  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        spans.push(src.slice(start, i + 1));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return spans;
}

/** 模型输出里所有可能的 JSON 片段：所有围栏块、原文、配平的 {…} 段。 */
function jsonCandidates(raw) {
  const out = [];
  const push = (value) => {
    const text = String(value ?? '').trim();
    if (text && !out.includes(text)) out.push(text);
  };
  for (const match of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)) push(match[1]);
  push(raw);
  for (const span of balancedSpans(raw)) push(span);
  return out;
}

/**
 * 把被截断的 JSON 补齐：按「尽量保住已写出的内容」的顺序给出几个候选。
 * 没截断就返回空数组。
 */
function closeTruncatedJson(text) {
  const src = String(text ?? '');
  const state = scanJson(src);
  if (!state.truncated) return [];

  const build = (head) => {
    const headState = scanJson(head);
    let body = head;
    let tail = '';
    if (headState.inString) {
      /* 末尾若是半个转义（奇数个反斜杠），先去掉，否则补上的引号会把它吃掉。 */
      const dangling = body.match(/(\\+)$/);
      if (dangling && dangling[1].length % 2 === 1) body = body.slice(0, -1);
      tail += '"';
    }
    for (let i = headState.stack.length - 1; i >= 0; i -= 1) {
      tail += headState.stack[i] === '{' ? '}' : ']';
    }
    return body + tail;
  };

  const out = [build(src)];
  if (state.commas.length) out.push(build(src.slice(0, state.commas[state.commas.length - 1])));
  if (state.inString) {
    const inner = src.slice(state.stringStart);
    const idx = inner.lastIndexOf(',');
    if (idx >= 0) out.push(build(src.slice(0, state.stringStart + idx)));
  }
  return out;
}

/** 抢救式提取：JSON 彻底坏掉时，直接按 key/text 抓四段正文（有损）。 */
function salvageRewriteSections(text, { scope = 'workspace' } = {}) {
  const src = String(text ?? '');
  const sections = [];
  for (const def of sectionsFor(scope)) {
    const re = new RegExp(
      `"key"\\s*:\\s*"${def.key}"[\\s\\S]{0,160}?"text"\\s*:\\s*"([\\s\\S]*?)"(?=\\s*[,}])`,
      'i',
    );
    const match = src.match(re);
    if (!match) continue;
    sections.push({ key: def.key, text: unescapeJsonish(match[1]) });
  }
  return sections.length ? sections : null;
}

/** 把抢救出来的正文里残留的 \n \t \" \\ 还原成真字符。 */
function unescapeJsonish(text) {
  return String(text ?? '').replace(/\\(n|r|t|"|\\)/g, (_, ch) => {
    if (ch === 'n') return '\n';
    if (ch === 'r') return '\r';
    if (ch === 't') return '\t';
    return ch;
  });
}

/**
 * 解析模型输出的重写结果 → { ok: true, sections, degraded } 或 { ok: false, error }。
 *
 * degraded: 'none' 干净解析 / 'repaired' 无损修复过 / 'truncated' 截断后抢救（有损）/
 *            'salvaged' 整体坏掉后按段抢救（有损）。有损的两种必须改送待审。
 */
export function parseRewriteResponse(text, { scope = 'workspace' } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, error: 'empty' };

  const candidates = jsonCandidates(raw);
  let parsed = null;
  let fallbackParsed = null;
  let degraded = 'none';
  const hasSections = (value) =>
    Boolean(
      value &&
        typeof value === 'object' &&
        Array.isArray(value.sections) &&
        value.sections.some((section) => String(section?.text ?? '').trim()),
    );

  for (const candidate of candidates) {
    const direct = tryParseJson(candidate);
    if (direct) {
      if (hasSections(direct)) {
        parsed = direct;
        break;
      }
      /* 普通 JSON 在前、真画像在后时不能被前一个截胡；先记下来供错误归因。 */
      fallbackParsed = fallbackParsed || direct;
      continue;
    }
    const fixed = repairJson(candidate);
    if (!fixed.fixes.length) continue;
    const value = tryParseJson(fixed.text);
    if (value) {
      if (!hasSections(value)) {
        fallbackParsed = fallbackParsed || value;
        continue;
      }
      parsed = value;
      degraded = 'repaired';
      break;
    }
  }

  if (!parsed) {
    /* 截断：把没写完的 JSON 补齐再试。 */
    for (const candidate of candidates) {
      for (const closed of closeTruncatedJson(candidate)) {
        const value = tryParseJson(repairJson(closed).text);
        if (!value) continue;
        if (!hasSections(value)) {
          fallbackParsed = fallbackParsed || value;
          continue;
        }
        parsed = value;
        degraded = 'truncated';
        break;
      }
      if (parsed) break;
    }
  }

  if (!parsed && fallbackParsed) parsed = fallbackParsed;

  if (!parsed) {
    /* 彻底坏掉：按段抢救。 */
    const salvaged = salvageRewriteSections(raw, { scope });
    if (salvaged) {
      const sections = normalizeSections(salvaged, { scope });
      if (sections.some((s) => s.text)) {
        return {
          ok: true,
          sections,
          evidence: {},
          sectionMeta: portraitSectionMeta({}, { scope }),
          degraded: 'salvaged',
        };
      }
    }
    /*
     * 到底算「截断」还是「压根没给 JSON」：散文里带个花括号不算截断。
     * 只有看着像 JSON（以 { 开头或提到 sections）却没写完，才报 truncated。
     */
    const looksLikeJson = /^\s*\{/u.test(raw) || raw.includes('"sections"');
    return { ok: false, error: scanJson(raw).truncated && looksLikeJson ? 'truncated' : 'no_json' };
  }

  const list = Array.isArray(parsed.sections) ? parsed.sections : null;
  if (!list) return { ok: false, error: degraded === 'truncated' ? 'truncated' : 'no_sections' };
  const sections = normalizeSections(list, { scope });
  if (!sections.some((s) => s.text)) {
    return { ok: false, error: degraded === 'truncated' ? 'truncated' : 'empty_sections' };
  }
  const evidence = normalizePortraitEvidence(parsed.evidence, { scope });
  return {
    ok: true,
    sections,
    evidence,
    sectionMeta: portraitSectionMeta(evidence, { scope }),
    degraded,
  };
}

export default {
  PORTRAIT_SECTIONS,
  PORTRAIT_HISTORY_LIMIT,
  REWRITE_SYSTEM,
  REWRITE_STRICT_SYSTEM,
  sectionsFor,
  normalizeSections,
  normalizePortraitEvidence,
  portraitSectionMeta,
  parsePortraitMarkdown,
  renderPortraitMarkdown,
  clampPortraitToBudget,
  renderPortraitInjection,
  renderProfileSections,
  buildRewriteInput,
  parseRewriteResponse,
  diffPortraitSections,
  renderPortraitDiff,
  portraitChangeLine,
};
