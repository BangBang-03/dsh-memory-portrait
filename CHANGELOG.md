# Changelog

本项目的用户可见变更。格式参考 [Keep a Changelog](https://keepachangelog.com/)，版本号遵循 SemVer；日期用 `Asia/Shanghai`。

## [Unreleased]

### Changed

- 二级蒸馏的触发时机从「整理时顺带」改成「**模型决断**」：新增 `memory` 工具的 `distill-global` 动作，模型在一段工作告一段落时可显式提炼。兜底是轮末——可蒸馏素材比上次多了 5 条就自动提炼一次。整理（Dream）不再顺带蒸馏：它是个 7 天的定时任务，要么太早（素材不够，提不出东西），要么太晚（已经忘了为什么）。
- 候选池的晋升判定改为每次轮末都跑一次（纯计算、幂等），不再只挂在整理流程里。
- 整理（Dream）仍然会做一次晋升判定，作为手动整理时的兜底。

### Fixed

- 候选池的已裁决历史只保留最近 200 条（`status: pending` 的候选全留）。此前每次轮末都读一个无限增长的文件——已晋升 / 已否的记录一年后可能几千条，读取与解析变成固定开销。

## [0.8.0] - 2026-11-05

### Added

- 工作区可携带副本：`<工作区>/.dsh-memory/` 下新增 `memory-snapshot.json`（结构化全量，保留 `id` / `trust` / `confidence` / 版本链，供另一台机器合并），与既有的 `MEMORY.md` 并列。两份都只装**本工作区**的记录，全局记忆留在本地，不跟着项目进仓库；内容未变时不重写，git 里只在真变更时出现 diff。
- 镜像改版：`MEMORY.md` 按「离线也能读」重新组织——项目概况与当前关注（来自工作区画像）排在所有条目前面，红线单独成节且措辞逐字保留，每条带「为什么」，文件头从「请勿手工编辑」改成边界声明（没装插件时可以直接改，插件上线后以条目库为准合并）。
- 历史工作区补写：主库里有该项目的记忆、但项目目录下还没有 `.dsh-memory/` 时，打开项目会自动补齐镜像与快照（只在确实有记忆时才建目录）。
- 二级蒸馏：Dream 时用一次模型调用把本项目记忆抽成「候选原则」，够格的自动升为全局记忆。门槛按证据强度分层——`constraint` / `feedback` / `preference` 是用户亲口说的，单项目即可；`decision` / `convention` 是推断出来的，需要第二个项目交叉验证。维护页新增「全局候选池」卡，显示待判定条数并支持逐条「不再提议」（一次点击，无二次确认）。
- 新增设置 `globalDistill`（默认 `true`）：关掉只是不再往上抽，已进池的候选照常按门槛晋升。
- 新增端点 `POST /candidates/reject`（`{ ids, reason? }`）。

### Changed

- `GET /health` 的 `health` 内新增 `candidates`（待判定 / 已晋升 / 已否计数）与 `candidateItems`（待判定明细）。
- `POST /dream` 现在包含二级蒸馏与全局原则晋升两步，顺序为先产候选、再判定晋升。

## [0.7.0] - 2026-11-01

### Changed

- 前台会话卡改为 Qoder 式摘要卡：图标 + 「更新于 YYYY-MM-DD HH:MM」+ 一段话摘要（本会话沉淀的记忆标题连成一句）；诉求列表、分类标签、逐条时间、刷新按钮、底部说明全部移除，卡片加宽留白，胶囊计数改为沉淀条数。
- 新增 `hudIcon` 设置（设置 → 记忆 → 当前对话）：可选 7 种会话卡图标，默认 `a` 官方鲸鱼标；`b` 为官方 App 图标矢量，`c`–`g` 为公开页面二创位图（作者未署名，对外分发前需确认授权）。`GET /session-brief` 新增返回 `icon` 键。

### Added

- 会话卡图标资产：官方鲸鱼矢量为单路径 data URI；二创位图压成 96px WebP 内嵌，无新增运行时依赖。

### Fixed

- 前台会话卡只跟随「当前可见对话」：打开设置弹窗、切到插件 / 自动化任务等主面板、或会话容器不存在时立即隐藏；切换对话时改拉新会话摘要，不再把上一个对话的卡片带过去。设置弹窗开合与会话切换均走 DOM 监听，另有 1 秒兜底轮询。

## [0.6.9] - 2026-10-31

### Changed

- 降低记忆插件的 token 成本：`autoCapture` 跳过续跑发言、上次 0 候选后退避 5 分钟；蒸馏输入已有记忆上限 60→24、对白摘录默认 6000→4000 字。
- 轮末召回本会话内去重（同一记忆不重复注入），新增 `turnRecallMaxChars` 默认 800，单条正文截断 300→200 字。
- 压缩 `memory` 工具描述（约 2040→851 字符），减少每次请求的固定 schema token。
- 0.6.9 已发布到 npmjs，安装命令不变。

## [0.6.8] - 2026-10-31

### Added

- 新增 GitHub Pages 落地页：安装命令、画像看点、证据 / 版本 / 审计说明与 GitHub / npm / Discussions 入口。
- 新增前台会话记忆卡：挂在宿主 `shell.overlay` 上的右下角悬浮卡，按会话展示当轮诉求与本会话已沉淀记忆（草稿与归档不可见）；每次内容变化刷新「更新于 HH:MM」；可收起 / 拖拽，位置本地记住；数据走新增的 `GET /session-brief`，不传会话时由宿主用最近活动会话兜底。
- 设置 → 记忆新增「该对话记忆」开关（默认开启）：只控制当前对话的前台会话卡，关闭状态存在本地，不影响长期记忆、其它对话或工作区配置。
- 市场元数据：`dsh.marketplace` 声明 web / desktop、需要重启、桌面端有手动安装步骤；`dsh.permissions` 声明本地读写、无外发网络、仅调用本地 `git` 做工作区身份识别。
- 新增 `tools/check-compat.mjs`：本地核对 README 兼容表与 `package.json`；`--npm` 再核对 npmjs 上已发布的同一版本。CI 在推 `main`、发 GitHub Release、发 npmjs 后各跑一次。

### Changed

- 修正 DSH STORE 契约：入口 ID 改为 `dsh-memory-portrait`；DSH 兼容范围按 0.2 版本线声明为 `>=0.2.0-rc.2 <0.3.0-0`，逐版本测试结论记在 `dsh.compatibility.dshReleases`（`0.2.1-rc.3` / `0.2.1-rc.5` compatible，`0.2.1-rc.4` / `0.2.2-alpha.2` unknown）。
- 安装范围明确为 **web / 桌面**；headless / TUI 尚未做端到端验证，暂不声明（host 半不依赖 `webServer`，但本轮 headless profile 缺模型凭据，无法完成实测）。
- 0.6.8 已发布到 npmjs，安装命令不变。

### Fixed

- 修复 DSH 0.2.1-rc.5 下插件被宿主静默跳过：原范围 `<0.2.1-rc.4` 把当前桌面版排除在外，启动时 bundle 进 `skippedBundles`，市场卡片显示“已安装，与当前 dsh 不兼容”，记忆面板 / `memory` 工具 / `/memory/api` 全部不生效。范围改为 0.2 版本线后，rc.5 启动正常加载；同一提交补了清单声明一致性测试，防止两处范围再次漂移。

## [0.6.7] - 2026-10-28

### Changed

- 品牌更名为 **Memory Portrait / 记忆画像**；GitHub 仓库改为 `BangBang-03/dsh-memory-portrait`，旧 URL 自动重定向。
- npm 包名保持 `@bangbang-03/dsh-memory`，安装命令不变；0.6.7 已发布到 npmjs。
- README 首屏、hero、社交预览、仓库 topics、Release 标题同步更新；Release 标题改为 `v0.6.7 · Memory Portrait`。
- 发布模型收敛为单一 `main` + `v*` 标签；`lab` / `lab-latest` 已删除。
- 新增 CONTRIBUTING、issue 模板、Discussions 入口与发布素材 `docs/launch-copy-2026-10-28.md`。

### Fixed

- 无新增修复；0.6.6 的会话索引脱敏已包含。

## [0.6.6] - 2026-10-27

### Fixed

- `sessionLogAppend` 会话索引落盘前先做密钥脱敏（D3），避免会话原文里的 npm token 落盘。

### Changed

- npm 补发 0.6.6（此前只在 GitHub Release / GitHub Packages）。
