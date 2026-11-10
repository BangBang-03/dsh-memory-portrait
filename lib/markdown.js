/**
 * 既有记忆的读取层：把别的工具（以及本插件自己的镜像）写下的 Markdown
 * 变成 dsh-memory 能落库的记录。
 *
 * 纯函数 + node 内置模块，不依赖 DSH，可以单独测试。
 *
 * 支持的形态（都来自实际拆机结果，不是猜的）：
 *   - WorkBuddy 工作区笔记  `<工作区>/.workbuddy/memory/MEMORY.md`
 *       `# 标题` + 若干 `## 主题` + 主题下的 `- 要点`
 *   - WorkBuddy 每日日志    `<工作区>/.workbuddy/memory/YYYY-MM-DD.md`
 *       `# 2026-10-10` + 若干 `## 事件`
 *   - Qoder 记忆            `~/.qoder/memory/<name>.md`
 *       YAML frontmatter（`name` / `description` / `metadata.type`）+ 正文
 *   - 纯文本                空行分段，首行当标题
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const IMPORT_FORMATS = ['auto', 'workbuddy', 'qoder', 'daily', 'text'];

export const FORMAT_LABELS = {
  auto: '自动识别',
  workbuddy: 'WorkBuddy 笔记',
  qoder: 'Qoder 记忆',
  daily: '每日日志',
  text: '纯文本',
};

const MAX_RECORDS = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
/** 正文里的 `#标签`（`##` 标题不会命中，因为 `#` 不在字符集里）。 */
const TAG_RE = /(?:^|[\s(（])#([0-9A-Za-z_\u4e00-\u9fff-]{2,24})/g;

function asText(value) {
  /* Windows 编辑器常带 BOM；不剥掉会让 frontmatter / 日期 H1 识别全部失手。 */
  return typeof value === 'string' ? value.replace(/^\uFEFF/, '') : '';
}

function isDateHeading(heading) {
  return DATE_RE.test(asText(heading).trim());
}

function collectInlineTags(...texts) {
  const found = [];
  for (const text of texts) {
    if (!text) continue;
    TAG_RE.lastIndex = 0;
    let match;
    while ((match = TAG_RE.exec(text)) !== null) found.push(match[1]);
  }
  return found;
}

function firstMeaningfulLine(lines) {
  for (const line of lines) {
    const clean = String(line || '')
      .replace(/^[\s>#*+-]+/, '')
      .trim();
    if (clean) return clean;
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * 识别
 * ------------------------------------------------------------------ */

/** 猜一段文本是哪种记忆格式。 */
export function detectFormat(text) {
  const src = asText(text);
  if (!src.trim()) return 'text';
  if (/^---\s*\r?\n[\s\S]*?\bname\s*:/.test(src)) return 'qoder';
  const heading = /^(#{1,2})\s+(.+?)\s*$/m.exec(src);
  /* 连标题都没有的才算自由文本——有标题就按「一篇笔记 = 几条记忆」来切。 */
  if (!heading) return 'text';
  return isDateHeading(heading[2]) ? 'daily' : 'workbuddy';
}

/* ------------------------------------------------------------------ *
 * Qoder：YAML frontmatter
 * ------------------------------------------------------------------ */

/** 极简 frontmatter 解析：只认顶层 `key: value` 与一层 `metadata:` 缩进。 */
export function parseFrontmatter(block) {
  const out = {};
  let nested = null;
  for (const rawLine of asText(block).split(/\r?\n/)) {
    if (!rawLine.trim() || /^\s*#/.test(rawLine)) continue;
    const indented = /^\s+\S/.test(rawLine);
    const match = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(rawLine);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim().replace(/^["']|["']$/g, '');
    if (indented && nested) {
      out[`${nested}.${key}`] = value;
      continue;
    }
    nested = value ? null : key;
    out[key] = value;
  }
  return out;
}

const QODER_CATEGORY = {
  /* v0.3.0 起原生支持 user / feedback 类别，Qoder 的同名 type 直接直通。 */
  user: 'user',
  feedback: 'feedback',
  preference: 'preference',
  reference: 'fact',
  fact: 'fact',
  project: 'component',
  decision: 'decision',
  convention: 'convention',
};

/** 把 `<name>.md` 里的 frontmatter + 正文切成记录。 */
function parseQoderDocument(fileName, text) {
  const src = asText(text);
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/.exec(src);
  if (!match) {
    const body = src.trim();
    if (!body) return [];
    return [
      {
        title: firstMeaningfulLine(body.split(/\r?\n/)) || fileName,
        content: body,
        category: 'note',
        tags: ['qoder'],
      },
    ];
  }
  const meta = parseFrontmatter(match[1]);
  const body = src.slice(match[0].length).trim();
  const name = asText(meta.name).trim();
  const description = asText(meta.description).trim();
  const type = asText(meta.type || meta['metadata.type']).trim();
  const slug = (name || path.basename(fileName, '.md')).replace(/\.md$/i, '');
  const tags = ['qoder'];
  if (type) tags.push(type);
  if (slug && slug !== description) tags.push(slug);
  return [
    {
      title: description || slug || firstMeaningfulLine(body.split(/\r?\n/)) || fileName,
      content: body,
      category: QODER_CATEGORY[type] || 'note',
      tags,
    },
  ];
}

/* ------------------------------------------------------------------ *
 * 标题分节（WorkBuddy 笔记 / 每日日志）
 * ------------------------------------------------------------------ */

/**
 * 一个小节里若用 `**粗体**` 独行当子标题（WorkBuddy 的用户画像就是这样），
 * 就按它再切一层；只有 0~1 个粗体行时保持原样，免得把正文里的强调当标题。
 */
function splitBoldBlocks(section) {
  const lines = section.body;
  const marks = [];
  let inFence = false;
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const match = /^\*\*([^*]{1,60})\*\*\s*$/.exec(line);
    if (match) marks.push({ index, title: match[1].trim() });
  });
  if (marks.length < 2) return [section];

  const out = [];
  const head = lines.slice(0, marks[0].index);
  if (head.join('').trim()) out.push({ title: section.title, body: head });
  marks.forEach((mark, position) => {
    const end = position + 1 < marks.length ? marks[position + 1].index : lines.length;
    out.push({ title: mark.title, body: lines.slice(mark.index + 1, end) });
  });
  return out;
}

function parseSectioned(text, { format }) {
  const lines = asText(text).split(/\r?\n/);
  const sections = [];
  const preamble = [];
  let docTitle = '';
  let current = null;
  let inFence = false;

  for (const line of lines) {
    /* 代码围栏里的 # / ## 是注释或代码，不是标题；整段原样保留到当前小节。 */
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      if (current) current.body.push(line);
      else preamble.push(line);
      continue;
    }
    if (inFence) {
      if (current) current.body.push(line);
      else preamble.push(line);
      continue;
    }
    const h1 = /^#\s+(.+?)\s*$/.exec(line);
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h1) {
      if (current) sections.push(current);
      current = null;
      docTitle = h1[1].trim();
      continue;
    }
    if (h2) {
      if (current) sections.push(current);
      current = { title: h2[1].trim(), body: [] };
      continue;
    }
    if (current) current.body.push(line);
    else preamble.push(line);
  }
  if (current) sections.push(current);

  /* 没有二级标题：整篇当一条，用 H1（或首行）当标题、正文取前言。 */
  const raw = sections.length ? sections : [{ title: docTitle, body: preamble }];
  /* 有些文件（WorkBuddy 的用户画像）用 **粗体** 当小节标题，再往下切一层。 */
  const blocks = raw.flatMap((section) => splitBoldBlocks(section));
  const dateTag = isDateHeading(docTitle) ? docTitle.trim().slice(0, 10) : '';
  const baseTags = [format === 'daily' ? 'log' : 'workbuddy'];
  if (dateTag) baseTags.push(dateTag);

  const records = [];
  for (const block of blocks) {
    const content = block.body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    /* 只有标题没有正文的小节按结构噪声丢掉，不生成空记忆。 */
    if (!content) continue;
    const title = block.title || firstMeaningfulLine(block.body);
    const tags = [...baseTags, ...collectInlineTags(block.title, content)];
    records.push({
      title: title || '未命名记忆',
      content,
      category: 'note',
      tags,
    });
  }
  return records;
}

/* ------------------------------------------------------------------ *
 * 纯文本
 * ------------------------------------------------------------------ */

function parsePlain(text) {
  return asText(text)
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const [first, ...rest] = block.split(/\r?\n/);
      const clean = first.replace(/^[-*#>\s]+/, '').trim();
      return {
        title: (clean || first.trim() || '未命名记忆').slice(0, 160),
        content: rest.length ? block : clean,
        category: 'note',
        tags: collectInlineTags(block),
      };
    });
}

/* ------------------------------------------------------------------ *
 * 对外入口
 * ------------------------------------------------------------------ */

/**
 * 解析一段文本。
 * @returns {{format: string, records: Array<object>}}
 */
export function parseMemoryText(text, { format = 'auto', maxRecords = MAX_RECORDS } = {}) {
  const src = asText(text);
  const resolved = IMPORT_FORMATS.includes(format) && format !== 'auto' ? format : detectFormat(src);
  let records;
  if (resolved === 'qoder') records = parseQoderDocument('', src);
  else if (resolved === 'workbuddy' || resolved === 'daily') records = parseSectioned(src, { format: resolved });
  else records = parsePlain(src);

  const cleaned = records
    .map((record) => ({
      title: String(record.title || '').trim().slice(0, 160) || '未命名记忆',
      content: String(record.content || '').trim(),
      category: record.category || 'note',
      tags: [...new Set((record.tags || []).map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 12),
      source: 'import',
    }))
    .filter((record) => record.content || record.title !== '未命名记忆')
    .slice(0, Math.max(1, maxRecords));

  return { format: resolved, records: cleaned };
}

/** 从磁盘路径读一个文件并解析（Qoder 的记忆用文件名兜底标题）。 */
export function parseMemoryFile(file, { format = 'auto', maxRecords = MAX_RECORDS } = {}) {
  const text = fs.readFileSync(file, 'utf8');
  const resolved = IMPORT_FORMATS.includes(format) && format !== 'auto' ? format : detectFormat(text);
  if (resolved === 'qoder') {
    const records = parseQoderDocument(path.basename(file), text)
      .map((record) => ({
        title: String(record.title || '').trim().slice(0, 160) || path.basename(file, '.md'),
        content: String(record.content || '').trim(),
        category: record.category || 'note',
        tags: [...new Set((record.tags || []).map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 12),
        source: 'import',
      }))
      .filter((record) => record.content);
    return { format: resolved, records: records.slice(0, Math.max(1, maxRecords)) };
  }
  const parsed = parseMemoryText(text, { format: resolved, maxRecords });
  return { ...parsed, format: resolved };
}

/* ------------------------------------------------------------------ *
 * 扫描本机既有记忆
 * ------------------------------------------------------------------ */

/**
 * 已知的记忆落点。`scope` 决定导入后进工作区库还是全局库。
 * 前三个是竞品写的，最后一个是本插件自己的镜像（换机器/重装时用来回灌）。
 */
export function memorySourceSpecs({ workspace = '', home = os.homedir() } = {}) {
  const specs = [];
  if (workspace) {
    specs.push({
      id: 'workspace-workbuddy',
      label: 'WorkBuddy 工作区记忆',
      scope: 'workspace',
      dir: path.join(workspace, '.workbuddy', 'memory'),
    });
  }
  specs.push(
    {
      id: 'user-workbuddy',
      label: 'WorkBuddy 用户级记忆',
      scope: 'global',
      dir: path.join(home, '.workbuddy', 'memory'),
    },
    {
      id: 'user-qoder',
      label: 'Qoder 记忆',
      scope: 'global',
      dir: path.join(home, '.qoder', 'memory'),
      /* 该目录下 MEMORY.md 只是「标题 + 文件名」的索引页，真正的记忆是那些带 frontmatter 的文件。 */
      keep: (entry) => entry.format === 'qoder',
    },
    {
      id: 'user-claude',
      label: 'Claude Code 记忆（~/.claude/projects/*/memory）',
      scope: 'global',
      dir: path.join(home, '.claude', 'projects'),
      walk: true,
      /* projects/<slug>/ 下只有 memory/ 子目录是自动记忆，CLAUDE.md 是规则文件不算记忆。 */
      keep: (entry) => /[\\/]memory[\\/]/.test(entry.path) && !/[\\/]memory[\\/]MEMORY\.md$/i.test(entry.path),
    },
    {
      id: 'user-codex',
      label: 'Codex 记忆（~/.codex/memories）',
      scope: 'global',
      dir: path.join(home, '.codex', 'memories'),
    },
    {
      id: 'user-windsurf',
      label: 'Windsurf 记忆（~/.codeium/windsurf/memories）',
      scope: 'global',
      dir: path.join(home, '.codeium', 'windsurf', 'memories'),
      walk: true,
    },
  );
  if (workspace) {
    specs.push({
      id: 'dsh-memory-mirror',
      label: 'dsh-memory 工作区镜像',
      scope: 'workspace',
      dir: path.join(workspace, '.dsh-memory'),
    });
  }
  return specs;
}

function listMarkdownFiles(dir, { walk = false } = {}) {
  try {
    const top = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
      .map((entry) => path.join(dir, entry.name));
    if (!walk) return top.sort();
    /* 递归版：Claude Code 的记忆散在 projects/<slug>/memory/ 下，Windsurf 按工作区分目录。 */
    const out = [...top];
    const queue = [dir];
    let visited = 0;
    while (queue.length && visited < 64 && out.length < 200) {
      const current = queue.shift();
      visited += 1;
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const child = path.join(current, entry.name);
        queue.push(child);
        try {
          for (const name of fs.readdirSync(child)) {
            if (/\.md$/i.test(name)) out.push(path.join(child, name));
          }
        } catch {
          /* 无权限的目录跳过 */
        }
      }
    }
    return [...new Set(out)].sort();
  } catch {
    return [];
  }
}

/**
 * 扫描已知落点，回报「能导入什么」而不落库。
 * 每个文件给出格式、字节数与记录预览，供面板先展示再确认。
 */
export function scanMemorySources({ workspace = '', home = os.homedir(), maxPreview = 3 } = {}) {
  const sources = [];
  for (const spec of memorySourceSpecs({ workspace, home })) {
    const files = listMarkdownFiles(spec.dir, { walk: spec.walk === true });
    const entries = files.map((file) => {
      const name = path.basename(file);
      let bytes = 0;
      let format = 'text';
      let records = 0;
      const preview = [];
      let error = null;
      try {
        const stat = fs.statSync(file);
        bytes = stat.size;
        const parsed = parseMemoryFile(file, {});
        format = parsed.format;
        records = parsed.records.length;
        for (const record of parsed.records.slice(0, maxPreview)) preview.push(record.title);
      } catch (cause) {
        error = String(cause?.message || cause);
      }
      return { path: file, name, bytes, format, records, preview, error };
    });
    const kept = typeof spec.keep === 'function' ? entries.filter(spec.keep) : entries;
    sources.push({
      id: spec.id,
      label: spec.label,
      scope: spec.scope,
      dir: spec.dir,
      exists: fs.existsSync(spec.dir),
      files: kept,
    });
  }
  return { sources };
}

export default {
  IMPORT_FORMATS,
  FORMAT_LABELS,
  detectFormat,
  parseFrontmatter,
  parseMemoryText,
  parseMemoryFile,
  memorySourceSpecs,
  scanMemorySources,
};
