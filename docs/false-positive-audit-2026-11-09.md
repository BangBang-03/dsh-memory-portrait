# 误报与规则冲突专项调研（2026-11-09）

> 范围：`lib/*.js` 的全部自动判定逻辑 + 真实记忆库回放 + 同类系统方案对照。
> 本文是调研与方案设计；**P0 止血、默认不产出矛盾结论（D）、L3 策略注册表、L1 时间轴、
> L2 按需语义裁决已全部落地**，清单见文末「落地进度」。
> 事实与行号以 2026-11-09 的 `main` 工作区为准。

---

## 1. 结论先行

**核心判断：问题不是「正则写得不够好」，而是把「语义判定」交给了词法，并且让判定结果直接触发不可逆动作。**

三个证据：

1. 上一轮把「不再 / 改用 / 迁移到」从否定词里拆出去后，真实库的疑似矛盾**没有归零，仍为 10 对**，只是触发词从「不再」换成了「不能 / 禁止 / 不要」。10 对里没有一对是真正的两条记忆互斥。
2. 现有的两处「保护」其实是把误报成本转嫁给了别处：`clusterDuplicates` 用 `detectContradictions` 过滤簇（store.js:2157）、`consolidateCluster` 遇到任一矛盾线索就拒绝合并（:2951），结果真实库 `duplicates: 0` —— 误报让正常的自动合并也停摆了。
3. 同一个 `updatedAt` 字段被当成「最后编辑 / 素材新鲜度 / 过期未用 / 简报指纹」四种语义使用，导致 `health.stale` 在真实库上**恒为 0**（六次维护台账全 0），而 `exposedButUnused` 是 22。

行业方向的佐证：mem0 在 v3 把「写入时 LLM 决定 ADD/UPDATE/DELETE/NOOP」改成了**单遍 ADD-only + 检索期多信号排序**；Zep/Graphiti 用双时态模型对旧事实打 `invalid_at` 而不是删除。共同点是**把「谁生效」的决定从写入时挪到检索时**——误判的代价从「删错数据」退化成「排序略差」。

因此建议的方案不是继续加正则，而是：**默认不生成「矛盾」这个结论；把启发式全部降级为只读信号；只在显式整理时对高相似簇做一次带证据要求的结构化语义裁决；所有失效动作改为时间轴上的「降权 / 失效」而非「归档 / 删除」。**

---

## 2. 现状盘点：误报清单

真实库数字（只读回放，未写入）：工作区 161 条 / active 149，全局 12 条 / active 9，红线 0；
`health()` = `stale 0`、`exposedButUnused 22`、`reviewDue 0`、`deadFiles 0`、`broken 0`、`duplicates 0`、
`overBudget true`、`activeCount 158`、`contradictions 10`、`attention.total 0`。

### 2.1 矛盾检测：10 / 10 误报

`detectContradictions`（store.js:428-495）的候选来自「共享 ≥3 个显著 token」或「共享 1 个标签」，
`contradictionHint`（:505-520）再要求一方句子含否定词、且该句显著词与对方有交集。

10 对 hint 的误报模式分类：

| 模式 | 例子（真实 hint 片段） | 对数 |
| --- | --- | --- |
| **句内对比句**：「必须挂 X，**不能**挂 Y」「能 A，但**不能** B」「**禁止** X，需手动 Y」——否定词来自同一句内部的对照结构，不是对另一条记录的否定 | 「自动巩固必须挂 turn/end，不能挂 agent/turn-stopping」 | 10 / 10 |
| **同一主题共享词**：npm/发布、自动整理/turn-end、git tag 三组话题互相配对 | 「验收发布必须去 npm registry 核对版本，不能只看 CI 状态」 | 10 / 10 |
| **结论一致被判矛盾**：两条记忆其实互相印证 | 「npm login…能 whoami，但不能 publish」⇄「npm publish 被 2FA 403 挡住」 | 6 / 10 |
| **中文二元组碎片**：`salientTokensOf` 把「发布必须」「安全策略」切成「布必」「全策」，却被当作「对方关键词」证据 | hits 出现「布必」「全策」 | 2 / 10 |

