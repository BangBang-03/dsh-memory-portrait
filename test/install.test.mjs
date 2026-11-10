/**
 * dsh-memory 安装脚本测试：在临时目录里搭一个假的 DSH 主目录，真跑 install.ps1 / uninstall.ps1。
 *   node test/install.test.mjs
 *
 * 只碰临时目录：包根是复制出来的假包，profile 是造的，跑完删干净。
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err && err.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-install-'));
const fakeHome = path.join(tmp, 'dshhome');
const fakePkg = path.join(tmp, 'pkg');
const profileDir = path.join(fakeHome, 'profiles', 'desktop');
const profileJson = path.join(profileDir, 'package.json');

const ORIGINAL_PROFILE = {
  name: 'dsh-profile-desktop',
  private: true,
  dependencies: {
    'dsh-context': '0.66.1',
    'dsh-cost-meter': '1.8.19',
  },
  dsh: {
    profile: {
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-context'],
    },
  },
};

function seed() {
  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.mkdirSync(path.join(fakeHome, 'profiles', 'node_modules', '@deepseek-ai'), { recursive: true });
  fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true });
  fs.writeFileSync(profileJson, `${JSON.stringify(ORIGINAL_PROFILE, null, 2)}\n`, 'utf8');

  fs.rmSync(fakePkg, { recursive: true, force: true });
  fs.mkdirSync(path.join(fakePkg, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(fakePkg, 'cordis.patch.yml'), `- insert:\n    - id: dsh-memory-portrait\n      name: '${PKG_NAME}'\n`, 'utf8');
  fs.writeFileSync(path.join(fakePkg, 'package.json'), `${JSON.stringify({ name: PKG_NAME, version: '0.1.0' })}\n`, 'utf8');
  fs.writeFileSync(path.join(fakePkg, 'lib', 'index.js'), 'export function apply() {}\n', 'utf8');
}

/**
 * pwsh 的管道输出编码跟着控制台代码页走：中文 Windows（CP936）上它吐 GBK 字节，
 * 英文环境/强制 UTF-8 的机器上则是 UTF-8。先按 UTF-8 解，出现替换符再按 GBK 重解，
 * 断言在两种机器上都成立。
 */
function decodeConsole(buffer) {
  const utf8 = Buffer.from(buffer).toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(buffer);
  } catch {
    return utf8;
  }
}

/**
 * 优先 PowerShell 7（pwsh）；stock Windows 只有 5.1 时回退 powershell.exe。
 *
 * 装了两代的机器上，默认只会跑到 pwsh 7，5.1 就永远没被这套用例覆盖过
 * （脚本里的语法 / cmdlet 差异要等用户装不上才发现）。
 * 显式指定 DSH_MEMORY_TEST_PS=powershell 可以强制跑 5.1 做一次兼容性验证。
 */
const PS_BIN = (() => {
  const forced = String(process.env.DSH_MEMORY_TEST_PS || '').trim();
  if (forced) return forced;
  /* 布尔开关，方便在装了两代的 Windows 上明确跑一遍 5.1（不必拼解释器路径）。 */
  if (process.env.DSH_MEMORY_TEST_PS51) return 'powershell';
  const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
    encoding: 'utf8',
  });
  return probe.status === 0 ? 'pwsh' : 'powershell';
})();

/**
 * 统一的 PowerShell 命令行。同步 / 异步两个入口必须共用：
 * 早先 runScriptAsync 自己拼了一份 argv，5.1 的 -ExecutionPolicy Bypass 只加到同步版，
 * 于是 6 个 -FromNpm / -FromUrl 用例在 5.1 上全被 ExecutionPolicy 拦在脚本外面。
 */
function psCommand(script, args) {
  const psArgs = ['-NoProfile', '-NonInteractive'];
  /*
   * Windows PowerShell 5.1 的 ExecutionPolicy 常是 Restricted / RemoteSigned，
   * `-File` 会在脚本执行前就被 AuthorizationManager 拦掉（报 UnauthorizedAccess），
   * 跟脚本内容无关。测试跑的是自己造的临时脚本，显式 Bypass 才能真的验到 5.1 的语法与 cmdlet。
   */
  if (PS_BIN !== 'pwsh') psArgs.push('-ExecutionPolicy', 'Bypass');
  psArgs.push('-File', path.join(pkgRoot, script), ...args);
  return psArgs;
}

