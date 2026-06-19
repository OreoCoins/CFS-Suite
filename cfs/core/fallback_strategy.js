/**
 * CFS-Suite · core/fallback_strategy.js
 *
 * 从 CFS v4.x（L5272-5635）整段迁移 — 弹性恢复体系骨架
 *   - FallbackStrategy：mode 切换（v4_full / v3_only / degraded）
 *   - HealthMonitor：故障事件订阅 + 自动降级
 *
 * 依赖：injection_strategy.js / diff_engine.js
 */
import { polyfilledApis as _r } from '../compat/tavern_helper_polyfill.js';
import './statdata_engine.js'; import './injection_strategy.js';
void _r;

/* ==========================================================
 * CFS v4.x: FallbackStrategy + HealthMonitor
 * (弹性恢复体系骨架 — 为 真接管准备的安全网)
 *
 * 设计哲学（roadmap §"故障树初版"）：
 * - HealthMonitor 监听所有 cfs_*_drift / corrupted / failure 事件
 * - FallbackStrategy 维护三态状态机：
 * 'mvu_fallback' — 默认，v4.x 完全旁路，prompt 走 MVU 原渲染
 * 'v4_full' — v4.x 全面接管
 * 'v4_degraded' — 出故障后强制降级（同 mvu_fallback 效果，但带原因记录）
 * - 默认 mode = 'mvu_fallback' (B 方案 — 显式 opt-in 才接管)
 * - 当前 未做，degrade/recover 只切状态机 + emit 事件
 * （没有"实际接管动作"要回滚），等 来了状态机即生效
 *
 * 故障 → 降级 阈值（连续 N 次同类故障 → 自动 degradeToMvu）：
 * - drift 类故障：3 次
 * - corruption 类故障：1 次（立即降级）
 * - psis 类故障：5 次（容忍度高，PSIS 误处理修复后即恢复）
 * ==========================================================*/
