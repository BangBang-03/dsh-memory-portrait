/**
 * dsh-memory — 全局原则的自动晋升判定（纯逻辑，不调模型、不碰磁盘）。
 *
 * 两级蒸馏的第二级。项目内蒸馏产出的「候选原则」在这里聚类、分层判定，
 * 决定哪些能升成全局记忆。
 *
 * 三条设计约定（2026-11-05 定，见 docs/global-distill-trial-2026-11-05.md）：
 *
 *   1. **按证据强度分层，而不是一律要求跨项目共振。**
 *      用户亲口说的（constraint / feedback / preference）单项目就能晋升；从行为里
 *      推断出来的（decision / convention）才需要第二个项目交叉验证。
 *      否则永远凑不齐「三个项目同时命中」，自动路径会活活饿死。
 *
 *   2. **自动为主**。判定是纯计算，不需要人确认；出错靠「可撤回 + 不再提议」纠正。
 *
 *   3. **前置拒绝放在聚类之前**。项目载体、常识套话这两类必须在成簇前挡掉，
 *      否则它们会把真正相近的原则拉进同一个簇，污染项目计数。
 */

import { similarity } from './text.js';

/**
 * 晋升门槛。
 *
 * `projects` 是**不同项目**的数目（同一项目报十次也只算一次）；
 * `anchors` 是簇内去重后的锚点条数（每条锚点指向项目内一条真实记忆）。
 *
 * 阈值来源：对 dsh-memory 全库 122 条 active 记忆做过一次手工蒸馏试跑，
 * 产出 4 条合格原则，其中 2 条属 feedback、2 条属 decision —— 这个分布直接
 * 决定了 feedback 不需要共振、decision 需要两个项目。
 */
export const PROMOTION_RULES = {
  constraint: { projects: 0, anchors: 0, why: '用户明说的绝对禁令，单项目即可' },
  feedback: { projects: 0, anchors: 1, why: '用户明确纠正过的行为，单项目即可' },
  preference: { projects: 0, anchors: 2, why: '用户表达过的偏好，要求两个锚点' },
  decision: { projects: 2, anchors: 2, why: '从取舍里推断的，需要第二个项目交叉验证' },
  convention: { projects: 2, anchors: 3, why: '从行为里归纳的，门槛最高' },
};

export const DISTILLABLE_CATEGORIES = Object.keys(PROMOTION_RULES);

/**
 * 项目载体：出现这些就说明原则还带着具体项目的信息，不能上行。
 * 每一条都对应试跑里淘汰掉的一类真实记忆。
 */
