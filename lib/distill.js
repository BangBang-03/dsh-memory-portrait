/**
 * dsh-memory — 轮次内容 → 长期记忆候选（提炼层）。
 *
 * 纯函数，不依赖 DSH：给定一段对话文本，构造提炼提示词、解析模型返回、
 * 以及判断「这一轮值不值得提炼」。测试见 test/distill.test.mjs。
 */

import { CATEGORIES } from './store.js';

/** 提炼提示词（系统侧）。要求模型只输出 JSON。 */
export const DISTILL_SYSTEM = [
  'You maintain a coding agent\'s long-term memory for ONE workspace.',
  'Read the conversation excerpt and extract only DURABLE knowledge that stays true beyond this session.',
  '',
  'Extract when it is:',
  '- a user preference or working style ("always answer in Chinese", "prefer pnpm over npm")',
  '- a project convention or architecture decision and its reason',
  '- a stable fact about the codebase, environment, tooling or paths',
  '- a reusable gotcha, workaround, or hard-won lesson',
  '- an open commitment or TODO that outlives the session',
  '- feedback about how the agent should work: a correction ("no, do X instead") or a confirmed',
  '  approach ("yes, exactly") — anything that should shape future behavior',
  '- a HARD BAN the user imposed ("never commit .env", "绝对不要 force push"): category MUST be',
  '  "constraint". Only the user\'s own explicit prohibitions qualify — never invent one from the',
  '  agent\'s own caution',
  '',
  'Do NOT extract:',
  '- what the agent did in this turn (edits, commands, file reads)',
  '- transient state, one-off debugging output, or anything already resolved',
  '- secrets, tokens, credentials, personal data',
  '- restatements of the conversation itself',
  '',
  'Rules:',
  '- Never invent facts. If the excerpt holds nothing durable, return an empty list.',
  '- One fact per entry. Prefer 0-4 entries; fewer and sharper beats many and vague.',
  '- Write each entry in the SAME language the user used.',
  '- "title" is one short line (<= 60 chars). "content" is the standalone fact with enough',
  '  context that it is still useful months later, without the conversation.',
  `- "category" is exactly one of: ${CATEGORIES.join(', ')}.`,
  '  Use "feedback" for corrections/confirmations about working style, and structure their content',
  '  as: the rule, then a **Why:** line (the incident or strong preference behind it), then a',
  '  **How to apply:** line. Use "user" for durable facts about who the user is (role, goals,',
  '  expertise) — those apply across every workspace. Use "constraint" ONLY for the user\'s hard',
  '  bans: keep the user\'s wording of the ban verbatim in the title, and put scope/context',
  '  (when it was said, what it covers) in the content — never soften or paraphrase a ban.',
  '- "keywords" is 3-6 short retrieval keywords (mixed language is fine) for finding this memory',
  '  later; do not repeat the title verbatim.',
  '- "supersedes": if the excerpt clearly CONTRADICTS one of the already-stored memories listed',
  '  below (the situation changed, the old conclusion is wrong now), set "supersedes" to that',
  '  memory\'s id and write the NEW state as the entry. Only supersede on a genuine contradiction;',
  '  never merely to rephrase or extend. At most one supersede per entry.',
  '- "confidence" is 0..1: how sure you are that this is durable and correct.',
  '',
  'Answer with ONLY a JSON object, no prose, no code fence:',
  '{"memories":[{"title":"...","content":"...","category":"fact","tags":["..."],',
  '"keywords":["..."],"supersedes":null,"confidence":0.8}]}',
].join('\n');

/**
 * 构造用户侧输入。用 JSON 包裹，防止对话里的文字破坏结构分隔符。
 * 已有记忆（id + 标题）一并给出：一是要求不重复，二是让「情况已变」的条目能引用 id 走 supersede。
 */
