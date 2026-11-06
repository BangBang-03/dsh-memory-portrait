# lib

插件运行时的全部代码。宿主半 `index.js` 跑在 DSH 服务端，客户端半 `client.js` 跑在设置面板，
其余模块是纯 Node 逻辑层——不 import 任何 DSH 运行时，可以脱离宿主单测。

**约束**：不加运行时依赖（`dependencies` 保持空），只许 import `node:*` 与相对路径（见 `AGENTS.md` P7）。

| 文件 | 职责 |
| --- | --- |
| `index.js` | 宿主半入口：`apply()` 注册简报注入段（`sectionOrder: 550`）、`memory` 工具、`/memory/api` 路由、`turn/end` 轮末召回与自动提炼、路径 JIT、启动整理、自动刷新全局画像（WorkBuddy 式） |
| `client.js` | 客户端半：设置面板「记忆」页（记忆库 / 维护 / 设置 三个 tab）；首页红线 + 画像 + 需要处理 + 原料抽屉，红线专用编辑器 / 画像逐段编辑与依据下钻 / 收件箱 |
| `store.js` | 存储核心：记录模型、去重合并、版本链（`supersedes`）、红线改稿历史与冲突检查、按时序归档矛盾旧结论、工作区镜像、导入导出、体检、画像与日志存取 |
| `retrieval.js` | 检索打分：BM25F、精确短语、`related` 一跳、同义词扩展 |
| `api.js` | `/memory/api` 的端点实现、错误码与参数校验（含 `/record`、`/redline/*` 审计接口与 `/health/resolve time-order`） |
| `dream.js` | Dream 整理管线：合并重复簇、报告矛盾（不自动归档）、报告过期；手动与「启动整理」共用，动手前快照、同时只跑一次 |
| `distill.js` | 自动提炼：提示词、模型输出容错解析、触发条件 |
| `portrait.js` | 工作区画像：段落模型、Markdown 渲染 / 解析、预算截断、版本 diff |
| `derivation.js` | 派生链：记忆 → 画像 → AGENTS.md 的源快照与标脏传播 |
| `security.js` | 写入安全：密钥脱敏、注入模式检测（taint）、`trust` 分级 |
| `quality.js` | 质量分（0–100）与低分闸门 |
| `markdown.js` | 既有记忆解析：WorkBuddy / Qoder / Claude Code / Codex / Windsurf |
| `text.js` | 分词、去重 token、文本相似度 |

## 改这里的注意点

- 改宿主半（`index.js`、`store.js` 等）后要**重启 DSH** 才生效；只改 `client.js` 用 `Ctrl+Shift+R` 硬刷新即可。
- 哪个模块对应哪个测试套件，见根 [AGENTS.md](../AGENTS.md) 的路由表；改完统一跑 `node test/run-all.mjs`
  （当前 15 套件 / 651 断言）。
- 配置键、默认值、HTTP 契约的权威说明在根 [README.md](../README.md)，不在本目录。
