/**
 * dsh-memory — HTTP API（设置面板与自动化调用共用的唯一读写入口）。
 *
 * 与传输层解耦：本模块只接收已解析的 `{ method, pathname, query, body }`，
 * 返回 `{ status, body }`。因此可以脱离 node:http 直接测试
 * （见 test/api.test.mjs），宿主侧只负责把 req/res 适配进来。
 */

import { CATEGORIES, CATEGORY_LABELS, GLOBAL_KEY, workspaceKey, normalizeRoot } from './store.js';
import {
  IMPORT_FORMATS,
  FORMAT_LABELS,
  parseMemoryFile,
  parseMemoryText,
  scanMemorySources,
} from './markdown.js';
import {
  PORTRAIT_SECTIONS,
  renderPortraitInjection,
  diffPortraitSections,
  portraitChangeLine,
} from './portrait.js';
import { extractJson } from './distill.js';
import { distillCadence } from './distill-global.js';
import { scanSecrets, scanInjection } from './security.js';
import { createDreamRunner } from './dream.js';

const API_PREFIX = '/memory/api';

/** 允许的排序键。 */
const SORTS = ['updated', 'created', 'title'];

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const s = String(value).toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes') return true;
  if (s === '0' || s === 'false' || s === 'no') return false;
  return fallback;
}

function int(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function asStringArray(value, limit = 500) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((v) => String(v ?? '').trim()).filter(Boolean).slice(0, limit);
}

/** 统一响应外壳。 */
function ok(body) {
  return { status: 200, body: { ok: true, ...body } };
}

function fail(status, error, detail) {
  return { status, body: { ok: false, error, ...(detail ? { detail } : {}) } };
}

/**
 * 构造 API 处理器。
 *
 * @param deps.store             — createMemoryStore() 的返回值
 * @param deps.settings          — { get(): object, set(patch): object }
 * @param deps.activeWorkspace   — () => string，当前活动工作区路径
 * @param deps.listWorkspaces    — () => [{key, root, slug, active, sessionId, live}]
 * @param deps.captures          — () => 最近自动提炼日志
 * @param deps.briefingInfo      — () => 最近一次简报计量 {workspace, mode, chars, count, at}
 * @param deps.snapshotInfo      — 可选 (workspace) => {frozen, text, chars, count, sessionId}：已冻结的静态简报
 * @param deps.recallInfo        — 可选 (workspace) => {count, ids, titles, chars, text}：下一轮会尾部注入的召回
 * @param deps.version           — 插件版本号
 * @param deps.distillNow        — 可选 async ({workspace, text, title}) => 候选数组（设置页手动提炼）
 * @param deps.captureNow        — 可选 () => void，立即对当前会话触发一次提炼
 */
