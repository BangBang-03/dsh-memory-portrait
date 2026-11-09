# 简报前缀缓存安全（P0）——实现说明

系统提示排在每个请求的最前面。它一变，后面所有内容的 prompt 前缀缓存全部作废。
这份笔记记录三件事：**审计结论**、**改法**、**尾部注入的宿主契约证据**。

改动落在 `lib/index.js`（宿主半）、`lib/api.js` 与 `lib/client.js`（预览/面板同批合并）。

---

## 1. 三条冷缓存的成因（审计结论）

| 位置 | 成因 | 现状 |
| --- | --- | --- |
| `lib/store.js` 的 `rankRecords()` | 打分含 `1 + log1p(useCount)*0.15` 与 `recencyBoost(updatedAt)*3`：一次 `get`、或时间过去一天，排序就换 | 已由并行改动修掉：`rankRecords(records, { stable })` 走「置顶 → 类别权重 → createdAt → id」，`briefing()` 已改用 `stable: true` |
| `lib/index.js` 的 `briefingText()` | 把「轮末召回」块追加在同一个段落尾巴 | **本次改掉**：召回整块移出系统提示，改走 `agent/pre-step` 尾部注入 |
| `lib/index.js:488-504`（旧） | 每个请求重渲染，`BRIEFING_TTL_MS = 1500` 且 memo key 含 `recalls.map(id)` | **本次改掉**：改成会话级冻结快照，只有内容指纹变了才重算一次 |

## 2. 改法（`lib/index.js`）

### 2.1 会话级冻结快照

- `briefingFreeze: Map<sessionId, { workspace, mode, fingerprint, text, count, ids, at, builds }>`，
  上限 `BRIEFING_FREEZE_LIMIT = 60`，超出按 `at`（最近一次命中时间）淘汰最旧。
- `briefingText(workspace, sessionId)` 先算内容指纹 `briefingFingerprint(workspace)`：
  只由「会出现在简报里的东西」决定 —— 每条记录的 `id | updatedAt | status | archived | pinned`
  （按 id 排序后拼接，**与落库顺序无关**）、工作区画像与全局画像的 `version@updatedAt`、
  工作日志的「最新日期 + 当天字数」。
- 指纹一致 → 原样返回上次的字节（`reason: 'frozen'`）；不一致 → 重算一次再冻结
  （`reason: 'first' | 'workspace' | 'mode' | 'memory'`）。
- 纯读、以及只改 `useCount` 的 `markUsed` 都不改指纹，所以「读得多」不会让系统提示变成新文本。
- 会话 id 被复用（`session/created` 同一个 id）、会话销毁（`session/disposed`）都丢掉快照。
- 诊断：`lastBriefing`（`workspace/mode/chars/count/at/sessionId/reason/frozen/builds`）＋
  环形缓冲 `briefingLog`（`at/sessionId/reason/chars/count/changed/mode/workspace`，30 条），
  通过 `briefingInfo()` 进 `/memory/api/state` 的 `briefing.rebuilds`，面板可展示「为什么重算了」。

> 为什么用「指纹」而不是让 store 提供 `revision()`：`lib/store.js` 那次改动归并行 agent 所有，
> 本次不动它。指纹只用 store 的公开读接口，语义等价：任何会影响简报文本的写入都会改
> `updatedAt` / `status` / 存在性 / 画像版本，因此都会被发现。
> 如果以后要省掉这次额外的 `store.list`，等价且更省的做法是给 `createMemoryStore` 加一个
> 只在 `mutate()` 里自增的 `revision()`，并让 `markUsed` 走 `touch: false`。

### 2.2 确定性静态排序

复用 `store.briefing()` 已有的 `stable` 分支（见上表）。`lib/index.js` 侧不再做二次排序，
也不读 `useCount` / 当前时间；本套件用 `test/briefing-stability.test.mjs` 前两条断言把它钉住
（换落库顺序、`markUsed` 之后，`briefing()` 返回的 id 序列必须完全一致）。
`search` / 轮末召回仍走原来的相关度打分，未改动。

### 2.3 轮末召回改走尾部注入

