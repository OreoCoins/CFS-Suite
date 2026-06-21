/**
 * CFS-Suite · core/path_registry.js
 *
 * 从 CFS v4.x（L3470-3946）整段迁移 — Schema Resolver + Path Registry。
 *
 * 协议契约 v3：
 *   §B.3 Schema Resolver — 双层命名空间 primary→fallback；resolvePath(schema_id:path_id)
 *   §C   Path Registry  — 路径权威列表（last_value / last_round / stability_class 等）；三态机输入
 *
 * 依赖：statdata_engine.js + schema_layer.js（SFL + SSG 必须先就位）
 */

import { polyfilledApis as _cfsPolyfillReport } from '../compat/tavern_helper_polyfill.js';
import './statdata_engine.js';
import './schema_layer.js';
void _cfsPolyfillReport;

// ============================================================
// 以下为 cfs_content_extracted.js L3470-3946（PathRegistry IIFE）
// ============================================================

/* ==========================================================
 * CFS v4.x: Schema Resolver + Path Registry
 *
 * 协议契约 v3 §B.3 + §C：
 *
 * Schema Resolver (§B.3)：
 * - 双层命名空间：primary (角色卡) → fallback (global)
 * - resolvePath(<schema_id>:<path_id>) 按 primary→fallback 顺序解析
 * - token 字面量跨卡不同 = 隔离正确，runtime 通过 Resolver 解析
 * - 监听 cfs_schema_swap_committed 自动失效缓存
 *
 * Path Registry (§C)：
 * - 数据结构：{ <path_id>: { path, schema_ref, last_value, last_round,
 * last_present_round, change_count, stability_class } }
 * - 路径权威列表，三态机的输入
 * - SwapGate commit 时根据新 active schema 同步（增/删 path_id）
 * - 持久化到 script-scope variables
 *
 * Schema paths 数据结构约定（写入 schema 时）：
 * schema.paths = {
 * "<path_id>": { // 稳定 ID（不是 path 字符串）
 * "path": "attributes.hp", // 人类可读路径（可变）
 * "type": "number",
 * "default": 100,
 * "desc": "..." // optional
 * }
 * }
 * path_id 推荐 'p_<NNNN>' 顺序递增，对 schema 演进稳定
 * ==========================================================*/
