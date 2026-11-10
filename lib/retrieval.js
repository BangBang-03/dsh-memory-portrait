/**
 * dsh-memory — 检索层（纯逻辑，无 DSH 依赖）。
 *
 * 目标：把「字段加权词重叠」升级成可解释的 BM25F + 三路补充信号：
 *   - BM25F：字段权重 + IDF + 文档长度归一，解决「长文淹没短文」「常见词压过稀有词」；
 *   - exactPhraseBoost：中文短语 / 路径 / 代码标识符的精确命中；
 *   - relatedBoostMap：related 一跳扩展（正向 + 反向），补「语义无关但功能相关」；
 *   - expandQueryTokens：查询侧保守同义词扩展，接住「用户换了说法」的召回。
 *
 * 不引入向量库、不调用模型；所有分数都是本地确定性计算。
 * 排序策略（置顶 / 类别 / 使用次数 / 衰减 / 质量）仍留在 lib/store.js，
 * 这里只负责「文本相关性」这一层，避免把存储策略耦合进来。
 */

import { tokenize } from './text.js';

/** BM25F 字段与权重。标题 > 标签/关键词 > 文件路径 > 正文。 */
export const BM25F_FIELDS = [
  { key: 'title', weight: 3.2, get: (r) => r.title || '' },
  { key: 'tags', weight: 2.4, get: (r) => (r.tags || []).join(' ') },
  { key: 'keywords', weight: 2.4, get: (r) => (r.keywords || []).join(' ') },
  { key: 'files', weight: 1.8, get: (r) => (r.files || []).join(' ') },
  { key: 'content', weight: 1.0, get: (r) => r.content || '' },
];

const K1 = 1.2;
const B = 0.75;

/**
 * 保守的同义词组：只做查询侧扩展，不改写入内容。
 * 目标是接住「用户换了说法、记忆里没出现那个词」的查询；
 * 不收录近义但语义会漂移的词（例如 token 同时指密钥与模型 token）。
 */
export const QUERY_SYNONYM_GROUPS = [
  ['发版', '发布', '上线', '对外', 'release', 'publish', 'deploy'],
  ['检查', '校验', '验证', 'check', 'verify'],
  ['构建', '编译', '打包', '生成', 'build', 'compile'],
  ['命令', '指令', 'command', 'cmd'],
  ['密钥', '令牌', '凭据', 'secret', 'credential'],
  ['防止', '避免', '预防', 'prevent'],
  ['写入', '写进', '落库', '提交', 'write', 'persist'],
  ['压缩', '裁剪', 'compact', 'compaction'],
  ['决策', '结论', 'decision', 'conclusion'],
  ['回滚', '恢复', 'rollback', 'recover'],
  ['仓库', '代码库', 'git', 'repository', 'repo'],
  ['检索', '搜索', '查找', 'search', 'retrieval'],
  ['画像', '档案', 'profile', 'portrait'],
  ['审批', '审核', 'approve', 'review'],
  ['导入', '迁移', 'import', 'migrate'],
  ['过期', '失效', 'stale', 'expire'],
  ['体检', '健康', 'health'],
  ['测试', '自测', 'test'],
  ['默认', 'default'],
];

const SYNONYM_MAP = new Map();
for (const group of QUERY_SYNONYM_GROUPS) {
  const terms = [...new Set(group.map((term) => term.toLowerCase()))];
  for (const term of terms) {
    if (!SYNONYM_MAP.has(term)) SYNONYM_MAP.set(term, new Set());
    for (const other of terms) if (other !== term) SYNONYM_MAP.get(term).add(other);
  }
}

/**
 * 查询词扩展：保留原词，按同义词组追加一次；上限 64 个，避免长查询膨胀。
 * 只对查询做，索引仍用原文，因此不会改变已写入记忆的语义。
 */
export function expandQueryTokens(tokens = []) {
  if (!Array.isArray(tokens) || !tokens.length) return [];
  const out = [];
  const seen = new Set();
  const push = (token) => {
    if (!token || seen.has(token)) return;
    seen.add(token);
    out.push(token);
  };
  for (const raw of tokens) {
    const token = String(raw ?? '').toLowerCase();
    push(token);
    for (const synonym of SYNONYM_MAP.get(token) || []) push(synonym);
    if (out.length >= 64) break;
  }
  return out;
}

