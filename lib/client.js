/**
 * dsh-memory —— 客户端半（DSH 设置面板的「记忆」页）。
 *
 * 无构建步骤：模块宿主按包名提供本文件，这里只 require("react")。
 * 页面通过同源 POST /memory/api/* 与宿主半通信（宿主半用 webServer 前缀路由注册）。
 *
 * ⚠️ 这里的 id 必须与 package.json 的 name 逐字一致：模块系统按 manifest 包名认领
 * 浏览器模块，注册成别的 id 只会报 `bundle … loaded without registering "<包名>"
 * via __ModuleLoader__.load`，宿主半天照跑、界面整块消失。0.3.2 把包名改成
 * @bangbang-03/dsh-memory 时漏改这里，0.3.4 修回；test/client.test.mjs 已加断言防回归。
 */
window.__ModuleLoader__.load({
  id: "@bangbang-03/dsh-memory",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const { useCallback, useEffect, useMemo, useRef, useState } = react;
    const h = react.createElement;

    /** 导入时的格式选择（与 lib/markdown.js 的 IMPORT_FORMATS 对齐）。 */
    const IMPORT_FORMAT_OPTIONS = ["auto", "workbuddy", "qoder", "daily", "text"];

    /**
     * 复制文本：优先 Clipboard API；远程 web（LAN http / 未上 TLS 的反代）不是
     * secure context，navigator.clipboard 不存在，退化到隐藏 textarea + execCommand。
     * 返回 false 让调用方提示「手动选中复制」，而不是点了没反应。
     */
    async function copyText(value) {
      const text = String(value == null ? "" : value);
      if (!text) return false;
      try {
        if (globalThis.navigator?.clipboard?.writeText) {
          await globalThis.navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        /* 权限被拒 / 非安全上下文：继续走兜底 */
      }
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.top = "-1000px";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(area);
        return Boolean(ok);
      } catch {
        return false;
      }
    }

    /* 面板的「显示与视图」偏好：只落本机 localStorage。
       这些是屏幕上的事（视图、排布、密度、哪几块显示），换了机器各看各的才对；
       不写进宿主配置，也就不会跨机同步、不进制品配置表。 */
    const UI_PREF_KEY = "dsh-memory:ui";
    const UI_PREF_GROUPS = ["none", "tag", "category", "timeline"];
    const UI_PREF_DEFAULTS = {
      view: "doc",
      groupBy: "none",
      density: "comfort",
      showPortrait: true,
      showStats: true,
      showBanner: true,
    };

    const uiPrefsRead = () => {
      try {
        const raw = globalThis.localStorage?.getItem(UI_PREF_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        const merged = { ...UI_PREF_DEFAULTS, ...(parsed && typeof parsed === "object" ? parsed : {}) };
        if (merged.view !== "list" && merged.view !== "doc") merged.view = "doc";
        if (!UI_PREF_GROUPS.includes(merged.groupBy)) merged.groupBy = "none";
        if (merged.density !== "compact" && merged.density !== "comfort") merged.density = "comfort";
        for (const key of ["showPortrait", "showStats", "showBanner"]) {
          merged[key] = merged[key] !== false;
        }
        return merged;
      } catch {
        return { ...UI_PREF_DEFAULTS };
      }
    };

    const uiPrefsWrite = (patch) => {
      try {
        const next = { ...uiPrefsRead(), ...(patch || {}) };
        globalThis.localStorage?.setItem(UI_PREF_KEY, JSON.stringify(next));
        return next;
      } catch {
        return uiPrefsRead();
      }
    };

    /* 会话卡外观：尺寸 / 底色 / 不透明度走宿主配置（设置页可调、跨机器同步），
       位置、展开状态与图标大小留在本机——图标大小纯粹是「这台机器上看着顺眼」，
       不进宿主配置、不影响任何记忆数据。常量放在顶部，设置页与前台卡共用同一套夹取规则。 */
    const HUD_LOOK_DEFAULTS = { width: 340, height: 0, opacity: 1, color: "" };
    const HUD_LOOK_WIDTH = [240, 640];
    const HUD_LOOK_HEIGHT = [180, 720];
    const HUD_LOOK_OPACITY = [0.35, 1];
    /** 卡片图标大小的可选区间与默认值（px）。 */
    const HUD_ICON_SIZE = [14, 40];
    const HUD_ICON_SIZE_DEFAULT = 20;
    /** 前台卡拖拽改大小后广播，设置页开着时同步滑杆。 */
    const HUD_LOOK_EVENT = "dsh-memory:session-hud/look";

    const hudClamp = (value, min, max, fallback) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return fallback;
      return Math.min(Math.max(num, min), max);
    };

    /** 只认 #rgb / #rrggbb；其它（含空串）一律回落到「跟随主题」。 */
    const hudHexColor = (value) => {
      const text = String(value || "").trim();
      return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu.test(text) ? text : "";
    };

    /** #rgb → #rrggbb：颜色选择器只认 6 位；CSS 与判断两处共用。 */
    const hudFullHex = (hex) => {
      const raw = String(hex || "").slice(1);
      return raw.length === 3 ? `#${raw.split("").map((ch) => ch + ch).join("")}` : String(hex || "");
    };

    /** 自定义底色时按亮度选前景色，避免浅底白字 / 深底黑字。 */
    const hudContrast = (hex) => {
      const raw = hudFullHex(hex).slice(1);
      const r = parseInt(raw.slice(0, 2), 16);
      const g = parseInt(raw.slice(2, 4), 16);
      const b = parseInt(raw.slice(4, 6), 16);
      const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return luma > 0.62 ? "#1f2329" : "#f5f7fb";
    };

    /** /session-brief 下发的 hud 外观 → 夹取后的安全值（宿主配置也可能被手改成越界值）。 */
    const hudLookFrom = (brief) => {
      const raw = brief?.hud && typeof brief.hud === "object" ? brief.hud : {};
      const height = hudClamp(raw.height, 0, HUD_LOOK_HEIGHT[1], HUD_LOOK_DEFAULTS.height);
      return {
        width: Math.round(hudClamp(raw.width, HUD_LOOK_WIDTH[0], HUD_LOOK_WIDTH[1], HUD_LOOK_DEFAULTS.width)),
        /* 0 与「太小」都按自适应处理，避免固定高度把头部挤扁。 */
        height: height >= HUD_LOOK_HEIGHT[0] ? Math.round(height) : 0,
        opacity: hudClamp(raw.opacity, HUD_LOOK_OPACITY[0], HUD_LOOK_OPACITY[1], HUD_LOOK_DEFAULTS.opacity),
        color: hudHexColor(raw.color),
      };
    };

    /** 外观 → CSS 变量：默认主题、透明度与前景色推导都交给样式表，React 只管变量。 */
    const hudLookVars = (look) => {
      const opacity = hudClamp(look?.opacity, HUD_LOOK_OPACITY[0], HUD_LOOK_OPACITY[1], HUD_LOOK_DEFAULTS.opacity);
      const vars = { "--dshmem-hud-bg-alpha": `${Math.round(opacity * 100)}%` };
      const color = hudHexColor(look?.color);
      if (!color) return vars;
      const fg = hudContrast(color);
      vars["--dshmem-hud-bg"] = color;
      vars["--dshmem-hud-fg"] = fg;
      vars["--dshmem-hud-dim"] = `color-mix(in srgb, ${fg} 62%, transparent)`;
      vars["--dshmem-hud-border"] = `color-mix(in srgb, ${fg} 22%, transparent)`;
      return vars;
    };

    /* 字节数转人读：备份清单用。 */
    const humanBytes = (value) => {
      const n = Number(value) || 0;
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
      return `${(n / 1024 / 1024).toFixed(1)} MB`;
    };

    /* 备份目录名就是时间戳：2026-10-22T14-23-45-678-manual → 2026-10-22 14:23:45 · manual */
    const backupLabel = (name) => {
      const text = String(name || "");
      const date = text.slice(0, 10);
      const time = text.slice(11, 19).replace(/-/gu, ":");
      const tag = text.slice(20).replace(/^-/u, "");
      const stamp = date && time ? `${date} ${time}` : text;
      return tag ? `${stamp} · ${tag}` : stamp;
    };


    /* ---------------------------------------------------------------- *
     * 样式
     * ---------------------------------------------------------------- */

    /**
     * 「记忆卡片」字形：设置导航项自带的齿轮图标由外壳补齐，这里用同尺寸的
     * 字形把它换掉（见文件末尾 syncNavMarker 的说明）。data URI 只含
     * encodeURIComponent 转义后的字符，放进 url("…") 是安全的。
     */
    const NAV_GLYPH = (() => {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M6 3.75h12A1.25 1.25 0 0 1 19.25 5v14A1.25 1.25 0 0 1 18 20.25H6A1.25 1.25 0 0 1 4.75 19V5A1.25 1.25 0 0 1 6 3.75Z"/>' +
        '<path d="M8.5 9h7M8.5 12.5h7M8.5 16h4"/></svg>';
      return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
    })();

    const css = `
:root{--dshmem-nav-glyph:${NAV_GLYPH};--dshmem-dim:color-mix(in srgb,currentColor 68%,transparent)}
/* 该 :root 变量供下面的导航字形使用；外壳的设置导航在本页面子树之外。 */
[role="dialog"] nav button[data-dshmem-nav] svg:first-child{display:none!important}
[role="dialog"] nav button[data-dshmem-nav]::before{content:"";flex:none;width:16px;height:16px;
  background-color:currentColor;
  -webkit-mask:var(--dshmem-nav-glyph) center/contain no-repeat;
  mask:var(--dshmem-nav-glyph) center/contain no-repeat}
.dshmem{
  /* 三档文字：正文 13 / 辅助 11.5 / 区块标题 15；间距走 4px 栅格，圆角只有控件 8 与容器 12。 */
  --dshmem-fs-meta:11.5px;--dshmem-fs-body:13px;--dshmem-fs-title:15px;
  --dshmem-space-1:4px;--dshmem-space-2:8px;--dshmem-space-3:12px;--dshmem-space-4:16px;--dshmem-space-5:24px;
  --dshmem-radius-control:8px;--dshmem-radius-panel:12px;
  --dshmem-line:var(--dsw-alias-border-l1,rgba(0,0,0,.08));
  --dshmem-surface:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.02));
  --dshmem-surface-strong:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.04));
  display:flex;flex-direction:column;gap:var(--dshmem-space-3);
  font-size:var(--dshmem-fs-body);line-height:1.55;
  color:var(--dsw-alias-label-primary,#1f2329)}
.dshmem *{box-sizing:border-box}
.dshmem_bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.dshmem_grow{flex:1;min-width:120px}
.dshmem_input,.dshmem_select,.dshmem_area{width:100%;padding:8px 12px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));
  background:var(--dsw-alias-bg-layer-2,transparent);color:inherit;font:inherit;outline:none}
.dshmem_input:focus,.dshmem_select:focus,.dshmem_area:focus{border-color:var(--dsw-static-deepseek-450,#4d6bfe)}
.dshmem_area{min-height:96px;resize:vertical;line-height:1.55;font-family:inherit}
.dshmem_btn{flex:none;display:inline-flex;align-items:center;gap:8px;height:32px;padding:0 14px;
  border-radius:8px;cursor:pointer;font:inherit;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));
  background:transparent;color:var(--dsw-alias-label-primary,#1f2329)}
.dshmem_btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.dshmem_btn:disabled{opacity:.5;cursor:default}
.dshmem_btn_primary{border-color:transparent;background:var(--dsw-static-deepseek-450,#4d6bfe);color:#fff}
.dshmem_btn_primary:hover{background:var(--dsw-static-deepseek-500,#4176e6)}
.dshmem_btn_sm{height:24px;padding:0 8px;font-size:var(--dshmem-fs-meta)}
.dshmem_link{flex:none;padding:0;border:0;background:transparent;font:inherit;
  font-size:var(--dshmem-fs-meta);color:var(--dsw-static-deepseek-450,#4d6bfe);cursor:pointer}
.dshmem_link:hover{text-decoration:underline}
.dshmem_link:disabled{color:var(--dshmem-dim,#8a9099);cursor:default;text-decoration:none}
.dshmem_btn_danger:hover{color:var(--dsw-alias-state-error-primary,#d54941);
  border-color:var(--dsw-alias-state-error-primary,#d54941)}
.dshmem_tabs{display:flex;flex-wrap:wrap;gap:8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07))}
.dshmem_tab{position:relative;padding:8px 12px;border:0;background:transparent;cursor:pointer;
  font:inherit;color:var(--dsw-alias-label-secondary,#5b6169)}
.dshmem_tab_on{color:var(--dsw-static-deepseek-450,#4d6bfe);font-weight:600}
.dshmem_tab_on::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;
  border-radius:2px;background:var(--dsw-static-deepseek-450,#4d6bfe)}
.dshmem_wsbar{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:10px;
  border:1px solid var(--dshmem-line);background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.02))}
.dshmem_wsbarMain{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshmem_wsbarPath{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshmem_wsfile{display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  padding-top:8px;border-top:1px dashed var(--dshmem-line)}
.dshmem_wsfileBody{max-height:260px;margin-top:4px;width:100%}
.dshmem_stats{display:flex;flex-wrap:wrap;gap:8px}
.dshmem_chip{padding:4px 10px;border-radius:999px;font-size:var(--dshmem-fs-meta);
  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07));
  background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.02));
  color:var(--dsw-alias-label-secondary,#5b6169)}
.dshmem_chip_click{cursor:pointer}
.dshmem_chip_redline{border-color:var(--dsw-alias-state-error-primary,#d54941);
  color:var(--dsw-alias-state-error-primary,#d54941);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d54941) 12%,transparent)}
.dshmem_chip_on{border-color:var(--dsw-static-deepseek-450,#4d6bfe);
  color:var(--dsw-static-deepseek-450,#4d6bfe);
  /* --dsw-static-* 在浅色/深色里是同一个值，直接拿 deepseek-50 当底会在深色下糊出一块近白的色块；
     用半透明蓝叠加当前底色，两种主题都成立（不支持 color-mix 时退回中性层）。 */
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));
  background:color-mix(in srgb,var(--dsw-static-deepseek-450,#4d6bfe) 16%,transparent)}
.dshmem_sources{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.dshmem_source{padding:var(--dshmem-space-2) 0;border-radius:0;
  border:0;border-top:1px solid var(--dshmem-line);background:transparent;
  display:flex;flex-direction:column;gap:var(--dshmem-space-1)}
.dshmem_source:first-child{border-top:0}
.dshmem_source_head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshmem_source_name{font-weight:600;color:var(--dsw-alias-label-primary,#111)}
.dshmem_source_path{font-size:var(--dshmem-fs-meta);color:var(--dshmem-dim);
  word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dshmem_list{display:flex;flex-direction:column;gap:0}
.dshmem_card{display:flex;flex-direction:column;gap:var(--dshmem-space-2);padding:var(--dshmem-space-3) 0;
  border-radius:0;border:0;border-top:1px solid var(--dshmem-line);background:transparent}
.dshmem_card:first-child{border-top:0}
.dshmem_card:hover{background:var(--dshmem-surface-strong)}
.dshmem_card_pin{border-left:2px solid var(--dsw-static-deepseek-450,#4d6bfe);
  padding-left:var(--dshmem-space-3)}
.dshmem_main{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.dshmem_title{font-weight:600;line-height:1.4;word-break:break-word}
.dshmem_reason{font-size:var(--dshmem-fs-meta);color:var(--dshmem-dim);border-left:2px solid color-mix(in srgb,currentColor 25%,transparent);padding-left:8px}
.dshmem_body{white-space:pre-wrap;word-break:break-word;line-height:1.55;
  color:var(--dsw-alias-label-secondary,#5b6169);
  display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.dshmem_meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:var(--dshmem-fs-meta);
  color:var(--dshmem-dim)}
.dshmem_tag{color:var(--dsw-static-deepseek-450,#4d6bfe)}
.dshmem_acts{display:flex;flex-direction:row;gap:4px;flex:none;align-items:center;
  justify-content:flex-end;flex-wrap:wrap;width:100%}
/* 分区与分组：范围分区 → 标签分组 → 卡片 */
.dshmem_seg{display:inline-flex;gap:2px;padding:2px;border-radius:8px;
  border:0;background:var(--dshmem-surface-strong)}
.dshmem_seg_btn{height:24px;padding:0 10px;border:0;border-radius:8px;background:transparent;
  cursor:pointer;font:inherit;font-size:var(--dshmem-fs-meta);color:var(--dsw-alias-label-secondary,#5b6169)}
.dshmem_seg_btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
/* 同 .dshmem_chip_on：static token 不随主题变，用半透明蓝叠加当前底色。 */
.dshmem_seg_on{background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));
  background:color-mix(in srgb,var(--dsw-static-deepseek-450,#4d6bfe) 16%,transparent);
  color:var(--dsw-static-deepseek-450,#4d6bfe);font-weight:600}
/* 概览可视化：纯 CSS 条形与柱形，不引图表库；颜色全部走主题 token。 */
.dshmem_ov{display:flex;flex-direction:column;gap:var(--dshmem-space-3)}
.dshmem_ovGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(92px,1fr));gap:8px}
.dshmem_tile{padding:10px 12px;border-radius:8px;background:var(--dshmem-surface-strong);
  display:flex;flex-direction:column;gap:2px;min-width:0}
.dshmem_tileNum{font-size:20px;font-weight:600;line-height:1.1}
.dshmem_tileLabel{font-size:var(--dshmem-fs-meta);color:var(--dshmem-dim)}
.dshmem_ovBlock{display:flex;flex-direction:column;gap:6px}
.dshmem_ovBlockHead{display:flex;align-items:baseline;gap:8px;
  font-size:var(--dshmem-fs-meta);font-weight:600;color:var(--dsw-alias-label-secondary,#5b6169)}
.dshmem_shareTrack{display:flex;height:8px;border-radius:999px;overflow:hidden;
  background:var(--dshmem-surface-strong)}
.dshmem_shareA{background:var(--dsw-static-deepseek-450,#4d6bfe)}
.dshmem_shareB{background:color-mix(in srgb,var(--dsw-static-deepseek-450,#4d6bfe) 34%,transparent)}
.dshmem_legend{display:flex;flex-wrap:wrap;gap:12px;font-size:var(--dshmem-fs-meta);color:var(--dshmem-dim)}
.dshmem_dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:middle}
.dshmem_catRow{display:grid;grid-template-columns:76px 1fr 34px;gap:8px;align-items:center;
  font-size:var(--dshmem-fs-meta)}
.dshmem_catName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshmem_catTrack{height:6px;border-radius:999px;overflow:hidden;background:var(--dshmem-surface-strong)}
.dshmem_catFill{height:100%;border-radius:999px;
  background:color-mix(in srgb,var(--dsw-static-deepseek-450,#4d6bfe) 62%,transparent)}
.dshmem_catNum{text-align:right;color:var(--dshmem-dim)}
.dshmem_trend{display:flex;align-items:stretch;gap:6px;height:58px}
.dshmem_trendCol{flex:1;min-width:0;display:flex;flex-direction:column;
  align-items:center;gap:4px;height:100%}
/* 柱高按百分比算，所以给它一个确定高度的轨道；否则会被日期行挤出容器。 */
.dshmem_trendTrack{flex:1;display:flex;align-items:flex-end;width:100%;min-height:0}
.dshmem_trendBar{width:100%;border-radius:4px 4px 0 0;min-height:2px;
  background:color-mix(in srgb,var(--dsw-static-deepseek-450,#4d6bfe) 52%,transparent)}
.dshmem_trendBar_on{background:var(--dsw-static-deepseek-450,#4d6bfe)}
.dshmem_trendDay{font-size:10.5px;color:var(--dshmem-dim);white-space:nowrap}
.dshmem_meter{height:6px;border-radius:999px;overflow:hidden;background:var(--dshmem-surface-strong)}
.dshmem_meterFill{height:100%;border-radius:999px;background:var(--dsw-static-deepseek-450,#4d6bfe)}
.dshmem_ovHint{font-size:var(--dshmem-fs-meta);color:var(--dshmem-dim)}
/* 紧凑密度：卡片间距与正文行数一起收紧。 */
.dshmem_dense .dshmem_card{padding:8px 0}
.dshmem_dense .dshmem_body{-webkit-line-clamp:2}
.dshmem_dense .dshmem_docPara{line-height:1.45}
.dshmem_dense .dshmem_list{gap:0}
.dshmem_space{display:flex;flex-direction:column;gap:var(--dshmem-space-4)}
.dshmem_section{display:flex;flex-direction:column;gap:var(--dshmem-space-2);
  padding:var(--dshmem-space-3) var(--dshmem-space-4);border-radius:var(--dshmem-radius-panel);
  border:0;background:var(--dshmem-surface)}
.dshmem_sectionHead{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none}
.dshmem_chev{flex:none;width:12px;font-size:var(--dshmem-fs-meta);color:var(--dshmem-dim)}
.dshmem_sectionTitle{font-size:var(--dshmem-fs-title);font-weight:600;line-height:1.35}
.dshmem_count{font-size:var(--dshmem-fs-meta);color:var(--dshmem-dim)}
.dshmem_groups{display:flex;flex-direction:column;gap:16px}
.dshmem_group{display:flex;flex-direction:column;gap:8px}
.dshmem_groupHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshmem_groupTitle{font-size:var(--dshmem-fs-meta);font-weight:600;cursor:pointer;user-select:none;
  color:var(--dsw-alias-label-secondary,#5b6169)}
.dshmem_groupTitle_plain{color:var(--dsw-alias-label-secondary,#5b6169)}
.dshmem_groupItems{display:flex;flex-direction:column;gap:0;
  border-left:1px solid var(--dshmem-line);padding-left:12px}
.dshmem_card_dense{padding:8px 0}
.dshmem_card_dense .dshmem_body{-webkit-line-clamp:2}
.dshmem_empty{padding:24px 16px;text-align:center;color:var(--dshmem-dim)}
.dshmem_first{padding:var(--dshmem-space-5);border-radius:var(--dshmem-radius-panel);
  display:flex;flex-direction:column;gap:var(--dshmem-space-3);
  border:0;background:var(--dshmem-surface)}
.dshmem_firstTitle{font-size:var(--dshmem-fs-title);font-weight:600;line-height:1.35}
.dshmem_firstList{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:8px;
  font-size:var(--dshmem-fs-body);color:var(--dsw-alias-label-secondary,#5b6169);line-height:1.55}
.dshmem_firstPath{font-size:11.5px;color:var(--dshmem-dim);word-break:break-all}
.dshmem_err{padding:8px 12px;border-radius:8px;font-size:var(--dshmem-fs-meta);
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));
  color:var(--dsw-alias-state-error-primary,#d54941)}
.dshmem_ok{padding:8px 12px;border-radius:8px;font-size:var(--dshmem-fs-meta);
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));
  color:var(--dsw-static-deepseek-450,#4d6bfe)}
.dshmem_box{padding:var(--dshmem-space-3) var(--dshmem-space-4);border-radius:var(--dshmem-radius-panel);
  display:flex;flex-direction:column;gap:var(--dshmem-space-2);
  border:0;background:var(--dshmem-surface)}
.dshmem_row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dshmem_lbl{flex:none;width:160px;font-size:var(--dshmem-fs-body);color:var(--dsw-alias-label-secondary,#5b6169)}
.dshmem_field{display:flex;flex-direction:column;gap:4px;flex:1 1 180px;min-width:0;max-width:260px}
.dshmem_fieldLabel{font-size:var(--dshmem-fs-meta);line-height:1.4;color:var(--dsw-alias-label-secondary,#5b6169)}
/* 会话卡外观：滑杆比数字框直观，右侧同时给出当前值。 */
.dshmem_slider{display:flex;flex-direction:column;gap:3px;flex:1 1 200px;min-width:170px;max-width:300px}
.dshmem_sliderTop{display:flex;align-items:baseline;justify-content:space-between;gap:8px;
  font-size:var(--dshmem-fs-meta);line-height:1.4;color:var(--dsw-alias-label-secondary,#5b6169)}
.dshmem_sliderVal{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#1f2329)}
.dshmem_range{width:100%;margin:0;cursor:pointer;accent-color:var(--dsw-static-deepseek-450,#4d6bfe)}
.dshmem_colorRow{display:flex;align-items:center;gap:8px}
.dshmem_color{flex:none;width:46px;height:32px;padding:2px;border-radius:8px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:transparent}
.dshmem_switch{display:flex;gap:8px;align-items:flex-start;cursor:pointer}
.dshmem_switch input{margin-top:2px;flex:none}
.dshmem_hint{font-size:11.5px;color:var(--dshmem-dim);line-height:1.5}
.dshmem_pick{display:flex;flex-direction:column;gap:var(--dshmem-space-2);
  padding:var(--dshmem-space-2) 0;border-radius:0;
  border:0;border-top:1px solid var(--dshmem-line)}
.dshmem_path{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;word-break:break-all;
  color:var(--dsw-alias-label-secondary,#5b6169)}
.dshmem_mirror{max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-word;
  font-family:ui-monospace,Consolas,monospace;font-size:11.5px;line-height:1.5;
  padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03))}
/* 档案视图：一份连续文档；快捷开关收在「工具与记录」里。 */
.dshmem_swRow{display:flex;align-items:center;justify-content:space-between;gap:var(--dshmem-space-4);
  padding:var(--dshmem-space-2) 0;border-radius:0;
  border:0;border-top:1px solid var(--dshmem-line);background:transparent}
.dshmem_swRow:first-child{border-top:0}
.dshmem_swMain{display:flex;flex-direction:column;gap:4px;min-width:0}
.dshmem_swTitle{font-weight:600;line-height:1.4}
.dshmem_swHint{font-size:11.5px;line-height:1.5;color:var(--dshmem-dim)}
.dshmem_tgl{flex:none;position:relative;width:40px;height:22px;padding:0;border-radius:11px;
  border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));cursor:pointer;
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.06))}
.dshmem_tgl::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;
  border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:left .15s}
.dshmem_tgl[data-on="1"]{background:var(--dsw-static-deepseek-500,#4176e6);
  border-color:var(--dsw-static-deepseek-500,#4176e6)}
.dshmem_tgl[data-on="1"]::after{left:20px}
.dshmem_docToolbar{display:flex;flex-direction:column;gap:var(--dshmem-space-3);
  padding-bottom:var(--dshmem-space-3);border-bottom:1px solid var(--dshmem-line)}
.dshmem_docCardHead{display:flex;align-items:flex-start;justify-content:space-between;
  gap:16px;flex-wrap:wrap}
.dshmem_docMain{display:flex;flex-direction:column;gap:4px;min-width:0}
.dshmem_doc{display:flex;flex-direction:column;gap:var(--dshmem-space-4)}
.dshmem_docSec{font-size:11.5px;letter-spacing:.03em;
  color:var(--dshmem-dim)}
.dshmem_docFlat{display:flex;flex-direction:column;gap:12px}
.dshmem_docItem{padding:var(--dshmem-space-2) 0;border-radius:0;
  border-top:1px solid var(--dshmem-line)}
.dshmem_docItem:first-child{border-top:0}
.dshmem_docItem:hover{background:var(--dshmem-surface-strong)}
.dshmem_docHeadRow{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.dshmem_docTitle{font-weight:600;line-height:1.5;word-break:break-word;
  color:var(--dsw-alias-label-primary,#0f1115)}
.dshmem_docFree{flex:none;font-size:11.5px;cursor:pointer;visibility:hidden;
  color:var(--dsw-static-deepseek-450,#4d6bfe)}
.dshmem_docItem:hover .dshmem_docFree{visibility:visible}
.dshmem_tlItem:hover .dshmem_docFree{visibility:visible}
.dshmem_docPara{margin-top:3px;white-space:pre-wrap;word-break:break-word;line-height:1.6;
  color:var(--dsw-alias-label-secondary,#5b6169)}
.dshmem_docFoot{font-size:11.5px;line-height:1.5;color:var(--dshmem-dim)}
/* 「想加记忆就在对话里说」那行：淡蓝底 + 左侧色条，别抢正文的注意力。 */
.dshmem_docAdd{margin-top:8px;padding:8px 12px;border-radius:8px;font-size:var(--dshmem-fs-meta);line-height:1.5;
  border-left:2px solid var(--dsw-static-deepseek-450,#4d6bfe);
  color:var(--dsw-alias-label-secondary,#5b6169);
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));
  background:color-mix(in srgb,var(--dsw-static-deepseek-450,#4d6bfe) 8%,transparent)}
.dshmem_area_doc{min-height:220px}
/* 时间线：按日分组的全部记忆（含归档）。 */
.dshmem_tl{display:flex;flex-direction:column;gap:var(--dshmem-space-4)}
.dshmem_tlDay{display:flex;align-items:center;gap:8px;font-size:11.5px;
  color:var(--dshmem-dim);position:sticky;top:0;
  background:var(--dsw-alias-bg-primary,inherit);padding:4px 0}
.dshmem_tlDay::after{content:"";flex:1;height:1px;
  background:var(--dsw-alias-border-l1,rgba(0,0,0,.07))}
.dshmem_tlItem{display:flex;flex-direction:column;gap:var(--dshmem-space-1);
  padding:var(--dshmem-space-2) 0;border-radius:0;cursor:pointer;
  border-top:1px solid var(--dshmem-line)}
.dshmem_tlItem:first-child{border-top:0}
.dshmem_tlItem:hover{background:var(--dshmem-surface-strong)}
.dshmem_tlItem_archived{opacity:.55}
.dshmem_tlHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.dshmem_tlTitle{font-weight:600;word-break:break-word}
.dshmem_tlBody{font-size:var(--dshmem-fs-body);line-height:1.55;white-space:pre-wrap;word-break:break-word;
  color:var(--dsw-alias-label-secondary,#5b6169);
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
/* 健康：统计卡 + 问题清单。 */
.dshmem_health{display:flex;flex-direction:column;gap:0}
.dshmem_kpis{display:flex;flex-wrap:wrap;gap:8px}
.dshmem_kpi{display:flex;flex-direction:column;gap:var(--dshmem-space-1);
  padding:0 var(--dshmem-space-4) 0 0;border:0;border-right:1px solid var(--dshmem-line);
  background:transparent;min-width:96px}
.dshmem_kpi:last-child{border-right:0;padding-right:0}
.dshmem_kpiNum{font-size:20px;font-weight:600;line-height:1.2}
.dshmem_kpiLbl{font-size:var(--dshmem-fs-meta);color:var(--dshmem-dim)}
.dshmem_issue{display:flex;flex-direction:column;gap:var(--dshmem-space-1);
  padding:var(--dshmem-space-2) 0;border-radius:0;
  border:0;border-top:1px solid var(--dshmem-line)}
.dshmem_issue:first-child{border-top:0}
.dshmem_issueHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshmem_issueBody{font-size:var(--dshmem-fs-body);color:var(--dsw-alias-label-secondary,#5b6169);word-break:break-word}
.dshmem_chain{color:var(--dsw-static-deepseek-450,#4d6bfe);font-size:var(--dshmem-fs-meta)}
/* 审批队列的草稿卡：左缘蓝条提示「还没生效」。 */
.dshmem_draftCard{border-left:3px solid var(--dsw-static-deepseek-450,#4d6bfe)}
.dshmem_redline{border-left:2px solid var(--dsw-alias-state-error-primary,#d54941)}
.dshmem_redlineEditor{display:flex;flex-direction:column;gap:8px;padding:12px;
  border-radius:8px;background:var(--dshmem-surface-strong)}
.dshmem_redlinePreview{margin:0;padding:10px 12px;border-radius:8px;
  background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));
  font-family:ui-monospace,Consolas,monospace;font-size:11.5px;line-height:1.5;
  white-space:pre-wrap;word-break:break-word}
.dshmem_attention{display:flex;align-items:center;justify-content:space-between;gap:var(--dshmem-space-3);
  padding:var(--dshmem-space-3) var(--dshmem-space-4);border-radius:var(--dshmem-radius-panel);
  background:var(--dshmem-surface)}
.dshmem_attention_alert{border-left:2px solid var(--dsw-alias-state-warning-primary,#d97706)}
.dshmem_attentionMain{display:flex;flex-direction:column;gap:4px;min-width:0}
.dshmem_attentionTitle{font-weight:600;line-height:1.4}
.dshmem_attentionInbox{display:flex;flex-direction:column;gap:var(--dshmem-space-3);
  padding:var(--dshmem-space-3) var(--dshmem-space-4);border-radius:var(--dshmem-radius-panel);
  background:var(--dshmem-surface)}
.dshmem_attentionSection{display:flex;flex-direction:column;gap:var(--dshmem-space-2)}
.dshmem_attentionSectionHead{font-size:var(--dshmem-fs-meta);font-weight:600;
  color:var(--dsw-alias-label-secondary,#5b6169);padding-bottom:4px;border-bottom:1px solid var(--dshmem-line)}
.dshmem_attentionItem{display:flex;gap:var(--dshmem-space-3);align-items:flex-start;
  justify-content:space-between;padding:var(--dshmem-space-2) 0;border-top:1px solid var(--dshmem-line)}
.dshmem_attentionItem:first-of-type{border-top:0}
.dshmem_attentionItem .dshmem_main{flex:1;min-width:0}
.dshmem_attentionItem .dshmem_acts{width:auto;flex:none}
.dshmem_attentionSection > .dshmem_btn{align-self:flex-start}
.dshmem_evidencePanel{display:flex;flex-direction:column;gap:var(--dshmem-space-2);
  padding:var(--dshmem-space-3);border-radius:8px;background:var(--dshmem-surface-strong);
  margin-top:var(--dshmem-space-2)}
/* 记忆页的次要区域：默认收起，标题行给摘要；展开后仍是同一套分区，不再套卡片。 */
.dshmem_tools{background:var(--dshmem-surface);border-radius:var(--dshmem-radius-panel);
  padding:var(--dshmem-space-3) var(--dshmem-space-4);display:flex;flex-direction:column;gap:var(--dshmem-space-2)}
.dshmem_toolsHead{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;flex-wrap:wrap}
.dshmem_toolsTitle{font-weight:600;font-size:var(--dshmem-fs-body)}
.dshmem_toolsSummary{font-size:var(--dshmem-fs-meta);color:var(--dshmem-dim)}
.dshmem_toolsBody{display:flex;flex-direction:column;gap:var(--dshmem-space-3)}
.dshmem_toolsBody[data-open="0"]{display:none}
.dshmem_toolsBlock{display:flex;flex-direction:column;gap:var(--dshmem-space-2)}
/* 工具区已经是一层容器，里面的旧 box 不再叠第二层底色。 */
.dshmem_toolsBody > .dshmem_box{background:transparent;padding:0;border-radius:0}
.dshmem_toolsBody > .dshmem_box .dshmem_sources{margin-top:0}
/* 列表筛选：默认收起，避免首屏同时出现搜索、排序、归档、工作区、标签五组控件。 */
.dshmem_filterBar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;
  padding-top:var(--dshmem-space-2);border-top:1px solid var(--dshmem-line)}
.dshmem_filterBar[data-open="0"]{display:none}
/* 维护页三段：标题行给计数与摘要，内容仍沿用原有的 box/issue 结构。 */
.dshmem_blockGroup{display:flex;flex-direction:column;gap:var(--dshmem-space-3)}
.dshmem_blockGroupHead{display:flex;align-items:center;gap:8px;user-select:none;
  padding-bottom:var(--dshmem-space-2);border-bottom:1px solid var(--dshmem-line);flex-wrap:wrap;
  margin-top:var(--dshmem-space-2)}
.dshmem_blockGroupTitle{font-size:var(--dshmem-fs-title);font-weight:600;line-height:1.35}
.dshmem_blockGroupBody{display:flex;flex-direction:column;gap:var(--dshmem-space-3)}
.dshmem_blockGroupBody[data-open="0"]{display:none}
.dshmem_blockGroupBody > .dshmem_box{background:transparent;padding:0;border-radius:0}
/* 设置页四组：组标题之间只留一条分隔线，不再用嵌套卡片。 */
.dshmem_fieldGroup{display:flex;flex-direction:column;gap:var(--dshmem-space-2)}
.dshmem_fieldGroupTitle{font-size:var(--dshmem-fs-title);font-weight:600;line-height:1.35;
  padding-bottom:var(--dshmem-space-1);border-bottom:1px solid var(--dshmem-line)}
.dshmem_fieldGroupBody{display:flex;flex-direction:column;gap:var(--dshmem-space-2)}
.dshmem_saveBar{position:sticky;bottom:0;z-index:3;display:flex;gap:8px;align-items:center;
  padding:var(--dshmem-space-3) 0;background:var(--dsw-alias-bg-primary,#fff);
  border-top:1px solid var(--dshmem-line)}
/* 前台会话记忆卡：挂在宿主 shell.overlay 槽位上，不在 .dshmem 容器里，
   所以不依赖 --dshmem-* 尺度变量，直接用宿主令牌 + 字面回退。
   层级：抓手 / 图标 / 标题 / 关闭 → 更新时间 → 正文；尺寸变量只有 --dshmem-hud-icon。 */
.dshmem_hud{position:fixed;right:24px;bottom:96px;z-index:60;max-width:calc(100vw - 24px);
  pointer-events:auto}
.dshmem_hud_free{right:auto;bottom:auto}
/* 卡面：16px 圆角 + 双层柔和投影，边框只留 1px 半透明描边，去掉「贴纸感」。 */
.dshmem_hud_card{display:flex;flex-direction:column;width:340px;border-radius:16px;
  padding:12px 16px 15px;
  border:1px solid var(--dshmem-hud-border,color-mix(in srgb,currentColor 12%,transparent));
  background:var(--dshmem-hud-bg,var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-primary,#fff)));
  color:var(--dshmem-hud-fg,var(--dsw-alias-label-primary,#1f2329));
  box-shadow:0 18px 40px -18px rgba(15,23,42,.34),0 2px 8px rgba(15,23,42,.06);
  font-size:13px;line-height:1.62}
/* 头区：整条都能拖，抓手把这件事说清楚。 */
.dshmem_hud_head{display:flex;align-items:center;gap:8px;margin-bottom:9px;
  cursor:grab;user-select:none;touch-action:none}
.dshmem_hud_head:active{cursor:grabbing}
/* 拖动柄：30×30 命中区（点阵 16×16，左缘与正文对齐）。点阵用纯 CSS 画，
   不依赖子节点/SVG——任何宿主渲染出来都是六个点。 */
.dshmem_hud_grip{flex:none;display:inline-flex;align-items:center;justify-content:center;
  width:30px;height:30px;margin-left:-7px;padding:0;border:0;border-radius:9px;
  background:transparent;color:inherit;opacity:.38;cursor:grab;touch-action:none;
  user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;
  transition:opacity .16s ease,background-color .16s ease,transform .16s ease}
.dshmem_hud_grip::before{content:"";width:16px;height:16px;
  background-image:
    radial-gradient(circle at 5px 4px,currentColor 1.4px,transparent 1.7px),
    radial-gradient(circle at 11px 4px,currentColor 1.4px,transparent 1.7px),
    radial-gradient(circle at 5px 8px,currentColor 1.4px,transparent 1.7px),
    radial-gradient(circle at 11px 8px,currentColor 1.4px,transparent 1.7px),
    radial-gradient(circle at 5px 12px,currentColor 1.4px,transparent 1.7px),
    radial-gradient(circle at 11px 12px,currentColor 1.4px,transparent 1.7px);
  background-repeat:no-repeat;background-size:16px 16px}
.dshmem_hud_grip:hover{opacity:1;transform:scale(1.05);
  background:var(--dsw-alias-interactive-bg-hover,rgba(15,23,42,.06))}
.dshmem_hud_grip:active,.dshmem_hud_grip[data-dragging="1"]{cursor:grabbing;opacity:1;transform:scale(.94);
  background:var(--dsw-alias-interactive-bg-hover,rgba(15,23,42,.09))}
.dshmem_hud_grip:focus-visible{outline:2px solid var(--dsw-static-deepseek-450,#4d6bfe);
  outline-offset:1px;opacity:1}
/* 预览里的抓手只是示意，不接事件。 */
.dshmem_hud_grip[data-static="1"]{cursor:default;pointer-events:none;opacity:.5}
/* 品牌块：给图标一个浅色底托，避免图片浮在卡片上显得散。 */
.dshmem_hud_brand{flex:none;display:inline-flex;align-items:center;justify-content:center;
  width:calc(var(--dshmem-hud-icon,20px) + 10px);height:calc(var(--dshmem-hud-icon,20px) + 10px);
  border-radius:9px;background:color-mix(in srgb,currentColor 7%,transparent)}
.dshmem_hud_glyph{flex:none;width:var(--dshmem-hud-icon,20px);height:var(--dshmem-hud-icon,20px);
  background-position:center;background-repeat:no-repeat;background-size:contain}
.dshmem_hud_title{flex:1 1 auto;min-width:0;font-size:13px;font-weight:600;letter-spacing:.2px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  color:var(--dshmem-hud-fg,inherit)}
.dshmem_hud_iconbtn{flex:none;width:24px;height:24px;padding:0;border:0;border-radius:8px;
  background:transparent;color:inherit;opacity:.42;cursor:pointer;font:inherit;font-size:15px;
  line-height:1;transition:opacity .16s ease,background-color .16s ease}
.dshmem_hud_iconbtn:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(15,23,42,.06))}
.dshmem_hud_iconbtn:focus-visible{outline:2px solid var(--dsw-static-deepseek-450,#4d6bfe);
  outline-offset:1px;opacity:1}
/* 更新时间：比正文再低一级，带一点字距，读起来像「元信息」而不是内容。 */
.dshmem_hud_time{margin:0 0 7px 1px;font-size:11px;line-height:1.5;letter-spacing:.2px;
  color:var(--dshmem-hud-dim,color-mix(in srgb,currentColor 52%,transparent))}
.dshmem_hud_body{max-height:min(50vh,360px);overflow:auto;word-break:break-word;
  font-size:12.5px;line-height:1.7;color:var(--dshmem-hud-fg,inherit)}
/* 固定高度：正文吃掉剩余空间，内部滚动（设置里 hudHeight > 0）。 */
.dshmem_hud_card[data-size="fixed"] .dshmem_hud_body{flex:1 1 auto;min-height:0;max-height:none}
/* 空态：一句结论 + 一句下一步，固定高度时竖直居中，不至于顶在角落。 */
.dshmem_hud_empty{display:flex;flex-direction:column;justify-content:center;gap:5px;
  color:var(--dshmem-hud-dim,color-mix(in srgb,currentColor 52%,transparent))}
.dshmem_hud_emptyTitle{font-size:12.5px;color:color-mix(in srgb,currentColor 70%,transparent)}
.dshmem_hud_emptyHint{font-size:11.5px;line-height:1.6}
.dshmem_hud_error{margin-top:8px;color:var(--dsw-alias-state-error-primary,#d54941);font-size:12px}
/* 右下角拖拽柄：三角形既是把手也是「这里能改大小」的提示。 */
.dshmem_hud_resize{position:absolute;right:1px;bottom:1px;width:18px;height:18px;
  border-radius:0 0 15px 0;cursor:nwse-resize;touch-action:none;opacity:.14;
  transition:opacity .16s ease;
  background:linear-gradient(135deg,transparent 50%,currentColor 50%)}
.dshmem_hud_card:hover .dshmem_hud_resize{opacity:.26}
.dshmem_hud_resize:hover{opacity:.5}
.dshmem_hud_pill{display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 13px 0 11px;
  border:1px solid var(--dshmem-hud-border,color-mix(in srgb,currentColor 12%,transparent));border-radius:999px;
  background:var(--dshmem-hud-bg,var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-primary,#fff)));
  color:var(--dshmem-hud-fg,inherit);
  box-shadow:0 10px 24px -14px rgba(15,23,42,.4),0 1px 4px rgba(15,23,42,.06);
  font:inherit;font-size:12.5px;cursor:pointer;
  transition:box-shadow .16s ease,transform .16s ease}
.dshmem_hud_pill .dshmem_hud_glyph{width:18px;height:18px}
.dshmem_hud_pill:hover{transform:translateY(-1px);
  box-shadow:0 14px 28px -14px rgba(15,23,42,.45),0 2px 6px rgba(15,23,42,.08)}
.dshmem_hud_pill:active{transform:translateY(0)}
/* 背景不透明度只混底色，文字保持清晰；不支持 color-mix 的宿主自动退回不透明底。
   只在真的调过透明度（data-translucent=1）时才走混色，默认外观与原来逐像素一致。 */
@supports (background:color-mix(in srgb,#fff 50%,transparent)){
  .dshmem_hud_card[data-translucent="1"]{background:color-mix(in srgb,
    var(--dshmem-hud-bg,var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-primary,#fff)))
    var(--dshmem-hud-bg-alpha,100%),transparent)}
  .dshmem_hud_pill[data-translucent="1"]{background:color-mix(in srgb,
    var(--dshmem-hud-bg,var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-primary,#fff)))
    var(--dshmem-hud-bg-alpha,100%),transparent)}
}
/* 半透明时补一层背景虚化：卡片浮在对话上也不糊字。 */
@supports (backdrop-filter:blur(2px)){
  .dshmem_hud_card[data-translucent="1"]{backdrop-filter:blur(14px) saturate(150%);
    -webkit-backdrop-filter:blur(14px) saturate(150%)}
  .dshmem_hud_pill[data-translucent="1"]{backdrop-filter:blur(10px) saturate(150%);
    -webkit-backdrop-filter:blur(10px) saturate(150%)}
}
/* 拖动中：抬升阴影 + 取消选中，手指划过正文也不会选到文字。 */
.dshmem_hud_card[data-dragging="1"]{cursor:grabbing;user-select:none;
  box-shadow:0 28px 52px -20px rgba(15,23,42,.46),0 4px 12px rgba(15,23,42,.1)}
.dshmem_hud_count{min-width:17px;height:17px;padding:0 5px;border-radius:999px;font-size:10px;
  display:inline-flex;align-items:center;justify-content:center;
  background:var(--dsw-static-deepseek-450,#4d6bfe);color:#fff}
/* 设置页的实时预览：复用卡片结构，只把宽度交给容器、去掉定位与投影。 */
.dshmem_hudPreview{margin-top:10px;padding:10px 12px 12px;box-shadow:none;
  border-radius:12px;width:100%;max-width:none}
.dshmem_hudPreview .dshmem_hud_head{margin-bottom:7px;cursor:default}
.dshmem_hudPreview .dshmem_hud_body{max-height:72px}
.dshmem_hudPreview .dshmem_hud_iconbtn{pointer-events:none;cursor:default}
.dshmem_hudPreviewLabel{display:flex;align-items:center;justify-content:space-between;
  gap:8px;font-size:11.5px;color:var(--dshmem-dim);margin-top:2px}
`;

    const CSS_TAG = "dsh-memory/Memory.module.css";
    /* 样式注入：同标记的 <style> 已存在时只换内容，不再追加第二份。
       宿主热重载插件时页面不会刷新，旧规则会一直留在文档里——只判断「有没有」
       会让新样式永远不生效（面板换了结构、却还是旧布局）。 */
    if (typeof document !== "undefined") {
      const marker = "style[data-plugin-css=" + JSON.stringify(CSS_TAG) + "]";
      const existing = typeof document.querySelector === "function" ? document.querySelector(marker) : null;
      if (existing) {
        if (existing.textContent !== css) existing.textContent = css;
      } else {
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-memory";
        tag.dataset.pluginCss = CSS_TAG;
        tag.textContent = css;
        document.head.appendChild(tag);
      }
    }

    /* ---------------------------------------------------------------- *
     * 宿主通信
     * ---------------------------------------------------------------- */

    // 文档相对：反代目录前缀与 dsh-app:// 外壳下同样可用。
    const baseUri = () =>
      (typeof document !== "undefined" && document.baseURI) || "http://127.0.0.1/";

    function url(path) {
      return new URL(String(path).replace(/^\/+/, ""), baseUri()).href;
    }

    async function request(method, path, { query, body, signal } = {}) {
      let target = url(`memory/api${path}`);
      if (query) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
          if (value === undefined || value === null || value === "") continue;
          params.set(key, String(value));
        }
        const qs = params.toString();
        if (qs) target += `?${qs}`;
      }
      const init = { method, signal, headers: {} };
      if (method !== "GET") {
        init.headers["content-type"] = "application/json";
        init.body = JSON.stringify(body ?? {});
      }
      const response = await fetch(target, init);
      const parsed = await response.json().catch(() => null);
      if (!response.ok || parsed === null || parsed.ok !== true) {
        const code = parsed?.error ? String(parsed.error) : `HTTP_${response.status}`;
        /*
         * detail 有两种形态：宿主半的 fail() 直接塞字符串（重写 / 迁移 / 整理），
         * 传输层错误则可能是 { message }。只认后者会把「没有可用的模型路由」
         * 这类可操作提示吞掉，面板上只剩一个 no_model_route。
         */
        const detailText =
          typeof parsed?.detail === "string"
            ? parsed.detail
            : parsed?.detail?.message || "";
        const detail = detailText ? ` — ${detailText}` : "";
        const error = new Error(`${code}${detail}`);
        error.code = code;
        error.detail = detailText ? String(detailText) : "";
        throw error;
      }
      return parsed;
    }

    const api = {
      state: (workspace, signal) => request("GET", "/state", { query: { workspace }, signal }),
      overview: (workspace, signal) => request("GET", "/overview", { query: { workspace }, signal }),
      list: (params, signal) => request("GET", "/list", { query: params, signal }),
      record: (query) => request("GET", "/record", { query }),
      save: (body) => request("POST", "/save", { body }),
      update: (body) => request("POST", "/update", { body }),
      bulk: (body) => request("POST", "/bulk", { body }),
      remove: (body) => request("POST", "/delete", { body }),
      redlineCheck: (body) => request("POST", "/redline/check", { body }),
      redlineUpdate: (body) => request("POST", "/redline/update", { body }),
      redlineHistory: (query) => request("GET", "/redline/history", { query }),
      redlineRollback: (body) => request("POST", "/redline/rollback", { body }),
      settings: (settings) => request("POST", "/settings", { body: { settings } }),
      mirror: (workspace) => request("GET", "/mirror", { query: { workspace } }),
      exportAll: (workspace) => request("GET", "/export", { query: { workspace } }),
      importAll: (body) => request("POST", "/import", { body }),
      importScan: (workspace) => request("GET", "/import-scan", { query: { workspace } }),
      importFromScan: (body) => request("POST", "/import-scan", { body }),
      capture: (workspace) => request("POST", "/capture", { body: { workspace } }),
      distill: (workspace, text) => request("POST", "/distill", { body: { workspace, text } }),
      health: (workspace, signal, opts = {}) => request("GET", "/health", { query: { workspace, ...opts }, signal }),
      healthResolve: (body) => request("POST", "/health/resolve", { body }),
      candidatesReject: (body) => request("POST", "/candidates/reject", { body }),
      injections: (workspace, signal, limit = 12) =>
        request("GET", "/injections", { query: { workspace, limit }, signal }),
      dream: (body) => request("POST", "/dream", { body }),
      backups: (signal, limit = 20) => request("GET", "/backups", { query: { limit }, signal }),
      backup: (body) => request("POST", "/backup", { body }),
      promote: (body) => request("POST", "/promote", { body }),
      derivations: (workspace, signal) => request("GET", "/derivations", { query: { workspace }, signal }),
      reviews: (workspace, signal, withinDays = 30) =>
        request("GET", "/reviews", { query: { workspace, withinDays }, signal }),
      review: (body) => request("POST", "/review", { body }),
      timeline: (workspace, signal) => request("GET", "/timeline", { query: { workspace }, signal }),
      queue: (workspace, signal) => request("GET", "/queue", { query: { workspace }, signal }),
      approve: (body) => request("POST", "/queue/approve", { body }),
      reject: (body) => request("POST", "/queue/reject", { body }),
      rollback: (body) => request("POST", "/supersede/rollback", { body }),
      briefPreview: (workspace, signal) => request("GET", "/briefing-preview", { query: { workspace }, signal }),
      sessionBrief: (session, limit = 12, signal) =>
        request("GET", "/session-brief", { query: { session, limit }, signal }),
      portrait: (workspace, signal) => request("GET", "/portrait", { query: { workspace }, signal }),
      /* 面板只展示全局画像：diff 固定走全局（后端 query.scope === 'global' → 根位 ''）。 */
      portraitDiff: (workspace, signal, from = "previous") =>
        request("GET", "/portrait/diff", { query: { workspace, from, scope: "global" }, signal }),
      savePortrait: (body) => request("POST", "/portrait/save", { body }),
      rewritePortrait: (body) => request("POST", "/portrait/rewrite", { body }),
      portraitMigrate: (body) => request("POST", "/portrait/migrate", { body }),
      /* 面板只展示全局画像：待审稿也固定走全局（后端 scope 缺省即 global）。 */
      portraitDraft: (workspace, signal) =>
        request("GET", "/portrait/draft", { query: { workspace, scope: "global" }, signal }),
      approveDraft: (body) => request("POST", "/portrait/draft/approve", { body }),
      discardDraft: (body) => request("POST", "/portrait/draft/discard", { body }),
      journal: (workspace, query, signal) =>
        request("GET", "/journal", { query: { workspace, ...(query || {}) }, signal }),
      mergeTags: (body) => request("POST", "/tags/merge", { body }),
    };

    /* ---------------------------------------------------------------- *
     * i18n
     * ---------------------------------------------------------------- */

    const NS = "settings.memory";

    const zh = {
      nav: "记忆",
      tabProject: "项目记忆",
      tabGlobal: "全局记忆",
      tabRedline: "红线",
      tabMaintain: "维护",
      tabCapture: "自动提炼",
      tabSettings: "设置",
      toolsTitle: "导入与工具",
      toolsHint: "导入 · 扫描 · 迁移 · 日志",
      rawToolsTitle: "写入与同步",
      rawEntriesTitle: "条目",
      entriesHint: "只列本范围的条目；另一个范围在顶部页签里。",
      globalEmpty: "还没有全局记忆",
      globalEmptyHint: "全局记忆是跨工作区通用的事实与偏好（例如「回复用中文」）。让模型存一条全局记忆，或者在这里新建，都会落到这个范围。",
      overviewTitle: "记忆概览",
      overviewHint: "只读：数据来自当前工作区的记忆库、画像与注入计量。",
      ovProject: "项目",
      ovGlobal: "全局",
      ovDrafts: "待审",
      ovRedlines: "红线",
      ovShare: "项目 / 全局占比",
      ovCategory: "类别分布",
      ovTrend: "近 7 天新增",
      ovBudget: "注入预算",
      ovPortrait: "画像覆盖",
      ovBudgetLine: "{used} / {max} 字 · {count} 条",
      ovPortraitLine: "{filled} / {total} 段有内容",
      ovEmpty: "还没有数据，先记一条再看。",
      ovNoPortrait: "还没有画像",
      viewGroup: "显示与视图",
      viewGroupHint: "改完立即生效、不用点保存；只影响这台设备上的面板，不改注入与记录行为。",
      uiView: "默认视图",
      uiGroupBy: "档案默认排布",
      uiDensity: "列表密度",
      uiDensityComfort: "宽松",
      uiDensityCompact: "紧凑",
      uiShowPortrait: "显示画像卡",
      uiShowStats: "显示统计行",
      uiShowBanner: "显示「刚刚记了什么」横幅",
      portraitTitle: "记忆画像",
      portraitEdit: "编辑画像",
      portraitEditSection: "编辑本段",
      portraitEmptySection: "段落内容不能为空。",
      evidenceTitle: "依据",
      evidenceOpen: "查看依据",
      evidenceMissing: "这条依据不在当前库（可能已归档或删除）。",
      evidenceEmpty: "这一天没有日志内容。",
      evidenceJournal: "工作日志",
      redlineAdd: "添加红线",
      redlineEdit: "编辑红线",
      redlineEditorEdit: "编辑红线",
      redlineTitlePh: "标题（例如：绝不覆盖生产数据）",
      redlineContentPh: "禁令原文。会逐字注入，模型不能改写。",
      redlineScope: "生效范围",
      redlineSource: "来源",
      redlineSourceUser: "你（面板）",
      redlineSourceAgent: "模型（工具）",
      redlineSourceAuto: "自动提炼",
      redlineSourceImport: "导入",
      redlinePreview: "注入预览",
      redlinePreviewHint: "简报里实际渲染为下面这一行；标题最多 200 字、正文最多 500 字，超出会截断。",
      redlineNeedBoth: "红线的标题和正文都不能为空。",
      redlineSaved: "红线已保存",
      redlineIdPending: "保存后生成 id",
      redlineOrderHint: "按加入时间排序",
      redlineCurrentVersion: "当前生效",
      redlineConflictHit: "与现有红线疑似矛盾：",
      redlineBackToEdit: "返回修改",
      redlineSaveAnyway: "仍然保存",
      redlineHistory: "历史",
      redlineHistoryTitle: "红线历史",
      redlineHistoryHint: "旧版本按替换时间排列；回滚会先把当前版本写回历史。",
      redlineHistoryEmpty: "还没有旧版本。",
      redlineRolledBack: "红线已回滚",
      redlineEmptyHint: "还没有红线。添加后会被逐字注入，模型不能修改；解除需要你在面板确认。",
      attentionTitle: "需要处理",
      attentionNone: "没有需要处理的项",
      attentionAuto: "自动维护中",
      attentionAutoHint: "矛盾 / 过期 / 复审 / 容量由插件自己处理，只有隔离内容和真正失效的复审才会找你",
      attentionHint: "隔离草稿 / 连续未验证的复审；其余由插件自动处理",
      attentionGo: "去整理",
      attentionMore: "查看全部",
      attentionOther: "其他体检问题",
      filters: "筛选",
      maintainGroupTodo: "需要我处理",
      maintainGroupState: "系统状态",
      maintainGroupHistory: "历史记录",
      settingsGroupInject: "注入",
      settingsGroupCapture: "记录",
      settingsGroupDistill: "二级蒸馏",
      settingsGroupGovernance: "治理",
      settingsGroupAdvanced: "高级与数据",
      settingsGroupConversation: "当前对话",
      sessionMemory: "该对话记忆",
      sessionMemoryHint: "默认开启；关闭后只隐藏本对话的前台会话卡，不影响长期记忆与其它对话。",
      sessionMemoryOn: "开启",
      sessionMemoryOff: "关闭",
      sessionMemoryNoSession: "当前没有可识别的对话",
      search: "搜索记忆…",
      allCategories: "全部",
      scopeWorkspace: "本工作区",
      scopeGlobal: "全局",
      showArchived: "含已归档",
      scopeProject: "项目记忆",
      scopeGlobalFull: "全局记忆",
      viewDoc: "档案",
      viewList: "列表",
      groupByTag: "按标签分组",
      groupByCategory: "按类型分组",
      groupByNone: "整篇文档",
      groupByTimeline: "时间线（含归档）",
      ungrouped: "未归类",
      consolidate: "整合",
      consolidateHint: "把本组的记忆合并成一条，原条目归档（红线不参与）",
      consolidateConflict: "这组里有疑似矛盾的记忆，先到维护页处理矛盾对，不能直接合并",
      consolidateRedline: "红线不参与整合",
      consolidated: "已整合为一条新记忆，原条目已归档（勾选「含已归档」可查看）",
      manageMemory: "记忆文档",
      manageHint: "整篇查看与维护：整理同标签条目、整篇编辑或导入 JSON；红线禁令单独置顶。",
      docAddHint: "想加记忆不用在这里填表：直接在对话里说「记住 ……」，这段正文会自己更新。",
      tidy: "整理",
      tidyNothing: "没有可整理的标签分组（同一标签下至少两条普通记忆才会合并；红线不参与）",
      tidyConflict: "有分组含疑似矛盾或红线，已跳过；先到维护页处理矛盾对",
      tidySkipped: "跳过 {n} 组（含矛盾或红线）",
      tidied: "已整理 {n} 组，合并稿入库、原条目归档",
      editDoc: "编辑",
      docEditHint: "整篇编辑：`## 分区` 起一段，`**标题**` 起一条，正文跟在标题后面。删掉整条会把它归档（不删除）。",
      docSaved: "已保存：写入/更新 {n} 条，归档 {a} 条",
      docFooter: "记忆保存在 {path}，仅保存在你的设备上",
      docFooterGlobal: "全局记忆保存在本机主库的 workspaces/_global/，跨工作区共享、不随项目走。",
      docAuto: "对话记忆",
      docAutoHint: "记住对话中的重要信息，让后续回答更贴合你。",
      docLocal: "本地记忆与技能",
      docLocalHint: "自动记录工作过程，并镜像一份到工作区的 .dsh-memory/MEMORY.md，数据仅保存在你的设备上。",
      untitled: "（未命名）",
      sort: "排序",
      sortUpdated: "最近更新",
      sortCreated: "最近创建",
      sortTitle: "标题",
      refresh: "刷新",
      newMemory: "新建记忆",
      pinned: "置顶",
      archived: "已归档",
      globalTag: "全局",
      chipTainted: "可疑",
      chipTaintedHint: "命中注入模式；非用户来源的记录已被隔离成草稿，等你在待审队列处理。",
      chipRedacted: "已脱敏",
      chipRedactedHint: "写入时命中密钥模式，对应内容已替换为 [REDACTED:*]。",
      chipExternal: "外部来源",
      chipExternalHint: "来自网页/工具输出等外部内容，参考时请先验证。",
      empty: "这个工作区还没有记忆",
      emptyHint: "会话中模型调用 memory 工具保存，或在这里手工新建。",
      firstRunTitle: "先让它记住第一件事",
      firstRunWhy: "自动提炼默认是关的：开了之后一轮对话结束就会自动把值得留的内容写成记忆；不开则完全由你和模型显式调用 memory 工具决定。选一条路开始就行。",
      firstRunStep1: "在对话里说「记住……」——模型会用 memory 工具落库（推荐）",
      firstRunStep2: "打开自动提炼：每轮结束自动沉淀；需要审核时再切到 review（只审高风险）或 draft（全部进队列）",
      firstRunStep3: "把别处已经有的记忆搬过来：维护页可扫描 WorkBuddy / Qoder / Claude Code / Codex 的记忆文件",
      firstRunAuto: "开启自动提炼",
      firstRunAutoOn: "自动提炼已开启，下轮对话结束就会开始沉淀",
      firstRunCreate: "手写一条",
      firstRunScan: "去维护页扫描导入",
      loading: "读取中…",
      workspace: "工作区",
      projectOnlyHint: "项目记忆只显示这个工作区的记忆；全局记忆在「全局记忆」页签里。",
      projectMirrorTitle: "工作区 MEMORY.md",
      projectMirrorHint: "这个工作区里的离线记忆文件，由记忆库生成；没装插件的机器也能直接读。",
      projectMirrorShow: "查看文件",
      projectMirrorHide: "收起文件",
      projectMirrorEmpty: "这个工作区还没有生成 MEMORY.md：打开设置里的镜像开关，或先保存一条记忆。",
      projectActive: "当前对话",
      projectSwitchHint: "切换后只影响「项目记忆」页签，不会改动全局记忆。",
      total: "共",
      unit: "条",
      pinnedCount: "置顶",
      globalCount: "全局",
      edit: "编辑",
      pin: "置顶",
      unpin: "取消置顶",
      archive: "归档",
      unarchive: "取消归档",
      remove: "删除",
      confirmRemove: "确定删除这条记忆？",
      save: "保存",
      cancel: "取消",
      formNew: "新建记忆",
      formEdit: "编辑记忆",
      fTitle: "标题",
      fTitlePh: "一句话说清这条记忆是什么",
      fContent: "内容",
      fContentPh: "事实本身，以及让它有用的原因或证据",
      fCategory: "类别",
      fTags: "标签",
      fTagsPh: "用逗号分隔",
      fScope: "范围",
      fPinned: "置顶（总是优先注入）",
      errTitle: "标题和内容至少要填一个",
      sBriefing: "会话开始时注入记忆摘要",
      sBriefingHint: "把本工作区最重要的记忆放进系统提示，模型一开场就知道。",
      sLimit: "注入条数上限",
      sChars: "注入字数上限",
      sPortraitChars: "画像预算（字数）",
      sAuto: "轮次结束时自动提炼",
      sAutoHint: "每轮对话结束后用模型归纳出值得长期保留的事实。会消耗额外 token。",
      sGlobalDistill: "开启二级蒸馏",
      sGlobalDistillHint: "把本项目的教训抽成跨项目原则。关掉只是不再往上抽，已进池的候选照常按门槛晋升。",
      sGlobalDistillMinNew: "素材门槛（条）",
      sGlobalDistillCooldown: "基础间隔（分钟）",
      sGlobalDistillCadenceHint: "未提炼素材达到门槛才尝试；连续空跑按 2 倍退避，最多 24 小时，有产出就回到基础间隔。",
      sAutoMin: "最短对话长度",
      sCooldown: "提炼最小间隔（毫秒）",
      sMinConf: "最低置信度",
      sMaxTurn: "每次最多落库条数",
      sTranscript: "对话摘录字数上限",
      sMirror: "在工作区生成 .dsh-memory/MEMORY.md",
      sMirrorHint: "人类可读的镜像文件，方便直接看和提交。主库始终在 ~/.dsh/storages/dsh-memory。",
      sDedupe: "自动合并高度相似的记忆",
      sQualityGate: "低分记忆自动归档",
      sQualityGateHint: "自动提炼 / 模型主动写入的条目，质量分低于 30 直接归档、不进简报；手工与导入的记忆不受影响。",
      sCaptureSub: "子代理会话也参与自动提炼",
      sCaptureSubHint: "默认关闭：派活的中间过程不写成长期记忆。",
      reasonLabel: "理由",
      qualityChip: "质量",
      sEnabled: "启用记忆系统",
      saved: "已保存设置",
      captureNow: "提炼当前会话",
      capturing: "提炼中…",
      captureLog: "最近提炼记录",
      captureEmpty: "还没有提炼记录",
      distillTitle: "粘贴一段文本做提炼",
      distillPh: "把一段对话、日志或笔记粘进来，模型会抽出值得长期保留的记忆。",
      distill: "提炼",
      distilling: "提炼中…",
      candidates: "候选记忆",
      adopt: "全部保存",
      adopted: "已保存",
      noCandidates: "没有抽到值得保留的内容",
      mirrorTitle: "镜像文件",
      mirrorEmpty: "还没有生成镜像文件（保存一条记忆后就会出现）",
      mirrorLoading: "正在读取镜像内容…",
      mirrorPresent: "已生成",
      mirrorAbsent: "未生成",
      mirrorStorage: "主库旁车",
      mirrorGlobal: "（全局记忆没有工作区镜像）",
      copy: "复制",
      copied: "已复制",
      copyFailed: "复制失败：请手动选中文本复制",
      exportTitle: "备份与迁移",
      exportDo: "导出 JSON",
      importDo: "导入 JSON",
      importPh: "粘贴导出内容或纯文本（空行分段，首行为标题）",
      imported: "导入完成",
      formatLabel: "文本格式",
      formatDetected: "识别为 {f}",
      format_auto: "自动识别",
      format_workbuddy: "WorkBuddy 笔记",
      format_qoder: "Qoder 记忆",
      format_daily: "每日日志",
      format_text: "纯文本",
      scanTitle: "从本机既有记忆导入",
      scanHint: "扫描 Qoder、WorkBuddy 与本插件镜像留下的记忆文件，按「一条记忆」拆好再入库；只读来源，不会改动原文件。",
      scanDo: "扫描本机",
      scanning: "扫描中…",
      scanAll: "全部导入",
      scanOne: "导入这个来源",
      scanFiles: "{n} 个文件",
      scanAbsent: "未找到",
      scanGlobal: "用户级",
      scanWorkspace: "工作区级",
      scanNothing: "没有扫描到可导入的记忆文件",
      scanImported: "已导入 {n}",
      tlHint: "全部记忆按更新时间排列，含已归档；点条目可直接编辑。",
      tlSearch: "在时间线里过滤…",
      recentTitle: "刚刚记了什么",
      recentHint: "过去 24 小时新增或更新 {n} 条；确认它们值得长期保留，不顺眼的就地归档。",
      recentSummary: "24h 内 +{n} 条",
      recentOpen: "展开",
      recentClose: "收起",
      briefPreviewTitle: "下次会话将注入",
      portraitWorkspaceEmptyHint: "还没有全局画像；点「重写画像」从记忆生成，或用下面的「从其它 App 迁移画像」导入。",
      migrateTitle: "从其它 App 迁移画像",
      migrateHint: "把下面的提示词复制到别的应用（Claude Code / ChatGPT 等）发给它的 AI，让它总结出你的画像；把它的回答粘贴到这里，与本插件的全局画像整合。",
      migratePrompt: "请回顾你在本应用中掌握的关于我的全部长期信息（身份与背景、工作偏好、协作约定、近期关注），总结成一份用户画像。只输出 JSON，不要其他文字：{\"background\":\"我是谁：角色、技术背景、长期目标\",\"preference\":\"我怎么工作：语言、风格、工具偏好、约定\",\"focus\":\"当前在做什么、优先级\",\"recent\":\"近期形成的新习惯或新结论\"}。要求：只写跨项目长期有效的信息，不写一次性任务细节；用我的常用语言；每段 2-5 句。",
      migrateCopy: "复制提示词",
      migrateCopied: "提示词已复制",
      migratePh: "粘贴那边 AI 的回答（JSON）…",
      migrateDo: "导入并整合",
      migrateDone: "已与全局画像整合",
      portraitDiff: "这次变了什么",
      portraitDiffClose: "收起变化",
      portraitPromote: "写进 AGENTS.md",
      portraitPromoted: "已写入 AGENTS.md（{n} 行；画像改写后这里会被标脏）",
      portraitDiffTitle: "画像变化（上一版 → 当前版）",
      portraitDiffLoading: "正在对比版本…",
      portraitDiffNoPrevious: "只有一版画像，还没有可对比的上一版。",
      portraitDiffEmpty: "这一版没有变化。",
      portraitDiffFrom: "v{from} → v{to}",
      portraitSubtitle: "工作区与全局的「档案摘要」——「现在是什么样」写在这里，「不会过期的知识」才进条目。",
      portraitCharsUnit: "{n} 字",
      portraitWorkspaceLabel: "工作区画像",
      portraitGlobalLabel: "全局画像",
      portraitStored: "portrait.json 维护",
      portraitFromMd: "来自 PORTRAIT.md（首次保存后落盘）",
      portraitEditHint: "按 `**段标题**` 分段：工作背景 / 协作约定（全局版为「个人背景」）/ 当前关注 / 近期动态。",
      portraitSaved: "画像已保存（v{v}）",
      portraitEmptySections: "至少要保留一个带标题的段落",
      portraitEmpty: "还没有画像。点「重写画像」从日志与条目生成一份，也可以在这里手写。",
      portraitRewrite: "立即刷新",
      portraitAutoOn: "自动更新：每 {hours} 小时检查一次，有新素材才调用模型（WorkBuddy 式主路径）",
      portraitAutoOff: "自动更新已关闭；画像只能手动刷新",
      portraitAutoAt: "上次更新：{when}",
      portraitAutoHint: "「立即刷新」只是兜底；正常情况下画像会在使用过程中自动更新。",
      hudTitle: "会话记忆",
      hudOpen: "展开会话记忆卡",
      hudCollapse: "收起会话记忆卡",
      hudDrag: "按住拖动，移动会话卡",
      hudUpdated: "更新于 {when}",
      hudSummary: "本会话记住了 {n} 条：{list}。",
      hudNoSaved: "本会话还没有沉淀记忆。",
      hudEmptyHint: "聊几句后，这里会自动出现本会话记住的事。",
      hudError: "读取失败：{message}",
      hudIconLabel: "会话卡图标",
      hudIconHint: "默认官方鲸鱼标；二创位图图标在设置保存后立即生效。",
      hudIconSizeLabel: "图标大小",
      hudIconSizeHint: "只改这台机器上的卡片长相，不进工作区记忆；拖动滑杆时下方预览实时跟着变。",
      hudPreviewLabel: "实时预览",
      hudPreviewBody: "本会话记住了 3 条：卡片配色、拖动位置、图标大小。",
      hudIconA: "官方鲸鱼标（默认）",
      hudIconB: "官方 App 图标",
      hudIconC: "可爱鲸鱼",
      hudIconD: "深蓝鲸鱼",
      hudIconE: "鲸鱼娘 · 女仆装",
      hudIconF: "鲸鱼娘 · 眨眼",
      hudIconG: "鲸鱼娘 · Q 版",
      hudWidthLabel: "卡片宽度",
      hudHeightLabel: "卡片高度",
      hudHeightAuto: "自动",
      hudHeightAutoHint: "回到随内容自适应的高度",
      hudOpacityLabel: "背景不透明度",
      hudColorLabel: "背景颜色",
      hudColorAuto: "跟随主题",
      hudLookHint: "拖动卡片右下角也能改大小；尺寸与配色随「保存」写进设置，换机器也一致。",
      hudResize: "拖动调整卡片大小",
      portraitRewritingShort: "重写中…",
      portraitRewriting: "正在重写画像（合并日志与条目，请稍候）…",
      portraitRewritten: "画像已重写并保存",
      portraitDrafted: "重写稿已存入待审",
      portraitRewriteDegraded: "模型输出有损（截断或格式坏掉），重写稿已存入待审，请逐段确认后再批准",
      portraitDraftHint: "有一份重写稿待批准（批准后生效、旧版留档）",
      portraitDraftView: "预览",
      portraitDraftHide: "收起预览",
      portraitDraftApprove: "批准",
      portraitDraftDiscard: "丢弃",
      portraitDraftApproved: "重写稿已批准，画像已更新",
      portraitDraftDiscarded: "重写稿已丢弃",
      journalTitle: "工作日志",
      journalHint: "完成实质工作后自动追记的流水账",
      journalSummary: "{n} 天",
      journalEmpty: "还没有日志。完成实质工作后，对话里会自动追记一条。",
      briefChip: "简报",
      tagMergeTitle: "标签清理",
      tagMergeHint: "写法不同、意思相同的标签（如 DSH / dsh）合并成一个；大小写不影响检索。",
      tagMergeVariants: "候选：{variants}",
      tagMergeDo: "合并为 {tag}",
      tagMerged: "已合并标签：{n} 条记忆更新",
      healthHint: "重复、过期与断链的体检结果；合并可撤销（原条目归档），归档可恢复。",
      healthOverBudget: "库规模超预算",
      healthContradictions: "矛盾线索（仅诊断）",
      healthContradictionsHint: "词法线索，不是语义判定，也不计入「需要处理」。想清理时再点「按时序归档旧条」；红线 / 置顶 / 你手写的旧条永远保留。",
      healthContradictionScan: "扫描矛盾线索",
      healthContradictionScanOff: "收起矛盾线索",
      healthContradictionScanHint: "默认不扫描。词法线索误报率高，只有你点一下才诊断；结果仅供查看，不会自动归档。",
      healthDeadFiles: "文件引用失效",
      healthDeadFilesHint: "记忆挂靠的文件已不存在（可能被移动或删除）。",
      redlineTitle: "红线（绝对禁令）",
      redlineHint: "绝对禁令会逐字注入、永久置顶；模型不能修改或解除，只有你能在面板确认后撤销。",
      redlineRemove: "解除红线",
      redlineConfirm: "解除后模型将不再受这条禁令约束，确定？",
      dreamTitle: "Dream · 立即整理（补跑）",
      dreamHint: "自动整理是主路径（启动时检查 + 轮末按需）；这里只在你现在就想整理一次时用：合并重复簇（原条目归档可恢复；红线不参与，置顶结果保持置顶）、复审到期自动续期（连两轮零引用才升级给人）、矛盾只做诊断、过期未用只报告。画像重写直接落库（跟随「画像重写落库方式」，默认 direct）。",
      dreamRun: "立即整理",
      dreamRunning: "整理中…",
      dreamDone: "Dream 完成",
      dreamSummary: "合并 {merged} 簇 ｜ 复审续期 {reviews} 条 ｜ 过期未用 {stale} 条 ｜ 曝光未用 {unused} 条（仅报告） ｜ 画像：{portrait}",
      dreamPortraitDrafted: "已进待审",
      dreamPortraitSaved: "已保存",
      dreamPortraitDegraded: "模型输出有损（截断或格式坏掉），已直接落库；可在画像卡回滚上一版",
      dreamPortraitNone: "未触发",
      dreamPortraitSkipped: "已跳过（{reason}）",
      dreamContradictionsResolved: "按时序归档 {n} 条旧结论",
      dreamContradictionResolvedLine: "旧结论「{old}」→ 新结论「{kept}」",
      dreamContradictionsPending: "{n} 条矛盾需要你确认",
      dreamContradictionPendingLine: "「{a}」⇄「{b}」：{reason}",
      contradictionReasonRedline: "旧条是红线，不自动归档",
      contradictionReasonPinned: "旧条已置顶",
      contradictionReasonUserOlder: "旧条是你手写，新条不是",
      contradictionReasonExternalNewer: "新条来自外部内容",
      contradictionReasonMixedScope: "跨工作区 / 全局",
      contradictionReasonArchived: "条目已归档或为草稿",
      contradictionReasonFailed: "归档失败",
      contradictionReasonNeedsConfirm: "词法线索，等你确认",
      healthTimeOrder: "按时序归档旧条",
      dreamSkipNoRoute: "没有可用的模型会话",
      dreamSkipNoMaterial: "没有可重写的原料",
      dreamSkipDisabled: "记忆系统未启用",
      dreamSkipRunning: "画像正在重写",
      dreamSkipNoWorkspace: "没有工作区",
      dreamSkipUnknown: "条件不满足",
      dreamStepPortrait: "画像",
      dreamStepMerge: "合并",
      dreamStepContradictions: "矛盾",
      dreamErrorUnknown: "未知错误",
      dreamMergedLine: "合并 {count} 条 → {title}",
      dreamErrors: "{n} 步出错",
      dreamAutoTitle: "自动整理 · 打开 DSH 时",
      dreamAutoHint: "每次打开 DSH 后检查一次当前工作区：距上次整理满 {days} 天，就在后台自动整理（合并重复簇、按时序归档旧结论、报告过期未用）。没有常驻定时器，也不占用对话轮次。画像重写：{portrait}。",
      dreamAutoOffHint: "已关闭。在「设置 → 治理」把「启动整理间隔」设为大于 0 的天数即可开启。",
      dreamAutoPortraitOn: "跟随「画像重写落库方式」（direct 直接落库 / draft 进待审）",
      dreamAutoPortraitOff: "已关闭（只做本地整理）",
      dreamLastTidy: "上次整理：{when}",
      dreamAutoNever: "打开 DSH 后会自动检查；目前还没跑过",
      dreamAutoNext: "到期日：{when}（下次打开 DSH 时检查）",
      dreamAutoSummary: "上次结果：合并 {merged} 簇 ｜ 复审续期 {reviews} 条 ｜ 画像：{portrait}",
      dreamAutoPortraitLine: "画像自动刷新：每 {hours} 小时检查 ｜ 上次更新 {when}",
      dreamAutoPortraitDisabled: "画像自动刷新已关闭（画像只能手动刷新）",
      sAutoDreamDays: "启动整理间隔（天）",
      sAutoDreamPortrait: "启动整理顺带重写画像",
      sAutoDreamPortraitHint: "会多一次模型调用；默认关，画像由「自动刷新画像」负责。",
      sAutoPortraitHours: "自动刷新画像间隔（小时）",
      sAutoPortraitHoursHint: "0 = 关闭。有新素材时才调用模型；这是画像的主更新路径（WorkBuddy 式）。",
      promoteBtn: "晋升到 AGENTS.md",
      promoteHint: "把这条写进工作区 AGENTS.md 的托管块（重复晋升不会产生重复行；块外内容可自由编辑）。",
      promoted: "已晋升进 {file}",
      pathTailHint: "最近一次路径注入 {n} 条 · ≈{tokens} token",
      healthKpiTotal: "记忆总数",
      healthKpiUtil: "被用过",
      healthKpiDrafts: "待审草稿",
      healthToken: "简报注入",
      healthTokenIndex: "索引模式（一行一条）",
      healthTokenFull: "全文模式（标题+摘录）",
      healthTokenLast: "最近一次注入",
      healthTokenEst: "≈ {tokens} token / 次请求（按字符粗估）",
      healthTokenNone: "还没有渲染过简报（会话开始后出现）",
      healthProblems: "体检结果",
      healthDuplicates: "重复记忆",
      healthDuplicatesHint: "内容高度相似，合并成一条；原条目会归档，可恢复。",
      healthStale: "过期未用",
      healthStaleHint: "超过 {days} 天从未被打开或引用且未置顶；确认没用就归档。",
      healthExposedUnused: "曝光未用",
      globalCandidatesTitle: "全局候选池",
      globalCandidatesHint: "整理时从本项目提炼的通用原则，够格的会自动升为全局记忆；不对的点「不再提议」，之后同主题不再出现。",
      globalCandidatesStats: "待判定 {pending} 条 ｜ 已晋升 {promoted} ｜ 已否 {rejected}",
      globalCandidatesReject: "不再提议",
      globalCandidatesNone: "还没有候选原则——素材达到门槛后会在轮末自动尝试，够不上标准就不产出。",
      globalDistillLast: "上次二级蒸馏：{when} ｜ 素材 {materials} 条 ｜ 解析 {parsed} 条 ｜ 新增 {added} 条",
      globalDistillNever: "还没有跑过二级蒸馏；素材达到门槛后会在轮末自动尝试。",
      globalDistillEmpty: "上次没有产出（{reason}）",
      globalDistillDuplicate: "本次提炼的原则都已在候选池里（未新增），节奏会自动放慢",
      globalDistillRejects: "拒绝原因：{reasons}",
      globalDistillInterval: "节奏：基础 {base} 分钟，连续空跑翻倍退避（最多 24 小时）；下次允许 {next}",
      globalDistillExcerpt: "模型原文（脱敏，最多 600 字）",
      distillReasonEmpty: "模型回了空数组",
      distillReasonAllRejected: "候选都被准入挡掉",
      distillReasonBadJson: "JSON 解析失败",
      distillReasonNotArray: "返回的不是数组",
      distillReasonNone: "没有返回数组",
      distillReasonLlmError: "模型调用失败",
      distillReasonNoMaterial: "素材不足",
      healthExposedUnusedHint: "被注入或检索到至少 3 次，但从未被显式打开、也未被答案引用；建议复核内容或归档。",
      injectionTitle: "注入审计",
      injectionHint: "每次真正进 prompt 的内容：字节数、hash、带了哪些记忆、谁被预算挤掉。",
      backupTitle: "整库快照",
      backupHint: "每天第一次写入、以及每次 Dream 之前都会自动整库复制一份，保留最近 7 份。误删或清空后，把任意一份拷回库目录即可恢复——面板不会自动覆盖当前数据。",
      backupRoot: "备份目录",
      backupRun: "立即备份",
      backupEmpty: "还没有快照（写一条记忆后自动出现）",
      backupDone: "备份完成：{name}",
      injectionNone: "还没有注入记录。",
      injectionKindBriefing: "简报",
      injectionKindTurnRecall: "尾部召回",
      injectionKindPathRecall: "路径召回",
      injectionDropped: "挤掉 {n} 条",
      derivationTitle: "派生链",
      derivationHint: "记忆 → 画像 → AGENTS.md：每一层记下它是从哪儿抄来的，源失效时这层会被标脏。",
      derivationNone: "还没有派生记录（保存画像或晋升到 AGENTS.md 后出现）。",
      derivationLayerPortrait: "画像",
      derivationLayerAgents: "AGENTS.md",
      derivationFresh: "仍成立",
      derivationDirty: "已失效",
      derivationSources: "源",
      reviewTitle: "复审队列",
      reviewHint: "带失效条件的记忆到期后进这里：回来看一眼「它还成立吗」。",
      reviewNone: "没有到期或即将到期的复审项。",
      reviewDue: "已到期",
      reviewSoon: "即将到期",
      reviewFalsifier: "失效条件",
      reviewDone: "已复审",
      reviewSummary: "已到期 {due} 条 ｜ 即将到期 {soon} 条",
      reviewTruncated: "仅列出前 {n} 条",
      chipFalsifier: "有失效条件",
      chipReviewDue: "待复审",
      portraitEvidence: "参考",
      portraitUntraced: "未溯源",
      healthBroken: "断链",
      healthBrokenHint: "指向不存在记忆的关联，摘掉即可。",
      healthNone: "没有发现问题",
      healthMerge: "合并",
      healthArchive: "归档",
      healthArchiveAll: "全部归档",
      healthUnlink: "摘除断链",
      healthGoQueue: "去审批",
      queueTitle: "待审草稿",
      queueHint: "自动提炼（草稿模式）产出的候选先到这里，批准后才会被注入简报与检索。",
      queueEmpty: "没有待审草稿",
      queueApprove: "批准",
      queueEditApprove: "编辑后批准",
      queueReject: "拒绝",
      queueApproved: "已批准生效",
      queueRejected: "已拒绝",
      queueSupersedes: "批准后推翻旧条",
      confirmReject: "拒绝并删除这条草稿？（草稿从未生效，删除不留档）",
      chainSupersedes: "↩ 推翻了旧条",
      chainSupersededBy: "被新条推翻",
      rollback: "回滚",
      confirmRollback: "回滚这条版本链？旧条会恢复生效，新条归档。",
      supersedeBtn: "推翻",
      supersedesHint: "以新结论替换旧条：旧条归档（可回滚），这条生效。",
      fRelated: "关联记忆 id",
      fRelatedPh: "逗号分隔的记忆 id，允许悬空",
      fSupersedes: "推翻记忆 id",
      fSupersedesPh: "留空表示不推翻任何条目",
      draftChip: "草稿",
      modeIndex: "索引模式（一行一条）",
      modeFull: "全文模式（标题+摘录）",
      modePortrait: "画像模式（画像 + 索引）",
      sBriefMode: "简报注入形态",
      sAutoInject: "自动注入记忆",
      sAutoInjectHint: "总闸：关掉后简报、轮末召回、路径召回都不再往上下文里加记忆，工具仍可手动读写（「只用工具」档）。",
      sTurnRecall: "轮末相关召回",
      sTurnRecallHint: "每轮结束后按当轮内容本地检索相关记忆，下一轮随简报注入。纯本地打分，不花模型 token。",
      sTurnRecallLimit: "每轮召回条数",
      sDiscipline: "记忆纪律",
      sDisciplineHint: "在简报里告诉模型何时写什么（含「记住/忘掉/更新记忆」等对话内指令）。",
      sRewriteMode: "画像重写方式",
      rewriteDirect: "直接生效",
      rewriteDraft: "先进待审",
      sJournalDays: "重写读取日志天数",
      sCaptureMode: "提炼写入方式",
      captureDirect: "直接落库",
      captureReview: "只审高风险",
      captureDraft: "全部草稿审批",
      sStaleDays: "体检的过期阈值（天）",
    };

    const en = {
      nav: "Memory",
      tabProject: "Project",
      tabGlobal: "Global",
      tabRedline: "Redlines",
      tabMaintain: "Maintenance",
      tabCapture: "Distillation",
      tabSettings: "Settings",
      toolsTitle: "Import & tools",
      toolsHint: "Import · Scan · Migration · Journal",
      rawToolsTitle: "Capture & sync",
      rawEntriesTitle: "Entries",
      entriesHint: "Entries in this scope only; switch the tab above for the other scope.",
      globalEmpty: "No global memories yet",
      globalEmptyHint: "Global memories are facts and preferences shared across workspaces (for example \"reply in Chinese\"). Ask the model to save one globally, or create one here — both land in this scope.",
      overviewTitle: "Memory overview",
      overviewHint: "Read-only: numbers come from this workspace's memory store, portrait and injection meter.",
      ovProject: "Project",
      ovGlobal: "Global",
      ovDrafts: "Drafts",
      ovRedlines: "Redlines",
      ovShare: "Project / global share",
      ovCategory: "Categories",
      ovTrend: "Added in 7 days",
      ovBudget: "Injection budget",
      ovPortrait: "Portrait coverage",
      ovBudgetLine: "{used} / {max} chars · {count} entries",
      ovPortraitLine: "{filled} / {total} sections filled",
      ovEmpty: "Nothing yet — save one memory first.",
      ovNoPortrait: "No portrait yet",
      viewGroup: "Display",
      viewGroupHint: "Applies immediately — no save needed. Only affects the panel on this device; injection and capture behaviour stay unchanged.",
      uiView: "Default view",
      uiGroupBy: "Default document layout",
      uiDensity: "List density",
      uiDensityComfort: "Comfortable",
      uiDensityCompact: "Compact",
      uiShowPortrait: "Show portrait card",
      uiShowStats: "Show stats row",
      uiShowBanner: "Show the 'just recorded' banner",
      portraitTitle: "Memory portrait",
      portraitEdit: "Edit portrait",
      portraitEditSection: "Edit section",
      portraitEmptySection: "Section text cannot be empty.",
      evidenceTitle: "Evidence",
      evidenceOpen: "View evidence",
      evidenceMissing: "This evidence is not in the current library (archived or deleted).",
      evidenceEmpty: "No journal text for this day.",
      evidenceJournal: "Work journal",
      redlineAdd: "Add redline",
      redlineEdit: "Edit redline",
      redlineEditorEdit: "Edit redline",
      redlineTitlePh: "Title (e.g. Never overwrite production data)",
      redlineContentPh: "The ban as written. It is injected verbatim and cannot be rewritten by the model.",
      redlineScope: "Scope",
      redlineSource: "Source",
      redlineSourceUser: "You (panel)",
      redlineSourceAgent: "Model (tool)",
      redlineSourceAuto: "Auto-capture",
      redlineSourceImport: "Import",
      redlinePreview: "Injection preview",
      redlinePreviewHint: "This is the exact line rendered in the briefing; title is capped at 200 chars and content at 500.",
      redlineNeedBoth: "A redline needs both a title and content.",
      redlineSaved: "Redline saved",
      redlineIdPending: "id generated on save",
      redlineOrderHint: "Oldest first",
      redlineCurrentVersion: "Currently active",
      redlineConflictHit: "Suspected conflict with existing redlines:",
      redlineBackToEdit: "Back to edit",
      redlineSaveAnyway: "Save anyway",
      redlineHistory: "History",
      redlineHistoryTitle: "Redline history",
      redlineHistoryHint: "Older versions by replacement time; rolling back writes the current version into history first.",
      redlineHistoryEmpty: "No older versions yet.",
      redlineRolledBack: "Redline rolled back",
      redlineEmptyHint: "No redlines yet. Added redlines are injected verbatim and cannot be rewritten by the model; removal needs your confirmation here.",
      attentionTitle: "Needs attention",
      attentionNone: "Nothing needs your attention",
      attentionAuto: "Auto-maintaining",
      attentionAutoHint: "Contradictions, staleness, reviews and capacity are handled automatically; only quarantined items and genuinely dead reviews reach you",
      attentionHint: "Quarantined drafts / repeatedly unverified reviews; everything else is handled automatically",
      attentionGo: "Open maintenance",
      attentionMore: "View all",
      attentionOther: "Other health issues",
      filters: "Filters",
      maintainGroupTodo: "Needs my input",
      maintainGroupState: "System status",
      maintainGroupHistory: "History",
      settingsGroupInject: "Injection",
      settingsGroupCapture: "Capture",
      settingsGroupDistill: "Global distillation",
      settingsGroupGovernance: "Governance",
      settingsGroupAdvanced: "Advanced & data",
      settingsGroupConversation: "Current conversation",
      sessionMemory: "Memory for this conversation",
      sessionMemoryHint: "On by default. When off, the foreground card hides for this conversation only; long-term memory and other conversations are unaffected.",
      sessionMemoryOn: "On",
      sessionMemoryOff: "Off",
      sessionMemoryNoSession: "No conversation detected right now",
      search: "Search memories…",
      allCategories: "All",
      scopeWorkspace: "This workspace",
      scopeGlobal: "Global",
      showArchived: "Include archived",
      scopeProject: "Project memory",
      scopeGlobalFull: "Global memory",
      viewDoc: "Profile",
      viewList: "List",
      groupByTag: "Group by tag",
      groupByCategory: "Group by type",
      groupByNone: "Whole document",
      groupByTimeline: "Timeline (archived included)",
      ungrouped: "Uncategorized",
      consolidate: "Consolidate",
      consolidateHint: "Merge this group into one memory; the sources get archived (redlines are excluded)",
      consolidateConflict: "This group contains suspected contradictions; resolve them in Maintenance before consolidating",
      consolidateRedline: "Redlines are excluded from consolidation",
      consolidated: "Consolidated. Sources were archived (enable “Include archived” to see them).",
      manageMemory: "Memory document",
      manageHint: "View and maintain the whole document: tidy tagged entries, edit everything, or import JSON. Redlines stay pinned above.",
      docAddHint: "No form needed to add a memory: just say “remember …” in the conversation and this document updates itself.",
      tidy: "Tidy up",
      tidyNothing: "Nothing to tidy (a tag needs at least two non-redline entries to be merged)",
      tidyConflict: "Skipped groups with suspected contradictions or redlines; resolve the contradiction in Maintenance first",
      tidySkipped: "skipped {n} group(s) with contradictions or redlines",
      tidied: "Tidied {n} group(s): merged entry saved, sources archived",
      editDoc: "Edit",
      docEditHint: "Whole-document editing: `## section` starts a section, `**Title**` starts an entry, body follows the title. Deleting an entry archives it (never deletes).",
      docSaved: "Saved: {n} written/updated, {a} archived",
      docFooter: "Memories are stored in {path}, on your device only",
      docFooterGlobal: "Global memories live in workspaces/_global/ in the local store — shared across workspaces, never committed.",
      docAuto: "Conversation memory",
      docAutoHint: "Remember what matters from your conversations so later answers fit you better.",
      docLocal: "Local memory & skills",
      docLocalHint: "Tracks how you work and mirrors a copy to .dsh-memory/MEMORY.md in the workspace. Data stays on your device.",
      untitled: "(untitled)",
      sort: "Sort",
      sortUpdated: "Recently updated",
      sortCreated: "Recently created",
      sortTitle: "Title",
      refresh: "Refresh",
      newMemory: "New memory",
      pinned: "Pinned",
      archived: "Archived",
      globalTag: "Global",
      chipTainted: "tainted",
      chipTaintedHint: "Matches injection patterns; quarantined as draft for non-user sources.",
      chipRedacted: "redacted",
      chipRedactedHint: "Secret patterns were replaced with [REDACTED:*] on write.",
      chipExternal: "external",
      chipExternalHint: "From web/tool output — verify before relying on it.",
      empty: "No memories in this workspace yet",
      emptyHint: "The agent saves them through the memory tool, or create one here.",
      firstRunTitle: "Start by letting it remember one thing",
      firstRunWhy: "Auto-capture is off by default: turn it on and each finished turn distills what is worth keeping into memories; leave it off and only you and the agent decide, through the memory tool. Pick one of the paths below.",
      firstRunStep1: "Say \"remember ...\" in the conversation — the agent saves it through the memory tool (recommended)",
      firstRunStep2: "Turn on auto-capture: distill after every turn; switch to review (high-risk only) or draft (all queued) if you want approval",
      firstRunStep3: "Bring over what you already have: the Maintain tab can scan WorkBuddy / Qoder / Claude Code / Codex memory files",
      firstRunAuto: "Turn on auto-capture",
      firstRunAutoOn: "Auto-capture is on — it will start distilling after the next turn",
      firstRunCreate: "Write one by hand",
      firstRunScan: "Scan & import (Maintain)",
      loading: "Loading…",
      workspace: "Workspace",
      projectOnlyHint: "Project memory shows this workspace only; global memories live in the Global tab.",
      projectMirrorTitle: "Workspace MEMORY.md",
      projectMirrorHint: "The offline memory file inside this workspace, generated from the store; readable on machines without the plugin.",
      projectMirrorShow: "View file",
      projectMirrorHide: "Hide file",
      projectMirrorEmpty: "This workspace has no MEMORY.md yet: turn on the mirror option in Settings, or save one memory first.",
      projectActive: "current conversation",
      projectSwitchHint: "Switching only affects the Project tab; global memories stay as they are.",
      total: "Total",
      unit: "",
      pinnedCount: "Pinned",
      globalCount: "Global",
      edit: "Edit",
      pin: "Pin",
      unpin: "Unpin",
      archive: "Archive",
      unarchive: "Unarchive",
      remove: "Delete",
      confirmRemove: "Delete this memory?",
      save: "Save",
      cancel: "Cancel",
      formNew: "New memory",
      formEdit: "Edit memory",
      fTitle: "Title",
      fTitlePh: "One line saying what this memory is",
      fContent: "Content",
      fContentPh: "The fact itself, plus the reasoning or evidence that makes it useful",
      fCategory: "Category",
      fTags: "Tags",
      fTagsPh: "Comma separated",
      fScope: "Scope",
      fPinned: "Pinned (always injected first)",
      errTitle: "Fill in a title or some content",
      sBriefing: "Inject a memory briefing at session start",
      sBriefingHint: "Puts the most important memories of this workspace into the system prompt.",
      sLimit: "Max memories injected",
      sChars: "Max characters injected",
      sPortraitChars: "Portrait budget (chars)",
      sAuto: "Auto-distill at turn end",
      sAutoHint: "Summarises durable facts after each turn using the model. Costs extra tokens.",
      sGlobalDistill: "Enable global distillation",
      sGlobalDistillHint: "Turns this project's lessons into cross-project principles. Turning it off only stops new proposals; candidates already in the pool still promote by threshold.",
      sGlobalDistillMinNew: "Material threshold (items)",
      sGlobalDistillCooldown: "Base interval (minutes)",
      sGlobalDistillCadenceHint: "Runs only when un-distilled material reaches the threshold; consecutive empty runs back off ×2 up to 24h, and any yield resets to the base interval.",
      sAutoMin: "Minimum transcript length",
      sCooldown: "Minimum interval (ms)",
      sMinConf: "Minimum confidence",
      sMaxTurn: "Max memories per turn",
      sTranscript: "Max transcript characters",
      sMirror: "Write .dsh-memory/MEMORY.md into the workspace",
      sMirrorHint: "A human-readable mirror you can read and commit. The main store stays in ~/.dsh/storages/dsh-memory.",
      sDedupe: "Merge highly similar memories automatically",
      sQualityGate: "Archive low-quality memories automatically",
      sQualityGateHint: "Memories written by auto-capture or the model itself are archived (and kept out of the briefing) when their quality score is below 30. Manual and imported memories are never hidden.",
      sCaptureSub: "Let subagent sessions auto-capture too",
      sCaptureSubHint: "Off by default: intermediate work of delegated tasks is not turned into long-term memory.",
      reasonLabel: "Why",
      qualityChip: "Quality",
      sEnabled: "Enable the memory system",
      saved: "Settings saved",
      captureNow: "Distill current session",
      capturing: "Distilling…",
      captureLog: "Recent distillations",
      captureEmpty: "Nothing distilled yet",
      distillTitle: "Distill pasted text",
      distillPh: "Paste a conversation, log or note and the model extracts durable memories.",
      distill: "Distill",
      distilling: "Distilling…",
      candidates: "Candidate memories",
      adopt: "Save all",
      adopted: "Saved",
      noCandidates: "Nothing worth keeping was found",
      mirrorTitle: "Mirror file",
      mirrorEmpty: "No mirror file yet (save one memory and it appears)",
      mirrorLoading: "Loading mirror content…",
      mirrorPresent: "written",
      mirrorAbsent: "not written",
      mirrorStorage: "Storage copy",
      mirrorGlobal: "(global memory has no workspace mirror)",
      copy: "Copy",
      copied: "Copied",
      copyFailed: "Copy failed — select the text and copy it manually",
      exportTitle: "Backup and migration",
      exportDo: "Export JSON",
      importDo: "Import JSON",
      importPh: "Paste an export or plain text (blank line separated, first line is the title)",
      imported: "Import finished",
      formatLabel: "Text format",
      formatDetected: "Detected as {f}",
      format_auto: "Auto detect",
      format_workbuddy: "WorkBuddy note",
      format_qoder: "Qoder memory",
      format_daily: "Daily log",
      format_text: "Plain text",
      scanTitle: "Import existing memories from this machine",
      scanHint: "Scans memory files left by Qoder, WorkBuddy and this plugin's mirror, splits them into memories and stores them. Sources are read-only.",
      scanDo: "Scan machine",
      scanning: "Scanning…",
      scanAll: "Import all",
      scanOne: "Import this source",
      scanFiles: "{n} files",
      scanAbsent: "Not found",
      scanGlobal: "User level",
      scanWorkspace: "Workspace level",
      scanNothing: "No importable memory files found",
      scanImported: "Imported {n}",
      tlHint: "All memories by update time, archived included; click one to edit it.",
      tlSearch: "Filter the timeline…",
      recentTitle: "Just learned",
      recentHint: "{n} memories added or updated in the last 24h; confirm they are worth keeping, archive the rest.",
      recentSummary: "+{n} in 24h",
      recentOpen: "Show",
      recentClose: "Hide",
      briefPreviewTitle: "Next session briefing",
      portraitWorkspaceEmptyHint: "No global portrait yet; hit \"Rewrite\" to generate one from memories, or import one via \"Migrate portrait from other apps\" below.",
      migrateTitle: "Migrate portrait from other apps",
      migrateHint: "Copy the prompt below into another app (Claude Code / ChatGPT, etc.) and let its AI summarize your profile; paste its answer here to merge it into this plugin's global portrait.",
      migratePrompt: "Review everything long-term you know about me from this app (identity and background, work preferences, collaboration conventions, recent focus) and summarize it into a user portrait. Output JSON only, no other text: {\"background\":\"Who I am: role, technical background, long-term goals\",\"preference\":\"How I work: language, style, tool preferences, conventions\",\"focus\":\"What I am working on now, priorities\",\"recent\":\"New habits or conclusions formed recently\"}. Rules: only cross-project, long-lived information — no one-off task details; write in my usual language; 2-5 sentences per section.",
      migrateCopy: "Copy prompt",
      migrateCopied: "Prompt copied",
      migratePh: "Paste the other AI's answer (JSON)…",
      migrateDo: "Import and merge",
      migrateDone: "Merged into the global portrait",
      portraitDiff: "What changed",
      portraitDiffClose: "Hide changes",
      portraitPromote: "Write to AGENTS.md",
      portraitPromoted: "Written to AGENTS.md ({n} lines; it is marked stale when the portrait is rewritten)",
      portraitDiffTitle: "Portrait changes (previous → current)",
      portraitDiffLoading: "Comparing versions…",
      portraitDiffNoPrevious: "Only one version so far — nothing to compare.",
      portraitDiffEmpty: "No changes in this version.",
      portraitDiffFrom: "v{from} → v{to}",
      portraitSubtitle: "A rolling profile of this workspace and of you — \"how things are now\" lives here; only non-expiring knowledge stays as memories below.",
      portraitCharsUnit: "{n} chars",
      portraitWorkspaceLabel: "Workspace portrait",
      portraitGlobalLabel: "Global portrait",
      portraitStored: "stored in portrait.json",
      portraitFromMd: "from PORTRAIT.md (persists on first save)",
      portraitEditHint: "Edit by `**Section**` blocks: Background / Conventions (Profile in the global one) / Focus / Recent.",
      portraitSaved: "Portrait saved (v{v})",
      portraitEmptySections: "Keep at least one titled section",
      portraitEmpty: "No portrait yet. Use “Rewrite portrait” to generate one from the journal and memories, or write it here by hand.",
      portraitRewrite: "Refresh now",
      portraitAutoOn: "Auto-update: checked every {hours}h, calls the model only when there is new material (WorkBuddy-style primary path)",
      portraitAutoOff: "Auto-update is off; the portrait only changes when refreshed manually",
      portraitAutoAt: "Last updated: {when}",
      portraitAutoHint: "\"Refresh now\" is the fallback; normally the portrait updates itself while you work.",
      hudTitle: "Session memory",
      hudOpen: "Open session memory",
      hudCollapse: "Collapse session memory",
      hudDrag: "Hold and drag to move this card",
      hudUpdated: "Updated {when}",
      hudSummary: "Saved {n} in this session: {list}.",
      hudNoSaved: "No memories saved in this session yet.",
      hudEmptyHint: "Chat a little and what this session remembers shows up here.",
      hudError: "Failed to load: {message}",
      hudIconLabel: "Card icon",
      hudIconHint: "Defaults to the official whale mark; fan-art bitmap icons apply as soon as settings are saved.",
      hudIconSizeLabel: "Icon size",
      hudIconSizeHint: "Changes the card on this machine only — nothing is written into workspace memory. The preview below follows the slider live.",
      hudPreviewLabel: "Live preview",
      hudPreviewBody: "Saved 3 in this session: card color, drag position, icon size.",
      hudIconA: "Official whale (default)",
      hudIconB: "Official app icon",
      hudIconC: "Cute whale",
      hudIconD: "Deep-sea whale",
      hudIconE: "Whale girl · maid",
      hudIconF: "Whale girl · wink",
      hudIconG: "Whale girl · chibi",
      hudWidthLabel: "Card width",
      hudHeightLabel: "Card height",
      hudHeightAuto: "Auto",
      hudHeightAutoHint: "Fit the card to its content again",
      hudOpacityLabel: "Background opacity",
      hudColorLabel: "Background color",
      hudColorAuto: "Theme",
      hudLookHint: "Drag the bottom-right corner to resize too. Size and color are saved with the settings and follow you across machines.",
      hudResize: "Drag to resize the card",
      portraitRewritingShort: "Rewriting…",
      portraitRewriting: "Rewriting the portrait (merging journal & memories)…",
      portraitRewritten: "Portrait rewritten and saved",
      portraitDrafted: "Rewrite saved as a draft for approval",
      portraitRewriteDegraded: "Model output was lossy (truncated or malformed); the rewrite was saved as a draft — review each section before approving",
      portraitDraftHint: "A rewrite is waiting for approval (approve to apply; the old version is archived)",
      portraitDraftView: "Preview",
      portraitDraftHide: "Hide preview",
      portraitDraftApprove: "Approve",
      portraitDraftDiscard: "Discard",
      portraitDraftApproved: "Rewrite approved — portrait updated",
      portraitDraftDiscarded: "Rewrite discarded",
      journalTitle: "Work journal",
      journalHint: "Low-barrier daily log, auto-appended after substantive work",
      journalSummary: "{n} days",
      journalEmpty: "No journal yet. It fills automatically after substantive work.",
      briefChip: "Briefed",
      tagMergeTitle: "Tag cleanup",
      tagMergeHint: "Merges variants of the same tag (e.g. DSH / dsh) into one; casing never affects search.",
      tagMergeVariants: "Variants: {variants}",
      tagMergeDo: "Merge into {tag}",
      tagMerged: "Tags merged: {n} memories updated",
      healthHint: "Duplicates, stale entries and broken links; merging is reversible (sources get archived), archiving restores.",
      healthOverBudget: "Over briefing budget",
      healthContradictions: "Contradiction clues (diagnostic)",
      healthContradictionsHint: "Lexical clues, not a semantic verdict — they never count as \"needs attention\". Archive pairs by time only if you want; redlines, pinned entries and older user-written entries are always kept.",
      healthContradictionScan: "Scan contradiction clues",
      healthContradictionScanOff: "Hide contradiction clues",
      healthContradictionScanHint: "Off by default. Lexical clues have a high false-positive rate, so they run only when you ask; results are read-only and never auto-archived.",
      healthDeadFiles: "Dead file refs",
      healthDeadFilesHint: "Files this memory was anchored to no longer exist (moved or deleted).",
      redlineTitle: "Redlines (hard bans)",
      redlineHint: "Hard bans are injected verbatim and stay pinned every turn; the model cannot edit or lift one — only you can, after confirming here.",
      redlineRemove: "Lift redline",
      redlineConfirm: "The agent will no longer be bound by this ban. Lift it?",
      dreamTitle: "Dream · tidy up now (fallback)",
      dreamHint: "Auto tidy-up is the primary path (on launch + on demand at turn end); use this only when you want a run right now: merge duplicate clusters (sources archived and restorable; redlines are excluded and pinned results stay pinned), renew due reviews automatically (escalated only after two zero-use rounds), treat contradictions as diagnostics and stale entries as a report. Portrait rewrites land directly (follows rewriteMode, default direct).",
      dreamRun: "Tidy now",
      dreamRunning: "Tidying…",
      dreamDone: "Dream finished",
      dreamSummary: "Merged {merged} clusters ｜ reviews renewed {reviews} ｜ stale {stale} ｜ exposed-never-used {unused} (reported only) ｜ portrait: {portrait}",
      dreamPortraitDrafted: "queued for review",
      dreamPortraitSaved: "saved",
      dreamPortraitDegraded: "Model output was lossy (truncated or malformed); it landed anyway — roll back to the previous version from the portrait card",
      dreamPortraitNone: "not triggered",
      dreamPortraitSkipped: "skipped ({reason})",
      dreamContradictionsResolved: "Archived {n} older statement(s) by time",
      dreamContradictionResolvedLine: "older \"{old}\" → newer \"{kept}\"",
      dreamContradictionsPending: "{n} contradiction(s) need your confirmation",
      dreamContradictionPendingLine: "\"{a}\" ⇄ \"{b}\": {reason}",
      contradictionReasonRedline: "the older one is a redline",
      contradictionReasonPinned: "the older one is pinned",
      contradictionReasonUserOlder: "the older one is user-written, the newer is not",
      contradictionReasonExternalNewer: "the newer one comes from external content",
      contradictionReasonMixedScope: "different scopes",
      contradictionReasonArchived: "archived or draft",
      contradictionReasonFailed: "archive failed",
      contradictionReasonNeedsConfirm: "lexical clue; needs your confirmation",
      healthTimeOrder: "Archive the older one by time",
      dreamSkipNoRoute: "no model session available",
      dreamSkipNoMaterial: "nothing to rewrite from",
      dreamSkipDisabled: "memory system is disabled",
      dreamSkipRunning: "portrait rewrite already running",
      dreamSkipNoWorkspace: "no workspace",
      dreamSkipUnknown: "conditions not met",
      dreamStepPortrait: "Portrait",
      dreamStepMerge: "Merge",
      dreamStepContradictions: "Contradictions",
      dreamErrorUnknown: "Unknown error",
      dreamMergedLine: "merged {count} → {title}",
      dreamErrors: "{n} step(s) failed",
      dreamAutoTitle: "Auto tidy-up · on DSH launch",
      dreamAutoHint: "Checked once for the current workspace each time DSH opens: when the last tidy-up is at least {days} days old, it runs in the background (merge duplicates, archive older statements by time, report stale entries). No resident timer and no turn budget used. Portrait rewrite: {portrait}.",
      dreamAutoOffHint: "Off. Set \"Auto tidy-up interval\" above 0 days under Settings → Governance to enable it.",
      dreamAutoPortraitOn: "follows \"Portrait rewrite mode\" (direct saves it / draft queues it for review)",
      dreamAutoPortraitOff: "off (local tidy-up only)",
      dreamLastTidy: "Last tidy-up: {when}",
      dreamAutoNever: "Checked after DSH opens; it has not run yet",
      dreamAutoNext: "Due: {when} (checked on the next DSH launch)",
      dreamAutoSummary: "Last result: merged {merged} ｜ reviews renewed {reviews} ｜ portrait: {portrait}",
      dreamAutoPortraitLine: "Auto portrait refresh: checked every {hours}h ｜ last updated {when}",
      dreamAutoPortraitDisabled: "Auto portrait refresh is off (portrait only changes when refreshed manually)",
      sAutoDreamDays: "Auto tidy-up interval (days)",
      sAutoDreamPortrait: "Auto tidy-up also rewrites the portrait",
      sAutoDreamPortraitHint: "Adds one model call; off by default — auto portrait refresh owns the portrait.",
      sAutoPortraitHours: "Auto portrait refresh interval (hours)",
      sAutoPortraitHoursHint: "0 = off. Calls the model only when there is new material; this is the primary portrait path (WorkBuddy-style).",
      promoteBtn: "Promote to AGENTS.md",
      promoteHint: "Write this memory into the workspace AGENTS.md managed block (idempotent; edit the rest freely).",
      promoted: "Promoted into {file}",
      pathTailHint: "Last path recall injected {n} · ≈{tokens} tokens",
      healthKpiTotal: "Memories",
      healthKpiUtil: "Ever used",
      healthKpiDrafts: "Pending drafts",
      healthToken: "Briefing injection",
      healthTokenIndex: "Index mode (one line each)",
      healthTokenFull: "Full mode (title + excerpt)",
      healthTokenLast: "Last injection",
      healthTokenEst: "≈ {tokens} tokens / request (rough estimate by characters)",
      healthTokenNone: "No briefing rendered yet (appears once a session starts)",
      healthProblems: "Findings",
      healthDuplicates: "Duplicates",
      healthDuplicatesHint: "Highly similar entries; merge into one. Sources get archived and can be restored.",
      healthStale: "Stale & never used",
      healthStaleHint: "Older than {days} days, never opened or cited, not pinned. Archive them if truly unused.",
      healthExposedUnused: "Exposed, never used",
      globalCandidatesTitle: "Global candidate pool",
      globalCandidatesHint: "Principles distilled from this project during tidy-up. Qualified ones become global memory automatically; hit \"Don't propose\" on a wrong one and that topic stops coming back.",
      globalCandidatesStats: "{pending} pending | {promoted} promoted | {rejected} rejected",
      globalCandidatesReject: "Don't propose",
      globalCandidatesNone: "No candidates yet — distillation runs at turn end once material reaches the threshold, and produces nothing when none qualify.",
      globalDistillLast: "Last global distillation: {when} | {materials} materials | {parsed} parsed | {added} added",
      globalDistillNever: "Global distillation has not run yet; once material reaches the threshold it runs automatically at turn end.",
      globalDistillEmpty: "Last run produced nothing ({reason})",
      globalDistillDuplicate: "Every principle this run was already in the pool (nothing added); the cadence slows down automatically",
      globalDistillRejects: "Rejected: {reasons}",
      globalDistillInterval: "Cadence: base {base} min, doubling while runs stay empty (max 24h); next allowed {next}",
      globalDistillExcerpt: "Model reply (redacted, up to 600 chars)",
      distillReasonEmpty: "the model returned an empty array",
      distillReasonAllRejected: "every candidate failed admission",
      distillReasonBadJson: "JSON parsing failed",
      distillReasonNotArray: "the reply was not an array",
      distillReasonNone: "no array in the reply",
      distillReasonLlmError: "the model call failed",
      distillReasonNoMaterial: "not enough material",
      healthExposedUnusedHint: "Injected or retrieved at least 3 times, but never opened or cited. Review the content or archive it.",
      injectionTitle: "Injection audit",
      injectionHint: "What actually entered the prompt: size, hash, which memories came along, and what the budget dropped.",
      backupTitle: "Library snapshot",
      backupHint: "One full copy of the library is taken on the first write of each day and before every Dream run, keeping the last 7. After an accidental delete, copy any snapshot back into the library directory — the panel never overwrites live data for you.",
      backupRoot: "Snapshots live in",
      backupRun: "Snapshot now",
      backupEmpty: "No snapshots yet (one appears after you save a memory)",
      backupDone: "Snapshot taken: {name}",
      injectionNone: "No injections recorded yet.",
      injectionKindBriefing: "Briefing",
      injectionKindTurnRecall: "Tail recall",
      injectionKindPathRecall: "Path recall",
      injectionDropped: "{n} dropped",
      derivationTitle: "Derivation chain",
      derivationHint: "Memory → portrait → AGENTS.md: each layer remembers where it was copied from; when the source breaks, the layer is marked stale.",
      derivationNone: "No derivations yet (they appear after saving a portrait or promoting into AGENTS.md).",
      derivationLayerPortrait: "Portrait",
      derivationLayerAgents: "AGENTS.md",
      derivationFresh: "still holds",
      derivationDirty: "stale",
      derivationSources: "sources",
      reviewTitle: "Review queue",
      reviewHint: "Memories with a falsifier land here when due: check whether they still hold.",
      reviewNone: "Nothing due or coming up for review.",
      reviewDue: "due",
      reviewSoon: "coming up",
      reviewFalsifier: "Falsifier",
      reviewDone: "Reviewed",
      reviewSummary: "{due} due ｜ {soon} coming up",
      reviewTruncated: "showing first {n}",
      chipFalsifier: "has falsifier",
      chipReviewDue: "review due",
      portraitEvidence: "Evidence",
      portraitUntraced: "Untraced",
      healthBroken: "Broken links",
      healthBrokenHint: "Relations pointing at memories that no longer exist; just unlink them.",
      healthNone: "No findings",
      healthMerge: "Merge",
      healthArchive: "Archive",
      healthArchiveAll: "Archive all",
      healthUnlink: "Unlink",
      healthGoQueue: "Review drafts",
      queueTitle: "Pending drafts",
      queueHint: "Candidates from auto-distillation (draft mode) land here first; they only take effect after approval.",
      queueEmpty: "No pending drafts",
      queueApprove: "Approve",
      queueEditApprove: "Edit then approve",
      queueReject: "Reject",
      queueApproved: "Approved and active",
      queueRejected: "Rejected",
      queueSupersedes: "Supersedes the old entry on approval",
      confirmReject: "Reject and delete this draft? (Drafts never took effect; deleting leaves no trace)",
      chainSupersedes: "↩ superseded an older entry",
      chainSupersededBy: "superseded by a newer entry",
      rollback: "Roll back",
      confirmRollback: "Roll back this chain? The old entry becomes active again, the new one is archived.",
      supersedeBtn: "Supersede",
      supersedesHint: "Replace the old entry with a new conclusion: the old one is archived (rollback possible), this one takes effect.",
      fRelated: "Related memory ids",
      fRelatedPh: "Comma separated ids; dangling ones are fine",
      fSupersedes: "Supersedes memory id",
      fSupersedesPh: "Leave empty to supersede nothing",
      draftChip: "Draft",
      modeIndex: "Index mode (one line each)",
      modeFull: "Full mode (title + excerpt)",
      modePortrait: "Portrait mode (portrait + index)",
      sBriefMode: "Briefing style",
      sAutoInject: "Auto-inject memories",
      sAutoInjectHint: "Master switch: when off, neither the briefing, turn-end recall nor path recall touches the context. Tools still read and write manually.",
      sTurnRecall: "Turn-end related recall",
      sTurnRecallHint: "After each turn, retrieves related memories locally and injects them with the next briefing. Pure local scoring, no model tokens.",
      sTurnRecallLimit: "Memories recalled per turn",
      sDiscipline: "Memory discipline",
      sDisciplineHint: "Tells the model when to write what (including “remember / forget / update memory” in-conversation triggers).",
      sRewriteMode: "Portrait rewrite mode",
      rewriteDirect: "Apply directly",
      rewriteDraft: "Draft & approve",
      sJournalDays: "Journal days for rewrite",
      sCaptureMode: "Distillation write mode",
      captureDirect: "Save directly",
      captureReview: "Review high-risk only",
      captureDraft: "All drafts need review",
      sStaleDays: "Stale threshold in days (health)",
    };

    /* ---------------------------------------------------------------- *
     * 分组显示名（英文态）
     * ---------------------------------------------------------------- */

    /** 中文类别标签（与宿主 lib/store.js 的 CATEGORY_LABELS 保持一致）。 */
    const CatLabels = {
      zh: {
        fact: "事实",
        preference: "偏好",
        decision: "决策",
        convention: "约定",
        component: "组件",
        task: "待办",
        note: "笔记",
        feedback: "反馈",
        user: "用户",
      },
    };

    const CATEGORY_EN = {
      fact: "Fact",
      preference: "Preference",
      decision: "Decision",
      convention: "Convention",
      component: "Component",
      task: "Task",
      note: "Note",
      feedback: "Feedback",
      user: "User",
    };

    const SOURCE_LABEL = {
      manual: "manual",
      agent: "agent",
      auto: "auto",
      import: "import",
    };

    /* ---------------------------------------------------------------- *
     * 小工具
     * ---------------------------------------------------------------- */

    function when(iso) {
      if (!iso) return "";
      const at = Date.parse(iso);
      if (!Number.isFinite(at)) return String(iso);
      const diff = Date.now() - at;
      const min = Math.round(diff / 60000);
      if (min < 1) return "just now";
      if (min < 60) return `${min}m`;
      const hours = Math.round(min / 60);
      if (hours < 24) return `${hours}h`;
      const days = Math.round(hours / 24);
      if (days < 30) return `${days}d`;
      return new Date(at).toISOString().slice(0, 10);
    }

    function baseName(root) {
      const clean = String(root || "").replace(/[\\/]+$/, "");
      const parts = clean.split(/[\\/]/);
      return parts[parts.length - 1] || clean;
    }

    function Spin() {
      return h("div", { className: "dshmem_empty" }, "…");
    }

    /* ---------------------------------------------------------------- *
     * 记忆卡片
     * ---------------------------------------------------------------- */

    function Card({ record, t, lang, dense, injected, onEdit, onRemove, onTogglePin, onToggleArchive, onRollback, onSupersede }) {
      const label = lang === "zh"
        ? CatLabels.zh[record.category] || record.category
        : CATEGORY_EN[record.category] || record.category;
      const tags = Array.isArray(record.tags) ? record.tags : [];
      const relatedCount = Array.isArray(record.related) ? record.related.length : 0;
      return h("div", {
        className: `dshmem_card${record.pinned ? " dshmem_card_pin" : ""}${
          dense ? " dshmem_card_dense" : ""
        }`,
      },
        h("div", { className: "dshmem_main" },
          h("div", { className: "dshmem_title" }, record.title),
          record.content
            ? h("div", { className: "dshmem_body" }, record.content)
            : null,
          record.reason
            ? h("div", { className: "dshmem_reason" }, `${t("reasonLabel")}：${record.reason}`)
            : null,
          h("div", { className: "dshmem_meta" },
            h("span", { className: "dshmem_chip" }, label),
            injected ? h("span", { className: "dshmem_chain", title: t("briefPreviewTitle") }, `✓ ${t("briefChip")}`) : null,
            record.scope === "global" ? h("span", { className: "dshmem_chip" }, t("globalTag")) : null,
            record.pinned ? h("span", { className: "dshmem_chip dshmem_chip_on" }, t("pinned")) : null,
            record.archived ? h("span", { className: "dshmem_chip" }, t("archived")) : null,
            typeof record.quality === "number" && record.quality < 60
              ? h("span", { className: "dshmem_chip" }, `${t("qualityChip")} ${record.quality}`)
              : null,
            tags.map((tag) => h("span", { key: tag, className: "dshmem_tag" }, `#${tag}`)),
            h("span", null, `${SOURCE_LABEL[record.source] || record.source} · ${when(record.updatedAt)}`),
            record.useCount ? h("span", null, `×${record.useCount}`) : null,
            record.supersedes ? h("span", { className: "dshmem_chain" }, t("chainSupersedes")) : null,
            record.supersededBy ? h("span", { className: "dshmem_chain" }, t("chainSupersededBy")) : null,
            relatedCount ? h("span", { className: "dshmem_chain" }, `⇔ ${relatedCount}`) : null
          )
        ),
        h("div", { className: "dshmem_acts" },
          h("button", {
            type: "button",
            className: "dshmem_btn dshmem_btn_sm",
            onClick: () => onEdit(record),
          }, t("edit")),
          h("button", {
            type: "button",
            className: "dshmem_btn dshmem_btn_sm",
            onClick: () => onTogglePin(record),
          }, record.pinned ? t("unpin") : t("pin")),
          h("button", {
            type: "button",
            className: "dshmem_btn dshmem_btn_sm",
            onClick: () => onToggleArchive(record),
          }, record.archived ? t("unarchive") : t("archive")),
          onSupersede
            ? h("button", {
                type: "button",
                className: "dshmem_btn dshmem_btn_sm",
                title: t("supersedesHint"),
                onClick: () => onSupersede(record),
              }, t("supersedeBtn"))
            : null,
          (record.supersedes || record.supersededBy) && onRollback
            ? h("button", {
                type: "button",
                className: "dshmem_btn dshmem_btn_sm",
                title: t("confirmRollback"),
                onClick: () => onRollback(record),
              }, t("rollback"))
            : null,
          h("button", {
            type: "button",
            className: "dshmem_btn dshmem_btn_sm dshmem_btn_danger",
            onClick: () => {
              if (typeof window !== "undefined" && !window.confirm(t("confirmRemove"))) return;
              onRemove(record);
            },
          }, t("remove"))
        )
      );
    }

    /* ---------------------------------------------------------------- *
     * 编辑 / 新建表单
     * ---------------------------------------------------------------- */

    function Editor({ t, lang, categories, draft, busy, onCancel, onSubmit }) {
      const [form, setForm] = useState(() => ({
        id: draft?.id || "",
        title: draft?.title || "",
        content: draft?.content || "",
        category: draft?.category || "note",
        tags: Array.isArray(draft?.tags) ? draft.tags.join(", ") : "",
        scope: draft?.scope || "workspace",
        pinned: Boolean(draft?.pinned),
        related: Array.isArray(draft?.related) ? draft.related.join(", ") : "",
        supersedes: draft?.supersedes || "",
      }));
      const [error, setError] = useState("");
      const patch = (key, value) => setForm((current) => ({ ...current, [key]: value }));

      const submit = () => {
        if (!form.title.trim() && !form.content.trim()) {
          setError(t("errTitle"));
          return;
        }
        setError("");
        onSubmit({
          id: form.id || undefined,
          title: form.title.trim(),
          content: form.content.trim(),
          category: form.category,
          tags: form.tags
            .split(/[,，]/)
            .map((tag) => tag.trim())
            .filter(Boolean),
          scope: form.scope,
          pinned: form.pinned,
          related: form.related
            .split(/[,，]/)
            .map((id) => id.trim())
            .filter(Boolean),
          supersedes: form.supersedes.trim() || undefined,
        });
      };

      return h("div", { className: "dshmem_box" },
        h("div", { className: "dshmem_title" }, form.id ? t("formEdit") : t("formNew")),
        h("input", {
          className: "dshmem_input",
          value: form.title,
          placeholder: t("fTitlePh"),
          onChange: (event) => patch("title", event.target.value),
        }),
        h("textarea", {
          className: "dshmem_area",
          value: form.content,
          placeholder: t("fContentPh"),
          onChange: (event) => patch("content", event.target.value),
        }),
        h("div", { className: "dshmem_row" },
          h("span", { className: "dshmem_lbl" }, t("fCategory")),
          h("select", {
            className: "dshmem_select",
            value: form.category,
            onChange: (event) => patch("category", event.target.value),
          }, categories.map((item) =>
            h("option", { key: item.id, value: item.id }, lang === "zh" ? item.label : CATEGORY_EN[item.id] || item.id))),
          h("span", { className: "dshmem_lbl" }, t("fScope")),
          h("select", {
            className: "dshmem_select",
            value: form.scope,
            onChange: (event) => patch("scope", event.target.value),
          },
            h("option", { value: "workspace" }, t("scopeWorkspace")),
            h("option", { value: "global" }, t("scopeGlobal"))
          )
        ),
        h("div", { className: "dshmem_row" },
          h("span", { className: "dshmem_lbl" }, t("fTags")),
          h("input", {
            className: "dshmem_input",
            value: form.tags,
            placeholder: t("fTagsPh"),
            onChange: (event) => patch("tags", event.target.value),
          })
        ),
        h("div", { className: "dshmem_row" },
          h("span", { className: "dshmem_lbl" }, t("fRelated")),
          h("input", {
            className: "dshmem_input",
            value: form.related,
            placeholder: t("fRelatedPh"),
            onChange: (event) => patch("related", event.target.value),
          })
        ),
        form.id
          ? null
          : h("div", { className: "dshmem_row" },
              h("span", { className: "dshmem_lbl" }, t("fSupersedes")),
              h("input", {
                className: "dshmem_input",
                value: form.supersedes,
                placeholder: t("fSupersedesPh"),
                onChange: (event) => patch("supersedes", event.target.value),
              })
            ),
        h("label", { className: "dshmem_switch" },
          h("input", {
            type: "checkbox",
            checked: form.pinned,
            onChange: (event) => patch("pinned", event.target.checked),
          }),
          h("span", null, t("fPinned"))
        ),
        error ? h("div", { className: "dshmem_err" }, error) : null,
        h("div", { className: "dshmem_row" },
          h("button", {
            type: "button",
            className: "dshmem_btn dshmem_btn_primary",
            disabled: busy,
            onClick: submit,
          }, t("save")),
          h("button", { type: "button", className: "dshmem_btn", onClick: onCancel }, t("cancel"))
        )
      );
    }

    /* ---------------------------------------------------------------- *
     * 设置页
     * ---------------------------------------------------------------- */

    function MemorySection(props) {
      const t = props.t;
      // inject 面提供的 hook：语言切换时 revision 变化 → 重算 lang。
      const localeRevision = props.useMemoryLocale
        ? props.useMemoryLocale((snapshot) => snapshot?.revision ?? 0)
        : 0;
      const lang = useMemo(() => {
        try {
          return t("nav") === "记忆" ? "zh" : "en";
        } catch {
          return "zh";
        }
      }, [t, localeRevision]);

      /* 顶部第一层就是范围：项目记忆（本工作区）与全局记忆各占一个页签。 */
      const [tab, setTab] = useState("project");
      const [state, setState] = useState(null);
      /* 设置页概览的聚合数据（/overview）：不与列表的 records 混用。 */
      const [overviewData, setOverviewData] = useState(null);
      const [recordsRaw, setRecordsRaw] = useState([]);
      /* records 属于哪个范围：切页签的那几帧旧数据还在，按它把显示门掉。 */
      const [recordsScope, setRecordsScope] = useState("");
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState("");
      const [notice, setNotice] = useState("");

      const [query, setQuery] = useState("");
      const [category, setCategory] = useState("");
      const [archived, setArchived] = useState(false);
      const [sort, setSort] = useState("updated");
      const [workspace, setWorkspace] = useState("");
      const [manualRoot, setManualRoot] = useState("");

      /* 显示偏好在设置页里改，落在本机；这里只读它的当前值。 */
      const [uiPrefs, setUiPrefs] = useState(() => uiPrefsRead());
      /* 分区与分组：范围由页签决定，剩下的是标签分组、折叠与「整合」来源。 */
      /* 视图默认「档案」：一条条卡片适合管理，但用户平时想看的是一份连续的档案。 */
      const [view, setView] = useState(() => (uiPrefsRead().view === "list" ? "list" : "doc"));
      /* 档案视图默认「整篇文档」（一个工作区一份长记忆）；按标签/按类型分组是同一视图的另一种排布。 */
      const [groupBy, setGroupBy] = useState(() => uiPrefsRead().groupBy);
      const [collapsed, setCollapsed] = useState({});
      const [mergeIds, setMergeIds] = useState(null);
      const [docDraft, setDocDraft] = useState(null);
      const [docImport, setDocImport] = useState(false);
      /* 记忆页的次要内容默认收进「工具与记录」；列表筛选默认收起，避免首屏堆控件。 */
      const [toolsOpen, setToolsOpen] = useState(false);
      const [filtersOpen, setFiltersOpen] = useState(false);
      const [attentionOpen, setAttentionOpen] = useState(false);
      const [maintainHistoryOpen, setMaintainHistoryOpen] = useState(false);
      const [maintainCaptureOpen, setMaintainCaptureOpen] = useState(false);

      const [draft, setDraft] = useState(null);
      const [redlineEdit, setRedlineEdit] = useState(null);
      const [busy, setBusy] = useState(false);

      const [settings, setSettings] = useState(null);
      const [settingsDirty, setSettingsDirty] = useState(false);
      /* 会话卡图标大小：本机偏好，改完即时生效（不进宿主配置，也不参与保存按钮）。 */
      const [hudIconSize, setHudIconSize] = useState(hudReadIconSize);
      /* 设置页的「该对话记忆」：当前会话 id + 是否开启（默认开启，关闭只影响该对话的前台卡）。 */
      const [sessionMemory, setSessionMemory] = useState({ id: "", on: true, loading: false });

      const [captures, setCaptures] = useState([]);
      const [capturing, setCapturing] = useState(false);
      const [distillText, setDistillText] = useState("");
      const [distilling, setDistilling] = useState(false);
      const [candidates, setCandidates] = useState(null);
      const [importText, setImportText] = useState("");
      const [importFormat, setImportFormat] = useState("auto");
      const [scan, setScan] = useState(null);
      const [scanning, setScanning] = useState(false);
      const [scanBusy, setScanBusy] = useState("");

      /* 时间线 / 健康 / 审批：进入对应 tab 或发生写操作后才拉取（detailTick 驱动刷新）。 */
      const [timelineData, setTimelineData] = useState(null);
      const [tlQuery, setTlQuery] = useState("");
      const [healthData, setHealthData] = useState(null);
      const [healthBusy, setHealthBusy] = useState(false);
      /* 矛盾线索默认不扫；只有用户显式点「扫描」才带 ?contradictions=1 拉一次。 */
      const [contradictionScan, setContradictionScan] = useState(false);
      /* 注入审计：最近真正进 prompt 的内容（字节、hash、取了什么、挤掉了什么）。 */
      const [injectionData, setInjectionData] = useState(null);
      /* 整库快照：每天一次 + 每次 Dream 前自动留，面板里只看清单与路径。 */
      const [backupData, setBackupData] = useState(null);
      const [backupBusy, setBackupBusy] = useState(false);
      /* Dream：一键半自动整理的运行态与最近一次报告。 */
      const [dreamBusy, setDreamBusy] = useState(false);
      const [dreamData, setDreamData] = useState(null);
      const [queueData, setQueueData] = useState(null);
      const [queueEdit, setQueueEdit] = useState(null);
      /* 派生链：记忆 → 画像 → AGENTS.md 的源快照与失效状态。 */
      const [derivationData, setDerivationData] = useState(null);
      /* 复审队列：带失效条件、到期该复查的记忆。 */
      const [reviewData, setReviewData] = useState(null);
      const [detailTick, setDetailTick] = useState(0);
      /* 「刚刚记了什么」与「简报预览」：记忆库顶部的两个横幅的数据源。 */
      const [recentData, setRecentData] = useState(null);
      const [recentOpen, setRecentOpen] = useState(false);
      const [briefPreviewData, setBriefPreviewData] = useState(null);
      /* 画像卡：portrait.json / PORTRAIT.md 的展示与编辑（scope: "workspace" | "global"）。 */
      const [portraitData, setPortraitData] = useState(null);
      const [portraitEdit, setPortraitEdit] = useState(null);
      const [portraitSectionEdit, setPortraitSectionEdit] = useState(null);
      const [evidenceView, setEvidenceView] = useState(null);
      const [redlineConflicts, setRedlineConflicts] = useState([]);
      /* 红线是跨范围的绝对禁令：单独拉一份全量（含归档，渲染时再滤掉），
         免得跟着页签的 scope 走——全局页上看不到本工作区的禁令。 */
      const [redlineData, setRedlineData] = useState(null);
      const [redlineHistoryView, setRedlineHistoryView] = useState(null);
      const [portraitBusy, setPortraitBusy] = useState(false);
      /* 重写（P1）：按钮忙碌态 + 待审稿预览数据。 */
      const [rewriteBusy, setRewriteBusy] = useState(false);
      const [draftData, setDraftData] = useState(null);
      /* 画像 2.0：上一版 → 当前版的 diff（默认收起，点开才拉）。 */
      const [portraitDiffOpen, setPortraitDiffOpen] = useState(false);
      const [portraitDiffData, setPortraitDiffData] = useState(null);
      const [portraitDiffBusy, setPortraitDiffBusy] = useState(false);
      /* 从其它 App 迁移画像：粘贴那边 AI 的 JSON 回答，与全局画像整合。 */
      const [migrateText, setMigrateText] = useState("");
      const [migrateBusy, setMigrateBusy] = useState(false);
      /* 工作日志条：展开时才拉取。 */
      const [journalOpen, setJournalOpen] = useState(false);
      /* 项目页顶部的工作区 MEMORY.md：默认收起，展开时才拉正文。 */
      const [mirrorOpen, setMirrorOpen] = useState(false);
      const [mirrorBusy, setMirrorBusy] = useState(false);
      const [journalData, setJournalData] = useState(null);

      const alive = useRef(true);
      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      /* 切到设置页时解析当前对话：优先 DOM 标记，其次宿主半最近活动会话。 */
      useEffect(() => {
        if (tab !== "settings") return undefined;
        let active = true;
        const controller = new AbortController();
        const apply = (id) => {
          if (!active) return;
          const key = String(id || "");
          setSessionMemory({ id: key, on: key ? !hudSessionOff(key) : true, loading: false });
        };
        const known = hudSessionId() || lastHudSession;
        if (known) {
          apply(known);
          return () => {
            active = false;
            controller.abort();
          };
        }
        setSessionMemory((current) => ({ ...current, loading: true }));
        api
          .sessionBrief("", 1, controller.signal)
          .then((data) => apply(data?.session))
          .catch(() => {
            if (active) setSessionMemory((current) => ({ ...current, loading: false }));
          });
        return () => {
          active = false;
          controller.abort();
        };
      }, [tab]);

      const target = workspace || manualRoot || "";
      /* 页签 → 范围。维护/设置两页要看全量（体检、概览都要跨范围计数），所以留空。 */
      const scope = tab === "project" ? "workspace" : tab === "global" ? "global" : "";
      /* 页签刚切过去时 records 还是上一个范围的：对不上就当作还没加载，
         否则列表视图会闪一帧另一边的条目（服务端已经按 scope 过滤，这里只防这一帧）。 */
      const recordsPending = recordsScope !== scope;
      const records = recordsPending ? [] : recordsRaw;

      /* 设置页的显示选项：立即生效 + 记住本机。 */
      const applyUi = (key, value) => {
        uiPrefsWrite({ [key]: value });
        setUiPrefs((current) => ({ ...current, [key]: value }));
        if (key === "view") setView(value === "list" ? "list" : "doc");
        if (key === "groupBy") setGroupBy(UI_PREF_GROUPS.includes(value) ? value : "none");
      };

      const flash = useCallback((message) => {
        setNotice(message);
        if (typeof window !== "undefined") {
          window.setTimeout(() => {
            if (alive.current) setNotice("");
          }, 2600);
        }
      }, []);

      /* 首屏 / 工作区切换：拉 state。 */
      useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        api
          .state(target, controller.signal)
          .then((payload) => {
            if (!alive.current) return;
            setState(payload);
            setCaptures(Array.isArray(payload.captures) ? payload.captures : []);
            setSettings((current) => current || payload.settings || null);
            if (!workspace && payload.workspace?.root) setWorkspace(payload.workspace.root);
            setError("");
          })
          .catch((cause) => {
            if (cause?.name === "AbortError" || !alive.current) return;
            setError(String(cause?.message || cause));
          })
          .finally(() => {
            if (alive.current) setLoading(false);
          });
        return () => controller.abort();
      }, [target]);

      /* 前台卡右下角拖拽改大小会直接落配置；设置面板若还保活着，同步滑杆避免显示旧值。 */
      useEffect(() => {
        if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
        const onLook = (event) => {
          const detail = event?.detail || {};
          const width = Number(detail.width);
          const height = Number(detail.height);
          if (!Number.isFinite(width) && !Number.isFinite(height)) return;
          setSettings((current) => {
            if (!current) return current;
            const next = { ...current };
            if (Number.isFinite(width)) next.hudWidth = width;
            if (Number.isFinite(height)) next.hudHeight = height;
            return next;
          });
          /* 不清 settingsDirty：拖动持久化的是尺寸，页面上其它未保存的改动仍需人点保存。 */
        };
        window.addEventListener(HUD_LOOK_EVENT, onLook);
        return () => window.removeEventListener(HUD_LOOK_EVENT, onLook);
      }, []);

      /* 镜像预览：文件已经存在就自动取一次内容，免得旁边写着「已生成」而这里空着。 */
      useEffect(() => {
        const exists = Boolean(state?.mirror?.workspaceExists || state?.mirror?.storageExists);
        if (!exists || state?.mirror?.markdown) return undefined;
        let cancelled = false;
        api
          .mirror(target)
          .then((payload) => {
            if (cancelled || !alive.current) return;
            setState((current) => ({ ...(current || {}), mirror: payload.mirror }));
          })
          .catch(() => {
            /* 预览取不到不影响其它区块 */
          });
        return () => {
          cancelled = true;
        };
      }, [target, state?.mirror?.workspaceExists, state?.mirror?.storageExists, state?.mirror?.markdown]);

      /* 列表：筛选条件变化就重拉。时间线排布需要含归档（同一份内容的另一种切法）。 */
      const reload = useCallback(
        (signal) => {
          /* 设置页只画聚合概览（/overview），不为它拉一份用不上的明细。 */
          if (tab === "settings") {
            setLoading(false);
            return Promise.resolve();
          }
          setLoading(true);
          return api
            .list(
              {
                workspace: target,
                q: query.trim(),
                category,
                scope,
                /* 项目页明确只要本工作区：不把全局库拉进来再过滤。 */
                global: scope === "workspace" ? "0" : "",
                archived: archived || groupBy === "timeline" ? "1" : "",
                sort,
                limit: 300,
              },
              signal,
            )
            .then((payload) => {
              if (!alive.current) return;
              setRecordsRaw(Array.isArray(payload.records) ? payload.records : []);
              setRecordsScope(scope);
              setError("");
            })
            .catch((cause) => {
              if (cause?.name === "AbortError" || !alive.current) return;
              setError(String(cause?.message || cause));
            })
            .finally(() => {
              if (alive.current) setLoading(false);
            });
        },
        [target, tab, query, category, scope, archived, groupBy, sort],
      );

      useEffect(() => {
        const controller = new AbortController();
        const timer = window.setTimeout(() => reload(controller.signal), query ? 220 : 0);
        return () => {
          window.clearTimeout(timer);
          controller.abort();
        };
      }, [reload, query]);

      /* 时间线数据：档案视图的「时间线」排布与维护页共用（含归档，写操作后重拉）。 */
      useEffect(() => {
        const controller = new AbortController();
        api
          .timeline(target, controller.signal)
          .then((payload) => {
            if (alive.current) setTimelineData(payload);
          })
          .catch((cause) => {
            if (alive.current && cause?.name !== "AbortError") setError(String(cause?.message || cause));
          });
        return () => controller.abort();
      }, [target, detailTick]);

      /* 「刚刚记了什么」：最近更新的 50 条（不受当前筛选影响），前端再按 24h 过滤。 */
      useEffect(() => {
        const controller = new AbortController();
        api
          .list({ workspace: target, sort: "updated", limit: 50 }, controller.signal)
          .then((payload) => {
            if (alive.current) setRecentData(payload);
          })
          .catch(() => {
            /* 横幅取不到不影响主列表 */
          });
        return () => controller.abort();
      }, [target, detailTick]);

      /* 「下次会话将注入」预览：设置变化或写操作后重算。 */
      useEffect(() => {
        const controller = new AbortController();
        api
          .briefPreview(target, controller.signal)
          .then((payload) => {
            if (alive.current) setBriefPreviewData(payload?.preview || null);
          })
          .catch(() => {
            /* 预览取不到不影响主列表 */
          });
        return () => controller.abort();
      }, [target, detailTick, settings?.briefMode, settings?.briefingLimit, settings?.briefingMaxChars]);

      /* 画像：工作区切换或写操作后重拉。 */
      useEffect(() => {
        const controller = new AbortController();
        api
          .portrait(target, controller.signal)
          .then((payload) => {
            if (alive.current) setPortraitData(payload || null);
          })
          .catch(() => {
            /* 画像取不到不影响主列表 */
          });
        return () => controller.abort();
      }, [target, detailTick]);

      /* 设置页概览：一次聚合拿齐图表口径，不为它拉明细。 */
      useEffect(() => {
        if (tab !== "settings") return undefined;
        const controller = new AbortController();
        api
          .overview(target, controller.signal)
          .then((payload) => {
            if (alive.current) setOverviewData(payload?.overview || null);
          })
          .catch(() => {
            /* 概览取不到不影响其它区块 */
          });
        return () => controller.abort();
      }, [tab, target, detailTick]);

      /* 红线单独取：范围由红线自己的 scope 决定，不受当前页签影响。 */
      useEffect(() => {
        const controller = new AbortController();
        api
          .list({ workspace: target, category: "constraint", archived: "1", limit: 100 }, controller.signal)
          .then((payload) => {
            if (alive.current) setRedlineData(Array.isArray(payload.records) ? payload.records : []);
          })
          .catch(() => {
            /* 红线取不到不影响主列表 */
          });
        return () => controller.abort();
      }, [target, detailTick]);

      /* 健康：维护页、项目/全局页的「需要处理」与设置页概览都要用。 */
      useEffect(() => {
        if (tab !== "maintain" && tab !== "project" && tab !== "global" && tab !== "settings") {
          return undefined;
        }
        const controller = new AbortController();
        api
          .health(target, controller.signal, contradictionScan ? { contradictions: 1 } : {})
          .then((payload) => {
            if (alive.current) setHealthData(payload);
          })
          .catch((cause) => {
            if (alive.current && cause?.name !== "AbortError") setError(String(cause?.message || cause));
          });
        return () => controller.abort();
      }, [tab, target, detailTick, contradictionScan]);

      /* 红线编辑器与通用记忆编辑器互斥，避免同屏两个表单。 */
      useEffect(() => {
        if (draft) setRedlineEdit(null);
      }, [draft]);

      /* 注入审计：与健康同在「维护」tab。 */
      useEffect(() => {
        if (tab !== "maintain") return undefined;
        const controller = new AbortController();
        api
          .injections(target, controller.signal, 12)
          .then((payload) => {
            if (alive.current) setInjectionData(payload);
          })
          .catch(() => {
            /* 审计读不到不影响其它区块 */
          });
        return () => controller.abort();
      }, [tab, target, detailTick]);

      /* 审批队列：维护页常驻；记忆页「需要处理」展开时也拉。 */
      useEffect(() => {
        const memoryTab = tab === "project" || tab === "global";
        if (tab !== "maintain" && !(memoryTab && attentionOpen)) return undefined;
        const controller = new AbortController();
        api
          .queue(target, controller.signal)
          .then((payload) => {
            if (alive.current) setQueueData(payload);
          })
          .catch((cause) => {
            if (alive.current && cause?.name !== "AbortError") setError(String(cause?.message || cause));
          });
        return () => controller.abort();
      }, [tab, target, detailTick, attentionOpen]);

      /* 整库快照：维护页最下面的「后悔药」。读不到不影响其它区块。 */
      useEffect(() => {
        if (tab !== "maintain") return undefined;
        const controller = new AbortController();
        api
          .backups(controller.signal)
          .then((payload) => {
            if (alive.current) setBackupData(payload);
          })
          .catch(() => {
            /* 快照清单读不到不影响其它区块 */
          });
        return () => controller.abort();
      }, [tab, target, detailTick]);

      /* 派生链与复审队列：维护页常驻；记忆页收件箱展开时也拉复审。 */
      useEffect(() => {
        const memoryTab = tab === "project" || tab === "global";
        if (tab !== "maintain" && !(memoryTab && attentionOpen)) return undefined;
        const controller = new AbortController();
        api
          .derivations(target, controller.signal)
          .then((payload) => {
            if (alive.current) setDerivationData(payload);
          })
          .catch(() => {
            /* 派生链读不到不影响其它区块 */
          });
        api
          .reviews(target, controller.signal, 30)
          .then((payload) => {
            if (alive.current) setReviewData(payload);
          })
          .catch(() => {
            /* 复审队列读不到不影响其它区块 */
          });
        return () => controller.abort();
      }, [tab, target, detailTick, attentionOpen]);

      /* 写操作后统一刷新状态与列表。 */
      const afterWrite = useCallback(
        (message) => {
          if (message) flash(message);
          setDetailTick((tick) => tick + 1);
          return api
            .state(target)
            .then((payload) => {
              if (!alive.current) return;
              setState(payload);
              setCaptures(Array.isArray(payload.captures) ? payload.captures : []);
            })
            .catch(() => {})
            .then(() => reload());
        },
        [target, flash, reload],
      );

      const run = useCallback(
        (promise, message) => {
          setBusy(true);
          setError("");
          return promise
            .then(() => afterWrite(message))
            .catch((cause) => setError(String(cause?.message || cause)))
            .finally(() => setBusy(false));
        },
        [afterWrite],
      );

      const stats = state?.stats || { total: 0, pinned: 0, global: 0, byCategory: {} };
      /* 顶部的「共 N 条」要跟当前范围筛选对上，否则会和列表里的卡片数打架。 */
      const scopeTotal =
        scope === "global" ? stats.global : scope === "workspace" ? stats.total : stats.total + stats.global;
      const categories = state?.categories || [];
      const workspaces = Array.isArray(state?.workspaces) ? state.workspaces : [];
      const tagList = Array.isArray(state?.tags) ? state.tags : [];
      const catLabel = (id) =>
        lang === "zh" ? CatLabels.zh[id] || id : CATEGORY_EN[id] || id;

      /* ---------------- 记忆页 ---------------- */

      const UNGROUPED = "__none__";
      const ALL_GROUP = "__all__";
      const unitSuffix = lang === "zh" ? t("unit") : "";

      /* 分组键：按标签时取第一条标签的归并形式（大小写不敏感，治理 DSH/dsh 漂移），
         按类型时取 category。`mode` 可以显式传入：整理永远按标签算，不受当前排布下拉的影响。 */
      const groupKeyOf = (record, mode = groupBy) => {
        if (mode === "category") return `cat:${record.category || "note"}`;
        const first = Array.isArray(record.tags) && record.tags.length ? String(record.tags[0]) : "";
        return first ? `tag:${first.toLowerCase()}` : UNGROUPED;
      };
      /* 组显示名：标签组取组内出现最多的原始写法（DSH/dsh 混用时显示更常见的那种）。 */
      const groupLabelOf = (key, items = []) => {
        if (key === UNGROUPED) return t("ungrouped");
        if (key === ALL_GROUP) return t("total");
        if (key.startsWith("cat:")) return catLabel(key.slice(4));
        const raw = key.slice(4);
        const tally = new Map();
        for (const record of items) {
          for (const tag of record.tags || []) {
            if (String(tag).toLowerCase() !== raw) continue;
            tally.set(tag, (tally.get(tag) || 0) + 1);
          }
        }
        const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
        return `#${best ? best[0] : raw}`;
      };
      const groupRecords = (list, mode = groupBy) => {
        const buckets = new Map();
        for (const record of list) {
          const key = mode === "none" ? ALL_GROUP : groupKeyOf(record, mode);
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(record);
        }
        return [...buckets.entries()]
          .map(([key, items]) => ({ key, label: groupLabelOf(key, items), items }))
          .sort((a, b) => {
            if (a.key === UNGROUPED) return 1;
            if (b.key === UNGROUPED) return -1;
            return b.items.length - a.items.length || a.label.localeCompare(b.label);
          });
      };

      const isFolded = (key) => Boolean(collapsed[key]);
      const toggleFolded = (key) =>
        setCollapsed((current) => ({ ...current, [key]: !current[key] }));

      /* 红线是绝对禁令，措辞逐字保留；整理 / 整合只合并普通记忆。 */
      const mergeableItems = (group) => group.items.filter((record) => record.category !== "constraint");

      /* 整合：把一组记忆合并成一条新记忆，原条目走 /bulk 归档（可取消归档恢复）。 */
      const consolidateDraft = (scopeId, group) => {
        const items = mergeableItems(group);
        const tally = new Map();
        for (const record of items) {
          tally.set(record.category, (tally.get(record.category) || 0) + 1);
        }
        const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
        const tagged = group.key.startsWith("tag:");
        return {
          title: tagged ? group.label.slice(1) : group.label,
          content: items
            .map((record) => {
              const body = String(record.content || "").replace(/\s+/g, " ").trim();
              return `- **${record.title}**${body ? ` — ${body}` : ""}`;
            })
            .join("\n"),
          category: top ? top[0] : "note",
          tags: tagged ? [group.label.slice(1)] : [],
          scope: scopeId,
        };
      };
      const startConsolidate = (scopeId, group) => {
        setMergeIds(mergeableItems(group).map((record) => record.id));
        setDraft(consolidateDraft(scopeId, group));
      };
      const closeEditor = () => {
        setDraft(null);
        setMergeIds(null);
        setQueueEdit(null);
      };
      const submitDraft = (form) => {
        const sources = mergeIds;
        const pendingQueue = queueEdit;
        closeEditor();
        /* 审批流：草稿「编辑后批准」——编辑字段随批准请求一起提交。 */
        if (pendingQueue) {
          run(api.approve({ workspace: target, id: pendingQueue.id, ...form }), t("queueApproved"));
          return;
        }
        /* 版本链：以新结论推翻旧条（/save 带 supersedes 时走 supersede）。 */
        if (form.supersedes && !form.id) {
          run(api.save({ workspace: target, ...form, source: "manual" }), t("saved"));
          return;
        }
        if (form.id) {
          run(api.update({ workspace: target, ...form }), t("saved"));
          return;
        }
        if (sources && sources.length) {
          const merging = api
            .healthResolve({
              action: "merge",
              workspace: target,
              ids: sources,
              title: form.title,
              content: form.content,
              category: form.category,
              tags: form.tags,
            })
            .catch((cause) => {
              if (cause?.code === "contradiction_pair") throw new Error(t("consolidateConflict"));
              if (cause?.code === "redline_protected") throw new Error(t("consolidateRedline"));
              throw cause;
            });
          run(merging, t("consolidated"));
          return;
        }
        run(api.save({ workspace: target, ...form, source: "manual" }), t("saved"));
      };

      const cardNode = (record, dense) =>
        h(Card, {
          key: record.id,
          record,
          t,
          lang,
          dense,
          injected: briefIds.has(record.id),
          onEdit: (item) => {
            setMergeIds(null);
            setQueueEdit(null);
            setDraft(item);
          },
          onTogglePin: (item) =>
            run(api.update({ workspace: target, id: item.id, pinned: !item.pinned })),
          onToggleArchive: (item) =>
            run(api.update({ workspace: target, id: item.id, archived: !item.archived })),
          onRemove: (item) => run(api.remove({ workspace: target, id: item.id })),
          onRollback: (item) => {
            if (typeof window !== "undefined" && !window.confirm(t("confirmRollback"))) return;
            run(api.rollback({ workspace: target, id: item.id }), t("saved"));
          },
          onSupersede: (item) => {
            setMergeIds(null);
            setQueueEdit(null);
            /* 推翻 = 以旧条为底稿写新结论：不带 id，带上 supersedes。 */
            setDraft({
              title: item.title,
              content: item.content,
              category: item.category,
              tags: item.tags,
              scope: item.scope,
              supersedes: item.id,
            });
          },
        });

      const groupNode = (scopeId, group) => {
        const key = `${scopeId}:${group.key}`;
        const folded = isFolded(key);
        return h("div", { className: "dshmem_group", key: group.key },
          h("div", { className: "dshmem_groupHead" },
            h("span", {
              className: `dshmem_groupTitle${group.key.startsWith("tag:") ? "" : " dshmem_groupTitle_plain"}`,
              onClick: () => toggleFolded(key),
            }, `${folded ? "▸" : "▾"} ${group.label}`),
            h("span", { className: "dshmem_count" }, `${group.items.length}${unitSuffix}`),
            mergeableItems(group).length > 1
              ? h("button", {
                  type: "button",
                  className: "dshmem_btn dshmem_btn_sm",
                  title: t("consolidateHint"),
                  onClick: () => startConsolidate(scopeId, group),
                }, t("consolidate"))
              : null
          ),
          folded
            ? null
            : h("div", { className: "dshmem_groupItems" },
                group.items.map((record) => cardNode(record, true)))
        );
      };

      /* 范围分区：项目记忆（本工作区）与全局记忆分开放，和 Qoder 的划分一致。 */
      const scopeSections = [
        { id: "workspace", label: t("scopeProject"), hint: state?.workspace?.root || target || "" },
        { id: "global", label: t("scopeGlobalFull"), hint: "" },
      ].filter((section) => scope === "" || scope === section.id);

      /* ---------------- 记忆库顶部：变化横幅 + 简报预览 ---------------- */

      /* 「刚刚记了什么」：最近更新的 50 条里取 24h 内的变化，不受当前筛选影响。
         横幅本体在 docEntry 之后定义（展开时复用 docEntry 的渲染）。 */
      const dayAgo = Date.now() - 24 * 3600 * 1000;
      /* 横幅只在项目页出现：全局条目有自己的页签，别混进「刚刚记了什么」。 */
      const recentItems = (Array.isArray(recentData?.records) ? recentData.records : [])
        .filter((record) => record.scope !== "global")
        .filter((record) => (Date.parse(record.updatedAt) || 0) >= dayAgo);
      const briefIds = new Set(Array.isArray(briefPreviewData?.ids) ? briefPreviewData.ids : []);
      /** 「这条会被注入下次简报」的小标记；卡片与时间线条目共用。 */
      const injectedChip = (record) =>
        briefIds.has(record.id)
          ? h("span", { className: "dshmem_chain", title: t("briefPreviewTitle") }, `✓ ${t("briefChip")}`)
          : null;

      /** 写入安全徽标：taint / 已脱敏 / 外部来源；卡片与时间线条目共用。 */
      const securityChips = (record) => [
        record.taint
          ? h("span", { className: "dshmem_chip", title: t("chipTaintedHint") }, t("chipTainted"))
          : null,
        record.redactions?.length
          ? h("span", { className: "dshmem_chip", title: t("chipRedactedHint") }, t("chipRedacted"))
          : null,
        record.trust === "external"
          ? h("span", { className: "dshmem_chip", title: t("chipExternalHint") }, t("chipExternal"))
          : null,
      ];

      /** 复审徽标：写了失效条件 / 已经到期该复查。 */
      const reviewChips = (record) => [
        record.falsifier
          ? h("span", { className: "dshmem_chip", title: record.falsifier }, t("chipFalsifier"))
          : null,
        record.falsifier && record.reviewAt && Date.parse(record.reviewAt) <= Date.now()
          ? h("span", { className: "dshmem_chip", title: record.falsifier }, t("chipReviewDue"))
          : null,
      ];

      /* ---------------- 档案视图：照 WorkBuddy 的「记忆与进化」 ---------------- */

      /* 文档里按分区出现顺序排；没有内容的分区不出现，免得留下一行空标题。 */
      const docSections = scopeSections.filter((section) =>
        records.some((record) => record.scope === section.id));

      const docText = () =>
        docSections
          .map((section) => {
            const blocks = records
              .filter((record) => record.scope === section.id)
              .map((record) => `**${record.title || t("untitled")}**\n${String(record.content || "").trim()}`);
            return [`## ${section.label}`, ...blocks].join("\n");
          })
          .join("\n\n");

      /* 解析整篇文档：`## 分区` 换区，`**标题**` 起一条，其余非空行并入正文。 */
      const parseDoc = (text) => {
        const out = [];
        let scopeId = docSections[0]?.id || "workspace";
        let current = null;
        for (const raw of String(text ?? "").replace(/\r\n/g, "\n").split("\n")) {
          const line = raw.trim();
          const heading = /^##\s+(.+)$/.exec(line);
          if (heading) {
            const hit = scopeSections.find((section) => section.label === heading[1].trim());
            if (hit) scopeId = hit.id;
            current = null;
            continue;
          }
          const bold = /^\*\*(.+?)\*\*$/.exec(line);
          if (bold) {
            current = { scope: scopeId, title: bold[1].trim(), lines: [] };
            out.push(current);
            continue;
          }
          if (!line) {
            if (current) current.lines.push("");
            continue;
          }
          if (!current) {
            current = { scope: scopeId, title: "", lines: [] };
            out.push(current);
          }
          current.lines.push(line);
        }
        return out
          .map((item) => {
            if (item.title) {
              return { scope: item.scope, title: item.title, content: item.lines.join("\n").trim() };
            }
            /* 没写粗体标题的，首行当标题、其余当正文。 */
            const at = item.lines.findIndex((line) => line.trim());
            return {
              scope: item.scope,
              title: String(item.lines[at] || "").trim().slice(0, 60),
              content: item.lines.slice(at + 1).join("\n").trim(),
            };
          })
          .filter((item) => item.title || item.content);
      };

      /* 回写整篇：同名同区的更新正文，没命中的新建，文档里消失的归档（不删除）。 */
      const applyDoc = () => {
        const blocks = parseDoc(docDraft);
        const known = new Map(records.map((record) => [`${record.scope}\u0000${record.title}`, record]));
        const kept = new Set();
        setBusy(true);
        setError("");
        (async () => {
          let written = 0;
          let archived = 0;
          for (const block of blocks) {
            const hit = known.get(`${block.scope}\u0000${block.title}`);
            if (hit) {
              kept.add(hit.id);
              if (String(hit.content || "").trim() !== block.content) {
                await api.update({ workspace: target, id: hit.id, content: block.content });
                written += 1;
              }
              continue;
            }
            await api.save({
              workspace: target,
              source: "manual",
              title: block.title,
              content: block.content,
              scope: block.scope,
            });
            written += 1;
          }
          const gone = records
            .filter((record) => !kept.has(record.id) && !record.archived)
            .map((record) => record.id);
          if (gone.length) {
            await api.bulk({ workspace: target, action: "archive", ids: gone });
            archived = gone.length;
          }
          return { written, archived };
        })()
          .then((counts) => {
            setDocDraft(null);
            return afterWrite(
              t("docSaved").replace("{n}", String(counts.written)).replace("{a}", String(counts.archived)),
            );
          })
          .catch((cause) => setError(String(cause?.message || cause)))
          .finally(() => {
            if (alive.current) setBusy(false);
          });
      };

      /* 「整理」＝每个同标签分组各自合并成一条，原条目归档；没有可整理的组就直说。 */
      const tidyJobs = [];
      for (const section of scopeSections) {
        for (const group of groupRecords(records.filter((record) => record.scope === section.id), "tag")) {
          const items = mergeableItems(group);
          if (group.key.startsWith("tag:") && items.length > 1) {
            tidyJobs.push({ section, group: { ...group, items } });
          }
        }
      }
      const tidyAll = () => {
        if (!tidyJobs.length) {
          flash(t("tidyNothing"));
          return;
        }
        setBusy(true);
        setError("");
        (async () => {
          let done = 0;
          let skipped = 0;
          for (const job of tidyJobs) {
            const draft = consolidateDraft(job.section.id, job.group);
            try {
              await api.healthResolve({
                action: "merge",
                workspace: target,
                ids: job.group.items.map((record) => record.id),
                title: draft.title,
                category: draft.category,
                tags: draft.tags,
              });
              done += 1;
            } catch (cause) {
              /* 矛盾对与红线由服务端合并闸拒绝；跳过这一组，其余组继续整理。 */
              if (cause?.code === "contradiction_pair" || cause?.code === "redline_protected") {
                skipped += 1;
                continue;
              }
              throw cause;
            }
          }
          return { done, skipped };
        })()
          .then(({ done, skipped }) => {
            if (!done && skipped) {
              flash(t("tidyConflict"));
              return;
            }
            return afterWrite(
              t("tidied").replace("{n}", String(done)) +
                (skipped ? ` ${t("tidySkipped").replace("{n}", String(skipped))}` : ""),
            );
          })
          .catch((cause) => setError(String(cause?.message || cause)))
          .finally(() => {
            if (alive.current) setBusy(false);
          });
      };

      /* 开关行：点一下即时落库（POST /settings 是 patch 合并，只发这一个键）。 */
      const flipSetting = (key) => {
        const previous = Boolean(settings ? settings[key] : false);
        const next = !previous;
        setSettings((current) => ({ ...(current || {}), [key]: next }));
        /* 不清 settingsDirty：页面上可能还有没点保存的改动，这个开关不会替它们落库。 */
        setBusy(true);
        setError("");
        api
          .settings({ [key]: next })
          .then((payload) => {
            if (!alive.current) return;
            if (payload?.settings) setSettings(payload.settings);
            flash(t("saved"));
          })
          .catch((cause) => {
            if (!alive.current) return;
            /* 失败时把乐观翻转回退，别让界面显示一个服务端并不存在的值。 */
            setSettings((current) => ({ ...(current || {}), [key]: previous }));
            setError(String(cause?.message || cause));
          })
          .finally(() => {
            if (alive.current) setBusy(false);
          });
      };

      /* 导入：设置页与档案页共用一份（JSON 走结构化，其余按文本 + 格式解析）。 */
      const doImport = () => {
        setBusy(true);
        setError("");
        let payload;
        try {
          payload = JSON.parse(importText);
        } catch {
          payload = { text: importText, format: importFormat };
        }
        api
          .importAll({ workspace: target, mode: "merge", ...payload })
          .then((result) => {
            if (result?.detectedFormat) {
              flash(t("formatDetected").replace("{f}", result.formatLabel || result.detectedFormat));
            }
            setDocImport(false);
            return afterWrite(t("imported"));
          })
          .catch((cause) => setError(String(cause?.message || cause)))
          .finally(() => {
            if (alive.current) setBusy(false);
          });
      };

      const switchRow = (key, title, hint) => {
        const on = Boolean(settings ? settings[key] : false);
        return h("div", { className: "dshmem_swRow", key },
          h("div", { className: "dshmem_swMain" },
            h("div", { className: "dshmem_swTitle" }, title),
            h("div", { className: "dshmem_swHint" }, hint)),
          h("button", {
            type: "button",
            role: "switch",
            "aria-checked": on ? "true" : "false",
            "data-on": on ? "1" : "0",
            className: "dshmem_tgl",
            title,
            disabled: busy,
            onClick: () => flipSetting(key),
          }));
      };

      /* 档案视图 = 一个工作区一份长记忆；同一份内容还能按标签/按类型排成可整理的分组。
         原来「档案」与「记忆空间」是两个视图、内容完全重合，现在合成一个视图的两种排布：
         不分组 → 连续文档；按标签/按类型 → 可折叠、可整合的分组卡片。 */
      /* ZCode 式索引条目：默认「标题 + 一句话钩子」，点击展开全文——索引常驻、正文按需，
         和注入侧的索引式简报同一个心智模型。 */
      const [docExpanded, setDocExpanded] = useState({});
      /* 时间线条目、画像子块（工作区/全局）各自的展开态——「都设计成可展开」的统一折叠语言。 */
      const [tlExpanded, setTlExpanded] = useState({});
      /* 画像正文是首页主内容，默认展开；需要扫一眼时再折叠。 */
      const [portraitSubExpanded, setPortraitSubExpanded] = useState({ global: true });
      const docEntry = (record) => {
        const content = String(record.content || "").trim();
        const firstLine = content.split("\n").find((line) => line.trim()) || "";
        const hook = firstLine.length > 96 ? `${firstLine.slice(0, 95)}…` : firstLine;
        const open = Boolean(docExpanded[record.id]);
        return h("div", { className: "dshmem_docItem", key: record.id },
          h("div", { className: "dshmem_docHeadRow" },
            h("span", {
              className: "dshmem_chev",
              style: { cursor: "pointer" },
              onClick: () => setDocExpanded((current) => ({ ...current, [record.id]: !current[record.id] })),
            }, open ? "▾" : "▸"),
            h("span", {
              className: "dshmem_docTitle",
              style: { cursor: "pointer" },
              onClick: () => setDocExpanded((current) => ({ ...current, [record.id]: !current[record.id] })),
            }, record.title || t("untitled")),
            injectedChip(record),
            ...securityChips(record),
            ...reviewChips(record),
            h("span", {
              className: "dshmem_docFree",
              onClick: () => {
                setMergeIds(null);
                setDraft(record);
              },
            }, t("edit"))),
          open
            ? content
              ? h("div", { className: "dshmem_docPara" }, content)
              : null
            : hook
              ? h("div", { className: "dshmem_docPara" }, hook)
              : null);
      };

      const toggleRecent = () => setRecentOpen((value) => !value);
      const recentBox = recentItems.length
        ? h("div", { className: "dshmem_box" },
            h("div", { className: "dshmem_docHeadRow" },
              h("span", { className: "dshmem_chev", style: { cursor: "pointer" }, onClick: toggleRecent },
                recentOpen ? "▾" : "▸"),
              h("span", { className: "dshmem_docTitle", style: { cursor: "pointer" }, onClick: toggleRecent },
                t("recentTitle")),
              h("span", { className: "dshmem_hint" },
                t("recentSummary").replace("{n}", String(recentItems.length))),
              h("div", { style: { flex: 1 } }),
              h("button", {
                type: "button",
                className: "dshmem_btn dshmem_btn_sm",
                onClick: toggleRecent,
              }, recentOpen ? t("recentClose") : t("recentOpen"))),
            recentOpen
              ? h("div", { className: "dshmem" },
                  h("div", { className: "dshmem_hint" }, t("recentHint").replace("{n}", String(recentItems.length))),
                  h("div", { className: "dshmem_docFlat" }, recentItems.map(docEntry)))
              : null)
        : null;

      /* ------------- 画像卡：工作区 + 全局两份「全貌」；编辑按 `**段标题**` 分段。 ------------- */

      const portraitTextOf = (portrait) =>
        (portrait?.sections || [])
          .filter((section) => section.text)
          .map((section) => `**${section.title}**\n${section.text}`)
          .join("\n\n");

      const splitPortraitText = (text) => {
        const lines = String(text || "").split(/\r?\n/);
        const out = [];
        let current = null;
        for (const line of lines) {
          const match = line.match(/^\*\*(.+?)\*\*\s*$/);
          if (match) {
            current = { title: match[1].trim(), body: [] };
            out.push(current);
            continue;
          }
          if (current) current.body.push(line);
        }
        return out
          .map((section) => ({ title: section.title, text: section.body.join("\n").trim() }))
          .filter((section) => section.title);
      };

      const beginPortraitEdit = (scope, portrait) => {
        setPortraitSectionEdit(null);
        setPortraitEdit({ scope, text: portraitTextOf(portrait) });
      };

      const savePortraitEdit = () => {
        if (!portraitEdit) return;
        const sections = splitPortraitText(portraitEdit.text);
        if (!sections.length) {
          setError(t("portraitEmptySections"));
          return;
        }
        setPortraitBusy(true);
        setError("");
        (async () => {
          try {
            const payload = await api.savePortrait({
              workspace: target,
              scope: portraitEdit.scope,
              sections,
            });
            const next = payload?.portrait || null;
            setPortraitData((prev) => ({
              ...(prev || { workspace: null, global: null, history: [] }),
              [portraitEdit.scope === "global" ? "global" : "workspace"]: next,
            }));
            setPortraitEdit(null);
            flash(t("portraitSaved").replace("{v}", String(next?.version ?? "")));
            setDetailTick((value) => value + 1);
          } catch (cause) {
            setError(String(cause?.message || cause));
          } finally {
            if (alive.current) setPortraitBusy(false);
          }
        })();
      };

      const savePortraitSection = () => {
        if (!portraitSectionEdit) return;
        const scope = portraitSectionEdit.scope;
        const portrait = scope === "global" ? portraitData?.global : portraitData?.workspace;
        if (!portrait) return;
        const text = String(portraitSectionEdit.text || "").trim();
        if (!text) {
          setError(t("portraitEmptySection"));
          return;
        }
        const sections = portrait.sections.map((section) =>
          section.key === portraitSectionEdit.key ? { ...section, text } : section
        );
        setPortraitBusy(true);
        setError("");
        (async () => {
          try {
            const payload = await api.savePortrait({ workspace: target, scope, sections });
            const next = payload?.portrait || null;
            setPortraitData((prev) => ({
              ...(prev || { workspace: null, global: null, history: [] }),
              [scope === "global" ? "global" : "workspace"]: next,
            }));
            setPortraitSectionEdit(null);
            flash(t("portraitSaved").replace("{v}", String(next?.version ?? "")));
            setDetailTick((value) => value + 1);
          } catch (cause) {
            setError(String(cause?.message || cause));
          } finally {
            if (alive.current) setPortraitBusy(false);
          }
        })();
      };

      /* 重写画像：LLM 重写式合并（日志 + 条目 → 全局画像）；draft 模式进待审。 */
      const doPortraitRewrite = () => {
        setRewriteBusy(true);
        setError("");
        flash(t("portraitRewriting"));
        (async () => {
          try {
            const payload = await api.rewritePortrait({ scope: "global" });
            const degraded = payload?.degraded && payload.degraded !== "none";
            flash(
              degraded
                ? t("portraitRewriteDegraded")
                : payload?.drafted
                  ? t("portraitDrafted")
                  : t("portraitRewritten"),
            );
            setDetailTick((value) => value + 1);
          } catch (cause) {
            setError(String(cause?.message || cause));
          } finally {
            if (alive.current) setRewriteBusy(false);
          }
        })();
      };

      /* 从其它 App 迁移画像：粘贴那边 AI 的 JSON 回答 → /portrait/migrate 与全局画像整合。 */
      const doPortraitMigrate = () => {
        const migrated = migrateText.trim();
        if (!migrated) return;
        setMigrateBusy(true);
        setError("");
        (async () => {
          try {
            await api.portraitMigrate({ text: migrated });
            flash(t("migrateDone"));
            setMigrateText("");
            setDetailTick((value) => value + 1);
          } catch (cause) {
            setError(String(cause?.message || cause));
          } finally {
            if (alive.current) setMigrateBusy(false);
          }
        })();
      };

      /* 画像 → AGENTS.md：把「协作约定」段写进工作区 AGENTS.md（派生链第二跳）。 */
      const doPortraitPromote = () => {
        setPortraitBusy(true);
        setError("");
        (async () => {
          try {
            const payload = await api.promote({ workspace: target, from: "portrait", section: "preference" });
            flash(t("portraitPromoted").replace("{n}", String((payload?.lines || []).length)));
            setDetailTick((value) => value + 1);
          } catch (cause) {
            setError(String(cause?.message || cause));
          } finally {
            if (alive.current) setPortraitBusy(false);
          }
        })();
      };

      /* 画像 2.0：拉上一版 → 当前版的 diff；点开才请求，失败不清空已有画像。 */
      const loadPortraitDiff = () => {
        setPortraitDiffBusy(true);
        setError("");
        (async () => {
          try {
            const payload = await api.portraitDiff(target);
            setPortraitDiffData(payload || null);
          } catch (cause) {
            setError(String(cause?.message || cause));
          } finally {
            if (alive.current) setPortraitDiffBusy(false);
          }
        })();
      };

      const togglePortraitDiff = () => {
        const next = !portraitDiffOpen;
        setPortraitDiffOpen(next);
        if (next && !portraitDiffData) loadPortraitDiff();
      };

      const loadDraft = () => {
        (async () => {
          try {
            const payload = await api.portraitDraft(target);
            setDraftData(payload?.draft || null);
          } catch (cause) {
            setError(String(cause?.message || cause));
          }
        })();
      };

      const approveDraftNow = () => {
        (async () => {
          try {
            await api.approveDraft({ workspace: target, scope: "global" });
            setDraftData(null);
            flash(t("portraitDraftApproved"));
            setDetailTick((value) => value + 1);
          } catch (cause) {
            setError(String(cause?.message || cause));
          }
        })();
      };

      const discardDraftNow = () => {
        (async () => {
          try {
            await api.discardDraft({ workspace: target, scope: "global" });
            setDraftData(null);
            flash(t("portraitDraftDiscarded"));
            setDetailTick((value) => value + 1);
          } catch (cause) {
            setError(String(cause?.message || cause));
          }
        })();
      };

      /* 工作日志：展开时拉最近几天（只读）。 */
      const toggleJournal = () => {
        const next = !journalOpen;
        setJournalOpen(next);
        if (next) {
          (async () => {
            try {
              const payload = await api.journal(target, { days: 3 });
              setJournalData(payload || null);
            } catch {
              /* 日志取不到不影响主列表 */
            }
          })();
        }
      };

      /* 画像证据：ref 显示成人能读的标签；没有证据的段标「未溯源」。 */
      const formatEvidenceRef = (ref) => {
        const text = String(ref || "");
        if (text.startsWith("journal:")) return `${text.slice(8)} 日志`;
        if (text.startsWith("mem_")) return `#${text}`;
        if (text.startsWith("session:")) return `会话 ${text.slice(8, 14)}`;
        return text;
      };
      const openEvidence = (ref) => {
        const value = String(ref || "");
        if (value.startsWith("mem_")) {
          setEvidenceView({ kind: "memory", id: value, loading: true, record: null, error: "" });
          api
            .record({ workspace: target, id: value })
            .then((payload) => {
              if (!alive.current) return;
              setEvidenceView((current) =>
                current && current.kind === "memory" && current.id === value
                  ? { ...current, loading: false, record: payload?.record || null }
                  : current,
              );
            })
            .catch((cause) => {
              if (!alive.current) return;
              setEvidenceView((current) =>
                current && current.kind === "memory" && current.id === value
                  ? { ...current, loading: false, error: String(cause?.message || cause) }
                  : current,
              );
            });
          return;
        }
        if (value.startsWith("journal:")) {
          const date = value.slice("journal:".length);
          setEvidenceView({ kind: "journal", date, loading: true, text: "", error: "" });
          api
            .journal(target, { date })
            .then((payload) => {
              if (!alive.current) return;
              setEvidenceView((current) =>
                current && current.kind === "journal" && current.date === date
                  ? { ...current, loading: false, text: payload?.text || "" }
                  : current,
              );
            })
            .catch((cause) => {
              if (!alive.current) return;
              setEvidenceView((current) =>
                current && current.kind === "journal" && current.date === date
                  ? { ...current, loading: false, error: String(cause?.message || cause) }
                  : current,
              );
            });
          return;
        }
        setEvidenceView({ kind: "other", ref: value, loading: false, text: "", error: "" });
      };
      const portraitEvidenceRow = (portraitLike, section) => {
        const refs = Array.isArray(portraitLike?.evidence?.[section.key]) ? portraitLike.evidence[section.key] : [];
        return h("div", { className: "dshmem_row", style: { gap: 4, flexWrap: "wrap" } },
          refs.length
            ? refs.map((ref) =>
                h("span", {
                  className: "dshmem_chip dshmem_chip_click",
                  key: ref,
                  role: "button",
                  tabIndex: 0,
                  title: t("evidenceOpen"),
                  onClick: () => openEvidence(ref),
                  onKeyDown: (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openEvidence(ref);
                    }
                  },
                }, formatEvidenceRef(ref)))
            : h("span", { className: "dshmem_chip" }, t("portraitUntraced")));
      };
      const evidencePanel = evidenceView
        ? h("div", { className: "dshmem_evidencePanel" },
            h("div", { className: "dshmem_docHeadRow" },
              h("span", { className: "dshmem_title" }, t("evidenceTitle")),
              h("div", { style: { flex: 1 } }),
              h("button", {
                type: "button",
                className: "dshmem_btn dshmem_btn_sm",
                onClick: () => setEvidenceView(null),
              }, t("recentClose"))),
            evidenceView.loading
              ? h(Spin)
              : evidenceView.error
                ? h("div", { className: "dshmem_err" }, evidenceView.error)
                : evidenceView.kind === "memory"
                  ? evidenceView.record
                    ? h("div", { className: "dshmem" },
                        h("div", { className: "dshmem_title" },
                          evidenceView.record.title || t("untitled")),
                        h("div", { className: "dshmem_meta" },
                          h("span", { className: "dshmem_chip" }, catLabel(evidenceView.record.category)),
                          evidenceView.record.archived
                            ? h("span", { className: "dshmem_chip" }, t("archived"))
                            : null,
                          h("span", null, String(evidenceView.record.updatedAt || "").slice(0, 10))),
                        h("div", { className: "dshmem_docPara" }, evidenceView.record.content))
                    : h("div", { className: "dshmem_hint" }, t("evidenceMissing"))
                  : evidenceView.kind === "journal"
                    ? h("div", { className: "dshmem" },
                        h("div", { className: "dshmem_meta" },
                          h("span", { className: "dshmem_chip" },
                            `${t("evidenceJournal")} ${evidenceView.date}`)),
                        h("div", { className: "dshmem_docPara" },
                          evidenceView.text || t("evidenceEmpty")))
                    : h("div", { className: "dshmem_hint" }, evidenceView.ref))
        : null;

      const portraitSectionOf = (scope, label, portrait) => {
        if (!portrait) return null;
        const editing = portraitEdit && portraitEdit.scope === scope;
        if (editing) {
          return h("div", { className: "dshmem", key: scope, style: { gap: 6 } },
            h("div", { className: "dshmem_docHeadRow" },
              h("span", { className: "dshmem_docTitle" },
                `${label}${portrait.version ? ` v${portrait.version}` : ""}`)),
            h("div", { className: "dshmem_hint" }, t("portraitEditHint")),
            h("textarea", {
              className: "dshmem_area",
              style: { minHeight: 150 },
              value: portraitEdit.text,
              onChange: (event) => setPortraitEdit({ scope, text: event.target.value }),
            }),
            h("div", { className: "dshmem_row" },
              h("button", {
                type: "button",
                className: "dshmem_btn dshmem_btn_primary",
                disabled: portraitBusy,
                onClick: savePortraitEdit,
              }, t("save")),
              h("button", {
                type: "button",
                className: "dshmem_btn",
                disabled: portraitBusy,
                onClick: () => setPortraitEdit(null),
              }, t("cancel"))));
        }
        /* 子折叠：默认只占一行（标题 + 字数/来源），点开才铺四段——和档案条目同一个折叠语言。 */
        const subOpen = Boolean(portraitSubExpanded[scope]);
        const chars = portrait.sections.reduce((n, section) => n + String(section.text || "").length, 0);
        const toggle = () => setPortraitSubExpanded((current) => ({ ...current, [scope]: !current[scope] }));
        return h("div", { className: "dshmem", key: scope, style: { gap: 4 } },
          h("div", { className: "dshmem_docHeadRow" },
            h("span", { className: "dshmem_chev", style: { cursor: "pointer" }, onClick: toggle },
              subOpen ? "▾" : "▸"),
            h("span", { className: "dshmem_docTitle", style: { cursor: "pointer" }, onClick: toggle },
              `${label}${portrait.version ? ` v${portrait.version}` : ""}`),
            h("span", { className: "dshmem_hint" },
              `${t("portraitCharsUnit").replace("{n}", String(chars))} · ${
                portrait.persistent ? t("portraitStored") : t("portraitFromMd")
              }`),
            h("div", { style: { flex: 1 } }),
            /* 晋升是工作区专属动作（AGENTS.md 是工作区文件），挂在对应块上而不是工具行。 */
            scope === "workspace"
              ? h("button", {
                  type: "button",
                  className: "dshmem_btn dshmem_btn_sm",
                  disabled: portraitBusy,
                  onClick: doPortraitPromote,
                }, t("portraitPromote"))
              : null,
            h("button", {
              type: "button",
              className: "dshmem_btn dshmem_btn_sm",
              disabled: portraitBusy,
              onClick: () => beginPortraitEdit(scope, portrait),
            }, t("editDoc"))),
          subOpen
            ? h("div", { className: "dshmem_docFlat" },
                portrait.sections
                  .filter((section) => section.text)
                  .map((section) => {
                    const editing =
                      portraitSectionEdit &&
                      portraitSectionEdit.scope === scope &&
                      portraitSectionEdit.key === section.key;
                    return h("div", { className: "dshmem_docPara", key: section.key },
                      editing
                        ? [
                            h("div", { className: "dshmem_docHeadRow" },
                              h("span", { style: { fontWeight: 500 } }, `${section.title}：`)),
                            h("textarea", {
                              className: "dshmem_area",
                              style: { minHeight: 90 },
                              value: portraitSectionEdit.text,
                              onChange: (event) =>
                                setPortraitSectionEdit((current) => ({ ...current, text: event.target.value })),
                            }),
                            h("div", { className: "dshmem_row" },
                              h("button", {
                                type: "button",
                                className: "dshmem_btn dshmem_btn_sm dshmem_btn_primary",
                                disabled: portraitBusy,
                                onClick: savePortraitSection,
                              }, t("save")),
                              h("button", {
                                type: "button",
                                className: "dshmem_btn dshmem_btn_sm",
                                disabled: portraitBusy,
                                onClick: () => setPortraitSectionEdit(null),
                              }, t("cancel")))
                          ]
                        : [
                            h("div", { className: "dshmem_docHeadRow" },
                              h("span", { style: { fontWeight: 500 } }, `${section.title}：`),
                              h("div", { style: { flex: 1 } }),
                              h("button", {
                                type: "button",
                                className: "dshmem_btn dshmem_btn_sm",
                                onClick: () =>
                                  setPortraitSectionEdit({ scope, key: section.key, text: section.text }),
                              }, t("portraitEditSection"))),
                            section.text,
                            portraitEvidenceRow(portrait, section)
                          ]);
                  }))
            : null);
      };

      /*
       * 红线卡（置顶于画像之上）：用户的绝对禁令每轮注入、永不退场（store 层治理）。
       * 解除走显式确认 + overrideRedline——这是模型拿不到的唯一删除通道。
       */
      const redlineRecords = (redlineData || records)
        .filter((record) => record.category === "constraint" && !record.archived)
        .sort(
          (a, b) =>
            String(a.createdAt || "").localeCompare(String(b.createdAt || "")) ||
            String(a.id).localeCompare(String(b.id)),
        );
      const redlineScopeLabel = (scope) => (scope === "global" ? t("scopeGlobalFull") : t("scopeWorkspace"));
      const redlineSourceLabel = (source) =>
        source === "manual"
          ? t("redlineSourceUser")
          : source === "agent"
            ? t("redlineSourceAgent")
            : source === "auto"
              ? t("redlineSourceAuto")
              : source === "import"
                ? t("redlineSourceImport")
                : source;
      const clampInject = (value, max) => {
        const text = String(value || "").trim();
        return text.length > max ? `${text.slice(0, max - 1)}…` : text;
      };
      const closeRedlineEditor = () => {
        setRedlineEdit(null);
        setRedlineConflicts([]);
      };
      const openRedlineEditor = (record) => {
        setDraft(null);
        setMergeIds(null);
        setQueueEdit(null);
        setRedlineHistoryView(null);
        setRedlineConflicts([]);
        setRedlineEdit(
          record
            ? {
                id: record.id,
                title: record.title,
                content: record.content,
                scope: record.scope,
                source: record.source,
                originalTitle: record.title,
                originalContent: record.content,
              }
            /* 红线页签是跨范围的：新红线默认全局，工作区级的在表单里改。 */
            : { id: null, title: "", content: "", scope: "global" },
        );
      };
      const persistRedline = () => {
        if (!redlineEdit) return;
        const title = String(redlineEdit.title || "").trim();
        const content = String(redlineEdit.content || "").trim();
        setBusy(true);
        setError("");
        const request = redlineEdit.id
          ? api.redlineUpdate({
              workspace: target,
              id: redlineEdit.id,
              title,
              content,
              confirm: true,
            })
          : api.save({
              workspace: target,
              category: "constraint",
              source: "manual",
              scope: redlineEdit.scope,
              title,
              content,
            });
        request
          .then(() => {
            closeRedlineEditor();
            return afterWrite(t("redlineSaved"));
          })
          .catch((cause) => setError(String(cause?.message || cause)))
          .finally(() => {
            if (alive.current) setBusy(false);
          });
      };
      const saveRedline = (force = false) => {
        if (!redlineEdit) return;
        const title = String(redlineEdit.title || "").trim();
        const content = String(redlineEdit.content || "").trim();
        if (!title || !content) {
          setError(t("redlineNeedBoth"));
          return;
        }
        if (force) {
          persistRedline();
          return;
        }
        setBusy(true);
        setError("");
        setRedlineConflicts([]);
        api
          .redlineCheck({
            workspace: target,
            title,
            content,
            excludeId: redlineEdit.id || undefined,
          })
          .then((payload) => {
            const conflicts = Array.isArray(payload?.conflicts) ? payload.conflicts : [];
            if (conflicts.length) {
              setRedlineConflicts(conflicts);
              setBusy(false);
              return;
            }
            persistRedline();
          })
          .catch((cause) => {
            setError(String(cause?.message || cause));
            setBusy(false);
          });
      };
      const openRedlineHistory = (record) => {
        setRedlineEdit(null);
        setRedlineConflicts([]);
        setBusy(true);
        setError("");
        api
          .redlineHistory({ workspace: target, id: record.id })
          .then((payload) => {
            setRedlineHistoryView({
              id: record.id,
              current: payload?.current || null,
              versions: Array.isArray(payload?.versions) ? payload.versions : [],
            });
          })
          .catch((cause) => setError(String(cause?.message || cause)))
          .finally(() => {
            if (alive.current) setBusy(false);
          });
      };
      const rollbackRedlineVersion = (index) => {
        if (!redlineHistoryView) return;
        setBusy(true);
        setError("");
        api
          .redlineRollback({
            workspace: target,
            id: redlineHistoryView.id,
            index,
            confirm: true,
          })
          .then(() => {
            setRedlineHistoryView(null);
            return afterWrite(t("redlineRolledBack"));
          })
          .catch((cause) => setError(String(cause?.message || cause)))
          .finally(() => {
            if (alive.current) setBusy(false);
          });
      };
      const redlinePreviewId = redlineEdit?.id ? `\`${redlineEdit.id}\`` : t("redlineIdPending");
      const redlinePreviewLine = redlineEdit
        ? `- ${clampInject(redlineEdit.title, 200)} — ${clampInject(redlineEdit.content, 500)} (${redlinePreviewId})`
        : "";
      const redlineOriginalPreviewLine = redlineEdit?.id
        ? `- ${clampInject(redlineEdit.originalTitle, 200)} — ${clampInject(redlineEdit.originalContent, 500)} (\`${redlineEdit.id}\`)`
        : "";
      const redlineEditor = redlineEdit
        ? h("div", { className: "dshmem_redlineEditor" },
            h("div", { className: "dshmem_title" },
              redlineEdit.id ? t("redlineEditorEdit") : t("redlineAdd")),
            h("input", {
              className: "dshmem_input",
              placeholder: t("redlineTitlePh"),
              value: redlineEdit.title,
              onChange: (event) => setRedlineEdit((current) => ({ ...current, title: event.target.value })),
            }),
            h("textarea", {
              className: "dshmem_area",
              placeholder: t("redlineContentPh"),
              value: redlineEdit.content,
              onChange: (event) => setRedlineEdit((current) => ({ ...current, content: event.target.value })),
            }),
            redlineEdit.id
              ? h("div", { className: "dshmem_meta" },
                  h("span", { className: "dshmem_chip" },
                    `${t("redlineScope")}：${redlineScopeLabel(redlineEdit.scope)}`),
                  h("span", { className: "dshmem_chip" },
                    `${t("redlineSource")}：${redlineSourceLabel(redlineEdit.source)}`))
              : h("div", { className: "dshmem_row" },
                  h("span", { className: "dshmem_lbl" }, t("redlineScope")),
                  h("select", {
                    className: "dshmem_select",
                    style: { width: "auto" },
                    value: redlineEdit.scope,
                    onChange: (event) =>
                      setRedlineEdit((current) => ({ ...current, scope: event.target.value })),
                  },
                    h("option", { value: "workspace" }, t("scopeWorkspace")),
                    h("option", { value: "global" }, t("scopeGlobalFull")))),
            redlineEdit.id
              ? h("div", { className: "dshmem" },
                  h("div", { className: "dshmem_hint" }, t("redlineCurrentVersion")),
                  h("pre", { className: "dshmem_redlinePreview" }, redlineOriginalPreviewLine))
              : null,
            h("div", { className: "dshmem_hint" }, t("redlinePreview")),
            h("pre", { className: "dshmem_redlinePreview" }, redlinePreviewLine),
            h("div", { className: "dshmem_hint" }, t("redlinePreviewHint")),
            redlineConflicts.length
              ? h("div", { className: "dshmem_err" },
                  h("div", null, t("redlineConflictHit")),
                  redlineConflicts.map((conflict) =>
                    h("div", { key: conflict.id },
                      `· ${conflict.title}${conflict.hint ? `：${conflict.hint}` : ""}`)),
                  h("div", { className: "dshmem_row" },
                    h("button", {
                      type: "button",
                      className: "dshmem_btn dshmem_btn_sm",
                      onClick: () => setRedlineConflicts([]),
                    }, t("redlineBackToEdit")),
                    h("button", {
                      type: "button",
                      className: "dshmem_btn dshmem_btn_sm dshmem_btn_danger",
                      disabled: busy,
                      onClick: () => saveRedline(true),
                    }, t("redlineSaveAnyway"))))
              : null,
            h("div", { className: "dshmem_row" },
              h("button", {
                type: "button",
                className: "dshmem_btn dshmem_btn_primary",
                disabled: busy,
                onClick: () => saveRedline(false),
              }, t("save")),
              h("button", {
                type: "button",
                className: "dshmem_btn",
                disabled: busy,
                onClick: closeRedlineEditor,
              }, t("cancel"))))
        : null;
      const redlineHistoryPanel = redlineHistoryView
        ? h("div", { className: "dshmem_redlineEditor" },
            h("div", { className: "dshmem_title" }, t("redlineHistoryTitle")),
            h("div", { className: "dshmem_hint" }, t("redlineHistoryHint")),
            redlineHistoryView.current
              ? h("div", { className: "dshmem" },
                  h("div", { className: "dshmem_hint" }, t("redlineCurrentVersion")),
                  h("pre", { className: "dshmem_redlinePreview" },
                    `- ${clampInject(redlineHistoryView.current.title, 200)} — ${
                      clampInject(redlineHistoryView.current.content, 500)
                    } (\`${redlineHistoryView.current.id}\`)`))
              : null,
            redlineHistoryView.versions.length
              ? [...redlineHistoryView.versions]
                  .map((version, index) => ({ version, index }))
                  .reverse()
                  .map(({ version, index }) =>
                    h("div", { className: "dshmem_issue", key: `${index}-${version.replacedAt}` },
                      h("div", { className: "dshmem_issueHead" },
                        h("span", { className: "dshmem_chip" },
                          version.replacedAt
                            ? String(version.replacedAt).slice(0, 16).replace("T", " ")
                            : `v${index + 1}`),
                        h("div", { style: { flex: 1 } }),
                        h("button", {
                          type: "button",
                          className: "dshmem_btn dshmem_btn_sm",
                          disabled: busy,
                          onClick: () => rollbackRedlineVersion(index),
                        }, t("rollback"))),
                      h("div", { className: "dshmem_issueBody" }, version.title),
                      h("div", { className: "dshmem_hint" }, version.content)))
              : h("div", { className: "dshmem_hint" }, t("redlineHistoryEmpty")),
            h("div", { className: "dshmem_row" },
              h("button", {
                type: "button",
                className: "dshmem_btn",
                onClick: () => setRedlineHistoryView(null),
              }, t("recentClose"))))
        : null;
      const redlineBox = h("div", { className: "dshmem_box dshmem_redline" },
        h("div", { className: "dshmem_docHeadRow" },
          h("span", { className: "dshmem_blockGroupTitle" },
            `${t("redlineTitle")}${redlineRecords.length ? ` (${redlineRecords.length})` : ""}`),
          redlineRecords.length > 1
            ? h("span", { className: "dshmem_count" }, t("redlineOrderHint"))
            : null,
          h("div", { style: { flex: 1 } }),
          h("button", {
            type: "button",
            className: "dshmem_btn dshmem_btn_sm dshmem_btn_primary",
            onClick: () => openRedlineEditor(null),
          }, t("redlineAdd"))),
        redlineEditor,
        redlineHistoryPanel,
        redlineRecords.length
          ? [
              h("div", { className: "dshmem_hint" }, t("redlineHint")),
              ...redlineRecords.map((record) =>
                h("div", { className: "dshmem_issue", key: record.id },
                  h("div", { className: "dshmem_issueHead" },
                    h("span", { className: "dshmem_chip dshmem_chip_redline" }, record.title),
                    h("span", { className: "dshmem_hint" },
                      `${redlineScopeLabel(record.scope)} · ${redlineSourceLabel(record.source)}`),
                    h("div", { style: { flex: 1 } }),
                    record.redlineHistory?.length
                      ? h("button", {
                          type: "button",
                          className: "dshmem_btn dshmem_btn_sm",
                          onClick: () => openRedlineHistory(record),
                        }, t("redlineHistory"))
                      : null,
                    h("button", {
                      type: "button",
                      className: "dshmem_btn dshmem_btn_sm",
                      onClick: () => openRedlineEditor(record),
                    }, t("redlineEdit")),
                    h("button", {
                      type: "button",
                      className: "dshmem_btn dshmem_btn_sm dshmem_btn_danger",
                      onClick: () => {
                        if (typeof window !== "undefined" && !window.confirm(t("redlineConfirm"))) return;
                        setRedlineHistoryView(null);
                        setRedlineEdit(null);
                        setRedlineConflicts([]);
                        run(api.remove({ workspace: target, id: record.id, overrideRedline: true }));
                      },
                    }, t("redlineRemove"))),
                  h("div", { className: "dshmem_issueBody" }, record.content)))
            ]
          : redlineEdit
            ? null
            : h("div", { className: "dshmem_hint" }, t("redlineEmptyHint")));

      /*
       * 平铺结构：工具行（重写 / 对比）+ 说明一行，下面只铺「全局画像」一块——
       * 工作区画像已从面板撤下（数据与 /portrait/* 端点保留，只是不再展示）。
       * 画像块各自折叠（portraitSubExpanded）；全局画像缺失时给空态引导，
       * 引导用户重写生成或走下面的「从其它 App 迁移画像」导入。
       */
      const portraitWorkspaceEmpty = h("div", { className: "dshmem", key: "workspace-empty", style: { gap: 4 } },
        h("div", { className: "dshmem_docHeadRow" },
          h("span", { className: "dshmem_docTitle" }, t("portraitGlobalLabel"))),
        h("div", { className: "dshmem_hint" }, t("portraitWorkspaceEmptyHint")),
        h("div", { className: "dshmem_row" },
          h("button", {
            type: "button",
            className: "dshmem_btn dshmem_btn_sm",
            disabled: rewriteBusy,
            onClick: doPortraitRewrite,
          }, rewriteBusy ? t("portraitRewritingShort") : t("portraitRewrite"))));

      const portraitBox = portraitData
        ? h("div", { className: "dshmem_box" },
            h("div", { className: "dshmem_docHeadRow" },
              h("span", { className: "dshmem_blockGroupTitle" }, t("portraitTitle")),
              h("div", { style: { flex: 1 } }),
              h("button", {
                type: "button",
                className: "dshmem_btn dshmem_btn_sm dshmem_btn_primary",
                disabled: portraitBusy || !portraitData.global,
                onClick: () => beginPortraitEdit("global", portraitData.global),
              }, t("portraitEdit")),
              h("button", {
                type: "button",
                className: "dshmem_btn dshmem_btn_sm",
                disabled: portraitDiffBusy,
                onClick: togglePortraitDiff,
              }, portraitDiffOpen ? t("portraitDiffClose") : t("portraitDiff")),
              h("button", {
                type: "button",
                className: "dshmem_btn dshmem_btn_sm",
                disabled: rewriteBusy,
                onClick: doPortraitRewrite,
              }, rewriteBusy ? t("portraitRewritingShort") : t("portraitRewrite"))),
            h("div", { className: "dshmem", style: { gap: 8 } },
              h("div", { className: "dshmem_hint" }, t("portraitSubtitle")),
              h("div", { className: "dshmem_hint" },
                Number(settings?.autoPortraitHours ?? 0) > 0
                  ? t("portraitAutoOn").replace("{hours}", String(Number(settings.autoPortraitHours))) +
                      (portraitData.global?.updatedAt
                        ? ` · ${t("portraitAutoAt").replace("{when}", String(portraitData.global.updatedAt).slice(0, 10))}`
                        : "")
                  : t("portraitAutoOff")),
              h("div", { className: "dshmem_hint" }, t("portraitAutoHint")),
                  /* 待审重写稿：预览 / 批准 / 丢弃（draft 模式时才有）。 */
                  portraitData.draft
                    ? h("div", { className: "dshmem_box", style: { padding: 8, gap: 6 } },
                        h("div", { className: "dshmem_hint" }, t("portraitDraftHint")),
                        draftData
                          ? h("div", { className: "dshmem_docFlat" },
                              draftData.sections
                                .filter((section) => section.text)
                                .map((section) =>
                                  h("div", { className: "dshmem_docPara", key: section.key },
                                    h("span", { style: { fontWeight: 500 } }, `${section.title}：`),
                                    section.text,
                                    portraitEvidenceRow(draftData, section))))
                          : null,
                        h("div", { className: "dshmem_row" },
                          h("button", {
                            type: "button",
                            className: "dshmem_btn dshmem_btn_sm",
                            onClick: () => (draftData ? setDraftData(null) : loadDraft()),
                          }, draftData ? t("portraitDraftHide") : t("portraitDraftView")),
                          h("button", {
                            type: "button",
                            className: "dshmem_btn dshmem_btn_sm dshmem_btn_primary",
                            onClick: approveDraftNow,
                          }, t("portraitDraftApprove")),
                          h("button", {
                            type: "button",
                            className: "dshmem_btn dshmem_btn_sm",
                            onClick: discardDraftNow,
                          }, t("portraitDraftDiscard"))))
                    : null,
                  /* 画像 2.0：上一版 → 当前版的逐段 diff（只读，点开才拉）。 */
                  portraitDiffOpen
                    ? h("div", { className: "dshmem_box", style: { padding: 8, gap: 6 } },
                        h("div", { className: "dshmem_hint" }, t("portraitDiffTitle")),
                        portraitDiffBusy
                          ? h("div", { className: "dshmem_hint" }, t("portraitDiffLoading"))
                          : !portraitDiffData
                            ? null
                            : !portraitDiffData.diff
                              ? h("div", { className: "dshmem_hint" }, t("portraitDiffNoPrevious"))
                              : h("div", { className: "dshmem" },
                                  h("div", { className: "dshmem_hint" },
                                    t("portraitDiffFrom")
                                      .replace("{from}", String(portraitDiffData.from?.version ?? "?"))
                                      .replace("{to}", String(portraitDiffData.to?.version ?? "?")) +
                                      (portraitDiffData.summary ? ` · ${portraitDiffData.summary}` : "")),
                                  ...((portraitDiffData.diff.changed || []).length
                                    ? (portraitDiffData.diff.changed || []).map((section) =>
                                        h("div", { key: section.key, className: "dshmem_docPara" },
                                          h("div", { style: { fontWeight: 500 } },
                                            `${section.title} +${section.added.length} −${section.removed.length}`),
                                          ...section.removed.map((line, index) =>
                                            h("div", {
                                              key: `r${index}`,
                                              className: "dshmem_hint",
                                              style: { textDecoration: "line-through" },
                                            }, `− ${line}`)),
                                          ...section.added.map((line, index) =>
                                            h("div", { key: `a${index}` }, `+ ${line}`))))
                                    : [h("div", { className: "dshmem_hint" }, t("portraitDiffEmpty"))])))
                    : null,
                  portraitData.global
                    ? portraitSectionOf("global", t("portraitGlobalLabel"), portraitData.global)
                    : portraitWorkspaceEmpty),
            evidencePanel)
        : null;

      /*
       * 从其它 App 迁移画像：复制提示词 → 拿到别的 App 让那边 AI 总结画像 →
       * 粘贴回来经 /portrait/migrate 与全局画像整合（后端返回 via: rewrite|fallback）。
       */
      const migrateBox = h("div", { className: "dshmem_box" },
        h("div", { className: "dshmem_title" }, t("migrateTitle")),
        h("div", { className: "dshmem_hint" }, t("migrateHint")),
        h("div", { className: "dshmem_row" },
          h("button", {
            type: "button",
            className: "dshmem_btn dshmem_btn_sm",
            onClick: () => {
              copyText(t("migratePrompt"))
                .then((ok) => {
                  if (ok) flash(t("migrateCopied"));
                  else setError(t("copyFailed"));
                })
                .catch((cause) => setError(String(cause?.message || cause)));
            },
          }, t("migrateCopy"))),
        /* 提示词全文常驻展示：复制前可确认内容，复制不可用时也能手动选中。 */
        h("div", { className: "dshmem_hint" }, t("migratePrompt")),
        h("textarea", {
          className: "dshmem_area",
          placeholder: t("migratePh"),
          value: migrateText,
          onChange: (event) => setMigrateText(event.target.value),
        }),
        h("div", { className: "dshmem_row" },
          h("button", {
            type: "button",
            className: "dshmem_btn dshmem_btn_sm dshmem_btn_primary",
            disabled: migrateBusy || !migrateText.trim(),
            onClick: doPortraitMigrate,
          }, t("migrateDo"))));

      /* 工作日志条（journal）：低门槛流水账，默认收起；展开时才拉最近几天。 */
      const journalBox = h("div", { className: "dshmem_box" },
        h("div", { className: "dshmem_docHeadRow" },
          h("span", { className: "dshmem_chev", style: { cursor: "pointer" }, onClick: toggleJournal },
            journalOpen ? "▾" : "▸"),
          h("span", { className: "dshmem_docTitle", style: { cursor: "pointer" }, onClick: toggleJournal },
            t("journalTitle")),
          h("span", { className: "dshmem_hint" },
            journalData?.dates?.length
              ? t("journalSummary").replace("{n}", String(journalData.dates.length))
              : t("journalHint")),
          h("div", { style: { flex: 1 } }),
          h("button", {
            type: "button",
            className: "dshmem_btn dshmem_btn_sm",
            onClick: toggleJournal,
          }, journalOpen ? t("recentClose") : t("recentOpen"))),
        journalOpen
          ? h("div", { className: "dshmem" },
              journalData?.recent?.length
                ? h("div", { className: "dshmem_docFlat" },
                    journalData.recent.map((item) =>
                      h("div", { key: item.date, style: { marginTop: 4 } },
                        h("div", { className: "dshmem_hint" }, item.date),
                        h("div", { className: "dshmem_docPara" }, String(item.text || "").trim()))))
                : h("div", { className: "dshmem_hint" }, t("journalEmpty")))
          : null);

      /* 时间线排布：同一份记忆按「日」切（含归档），和 Qoder 之外所有竞品都没做的视图。 */
      const timelineByDay = (() => {
        const q = tlQuery.trim().toLowerCase();
        const pool = q
          ? records.filter((record) =>
              String(record.title || "").toLowerCase().includes(q) ||
              String(record.content || "").toLowerCase().includes(q))
          : records;
        const byDay = new Map();
        for (const record of pool) {
          const day = String(record.updatedAt || record.createdAt || "").slice(0, 10) || "—";
          if (!byDay.has(day)) byDay.set(day, []);
          byDay.get(day).push(record);
        }
        return [...byDay.entries()].map(([day, items]) => ({ day, items }));
      })();

      /* 时间线条目与档案条目同一套折叠语言：▸ 标题 + 一句话钩子，点击展开全文；编辑走 hover 小按钮。 */
      const tlEntry = (record) => {
        const content = String(record.content || "").trim();
        const firstLine = content.split("\n").find((line) => line.trim()) || "";
        const hook = firstLine.length > 96 ? `${firstLine.slice(0, 95)}…` : firstLine;
        const open = Boolean(tlExpanded[record.id]);
        const toggle = () => setTlExpanded((current) => ({ ...current, [record.id]: !current[record.id] }));
        const openEditor = () => {
          setMergeIds(null);
          setQueueEdit(null);
          setDraft(record);
        };
        return h("div", {
          className: `dshmem_tlItem${record.archived ? " dshmem_tlItem_archived" : ""}`,
          key: record.id,
        },
          h("div", { className: "dshmem_tlHead" },
            h("span", { className: "dshmem_chev", style: { cursor: "pointer" }, onClick: toggle },
              open ? "▾" : "▸"),
            h("span", { className: "dshmem_chip" }, catLabel(record.category)),
            injectedChip(record),
            ...securityChips(record),
            ...reviewChips(record),
            record.scope === "global" ? h("span", { className: "dshmem_chip" }, t("globalTag")) : null,
            record.archived ? h("span", { className: "dshmem_chip" }, t("archived")) : null,
            h("span", { className: "dshmem_tlTitle", style: { cursor: "pointer" }, onClick: toggle },
              record.title || t("untitled")),
            h("span", { className: "dshmem_hint" },
              `${SOURCE_LABEL[record.source] || record.source} · ${String(record.updatedAt || "").slice(11, 16)}`,
              record.supersedes ? ` ${t("chainSupersedes")}` : ""),
            h("span", { className: "dshmem_docFree", onClick: openEditor }, t("edit"))),
          open
            ? content
              ? h("div", { className: "dshmem_tlBody" }, content)
              : null
            : hook
              ? h("div", { className: "dshmem_docPara" }, hook)
              : null);
      };

      const memorySections = groupBy === "timeline"
        ? h("div", { className: "dshmem_tl" },
            timelineByDay.length
              ? timelineByDay.map((group) =>
                  h("div", { key: group.day },
                    h("div", { className: "dshmem_tlDay" }, group.day),
                    group.items.map(tlEntry)))
              : h("div", { className: "dshmem_empty" }, t("empty")))
        : h("div", { className: "dshmem_space" },
            /* 文档排布只列有内容的分区（免得留下一行空标题）；分组排布保留空分区，好让「这里还没东西」看得见。 */
            (groupBy === "none" ? docSections : scopeSections).map((section) => {
              const items = records.filter((record) => record.scope === section.id);
              const key = `section:${section.id}`;
              const folded = isFolded(key);
              return h("div", { className: "dshmem_section", key: section.id },
                h("div", { className: "dshmem_sectionHead", onClick: () => toggleFolded(key) },
                  h("span", { className: "dshmem_chev" }, folded ? "▸" : "▾"),
                  h("span", { className: "dshmem_sectionTitle" }, section.label),
                  h("span", { className: "dshmem_count" }, `${items.length}${unitSuffix}`),
                  section.hint ? h("span", { className: "dshmem_hint dshmem_path" }, section.hint) : null
                ),
                folded || !items.length
                  ? null
                  : groupBy === "none"
                    ? h("div", { className: "dshmem_docFlat" }, items.map(docEntry))
                    : h("div", { className: "dshmem_groups" },
                        groupRecords(items).map((group) => groupNode(section.id, group))));
            }));

      const docPath = state?.mirror?.storageFile || state?.workspace?.dataFile || "";
      const docTab = h("div", { className: "dshmem" },
        h("div", { className: "dshmem_docToolbar" },
          h("div", { className: "dshmem_docCardHead" },
            h("div", { className: "dshmem_docMain" },
              h("div", { className: "dshmem_blockGroupTitle" }, t("manageMemory")),
              h("div", { className: "dshmem_hint" }, t("manageHint"))),
            h("div", { className: "dshmem_row" },
              h("button", {
                type: "button",
                className: "dshmem_btn",
                disabled: busy,
                onClick: tidyAll,
              }, t("tidy")),
              h("button", {
                type: "button",
                className: "dshmem_btn",
                disabled: busy || docDraft !== null,
                onClick: () => {
                  setDocImport(false);
                  setDocDraft(docText());
                },
              }, t("editDoc")),
              /* 导入按 JSON / 文本里的 scope 落库，没写 scope 的按项目走：
                 全局页不提供这个入口，免得在全局页导入却写进项目库。 */
              scope === "global"
                ? null
                : h("button", {
                    type: "button",
                    className: "dshmem_btn",
                    disabled: busy,
                    onClick: () => {
                      setDocDraft(null);
                      setDocImport((value) => !value);
                    },
                  }, t("importDo")))),
          /* 「一个工作区一份长记忆」：正文由对话里的记忆工具维护，不需要用户在这里逐条新建。 */
          h("div", { className: "dshmem_docAdd" }, t("docAddHint")),
          docImport && scope !== "global"
            ? h("div", { className: "dshmem" },
                h("textarea", {
                  className: "dshmem_area",
                  value: importText,
                  placeholder: t("importPh"),
                  onChange: (event) => setImportText(event.target.value),
                }),
                h("div", { className: "dshmem_row" },
                  h("button", {
                    type: "button",
                    className: "dshmem_btn dshmem_btn_primary",
                    disabled: busy || !importText.trim(),
                    onClick: doImport,
                  }, t("importDo")),
                  h("button", {
                    type: "button",
                    className: "dshmem_btn",
                    disabled: busy,
                    onClick: () => setDocImport(false),
                  }, t("cancel"))))
            : null,
          docDraft !== null
            ? h("div", { className: "dshmem" },
                h("div", { className: "dshmem_hint" }, t("docEditHint")),
                h("textarea", {
                  className: "dshmem_area dshmem_area_doc",
                  value: docDraft,
                  onChange: (event) => setDocDraft(event.target.value),
                }),
                h("div", { className: "dshmem_row" },
                  h("button", {
                    type: "button",
                    className: "dshmem_btn dshmem_btn_primary",
                    disabled: busy,
                    onClick: applyDoc,
                  }, t("save")),
                  h("button", {
                    type: "button",
                    className: "dshmem_btn",
                    disabled: busy,
                    onClick: () => setDocDraft(null),
                  }, t("cancel"))))
            : null),
        docDraft !== null
          ? null
          : records.length
            ? memorySections
            : h("div", { className: "dshmem_empty" },
                h("div", null, t("empty")),
                h("div", { className: "dshmem_hint" }, t("emptyHint"))),
        h("div", { className: "dshmem_docFoot" },
          scope === "global"
            ? t("docFooterGlobal")
            : t("docFooter").replace("{path}", docPath || "—"))
      );

      /* 空库首页：安装后第一次打开最可能看到这一屏。它要回答的是「怎么开始」而不是「这里空」——
         autoCapture 默认关，不点这一下，记忆库会一直是空的。 */
      const firstRunCard = () => {
        const autoOn = Boolean(settings?.autoCapture);
        return h("div", { className: "dshmem_first" },
          h("div", { className: "dshmem_firstTitle" }, t("firstRunTitle")),
          h("div", { className: "dshmem_hint" }, t("firstRunWhy")),
          h("ul", { className: "dshmem_firstList" },
            h("li", null, t("firstRunStep1")),
            h("li", null, t("firstRunStep2")),
            h("li", null, t("firstRunStep3"))),
          h("div", { className: "dshmem_row" },
            autoOn
              ? h("span", { className: "dshmem_hint" }, t("firstRunAutoOn"))
              : h("button", {
                  type: "button",
                  className: "dshmem_btn dshmem_btn_primary",
                  disabled: busy,
                  onClick: () => flipSetting("autoCapture"),
                }, t("firstRunAuto")),
            h("button", {
              type: "button",
              className: "dshmem_btn",
              disabled: busy,
              onClick: () => setDraft({}),
            }, t("firstRunCreate")),
            h("button", {
              type: "button",
              className: "dshmem_btn",
              disabled: busy,
              onClick: () => setTab("maintain"),
            }, t("firstRunScan"))));
      };

      /* 档案视图就是「一个工作区一份长记忆」：条数、范围 chip、搜索、排序、新建这些都属于
         列表视图，档案页只在最上面留视图切换与排布下拉。 */
      /* 范围已经由顶部页签决定，这里不再放三个范围 chip——只留本页条数与置顶数。 */
      /* 置顶数从当前范围的 records 数：stats.pinned 只算工作区，全局页会显示错的数。 */
      const scopePinned = records.filter((record) => record.pinned).length;
      const statsRow = h("div", { className: "dshmem_stats" },
          h("span", { className: "dshmem_chip" }, `${t("total")} ${scopeTotal}${unitSuffix}`),
          scopePinned
            ? h("span", { className: "dshmem_chip dshmem_chip_on" }, `${t("pinnedCount")} ${scopePinned}`)
            : null
        );

      const libraryEmpty = stats.total + stats.global === 0;
      const scopeEmpty = scopeTotal === 0;
      const attentionHealth = healthData?.health || null;
      const attentionDrafts = Array.isArray(queueData?.records) ? queueData.records : [];
      const attentionContradictions = Array.isArray(attentionHealth?.contradictions) ? attentionHealth.contradictions : [];
      const attentionReviews = Array.isArray(reviewData?.due) ? reviewData.due : [];
      const attentionStale = Array.isArray(attentionHealth?.stale) ? attentionHealth.stale : [];
      const attentionDeadFiles = Array.isArray(attentionHealth?.deadFiles) ? attentionHealth.deadFiles : [];
      const attentionOtherCount = attentionDeadFiles.length + (attentionHealth?.overBudget ? 1 : 0);
      /*
       * 优先用后端给的 attention.total：它只统计「插件不敢自动决、且不可逆」的项
       * （taint 隔离草稿 + 连续自动续期仍零引用的复审）。
       * 老后端没这个字段时回落到旧的加法，保证面板不炸。
       */
      const legacyAttentionCount = (Number(attentionHealth?.drafts ?? state?.stats?.drafts ?? 0) || 0) +
        attentionContradictions.length +
        (attentionHealth?.reviewDue?.length || 0) +
        attentionStale.length +
        attentionOtherCount;
      const attentionCount = libraryEmpty
        ? 0
        : Number(attentionHealth?.attention?.total ?? legacyAttentionCount) || 0;
      const attentionBox = libraryEmpty || loading
        ? null
        : h("div", { className: `dshmem_attention${attentionCount ? " dshmem_attention_alert" : ""}` },
            h("div", {
              className: "dshmem_attentionMain",
              style: attentionCount ? { cursor: "pointer" } : undefined,
              onClick: attentionCount ? () => setAttentionOpen((value) => !value) : undefined,
            },
              h("div", { className: "dshmem_attentionTitle" },
                attentionCount ? h("span", { className: "dshmem_chev" }, attentionOpen ? "▾" : "▸") : null,
                attentionCount ? `${t("attentionTitle")} ${attentionCount}` : t("attentionAuto")),
              h("div", { className: "dshmem_hint" },
                attentionCount ? t("attentionHint") : t("attentionAutoHint"))),
            attentionCount
              ? h("div", { className: "dshmem_row" },
                  h("button", {
                    type: "button",
                    className: "dshmem_btn dshmem_btn_sm",
                    onClick: () => setAttentionOpen((value) => !value),
                  }, attentionOpen ? t("recentClose") : t("attentionMore")),
                  h("button", {
                    type: "button",
                    className: "dshmem_btn dshmem_btn_sm",
                    onClick: () => setTab("maintain"),
                  }, t("attentionGo")))
              : null);
      const attentionInbox = attentionOpen && attentionCount > 0 && !libraryEmpty
        ? h("div", { className: "dshmem_attentionInbox" },
            !queueData && !reviewData ? h(Spin) : null,
            queueData && attentionDrafts.length
              ? h("div", { className: "dshmem_attentionSection" },
                  h("div", { className: "dshmem_attentionSectionHead" },
                    `${t("queueTitle")} (${attentionDrafts.length})`),
                  attentionDrafts.slice(0, 5).map((record) =>
                    h("div", { className: "dshmem_attentionItem", key: record.id },
                      h("div", { className: "dshmem_main" },
                        h("div", { className: "dshmem_title" }, record.title || t("untitled")),
                        h("div", { className: "dshmem_meta" },
                          h("span", { className: "dshmem_chip" }, catLabel(record.category)),
                          h("span", null, when(record.updatedAt)))),
                      h("div", { className: "dshmem_acts" },
                        h("button", {
                          type: "button",
                          className: "dshmem_btn dshmem_btn_sm dshmem_btn_primary",
                          disabled: busy,
                          onClick: () =>
                            run(api.approve({ workspace: target, id: record.id }), t("queueApproved")),
                        }, t("queueApprove")),
                        h("button", {
                          type: "button",
                          className: "dshmem_btn dshmem_btn_sm dshmem_btn_danger",
                          disabled: busy,
                          onClick: () => {
                            if (typeof window !== "undefined" && !window.confirm(t("confirmReject"))) return;
                            run(api.reject({ workspace: target, id: record.id }), t("queueRejected"));
                          },
                        }, t("queueReject"))))),
                  attentionDrafts.length > 5
                    ? h("button", {
                        type: "button",
                        className: "dshmem_btn dshmem_btn_sm",
                        onClick: () => setTab("maintain"),
                      }, t("attentionMore"))
                    : null)
              : null,
            attentionContradictions.length
              ? h("div", { className: "dshmem_attentionSection" },
                  h("div", { className: "dshmem_attentionSectionHead" },
                    `${t("healthContradictions")} (${attentionContradictions.length})`),
                  attentionContradictions.slice(0, 5).map((pair, index) =>
                    h("div", { className: "dshmem_attentionItem", key: `${pair.a}-${pair.b}-${index}` },
                      h("div", { className: "dshmem_main" },
                        h("div", { className: "dshmem_title" },
                          `${pair.aTitle || pair.a} ⇄ ${pair.bTitle || pair.b}`),
                        pair.hint ? h("div", { className: "dshmem_hint" }, pair.hint) : null))))
              : null,
            attentionReviews.length
              ? h("div", { className: "dshmem_attentionSection" },
                  h("div", { className: "dshmem_attentionSectionHead" },
                    `${t("reviewTitle")} (${attentionReviews.length})`),
                  attentionReviews.slice(0, 5).map((item) =>
                    h("div", { className: "dshmem_attentionItem", key: item.id },
                      h("div", { className: "dshmem_main" },
                        h("div", { className: "dshmem_title" }, item.title || t("untitled")),
                        h("div", { className: "dshmem_hint" },
                          `${t("reviewFalsifier")}：${item.falsifier || "—"}`)),
                      h("button", {
                        type: "button",
                        className: "dshmem_btn dshmem_btn_sm dshmem_btn_primary",
                        disabled: busy,
                        onClick: () => run(api.review({ workspace: target, id: item.id }), t("reviewDone")),
                      }, t("reviewDone")))))
              : null,
            attentionStale.length
              ? h("div", { className: "dshmem_attentionSection" },
                  h("div", { className: "dshmem_attentionSectionHead" },
                    `${t("healthStale")} (${attentionStale.length})`),
                  attentionStale.slice(0, 5).map((item) =>
                    h("div", { className: "dshmem_attentionItem", key: item.id },
                      h("div", { className: "dshmem_main" },
                        h("div", { className: "dshmem_title" }, item.title || item.id)))),
                  h("div", { className: "dshmem_row" },
                    h("button", {
                      type: "button",
                      className: "dshmem_btn dshmem_btn_sm",
                      disabled: busy,
                      onClick: () =>
                        run(
                          api.healthResolve({
                            workspace: target,
                            action: "archive",
                            ids: attentionStale.map((item) => item.id),
                          }),
                          t("saved"),
                        ),
                    }, t("healthArchiveAll"))))
              : null,
            attentionOtherCount
              ? h("div", { className: "dshmem_attentionSection" },
                  h("div", { className: "dshmem_attentionSectionHead" },
                    `${t("attentionOther")} (${attentionOtherCount})`),
                  attentionDeadFiles.slice(0, 5).map((item, index) =>
                    h("div", { className: "dshmem_attentionItem", key: `dead-${item.id}-${index}` },
                      h("div", { className: "dshmem_main" },
                        h("div", { className: "dshmem_title" }, item.title || item.id),
                        h("div", { className: "dshmem_hint" }, (item.files || []).join(" ｜ "))))),
                  attentionHealth?.overBudget
                    ? h("div", { className: "dshmem_hint" }, attentionHealth.overBudgetAdvice || "")
                    : null,
                  h("button", {
                    type: "button",
                    className: "dshmem_btn dshmem_btn_sm",
                    onClick: () => setTab("maintain"),
                  }, t("attentionGo")))
              : null)
        : null;
      const firstRun = (loading || recordsPending) && records.length === 0
        ? h(Spin)
        : libraryEmpty
          ? firstRunCard()
          : null;

      /* 项目页的下半部分：写入开关、导入扫描、迁移与工作日志，默认收起。 */
      const toolsDrawer = h("div", { className: "dshmem_tools" },
        h("div", { className: "dshmem_toolsHead", onClick: () => setToolsOpen((value) => !value) },
          h("span", { className: "dshmem_chev" }, toolsOpen ? "▾" : "▸"),
          h("span", { className: "dshmem_toolsTitle" }, t("toolsTitle")),
          h("span", { className: "dshmem_toolsSummary" }, t("toolsHint"))),
        h("div", { className: "dshmem_toolsBody", "data-open": toolsOpen ? "1" : "0" },
          h("div", { className: "dshmem_blockGroupHead" },
            h("span", { className: "dshmem_blockGroupTitle" }, t("rawToolsTitle"))),
          h("div", { className: "dshmem_toolsBlock" },
            switchRow("autoCapture", t("docAuto"), t("docAutoHint")),
            switchRow("mirror", t("docLocal"), t("docLocalHint"))),
            /* 从其它 App 导入（WorkBuddy / Qoder / Claude Code 等本机记忆文件）。 */
            h("div", { className: "dshmem_toolsBlock" },
          h("div", { className: "dshmem_title" }, t("scanTitle")),
          h("div", { className: "dshmem_hint" }, t("scanHint")),
          h("div", { className: "dshmem_row" },
            h("button", {
              type: "button",
              className: "dshmem_btn dshmem_btn_primary",
              disabled: scanning,
              onClick: () => {
                setScanning(true);
                api
                  .importScan(target)
                  .then((payload) => setScan(payload.scan))
                  .catch((cause) => setError(String(cause?.message || cause)))
                  .finally(() => {
                    if (alive.current) setScanning(false);
                  });
              },
            }, scanning ? t("scanning") : t("scanDo")),
            scan
              ? h("button", {
                  type: "button",
                  className: "dshmem_btn",
                  disabled: Boolean(scanBusy),
                  onClick: () => {
                    const ids = scan.sources.filter((source) => source.exists && source.files.length).map((source) => source.id);
                    if (!ids.length) return flash(t("scanNothing"));
                    setScanBusy("__all__");
                    api
                      .importFromScan({ workspace: target, mode: "merge", sources: ids })
                      .then((payload) => {
                        const n = payload.imported?.added ?? 0;
                        flash(t("scanImported").replace("{n}", String(n)));
                        return api.importScan(target).then((next) => setScan(next.scan));
                      })
                      .then(() => afterWrite())
                      .catch((cause) => setError(String(cause?.message || cause)))
                      .finally(() => {
                        if (alive.current) setScanBusy("");
                      });
                  },
                }, t("scanAll"))
              : null
          ),
          scan
            ? h("div", { className: "dshmem_sources" },
                scan.sources.map((source) =>
                  h("div", { className: "dshmem_source", key: source.id },
                    h("div", { className: "dshmem_source_head" },
                      h("span", { className: "dshmem_source_name" }, source.label),
                      h("span", {
                        className: `dshmem_chip${source.exists ? " dshmem_chip_on" : ""}`,
                      }, source.exists ? t("scanFiles").replace("{n}", String(source.files.length)) : t("scanAbsent")),
                      h("span", { className: "dshmem_meta" }, source.scope === "global" ? t("scanGlobal") : t("scanWorkspace"))
                    ),
                    source.exists
                      ? h("div", { className: "dshmem_source_path" }, source.dir)
                      : null,
                    source.exists && source.files.length
                      ? source.files.map((file) =>
                          h("div", { className: "dshmem_meta", key: file.path },
                            `${file.name} · ${file.format} · ${file.records}`)
                        )
                      : null,
                    source.exists && source.files.length
                      ? h("div", { className: "dshmem_row" },
                          h("button", {
                            type: "button",
                            className: "dshmem_btn",
                            disabled: Boolean(scanBusy),
                            onClick: () => {
                              setScanBusy(source.id);
                              api
                                .importFromScan({ workspace: target, mode: "merge", sources: [source.id] })
                                .then((payload) => {
                                  const n = payload.imported?.added ?? 0;
                                  flash(t("scanImported").replace("{n}", String(n)));
                                  return api.importScan(target).then((next) => setScan(next.scan));
                                })
                                .then(() => afterWrite())
                                .catch((cause) => setError(String(cause?.message || cause)))
                                .finally(() => {
                                  if (alive.current) setScanBusy("");
                                });
                            },
                          }, scanBusy === source.id ? t("scanning") : t("scanOne"))
                        )
                      : null
                  )
                )
              )
            : null
            ),
            migrateBox,
            journalBox));

      /*
       * 条目区：范围由顶部页签决定，条目就是这一页的主内容，不再塞进「原料」抽屉。
       * 档案 / 列表两种切法、搜索与筛选都留在这一块里，项目页与全局页共用同一套渲染。
       */
      const entriesBlock = h("div", { className: "dshmem_blockGroup" },
            libraryEmpty ? null : h("div", { className: "dshmem_blockGroupHead" },
              h("span", { className: "dshmem_blockGroupTitle" }, t("rawEntriesTitle")),
              h("span", { className: "dshmem_count" }, `${scopeTotal}${unitSuffix}`)),
            libraryEmpty ? null : h("div", { className: "dshmem_hint" }, t("entriesHint")),
            /* 条数与置顶数只在列表视图里出现：档案视图要的是连续正文，不是统计。 */
            !libraryEmpty && view === "list" && uiPrefs.showStats ? statsRow : null,

        scopeEmpty
          ? null
          : h("div", { className: "dshmem_bar" },
          view === "doc"
            ? null
            : h("input", {
                className: "dshmem_input dshmem_grow",
                value: query,
                placeholder: t("search"),
                onChange: (event) => setQuery(event.target.value),
              }),
          h("div", { className: "dshmem_seg" },
            h("button", {
              type: "button",
              className: `dshmem_seg_btn${view === "doc" ? " dshmem_seg_on" : ""}`,
              onClick: () => setView("doc"),
            }, t("viewDoc")),
            h("button", {
              type: "button",
              className: `dshmem_seg_btn${view === "list" ? " dshmem_seg_on" : ""}`,
              onClick: () => setView("list"),
            }, t("viewList"))
          ),
          /* 排布下拉只在档案视图里；整篇文档 / 按标签 / 按类型 / 时间线是同一份内容的四种切法。 */
          view === "doc"
            ? h("select", {
                className: "dshmem_select",
                style: { width: "auto" },
                value: groupBy,
                onChange: (event) => setGroupBy(event.target.value),
              },
                h("option", { value: "none" }, t("groupByNone")),
                h("option", { value: "tag" }, t("groupByTag")),
                h("option", { value: "category" }, t("groupByCategory")),
                h("option", { value: "timeline" }, t("groupByTimeline"))
              )
            : null,
          view === "doc" && groupBy === "timeline"
            ? h("input", {
                className: "dshmem_input",
                style: { width: 180 },
                value: tlQuery,
                placeholder: t("tlSearch"),
                onChange: (event) => setTlQuery(event.target.value),
              })
            : null,
          /* 列表只留搜索、视图、筛选、新建；排序 / 归档 / 标签收进筛选行，工作区在项目页顶部常驻。 */
          view === "doc"
            ? null
            : h("button", {
                type: "button",
                className: "dshmem_btn dshmem_btn_sm",
                onClick: () => setFiltersOpen((value) => !value),
              }, filtersOpen ? t("recentClose") : t("filters")),
          view === "doc"
            ? null
            : h("button", {
                type: "button",
                className: "dshmem_btn dshmem_btn_primary",
                /* 在哪一页新建就落在哪个范围，表单里还能改。 */
                onClick: () => setDraft({ scope: scope === "global" ? "global" : "workspace" }),
              }, t("newMemory"))
        ),

        libraryEmpty
          ? null
          : view === "doc"
            ? null
            : h("div", { className: "dshmem_filterBar", "data-open": filtersOpen ? "1" : "0" },
              h("select", {
                className: "dshmem_select",
                style: { width: "auto" },
                value: sort,
                onChange: (event) => setSort(event.target.value),
              },
                h("option", { value: "updated" }, t("sortUpdated")),
                h("option", { value: "created" }, t("sortCreated")),
                h("option", { value: "title" }, t("sortTitle"))
              ),
              h("label", { className: "dshmem_switch", style: { alignItems: "center" } },
                h("input", {
                  type: "checkbox",
                  checked: archived,
                  onChange: (event) => setArchived(event.target.checked),
                }),
                h("span", null, t("showArchived"))
              ),
              /* 工作区在项目页顶部单独选（常驻），筛选行这里只留当前路径。 */
              h("span", { className: "dshmem_hint dshmem_path" }, state?.workspace?.root || target || "—"),
              stats.pinned || Object.keys(stats.byCategory || {}).length
                ? h("div", { className: "dshmem_stats" },
                    stats.pinned
                      ? h("span", { className: "dshmem_chip dshmem_chip_on" }, `${t("pinnedCount")} ${stats.pinned}`)
                      : null,
                    Object.entries(stats.byCategory || {})
                      .sort((a, b) => b[1] - a[1])
                      .map(([id, count]) =>
                        h("span", {
                          key: id,
                          className: `dshmem_chip dshmem_chip_click${category === id ? " dshmem_chip_on" : ""}`,
                          onClick: () => setCategory(category === id ? "" : id),
                        }, `${catLabel(id)} ${count}`)))
                : null,
              tagList.length
                ? h("div", { className: "dshmem_stats" },
                    tagList.slice(0, 14).map((item) =>
                      h("span", {
                        key: item.tag,
                        className: "dshmem_chip dshmem_chip_click",
                        onClick: () => setQuery(item.tag),
                      }, `#${item.tag} ${item.count}`)))
                : null),

        scopeEmpty
          ? h("div", { className: "dshmem_empty" },
              h("div", null, tab === "global" ? t("globalEmpty") : t("empty")),
              h("div", { className: "dshmem_hint" },
                tab === "global" ? t("globalEmptyHint") : t("emptyHint")))
          : (loading || recordsPending) && records.length === 0
            ? h(Spin)
            : view === "doc"
              ? docTab
              : records.length === 0
                ? h("div", { className: "dshmem_empty" },
                    h("div", null, t("empty")),
                    h("div", { className: "dshmem_hint" }, t("emptyHint")))
                : h("div", { className: "dshmem_list" },
                      records.map((record) => cardNode(record, false)))
      );

      /*
       * 项目页顶部的「工作区」条：项目记忆必须绑定到一个具体工作区。
       * 选择器常驻（不再藏在列表筛选行里），旁边直接给出该工作区的 MEMORY.md 入口；
       * 全局记忆没有工作区维度，只在「全局记忆」页签出现。
       */
      const workspaceRows = useMemo(() => {
        const seen = new Set();
        const rows = [];
        for (const item of workspaces) {
          const root = String(item?.root || "");
          /* _global 是主库的全局分区（root 为空），不是工作区，不能出现在选择器里。 */
          if (!root) continue;
          if (seen.has(root)) continue;
          seen.add(root);
          rows.push({ ...item, root });
        }
        if (target && !seen.has(target)) {
          rows.push({ key: "current", root: target, count: scopeTotal, active: true });
        }
        return rows.sort(
          (a, b) =>
            (b.active ? 1 : 0) - (a.active ? 1 : 0) ||
            (b.live ? 1 : 0) - (a.live ? 1 : 0) ||
            String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")),
        );
      }, [workspaces, target, scopeTotal]);

      /* 只有「项目记忆」绑工作区；切换后不碰全局库。 */
      const switchWorkspace = (root) => {
        setWorkspace(String(root || ""));
        setManualRoot("");
        setDraft(null);
        setMergeIds(null);
        setDocDraft(null);
        setMirrorOpen(false);
      };

      const toggleWorkspaceMirror = () => {
        if (mirrorOpen) {
          setMirrorOpen(false);
          return;
        }
        setMirrorOpen(true);
        if (state?.mirror?.markdown || !target || mirrorBusy) return;
        setMirrorBusy(true);
        api
          .mirror(target)
          .then((payload) => {
            if (!alive.current) return;
            setState((current) => ({ ...(current || {}), mirror: payload.mirror }));
          })
          .catch((cause) => {
            if (alive.current) setError(String(cause?.message || cause));
          })
          .finally(() => {
            if (alive.current) setMirrorBusy(false);
          });
      };

      const workspaceMirrorText = state?.mirror?.markdown || "";
      const workspaceRowLabel = (item) =>
        `${baseName(item.root) || item.root}${item.active ? `（${t("projectActive")}）` : ""}${
          item.count ? ` · ${item.count}${unitSuffix}` : ""
        }`;

      const workspaceBar = tab === "project"
        ? h("div", { className: "dshmem_wsbar" },
            h("div", { className: "dshmem_wsbarMain" },
              h("span", { className: "dshmem_lbl" }, t("workspace")),
              workspaceRows.length > 1
                ? h("select", {
                    className: "dshmem_select",
                    style: { width: "auto", minWidth: 200, maxWidth: 320 },
                    value: target,
                    title: t("projectSwitchHint"),
                    onChange: (event) => switchWorkspace(event.target.value),
                  }, workspaceRows.map((item) =>
                    h("option", { key: item.key || item.root, value: item.root }, workspaceRowLabel(item))))
                : h("span", { className: "dshmem_chip dshmem_chip_on" },
                    `${baseName(target) || target || "—"}${scopeTotal ? ` · ${scopeTotal}${unitSuffix}` : ""}`),
              h("span", { className: "dshmem_hint" }, t("projectOnlyHint"))),
            h("div", { className: "dshmem_wsbarPath" },
              h("span", { className: "dshmem_path", title: target || "" }, target || "—")),
            h("div", { className: "dshmem_wsfile" },
              h("span", { className: "dshmem_chip dshmem_chip_on", title: t("projectMirrorHint") },
                t("projectMirrorTitle")),
              h("span", { className: "dshmem_path dshmem_grow", title: state?.mirror?.workspaceFile || "" },
                state?.mirror?.workspaceFile || "—"),
              h("span", {
                className: `dshmem_chip${state?.mirror?.workspaceExists ? " dshmem_chip_on" : ""}`,
              }, state?.mirror?.workspaceExists ? t("mirrorPresent") : t("mirrorAbsent")),
              h("button", {
                type: "button",
                className: `dshmem_btn dshmem_btn_sm${mirrorOpen ? "" : " dshmem_btn_primary"}`,
                disabled: mirrorBusy,
                onClick: toggleWorkspaceMirror,
              }, mirrorBusy ? t("mirrorLoading") : mirrorOpen ? t("projectMirrorHide") : t("projectMirrorShow")),
              mirrorOpen && workspaceMirrorText
                ? h("button", {
                    type: "button",
                    className: "dshmem_btn dshmem_btn_sm",
                    onClick: () => {
                      copyText(workspaceMirrorText).then((ok) => {
                        if (ok) flash(t("copied"));
                        else setError(t("copyFailed"));
                      });
                    },
                  }, t("copy"))
                : null,
              mirrorOpen
                ? workspaceMirrorText
                  ? h("pre", { className: "dshmem_mirror dshmem_wsfileBody" }, workspaceMirrorText)
                  : h("div", { className: "dshmem_hint" }, t("projectMirrorEmpty"))
                : null))
        : null;

      /*
       * 项目页：条目 + 写入工具（自动提炼、镜像、导入扫描、迁移、工作日志）。
       * 全局页：全局画像 + 全局条目。
       * 红线页：跨范围的绝对禁令工作台（不跟页签的 scope 走，单独拉全量）。
       */
      const redlineTab = h("div", { className: "dshmem" }, redlineBox);
      const memoryTab = h("div", { className: `dshmem${uiPrefs.density === "compact" ? " dshmem_dense" : ""}` },
        workspaceBar,
        tab === "global" && uiPrefs.showPortrait ? portraitBox : null,
        attentionBox,
        attentionInbox,
        tab === "project" ? firstRun : null,
        tab === "project" && uiPrefs.showBanner ? recentBox : null,
        entriesBlock,
        tab === "project" ? toolsDrawer : null);

      /* ---------------- 自动提炼：维护页里的手动触发、提炼输入与日志 ---------------- */

      const updateSetting = (key, value) => {
        setSettings((current) => ({ ...(current || {}), [key]: value }));
        setSettingsDirty(true);
      };

      /* 提炼日志：自动提炼页与健康页共用。 */
      const renderCaptures = () =>
        h("div", { className: "dshmem_box" },
          h("div", { className: "dshmem_title" }, t("captureLog")),
          captures.length === 0
            ? h("div", { className: "dshmem_hint" }, t("captureEmpty"))
            : h("div", { className: "dshmem_list" },
                captures.map((item, index) =>
                  h("div", { className: "dshmem_meta", key: `${item.at}-${index}` },
                    h("span", { className: "dshmem_chip" }, item.reason || "?"),
                    h("span", null, `${item.saved ?? 0} / ${item.candidates ?? 0}`),
                    h("span", null, when(item.at)),
                    item.titles && item.titles.length
                      ? h("span", { className: "dshmem_hint" }, item.titles.join(" · "))
                      : null,
                    item.error ? h("span", { className: "dshmem_err" }, item.error) : null
                  ))));

      const captureSection = h("div", { className: "dshmem" },
        h("div", { className: "dshmem_box" },
          h("div", { className: "dshmem_row" },
            h("button", {
              type: "button",
              className: "dshmem_btn dshmem_btn_primary",
              disabled: capturing,
              onClick: () => {
                setCapturing(true);
                setError("");
                api
                  .capture(target)
                  .then((payload) => {
                    const done = payload?.capture;
                    flash(
                      done?.ok
                        ? `${t("candidates")}: ${done.saved ?? 0}`
                        : `→ ${done?.reason || "no-op"}`,
                    );
                    if (alive.current) setCaptures(Array.isArray(payload?.captures) ? payload.captures : captures);
                    return api.state(target).then((next) => {
                      if (!alive.current) return;
                      setState(next);
                      setCaptures(Array.isArray(next.captures) ? next.captures : []);
                    });
                  })
                  .then(() => reload())
                  .catch((cause) => setError(String(cause?.message || cause)))
                  .finally(() => {
                    if (alive.current) setCapturing(false);
                  });
              },
            }, capturing ? t("capturing") : t("captureNow")),
            h("span", { className: "dshmem_hint" }, `${t("workspace")}: ${target || "—"}`)
          ),
          h("div", { className: "dshmem_hint" }, t("sAutoHint")),
          h("div", { className: "dshmem_meta" },
            h("span", null, `${t("sAuto")}: ${(state?.settings?.autoCapture ?? settings?.autoCapture) ? "on" : "off"}`),
            h("span", null, `${t("sLimit")}: ${settings?.briefingLimit ?? "—"}`)
          )
        ),

        h("div", { className: "dshmem_box" },
          h("div", { className: "dshmem_title" }, t("distillTitle")),
          h("textarea", {
            className: "dshmem_area",
            value: distillText,
            placeholder: t("distillPh"),
            onChange: (event) => setDistillText(event.target.value),
          }),
          h("div", { className: "dshmem_row" },
            h("button", {
              type: "button",
              className: "dshmem_btn",
              disabled: distilling || !distillText.trim(),
              onClick: () => {
                setDistilling(true);
                setError("");
                api
                  .distill(target, distillText)
                  .then((payload) => {
                    if (!alive.current) return;
                    setCandidates(Array.isArray(payload.candidates) ? payload.candidates : []);
                  })
                  .catch((cause) => setError(String(cause?.message || cause)))
                  .finally(() => {
                    if (alive.current) setDistilling(false);
                  });
              },
            }, distilling ? t("distilling") : t("distill")),
            candidates && candidates.length
              ? h("button", {
                  type: "button",
                  className: "dshmem_btn dshmem_btn_primary",
                  disabled: busy,
                  onClick: () => {
                    setBusy(true);
                    Promise.all(
                      candidates.map((item) =>
                        api.save({
                          workspace: target,
                          title: item.title,
                          content: item.content,
                          category: item.category,
                          tags: item.tags,
                          scope: "workspace",
                          source: "auto",
                          confidence: item.confidence,
                          dedupe: true,
                        }),
                      ),
                    )
                      .then(() => {
                        setCandidates(null);
                        setDistillText("");
                        return afterWrite(t("adopted"));
                      })
                      .catch((cause) => setError(String(cause?.message || cause)))
                      .finally(() => {
                        if (alive.current) setBusy(false);
                      });
                  },
                }, t("adopt"))
              : null
          ),
          candidates
            ? candidates.length === 0
              ? h("div", { className: "dshmem_hint" }, t("noCandidates"))
              : h("div", { className: "dshmem_list" },
                  candidates.map((item, index) =>
                    h("div", { className: "dshmem_card", key: `${index}-${item.title}` },
                      h("div", { className: "dshmem_main" },
                        h("div", { className: "dshmem_title" }, item.title),
                        h("div", { className: "dshmem_body" }, item.content),
                        h("div", { className: "dshmem_meta" },
                          h("span", { className: "dshmem_chip" }, catLabel(item.category)),
                          typeof item.confidence === "number"
                            ? h("span", null, `${item.confidence.toFixed(2)}`)
                            : null,
                          (item.tags || []).map((tag) => h("span", { key: tag, className: "dshmem_tag" }, `#${tag}`))
                        )
                      )
                    )))
            : null
        ),

        renderCaptures()
      );

      /* ---------------- 设置页 ---------------- */

      const num = (key, label, min, max, step) =>
        h("label", { className: "dshmem_field" },
          h("span", { className: "dshmem_fieldLabel" }, label),
          h("input", {
            className: "dshmem_input",
            type: "number",
            min,
            max,
            step: step || 1,
            value: settings?.[key] ?? "",
            onChange: (event) => updateSetting(key, Number(event.target.value)),
          })
        );

      /* 会话卡外观用的滑杆：右侧实时显示当前值，夹取后的值才写回设置。 */
      const hudSlider = (key, label, min, max, step, format, onReset) => {
        const raw = Number(settings?.[key]);
        const shown = Number.isFinite(raw) ? Math.min(Math.max(raw, min), max) : min;
        return h("div", { className: "dshmem_slider" },
          h("span", { className: "dshmem_sliderTop" },
            h("span", null, label),
            h("span", { className: "dshmem_sliderVal" }, format(Number(settings?.[key]), shown)),
            onReset
              ? h("button", {
                  type: "button",
                  className: "dshmem_link",
                  title: onReset.title,
                  onClick: onReset.onClick,
                }, onReset.label)
              : null),
          h("input", {
            className: "dshmem_range",
            type: "range",
            min,
            max,
            step,
            value: shown,
            "aria-label": label,
            onChange: (event) => updateSetting(key, Number(event.target.value)),
          }));
      };

      const toggle = (key, label, hint) =>
        h("label", { className: "dshmem_switch" },
          h("input", {
            type: "checkbox",
            checked: Boolean(settings?.[key]),
            onChange: (event) => updateSetting(key, event.target.checked),
          }),
          h("span", null,
            h("div", null, label),
            hint ? h("div", { className: "dshmem_hint" }, hint) : null)
        );

      const fieldGroup = (title, children) =>
        h("div", { className: "dshmem_fieldGroup" },
          h("div", { className: "dshmem_fieldGroupTitle" }, title),
          h("div", { className: "dshmem_fieldGroupBody" }, ...children));

      /* 显示偏好用的两个小控件：分段选择（立即生效）与开关。 */
      const segRow = (label, options, value, onPick) =>
        h("div", { className: "dshmem_row" },
          h("span", { className: "dshmem_lbl" }, label),
          h("div", { className: "dshmem_seg" },
            options.map(([id, text]) =>
              h("button", {
                key: id,
                type: "button",
                className: `dshmem_seg_btn${value === id ? " dshmem_seg_on" : ""}`,
                onClick: () => onPick(id),
              }, text))));

      const uiToggle = (key, label) =>
        h("label", { className: "dshmem_switch" },
          h("input", {
            type: "checkbox",
            checked: uiPrefs[key] !== false,
            onChange: (event) => applyUi(key, event.target.checked),
          }),
          h("span", null, h("div", null, label)));

      /* ---------------- 设置页顶部的记忆概览（只读） ---------------- */
      /* 数据来自 /overview 聚合端点：一次拿齐计数 / 类别 / 趋势 / 画像覆盖，不拉明细、不写任何东西。 */
      const ovCounts = overviewData?.counts || {
        project: Number(stats.total) || 0,
        global: Number(stats.global) || 0,
        drafts: Number(stats.drafts) || 0,
        redlines: redlineRecords.length,
      };
      const ovProject = Number(ovCounts.project) || 0;
      const ovGlobal = Number(ovCounts.global) || 0;
      const ovRedlines = Number(ovCounts.redlines) || 0;
      const ovShareTotal = ovProject + ovGlobal;
      const ovProjectPct = ovShareTotal ? Math.round((ovProject / ovShareTotal) * 100) : 0;

      const ovCategories = (() => {
        const rows = Array.isArray(overviewData?.categories) ? overviewData.categories.slice(0, 6) : [];
        const max = rows.length ? rows[0].count : 1;
        return rows.map((row) => ({
          id: row.id,
          count: row.count,
          label: catLabel(row.id),
          pct: Math.round((row.count / max) * 100),
        }));
      })();

      /* 近 7 天新增：端点按 createdAt 分日；还没回来时先铺 7 根空柱，避免布局跳。 */
      const ovTrend = (() => {
        const rows = Array.isArray(overviewData?.trend) ? overviewData.trend : [];
        if (rows.length) {
          const max = Math.max(1, ...rows.map((row) => row.count));
          return rows.map((row) => ({
            key: row.date,
            label: String(Number(String(row.date).slice(8, 10))),
            count: row.count,
            pct: Math.round((row.count / max) * 100),
          }));
        }
        const out = [];
        for (let i = 6; i >= 0; i -= 1) {
          const day = new Date(Date.now() - i * 86400000);
          const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
          out.push({ key, label: String(day.getDate()), count: 0, pct: 0 });
        }
        return out;
      })();

      const ovBrief = state?.briefing || null;
      const ovBudgetMax = Number(settings?.briefingMaxChars) || 0;
      const ovBudgetUsed = Number(ovBrief?.chars) || 0;
      const ovBudgetPct = ovBudgetMax
        ? Math.min(100, Math.round((ovBudgetUsed / ovBudgetMax) * 100))
        : 0;

      /* 画像覆盖优先用端点结果；端点还没回来时退回已加载的全局画像。 */
      const ovPortraitTotal = Number(overviewData?.portrait?.total)
        || (Array.isArray(portraitData?.global?.sections) ? portraitData.global.sections.length : 0);
      const ovPortraitFilled = Number(overviewData?.portrait?.filled)
        || (Array.isArray(portraitData?.global?.sections)
          ? portraitData.global.sections.filter((section) => String(section.text || "").trim()).length
          : 0);
      const ovPortraitPct = ovPortraitTotal
        ? Math.round((ovPortraitFilled / ovPortraitTotal) * 100)
        : 0;

      const ovTile = (value, label) =>
        h("div", { className: "dshmem_tile" },
          h("div", { className: "dshmem_tileNum" }, String(value)),
          h("div", { className: "dshmem_tileLabel" }, label));

      const ovMeter = (title, pct, text) =>
        h("div", { className: "dshmem_ovBlock" },
          h("div", { className: "dshmem_ovBlockHead" }, title, h("span", { className: "dshmem_ovHint" }, `${pct}%`)),
          h("div", { className: "dshmem_meter" },
            h("div", { className: "dshmem_meterFill", style: { width: `${pct}%` } })),
          h("div", { className: "dshmem_ovHint" }, text));

      const overviewCard = h("div", { className: "dshmem_box dshmem_ov" },
        h("div", { className: "dshmem_docHeadRow" },
          h("span", { className: "dshmem_blockGroupTitle" }, t("overviewTitle")),
          h("span", { className: "dshmem_hint" }, t("overviewHint"))),
        libraryEmpty
          ? h("div", { className: "dshmem_hint" }, t("ovEmpty"))
          : [
              h("div", { className: "dshmem_ovGrid" },
                ovTile(ovProject, t("ovProject")),
                ovTile(ovGlobal, t("ovGlobal")),
                ovTile(Number(stats.drafts) || 0, t("ovDrafts")),
                ovTile(ovRedlines, t("ovRedlines"))),
              h("div", { className: "dshmem_ovBlock" },
                h("div", { className: "dshmem_ovBlockHead" }, t("ovShare")),
                h("div", { className: "dshmem_shareTrack" },
                  h("span", { className: "dshmem_shareA", style: { width: `${ovProjectPct}%` } }),
                  h("span", { className: "dshmem_shareB", style: { flex: 1 } })),
                h("div", { className: "dshmem_legend" },
                  h("span", null,
                    h("i", { className: "dshmem_dot dshmem_shareA" }),
                    `${t("ovProject")} ${ovProject}`),
                  h("span", null,
                    h("i", { className: "dshmem_dot dshmem_shareB" }),
                    `${t("ovGlobal")} ${ovGlobal}`))),
              ovCategories.length
                ? h("div", { className: "dshmem_ovBlock" },
                    h("div", { className: "dshmem_ovBlockHead" }, t("ovCategory")),
                    ovCategories.map((row) =>
                      h("div", { className: "dshmem_catRow", key: row.id },
                        h("span", { className: "dshmem_catName", title: row.label }, row.label),
                        h("div", { className: "dshmem_catTrack" },
                          h("div", { className: "dshmem_catFill", style: { width: `${row.pct}%` } })),
                        h("span", { className: "dshmem_catNum" }, String(row.count)))))
                : null,
              h("div", { className: "dshmem_ovBlock" },
                h("div", { className: "dshmem_ovBlockHead" }, t("ovTrend")),
                h("div", { className: "dshmem_trend" },
                  ovTrend.map((day) =>
                    h("div", { className: "dshmem_trendCol", key: day.key },
                      h("div", { className: "dshmem_trendTrack" },
                        h("div", {
                          className: `dshmem_trendBar${day.count ? " dshmem_trendBar_on" : ""}`,
                          style: { height: `${Math.max(4, day.pct)}%` },
                          title: `${day.key} · ${day.count}`,
                        })),
                      h("span", { className: "dshmem_trendDay" }, day.label))))),
              h("div", { className: "dshmem_ovGrid" },
                ovMeter(
                  t("ovBudget"),
                  ovBudgetPct,
                  ovBrief
                    ? t("ovBudgetLine")
                        .replace("{used}", String(ovBudgetUsed))
                        .replace("{max}", String(ovBudgetMax || "—"))
                        .replace("{count}", String(Number(ovBrief.count) || 0))
                    : "—",
                ),
                ovMeter(
                  t("ovPortrait"),
                  ovPortraitPct,
                  ovPortraitTotal
                    ? t("ovPortraitLine")
                        .replace("{filled}", String(ovPortraitFilled))
                        .replace("{total}", String(ovPortraitTotal))
                    : t("ovNoPortrait"),
                )),
            ]);

      /* 「该对话记忆」开关：只影响本会话的前台卡，默认开启。 */
      const toggleSessionMemory = (enabled) => {
        if (!sessionMemory.id) return;
        hudSetSessionOff(sessionMemory.id, !enabled);
        setSessionMemory((current) => ({ ...current, on: enabled }));
      };

      /* 会话卡外观：颜色只认 #rgb / #rrggbb；高度 0 = 随内容自适应。 */
      const hudColorValue = hudHexColor(settings?.hudColor);
      const hudHeightFixed = Number(settings?.hudHeight) >= HUD_LOOK_HEIGHT[0];
      /* 预览用的外观：直接吃设置页当前（未保存）的值，拖滑杆时立刻变。 */
      const previewLook = hudLookFrom({
        hud: {
          width: settings?.hudWidth,
          height: 0,
          opacity: settings?.hudOpacity,
          color: settings?.hudColor,
        },
      });
      const previewIcon = HUD_ICONS[settings?.hudIcon] || HUD_ICONS.a;
      const previewStamp = (() => {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
      })();

      const settingsTab = h("div", { className: "dshmem" },
        overviewCard,
        fieldGroup(t("viewGroup"), [
          h("div", { className: "dshmem_box" },
            h("div", { className: "dshmem_hint" }, t("viewGroupHint")),
            segRow(
              t("uiView"),
              [["doc", t("viewDoc")], ["list", t("viewList")]],
              uiPrefs.view,
              (value) => applyUi("view", value),
            ),
            segRow(
              t("uiGroupBy"),
              [
                ["none", t("groupByNone")],
                ["tag", t("groupByTag")],
                ["category", t("groupByCategory")],
                ["timeline", t("groupByTimeline")],
              ],
              uiPrefs.groupBy,
              (value) => applyUi("groupBy", value),
            ),
            segRow(
              t("uiDensity"),
              [["comfort", t("uiDensityComfort")], ["compact", t("uiDensityCompact")]],
              uiPrefs.density,
              (value) => applyUi("density", value),
            ),
            uiToggle("showPortrait", t("uiShowPortrait")),
            uiToggle("showStats", t("uiShowStats")),
            uiToggle("showBanner", t("uiShowBanner")))
        ]),
        fieldGroup(t("settingsGroupConversation"), [
          h("div", { className: "dshmem_box" },
            h("label", { className: "dshmem_switch" },
              h("input", {
                type: "checkbox",
                checked: sessionMemory.on,
                disabled: !sessionMemory.id,
                onChange: (event) => toggleSessionMemory(event.target.checked),
              }),
              h("span", null,
                h("div", null, t("sessionMemory")),
                h("div", { className: "dshmem_hint" }, t("sessionMemoryHint")))
            ),
            h("div", { className: "dshmem_meta" },
              h("span", { className: "dshmem_hint" }, sessionMemory.id ? "" : t("sessionMemoryNoSession")),
              h("span", { className: "dshmem_chip" },
                sessionMemory.id ? (sessionMemory.on ? t("sessionMemoryOn") : t("sessionMemoryOff")) : "—")
            )
          ),
          h("div", { className: "dshmem_box" },
            h("div", { className: "dshmem_row" },
              h("span", { className: "dshmem_lbl" }, t("hudIconLabel")),
              h("select", {
                className: "dshmem_select",
                style: { width: "auto" },
                value: HUD_ICONS[settings?.hudIcon] ? settings.hudIcon : "a",
                onChange: (event) => updateSetting("hudIcon", event.target.value),
              },
                h("option", { value: "a" }, t("hudIconA")),
                h("option", { value: "b" }, t("hudIconB")),
                h("option", { value: "c" }, t("hudIconC")),
                h("option", { value: "d" }, t("hudIconD")),
                h("option", { value: "e" }, t("hudIconE")),
                h("option", { value: "f" }, t("hudIconF")),
                h("option", { value: "g" }, t("hudIconG"))
              )
            ),
            h("div", { className: "dshmem_slider" },
              h("span", { className: "dshmem_sliderTop" },
                h("span", null, t("hudIconSizeLabel")),
                h("span", { className: "dshmem_sliderVal" }, `${hudIconSize} px`)),
              h("input", {
                className: "dshmem_range",
                type: "range",
                min: HUD_ICON_SIZE[0],
                max: HUD_ICON_SIZE[1],
                step: 1,
                value: hudIconSize,
                "aria-label": t("hudIconSizeLabel"),
                onChange: (event) => setHudIconSize(hudWriteIconSize(Number(event.target.value))),
              })),
            h("div", { className: "dshmem_hint" }, t("hudIconHint")),
            h("div", { className: "dshmem_hint" }, t("hudIconSizeHint")),
            /* 实时预览：和前台卡同一套结构 / 类名，改哪个滑杆这里立刻变。 */
            h("div", { className: "dshmem_hudPreviewLabel" },
              h("span", null, t("hudPreviewLabel"))),
            h("div", {
              className: "dshmem_hudPreview dshmem_hud_card",
              "data-translucent": previewLook.opacity < 0.999 ? "1" : "0",
              style: {
                ...hudLookVars(previewLook),
                "--dshmem-hud-icon": `${hudIconSize}px`,
                width: "100%",
                height: "auto",
              },
            },
              h("div", { className: "dshmem_hud_head" },
                h("span", { className: "dshmem_hud_grip", "data-static": "1", "aria-hidden": "true" }),
                h("span", { className: "dshmem_hud_brand", "aria-hidden": "true" },
                  h("span", { className: "dshmem_hud_glyph", style: { backgroundImage: previewIcon } })),
                h("span", { className: "dshmem_hud_title" }, t("hudTitle")),
                h("span", { className: "dshmem_hud_iconbtn", "aria-hidden": "true" }, "×")),
              h("div", { className: "dshmem_hud_time" },
                t("hudUpdated").replace("{when}", previewStamp)),
              h("div", { className: "dshmem_hud_body" }, t("hudPreviewBody")))
          ),
          h("div", { className: "dshmem_box" },
            h("div", { className: "dshmem_row" },
              hudSlider("hudWidth", t("hudWidthLabel"), HUD_LOOK_WIDTH[0], HUD_LOOK_WIDTH[1], 10,
                (value, shown) => `${shown} px`),
              hudSlider("hudHeight", t("hudHeightLabel"), HUD_LOOK_HEIGHT[0], HUD_LOOK_HEIGHT[1], 10,
                (value, shown) => (Number(value) >= HUD_LOOK_HEIGHT[0] ? `${shown} px` : t("hudHeightAuto")),
                hudHeightFixed
                  ? {
                      label: t("hudHeightAuto"),
                      title: t("hudHeightAutoHint"),
                      onClick: () => updateSetting("hudHeight", 0),
                    }
                  : null)
            ),
            h("div", { className: "dshmem_row" },
              hudSlider("hudOpacity", t("hudOpacityLabel"), HUD_LOOK_OPACITY[0], HUD_LOOK_OPACITY[1], 0.05,
                (value, shown) => `${Math.round(shown * 100)}%`),
              h("div", { className: "dshmem_slider", style: { maxWidth: "220px" } },
                h("span", { className: "dshmem_sliderTop" },
                  h("span", null, t("hudColorLabel")),
                  h("span", { className: "dshmem_sliderVal" }, hudColorValue || t("hudColorAuto"))),
                h("span", { className: "dshmem_colorRow" },
                  h("input", {
                    type: "color",
                    className: "dshmem_color",
                    "aria-label": t("hudColorLabel"),
                    value: hudColorValue ? hudFullHex(hudColorValue) : "#ffffff",
                    onChange: (event) => updateSetting("hudColor", event.target.value),
                  }),
                  h("button", {
                    type: "button",
                    className: "dshmem_link",
                    disabled: !hudColorValue,
                    onClick: () => updateSetting("hudColor", ""),
                  }, t("hudColorAuto"))))
            ),
            h("div", { className: "dshmem_hint" }, t("hudLookHint"))
          )
        ]),
        fieldGroup(t("settingsGroupInject"), [
          h("div", { className: "dshmem_box" },
            toggle("enabled", t("sEnabled")),
            toggle("briefing", t("sBriefing"), t("sBriefingHint")),
            h("div", { className: "dshmem_row" },
              h("span", { className: "dshmem_lbl" }, t("sBriefMode")),
              h("select", {
                className: "dshmem_select",
                style: { width: "auto" },
                value:
                  settings?.briefMode === "full"
                    ? "full"
                    : settings?.briefMode === "portrait"
                      ? "portrait"
                      : "index",
                onChange: (event) => updateSetting("briefMode", event.target.value),
              },
                h("option", { value: "index" }, t("modeIndex")),
                h("option", { value: "full" }, t("modeFull")),
                h("option", { value: "portrait" }, t("modePortrait"))
              )
            ),
            h("div", { className: "dshmem_row" },
              num("briefingLimit", t("sLimit"), 1, 50),
              num("briefingMaxChars", t("sChars"), 200, 20000, 100),
              num("portraitMaxChars", t("sPortraitChars"), 200, 8000, 100)
            ),
            toggle("autoInject", t("sAutoInject"), t("sAutoInjectHint")),
            toggle("turnRecall", t("sTurnRecall"), t("sTurnRecallHint")),
            h("div", { className: "dshmem_row" },
              num("turnRecallLimit", t("sTurnRecallLimit"), 1, 10)
            ),
            toggle("discipline", t("sDiscipline"), t("sDisciplineHint"))
          )
        ]),
        fieldGroup(t("settingsGroupCapture"), [
          h("div", { className: "dshmem_box" },
            toggle("autoCapture", t("sAuto"), t("sAutoHint")),
            h("div", { className: "dshmem_row" },
              h("span", { className: "dshmem_lbl" }, t("sCaptureMode")),
              h("select", {
                className: "dshmem_select",
                style: { width: "auto" },
                value: settings?.captureMode || "direct",
                onChange: (event) => updateSetting("captureMode", event.target.value),
              },
                h("option", { value: "direct" }, t("captureDirect")),
                h("option", { value: "review" }, t("captureReview")),
                h("option", { value: "draft" }, t("captureDraft"))
              )
            ),
            h("div", { className: "dshmem_row" },
              num("autoCaptureMinChars", t("sAutoMin"), 0, 200000, 100),
              num("captureCooldownMs", t("sCooldown"), 0, 3600000, 1000)
            ),
            h("div", { className: "dshmem_row" },
              num("minConfidence", t("sMinConf"), 0, 1, 0.05),
              num("maxPerTurn", t("sMaxTurn"), 1, 20)
            ),
            h("div", { className: "dshmem_row" },
              num("maxTranscriptChars", t("sTranscript"), 500, 60000, 500)
            ),
            toggle("captureSubagents", t("sCaptureSub"), t("sCaptureSubHint"))
          )
        ]),
        fieldGroup(t("settingsGroupDistill"), [
          h("div", { className: "dshmem_box" },
            toggle("globalDistill", t("sGlobalDistill"), t("sGlobalDistillHint")),
            h("div", { className: "dshmem_row" },
              num("globalDistillMinNew", t("sGlobalDistillMinNew"), 1, 50),
              num("globalDistillCooldownMinutes", t("sGlobalDistillCooldown"), 1, 1440)
            ),
            h("div", { className: "dshmem_hint" }, t("sGlobalDistillCadenceHint"))
          )
        ]),
        fieldGroup(t("settingsGroupGovernance"), [
          h("div", { className: "dshmem_box" },
            h("div", { className: "dshmem_row" },
              h("span", { className: "dshmem_lbl" }, t("sRewriteMode")),
              h("select", {
                className: "dshmem_select",
                style: { width: "auto" },
                value: settings?.rewriteMode === "draft" ? "draft" : "direct",
                onChange: (event) => updateSetting("rewriteMode", event.target.value),
              },
                h("option", { value: "direct" }, t("rewriteDirect")),
                h("option", { value: "draft" }, t("rewriteDraft"))
              ),
              num("journalDays", t("sJournalDays"), 1, 90)
            ),
            toggle("mirror", t("sMirror"), t("sMirrorHint")),
            toggle("dedupe", t("sDedupe")),
            toggle("qualityGate", t("sQualityGate"), t("sQualityGateHint")),
            h("div", { className: "dshmem_row" },
              num("staleDays", t("sStaleDays"), 7, 365),
              num("autoDreamDays", t("sAutoDreamDays"), 0, 365),
              num("autoPortraitHours", t("sAutoPortraitHours"), 0, 168)
            ),
            h("div", { className: "dshmem_hint" }, t("sAutoPortraitHoursHint")),
            toggle("autoDreamPortrait", t("sAutoDreamPortrait"), t("sAutoDreamPortraitHint"))
          )
        ]),
        h("div", { className: "dshmem_fieldGroupTitle" }, t("settingsGroupAdvanced")),
        h("div", { className: "dshmem_box" },
          h("div", { className: "dshmem_title" }, t("mirrorTitle")),
          h("div", { className: "dshmem_meta" },
            h("span", { className: "dshmem_path" }, state?.mirror?.workspaceFile || t("mirrorGlobal")),
            state?.mirror?.workspaceFile
              ? h("span", {
                  className: `dshmem_chip${state?.mirror?.workspaceExists ? " dshmem_chip_on" : ""}`,
                }, state?.mirror?.workspaceExists ? t("mirrorPresent") : t("mirrorAbsent"))
              : null
          ),
          h("div", { className: "dshmem_meta" },
            h("span", { className: "dshmem_hint" }, t("mirrorStorage")),
            h("span", { className: "dshmem_path" }, state?.mirror?.storageFile || state?.workspace?.dataFile || "—")
          ),
          h("div", { className: "dshmem_row" },
            h("button", {
              type: "button",
              className: "dshmem_btn dshmem_btn_sm",
              onClick: () => {
                setBusy(true);
                api
                  .mirror(target)
                  .then((payload) => {
                    if (!alive.current) return;
                    setState((current) => ({ ...(current || {}), mirror: payload.mirror }));
                  })
                  .catch((cause) => setError(String(cause?.message || cause)))
                  .finally(() => {
                    if (alive.current) setBusy(false);
                  });
              },
            }, t("refresh")),
            state?.mirror?.markdown
              ? h("button", {
                  type: "button",
                  className: "dshmem_btn dshmem_btn_sm",
                  onClick: () => {
                    copyText(state.mirror.markdown).then((ok) => {
                      if (ok) flash(t("copied"));
                      else setError(t("copyFailed"));
                    });
                  },
                }, t("copy"))
              : null
          ),
          state?.mirror?.markdown
            ? h("div", { className: "dshmem_mirror" }, state.mirror.markdown)
            : h("div", { className: "dshmem_hint" },
                state?.mirror?.workspaceExists || state?.mirror?.storageExists
                  ? t("mirrorLoading")
                  : t("mirrorEmpty"))
        ),
        h("div", { className: "dshmem_box" },
          h("div", { className: "dshmem_title" }, t("exportTitle")),
          h("div", { className: "dshmem_row" },
            h("button", {
              type: "button",
              className: "dshmem_btn",
              onClick: () => {
                api
                  .exportAll(target)
                  .then((payload) => {
                    const text = JSON.stringify(payload.export, null, 2);
                    setImportText(text);
                    copyText(text).then((ok) => {
                      if (ok) flash(t("copied"));
                      else setError(t("copyFailed"));
                    });
                  })
                  .catch((cause) => setError(String(cause?.message || cause)));
              },
            }, t("exportDo")),
            h("button", {
              type: "button",
              className: "dshmem_btn",
              disabled: busy || !importText.trim(),
              onClick: doImport,
            }, t("importDo"))
          ),
          h("div", { className: "dshmem_row" },
            h("span", { className: "dshmem_meta" }, t("formatLabel")),
            h("select", {
              className: "dshmem_select",
              value: importFormat,
              onChange: (event) => setImportFormat(event.target.value),
            }, IMPORT_FORMAT_OPTIONS.map((value) =>
              h("option", { value, key: value }, t(`format_${value}`))
            ))
          ),
          h("textarea", {
            className: "dshmem_area",
            value: importText,
            placeholder: t("importPh"),
            onChange: (event) => setImportText(event.target.value),
          }),
          h("div", { className: "dshmem_meta" },
            h("span", null, `dsh-memory ${state?.version || ""}`),
            h("span", null, state?.api || "/memory/api")
          )
        ),
        h("div", { className: "dshmem_saveBar", style: { justifyContent: "flex-end" } },
          h("button", {
            type: "button",
            className: "dshmem_btn dshmem_btn_primary",
            disabled: busy || !settingsDirty,
            onClick: () => {
              setBusy(true);
              setError("");
              api
                .settings(settings)
                .then((payload) => {
                  if (!alive.current) return;
                  setSettings(payload.settings);
                  setSettingsDirty(false);
                  hudNotify();
                  flash(t("saved"));
                  return api.state(target).then((next) => {
                    if (alive.current) setState(next);
                  });
                })
                .catch((cause) => setError(String(cause?.message || cause)))
                .finally(() => {
                  if (alive.current) setBusy(false);
                });
            },
          }, t("save")),
          h("button", {
            type: "button",
            className: "dshmem_btn",
            onClick: () => {
              setSettings(state?.settings || settings);
              setSettingsDirty(false);
            },
          }, t("cancel"))
        )
      );

      /* ---------------- 维护页：体检 + 待审队列 + 标签清理 ---------------- */
      /* 时间线不再是独立 tab——它并进了记忆库的排布下拉（同一份内容的按日切法）。 */

      const healthBusyRun = (promise, message) => {
        setHealthBusy(true);
        setError("");
        promise
          .then(() => afterWrite(message))
          .catch((cause) => setError(String(cause?.message || cause)))
          .finally(() => {
            if (alive.current) setHealthBusy(false);
          });
      };
      const resolveContradictionByTime = (pair) =>
        api
          .healthResolve({ workspace: target, action: "time-order", ids: [pair.a, pair.b] })
          .catch((cause) => {
            const reason = cause?.code;
            if (reason === "redline_protected") throw new Error(t("contradictionReasonRedline"));
            if (reason === "pinned_older") throw new Error(t("contradictionReasonPinned"));
            if (reason === "user_older") throw new Error(t("contradictionReasonUserOlder"));
            if (reason === "external_newer") throw new Error(t("contradictionReasonExternalNewer"));
            if (reason === "mixed_scope") throw new Error(t("contradictionReasonMixedScope"));
            if (reason === "archived" || reason === "draft") {
              throw new Error(t("contradictionReasonArchived"));
            }
            if (reason === "archive_failed") throw new Error(t("contradictionReasonFailed"));
            throw cause;
          });

      const health = healthData?.health || null;
      const healthStats = healthData?.stats || null;
      const briefing = state?.briefing || null;
      const runDream = () => {
        setDreamBusy(true);
        setError("");
        api
          .dream({ workspace: target })
          .then((payload) => {
            setDreamData(payload || null);
            /* 服务端动手前已经留了快照，这里把清单刷新一下，别让面板显示旧状态。 */
            api
              .backups()
              .then((next) => {
                if (alive.current) setBackupData(next);
              })
              .catch(() => {});
            afterWrite(t("dreamDone"));
          })
          .catch((cause) => setError(String(cause?.message || cause)))
          .finally(() => {
            if (alive.current) setDreamBusy(false);
          });
      };
      const briefModeLabel = settings?.briefMode === "full" ? t("healthTokenFull") : t("healthTokenIndex");
      const estTokens = briefing?.chars ? Math.round(briefing.chars * 0.6) : null;

      const queueRecords = Array.isArray(queueData?.records) ? queueData.records : [];
      /* 注入审计：最近真正进 prompt 的内容。 */
      const injectionEntries = Array.isArray(injectionData?.entries) ? injectionData.entries : [];
      const injectionKindLabel = (kind) =>
        kind === "turn-recall"
          ? t("injectionKindTurnRecall")
          : kind === "path-recall"
            ? t("injectionKindPathRecall")
            : t("injectionKindBriefing");
      /* 派生链：每层派生了什么、源现在还成不成立。 */
      const derivationEntries = Array.isArray(derivationData?.entries) ? derivationData.entries : [];
      const derivationLayerLabel = (layer) =>
        layer === "agents" ? t("derivationLayerAgents") : t("derivationLayerPortrait");
      /* 复审队列：已到期在前。 */
      const reviewItems = [
        ...(Array.isArray(reviewData?.due) ? reviewData.due.map((r) => ({ ...r, due: true })) : []),
        ...(Array.isArray(reviewData?.soon) ? reviewData.soon.map((r) => ({ ...r, due: false })) : []),
      ];

      /* 标签清理候选：小写归并后同组出现多种原始写法的（如 DSH / dsh），目标取计数最多的写法。 */
      const tagVariants = (() => {
        const groups = new Map();
        for (const { tag, count } of tagList) {
          const key = String(tag).toLowerCase();
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push({ tag, count });
        }
        return [...groups.values()]
          .filter((variants) => new Set(variants.map((v) => v.tag)).size > 1)
          .map((variants) => {
            const sorted = [...variants].sort((a, b) => b.count - a.count);
            return {
              variants: sorted.map((v) => v.tag),
              target: sorted[0].tag,
            };
          });
      })();

      const tagCleanupBox = tagVariants.length
        ? h("div", { className: "dshmem_box" },
            h("div", { className: "dshmem_title" }, t("tagMergeTitle")),
            h("div", { className: "dshmem_hint" }, t("tagMergeHint")),
            tagVariants.map((group) =>
              h("div", { className: "dshmem_issue", key: group.target },
                h("div", { className: "dshmem_issueHead" },
                  h("span", { className: "dshmem_chip" }, group.variants.join(" / ")),
                  h("button", {
                    type: "button",
                    className: "dshmem_btn dshmem_btn_sm",
                    disabled: healthBusy,
                    onClick: () => {
                      setHealthBusy(true);
                      setError("");
                      api
                        .mergeTags({ workspace: target, from: group.variants, to: group.target })
                        .then((payload) => afterWrite(t("tagMerged").replace("{n}", String(payload.affected ?? 0))))
                        .catch((cause) => setError(String(cause?.message || cause)))
                        .finally(() => {
                          if (alive.current) setHealthBusy(false);
                        });
                    },
                  }, t("tagMergeDo").replace("{tag}", group.target))),
                h("div", { className: "dshmem_hint" },
                  t("tagMergeVariants").replace("{variants}", group.variants.join("、"))))))
        : null;

      const dreamSkipReasonLabel = (reason) => {
        switch (reason) {
          case "no_model_route":
          case "llm_unavailable":
            return t("dreamSkipNoRoute");
          case "no_material":
            return t("dreamSkipNoMaterial");
          case "disabled":
            return t("dreamSkipDisabled");
          case "already_running":
            return t("dreamSkipRunning");
          case "no_workspace":
            return t("dreamSkipNoWorkspace");
          default:
            return t("dreamSkipUnknown");
        }
      };
      const contradictionReasonLabel = (reason) => {
        switch (reason) {
          case "redline_protected":
            return t("contradictionReasonRedline");
          case "pinned_older":
            return t("contradictionReasonPinned");
          case "user_older":
            return t("contradictionReasonUserOlder");
          case "external_newer":
            return t("contradictionReasonExternalNewer");
          case "mixed_scope":
            return t("contradictionReasonMixedScope");
          case "archived":
          case "draft":
            return t("contradictionReasonArchived");
          case "archive_failed":
            return t("contradictionReasonFailed");
          case "needs_confirmation":
            return t("contradictionReasonNeedsConfirm");
          default:
            return reason || t("dreamErrorUnknown");
        }
      };
      const maintainDate = (iso) => {
        const time = Date.parse(String(iso || ""));
        if (!Number.isFinite(time)) return "—";
        const date = new Date(time);
        const pad = (n) => String(n).padStart(2, "0");
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
      };
      const maintainDateTime = (iso) => {
        const time = Date.parse(String(iso || ""));
        if (!Number.isFinite(time)) return "—";
        const date = new Date(time);
        const pad = (n) => String(n).padStart(2, "0");
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
      };
      /* 二级蒸馏：上次尝试的素材 / 解析 / 拒绝原因，以及自适应节奏的下一个窗口。 */
      const distillInfo = health?.globalDistill || null;
      const distillReasonLabel = (reason) => {
        switch (reason) {
          case "empty":
            return t("distillReasonEmpty");
          case "all_rejected":
            return t("distillReasonAllRejected");
          case "bad_json":
            return t("distillReasonBadJson");
          case "not_array":
            return t("distillReasonNotArray");
          case "none":
            return t("distillReasonNone");
          case "llm_error":
          case "no_model_route":
          case "llm_unavailable":
            return t("distillReasonLlmError");
          case "no_material":
            return t("distillReasonNoMaterial");
          default:
            return reason || "—";
        }
      };
      const maintainPortraitLabel = (report) =>
        report?.portrait === "drafted"
          ? t("dreamPortraitDrafted")
          : report?.portrait === "saved"
            ? t("dreamPortraitSaved")
            : report?.portrait === "skipped"
              ? t("dreamPortraitSkipped").replace(
                  "{reason}",
                  dreamSkipReasonLabel(report.portraitReason),
                )
              : t("dreamPortraitNone");
      const autoMaintain = health?.maintenance || null;
      const autoMaintainDays = Number(autoMaintain?.autoDreamDays || 0);
      const maintainTab = h("div", { className: "dshmem" },
        h("div", { className: "dshmem_blockGroupHead" },
          h("span", { className: "dshmem_blockGroupTitle" }, t("maintainGroupState"))),
        h("div", { className: "dshmem_hint" }, t("healthHint")),
        h("div", { className: "dshmem_kpis" },
          h("div", { className: "dshmem_kpi" },
            h("div", { className: "dshmem_kpiNum" },
              String(healthStats ? healthStats.total + healthStats.global : "—")),
            h("div", { className: "dshmem_kpiLbl" }, t("healthKpiTotal"))),
          h("div", { className: "dshmem_kpi" },
            h("div", { className: "dshmem_kpiNum" },
              healthStats && healthStats.total + healthStats.global
                ? `${Math.round((healthStats.utilization || 0) * 100)}%`
                : "—"),
            h("div", { className: "dshmem_kpiLbl" }, t("healthKpiUtil"))),
          h("div", { className: "dshmem_kpi" },
            h("div", { className: "dshmem_kpiNum" }, String(health?.drafts ?? 0)),
            h("div", { className: "dshmem_kpiLbl" }, t("healthKpiDrafts"))),
          h("div", { className: "dshmem_kpi" },
            h("div", { className: "dshmem_kpiNum" }, briefing?.chars ? String(briefing.chars) : "—"),
            h("div", { className: "dshmem_kpiLbl" }, t("healthToken")),
            h("div", { className: "dshmem_hint" }, briefModeLabel),
            briefing?.chars
              ? h("div", { className: "dshmem_hint" }, t("healthTokenEst").replace("{tokens}", String(estTokens ?? "—")))
              : h("div", { className: "dshmem_hint" }, t("healthTokenNone")),
            briefing?.pathTail?.count
              ? h("div", { className: "dshmem_hint" },
                  t("pathTailHint")
                    .replace("{n}", String(briefing.pathTail.count))
                    .replace("{tokens}", String(Math.round((briefing.pathTail.chars || 0) * 0.6))))
              : null)),
        /* 自动整理：打开 DSH 后按间隔跑，不需要点按钮；没有常驻定时器。 */
        h("div", { className: "dshmem_box" },
          h("div", { className: "dshmem_title" }, t("dreamAutoTitle")),
          !health
            ? h(Spin)
            : h("div", null,
                h("div", { className: "dshmem_hint" },
                  autoMaintainDays > 0
                    ? t("dreamAutoHint")
                        .replace("{days}", String(autoMaintainDays))
                        .replace(
                          "{portrait}",
                          autoMaintain?.autoDreamPortrait
                            ? t("dreamAutoPortraitOn")
                            : t("dreamAutoPortraitOff"),
                        )
                    : t("dreamAutoOffHint")),
                h("div", { className: "dshmem_hint" },
                  autoMaintain?.autoPortraitHours > 0
                    ? t("dreamAutoPortraitLine")
                        .replace("{hours}", String(autoMaintain.autoPortraitHours))
                        .replace(
                          "{when}",
                          autoMaintain.portraitUpdatedAt
                            ? maintainDate(autoMaintain.portraitUpdatedAt)
                            : "—",
                        )
                    : t("dreamAutoPortraitDisabled")),
                h("div", { className: "dshmem_hint" },
                  autoMaintain?.lastAutoAt || autoMaintain?.lastManualAt
                    ? t("dreamLastTidy").replace(
                        "{when}",
                        maintainDate(autoMaintain.lastAutoAt || autoMaintain.lastManualAt),
                      )
                    : t("dreamAutoNever")),
                autoMaintainDays > 0 && autoMaintain?.nextDueAt
                  ? h("div", { className: "dshmem_hint" },
                      t("dreamAutoNext").replace("{when}", maintainDate(autoMaintain.nextDueAt)))
                  : null,
                autoMaintain?.lastReport
                  ? h("div", { className: "dshmem_hint" },
                      t("dreamAutoSummary")
                        .replace("{merged}", String(autoMaintain.lastReport.merged ?? 0))
                        .replace("{reviews}", String(autoMaintain.lastReport.autoReviewed ?? 0))
                        .replace("{portrait}", maintainPortraitLabel(autoMaintain.lastReport)))
            : null)),
        /* Dream：手动补跑（合并重复簇 / 复审自动续期 / 只读矛盾线索 / 画像默认直接落库）。 */
        h("div", { className: "dshmem_box" },
          h("div", { className: "dshmem_title" }, t("dreamTitle")),
          h("div", { className: "dshmem_hint" }, t("dreamHint")),
          h("div", { className: "dshmem_row" },
            h("button", {
              type: "button",
              className: "dshmem_btn dshmem_btn_sm",
              disabled: dreamBusy,
              onClick: runDream,
            }, dreamBusy ? t("dreamRunning") : t("dreamRun")),
            dreamData
              ? h("span", { className: "dshmem_hint" },
                  t("dreamSummary")
                    .replace("{merged}", String((dreamData.merged || []).length))
                    .replace("{reviews}", String(dreamData.autoReviewed ?? 0))
                    .replace("{stale}", String(dreamData.staleReported ?? 0))
                    .replace("{unused}", String(dreamData.exposedUnusedReported ?? 0))
                    .replace(
                      "{portrait}",
                      dreamData.portrait === "drafted"
                        ? t("dreamPortraitDrafted")
                        : dreamData.portrait === "saved"
                          ? t("dreamPortraitSaved")
                          : dreamData.portrait === "skipped"
                            ? t("dreamPortraitSkipped").replace(
                                "{reason}",
                                dreamSkipReasonLabel(dreamData.portraitReason),
                              )
                            : t("dreamPortraitNone"),
                    ))
              : null),
          dreamData?.portraitDegraded
            ? h("div", { className: "dshmem_hint" }, t("dreamPortraitDegraded"))
            : null,
          dreamData?.merged?.length
            ? h("div", { className: "dshmem_docFlat" },
                dreamData.merged.map((item) =>
                  h("div", { key: item.into, className: "dshmem_hint" },
                    t("dreamMergedLine")
                      .replace("{count}", String(item.count))
                      .replace("{title}", item.title || "—"))))
            : null,
          dreamData?.contradictionsResolved?.length
            ? h("div", { className: "dshmem_docFlat" },
                h("div", { className: "dshmem_hint" },
                  t("dreamContradictionsResolved").replace(
                    "{n}",
                    String(dreamData.contradictionsResolved.length),
                  )),
                dreamData.contradictionsResolved.map((item) =>
                  h("div", { key: item.archivedId, className: "dshmem_hint" },
                    t("dreamContradictionResolvedLine")
                      .replace("{old}", item.archivedTitle || item.archivedId)
                      .replace("{kept}", item.keptTitle || item.keptId))))
            : null,
          dreamData?.contradictionsPending?.length
            ? h("div", { className: "dshmem_docFlat" },
                h("div", { className: "dshmem_hint" },
                  t("dreamContradictionsPending").replace(
                    "{n}",
                    String(dreamData.contradictionsPending.length),
                  )),
                dreamData.contradictionsPending.map((pair, index) =>
                  h("div", { key: `${pair.a}-${pair.b}-${index}`, className: "dshmem_hint" },
                    t("dreamContradictionPendingLine")
                      .replace("{a}", pair.aTitle || pair.a)
                      .replace("{b}", pair.bTitle || pair.b)
                      .replace("{reason}", contradictionReasonLabel(pair.reason)))))
            : null,
          dreamData?.errors?.length
            ? h("div", { className: "dshmem_err" },
                h("div", null, t("dreamErrors").replace("{n}", String(dreamData.errors.length))),
                dreamData.errors.map((error, index) =>
                  h("div", { key: `${error.step}-${index}` },
                    `${
                      error.step === "portrait"
                        ? t("dreamStepPortrait")
                        : error.step === "merge"
                          ? t("dreamStepMerge")
                          : error.step === "contradictions"
                            ? t("dreamStepContradictions")
                            : error.step
                    }：${error.detail || error.error || t("dreamErrorUnknown")}`)))
            : null),
        h("div", { className: "dshmem_box" },
          h("div", { className: "dshmem_title" }, t("healthProblems")),
          h("div", { className: "dshmem_row" },
            h("button", {
              type: "button",
              className: "dshmem_btn dshmem_btn_sm",
              onClick: () => setContradictionScan((value) => !value),
            }, contradictionScan ? t("healthContradictionScanOff") : t("healthContradictionScan")),
            contradictionScan
              ? h("span", { className: "dshmem_hint" }, `${(health?.contradictions || []).length} 条`)
              : null),
          h("div", { className: "dshmem_hint" }, t("healthContradictionScanHint")),
          !health
            ? h(Spin)
            : health.duplicates.length || health.stale.length || (health.exposedButUnused || []).length || health.broken.length
                || (health.contradictions || []).length || (health.deadFiles || []).length || health.overBudget
              ? h("div", { className: "dshmem_health" },
                  health.overBudget
                    ? h("div", { className: "dshmem_issue" },
                        h("div", { className: "dshmem_issueHead" },
                          h("span", { className: "dshmem_chip dshmem_chip_on" }, t("healthOverBudget"))),
                        h("div", { className: "dshmem_issueBody" }, health.overBudgetAdvice || ""))
                    : null,
                  (health.contradictions || []).map((pair, index) =>
                    h("div", { className: "dshmem_issue", key: `ctr-${index}` },
                      h("div", { className: "dshmem_issueHead" },
                        h("span", { className: "dshmem_chip" }, t("healthContradictions")),
                        h("button", {
                          type: "button",
                          className: "dshmem_btn dshmem_btn_sm",
                          disabled: healthBusy,
                          onClick: () =>
                            healthBusyRun(resolveContradictionByTime(pair), t("saved")),
                        }, t("healthTimeOrder"))),
                      h("div", { className: "dshmem_issueBody" }, `${pair.aTitle || pair.a} ⇄ ${pair.bTitle || pair.b}`),
                      h("div", { className: "dshmem_hint" }, pair.hint || ""),
                      h("div", { className: "dshmem_hint" }, t("healthContradictionsHint")))),
                  (health.deadFiles || []).map((item, index) =>
                    h("div", { className: "dshmem_issue", key: `dead-${index}` },
                      h("div", { className: "dshmem_issueHead" },
                        h("span", { className: "dshmem_chip" }, t("healthDeadFiles"))),
                      h("div", { className: "dshmem_issueBody" }, item.title || item.id),
                      h("div", { className: "dshmem_hint" }, (item.files || []).join(" ｜ ")),
                      h("div", { className: "dshmem_hint" }, t("healthDeadFilesHint")))),
                  health.duplicates.map((cluster, index) =>
                    h("div", { className: "dshmem_issue", key: `dup-${index}` },
                      h("div", { className: "dshmem_issueHead" },
                        h("span", { className: "dshmem_chip dshmem_chip_on" }, t("healthDuplicates")),
                        h("button", {
                          type: "button",
                          className: "dshmem_btn dshmem_btn_sm",
                          disabled: healthBusy,
                          onClick: () =>
                            healthBusyRun(
                              api.healthResolve({
                                workspace: target,
                                action: "merge",
                                ids: cluster.map((item) => item.id),
                              }),
                              t("saved"),
                            ),
                        }, t("healthMerge"))),
                      h("div", { className: "dshmem_issueBody" }, cluster.map((item) => item.title).join(" ｜ ")),
                      h("div", { className: "dshmem_hint" }, t("healthDuplicatesHint")))),
                  health.stale.length
                    ? h("div", { className: "dshmem_issue" },
                        h("div", { className: "dshmem_issueHead" },
                          h("span", { className: "dshmem_chip" }, `${t("healthStale")} ${health.stale.length}`),
                          h("button", {
                            type: "button",
                            className: "dshmem_btn dshmem_btn_sm",
                            disabled: healthBusy,
                            onClick: () =>
                              healthBusyRun(
                                api.healthResolve({
                                  workspace: target,
                                  action: "archive",
                                  ids: health.stale.map((item) => item.id),
                                }),
                                t("saved"),
                              ),
                          }, t("healthArchiveAll"))),
                        h("div", { className: "dshmem_issueBody" }, health.stale.map((item) => item.title).join(" ｜ ")),
                        h("div", { className: "dshmem_hint" }, t("healthStaleHint").replace("{days}", String(health.staleDays ?? 60))))
                    : null,
                  (health.exposedButUnused || []).length
                    ? h("div", { className: "dshmem_issue" },
                        h("div", { className: "dshmem_issueHead" },
                          h("span", { className: "dshmem_chip" }, `${t("healthExposedUnused")} ${health.exposedButUnused.length}`)),
                        h("div", { className: "dshmem_issueBody" },
                          health.exposedButUnused
                            .map((item) => `${item.title} ×${item.exposedCount}`)
                            .join(" ｜ ")),
                        h("div", { className: "dshmem_hint" }, t("healthExposedUnusedHint")))
                    : null,
                  health.broken.map((link, index) =>
                    h("div", { className: "dshmem_issue", key: `brk-${index}` },
                      h("div", { className: "dshmem_issueHead" },
                        h("span", { className: "dshmem_chip" }, t("healthBroken")),
                        h("button", {
                          type: "button",
                          className: "dshmem_btn dshmem_btn_sm",
                          disabled: healthBusy,
                          onClick: () =>
                            healthBusyRun(
                              api.healthResolve({ workspace: target, action: "unlink", id: link.id, target: link.target }),
                              t("saved"),
                            ),
                        }, t("healthUnlink"))),
                      h("div", { className: "dshmem_issueBody" }, `${link.field} → ${link.target}`))))
              : h("div", { className: "dshmem_hint" }, t("healthNone"))),
        h("div", { className: "dshmem_box" },
          h("div", { className: "dshmem_title" }, t("globalCandidatesTitle")),
          h("div", { className: "dshmem_hint" }, t("globalCandidatesHint")),
          distillInfo
            ? h("div", { className: "dshmem_meta", style: { flexDirection: "column", alignItems: "flex-start", gap: 2 } },
                h("span", { className: "dshmem_hint" },
                  distillInfo.lastAt
                    ? t("globalDistillLast")
                        .replace("{when}", maintainDateTime(distillInfo.lastAt))
                        .replace("{materials}", String(distillInfo.lastMaterials ?? 0))
                        .replace("{parsed}", String(distillInfo.lastParsed ?? 0))
                        .replace("{added}", String(distillInfo.lastAdded ?? 0))
                    : t("globalDistillNever")),
                distillInfo.lastAt && distillInfo.lastResult && distillInfo.lastResult !== "added"
                  && distillInfo.lastResult !== "duplicate"
                  ? h("span", { className: "dshmem_hint" },
                      t("globalDistillEmpty").replace("{reason}", distillReasonLabel(distillInfo.lastReason)))
                  : null,
                distillInfo.lastResult === "duplicate"
                  ? h("span", { className: "dshmem_hint" }, t("globalDistillDuplicate"))
                  : null,
                Object.keys(distillInfo.lastRejects || {}).length
                  ? h("span", { className: "dshmem_hint" },
                      t("globalDistillRejects").replace(
                        "{reasons}",
                        Object.entries(distillInfo.lastRejects)
                          .map(([reason, count]) => `${reason}×${count}`)
                          .join(" / "),
                      ))
                  : null,
                distillInfo.lastAt
                  ? h("span", { className: "dshmem_hint" },
                      t("globalDistillInterval")
                        .replace("{base}", String(distillInfo.baseMinutes ?? 15))
                        .replace(
                          "{next}",
                          distillInfo.nextAllowedAt ? maintainDateTime(distillInfo.nextAllowedAt) : "—",
                        ))
                  : null,
                distillInfo.lastExcerpt
                  ? h("div", { className: "dshmem_issueBody", style: { whiteSpace: "pre-wrap" } },
                      `${t("globalDistillExcerpt")}：${distillInfo.lastExcerpt}`)
                  : null)
            : null,
          !health
            ? h(Spin)
            : (health.candidateItems || []).length
              ? h("div", null,
                  h("div", { className: "dshmem_hint" },
                    t("globalCandidatesStats")
                      .replace("{pending}", String(health.candidates?.pending ?? 0))
                      .replace("{promoted}", String(health.candidates?.promoted ?? 0))
                      .replace("{rejected}", String(health.candidates?.rejected ?? 0))),
                  health.candidateItems.map((item) =>
                    h("div", { className: "dshmem_issue", key: item.id },
                      h("div", { className: "dshmem_issueHead" },
                        h("span", { className: "dshmem_chip" }, item.category),
                        h("button", {
                          type: "button",
                          className: "dshmem_btn dshmem_btn_sm",
                          disabled: healthBusy,
                          onClick: () =>
                            healthBusyRun(
                              api.candidatesReject({ ids: [item.id], reason: "panel" }),
                              t("saved"),
                            ),
                        }, t("globalCandidatesReject"))),
                      h("div", { className: "dshmem_issueBody" }, item.text))))
              : h("div", { className: "dshmem_hint" }, t("globalCandidatesNone"))),
        h("div", { className: "dshmem_box" },
          h("div", { className: "dshmem_title" }, t("injectionTitle")),
          h("div", { className: "dshmem_hint" }, t("injectionHint")),
          !injectionData
            ? h(Spin)
            : injectionEntries.length
              ? h("div", { className: "dshmem_health" },
                  injectionEntries.map((entry) =>
                    h("div", { className: "dshmem_issue", key: `${entry.kind}-${entry.at}-${entry.hash}` },
                      h("div", { className: "dshmem_issueHead" },
                        h("span", { className: "dshmem_chip" }, injectionKindLabel(entry.kind)),
                        h("span", { className: "dshmem_hint" },
                          `${entry.chars} 字 ｜ ${(entry.ids || []).length} 条 ｜ #${String(entry.hash || "").slice(0, 8)}${
                            (entry.dropped || []).length
                              ? ` ｜ ${t("injectionDropped").replace("{n}", String(entry.dropped.length))}`
                              : ""
                          }`)),
                      entry.preview
                        ? h("div", { className: "dshmem_issueBody" }, entry.preview)
                        : null)))
              : h("div", { className: "dshmem_hint" }, t("injectionNone"))),
        h("div", { className: "dshmem_box" },
          h("div", { className: "dshmem_title" }, t("backupTitle")),
          h("div", { className: "dshmem_hint" }, t("backupHint")),
          h("div", { className: "dshmem_row" },
            h("button", {
              type: "button",
              className: "dshmem_btn dshmem_btn_sm",
              disabled: backupBusy,
              onClick: () => {
                setBackupBusy(true);
                api
                  .backup({ reason: "manual", workspace: target })
                  .then((payload) => {
                    if (!alive.current) return;
                    setBackupData(payload);
                    flash(t("backupDone").replace("{name}", String(payload?.backup?.name || "")));
                  })
                  .catch((cause) => setError(String(cause?.message || cause)))
                  .finally(() => {
                    if (alive.current) setBackupBusy(false);
                  });
              },
            }, t("backupRun"))),
          backupData?.root
            ? h("div", { className: "dshmem_hint dshmem_path" },
                `${t("backupRoot")}：${backupData.root}`)
            : null,
          !backupData
            ? h(Spin)
            : (backupData.backups || []).length
              ? h("div", { className: "dshmem_health" },
                  backupData.backups.map((item) =>
                    h("div", { className: "dshmem_issue", key: item.name },
                      h("div", { className: "dshmem_issueHead" },
                        h("span", { className: "dshmem_chip" }, backupLabel(item.name)),
                        h("span", { className: "dshmem_hint" },
                          `${item.files} · ${humanBytes(item.bytes)}`)))))
              : h("div", { className: "dshmem_hint" }, t("backupEmpty"))),
        h("div", { className: "dshmem_box" },
          h("div", { className: "dshmem_title" }, t("derivationTitle")),
          h("div", { className: "dshmem_hint" }, t("derivationHint")),
          !derivationData
            ? h(Spin)
            : derivationEntries.length
              ? h("div", { className: "dshmem_health" },
                  derivationEntries.map((entry) =>
                    h("div", { className: "dshmem_issue", key: entry.id },
                      h("div", { className: "dshmem_issueHead" },
                        h("span", { className: "dshmem_chip" }, derivationLayerLabel(entry.layer)),
                        h("span", { className: "dshmem_hint" }, entry.target)),
                      h("div", { className: "dshmem_issueBody" },
                        `${entry.state === "dirty" ? t("derivationDirty") : t("derivationFresh")}${
                          entry.reason ? `：${entry.reason}` : ""
                        }${
                          (entry.sources || []).length
                            ? ` ｜ ${t("derivationSources")}：${entry.sources.map((s) => s.id).join("、")}`
                            : ""
                        }`))))
              : h("div", { className: "dshmem_hint" }, t("derivationNone"))),
        h("div", { className: "dshmem_blockGroupHead" },
          h("span", { className: "dshmem_blockGroupTitle" }, t("maintainGroupTodo")),
          h("span", { className: "dshmem_count" }, String(queueRecords.length + reviewItems.length))),
        h("div", { className: "dshmem_box" },
          h("div", { className: "dshmem_title" }, t("reviewTitle")),
          h("div", { className: "dshmem_hint" }, t("reviewHint")),
          reviewData
            ? h(
                "div",
                { className: "dshmem_hint" },
                `${t("reviewSummary")
                  .replace("{due}", String(reviewData.dueCount ?? 0))
                  .replace("{soon}", String(reviewData.soonCount ?? 0))}${
                  (reviewData.dueCount ?? 0) > (reviewData.due?.length ?? 0) ||
                  (reviewData.soonCount ?? 0) > (reviewData.soon?.length ?? 0)
                    ? ` ｜ ${t("reviewTruncated").replace("{n}", String(reviewData.limit ?? 50))}`
                    : ""
                }`,
              )
            : null,
          !reviewData
            ? h(Spin)
            : reviewItems.length
              ? h("div", { className: "dshmem_health" },
                  reviewItems.map((item) =>
                    h("div", { className: "dshmem_issue", key: item.id },
                      h("div", { className: "dshmem_issueHead" },
                        h("span", { className: "dshmem_chip" }, item.due ? t("reviewDue") : t("reviewSoon")),
                        h("span", { className: "dshmem_hint" }, String(item.reviewAt || "").slice(0, 10))),
                      h("div", { className: "dshmem_issueBody" },
                        `${item.title || t("untitled")} ｜ ${t("reviewFalsifier")}：${item.falsifier || "—"}`),
                      h("div", { className: "dshmem_acts" },
                        h("button", {
                          type: "button",
                          className: "dshmem_btn dshmem_btn_sm dshmem_btn_primary",
                          disabled: busy,
                          onClick: () => run(api.review({ workspace: target, id: item.id }), t("reviewDone")),
                        }, t("reviewDone"))))))
              : h("div", { className: "dshmem_hint" }, t("reviewNone"))),
        h("div", { className: "dshmem_box" },
          h("div", { className: "dshmem_title" }, t("queueTitle")),
          h("div", { className: "dshmem_hint" }, t("queueHint")),
          !queueData
            ? h(Spin)
            : queueRecords.length
              ? h("div", { className: "dshmem_list" },
                  queueRecords.map((record) =>
                    h("div", { className: "dshmem_card dshmem_draftCard", key: record.id },
                      h("div", { className: "dshmem_main" },
                        h("div", { className: "dshmem_title" }, record.title || t("untitled")),
                        h("div", { className: "dshmem_body" }, record.content),
                        h("div", { className: "dshmem_meta" },
                          h("span", { className: "dshmem_chip dshmem_chip_on" }, t("draftChip")),
                          h("span", { className: "dshmem_chip" }, catLabel(record.category)),
                          (record.tags || []).map((tag) => h("span", { key: tag, className: "dshmem_tag" }, `#${tag}`)),
                          typeof record.confidence === "number" ? h("span", null, record.confidence.toFixed(2)) : null,
                          record.supersedes ? h("span", { className: "dshmem_chain" }, t("queueSupersedes")) : null,
                          h("span", null, when(record.updatedAt)))),
                      h("div", { className: "dshmem_acts" },
                        h("button", {
                          type: "button",
                          className: "dshmem_btn dshmem_btn_sm dshmem_btn_primary",
                          disabled: busy,
                          onClick: () => run(api.approve({ workspace: target, id: record.id }), t("queueApproved")),
                        }, t("queueApprove")),
                        h("button", {
                          type: "button",
                          className: "dshmem_btn dshmem_btn_sm",
                          disabled: busy,
                          onClick: () => {
                            setMergeIds(null);
                            setQueueEdit(record);
                            setDraft(record);
                          },
                        }, t("queueEditApprove")),
                        h("button", {
                          type: "button",
                          className: "dshmem_btn dshmem_btn_sm dshmem_btn_danger",
                          disabled: busy,
                          onClick: () => {
                            if (typeof window !== "undefined" && !window.confirm(t("confirmReject"))) return;
                            run(api.reject({ workspace: target, id: record.id }), t("queueRejected"));
                          },
                        }, t("queueReject"))))))
              : h("div", { className: "dshmem_empty" }, t("queueEmpty"))),
        h("div", {
          className: "dshmem_blockGroupHead",
          style: { cursor: "pointer" },
          onClick: () => setMaintainCaptureOpen((value) => !value),
        },
          h("span", { className: "dshmem_chev" }, maintainCaptureOpen ? "▾" : "▸"),
          h("span", { className: "dshmem_blockGroupTitle" }, t("tabCapture"))),
        h("div", { className: "dshmem_blockGroupBody", "data-open": maintainCaptureOpen ? "1" : "0" },
          captureSection),
        h("div", {
          className: "dshmem_blockGroupHead",
          style: { cursor: "pointer" },
          onClick: () => setMaintainHistoryOpen((value) => !value),
        },
          h("span", { className: "dshmem_chev" }, maintainHistoryOpen ? "▾" : "▸"),
          h("span", { className: "dshmem_blockGroupTitle" }, t("maintainGroupHistory"))),
        h("div", { className: "dshmem_blockGroupBody", "data-open": maintainHistoryOpen ? "1" : "0" },
          /* 标签清理：写法不同、意思相同的标签（大小写漂移）一键归并。 */
          tagCleanupBox)
      );

      /* 跨 tab 共享：编辑器（新建/编辑/整合/推翻/审批编辑共用）与提示条。
         时间线与审批页里点条目也要能编辑，所以编辑器不属于任何一个 tab。 */
      /* 程序记忆晋升：编辑已有 convention/decision/preference/feedback 时可一键进 AGENTS.md。 */
      const PROMOTABLE = new Set(["convention", "decision", "preference", "feedback"]);
      const promoteNow = () => {
        if (!draft?.id) return;
        setBusy(true);
        setError("");
        api
          .promote({ workspace: target, id: draft.id })
          .then((payload) => flash(t("promoted").replace("{file}", payload?.file ?? "AGENTS.md")))
          .catch((cause) => setError(String(cause?.message || cause)))
          .finally(() => {
            if (alive.current) setBusy(false);
          });
      };

      const sharedBlocks = h("div", { className: "dshmem" },
        draft && mergeIds ? h("div", { className: "dshmem_hint" }, t("consolidateHint")) : null,
        draft && draft.id && PROMOTABLE.has(draft.category) && draft.scope !== "global"
          ? h("div", { className: "dshmem_row" },
              h("button", {
                type: "button",
                className: "dshmem_btn dshmem_btn_sm",
                disabled: busy,
                onClick: promoteNow,
              }, t("promoteBtn")),
              h("span", { className: "dshmem_hint" }, t("promoteHint")))
          : null,
        draft
          ? h(Editor, {
              key: draft.id || draft.supersedes || "new",
              t,
              lang,
              categories,
              draft,
              busy,
              onCancel: closeEditor,
              onSubmit: submitDraft,
            })
          : null,
        error ? h("div", { className: "dshmem_err" }, error) : null,
        notice ? h("div", { className: "dshmem_ok" }, notice) : null);

      const draftCount = Number(state?.stats?.drafts) || 0;
      const statsTotal = Number(state?.stats?.total) || 0;
      const statsGlobal = Number(state?.stats?.global) || 0;
      const redlineCount = redlineRecords.length;
      const tabs = [
        ["project", `${t("tabProject")}${statsTotal ? ` ${statsTotal}` : ""}`],
        ["global", `${t("tabGlobal")}${statsGlobal ? ` ${statsGlobal}` : ""}`],
        ["redline", `${t("tabRedline")}${redlineCount ? ` ${redlineCount}` : ""}`],
        ["maintain", `${t("tabMaintain")}${draftCount ? ` ${draftCount}` : ""}`],
        ["settings", t("tabSettings")],
      ];

      return h("div", { className: "dshmem", style: { gap: 12 } },
        h("div", { className: "dshmem_tabs" },
          tabs.map(([id, label]) =>
            h("button", {
              key: id,
              type: "button",
              className: `dshmem_tab${tab === id ? " dshmem_tab_on" : ""}`,
              onClick: () => setTab(id),
            }, label))
        ),
        !state && error
          ? h("div", { className: "dshmem_err" }, error)
          : h("div", { className: "dshmem", style: { gap: 12 } },
              sharedBlocks,
              tab === "redline"
                ? redlineTab
                : tab === "project" || tab === "global"
                  ? memoryTab
                  : tab === "maintain"
                    ? maintainTab
                    : settingsTab)
      );
    }

    /* ---------------------------------------------------------------- *
     * 插件入口
     * ---------------------------------------------------------------- */

    const name = "dsh-memory";
    const inject = ["slots", "locale"];

    /** 极小的快照 store，只为把 locale 变化推进页面（官方 inject-hook 惯例）。 */
    function makeStore(initial) {
      let value = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => value,
        set(next) {
          value = next;
          for (const listener of [...listeners]) listener();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    }

    const NAV_MARKER = "data-dshmem-nav";

    /**
     * DSH 0.2.0 的设置导航只投影注册项的 id / order / label（`dsh-client-ui-settings-general`
     * 的 nav 渲染），图标由外壳内部一张封闭的 id 表决定，未知 id 一律回落到齿轮——注册项
     * 没有 icon 字段可用。在公开契约长出该字段之前，只认出「文本等于本插件当前本地化标题」
     * 的那一行并打上标记，交给上面的样式换成记忆卡片字形（`dsh-better-sidebar` 的
     * settings-nav-icon 是同源做法）。标记不拥有任何外壳结构，卸载时全部撤掉。
     *
     * MutationObserver 观察 body 子树：会话流式输出会持续触发变更，所以用 rAF 合并成帧。
     */
    function syncNavMarker(label) {
      if (typeof document === "undefined") return () => {};
      let disposed = false;
      let frame = 0;
      const sync = () => {
        frame = 0;
        if (disposed) return;
        const want = String(label() ?? "").trim();
        for (const button of document.querySelectorAll('[role="dialog"] nav button')) {
          if (want.length > 0 && (button.textContent ?? "").trim() === want) {
            button.setAttribute(NAV_MARKER, "");
          } else {
            button.removeAttribute(NAV_MARKER);
          }
        }
      };
      const schedule = () => {
        if (disposed || frame) return;
        frame = typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(sync)
          : setTimeout(sync, 16);
      };
      sync();
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      return () => {
        disposed = true;
        if (frame) {
          if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
          else clearTimeout(frame);
          frame = 0;
        }
        observer.disconnect();
        for (const node of document.querySelectorAll("[" + NAV_MARKER + "]")) {
          node.removeAttribute(NAV_MARKER);
        }
      };
    }

    /* ---------------------------------------------------------------- *
     * 前台会话记忆卡（shell.overlay）
     * ---------------------------------------------------------------- */

    const HUD_SESSION_ATTR = "data-conversation-session";
    const HUD_POS_KEY = "dsh-memory/session-hud/position";
    const HUD_OPEN_KEY = "dsh-memory/session-hud/open";
    const HUD_OFF_KEY = "dsh-memory/session-hud/off";
    const HUD_ICON_SIZE_KEY = "dsh-memory/session-hud/icon-size";
    const HUD_EVENT = "dsh-memory:session-hud";
    /** 图标大小变了：设置页调完之后前台卡立刻跟着变，不用等对话切换。 */
    const HUD_ICON_SIZE_EVENT = "dsh-memory:session-hud/icon-size";
    /** 最近一次解析到的会话 id：设置页拿不到 DOM 标记时用它判断「该对话」。 */
    let lastHudSession = "";

    /** 通知前台卡立即重拉一次（设置保存 / 按对话开关切换）。 */
    function hudNotify() {
      try {
        if (
          typeof window !== "undefined" &&
          typeof window.dispatchEvent === "function" &&
          typeof Event === "function"
        ) {
          window.dispatchEvent(new Event(HUD_EVENT));
        }
      } catch {
        /* 没有事件系统就等下一次轮询 */
      }
    }

    function hudOffList() {
      try {
        const raw = globalThis.localStorage?.getItem(HUD_OFF_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list.filter((id) => typeof id === "string" && id) : [];
      } catch {
        return [];
      }
    }

    function hudSessionOff(id) {
      const key = String(id || "");
      return Boolean(key) && hudOffList().includes(key);
    }

    function hudSetSessionOff(id, off) {
      const key = String(id || "");
      if (!key) return;
      const list = new Set(hudOffList());
      if (off) list.add(key);
      else list.delete(key);
      try {
        globalThis.localStorage?.setItem(HUD_OFF_KEY, JSON.stringify([...list].slice(-200)));
      } catch {
        /* 存储不可用时只影响本次显示记忆 */
      }
      hudNotify();
    }
    /* 会话卡图标：a/b 是官方矢量，c–g 是二创位图（96px WebP）；设置项 hudIcon 选键。 */
    const HUD_ICON_WHALE = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 50 50\"><path fill=\"#4D6BFE\" fill-rule=\"nonzero\" d=\"M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z\"/></svg>";
    const HUD_ICON_APP = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 50 50\"><rect width=\"50\" height=\"50\" rx=\"11\" fill=\"#4D6BFE\"/><g transform=\"translate(9 9.5) scale(0.64)\"><path fill=\"#FFFFFF\" fill-rule=\"nonzero\" d=\"M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z\"/></g></svg>";
    const hudIconSvg = (markup) => `url("data:image/svg+xml,${encodeURIComponent(markup)}")`;
    const HUD_ICON_IMAGES = {
      c: "data:image/webp;base64,UklGRoYFAABXRUJQVlA4IHoFAADQGQCdASpgAGAAPlEmj0UjoiESuV4AOAUEtABqntC/VevKvn4XzfK7/YPwNw7hcewHCO9gHmAfpX/qOqP5hf2J/aLsdegB/Y/9V1iHoAeWT+2fwc/uT+33tVPKUGivN729yX+o2tnG76A2fB6Z9gn9ZutUx68iZ3mntSZgFz0Q5mbRcN86jx5aTMj57G582KDwEOczCph61x16zSU4rzuXyqPAbVQt5ML6XJL4BnQip/JXK5yvsOTNM2TNO2fKyIFD0x0neaERglYN/xJJyfUr+Qc4gxKVAAD+/rQgB54UfYu8fYzSBOO4dVkVONCXfcFc1brHD/dpMyjDnH3QQ3Z5xWH8iJ+mU71GzG82lHinOfD/jxmlibzbDp9tttDvpCq5gHyzTvCwda3whLWQKNen4ga69UKUSSFzlco3t+yjELCOwq0vxX18av7ynHKKGiCvJCFP9nuDRI1T+OnjvbhKcDt3sl3Q838mMkHM3clZlN1uW7mOtFT24NGzHjtFbjPAFPRsjIcp2afncAfSXCCGwfv1+CmBPv1zTi77TA5cbSia4n1FYLGjDv9XFt12rt9sulovrHl7n5pTSqw6pMRj/Ak1YXqrdjh39ui/peQ83j1YGOvxbZCV2HSpkDqF15PVBXgd9JeoN5Te4fwu/xMYIeQpKy2N1D24xULPVB8AjPdig8esPM4bjej0uc+zkazOegUhx2lnW972S87uZOGKbUx9SS3qVp0ORQ7m526UjDiv15lvtCGtF7Vw+5QP54bZhzCuBpDCm/FpzxP9AzGCVIFXtccC4Y8JPEz5zZ4rxguznJJABD3LOYJbO0yx7IRU1zTVbCJrmDFrUksqlz+xubpmlzJik+SMvaFSVez+M5FFKCXus/f63Okv8T61svuCmqVrVmWla/9kMno5v9BmroVOt1ONpf24xt6DJ+gF7qi8P/qLYvTiw75I6dq7ac/pJyIeOLJTWL0MLbFFn4Jygea5SQ9N4jxplZMCMmCWQ9k4rGmx8AWdj6z3YRb89l01d6suWSqe1K5zXvirn8hsa4de9cD3Ey+nVbx6+lZa0ECYwvloXBbIHLVX8zHkIt66qJZLeEh1HvnpxvNLIfPQP7u8hQVi34XSYtQdE0Ymf7E5uh4Cxp2/wqWjDXM8CSasnGkZWm/pjP26EB83rzIiFIFm7df4LwSgZPf/MZ/+clTGP+trkeEJ2pOGPPFd9dyRY+ZXdGvQmi3P+HZSh4cukkTn8YTCrYiFyWR5h4pt4j7QWx9U/xMf+yCd4YZFjrhpfTK/bwyClgzqVZmmGpkI3wC/F/hmr403vsbEK3HcIQBL4LgG2weInyqaRn/iFyv71dAViCyMDbVafwD7yRJICFFrlduECokT+qtMZjSdlrFKugkqvbcB4DzJ/B3KkJauCjnTNVojbxaOBvpm5m9Gu/bvNe4OZ6dVC22X/8Ue1hp5/Hs9D1Clcnt6/Wn3HH5nA4Zb2D20+pU+Pzyv07P5qhpGECiKJx0m555TZi8tECqC82pZIMr12V5elNu8zC2vWD1cMZ7jnayqAN2EWTdntOurS9txXogTJ0lbuEyWBrK603TB5R9qakpVY9kGaCBhPHQvydVmnT8aue05OZXQy0hJSy6f7BLCu/W5h4oVzPl1drlLr2flkwF7Yu58cO/5c/Gnn1syQ86pnqyejnV9u4EP55XAxmWBD579GeQRFndaSYobO3wODa5RcLNyErFlg26uWT4yUaS5kPJNTRwonQjwguH6JOK4+aPdmiNSWL3QsL7Vo4M+FH8WUKRXrYSXMt7kRanabBJ88qJQGvEmgk0LF7UexYk++pRNeLE65gmFDAbUMbJTHz0+mrhv/VkDvJu+AAAAAAAA",
      d: "data:image/webp;base64,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",
      e: "data:image/webp;base64,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",
      f: "data:image/webp;base64,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",
      g: "data:image/webp;base64,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",
    };
    const HUD_ICONS = {
      a: hudIconSvg(HUD_ICON_WHALE),
      b: hudIconSvg(HUD_ICON_APP),
      c: `url("${HUD_ICON_IMAGES.c}")`,
      d: `url("${HUD_ICON_IMAGES.d}")`,
      e: `url("${HUD_ICON_IMAGES.e}")`,
      f: `url("${HUD_ICON_IMAGES.f}")`,
      g: `url("${HUD_ICON_IMAGES.g}")`,
    };

    function hudReadOpen() {
      try {
        return globalThis.localStorage?.getItem(HUD_OPEN_KEY) === "1";
      } catch {
        return false;
      }
    }

    function hudWriteOpen(open) {
      try {
        globalThis.localStorage?.setItem(HUD_OPEN_KEY, open ? "1" : "0");
      } catch {
        /* 无存储介质时只影响位置/展开状态的记忆，不影响功能 */
      }
    }

    function hudReadPos() {
      try {
        const raw = globalThis.localStorage?.getItem(HUD_POS_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) {
          return { left: parsed.left, top: parsed.top };
        }
      } catch {
        /* 坏数据回落到默认位置 */
      }
      return null;
    }

    function hudWritePos(pos) {
      try {
        if (pos) globalThis.localStorage?.setItem(HUD_POS_KEY, JSON.stringify(pos));
        else globalThis.localStorage?.removeItem(HUD_POS_KEY);
      } catch {
        /* 同上 */
      }
    }

    /** 图标大小：本机偏好，坏值 / 越界一律夹回 14–40px，默认 20px。 */
    function hudReadIconSize() {
      try {
        const raw = Number(globalThis.localStorage?.getItem(HUD_ICON_SIZE_KEY));
        if (!Number.isFinite(raw) || raw <= 0) return HUD_ICON_SIZE_DEFAULT;
        return Math.round(hudClamp(raw, HUD_ICON_SIZE[0], HUD_ICON_SIZE[1], HUD_ICON_SIZE_DEFAULT));
      } catch {
        return HUD_ICON_SIZE_DEFAULT;
      }
    }

    function hudWriteIconSize(size) {
      const next = Math.round(hudClamp(size, HUD_ICON_SIZE[0], HUD_ICON_SIZE[1], HUD_ICON_SIZE_DEFAULT));
      try {
        globalThis.localStorage?.setItem(HUD_ICON_SIZE_KEY, String(next));
      } catch {
        /* 无存储介质时只影响本次显示，不挡设置页调 */
      }
      try {
        if (
          typeof window !== "undefined" &&
          typeof window.dispatchEvent === "function" &&
          typeof CustomEvent === "function"
        ) {
          window.dispatchEvent(new CustomEvent(HUD_ICON_SIZE_EVENT, { detail: { size: next } }));
        }
      } catch {
        /* 没有事件系统就等下一次对话切换时重读 */
      }
      return next;
    }

    /** 宿主设置面板等模态层：它盖住对话时，前台卡不能跟着浮到设置页上。 */
    function hudModalOpen() {
      if (typeof document === "undefined" || typeof document.querySelector !== "function") return false;
      let node = null;
      try {
        node = document.querySelector("[data-shortcut-modal]");
      } catch {
        return false;
      }
      if (!node) return false;
      const rects = typeof node?.getClientRects === "function" ? node.getClientRects() : null;
      return !rects || rects.length > 0;
    }

    /** 当前对话的 sessionId：宿主在对话容器上打的只读标记（与引用插件同一契约）。 */
    function hudSessionId() {
      if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return "";
      let nodes = [];
      try {
        nodes = document.querySelectorAll(`[${HUD_SESSION_ATTR}]`);
      } catch {
        return "";
      }
      for (const node of nodes || []) {
        const id = String(node?.getAttribute?.(HUD_SESSION_ATTR) || "");
        if (!id) continue;
        /* 多窗格时可能有隐藏副本：优先取仍在布局里的那个。 */
        const rects = typeof node?.getClientRects === "function" ? node.getClientRects() : null;
        if (rects && rects.length === 0) continue;
        return id;
      }
      return "";
    }

    /** 前台卡只属于「当前可见对话」：没有对话容器或被模态层盖住时返回空。 */
    function hudLiveSession() {
      if (hudModalOpen()) return "";
      return hudSessionId();
    }

    /** 卡片「更新于」：取本会话沉淀记忆里最新的一条，精确到分钟。 */
    function hudUpdatedStamp(records) {
      let latest = 0;
      for (const record of records) {
        const at = Date.parse(String(record?.updatedAt || record?.createdAt || ""));
        if (Number.isFinite(at) && at > latest) latest = at;
      }
      if (!latest) return "";
      const date = new Date(latest);
      const pad = (n) => String(n).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function SessionMemoryHud(props) {
      const t = typeof props?.t === "function" ? props.t : (key) => key;
      const [open, setOpen] = useState(hudReadOpen);
      const [pos, setPos] = useState(hudReadPos);
      const [brief, setBrief] = useState(null);
      const [error, setError] = useState("");
      const cardRef = useRef(null);
      const dragRef = useRef(null);
      /** 拖拽柄改出来的尺寸：先本地生效，松手后落配置（设置页滑杆同一套值）。 */
      const [size, setSize] = useState(null);
      /** 拖动进行中：只驱动样式反馈（抬阴影 / grabbing），位置本身直写 DOM。 */
      const [dragging, setDragging] = useState(false);
      /** 图标大小：本机偏好，设置页调完即时生效。 */
      const [iconSize, setIconSize] = useState(hudReadIconSize);

      /** 当前可见对话的 id；设置页 / 主面板 / 模态层打开时为空。 */
      const [session, setSession] = useState(hudLiveSession);

      const load = useCallback(async (sid, signal) => {
        if (!sid) return;
        try {
          const data = await api.sessionBrief(sid, 1, signal);
          if (signal?.aborted) return;
          lastHudSession = String(sid);
          setBrief(data);
          setError("");
        } catch (err) {
          if (!signal?.aborted) setError(String(err?.message || err));
        }
      }, []);

      /**
       * 会话是不是还停在开局（新建会话 / 一条用户消息都还没有）。
       * 开局阶段整卡隐藏，但得有东西把「已经开始了」探出来：这里用 1s 的快节奏轮询，
       * 开始之后立刻回到常规节奏（展开 5s / 收起 15s）。
       */
      const awaitingStart =
        Boolean(session) && brief?.started === false && String(brief?.session || "") === session;

      /* 对话容器换人 / 设置弹窗开合时立即同步；兜底 1s 轮询覆盖宿主不触发 DOM 事件的路径。 */
      useEffect(() => {
        const sync = () => {
          const next = hudLiveSession();
          if (next) lastHudSession = next;
          setSession((current) => (current === next ? current : next));
        };
        sync();
        const timer = setInterval(sync, 1000);
        if (timer && typeof timer.unref === "function") timer.unref();
        let sessionObserver;
        let shellObserver;
        const body = typeof document !== "undefined" ? document.body : null;
        if (body && typeof MutationObserver === "function") {
          sessionObserver = new MutationObserver(sync);
          sessionObserver.observe(body, {
            attributes: true,
            subtree: true,
            attributeFilter: [HUD_SESSION_ATTR],
          });
          /* 设置面板是 body 上的 portal，开合只会换 body 的直接子节点。 */
          shellObserver = new MutationObserver(sync);
          shellObserver.observe(body, { childList: true });
        }
        return () => {
          clearInterval(timer);
          sessionObserver?.disconnect();
          shellObserver?.disconnect();
        };
      }, []);

      useEffect(() => {
        if (!session) return undefined;
        const controller = new AbortController();
        setBrief((current) => (String(current?.session || "") === session ? current : null));
        const tick = () => {
          if (typeof document !== "undefined" && document.hidden) return;
          void load(session, controller.signal);
        };
        tick();
        /* 展开时看得勤一点；收起成胶囊时降频；会话还没开始时 1s 一探，等它开始。 */
        const timer = setInterval(tick, awaitingStart ? 1000 : open ? 5000 : 15000);
        if (timer && typeof timer.unref === "function") timer.unref();
        return () => {
          clearInterval(timer);
          controller.abort();
        };
      }, [session, open, load, awaitingStart]);

      /* 设置页切换「该对话记忆」后立即刷新，不等下一次轮询。 */
      useEffect(() => {
        if (!session) return undefined;
        if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
        const onHud = () => {
          const controller = new AbortController();
          void load(session, controller.signal);
        };
        window.addEventListener(HUD_EVENT, onHud);
        return () => window.removeEventListener(HUD_EVENT, onHud);
      }, [session, load]);

      /* 图标大小是纯显示偏好：设置页拖完滑杆就广播，卡片当场跟着变。 */
      useEffect(() => {
        if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
        const onSize = (event) => {
          const next = Number(event?.detail?.size);
          setIconSize(Number.isFinite(next) ? next : hudReadIconSize());
        };
        window.addEventListener(HUD_ICON_SIZE_EVENT, onSize);
        return () => window.removeEventListener(HUD_ICON_SIZE_EVENT, onSize);
      }, []);

      const toggle = (next) => {
        setOpen(next);
        hudWriteOpen(next);
      };

      /* 拖动：头区与左侧拖动柄都能发起。按下即接管指针，移动合并到一帧、
         直接写 style 而**不** setState——拖动过程中整卡不重渲染，长摘要也不掉帧；
         松手才把最终位置交给 React，落本地存储。 */
      const startDrag = (event, options) => {
        const fromHandle = Boolean(options && options.handle);
        if (!event || (event.button !== 0 && event.pointerType !== "touch")) return;
        /* 已经有一次拖动在进行（多指同时按下）：忽略后到的这一次。 */
        if (dragRef.current) return;
        /* 「收起」这类按钮不要顺手把卡片拖走；拖动柄自己就是按钮，单独放行。 */
        if (!fromHandle && typeof event.target?.closest === "function" && event.target.closest("button")) return;
        const node = cardRef.current;
        if (!node || typeof node.getBoundingClientRect !== "function") return;
        const rect = node.getBoundingClientRect();
        if (!rect || !rect.width) return;

        event.preventDefault?.();
        try {
          /* 指针捕获：手滑出卡片、甚至滑出窗口也照样跟着走。 */
          event.currentTarget?.setPointerCapture?.(event.pointerId);
        } catch {
          /* 不支持捕获时退回 document 监听，行为一致 */
        }

        const origin = {
          x: Number(event.clientX),
          y: Number(event.clientY),
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        };
        let latest = { left: Math.round(rect.left), top: Math.round(rect.top) };
        let frame = 0;

        /* 从「右下角锚定」切到「左上角定位」：先补 free 再写 left/top，
           否则两个方向同时生效会把卡片撑成一个视口高。 */
        node.classList?.add("dshmem_hud_free");
        node.style.left = `${latest.left}px`;
        node.style.top = `${latest.top}px`;

        const apply = () => {
          frame = 0;
          node.style.left = `${latest.left}px`;
          node.style.top = `${latest.top}px`;
        };
        const schedule = () => {
          if (frame) return;
          const raf = globalThis.requestAnimationFrame;
          if (typeof raf !== "function") {
            apply();
            return;
          }
          frame = raf(apply);
        };

        const move = (moveEvent) => {
          const vw = typeof window !== "undefined" && Number.isFinite(window.innerWidth) ? window.innerWidth : 1280;
          const vh = typeof window !== "undefined" && Number.isFinite(window.innerHeight) ? window.innerHeight : 800;
          latest = {
            left: Math.round(
              Math.min(
                Math.max(8, origin.left + Number(moveEvent.clientX) - origin.x),
                Math.max(8, vw - origin.width - 8),
              ),
            ),
            top: Math.round(
              Math.min(
                Math.max(8, origin.top + Number(moveEvent.clientY) - origin.y),
                Math.max(8, vh - origin.height - 8),
              ),
            ),
          };
          schedule();
        };

        const finish = () => {
          /* 幂等：blur 与 pointerup 可能先后到达，只收尾一次。 */
          if (!dragRef.current) return;
          dragRef.current = null;
          if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", finish);
            document.removeEventListener("pointercancel", finish);
          }
          if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
            window.removeEventListener("blur", finish);
          }
          const caf = globalThis.cancelAnimationFrame;
          if (frame && typeof caf === "function") caf(frame);
          frame = 0;
          /* 最后一帧可能还没画出来：先落地再交给 React，松手不会回弹一下。 */
          apply();
          setDragging(false);
          setPos(latest);
          hudWritePos(latest);
        };

        dragRef.current = { finish };
        setDragging(true);
        if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
          document.addEventListener("pointermove", move);
          document.addEventListener("pointerup", finish);
          document.addEventListener("pointercancel", finish);
        }
        if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
          /* 窗口失焦（alt-tab / 切到别的窗口）时可能收不到 pointerup：兜底收尾。 */
          window.addEventListener("blur", finish);
        }
      };

      /* 右下角把手：宽度与固定高度一起拖，松手写回配置；设置页开着时同步滑杆。 */
      const startResize = (event) => {
        if (!event || event.button !== 0) return;
        event.preventDefault?.();
        event.stopPropagation?.();
        const node = cardRef.current;
        const rect =
          node && typeof node.getBoundingClientRect === "function" ? node.getBoundingClientRect() : null;
        if (!rect || !rect.width) return;
        const origin = {
          x: Number(event.clientX),
          y: Number(event.clientY),
          width: rect.width,
          height: rect.height,
        };
        let next = { width: Math.round(rect.width), height: Math.round(rect.height) };
        const move = (moveEvent) => {
          next = {
            width: Math.round(
              hudClamp(
                origin.width + Number(moveEvent.clientX) - origin.x,
                HUD_LOOK_WIDTH[0],
                HUD_LOOK_WIDTH[1],
                origin.width,
              ),
            ),
            height: Math.round(
              hudClamp(
                origin.height + Number(moveEvent.clientY) - origin.y,
                HUD_LOOK_HEIGHT[0],
                HUD_LOOK_HEIGHT[1],
                origin.height,
              ),
            ),
          };
          setSize(next);
        };
        const up = () => {
          if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", up);
          }
          /* 尺寸属于显示偏好，和设置页共用宿主配置；保存失败也不打断本次显示。 */
          api
            .settings({ hudWidth: next.width, hudHeight: next.height })
            .then((payload) => {
              if (payload?.settings) {
                const savedWidth = Number(payload.settings.hudWidth) || next.width;
                const savedHeight = Number(payload.settings.hudHeight) || 0;
                /* 把配置回写进当前 brief 再撤掉本地覆盖，避免等下一次轮询时的回弹。 */
                setBrief((current) =>
                  current && String(current.session || "") === session
                    ? { ...current, hud: { ...(current.hud || {}), width: savedWidth, height: savedHeight } }
                    : current,
                );
              }
              setSize(null);
              try {
                if (
                  typeof window !== "undefined" &&
                  typeof window.dispatchEvent === "function" &&
                  typeof CustomEvent === "function"
                ) {
                  window.dispatchEvent(
                    new CustomEvent(HUD_LOOK_EVENT, {
                      detail: { width: next.width, height: next.height },
                    }),
                  );
                }
              } catch {
                /* 没有事件系统时只影响设置页的即时同步，不影响前台卡 */
              }
            })
            .catch(() => {
              /* 保存失败：保留本次拖出来的尺寸，下次打开设置页会回到配置值 */
            });
        };
        if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
          document.addEventListener("pointermove", move);
          document.addEventListener("pointerup", up);
        }
      };

      /* 只属于当前可见对话：离开对话 / 打开设置弹窗时整卡隐藏。 */
      const activeBrief = brief && String(brief.session || "") === session ? brief : null;
      if (!session || !activeBrief) return null;
      /* 开局不出现：新建会话在空白页就已经有会话 id，只有「会话里已经有真实用户消息」才算开始。
         老后端不返回 started 时按原行为显示，升级后卡片不会整体失踪。 */
      if (activeBrief.started === false) return null;
      /* 「该对话记忆」关掉时整卡隐藏；开关在设置页，按当前会话 id 存本地。 */
      if (hudSessionOff(activeBrief.session)) return null;
      const records = Array.isArray(activeBrief.records) ? activeBrief.records : [];
      const iconStyle = HUD_ICONS[String(activeBrief.icon || "a")] || HUD_ICONS.a;
      const updated = hudUpdatedStamp(records);
      const titles = records.map((record) => String(record?.title || "").trim()).filter(Boolean);
      const summary = titles.length
        ? t("hudSummary").replace("{n}", String(titles.length)).replace("{list}", titles.join("；"))
        : "";
      const wrapperClass = "dshmem_hud" + (pos ? " dshmem_hud_free" : "");
      const wrapperStyle = pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : undefined;
      /* 外观：宿主配置提供初值，右下角拖动给出本次覆盖；胶囊只吃颜色与透明度，不吃尺寸。 */
      const look = { ...hudLookFrom(activeBrief), ...(size || {}) };
      const lookVars = { ...hudLookVars(look), "--dshmem-hud-icon": `${iconSize}px` };
      const pillStyle = { ...(wrapperStyle || {}), ...lookVars };
      const cardStyle = { ...(wrapperStyle || {}), ...lookVars, width: `${look.width}px` };
      if (look.height) cardStyle.height = `${look.height}px`;

      if (!open) {
        return h(
          "div",
          { className: wrapperClass, style: pillStyle, "data-dshmem-hud": "pill", "data-translucent": look.opacity < 0.999 ? "1" : "0" },
          h(
            "button",
            {
              type: "button",
              className: "dshmem_hud_pill",
              title: t("hudOpen"),
              "data-translucent": look.opacity < 0.999 ? "1" : "0",
              onClick: () => toggle(true),
            },
            h("span", { className: "dshmem_hud_glyph", "aria-hidden": "true", style: { backgroundImage: iconStyle } }),
            h("span", null, t("hudTitle")),
            records.length ? h("span", { className: "dshmem_hud_count" }, String(records.length)) : null,
          ),
        );
      }

      return h(
        "section",
        {
          className: `${wrapperClass} dshmem_hud_card`,
          style: cardStyle,
          ref: cardRef,
          "aria-label": t("hudTitle"),
          "data-dshmem-hud": "card",
          "data-size": look.height ? "fixed" : "auto",
          "data-translucent": look.opacity < 0.999 ? "1" : "0",
          "data-dragging": dragging ? "1" : "0",
        },
        h(
          "div",
          { className: "dshmem_hud_head", onPointerDown: startDrag },
          /* 可视拖动柄：按住整块 30×30 拖动整卡；头区其余空白处也照样能拖。 */
          h("button", {
            type: "button",
            className: "dshmem_hud_grip",
            title: t("hudDrag"),
            "aria-label": t("hudDrag"),
            "data-dragging": dragging ? "1" : "0",
            onPointerDown: (event) => startDrag(event, { handle: true }),
          }),
          h(
            "span",
            { className: "dshmem_hud_brand", "aria-hidden": "true" },
            h("span", { className: "dshmem_hud_glyph", style: { backgroundImage: iconStyle } }),
          ),
          h("span", { className: "dshmem_hud_title" }, t("hudTitle")),
          h(
            "button",
            {
              type: "button",
              className: "dshmem_hud_iconbtn",
              title: t("hudCollapse"),
              onClick: () => toggle(false),
            },
            "×",
          ),
        ),
        updated ? h("div", { className: "dshmem_hud_time" }, t("hudUpdated").replace("{when}", updated)) : null,
        error ? h("div", { className: "dshmem_hud_error" }, t("hudError").replace("{message}", error)) : null,
        summary
          ? h("div", { className: "dshmem_hud_body" }, summary)
          : h("div", { className: "dshmem_hud_body dshmem_hud_empty" },
              h("div", { className: "dshmem_hud_emptyTitle" }, t("hudNoSaved")),
              h("div", { className: "dshmem_hud_emptyHint" }, t("hudEmptyHint")),
            ),
        h("div", {
          className: "dshmem_hud_resize",
          title: t("hudResize"),
          onPointerDown: startResize,
          "aria-hidden": "true",
        }),
      );
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-memory: 设置页词典");
      ctx.effect(() => syncNavMarker(() => t("nav")), "dsh-memory: 设置导航图标");

      // 语言切换时让页面重渲染（label 是 thunk，但组件自身不会自动跟随）。
      const localeStore = makeStore({ revision: ctx.locale.getSnapshot?.()?.revision ?? 0 });
      ctx.effect(
        () =>
          ctx.locale.subscribe(() => {
            localeStore.set({ revision: ctx.locale.getSnapshot?.()?.revision ?? 0 });
          }),
        "dsh-memory: locale 订阅",
      );

      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "memory",
            order: 25,
            label: () => t("nav"),
            locale: NS,
            inject: () => ({ hooks: { memoryLocale: localeStore } }),
          },
          MemorySection,
        ),
      );

      /* 前台会话卡：宿主提供 shell.overlay 时才挂载；没有该槽位的宿主自然不显示。 */
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          {
            name: "shell.overlay",
            id: "session-hud",
            order: 30,
            locale: NS,
          },
          SessionMemoryHud,
        ),
      );
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