const CARRIER_PATTERNS = [
  { re: /[A-Za-z]:\\|\/(?:Users|home|usr|opt|srv|var)\//, why: 'path' },
  { re: /\.(?:js|mjs|cjs|ts|tsx|json|yml|yaml|toml|md|ps1|sh|py|lock)\b/, why: 'filename' },
  { re: /\bv\d+\.\d+(?:\.\d+)?\b/, why: 'version' },
  { re: /@[a-z0-9-]+\/[a-z0-9-]+/i, why: 'package' },
  { re: /\b(?:npm|pnpm|yarn|git|node|pwsh|powershell|docker)\s+[a-z-]/i, why: 'command' },
];

/**
 * 常识套话：正确的废话。占全局预算、又不改变任何行为。
 * 只挡最空泛的那几句，不挡「必须验证」「先备份」这类有约束力的。
 */
const CLICHE_PATTERNS = [
  /^要?写(?:单元)?测试/,
  /注意安全/,
  /保持(?:代码)?(?:整洁|简洁|清晰)/,
  /(?:及时|多)沟通/,
  /^要(?:认真|仔细|细心)/,
];

/**
 * 候选原则的准入检查。返回拒绝原因，通过则返回 null。
 *
 * 顺序有意为之：**套话先判**——「写测试很重要」这类既短又空，报 `cliche` 比报
 * `too-short` 更能指导提示词往哪改；然后才是长度与项目载体。
 */
export function candidateRejection(text) {
  const value = String(text == null ? '' : text).trim();
  for (const re of CLICHE_PATTERNS) {
    if (re.test(value)) return 'cliche';
  }
  if (value.length < 10) return 'too-short';
  if (value.length > 240) return 'too-long';
  for (const { re, why } of CARRIER_PATTERNS) {
    if (re.test(value)) return `carries-${why}`;
  }
  return null;
}

/**
 * 判定一个簇能不能晋升。
 *
 * @param cluster.category 原则类别（决定门槛）
 * @param cluster.projects 出现过的项目标识（同一项目重复不计）
 * @param cluster.anchors  去重后的锚点数
 */
export function evaluateCluster({ category, projects = [], anchors = 0 } = {}) {
  const rule = PROMOTION_RULES[category];
  if (!rule) return { promote: false, reason: 'category-not-distillable' };

  const projectCount = new Set((Array.isArray(projects) ? projects : []).filter(Boolean)).size;
  if (projectCount < rule.projects) {
    return {
      promote: false,
      reason: 'need-more-projects',
      missing: rule.projects - projectCount,
    };
  }
  if (!(anchors >= rule.anchors)) {
    return {
      promote: false,
      reason: 'need-more-anchors',
      missing: rule.anchors - anchors,
    };
  }
  return { promote: true, reason: 'ok' };
}

/**
 * 把候选原则按主题聚成簇。
 *
 * 合并判据**优先看 `topics`（主题词），没有才回落到文本相似度**。
 * 原因是实测出来的：两条讲同一件事的原则，完整句子的 Jaccard 只有 0.20
 * （「改动真实数据前先留一份可回滚的快照，合并归档删除不能由系统自动决定」
 * 对「不可逆的批量操作之前必须先留可回滚快照，不要自动裁决」）——句子越长，
 * 分母越大，全文相似度越失效。靠它聚类会把同主题全部漏掉。
 *
 * 所以蒸馏提示词必须要求输出 2–3 个主题词（如 `backup` / `irreversible`），
 * 这里按主题词交集判定。没给 topics 的旧候选回落到相似度，阈值 0.40 —— 那是对
 * 短句校准过的值（改写型 0.42–0.44，换措辞 0.61–0.70）。
 *
 * 同类别是硬条件：跨类别不合并（「用 pnpm」既是约定也可能是偏好，混在一个簇里
 * 会让门槛判定失去意义）。
 *
 * @param candidates [{ text, category, project, anchors: [id], topics: [string], at }]
 */
export function clusterCandidates(candidates = [], { threshold = 0.4 } = {}) {
  const list = [];
  for (const item of Array.isArray(candidates) ? candidates : []) {
    if (!item || !item.text) continue;
    const text = String(item.text).trim();
    if (candidateRejection(text)) continue;
    const category = DISTILLABLE_CATEGORIES.includes(item.category) ? item.category : 'convention';
    const topics = [...new Set(
      (Array.isArray(item.topics) ? item.topics : [])
        .map((t) => String(t || '').toLowerCase().trim())
        .filter(Boolean),
    )].slice(0, 6);
    list.push({ ...item, text, category, topics });
  }

  /** 同主题判定：两边都给主题词就按交集，否则回落到文本相似度。 */
  const sameTopic = (a, b) => {
    if (a.topics.length && b.topics.length) {
      const set = new Set(a.topics);
      return b.topics.some((topic) => set.has(topic));
    }
    return similarity(a.text, b.text) >= threshold;
  };

  const parent = list.map((_, index) => index);
  const find = (index) => {
    let i = index;
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };

  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (list[i].category !== list[j].category) continue;
      if (sameTopic(list[i], list[j])) parent[find(i)] = find(j);
    }
  }

  const groups = new Map();
  for (let i = 0; i < list.length; i += 1) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(list[i]);
  }

  return [...groups.values()].map((members) => {
    const projects = [...new Set(members.map((m) => String(m.project || '')).filter(Boolean))];
    const anchorIds = new Set();
    for (const m of members) {
      for (const id of Array.isArray(m.anchors) ? m.anchors : []) anchorIds.add(String(id));
    }
    /* 代表文本取锚点最多的那条：锚点多说明它在项目里被反复印证，比短的更可靠。 */
    const lead = members
      .slice()
      .sort((a, b) => (b.anchors?.length || 0) - (a.anchors?.length || 0))[0];
    return {
      text: lead.text,
      category: lead.category,
      /* topics 必须透传：下游要靠它写全局记忆的 keywords，再做「换说法」去重。
         漏掉这一行会让去重判据静默失效（曾经踩过）。 */
      topics: [...new Set(members.flatMap((m) => m.topics || []))].slice(0, 6),
      projects,
      anchors: anchorIds.size,
      members,
    };
  });
}