/** 跑脚本；返回 { status, stdout, stderr }。 */
function runScript(script, args) {
  const result = spawnSync(PS_BIN, psCommand(script, args), { encoding: 'buffer' });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout ? decodeConsole(result.stdout) : '',
    stderr: result.stderr ? decodeConsole(result.stderr) : '',
  };
}

const install = (extra = []) => runScript('install.ps1', ['-Profile', 'desktop', '-DshHome', fakeHome, '-PackageRoot', fakePkg, ...extra]);
const uninstall = (extra = []) => runScript('uninstall.ps1', ['-Profile', 'desktop', '-DshHome', fakeHome, ...extra]);

const readProfile = () => JSON.parse(fs.readFileSync(profileJson, 'utf8'));
const backups = () => fs.readdirSync(profileDir).filter((name) => name.startsWith('package.json.bak-')).sort();

/** junction 在 Node 里是 symlink；readlink 会带回 \\?\ 前缀。 */
function linkTarget(target) {
  const raw = fs.readlinkSync(target);
  return raw.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '');
}

const shimPath = path.join(fakePkg, 'node_modules', '@deepseek-ai');
/* 真包名：依赖键 / bundles 项 / cordis 行名 / 客户端模块 id 都是它（0.3.2 起）。 */
const PKG_NAME = '@bangbang-03/dsh-memory';
/* 0.3.2 之前的老别名，装过的话要能被安装脚本迁移掉。 */
const LEGACY_NAME = 'dsh-memory';
const profileLink = path.join(profileDir, 'node_modules', '@bangbang-03', 'dsh-memory');
const legacyLink = path.join(profileDir, 'node_modules', LEGACY_NAME);
const sharedModules = path.join(fakeHome, 'profiles', 'node_modules', '@deepseek-ai');
/* 记忆数据目录名不跟包名走（lib/store.js 里写死 dsh-memory）。 */
const storageDir = path.join(fakeHome, 'storages', 'dsh-memory');

/* ------------------------------------------------------------------ *
 * 测试
 * ------------------------------------------------------------------ */

console.log('dsh-memory install / uninstall');

await test('install.ps1 的 param() 默认值不依赖 $PSScriptRoot（PowerShell 5.1 里它为空串）', () => {
  /*
   * 5.1 在求参数默认值时还没给 $PSScriptRoot 赋值：远程模式不传 -PackageRoot，
   * 于是第一句 Resolve-Path -LiteralPath '' 就抛参数绑定错误，安装直接失败。
   * 默认值改在脚本正文里兜底；这条静态断言保证以后不会被「顺手挪回参数表」。
   */
  const script = fs.readFileSync(path.join(pkgRoot, 'install.ps1'), 'utf8');
  const block = /param\(([\s\S]*?)\n\)/.exec(script)?.[1] || '';
  assert.equal(/\$PSScriptRoot/.test(block), false, '参数默认值里不能引用 $PSScriptRoot');
  assert.match(script, /if \(-not \$PackageRoot\) \{ \$PackageRoot = \$PSScriptRoot \}/);
});

await test('install.ps1 把包挂进 bundles、dependencies 与 junction，并先备份', () => {
  seed();
  const before = fs.readFileSync(profileJson, 'utf8');
  const result = install();
  assert.equal(result.status, 0, `install.ps1 退出码 ${result.status}\n${result.stdout}\n${result.stderr}`);

  const profile = readProfile();
  assert.deepEqual(
    profile.dsh.profile.bundles,
    [...ORIGINAL_PROFILE.dsh.profile.bundles, PKG_NAME],
    'bundles 没有正确追加（应追加到末尾，且保留原有顺序）',
  );
  assert.equal(profile.dependencies[PKG_NAME], `link:${fakePkg.replace(/\\/g, '/')}`);
  assert.equal(profile.dependencies['dsh-context'], '0.66.1', '原有依赖被改动了');
  assert.equal(profile.name, 'dsh-profile-desktop', '原有字段丢失');

  const bak = backups();
  assert.equal(bak.length, 1, `应恰好一个备份，实际 ${bak.length}`);
  assert.equal(fs.readFileSync(path.join(profileDir, bak[0]), 'utf8'), before, '备份内容与改动前不一致');

  assert.ok(fs.lstatSync(shimPath).isSymbolicLink(), '包内垫片没建');
  assert.equal(linkTarget(shimPath), sharedModules);
  assert.ok(fs.lstatSync(profileLink).isSymbolicLink(), 'profile junction 没建');
  assert.equal(linkTarget(profileLink), fakePkg);
});

