# Memory Portrait · 记忆画像

[![Release](https://img.shields.io/github/v/release/BangBang-03/dsh-memory-portrait?color=4d6bfe&label=release)](https://github.com/BangBang-03/dsh-memory-portrait/releases/latest)
[![npm](https://img.shields.io/npm/v/@bangbang-03/dsh-memory?color=4d6bfe&label=npm)](https://www.npmjs.com/package/@bangbang-03/dsh-memory)
[![License](https://img.shields.io/github/license/BangBang-03/dsh-memory-portrait?color=4d6bfe)](https://github.com/BangBang-03/dsh-memory-portrait/blob/main/LICENSE)
[![Tests](https://img.shields.io/badge/tests-701%20passed-4d6bfe)](https://github.com/BangBang-03/dsh-memory-portrait#测试)

**DSH 的记忆画像：不是记住更多，而是让你看见它怎么理解你。**<br>
**Long-term memory for DeepSeek Harness, with a portrait you can inspect.**

![Memory Portrait：一轮对话里的记忆回路](https://raw.githubusercontent.com/BangBang-03/dsh-memory-portrait/main/docs/assets/hero.png)

**中文** ｜ [English](#english) ｜ [项目主页](https://bangbang-03.github.io/dsh-memory-portrait/)

> 仓库名已改为 `dsh-memory-portrait`；npm 包名仍是 `@bangbang-03/dsh-memory`，安装命令不变。

**Memory Portrait** 把记忆按工作区落库：会话开始时注入一份**索引简报**（一行一条，正文按需用 `memory` 工具取，省 token），
轮次结束后用本地检索把相关记忆**召回**到下一轮，可选地把对话**自动提炼**成结构化记忆。
它把「画像」放在首页：模型现在怎么理解你、每段判断来自哪条记忆、这一版和上一版差在哪里——有证据、有版本、能解释变化。
和「自动多记一点」的插件不同，它把重点放在**记错了怎么办**：红线、审批队列、版本链、注入审计、派生链，全部能在 **设置 → 记忆** 里看到。

- **画像是主视图**：每段挂证据，改了什么可 diff，源失效沿派生链标脏。
- **省 token**：索引模式同样预算多装约 3 倍条目；简报字节稳定，不破坏 prompt 前缀缓存。
- **可控**：自动提炼可先进审批队列；红线逐字置顶，模型不能删改；改稿留历史，可回滚。
- **可审计**：每次注入都记录正文 hash、命中的记忆 id、被预算挤掉的条目；画像与 `AGENTS.md` 有派生链。
- **零依赖**：`dependencies` 为空，只要 fs + 回环 HTTP；不 shell、不 env、不启子进程、不出站、不加载动态代码。

> **English** — Long-term workspace memory for DeepSeek Harness, with an inspectable portrait: every section carries evidence, versions, and diffs. Redlines, an approval queue, a version chain, and an injection audit are included. Zero dependencies; no shell, env, or outbound requests. [Jump to English](#english).

## 安装

DSH ≥ 0.2.0-rc.2，web / 桌面。headless / TUI profile 尚未做端到端验证，暂不声明。

### 一条命令（推荐，web profile）

```powershell
dsh plugin --profile web add "https://github.com/BangBang-03/dsh-memory-portrait/releases/latest/download/dsh-memory-latest.tgz"
```

`/latest/` 永远取最新稳定版，不需要 clone，也不需要 npm。

### npm（web profile）

```powershell
dsh plugin --profile web add @bangbang-03/dsh-memory
```

> npm 源与 Releases 同源；如果 `npm view @bangbang-03/dsh-memory version` 低于 Releases，用上面的「一条命令」。

### 桌面端

把 [`install.ps1`](https://github.com/BangBang-03/dsh-memory-portrait/blob/main/install.ps1) 下载到任意目录，然后：

```powershell
pwsh -File install.ps1 -FromRelease -Channel stable
```

脚本会下载最新稳定版 tarball、解包到 `~/.dsh/plugins/dsh-memory`，再完成垫片 / profile 清单 / junction 三步；**更新就是重跑同一条命令**。`-Channel lab` 是兼容别名，等同 `stable`。

### 源码

```powershell
git clone https://github.com/BangBang-03/dsh-memory-portrait.git
cd dsh-memory-portrait
pwsh -File install.ps1 -DryRun     # 先看一遍要改什么
pwsh -File install.ps1             # 真装
# 重启 DSH 桌面端
```

> `dsh plugin --profile desktop …` 会被拒绝：desktop profile 由 Electron 独占。桌面端用上面的 `install.ps1`。
> 改 profile 前脚本会自动备份（秒级时间戳，不覆盖旧备份）。回滚：`pwsh -File uninstall.ps1`（记忆数据保留）；
> `-PurgeStorage` 才会删 `~/.dsh/storages/dsh-memory`。

装好后打开 **设置 → 记忆**。宿主路由是 `/memory/api`，只监听回环地址；客户端用 `new URL("memory/api/…", document.baseURI)` 解析，反代前缀 / `dsh-app://` 外壳下也能到达。

## 兼容性

| DSH 版本 | 状态 |
| --- | --- |
| `0.2.0-rc.2` | compatible（已测试） |
| `0.2.1-rc.3` | compatible（已测试） |
| `0.2.1-rc.4` | unknown（范围覆盖，未单独测试） |
| `0.2.1-rc.5` | compatible（当前桌面版，已测试） |
| `0.2.2-alpha.2` | unknown（范围覆盖，未测试） |

Node `^22.19.0 || >=24.0.0`；DSH 范围 `>=0.2.0-rc.2 <0.3.0-0`。范围按 **0.2 版本线**整体声明，避免 DSH 每发一个 nightly 就在宿主启动时被跳过；逐版本测试结论仍记在 `dsh.compatibility.dshReleases`，未测试的版本标 `unknown`，不冒充 compatible。

> DSH 0.2.1 起，宿主在启动 / 重新组合时按 `engines.dsh` 判定组合包：不匹配的 bundle 会被**静默跳过**（列进 `skippedBundles`），市场卡片显示“已安装，与当前 dsh 不兼容”，插件功能整体不生效。升级 DSH 后若看到这行字，先确认上表的范围覆盖当前版本。

> 兼容口径不是手写三份：`node tools/check-compat.mjs` 会核对 `package.json` 与 README 表格；`--npm` 再核对 npmjs 上已发布的同一版本。CI 在发版时跑后者。

## 它怎么工作

| 通路 | 触发 | 做什么 |
| --- | --- | --- |
| 简报 | 会话开始 | `briefMode: index` 一行一条；正文按需 `memory get/search` |
| `memory` 工具 | 任何时候 | save/search/sessions/promote/list/get/update/forget/stats/distill-global |
| 轮末召回 | `turn/end` | 当轮用户消息本地检索，命中项下一轮尾部注入；纯本地 0 token |
| 路径 JIT | 工具触达 `files` | 相关记忆在下一步尾部注入；全路径 > 目录后缀 > 同名 |
| 自动提炼 | 轮次结束（可选） | 结构化记忆；默认 `direct` 全自动，`review` 只把高风险候选送审批，`draft` 严格全部进队列 |
| 二级蒸馏 | 模型判断；素材攒够 3 条（用户亲口说的 2 条即可） | 把本项目的教训抽成**跨项目**原则：`constraint` / `feedback` / `preference` 是用户亲口说的，单项目即可晋升；`decision` / `convention` 是推断出来的，要第二个项目交叉验证。够格的自动升为全局记忆。节奏自适应：连续空跑 15m → 30m → 1h … 最多 24h；重复表述（候选池里已有）也算没有进展，不会每 15 分钟重跑；维护页能看上次素材数、解析数、拒绝原因与下次窗口 |
| Dream / 画像 | 启动 + 轮末到期检查 | 合并重复簇、复审自动续期、报告过期、全局原则晋升判定；画像按 6 小时自动刷新（零审批，直接落库、可回滚）。手动整理才做一次语义裁决，且只决定「这一簇要不要合并」，不自动归档 |
| 前台会话卡 | 仅当前对话（可收起） | 右下角悬浮卡：图标 + 标题 + 「更新于 YYYY-MM-DD HH:MM」+ 一段话摘要（本会话沉淀的记忆标题连成一句，草稿不可见），空库时给「还没有沉淀 + 聊几句后会出现」两行提示；图标在设置里可选 7 种、大小 14–40px 可调（设置页带实时预览，只落本机），默认官方鲸鱼标；顶部左侧有六点拖动柄，按住整块即可拖走卡片，位置本地记住；切到设置 / 插件 / 自动化任务页自动隐藏，切对话自动换摘要；设置 → 记忆可用「该对话记忆」单独关闭本对话 |

简报的排序不读 `useCount` / 当前时间，日期戳只用 `createdAt`，并且**会话级冻结**。这样同一会话的系统提示不会逐轮变化，前缀缓存不会因为记忆更新而整段作废。

## 从别的工具搬过来

设置 → 记忆 → **从本机既有记忆导入**：扫描 WorkBuddy / Qoder / Claude Code / Codex / Windsurf 的既有记忆文件，只读扫描、按来源打标签；也可以直接粘 `/export` 的 JSON 或 Markdown。导入有新增时会后台触发一次画像重写（`feedPortrait: false` 可关）。

## 画像与账本

画像不是一句总结：每段有证据、版本和 diff；下面的机制保证它不会变成模型随手写的小抄。

| 机制 | 作用 |
| --- | --- |
| 红线 | 绝对禁令逐字置顶；模型不能删 / 归档；改稿留 20 版历史，可回滚；保存前查冲突 |
| 审批队列 | `draft` 全部进队列、`review` 只收高风险（红线 / 命中注入 / 置信度 < 0.6）；草稿四不可见（简报 / 检索 / 镜像 / 导出），批准才生效（C6） |
| 版本链 | `supersedes` 旧条归档不删除，新旧互指；一键回滚 |
| 时间轴 | `validFrom` / `validUntil` / `invalidatedBy` 记录事实的生效与失效；旧结论静态降权 0.3× 但不删除，快照携带 validity、不携带本机统计 |
| 注入审计 | 每次进 prompt 的正文 hash + 记忆 id + 被挤掉的条目；append-only |
| 派生链 | 记忆 → 画像 → `AGENTS.md` 每层记源快照；源失效沿链标脏 |
| 整库快照 | 每天首次写入 + 每次 Dream 前备份，轮转 7 份；恢复 = 手工拷回库目录 |
| 写入安全 | 密钥脱敏 + 注入模式 taint；非 user 来源 taint 隔离成草稿 |

## 为什么是「画像」

如果你要的是「模型自动多记一点」，很多插件都能做。Memory Portrait 把重点放在**它现在怎么理解你**：画像的每段有证据、有版本、能解释变化；写错了有红线、审批、版本链、注入审计。它不追求记住一切，而是让每一条被记住的东西有来源、有版本、能解释、能撤回。

几个明确的取舍：

| 选择 | 取舍 |
| --- | --- |
| 本地 BM25F + 精确短语 + 同义词 + 路径召回 | 不引入向量服务 / 后端，零依赖；语义泛化弱于 embedding |
| 索引简报 + 按需取正文 | 省 token；模型需要多一步 `get` |
| 启动 / 轮末到期检查，无常驻定时器 | 不占后台；整理不是实时 |
| Dream 只报告矛盾，不自动归档 | 避免词法误报；需要人确认 |

## 配置

面板里能改的都落在 `~/.dsh/storages/dsh-memory/settings.json`；`cordis.patch.yml` 里的 config 只是初值。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `autoInject` | `true` | 注入总闸：关掉后简报 / 轮末召回 / 路径召回都不再进上下文，`memory` 工具照常读写（「只用工具」档） |
| `directory` | `""` | 数据库位置，空 = `~/.dsh/storages/dsh-memory` |
| `disabledWorkspaces` | `[]` | 停用自动记忆的工作区（绝对路径，归一后精确匹配）：不注入、不自动提炼；工具仍可手动读写。事故排查时也用它把一次性工作区摘出去 |
| `mirror` | `true` | 在工作区写 `.dsh-memory/MEMORY.md`（人读）+ `memory-snapshot.json`（结构化，供跨机器携带项目记忆） |
| `briefing` | `true` | 会话开始注入记忆简报 |
| `briefMode` | `"index"` | `index` 一行一条索引（省 token）；`full` 标题+正文摘录；`portrait` 全局画像全量（工作区画像已撤）+ 索引清单 |
| `briefingLimit` | `12` | 注入条数上限（1–50） |
| `briefingMaxChars` | `2000` | 注入字数上限（200–20000） |
| `briefingRebuildMinNew` | `3` | 简报重算闸：冷却结束后，新增记录攒够几条才重算系统提示（1–50；`1` = 冷却一过有一条就重算）。每次重算都会让宿主把整份系统提示再追加进历史，调大更省 token，调小更新更及时 |
| `briefingRebuildCooldownMs` | `1800000` | 简报重算闸（硬间隔）：两次重算至少隔多少毫秒，冷却期内即使攒够条数也不重算；没有新增条目的编辑 / 归档 / 画像 / 日志变化最多等 2 个冷却周期（0–3600000；`0` = 不做速率限制） |
| `portraitMaxChars` | `1400` | 画像注入的字数预算（工作区 + 全局合计；仅 `briefMode=portrait` 生效，200–8000） |
| `discipline` | `true` | 注入「记忆纪律」一段（何时写什么、对话内指令触发规则） |
| `rewriteMode` | `"direct"` | 画像重写写入方式：`direct` 直接落库（默认，含模型输出有损的情况——版本历史可回滚）；`draft` 才先存待审稿 |
| `journalDays` | `14` | 画像重写时读取最近多少天的日志作为原料（1–90） |
| `turnRecall` | `true` | 轮末按当轮内容召回相关记忆进下一轮 |
| `turnRecallLimit` | `3` | 每轮召回条数（1–10） |
| `turnRecallMaxChars` | `800` | 轮末召回块总字符上限（200–4000），超出的条目不注入 |
| `sectionOrder` | `550` | 注入段落在系统提示里的位置 |
| `hudIcon` | `"a"` | 前台会话卡图标：`a` 官方鲸鱼标（默认）/ `b` 官方 App 图标 / `c` 可爱鲸鱼 / `d` 深蓝鲸鱼 / `e`–`g` 鲸鱼娘二创位图。二创图标为公开页面素材、作者未署名，对外分发前需确认授权 |
| `hudWidth` | `340` | 前台会话卡宽度（px，240–640）；设置页滑杆或卡片右下角拖拽调整 |
| `hudHeight` | `0` | 前台会话卡高度（px，0 = 随内容自适应；固定值 180–720，正文区内部滚动） |
| `hudOpacity` | `1` | 前台会话卡背景不透明度（0.35–1）。只混底色，文字保持清晰；不支持 `color-mix` 的宿主退回不透明底 |
| `hudColor` | `""` | 前台会话卡背景色（`#rgb` / `#rrggbb`）；空 = 跟随宿主主题。自定义底色时文字按亮度自动换成深色或浅色 |
| `autoCapture` | `false` | 轮次结束自动提炼 |
| `autoDreamDays` | `7` | 启动整理：启动时与轮末检查当前（最近使用的）工作区，距上次（自动或手动）整理满 N 天就在后台整理一次；`0` 关闭（0–365）。没有常驻定时器 |
| `autoDreamPortrait` | `false` | 自动整理（启动时）是否顺带重写画像；默认关——画像由 `autoPortraitHours` 自动刷新负责。手动 Dream 也会刷新一版，落库方式跟随 `rewriteMode`（默认直接生效） |
| `globalDistill` | `true` | 二级蒸馏：把本项目记忆抽成「候选原则」写进全局候选池。**时机由模型决定**（`memory` 工具的 `distill-global` 动作，在一段工作告一段落时显式调用）；兜底是轮末——按候选原则的 `anchors` 判断「还有几条没提炼过」，再用下两行的自适应间隔控制频次。关掉只是不再往上抽，已进池的候选照常按门槛晋升 |
| `globalDistillMinNew` | `3` | 二级蒸馏的素材门槛：还剩多少条**没被提炼过**的素材才值得再试一次。`feedback` / `constraint` / `preference` 未覆盖达到 2 条时也会触发——这几类单项目就能晋升，优先蒸馏 |
| `globalDistillCooldownMinutes` | `15` | 二级蒸馏的基础间隔（分钟）。连续空跑按 2 倍指数退避（15m → 30m → 1h … 上限 24h），有产出就回到基础间隔；不是定时任务，素材门槛没过时连时间闸都不看 |
| `autoPortraitHours` | `6` | 自动刷新全局画像：每 N 小时检查一次，有新素材时调用模型重写；`0` 关闭（0–168）。面板「立即刷新」只是兜底 |
| `captureMode` | `"direct"` | `direct` 全自动落库；`review` 只把高风险候选（红线 / 命中注入 / 置信度 < 0.6）送待审；`draft` 严格全部进队列（C6） |
| `staleDays` | `60` | 体检里「过期未用」的判定天数 |
| `autoCaptureMinChars` | `600` | 太短的轮次不提炼 |
| `captureCooldownMs` | `60000` | 两次提炼的最小间隔 |
| `minConfidence` | `0.4` | 提炼结果的最低置信度 |
| `maxPerTurn` | `5` | 每次最多落库条数 |
| `maxTranscriptChars` | `4000` | 送给模型的对白摘录上限 |
| `dedupe` | `true` | 保存时合并相似记忆 |
| `qualityGate` | `true` | 质量闸门：自动提炼 / agent 主动写入的低分条目（<30）直接归档，不进简报 |
| `redactSecrets` | `true` | 写入安全：密钥扫描与脱敏（命中替换为 `[REDACTED:*]` 并记 `redactions`） |
| `quarantineTainted` | `true` | 写入安全：非 user 来源命中注入模式（taint）时自动隔离成草稿 |
| `pathRecall` | `true` | 路径 JIT：工具触达 `files` 挂靠的文件时，相关记忆在下一步尾部注入 |
| `pathRecallLimit` | `3` | 每次路径召回最多注入几条（1–10） |
| `sessionSearch` | `true` | 会话索引：每轮用户发言原文落 `sessions.jsonl`，`action=sessions` 溯源 |
| `compactionSalvage` | `true` | 压缩协同：宿主压缩上下文时把摘要照录进当天工作日志 |
| `captureSubagents` | `false` | 子代理会话（origin=subagent）是否也参与自动提炼；默认否，避免把派活的中间过程写成记忆 |
| `falsifierReviewDays` | `90` | 复审周期（天）：带失效条件的记忆默认多少天后进复审队列（1–3650） |

## HTTP 契约

`/memory/api` 前缀，JSON 信封成功 `{ok:true,…}` / 失败 `{ok:false,error,detail?}`。
请求体超 4MB 回 `413 payload_too_large`；显式传入的 `workspace` 必须是已注册工作区
（当前活动工作区或落过库的工作区），否则回 `400 invalid_workspace`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/state` | 版本、工作区、统计、设置、类别、工作区列表、标签、最近提炼、最近简报计量 |
| GET | `/overview` | 面板「记忆概览」的聚合数据：项目 / 全局 / 待审 / 红线计数、类别分布、近 7 天新增（按 `createdAt`）、全局画像覆盖率；只读，不拉明细 |
| GET | `/briefing-preview` | 简报预览：按当前设置算「下次会话会注入哪些记忆」，含画像计量与预算挤掉的条目 |
| GET | `/list` | 列表；`q/category/scope/tag/archived/sort/limit/offset`（不含草稿） |
| GET | `/record` | 读单条（含归档，不含草稿）：`id`；画像依据下钻用 |
| POST | `/save` | 新建或合并；带 `supersedes` 走版本链（旧条归档、可回滚） |
| POST | `/update` | 改一条（含 `related` / `keywords`） |
| POST | `/bulk` | `delete` / `archive` / `unarchive` / `pin` / `unpin` |
| POST | `/delete` | 删一条（红线需带 `overrideRedline: true`，面板确认后才会带；否则 403 `redline_protected`） |
| POST | `/redline/check` | 红线保存前冲突检查：与现有红线做疑似矛盾词法判定（只读） |
| POST | `/redline/update` | 红线改稿（必须 `confirm: true`；旧措辞写入历史） |
| GET | `/redline/history` | 红线当前版本 + 旧版本列表 |
| POST | `/redline/rollback` | 红线回滚（必须 `confirm: true`；当前版本先写回历史） |
| POST | `/settings` | 写设置 |
| GET | `/health` | 体检：重复簇、过期未用、断链、待审草稿数、files 引用失效、overBudget 超预算信号；**矛盾线索默认不产出**（词法误报率高），`?contradictions=1` 才显式诊断；另含 `attention`（唯一「需要处理」口径）、`dormant`（久未使用汇总）、`maintenance`（启动整理间隔 / 上次 / 下次 / 摘要、`autoPortraitHours` 与全局画像 `updatedAt`、运行态）、`candidates` / `candidateItems`（二级蒸馏候选池：待判定计数与明细，供维护页渲染）与 `globalDistill`（上次二级蒸馏：素材 / 解析 / 拒绝原因 / 脱敏摘要 / 自适应节奏与下次允许时间） |
| POST | `/health/resolve` | 一键处理：`merge`（合并簇，可带 `title/category/tags/content` 覆盖合并稿；红线与矛盾对会被拒绝）/ `time-order`（对一对矛盾按时序归档旧条，红线 / 置顶 / 用户旧条 / 外部新条会被拒绝）/ `archive`（归档过期）/ `unlink`（摘除断链） |
| GET | `/timeline` | 全部记忆（含归档、不含草稿）按更新时间倒序 |
| GET | `/portrait` | 当前画像（工作区 + 全局）、版本列表、段落定义 |
| POST | `/portrait/save` | 保存画像（版本 +1，旧版留档） |
| GET | `/portrait/history` | 画像版本列表（降序） |
| GET | `/portrait/export` | **画像导出**（轻量）：全局画像（含版本历史）+ 全部红线；`POST /import` 识别该载荷自动回灌（导入即入画像） |
| GET | `/portrait/diff` | 两个版本的逐段 diff（`from=previous` 默认，返回 `+`/`−` 行与摘要） |
| POST | `/portrait/rewrite` | 触发画像重写（`scope=global` 为面板默认；`rewriteMode` 决定直写或进待审，默认直写） |
| POST | `/portrait/migrate` | 跨 App 迁移画像：粘贴其它应用 AI 按提示词总结的画像 JSON，与全局画像整合（LLM 整合，失败降级段落合并） |
| GET | `/portrait/draft` | 读取待审重写稿（默认全局；`scope=workspace` 读工作区旧稿） |
| POST | `/portrait/draft/approve` | 批准重写稿：落库、旧版留档、清待审文件 |
| POST | `/portrait/draft/discard` | 丢弃重写稿 |
| GET | `/queue` | 待审草稿队列 |
| POST | `/queue/approve` | 批准草稿（可带编辑字段；草稿带 `supersedes` 时兑现版本链） |
| POST | `/queue/reject` | 拒绝草稿（默认删除，`mode: archive` 归档留底） |
| POST | `/supersede/rollback` | 版本链回滚：传新条 id 恢复旧条，或传旧条 id 撤销推翻 |
| GET | `/export` | 导出当前工作区与全局**条目**（字段齐全，含 `falsifier` / `reviewAt`）；`?full=1` 连画像 / 派生链 / 最近 30 天日志一起导出，`/import` 自动识别回灌 |
| POST | `/import` | 导入（备份载荷、纯文本、画像导出载荷，或 `path`/`paths` 指到本机既有记忆文件）。导入有新增时**后台自动触发一次画像重写**（「导入即入画像」；`feedPortrait: false` 关闭，响应 `portraitRewrite` 标记是否触发） |
| GET | `/journal` | 读最近 N 天工作日志（`days`，1-30，默认 3） |
| POST | `/journal` | 写一条工作日志（`date` 可指定，默认当天） |
| GET | `/import-scan` | 扫描本机既有记忆来源（WorkBuddy / Qoder / Claude Code / Codex / Windsurf / 本插件镜像），只读 |
| POST | `/import-scan` | 按来源 id 或路径导入，用户级来源自动进全局库 |
| GET | `/mirror` | 取当前工作区镜像的 Markdown |
| POST | `/capture` | 立刻提炼一次（`captureMode` 决定落库还是进队列） |
| POST | `/dream` | Dream 整理（手动补跑；与「启动整理」同一管线）：合并重复簇（红线不参与、置顶结果保持置顶）+ 复审到期自动续期（连两轮零引用才升级）+ 自动路径不扫矛盾、手动整理才产出只读线索 + 报告过期未用 + 二级蒸馏与全局原则晋升 + 画像重写（默认直接落库）。手动整理另做**一次**打包语义裁决（`lib/adjudicate.js`）：只有判 `duplicate` 的簇才合并，判 `contradicts` 必须给出同一主谓宾的互斥取值与分落两条的证据，否则强制回落 `unrelated`；无模型路由时静默跳过 |
| POST | `/candidates/reject` | 「不再提议」：把候选原则标成 rejected，之后同主题不再晋升。`{ ids, reason? }`。自动路径不弹确认，纠错就靠这一个动作 |
| GET | `/sessions` | 会话检索（溯源）：按词重叠搜回当轮用户发言原文 + sessionId/turn |
| GET | `/session-brief` | 前台会话卡的数据源：本会话沉淀的记忆 + 本会话用户诉求 + `hudIcon` 图标键 + `hud` 外观（`width` / `height` / `opacity` / `color`；卡片只展示记忆摘要；草稿与归档不可见）；按 `session` 精确过滤，不传时用最近活动会话兜底 |
| GET | `/injections` | 注入审计：最近真正进 prompt 的内容（正文预览 + sha256 前 16 位 + id 列表 + 被挤掉的条目；`full=1` 给原文，`kind` 可过滤） |
| GET | `/derivations` | 跨层派生链：每层派生了什么、源现在还成不成立（`state` 为 `fresh` / `dirty`，带失效原因） |
| GET | `/reviews` | 复审队列：带失效条件、到期该复查的记忆（`due` / `soon`） |
| POST | `/review` | 复审一条：记「看过，还成立」，到期时间推后一个周期 |
| POST | `/tags/merge` | 标签归并：把大小写等写法变体合并成目标写法（含全局库与草稿） |
| POST | `/promote` | 程序记忆晋升：把一条记忆写进工作区 AGENTS.md 托管块（幂等）；带 `from=portrait` 则改写画像的某一段 |
| POST | `/distill` | 只返回候选，不落库 |
| GET | `/backups` | 整库快照清单（新的在前，带文件数与字节数）与备份目录路径；没有备份时返回空数组 |
| POST | `/backup` | 立刻做一次整库快照（`reason` 可选）；返回快照名、文件数、字节数与轮转掉的旧快照 |
| POST | `/security/scan` | 写入安全：扫描任意文本的密钥与注入模式，只报告不落库 |
| GET | `/ping` | 存活探测 |

## 数据与隐私

```text
~/.dsh/storages/dsh-memory/
  index.json                     工作区索引
  settings.json                  面板里改的设置
  workspaces/<目录名>-<hash>/memories.json    每个工作区一个库
  workspaces/<目录名>-<hash>/MEMORY.md        人读旁车
  workspaces/<目录名>-<hash>/portrait.json    工作区画像
  workspaces/<目录名>-<hash>/derivations.json 跨层派生链
  workspaces/<目录名>-<hash>/journal/         每天一个只追加的工作日志
  workspaces/<目录名>-<hash>/global-distill.json 二级蒸馏台账（素材 / 拒绝原因 / 空跑次数）
  workspaces/_global/memories.json            跨工作区共享的全局记忆
  workspaces/_global/candidates.json          二级蒸馏的候选原则池（等跨项目共振）
  backups/<时间戳>-<原因>/                     整库快照（每天一次 + 每次 Dream 前）
```

- 主库只落 `~/.dsh/storages/dsh-memory`，默认不进仓库。
- 打开 `mirror` 才在 `<工作区>/.dsh-memory/` 写两份文件。**没装插件的机器上，这两份就是唯一的项目记忆入口**：
  - `MEMORY.md`：项目概况（画像）→ 当前关注 → 不能碰的规矩 → 置顶 → 分类条目，**全量不截断**。有变更时整份重写；内容不变时字节不变，git 里只在真变更时出现 diff。
  - `memory-snapshot.json`：结构化全量，保留 `id` / `trust` / `confidence` / 版本链，供另一台机器合并。
- 关掉 `mirror` 两份一起撤回；两份都只装**本工作区**的记录，全局记忆留在本地，不跟着项目进仓库。
- 每条写入路径都过 `lib/security.js`：密钥脱敏 + 注入模式 taint；非 user 来源 taint 隔离成草稿。
- 非回环来源访问 `/memory/api` 一律 403。

## 测试

```powershell
npm test   # 15 个套件 / 701 项断言
```

- 检索：54 条记忆 × 60 条查询硬评测，Recall@5 1.000、MRR@10 0.930（自测口径，见 [评测说明](https://github.com/BangBang-03/dsh-memory-portrait/blob/main/docs/retrieval-eval-2026-10-20.md)）。
- 安全：100 条密钥样本全部脱敏；20 条注入样本全部命中；20 条正常文本零误报。
- 简报稳定性：会话级冻结、确定性排序、轮末召回尾部注入去重。
- 客户端：把设置页真的渲染出来，接到真实 `store` + `api` 上驱动交互。

## 维护与发布

- 分支：`main` 是唯一长期分支；推 `main` 只跑测试，正式版用 `v*` 标签发布；完整流程与验收见 [`skills/release/SKILL.md`](https://github.com/BangBang-03/dsh-memory-portrait/blob/main/skills/release/SKILL.md)。
- 发版：`node tools/release.mjs`，然后 `node tools/release-watch.mjs`。
- 完整规格、历史章节、导入格式、测试明细与边界讨论：[`docs/REFERENCE.md`](https://github.com/BangBang-03/dsh-memory-portrait/blob/main/docs/REFERENCE.md)。

## 文档

| 想了解 | 读 |
| --- | --- |
| 完整规格（旧版 README 存档） | [docs/REFERENCE.md](https://github.com/BangBang-03/dsh-memory-portrait/blob/main/docs/REFERENCE.md) |
| 版本变更日志 | [CHANGELOG.md](https://github.com/BangBang-03/dsh-memory-portrait/blob/main/CHANGELOG.md) |
| 项目主页（安装 / 看点 / 链接） | [bangbang-03.github.io/dsh-memory-portrait](https://bangbang-03.github.io/dsh-memory-portrait/) |
| 检索方案与基线 | [docs/retrieval-eval-2026-10-20.md](https://github.com/BangBang-03/dsh-memory-portrait/blob/main/docs/retrieval-eval-2026-10-20.md) |
| 简报为什么必须字节稳定 | [docs/briefing-cache-safety.md](https://github.com/BangBang-03/dsh-memory-portrait/blob/main/docs/briefing-cache-safety.md) |
| 误报与规则冲突调研、改造方案 | [docs/false-positive-audit-2026-11-09.md](https://github.com/BangBang-03/dsh-memory-portrait/blob/main/docs/false-positive-audit-2026-11-09.md) |
| 与 WorkBuddy 个人记忆的差距 | [docs/personal-memory-parity.md](https://github.com/BangBang-03/dsh-memory-portrait/blob/main/docs/personal-memory-parity.md) |
| 市场扫描与竞品 | [docs/market-scan-2026-10.md](https://github.com/BangBang-03/dsh-memory-portrait/blob/main/docs/market-scan-2026-10.md) |
| 发版流程 | [skills/release/SKILL.md](https://github.com/BangBang-03/dsh-memory-portrait/blob/main/skills/release/SKILL.md) |

## 参与

- 安装 / 使用问题：用 [issue 模板](https://github.com/BangBang-03/dsh-memory-portrait/issues/new/choose)
- 想法与用法：[Discussions](https://github.com/BangBang-03/dsh-memory-portrait/discussions)
- 贡献代码：[CONTRIBUTING.md](https://github.com/BangBang-03/dsh-memory-portrait/blob/main/CONTRIBUTING.md)

## English

`Memory Portrait` is a long-term workspace memory plugin for **DeepSeek Harness** (npm package: `@bangbang-03/dsh-memory`). It injects a compact index at session start, fetches bodies on demand, recalls relevant memories at turn end with a purely local search, and can distill conversations into structured memories that wait in an approval queue.

What makes it different: the portrait is the main view. Every section carries evidence, versions, and diffs, so you can see how the agent understands the project and why that changed. Memory is treated as a **governed artifact**: redlines are injected verbatim and cannot be silently edited; every rewrite has a version chain; every injection is audited. `dependencies` is empty — no shell, no env, no outbound requests.

```powershell
dsh plugin --profile web add @bangbang-03/dsh-memory
```

If it saves you from re-explaining your project, a ⭐ helps others find it. Bugs and install issues: [open an issue](https://github.com/BangBang-03/dsh-memory-portrait/issues).

## License

MIT