(function () {
 'use strict';

 var _GLOBAL = (typeof window !== 'undefined' && window.parent) || (typeof window !== 'undefined' ? window : null);
 if (!_GLOBAL || !_GLOBAL.CFS4 || !_GLOBAL.CFS4._loaded) {
 console.warn('[CFS v4.x] CFS4 not initialized, abort');
 return;
 }
 if (_GLOBAL.CFS4.HealthMonitor && _GLOBAL.CFS4.FallbackStrategy) {
 console.warn('[CFS v4.x] HealthMonitor/FallbackStrategy 已加载，skip');
 return;
 }

 var CFS4 = _GLOBAL.CFS4;
 var L = CFS4.log;
 var FB_STATE_KEY = 'cfs_v4_fallback_strategy_state';

 // ===== 状态枚举 =====
 var MODE = {
 MVU_FALLBACK: 'mvu_fallback',
 V4_FULL: 'v4_full',
 V4_DEGRADED: 'v4_degraded'
 };
 var HEALTH = {
 HEALTHY: 'healthy',
 DEGRADED: 'degraded',
 FALLBACK: 'fallback'
 };

 // ===== 故障阈值配置 =====
 var FAILURE_THRESHOLDS = {
 'cfs_schema_drift_detected': 3, // 3 次 schema 漂移 → 降级
 'cfs_pr_corrupted': 1, // 1 次 PathRegistry 损坏 → 立即降级
 'cfs_psis_failure': 5, // 5 次 PSIS 误处理 → 降级
 'cfs_injection_failed': 3 // 3 次注入失败 → 降级 (用)
 };

 // ===== HealthMonitor 内部 state =====
 var _failureCounts = {}; // { 'cfs_schema_drift_detected': 2, ... }
 var _healthHistory = []; // 最近 20 条故障信号
 var _MAX_HISTORY = 20;
 var _currentHealth = HEALTH.HEALTHY;

 // ===== FallbackStrategy 内部 state =====
 var _currentMode = MODE.MVU_FALLBACK; // 默认 B 方案：启动不接管
 var _degradedReason = null;
 var _lastModeChangeAt = new Date().toISOString();
 var _modeChangeHistory = []; // { from, to, reason, at }
 var _MAX_MODE_HISTORY = 10;

 // ===== 持久化 =====
 function _persistState() {
 try {
 if (typeof updateVariablesWith !== 'function') return false;
 updateVariablesWith(function (vars) {
 if (!vars || typeof vars !== 'object') vars = {};
 vars[FB_STATE_KEY] = {
 mode: _currentMode,
 health: _currentHealth,
 degraded_reason: _degradedReason,
 last_change_at: _lastModeChangeAt,
 mode_history: _modeChangeHistory
 };
 return vars;
 }, { type: 'script', script_id: getScriptId() });
 return true;
 } catch (e) { L.warn('FallbackStrategy persist failed', e); return false; }
 }

 function _loadState() {
 try {
 if (typeof getVariables !== 'function') return null;
 var sv = getVariables({ type: 'script', script_id: getScriptId() });
 return (sv && sv[FB_STATE_KEY]) || null;
 } catch (e) { L.warn('FallbackStrategy loadState failed', e); return null; }
 }

 function _bootRestore() {
 var loaded = _loadState();
 if (loaded) {
 // 容错：旧版可能没 mode_history
 if (loaded.mode === MODE.MVU_FALLBACK || loaded.mode === MODE.V4_FULL || loaded.mode === MODE.V4_DEGRADED) {
 _currentMode = loaded.mode;
 }
 if (loaded.health === HEALTH.HEALTHY || loaded.health === HEALTH.DEGRADED || loaded.health === HEALTH.FALLBACK) {
 _currentHealth = loaded.health;
 }
 _degradedReason = loaded.degraded_reason || null;
 _lastModeChangeAt = loaded.last_change_at || _lastModeChangeAt;
 _modeChangeHistory = Array.isArray(loaded.mode_history) ? loaded.mode_history.slice(-_MAX_MODE_HISTORY) : [];
 L.info('FallbackStrategy boot: 恢复 mode=' + _currentMode + ' health=' + _currentHealth
 + (_degradedReason ? ' reason=' + _degradedReason : ''));
 } else {
 L.info('FallbackStrategy boot: 无历史 state，默认 mode=' + _currentMode + ' health=' + _currentHealth);
 }
 }

 // ===== HealthMonitor: 故障信号处理 =====
 function _onFailureEvent(eventName, payload) {
 // === 启动期事件丢弃（spec v2）：未 DONE 前的失败不算"故障"，是"未就绪" ===
 // 这是"未就绪 ≠ 故障"硬约束的最后一道闸 —— 杜绝启动期 fail 触发自动降级
 try {
 var coord = (_GLOBAL && _GLOBAL.CFS4 && _GLOBAL.CFS4.Coordinator) || null;
 var phase = coord && coord.getState && coord.getState().phase;
 if (phase && phase !== 'DONE' && phase !== 'READY_FULL' && phase !== 'READY_NO_MVU') {
 L.debug('HealthMonitor: 启动期事件丢弃 ' + eventName + ' (phase=' + phase + ')');
 return;
 }
 } catch (_e) { /* fallthrough */ }

 _healthHistory.unshift({
 event: eventName,
 payload: payload,
 at: new Date().toISOString()
 });
 if (_healthHistory.length > _MAX_HISTORY) _healthHistory.pop();

 _failureCounts[eventName] = (_failureCounts[eventName] || 0) + 1;

 L.debug('HealthMonitor: ' + eventName + ' #' + _failureCounts[eventName] + ' / threshold=' + (FAILURE_THRESHOLDS[eventName] || '∞'));

 // 阈值检测
 var threshold = FAILURE_THRESHOLDS[eventName];
 if (threshold && _failureCounts[eventName] >= threshold) {
 L.warn('HealthMonitor: ' + eventName + ' 累计 ' + _failureCounts[eventName] + ' 次（阈值 ' + threshold + '）→ 自动降级');
 _autoDegradeOnThreshold(eventName);
 }

 // 任何故障都把 health 状态拉低
 if (_currentHealth === HEALTH.HEALTHY) {
 _setHealth(HEALTH.DEGRADED, '检测到 ' + eventName);
 }
 }

 function _autoDegradeOnThreshold(eventName) {
 if (_currentMode === MODE.MVU_FALLBACK || _currentMode === MODE.V4_DEGRADED) {
 L.debug('HealthMonitor 自动降级: 已在 fallback 状态，跳过');
 return;
 }
 degradeToMvu({ reason: '自动降级 ' + eventName + ' 累计 ' + _failureCounts[eventName] + ' 次', auto: true });
 }

 function _setHealth(newHealth, reason) {
 if (_currentHealth === newHealth) return;
 var oldHealth = _currentHealth;
 _currentHealth = newHealth;
 L.info('HealthMonitor: health ' + oldHealth + ' → ' + newHealth + (reason ? ' (' + reason + ')' : ''));
 CFS4.emit(newHealth === HEALTH.HEALTHY ? 'cfs_v4_recovered' : 'cfs_v4_degraded', {
 from_health: oldHealth, to_health: newHealth, reason: reason
 });
 _persistState();
 }

 function _resetFailureCounts() {
 _failureCounts = {};
 L.debug('HealthMonitor: 故障计数清零');
 }

 // ===== FallbackStrategy: degradeToMvu =====
 function degradeToMvu(opts) {
 opts = opts || {};
 var reason = opts.reason || '手动降级';
 var auto = opts.auto === true;
 var prevMode = _currentMode;

 if (prevMode === MODE.MVU_FALLBACK) {
 L.debug('degradeToMvu: 已是 mvu_fallback，跳过');
 return { changed: false, mode: _currentMode };
 }

 // === 实际接管动作 ===
 // 真接管落地后，这里需要：
 // 1. enable 原 worldbook 内 {{format_message_variable::stat_data}} entry
 // 2. disable v4.x 动态 entry（如果存在）
 // 当前 阶段 v4.x 还没真接管 prompt，所以这里只切状态机 + emit
 // —— 状态机先就绪，等 来填具体动作

 var targetMode = auto ? MODE.V4_DEGRADED : MODE.MVU_FALLBACK;
 _setMode(targetMode, reason);
 _degradedReason = reason;
 _setHealth(HEALTH.FALLBACK, reason);

 L.warn('🛡️ degradeToMvu: ' + prevMode + ' → ' + targetMode + ' (' + reason + ')');

 // spec v2: toast 走 NotificationCenter（防抖 + 启动期静默）
 try {
 var _nc = (_GLOBAL && _GLOBAL.CFS4 && _GLOBAL.CFS4.NotificationCenter) || null;
 if (_nc) _nc.notify('degrade', { reason: reason, mode_pair: prevMode + '→' + targetMode });
 } catch (_e) {}

 return { changed: true, mode: targetMode, prev_mode: prevMode, reason: reason };
 }

 // ===== FallbackStrategy: recoverToV4 =====
 function recoverToV4(opts) {
 opts = opts || {};
 var prevMode = _currentMode;

 if (prevMode === MODE.V4_FULL) {
 L.debug('recoverToV4: 已是 v4_full，跳过');
 return { changed: false, mode: _currentMode };
 }

 // === 健康检查 ===
 var healthCheck = _runHealthCheck();
 if (!healthCheck.ok && !opts.force) {
 L.warn('recoverToV4: 健康检查未通过，拒绝恢复 (用 {force: true} 强制)', healthCheck);
 return { changed: false, mode: _currentMode, health_check: healthCheck };
 }

 // === 实际恢复动作===
 // 1. disable 原 stat_data entry
 // 2. enable v4.x 动态 entry

 _setMode(MODE.V4_FULL, opts.reason || '手动恢复');
 _degradedReason = null;
 _resetFailureCounts();
 _setHealth(HEALTH.HEALTHY, '恢复成功');

 L.info('✅ recoverToV4: ' + prevMode + ' → v4_full');

 // spec v2: toast 走 NotificationCenter（防抖 + 启动期静默）
 try {
 var _nc = (_GLOBAL && _GLOBAL.CFS4 && _GLOBAL.CFS4.NotificationCenter) || null;
 if (_nc) _nc.notify('recover', { mode_pair: prevMode + '→v4_full' });
 } catch (_e) {}

 return { changed: true, mode: MODE.V4_FULL, prev_mode: prevMode };
 }

 // ===== 健康检查（recoverToV4 前置）=====
 function _runHealthCheck() {
 var checks = {};

 // 检查 1: PathRegistry 非空 + 持久化正常
 try {
 var prCount = Object.keys(CFS4.PathRegistry.getAll()).length;
 checks.path_registry_populated = { ok: prCount > 0, count: prCount };
 } catch (e) { checks.path_registry_populated = { ok: false, error: e.message }; }

 // 检查 2: SchemaFrozenLayer 工作
 try {
 checks.schema_frozen_layer = { ok: !!(CFS4.SchemaFrozenLayer && CFS4.SchemaFrozenLayer._version) };
 } catch (e) { checks.schema_frozen_layer = { ok: false, error: e.message }; }

 // 检查 3: 当前 health = HEALTHY 或最近 N 秒无新故障
 var noRecentFailure = true;
 if (_healthHistory.length > 0) {
 var lastFailAt = new Date(_healthHistory[0].at).getTime();
 var minutesSince = (Date.now() - lastFailAt) / 60000;
 noRecentFailure = minutesSince >= 5; // 5 分钟无新故障
 checks.no_recent_failure = { ok: noRecentFailure, minutes_since_last: minutesSince };
 } else {
 checks.no_recent_failure = { ok: true, minutes_since_last: null };
 }

 var allOk = Object.keys(checks).every(function (k) { return checks[k].ok; });
 return { ok: allOk, checks: checks };
 }

 function _setMode(newMode, reason) {
 var oldMode = _currentMode;
 _currentMode = newMode;
 _lastModeChangeAt = new Date().toISOString();
 _modeChangeHistory.unshift({
 from: oldMode, to: newMode, reason: reason, at: _lastModeChangeAt
 });
 if (_modeChangeHistory.length > _MAX_MODE_HISTORY) _modeChangeHistory.pop();
 _persistState();
 }

 // ===== 故障事件订阅 =====
 function _wireUpListeners() {
 if (typeof eventOn !== 'function') {
 L.warn('eventOn 不可用，HealthMonitor 无法订阅故障事件');
 return;
 }
 Object.keys(FAILURE_THRESHOLDS).forEach(function (eventName) {
 try {
 eventOn(eventName, function (payload) {
 _onFailureEvent(eventName, payload);
 });
 } catch (e) { L.warn('订阅 ' + eventName + ' 失败', e); }
 });
 L.info('HealthMonitor: 已订阅 ' + Object.keys(FAILURE_THRESHOLDS).length + ' 个故障事件');
 }

 // ===== 导出 =====
 CFS4.HealthMonitor = {
 _version: '8.0',
 getStatus: function () {
 return {
 health: _currentHealth,
 failure_counts: Object.assign({}, _failureCounts),
 recent_failures: _healthHistory.slice(0, 5),
 thresholds: FAILURE_THRESHOLDS
 };
 },
 getHistory: function () { return _healthHistory.slice(); },
 resetCounts: _resetFailureCounts,
 _runHealthCheck: _runHealthCheck
 };

 CFS4.FallbackStrategy = {
 _version: '8.0',
 MODE: MODE,
 degradeToMvu: degradeToMvu,
 recoverToV4: recoverToV4,
 getCurrentMode: function () { return _currentMode; },
 getState: function () {
 return {
 mode: _currentMode,
 health: _currentHealth,
 degraded_reason: _degradedReason,
 last_change_at: _lastModeChangeAt,
 mode_history: _modeChangeHistory.slice()
 };
 },
 // selfTest 不真做降级动作（避免污染用户态），只验证 API 可调
 selfTest: function () {
 var snap0 = this.getState();
 var hm = CFS4.HealthMonitor.getStatus();
 var hc = _runHealthCheck();
 return {
 initial_state: snap0,
 health_status: hm,
 health_check: hc,
 api_ok: true
 };
 }
 };

 // ===== boot =====
 try { eventOnce('app_ready', function () { _bootRestore(); _wireUpListeners(); }); }
 catch (e) { setTimeout(function () { _bootRestore(); _wireUpListeners(); }, 1800); }
 setTimeout(function () {
 // 兜底：如果 app_ready 没触发
 if (!_modeChangeHistory.length && _currentMode === MODE.MVU_FALLBACK) {
 _bootRestore(); _wireUpListeners();
 }
 }, 2800);

 L.info('FallbackStrategy + HealthMonitor 已挂载 (默认 mode=' + _currentMode + ')');
})();


export const FallbackStrategy = window.CFS4?.FallbackStrategy;
export const HealthMonitor = window.CFS4?.HealthMonitor;
console.log('[CFS-Suite/fallback-strategy] FallbackStrategy + HealthMonitor ESM bridge OK');