await test('install.ps1 是幂等的：再跑一次不重复追加、不再备份', () => {
  const before = fs.readFileSync(profileJson, 'utf8');
  const result = install();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(profileJson, 'utf8'), before, '第二次运行改动了 package.json');
  assert.equal(backups().length, 1, '第二次运行又备份了一次');
  assert.match(result.stdout, /已经是目标状态/);
});

await test('install.ps1 -DryRun 不落盘', () => {
  seed();
  const before = fs.readFileSync(profileJson, 'utf8');
  const result = install(['-DryRun']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(profileJson, 'utf8'), before, 'dry run 改了 package.json');
  assert.equal(backups().length, 0, 'dry run 产生了备份');
  assert.equal(fs.existsSync(shimPath), false, 'dry run 建了垫片');
  assert.equal(fs.existsSync(profileLink), false, 'dry run 建了 junction');
});

await test('install.ps1 迁移 0.3.2 之前的老别名安装（清条目 + 摘 junction）', () => {
  seed();
  /* 手工搭出老装法：依赖键 / bundles 项 / junction 名全是别名 dsh-memory。 */
  const legacyProfile = JSON.parse(fs.readFileSync(profileJson, 'utf8'));
  legacyProfile.dependencies[LEGACY_NAME] = `link:${fakePkg.replace(/\\/g, '/')}`;
  legacyProfile.dsh.profile.bundles = [...legacyProfile.dsh.profile.bundles, LEGACY_NAME];
  fs.writeFileSync(profileJson, `${JSON.stringify(legacyProfile, null, 2)}\n`, 'utf8');
  fs.symlinkSync(fakePkg, legacyLink, 'junction');

  const result = install();
  assert.equal(result.status, 0, `退出码 ${result.status}\n${result.stdout}\n${result.stderr}`);

  const profile = readProfile();
  assert.equal(LEGACY_NAME in profile.dependencies, false, '旧别名依赖没清掉');
  assert.equal(profile.dsh.profile.bundles.includes(LEGACY_NAME), false, '旧别名 bundles 项没清掉');
  assert.equal(
    profile.dsh.profile.bundles.filter((n) => n === PKG_NAME).length,
    1,
    '真包名应恰好一条（别名胜下一条会双份加载）',
  );
  assert.equal(profile.dependencies[PKG_NAME], `link:${fakePkg.replace(/\\/g, '/')}`);
  assert.equal(fs.existsSync(legacyLink), false, '旧别名 junction 没摘掉');
  assert.ok(fs.lstatSync(profileLink).isSymbolicLink(), '新的正经 junction 没建');
});

await test('install.ps1 抵赖：包根不对就报错退出', () => {
  seed();
  fs.rmSync(path.join(fakePkg, 'cordis.patch.yml'));
  const result = install();
  assert.notEqual(result.status, 0, '缺 cordis.patch.yml 时竟然成功了');
  assert.match(`${result.stdout}${result.stderr}`, /不是 dsh-memory 包根目录/);
});

await test('install.ps1 抵赖：profile 目录不存在就报错退出', () => {
  seed();
  const result = runScript('install.ps1', ['-Profile', 'nope', '-DshHome', fakeHome, '-PackageRoot', fakePkg]);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /找不到 profile/);
});

