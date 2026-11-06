/**
 * 宿主半冒烟测试：不启动 DSH，直接 import lib/index.js，验证导出与 Config 行为。
 * 运行：node test/host.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkLocal } from '../tools/check-compat.mjs';
import { verifyDocNumbers } from '../tools/doc-numbers.mjs';

const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

let mod;
try {
  mod = await import('../lib/index.js');
} catch (error) {
  console.error('FAIL  无法 import lib/index.js:', error?.message || error);
  console.error(error?.stack);
  process.exit(1);
}

const checks = [];
function check(label, fn) {
  try {
    fn();
    checks.push(['ok', label]);
  } catch (error) {
    checks.push(['fail', label, error?.message || String(error)]);
  }
}

check('导出 name', () => assert.equal(mod.name, 'dsh-memory'));
check('导出 inject 含 tools', () => assert.deepEqual(mod.inject, ['tools']));
check('导出 apply 函数', () => assert.equal(typeof mod.apply, 'function'));
check('导出 Config', () => assert.ok(mod.Config));
check('默认导出完整', () => {
  assert.equal(typeof mod.default.apply, 'function');
  assert.equal(mod.default.name, 'dsh-memory');
});

check('Config 解析空对象得到默认值', () => {
  const value = mod.Config({});
  assert.equal(value.enabled, true);
  assert.equal(value.mirror, true);
  assert.equal(value.briefing, true);
  assert.equal(value.briefingLimit, 12);
  assert.equal(value.briefingMaxChars, 2000);
  assert.equal(value.portraitMaxChars, 1400);
  assert.equal(value.discipline, true);
  assert.equal(value.rewriteMode, 'direct');
  assert.equal(value.journalDays, 14);
  assert.equal(value.autoCapture, false);
  assert.equal(value.minConfidence, 0.4);
  assert.equal(value.maxPerTurn, 5);
  assert.equal(value.turnRecallMaxChars, 800);
  assert.equal(value.maxTranscriptChars, 4000);
  assert.equal(value.dedupe, true);
  assert.equal(value.qualityGate, true, '质量闸门默认开');
  assert.equal(value.redactSecrets, true);
  assert.equal(value.quarantineTainted, true);
  assert.equal(value.falsifierReviewDays, 90);
  assert.equal(value.captureSubagents, false, '子代理会话默认不参与自动提炼');
  assert.equal(value.autoDreamDays, 7, '启动整理默认每 7 天一次');
  assert.equal(value.autoDreamPortrait, false, '启动整理默认不重写画像（画像由自动刷新负责）');
  assert.equal(value.globalDistill, true, '二级蒸馏默认开：自动为主，不靠用户点确认');
  assert.equal(value.autoPortraitHours, 6, '画像默认每 6 小时自动刷新');
  assert.equal(value.sectionOrder, 550);
  assert.equal(value.hudIcon, 'a', '会话卡图标默认官方鲸鱼标');
  assert.equal(value.directory, '');
  assert.equal(value.autoInject, true, '注入总闸默认开');
  assert.deepEqual(value.disabledWorkspaces, [], '停用名单默认空');
});

/**
 * C7 的自动化版本：配置键必须同时出现在 README 与 REFERENCE 的配置表里。
 *
 * 这条以前只靠人工纪律（「加键记得改三处」），结果真的漏过 6 个键。
 * 现在改成断言：加键忘了写文档，测试直接红。
 */
check('C7 文档覆盖：每个配置键都在 README 与 REFERENCE 的配置表里有说明', () => {
  const keys = Object.keys(mod.Config({}));
  const documentedKeys = (file) => {
    const text = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const out = new Set();
    for (const line of text.split('\n')) {
      const hit = line.match(/^\| `([a-zA-Z][a-zA-Z0-9]*)` \|/);
      if (hit) out.add(hit[1]);
    }
    return out;
  };
  for (const file of ['README.md', 'docs/REFERENCE.md']) {
    const documented = documentedKeys(file);
    const missing = keys.filter((key) => !documented.has(key));
    assert.equal(missing.length, 0, `${file} 配置表缺少：${missing.join(', ')}`);
  }
});

/**
 * 校验器自身的测试。
 *
 * 这道闸守的是「测试全绿但文档写错数字」，如果它自己写错了，问题只会更隐蔽——
 * 所以它必须被测到，而不是只靠人工跑一次确认能过。
 */
check('文档数字校验器：徽章 / 断言 / 套件明细三种写法都能识别', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-docnum-'));
  fs.writeFileSync(
    path.join(dir, 'doc.md'),
    [
      '![Tests](https://img.shields.io/badge/tests-100%20passed-blue)',
      '全部 15 个套件通过，100 条断言。',
      '15 个套件、100 项（明细可能滞后）。',
    ].join('\n'),
    'utf8',
  );
  const files = ['doc.md'];
  assert.deepEqual(verifyDocNumbers(dir, { total: 100, suites: 15, files }), []);
  const bad = verifyDocNumbers(dir, { total: 200, suites: 15, files });
  assert.equal(bad.length, 3, '三种写法各报一次，不能合并成一条也不能漏');
});

