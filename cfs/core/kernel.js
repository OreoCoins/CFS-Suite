/**
 * CFS-Suite · core/kernel.js
 *
 * 从 CFS v4.x（cfs_content_extracted.js L1842-2594）整段迁移过来的微内核：
 *   - SessionGate    无状态探针
 *   - Coordinator    启动状态机 + 插件总线 + 看门狗（指数退避）
 *   - NotificationCenter   toast 唯一出口（启动期合并 + 运行期防抖）
 *
 * 三者共享 IIFE 闭包变量（_phase / _plugins / _transitions 等），无法干净拆 3 文件，
 * 整段保留 IIFE 包装；前面加 polyfill import 和 minimal CFS4 boot，后面加 ES module export。
 *
 * 设计文档：D:\Silly\LOG\2026-06-18-cfs-startup-gating-design.md
 * 迁移日志：D:\Silly\LOG\2026-06-19-cfs-suite-day3-impl-log.md
 *
 * 迁移说明：
 *   - L17 `_GLOBAL = window.parent || window` 在 ST 主 window 时 window.parent === window
 *     所以原代码不动；iframe 兼容性保留。
 *   - 内部 `window.parent.this_chid` 等同 `window.this_chid`（ST 主 frame）。
 *   - TavernHelper / eventOn / eventOnce / eventEmit 由 polyfill 注入到 window，
 *     原 IIFE 直接吃这些全局。
 */

import { polyfilledApis as _cfsPolyfillReport } from '../compat/tavern_helper_polyfill.js';
// Day 4 起：CFS4 完整 init 由 statdata_engine.js 做（含 EVENTS / NS / loadConfig / saveConfig
// + 模块挂载点完整字段）。ESM import 保证 statdata_engine.js IIFE 先跑完。
import './statdata_engine.js';

// 让 lint 警告别叫；polyfill 副作用挂全局后下面 IIFE 用全局变量
void _cfsPolyfillReport;

// ============================================================
// 以下整段为 cfs_content_extracted.js L1842-2594 的原样迁移（IIFE 形态）
// 末尾会把 SessionGate / Coordinator / NotificationCenter 挂到 window.CFS4 上。
// 不动 IIFE 内部任何一行，只为外层 ESM 加 export wrapper。
// ============================================================

/* ==========================================================
 * CFS v4.x: SessionGate + Coordinator + NotificationCenter
 * 微内核 + 插件总线架构（spec v2，2026-06-18）
 *
 * SessionGate    — 无状态探针，仅 probe() 一个方法
 * Coordinator    — 启动状态机 + 插件总线 + 看门狗（指数退避）
 * NotificationCenter — toast 唯一出口，启动期合并 + 运行期防抖
 *
 * 核心原则："未就绪 ≠ 故障"：未进会话 / Mvu 未就绪 = 启动状态机的 PROBING，
 * 绝不喂 HealthMonitor，绝不触发 FallbackStrategy，绝不弹 toast。
 *
 * 设计文档：D:\Silly\LOG\2026-06-18-cfs-startup-gating-design.md
 ==========================================================*/
