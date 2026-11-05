# AGENTS.md

Memory Portrait（记忆画像）是 DSH 的工作区记忆插件（真包名 `@bangbang-03/dsh-memory`）。本文件只放两样东西：
**改代码不能踩的红线**、**改什么该动哪个文件的路由表**。设计取舍、竞品对标、机制细节在 `docs/REFERENCE.md`；
根 `README.md` 是对外入口（安装 / 看点 / 配置 / HTTP 契约），不要往这里抄。

结构一句话：宿主半 `lib/index.js`（简报注入 / `memory` 工具 / `/memory/api` 路由 / 轮末召回）+
客户端半 `lib/client.js`（设置面板「记忆」页）+ 其余 `lib/*.js` 纯 Node 逻辑层（不 import 任何 DSH 运行时，可脱离宿主单测）。
项目级 skill 放在 `skills/`（只对本仓库生效，不装进全局 skill 目录），路由见 2.4。

分支一句话：GitHub 默认分支是 **`main`**，也是唯一长期分支；正式版用 **`v*` 标签**发布。
功能开发走短命分支或直接 `main`，合入前跑全量测试；`lab` 已删除，不再维护双线。
推 `main` 只跑测试；`v*` 标签才触发发布。

项目身份：品牌 **Memory Portrait / 记忆画像**；GitHub `BangBang-03/dsh-memory-portrait`；
npm 包名仍是 `@bangbang-03/dsh-memory`，安装命令不变。

---

## 1. 红线

### 1.1 契约红线（改了就静默坏，不一定会红测试）

| # | 红线 | 违反了会怎样 |
| --- | --- | --- |
| **C1** | 真包名 `@bangbang-03/dsh-memory` 必须逐字一致地出现在四处：`package.json` 的 `name`、`cordis.patch.yml` 的 `name`、`lib/client.js` 的 `id`、profile 的 `dependencies` 键与 `dsh.profile.bundles` 项 | 写成别名时宿主半照常工作、设置面板**整块消失**（0.3.2 踩过，0.3.4 修）。`test/client.test.mjs` 有断言守着 |
| **C2** | 客户端访问后端一律 `new URL("memory/api/…", document.baseURI)`，不写死 `/memory/api`，不用以 `/` 开头的绝对路径 | 反代目录前缀 / `dsh-app://` 外壳下请求打不到宿主，面板一片 404 |
| **C3** | 注入段默认 `sectionOrder: 550`，不要挪 | 它夹在 PLAN_POLICY(500) 与 TEAM_POLICY(600) 之间；挪了会跟别的段抢位置 |
| **C4** | 简报必须**字节稳定**：会话级冻结 + 确定性排序，排序与行内字段不得读 `useCount` / 曝光次数 / 当前时间；行内日期戳只能用 `createdAt`（不可变），**不能用 `updatedAt` / `lastUsedAt`**（`markUsed` 会刷） | `briefing-stability` 会红；真放出去是系统提示逐轮变化、缓存命中率整体下降 |
| **C5** | 只监听 `session/event` 的 `turn/end`。**不要**挂 `agent/turn-stopping` | 那个事件是串行 await，长活会拖住整个轮次收尾 |
| **C6** | `status: draft` 四不可见：不进简报、不进检索、不进镜像、不进导出 | 待审队列形同虚设，没被批准的模型产出直接生效 |
| **C7** | 加端点 / 加配置键 / 改默认值 → 同步三处：`cordis.patch.yml`、README 的「配置」与「HTTP 契约」表、`test/host.test.mjs` 的默认值断言 | README 是发布合同；默认值只改代码不改 patch，用户装上去还是旧值 |
| **C8** | 红线（`category: constraint`）的治理链不得松动：`store.remove` / `patchRecord` 默认拒绝（`redline_protected`），`overrideRedline` **只能**从面板确认（`POST /delete` 显式传）进来，`memory` 工具的 forget / HTTP 默认路径永不透传；改稿 / 回滚只走面板确认接口（`/redline/update`、`/redline/rollback`，必须 `confirm: true`），旧措辞进历史；红线不参与整理 / 合并；简报里红线先于预算挑选、措辞逐字渲染（不经 LLM 重写软化） | 模型一句话删掉用户的绝对禁令，或禁令被画像重写悄悄改写措辞 |
| **C9** | 工作区镜像 `MEMORY.md` 是**离线唯一入口**（别的机器上可能没有本插件）：画像段落必须排在条目之前、红线逐字不截断、文件头声明「没装插件时可以直接改」而不是禁止编辑；**全量输出** —— 不按日期拆文件、不截断正文、不丢条目；每次写入整份重写，内容不变时字节必须不变 | 没装插件的机器上，项目记忆要么读不懂、要么读不全 |

