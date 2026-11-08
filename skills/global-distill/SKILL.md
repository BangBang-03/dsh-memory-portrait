---
name: global-distill
description: 从单个项目的记忆里蒸馏出跨项目成立的原则（二级蒸馏）。用户说「提炼通用原则 / 归纳跨项目经验 / 更新全局记忆 / 二级蒸馏 / 这些经验哪些是通用的」时使用。产出带 category / topics / anchors 的候选原则，交给 lib/distill-global.js 判定晋升。
---

# 从项目记忆蒸馏全局原则

两级蒸馏的第二级。第一级是 `turn/end` 的 capture（会话 → 项目），这一级是项目 → 全局。

**核心原则：蒸馏是「生成抽象」，不是「复制条目」。** 项目里写「工作区镜像必须全量渲染，不按日期拆分」，全局里应该是「偏好完整信息，不为简洁牺牲内容」——两句话不一样，后者去掉了载体只留下偏好。

## 适用场景

- 用户说「这个项目里有哪些经验是通用的」「提炼一下原则」「更新全局记忆」。
- 项目记忆积累到一定规模（几十条以上），需要定期往上抽一层。
- 新项目启动，想知道之前总结过哪些跨项目原则。

## 先读

- `lib/distill-global.js` 的 `PROMOTION_RULES`：每个类别要几个项目、几个锚点才够。
- `docs/global-distill-trial-2026-11-05.md`：一次真实试跑，122 条记忆只蒸馏出 4 条，
  以及为什么 `convention` 类几乎全部不可上行。

**先看产出密度的预期：合格率大约 3%。** 如果一个项目蒸馏出 8 条，多半是标准放松了。

## 输入准备

按类别取记忆，**不要全量平铺**——`fact` / `note` / `component` / `task` 基本不上行，喂进去只会稀释判断。

优先顺序：

1. `feedback`（用户纠正过什么）—— 产出率最高，天然指向行为
2. `decision`（为什么放弃另一条路）—— 取舍逻辑最容易迁移
3. `preference` / `constraint` —— 用户亲口说的，单项目就能晋升
4. `convention` —— **产出率最低**，多数是本项目的发布/文档规范

每条只给标题 + 正文前 70 字 + `reason`，附上 id 供 anchors 引用。

## 提示词

以下整段可直接作为 system prompt 使用。

```
你是记忆蒸馏器。输入是一个项目的长期记忆条目，输出是这个项目里「跨项目仍然成立」的原则。

只输出 JSON 数组，不要任何解释、不要 markdown 代码块。0–3 条，宁少勿滥。

每条格式：
{
  "text": "一句原则，不超过 120 字",
  "category": "constraint | feedback | preference | decision | convention",
  "topics": ["2-3 个英文小写主题词"],
  "anchors": ["支撑这条原则的记忆 id，至少 2 个"]
}

判定「跨项目成立」的标准：
- 它讲的是「怎么做事的规矩」，不是「这个项目的具体状态」。
- 去掉所有专有名词后仍然成立。
- 换一个完全不同的项目，它依然是对的。

三类必须禁止：

1. 携带项目载体——文件路径、文件名、命令、版本号、包名、项目名。
   反例：「发布前跑 node test/run-all.mjs」
   正例：「改完必须跑全量测试再提交」

2. 只有一个锚点——可能只是偶发偏好，不足以称为原则。

3. 常识套话——写测试、注意安全、保持简洁、及时沟通这类正确的废话。
   反例：「要写单元测试」
   正例：「改动必须验证再提交，不接受『应该没问题』这种说法」

category 只能是这五个之一，按证据来源选：
- constraint：用户明确说过「绝对不要 / 永远不要」
- feedback：用户纠正过你的某个行为
- preference：用户表达过的工作偏好
- decision：从取舍里推断的（为什么放弃了另一条路）
- convention：从反复出现的行为里归纳的

topics 用英文小写，2–3 个，要能在不同项目之间对上（如 backup / irreversible /
verification / non-blocking）。不要用项目名、技术栈名、产品名做 topic——那会让
跨项目聚类失效。

如果没有一条满足以上标准，输出 []。
```

