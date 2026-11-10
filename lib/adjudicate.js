/**
 * dsh-memory — L2 按需语义裁决（误报治理方案的第二阶段）。
 *
 * 立场：词法判不出「否定的宾语是不是对方那条」。默认路径一次模型都不调；
 * 只有用户显式点「整理」、且确实存在高相似簇时，才把**所有簇打包成一次** LLM 调用。
 *
 * 模型不是法官，只是候选生成器：输出必须过 `verifyVerdict` 的硬闸——
 * 判 contradicts 必须给出「同一 subject + predicate 上的两个互斥 object」，
 * 且两条 evidence 分别落在两条不同记录的原文里，两个值分别出现在对应 evidence 中。
 * 任何一条不满足就强制回落 unrelated。这堵住真实库上 10/10 误报的四种形态：
 * 句内对比句、同主题共享词、结论一致、中文二元组碎片。
 *
 * 结论只进只读信号 / 建议动作，**绝不自动归档**；是否 supersede 由人在面板确认。
 * 纯逻辑层：不 import 任何 DSH 运行时（P7），callLlm 由宿主注入。
 */

export const ADJUDICATE_RELATIONS = ['duplicate', 'complementary', 'contradicts', 'unrelated'];

/** 簇的稳定 key：与 dream.js 的合并循环共用，不依赖数组顺序。 */
export function clusterKey(records) {
  return (Array.isArray(records) ? records : [])
    .map((r) => String(r?.id ?? ''))
    .filter(Boolean)
    .sort()
    .join('|');
}

/** 取记录的可检索原文（标题 + 正文），用于验证 evidence 落点。 */
function corpusOf(record) {
  return `${String(record?.title ?? '')}\n${String(record?.content ?? '')}`;
}

export const ADJUDICATE_SYSTEM = `你是记忆库的「关系判定器」。给你若干组由词法相似度召回的记忆簇，你必须判断每组内部两条记忆的真实关系。

输出严格 JSON 数组，不要任何解释文字、不要 markdown 围栏。每个元素：
{
  "key": "输入里该簇的 key",
  "relation": "duplicate" | "complementary" | "contradicts" | "unrelated",
  "subject": "两条共同谈论的对象（名词）",
  "predicate": "两条共同谈论的属性或动作（谓词）",
  "values": ["第一条里该谓词的取值", "第二条里该谓词的取值"],
  "evidence": ["第一条原文中支持该取值的片段", "第二条原文中支持该取值的片段"],
  "confidence": 0..1
}

判定纪律（非常重要）：
- 只有两条记忆在【同一个 subject 的同一个 predicate】上给出了【互斥的两个取值】时，才允许判 contradicts。
- 一句里同时出现「必须 A，不能 B」「能 A，但不能 B」属于单条内部的对比说明，不是两条记忆冲突；这类应判 unrelated 或 complementary。
- 「不再 X / 改成 Y / 迁移到 Y」是同一主题的**时间演进**，除非对方明确仍在坚持旧断言，否则判 complementary，不要判 contradicts。
- 两条只是共享主题词、但谈论的对象或属性不同 → unrelated。
- evidence 必须是原文里真实存在的连续片段，不许改写、不许编造；两条 evidence 必须来自两条不同的记忆。
- 抽不出 subject / predicate / 两个不同取值时，一律判 unrelated。

只输出 JSON 数组。`;

/** 构造一次批量输入：把若干簇压进一条 user message，控制字符数。 */
export function buildAdjudicateInput(clusters, { maxClusters = 8, maxCharsPerRecord = 500 } = {}) {
  const picked = (Array.isArray(clusters) ? clusters : []).slice(0, maxClusters);
  const payload = picked.map((group) => {
    const full = Array.isArray(group) ? group : [];
    const records = full.slice(0, 4);
    return {
      /* key 必须用完整簇算：parseAdjudicateResponse 按完整簇查表，
         只用前 4 条会让 5 条以上的簇永远匹配不上（裁决被静默丢弃）。 */
      key: clusterKey(full),
      records: records.map((r) => ({
        id: String(r?.id ?? ''),
        title: String(r?.title ?? '').slice(0, maxCharsPerRecord),
        content: String(r?.content ?? '').slice(0, maxCharsPerRecord),
        source: String(r?.source ?? ''),
        trust: String(r?.trust ?? ''),
        createdAt: String(r?.createdAt ?? ''),
      })),
    };
  });
  return JSON.stringify({
    task: '判定每组记忆簇内部的关系；只有同一主谓宾上的互斥取值才算 contradicts',
    clusters: payload,
  });
}