export function createApi(deps) {
  const {
    store,
    settings,
    activeWorkspace = () => '',
    listWorkspaces = () => [],
    workspaceForSession = () => '',
    activeSession = () => null,
    captures = () => [],
    briefingInfo = () => null,
    snapshotInfo = () => null,
    recallInfo = () => null,
    version = '0.0.0',
    distillNow,
    captureNow,
    rewriteNow = null,
    rewriteState = () => ({}),
    dreamNow = null,
    dreamInfo = () => ({}),
    approveDraft = () => ({ ok: false, error: 'unsupported' }),
  } = deps;

  /* 没有宿主注入的 dreamNow 时自己建一个：api 单测与嵌入式调用不必知道启动整理。 */
  const runDream =
    typeof dreamNow === 'function' ? dreamNow : createDreamRunner({ store, settings, rewriteNow }).run;

  /**
   * 解析目标工作区：显式传入 > 当前活动工作区。
   * 显式路径做白名单校验：必须是 listWorkspaces() 里出现过的、或等于当前活动
   * 工作区的路径——写镜像 / 晋升会往工作区目录落文件，越界路径必须明确 400
   * （invalid_workspace），静默回落会把数据写错地方还不报错。
   * Windows 文件系统大小写不敏感：normalizeRoot 只归一化盘符，比较时整个
   * 路径再 lower-case 一次，`c:\users\…` 与 `C:\Users\…` 视为同一工作区。
   */
  function sameRoot(a, b) {
    if (a === b) return true;
    return process.platform === 'win32' && a.toLowerCase() === b.toLowerCase();
  }

  function resolveWorkspace(query = {}, body = {}) {
    const explicit = body.workspace ?? query.workspace;
    if (typeof explicit === 'string' && explicit.trim()) {
      const root = normalizeRoot(explicit);
      const active = normalizeRoot(activeWorkspace() || '');
      const registered =
        sameRoot(root, active) ||
        listWorkspaces().some((item) => item && sameRoot(normalizeRoot(item.root || ''), root));
      if (!registered) {
        const error = new Error('invalid_workspace');
        error.code = 'INVALID_WORKSPACE';
        throw error;
      }
      return root;
    }
    return normalizeRoot(activeWorkspace() || '');
  }

  /**
   * 导入即入画像：导入落库后后台触发一次画像重写（WorkBuddy 式「导入 → 更新」）。
   * fire-and-forget——重写是一次 LLM 调用（可能几十秒），不阻塞导入响应、失败不影响导入结果；
   * 没有新增/替换（纯去重）不触发；body.feedPortrait === false 显式关闭。
   */
  function feedPortraitAfterImport(workspace, body, imported) {
    if (body.feedPortrait === false) return false;
    if (!imported || !(imported.added > 0 || imported.replaced > 0)) return false;
    if (typeof rewriteNow !== 'function') return false;
    Promise.resolve(rewriteNow({ workspace, scope: 'workspace' })).catch(() => {});
    return true;
  }

  function stateFor(workspace) {
    const briefing = briefingInfo() || null;
    return {
      version,
      api: API_PREFIX,
      workspace: { root: workspace, key: workspaceKey(workspace), ...store.workspaceInfo(workspace) },
      stats: store.stats({ workspace }),
      settings: settings.get(),
      categories: CATEGORIES.map((id) => ({ id, label: CATEGORY_LABELS[id] })),
      workspaces: listWorkspaces(),
      tags: store.tags({ workspace }).slice(0, 40),
      captures: captures(),
      mirror: store.mirrorInfo(workspace),
      briefing: briefing && briefing.workspace === workspace ? briefing : null,
      globalFolder: GLOBAL_KEY,
    };
  }

  const routes = {
    /** 页面首屏：版本、当前工作区、统计、设置、类别、工作区列表、标签、最近提炼。 */
    'GET /state'({ query }) {
      return ok(stateFor(resolveWorkspace(query)));
    },

    /** 面板「记忆概览」：只读聚合（计数 / 类别 / 近 7 天 / 全局画像覆盖），不拉明细。 */
    'GET /overview'({ query }) {
      const workspace = resolveWorkspace(query);
      const days = int(query.days, 7, 1, 30);
      return ok({ overview: store.overview({ workspace, days }) });
    },

    /** 记忆列表（支持查询/过滤/分页）。 */
    'GET /list'({ query }) {
      const workspace = resolveWorkspace(query);
      const result = store.list({
        workspace,
        query: String(query.q ?? query.query ?? ''),
        category: CATEGORIES.includes(query.category) ? query.category : '',
        scope: query.scope === 'global' || query.scope === 'workspace' ? query.scope : '',
        tag: String(query.tag ?? ''),
        includeGlobal: bool(query.global, true),
        includeArchived: bool(query.archived, false),
        sort: SORTS.includes(query.sort) ? query.sort : 'updated',
        limit: int(query.limit, 200, 1, 1000),
        offset: int(query.offset, 0, 0, 1e6),
      });
      return ok({ workspace: { root: workspace, key: workspaceKey(workspace) }, ...result });
    },

    /** 读单条（含归档，不含草稿）：画像依据下钻用。 */
    'GET /record'({ query }) {
      const workspace = resolveWorkspace(query);
      const id = String(query.id ?? '').trim();
      if (!id) return fail(400, 'missing_id');
      const record = store.get(id, { workspace });
      if (!record) return fail(404, 'not_found');
      return ok({ record });
    },

    /** 新建或更新一条记忆。带 id 即更新；带 supersedes 走版本链（旧条归档、可回滚）。 */
    'POST /save'({ body }) {
      const workspace = resolveWorkspace({}, body);
      const input = {
        id: body.id,
        title: body.title,
        content: body.content,
        category: body.category,
        tags: body.tags,
        keywords: body.keywords,
        related: body.related,
        supersedes: body.supersedes,
        scope: body.scope === 'global' ? 'global' : 'workspace',
        files: body.files,
        sessionId: body.sessionId,
        confidence: body.confidence,
      };
      if (input.id === undefined) input.source = body.source === 'auto' ? 'auto' : 'manual';
      if (body.pinned !== undefined) input.pinned = Boolean(body.pinned);
      if (body.archived !== undefined) input.archived = Boolean(body.archived);

      const hasContent = String(input.title ?? '').trim() || String(input.content ?? '').trim();
      if (!hasContent) return fail(400, 'empty_memory');

      let result;
      if (input.supersedes && !input.id) {
        const old = store.get(String(input.supersedes), { workspace });
        if (!old) return fail(404, 'supersede_target_not_found');
        result = store.supersede(old.id, input, { workspace });
      } else {
        result = store.upsert(input, { workspace, dedupe: bool(body.dedupe, false) });
      }
      return ok({
        record: result.record,
        mergedInto: Boolean(result.mergedInto),
        superseded: result.superseded ? { id: result.superseded.id, title: result.superseded.title } : null,
      });
    },

    /** 局部更新（置顶、归档、改类别、改正文、关联与关键词）。 */
    'POST /update'({ body }) {
      const workspace = resolveWorkspace({}, body);
      const id = String(body.id ?? '').trim();
      if (!id) return fail(400, 'missing_id');

      const patch = {};
      for (const key of [
        'title',
        'content',
        'category',
        'tags',
        'keywords',
        'related',
        'files',
        'scope',
        'pinned',
        'archived',
        'confidence',
      ]) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      if (patch.category !== undefined && !CATEGORIES.includes(patch.category)) patch.category = 'note';
      if (patch.scope !== undefined) patch.scope = patch.scope === 'global' ? 'global' : 'workspace';

      const result = store.update(id, patch, { workspace });
      if (!result.ok) return fail(404, 'not_found');
      return ok({ record: result.record });
    },

    /** 批量操作：delete | archive | unarchive | pin | unpin。 */
    'POST /bulk'({ body }) {
      const workspace = resolveWorkspace({}, body);
      const action = String(body.action ?? '');
      const ids = asStringArray(body.ids);
      if (!['delete', 'archive', 'unarchive', 'pin', 'unpin'].includes(action)) return fail(400, 'bad_action');
      if (!ids.length) return fail(400, 'missing_ids');
      const result = store.bulk(action, ids, { workspace });
      return ok({ affected: result.affected, stats: store.stats({ workspace }) });
    },

    /** 删除单条（面板上的一次点击，语义更直白）。 */
    'POST /delete'({ body }) {
      const workspace = resolveWorkspace({}, body);
      const id = String(body.id ?? '').trim();
      if (!id) return fail(400, 'missing_id');
      /* overrideRedline 只给面板的显式确认用；模型工具（memory forget）没有这条通道。 */
      const result = store.remove(id, { workspace, overrideRedline: body.overrideRedline === true });
      if (!result.ok) return fail(result.error === 'redline_protected' ? 403 : 404, result.error);
      return ok({ removed: result.removed.id, stats: store.stats({ workspace }) });
    },

    /* ---------------- 红线：改稿审计 / 历史 / 回滚 / 冲突检查 ---------------- */

    /** 新红线保存前的冲突检查：只读，不落库。 */
    'POST /redline/check'({ body }) {
      const workspace = resolveWorkspace({}, body);
      const result = store.redlineConflicts({
        workspace,
        title: body.title,
        content: body.content,
        excludeId: String(body.excludeId ?? '').trim(),
      });
      if (!result.ok) return fail(400, result.error || 'redline_check_failed');
      return ok({ conflicts: result.conflicts });
    },

    /** 红线改稿：必须由面板显式确认；旧措辞写进历史。 */
    'POST /redline/update'({ body }) {
      const workspace = resolveWorkspace({}, body);
      const id = String(body.id ?? '').trim();
      if (!id) return fail(400, 'missing_id');
      if (body.confirm !== true) return fail(400, 'confirmation_required');
      const result = store.updateRedline(id, { title: body.title, content: body.content }, { workspace });
      if (!result.ok) return fail(400, result.error || 'redline_update_failed');
      return ok({ record: result.record, unchanged: Boolean(result.unchanged) });
    },

    /** 红线历史：当前生效版本 + 旧版本列表。 */
    'GET /redline/history'({ query }) {
      const workspace = resolveWorkspace(query);
      const id = String(query.id ?? '').trim();
      if (!id) return fail(400, 'missing_id');
      const record = store.get(id, { workspace, includeDrafts: true });
      if (!record || record.category !== 'constraint') return fail(404, 'not_found');
      return ok({
        current: {
          id: record.id,
          title: record.title,
          content: record.content,
          updatedAt: record.updatedAt,
        },
        versions: record.redlineHistory || [],
      });
    },

    /** 红线回滚：同样要显式确认；当前版本先写回历史。 */
    'POST /redline/rollback'({ body }) {
      const workspace = resolveWorkspace({}, body);
      const id = String(body.id ?? '').trim();
      if (!id) return fail(400, 'missing_id');
      if (body.confirm !== true) return fail(400, 'confirmation_required');
      const result = store.rollbackRedline(id, body.index, { workspace });
      if (!result.ok) return fail(400, result.error || 'redline_rollback_failed');
      return ok({ record: result.record });
    },

    /** 读写插件设置。 */
    'POST /settings'({ query, body }) {
      const patch = body.settings ?? body;
      const before = settings.get();
      const next = settings.set(patch && typeof patch === 'object' ? patch : {});
      const workspace = resolveWorkspace(query, body);
      // 关掉工作区镜像就把文件收掉，别在仓库里留下过期的 MEMORY.md。
      if (before.mirror && !next.mirror) store.removeWorkspaceMirror(workspace);
      return ok({ settings: next, mirror: store.mirrorInfo(workspace) });
    },

    /** 导出全部记忆（备份）；`?full=1` 时并入画像 / 派生链 / 最近 30 天日志，供换机整库恢复。 */
    'GET /export'({ query }) {
      const workspace = resolveWorkspace(query);
      return ok({ export: store.export({ workspace, full: bool(query.full) }) });
    },

    /**
     * 画像导出（轻量）：全局画像（含版本历史）+ 全部红线——
     * 画像为主视图时，这一份载荷就是「整套画像记忆」，比 full 导出小一个量级。
     * 工作区画像的用户可见面已撤（产品只保留全局画像），载荷不再携带 workspace 字段；
     * 数据层双 scope 保留，但导出 / 导入链路只认全局。
     */
    'GET /portrait/export'({ query }) {
      const workspace = resolveWorkspace(query);
      const portraitOf = (root) => {
        const portrait = store.portrait(root);
        if (!portrait) return null;
        const { persistent, ...stored } = portrait;
        return stored;
      };
      const redlines = store
        .list({ workspace, limit: 500 })
        .records.filter((r) => r.category === 'constraint' && !r.archived);
      return ok({
        portraitExport: {
          schemaVersion: 1,
          exportedAt: new Date().toISOString(),
          global: { portrait: portraitOf(''), history: store.portraitHistory('') },
          redlines,
        },
      });
    },

    /** 从导出载荷、纯文本或本机既有记忆文件导入。 */
    'POST /import'({ body }) {
      const workspace = resolveWorkspace({}, body);
      const mode = body.mode === 'replace' ? 'replace' : 'merge';

      // 1) 备份载荷原样回灌。
      if (body.records || body.export) {
        const result = store.import(body.export ?? body, { workspace, mode });
        return ok({
          imported: result,
          portraitRewrite: feedPortraitAfterImport(workspace, body, result) ? 'triggered' : undefined,
          stats: store.stats({ workspace }),
        });
      }

      // 1.5) 画像导出载荷（GET /portrait/export 的产物）：红线条目入库 + 全局画像直接保存（版本 +1 留档）。
      //      工作区画像已撤（只保留全局画像），旧载荷里的 workspace 画像字段直接忽略。
      if (body.portraitExport) {
        const pe = body.portraitExport;
        const result = store.import(
          { records: Array.isArray(pe.redlines) ? pe.redlines : [] },
          { workspace, mode },
        );
        let globalSaved = false;
        const globalPortrait = pe.global?.portrait;
        if (globalPortrait && Array.isArray(globalPortrait.sections)) {
          globalSaved = Boolean(
            store
              .savePortrait('', {
                sections: globalPortrait.sections,
                evidence: globalPortrait.evidence,
                source: 'import',
              })
              .ok,
          );
        }
        return ok({
          imported: result,
          globalPortraitSaved: globalSaved,
          portraitRewrite: feedPortraitAfterImport(workspace, body, result) ? 'triggered' : undefined,
          stats: store.stats({ workspace }),
        });
      }

      // 2) 指定了文件路径：按文件解析。
      const paths = asStringArray(body.paths ?? body.path, 50);
      if (paths.length) {
        const records = [];
        const files = [];
        for (const file of paths) {
          try {
            const parsed = parseMemoryFile(file, { format: body.format });
            files.push({ path: file, format: parsed.format, records: parsed.records.length });
            for (const record of parsed.records) records.push({ ...record, scope: body.scope === 'global' ? 'global' : 'workspace' });
          } catch (error) {
            files.push({ path: file, records: 0, error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (!records.length) return fail(400, 'empty_payload', { files });
        const result = store.import({ records }, { workspace, mode });
        return ok({
          imported: result,
          files,
          portraitRewrite: feedPortraitAfterImport(workspace, body, result) ? 'triggered' : undefined,
          stats: store.stats({ workspace }),
        });
      }

      // 3) 自由文本：按空行分段（text）或按竞品记忆格式切条。
      const text = String(body.text ?? '').trim();
      if (!text) return fail(400, 'empty_payload');
      const format = IMPORT_FORMATS.includes(body.format) ? body.format : 'auto';
      let records;
      let detected = format;
      if (format === 'text') {
        records = text
          .split(/\n\s*\n/)
          .map((block) => block.trim())
          .filter(Boolean)
          .map((block) => {
            const [first, ...rest] = block.split('\n');
            const clean = first.replace(/^[-*#\s]+/, '').trim();
            return rest.length
              ? { title: clean.slice(0, 160), content: block, category: 'note', source: 'import' }
              : { title: clean.slice(0, 160), content: clean, category: 'note', source: 'import' };
          });
      } else {
        const parsed = parseMemoryText(text, { format });
        records = parsed.records;
        detected = parsed.format;
      }
      if (!records.length) return fail(400, 'empty_payload');
      const result = store.import({ records }, { workspace, mode });
      return ok({
        imported: result,
        detectedFormat: detected,
        formatLabel: FORMAT_LABELS[detected] ?? detected,
        portraitRewrite: feedPortraitAfterImport(workspace, body, result) ? 'triggered' : undefined,
        stats: store.stats({ workspace }),
      });
    },

    /** 扫描本机既有的竞品记忆（Qoder / WorkBuddy / 本插件镜像），只读。 */
    'GET /import-scan'({ query }) {
      const workspace = resolveWorkspace(query);
      return ok({
        scan: scanMemorySources({ workspace }),
        formats: FORMAT_LABELS,
      });
    },

    /** 把扫描到的来源导入：`{ sources: ['user-qoder', …] }` 或 `{ paths: [...] }`。 */
    'POST /import-scan'({ body }) {
      const workspace = resolveWorkspace({}, body);
      const mode = body.mode === 'replace' ? 'replace' : 'merge';
      const wanted = new Set(asStringArray(body.sources, 20));
      const scan = scanMemorySources({ workspace });
      const targets = [];
      for (const source of scan.sources) {
        if (wanted.size && !wanted.has(source.id)) continue;
        for (const file of source.files) targets.push({ file, scope: source.scope, sourceId: source.id });
      }
      for (const path of asStringArray(body.paths, 50)) {
        targets.push({ file: { path, format: body.format ?? 'auto' }, scope: body.scope === 'global' ? 'global' : 'workspace', sourceId: 'manual' });
      }
      if (!targets.length) return fail(400, 'nothing_selected', { sources: scan.sources.map((s) => s.id) });

      const records = [];
      const files = [];
      for (const { file, scope, sourceId } of targets) {
        /* 来源打标签：user-claude → `claude`，让「这条从哪来」在面板与导出里可见。 */
        const sourceTag = sourceId && sourceId !== 'manual' ? sourceId.replace(/^user-/, '') : null;
        try {
          const parsed = parseMemoryFile(file.path, { format: file.format ?? 'auto' });
          for (const record of parsed.records) {
            const tags = Array.isArray(record.tags) ? record.tags.slice() : [];
            if (sourceTag && !tags.includes(sourceTag)) tags.push(sourceTag);
            records.push({ ...record, scope, tags });
          }
          files.push({ path: file.path, format: parsed.format, records: parsed.records.length, scope });
        } catch (error) {
          files.push({ path: file.path, records: 0, scope, error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (!records.length) return fail(400, 'empty_payload', { files });
      const result = store.import({ records }, { workspace, mode });
      return ok({ imported: result, files, stats: store.stats({ workspace }) });
    },

    /** 会话检索（溯源）：按词重叠搜回当轮的用户发言原文。 */
    'GET /sessions'({ query }) {
      const workspace = resolveWorkspace(query);
      const results = store.sessionSearch({
        workspace,
        query: String(query.q ?? query.query ?? ''),
        limit: int(query.limit, 8, 1, 50),
      });
      return ok({ results });
    },

    /**
     * 前台会话卡：本会话的用户诉求 + 本会话沉淀的记忆 + 当前图标设置。
     * 草稿与归档由 store.list 的默认口径挡在外面（C6）；会话未知时回落活动工作区，
     * 没有会话 id 就返回空载荷，不猜内容。
     */
    'GET /session-brief'({ query }) {
      const requested = String(query.session || '').trim();
      /* 客户端拿不到会话标记时（新会话 / 宿主没打属性）由宿主用最近活动的会话兜底。 */
      const active = requested ? null : activeSession();
      const session = requested || String(active?.id || '');
      const cfg = settings.get();
      const icon = String(cfg.hudIcon || 'a');
      /* 会话卡外观：宽度 / 高度（0=自适应）/ 背景不透明度 / 背景色（空=跟随主题）。
         和图标一样由宿主下发，保存设置后前台卡下一轮轮询就换上，不需要刷新页面。 */
      const hud = {
        width: Number(cfg.hudWidth) || 340,
        height: Number.isFinite(Number(cfg.hudHeight)) ? Number(cfg.hudHeight) : 0,
        opacity: Number.isFinite(Number(cfg.hudOpacity)) ? Number(cfg.hudOpacity) : 1,
        color: typeof cfg.hudColor === 'string' ? cfg.hudColor : '',
      };
      const workspace =
        normalizeRoot(workspaceForSession(session) || '') ||
        normalizeRoot(active?.workspace || '') ||
        normalizeRoot(activeWorkspace() || '');
      if (!session || !workspace) {
        return ok({ session, workspace, entries: [], records: [], updatedAt: null, icon, hud });
      }
      const limit = int(query.limit, 12, 1, 50);
      const entries = store.sessionSearch({ workspace, query: '', limit, sessionId: session });
      const records = store
        .list({ workspace, limit: 500 })
        .records.filter(
          (record) =>
            String(record.sessionId || '') === session ||
            String(record.evidence?.sessionId || '') === session,
        )
        .slice(0, 8)
        .map((record) => ({
          id: record.id,
          title: record.title,
          category: record.category,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        }));
      const stamps = [
        entries[0]?.at,
        ...records.map((record) => record.updatedAt || record.createdAt),
      ]
        .filter(Boolean)
        .sort();
      return ok({
        session,
        workspace,
        entries,
        records,
        updatedAt: stamps.length ? stamps[stamps.length - 1] : null,
        icon,
        hud,
      });
    },

    /** 注入审计：最近真正进 prompt 的内容（字节 + hash + 取舍）。 */
    'GET /injections'({ query }) {
      const workspace = resolveWorkspace(query);
      const limit = int(query.limit, 20, 1, 100);
      const kind = ['briefing', 'turn-recall', 'path-recall'].includes(query.kind) ? query.kind : '';
      const full = bool(query.full, false);
      const entries = store.injectionLogRead(workspace, { limit, kind }).map((row) => {
        const { text, ...rest } = row;
        return full ? { ...rest, text } : { ...rest, preview: String(text || '').slice(0, 200) };
      });
      return ok({ entries });
    },

    /** 程序记忆晋升：把一条 convention/decision/preference/feedback 写进工作区 AGENTS.md 托管块。 */
    'POST /promote'({ body }) {
      const workspace = resolveWorkspace({}, body);
      const id = String(body?.id ?? '').trim();
      if (body?.from === 'portrait') {
        const section = String(body?.section ?? 'preference').trim() || 'preference';
        const result = store.promotePortraitToAgents(workspace, { section });
        if (!result.ok) {
          return fail(result.error === 'no_portrait' ? 404 : 400, result.error);
        }
        return ok({ file: result.file, lines: result.lines, section: result.section });
      }
      if (!id) return fail(400, 'missing_id');
      const result = store.promoteToAgents(workspace, { id });
      if (!result.ok) {
        return fail(result.error === 'not_found' ? 404 : 400, result.error);
      }
      return ok({ file: result.file, record: result.record });
    },

    /** 跨层派生链：谁派生了什么，源现在还成不成立。 */
    'GET /derivations'({ query }) {
      const workspace = resolveWorkspace(query);
      const entries = store.derivationList(workspace);
      return ok({ entries, summary: store.derivationSummary(workspace) });
    },

    /** 复审队列：带失效条件、到期该复查的记忆。 */
    'GET /reviews'({ query }) {
      const workspace = resolveWorkspace(query);
      const withinDays = int(query.withinDays, 30, 1, 365);
      const limit = int(query.limit, 50, 1, 200);
      const queue = store.reviewQueue(workspace, { withinDays });
      const brief = (record) => ({
        id: record.id,
        title: record.title,
        falsifier: record.falsifier,
        reviewAt: record.reviewAt,
        reviewedAt: record.reviewedAt || null,
      });
      /* 全量返回会在记忆多的时候把面板拖慢；这里截断，但把真实总数带回去。 */
      return ok({
        due: queue.due.slice(0, limit).map(brief),
        soon: queue.soon.slice(0, limit).map(brief),
        dueCount: queue.due.length,
        soonCount: queue.soon.length,
        limit,
      });
    },

    /** 复审一条：记「看过，还成立」，并把到期时间推后一个周期。 */
    'POST /review'({ body }) {
      const workspace = resolveWorkspace({}, body);
      const id = String(body?.id ?? '').trim();
      if (!id) return fail(400, 'missing_id');
      const result = store.markReviewed(id, { workspace, reviewAt: body?.reviewAt ?? null });
      if (!result.ok) return fail(result.error === 'not_found' ? 404 : 400, result.error);
      return ok({ record: result.record, reviewAt: result.reviewAt });
    },

    /** 打开记忆镜像文件所在目录的信息（面板上「在文件夹中查看」）。 */
    'GET /mirror'({ query }) {
      const workspace = resolveWorkspace(query);
      const info = store.workspaceInfo(workspace);
      return ok({
        mirror: { ...info, ...store.mirrorInfo(workspace), markdown: store.renderMarkdown(workspace) },
      });
    },

    /** 手动触发一次「对当前会话做自动提炼」。 */
    async 'POST /capture'(ctxArgs) {
      if (typeof captureNow !== 'function') return fail(501, 'capture_unavailable');
      const workspace = resolveWorkspace({}, ctxArgs.body);
      const result = await captureNow({ force: true, workspace });
      return ok({ capture: result, stats: store.stats({ workspace }) });
    },

    /**
     * Dream：半自动整理（面板按钮手动触发；「启动整理」也走同一条管线）。
     * 1) 合并重复簇（源条目归档可恢复，与面板「整合」同一语义）；
     * 2) 按时序处理矛盾：保留新结论、归档旧结论；红线 / 置顶 / 用户旧结论 / 外部新内容只报告；
     * 3) 过期未用只报告不归档（由人决定）；
     * 4) 画像重写（宿主提供 rewriteNow 时）；手动触发一律进待审。
     * 返回一份报告，面板展示「合并了几簇、哪些过期、画像是否进了待审」。
     */
    async 'POST /dream'(ctxArgs) {
      const workspace = resolveWorkspace({}, ctxArgs.body);
      const report = await runDream({ workspace, source: 'manual' });
      if (!report?.ok) {
        const error = report?.error || 'dream_failed';
        return fail(error === 'already_running' ? 409 : 500, error, report?.detail);
      }
      return ok(report);
    },

    /** 手动提炼：把一段文本交给模型变成记忆候选（不落库，返回给面板预览）。 */
    async 'POST /distill'({ body }) {
      if (typeof distillNow !== 'function') return fail(501, 'distill_unavailable');
      const text = String(body.text ?? '').trim();
      if (!text) return fail(400, 'empty_text');
      const workspace = resolveWorkspace({}, body);
      const candidates = await distillNow({ workspace, text: text.slice(0, 20000) });
      return ok({ candidates });
    },

    /** 让面板能探测服务是否在线。 */
    'GET /ping'() {
      return ok({ version, at: new Date().toISOString() });
    },

    /**
     * 写入安全：只扫描不落库。返回密钥命中（含脱敏后文本）与注入模式。
     * 工具/外部内容在真正 save 之前可以先过这里；store 写入路径同样会扫。
     */
    'POST /security/scan'({ body }) {
      const text = String(body?.text ?? '');
      if (!text.trim()) return fail(400, 'empty_text');
      const secrets = scanSecrets(text);
      const injection = scanInjection(text);
      return ok({
        tainted: injection.tainted,
        injectionKinds: injection.kinds,
        secretFindings: secrets.findings,
        redacted: secrets.text,
      });
    },

    /**
     * 简报预览：按当前设置算一遍「下次会话会注入哪些记忆」。
     * 口径与宿主半 briefingText 一致：index 按行 / full 按摘录 / portrait 另含画像预算。
     */
    'GET /briefing-preview'({ query }) {
      const workspace = resolveWorkspace(query);
      const cfg = settings.get();
      const enabled = Boolean(cfg.enabled && cfg.briefing);
      const rawMode =
        cfg.briefMode === 'full' ? 'full' : cfg.briefMode === 'portrait' ? 'portrait' : 'index';
      const mode = rawMode === 'full' ? 'full' : 'index';
      const stats = store.stats({ workspace });
      const pickedAll = enabled
        ? store.briefing({ workspace, limit: cfg.briefingLimit, maxChars: cfg.briefingMaxChars, mode })
        : [];
      /* portrait 模式：画像条目已由画像段全量承担，索引清单里排除（与宿主半一致）。 */
      const picked =
        rawMode === 'portrait' ? pickedAll.filter((r) => !(r.tags || []).includes('portrait')) : pickedAll;
      const portraitInjection =
        enabled && rawMode === 'portrait'
          ? renderPortraitInjection({
              workspace: store.portrait(workspace),
              global: store.portrait(''),
              maxChars: cfg.portraitMaxChars,
            })
          : null;
      /* 字符估算口径对齐 briefingText：index 按行、full 按标题+260 字摘录；页眉页脚开销不计入。 */
      const chars =
        picked.reduce((n, r) =>
          mode === 'index'
            ? n + r.title.length + (r.tags || []).join('').length + 30
            : n + r.title.length + Math.min(String(r.content || '').length, 260) + 24,
          0) + (portraitInjection ? portraitInjection.chars : 0);
      /* 冻结快照：frozen 为真时 staticText 就是接下来真正注入的字节。 */
      const snapshot = typeof snapshotInfo === 'function' ? snapshotInfo(workspace) : null;
      /* 尾部注入：轮末召回不进系统提示，单列一栏。 */
      const recall = typeof recallInfo === 'function' ? recallInfo(workspace) : null;
      return ok({
        preview: {
          enabled,
          mode: rawMode,
          limit: cfg.briefingLimit,
          maxChars: cfg.briefingMaxChars,
          portrait: portraitInjection
            ? {
                chars: portraitInjection.chars,
                truncated: portraitInjection.truncated,
                hasWorkspace: portraitInjection.hasWorkspace,
                hasGlobal: portraitInjection.hasGlobal,
                maxChars: cfg.portraitMaxChars,
              }
            : null,
          count: picked.length,
          available: stats.total + stats.global,
          chars,
          estTokens: Math.round(chars * 0.6),
          ids: picked.map((r) => r.id),
          titles: picked.map((r) => r.title),
          /* 已冻结的静态简报：frozen 为真时 staticText 就是接下来注入的字节。 */
          frozen: Boolean(snapshot?.frozen),
          sessionId: snapshot?.sessionId || '',
          staticText: snapshot?.frozen ? snapshot.text : null,
          staticChars: snapshot?.frozen ? snapshot.chars : chars,
          /* 尾部注入：与系统提示分开显示，别让人以为召回还在系统提示里。 */
          recall:
            recall && recall.count
              ? {
                  count: recall.count,
                  ids: recall.ids,
                  titles: recall.titles,
                  chars: recall.chars,
                  text: recall.text,
                }
              : null,
        },
      });
    },

    /* ---------------- 画像层（portrait） ---------------- */

    /** 当前画像（工作区 + 全局）、版本列表与段落定义；带重写运行态与待审稿存在性。 */
    'GET /portrait'({ query }) {
      const workspace = resolveWorkspace(query);
      const state = rewriteState() || {};
      return ok({
        workspace: store.portrait(workspace),
        global: store.portrait(''),
        history: store.portraitHistory(workspace),
        sectionDefs: PORTRAIT_SECTIONS.map((s) => ({ key: s.key, title: s.title, globalTitle: s.globalTitle })),
        rewriting: Boolean(state.running),
        lastError: state.lastError || null,
        /* 面板只展示全局画像：待审稿也按全局检查，否则工作区旧稿会冒充全局待审。 */
        draft: Boolean(store.portraitDraftRead('')),
      });
    },

    /** 手动保存画像（版本 +1、旧版留档、PORTRAIT.md 同步刷）。scope=global 写全局画像。 */
    'POST /portrait/save'({ query, body }) {
      const workspace = resolveWorkspace(query, body);
      const scope = body.scope === 'global' ? 'global' : 'workspace';
      const sections = Array.isArray(body.sections) ? body.sections : null;
      if (!sections) return fail(400, 'bad_sections');
      const root = scope === 'global' ? '' : workspace;
      const evidence = body.evidence && typeof body.evidence === 'object' ? body.evidence : undefined;
      const result = store.savePortrait(root, { sections, evidence, source: 'manual' });
      return ok({ portrait: result.portrait, mdWritten: result.mdWritten });
    },

    /** 画像版本列表（降序；含当前版本）。 */
    'GET /portrait/history'({ query }) {
      const workspace = resolveWorkspace(query);
      return ok({ history: store.portraitHistory(workspace) });
    },

    /**
     * 画像 2.0：两个版本之间的逐段 diff。
     * `from=previous`（默认）对比上一版与当前版；也可传具体版本号。
     * 返回 added / removed 行、逐段计数与一行摘要，供面板「这次变了什么」使用。
     */
    'GET /portrait/diff'({ query }) {
      const workspace = resolveWorkspace(query);
      const scope = query.scope === 'global' ? 'global' : 'workspace';
      const root = scope === 'global' ? '' : workspace;
      const current = store.portrait(root);
      const currentVersion = Number(current?.version) || 1;
      const toVersion =
        query.to == null || query.to === 'current' ? currentVersion : Number(query.to);
      const fromRaw = query.from == null ? currentVersion - 1 : query.from;
      const fromVersion = fromRaw === 'previous' ? toVersion - 1 : Number(fromRaw);

      if (!Number.isInteger(toVersion) || toVersion < 1) return fail(400, 'bad_version');
      if (!Number.isInteger(fromVersion) || fromVersion < 1) {
        return ok({ scope, currentVersion, diff: null, reason: 'no_previous_version' });
      }

      const before = store.portraitVersion(root, fromVersion);
      const after = toVersion === currentVersion ? current : store.portraitVersion(root, toVersion);
      if (!before) return fail(404, 'version_not_found', { version: fromVersion });
      if (!after) return fail(404, 'version_not_found', { version: toVersion });

      const diff = diffPortraitSections(before.sections, after.sections, { scope });
      return ok({
        scope,
        from: { version: before.version ?? fromVersion, updatedAt: before.updatedAt ?? null },
        to: { version: after.version ?? toVersion, updatedAt: after.updatedAt ?? null },
        diff,
        summary: portraitChangeLine(diff),
      });
    },

    /* ---------------- 日志层（journal） ---------------- */

    /** 写一条工作日志（append-only，低门槛流水账）。 */
    'POST /journal'({ query, body }) {
      const workspace = resolveWorkspace(query, body);
      const text = String(body.text ?? '').trim();
      if (!text) return fail(400, 'empty_text');
      const result = store.journalAppend(workspace, { text });
      if (!result.ok) return fail(400, result.error || 'append_failed');
      return ok({ date: result.date, time: result.time });
    },

    /** 读日志：带 date 取某天原文；不带 date 返回日期列表 + 最近几天。 */
    'GET /journal'({ query }) {
      const workspace = resolveWorkspace(query);
      const dates = store.journalDates(workspace);
      const date = String(query.date ?? '').trim();
      if (date) {
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return fail(400, 'bad_date');
        const day = store.journalRead(workspace, { date });
        return ok({ dates, date: day.date, text: day.text });
      }
      const days = int(query.days, 3, 1, 30);
      const recent = store.journalRecent(workspace, { days });
      return ok({ dates, recent: recent.map((item) => ({ date: item.date, text: item.text })) });
    },

    /* ---------------- 画像重写（P1） ---------------- */

    /** 触发一次重写（LLM 重写式合并）。mode: direct | draft；缺省跟随设置。 */
    async 'POST /portrait/rewrite'({ query, body }) {
      if (typeof rewriteNow !== 'function') return fail(501, 'unsupported');
      const workspace = resolveWorkspace(query, body);
      const scope = body.scope === 'global' ? 'global' : 'workspace';
      const mode = body.mode === 'draft' || body.mode === 'direct' ? body.mode : '';
      /* 全局画像的「立即刷新」也吸收当前工作区近况（与自动刷新同一口径）。 */
      const result = await rewriteNow({
        workspace,
        scope,
        mode,
        contextWorkspace: scope === 'global' ? workspace : '',
      });
      if (!result?.ok) {
        if (result?.error === 'already_running') return fail(409, 'already_running');
        return fail(500, result?.error || 'rewrite_failed', result?.detail);
      }
      return ok({
        drafted: Boolean(result.drafted),
        portrait: result.portrait || null,
        sections: result.drafted ? result.sections : null,
        /* 'repaired' 无损修复；'truncated' / 'salvaged' 有损——有损的一律进了待审，要人过一眼。 */
        degraded: result.degraded || 'none',
      });
    },

    /**
     * 跨 App 迁移画像：body.text 是用户在其它应用按提示词让那边 AI 总结出的画像 JSON
     * （允许夹在普通文本 / 代码围栏里）。解析出四段后走全局画像重写整合；
     * 重写通道不可用或抛错时降级为「旧段 + 迁移段」纯文本合并，迁移内容永不因通道失败而丢失。
     */
    async 'POST /portrait/migrate'({ body }) {
      const raw = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!raw) return fail(400, 'bad_payload');
      const parsed = extractJson(raw);
      if (!parsed) return fail(400, 'bad_payload');

      /* 四段取值：缺键容忍、非串跳过；全空说明载荷里没有可整合的画像内容。 */
      const MIGRATE_KEYS = ['background', 'preference', 'focus', 'recent'];
      const migrateParts = {};
      let hasContent = false;
      for (const key of MIGRATE_KEYS) {
        const value = parsed[key];
        if (typeof value === 'string' && value.trim()) {
          migrateParts[key] = value.trim();
          hasContent = true;
        } else {
          migrateParts[key] = '';
        }
      }
      if (!hasContent) return fail(400, 'bad_payload');

      const migrateText = MIGRATE_KEYS.map((key) => (migrateParts[key] ? `${key}: ${migrateParts[key]}` : ''))
        .filter(Boolean)
        .join('\n');

      /* 首选：LLM 重写式整合（只动全局画像）。 */
      if (typeof rewriteNow === 'function') {
        let result = null;
        try {
          result = await rewriteNow({ workspace: '', scope: 'global', migrateText });
        } catch {
          result = null; /* 重写通道抛错 → 走降级合并 */
        }
        if (result?.ok) {
          return ok({ merged: true, via: 'rewrite', portrait: result.portrait || null });
        }
        if (result) {
          /* 重写通道明确拒绝（running / disabled / 原料不足…）：按 /portrait/rewrite 的写法映射 */
          if (result.error === 'already_running') return fail(409, 'already_running');
          return fail(500, result.error || 'migrate_failed', result.detail);
        }
      }

      /* 降级合并：旧段 + '\n' + 迁移段逐段拼接，直接落库（source=import 留档）。 */
      try {
        const current = store.portrait('');
        const oldByText = new Map((current?.sections || []).map((s) => [s.key, String(s.text || '')]));
        const sections = MIGRATE_KEYS.map((key) => {
          const oldText = oldByText.get(key) || '';
          const incoming = migrateParts[key];
          if (incoming && oldText) return { key, text: `${oldText}\n${incoming}` };
          return { key, text: incoming || oldText };
        });
        const saved = store.savePortrait('', { sections, source: 'import' });
        return ok({ merged: true, via: 'fallback', portrait: saved?.portrait || null });
      } catch (error) {
        return fail(500, 'migrate_failed', String(error?.message || error));
      }
    },

    /** 待审重写稿内容（默认全局；显式 scope=workspace 才读工作区旧稿）。 */
    'GET /portrait/draft'({ query }) {
      const workspace = resolveWorkspace(query);
      const scope = query.scope === 'workspace' ? 'workspace' : 'global';
      return ok({ draft: store.portraitDraftRead(scope === 'global' ? '' : workspace) });
    },

    /** 批准待审重写稿（落库 + 清稿）。 */
    'POST /portrait/draft/approve'({ query, body }) {
      const workspace = resolveWorkspace(query, body);
      const scope = body.scope === 'global' ? 'global' : 'workspace';
      const result = approveDraft({ workspace, scope });
      if (!result?.ok) return fail(404, result?.error || 'no_draft');
      return ok({ portrait: result.portrait });
    },

    /** 丢弃待审重写稿（默认全局）。 */
    'POST /portrait/draft/discard'({ query, body }) {
      const workspace = resolveWorkspace(query, body);
      const scope = body.scope === 'workspace' ? 'workspace' : 'global';
      store.portraitDraftClear(scope === 'global' ? '' : workspace);
      return ok({ discarded: true });
    },

    /** 合并标签变体（如 DSH / dsh → dsh）。返回受影响的条数。 */
    'POST /tags/merge'({ body }) {
      const workspace = resolveWorkspace({}, body);
      const to = String(body.to ?? '').trim();
      const from = asStringArray(body.from, 50).filter((t) => t && t !== to);
      if (!to || !from.length) return fail(400, 'nothing_to_merge');
      const result = store.mergeTag(from, to, { workspace });
      if (!result.ok) return fail(400, result.error || 'merge_failed');
      return ok({ affected: result.affected, stats: store.stats({ workspace }) });
    },

    /* ---------------- 整库快照（后悔药） ---------------- */

    /** 现有快照清单（新的在前）。没有 backups/ 时返回空数组，不报错。 */
    'GET /backups'({ query }) {
      const limit = Math.max(1, Math.min(200, Number(query?.limit) || 20));
      return ok({
        backups: store.snapshots({ limit }),
        root: typeof store.snapshotRoot === 'function' ? store.snapshotRoot() : '',
        keep: 7,
      });
    },

    /**
     * 立刻做一次整库快照。误删 / 清空 / 换机之前按一下。
     * 失败不抛异常，把 store 的 { ok:false, error } 原样带回去。
     */
    'POST /backup'({ body }) {
      const result = store.snapshotLibrary({
        keep: 7,
        reason: String(body?.reason || 'manual'),
      });
      if (!result.ok) return fail(400, result.error || 'snapshot_failed');
      return ok({
        backup: { name: result.name, files: result.files, bytes: result.bytes },
        removed: result.removed || [],
        backups: store.snapshots({ limit: 20 }),
      });
    },

    /* ---------------- v0.3.0：体检 / 时间线 / 审批队列 / 版本链 ---------------- */

    /** 记忆体检：重复簇、过期未用、断链、待审草稿数。只报告不处理。 */
    'GET /health'({ query }) {
      const workspace = resolveWorkspace(query);
      const cfg = settings.get();
      const health = store.health({ workspace, staleDays: cfg.staleDays, briefingLimit: cfg.briefingLimit });
      const titleOf = (id) => store.get(id, { workspace })?.title || '';
      /* 启动整理：上次自动 / 手动整理时间、下一次到期、最近一次摘要（面板「自动整理」卡用）。 */
      const maintenance = store.maintenanceState(workspace);
      const autoDreamDays = Number(cfg.autoDreamDays) || 0;
      const lastTidyAt = Date.parse(maintenance.lastAutoAt || maintenance.lastManualAt || '') || 0;
      const dreamState = dreamInfo() || {};
      /* 二级蒸馏：上次尝试的素材 / 解析 / 拒绝原因，以及自适应节奏的下一窗。 */
      const distillState = store.globalDistillState(workspace);
      const distillCadenceInfo = distillCadence(distillState, {
        cooldownMinutes: cfg.globalDistillCooldownMinutes,
      });
      const lastDistillAt = Date.parse(distillState.lastAt || '') || 0;
      return ok({
        health: {
          ...health,
          globalDistill: {
            ...distillState,
            enabled: cfg.globalDistill !== false,
            minNew: Number(cfg.globalDistillMinNew) || 3,
            baseMinutes: distillCadenceInfo.baseMinutes,
            intervalMinutes: distillCadenceInfo.intervalMinutes,
            /* no_material 不占时间窗（没花 token），不显示会误导的「下次允许」。 */
            nextAllowedAt:
              lastDistillAt && distillState.lastResult !== 'no_material'
                ? new Date(lastDistillAt + distillCadenceInfo.intervalMs).toISOString()
                : null,
          },
          /* 二级蒸馏的候选池：面板显示「待判定 N 条」，并能逐条「不再提议」。
             放在 health 内部而不是顶层——维护页拿到的就是这一层。 */
          candidates: store.candidates.stats(),
          candidateItems: store.candidates
            .list({ status: 'pending' })
            .slice(0, 10)
            .map((item) => ({
              id: item.id,
              text: item.text,
              category: item.category,
              topics: item.topics || [],
            })),
          maintenance: {
            autoDreamDays,
            autoDreamPortrait: cfg.autoDreamPortrait !== false,
            autoPortraitHours: Number(cfg.autoPortraitHours) || 0,
            portraitUpdatedAt: store.portrait('')?.updatedAt || null,
            lastAutoAt: maintenance.lastAutoAt,
            lastManualAt: maintenance.lastManualAt,
            lastReport: maintenance.lastReport,
            nextDueAt:
              autoDreamDays > 0 && lastTidyAt
                ? new Date(lastTidyAt + autoDreamDays * 86400000).toISOString()
                : null,
            running: Boolean(dreamState.running),
          },
          duplicates: health.duplicates.map((ids) => ids.map((id) => ({ id, title: titleOf(id) }))),
          stale: health.stale.map((id) => ({ id, title: titleOf(id) })),
          exposedButUnused: health.exposedButUnused.map((id) => {
            const record = store.get(id, { workspace });
            return { id, title: record?.title || '', exposedCount: record?.exposedCount || 0 };
          }),
          /* 矛盾对与失效文件引用带上标题，面板直接可读（只有 id 用户认不出来）。 */
          contradictions: health.contradictions.map((pair) => ({
            ...pair,
            aTitle: titleOf(pair.a),
            bTitle: titleOf(pair.b),
          })),
          deadFiles: health.deadFiles.map((item) => ({
            ...item,
            title: titleOf(item.id),
          })),
        },
        stats: store.stats({ workspace }),
      });
    },

    /**
     * 「不再提议」：把候选标成 rejected，之后同主题不再晋升。
     * 自动路径不弹确认，纠错就靠这一个动作——所以它必须足够便宜：一次点击，无二次确认。
     */
    'POST /candidates/reject'({ body }) {
      const ids = asStringArray(body.ids, 50);
      if (!ids.length) return fail(400, 'need_ids');
      const result = store.candidates.mark(ids, {
        status: 'rejected',
        rejectReason: String(body.reason ?? '').slice(0, 120) || null,
      });
      if (!result.ok) return fail(400, result.error || 'reject_failed');
      return ok({ rejected: result.affected, stats: store.candidates.stats() });
    },

    /** 体检修复动作：merge（合并重复簇）| archive（归档过期）| unlink（摘除断链）。 */
    'POST /health/resolve'({ body }) {
      const workspace = resolveWorkspace({}, body);
      const action = String(body.action ?? '');
      if (action === 'merge') {
        const ids = asStringArray(body.ids, 50);
        if (ids.length < 2) return fail(400, 'need_two');
        const result = store.consolidateCluster(ids, {
          workspace,
          source: 'manual',
          title: String(body.title ?? '').trim() || undefined,
          content: typeof body.content === 'string' ? body.content : undefined,
          category: CATEGORIES.includes(body.category) ? body.category : undefined,
          tags: Array.isArray(body.tags) ? body.tags.slice(0, 32).map(String) : undefined,
        });
        if (!result.ok) return fail(400, result.error || 'merge_failed');
        return ok({ merged: result.record, archivedIds: result.archivedIds, stats: store.stats({ workspace }) });
      }
      if (action === 'time-order') {
        const ids = asStringArray(body.ids, 50);
        if (ids.length !== 2) return fail(400, 'need_two');
        const result = store.resolveContradictionPair(ids[0], ids[1], { workspace });
        if (!result.ok) return fail(400, result.error || 'resolve_failed');
        return ok({
          archived: result.archived?.id,
          kept: result.kept?.id,
          stats: store.stats({ workspace }),
        });
      }
      if (action === 'archive') {
        const ids = asStringArray(body.ids, 200);
        if (!ids.length) return fail(400, 'missing_ids');
        const result = store.bulk('archive', ids, { workspace });
        return ok({ affected: result.affected, stats: store.stats({ workspace }) });
      }
      if (action === 'unlink') {
        const id = String(body.id ?? '').trim();
        if (!id) return fail(400, 'missing_id');
        const result = store.unlink(id, String(body.target ?? ''), { workspace });
        if (!result.ok) return fail(404, result.error || 'not_found');
        return ok({ record: result.record });
      }
      return fail(400, 'bad_action');
    },

    /** 时间线：全部记忆（含归档、不含草稿）按更新时间倒序，前端按日分组。 */
    'GET /timeline'({ query }) {
      const workspace = resolveWorkspace(query);
      const result = store.list({
        workspace,
        includeArchived: true,
        sort: 'updated',
        limit: int(query.limit, 300, 1, 1000),
      });
      return ok({ workspace: { root: workspace, key: workspaceKey(workspace) }, ...result });
    },

    /** 待审草稿队列（captureMode=draft 时自动提炼的候选先到这里）。 */
    'GET /queue'({ query }) {
      const workspace = resolveWorkspace(query);
      const result = store.list({ workspace, includeDrafts: true, sort: 'updated', limit: 100 });
      return ok({
        workspace: { root: workspace, key: workspaceKey(workspace) },
        total: result.records.filter((r) => r.status === 'draft').length,
        records: result.records.filter((r) => r.status === 'draft'),
      });
    },

    /**
     * 批准草稿：可附带编辑字段。草稿若挂着 supersedes，批准即兑现版本链
     * （旧条归档、草稿转正为版本链的新头）。
     */
    'POST /queue/approve'({ body }) {
      const workspace = resolveWorkspace({}, body);
      const id = String(body.id ?? '').trim();
      if (!id) return fail(400, 'missing_id');
      const draft = store.get(id, { workspace, includeDrafts: true });
      if (!draft || draft.status !== 'draft') return fail(404, 'draft_not_found');

      const edits = {};
      for (const key of ['title', 'content', 'category', 'tags', 'keywords', 'related']) {
        if (body[key] !== undefined) edits[key] = body[key];
      }
      if (edits.category !== undefined && !CATEGORIES.includes(edits.category)) delete edits.category;

      if (draft.supersedes && !edits.supersedesDiscarded) {
        const old = store.get(draft.supersedes, { workspace });
        if (old) {
          // 剥掉草稿自己的 id：版本链的新头必须是新 id，否则下面 remove(id) 会误删新记录。
          const { id: _draftId, ...seed } = { ...draft, ...edits, status: 'active' };
          const result = store.supersede(old.id, seed, { workspace });
          store.remove(id, { workspace });
          return ok({ record: result.record, superseded: { id: old.id, title: old.title } });
        }
      }
      // allowStatusChange: 审批是唯一允许把 draft 转正的路径（patchRecord 的状态机保护）。
      const result = store.update(id, { ...edits, status: 'active' }, { workspace, allowStatusChange: true });
      if (!result.ok) return fail(404, 'not_found');
      return ok({ record: result.record });
    },

    /** 拒绝草稿：默认直接删除（草稿从未生效），mode=archive 时归档留底。 */
    'POST /queue/reject'({ body }) {
      const workspace = resolveWorkspace({}, body);
      const id = String(body.id ?? '').trim();
      if (!id) return fail(400, 'missing_id');
      const draft = store.get(id, { workspace, includeDrafts: true });
      if (!draft || draft.status !== 'draft') return fail(404, 'draft_not_found');
      if (body.mode === 'archive') {
        const result = store.update(id, { status: 'active', archived: true }, { workspace });
        return ok({ archived: result.record.id });
      }
      const result = store.remove(id, { workspace });
      return ok({ removed: result.removed.id });
    },

    /** 版本链回滚：传新条 id 恢复旧条，或传旧条 id（带 supersededBy）撤销推翻。 */
    'POST /supersede/rollback'({ body }) {
      const workspace = resolveWorkspace({}, body);
      const id = String(body.id ?? '').trim();
      if (!id) return fail(400, 'missing_id');
      const result = store.rollback(id, { workspace });
      if (!result.ok) return fail(400, result.error || 'rollback_failed');
      return ok({ restored: result.restored, archived: result.archived });
    },
  };

  /**
   * 处理一个已解析的请求。
   * @param args.method   — 大写 HTTP 方法
   * @param args.pathname — 完整 pathname（含 /memory/api 前缀）
   * @param args.query    — 已解析的查询串对象
   * @param args.body     — 已解析的 JSON body（可空）
   * @returns {status, body}
   */
  async function handle({ method = 'GET', pathname = '', query = {}, body = null } = {}) {
    let sub = pathname;
    if (sub.startsWith(API_PREFIX)) sub = sub.slice(API_PREFIX.length);
    if (!sub.startsWith('/')) sub = `/${sub}`;
    sub = sub.replace(/\/+$/, '') || '/';

    const verb = String(method || 'GET').toUpperCase();
    const key = `${verb} ${sub}`;
    const handler = routes[key];

    if (!handler) {
      const known = Object.keys(routes);
      return fail(404, 'unknown_route', { request: key, known });
    }

    try {
      return await handler({ query: query || {}, body: body && typeof body === 'object' ? body : {} });
    } catch (error) {
      // resolveWorkspace 的白名单拒绝：统一的 400 invalid_workspace，不透传成 500。
      if (error && error.code === 'INVALID_WORKSPACE') return fail(400, 'invalid_workspace');
      return fail(500, 'handler_failed', { message: error instanceof Error ? error.message : String(error) });
    }
  }

  return { handle, routes: Object.keys(routes), API_PREFIX, stateFor, resolveWorkspace };
}

export { API_PREFIX };
export default createApi;