### 1.2 数据与隐私红线

| # | 红线 | 违反了会怎样 |
| --- | --- | --- |
| **D1** | 主库只落 `~/.dsh/storages/dsh-memory`，**永不进仓库**；仓库里只允许 `.dsh-memory/` 下两份副本：`MEMORY.md`（人读）与 `memory-snapshot.json`（结构化，供跨机器合并）。两份都只装本工作区记录，**全局记忆一律不进** | 记忆随 git 外泄给所有人 |
| **D2** | 工作区镜像与快照只在 `mirror: true` **且工作区目录真实存在**时写 `<ws>/.dsh-memory/{MEMORY.md,memory-snapshot.json}`；关开关要**两份一起**撤回；不许凭空造目录 | 用户删了工作区却被插件重建；关开关后残留孤儿 JSON |
| **D3** | 每条写入路径（工具、面板、导入、晋升、自动提炼）都必须过 `lib/security.js`：密钥脱敏 + 注入模式 taint | 密钥落盘、taint 内容被当指令执行 |
| **D4** | `trust` 只能由写入来源推导，模型**不能自封** `user`；非 user 来源命中 taint 一律隔离成草稿 | 提权：模型自己给自己写「用户指令」 |
| **D5** | `lib/index.js` 的 `route()` 里 `isTrusted()` 必须是第一道门，非回环来源一律 403 | 局域网内任意网页能读写你的全部记忆 |
| **D6** | 注入措辞必须框成「背景资料」，自动提炼结果必须标来源 | 记忆变指令：三个月前的对话被当成当前任务 |
| **D7** | 归档 / `supersedes` 而不是删除；推翻要能回滚 | 历史没了，用户改错一次就永久丢数据 |
| **D8** | `memory-snapshot.json` 只装本工作区 active 记录，**不得**带本机使用统计（`useCount` / `lastUsedAt` / `exposedCount` / `openedCount` / `citedCount`）；内容未变时不重写 | 另一台机器合并后排序被本机热度污染；快照在 git 里永远 dirty |

### 1.3 流程红线（发布 / 安装）

| # | 红线 | 违反了会怎样 |
| --- | --- | --- |
| **P1** | 长期分支只有 `main`；功能分支必须短命，合回 `main` 前跑全量测试。正式版只在 `main` 头打 `v*` 标签；不再维护 `lab` 长期线，也不做「推 lab 后把 main 追到上一版」的同步 | 两条长期线会让默认分支、发布源与文档各说各话；`main` 与 tag 不一致时先查清再发 |
| **P2** | 已推送的 `main` 不 amend、不 rebase、不 force push | 远端已开 `allow_force_pushes=false`；改写历史会造平行提交，CI 与其它 clone 全对不上 |
| **P3** | git 与 REST 两条推送通道**不要混用** | REST 重建的提交时区归一成 `+0000`，同树不同 SHA，混推就是分叉 |
| **P4** | 改 `~/.dsh/profiles/**` 前必须备份（`install.ps1` 自带秒级时间戳备份，手工改也要先备份） | 把用户的 DSH 装坏且无从回滚 |
| **P5** | 卸载 / 替换只动 junction 与清单项；碰到同名**真实目录**直接报错退出，不许 `Remove-Item -Recurse` | PowerShell 5.1 会跟进 junction 删到共享的 `@deepseek-ai/*`（脚本里已专门防这一步） |
| **P6** | 改完跑 `node test/run-all.mjs`（15 套件 / 644 断言）**全绿**才算改完；纯文档提交可跳过 | `store` / `api` / `briefing` 三套守的是数据完整性与注入稳定性 |
| **P7** | 不加运行时依赖：`dependencies` 保持空，`peerDependencies` 全 optional，`lib/*.js` 只许 import `node:*` 与相对路径 | 插件要在用户机器上零安装；加依赖等于要求所有人重装 |
| **P8** | 正式版只在 `main` 打 `v*` 标签，且 `package.json` 不许是预发布号（`-lab.N` / `-rc.N` 等）；打标签前 `main` 必须已推送并通过测试；不手改远端保护设置 | 标签挂在旧提交上，`/releases/latest` 发出去的就是旧代码；预发布号漏上去再也升不回来。完整步骤与验收见 `skills/release/SKILL.md` |

