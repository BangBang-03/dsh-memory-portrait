# Contributing

Thanks for taking a look. This is a DSH plugin, not a standalone app: most changes need a real DSH desktop/web profile to verify.

## 开发环境

- Windows + DSH desktop（或 web profile），Node `^22.19` / `>=24`，PowerShell 5.1+。
- 先看安装计划，再真装：

```powershell
pwsh -File install.ps1 -DryRun
pwsh -File install.ps1
# 重启 DSH 桌面端
```

- 测试：

```powershell
node test/run-all.mjs   # 15 套件 / 701 断言
```

`install` 套件会真跑 `install.ps1` / `uninstall.ps1`，需要 Windows + `pwsh`；其它套件是纯逻辑层，可以单独跑，例如 `node test/store.test.mjs`。

## 分支与发布

- **只有 `main` 一个长期分支**；功能分支请短命，合并回 `main` 前跑全量测试。
- 正式版用 `v*` 标签发布；不要移动或复用已发布的标签。
- 提交信息用 `feat:` / `fix:` / `docs:` / `test:` / `chore:` 前缀。
- 不要提交 `~/.dsh/storages/dsh-memory` 里的真实记忆、`.probe/`、本地备份或任何 token。

## Pull request

- 一个 PR 只做一件事；带上测试或说明为什么不需要测试。
- 改到配置项 / HTTP 端点时，同步 README 的「配置」与「HTTP 契约」表（C7）。
- 不加运行时依赖：`dependencies` 保持空，`lib/*.js` 只 import `node:*` 与相对路径（P7）。
- 改客户端面板时附截图或说明验证路径；改宿主半时说明是否重启 DSH。

## 报告问题

用仓库的 issue 模板，至少带上：

- DSH 版本、安装方式（npm / Release 资产 / 源码）、操作系统；
- 复现步骤、期望结果、实际结果；
- 相关日志（**先脱敏**：不要贴 token、密钥、完整记忆正文）。

安全问题不要公开贴敏感内容；能开 GitHub Security Advisory 就走私有通道。
