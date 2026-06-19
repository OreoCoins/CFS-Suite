/**
 * CFS-Suite · core/statdata_engine.js
 *
 * 从 CFS v4.x（cfs_content_extracted.js L1600-1841）整段迁移：
 *   - CFS4 全局命名空间 init（_loaded / version / _cfg / EVENTS / NS）
 *   - 配置持久化 loadConfig / saveConfig（localStorage 兜底 by polyfill）
 *   - Event Bus 命名约定（cfs_schema_* / cfs_diff_*）
 *   - 角色卡 slug 派生（deriveCharacterSlug）+ schema_id 生成（getSchemaIds）
 *   - 顶层 API 暴露 window.CFS4.{loadConfig, saveConfig, emit, ...}
 *
 * 此模块必须在 kernel.js / 所有 Day 4 Schema/PathRegistry/Injection 模块之前加载。
 * ESM import 链由 kernel.js 顶部 `import './statdata_engine.js'` 保证顺序。
 *
 * Day 4 迁移说明：
 *   - L1772 `_CFS4_GLOBAL = window.parent || window` 在 ST 顶层等价 window，不动
 *   - 内部用 polyfill 注入的 getVariables / updateVariablesWith / getScriptId
 */

import { polyfilledApis as _cfsPolyfillReport } from '../compat/tavern_helper_polyfill.js';
void _cfsPolyfillReport;

// ============================================================
// 以下整段为 cfs_content_extracted.js L1600-1841 的原样迁移（IIFE 形态）
// 末尾把 CFS4 全局对象挂到 window.CFS4 上
// ============================================================

/* ==========================================================
 * CFS v4.x · StatData Engine
 * (prompt runtime state engine)
 *
 * 独立 IIFE，跟 v3.1.7 既有代码物理隔离。
 * 通过 ST API + 事件总线 + window.CFS4 全局命名空间通信。
 * 删此块 = 完全卸载 v4.x，v3.1.7 仍正常工作。
 *
 * 协议契约 v3 收敛版（详见
 * C:\Users\30794\.claude\plans\ok-cache-mvu-mvu-v1-1-0-json-mvu-hashed-diffie.md）：
 * §B Schema Frozen Layer（双锚点 extensions.cfs.schema + SHA256）
 * §C Path Registry 三态机（present / omitted / deleted）
 * §D Stable Presence Token <STABLE ref="..."/>
 * §E Schema Swap Gate（T_w=90s）
 * §F LLM 输出协议（<UpdateVariable> JSONPatch RFC 6902）
 * §G PSIS R1 白名单识别
 *
 * 范围：模块入口 + 配置持久化 + Event Bus 命名 + 角色卡 slug 派生 + schema_id 生成
 * 不实现：Schema 写入 / Diff Engine / Resolver / Injection
 * ==========================================================*/