---

## 2. 路由表

### 2.1 改什么 → 动哪

| 你要改什么 | 主文件 | 一起看 | 必须跑 |
| --- | --- | --- | --- |
| 记录模型、去重合并、版本链、镜像、导入导出、体检、画像存取 | `lib/store.js` | `lib/quality.js`、`lib/text.js` | `store` |
| 工作区可携带快照（跨机器携带项目记忆；只装本工作区 active 记录，不含本机统计） | `lib/store.js` 的 `portableSnapshot` / `writeSnapshotFile` | `test/store.test.mjs` 的快照六条用例、`lib/markdown.js` 的 `dsh-memory-mirror` 导入源 | `store` |
| 红线专用编辑 / 历史 / 冲突检查 | `lib/client.js`（红线编辑器） | `lib/store.js` 的 `updateRedline` / `rollbackRedline` / `redlineConflicts`、`lib/api.js` 的 `/redline/*` | `store` + `api` + `client` |
| 检索打分（BM25F / 精确短语 / related 一跳 / 同义词扩展） | `lib/retrieval.js` | `test/fixtures/retrieval-hard-60.json`、`docs/retrieval-eval-2026-10-20.md` | `retrieval` |
| 简报注入、`memory` 工具、轮末召回、路径 JIT、路由挂载、Config schema | `lib/index.js` | `lib/portrait.js`、`lib/api.js` | `activate` + `briefing-stability` + `host` |
| HTTP 端点、错误码、参数校验 | `lib/api.js` | README「HTTP 契约」表 | `api` |
| 设置面板 UI（三个 tab、首页红线/画像/收件箱、原料抽屉、维护页、图标标记） | `lib/client.js` | `test/mini-react.mjs`、`locale/*.json` | `client` |
| 前台会话记忆卡（Qoder 式摘要卡：图标 + 更新时间 + 一段话摘要；图标可选 `hudIcon`；可收起/拖拽、位置持久化、按对话开关） | `lib/client.js` 的 `SessionMemoryHud` / `HUD_ICONS` | `lib/api.js` 的 `/session-brief`、`lib/store.js` 的 `sessionSearch`、`lib/index.js` 的 `workspaceForSession` / `activeSession` / `hudIcon` | `client` + `api` |
| 清单兼容口径 / 市场元数据（`engines.dsh`、`dshReleases`、`marketplace`、`permissions`） | `package.json` | `README.md` 的「兼容性」、`tools/check-compat.mjs`、`.github/workflows/publish*.yml` | `host` + `node tools/check-compat.mjs` |
| 提炼提示词、模型输出容错、触发条件 | `lib/distill.js` | `lib/index.js` 里的 capture 流程 | `distill` |
| 全局原则晋升（候选准入 / 分层门槛 / 主题聚类 / 晋升执行） | `lib/distill-global.js` | `lib/index.js` 的 `runGlobalDistill` 与 `maybeDistillGlobally`、`docs/global-distill-trial-2026-11-05.md` | `distill-global` |
| 全局候选原则池（候选读写与裁决标记） | `lib/store.js` 的 `candidates` | `lib/distill-global.js`、`skills/global-distill/SKILL.md` | `store` + `distill-global` |
| Dream 整理管线（合并重复簇 / 矛盾报告（不自动归档）/ 全局原则晋升判定 / 启动 + 轮末到期检查与台账） | `lib/dream.js` | `lib/index.js` 的 `runAutoDream`、`lib/store.js` 的 `maintenanceState` / `noteMaintenance` / `candidates`、`lib/api.js` 的 `/dream` 与 `/health` | `api` + `activate` + `store` + `distill-global` |
| 自动刷新全局画像（WorkBuddy 式主路径：turn/end + 会话销毁触发、吸收当前工作区近况） | `lib/index.js` 的 `scheduleAutoPortrait` / `runPortraitRewrite` | `lib/portrait.js`、`lib/client.js` 画像卡自动状态、`lib/api.js` 的 `/portrait` 与 `/health` | `activate` + `portrait` + `api` |
| 画像段落、渲染 / 解析、预算截断、版本 diff | `lib/portrait.js` | `lib/store.js` 的 portrait 段 | `portrait` |
| 画像重写提示词、模型输出容错解析、失败重试与有损改送待审 | `lib/portrait.js`（`REWRITE_SYSTEM` / `REWRITE_STRICT_SYSTEM` / `parseRewriteResponse`） | `lib/index.js` 的 `runPortraitRewrite`（重试、脱敏日志、degraded 判定） | `portrait` + `activate` |
| 派生链（记忆 → 画像 → AGENTS.md 的源快照与标脏） | `lib/derivation.js` | `lib/store.js` 的 `promoteToAgents` | `derivation` |
| 失效条件（`falsifier`）与到期复审 | `lib/store.js` + `lib/api.js` | — | `verification` |
| 整库快照（`backups/` 轮转、`GET /backups`、`POST /backup`、Dream 前预备份） | `lib/store.js`（`snapshotLibrary` / `snapshots` / `mutate` 里的 `dailySnapshot`） | `lib/api.js` 的 `POST /dream`、`lib/client.js` 维护页「整库快照」卡 | `store` + `api` + `client` |
| 密钥脱敏 / taint 检测 / trust 分级 | `lib/security.js` | `lib/store.js` 的全部写入路径 | `security` |
| 质量分与低分闸门 | `lib/quality.js` | `lib/store.js` 的 `qualityFields` | `store` |
| 既有记忆解析（WorkBuddy / Qoder / Claude Code / Codex / Windsurf） | `lib/markdown.js` | 扫描落点 `memorySourceSpecs()` | `markdown` |
| 安装 / 卸载 / 远程安装 | `install.ps1`、`uninstall.ps1` | `cordis.patch.yml` | `install` |
| 推送、发版、远端同步 | `skills/release/SKILL.md` | `tools/push.mjs`、`tools/release.mjs`、`tools/release-watch.mjs`、`tools/sync.mjs`、`tools/status.mjs`、`tools/check-compat.mjs` | 见 P6；正式版按 skill 的验收清单 |
| 文档同步 / 更新日志 | `skills/docs-sync/SKILL.md` | `README.md`、`AGENTS.md`、`CHANGELOG.md`、`docs/README.md` | 按 skill 的检查清单 |
| 更新项目记忆文件 / 离线交接 | `skills/memory-doc/SKILL.md` | `lib/store.js` 的 `renderMarkdown`（镜像结构由它决定）、同目录 `memory-snapshot.json` | `store` |
| 从项目提炼全局原则 / 二级蒸馏 | `skills/global-distill/SKILL.md` | `lib/distill-global.js`（判定规则）、`docs/global-distill-trial-2026-11-05.md` | `distill-global` |

