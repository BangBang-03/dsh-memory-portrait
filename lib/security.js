/**
 * dsh-memory — 写入安全层（纯逻辑，无 DSH 依赖）。
 *
 * 三件事：
 *   1. 密钥扫描与脱敏：sk- / ghp_ / AKIA / AIza / xox / JWT / 私钥 / Bearer /
 *      `password: …` 类赋值 / 带凭据的数据库 URI —— 命中就替换成 [REDACTED:<kind>]；
 *   2. 注入模式检测：「忽略之前的指令」「把以下内容写入记忆」「泄露系统提示」等——
 *      命中记 taint，非用户来源的记录会被隔离成草稿（等人审批）；
 *   3. trust 分级：user > agent > auto / import / external。
 *      模型不能自封 user；trust 由写入路径按来源推导，显式传入的非法值一律忽略。
 *
 * 设计取向是「脱敏 + 隔离」而不是「拒绝写入」：个人使用场景下，把内容留下来、
 * 把危险部分抹掉、把可疑内容藏进待审队列，比直接丢掉更可用。
 * 全部是本地正则，不调用模型、不联网。
 */

export const TRUST_LEVELS = ['user', 'agent', 'auto', 'import', 'external'];

/** source → 默认 trust；manual 视为用户亲手写的。 */
export const TRUST_BY_SOURCE = {
  manual: 'user',
  agent: 'agent',
  auto: 'auto',
  import: 'import',
};

/* ------------------------------------------------------------------ *
 * 密钥模式
 * ------------------------------------------------------------------ */