根因是**判定缺两个必要条件**：没有抽「主语 + 谓词 + 宾语」，也没有要求「否定作用于对方那条断言的同一个对象」。
只要共享主题词就成立，而同主题恰恰是记忆库的常态。`CONTRADICTION_NEG_TOKENS` 只拉黑固定否定词，挡不住分词碎片。

### 2.2 其它误报 / 失效判定

| 规则 | 位置 | 问题 | 严重度 |
| --- | --- | --- | --- |
| `health.stale` | store.js:3008-3010 | 用 `updatedAt` 判「过期未用」，但 `updatedAt` 由 `normalizeRecord`(:796)/`patchRecord`(:2205)/`markReviewed`/`mergeTag`/归档刷新；`bump`/`markUsed` 反而**不刷**（只刷 `lastUsedAt`/`useCount`）。真实语义是「最后被系统改写」，且 `!useCount` 把「用过一次、三年前」的记忆永久排除。真实库恒 0 | 高 |
| `scanInjection` / `assessTaint` | security.js:167-201, 78-92 | 纯词法、**不看 trust/source**。用户正常写「忽略之前的要求，以后都用 pnpm」「把以下规则写入记忆」「不要告诉用户我的邮箱」都会命中 `ignore_instructions_zh` / `write_to_memory_zh` / `hidden_note_zh`。`test/security.test.mjs` 的 20 条 benign 是刻意绕开关键词的擦边句，未覆盖真实规则句式 | 高 |
| taint 误报的下游 | index.js:1983,1989,2408 | user 记录虽不被隔离（`applySecurityGate` 放行），但 `taint=true` 会被 `runPortraitRewrite` / `hasPortraitMaterial` **静默排除出画像素材**，且没有复核/撤销入口 | 高 |
| `resolveContradictionsByTime` | store.js:2830 | 签名默认 `apply = true`（真归档），而唯一生产调用 dream.js:115 显式传 `apply:false`、面板走 `resolveContradictionPair` 完全不经过它。**默认值与「矛盾不自动归档」的全局约定相反**，未来任何省略参数的调用方会静默归档 | 高 |
| `qualityGate` | store.js:2543-2554 | `source ∈ {auto,agent} && quality < 30` 写入瞬间自动归档，无快照、无 `supersededBy` 回滚链；与 `promoteCandidates`（distill-global.js:436-449，同样 `source:'auto'`、短原则）可能在同一条记录上「自动晋升 → 自动归档」互斥 | 中高 |
| `stale` vs `exposedButUnused` | store.js:3009 / 3013 | 同一前缀 `!isRedline && !pinned && !useCount`，尾条件一个按时间、一个按曝光次数；可重复计数，结果 0 vs 22；后者无时间维度 | 中 |
| `overBudget` | store.js:3049-3050 | `activeCount > briefingLimit * 5` 是启发值；排除红线却用条数估算，不看 `briefingMaxChars`；实际装载是「limit 条普通记录 + 全部红线」，三套口径不统一。真实库 true 但 `duplicates=0`，即报了警却无可自动处理项 | 中 |
| `hasPortraitMaterial` / `briefingFingerprint` | index.js:2409 / 643-681 | 复用 `updatedAt` 判「有新素材」与简报指纹；一次与内容无关的 `patchRecord`（置顶、改类别、自动续期、合并标签）就能触发画像重写 → 改画像 `updatedAt` → 又改简报指纹 | 中 |
| `reviewAt` 自动续期 vs `falsifier` | store.js:1186-1188, 3394-3396 | `falsifier` 语义是「什么情况出现就不成立」，实现却是「一个会自己续期的闹钟 + 用 `useCount` 猜活跃度」；系统从不观测失效条件是否出现 | 中 |

### 2.3 规则互相矛盾