/**
 * 建索引：每个字段的 tf / 长度 / 平均长度，以及文档级 df。
 * 记录数量在几百到几千时，这个索引构建是毫秒级；不落盘，每次检索现建。
 */
export function createBm25fIndex(records = []) {
  const list = Array.isArray(records) ? records : [];
  const docs = new Map();
  const df = new Map();
  const stats = new Map(BM25F_FIELDS.map((f) => [f.key, { totalLen: 0, avgLen: 0 }]));

  for (const record of list) {
    const perField = new Map();
    const seen = new Set();
    for (const field of BM25F_FIELDS) {
      const tokens = tokenize(field.get(record));
      const tf = new Map();
      for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
      perField.set(field.key, { tf, len: tokens.length });
      const st = stats.get(field.key);
      st.totalLen += tokens.length;
      for (const token of tf.keys()) seen.add(token);
    }
    for (const token of seen) df.set(token, (df.get(token) || 0) + 1);
    docs.set(record.id, perField);
  }

  const n = list.length;
  for (const st of stats.values()) st.avgLen = n ? st.totalLen / n : 0;

  return { N: n, docs, df, stats, k1: K1, b: B };
}

/** 单条记录的 BM25F 原始分；queryTokens 为空或记录不在索引里时返回 0。 */
export function scoreBm25f(record, queryTokens = [], index = null) {
  if (!index || !record || !Array.isArray(queryTokens) || !queryTokens.length) return 0;
  const doc = index.docs.get(record.id);
  if (!doc) return 0;

  let score = 0;
  for (const token of queryTokens) {
    const docFreq = index.df.get(token) || 0;
    if (!docFreq) continue;
    const idf = Math.log(1 + (index.N - docFreq + 0.5) / (docFreq + 0.5));
    for (const field of BM25F_FIELDS) {
      const slot = doc.get(field.key);
      const tf = slot?.tf.get(token) || 0;
      if (!tf) continue;
      const stat = index.stats.get(field.key);
      const avg = stat?.avgLen || 1;
      const len = slot?.len || 0;
      const denom = tf + index.k1 * (1 - index.b + index.b * (len / avg));
      score += (field.weight * idf * (tf * (index.k1 + 1))) / denom;
    }
  }
  return score;
}

/**
 * 精确短语加权：中文短语、路径、代码标识符整体出现时，比散词命中更强。
 * 返回 0–1；标题 1.0，标签/关键词 0.8，路径 0.7，正文 0.5。
 */
export function exactPhraseBoost(record, query) {
  const q = String(query == null ? '' : query).trim().toLowerCase();
  if (q.length < 2 || !record) return 0;
  const hit = (value, weight) => (String(value == null ? '' : value).toLowerCase().includes(q) ? weight : 0);
  return Math.max(
    hit(record.title, 1),
    hit((record.tags || []).join(' '), 0.8),
    hit((record.keywords || []).join(' '), 0.8),
    hit((record.files || []).join(' '), 0.7),
    hit(record.content, 0.5),
  );
}

/**
 * related 一跳扩展：正向（我指向高分记录）+ 反向（高分记录指向我）。
 * 返回 id -> 原始 boost（未归一）；调用方负责除以最大值。
 */
export function relatedBoostMap(records = [], lexicalScores = new Map()) {
  const list = Array.isArray(records) ? records : [];
  const reverse = new Map();
  for (const record of list) {
    for (const id of record.related || []) {
      if (!reverse.has(id)) reverse.set(id, []);
      reverse.get(id).push(record.id);
    }
  }

  const out = new Map();
  for (const record of list) {
    let best = 0;
    for (const id of record.related || []) {
      best = Math.max(best, lexicalScores.get(id) || 0);
    }
    for (const id of reverse.get(record.id) || []) {
      best = Math.max(best, (lexicalScores.get(id) || 0) * 0.8);
    }
    out.set(record.id, best);
  }
  return out;
}

export default {
  BM25F_FIELDS,
  createBm25fIndex,
  scoreBm25f,
  exactPhraseBoost,
  relatedBoostMap,
};