(function () {
 'use strict';

 var _GLOBAL = (typeof window !== 'undefined' && window.parent) || (typeof window !== 'undefined' ? window : null);
 if (!_GLOBAL || !_GLOBAL.CFS4 || !_GLOBAL.CFS4._loaded) {
 console.warn('[CFS v4.x] CFS4 not initialized, abort');
 return;
 }
 if (_GLOBAL.CFS4.SchemaResolver && _GLOBAL.CFS4.PathRegistry) {
 console.warn('[CFS v4.x] Resolver/Registry already mounted, skip');
 return;
 }
 if (!_GLOBAL.CFS4.SchemaFrozenLayer || !_GLOBAL.CFS4.SchemaSwapGate) {
 console.warn('[CFS v4.x] 依赖未就绪，abort');
 return;
 }

 var CFS4 = _GLOBAL.CFS4;
 var L = CFS4.log;
 var SFL = CFS4.SchemaFrozenLayer;
 var SSG = CFS4.SchemaSwapGate;
 var PATH_REGISTRY_KEY = 'cfs_v4_path_registry_state';

 // ===== Schema Resolver =====

 // 缓存 { schemaId: { schema, meta, uid, worldbook, ts } }
 var _resolverCache = {};

 function _invalidate(schemaId) {
 if (schemaId) delete _resolverCache[schemaId];
 else _resolverCache = {};
 }

 // 解析单个 schema_id（不走双层）
 async function resolveSchema(schemaId) {
 if (!schemaId) throw new Error('resolveSchema: schemaId 必填');
 if (_resolverCache[schemaId]) return _resolverCache[schemaId];
 var read = await SFL.readSchema(schemaId);
 if (!read) return null;
 _resolverCache[schemaId] = {
 schema: read.schema,
 meta: read.meta,
 uid: read.uid,
 worldbook: read.worldbook,
 ts: Date.now()
 };
 return _resolverCache[schemaId];
 }

 // 双层 resolution：先 primary，再 fallback
 // 返回 { primary, fallback }（任一可能为 null）
 async function resolveLayered() {
 var ids = CFS4.getSchemaIds();
 var primary = await resolveSchema(ids.primary).catch(function () { return null; });
 var fallback = await resolveSchema(ids.fallback).catch(function () { return null; });
 return { primary: primary, fallback: fallback, ids: ids };
 }

 // 解析 path_ref：<schema_id>:<path_id>
 // schema_id 本身含冒号（cfs_schema_xxx:primary），用 lastIndexOf 分隔
 function parsePathRef(pathRef) {
 if (!pathRef || typeof pathRef !== 'string') return null;
 var lastColon = pathRef.lastIndexOf(':');
 if (lastColon < 0) return null;
 var schemaId = pathRef.slice(0, lastColon);
 var pathId = pathRef.slice(lastColon + 1);
 if (!schemaId || !pathId) return null;
 return { schema_id: schemaId, path_id: pathId };
 }

 // 给定 path_ref，按 primary→fallback 双层解析
 // 返回 { path_id, schema_id, schema_ref, path_meta }
 async function resolvePath(pathRef) {
 var parsed = parsePathRef(pathRef);
 if (!parsed) throw new Error('resolvePath: invalid ref ' + pathRef);

 // 1. 先尝试 pathRef 里指定的 schema_id
 var cached = await resolveSchema(parsed.schema_id);
 if (cached && cached.schema && cached.schema.paths && cached.schema.paths[parsed.path_id]) {
 return {
 path_id: parsed.path_id,
 schema_id: parsed.schema_id,
 schema_ref: parsed.schema_id,
 path_meta: cached.schema.paths[parsed.path_id]
 };
 }

 // 2. 双层 fallback：如果 parsed.schema_id 不是当前 ids.primary，再试当前 primary + global fallback
 var ids = CFS4.getSchemaIds();
 var candidates = [];
 if (parsed.schema_id !== ids.primary) candidates.push(ids.primary);
 if (parsed.schema_id !== ids.fallback) candidates.push(ids.fallback);

 for (var i = 0; i < candidates.length; i++) {
 var cand = candidates[i];
 var c = await resolveSchema(cand).catch(function () { return null; });
 if (c && c.schema && c.schema.paths && c.schema.paths[parsed.path_id]) {
 return {
 path_id: parsed.path_id,
 schema_id: cand,
 schema_ref: cand,
 path_meta: c.schema.paths[parsed.path_id]
 };
 }
 }
 // 都找不到 → drift signal
 L.warn('resolvePath: path_id ' + parsed.path_id + ' 在 primary 和 fallback 中都找不到');
 return null;
 }

 // 给定 schema_ref 返回该 schema 内所有 path（{path_id: path_meta} map）
 async function listSchemaPaths(schemaId) {
 var c = await resolveSchema(schemaId);
 if (!c || !c.schema || !c.schema.paths) return {};
 return c.schema.paths;
 }

 // 失效 cache（外部 hook 用）
 function invalidateCache(schemaId) { _invalidate(schemaId); L.debug('resolver cache invalidated: ' + (schemaId || 'ALL')); }

 // ===== Path Registry =====

 // 内存 state
 var _registry = {}; // { path_id: { path, schema_ref, last_value, last_round, last_present_round, change_count, stability_class } }

 function _persistRegistry() {
 try {
 if (typeof updateVariablesWith !== 'function') return false;
 // 体积警告 + emit 信号让 HealthMonitor 可观测
 var pathCount = Object.keys(_registry).length;
 updateVariablesWith(function (vars) {
 if (!vars || typeof vars !== 'object') vars = {};
 vars[PATH_REGISTRY_KEY] = _registry;
 vars[PATH_REGISTRY_KEY + '_meta'] = { count: pathCount, ts: new Date().toISOString(), _version: 1 };
 return vars;
 }, { type: 'script', script_id: getScriptId() });
 // 体积阈值检测（接近 50KB 提前预警，留分页 contingency 窗口）
 try {
 var sizeBytes = JSON.stringify(_registry).length;
 if (sizeBytes > 40000 && !_persistRegistry._sizeWarned) {
 L.warn('PathRegistry 持久化体积接近阈值: ' + sizeBytes + ' bytes — 接近 50KB 软限，可能需要分页存储');
 _persistRegistry._sizeWarned = true;
 }
 } catch (_e) {}
 CFS4.emit('cfs_path_registry_persisted', { count: pathCount });
 return true;
 } catch (e) { L.error('PathRegistry persist failed', e); return false; }
 }

 function _loadRegistry() {
 try {
 if (typeof getVariables !== 'function') return {};
 var sv = getVariables({ type: 'script', script_id: getScriptId() });
 return (sv && sv[PATH_REGISTRY_KEY]) || {};
 } catch (e) { L.warn('PathRegistry load failed', e); return {}; }
 }

 function registerPath(pathId, schemaRef, opts) {
 if (!pathId) throw new Error('registerPath: pathId 必填');
 if (!schemaRef) throw new Error('registerPath: schemaRef 必填');
 opts = opts || {};
 if (!_registry[pathId]) {
 _registry[pathId] = {
 path: opts.path || pathId,
 schema_ref: schemaRef,
 last_value: opts.initialValue !== undefined ? opts.initialValue : null,
 last_round: opts.round != null ? opts.round : 0,
 last_present_round: 0,
 change_count: 0,
 stability_class: opts.stability_class || 'volatile',
 // CFS v5.0 Day 10: 自动观察四件套（Slow Promote / Fast Demote）
 stable_rounds: 0,
 last_change_round: 0,
 promote_count: 0,
 demote_count: 0
 };
 } else {
 // 重注册：只更新 schema_ref 和 path（人类可读路径）；其他保留
 _registry[pathId].schema_ref = schemaRef;
 if (opts.path) _registry[pathId].path = opts.path;
 // 老数据兼容：load 进来缺四件套字段时补 0（一次性）
 if (_registry[pathId].stable_rounds == null) _registry[pathId].stable_rounds = 0;
 if (_registry[pathId].last_change_round == null) _registry[pathId].last_change_round = 0;
 if (_registry[pathId].promote_count == null) _registry[pathId].promote_count = 0;
 if (_registry[pathId].demote_count == null) _registry[pathId].demote_count = 0;
 }
 _persistRegistry();
 return _registry[pathId];
 }

 function unregisterPath(pathId) {
 if (_registry[pathId]) {
 delete _registry[pathId];
 _persistRegistry();
 return true;
 }
 return false;
 }

 // 给 path_id 更新值（值真实出现时调用）
 function updatePath(pathId, value, round) {
 var r = _registry[pathId];
 if (!r) {
 L.warn('updatePath: ' + pathId + ' 未注册');
 return null;
 }
 var changed = (value !== r.last_value);
 if (changed) {
 r.last_value = value;
 r.change_count += 1;
 }
 if (round != null) {
 r.last_round = round;
 r.last_present_round = round;
 }
 _persistRegistry();
 return r;
 }

 // 标记 path 在某一轮缺失（不更新 last_value）
 function markPathOmitted(pathId, round) {
 var r = _registry[pathId];
 if (!r) return null;
 if (round != null) r.last_round = round;
 // last_present_round 不更新（区分"上次以 present 出现"vs"上次遍历到"）
 _persistRegistry();
 return r;
 }

 function setStabilityClass(pathId, cls) {
 var r = _registry[pathId];
 if (!r) return null;
 if (['volatile', 'stable', 'frozen'].indexOf(cls) < 0) {
 throw new Error('setStabilityClass: cls 必须是 volatile / stable / frozen');
 }
 r.stability_class = cls;
 _persistRegistry();
 return r;
 }

 function getPath(pathId) { return _registry[pathId] || null; }
 function getAllPaths() { return _registry; }

 // 根据当前 active schema 同步 registry：增/删 path_id
 async function syncFromSchema(schemaId) {
 var sid = schemaId || CFS4.getSchemaIds().primary;
 var paths = await listSchemaPaths(sid);
 var added = [], removed = [], kept = [];

 var schemaPathIds = Object.keys(paths);
 // 1. schema 里新增的 path_id → register
 for (var i = 0; i < schemaPathIds.length; i++) {
 var pid = schemaPathIds[i];
 var meta = paths[pid];
 if (!_registry[pid]) {
 registerPath(pid, sid, {
 path: meta.path || pid,
 initialValue: meta.default,
 stability_class: meta.stability_class || 'volatile'
 });
 added.push(pid);
 } else {
 // 检查 path 字符串是否变了
 if (meta.path && meta.path !== _registry[pid].path) {
 _registry[pid].path = meta.path;
 }
 _registry[pid].schema_ref = sid;
 kept.push(pid);
 }
 }
 // 2. registry 里有但当前 schema 没有的 path_id（在同 schema_ref 内）→ 标记为"待删除"
 // 实际是否删除取决于策略：暂时不强删，emit drift 让上层决定
 var registryPathIds = Object.keys(_registry);
 for (var j = 0; j < registryPathIds.length; j++) {
 var rid = registryPathIds[j];
 if (_registry[rid].schema_ref === sid && schemaPathIds.indexOf(rid) < 0) {
 removed.push(rid);
 }
 }
 _persistRegistry();
 var summary = { schema_id: sid, added: added, removed_pending: removed, kept: kept };
 CFS4.emit(CFS4.EVENTS.PATH_REGISTRY_UPDATED, summary);
 L.info('PathRegistry sync from ' + sid + ': +' + added.length + ' kept=' + kept.length + ' removed_pending=' + removed.length);
 return summary;
 }

 // boot 恢复 registry (多次重试加载，对抗 ST 落盘时序异步)
 function _bootRestoreRegistry() {
 // hotfix v2.8.1: 如果 _registry 已有数据（autoRegister/手动注册），不要覆盖
 // 触发场景：IIFE 末尾的 setTimeout 兜底 + chat_changed 钩多次触发都会调到这里
 // 第一次 boot 后 autoRegister 注册了 641 条 path，第二次 boot 调 _loadRegistry()
 // 从 script vars 读到 null（还没落盘）→ 直接清空 _registry —— 这才是 pr=0 的真因
 if (Object.keys(_registry).length > 0) {
 L.info('PathRegistry boot 跳过（已有 ' + Object.keys(_registry).length + ' 条 path，不覆盖）');
 return;
 }
 var loaded = _loadRegistry();
 var count = loaded ? Object.keys(loaded).length : 0;
 _registry = loaded || {};
 L.info('PathRegistry boot: 恢复 ' + count + ' 条 path (第 1 次尝试)');
 if (count === 0) {
 // 0 条不一定是空状态，可能是 ST 还没落盘 → 多次延迟重试
 var attempts = [500, 1500, 3000];
 attempts.forEach(function (delay, i) {
 setTimeout(function () {
 if (Object.keys(_registry).length > 0) return; // 已有数据不再覆盖
 var retry = _loadRegistry();
 var retryCount = retry ? Object.keys(retry).length : 0;
 if (retryCount > 0) {
 _registry = retry;
 L.info('PathRegistry boot 第 ' + (i + 2) + ' 次尝试 (' + delay + 'ms 延迟): 恢复 ' + retryCount + ' 条 path');
 CFS4.emit('cfs_path_registry_late_recovered', { count: retryCount, attempt: i + 2 });
 }
 }, delay);
 });
 }
 // 体积警告（boot 时也检测）
 try {
 var sizeBytes = JSON.stringify(_registry).length;
 if (sizeBytes > 40000) L.warn('PathRegistry boot 加载体积: ' + sizeBytes + ' bytes (接近 50KB)');
 } catch (_e) {}
 }
 // 主动 flush helper（disconnect 等场景调）
 function _flushRegistry() {
 _persistRegistry();
 L.debug('PathRegistry 主动 flush 完成 (' + Object.keys(_registry).length + ' 条)');
 }

 // 2026-06-21 v6 hotfix：切卡霸王 reset
 // 旧 BUG（v2.8.1 hotfix 副作用）：chat_id_changed 只调 _flushRegistry，
 //   in-memory _registry 保留旧卡 paths + boot 函数"已有不覆盖"锁住覆盖路径
 //   → 切到新卡后 PathRegistry.getAll() 仍是旧卡 423 条字段，整个 MVU 数据流按错卡字段跑
 // 修：切卡时强制清空 in-memory + 触发新卡 autoRegister
 // 注意 boot 时仍尊重 v2.8.1 "已有不覆盖" — 那条治的是落盘时序问题，不是切卡场景
 var _lastSeenChatId = null;
 function _currentChatIdSafe() {
 try {
 var ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext() : null;
 if (ctx && typeof ctx.getCurrentChatId === 'function') return ctx.getCurrentChatId();
 if (ctx && ctx.chatId != null) return ctx.chatId;
 } catch (_e) {}
 return null;
 }
 // 防御层 hotfix(2026-06-21)：切卡后 stat_data 异步未就绪时，旧逻辑只在 1000ms 单发一次
 //   autoRegister 会扑空 —— 卡自带 MVU（网络 import MagVarUpdate@beta）+ Zod schema 注册
 //   + 首条消息处理通常都 >1s。表现：首次导入卡 PathRegistry 永远空，要手动「清空 path + F5」。
 //   改为退避轮询 Mvu.getMvuData，等 stat_data 非空再 autoRegister。退避表累计 ~60s，
 //   与 real_takeover v4_bootstrap 的 Mvu 60s timeout 对齐。
 function _resolveMvuPR() {
 if (typeof Mvu !== 'undefined' && Mvu && Mvu.getMvuData) return Mvu;
 if (_GLOBAL && _GLOBAL.Mvu && _GLOBAL.Mvu.getMvuData) return _GLOBAL.Mvu;
 if (typeof window !== 'undefined' && window.Mvu && window.Mvu.getMvuData) return window.Mvu;
 if (typeof window !== 'undefined' && window.parent && window.parent.Mvu && window.parent.Mvu.getMvuData) return window.parent.Mvu;
 return null;
 }
 var _AUTO_REG_BACKOFF = [1000, 2000, 4000, 8000, 15000, 30000]; // 累计 ~60s
 function _scheduleAutoRegisterWhenReady(forChatId, attempt) {
 attempt = attempt || 0;
 if (attempt >= _AUTO_REG_BACKOFF.length) {
 L.warn('PathRegistry 切卡 autoRegister：' + _AUTO_REG_BACKOFF.length + ' 次重试后 stat_data 仍未就绪，放弃 (chatId=' + forChatId + ')');
 return;
 }
 setTimeout(function () {
 // 守卫1：切卡链已失效（用户又切走） → 放弃本链，避免给错卡注册
 if (forChatId !== _lastSeenChatId) {
 L.debug('PathRegistry autoRegister 重试取消：chatId 已变 (' + forChatId + ' → ' + _lastSeenChatId + ')');
 return;
 }
 // 守卫2：registry 已有数据（bootstrap / 手动已建） → 不重复
 if (Object.keys(_registry).length > 0) {
 L.info('PathRegistry 切卡 autoRegister 跳过：已有 ' + Object.keys(_registry).length + ' 条 path');
 return;
 }
 var IS = CFS4 && CFS4.InjectionStrategy;
 if (!IS || typeof IS.autoRegisterFromStatData !== 'function') {
 L.warn('PathRegistry 切卡：autoRegisterFromStatData 不可用，退避重试');
 _scheduleAutoRegisterWhenReady(forChatId, attempt + 1);
 return;
 }
 // 先探 stat_data 是否就绪（非空），避免 autoRegister 内部抛错刷屏
 var mvu = _resolveMvuPR();
 var readyCheck = mvu
 ? Promise.resolve(mvu.getMvuData({ type: 'message', message_id: -1 })).catch(function () { return null; })
 : Promise.resolve(null);
 readyCheck.then(function (mvuData) {
 var ready = mvuData && mvuData.stat_data && Object.keys(mvuData.stat_data).length > 0;
 if (!ready) {
 L.debug('PathRegistry 切卡 autoRegister 等待 stat_data 就绪（第 ' + (attempt + 1) + ' 次，chatId=' + forChatId + '）');
 _scheduleAutoRegisterWhenReady(forChatId, attempt + 1);
 return;
 }
 Promise.resolve(IS.autoRegisterFromStatData({ default_class: 'volatile' }))
 .then(function (auto) {
 L.info('PathRegistry 切卡后 autoRegister 成功：' + (auto && auto.count != null ? auto.count : '?') + ' 条 path（第 ' + (attempt + 1) + ' 次就绪，chatId=' + forChatId + '）');
 try { CFS4.emit('cfs_path_registry_chat_autoreg', { chatId: forChatId, count: auto && auto.count, attempt: attempt + 1 }); } catch (_e) {}
 })
 .catch(function (e) {
 L.warn('PathRegistry 切卡 autoRegister 失败，退避重试', e);
 _scheduleAutoRegisterWhenReady(forChatId, attempt + 1);
 });
 });
 }, _AUTO_REG_BACKOFF[attempt]);
 }
 function _onChatChanged() {
 var newChatId = _currentChatIdSafe();
 // 防误触：chat_id_changed 在保存/重命名等场景也会触发但 chatId 没真变
 if (newChatId != null && newChatId === _lastSeenChatId) {
 L.debug('PathRegistry chat_id_changed 但 chatId 未变 (' + newChatId + ')，跳过 reset');
 _persistRegistry();
 return;
 }
 var prevCount = Object.keys(_registry).length;
 var prevChatId = _lastSeenChatId;
 // 1. flush 当前 _registry 到 LS（旧卡数据保留在 LS，下次回到旧卡 boot 时能恢复）
 try { _persistRegistry(); } catch (_e) {}
 // 2. 霸王 reset：清空 in-memory
 _registry = {};
 _lastSeenChatId = newChatId;
 L.warn('PathRegistry 切卡 reset: chatId ' + prevChatId + ' → ' + newChatId + '（清掉 ' + prevCount + ' 条旧卡 path）');
 CFS4.emit('cfs_path_registry_chat_switched', { from: prevChatId, to: newChatId, cleared: prevCount });
 // 3. 触发 autoRegister 重建新卡 paths（退避轮询等 stat_data 就绪，见上方 _scheduleAutoRegisterWhenReady）
 _scheduleAutoRegisterWhenReady(newChatId, 0);
 }

 // 钩 cfs_schema_swap_committed → 失效 cache + 同步 registry
 function _onSchemaCommitted(payload) {
 L.debug('Resolver/Registry: schema committed', payload);
 if (payload && payload.schema_id) {
 invalidateCache(payload.schema_id);
 // 异步 sync
 syncFromSchema(payload.schema_id).catch(function (e) {
 L.warn('PathRegistry syncFromSchema after commit failed', e);
 });
 } else {
 invalidateCache();
 }
 }

 try {
 if (typeof eventOn === 'function') {
 eventOn(CFS4.EVENTS.SCHEMA_SWAP_COMMITTED, _onSchemaCommitted);
 eventOn(CFS4.EVENTS.SCHEMA_FROZEN, function (payload) {
 // schema 刚被 freeze（write），失效 cache（即使没 commit，refresh schemas）
 if (payload && payload.schema_id) invalidateCache(payload.schema_id);
 });
 }
 } catch (e) { L.warn('钩事件失败', e); }

 // ===== selfTest =====
 async function selfTest() {
 var ids = CFS4.getSchemaIds();
 var sid = ids.primary + '::_test_resolver';

 // 构造一个 schema 含两个 path
 var schema = SFL.buildDefaultSchemaTemplate();
 schema.paths['p_0001'] = { path: 'attributes.hp', type: 'number', default: 100 };
 schema.paths['p_0002'] = { path: 'attributes.mp', type: 'number', default: 60 };

 // propose v1（首次→active）
 var r1 = await SSG.propose(schema, { schemaId: sid, ver: 1 });
 L.info('selfTest propose v1:', r1);

 // 此时 swap_committed 事件应已触发 syncFromSchema
 // 等下一个 tick 让事件 listener 跑完
 await new Promise(function (resolve) { setTimeout(resolve, 100); });

 // 1. resolveSchema 应能命中
 var resolved = await resolveSchema(sid);
 L.info('selfTest resolveSchema:', resolved ? { uid: resolved.uid, paths: Object.keys(resolved.schema.paths) } : null);

 // 2. resolvePath 应能找到 p_0001
 var rp = await resolvePath(sid + ':p_0001');
 L.info('selfTest resolvePath p_0001:', rp);

 // 3. PathRegistry 应已经 sync 含 p_0001 + p_0002
 var reg = getAllPaths();
 var myPaths = {};
 Object.keys(reg).forEach(function (k) { if (reg[k].schema_ref === sid) myPaths[k] = reg[k]; });
 L.info('selfTest PathRegistry (filtered to this schema):', myPaths);

 return {
 proposed: r1,
 resolved: resolved ? { uid: resolved.uid, paths: Object.keys(resolved.schema.paths) } : null,
 resolvedPath: rp,
 registryPaths: myPaths
 };
 }

 // cleanup（清掉 _test_resolver 残留）
 async function cleanupPhase4Test() {
 var ids = CFS4.getSchemaIds();
 var sid = ids.primary + '::_test_resolver';
 // 撤掉 Registry 里 schema_ref = sid 的所有 path
 var removedPaths = [];
 Object.keys(_registry).forEach(function (k) {
 if (_registry[k].schema_ref === sid) {
 delete _registry[k];
 removedPaths.push(k);
 }
 });
 _persistRegistry();
 // disable schema entry
 try { await SFL.removeSchema(sid, 1); } catch (_e) {}
 invalidateCache(sid);
 return { schema_id: sid, removed_paths: removedPaths };
 }

 // ===== boot =====
 try { eventOnce('app_ready', _bootRestoreRegistry); }
 catch (e) { setTimeout(_bootRestoreRegistry, 1800); }
 setTimeout(function () {
 if (Object.keys(_registry).length === 0) _bootRestoreRegistry();
 }, 2600);

 // 2026-06-21 v6 hotfix：chat 切换走霸王 reset 路径，不再只 flush
 // 老代码：eventOn('chat_changed', _flushRegistry) → 只保存，导致切卡后 _registry 仍是旧卡数据
 // 新：eventOn('chat_changed', _onChatChanged) → flush 旧 + reset in-memory + autoRegister 新卡
 try {
 if (typeof eventOn === 'function') {
 eventOn('chat_changed', _onChatChanged);
 eventOn('chat_id_changed', _onChatChanged);
 // 初始化 _lastSeenChatId（首次 boot 时填一次，避免 boot 后第一次 chat_id_changed 误判为"切卡"）
 setTimeout(function () { if (_lastSeenChatId == null) _lastSeenChatId = _currentChatIdSafe(); }, 500);
 }
 } catch (e) { L.warn('chat_changed 钩失败', e); }

 // ===== 导出 =====
 CFS4.SchemaResolver = {
 _version: '4.0',
 resolveSchema: resolveSchema,
 resolveLayered: resolveLayered,
 resolvePath: resolvePath,
 parsePathRef: parsePathRef,
 listSchemaPaths: listSchemaPaths,
 invalidateCache: invalidateCache,
 _getCache: function () { return _resolverCache; }
 };

 CFS4.PathRegistry = {
 _version: '4.1',
 register: registerPath,
 unregister: unregisterPath,
 update: updatePath,
 markOmitted: markPathOmitted,
 setStabilityClass: setStabilityClass,
 getPath: getPath,
 getAll: getAllPaths,
 syncFromSchema: syncFromSchema,
 selfTest: selfTest,
 cleanupPhase4Test: cleanupPhase4Test,
 flush: _flushRegistry, // 主动 flush
 _persistImmediate: _persistRegistry,
 _bootRestore: _bootRestoreRegistry
 };

 L.info('Schema Resolver + Path Registry mounted');
})();


// ============================================================
// ESM export — SchemaResolver + PathRegistry
// ============================================================
export const SchemaResolver = window.CFS4?.SchemaResolver;
export const PathRegistry = window.CFS4?.PathRegistry;

console.log('[CFS-Suite/path-registry] SchemaResolver + PathRegistry ESM bridge OK');