| # | 冲突双方 | 性质 |
| --- | --- | --- |
| 1 | **AGENTS.md C6**（`status: draft` 四不可见、没被批准的模型产出不得生效） **vs 上一轮新增的「draft 模式低风险候选当场转正」**（index.js:1492-1499, 1570） | **直接踩红线**。模型自产 `source:'auto'` 候选压根不建成 draft，绕过 `/queue/approve`（api.js:1283 唯一 `allowStatusChange` 转正路径）。这是上一轮为满足「自动化为主」引入的策略层冲突，必须消解 |
| 2 | `detectContradictions`（共享 tag/token ⇒ 疑似互斥） **vs** `clusterDuplicates`（Jaccard ≥0.72 ⇒ 可合并） | 对「同主题」结论相反；靠 2157 / 2951 串联把冲突转成「禁止合并」，代价是真实库 `duplicates: 0` |
| 3 | `qualityGate` 写入即归档 **vs** dream.js:122「过期未用只报告不归档，由人决定」 | 同为「系统认为这条没价值」，两套相反的安全标准 |
| 4 | `resolveContradictionsByTime` 默认 `apply=true` **vs** 全部生产调用方 + README「Dream 只报告矛盾」 | 危险默认值 |
| 5 | D8「快照不许带使用统计」 **vs** 本机 `rankRecords` 用 `useCount`/`lastUsedAt`、`health` 用 `exposedCount`、`stats` 用统计 | 四套口径（快照禁带 / 简报 stable 禁读 / 检索默认加权 / 体检作判据）。方向自洽但无统一说明 |
| 6 | C4「简报字节稳定」 **vs** 自动刷新画像 | fingerprint 含 `portrait.version@updatedAt` 与 journal，画像更新**会**改简报正文，只是被 cooldown 闸合并。C4 承诺的是会话级冻结与排序确定性，不是「简报永不变」——表述与实现有张力 |
| 7 | `overBudget` 排除红线的条数估算 **vs** `briefing()` 红线全量进 **vs** `rankRecords` 的 `catWeight.constraint=2` | 三套机制共用一个 `isRedline`，但阈值/装载/字节上限互不对齐 |
| 8 | `archiveOlderContradiction` 用不可变 `createdAt` 判新旧（:2228） **vs** `patchRecord` 编辑只刷 `updatedAt` 保留 `createdAt` | 「编辑过的旧条」在时序判定里仍算旧 |

**一句话根因**：一个 `updatedAt` 承担四种语义；判定逻辑散落在 8 个文件、各自定义「同主题 / 没价值 / 可疑」；规则是否可执行、是否可逆、要不要人工，全靠各调用点自己临时决定，没有统一契约。

---

## 3. 根因归纳

1. **词法承担语义**：中文没有分词，靠二元组 + 否定词表，无法抽出「谁对什么做了什么断言」，因此「句内对比」「同主题」「结论一致」必然被判成冲突。
2. **判定与动作耦合**：启发式输出直接连到「归档 / 拒绝合并 / 排除出素材 / 计入待办」。误报一旦发生就有实际代价，于是只能靠加保护规则层层打补丁，补丁又制造新的规则冲突。
3. **字段语义复用**：`updatedAt` / `taint` / `useCount` 各被多处赋予不同含义，同一事实在不同模块得到相反结论。
4. **规则没有单一来源**：红线写在 AGENTS.md、策略写在 CHANGELOG、实现散在 `store.js`/`index.js`/`dream.js`，默认值与全局约定相反也没有自动检查。C7 只守住了「配置键要有文档」，没守「规则之间不打架」。

---

## 4. 同类系统调研