### 2.2 症状 → 先去哪

| 现象 | 先查 |
| --- | --- |
| 设置面板整块不见，宿主半照常工作 | **C1**：包名 / 模块 `id` 不一致 |
| 面板请求全 404，或只在外壳 / 反代下坏 | **C2**：客户端 URL 拼接 |
| 系统提示每轮都在变、缓存命中率掉 | **C4** + `briefing-stability`：排序里混进了 `useCount` / 时间 |
| 同一条记忆出现两份、列表有重复 | `install.ps1` 的老别名迁移没跑；或 `dedupe` 被关 |
| `dsh plugin --profile desktop add …` 被拒 | 正常：desktop profile 由桌面端独占，走 `install.ps1` |
| 该进简报的记忆没进 | `GET /briefing-preview` 看它是不是被预算挤掉（`briefingLimit` / `briefingMaxChars`） |
| 自动提炼写了不该写的东西 | 先看 `captureMode` 是不是 `direct`；`draft` 会进待审队列 |
| 打开 DSH 后没有自动整理 / 轮末也不整理 | `autoDreamDays` 是否为 0；工作区是否在 `disabledWorkspaces`；`<库根>/workspaces/<folder>/maintenance.json` 的 `lastAutoAt` 是否已到期；空库（<2 条）不会跑；`rewriteState.running` / 正在提炼时会等下一轮 |
| 画像不自动更新 / 一直是旧版 | `autoPortraitHours` 是否为 0；全局画像 `updatedAt` 是否已满间隔；当前工作区是否有比画像更新的素材（排除红线 / taint / 草稿）；`rewriteState.running`；`rewriteMode=draft` 时是进待审而非直接更新 |
| 库被误删 / 面板点了清空 | 看 `<库根>/backups/`：每天第一次写入 + 每次 Dream 前各留一份，轮转 7 份；拷回目录即恢复（面板不做自动覆盖） |
| 红线改稿后旧措辞丢失 / 历史回滚无效 | `/redline/update`、`/redline/rollback` 是否带 `confirm: true`；`normalizeRedlineHistory()` 与 `normalizeLoaded()` 是否保留 `redlineHistory`；历史上限 20 版 |
| Dream / 整理合并了红线、置顶丢失、正反结论被揉成一条 | `clusterDuplicates()` 排除红线与矛盾对；`consolidateCluster()` 返回 `redline_protected` / `contradiction_pair` 并继承 `pinned`；面板整理走 `/health/resolve merge`，不走 `/save` + `/bulk` |
| Dream 报「N 步出错」但只显示画像未触发 | 画像重写失败码是否被分类为跳过（`no_model_route` / `llm_unavailable` / `no_material` / `disabled` / `already_running` / `no_workspace`）；真实失败应在客户端显示步骤与明细 |
| Dream 报「画像：重写结果解析失败（no_json）」 | 模型没按 JSON 输出。`parseRewriteResponse` 已能修裸换行 / 尾逗号、抢救截断与整体坏掉的输出；仍失败时宿主会用 `REWRITE_STRICT_SYSTEM` 重试一次，两次都失败才报错。宿主日志里有一条脱敏摘要（`画像重写解析失败`）可查原文形态 |
| Dream 后旧结论仍在 / 待确认矛盾反复出现 | 正常：Dream 只报告词法线索，不自动归档。确认一对走 `/health/resolve time-order`；保护边界是红线 / 置顶 / `user_older` / `external_newer` / `mixed_scope` |
| 红线冲突提示误报 / 漏报 | `redlineConflicts()` 复用 `detectContradictions()` 的疑似矛盾词法规则，是启发式；调阈值/否定词时同步 `store` 与 `api` 的红线测试 |
| 首页「需要处理」数字与收件箱不一致 | `healthData` / `queueData` / `reviewData` 的拉取条件；收件箱只在 `attentionOpen` 时拉 queue / reviews |
| 改完代码界面没变 | 宿主半（`lib/index.js` 等）改动要**重启 DSH**；纯客户端改动 `Ctrl+Shift+R` 硬刷新即可 |
| 前台会话记忆卡不出现 / 位置没记住 | 宿主是否提供 `shell.overlay`；当前是否在对话页（设置弹窗、插件 / 自动化任务主面板会隐藏卡片）；设置页「该对话记忆」是否被关掉（按会话 id 存在 localStorage）；`localStorage` 是否可用（位置与展开状态也存本地）；卡片只认当前可见的 `[data-conversation-session]`，不再用最近活动会话兜底 |
| 升级 DSH 后插件整块不生效 / 市场卡片说「已安装，与当前 dsh 不兼容」 | `engines.dsh` 是否覆盖当前版本；跑 `node tools/check-compat.mjs` 看 README / package.json 是否同源。DSH 0.2.1 起不匹配会进 `skippedBundles`，记忆面板 / `memory` 工具 / `/memory/api` 全部不生效 |
| 正式版没发出去 / Release 不是 Latest / 资产缺失 / npmjs 没更新 | 先跑 `node tools/release-watch.mjs` 看 CI 与 Release 结论；npmjs 步骤 skipped 时先看仓库是否配置了 `NPM_TOKEN`；完整流程见 `skills/release/SKILL.md` |
| `main` 与最新 tag 不一致 | 正常：tag 之后可能还有未发版提交；发版前先 bump 版本并重新打 tag，不要移动旧 tag |