(function () {
 'use strict';

 if (typeof window !== 'undefined' && window.CFS4 && window.CFS4._loaded) {
 console.warn('[CFS v4.x] StatData Engine already loaded, skipping re-init');
 return;
 }

 // ===== 0. 命名空间常量 =====
 var CFS4_VERSION = '4.0.0';
 var CFS4_SCRIPT_VAR_KEY = 'cfs_v4_statdata_engine_config';
 var CFS4_EXT_NS_ROOT = 'cfs'; // entry.extensions.cfs.{schema,...}
 var CFS4_SCHEMA_ENTRY_PREFIX = '_cfs_schema_'; // worldbook entry comment 约定（仅 UI 提示，识别只看双锚点）
 var CFS4_STABLE_TOKEN_TAG = 'STABLE'; // <STABLE ref="..."/>

 var CFS4_DEFAULT_CONFIG = {
 enabled: true,
 swap_gate_T_w_seconds: 90, // §E 默认 90s，可配 30 ~ 600
 schema_id_character_slug_override: null, // null = 自动派生
 schema_id_global: 'cfs_schema_global',
 log_level: 'info', // 'debug' | 'info' | 'warn' | 'error'
 drift_toast_enabled: true, // 漂移时弹 toast（用到）
 };

 // ===== 1. Logger =====
 var L = {
 _prefix: '[CFS v4.x]',
 _on: function (lvl) {
 var cur = (window.CFS4 && window.CFS4._cfg && window.CFS4._cfg.log_level) || 'info';
 var order = { debug: 0, info: 1, warn: 2, error: 3 };
 return (order[lvl] != null) && (order[cur] != null) && (order[lvl] >= order[cur]);
 },
 debug: function (msg, data) { if (L._on('debug')) console.log(L._prefix, msg, data !== undefined ? data : ''); },
 info: function (msg, data) { if (L._on('info')) console.log(L._prefix, msg, data !== undefined ? data : ''); },
 warn: function (msg, data) { if (L._on('warn')) console.warn(L._prefix, msg, data !== undefined ? data : ''); },
 error: function (msg, data) { console.error(L._prefix, msg, data !== undefined ? data : ''); },
 };

 // ===== 2. 配置持久化（沿用 MVU 助手 getVariables({type:'script'}) 模式）=====
 function loadConfig() {
 try {
 var sv = (typeof getVariables === 'function')
 ? getVariables({ type: 'script', script_id: getScriptId() })
 : {};
 var saved = sv && sv[CFS4_SCRIPT_VAR_KEY];
 var cfg = Object.assign({}, CFS4_DEFAULT_CONFIG, saved || {});
 // 防御性：T_w 范围裁剪 30 ~ 600
 if (typeof cfg.swap_gate_T_w_seconds !== 'number' || cfg.swap_gate_T_w_seconds < 30) cfg.swap_gate_T_w_seconds = 30;
 if (cfg.swap_gate_T_w_seconds > 600) cfg.swap_gate_T_w_seconds = 600;
 L.debug('config loaded', cfg);
 return cfg;
 } catch (e) {
 L.warn('loadConfig failed, fallback default', e);
 return Object.assign({}, CFS4_DEFAULT_CONFIG);
 }
 }

 function saveConfig(cfg) {
 try {
 if (typeof updateVariablesWith !== 'function') {
 L.warn('updateVariablesWith unavailable, config not persisted');
 return false;
 }
 updateVariablesWith(function (vars) {
 if (!vars || typeof vars !== 'object') vars = {};
 vars[CFS4_SCRIPT_VAR_KEY] = cfg;
 return vars;
 }, { type: 'script', script_id: getScriptId() });
 L.info('config saved');
 return true;
 } catch (e) {
 L.error('saveConfig failed', e);
 return false;
 }
 }

 // ===== 3. Event Bus（自有事件命名 cfs_schema_* / cfs_diff_*）=====
 var CFS4_EVENTS = {
 SCHEMA_FROZEN: 'cfs_schema_frozen', // schema 写入完成 + 双锚点封存
 SCHEMA_SWAP_PENDING: 'cfs_schema_swap_pending', // 进入双轨期
 SCHEMA_SWAP_COMMITTED: 'cfs_schema_swap_committed', // lazy switch 完成
 SCHEMA_SWAP_ROLLED_BACK: 'cfs_schema_swap_rolled_back',
 SCHEMA_DRIFT_DETECTED: 'cfs_schema_drift_detected',
 PATH_REGISTRY_UPDATED: 'cfs_path_registry_updated',
 DIFF_COMPUTED: 'cfs_diff_computed',
 INJECTION_APPLIED: 'cfs_injection_applied',
 };

 function emit(eventName, payload) {
 try {
 if (typeof eventEmit === 'function') {
 eventEmit(eventName, payload);
 L.debug('emit ' + eventName, payload);
 } else {
 L.warn('eventEmit unavailable, dropped ' + eventName);
 }
 } catch (e) {
 L.warn('emit ' + eventName + ' failed', e);
 }
 }

 // ===== 4. 角色卡 slug 派生（schema_id 双层命名空间用）=====
 function deriveCharacterSlug() {
 try {
 var name = null;
 // 优先 SillyTavern.getContext 拿角色名
 if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
 try {
 var ctx = SillyTavern.getContext();
 if (ctx && ctx.characters && ctx.characterId != null) {
 var ch = ctx.characters[ctx.characterId];
 if (ch && ch.name) name = ch.name;
 }
 } catch (e) { /* ignore */ }
 }
 // 兜底：当前角色卡的 primary worldbook 名
 if (!name && typeof TavernHelper !== 'undefined' && TavernHelper.getCharLorebooks) {
 try {
 var bind = TavernHelper.getCharLorebooks({ name: 'current' });
 if (bind && bind.primary) name = bind.primary;
 } catch (e) { /* ignore */ }
 }
 if (!name) return 'unknown';
 // slug 化：保留 Unicode 字母数字，其他换 _，去首尾下划线，全小写
 var slug;
 try {
 slug = String(name).replace(/[^\p{L}\p{N}]+/gu, '_');
 } catch (e) {
 // 旧浏览器不支持 \p{L}，降级到 ASCII
 slug = String(name).replace(/[^A-Za-z0-9_一-龥]+/g, '_');
 }
 slug = slug.replace(/^_+|_+$/g, '').toLowerCase();
 return slug || 'unknown';
 } catch (e) {
 L.warn('deriveCharacterSlug failed', e);
 return 'unknown';
 }
 }

 // ===== 5. Schema ID 双层命名空间 =====
 function getSchemaIds() {
 var cfg = (window.CFS4 && window.CFS4._cfg) || CFS4_DEFAULT_CONFIG;
 var slug = cfg.schema_id_character_slug_override || deriveCharacterSlug();
 return {
 character_slug: slug,
 primary: 'cfs_schema_' + slug + ':primary',
 fallback: (cfg.schema_id_global || 'cfs_schema_global') + ':fallback',
 };
 }

 // ===== 6. 顶层 API（暴露给后续 Phase 模块用）=====
 // 挂到 window.parent 让主页面 F12 可访问（CFS 跑在 iframe srcdoc 内）
 var _CFS4_GLOBAL = (typeof window !== 'undefined' && window.parent) || (typeof window !== 'undefined' ? window : null);
 if (_CFS4_GLOBAL) {
 _CFS4_GLOBAL.CFS4 = {
 _loaded: true,
 version: CFS4_VERSION,
 _cfg: null, // app_ready 时填入
 EVENTS: CFS4_EVENTS,
 NS: {
 EXT_ROOT: CFS4_EXT_NS_ROOT, // entry.extensions.cfs
 SCHEMA_ENTRY_PREFIX: CFS4_SCHEMA_ENTRY_PREFIX,
 STABLE_TOKEN_TAG: CFS4_STABLE_TOKEN_TAG,
 SCRIPT_VAR_KEY: CFS4_SCRIPT_VAR_KEY,
 },
 // API
 loadConfig: loadConfig,
 saveConfig: saveConfig,
 emit: emit,
 deriveCharacterSlug: deriveCharacterSlug,
 getSchemaIds: getSchemaIds,
 log: L,
 // 模块的挂载点（占位，后续填）
 SchemaFrozenLayer: null,
 SchemaSwapGate: null,
 SchemaResolver: null,
 PathRegistry: null,
 DiffEngine: null,
 PresenceEncoder: null,
 InjectionStrategy: null,
 };
 // iframe 内同步：方便 iframe 内代码用 window.CFS4 也能访问
 if (typeof window !== 'undefined' && window !== _CFS4_GLOBAL) window.CFS4 = _CFS4_GLOBAL.CFS4;
 }

 // ===== 7. 启动 =====
 function v4_boot() {
 try {
 _CFS4_GLOBAL.CFS4._cfg = loadConfig();
 L.info('StatData Engine ' + CFS4_VERSION + ' initialized; pending chat_changed for schema IDs');
 // spec v2: "loaded" toast 删除（被 NotificationCenter 启动报告取代）
 } catch (e) {
 L.error('v4_boot failed', e);
 }
 }

 // chat 切换时重打 schema IDs，让用户看到实际 slug
 function v4_logSchemaIdsOnChat() {
 try {
 var ids = getSchemaIds();
 L.info('chat_changed → schema IDs: ' + ids.primary + ' / ' + ids.fallback);
 } catch (e) {
 L.warn('v4_logSchemaIdsOnChat failed', e);
 }
 }
 try {
 if (typeof eventOn === 'function') {
 eventOn('chat_changed', v4_logSchemaIdsOnChat);
 eventOn('character_selected', v4_logSchemaIdsOnChat);
 }
 } catch (e) {
 L.warn('chat_changed listener register failed', e);
 }

 try { eventOnce('app_ready', v4_boot); }
 catch (e) { setTimeout(v4_boot, 1800); }
 setTimeout(function () {
 if (_CFS4_GLOBAL && _CFS4_GLOBAL.CFS4 && !_CFS4_GLOBAL.CFS4._cfg) v4_boot();
 }, 2400);

})();


// ============================================================
// ESM export — 桥接 window.CFS4.* 到 ES module 命名空间
// ============================================================
export const CFS4 = window.CFS4;
export const CFS4_VERSION = window.CFS4?.version;
export const CFS4_EVENTS = window.CFS4?.EVENTS;
export const CFS4_NS = window.CFS4?.NS;

console.log('[CFS-Suite/statdata-engine] CFS4 全局命名空间已 init, version=' + CFS4_VERSION);