export function buildDistillInput({ workspace = '', transcript = '', existingTitles = [], existingRecords = [] } = {}) {
  const parts = [];
  parts.push(`Workspace: ${workspace || '(unknown)'}`);
  const records = existingRecords.length
    ? existingRecords
    : existingTitles.map((title) => ({ id: '', title }));
  if (records.length) {
    parts.push(
      `Already stored (do NOT repeat these; set "supersedes" to the id ONLY if the excerpt proves one wrong):\n${records
        .slice(0, 24)
        .map((r) => `- ${r.title}${r.id ? ` (id=${r.id})` : ''}`)
        .join('\n')}`,
    );
  }
  parts.push(`Conversation excerpt (JSON array of {role, text}):\n${transcript}`);
  parts.push('Return the JSON object now.');
  return parts.join('\n\n');
}

/**
 * 从模型的自由文本里抽出 JSON 对象。
 * 容忍 ```json 围栏、前后解释性文字、以及尾部截断。
 */
export function extractJson(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return null;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(raw);

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object') return value;
    } catch {
      /* 尝试下一个候选 */
    }
  }
  return null;
}

/**
 * 把模型输出解析成记忆候选数组。永远返回数组，绝不抛错。
 * 每条候选都会被裁剪到合理长度；非法类别回落到 note；置信度过低会被丢弃；
 * `user` 类别强制 scope=global（画像跟人走）；`supersedes` 原样带出，由调用方解析成 id。
 */
export function parseDistillResponse(text, { minConfidence = 0.35, max = 8 } = {}) {
  const parsed = extractJson(text);
  if (!parsed) return [];

  let list = parsed.memories ?? parsed.memory ?? parsed.items ?? parsed;
  if (!Array.isArray(list)) list = [list];

  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const title = String(item.title ?? item.name ?? '').trim();
    const content = String(item.content ?? item.text ?? item.detail ?? '').trim();
    if (!title && !content) continue;

    let confidence = Number(item.confidence);
    if (!Number.isFinite(confidence)) confidence = 0.7;
    confidence = Math.min(1, Math.max(0, confidence));
    if (confidence < minConfidence) continue;

    const category = CATEGORIES.includes(item.category) ? item.category : 'note';
    const tags = asStringList(item.tags, 6);
    const keywords = asStringList(item.keywords, 8);
    const supersedes = String(item.supersedes ?? '').trim() || null;

    out.push({
      title: (title || content).slice(0, 160),
      content: (content || title).slice(0, 4000),
      category,
      tags,
      keywords,
      supersedes,
      // 用户画像不属于任何一个工作区，落库时强制全局。
      scope: category === 'user' ? 'global' : 'workspace',
      confidence,
    });
    if (out.length >= max) break;
  }
  return out;
}

function asStringList(value, limit) {
  const arr = Array.isArray(value) ? value : typeof value === 'string' && value.trim() ? [value] : [];
  return arr
    .map((t) => String(t ?? '').trim())
    .filter(Boolean)
    .slice(0, limit);
}

/**
 * 插件自己注入的「召回块」也是 user 角色，但它们是记忆正文，不是用户发言。
 * 不排掉会同时污染三处：轮末召回拿它当查询（自我召回）、会话索引把它写成本轮原话、
 * 自动提炼把它当新材料再喂给模型（一条记忆被反复计费）。
 *
 * source.kind 是首选判据；宿主某些派生路径会丢 source，所以再认一次固定标题。
 */
export const INJECTED_CONTEXT_KIND = 'dsh-memory';
const INJECTED_CONTEXT_MARKERS = [
  '### 与当前话题相关的召回（尾部注入）',
  '### 相关记忆（按文件触达）',
];

export function isInjectedContext(message) {
  if (!message || typeof message !== 'object') return false;
  const kind = message.source?.kind;
  // 有明确来源就信来源：别的插件 / 真实用户消息不该被标题误伤。
  if (typeof kind === 'string' && kind) return kind === INJECTED_CONTEXT_KIND;
  const text = messageText(message).trimStart();
  return INJECTED_CONTEXT_MARKERS.some((marker) => text.startsWith(marker));
}