- 系统提示段只剩静态内容：统计 + 索引/全文 + 页脚 + 记忆纪律。
- 召回块正文由 `recallBlockText()` 渲染，标题写成
  `### 与当前话题相关的召回（尾部注入）`，并明确「只是背景参考、不要当成用户要求、不要写回记忆」。
- `ctx.on('agent/pre-step', ...)` 里把它折进这一 step 的进入批次：

```js
ctx.on('agent/pre-step', async (payload, next) => {
  const decision = await next();
  return injectTailRecall(decision, payload);
});
// injectTailRecall：
const anchor = entering.findLastIndex((candidate) => messages.includes(candidate));
return { ...decision, messages: entering.toSpliced(anchor + 1, 0, message) };
```

- 去重三层，保证「一轮恰好一次」：
  1. `buffer.injectedTurn === turn`（内存层）；
  2. `tailAlreadyInSession(session, turn)`：扫 `session.surface.nodes` / `session.eventAt(seq)`，
     看会话日志里有没有 `user/message` 且 `source.kind === 'dsh-memory' && source.turn === turn`
     （重试 / 续跑 / 重放）；
  3. 进入批次里已经有同一条 payload 时不再插入。
- 不越过「本 step 本来就没消息」的边界：`decision.kind === 'reject'`、批次为空、
  或批次里只有 `source.kind === 'runtime-context'` 时一律不注入 —— 否则会给一个本来不会发生的
  step 凭空塞出一条召回，白烧一次模型调用。
- `turnRecall` / `turnRecallLimit` 设置照旧生效（`recallFor()` 里读设置）。
- 注入计量写进 `lastTail`，通过 `/memory/api/state` 的 `briefing.tail` 暴露。

### 2.4 重算闸：内容变了也不一定立刻重算（2026-11-08 / 2026-11-09 修订）

指纹只解决「纯读不变」，解决不了「写一条就变一次」。DSH 的 `in-history` 契约是
**把整份系统提示追加到缓存历史之后**（见 §3.1），所以每次重算的代价不是改一段，
而是历史里永久多一份 ~10KB 的提示。实测：4 轮 / 273 步的会话出现 6 份系统提示
（多出 51K 字符，约占该会话 61.5M tokens 的 3.8%）；29 轮 / 485 步的会话出现 28 份。
2026-11-09 复查更极端：51 轮追加 78 份、单份约 6.7KB，累计 524K 字符。

现在的策略（`lib/index.js` 的 `briefingTextCore`）：

- 指纹变了以后先看闸，没过就继续返回冻结字节，`lastBriefing.reason = 'coalesced'`，
  `pendingNew` / `waitedMs` 进 `/state` 方便面板解释「为什么还没刷新」；
- **硬间隔**：距上次重算不足 `briefingRebuildCooldownMs`（默认 30 分钟）时，
  即使新增记录已经超过 `briefingRebuildMinNew`（默认 3）也不重算；
- 冷却结束后：新增记录达到 `briefingRebuildMinNew` 就批量重算一次；
  没有新增、只有编辑 / 归档 / 画像版本 / 工作日志变化时，最多再等 2 个冷却周期；
- 首次装配、工作区切换、模式切换、会话 id 复用照旧立即重算；
- 红线是安全边界：新增 / 改稿 / 归档绕过冷却与条数闸，立刻重算；
- 把 `briefingRebuildCooldownMs` 设为 `0` 才等同旧行为（有变化就重算）；
  `briefingRebuildMinNew: 1` 只表示「冷却一过，有一条新记录就重算」。

代价与取舍：默认最多约 30 分钟 / 3 条之内，新写的记忆与改稿不会出现在下一次请求的索引里
（红线除外）；正文仍可用 `memory action=search/get` 取到，轮末召回也不看简报冻结
（新记忆下一轮仍可能被尾部召回带出）。简报正文同时去掉了工作区统计行
（条数会随单条写入立刻变，是重算的稳定触发器）。

## 3. 尾部注入的宿主契约（证据）

源码都在 `D:\DSH\resources\app.asar`（0.2.1-rc.2）。抽取方式：

