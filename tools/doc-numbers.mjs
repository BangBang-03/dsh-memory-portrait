/**
 * 文档数字校验：README / AGENTS / REFERENCE 等处的断言总数与套件数，必须和实际跑出来的一致。
 *
 * 为什么单独抽一个模块：这个数字以前靠 `sed` 手工同步 8 个文件，2026-11-06 的自查里
 * 连漏 3 轮——`tests-641%20passed`、`15 个套件 644 条` 这些写法各自的 sed 模式覆盖不到。
 * 抽出来才能给它自己写测试；否则「校验器写错了」这件事永远没人发现。
 *
 * 只依赖 `node:*`（P7）。
 */

import fs from 'node:fs';
import path from 'node:path';

export const DOC_FILES = [
  'README.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'lib/README.md',
  'skills/release/SKILL.md',
  'docs/REFERENCE.md',
  'test/README.md',
  /* 测试入口里的套件描述也是人读的，漏改一样会误导人。 */
  'test/run-all.mjs',
];

/**
 * 断言总数在文档里的各种写法。写法太多正是 sed 漏改的原因，这里一次收全：
 *   tests-646%20passed（徽章）、646 断言、646 条断言、646 项断言、15 个套件、646 项
 *
 * 注意 `(?:条|项)?` 不能省：漏了它，`15 个套件 / 646 条断言` 这种写法会被整条跳过——
 * 校验器自己也要被测到，就是因为这个正则一开始真的漏了「条断言」。
 */
/**
 * 注意：这个校验器扫的是**全文**，包括注释与代码块里的示例。
 * 所以文档里举例时要写成 `tests-NNN%20passed` 而不是真的贴一个数字——
 * 2026-11-06 就在 run-all.mjs 的注释里贴了 `tests-641%20passed`，
 * 结果被自己当成真徽章，误报了一次。
 */
export const ASSERT_PATTERNS = [
  { re: /tests-(\d+)%20passed/g, label: '测试徽章' },
  { re: /(\d+)\s*(?:条|项)?断言/g, label: '断言总数' },
  { re: /个套件[、/\s]*(\d+)\s*项/g, label: '套件明细合计' },
];

export const SUITE_PATTERN = /(\d+)\s*个?套件/g;

/** 文档里端点数的写法。 */
export const ENDPOINT_PATTERN = /(\d+)\s*个端点/g;

/**
 * api.js 里的路由 key 有两种形态：`'GET /ping'` 和 `async 'POST /dream'`。
 * 手工 grep 很容易只数到一种——2026-11-06 就因为漏了 async 那 5 个，
 * 把 53 个端点写成 48 进了文档。这里按实际写法数，不靠人肉。
 */
const ROUTE_KEY_PATTERN = /^\s+(?:async )?'(?:GET|POST|DELETE|PUT|PATCH) \//gm;

/** 统计实际注册的端点数；api.js 不在时返回 null（跳过该检查）。 */
export function countEndpoints(root) {
  const file = path.join(root, 'lib/api.js');
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  return (text.match(ROUTE_KEY_PATTERN) || []).length;
}

/**
 * @param root          仓库根目录
 * @param opts.total    实际断言总数
 * @param opts.suites   实际套件数
 * @param opts.files    覆盖默认的待查文件列表（测试用）
 * @returns {string[]}  问题列表；空数组表示全部一致
 */
export function verifyDocNumbers(root, { total, suites, files = DOC_FILES } = {}) {
  const problems = [];
  const seen = new Set();
  const endpoints = countEndpoints(root);

  const record = (file, label, value, expected) => {
    if (value === expected) return;
    const key = `${file}|${label}|${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push(`${file} [${label}] 写着 ${value}，实际 ${expected}`);
  };

  for (const file of files) {
    const abs = path.join(root, file);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');

    for (const { re, label } of ASSERT_PATTERNS) {
      for (const match of text.matchAll(re)) {
        record(file, label, Number(match[1]), total);
      }
    }
    for (const match of text.matchAll(SUITE_PATTERN)) {
      record(file, '套件数', Number(match[1]), suites);
    }
    if (endpoints !== null) {
      for (const match of text.matchAll(ENDPOINT_PATTERN)) {
        record(file, '端点数', Number(match[1]), endpoints);
      }
    }
  }
  return problems;
}

export default { DOC_FILES, ASSERT_PATTERNS, SUITE_PATTERN, ENDPOINT_PATTERN, countEndpoints, verifyDocNumbers };