(function () {
 'use strict';

 var _GLOBAL = (typeof window !== 'undefined' && window.parent) || (typeof window !== 'undefined' ? window : null);
 if (!_GLOBAL || !_GLOBAL.CFS4 || !_GLOBAL.CFS4._loaded) {
 console.warn('[CFS Coordinator] CFS4 not initialized, abort');
 return;
 }
 var CFS4 = _GLOBAL.CFS4;
 if (CFS4.Coordinator && CFS4.Coordinator._version) {
 console.warn('[CFS Coordinator] ' + CFS4.Coordinator._version + ' already mounted, skip');
 return;
 }
 var L = CFS4.log || {
 debug: function (m, d) { console.log('[CFS Coordinator]', m, d !== undefined ? d : ''); },
 info: function (m, d) { console.log('[CFS Coordinator]', m, d !== undefined ? d : ''); },
 warn: function (m, d) { console.warn('[CFS Coordinator]', m, d !== undefined ? d : ''); },
 error: function (m, d) { console.error('[CFS Coordinator]', m, d !== undefined ? d : ''); },
 };

 // === 内部状态 ===
 var _phase = 'BOOTING';
 var _transitions = [{ phase: 'BOOTING', at: Date.now() }];
 var _plugins = [];
 var _summary = {};
 var _watchdogTick = 0;
 var _watchdogTimer = null;
 var _chatChangedSeen = false;
 var _hasMvuMacroCache = null; // null=未知 / true=有macro / false=确认无macro
 var _startupTimeMs = 0;

 // 指数退避表：累计 60s
 var BACKOFF = [1000, 2000, 4000, 8000, 15000, 30000];

 // === 工具：Mvu 四层 fallback（与 v4.x InjectionStrategy 一致）===
 function _resolveMvu() {
 if (typeof Mvu !== 'undefined' && Mvu && Mvu.getMvuData) return Mvu;
 if (_GLOBAL && _GLOBAL.Mvu && _GLOBAL.Mvu.getMvuData) return _GLOBAL.Mvu;
 if (typeof window !== 'undefined' && window.Mvu && window.Mvu.getMvuData) return window.Mvu;
 if (typeof window !== 'undefined' && window.parent && window.parent.Mvu && window.parent.Mvu.getMvuData) return window.parent.Mvu;
 return null;
 }

 // === 工具：当前会话 id（chid / chatId / chat 数组任一非空即视为"已进会话"） ===
 // hotfix v2.1：NE Memory Engine 直接看 chatId，CFS 也跟进。SillyTavern 多个全局字段
 // 任一非空即可判定。多入口降低判定漏检风险。
 function _getCurrentChid() {
 // 1) SillyTavern.getContext()
 try {
 var ST = (typeof SillyTavern !== 'undefined') ? SillyTavern : (_GLOBAL && _GLOBAL.SillyTavern);
 if (ST && ST.getContext) {
 var ctx = ST.getContext();
 if (ctx) {
 if (ctx.characterId != null && ctx.characterId !== '') return 'chid:' + ctx.characterId;
 if (ctx.chatId != null && ctx.chatId !== '') return 'chat:' + ctx.chatId;
 if (Array.isArray(ctx.chat) && ctx.chat.length > 0) return 'chat_array';
 if (ctx.name2 && typeof ctx.name2 === 'string' && ctx.name2.length > 0) return 'name2:' + ctx.name2;
 }
 }
 } catch (e) {}
 // 2) window.parent.this_chid（ST 主 frame 全局）
 try {
 var parentWin = (typeof window !== 'undefined' && window.parent) ? window.parent : null;
 if (parentWin) {
 if (parentWin.this_chid != null && parentWin.this_chid !== '') return 'this_chid:' + parentWin.this_chid;
 if (Array.isArray(parentWin.chat) && parentWin.chat.length > 0) return 'parent_chat_array';
 if (parentWin.characters && Array.isArray(parentWin.characters) && parentWin.this_chid != null) return 'parent_chid';
 }
 if (typeof this_chid !== 'undefined' && this_chid != null && this_chid !== '') return 'this_chid_local:' + this_chid;
 } catch (e) {}
 // 3) TavernHelper 兜底
 try {
 var TH = (typeof TavernHelper !== 'undefined') ? TavernHelper : (_GLOBAL && _GLOBAL.TavernHelper);
 if (TH && typeof TH.getCurrentMessageId === 'function') {
 var mid = TH.getCurrentMessageId();
 if (mid != null && mid >= 0) return 'msg:' + mid;
 }
 } catch (e) {}
 return null;
 }

 // === SessionGate（无状态探针） ===
 // 核心判据修正（hotfix v2.1）：以 _getCurrentChid() 非空作为"已进会话"的主判据，
 // 不再依赖 chat_changed 事件触发——因为 F5 恢复会话时 ST 只发 chat_id_changed，
 // 不发 chat_changed；且事件可能在 CFS 加载之前就发生。
 CFS4.SessionGate = {
 probe: function () {
 // 1. 角色卡 ID 是主判据（最权威）
 var chid = _getCurrentChid();
 if (chid == null) {
 return { state: 'idle', reason: _chatChangedSeen ? 'no_character' : 'no_character_no_event' };
 }
 // 2. Mvu 探针
 var mvu = _resolveMvu();
 if (mvu && mvu.getMvuData) {
 try {
 var data = mvu.getMvuData({ type: 'message', message_id: -1 });
 if (data && typeof data.then === 'function') {
 // 异步：当作 pending，下次 tick 再试
 data.then(function () { /* noop */ }).catch(function () {});
 return { state: 'pending_mvu', reason: 'mvu_async_pending', detail: { chid: chid } };
 }
 if (data && data.stat_data && typeof data.stat_data === 'object' && Object.keys(data.stat_data).length > 0) {
 return { state: 'ready_full', reason: 'mvu_ready', detail: { chid: chid } };
 }
 } catch (e) { /* fallthrough → pending */ }
 }
 // 3. stat_data 拿不到：检查卡是否带 MVU
 if (_hasMvuMacroCache === false) {
 return { state: 'ready_no_mvu', reason: 'no_mvu_card', detail: { chid: chid } };
 }
 // 4. cache 还没填 或 确认有 macro → 等
 return { state: 'pending_mvu', reason: 'mvu_loading', detail: { chid: chid, macro_cache: _hasMvuMacroCache } };
 }
 };

 // === Coordinator 内部：状态机 ===
 function _transit(newPhase, reason) {
 _phase = newPhase;
 _transitions.push({ phase: newPhase, at: Date.now(), reason: reason });
 L.info('Coordinator: → ' + newPhase + (reason ? ' (' + reason + ')' : ''));
 }

 function _runPluginEvent(event, ctx) {
 var sorted = _plugins.slice().sort(function (a, b) { return (a.priority || 50) - (b.priority || 50); });
 return sorted.reduce(function (chain, p) {
 return chain.then(function () {
 var fn = p[event];
 if (typeof fn !== 'function') return null;
 return Promise.resolve()
 .then(function () { return fn(ctx); })
 .then(function (r) { _summary[p.name] = r || { ok: true }; })
 .catch(function (e) {
 _summary[p.name] = { ok: false, summary: 'plugin ' + p.name + ' crashed: ' + (e && e.message) };
 L.warn('plugin ' + p.name + ' crashed during ' + event, e);
 });
 });
 }, Promise.resolve()).then(function () {
 _transit('DONE', event + ' done');
 try {
 if (typeof eventEmit === 'function') {
 eventEmit('cfs:coordinator:done', { phase: _phase, summary: _summary, prev_phase: ctx && ctx.phase });
 }
 } catch (e) {}
 });
 }

 function _markReady(state) {
 if (_phase !== 'PROBING') return;
 if (_watchdogTimer) { clearTimeout(_watchdogTimer); _watchdogTimer = null; }
 _startupTimeMs = Date.now() - _transitions[0].at;
 var phaseName = (state === 'ready_full') ? 'READY_FULL' : 'READY_NO_MVU';
 _transit(phaseName, 'session_ready (用时 ' + _startupTimeMs + 'ms)');
 // hotfix v2.3：进 READY 立即 audit（force）
 _auditTrigger('session_ready', { force: true });
 _runPluginEvent('onSessionReady', { state: state, phase: phaseName, summary: _summary });
 }

 function _markTimeout(reason) {
 if (_phase !== 'PROBING') return;
 if (_watchdogTimer) { clearTimeout(_watchdogTimer); _watchdogTimer = null; }
 _startupTimeMs = Date.now() - _transitions[0].at;
 _transit('TIMEOUT', reason + ' (用时 ' + _startupTimeMs + 'ms)');
 _runPluginEvent('onSessionTimeout', { reason: reason, phase: 'TIMEOUT', summary: _summary });
 }

 // === 看门狗（指数退避） ===
 function _watchdogStep() {
 if (_phase !== 'PROBING') return;
 var probe = CFS4.SessionGate.probe();
 if (probe.state === 'ready_full' || probe.state === 'ready_no_mvu') {
 return _markReady(probe.state);
 }
 if (_watchdogTick >= BACKOFF.length) {
 if (probe.state === 'pending_mvu') return _markTimeout('mvu_load_timeout');
 L.info('Coordinator: 看门狗退避表耗尽，仍 idle，等 chat_changed');
 return;
 }
 var delay = BACKOFF[_watchdogTick++];
 L.debug('Coordinator: watchdog ' + _watchdogTick + '/' + BACKOFF.length + ' 状态=' + probe.state + ' 下次=' + delay + 'ms');
 _watchdogTimer = setTimeout(_watchdogStep, delay);
 }

 // === chat_changed 触发的探针（不消耗看门狗 tick） ===
 function _tick() {
 if (_phase !== 'PROBING') return;
 var probe = CFS4.SessionGate.probe();
 if (probe.state === 'ready_full' || probe.state === 'ready_no_mvu') {
 _markReady(probe.state);
 }
 }

 // === chat_changed 钩 ===
 function _onChatChanged() {
 _chatChangedSeen = true; // 闭包变量；外部通过 Coordinator._chatChangedSeen getter 读取
 // 异步预填 _hasMvuMacroCache
 _prefillMvuMacroCache();
 // hotfix v2.3：chat_changed 直接调 audit（不等 macro cache 链路）
 _auditTrigger('chat_changed', { force: true });
 if (_phase === 'DONE' || _phase === 'TIMEOUT') {
 // 切卡走 v4.x 老路径，但仍要审计新卡的 entry 位置
 return;
 }
 _tick();
 }

 // === 预填 macro cache ===
 function _prefillMvuMacroCache() {
 try {
 // 优先用 TavernHelper 全局 API
 var helper = (typeof TavernHelper !== 'undefined') ? TavernHelper : (_GLOBAL && _GLOBAL.TavernHelper);
 if (!helper || !helper.getCharLorebooks || !helper.getLorebookEntries) {
 // 兜底：等 SchemaFrozenLayer 就绪
 if (CFS4.SchemaFrozenLayer && CFS4.SchemaFrozenLayer.getActiveWorldbook) {
 Promise.resolve(CFS4.SchemaFrozenLayer.getActiveWorldbook())
 .then(function (wb) {
 if (!wb) { _hasMvuMacroCache = null; return; }
 return Promise.resolve(helper && helper.getLorebookEntries ? helper.getLorebookEntries(wb) : null);
 })
 .then(function (entries) { _commitMacroCache(entries); })
 .catch(function () { _hasMvuMacroCache = null; });
 }
 return;
 }
 // 主路径
 Promise.resolve(helper.getCharLorebooks({ name: 'current' }))
 .then(function (bind) {
 if (!bind || !bind.primary) { _hasMvuMacroCache = null; return null; }
 return helper.getLorebookEntries(bind.primary);
 })
 .then(function (entries) { _commitMacroCache(entries); })
 .catch(function () { _hasMvuMacroCache = null; });
 } catch (e) { _hasMvuMacroCache = null; }
 }
 function _commitMacroCache(entries) {
 if (!entries || !entries.length) { _hasMvuMacroCache = null; return; }
 var has = false;
 for (var i = 0; i < entries.length; i++) {
 var c = entries[i] && entries[i].content;
 if (typeof c === 'string' && (
 c.indexOf('{{format_message_variable::stat_data}}') >= 0 ||
 c.indexOf('format_message_variable::stat_data') >= 0 ||
 // hotfix v2.7: EJS 模板识别
 c.indexOf("getvar('stat_data')") >= 0 ||
 c.indexOf('getvar("stat_data")') >= 0 ||
 c.indexOf('<status_current_variables>') >= 0
 )) { has = true; break; }
 }
 _hasMvuMacroCache = has;
 L.debug('Coordinator: macro cache committed = ' + has);
 // cache 变化后再 tick 一次（catch _ready_no_mvu）
 _tick();
 // hotfix v2.3：cache 提交时也跑一次 audit（兜底）
 _auditTrigger('macro_cache_committed');
 }

 // === hotfix v2.3：主动审计 + 强制修正 CFS 自管 entry 位置 ===
 // 防御外部脚本（WM 等）改坏 CFS entry 的 position/role，让 1KB 内容跑到 miss 区
 // SCHEMA entry 期望 pos=0+role=0（before_char，进 prefix cache 区）
 // DYNAMIC entry 期望 pos=4+role=1（at_depth_as_user，落 chat 末尾不破坏 prefix）
 var _auditDebounceMs = 5000;
 var _auditLastRun = 0;
 var _auditRunCount = 0;
 // hotfix v2.6：死循环检测 — 同一 uid 连续修 N 次仍不成功 → 标记本会话跳过
 var _auditFailCount = {};        // uid → 连续失败次数
 var _auditSkippedUids = {};      // uid → true（本会话标记跳过）
 var _AUDIT_FAIL_THRESHOLD = 3;
 // hotfix v2.7: DYNAMIC 重建在途锁，避免 audit 重复触发 bootstrap
 var _auditRebuildInFlight = false;
 // hotfix v2.8: TavernHelper 位置字符串别名 ↔ ST 数字常量
 // TavernHelper.getLorebookEntries 返回字符串别名，setLorebookEntries 也接受字符串
 // ST 内部 world_info_position: before=0, after=1, ANTop=2, ANBottom=3, atDepth=4, EMTop=5, EMBottom=6, outlet=7
 var POS_STR_TO_NUM = {
 'before_character_definition': 0,
 'after_character_definition': 1,
 'an_top': 2,
 'an_bottom': 3,
 'at_depth': 4,
 'at_depth_as_user': 4,  // ST 内部仍是 atDepth (4) + role=user，但 TavernHelper 用单独别名
 'em_top': 5,
 'em_bottom': 6,
 'outlet': 7
 };
 function _normalizePos(p) {
 if (typeof p === 'number') return p;
 if (typeof p === 'string' && POS_STR_TO_NUM[p] !== undefined) return POS_STR_TO_NUM[p];
 return -1;
 }
 async function _auditCfsEntries(opts) {
 opts = opts || {};
 var force = opts.force === true;
 var now = Date.now();
 if (!force && (now - _auditLastRun < _auditDebounceMs)) {
 console.log('[CFS Audit] debounce 跳过 (距上次 ' + (now - _auditLastRun) + 'ms < ' + _auditDebounceMs + 'ms)');
 return { skipped: true };
 }
 _auditLastRun = now;
 _auditRunCount++;
 try {
 var helper = (typeof TavernHelper !== 'undefined') ? TavernHelper : (_GLOBAL && _GLOBAL.TavernHelper);
 if (!helper || !helper.getCharLorebooks || !helper.getLorebookEntries || !helper.setLorebookEntries) {
 console.warn('[CFS Audit] TavernHelper 不可用，跳过 (run #' + _auditRunCount + ')');
 return { skipped: true, reason: 'no_helper' };
 }
 var bind = await Promise.resolve(helper.getCharLorebooks({ name: 'current' }));
 if (!bind || !bind.primary) {
 console.log('[CFS Audit] 当前卡无 primary worldbook，跳过');
 return { skipped: true, reason: 'no_primary_wb' };
 }
 var entries = await Promise.resolve(helper.getLorebookEntries(bind.primary));
 if (!Array.isArray(entries) || entries.length === 0) {
 console.log('[CFS Audit] worldbook 为空，跳过');
 return { skipped: true, reason: 'empty_wb' };
 }

 console.log('[CFS Audit] run #' + _auditRunCount + ' 扫描 ' + entries.length + ' 条 entry');

 var fixes = [];
 var cfsCount = 0;
 var skippedDisabled = 0;
 var skippedFailed = 0;
 for (var i = 0; i < entries.length; i++) {
 var e = entries[i];
 var c = e && e.comment;
 if (typeof c !== 'string') continue;
 var isSchema = c.indexOf('[CFS4_SCHEMA|') === 0;
 var isDynamic = c.indexOf('[CFS4_DYNAMIC|') === 0;
 if (!isSchema && !isDynamic) continue;
 cfsCount++;

 // hotfix v2.6 (1)：跳过 disabled entry — SCHEMA entry 设计上就是 disable=true（不参 prompt），position 不影响 cache
 // 唯一可能 enabled 的 SCHEMA 是 meta_rule_v61（writeSchema injectable=true），DYNAMIC entry 也是 enabled
 // 通过 disable=true / enabled=false 判断 entry 是否真的会进 prompt
 var entryDisabled = (e.disable === true) || (e.enabled === false);
 if (entryDisabled) {
 skippedDisabled++;
 continue;
 }

 // hotfix v2.6 (2)：死循环保护 — 同 uid 连续 N 次修复失败 → 标记跳过
 if (_auditSkippedUids[e.uid]) {
 skippedFailed++;
 continue;
 }

 // 期望值：SCHEMA=0+0（before_character_definition / system）
 //         DYNAMIC=4+1（at_depth_as_user → 数字层就是 pos=4 + role=1=user）
 var expectedPos = isSchema ? 0 : 4;
 var expectedRole = isSchema ? 0 : 1;

 // hotfix v2.8: 兼容字符串别名（TavernHelper 返回的是字符串）
 var actualPos = _normalizePos(e.position);
 // DYNAMIC entry role=null 时容忍（TavernHelper at_depth_as_user 模式下 role 可能 null/undefined）
 // 视 null/undefined 为期望 role
 var actualRole;
 if (e.role == null) {
 actualRole = (!isSchema && expectedPos === 4) ? expectedRole : 0;  // DYNAMIC role=null → 视为期望值
 } else {
 actualRole = e.role;
 }
 var posMatch = actualPos === expectedPos;
 var roleMatch = actualRole === expectedRole;

 console.log('[CFS Audit] uid=' + e.uid + ' 类型=' + (isSchema ? 'SCHEMA' : 'DYNAMIC')
 + ' 实际 pos=' + actualPos + ' role=' + actualRole + ' (raw pos=' + (typeof e.position) + ':' + e.position + ' role=' + (typeof e.role) + ':' + e.role + ')'
 + ' 期望 pos=' + expectedPos + ' role=' + expectedRole
 + ' ' + (posMatch && roleMatch ? '✓ OK' : '✗ 需修正'));

 if (posMatch && roleMatch) {
 // 命中即重置失败计数
 if (_auditFailCount[e.uid]) _auditFailCount[e.uid] = 0;
 continue;
 }
 // 失败计数 +1，触发 N 次仍未成功 → 标记本会话跳过这个 uid
 _auditFailCount[e.uid] = (_auditFailCount[e.uid] || 0) + 1;
 if (_auditFailCount[e.uid] >= _AUDIT_FAIL_THRESHOLD) {
 _auditSkippedUids[e.uid] = true;
 console.warn('[CFS Audit] uid=' + e.uid + ' 连续 ' + _AUDIT_FAIL_THRESHOLD + ' 次修复后状态仍不匹配（疑似 TavernHelper 字段映射问题），本会话跳过');
 continue;
 }

 // 只传必要字段，避免 partial update 把其他字段抹掉
 var newKeys = Array.isArray(e.keys) ? e.keys.slice() : [];
 if (newKeys.indexOf('_cfs4_position_locked') < 0) newKeys.push('_cfs4_position_locked');
 var newExt = Object.assign({}, e.extensions || {});
 newExt.cfs = Object.assign({}, newExt.cfs || {}, {
 expected_position: expectedPos,
 expected_role: expectedRole,
 managed: true
 });
 // hotfix v2.8: 写入用字符串别名 — TavernHelper 接受字符串，数字会被默认值兜底
 var writePos = isSchema ? 'before_character_definition' : 'at_depth_as_user';
 fixes.push({
 uid: e.uid,
 position: writePos,
 role: expectedRole,
 depth: e.depth || 0,
 keys: newKeys,
 extensions: newExt
 });
 }
 if (skippedDisabled || skippedFailed) {
 console.log('[CFS Audit] 跳过 ' + skippedDisabled + ' 条 disabled entry + ' + skippedFailed + ' 条标记不可修 entry');
 }

 console.log('[CFS Audit] 共发现 ' + cfsCount + ' 条 CFS 自管 entry，需修正 ' + fixes.length + ' 条');

 // hotfix v2.7: DYNAMIC 存在性自愈 — SCHEMA 在但 DYNAMIC 缺（WM 误杀场景），触发 bootstrapTakeover 重建
 // 不 await（避免阻塞 audit 调用方），fire-and-forget；下次 prompt 拼装时新 DYNAMIC 就绪
 try {
 var hasSchema = entries.some(function (e) { return e && typeof e.comment === 'string' && e.comment.indexOf('[CFS4_SCHEMA|') === 0; });
 var hasDynamic = entries.some(function (e) { return e && typeof e.comment === 'string' && e.comment.indexOf('[CFS4_DYNAMIC|') === 0; });
 if (hasSchema && !hasDynamic && !_auditRebuildInFlight) {
 console.warn('[CFS Audit] 检测到 SCHEMA 存在但 DYNAMIC 缺失（疑似 WM 删除），fire bootstrapTakeover 重建...');
 _auditRebuildInFlight = true;
 var injStrat = _GLOBAL && _GLOBAL.CFS4 && _GLOBAL.CFS4.InjectionStrategy;
 if (injStrat && typeof injStrat.bootstrapTakeover === 'function') {
 Promise.resolve(injStrat.bootstrapTakeover({ force: true }))
 .then(function (rep) {
 _auditRebuildInFlight = false;
 if (rep && rep.success) {
 console.warn('[CFS Audit] ✅ DYNAMIC 重建成功，注入 ' + (rep.steps || []).filter(function(s){return s.step==='applyInjection';})[0]);
 } else {
 console.warn('[CFS Audit] DYNAMIC 重建未成功（可能 detection 仍找不到渲染 entry）', rep);
 }
 })
 .catch(function (e) {
 _auditRebuildInFlight = false;
 console.warn('[CFS Audit] DYNAMIC 重建异常', e);
 });
 } else {
 _auditRebuildInFlight = false;
 console.warn('[CFS Audit] InjectionStrategy 不可用，无法重建 DYNAMIC');
 }
 }
 } catch (_eReb) { _auditRebuildInFlight = false; }

 if (fixes.length > 0) {
 try {
 await Promise.resolve(helper.setLorebookEntries(bind.primary, fixes));
 console.warn('[CFS Audit] ✅ 已修正 ' + fixes.length + ' 条 CFS entry 位置 → 写回 worldbook 成功 (uids=' + fixes.map(function (f) { return f.uid; }).join(',') + ')');
 try {
 if (typeof eventEmit === 'function') {
 eventEmit('cfs:position:repaired', { count: fixes.length, uids: fixes.map(function (f) { return f.uid; }) });
 }
 } catch (_e2) {}
 return { fixed: fixes.length, uids: fixes.map(function (f) { return f.uid; }) };
 } catch (eSet) {
 console.error('[CFS Audit] ✗ setLorebookEntries 失败:', eSet);
 return { error: eSet && eSet.message, attempted: fixes.length };
 }
 } else {
 console.log('[CFS Audit] 位置审计通过，无需修正');
 return { fixed: 0 };
 }
 } catch (e) {
 console.error('[CFS Audit] _auditCfsEntries 异常:', e);
 return { error: e && e.message };
 }
 }

 // hotfix v2.3：暴露 audit 给外部 + 加快首次触发
 // 触发链：
 //   ① app_ready 后 3s 强制跑一次（即使没切卡也修）
 //   ② chat_changed 钩内主动调（绕开 macro cache 链路）
 //   ③ macro cache 提交后调（原有，作为兜底）
 //   ④ Coordinator 转 READY_FULL 后调
 function _auditTrigger(label, opts) {
 console.log('[CFS Audit] 触发 (来源=' + label + ')');
 return _auditCfsEntries(opts).catch(function (e) { console.error('[CFS Audit] 异常 (' + label + '):', e); });
 }

 // === app_ready 启动探针 ===
 function _startProbing() {
 if (_phase !== 'BOOTING') return;
 _transit('PROBING', 'app_ready');
 _tick(); // 立刻试一次
 _watchdogStep(); // 启动看门狗
 // hotfix v2.3：app_ready 后 3s 强制跑一次 audit（即使没 chat_changed 也要修）
 setTimeout(function () { _auditTrigger('app_ready_delayed', { force: true }); }, 3000);
 }

 // === Coordinator API ===
 CFS4.Coordinator = {
 _version: '1.1',
 _chatChangedSeen: false, // 仅 UI 查询用
 _hasMvuMacroCache: null, // 仅 UI 查询用

 register: function (plugin) {
 if (!plugin || !plugin.name) { L.warn('Coordinator.register: plugin 缺 name'); return; }
 _plugins = _plugins.filter(function (p) { return p.name !== plugin.name; });
 _plugins.push(plugin);
 L.debug('Coordinator: 注册插件 ' + plugin.name + ' (priority=' + (plugin.priority || 50) + ')');
 // 如果已经 READY，给新插件补一次催跑（用于延迟注册的插件）
 // hotfix v2.2: 补跑完成后再 emit cfs:coordinator:done，让面板刷新
 if (_phase === 'READY_FULL' || _phase === 'READY_NO_MVU' || _phase === 'DONE') {
 if (typeof plugin.onSessionReady === 'function') {
 try {
 Promise.resolve(plugin.onSessionReady({ state: _phase.toLowerCase(), phase: _phase, summary: _summary }))
 .then(function (r) {
 _summary[plugin.name] = r || { ok: true };
 try {
 if (typeof eventEmit === 'function') {
 eventEmit('cfs:coordinator:done', { phase: _phase, summary: _summary, late_plugin: plugin.name });
 }
 } catch (_e) {}
 })
 .catch(function (e) {
 _summary[plugin.name] = { ok: false, summary: 'late plugin crashed: ' + e.message };
 try {
 if (typeof eventEmit === 'function') {
 eventEmit('cfs:coordinator:done', { phase: _phase, summary: _summary, late_plugin: plugin.name, crashed: true });
 }
 } catch (_e) {}
 });
 } catch (e) {}
 }
 }
 },

 getState: function () {
 return {
 phase: _phase,
 since: _transitions[_transitions.length - 1].at,
 transitions: _transitions.slice(),
 summary: Object.assign({}, _summary),
 startup_time_ms: _startupTimeMs,
 chat_changed_seen: _chatChangedSeen,
 has_mvu_macro_cache: _hasMvuMacroCache,
 };
 },

 // 关键：所有动 prompt / 写 wb / 弹 toast 的入口在头部调这个
 // 返回 null = 放行；返回 object = 短路返回值
 gateGuard: function (opts) {
 if (opts && opts.force === true) return null;
 if (_phase === 'BOOTING' || _phase === 'PROBING') {
 return { success: false, reason: 'session_not_ready', phase: _phase };
 }
 return null;
 },

 // 调试用
 _tick: _tick,
 _getInternals: function () {
 return { phase: _phase, plugins: _plugins.map(function (p) { return { name: p.name, priority: p.priority }; }) };
 },
 // hotfix v2.3：手动触发 audit（F12 救回入口）
 auditEntries: function (opts) { return _auditTrigger('manual', Object.assign({ force: true }, opts || {})); },
 getAuditState: function () { return { last_run: _auditLastRun, run_count: _auditRunCount, debounce_ms: _auditDebounceMs }; }
 };
 // 暴露给 SessionGate.probe() 用
 Object.defineProperty(CFS4.Coordinator, '_chatChangedSeen', { get: function () { return _chatChangedSeen; }, configurable: true });
 Object.defineProperty(CFS4.Coordinator, '_hasMvuMacroCache', { get: function () { return _hasMvuMacroCache; }, configurable: true });

 // === NotificationCenter ===
 var _toastr = (typeof toastr !== 'undefined') ? toastr : ((_GLOBAL && _GLOBAL.toastr) ? _GLOBAL.toastr : null);
 var _pendingStartup = { psis: null, v4x: null };
 var _lastEmit = {}; // kind → ts
 var _lastKey = {}; // kind → 合并键

 var DEBOUNCE = {
 drift: 10000,
 degrade: 30000,
 recover: 30000,
 mvu_error: 5000,
 psis_r0: 30000,
 };

 function _isStartupPhase() {
 return _phase === 'BOOTING' || _phase === 'PROBING';
 }

 function _toast(type, msg, timeout) {
 try {
 if (!_toastr) { L.warn('toastr 不可用，丢弃: ' + msg); return; }
 var opts = timeout ? { timeOut: timeout } : {};
 if (type === 'success' && _toastr.success) return _toastr.success(msg, '', opts);
 if (type === 'error' && _toastr.error) return _toastr.error(msg, '', opts);
 if (type === 'warning' && _toastr.warning) return _toastr.warning(msg, '', opts);
 if (_toastr.info) return _toastr.info(msg, '', opts);
 } catch (e) {}
 }

 var NC_ROUTES = {
 drift: { type: 'error', timeout: 8000, format: function (p) { return '🛡️ CFS 数据结构异常：' + (p.schema_id || '?') + ' 已自动隔离'; } },
 degrade: { type: 'warning', timeout: 6000, format: function (p) { return '🛡️ MVU 接管已暂停（原因：' + (p.reason || '?') + '）\n数据将回到 MVU 原渲染。详情见「🛡️ MVU 守护」面板'; } },
 recover: { type: 'success', timeout: 4000, format: function () { return '🛡️ MVU 接管已恢复'; } },
 psis_r0: { type: 'warning', timeout: 12000, format: function (p) { return '🛡️ 检测到预设结构问题：[' + (p.names || '?') + '] 排在历史之后 → 破坏缓存命中。请到预设里调整顺序'; } },
 mvu_error: { type: 'warning', timeout: 7000, format: function (p) { return '⚠️ 检测到 MVU 报错（' + (p.pattern || '') + '）。最近一轮 MVU 解析可能失败，变量未更新'; } },
 psis_r1_fix: { type: 'success', timeout: 5000, format: function (p) { return '🛡️ 自动修复 ' + (p.n || 0) + ' 条提示词结构问题'; } },
 mvu_recovered: { type: 'info', timeout: 4000, format: function () { return '🛡️ MVU 守护已自动恢复启用'; } },
 initvar_auto: { type: 'info', timeout: 4000, format: function () { return '🛡️ initvar 生命周期已自动接管'; } },
 info: { type: 'info', timeout: 4000, format: function (p) { return p.msg || ''; } },
 // v4.9 SEM channels
 sem_candidates: { type: 'info', timeout: 9000, format: function (p) { return '📦 深度优化发现 ' + p.count + ' 条稳态候选 entry，命中率可提升 ~' + p.gain + '%。MVU 控制台 → 世界书优化'; } },
 sem_migrated: { type: 'info', timeout: 5000, format: function (p) { return (p.rollback ? '↩ 深度优化回滚' : '⬆ 深度优化迁移') + ' 完成 ok=' + p.ok + ' fail=' + p.fail; } },
 sem_drift: { type: 'warning', timeout: 10000, format: function (p) { return '⚠ 检测到有插件正在回拉深度优化的已迁移条目（uid=' + p.uid + '），请到「📦 世界书优化」面板手动再次优化'; } },
 sem_failed: { type: 'warning', timeout: 6000, format: function (p) { return '⚠ 深度优化操作失败 ' + (p.detail || ''); } },
 // v4.9.3 PSIS Plus channels (savePreset 完整对象架构)
 psis_plus_detected: { type: 'info', timeout: 9000, format: function (p) { return '📐 PSIS Plus 在「' + (p.preset || '?') + '」检测到 ' + p.count + ' 项排序异常，MVU 控制台 → 提示词结构 可一键修复'; } },
 psis_plus_repaired: { type: 'success', timeout: 6000, format: function (p) { return '✓ PSIS Plus 已重排 ' + p.count + ' 项并保存到预设「' + (p.preset || '?') + '」（含正则等所有字段原样保留）'; } },
 psis_plus_restored: { type: 'info', timeout: 6000, format: function (p) { return '↩ PSIS Plus 已还原预设「' + (p.preset || '?') + '」到 ' + (p.timestamp || '') + ' 状态（完整 dump 恢复）'; } },
 psis_plus_failed: { type: 'warning', timeout: 7000, format: function (p) { return '⚠ PSIS Plus 操作失败：' + (p.detail || '?'); } },
 };

 CFS4.NotificationCenter = {
 _version: '1.0',
 report: function (channel, payload) {
 _pendingStartup[channel] = payload || { ok: false, summary: '(未上报)' };
 L.debug('NotificationCenter.report ' + channel + ': ' + (payload && payload.summary));
 },
 notify: function (kind, payload) {
 if (_isStartupPhase()) {
 L.info('[启动期静默] notify ' + kind + ' (' + (payload && (payload.summary || payload.msg || payload.reason) || '') + ')');
 return;
 }
 var now = Date.now();
 var window_ms = DEBOUNCE[kind];
 var keyValue = (payload && (payload.key || payload.schema_id || payload.marker_set || payload.pattern_hash || payload.mode_pair)) || '*';
 var lastKey = _lastKey[kind];
 var lastTs = _lastEmit[kind] || 0;
 if (window_ms && lastKey === keyValue && (now - lastTs) < window_ms) {
 L.debug('NotificationCenter: 防抖丢弃 ' + kind + ' (key=' + keyValue + ')');
 return;
 }
 _lastEmit[kind] = now;
 _lastKey[kind] = keyValue;
 var route = NC_ROUTES[kind];
 if (!route) { L.warn('NotificationCenter: 未知 kind ' + kind); return; }
 var msg = (typeof route.format === 'function') ? route.format(payload || {}) : route.format;
 _toast(route.type, msg, route.timeout);
 },
 flushStartup: function (phase) {
 var psis = _pendingStartup.psis;
 var v4x = _pendingStartup.v4x;
 var psisLine = psis
 ? ((psis.ok ? '✓ ' : '✗ ') + (psis.summary || ''))
 : '— 未上报';
 var v4xLine;
 if (phase === 'TIMEOUT') {
 v4xLine = '✗ 接管失败 — Mvu 长期未就绪';
 } else if (phase === 'READY_NO_MVU') {
 v4xLine = '— 本卡未使用 MVU，无需接管';
 } else if (v4x) {
 v4xLine = (v4x.ok ? '✓ 已接管' : '✗ 未接管') + (v4x.summary ? '（' + v4x.summary + '）' : '');
 } else {
 v4xLine = '— 未上报';
 }
 var msg = '🛡️ CFS 启动报告\n• 提示词结构守护：' + psisLine + '\n• MVU 数据插入位置：' + v4xLine;
 if (phase === 'TIMEOUT') msg += '\n请打开「MVU 守护」面板点「超时手动接管」按钮';
 var type = (phase === 'TIMEOUT') ? 'error' : (phase === 'READY_NO_MVU' ? 'info' : 'success');
 var to = (phase === 'TIMEOUT') ? 12000 : 8000;
 _toast(type, msg, to);
 L.info('NotificationCenter.flushStartup ' + phase + ' 已弹');
 },
 _peekPending: function () { return { psis: _pendingStartup.psis, v4x: _pendingStartup.v4x }; }
 };

 // === 注册 NotificationCenter 自己为 plugin（priority=90，最后跑）===
 CFS4.Coordinator.register({
 name: 'notification_center',
 priority: 90,
 onSessionReady: function (ctx) {
 CFS4.NotificationCenter.flushStartup(ctx.phase || _phase);
 return { ok: true, summary: 'startup report flushed (' + (ctx.phase || _phase) + ')' };
 },
 onSessionTimeout: function () {
 CFS4.NotificationCenter.flushStartup('TIMEOUT');
 return { ok: false, summary: 'startup timeout reported' };
 }
 });

 // === boot hooks ===
 // hotfix v2.1：订阅多个事件名（ST 不同版本/路径触发的事件名不一致）
 // - chat_changed / CHAT_CHANGED — 业火归途小助手/EWC 都监听这俩
 // - chat_id_changed / CHAT_ID_CHANGED — NE Memory Engine 监听这俩，F5 恢复会话时只发这个
 // - character_selected / CHARACTER_SELECTED — 切角色卡时发
 // - message_received / character_message_rendered — 消息事件兜底
 // 任一触发都置位 _chatChangedSeen 并跑 _tick
 var EVENT_NAMES = [
 'chat_changed', 'CHAT_CHANGED',
 'chat_id_changed', 'CHAT_ID_CHANGED',
 'character_selected', 'CHARACTER_SELECTED',
 'message_received', 'MESSAGE_RECEIVED',
 'character_message_rendered', 'CHARACTER_MESSAGE_RENDERED'
 ];

 // hotfix v2.4：worldinfo_updated 监听
 // hotfix v2.6：3 次延迟改为单次 1500ms 防抖 — 避免 audit 自己写入 → 触发 worldinfo_updated → 3 次 audit → 3 次写入 → 9 次... 死循环
 // audit 内部已有 5s debounce 兜底；这里再做事件源去抖
 var _woiTimer = null;
 function _scheduleAuditOnWorldInfoUpdated() {
 if (_woiTimer) clearTimeout(_woiTimer);
 _woiTimer = setTimeout(function () {
 _woiTimer = null;
 _auditTrigger('worldinfo_updated', { force: true });
 }, 1500);
 }
 var _eventBoundCount = 0;
 // 1) 优先用 TavernHelper 的 eventOn
 try {
 if (typeof eventOn === 'function') {
 EVENT_NAMES.forEach(function (name) {
 try { eventOn(name, _onChatChanged); _eventBoundCount++; } catch (e) {}
 });
 // hotfix v2.4: worldinfo_updated 触发延迟 audit（对抗 WM 改后立即生效）
 try { eventOn('worldinfo_updated', _scheduleAuditOnWorldInfoUpdated); } catch (e) {}
 try { eventOn('WORLDINFO_UPDATED', _scheduleAuditOnWorldInfoUpdated); } catch (e) {}
 }
 } catch (e) { L.warn('eventOn 多事件注册失败', e); }
 // 2) NE 风格兜底：直接绑 ST 原生 eventSource.on
 try {
 var ST = (typeof SillyTavern !== 'undefined') ? SillyTavern : (_GLOBAL && _GLOBAL.SillyTavern);
 var ctx = ST && ST.getContext && ST.getContext();
 var es = ctx && ctx.eventSource;
 if (es && typeof es.on === 'function') {
 EVENT_NAMES.forEach(function (name) {
 try { es.on(name, _onChatChanged); _eventBoundCount++; } catch (e) {}
 });
 L.info('SessionGate: eventSource 兜底已绑（共 ' + EVENT_NAMES.length + ' 名）');
 }
 } catch (e) { L.warn('eventSource 兜底注册失败', e); }
 L.info('SessionGate: 共绑定 ' + _eventBoundCount + ' 个事件监听器');

 try { eventOnce('app_ready', _startProbing); }
 catch (e) { setTimeout(_startProbing, 1800); }
 // 兜底：app_ready 没触发的环境
 setTimeout(function () {
 if (_phase === 'BOOTING') _startProbing();
 }, 2500);

 // hotfix v2.1：脚本加载时立刻尝试一次预填 macro cache（不等 chat_changed）
 // 用户 F5 时如果已经在会话里，chat_changed 不会再触发，但 macro cache 仍需预填
 setTimeout(_prefillMvuMacroCache, 2000);
 setTimeout(_prefillMvuMacroCache, 5000); // 再补一次，防 TavernHelper 加载延迟

 L.info('Coordinator + SessionGate + NotificationCenter v1.1 已挂载');
})();


// ============================================================
// ESM export — 桥接 window.CFS4.* 到 ES module 命名空间
// 上面 IIFE 同步执行完毕后 window.CFS4.* 三对象已就位
// ============================================================

export const SessionGate = window.CFS4.SessionGate;
export const Coordinator = window.CFS4.Coordinator;
export const NotificationCenter = window.CFS4.NotificationCenter;

console.log('[CFS-Suite/kernel] 微内核 ESM bridge: SessionGate/Coordinator/NotificationCenter 已 export');