## 输出格式

```json
[
  {
    "text": "不可逆操作前必须先留可回滚的快照，不做自动裁决",
    "category": "decision",
    "topics": ["backup", "irreversible"],
    "anchors": ["mem_abc123", "mem_def456"]
  }
]
```

解析容错：模型常会套一层 ```json 代码块或加一句「以下是结果」。剥掉围栏、取第一个 `[` 到最后一个 `]`，再 `JSON.parse`。解析失败当空数组处理，不要重试超过一次。

## 校验（落库前逐条过）

**自动拒绝**，对照 `lib/distill-global.js` 的 `candidateRejection`：

| 拒绝原因 | 触发条件 |
|---|---|
| `cliche` | 命中套话正则 |
| `too-short` / `too-long` | 少于 10 字 / 超过 240 字 |
| `carries-path` | 出现盘符或 `/Users` `/home` 这类路径 |
| `carries-filename` | 出现 `.js` `.yml` `.md` 等扩展名 |
| `carries-version` | 出现 `v1.2.3` |
| `carries-package` | 出现 `@scope/name` |
| `carries-command` | 出现 `npm` `git` `node` 等命令 |

**人工复核**：

- [ ] topics 里没有项目名 / 技术栈名（否则跨项目永远对不上）
- [ ] anchors 里的 id 真实存在；`constraint` / `feedback` 至少 1 条，`preference` / `decision` 至少 2 条，`convention` 至少 2 条（晋升时还要跨项目合计 3 条）
- [ ] 「换一个项目还成立吗」这个问题，答案是肯定的
- [ ] 条数不超过 3，且没有一条是「因为写得很顺所以留着」

## 落库

**什么时候提炼由模型自己判断**，不是定时任务：在工具里调 `memory` 的 `distill-global` 动作
（那段工作告一段落、或者好几条记忆指向同一条通用原则时），或用本 skill 手工跑一次。
兜底是轮末——按 `globalDistillMinNew`（默认 3 条）检查还剩几条**没被提炼过**的素材
（按候选的 `anchors` 判断哪条用过）；`feedback` / `constraint` / `preference` 未覆盖达到 2 条时提前触发。
时间闸自适应：基础 `globalDistillCooldownMinutes`（默认 15 分钟），连续空跑按 2 倍退避到 24 小时，有产出清零。
每次尝试都落 `<ws>/global-distill.json`，`/health` 的 `globalDistill` 与维护页能看到素材 / 解析 / 拒绝原因。

候选原则写入全局候选池，格式 `{ text, category, topics, anchors, project, at }`，
由 `promotionReport()` 聚类后交给 `PROMOTION_RULES` 判定：

- 达标 → 生成全局记忆（`active`，自动为主，不弹确认）
- 未达标 → 留在池里等第二个项目
- 被用户否过 → 标 `rejected`，同主题不再提议

## 常见错误

| 错误 | 后果 |
|---|---|
| 把一个项目的具体命令写成原则 | 到别的项目就是错的指令，而且很难被发现 |
| 用项目名或技术栈名当 topic | 跨项目聚类永远匹配不上，自动路径彻底失效 |
| 为了凑数放宽标准 | 全局记忆被稀释，用户开始忽略它 |
| 只蒸馏 `convention` | 产出率最低的一类，21 条里通常只有 3 条能上行 |
| 把「这次的临时决定」写成原则 | 换个会话就不成立，属于第一级蒸馏该拦下的噪声 |

## 相关

- 判定逻辑：`lib/distill-global.js`
- 试跑记录与淘汰分析：`docs/global-distill-trial-2026-11-05.md`
- 项目记忆文件的写法：`skills/memory-doc/SKILL.md`
