/**
 * dsh-memory — Dream 整理管线（手动按钮与「启动整理」共用）。
 *
 * 半自动巩固的安全子集，三步都不产生新条目：
 *   1) 合并重复簇（源条目归档可恢复；红线不参与，结果继承置顶）；
 *   2) 按时序归档矛盾的旧结论（红线 / 置顶 / 用户旧条 / 外部新条只报告）；
 *   3) 报告过期未用（只报告，不归档）。
 * 可选第四步：画像重写（需要宿主提供 rewriteNow）。
 *
 * 边界（AGENTS.md D 系列 / C5）：
 *   - 没有任何定时器；调用方决定何时运行（面板按钮 / 打开 DSH 后的启动检查）；
 *   - 动手前先整库快照；失败只进报告，绝不抛给调用方；
 *   - 同一时刻只允许一次 Dream，重复调用返回 already_running。
 */

import { promoteCandidates } from './distill-global.js';

const PORTRAIT_SKIP_REASONS = new Set([
  'disabled',
  'already_running',
  'no_workspace',
  'no_material',
  'no_model_route',
  'llm_unavailable',
]);

/**
 * @param deps.store      — createMemoryStore() 的返回值
 * @param deps.settings   — { get(): object }
 * @param deps.rewriteNow — 可选 async ({workspace, mode}) => 画像重写结果
 * @param deps.logger     — 可选宿主 logger（只记 warn，不记业务正文）
 */
