# docs

设计文档与调研记录，不是发布合同——配置表、HTTP 契约以根 [README.md](../README.md) 为准。

| 文档 | 内容 |
| --- | --- |
| `REFERENCE.md` | v0.6.6 完整规格存档：旧版页面细节、导入格式、测试明细、边界与对标 |
| `launch-copy-2026-10-28.md` | 发布素材：安全审计 / prompt cache / 治理三个角度与渠道草稿 |
| `briefing-cache-safety.md` | 简报为什么必须字节稳定：会话级冻结、确定性排序与缓存命中率的代价 |
| `retrieval-eval-2026-10-20.md` | 检索方案与 60 条评测的基线数字 |
| `personal-memory-parity.md` | 与 WorkBuddy 个人记忆的能力差距 |
| `global-distill-trial-2026-11-05.md` | 二级蒸馏试跑：122 条记忆产出 4 条原则的实测与淘汰分析，晋升门槛的来源 |
| `market-scan-2026-10.md` | 市场同类插件扫描与插件自查 |
| `dsh-memory-landscape-2026-10.md` | 同类产品全景 |
| `competitive-delta-2026-10-20.md` | 头部产品近月新机制、可借鉴清单与优先级 |
| `false-positive-audit-2026-11-09.md` | 误报与规则冲突专项调研：真实库 10 对疑似矛盾的成因、同类系统方案对照、时间轴 + 策略注册表的改造方案；文末记有 P0 / 默认不产出矛盾 / L3 的落地进度 |

带日期的文档是当时的调研快照，数字与结论不随代码更新；引用前先对照当前实现与测试。
当前面板信息架构、红线审计 / 历史、画像逐段编辑与依据下钻、需要处理收件箱，以
[`REFERENCE.md`](REFERENCE.md) 的「近期改动（0.6.4）」一节为准。正式发版流程见
[`skills/release/SKILL.md`](../skills/release/SKILL.md)。