await test('uninstall.ps1 还原 bundles / dependencies，删掉 junction，但保留记忆数据', () => {
  seed();
  assert.equal(install().status, 0);
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(path.join(storageDir, 'settings.json'), '{"briefingLimit":12}\n', 'utf8');

  const result = uninstall();
  assert.equal(result.status, 0, `uninstall.ps1 退出码 ${result.status}\n${result.stdout}\n${result.stderr}`);

  const profile = readProfile();
  assert.deepEqual(profile.dsh.profile.bundles, ORIGINAL_PROFILE.dsh.profile.bundles);
  assert.equal(PKG_NAME in profile.dependencies, false);
  assert.equal(profile.dependencies['dsh-cost-meter'], '1.8.19', '原依赖被误删');
  assert.equal(fs.existsSync(profileLink), false, 'profile junction 没删掉');
  assert.ok(fs.existsSync(shimPath), '垫片被删了（应该保留）');
  assert.ok(fs.existsSync(path.join(storageDir, 'settings.json')), '记忆数据被误删');
  assert.equal(backups().length, 2, '卸载前应再备份一次');
});

await test('uninstall.ps1 -PurgeStorage 才删记忆数据', () => {
  seed();
  assert.equal(install().status, 0);
  fs.mkdirSync(storageDir, { recursive: true });
  assert.equal(uninstall(['-PurgeStorage']).status, 0);
  assert.equal(fs.existsSync(storageDir), false, '-PurgeStorage 没有删掉数据目录');
  assert.ok(fs.existsSync(fakePkg), '包目录被误删');
  assert.ok(fs.existsSync(path.join(fakePkg, 'lib', 'index.js')), '包内容被误删');
});

await test('uninstall.ps1 抵赖：junction 位置是真实目录时拒绝删除', () => {
  seed();
  assert.equal(install().status, 0);
  fs.rmSync(profileLink);
  fs.mkdirSync(profileLink);
  fs.writeFileSync(path.join(profileLink, 'important.txt'), 'do not delete\n', 'utf8');

  const result = uninstall();
  assert.notEqual(result.status, 0, '真实目录竟然被删了');
  assert.ok(fs.existsSync(path.join(profileLink, 'important.txt')), '真实目录内容被删了');
});

await test('uninstall.ps1 在没装过的 profile 上是无害的空操作', () => {
  seed();
  const before = fs.readFileSync(profileJson, 'utf8');
  const result = uninstall();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(profileJson, 'utf8'), before, '空操作也改了 package.json');
  assert.equal(backups().length, 0, '空操作产生备份');
  assert.match(result.stdout, /没有 @bangbang-03\/dsh-memory/);
});

/* ------------------------------------------------------------------ *
 * v0.3.1：-FromNpm 远程拉取（对着本机假 registry 真跑 HTTP 流程）
 * ------------------------------------------------------------------ */

import http from 'node:http';