/** 从模型回复里捞出 JSON 数组：容忍 ```json 围栏与前后废话。 */
function extractArray(reply) {
  const text = String(reply ?? '').trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1] : text;
  const start = source.indexOf('[');
  const end = source.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(source.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 硬闸：验证一条裁决，返回 { relation, guard }。
 * guard 非空表示被降级；调用方据此知道模型输出不可信。
 */
export function verifyVerdict(raw, records) {
  const out = {
    key: String(raw?.key ?? ''),
    relation: ADJUDICATE_RELATIONS.includes(raw?.relation) ? raw.relation : 'unrelated',
    subject: String(raw?.subject ?? '').trim(),
    predicate: String(raw?.predicate ?? '').trim(),
    values: Array.isArray(raw?.values) ? raw.values.map((v) => String(v ?? '').trim()) : [],
    evidence: Array.isArray(raw?.evidence) ? raw.evidence.map((v) => String(v ?? '').trim()) : [],
    confidence: Number.isFinite(raw?.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : 0,
    guard: null,
  };
  if (out.relation !== 'contradicts') return out;

  const corpora = (Array.isArray(records) ? records : []).map(corpusOf);
  const fail = (reason) => {
    out.relation = 'unrelated';
    out.guard = reason;
    return out;
  };
  if (!out.subject || !out.predicate) return fail('missing_subject_or_predicate');
  if (out.values.length !== 2 || !out.values[0] || !out.values[1]) return fail('missing_values');
  if (out.values[0] === out.values[1]) return fail('values_not_exclusive');
  if (out.evidence.length !== 2 || !out.evidence[0] || !out.evidence[1]) return fail('missing_evidence');
  if (corpora.length < 2) return fail('cluster_too_small');

  /* 两条 evidence 必须分别落在两条**不同**记录里。 */
  const hitA = corpora.findIndex((text) => text.includes(out.evidence[0]));
  const hitB = corpora.findIndex((text) => text.includes(out.evidence[1]));
  if (hitA < 0 || hitB < 0) return fail('evidence_not_in_source');
  if (hitA === hitB) return fail('evidence_same_record');

  /* 两个互斥值必须分别出现在对应 evidence 里（允许顺序颠倒）。 */
  const forward = out.evidence[0].includes(out.values[0]) && out.evidence[1].includes(out.values[1]);
  const backward = out.evidence[0].includes(out.values[1]) && out.evidence[1].includes(out.values[0]);
  if (!forward && !backward) return fail('values_not_grounded');
  return out;
}

/** 解析 + 校验一批裁决。未知 key / 模型漏答的簇一律按「不裁决」处理。 */
export function parseAdjudicateResponse(reply, clusters, { maxClusters = 8 } = {}) {
  const rows = extractArray(reply);
  if (!rows) return { ok: false, error: 'bad_json', verdicts: new Map() };
  const byKey = new Map(
    (Array.isArray(clusters) ? clusters : [])
      .slice(0, Math.max(1, Number(maxClusters) || 8))
      .map((group) => [clusterKey(group), Array.isArray(group) ? group : []]),
  );
  const verdicts = new Map();
  for (const row of rows) {
    const key = String(row?.key ?? '');
    if (!byKey.has(key)) continue;
    verdicts.set(key, verifyVerdict(row, byKey.get(key)));
  }
  return { ok: true, error: null, verdicts };
}

/**
 * @param deps.callLlm — async ({ system, userText, maxTokens }) => string，由宿主注入
 * @param deps.logger  — 可选，只记 warn
 */
export function createAdjudicator({ callLlm, logger = null } = {}) {
  function warn(message) {
    try {
      logger?.warn?.(`dsh-memory: ${message}`);
    } catch {
      /* 日志失败不影响整理 */
    }
  }

  /**
   * 一次调用裁决所有簇；失败一律静默跳过，让调用方回落到确定性规则。
   * @returns {Promise<{ ok, reason, verdicts: Map<string, object> }>}
   */
  async function adjudicate(clusters, { maxClusters = 8 } = {}) {
    const groups = (Array.isArray(clusters) ? clusters : []).filter((g) => Array.isArray(g) && g.length >= 2);
    if (typeof callLlm !== 'function' || !groups.length) {
      return { ok: false, reason: groups.length ? 'no_model_route' : 'no_clusters', verdicts: new Map() };
    }
    try {
      const reply = await callLlm({
        system: ADJUDICATE_SYSTEM,
        userText: buildAdjudicateInput(groups, { maxClusters }),
        maxTokens: 2400,
      });
      const result = parseAdjudicateResponse(reply, groups, { maxClusters });
      if (!result.ok) {
        warn(`语义裁决解析失败（${result.error}），回落确定性规则`);
        return { ok: false, reason: result.error, verdicts: new Map() };
      }
      return { ok: true, reason: null, verdicts: result.verdicts };
    } catch (error) {
      warn(`语义裁决不可用（${error?.message || error}），回落确定性规则`);
      return { ok: false, reason: String(error?.message || error), verdicts: new Map() };
    }
  }

  return { adjudicate };
}

export default { ADJUDICATE_RELATIONS, ADJUDICATE_SYSTEM, clusterKey, buildAdjudicateInput, verifyVerdict, parseAdjudicateResponse, createAdjudicator };