/**
 * 一次跑完：聚类 + 逐簇判定。返回的每个簇都带 `verdict`。
 * 调用方（Dream / 候选池巡检）只需挑 `verdict.promote === true` 的落库。
 */
export function promotionReport(candidates = [], { threshold = 0.4 } = {}) {
  return clusterCandidates(candidates, { threshold }).map((cluster) => ({
    ...cluster,
    verdict: evaluateCluster(cluster),
  }));
}

/**
 * 二级蒸馏的提示词。
 *
 * 和 skills/global-distill/SKILL.md 里那份是同一套规则，只是这里给程序调用。
 * 三处关键约束不能松：
 *   - 禁止项目载体（否则到别的项目就是错误指令）；
 *   - 禁止单锚点（偶发偏好不是原则）；
 *   - topics 必填（聚类完全依赖它，缺了整个自动路径就是瘫的）。
 */
export const GLOBAL_DISTILL_SYSTEM = [
  '你是记忆蒸馏器。输入是一个项目的长期记忆条目，输出是这个项目里「跨项目仍然成立」的原则。',
  '',
  '只输出 JSON 数组，不要任何解释、不要 markdown 代码块。0–3 条，宁少勿滥。',
  '每条格式：',
  '{"text":"一句原则，不超过 120 字","category":"constraint|feedback|preference|decision|convention",',
  ' "topics":["2-3 个英文小写主题词"],"anchors":["支撑它的记忆 id，至少 2 个"]}',
  '',
  '判定「跨项目成立」的标准：',
  '- 它讲的是「怎么做事的规矩」，不是「这个项目的具体状态」。',
  '- 去掉所有专有名词后仍然成立。',
  '- 换一个完全不同的项目，它依然是对的。',
  '',
  '三类必须禁止：',
  '1. 携带项目载体——文件路径、文件名、命令、版本号、包名、项目名。',
  '   反例：「发布前跑 node test/run-all.mjs」；正例：「改完必须跑全量测试再提交」。',
  '2. 只有一个锚点——可能只是偶发偏好。',
  '3. 常识套话——写测试、注意安全、保持简洁、及时沟通。',
  '   反例：「要写单元测试」；正例：「改动必须验证再提交，不接受『应该没问题』」。',
  '',
  'category 按证据来源选：',
  '- constraint：用户明确说过「绝对不要 / 永远不要」',
  '- feedback：用户纠正过你的某个行为',
  '- preference：用户表达过的工作偏好',
  '- decision：从取舍里推断的（为什么放弃了另一条路）',
  '- convention：从反复出现的行为里归纳的',
  '',
  'topics 用英文小写，2–3 个，要能在不同项目之间对上（backup / irreversible / verification）。',
  '不要用项目名、技术栈名、产品名做 topic——那会让跨项目聚类失效。',
  '',
  '如果没有一条满足以上标准，输出 []。',
].join('\n');

/**
 * 解析蒸馏回复。
 *
 * 容错策略（模型输出不可信，这里必须宽进严出）：
 *   - 剥掉 ```json 围栏，取第一个 `[` 到最后一个 `]`；
 *   - 逐条过 `candidateRejection`，脏的直接丢；
 *   - **topics 为空直接丢**——聚类完全依赖主题词，留着只会污染候选池；
 *   - 超过 limit 条截断，防止模型一次报十几条。
 *
 * 解析失败返回空数组，不抛错：蒸馏是后台奖励动作，失败不该打断 Dream。
 */