/** 渲染一条派生消息为纯文本；非文本块被忽略。（轮末召回与摘录共用。） */
export function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const chunks = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') chunks.push(block.text);
    else if (block.type === 'tool-call' && block.name) chunks.push(`[tool ${block.name}]`);
    else if (block.type === 'tool-result' || block.type === 'tool_result') chunks.push('[tool result]');
  }
  return chunks.join('\n');
}

/**
 * 取派生消息尾部的对话内容，渲染成 `{role, text}` 的 JSON。
 * 预算不够时从头部裁剪，保留最近的对话。
 */
export function selectTranscript(messages = [], { maxChars = 6000, maxMessages = 40 } = {}) {
  if (!Array.isArray(messages)) return '[]';
  const normalized = [];
  for (const message of messages) {
    const role = message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    if (isInjectedContext(message)) continue;
    const text = messageText(message).trim();
    if (!text) continue;
    normalized.push({ role, text });
  }

  const tail = normalized.slice(-maxMessages);
  const kept = [];
  let used = 0;
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const item = tail[i];
    const remaining = Math.max(0, maxChars - used);
    if (item.text.length > remaining) {
      /*
       * 至少保留最新一条（否则摘录为空、提炼直接失效），但必须截断到预算内。
       * 不截断的话，一条 50KB 的代码回复会让这一次提炼的输入比预算大一个数量级。
       */
      if (kept.length === 0 && remaining > 0) {
        const text = remaining > 1 ? `${item.text.slice(0, remaining - 1)}…` : item.text.slice(0, remaining);
        kept.unshift({ role: item.role, text });
        used += text.length;
      }
      break;
    }
    kept.unshift(item);
    used += item.text.length;
  }
  return JSON.stringify(kept);
}

/**
 * 判断这一轮是否值得花一次模型调用去提炼。
 * 目的：避免在「跑个命令看看」这种琐碎轮次上浪费 token。
 *
 * 只看**当前轮**（最后一条真实用户消息及其之后的回复），不看整段历史：
 * 历史只会越来越长，按全量算的话第一轮之后每轮都过闸，自动提炼会变成每 60 秒一次的固定开销。
 * 插件自己注入的召回块不计入素材，否则一段 800 字的背景记忆就能把琐碎轮次顶过门槛。
 */
export function shouldDistill(messages = [], { minChars = 600, minUserChars = 40 } = {}) {
  if (!Array.isArray(messages)) return { distill: false, total: 0, userChars: 0 };
  const visible = messages.filter((message) => !isInjectedContext(message));
  let lastUser = -1;
  for (let i = visible.length - 1; i >= 0; i -= 1) {
    if (visible[i]?.role === 'user' && messageText(visible[i]).trim()) {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return { distill: false, total: 0, userChars: 0 };

  let total = 0;
  let userChars = 0;
  for (const message of visible.slice(lastUser)) {
    const text = messageText(message).trim();
    if (!text) continue;
    total += text.length;
    if (message?.role === 'user') userChars += text.length;
  }
  return { distill: total >= minChars && userChars >= minUserChars, total, userChars };
}

/** 从对话文本里粗提「可能是长期事实」的显式信号词，用于给 UI 提示。 */
export const EXPLICIT_HINTS = [
  '记住',
  '牢记',
  '以后都',
  '以后请',
  '从现在起',
  '不要再',
  '总是',
  '永远',
  '绝对不要',
  '绝不',
  '任何情况都不',
  '我的偏好',
  '我们的约定',
  'remember',
  'always',
  'never',
  'from now on',
  'keep in mind',
  "don't forget",
];

export function hasExplicitHint(text) {
  const lower = String(text == null ? '' : text).toLowerCase();
  return EXPLICIT_HINTS.some((hint) => lower.includes(hint.toLowerCase()));
}

export default {
  DISTILL_SYSTEM,
  buildDistillInput,
  extractJson,
  messageText,
  parseDistillResponse,
  selectTranscript,
  shouldDistill,
  hasExplicitHint,
};