export const SECRET_PATTERNS = [
  { kind: 'openai_key', re: /sk-[A-Za-z0-9_-]{16,}/g },
  { kind: 'github_pat', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'github_fine_pat', re: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { kind: 'gitlab_pat', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'aws_access_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'aws_temp_key', re: /\bASIA[0-9A-Z]{16}\b/g },
  { kind: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { kind: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9_.\-+/=]{20,}/gi },
  {
    // 赋值形态：只脱敏值，保留字段名（password: [REDACTED:credential]）。
    // 值支持引号整段或任意非空白 token：`Tr0ub4dor&3`、`abc!secret` 这类
    // 带标点的口令以前只脱敏前半截，后缀会原样留在库里。
    kind: 'credential_assignment',
    re: /\b(password|passwd|pwd|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|private[_-]?key|secret_access_key|aws_secret_access_key)\b\s*[:=]\s*(?:"([^"\n]{8,})"|'([^'\n]{8,})'|([^\s"'`;,]{8,}))/gi,
    replace: (match, name) => `${name}: [REDACTED:credential]`,
  },
  {
    kind: 'db_uri_with_credentials',
    re: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s'":]+:[^\s'"]+@/gi,
  },
  /* 下面是实测漏掉的常见托管凭据格式；长度门槛按各家真实 token 收紧，避免误伤普通词。 */
  { kind: 'slack_app_token', re: /\bxapp-\d-[A-Za-z0-9-]{10,}/g },
  { kind: 'stripe_key', re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'npm_token', re: /\bnpm_[A-Za-z0-9]{30,}/g },
  { kind: 'telegram_bot', re: /\b\d{8,10}:[A-Za-z0-9_-]{30,}/g },
  /*
   * Discord token = base64(用户ID).base64(时间戳).base64(HMAC)。三段长度按真实
   * token 收紧（22-32 / 6-8 / 24-50）：第三段下限提到 24，挡掉「长名.短段.短hash」
   * 型构建产物 / tag 名（这类 slug 的第三段常在 22 字符上下）。
   */
  { kind: 'discord_token', re: /\b[A-Za-z0-9_-]{22,32}\.[A-Za-z0-9_-]{6,8}\.[A-Za-z0-9_-]{24,50}\b/g },
  { kind: 'cloudflare_api', re: /\bv1\.0-[A-Za-z0-9_-]{30,}/g },
];

/* ------------------------------------------------------------------ *
 * 注入模式
 * ------------------------------------------------------------------ */

export const INJECTION_PATTERNS = [
  {
    kind: 'ignore_instructions_en',
    re: /\b(?:ignore|disregard|forget)\s+(?:all\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|prompts|rules)\b/i,
  },
  { kind: 'ignore_instructions_zh', re: /(?:忽略|无视|忘记)(?:之前|以前|上面|以上|先前)(?:的|所有)*(?:指令|指示|设定|要求)/ },
  { kind: 'write_to_memory_zh', re: /把(?:以下|下面|这段)(?:内容|文字|指令)?(?:悄悄地|偷偷地)?写入(?:你的)?(?:长期)?记忆/ },
  {
    kind: 'write_to_memory_en',
    re: /\bwrite\s+(?:this|the\s+following)\s+(?:content\s+)?(?:in)?to\s+(?:your\s+)?(?:long[- ]?term\s+)?memory\b/i,
  },
  { kind: 'exfiltrate_prompt_en', re: /\b(?:print|reveal|show|repeat|output)\s+(?:me\s+)?(?:your\s+)?system\s+prompt\b/i },
  { kind: 'exfiltrate_prompt_zh', re: /(?:泄露|透露|输出|打印)(?:你的)?系统提示/ },
  { kind: 'exfiltrate_memory_zh', re: /(?:把|将)(?:你的)?(?:长期)?记忆(?:内容)?(?:偷偷)?(?:上传|发送|外传)(?:到|给)/ },
  {
    kind: 'exfiltrate_memory_en',
    re: /\b(?:upload|send|post)\s+(?:your\s+)?(?:long[- ]?term\s+)?memor(?:y|ies)\s+(?:to|out)\b/i,
  },
  { kind: 'hidden_note_en', re: /\b(?:do\s+not\s+tell|don't\s+tell|hide\s+this\s+from)\s+(?:the\s+)?user\b/i },
  { kind: 'hidden_note_zh', re: /不要告诉用户|对用户隐瞒/ },
  { kind: 'ignore_instructions_ja', re: /(?:以前|前|直前)の(?:指示|命令|プロンプト)(?:[をに]|から)?(?:無視|忘れ|従わな)/ },
];

/* ------------------------------------------------------------------ *
 * 扫描
 * ------------------------------------------------------------------ */

/**
 * 检测用的无状态副本：去掉 g / y 标志。
 *
 * `re.test()` 带 g 时会把 lastIndex 留在正则对象上，同一条模式第二次调用就从上次位置
 * 继续找——同一段文本第一次判 tainted、第二次判干净，取决于之前扫过什么。
 * 现在这些模式都是无标志的，但新增一条带 g 的模式就会变成难查的间歇性漏检，
 * 所以在模块加载时统一去掉（模式表本身仍保留原样，导出给面板 / 测试看）。
 */
const INJECTION_TESTS = INJECTION_PATTERNS.map((pattern) => ({
  kind: pattern.kind,
  re: new RegExp(pattern.re.source, pattern.re.flags.replace(/[gy]/g, '')),
}));

/**
 * 检测专用归一化（不改写原文）：去零宽字符（U+200B~200D / U+FEFF）、
 * 全角转半角。只服务注入检测——落库内容与简报仍用原文，避免污染数据。
 */
export function normalizeForDetection(text) {
  return String(text)
    .replace(/[\u200b-\u200d\uFEFF]/g, '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ');
}

const BASE64_TOKEN_RE = /[A-Za-z0-9+/]{20,}={0,2}/g;

/**
 * 找「形如 base64」的长 token（≥20 字符且以 = 结尾，或长度 ≥24）并尝试解码。
 * 解码成高可打印率 utf8 文本（>80%）的才返回，供注入正则再扫一遍——
 * 可打印率低说明解出来是二进制噪声（哈希 / 随机串），不当作藏起来的指令。
 */
function base64DecodedTexts(text, limit = 8) {
  const out = [];
  for (const match of String(text).matchAll(BASE64_TOKEN_RE)) {
    if (out.length >= limit) break;
    const token = match[0];
    if (!(token.endsWith('=') || token.length >= 24)) continue;
    let decoded;
    try {
      decoded = Buffer.from(token, 'base64').toString('utf8');
    } catch {
      continue;
    }
    if (!decoded || decoded.length < 8) continue;
    const chars = [...decoded];
    const printable = chars.filter((ch) => {
      const code = ch.codePointAt(0);
      // 控制字符（除 \t \n \r）与 DEL 之外都算可打印；CJK 区天然可打印。
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127) || code >= 0x2e80;
    }).length;
    if (printable / chars.length > 0.8) out.push(decoded);
  }
  return out;
}

/**
 * 私钥块用线性扫描而不是 `[\s\S]*?` 正则：后者在重复 BEGIN 且没有 END 时
 * 会对每个起点回溯到串尾（4MB 输入实测近 9 秒）。
 */
const PRIVATE_KEY_BEGIN_RE = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g;
const PRIVATE_KEY_END_RE = /-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g;

function redactPrivateKeys(text, counts) {
  let out = text;
  const beginRe = new RegExp(PRIVATE_KEY_BEGIN_RE.source, 'g');
  const endRe = new RegExp(PRIVATE_KEY_END_RE.source, 'g');
  let match;
  while ((match = beginRe.exec(out)) !== null) {
    endRe.lastIndex = match.index;
    const end = endRe.exec(out);
    if (!end) break;
    counts.set('private_key', (counts.get('private_key') || 0) + 1);
    const replacement = '[REDACTED:private_key]';
    out = out.slice(0, match.index) + replacement + out.slice(end.index + end[0].length);
    beginRe.lastIndex = match.index + replacement.length;
  }
  return out;
}

/**
 * 密钥扫描 + 脱敏。返回 { text, findings }；
 * findings 是去重后的 [{ kind, count }]，text 已把命中部分换成 [REDACTED:<kind>]。
 */
export function scanSecrets(text) {
  const input = String(text == null ? '' : text);
  if (!input) return { text: input, findings: [] };
  const counts = new Map();
  let out = redactPrivateKeys(input, counts);
  for (const pattern of SECRET_PATTERNS) {
    const re = new RegExp(pattern.re.source, pattern.re.flags.includes('g') ? pattern.re.flags : `${pattern.re.flags}g`);
    out = out.replace(re, (...args) => {
      counts.set(pattern.kind, (counts.get(pattern.kind) || 0) + 1);
      if (typeof pattern.replace === 'function') return pattern.replace(...args);
      return `[REDACTED:${pattern.kind}]`;
    });
  }
  return { text: out, findings: [...counts.entries()].map(([kind, count]) => ({ kind, count })) };
}

/**
 * 注入模式检测。返回 { tainted, kinds }。
 * 三层：原文正则 → 归一化视图（去零宽 / 全角转半角）再扫 → base64 长 token
 * 解码后扫。归一化与解码只用于检测，不改变任何落库内容。
 */
export function scanInjection(text) {
  const input = String(text == null ? '' : text);
  if (!input) return { tainted: false, kinds: [] };
  const kinds = [];
  const collect = (value) => {
    if (!value) return;
    for (const pattern of INJECTION_TESTS) {
      if (pattern.re.test(value) && !kinds.includes(pattern.kind)) kinds.push(pattern.kind);
    }
  };
  collect(input);
  const normalized = normalizeForDetection(input);
  if (normalized !== input) collect(normalized);
  for (const decoded of base64DecodedTexts(normalized)) collect(decoded);
  return { tainted: kinds.length > 0, kinds };
}

/**
 * trust 分级。显式传入合法值只在非模型来源（manual / import / external）采纳——
 * agent / auto 来源显式传 trust 一律忽略（D4：模型不能自封 user，否则一条
 * `trust:'user'` 就绕过 taint 隔离）；否则看 external 标记；
 * 再否则按 source 推导；更新路径沿用 existing 的 trust。
 */
export function computeTrust(input = {}, existing = null) {
  const explicitAllowed = !['agent', 'auto'].includes(input.source);
  if (explicitAllowed && TRUST_LEVELS.includes(input.trust)) return input.trust;
  if (input.external === true) return 'external';
  if (existing && TRUST_LEVELS.includes(existing.trust)) return existing.trust;
  return TRUST_BY_SOURCE[input.source] || existing?.trust || 'agent';
}

/** 把若干字段拼起来做一次注入检测。 */
export function assessTaint(parts = []) {
  return scanInjection(parts.filter((p) => p != null && p !== '').join('\n'));
}

export default {
  TRUST_LEVELS,
  TRUST_BY_SOURCE,
  SECRET_PATTERNS,
  INJECTION_PATTERNS,
  scanSecrets,
  scanInjection,
  normalizeForDetection,
  computeTrust,
  assessTaint,
};
