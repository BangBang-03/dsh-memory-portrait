/**
 * 兼容口径一致性检查（不联网 / 可选联网）。
 *
 *   node tools/check-compat.mjs          # 本地：package.json + README 兼容表
 *   node tools/check-compat.mjs --npm    # 再核对 npmjs 上已发布的同一版本清单
 *
 * 为什么要这个脚本：DSH 0.2.1 起按 `engines.dsh` 决定是否加载 bundle，不匹配会静默跳过
 * （skippedBundles）。同一份范围如果只改 package.json、不改 README，市场页会继续告诉用户
 * 一个错误的范围；npm 包如果和仓库不一致，安装入口之间又会各说各话。这里把三处钉在一起。
 *
 * 退出码：0 = 全部一致；1 = 有漂移或 npm 上查不到该版本。
 */
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 从 README 的「## 兼容性」段解析 DSH 范围与逐版本表。 */
export function parseReadmeCompat(readme) {
  const text = String(readme ?? '');
  const section = /##\s*兼容性[\s\S]*?(?=\n##\s|$)/u.exec(text)?.[0] ?? '';
  const rows = new Map();
  for (const match of section.matchAll(/^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|/gmu)) {
    const version = match[1].trim();
    const status = match[2].trim().split(/[（(\s]/u)[0];
    if (version) rows.set(version, status);
  }
  const range = /DSH\s*范围\s*`([^`]+)`/u.exec(section)?.[1]?.trim() ?? '';
  return { section, rows, range };
}

/** 本地一致性：package.json 内部两处、package.json 与 README 表格/范围。 */
export function checkLocal(manifest, readme) {
  const errors = [];
  const range = String(manifest?.engines?.dsh ?? '').trim();
  const compatRange = String(manifest?.dsh?.compatibility?.dsh ?? '').trim();
  const releases = manifest?.dsh?.compatibility?.dshReleases ?? {};

  if (!range) errors.push('package.json 缺 engines.dsh');
  if (range !== compatRange) {
    errors.push(`engines.dsh（${range || '空'}）与 dsh.compatibility.dsh（${compatRange || '空'}）不一致`);
  }

  const parsed = parseReadmeCompat(readme);
  if (!parsed.section) errors.push('README 找不到「## 兼容性」段');
  if (!parsed.range) errors.push('README 兼容性段找不到「DSH 范围 `...`」');
  else if (range && parsed.range !== range) {
    errors.push(`README 的 DSH 范围（${parsed.range}）与 engines.dsh（${range}）不一致`);
  }

  const expected = Object.keys(releases).sort();
  const actual = [...parsed.rows.keys()].sort();
  if (expected.join('\n') !== actual.join('\n')) {
    errors.push(`README 版本表（${actual.join(', ') || '空'}）与 dshReleases（${expected.join(', ') || '空'}）不一致`);
  }
  for (const [version, status] of parsed.rows) {
    if (releases[version] && releases[version] !== status) {
      errors.push(`README 把 ${version} 标成 ${status}，dshReleases 是 ${releases[version]}`);
    }
  }

  const marketplace = manifest?.dsh?.marketplace;
  if (!marketplace) {
    errors.push('package.json 缺 dsh.marketplace');
  } else {
    if (!Array.isArray(marketplace.profiles) || marketplace.profiles.length === 0) {
      errors.push('dsh.marketplace.profiles 必须是非空数组');
    }
    for (const key of ['requiresRestart', 'manualSteps']) {
      if (typeof marketplace[key] !== 'boolean') errors.push(`dsh.marketplace.${key} 必须是布尔值`);
    }
  }

  const permissions = manifest?.dsh?.permissions;
  if (!permissions) {
    errors.push('package.json 缺 dsh.permissions');
  } else {
    for (const key of ['level', 'files', 'network', 'commands', 'credentials', 'externalServices']) {
      if (!(key in permissions)) errors.push(`dsh.permissions 缺 ${key}`);
    }
  }

  return { errors, range, releases, readmeRows: parsed.rows };
}

/** 联网一致性：npmjs 上该版本的清单必须与本地同源。 */
export async function checkRegistry(manifest, { attempts = 15, delayMs = 4000 } = {}) {
  const errors = [];
  const name = String(manifest?.name ?? '');
  const version = String(manifest?.version ?? '');
  if (!name || !version) {
    return { errors: ['package.json 缺 name 或 version'], doc: null };
  }

  const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  let doc = null;
  let lastStatus = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      lastStatus = response.status;
      if (response.ok) {
        doc = await response.json();
        break;
      }
      if (response.status !== 404) break;
    } catch (error) {
      lastStatus = 0;
      if (attempt === attempts - 1) errors.push(`读取 npm 清单失败：${error.message}`);
    }
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  if (!doc) {
    errors.push(`npmjs 上找不到 ${name}@${version}（最后一次 HTTP ${lastStatus || '网络错误'}）`);
    return { errors, doc: null };
  }

  const range = String(manifest?.engines?.dsh ?? '').trim();
  if (String(doc.engines?.dsh ?? '').trim() !== range) {
    errors.push(`npm 的 engines.dsh（${doc.engines?.dsh ?? '空'}）与本地（${range}）不一致`);
  }
  if (String(doc.dsh?.compatibility?.dsh ?? '').trim() !== range) {
    errors.push(`npm 的 dsh.compatibility.dsh（${doc.dsh?.compatibility?.dsh ?? '空'}）与本地（${range}）不一致`);
  }

  const local = manifest?.dsh?.compatibility?.dshReleases ?? {};
  const remote = doc.dsh?.compatibility?.dshReleases ?? {};
  if (Object.keys(local).sort().join('\n') !== Object.keys(remote).sort().join('\n')) {
    errors.push(`npm 的 dshReleases 版本表（${Object.keys(remote).join(', ') || '空'}）与本地（${Object.keys(local).join(', ') || '空'}）不一致`);
  }
  for (const [key, value] of Object.entries(local)) {
    if (remote[key] && remote[key] !== value) {
      errors.push(`npm 把 ${key} 标成 ${remote[key]}，本地是 ${value}`);
    }
  }

  const localProfiles = [...(manifest?.dsh?.marketplace?.profiles ?? [])].sort();
  const remoteProfiles = [...(doc.dsh?.marketplace?.profiles ?? [])].sort();
  if (localProfiles.join(',') !== remoteProfiles.join(',')) {
    errors.push(`npm 的 marketplace.profiles（${remoteProfiles.join(', ') || '空'}）与本地（${localProfiles.join(', ') || '空'}）不一致`);
  }

  return { errors, doc };
}

async function main() {
  const manifest = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'));
  const readme = readFileSync(path.join(here, 'README.md'), 'utf8');
  const local = checkLocal(manifest, readme);
  const errors = [...local.errors];

  let registryDoc = null;
  if (process.argv.includes('--npm')) {
    const registry = await checkRegistry(manifest);
    errors.push(...registry.errors);
    registryDoc = registry.doc;
  }

  if (errors.length) {
    for (const error of errors) console.error('FAIL ' + error);
    process.exit(1);
  }

  const suffix = registryDoc ? `，npm ${manifest.version} 已核对` : '';
  console.log(
    `兼容口径通过：range=${local.range}，releases=${Object.keys(local.releases).length} 条，README 表=${local.readmeRows.size} 行${suffix}`,
  );
}

/**
 * 判断本模块是否被当作入口直接执行。
 * 不能用 `pathToFileURL(argv[1]) === import.meta.url`：工作区是 junction / symlink 时
 * Node 会把 import.meta.url 解析成真实路径，而 argv[1] 仍是链接路径，两者永不相等——
 * 脚本会「静默成功但什么都不检查」。两边都取 realpath 再比。
 */
function isEntryModule() {
  if (!process.argv[1]) return false;
  try {
    const entry = realpathSync(path.resolve(process.argv[1]));
    const self = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32'
      ? entry.toLowerCase() === self.toLowerCase()
      : entry === self;
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  await main();
}