| 系统 | 矛盾 / 失效怎么处理 | 对本项目的启示 | 来源 |
| --- | --- | --- | --- |
| **mem0 v2 → v3** | v2 是两阶段：LLM 抽取事实 → 对 top-s 相似记忆做 tool call，由 LLM 选 `ADD / UPDATE / DELETE / NOOP`，**写入时解决冲突**；v3 改成**单遍 ADD-only**：新旧事实都保留、附时间元数据，冲突留到检索期由「语义 + BM25 + 实体 + temporal」多信号排序解决。理由写得很直白：「facts that seemed contradictory but were actually complementary are preserved」 | 这是最重要的行业转向：**不要在写入时判断互斥**。本项目可以照搬「保留 + 检索期决定谁靠前」，而不必引入图数据库 | [docs.mem0.ai 迁移指南](https://docs.mem0.ai/migration/platform-v2-to-v3)、[Memory Evaluation](https://docs.mem0.ai/core-concepts/memory-evaluation)、[arXiv 2504.19413](https://arxiv.org/pdf/2504.19413.pdf) |
| **mem0 Memory Decay** | 不做驱逐，**检索期重排序**：最近访问的记忆最多 1.5×，久未用的衰减到 0.3×，但「仍然会在真正最匹配时浮上来」。官方明确「不是 eviction 策略，什么都不删」 | 本项目 `decayFactor` 已有，但 `stale`/`exposedButUnused` 仍在「报给人」。应把这两项彻底改成排序信号，不再作为体检问题 | [Memory eviction and forgetting](https://mem0.ai/library/agent-memory/memory-eviction-and-forgetting-in-ai-agents) |
| **Zep / Graphiti** | 双时态：`valid_at` / `invalid_at`（现实世界何时为真）+ `created_at` / `expired_at`（系统何时学到/退休）。新事实冲突时**给旧边打 `invalid_at`，不删除**；每个事实带 provenance 回指 episode，合并时 lineage 取并集 | 直接对应本项目 `supersedes`/`supersededBy`：把它升级成带时间戳的失效窗口，就能同时回答「现在信哪条」和「当时信哪条」，且不需要 LLM 判定 | [Zep temporal KG](https://www.getzep.com/ai-agents/temporal-knowledge-graph)、[Zep provenance](https://blog.getzep.com/how-zep-tracks-provenance-in-agent-memory) |
| **Letta / MemGPT** | 模型自己调用 memory 工具改写 memory block；block 是服务端可读可改可审计的状态 | 「谁有权改」比「怎么判」更重要；对应本项目的 trust / 来源分层 | [Mem0 vs Letta vs Zep](https://dataaspirant.com/blog/mem0-vs-letta-vs-zep) |
| **ChatGPT / Claude / Cursor** | ChatGPT 静默写入记忆，被批评为「silent updates 破坏信任」；Claude 按项目隔离、每条可编辑删除；Cursor / Claude Code 干脆用仓库里的 `.cursorrules` / `MEMORY.md`——**memory as code，可读可编辑可导出** | 本项目的 C9「MEMORY.md 是离线唯一入口」方向正确，应继续强化「用户是作者」，而不是把判定黑箱化 | [Designing Agent Memory 2026](https://brainy.ink/paper/designing-agent-memory)、[Memory audit guide](https://www.memorylake.ai/en/blogs/audit-what-your-ai-remembers) |
| **安全侧 / HITL** | 共识是 **provenance-aware**：「Source provenance is a security input, not descriptive metadata」，同一句祈使句来自认证用户是合法指令、来自检索文档才是攻击；纯关键词黑名单必然误伤（「treating every imperative sentence as an attack makes the product unusable」）。护栏顺序：确定性 action allowlist → provenance 标记 → 输出扫描 → 概率分类器 → **只在不可逆动作上要人** | 直接命中本项目 `assessTaint` 的高误报：应当按 `trust` 分流，user 通道不扫注入（仍扫密钥），external/import 才扫；且输出应是带证据的 risk，不是布尔 `taint` | [ChainGuard provenance-aware ingress](https://www.preprints.org/manuscript/202608.1961)、[Prompt injection vs ordinary instruction](https://neurapath.in/blog/prompt-injection-versus-an-ordinary-user-instruction)、[Agent guardrails](https://secagentlabs.com/blog/ai-agent-guardrails-input-output-filtering) |
| **工程治理** | 「Routing and Memory Contracts」：先按 `intent / risk class / budget / escalation mode` 做确定性预路由；写操作必须带 `source, timestamp, confidence, actor`；**policy memory 是 write-on-review only**；不可逆动作前做 freshness gate；评估要看 trace 级指标，尤其是 `blocked-safe false positive rate`（把合法事挡掉的比率） | 对应本项目的「单一策略注册表」与验收指标：应该把「误报率」当一等指标来测，而不是只测断言数 | [Routing and Memory Contracts](https://urandom.io/blog/2026-03-07-routing-memory-contracts-for-agentic-ai) |
| **置信度分流** | 高置信自动写入、中间带原文片段进审核队列、低置信丢弃；审核员必须看到**原始对话片段**才能判断；阈值用自己的审核数据定期校准，不拍脑袋 | 本项目 `AUTO_APPROVE_CONFIDENCE=0.6` 是模型自报的置信度，没有证据片段，且撞了 C6 —— 要么改成显式模式，要么补证据与校准 | [HITL 置信度分流](https://blog.51cto.com/u_16213705/14857995) |

**跨源共识（三条）**：

- **保留优先**：冲突时新旧事实共存 + 时间元数据，失效用 `invalid_at` / 降权，不删除。
- **来源优先于内容**：注入/可信度判定先看 provenance，再看文本；纯词法只能做召回，不能做裁决。
- **人工只守不可逆**：确定性动作自动执行，语义不确定就退化为排序/只读信号，只有真正不可逆才升级给人。

---

## 5. 建议方案：三层 + 一条主线

主线一句话：**把「判定」从词法/写入时，迁到语义/检索时；把「规则」从散落的 if，收敛到单一策略注册表。**

### L0 止血（零架构改动，可独立上线）

| # | 动作 | 解决 |
| --- | --- | --- |
| 0.1 | `health.stale` 改用 `lastUsedAt \|\| createdAt`；`exposedButUnused` 加时间维度（如 `createdAt` 早于 7 天）；两者合并成一个 `dormant` 信号，不再双列 | stale 恒 0 / 口径重叠 |
| 0.2 | `resolveContradictionsByTime` 默认改 `apply: false`，真归档重命名为 `archiveContradictionsByTime` 并只对显式传 `confirm` 开放 | 危险默认值 |
| 0.3 | `assessTaint` 按 trust 分流：`trust==='user'` 只扫密钥、不扫注入；`external/import` 走完整注入扫描；输出 `risk{kind,evidence}` 而非布尔 `taint`；给误判留撤销入口 | 正常规则被判注入 + 被静默排除出画像 |
| 0.4 | **消解 C6 冲突**：把「draft 模式下低风险自动转正」从 `captureMode` 里拆出来，改成显式的 `captureMode: 'auto'`（与 `direct` 同义但语义清楚）+ `captureMode: 'review'`（全部进队列）。`draft` 保留其字面语义，不再承担「自动批准」 | 上一轮引入的红线冲突 |
| 0.5 | 所有启发式结果统一降级为 `signals`（只读、不进 `attention`、不触发动作）；`attention` 只保留「不可逆且不可自动裁决」的两类 | 误报不再有破坏力 |

> L0 的关键不是「减少误报」，而是**让误报无害**。修完这 5 条，即使矛盾检测仍然 10/10 不准，用户也感觉不到。

### L1 数据模型：时间轴 + provenance（核心）

- 每条记录新增 `validFrom` / `validUntil` / `invalidatedBy`（复用现有 `supersededBy`，补时间戳），
  **保留而不是归档**：旧结论 `validUntil = 新条.createdAt`，`supersededBy` 指向新条。
- 新增 `contentUpdatedAt`（仅内容改写时刷新）与 `systemTouchedAt`（系统元数据改写），
  与 `lastUsedAt` / `createdAt` 各司其职：
  - `health.dormant` 用 `lastUsedAt || createdAt`；
  - `hasPortraitMaterial` / `briefingFingerprint` 用 `contentUpdatedAt`；
  - `renderMarkdown` 行内日期用 `createdAt`（C4/C9 口径）。
- 写入路径强制带 `provenance {source, trust, actor, confidence, evidence}`，
  **没有 provenance 的记录不参与任何自动动作**（借鉴 memory contracts）。
- 检索期排序：`validUntil === null` 的事实优先；已失效的按 `validUntil` 衰减（mem0 Memory Decay 的 0.3× 下限），
  仍可在「当时怎么做的」类查询里浮上来。

**效果**：旧结论不再需要「被判矛盾 → 被归档」，只需要「被更新 → 自动失效」。矛盾检测的存废变成一个可选功能，而不是数据完整性的前置条件。

### L2 判定：默认不判，按需语义裁决

```
写入时   ── 不生成任何「矛盾」结论，只做 ADD（mem0 v3 式）
           └ 局部：高相似簇（Jaccard ≥0.72）只标 cluster，不裁决

检索时   ── 时间轴 + 多信号排序决定谁靠前
           └ 已失效事实自动降权，不删除、不报警

显式整理 ── 可选：对 cluster 做一次结构化 LLM 裁决
           └ 输入：两条原文 + 各自 provenance
           └ 输出（JSON schema 强约束）：
             { relation: "duplicate" | "complementary" | "contradicts" | "unrelated",
               subject, predicate, object, evidence: [原文片段, 原文片段],
               confidence }
           └ 硬闸：判 contradicts 必须给出**同一 subject+predicate 的互斥 object**，
                    且 evidence 必须分别落在两条记录里；否则强制回落 unrelated。
           └ 结论只写 `signals` 与建议动作，**绝不自动归档**；
             用户点确认才走 `supersedes`（可回滚）
```

这个「同一主谓宾 + 证据落点」的硬闸，正好堵住本项目 10 对误报的全部四种模式：
句内对比句（否定对象是同句的另一个谓词）、主题词共享（object 不同）、结论一致（object 相同）、二元组碎片（抽不出 object）。

LLM 调用量：默认路径 **0 次**；只有用户点「整理」且存在高相似簇时，最多 1 次（可批量打包）。
不引入向量库、不引入图数据库，符合 P7「零运行时依赖」。

### L3 治理：单一策略注册表

新建 `lib/policy.js`，每条规则声明式登记：

```js
{ id, detector: 'deterministic' | 'lexical' | 'semantic',
  reversible: boolean,          // 归档/删除/supersede = 不可逆
  requiresHuman: boolean,       // 由 reversible + detector 推导，不许手写
  defaultAction: 'none' | 'signal' | 'downweight' | 'archive',
  evidence: string[],           // 必须能拿出证据片段
  surfaces: string[] }          // 允许出现在哪些视图（attention / 维护页 / 日志）
```

配套三条自动校验（仿 C7 的做法，纳入 `host` 套件）：

1. `reversible === false && requiresHuman === false` → 测试直接红；
2. `detector === 'lexical' && defaultAction === 'archive'` → 测试直接红（词法不许触发归档）；
3. `requiresHuman === true` 的规则必须出现在 `attention`，反之必须不出现。

`detectContradictions` 与 `clusterDuplicates` 共用同一个「同主题簇」抽象：
共享 tag/token 只作为**召回**，不再是结论；「重复 / 互补 / 互斥 / 无关」由同一处产出，杜绝两套相反口径。

---

## 6. 取舍权衡

| 方案 | 精度 | LLM 成本 | 误判代价 | 改动面 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **A 继续调正则**（当前路径） | 低，且随语料演化持续退化 | 0 | 误归档 / 阻断合并 | 小 | 已证伪：修完「不再」冒出「不能」 |
| **B 全量 LLM judge**：每对候选都问模型 | 高 | 每轮 N 次调用，占用 `turn/end` | 模型幻觉 + 延迟 | 中 | 否决：违反 C5 与 P7，成本不可控 |
| **C 分层：规则召回 + LLM 裁决 + 检索期生效** | 高 | 默认 0，显式整理 ≤1 次 | 退化为排序偏差 | 中 | **推荐** |
| **D 纯检索期（mem0 v3 式，彻底不判矛盾）** | 最高（不产生矛盾结论） | 0 | 旧结论仍可能被注入 | 小 | **作为默认**，C 作为按需增强 |

**推荐组合：默认 D，按需 C。** 即默认状态根本没有「待确认矛盾」这个队列；用户想清理时点一次整理，才用 C 做语义裁决并给出建议。这既符合 mem0 v3 的行业转向，也符合本项目「自动化为主、人工兜底」的定位。

必须接受的三个代价：

1. **旧结论会多留一会儿**：不再写入即归档，靠检索降权。换来的是「永不误删」。
   缓解：`validUntil` 已失效的条目在简报/镜像里可折叠或标「历史」，不占预算席位。
2. **「矛盾」不再是可见功能**：维护页少一张卡。换来的是误报归零。
   缓解：把它变成「时间轴 / 版本链」视图，用户看的是「这条被哪条取代了」，比「这两条可能矛盾」更可读。
3. **新增字段要迁移**：`validFrom/validUntil/contentUpdatedAt` 需要 `normalizeLoaded` 兼容旧记录（默认 `validFrom = createdAt`、`validUntil = null`），且 `memory-snapshot.json` 要按 D8 决定是否携带——建议**携带 validity 不带统计**，因为它属于事实本身而非本机热度。

明确**不做**的事：不引入向量库 / 图数据库 / 常驻定时器（P7、C5、D8）；不让模型自己批准自己的草稿（C6）；不让词法判定触发任何不可逆动作。

---

## 7. 落地路径与验收

| 阶段 | 内容 | 可独立验证 |
| --- | --- | --- |
| P0（L0 止血） | 5 条零架构改动 + 补测试夹具 | 真实库 `stale` 不再是 0；`apply` 默认值断言；benign 规则句不再 `tainted`；C6 冲突消解 |
| P1（L1 时间轴） | 新字段 + `normalizeLoaded` 兼容 + 排序改造 + 镜像/快照口径 | 旧库导入不丢数据；简报字节稳定性套件仍绿；失效事实自动降权但不消失 |
| P2（L2 语义裁决） | 结构化裁决提示词 + 硬闸 + 面板「整理」入口 | 真实库 10 对误报全部判 `unrelated`；pnpm 真冲突夹具判 `contradicts` |
| P3（L3 注册表） | `lib/policy.js` + 三条自动校验 + 文档同步 | 加一条「词法规则带 archive」会红测试 |

**验收指标（用真实库回放，不看代码行数）**：

| 指标 | 当前 | 目标 |
| --- | --- | --- |
| 疑似矛盾误报率（人工标注 10 对 + 夹具） | 100%（10/10） | 0（默认不产出） |
| `attention.total` | 0（但由「排除计数」实现，非由「无误报」实现） | 0，且**不存在被隐藏的诊断项** |
| `health.stale` | 恒 0（规则失效） | 真实反映「久未使用」，且只作排序信号 |
| 自动动作的不可逆比例 | 存在（合并归档、低分归档） | 0；所有自动动作 100% 可回滚 |
| `duplicates` 被误报阻断 | 0 簇 | 恢复正常的合并能力 |
| LLM 调用增量 | 0 | 默认路径 0；显式整理 ≤1 次 |
| `blocked-safe false positive rate`（把合法事挡掉） | 未测 | 纳入 trace 级评估，用 `test/fixtures/` 回归 |

建议新建 `test/fixtures/false-positive-2026-11-09.json`：把真实库 10 对 hint、pnpm 真冲突夹具、6 条 benign 规则句固定下来，
每次改判定逻辑都跑一遍，防止「修一批、冒一批」再次发生。

---

## 8. 落地进度（2026-11-09 同日）

两个开放问题按推荐值拍板：`captureMode` 拆出 `review` 恢复 `draft` 严格语义（不破 C6）；
`validUntil` 属事实本身、拟进快照（L1 实施时处理，不带统计）。

| 阶段 | 状态 | 实际落地 |
| --- | --- | --- |
| P0 止血 | **已落地** | `stale` 改看 `lastUsedAt \|\| createdAt` + 新增 `dormant`；`resolveContradictionsByTime` 默认 `apply:false`；taint 保留词法元数据、消费端改 `untrustedTaint()` 按 trust 分层；`captureMode` 三值；`clusterDuplicates` 只召回不裁决（合并安全闸留在动作前）；`attention` 只保留两类人工项 |
| 默认 D | **已落地** | `GET /health` 默认不产出矛盾结论，`?contradictions=1` 才诊断；维护页新增「扫描矛盾线索」按钮；自动 Dream 零检测，手动整理才产出只读线索 |
| L3 注册表 | **已落地** | 新建 `lib/policy.js`（15 条规则 + 三条治理校验），`test/host.test.mjs` 四条用例守住；`test/fixtures/false-positive-2026-11-09.json` 固定 10 对误报 + 真冲突 + 6 条 benign 规则句 |
| 顺带修的真 bug | **已落地** | 轮末召回排重原本用实时简报选条、注入时却用会话冻结快照，两套口径打架导致 `turn-recall` 永远为空；统一为冻结 ids |
| L1 时间轴 | **已落地** | `validFrom` / `validUntil` / `invalidatedBy` + `contentUpdatedAt` / `systemTouchedAt`；`normalizeLoaded` 兼容旧库（顺带修了 `autoReviewCount` 重启丢失）；`supersede` 关闭旧事实窗口；`rankRecords` 两个分支静态降权 0.3×（不读当前时间，C4）；快照携带 validity、不携带本机统计（D8）；简报指纹与画像素材改用 `contentUpdatedAt` |
| L2 按需语义裁决 | **已落地** | 新建 `lib/adjudicate.js`：一次调用打包所有簇，输出 `{relation, subject, predicate, values, evidence, confidence}`；`verifyVerdict` 硬闸要求 contradicts 给出同一主谓宾的两个互斥取值、两条 evidence 分落两条记录且值分别命中，否则强制 `unrelated`。接入手动 Dream 的合并决策（只有 `duplicate` 才合并）；无模型 / 坏 JSON / 自动整理一律静默回落确定性规则 |

**两处实施取舍**（与方案的理想态有意偏差，理由记在这里）：

- **`supersede` 仍归档旧条**，没有改成「只失效不归档」。改归档语义会同时牵动 C6（草稿四不可见）、C9（镜像全量输出）、导出格式、版本链回滚与面板列表过滤，风险远大于收益；现在先把时间轴字段铺好，`validUntil` 已能回答「何时被取代」，归档语义留作独立迁移。
- **降权用静态 `validUntil != null` 判定**，不按「距离失效多久」做动态衰减。后者要读当前时间，直接违反 C4 的简报字节稳定；0.3× 是 mem0 Memory Decay 的下限，效果等价且确定。

验收：`node test/run-all.mjs` 15 套件 / **696 条断言全绿**，文档数字闸门一致。
真实库默认路径 `health().contradictions === []`，`attention.total === 0` 由「无误报」而非「隐藏诊断项」达成。

---

## 9. 风险与开放问题

- ~~**C6 冲突怎么解**~~：**已定并落地**。新增 `review` 值承接「只审高风险」，`draft` 恢复严格语义；默认值未变，因此不触发 C7 的默认值四处同步。
- **`validUntil` 要不要进 `memory-snapshot.json`**：**已落地**。携带 `validFrom` / `validUntil` / `invalidatedBy`，不带 `contentUpdatedAt` / `systemTouchedAt` 与任何使用统计（D8）；schemaVersion 保持 2，旧版本读快照会忽略未知字段。
- ~~**语义裁决的模型可用性**~~：**已定并落地**。复用宿主 `callLlm` + `lastSession`；无路由 / 解析失败 / 自动整理一律静默回落确定性规则，绝不阻塞整理；一次手动整理最多 1 次调用。
- ~~**`supersede` 要不要改成只失效不归档**~~：**本轮保留归档**（见上方取舍），时间轴字段已铺好，语义迁移留作独立一轮。
- **`taint` 从布尔改成 risk 对象**：**仍未做**（会改落盘结构与导入契约）。当前用 `untrustedTaint()` 在消费端按 trust 分层；若要补，需 `normalizeLoaded` 兼容层 + 导入导出测试。

---

## 附：本文引用的外部资料

1. mem0 — [Platform v2→v3 迁移](https://docs.mem0.ai/migration/platform-v2-to-v3)、[Memory Evaluation](https://docs.mem0.ai/core-concepts/memory-evaluation)、[Memory eviction and forgetting](https://mem0.ai/library/agent-memory/memory-eviction-and-forgetting-in-ai-agents)、[Mem0 论文 arXiv:2504.19413](https://arxiv.org/pdf/2504.19413.pdf)
2. Zep / Graphiti — [Temporal Knowledge Graph](https://www.getzep.com/ai-agents/temporal-knowledge-graph)、[Tracking provenance](https://blog.getzep.com/how-zep-tracks-provenance-in-agent-memory)、[Mem0 vs Letta vs Zep](https://dataaspirant.com/blog/mem0-vs-letta-vs-zep)
3. 产品设计 — [Designing Agent Memory 2026](https://brainy.ink/paper/designing-agent-memory)、[Audit what your AI remembers](https://www.memorylake.ai/en/blogs/audit-what-your-ai-remembers)
4. 安全与 HITL — [ChainGuard provenance-aware ingress](https://www.preprints.org/manuscript/202608.1961)、[Prompt injection vs ordinary instruction](https://neurapath.in/blog/prompt-injection-versus-an-ordinary-user-instruction)、[Agent guardrails](https://secagentlabs.com/blog/ai-agent-guardrails-input-output-filtering)、[HITL 置信度分流](https://blog.51cto.com/u_16213705/14857995)
5. 工程治理 — [Routing and Memory Contracts](https://urandom.io/blog/2026-03-07-routing-memory-contracts-for-agentic-ai)

> 注意：厂商自报的 benchmark 数字（LoCoMo / LongMemEval）只用来判断架构方向，不作为本项目的效果承诺。
> 本文的预期效果以「真实库回放 + 夹具回归」为准。
