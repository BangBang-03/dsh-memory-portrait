# 项目级 skills

本目录只放本仓库自己的 skill，不安装到全局 skill 目录。入口在 `AGENTS.md` 的「2.4 项目级 skills」。

| skill | 用途 |
| --- | --- |
| [`release/SKILL.md`](release/SKILL.md) | 正式发版、打 `v*` 标签、核对 Release |
| [`docs-sync/SKILL.md`](docs-sync/SKILL.md) | 更新文件 / 更新文档 / 更新日志：README、AGENTS、REFERENCE、CHANGELOG 与 journal 的默认同步 |
| [`memory-doc/SKILL.md`](memory-doc/SKILL.md) | 更新工作区项目记忆 `.dsh-memory/MEMORY.md`：先判断插件在不在、结构固定、写作规范、离线交接校验 |
| [`delivery-check/SKILL.md`](delivery-check/SKILL.md) | 交付前自查：先跑自动化闸门，再查交付物是否真的更新、文档描述是否跟上行为变更、新文件有没有被索引；核心是「自查只对当时的 HEAD 有效」 |
| [`global-distill/SKILL.md`](global-distill/SKILL.md) | 从项目记忆蒸馏跨项目原则（二级蒸馏）：提示词、输出格式、三类禁止、校验与落库 |

新增 skill 的约定：

- 目录名与 frontmatter 的 `name` 一致，用 kebab-case。
- `SKILL.md` 必须带 `name` 与 `description`；`description` 写清触发场景，不能只写「发版」。
- 可执行脚本放在 `scripts/`，只依赖 `node:*` 与仓库相对路径（AGENTS P7）。
- 新增后在 `AGENTS.md` 2.4 加一行路由，不要只靠目录名被发现。