### 2.3 文档路由

| 想了解 | 读 |
| --- | --- |
| 安装、快速开始、配置表、HTTP 契约 | `README.md` |
| 完整规格、历史章节、导入格式、测试明细、边界 | `docs/REFERENCE.md` |
| 版本变更日志 | `CHANGELOG.md` |
| 发布素材与渠道草稿 | `docs/launch-copy-2026-10-28.md` |
| 分支 / 发版 / 推送通道 | `skills/release/SKILL.md`、`tools/README.md` |
| 检索方案与基线数字 | `docs/retrieval-eval-2026-10-20.md` |
| 简报为什么必须字节稳定 | `docs/briefing-cache-safety.md` |
| 与 WorkBuddy 个人记忆的差距 | `docs/personal-memory-parity.md` |
| 市场同类扫描、插件自查与竞品 | `docs/market-scan-2026-10.md`、`docs/dsh-memory-landscape-2026-10.md` |
| 头部这一个月的新机制、可抄清单与优先级 | `docs/competitive-delta-2026-10-20.md` |
| 市场实时榜与**分发堵点复盘**（2026-10-27 快照；npmjs 0.6.9 已发） | `docs/market-top10-2026-10-27.md` |

### 2.4 项目级 skills

本仓库自己的 skill 放在 `skills/`，只对本仓库生效，不装进全局 skill 目录。新增或修改 skill 后，在 2.1 加一行路由。

