---
name: release
description: DSH 记忆插件的推送与正式发版流程。main 是唯一长期分支；推 main 只跑测试，正式版只在 main 头打 v* 标签。用户说「发版 / 发布正式版 / release / 打标签 / 核对 Release」时使用。按 AGENTS P1/P2/P3/P6/P8 执行；禁止用 git push 直连、禁止混用两种推送通道。
---

# DSH 记忆插件：推送与正式发版

## 适用场景

- 用户说「发版」「发布正式版」「release」「打 vX.Y.Z」：走完整正式版流程。
- 用户说「推 main」：只推 `main`，不 bump、不打标签；`main` 推送会触发测试，但不会发版。
- 发布后核对 Release 资产、CI 结论、`latest` 指向：跑 `tools/release-watch.mjs`。

## 先读

- `AGENTS.md` 的 P1 / P2 / P3 / P6 / P8：分支、推送通道、测试与标签的硬约束。
- `tools/release.mjs`：推 `main` + 建 `v*` 标签；只拒绝**已跟踪改动**，未跟踪文件（如 `.probe/`）不阻塞。
- `tools/release-watch.mjs`：等标签触发的 Actions，核对 Release 是否 Latest、资产是否齐全。

## 不可违反

1. **`main` 是唯一长期分支**。功能分支必须短命；合回 `main` 前跑全量测试。不再维护 `lab`。
2. **正式标签只在 `main` 头**。标签提交必须与 `main` 同一提交；不在其它分支打 `v*`。
3. **只用 REST 通道**。所有推送走 `node tools/push.mjs` / `node tools/release.mjs`；不要用 `git push`，也不要在同一条分支上混用两种通道（P3）。
4. **版本号必须是正式号**。`package.json` 不能带 `-lab.N`；标签 `vX.Y.Z` 必须与它逐字对应。
5. **全量测试全绿才发**。`node test/run-all.mjs` 必须 15 套件 / 642 断言通过；纯文档改动可跳过，但发版提交包含 `package.json`，不能跳过。
6. **不改写历史**。已推送的 `main` 不 amend、不 rebase、不 force push（P2）。
7. **不发布未跟踪内容**。`.probe/`、本地审计材料等未跟踪文件不进入发布提交；不要为了发版把它们 `git add` 进去。

## 日常推送（不发版）

```bash
git branch --show-current                       # 必须是 main
node test/run-all.mjs                           # 15 套件 / 642 断言
node tools/push.mjs --branch main
```

推 `main` 会触发 `publish.yml` 的 `test` job（只跑纯逻辑层测试，不发布）。
REST 重建的提交时区会归一成 `+0000`，不要在之后改用 `git push` 推同一条分支。

## 正式发版

### 0. 预检

```bash
git branch --show-current                       # 必须是 main
git status --porcelain --untracked-files=no     # 必须为空（已跟踪改动不能带进发版）
node -p "require('./package.json').version"     # 当前版本，例如 0.6.6
git ls-remote origin refs/heads/main 'refs/tags/v*'
node tools/status.mjs                           # main / 最新正式版 / 最近 CI
```

选下一个正式版号：默认是当前补丁号 +1（`0.6.6` → `0.6.7`）。如果用户指定了版本，按用户指定的来。确认目标标签在本地和远端都不存在；存在就说明这个版本已经发过，换下一个补丁号。

### 1. 提升版本并跑全量测试

把 `package.json` 的 `version` 改成目标正式版本号，同时确认 `package-lock.json` 根版本一致，然后：

```bash
node test/run-all.mjs
```

必须看到「全部 15 个套件通过」且断言数为 641。测试红就停在 `main` 修，不要提交发版号、不要打标签。

### 2. 提交并推送 main

发版提交只包含版本文件：

```bash
git add package.json package-lock.json
git commit -m "chore(release): X.Y.Z"
node tools/push.mjs --branch main
```

等这次 `main` 推送触发的 `publish` / `test` job 变绿，再打标签。

### 3. 打标签并正式发布

```bash
node tools/release.mjs
```

`release.mjs` 会依次检查：当前在 `main`、已跟踪工作区干净、版本号不是预发布、目标标签不存在；然后用 REST 推 `main`（若已推送是空操作），在远端 `main` 头创建 `vX.Y.Z` 标签，并在本地打同名标签。

### 4. 等 CI 并验收

```bash
node tools/release-watch.mjs
```

默认读取 `package.json` 的版本，也可以显式传入：

```bash
node tools/release-watch.mjs --version X.Y.Z
```

脚本会等待该标签触发的 `publish` 与 `Publish to npmjs` 工作流结束，并核对：

- `publish` 的 stable 任务成功；
- Release `vX.Y.Z` 存在、非 prerelease、非 draft；
- Release 是 GitHub Latest；
- 资产包含 `dsh-memory-latest.tgz` 和 `*-X.Y.Z.tgz`；
- npmjs 通道是「已发布」还是「跳过（未配置 NPM_TOKEN）」。

只有退出码为 0 才算正式版完成。CI 失败时先打开运行链接定位，不要手工改 Release 资产掩盖失败。

### 5. 收尾

```bash
node tools/status.mjs
```

向用户汇报：版本号、标签提交、`main` 与标签的远端 SHA、CI 结论、Release 链接、npmjs 通道状态。

## 失败处理

| 现象 | 处理 |
| --- | --- |
| 全量测试红 | 停在 `main` 修复；不要提交发版号或打标签 |
| `push.mjs` 认证失败 / 网络失败 | 检查 `GH_TOKEN` 或 git credential store；重跑同一个 REST 工具，不要改用 `git push` |
| `push.mjs` 报「找不到与远端头内容一致的本地提交」 | 本地与远端历史不一致；按提示先用 `node tools/sync.mjs` 对齐，不要绕开强推 |
| 标签已存在 | 该版本已发过；换下一个补丁号，绝不移动或复用旧标签 |
| `publish` CI 失败 | 打开运行链接定位；修复后用新的补丁号重走流程 |
| Release 不是 Latest / 缺资产 | 看 stable 任务日志；先确认工作流是否失败，不要手工补资产掩盖问题 |
| npmjs 跳过 | 仓库未配置 `NPM_TOKEN`，属于设计行为；GitHub Release 与 GitHub Packages 不受影响 |

## 验收清单

- [ ] `package.json` 版本 = 标签版本 = Release 标题
- [ ] `node test/run-all.mjs`：15 套件 / 642 断言全绿
- [ ] 远端 `main` 与 `vX.Y.Z` 指向同一提交或内容等价的提交
- [ ] `publish` 的 stable 任务成功
- [ ] Release 是 Latest、非 prerelease、资产齐全
- [ ] npmjs 状态已记录（发布或跳过）
- [ ] 没有 amend / rebase / force
