/**
 * dsh-memory — 自动判定策略注册表（误报治理 L3）。
 *
 * 目的：把散落在 store / index / dream / api 里的「谁可以自动做什么」收敛成一份
 * 可机读契约，让三条治理规则能被测试守住，而不是靠文档里的一句话。
 *
 * 字段语义：
 *   detector      — deterministic（确定性规则）/ lexical（词法召回）/ semantic（模型裁决）
 *   reversible    — 动作能否回滚（归档 + supersededBy、画像版本历史都算可逆；删除/覆盖不算）
 *   requiresHuman — 是否必须人确认才能执行
 *   defaultAction — 默认动作；signal 只读、downweight 只影响排序
 *   surfaces      — 允许出现的视图；attention 是唯一会占用用户注意力的视图
 *
 * 设计约束（与 docs/false-positive-audit-2026-11-09.md 一致）：
 *   - 误报的代价必须退化为「排序略差」，不能是「删错数据」；
 *   - 词法只做召回，不做裁决，更不触发不可逆动作；
 *   - 人工只守不可逆 / 不可信的动作，其余一律自动。
 *
 * 纯数据 + 纯函数，不 import 任何运行时依赖（P7）。
 */

export const POLICY_DETECTORS = ['deterministic', 'lexical', 'semantic'];

/** 词法判定绝不允许默认执行这些动作。 */
const SIDE_EFFECT_ACTIONS = new Set(['archive', 'delete', 'supersede', 'overwrite']);

export const POLICIES = [
  {
    id: 'redline-governance',
    detector: 'deterministic',
    reversible: false,
    requiresHuman: true,
    defaultAction: 'delete',
    surfaces: ['attention', 'redline'],
    evidence: ['panel confirm:true'],
    note: 'C8：红线删除 / 改稿只能从面板确认接口进来，模型工具永不透传',
  },
  {
    id: 'taint-quarantine',
    detector: 'lexical',
    reversible: true,
    requiresHuman: true,
    defaultAction: 'quarantine',
    surfaces: ['attention', 'queue'],
    evidence: ['injection pattern', 'trust !== user'],
    note: 'D4：非 user 来源命中注入模式隔离成草稿；草稿四不可见（C6）',
  },
  {
    id: 'review-escalation',
    detector: 'deterministic',
    reversible: true,
    requiresHuman: true,
    defaultAction: 'signal',
    surfaces: ['attention', 'reviews'],
    evidence: ['autoReviewCount >= 2', 'useCount === 0'],
    note: '复审到期先自动续期，连两轮零引用才升级给人',
  },
  {
    id: 'contradiction-clue',
    detector: 'lexical',
    reversible: true,
    requiresHuman: false,
    defaultAction: 'signal',
    surfaces: ['maintain'],
    evidence: ['shared tokens', 'hint'],
    note: '默认不产出；只有用户显式点「扫描矛盾线索」才诊断，结论只读、绝不自动归档',
  },
  {
    id: 'duplicate-cluster',
    detector: 'lexical',
    reversible: true,
    requiresHuman: false,
    defaultAction: 'signal',
    surfaces: ['maintain'],
    evidence: ['Jaccard >= 0.72'],
    note: '召回阶段只给候选，不再用矛盾检测把簇抹掉',
  },
  {
    id: 'consolidate-cluster',
    detector: 'deterministic',
    reversible: true,
    requiresHuman: false,
    defaultAction: 'supersede',
    surfaces: ['maintain'],
    evidence: ['snapshot', 'supersededBy', 'redline guard', 'contradiction_pair guard'],
    note: '动作前的安全闸：红线 / 语义相反 / 跨 scope 一律拒绝；源条目归档可恢复',
  },
  {
    id: 'timeline-invalidation',
    detector: 'deterministic',
    reversible: true,
    requiresHuman: false,
    defaultAction: 'supersede',
    surfaces: ['maintain'],
    evidence: ['validUntil', 'invalidatedBy'],
    note: '旧事实窗口关闭但记录保留（D7）；检索期静态降权 0.3×，不读当前时间（C4）',
  },
  {
    id: 'semantic-adjudication',
    detector: 'semantic',
    reversible: true,
    requiresHuman: false,
    defaultAction: 'signal',
    surfaces: ['maintain'],
    evidence: ['subject', 'predicate', 'values', 'evidence'],
    note: '仅手动整理且存在高相似簇时调用一次；判 contradicts 必须过同一主谓宾互斥 + 证据落点硬闸',
  },
  {
    id: 'stale-dormant',
    detector: 'deterministic',
    reversible: true,
    requiresHuman: false,
    defaultAction: 'downweight',
    surfaces: ['maintain'],
    evidence: ['lastUsedAt || createdAt'],
    note: '按 decay 自动降权，不归档、不进 attention；不再用会被系统改写的 updatedAt',
  },
  {
    id: 'exposed-unused',
    detector: 'deterministic',
    reversible: true,
    requiresHuman: false,
    defaultAction: 'downweight',
    surfaces: ['maintain'],
    evidence: ['exposedCount >= 3', 'useCount === 0'],
    note: '相关性存疑信号，与「久未使用」是两个独立维度',
  },
  {
    id: 'dead-file-ref',
    detector: 'deterministic',
    reversible: true,
    requiresHuman: false,
    defaultAction: 'signal',
    surfaces: ['maintain'],
    evidence: ['fs.existsSync'],
    note: '只读报告；摘除断链由人点，避免误改记录',
  },
  {
    id: 'over-budget',
    detector: 'deterministic',
    reversible: true,
    requiresHuman: false,
    defaultAction: 'signal',
    surfaces: ['maintain', 'settings'],
    evidence: ['activeCount > briefingLimit * 5'],
    note: '容量提示，不是用户待办',
  },
  {
    id: 'quality-gate',
    detector: 'deterministic',
    reversible: true,
    requiresHuman: false,
    defaultAction: 'archive',
    surfaces: ['maintain'],
    evidence: ['quality < 30', 'source auto|agent'],
    note: '归档可恢复（unarchive）；TODO：补 supersededBy 回滚链，与 promoteCandidates 统一准入',
  },
  {
    id: 'portrait-rewrite',
    detector: 'semantic',
    reversible: true,
    requiresHuman: false,
    defaultAction: 'save',
    surfaces: ['portrait'],
    evidence: ['version history'],
    note: '零审批：默认 direct 直接落库；有损也落库并标 degraded，靠版本历史回滚',
  },
  {
    id: 'candidate-promotion',
    detector: 'semantic',
    reversible: true,
    requiresHuman: false,
    defaultAction: 'supersede',
    surfaces: ['maintain'],
    evidence: ['anchors', 'cross-project threshold'],
    note: '二级蒸馏够格自动晋升全局；门槛按证据强度分层',
  },
];

