---
name: delivery-check
description: 交付前自查。用户说「交付前自查 / 发版前检查 / 复查一下 / 可以发了吗 / 做一轮检查」时使用；也是 release 流程的必经步骤。重点不是跑测试，而是查那些测试抓不到的：交付物是否真的更新、文档是否跟上行为变更、上一次自查之后的提交是否都补了文档。
---

# 交付前自查

## 为什么需要它

测试全绿不等于交付合格。2026-11-06 的一次自查里，651 条断言全绿、CI 通过，但仍然查出 5 类问题：

- 工作区副本 `.dsh-memory/MEMORY.md` 还是半个月前的旧版（镜像改版只改了代码，产物从没重新生成）
- 文档写「51 个端点」、run-all 写「43 个」，实际 48 个
- 新工具 `tools/doc-numbers.mjs` 没登记进 `tools/README.md`
- skill 里还写着「素材比上次多了 5 条」，而代码早改成「还剩几条没被引用过」
- 规格文档的「五条记忆通路」实际列了 7 条

**这些一个都不会让测试变红。** 测试守的是行为，自查守的是「交付物和文档是否配得上这个行为」。

## 一条硬规则

**自查只对当时的 HEAD 有效。** 自查完又提交了东西，那次自查就作废了——必须重来，或者至少重查增量。

2026-11-06 犯过这个错：16:34 做了完整自查，之后又提交 4 次（蒸馏时机、候选池上限、doc-numbers、死结修复），然后直接发版。发版后追查，果然漏了 3 处文档。

## 第一步：跑自动化能查的

```bash
node test/run-all.mjs        # 测试 + 文档数字，两个闸门一起过
node tools/check-compat.mjs  # 兼容口径：package.json / README 表 / 清单
```

这两条已经覆盖了不少以前靠人工记的东西：

| 已被自动化接管 | 位置 |
|---|---|
| 全部测试 | `test/run-all.mjs` |
| 文档里的断言总数与套件数 | `tools/doc-numbers.mjs`，不一致直接红 |
| 每个配置键都在 README 与 REFERENCE 的配置表里 | `test/host.test.mjs` 的 C7 断言 |
| 包名逐字一致 | `test/client.test.mjs` / `host.test.mjs` |
| 兼容清单与 README 同源 | `tools/check-compat.mjs` |

**这两条红了就不用往下走了**，先修。

## 第二步：查自动化查不到的

按顺序，每条都要给结论（通过 / 已修 / 遗留）。

### 1. 交付物是不是真的更新了

代码改了，产物不一定跟着变。

```bash
ls -la .dsh-memory/                    # 时间戳是不是今天的
head -4 .dsh-memory/MEMORY.md          # 文件头是不是新版措辞
```

镜像只在「写入记忆」时重写。只改 `renderMarkdown` 的话，用户下次写记忆前看到的还是旧格式。必要时手动跑：

```bash
node --input-type=module -e "
import { createMemoryStore } from './lib/store.js';
const s = createMemoryStore({ dir: process.env.USERPROFILE + '/.dsh/storages/dsh-memory' });
console.log(s.refreshMirror(process.cwd()));
"
```

### 2. 上一次自查之后的所有提交

```bash
git log --oneline -10
```

逐个问：这个提交改了什么？对应的文档补了吗？

这一条最容易漏，因为它要求你**记得上次自查是什么时候**。忘了就按「全部提交」查。

### 3. 文档描述跟上了行为变更吗

代码改了行为，README / REFERENCE / skill 里的**描述**往往还是旧的——数字有闸门守着，描述没有。

重点查三类：

| 类型 | 例子 |
|---|---|
| 触发条件 | 「整理时顺带」→ 改成「模型决断」了没 |
| 判定标准 | 「比上次多了 5 条」→ 改成「还剩几条没被引用过」了没 |
| 数量 | 「五条记忆通路」实际有几条 |

```bash
grep -rn "比上次\|顺带\|每 7 天" README.md docs/REFERENCE.md skills/*/SKILL.md
```

### 4. 新文件有没有被索引

新增的工具、skill、文档，都要在三个地方之一出现：

| 新增什么 | 必须登记到 |
|---|---|
| `tools/*.mjs` | `tools/README.md` 的表格 |
| `skills/<name>/SKILL.md` | `skills/README.md` 的表格 + AGENTS 2.4 |
| `docs/*.md` | `docs/README.md` 的表格 + AGENTS 2.3 |

漏了不会红，只是以后没人找得到它。

### 5. 数量类描述

端点、配置键、套件数、断言数——任何写着数字的地方。

断言数与套件数已被 `run-all` 守住；**端点数没有**，得手工核对：

```bash
grep -cE "^    '(GET|POST|DELETE) /" lib/api.js    # 与文档里的数字比
```

### 6. 红线抽查（发版前必做）

不用全查，抽最容易静默坏的四条：

| 红线 | 怎么查 |
|---|---|
| **C1** 包名 | `node -p "require('./package.json').name"` + `grep name cordis.patch.yml` + `grep id lib/client.js` |
| **C7** 配置键 | 跑 `host` 套件（有断言） |
| **D8** 快照不带统计 | 实际渲染一次，看字段里有没有 `useCount` / `lastUsedAt` |
| **P7** 零依赖 | `dependencies: {}`，peer 全 `optional` |

### 7. 未提交的东西

```bash
git status --short
```

确认 `.idea/`、`.probe/` 这类本地材料**没有**被 `git add`（P8：不发布未跟踪内容）。确认该提交的都提交了——自查里的修复不能留在工作区。

## 第三步：出结论

三段，不要写成流水账：

```
## 结论
一句话：通过 / 有 N 处已修 / 有 N 处遗留

## 修复的
| 问题 | 严重度 | 处理 |

## 遗留风险
不打算修的、或修不了的，写清楚为什么
```

## 常见错误

| 错误 | 后果 |
|---|---|
| 只跑测试就说「自查完成」 | 测试守不住文档与交付物，这次 5 类问题全是这么漏的 |
| 自查后继续改代码，不再复查 | 自查作废，等于没做 |
| 只查「改了什么」，不查「改的东西描述对不对」 | 行为变了、文档还是旧的，用户按文档用会困惑 |
| 把 `.probe/` 一并提交 | 本地审计材料进了发布包 |
