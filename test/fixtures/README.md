# test/fixtures

测试数据。目前有两份：

- `retrieval-hard-60.json` —— 60 条确定性检索评测集，分六组各 10 条：
  同义改写、路径 / 代码、近邻干扰、`related` 多跳、否定 / 纠错、标签 / 关键词。
  每条记忆用 fixture 内的 `key`（`m01`…）互相引用，`gold` 也按 `key` 标注，
  这样不依赖真实存储的自增 id。
- `false-positive-2026-11-09.json` —— 误报回归夹具：真实库 `health.contradictions`
  的 10 对误报（句内对比句 / 变更语态 / 同主题共享词 / 二元组碎片四类）、
  一对真冲突（pnpm → npm）与 6 条 benign 用户规则句。
  作用是把「修一批触发词又冒出另一批」钉死：默认路径必须零矛盾结论，
  显式诊断只作只读信号、绝不自动归档。背景见 `docs/false-positive-audit-2026-11-09.md`。

由 `test/retrieval.test.mjs` 与 `test/store.test.mjs` 读取；改动评测集会直接影响检索基线，
`docs/retrieval-eval-2026-10-20.md` 里的数字需要同步复核。
