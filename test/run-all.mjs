/**
 * 一次跑完 dsh-memory 的全部测试套件。
 *   node test/run-all.mjs
 * 任一子套件失败即 exit 1。
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const suites = [
  ['store', '存储层：工作区分库、去重合并、检索、镜像、导入导出'],
  ['retrieval', '检索层：BM25F、短语、related 一跳、评测基线'],
  ['security', '写入安全：密钥脱敏、注入检测、trust 分级与隔离'],
  ['derivation', '派生链：记忆→画像→AGENTS.md 的源快照与反向标脏'],
  ['verification', '可执行校验：失效条件（falsifier）与到期复审队列'],
  ['portrait', '画像层：段落模型、Markdown 渲染与解析、预算截断与注入'],
  ['markdown', '既有记忆解析：WorkBuddy 笔记/日报、Qoder frontmatter、纯文本、本机扫描'],
  ['distill', '提炼层：对话摘录、模型输出解析、触发条件'],
  ['distill-global', '全局原则晋升：候选准入、分层门槛、主题聚类'],
  ['api', 'HTTP 契约：43 个端点（含既有记忆扫描导入）、错误码、参数校验'],
  ['host', '宿主半：导出、Config 默认值与校验'],
  ['activate', '宿主半激活：假 cordis 跑 apply()，工具 / 提示段 / 路由真的能用'],
  ['briefing-stability', '简报稳定性：会话级冻结快照、确定性排序、轮末召回尾部注入'],
  ['client', '客户端半：模块格式、槽位注册、渲染与交互（端到端）'],
  ['install', '安装脚本：备份、幂等、dry run、卸载还原与拒绝误删'],
];

let failed = 0;

for (const [name, description] of suites) {
  console.log(`\n=== ${name} — ${description} ===`);
  const result = spawnSync(process.execPath, [path.join(here, `${name}.test.mjs`)], {
    stdio: 'inherit',
    cwd: path.resolve(here, '..'),
  });
  if (result.status !== 0) failed += 1;
}

console.log('');
if (failed > 0) {
  console.log(`${failed} 个套件失败`);
  process.exit(1);
}
console.log(`全部 ${suites.length} 个套件通过`);
