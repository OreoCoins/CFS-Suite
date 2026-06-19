/**
 * CFS-Suite · core/real_takeover.js
 *
 * 从 CFS v4.x（L5636-6508）整段迁移 — Real Takeover 方案 A 实施
 *
 * 把 dry-run 阶段算出的 delta + BATCH 真正塞进 prompt（generate_before_combine_prompts 钩）。
 * managed MVU entry 锁定 + bootstrapTakeover + autoBootstrap。
 *
 * 依赖：injection_strategy.js + fallback_strategy.js
 */
import { polyfilledApis as _r } from '../compat/tavern_helper_polyfill.js';
import './statdata_engine.js'; import './schema_layer.js'; import './path_registry.js';
import './diff_engine.js'; import './injection_strategy.js'; import './fallback_strategy.js';
void _r;

/* ==========================================================
 * CFS v4.x: Real Takeover (方案 A 实施)
 *
 * 把 dry-run 阶段算出的 delta + BATCH，真正塞进 prompt。
 *
 * 接管机制（方案 A — worldbook 层动态 entry 替换）：
 * 1. 找到原 MVU stat_data 渲染 entry (含 {{format_message_variable::stat_data}})
 * 2. 创建 v4.x 自管动态 entry (comment 前缀 [CFS4_DYNAMIC|injection], PSIS 已豁免)
 * 3. 钩 generate_before_combine_prompts 抢跑（v3.1.7 同钩点，多 listener 并存）
 * - 算 generateInjection_v61 输出
 * - 写到 dynamic entry 的 content (TavernHelper.setLorebookEntries)
 * - 确保原 mvu entry 被 disable
 * 4. 跟 FallbackStrategy 状态机绑定：
 * - mode='v4_full' → 启用接管 (dynamic enabled + mvu disabled)
 * - mode='mvu_fallback' → 还原 (dynamic disabled + mvu enabled)
 * - mode='v4_degraded' → 同 mvu_fallback (自动降级触发)
 *
 * 跟 EWC autoSwitch 共存：
 * EWC 在 generation_started 时跑 autoSwitch（可能 re-enable mvu entry）
 * v4.x 在 generate_before_combine_prompts 时跑（EWC 之后），再次确认 disable
 *
 * 安全开关：
 * 默认 FallbackStrategy.mode='mvu_fallback' → 接管完全不生效
 * 用户必须显式调 recoverToV4() 才切到 v4_full → 接管启动
 * 任何 applyInjection 失败 → emit cfs_injection_failed → HealthMonitor 自动降级
 * ==========================================================*/