/** 造一个 npm 形状的包 tarball（顶层 package/ 目录，同 npm pack 产物）。 */
function buildTgz(version, dest) {
  const src = path.join(tmp, `npm-fixture-${version}`);
  fs.rmSync(src, { recursive: true, force: true });
  fs.mkdirSync(path.join(src, 'package', 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(src, 'package', 'package.json'),
    `${JSON.stringify({ name: '@bangbang-03/dsh-memory', version, type: 'module' })}\n`,
  );
  fs.writeFileSync(path.join(src, 'package', 'cordis.patch.yml'), `- insert:\n    - id: dsh-memory-portrait\n      name: '${PKG_NAME}'\n`);
  fs.writeFileSync(path.join(src, 'package', 'lib', 'index.js'), 'export function apply() {}\n');
  fs.writeFileSync(path.join(src, 'package', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  /* GNU tar 会把 "C:\xxx" 当成远程主机，所以用相对文件名 + cwd。 */
  const out = spawnSync('tar', ['-czf', path.basename(dest), '-C', src, 'package'], { cwd: path.dirname(dest) });
  if (out.status !== 0) throw new Error(`tar 失败: ${out.stderr}`);
}

const tgzByVersion = {};
for (const v of ['0.3.1', '0.3.2']) {
  const dest = path.join(tmp, `dsh-memory-${v}.tgz`);
  buildTgz(v, dest);
  tgzByVersion[v] = fs.readFileSync(dest);
}

/** 假 npm registry：/ 包元数据 + /tarball 下载；记录收到的 Authorization 头。 */
async function startFakeRegistry() {
  const state = { latest: '0.3.1' };
  const received = [];
  const server = http.createServer((req, res) => {
    received.push({ url: req.url, auth: req.headers.authorization || '' });
    if (req.url.toLowerCase() === '/%40bangbang-03%2fdsh-memory') {
      const v = state.latest;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          name: '@bangbang-03/dsh-memory',
          'dist-tags': { latest: v },
          versions: {
            [v]: {
              name: '@bangbang-03/dsh-memory',
              version: v,
              dist: { tarball: `http://127.0.0.1:${server.address().port}/dsh-memory-${v}.tgz` },
            },
          },
        }),
      );
      return;
    }
    const tgzMatch = /^\/dsh-memory-(\d+\.\d+\.\d+)\.tgz$/.exec(req.url);
    if (tgzMatch && tgzByVersion[tgzMatch[1]]) {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(tgzByVersion[tgzMatch[1]]);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, state, received };
}

const { server: fakeRegistry, state: registryState, received: registryReceived } = await startFakeRegistry();
const registryBase = `http://127.0.0.1:${fakeRegistry.address().port}`;

const remoteHome = path.join(tmp, 'dshhome-remote');
const remoteProfileDir = path.join(remoteHome, 'profiles', 'desktop');
const remoteProfileJson = path.join(remoteProfileDir, 'package.json');
const remotePluginsDir = path.join(remoteHome, 'plugins', 'dsh-memory');
const remoteProfileLink = path.join(remoteProfileDir, 'node_modules', '@bangbang-03', 'dsh-memory');

/**
 * 异步版 runScript：-FromNpm 的用例必须用它——spawnSync 会阻塞 node 事件循环，
 * 假 registry 就没法应答 pwsh 的请求，直接死锁。
 */
function runScriptAsync(script, args) {
  return new Promise((resolve) => {
    const child = spawn(PS_BIN, psCommand(script, args), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = { stdout: [], stderr: [] };
    child.stdout.on('data', (chunk) => chunks.stdout.push(chunk));
    child.stderr.on('data', (chunk) => chunks.stderr.push(chunk));
    child.on('error', (err) => resolve({ status: -1, stdout: '', stderr: String(err) }));
    child.on('close', (status) =>
      resolve({
        status,
        stdout: chunks.stdout.length ? decodeConsole(Buffer.concat(chunks.stdout)) : '',
        stderr: chunks.stderr.length ? decodeConsole(Buffer.concat(chunks.stderr)) : '',
      }),
    );
  });
}

function seedRemoteProfile() {
  fs.rmSync(remoteHome, { recursive: true, force: true });
  fs.mkdirSync(path.join(remoteHome, 'profiles', 'node_modules', '@deepseek-ai'), { recursive: true });
  fs.mkdirSync(path.join(remoteProfileDir, 'node_modules'), { recursive: true });
  fs.writeFileSync(remoteProfileJson, `${JSON.stringify(ORIGINAL_PROFILE, null, 2)}\n`, 'utf8');
}

const remoteInstall = async (extra = []) =>
  runScriptAsync('install.ps1', [
    '-Profile', 'desktop',
    '-DshHome', remoteHome,
    '-FromNpm', '@bangbang-03/dsh-memory',
    '-Registry', registryBase,
    ...extra,
  ]);

await test('-FromNpm：从 registry 拉 latest 并装进 profile（解包 / 垫片 / package.json / junction）', async () => {
  seedRemoteProfile();
  const result = await remoteInstall();
  assert.equal(result.status, 0, `退出码 ${result.status}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /0\.3\.1/, '应打印拉到的版本');

  const installed = JSON.parse(fs.readFileSync(path.join(remotePluginsDir, 'package.json'), 'utf8'));
  assert.equal(installed.version, '0.3.1', 'tarball 应解到 plugins/dsh-memory');
  assert.ok(fs.existsSync(path.join(remotePluginsDir, 'cordis.patch.yml')), '包内容应完整');

  const profile = JSON.parse(fs.readFileSync(remoteProfileJson, 'utf8'));
  assert.ok(profile.dsh.profile.bundles.includes(PKG_NAME), 'bundles 应追加');
  assert.match(profile.dependencies[PKG_NAME], /^link:/, '依赖应指向 plugins 解包目录');

  const link = linkTarget(remoteProfileLink);
  assert.equal(path.resolve(link), path.resolve(remotePluginsDir), 'junction 应指向 plugins 解包目录');

  const shim = path.resolve(linkTarget(path.join(remotePluginsDir, 'node_modules', '@deepseek-ai')));
  assert.equal(shim, path.resolve(remoteHome, 'profiles', 'node_modules', '@deepseek-ai'), '垫片应指向共享模块');
});

await test('-FromNpm：registry 出新版后重跑同一条命令即完成更新', async () => {
  registryState.latest = '0.3.2';
  const result = await remoteInstall();
  assert.equal(result.status, 0, result.stderr);
  const installed = JSON.parse(fs.readFileSync(path.join(remotePluginsDir, 'package.json'), 'utf8'));
  assert.equal(installed.version, '0.3.2', '应整体替换成 0.3.2');
  assert.equal(
    path.resolve(linkTarget(remoteProfileLink)),
    path.resolve(remotePluginsDir),
    'junction 仍指向同一目录（DSH 侧无需任何动作）',
  );
  assert.ok(fs.existsSync(path.join(remotePluginsDir, 'cordis.patch.yml')), '更新后包内容完整');
});

await test('-FromNpm -DryRun：不联网、不落盘', async () => {
  seedRemoteProfile();
  const requestsBefore = registryReceived.length;
  const result = await remoteInstall(['-DryRun']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(remotePluginsDir), false, '不该建 plugins 目录');
  assert.match(result.stdout, /没有联网/);
  assert.equal(registryReceived.length, requestsBefore, 'dry run 不该发任何请求');
});

await test('-FromNpm：-NpmToken 以 Bearer 头带上（GitHub Packages 场景）', async () => {
  seedRemoteProfile();
  const before = registryReceived.length;
  const result = await remoteInstall(['-NpmToken', 'test-token-abc']);
  assert.equal(result.status, 0, result.stderr);
  const sent = registryReceived.slice(before);
  assert.ok(sent.length >= 2, '元数据与 tarball 两次请求');
  assert.ok(
    sent.every((r) => r.auth === 'Bearer test-token-abc'),
    `实际头：${sent.map((r) => r.auth || '(无)').join(' | ')}`,
  );
});

await test('-FromUrl：直接下 tarball（Release 资产场景，不走 registry 协议）', async () => {
  seedRemoteProfile();
  const url = `${registryBase}/dsh-memory-0.3.2.tgz`;
  const before = registryReceived.length;
  const result = await runScriptAsync('install.ps1', [
    '-Profile', 'desktop',
    '-DshHome', remoteHome,
    '-FromUrl', url,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const installed = JSON.parse(fs.readFileSync(path.join(remotePluginsDir, 'package.json'), 'utf8'));
  assert.equal(installed.version, '0.3.2', '应装上 tarball 里的版本');
  assert.equal(
    path.resolve(linkTarget(remoteProfileLink)),
    path.resolve(remotePluginsDir),
    'junction 指向解包目录',
  );
  // 只有一次 tarball 请求：-FromUrl 不该去查 registry 元数据。
  const metas = registryReceived.slice(before).filter((r) => r.url.toLowerCase().includes('%40'));
  assert.equal(metas.length, 0, 'FromUrl 不该发元数据请求');
});

await test('-FromNpm：registry 没有该包时明确报错退出', async () => {
  seedRemoteProfile();
  const result = await runScriptAsync('install.ps1', [
    '-Profile', 'desktop',
    '-DshHome', remoteHome,
    '-FromNpm', '@bangbang-03/nope',
    '-Registry', registryBase,
  ]);
  assert.notEqual(result.status, 0, '应该失败退出');
  assert.match(result.stdout + result.stderr, /404/, '错误信息应带上 404');
});

/* ------------------------------------------------------------------ */

/* 不关掉假 registry，node 会因监听句柄挂着不退（run-all 会一直等子进程）。 */
fakeRegistry.closeAllConnections?.();
await new Promise((resolve) => fakeRegistry.close(resolve));

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