/**
 * 三条自动校验。返回人类可读的违规列表；空数组代表契约成立。
 * 直接被 test/host.test.mjs 调用——加规则时写错字段会当场红，而不是等线上误伤数据。
 */
export function validatePolicies(policies = POLICIES) {
  const violations = [];
  for (const rule of policies) {
    const id = rule?.id || '(missing id)';
    const surfaces = Array.isArray(rule?.surfaces) ? rule.surfaces : [];
    const inAttention = surfaces.includes('attention');

    if (!POLICY_DETECTORS.includes(rule?.detector)) {
      violations.push(`${id}: detector 必须是 ${POLICY_DETECTORS.join(' / ')}`);
    }
    /* 1) 不可逆动作必须有人守着。 */
    if (rule?.reversible === false && rule?.requiresHuman !== true) {
      violations.push(`${id}: 不可逆动作必须 requiresHuman`);
    }
    /* 2) 词法只做召回，不许默认归档 / 删除 / 推翻。 */
    if (rule?.detector === 'lexical' && SIDE_EFFECT_ACTIONS.has(rule?.defaultAction)) {
      violations.push(`${id}: 词法判定不得默认执行 ${rule.defaultAction}`);
    }
    /* 3) attention 是人工专属视图，两边必须严格对齐。 */
    if (rule?.requiresHuman === true && !inAttention) {
      violations.push(`${id}: 需要人确认却不在 attention 里`);
    }
    if (rule?.requiresHuman !== true && inAttention) {
      violations.push(`${id}: 自动项不该占用 attention`);
    }
  }
  return violations;
}

/** 供面板 / API 展示「哪些事已经由插件自动处理」。 */
export function autoHandledRules(policies = POLICIES) {
  return policies.filter((rule) => !rule.requiresHuman).map((rule) => rule.id);
}

export default { POLICIES, POLICY_DETECTORS, validatePolicies, autoHandledRules };