(function () {
 'use strict';

 var _GLOBAL = (typeof window !== 'undefined' && window.parent) || (typeof window !== 'undefined' ? window : null);
 if (!_GLOBAL || !_GLOBAL.CFS4 || !_GLOBAL.CFS4._loaded) {
 console.warn('[CFS v4.x] CFS4 not initialized, abort');
 return;
 }
 if (_GLOBAL.CFS4.InjectionStrategy && _GLOBAL.CFS4.InjectionStrategy.applyInjection) {
 console.warn('[CFS v4.x] applyInjection 已加载，skip');
 return;
 }
 if (!_GLOBAL.CFS4.FallbackStrategy || !_GLOBAL.CFS4.SchemaFrozenLayer) {
 console.warn('[CFS v4.x] 依赖未就绪，abort');
 return;
 }

 var CFS4 = _GLOBAL.CFS4;
 var L = CFS4.log;
 var SFL = CFS4.SchemaFrozenLayer;
 var FS = CFS4.FallbackStrategy;
 var IS = CFS4.InjectionStrategy;

 // ===== 常量 =====
 var DYNAMIC_ENTRY_COMMENT = '[CFS4_DYNAMIC|injection] CFS v4.x 自管 - 每轮自动更新 - 勿手动编辑';
 var MANAGED_MVU_ENTRIES_KEY = 'cfs_v4_managed_mvu_entries';
 var MVU_RENDER_MARKERS = [
 // 经典 macro 形式
 '{{format_message_variable::stat_data}}',
 '{{format_message_variable',
 'format_message_variable::stat_data',
 // hotfix v2.7：EJS 模板形式（含 getvar('stat_data') 调用 / status_current_variables 标签）
 "getvar('stat_data')",
 'getvar("stat_data")',
 'getvar(`stat_data`)',
 '<status_current_variables>',
 '</status_current_variables>'
 ];

 // ===== 内部 state =====
 var _managedMvuUids = []; // 用户锁定的 mvu rendering entry uids
 var _dynamicEntryUid = null; // v4.x 动态 entry uid (缓存)
 var _lastInjection = null; // 最近一次注入快照
 var _injectionCount = 0;
 var _failureCount = 0;
 var _MAX_FAILURES_BEFORE_DEGRADE = 3;

 // ===== TavernHelper helpers =====
 function _resolveTH() {
 if (typeof TavernHelper !== 'undefined') return TavernHelper;
 if (_GLOBAL && _GLOBAL.TavernHelper) return _GLOBAL.TavernHelper;
 return null;
 }

 async function _getEntries(wb) {
 var TH = _resolveTH();
 if (!TH) throw new Error('TavernHelper 不可用');
 return await TH.getLorebookEntries(wb);
 }

 async function _setEntries(wb, patches) {
 var TH = _resolveTH();
 if (!TH) throw new Error('TavernHelper 不可用');
 return await TH.setLorebookEntries(wb, patches);
 }

 // ===== Step 1: 列出候选 MVU rendering entries =====
 async function listCandidateMvuEntries() {
 var wb = await SFL.getActiveWorldbook();
 var entries = await _getEntries(wb);
 var candidates = [];
 for (var i = 0; i < entries.length; i++) {
 var e = entries[i];
 // 跳过 v4.x 自管的 entry
 if (e.comment && e.comment.indexOf('[CFS4_') === 0) continue;
 var c = e.content || '';
 var hitMarkers = MVU_RENDER_MARKERS.filter(function (m) { return c.indexOf(m) >= 0; });
 if (hitMarkers.length > 0) {
 candidates.push({
 uid: e.uid,
 comment: (e.comment || '').slice(0, 80),
 enabled: e.enabled,
 position: e.position,
 contentLen: c.length,
 hitMarkers: hitMarkers
 });
 }
 }
 return { worldbook: wb, candidates: candidates };
 }

 // ===== Step 2: 锁定 / 查询 managed mvu entries =====
 function _persistManagedUids() {
 try {
 if (typeof updateVariablesWith !== 'function') return false;
 updateVariablesWith(function (vars) {
 if (!vars || typeof vars !== 'object') vars = {};
 vars[MANAGED_MVU_ENTRIES_KEY] = _managedMvuUids;
 return vars;
 }, { type: 'script', script_id: getScriptId() });
 return true;
 } catch (e) { L.warn('persistManagedUids failed', e); return false; }
 }

 function _loadManagedUids() {
 try {
 if (typeof getVariables !== 'function') return [];
 var sv = getVariables({ type: 'script', script_id: getScriptId() });
 return (sv && Array.isArray(sv[MANAGED_MVU_ENTRIES_KEY])) ? sv[MANAGED_MVU_ENTRIES_KEY] : [];
 } catch (e) { return []; }
 }

 function setManagedMvuEntries(uids) {
 if (!Array.isArray(uids)) throw new Error('setManagedMvuEntries: uids 必须是数组');
 _managedMvuUids = uids.slice();
 _persistManagedUids();
 L.info('锁定 managed MVU entries:', _managedMvuUids);
 return _managedMvuUids;
 }

 function getManagedMvuEntries() {
 return _managedMvuUids.slice();
 }

 // ===== Step 3: 确保 v4.x 动态 entry 存在 =====
 async function ensureDynamicEntry() {
 var wb = await SFL.getActiveWorldbook();
 var entries = await _getEntries(wb);
 var existing = entries.find(function (e) {
 return e.comment && e.comment.indexOf('[CFS4_DYNAMIC|injection]') === 0;
 });
 if (existing) {
 _dynamicEntryUid = existing.uid;
 // hotfix v2.8: reuse 路径校验位置，若历史版本（v2.2-v2.7）创建时写错位置（pos=0 进 prefix），立刻 update 修正
 // 字符串别名 normalize：'at_depth_as_user' / 'at_depth' → 4
 var posStr = existing.position;
 var actualPosNum = (typeof posStr === 'number') ? posStr
 : (posStr === 'at_depth_as_user' || posStr === 'at_depth') ? 4
 : (posStr === 'before_character_definition') ? 0
 : (posStr === 'after_character_definition') ? 1
 : -1;
 var needFix = (actualPosNum !== 4);
 if (needFix) {
 L.warn('reuse DYNAMIC entry uid=' + existing.uid + ' 位置异常 (raw=' + JSON.stringify(posStr) + ' actualPosNum=' + actualPosNum + ')，触发 update 修正');
 try {
 var fixPayload = {
 uid: existing.uid,
 position: 'at_depth_as_user',  // 字符串别名
 role: 0,
 depth: 0,
 keys: (Array.isArray(existing.keys) && existing.keys.length > 0) ? existing.keys : ['_cfs4_managed', '_cfs4_dynamic', '_cfs4_position_locked'],
 extensions: Object.assign({}, existing.extensions || {}, { cfs: Object.assign({}, (existing.extensions && existing.extensions.cfs) || {}, { managed: true, dynamic: true, expected_position: 4, expected_role: 1 }) })
 };
 await _setEntries(wb, [fixPayload]);
 L.info('reuse DYNAMIC entry uid=' + existing.uid + ' 位置已修正');
 } catch (eFix) {
 L.warn('reuse DYNAMIC entry 位置修正失败', eFix);
 }
 } else {
 L.debug('dynamic entry 已存在 uid=' + existing.uid + ' 位置正确');
 }
 return { entry: existing, worldbook: wb, action: 'reuse' };
 }
 // 创建（三档 fallback 同 SFL.writeSchema）
 // hotfix v2.8（字符串别名反转）：
 //   v2.2 改成数字 position=4 + role=1 是错的 —— 实测 TavernHelper 不接受数字 4，
 //   写入后落到默认值 pos=int(0)（before_char_def，prefix 区！）破坏 cache。
 //   v2.8 改回字符串 'at_depth_as_user' —— TavernHelper 接受字符串别名，
 //   写入后自动翻译为 pos=4 + role=1（与缄默之秋历史版本一致，已验证 95-97% 命中率）。
 var payload = {
 comment: DYNAMIC_ENTRY_COMMENT,
 content: '',
 enabled: true,
 constant: true,
 type: 'constant',
 position: 'at_depth_as_user',  // 字符串别名 — TavernHelper 翻译为 pos=4 + role=1
 role: 0,                        // 给 0 默认，TavernHelper 'at_depth_as_user' 模式下会自动覆盖为 role=user
 depth: 0,                       // 紧贴最新 user msg
 order: 100,
 keys: ['_cfs4_managed', '_cfs4_dynamic', '_cfs4_position_locked'],
 extensions: { cfs: { managed: true, dynamic: true, expected_position: 4, expected_role: 1 } }
 };
 var TH = _resolveTH();
 var created = false;
 var errs = [];
 if (typeof TH.createLorebookEntries === 'function') {
 try {
 var res = await TH.createLorebookEntries(wb, [payload]);
 if (Array.isArray(res) && res.length > 0) {
 _dynamicEntryUid = (res[0] && res[0].uid != null) ? res[0].uid : (typeof res[0] === 'number' ? res[0] : null);
 }
 created = true;
 } catch (e) { errs.push('createLorebookEntries: ' + e.message); }
 }
 if (!created && typeof TH.createLorebookEntry === 'function') {
 try {
 var res2 = await TH.createLorebookEntry(wb, payload);
 if (res2 && res2.uid != null) _dynamicEntryUid = res2.uid;
 created = true;
 } catch (e) { errs.push('createLorebookEntry: ' + e.message); }
 }
 if (!created) {
 try { await _setEntries(wb, [payload]); created = true; }
 catch (e) { errs.push('setLorebookEntries: ' + e.message); }
 }
 if (!created) throw new Error('ensureDynamicEntry 失败: ' + errs.join(' | '));
 // 兜底反查 uid
 if (_dynamicEntryUid == null) {
 var refetched = await _getEntries(wb);
 var found = refetched.find(function (e) {
 return e.comment && e.comment.indexOf('[CFS4_DYNAMIC|injection]') === 0;
 });
 if (found) _dynamicEntryUid = found.uid;
 }
 L.info('dynamic entry 创建成功 uid=' + _dynamicEntryUid);
 return { entry: { uid: _dynamicEntryUid }, worldbook: wb, action: 'create' };
 }

 // ===== Step 4: 真接管 — 更新 dynamic entry content =====
 async function applyInjection(opts) {
 opts = opts || {};
 // === SessionGate 短路（spec v2）===
 var gate = (_GLOBAL && _GLOBAL.CFS4 && _GLOBAL.CFS4.Coordinator && typeof _GLOBAL.CFS4.Coordinator.gateGuard === 'function')
 ? _GLOBAL.CFS4.Coordinator.gateGuard(opts) : null;
 if (gate) {
 L.debug('applyInjection: 启动门控未放行 phase=' + gate.phase + '，跳过');
 return { skipped: true, reason: 'session_not_ready', phase: gate.phase };
 }
 var mode = FS.getCurrentMode();
 if (mode !== 'v4_full' && !opts.force) {
 L.debug('applyInjection: mode=' + mode + ' 跳过 (用 {force:true} 强制)');
 return { skipped: true, mode: mode };
 }

 try {
 // 1. 拿当前 stat_data
 var mvu = (typeof Mvu !== 'undefined' && Mvu) || (_GLOBAL && _GLOBAL.Mvu) || null;
 if (!mvu || !mvu.getMvuData) throw new Error('Mvu 不可用');
 var mvuData = await mvu.getMvuData({ type: 'message', message_id: -1 });
 if (!mvuData || !mvuData.stat_data) throw new Error('当前消息无 stat_data');
 var sd = mvuData.stat_data;

 // 2. 找活跃 schema_ref（最多 path 的）
 var reg = CFS4.PathRegistry.getAll();
 var counts = {};
 Object.keys(reg).forEach(function (pid) {
 var r = reg[pid].schema_ref;
 if (r) counts[r] = (counts[r] || 0) + 1;
 });
 var activeSchema = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
 if (!activeSchema) throw new Error('PathRegistry 内无活跃 schema (autoRegister 先跑)');

 // 3. 调 generateInjection_v61
 var inj = await IS.generateInjection({
 schema_id: activeSchema,
 new_stat_data: sd,
 round: Date.now()
 });

 // 4. 拼装 entry content
 var contentParts = [];
 if (inj.delta_layer) contentParts.push(inj.delta_layer);
 if (inj.presence_tokens) contentParts.push(inj.presence_tokens);
 var finalContent = contentParts.join('\n');
 // 容错：空内容时写一个简短占位避免空 entry 异常
 if (!finalContent) finalContent = '<!-- CFS v4.x: stat_data 跨轮稳定，无 delta -->';

 // 5. ensure dynamic entry exists + 更新 content
 await ensureDynamicEntry();
 var wb = await SFL.getActiveWorldbook();
 await _setEntries(wb, [{
 uid: _dynamicEntryUid,
 content: finalContent,
 enabled: true,
 comment: DYNAMIC_ENTRY_COMMENT // 重申 comment 防 EWC 改
 }]);

 // 6. 强制 disable 所有 managed MVU rendering entries (追加 keys 标记)
 var disabledCount = 0;
 if (_managedMvuUids.length > 0) {
 try {
 var entriesNow = await _getEntries(wb);
 var disablePatches = _managedMvuUids.map(function (uid) {
 var existing = entriesNow.find(function (e) { return e.uid === uid; });
 var currentKeys = (existing && Array.isArray(existing.keys)) ? existing.keys.slice() : [];
 if (currentKeys.indexOf('_cfs4_managed_mvu') < 0) currentKeys.push('_cfs4_managed_mvu');
 return { uid: uid, enabled: false, keys: currentKeys };
 });
 await _setEntries(wb, disablePatches);
 disabledCount = _managedMvuUids.length;
 } catch (e) {
 L.warn('disable mvu entries 部分失败', e);
 }
 }

 _injectionCount++;
 _failureCount = 0;
 _lastInjection = {
 at: new Date().toISOString(),
 schema_id: activeSchema,
 stats: inj.stats,
 injected_chars: finalContent.length,
 mvu_disabled_count: disabledCount
 };

 CFS4.emit(CFS4.EVENTS.INJECTION_APPLIED, {
 mode: 'v4_full_real',
 schema_id: activeSchema,
 stats: inj.stats,
 injected_chars: finalContent.length
 });

 L.info('applyInjection #' + _injectionCount + ': ' + finalContent.length + ' 字符注入到 dynamic entry uid=' + _dynamicEntryUid
 + ' (delta=' + inj.stats.delta_field_count + ' batch=' + inj.stats.batch_stable_field_count
 + ' frozen_silent=' + inj.stats.frozen_silent_field_count + ' mvu_disabled=' + disabledCount + ')');

 return {
 skipped: false,
 success: true,
 injected_chars: finalContent.length,
 stats: inj.stats,
 mvu_disabled_count: disabledCount
 };

 } catch (e) {
 _failureCount++;
 L.error('applyInjection #' + _failureCount + ' 失败', e);
 CFS4.emit('cfs_injection_failed', { error: e.message, count: _failureCount });

 // 连续 N 次失败 → HealthMonitor 会自动触发 degradeToMvu
 // (CFS4.HealthMonitor 订阅了 cfs_injection_failed，阈值 3)
 // 但本地也加一道保险，连续 N 次直接调
 if (_failureCount >= _MAX_FAILURES_BEFORE_DEGRADE) {
 L.warn('连续 ' + _failureCount + ' 次失败，触发自动降级');
 try {
 await restoreMvuRendering({ reason: 'applyInjection 连续失败 ' + _failureCount + ' 次' });
 } catch (_e2) {}
 }
 return { skipped: false, success: false, error: e.message };
 }
 }

 // ===== Step 5: 还原 MVU 渲染 =====
 async function restoreMvuRendering(opts) {
 opts = opts || {};
 // === SessionGate 短路（spec v2）：启动期不允许触发 restore，避免 _setHealth 联动 ===
 var gate = (_GLOBAL && _GLOBAL.CFS4 && _GLOBAL.CFS4.Coordinator && typeof _GLOBAL.CFS4.Coordinator.gateGuard === 'function')
 ? _GLOBAL.CFS4.Coordinator.gateGuard(opts) : null;
 if (gate) {
 L.debug('restoreMvuRendering: 启动门控未放行 phase=' + gate.phase + '，跳过');
 return { skipped: true, reason: 'session_not_ready', phase: gate.phase };
 }
 L.info('restoreMvuRendering: ' + (opts.reason || '手动'));
 try {
 var wb = await SFL.getActiveWorldbook();
 var patches = [];

 // 1. enable 所有 managed mvu entries (移除 _cfs4_managed_mvu key)
 if (_managedMvuUids.length > 0) {
 var entriesNow = await _getEntries(wb);
 _managedMvuUids.forEach(function (uid) {
 var existing = entriesNow.find(function (e) { return e.uid === uid; });
 var currentKeys = (existing && Array.isArray(existing.keys))
 ? existing.keys.filter(function (k) { return k !== '_cfs4_managed_mvu'; })
 : [];
 patches.push({ uid: uid, enabled: true, keys: currentKeys });
 });
 }
 // 2. disable v4.x dynamic entry
 if (_dynamicEntryUid != null) {
 patches.push({ uid: _dynamicEntryUid, enabled: false });
 }
 if (patches.length > 0) {
 await _setEntries(wb, patches);
 }

 CFS4.emit('cfs_mvu_rendering_restored', {
 mvu_enabled_count: _managedMvuUids.length,
 dynamic_disabled: _dynamicEntryUid != null
 });

 L.info('restoreMvuRendering 完成: ' + _managedMvuUids.length + ' 条 mvu entry 重启用, dynamic entry disabled');
 return { success: true, restored: _managedMvuUids.length };
 } catch (e) {
 L.error('restoreMvuRendering failed', e);
 return { success: false, error: e.message };
 }
 }

 // ===== Step 6: 模拟接管（不真改 worldbook，给用户验真用）=====
 async function simulateInjection() {
 try {
 var mvu = (typeof Mvu !== 'undefined' && Mvu) || (_GLOBAL && _GLOBAL.Mvu) || null;
 if (!mvu || !mvu.getMvuData) throw new Error('Mvu 不可用');
 var mvuData = await mvu.getMvuData({ type: 'message', message_id: -1 });
 if (!mvuData || !mvuData.stat_data) throw new Error('当前消息无 stat_data');
 var sd = mvuData.stat_data;

 var reg = CFS4.PathRegistry.getAll();
 var counts = {};
 Object.keys(reg).forEach(function (pid) {
 var r = reg[pid].schema_ref;
 if (r) counts[r] = (counts[r] || 0) + 1;
 });
 var activeSchema = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
 if (!activeSchema) {
 return { error: 'PathRegistry 无活跃 schema (跑 autoRegister 先)' };
 }

 var inj = await IS.generateInjection({
 schema_id: activeSchema,
 new_stat_data: sd,
 round: Date.now()
 });

 var contentParts = [];
 if (inj.delta_layer) contentParts.push(inj.delta_layer);
 if (inj.presence_tokens) contentParts.push(inj.presence_tokens);
 var finalContent = contentParts.join('\n');

 return {
 active_schema: activeSchema,
 stats: inj.stats,
 injected_chars: finalContent.length,
 content_preview: finalContent.slice(0, 400) + (finalContent.length > 400 ? '...' : ''),
 managed_mvu_count: _managedMvuUids.length,
 ready_for_takeover: _managedMvuUids.length > 0 && finalContent.length > 0,
 notes: _managedMvuUids.length === 0
 ? '⚠️ 未锁定 managed MVU entries，接管不会 disable 原渲染 → 体积反而增加'
 : '✅ 配置就绪，可以 recoverToV4() 真切'
 };
 } catch (e) {
 return { error: e.message };
 }
 }

 // ===== Step 7: 钩 generate_before_combine_prompts =====
 // 取代 / 6.1 的 dry-run 钩 —— 实际改 worldbook entry content
 async function _onGenerateBeforeCombineRealTakeover() {
 // hotfix v2.4：真接管前先同步 audit，确保 entry 位置正确再让 applyInjection 改 worldbook
 // 这是"慢一步修复"的根本解 — 把 audit 从异步事件链路提升为 prompt 拼装的前置钩
 try {
 var _co = _GLOBAL && _GLOBAL.CFS4 && _GLOBAL.CFS4.Coordinator;
 if (_co && typeof _co.auditEntries === 'function') {
 var _auditRes = await _co.auditEntries({ force: true });
 if (_auditRes && _auditRes.fixed > 0) {
 L.warn('hotfix v2.4 [Real Takeover]: 拼 prompt 前同步修了 ' + _auditRes.fixed + ' 条 entry');
 }
 }
 } catch (eAudit) { L.warn('audit before real takeover failed', eAudit); }
 try {
 await applyInjection({});
 } catch (e) {
 L.error('钩 generate_before_combine_prompts 异常', e);
 }
 }

 // hotfix: 钩注册移入 app_ready
 // 这是真接管闭环的关键 — 没有这个钩，dynamic entry content 不会每轮更新
 var _realTakeoverHookRegistered = false;
 function _registerRealTakeoverHook() {
 if (_realTakeoverHookRegistered) return;
 try {
 if (typeof eventOn === 'function') {
 eventOn('generate_before_combine_prompts', _onGenerateBeforeCombineRealTakeover);
 _realTakeoverHookRegistered = true;
 L.info('generate_before_combine_prompts 钩已注册 - 真接管闭环成立');
 }
 } catch (e) { L.warn('钩注册失败', e); }
 }
 try { eventOnce('app_ready', _registerRealTakeoverHook); }
 catch (e) { setTimeout(_registerRealTakeoverHook, 2000); }
 setTimeout(_registerRealTakeoverHook, 2800);

 // ===== Step 8: 订阅 FallbackStrategy 事件 (hotfix: 移入 app_ready) =====
 var _fallbackEventsSubscribed = false;
 function _subscribeFallbackEvents() {
 if (_fallbackEventsSubscribed) return;
 try {
 if (typeof eventOn === 'function') {
 eventOn('cfs_v4_recovered', async function (payload) {
 // === SessionGate 短路（spec v2）===
 var g1 = (_GLOBAL && _GLOBAL.CFS4 && _GLOBAL.CFS4.Coordinator && typeof _GLOBAL.CFS4.Coordinator.gateGuard === 'function')
 ? _GLOBAL.CFS4.Coordinator.gateGuard() : null;
 if (g1) { L.debug('cfs_v4_recovered: 启动门控未放行 phase=' + g1.phase + '，跳过'); return; }
 L.info('收到 cfs_v4_recovered，准备接管', payload);
 try { await ensureDynamicEntry(); }
 catch (e) { L.warn('v4_recovered prep failed', e); }
 });
 eventOn('cfs_v4_degraded', async function (payload) {
 // === SessionGate 短路（spec v2）===
 var g2 = (_GLOBAL && _GLOBAL.CFS4 && _GLOBAL.CFS4.Coordinator && typeof _GLOBAL.CFS4.Coordinator.gateGuard === 'function')
 ? _GLOBAL.CFS4.Coordinator.gateGuard() : null;
 if (g2) { L.debug('cfs_v4_degraded: 启动门控未放行 phase=' + g2.phase + '，跳过'); return; }
 // 区分 health=degraded (1 次故障警告) vs health=fallback (真降级)
 // 只在真降级时还原 MVU 渲染，避免单次失败错杀 dynamic entry
 if (payload && payload.to_health && payload.to_health !== 'fallback') {
 L.debug('cfs_v4_degraded(to_health=' + payload.to_health + ') 仅 health 警告，不触发 restore');
 return;
 }
 L.info('收到 cfs_v4_degraded(fallback)，还原 MVU 渲染', payload);
 try { await restoreMvuRendering({ reason: 'FallbackStrategy 触发降级: ' + (payload.reason || '') }); }
 catch (e) { L.warn('v4_degraded restore failed', e); }
 });
 _fallbackEventsSubscribed = true;
 L.info('cfs_v4_recovered/degraded 订阅已就位');
 }
 } catch (e) { L.warn('订阅 fallback 事件失败', e); }
 }
 try { eventOnce('app_ready', _subscribeFallbackEvents); }
 catch (e) { setTimeout(_subscribeFallbackEvents, 2000); }
 setTimeout(_subscribeFallbackEvents, 2800);

 // ===== Step 9: boot — 双源恢复 + 自动 autoRegister + 自动接管 (+ ) =====
 var _bootstrapDone = false;
 async function _bootRestore() {
 // 1. managed_uids 双源恢复
 var fromVars = _loadManagedUids();
 if (fromVars.length > 0 && _managedMvuUids.length === 0) {
 _managedMvuUids = fromVars;
 L.info('boot: 从 script vars 恢复 ' + fromVars.length + ' 条 managed MVU uid');
 }
 // hotfix: keys 扫描失败不阻塞 autoBootstrap (原 `if (!wb) return` 跳出整个 _bootRestore 导致 autoBootstrap 永远不跑)
 try {
 var wb = await SFL.getActiveWorldbook().catch(function () { return null; });
 if (wb) {
 var entries = await _getEntries(wb).catch(function () { return []; });
 var fromKeys = entries
 .filter(function (e) { return Array.isArray(e.keys) && e.keys.indexOf('_cfs4_managed_mvu') >= 0; })
 .map(function (e) { return e.uid; });
 if (fromKeys.length > 0) {
 var merged = _managedMvuUids.slice();
 fromKeys.forEach(function (uid) { if (merged.indexOf(uid) < 0) merged.push(uid); });
 if (merged.length !== _managedMvuUids.length) {
 _managedMvuUids = merged;
 _persistManagedUids();
 console.warn('[CFS v4.x] boot: 从 worldbook keys 扫描恢复 ' + fromKeys.length + ' 条 (合并后总 ' + _managedMvuUids.length + ' 条)');
 }
 }
 } else {
 console.warn('[CFS v4.x] boot: worldbook 暂不可用，跳过 keys 扫描 (autoBootstrap 仍会跑)');
 }
 } catch (e) { console.warn('[CFS v4.x] boot keys 扫描失败 (不阻塞 autoBootstrap)', e); }

 // boot 自动 bootstrap — done 修复 (spec v2：自我重试已删除，由 Coordinator 看门狗承担)
 if (_bootstrapDone) return { success: true, already: true };
 try {
 var rep = await _autoBootstrap();
 if (rep && rep.success) {
 _bootstrapDone = true;
 console.warn('[CFS v4.x] ✅ autoBootstrap 成功');
 return rep;
 }
 var lastStep = rep && rep.steps && rep.steps[rep.steps.length - 1];
 var why = lastStep ? (lastStep.error || (lastStep.skipped ? JSON.stringify(lastStep.skipped) : 'unknown')) : 'no_steps';
 console.warn('[CFS v4.x] autoBootstrap 本轮未成功: ' + why);
 return rep || { success: false, reason: 'unknown' };
 } catch (e) {
 console.warn('[CFS v4.x] boot autoBootstrap failed', e);
 return { success: false, reason: 'crashed: ' + (e && e.message) };
 }
 }

 // Mvu 四层 fallback (跟 _resolveMvu 一致)
 function _resolveMvu() {
 if (typeof Mvu !== 'undefined' && Mvu && Mvu.getMvuData) return Mvu;
 if (_GLOBAL && _GLOBAL.Mvu && _GLOBAL.Mvu.getMvuData) return _GLOBAL.Mvu;
 if (typeof window !== 'undefined' && window.Mvu && window.Mvu.getMvuData) return window.Mvu;
 if (typeof window !== 'undefined' && window.parent && window.parent.Mvu && window.parent.Mvu.getMvuData) return window.parent.Mvu;
 return null;
 }

 // worldbook 状态检测 — 看 v4.x 是否已经接管过 (跨 F5 自描述识别)
 async function _detectWorldbookTakeoverState() {
 var detection = { has_dynamic: false, has_schema: false, dynamic_enabled: false, dynamic_uid: null,
 managed_mvu_uids: [], any_mvu_disabled: false, mvu_render_uids: [] };
 try {
 var wb = await SFL.getActiveWorldbook().catch(function () { return null; });
 if (!wb) return detection;
 var entries = await _getEntries(wb).catch(function () { return []; });
 var dyn = entries.find(function (e) {
 return e.comment && e.comment.indexOf('[CFS4_DYNAMIC|injection]') === 0;
 });
 if (dyn) {
 detection.has_dynamic = true;
 detection.dynamic_enabled = dyn.enabled;
 detection.dynamic_uid = dyn.uid;
 }
 // hotfix v2.7: 单独检测 SCHEMA 存在性，供 audit 校验"SCHEMA 在但 DYNAMIC 缺"用
 detection.has_schema = entries.some(function (e) {
 return e.comment && e.comment.indexOf('[CFS4_SCHEMA|') === 0;
 });
 // 找 keys 含 _cfs4_managed_mvu (标记)
 detection.managed_mvu_uids = entries
 .filter(function (e) { return Array.isArray(e.keys) && e.keys.indexOf('_cfs4_managed_mvu') >= 0; })
 .map(function (e) { return e.uid; });
 // 内部辅助：判断 content 是否是 MVU 渲染（含任一 marker，含 EJS 模板形式）
 function _isMvuRenderContent(content) {
 if (typeof content !== 'string') return false;
 for (var k = 0; k < MVU_RENDER_MARKERS.length; k++) {
 if (content.indexOf(MVU_RENDER_MARKERS[k]) >= 0) return true;
 }
 return false;
 }
 // 兜底（原语义保留）：找含 stat_data marker 但被 disable 的 entry
 detection.any_mvu_disabled = entries.some(function (e) {
 if (e.enabled === false) return _isMvuRenderContent(e.content);
 return false;
 });
 // hotfix v2.7: 列出所有 MVU 渲染 entry（无论 enabled 与否，但排除 CFS 自管）
 // bootstrapTakeover 用它来在 managed_mvu_uids 空时兜底锁定（识别 EJS 模板）
 detection.mvu_render_uids = entries
 .filter(function (e) {
 if (e.comment && e.comment.indexOf('[CFS4_') === 0) return false; // 排除 CFS 自管
 return _isMvuRenderContent(e.content);
 })
 .map(function (e) { return { uid: e.uid, enabled: e.enabled !== false, comment: (e.comment || '').slice(0, 60) }; });
 } catch (e) {}
 return detection;
 }

 // 公开 + 可重入的 bootstrapTakeover API
 // 用户 F5 后任何时候可以调一次救回，自动 boot 也调它
 async function bootstrapTakeover(opts) {
 opts = opts || {};
 var force = opts.force === true;
 // === SessionGate 短路（spec v2）：force=true 时绕过，这是手动救回的唯一入口 ===
 var gate = (_GLOBAL && _GLOBAL.CFS4 && _GLOBAL.CFS4.Coordinator && typeof _GLOBAL.CFS4.Coordinator.gateGuard === 'function')
 ? _GLOBAL.CFS4.Coordinator.gateGuard(opts) : null;
 if (gate) {
 console.warn('[CFS v4.x] bootstrapTakeover: 启动门控未放行 phase=' + gate.phase + '，跳过（用 force:true 绕过）');
 return { success: false, skipped: true, reason: 'session_not_ready', phase: gate.phase, steps: [] };
 }
 console.warn('[CFS v4.x] 🚀 bootstrapTakeover 开始 (force=' + force + ')');

 var report = { steps: [], success: false };

 // === Step A: PathRegistry 空 → 自动 autoRegister ===
 try {
 var prCount = Object.keys(CFS4.PathRegistry.getAll()).length;
 if (prCount === 0) {
 var mvu = _resolveMvu();
 if (!mvu) {
 console.warn('[CFS v4.x] bootstrapTakeover: Mvu 不可用 (四层都没找到)，无法 autoRegister');
 report.steps.push({ step: 'autoRegister', skipped: 'Mvu 不可用' });
 return report;
 }
 var mvuData = await Promise.resolve(mvu.getMvuData({ type: 'message', message_id: -1 })).catch(function (e) {
 console.warn('[CFS v4.x] getMvuData 失败', e); return null;
 });
 if (!mvuData || !mvuData.stat_data) {
 console.warn('[CFS v4.x] bootstrapTakeover: 当前消息无 stat_data，跳过');
 report.steps.push({ step: 'autoRegister', skipped: 'stat_data 空' });
 return report;
 }
 console.warn('[CFS v4.x] bootstrapTakeover: PathRegistry 空 → autoRegister...');
 var auto = await CFS4.InjectionStrategy.autoRegisterFromStatData({ default_class: 'volatile' });
 report.steps.push({ step: 'autoRegister', count: auto.count, schema: auto.schema_id });
 console.warn('[CFS v4.x] bootstrapTakeover: 注册 ' + auto.count + ' 条 path');
 // 启发式打 stable (扩展关键词)
 var allPaths = Object.keys(CFS4.PathRegistry.getAll());
 var stableLike = allPaths.filter(function (pid) {
 var p = CFS4.PathRegistry.getPath(pid);
 return p && /(_max|国家|character_name|世界阶段|nationality|camp|身份|性别|年龄|出生|籍贯)/.test(p.path);
 });
 if (stableLike.length > 0) {
 CFS4.InjectionStrategy.bulkSetStabilityClass(stableLike, 'stable');
 report.steps.push({ step: 'stable', count: stableLike.length });
 console.warn('[CFS v4.x] bootstrapTakeover: 打 stable ' + stableLike.length + ' 条');
 }
 } else {
 report.steps.push({ step: 'autoRegister', skipped: 'PathRegistry 已有 ' + prCount + ' 条' });
 }
 } catch (e) {
 console.warn('[CFS v4.x] bootstrapTakeover autoRegister failed', e);
 report.steps.push({ step: 'autoRegister', error: e.message });
 return report;
 }

 // === Step B: worldbook 状态检测 → 反推 managed_uids ===
 var detection = await _detectWorldbookTakeoverState();
 report.steps.push({ step: 'detect', detection: detection });
 console.warn('[CFS v4.x] bootstrapTakeover detection:', detection);

 if (detection.managed_mvu_uids.length > 0) {
 // keys 标记反推 managed_uids
 setManagedMvuEntries(detection.managed_mvu_uids);
 console.warn('[CFS v4.x] bootstrapTakeover: 从 worldbook keys 反推 managed_uids = ' + JSON.stringify(detection.managed_mvu_uids));
 } else if (_managedMvuUids.length === 0 && detection.mvu_render_uids && detection.mvu_render_uids.length > 0) {
 // hotfix v2.7: 通过 markers 识别到 MVU 渲染 entry（含 EJS 模板形式），无论 enabled 与否都自动锁定
 // 覆盖场景：1) WM 删了 keys 标记 2) 卡用 EJS 模板而非 macro 3) 用户手动开启被 WM 误杀的 entry
 var uidsV27 = detection.mvu_render_uids.map(function (e) { return e.uid; });
 setManagedMvuEntries(uidsV27);
 console.warn('[CFS v4.x] bootstrapTakeover: 通过 MVU_RENDER_MARKERS 识别 ' + uidsV27.length + ' 条渲染 entry，自动锁定 ' + JSON.stringify(uidsV27)
 + ' (含 ' + detection.mvu_render_uids.filter(function(e){return e.enabled;}).length + ' 条 enabled)');
 report.steps.push({ step: 'auto_lock_managed_v27', uids: uidsV27, details: detection.mvu_render_uids });
 } else if (_managedMvuUids.length === 0 && detection.any_mvu_disabled) {
 // 兼容旧路径（detection.mvu_render_uids 应包含此情况，理论上不会进这里，保留兜底）
 var candidates = await listCandidateMvuEntries();
 var disabledCandidates = candidates.candidates.filter(function (c) { return !c.enabled; });
 if (disabledCandidates.length > 0) {
 var uids = disabledCandidates.map(function (c) { return c.uid; });
 setManagedMvuEntries(uids);
 console.warn('[CFS v4.x] bootstrapTakeover: [兼容路径] 发现 disabled mvu entry 但无 keys 标记，自动锁定 ' + JSON.stringify(uids));
 report.steps.push({ step: 'auto_lock_managed', uids: uids });
 }
 }

 // === Step C: mode 不是 v4_full → 自动恢复 (如果 worldbook 已是接管状态) ===
 var currentMode = CFS4.FallbackStrategy.getCurrentMode();
 var shouldTakeOver = detection.has_dynamic || _managedMvuUids.length > 0 || force;
 if (currentMode !== 'v4_full' && shouldTakeOver) {
 console.warn('[CFS v4.x] bootstrapTakeover: worldbook 已是接管状态 → 强制恢复 mode = v4_full');
 CFS4.HealthMonitor.resetCounts();
 CFS4.FallbackStrategy.recoverToV4({ force: true, reason: 'bootstrapTakeover 自动恢复' });
 report.steps.push({ step: 'recover_mode', from: currentMode, to: 'v4_full' });
 }

 // === Step D: applyInjection ===
 var modeNow = CFS4.FallbackStrategy.getCurrentMode();
 var prCountNow = Object.keys(CFS4.PathRegistry.getAll()).length;
 if (modeNow === 'v4_full' && _managedMvuUids.length > 0 && prCountNow > 0) {
 console.warn('[CFS v4.x] bootstrapTakeover: 触发 applyInjection...');
 var result = await applyInjection({});
 report.steps.push({ step: 'applyInjection', result: result });
 if (result && result.success) {
 console.warn('[CFS v4.x] 🎉 bootstrapTakeover 成功，注入 ' + result.injected_chars + ' 字符 (disable ' + result.mvu_disabled_count + ' 条 mvu entry)');
 report.success = true;
 // v4.9 SEM 被动扫描（5 秒延时，避免和接管事件抢 NC）
 try {
 setTimeout(function () {
 try {
 var _semNs = (_GLOBAL && _GLOBAL.CFS4 && _GLOBAL.CFS4.SEM);
 if (_semNs && typeof _semNs.passiveScan === 'function') _semNs.passiveScan();
 } catch (e) {}
 }, 5000);
 } catch (e) {}
 } else {
 console.warn('[CFS v4.x] bootstrapTakeover applyInjection 失败:', result && result.error);
 }
 } else {
 console.warn('[CFS v4.x] bootstrapTakeover: 不满足 apply 条件 (mode=' + modeNow + ' managed=' + _managedMvuUids.length + ' pr=' + prCountNow + ')');
 report.steps.push({ step: 'applyInjection', skipped: { mode: modeNow, managed: _managedMvuUids.length, pr: prCountNow } });
 }

 return report;
 }

 // /15 兼容名: _autoBootstrap 调 bootstrapTakeover (内部使用)
 async function _autoBootstrap() { return await bootstrapTakeover({}); }

 // ===== 改造点（spec v2）：_bootRestore 改为 Coordinator plugin =====
 // 旧：app_ready + 8 个 setTimeout 撒网 + 自我重试每 2s × 15 次（最多 24 + 15 次触发）
 // 新：注册为 Coordinator plugin（priority=20），由 SessionGate 放行 + 看门狗指数退避控制
 function _registerV4BootPlugin(retryLeft) {
 retryLeft = (retryLeft == null) ? 50 : retryLeft;
 try {
 if (_GLOBAL && _GLOBAL.CFS4 && _GLOBAL.CFS4.Coordinator && typeof _GLOBAL.CFS4.Coordinator.register === 'function') {
 _GLOBAL.CFS4.Coordinator.register({
 name: 'v4_bootstrap',
 priority: 20,
 onSessionReady: function (ctx) {
 var NC = (_GLOBAL.CFS4 && _GLOBAL.CFS4.NotificationCenter) || null;
 if (ctx && ctx.state === 'ready_no_mvu') {
 if (NC) NC.report('v4x', { ok: true, summary: '本卡未使用 MVU' });
 return { ok: true, summary: 'skipped (no_mvu_card)' };
 }
 return _bootRestore()
 .then(function (rep) {
 if (rep && rep.success) {
 var stepApply = rep.steps && rep.steps.find(function (s) { return s.step === 'applyInjection'; });
 var injectedChars = (stepApply && stepApply.result && stepApply.result.injected_chars) || 0;
 var mvuDisabled = (stepApply && stepApply.result && stepApply.result.mvu_disabled_count) || 0;
 if (NC) NC.report('v4x', { ok: true, summary: '注入 ' + injectedChars + ' 字符 / 接管 ' + mvuDisabled + ' 条 mvu entry' });
 return { ok: true, summary: '注入 ' + injectedChars + ' 字符' };
 }
 if (NC) NC.report('v4x', { ok: false, summary: 'bootstrap 未完成（详见控制台）' });
 return { ok: false, summary: 'bootstrap incomplete' };
 })
 .catch(function (e) {
 if (NC) NC.report('v4x', { ok: false, summary: 'bootstrap 异常: ' + (e && e.message) });
 return { ok: false, summary: 'crashed: ' + (e && e.message) };
 });
 },
 onSessionTimeout: function () {
 var NC = (_GLOBAL.CFS4 && _GLOBAL.CFS4.NotificationCenter) || null;
 if (NC) NC.report('v4x', { ok: false, summary: 'Mvu 60s 未就绪' });
 return { ok: false, summary: 'mvu timeout' };
 }
 });
 console.log('[CFS v4.x] v4_bootstrap plugin 已注册到 Coordinator');
 return;
 }
 if (retryLeft > 0) {
 setTimeout(function () { _registerV4BootPlugin(retryLeft - 1); }, 50);
 return;
 }
 // 超过 2.5s 仍没挂上 → 兜底
 console.warn('[CFS v4.x] Coordinator 长期不可用，v4_bootstrap 走 app_ready 兜底');
 try { eventOnce('app_ready', _bootRestore); }
 catch (e) { setTimeout(_bootRestore, 1800); }
 } catch (eR) { console.warn('[CFS v4.x] v4_bootstrap plugin 注册失败', eR); }
 }
 setTimeout(_registerV4BootPlugin, 0);

 // ===== Step 10: 自检 =====
 async function selfTest() {
 var candidates = await listCandidateMvuEntries();
 var sim = await simulateInjection();
 var dyn = null;
 if (_dynamicEntryUid != null) {
 try {
 var wb = await SFL.getActiveWorldbook();
 var es = await _getEntries(wb);
 var d = es.find(function (e) { return e.uid === _dynamicEntryUid; });
 dyn = d ? { uid: d.uid, enabled: d.enabled, contentLen: (d.content || '').length, comment: d.comment.slice(0, 60) } : null;
 } catch (_e) {}
 }
 return {
 current_mode: FS.getCurrentMode(),
 mvu_candidates: candidates,
 managed_uids: _managedMvuUids.slice(),
 dynamic_entry: dyn,
 simulation: sim,
 injection_stats: { count: _injectionCount, failures: _failureCount, last: _lastInjection }
 };
 }

 // ===== 导出 =====
 IS.listCandidateMvuEntries = listCandidateMvuEntries;
 IS.setManagedMvuEntries = setManagedMvuEntries;
 IS.getManagedMvuEntries = getManagedMvuEntries;
 IS.ensureDynamicEntry = ensureDynamicEntry;
 IS.applyInjection = applyInjection;
 IS.restoreMvuRendering = restoreMvuRendering;
 IS.simulateInjection = simulateInjection;
 IS.getDynamicEntryUid = function () { return _dynamicEntryUid; };
 IS.getLastInjection = function () { return _lastInjection; };
 IS.selfTest = selfTest;
 // 公开 bootstrap API + worldbook 检测
 IS.bootstrapTakeover = bootstrapTakeover;
 IS.detectTakeoverState = _detectWorldbookTakeoverState;

 L.info('Real Takeover (方案 A) 已挂载 — 默认 mode=' + FS.getCurrentMode() + '，接管未启动');
})();



// Real Takeover IIFE 完成 — 给 window.CFS4 加完成 flag，不依赖 attach 字段探测。
// 上面 L.info('Real Takeover (方案 A) 已挂载') 出现 = IIFE 跑到底 = attach 行已执行
// 即便后续 attach 在某种闭包/对象引用诡异下没生效（看 IS keys log 诊断），也算 mounted。
if (window.CFS4) {
    window.CFS4._realTakeoverIIFEDone = true;
}

const _isAtExportTime = window.CFS4?.InjectionStrategy;
console.log(
    '[CFS-Suite/real-takeover] IS keys at export time:',
    Object.keys(_isAtExportTime ?? {}),
);

export const RealTakeover = window.CFS4?._realTakeoverIIFEDone
    ? {
        mounted: true,
        bootstrapTakeover: _isAtExportTime?.bootstrapTakeover,
        detectTakeoverState: _isAtExportTime?.detectTakeoverState,
        _attachedTo: 'CFS4.InjectionStrategy',
    }
    : null;

console.log(
    '[CFS-Suite/real-takeover] RealTakeover ESM bridge OK, has IS.bootstrapTakeover =',
    !!_isAtExportTime?.bootstrapTakeover,
);
