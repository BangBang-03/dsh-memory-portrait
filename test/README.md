# test

全部测试都是脱离 DSH 的独立 `.mjs`，自带断言与计数，失败即 `exit 1`。
当前 **15 个套件 / 646 条断言**。

```powershell
node test/run-all.mjs        # 15 个套件全跑（改完代码必跑）
node test/store.test.mjs     # 单跑一个：换成 retrieval / api / client …
```

| 套件 | 守什么 |
| --- | --- |
| `store` | 工作区分库、去重合并、版本链、红线改稿历史 / 回滚 / 冲突检查、按时序归档矛盾旧结论及其保护边界、镜像、导入导出、原子写 |
| `retrieval` | BM25F、精确短语、`related` 一跳、同义词扩展、评测基线 |
| `security` | 密钥脱敏、注入检测、`trust` 分级与隔离 |
| `derivation` | 记忆 → 画像 → AGENTS.md 的源快照与反向标脏 |
| `verification` | 失效条件（`falsifier`）与到期复审队列 |
| `portrait` | 画像段落模型、Markdown 渲染 / 解析、预算截断 |
| `markdown` | 既有记忆解析（WorkBuddy / Qoder / 纯文本 / 本机扫描） |
| `distill` | 对话摘录、模型输出解析、触发条件 |
| `distill-global` | 候选原则准入（项目载体 / 套话 / 长度）、按证据强度分层晋升门槛、主题词聚类与项目去重 |
| `api` | HTTP 契约、错误码、参数校验、单条读取与红线审计接口（`/record`、`/redline/*`）、Dream 矛盾报告与 `/health/resolve time-order` |
| `host` | 宿主半导出、Config 默认值与校验 |
| `activate` | 假 cordis 跑 `apply()`：工具、提示段、路由真的能用；启动整理（合并 / 台账 / 快照）；自动刷新全局画像（吸收当前工作区近况 + 6h 节流） |
| `briefing-stability` | 会话级冻结快照、确定性排序、轮末召回尾部注入 |
| `client` | 客户端模块格式、槽位注册、渲染与交互（端到端）：三页签、首页四块、红线编辑器与历史、画像逐段 / 依据下钻、全局待审稿、自动刷新状态、收件箱、原料抽屉、Dream 矛盾报告 |
| `install` | 安装脚本备份、幂等、dry run、卸载还原与拒绝误删 |

## 约定

- 新增套件：在本目录建 `<name>.test.mjs`，并把 `[name, 描述]` 加进 `run-all.mjs` 的 `suites` 数组。
- `mini-react.mjs` 是给 `client.test.mjs` 用的极小 React 替身（`createElement` + 5 个 hook），
  不是通用实现，只在 DSH 之外把设置页真的渲染出来。
- `fixtures/` 放测试数据，见 [fixtures/README.md](fixtures/README.md)。
- 测试必须能在任意目录、无网络、无 DSH 安装的机器上跑通。
