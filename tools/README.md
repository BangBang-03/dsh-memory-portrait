# tools

维护单一 `main` + `v*` 标签发版模型的脚本。全部走 **GitHub REST API**：
本机连不上 `github.com:443`，只通 `api.github.com`，所以 `git push` / `git fetch` 不可用。

| 脚本 | 干什么 |
| --- | --- |
| `push.mjs` | 用 REST 把本地提交逐个在远端重建并推当前分支；tree sha 对不上就中止，不做强推；`synced yes` 表示没有新提交要推 |
| `sync.mjs` | 用 REST 补齐远端对象并把本地 refs / 标签对齐到远端（等价 `git pull`），`--dry` 只看缺什么 |
| `release.mjs` | 在 `main` 上推代码并打 `v<package.json 版本>` 标签，触发正式发版；只拒绝已跟踪改动，未跟踪文件（如 `.probe/`）不阻塞；`--dry` 只检查 |
| `release-watch.mjs` | 只读：等 `v*` 标签触发的 Actions 跑完，核对 Release 是否 Latest、非预发布、资产齐全，并报告 npmjs 通道状态 |
| `check-compat.mjs` | 只读：核对 `package.json`、README 兼容表；`--npm` 再核对 npmjs 上已发布的同一版本清单 |
| `status.mjs` | 只读：默认分支、各分支头、最近 CI、最新正式版 |
| `doc-numbers.mjs` | 只读：校验文档里的断言总数与套件数是否和实际一致；由 `test/run-all.mjs` 在测试全绿后调用，不一致就红 |

```powershell
node tools/status.mjs                 # 先看状态
node tools/push.mjs [--branch main] [--dry]
node tools/sync.mjs [--dry]
node tools/release.mjs [--dry]        # 仅在 main 上、版本号已 bump 后
node tools/release-watch.mjs          # 打标签后：等 CI + 核对 Release
node tools/check-compat.mjs [--npm]   # 兼容口径：README / package.json / npm 已发布清单
```

`main` 上的日常提交只跑 CI 测试；正式版由 `v*` 标签触发 `publish.yml` 的 stable job。
完整发版顺序与失败处理见 [`skills/release/SKILL.md`](../skills/release/SKILL.md)。

- token：优先 `GH_TOKEN` 环境变量，否则读本机 git credential store 里 `github.com` 的凭据。
- **不要把 git 推送与 REST 推送混用**：REST 重建的提交时区归一成 `+0000`，同树不同 SHA，混推会分叉（`AGENTS.md` P3）。