export function parseGlobalDistill(text, { limit = 3 } = {}) {
  const raw = String(text == null ? '' : text);
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out = [];
  for (const item of parsed) {
    if (!item || typeof item.text !== 'string') continue;
    const value = item.text.trim();
    if (candidateRejection(value)) continue;

    const topics = (Array.isArray(item.topics) ? item.topics : [])
      .map((topic) => String(topic || '').toLowerCase().trim())
      .filter(Boolean)
      .slice(0, 6);
    if (!topics.length) continue;

    const anchors = (Array.isArray(item.anchors) ? item.anchors : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean)
      .slice(0, 16);
    if (!anchors.length) continue;

    out.push({
      text: value,
      category: DISTILLABLE_CATEGORIES.includes(item.category) ? item.category : 'convention',
      topics,
      anchors,
    });
    if (out.length >= Math.max(1, limit)) break;
  }
  return out;
}

/**
 * 把候选池里达标的原则晋升成全局记忆。
 *
 * 四道闸：
 *   1. 准入与门槛走本文件的纯函数（可单测）；
 *   2. 落库前查一次全局库——换个说法但讲同一件事的，记到已有那条上，不重复建；
 *   3. 写入用 `source: 'auto'`、`confidence: 0.75`：模型归纳的结论不能冒充 user；
 *   4. 晋升成功才 mark promoted；写失败留 pending，下次再来。
 *
 * 纯计算 + 存储操作，随时可重跑（幂等）：候选一旦标记就不再参与判定，
 * 所以轮末、任务结束、模型主动触发都可以安全地各调一次。
 *
 * @param store — createMemoryStore() 的返回值
 */
export function promoteCandidates(store) {
  const pending = store.candidates.list({ status: 'pending' });
  if (!pending.length) return { promoted: 0, duplicates: 0, ids: [] };

  const ready = promotionReport(pending).filter((item) => item.verdict.promote);
  if (!ready.length) return { promoted: 0, duplicates: 0, ids: [] };

  let promoted = 0;
  let duplicates = 0;
  const ids = [];

  for (const cluster of ready) {
    const memberIds = cluster.members.map((item) => item.id);

    /*
     * 已有同主题的全局记忆（只是说法不同）→ 记到那条上，不重复建。
     *
     * 判据分两档，原因和聚类层一样：长句的 Jaccard 天然偏低（同一个原则换句话
     * 说能掉到 0.43）。所以共享主题词时用 0.35 的松阈值，没有共同主题词才要求
     * 0.6 —— 后者基本只有近乎逐字重复才会命中。
     */
    const globals = store.list({
      workspace: '',
      includeGlobal: true,
      includeArchived: false,
      scope: 'global',
    }).records || [];
    const topics = new Set(cluster.topics || []);
    const duplicate = globals.find((record) => {
      const shared = (record.keywords || []).some((keyword) => topics.has(keyword));
      const sim = similarity(cluster.text, `${record.title || ''} ${record.content || ''}`);
      return sim >= 0.6 || (shared && sim >= 0.35);
    });
    if (duplicate) {
      store.candidates.mark(memberIds, { status: 'promoted', promotedId: duplicate.id });
      duplicates += 1;
      continue;
    }

    const saved = store.upsert(
      {
        title: cluster.text.slice(0, 60),
        content: cluster.text,
        category: cluster.category,
        scope: 'global',
        source: 'auto',
        confidence: 0.75,
        keywords: cluster.topics || [],
        /* 只记「几个项目」，不记是哪几个：项目名不该出现在全局库里。 */
        reason: `由 ${cluster.projects.length} 个项目的候选原则共振得出`,
      },
      { workspace: '' },
    );

    if (saved?.record?.id) {
      store.candidates.mark(memberIds, { status: 'promoted', promotedId: saved.record.id });
      promoted += 1;
      ids.push(saved.record.id);
    }
  }

  return { promoted, duplicates, ids };
}

export default {
  PROMOTION_RULES,
  DISTILLABLE_CATEGORIES,
  GLOBAL_DISTILL_SYSTEM,
  candidateRejection,
  evaluateCluster,
  clusterCandidates,
  promotionReport,
  parseGlobalDistill,
  promoteCandidates,
};