export function createDreamRunner({ store, settings, rewriteNow = null, logger = null } = {}) {
  let running = false;
  let last = null;

  function warn(message) {
    try {
      logger?.warn?.(`dsh-memory: ${message}`);
    } catch {
      /* 日志失败不能影响整理本身 */
    }
  }

  /**
   * @param opts.workspace — 目标工作区（已归一化）
   * @param opts.source    — 'manual'（面板 / HTTP）| 'auto'（启动整理）
   * @param opts.portrait  — auto 时是否尝试画像重写；manual 始终尝试（与旧行为一致）
   * @returns {Promise<object>} 报告；失败返回 { ok: false, error }
   */
  async function run({ workspace = '', source = 'manual', portrait = true } = {}) {
    if (running) return { ok: false, error: 'already_running' };
    running = true;
    const cfg = settings.get();
    const auto = source === 'auto';
    const report = {
      ok: true,
      workspace,
      source: auto ? 'auto' : 'manual',
      at: new Date().toISOString(),
      merged: [],
      contradictionsResolved: [],
      contradictionsPending: [],
      staleReported: 0,
      staleIds: [],
      exposedUnusedReported: 0,
      exposedUnusedIds: [],
      globalPromoted: 0,
      globalPromotedIds: [],
      globalDuplicates: 0,
      portrait: null,
      portraitReason: null,
      portraitDetail: null,
      portraitDegraded: null,
      errors: [],
      backup: null,
    };

    try {
      /* 合并条目、归档旧结论、重写画像都是不可逆动作——动手前先留一份整库快照。 */
      const backup = store.snapshotLibrary({ reason: auto ? 'auto-dream' : 'dream' });
      report.backup = backup?.ok ? { name: backup.name, files: backup.files } : null;

      const clusters = store.findDuplicateClusters({ workspace }).slice(0, 20);
      for (const group of clusters) {
        const ids = group.map((r) => r.id);
        try {
          const result = store.consolidateCluster(ids, {
            workspace,
            source: auto ? 'auto' : 'manual',
          });
          if (result?.ok) {
            report.merged.push({
              into: result.record?.id ?? null,
              title: result.record?.title ?? '',
              count: ids.length,
              archivedIds: result.archivedIds ?? ids,
            });
          } else {
            report.errors.push({ step: 'merge', ids, error: result?.error || 'unknown' });
          }
        } catch (error) {
          report.errors.push({ step: 'merge', ids, error: String(error?.message || error) });
        }
      }

      /*
       * 矛盾对先按词法线索报告，**不自动归档**：词法检测会误报（真实库上出现过
       * 「竞争定位」被「autoCapture 默认值」判成矛盾），自动归档会误伤无关记忆。
       * 归档只走面板逐对确认的 `/health/resolve time-order`，那里有快照与回滚。
       */
      try {
        const resolution = store.resolveContradictionsByTime({ workspace, apply: false });
        report.contradictionsResolved = [];
        report.contradictionsPending = resolution.pending;
      } catch (error) {
        report.errors.push({ step: 'contradictions', error: String(error?.message || error) });
      }

      /* 只报告，不自动归档：过期未用由人决定（避免「很久没打开」被当成失效）。 */
      try {
        const health = store.health({
          workspace,
          staleDays: cfg.staleDays ?? 60,
          briefingLimit: cfg.briefingLimit,
        });
        report.staleReported = health.stale.length;
        report.staleIds = health.stale.slice(0, 50);
        report.exposedUnusedReported = health.exposedButUnused.length;
        report.exposedUnusedIds = health.exposedButUnused.slice(0, 50);
      } catch (error) {
        report.errors.push({ step: 'health', error: String(error?.message || error) });
      }

      /* 二级蒸馏的判定步骤：候选池里够格的原则晋升到全局。
         纯计算，随时可重跑（幂等）。**产**候选不在这里做——那一步的时机由模型
         判断或由任务结束触发，不是定时任务该管的事。 */
      try {
        const outcome = promoteCandidates(store);
        report.globalPromoted = outcome.promoted;
        report.globalPromotedIds = outcome.ids;
        report.globalDuplicates = outcome.duplicates;
      } catch (error) {
        report.errors.push({ step: 'global-promote', error: String(error?.message || error) });
      }

      /* 画像重写：手动始终尝试（旧行为：一律进待审）；自动只在开启且调用方允许时尝试，
         落库方式跟随 rewriteMode（direct 直接落库 / draft 进待审）。 */
      const shouldPortrait = typeof rewriteNow === 'function' && (auto ? portrait && cfg.autoDreamPortrait !== false : true);
      if (shouldPortrait) {
        try {
          const mode = auto ? (cfg.rewriteMode === 'draft' ? 'draft' : 'direct') : 'draft';
          const result = await rewriteNow({
            workspace,
            mode,
            /* 面板只展示全局画像：Dream 的画像步骤也写全局，别再把待审稿写进看不见的工作区画像。 */
            scope: 'global',
            contextWorkspace: workspace,
          });
          if (result?.ok) {
            report.portrait = result.drafted ? 'drafted' : result.portrait ? 'saved' : null;
            if (result.degraded && result.degraded !== 'none') report.portraitDegraded = result.degraded;
          } else if (result?.error && PORTRAIT_SKIP_REASONS.has(result.error)) {
            report.portrait = 'skipped';
            report.portraitReason = result.error;
            report.portraitDetail = result.detail ?? null;
          } else if (result?.error) {
            report.errors.push({ step: 'portrait', error: result.error, detail: result.detail ?? null });
          }
        } catch (error) {
          report.errors.push({ step: 'portrait', error: String(error?.message || error) });
        }
      } else if (auto && cfg.autoDreamPortrait !== false) {
        /* 开了画像重写但调用方还没拿到模型路由：报 skipped，等下一次启动 / 下个周期。 */
        report.portrait = 'skipped';
        report.portraitReason = 'no_model_route';
      }

      /* 台账落库失败不影响整理结果：下一次启动只是会再整理一次。 */
      try {
        store.noteMaintenance(workspace, {
          at: report.at,
          source: report.source,
          report: summarize(report),
        });
      } catch (error) {
        warn(`维护台账写入失败: ${error?.message || error}`);
      }

      last = report;
      return report;
    } catch (error) {
      const message = String(error?.message || error);
      warn(`Dream 失败: ${message}`);
      return { ok: false, error: 'dream_failed', detail: message, at: report.at, source: report.source };
    } finally {
      running = false;
    }
  }

  /** 只留面板要显示的数字与状态，台账不存整份报告（合并明细可能很长）。 */
  function summarize(report) {
    return {
      merged: report.merged.length,
      archived: report.merged.reduce((sum, item) => sum + (item.archivedIds?.length || 0), 0),
      contradictionsResolved: report.contradictionsResolved.length,
      contradictionsPending: report.contradictionsPending.length,
      stale: report.staleReported,
      exposedUnused: report.exposedUnusedReported,
      globalPromoted: report.globalPromoted,
      globalDuplicates: report.globalDuplicates,
      portrait: report.portrait,
      portraitReason: report.portraitReason,
      errors: report.errors.length,
    };
  }

  return {
    run,
    /** 运行态（面板据此显示「整理中」）。 */
    state() {
      return { running, last };
    },
  };
}