check('文档数字校验器：套件数写错也会被抓到', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-docnum2-'));
  fs.writeFileSync(path.join(dir, 'doc.md'), '全部 14 个套件通过，100 条断言。', 'utf8');
  const problems = verifyDocNumbers(dir, { total: 100, suites: 15, files: ['doc.md'] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /套件数.*14.*15/);
});

check('Config 接受停用工作区名单', () => {
  const value = mod.Config({ disabledWorkspaces: ['C:/tmp/one-off', '/home/u/scratch'] });
  assert.deepEqual(value.disabledWorkspaces, ['C:/tmp/one-off', '/home/u/scratch']);
});

check('续跑判定：没有新信息的确认句跳过召回，短指令照常召回', () => {
  const cont = mod.isContinuation;
  for (const text of ['继续', '好的，那就继续吧', '嗯', 'ok', '下一步', '谢谢！', '接着往下']) {
    assert.equal(cont(text), true, `应判为续跑：${text}`);
  }
  for (const text of [
    '为什么构建这么慢',
    '好的，那就按 B 方案做',
    '帮我看看 store.js 里怎么写的',
    '继续把画像重写做完',
    '是不是该换成 BM25',
  ]) {
    assert.equal(cont(text), false, `不该判为续跑：${text}`);
  }
});

check('Config 接受覆盖值', () => {
  const value = mod.Config({ enabled: false, autoCapture: true, briefingLimit: 5, falsifierReviewDays: 30 });
  assert.equal(value.enabled, false);
  assert.equal(value.autoCapture, true);
  assert.equal(value.briefingLimit, 5);
  assert.equal(value.falsifierReviewDays, 30);
});

check('Config 拒绝越界值', () => {
  assert.throws(() => mod.Config({ briefingLimit: 999 }));
  assert.throws(() => mod.Config({ minConfidence: 5 }));
});

check('API_PREFIX 常量正确', () => assert.equal(mod.API_PREFIX, '/memory/api'));
check('GLOBAL_KEY 常量正确', () => assert.equal(mod.GLOBAL_KEY, '_global'));

/*
 * 清单契约：用户装的是整包，宿主只看 package.json 的 engines.dsh。
 * 两处范围漂移过一次——0.2.1-rc.5 被 `<0.2.1-rc.4` 排除，宿主启动时静默跳过 bundle，
 * 市场卡片报“已安装，与当前 dsh 不兼容”。这里把“0.2 版本线整体声明”钉成测试，
 * 再收窄就必须显式改测试，而不是悄悄把当前桌面版关在门外。
 */
check('包清单的 DSH 范围两处一致', () => {
  assert.equal(manifest.engines?.dsh, manifest.dsh?.compatibility?.dsh);
});

check('DSH 兼容范围按 0.2 版本线声明', () => {
  assert.equal(manifest.engines?.dsh, '>=0.2.0-rc.2 <0.3.0-0');
});

check('dshReleases 只记合法状态', () => {
  const releases = manifest.dsh?.compatibility?.dshReleases ?? {};
  const versions = Object.keys(releases);
  assert.ok(versions.length > 0, 'dshReleases 不能为空');
  for (const version of versions) {
    assert.match(version, /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/, `版本号格式不对：${version}`);
    assert.ok(
      ['compatible', 'unknown', 'incompatible'].includes(releases[version]),
      `状态非法：${version} = ${releases[version]}`,
    );
  }
});

check('README 兼容表与 package.json 同源', () => {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const result = checkLocal(manifest, readme);
  assert.deepEqual(result.errors, []);
});

check('市场元数据声明 web / desktop 与桌面手动步骤', () => {
  assert.deepEqual([...(manifest.dsh?.marketplace?.profiles ?? [])].sort(), ['desktop', 'web']);
  assert.equal(manifest.dsh?.marketplace?.requiresBuildApproval, false);
  assert.equal(manifest.dsh?.marketplace?.requiresRestart, true);
  assert.equal(manifest.dsh?.marketplace?.manualSteps, true);
});

check('权限声明覆盖 git 且无外发网络', () => {
  assert.equal(manifest.dsh?.permissions?.network, 'none');
  assert.equal(manifest.dsh?.permissions?.commands, 'git');
  assert.equal(manifest.dsh?.permissions?.credentials?.length, 0);
  assert.equal(manifest.dsh?.permissions?.externalServices?.length, 0);
});

let failed = 0;
for (const [state, label, detail] of checks) {
  if (state === 'ok') console.log(`  ok   ${label}`);
  else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