| 想做什么 | 读 |
| --- | --- |
| 正式发版、打 `v*` 标签、核对 Release | `skills/release/SKILL.md` |
| 更新文件 / 更新文档 / 更新日志 | `skills/docs-sync/SKILL.md` |
| 更新项目记忆 `.dsh-memory/MEMORY.md`：结构、写作规范、离线交接 | `skills/memory-doc/SKILL.md` |
| 从项目记忆提炼跨项目原则（二级蒸馏） | `skills/global-distill/SKILL.md` |
| 新增项目级 skill 的目录与 frontmatter 约定 | `skills/README.md` |

---

## 3. 命令速查

```powershell
node test/run-all.mjs                  # 15 套件 / 644 断言，改完必跑（P6）
node test/store.test.mjs               # 单套件：把 store 换成 retrieval / api / client …

pwsh -File install.ps1 -DryRun         # 只看要改什么，不落盘
pwsh -File install.ps1                 # 本地装（junction + profile 清单）
pwsh -File install.ps1 -FromRelease    # 远程装最新稳定版（默认 stable）
pwsh -File uninstall.ps1 [-PurgeStorage]

node tools/status.mjs                  # main / 最新正式版 / 最近 CI
node tools/check-compat.mjs [--npm]    # 兼容口径：README / package.json / npm 已发布清单
node tools/push.mjs --branch main      # 推 main（REST）
node tools/release.mjs                 # 在 main 上：推 main + 打 v* 标签
node tools/release-watch.mjs           # 等 CI + 核对 Release
```

---

## 4. 已知坑（是设计边界，别顺手「修」）

1. **普通 `GET /export` 只覆盖条目；`?full=1` 连画像 / 派生链 / 日志（注入审计任何载荷都不含）**。
   full 载荷经 `POST /import` 自动回灌（画像空不覆盖、派生链按 `updatedAt` 合并、日志去重追加）。
   要字节级整库搬运用 `backups/` 快照，但**恢复是手工的**：面板只列清单与路径，不替你覆盖当前数据。
2. **派生链只审源端**：它回答「这条记忆现在还成不成立」，不回答「AGENTS.md 里那行还在不在」。手删晋升行，链上仍是 `fresh`。
3. **Windows 上 rename 偶发 `EPERM`**：杀软 / 索引器短时占住文件所致。`store.js` 的原子写已做**退避重试**
   （6 次、8–40ms 递增），彻底失败会先擦掉 `.tmp` 再抛。所以再红就是真问题——**别再习惯性「重跑一下」**。
4. **导航图标是 CSS 掩码贴上去的**：DSH 的 `settings.section` 不投影 icon，`syncNavMarker()` 靠「文本等于本插件本地化标题」认行。
   外壳改结构最坏结果是退回齿轮，不影响导航本身——不要为它去改 `configForms`。

---

## 5. 托管块（不要手改块内）

下面的 `dsh-memory:promoted` 块由插件自己维护：`POST /promote`、面板「晋升到 AGENTS.md」、`memory` 工具的 `promote`
都会往块里追加 `- **标题** — 正文` 行（幂等，重复晋升不产生重复行）。块外内容随便改。

<!-- dsh-memory:promoted 开始（由 dsh-memory 维护，请勿手工编辑本块） -->
<!-- dsh-memory:promoted 结束 -->