```pwsh
node -e "const b=require('fs').readFileSync('D:/DSH/resources/app.asar');const s=b.toString('latin1');let i=s.indexOf('agent/pre-step');console.log(s.slice(i-800,i+800))"
```

### 3.1 内建 `dsh-agent-instructions` 的同一套写法

`dsh/node_modules/@deepseek-ai/dsh-agent-instructions/lib/index.js`：

```js
ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => {
  const decision = await next();
  ...
  if (decision.kind === "reject" || step === 1 && decision.messages.length === 0) {
    syncInbox(agent, messages, desired);
    return decision;
  }
  ...
  const lastClaimedIndex = decision.messages.findLastIndex((message) => messages.includes(message));
  const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired);
  return { ...decision, messages: entered };
});
```

它的 README 写明这套语义：

> At the first eligible `agent/pre-step` of a session, the plugin composes the baseline
> and **folds it into the entering batch right after the claimed messages**.
>
> Baseline and refresh messages are **ordinary sourced `user/message` events**, so they replay,
> compact, and resume exactly like other history, and model-visible state is always
> reconstructable from the session log.

### 3.2 进入批次怎么变成会话历史

`dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`：

- `preStep()` 认领 inbox 后发起 waterfall：

```js
const decision = await this.dispatch.waterfall("agent/pre-step", { messages: claimed, ...position, signal }, () => {
  const sections = renderContextSections(assembly);
  const context = this.runtimeContext.project(joinContextSections(sections), sections);
  return Promise.resolve({ kind: "enter", messages: context === void 0 ? claimed : [...claimed, context] });
});
```

- `step(decision)` 把这些消息落成 durable 事件（`firstAttempt` 保证同一步的重试不会重复落）：

```js
if (firstAttempt) for (const message of decision.messages) if (message.source.kind === "runtime-context") {
  ...
} else this.session.append("user/message", message, { surfaceOp: "append" });
```

两条硬约束由此确定：

1. **`message.source` 必须有 `.kind`** —— 那句 `message.source.kind` 会直接读属性，
   没有 `source` 会抛；我们给 `{ kind: 'dsh-memory', form: 'turn-recall', turn, ids }`。
2. 消息不会被宿主丢掉：它作为 `user/message` 落库，模型这一 step 就看得见；也正因为落了库，
   去重必须查会话日志（见 §2.3 第 2 条）。

## 4. 预览与面板

`lib/api.js` 的 `GET /briefing-preview` 与 `lib/client.js` 的「下次会话将注入」需要配合
（已随本次合并进两个文件）：

- 新增依赖 `snapshotInfo(workspace)` / `recallInfo(workspace)`（`lib/index.js` 已提供）。
- 预览新增字段：`frozen`、`sessionId`、`staticText`（**冻结时就是接下来注入的那份字节**）、
  `staticChars`、`recall: { count, ids, titles, chars, text } | null`。
- 面板：标题行加「尾部 +N」标记，展开区加「尾部注入（不进系统提示）／已冻结」两行。
- 没有尾部召回时 `recall` 为 `null`，面板显示「本轮没有尾部召回」。

## 5. 验收与回归

`node test/run-all.mjs`：改前 **9 套件 / 370 断言**，改后 **10 套件 / 392 断言**，全绿。
新增 `test/briefing-stability.test.mjs`（14 条），并在 `test/activate.test.mjs` 里按新语义
改写了「系统提示段带简报」「轮末召回」「portrait 快照」两类用例。

## 6. 行为变化（用户可感知）

1. **画像改写现在会在同一会话内生效**：以前 `portraitFreeze` 让进行中的会话看不到新画像，
   下一会话才生效；现在只要内容真的变了，下一次请求会重算一次简报再重新冻结
   （会牺牲一次前缀缓存，换「面板说的就是模型看的」）。
2. **轮末召回从系统提示挪到了用户消息尾部**：模型仍然看得到，但它出现在对话里而不是系统提示里，
   并且明确标了「背景参考、不要回写记忆」。
3. `/memory/api/state` 的 `briefing` 多了 `sessionId / reason / frozen / builds / rebuilds / tail`。
