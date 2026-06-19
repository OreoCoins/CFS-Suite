/**
 * CFS-Suite · core/diff_engine.js
 *
 * 从 CFS v4.x（L3947-4320）整段迁移 — Diff Engine 三态机
 * 协议契约 v3 §C：path-registry-driven 三态机 (present / omitted / deleted)
 *
 * 依赖：path_registry.js
 */
import { polyfilledApis as _r } from '../compat/tavern_helper_polyfill.js';
import './statdata_engine.js'; import './schema_layer.js'; import './path_registry.js';
void _r;

/* ==========================================================
 * CFS v4.x: Diff Engine (path-registry-driven 三态机)
 *
 * 协议契约 v3 §C 铁律：
 * - 输入: (registry, old_stat_data, new_stat_data, llm_update_ops)
 * - 输出: 每个注册路径恰好一个三态判定
 *
 * | 状态 | 判定 | 注入处理 |
 * |---------|------------------------------------------------|-------------------------|
 * | present | new 有值 + 跟 old 不同 | 走 mutable delta 层 |
 * | omitted | new 无值 / 值未变 + 无 explicit remove op | 保留 old 值 + stable token |
 * | deleted | LLM <UpdateVariable> 内出现 op='remove' path... | registry 移除该 path |
 *
 * 铁律：「new 里无值」绝不等于「deleted」
 * 未注册 path 出现 → emit cfs_schema_drift_detected
 *
 * 是纯计算引擎，不修改任何 state（不动 PathRegistry，不动 worldbook）。
 * 调用者根据三态结果决定后续动作。
 * ==========================================================*/
(function () {
 'use strict';

 var _GLOBAL = (typeof window !== 'undefined' && window.parent) || (typeof window !== 'undefined' ? window : null);
 if (!_GLOBAL || !_GLOBAL.CFS4 || !_GLOBAL.CFS4._loaded) {
 console.warn('[CFS v4.x] CFS4 not initialized, abort');
 return;
 }
 if (_GLOBAL.CFS4.DiffEngine && _GLOBAL.CFS4.DiffEngine._version) {
 console.warn('[CFS v4.x] DiffEngine already mounted, skip');
 return;
 }
 if (!_GLOBAL.CFS4.PathRegistry || !_GLOBAL.CFS4.SchemaResolver) {
 console.warn('[CFS v4.x] 依赖未就绪，abort');
 return;
 }

 var CFS4 = _GLOBAL.CFS4;
 var L = CFS4.log;
 var PR = CFS4.PathRegistry;

 // ===== 0. 工具：按点分 path 字符串读 nested object 值 =====
 function _getByPath(obj, path) {
 if (obj == null || !path) return undefined;
 var parts = String(path).split('.');
 var cur = obj;
 for (var i = 0; i < parts.length; i++) {
 if (cur == null || typeof cur !== 'object') return undefined;
 cur = cur[parts[i]];
 }
 return cur;
 }

 // 检查 obj 内 path 是否真的存在（区分 undefined 和 missing）
 function _hasPath(obj, path) {
 if (obj == null || !path) return false;
 var parts = String(path).split('.');
 var cur = obj;
 for (var i = 0; i < parts.length; i++) {
 if (cur == null || typeof cur !== 'object') return false;
 if (!Object.prototype.hasOwnProperty.call(cur, parts[i])) return false;
 cur = cur[parts[i]];
 }
 return true;
 }

 // 深比较两个值是否相等
 function _deepEqual(a, b) {
 if (a === b) return true;
 if (a == null || b == null) return a === b;
 if (typeof a !== typeof b) return false;
 if (typeof a !== 'object') return a === b;
 if (Array.isArray(a) !== Array.isArray(b)) return false;
 if (Array.isArray(a)) {
 if (a.length !== b.length) return false;
 for (var i = 0; i < a.length; i++) if (!_deepEqual(a[i], b[i])) return false;
 return true;
 }
 var aKeys = Object.keys(a);
 var bKeys = Object.keys(b);
 if (aKeys.length !== bKeys.length) return false;
 for (var j = 0; j < aKeys.length; j++) {
 if (!Object.prototype.hasOwnProperty.call(b, aKeys[j])) return false;
 if (!_deepEqual(a[aKeys[j]], b[aKeys[j]])) return false;
 }
 return true;
 }

 // 递归提取 stat_data 所有 leaf path（用 . 分隔，array 作 leaf）
 function _walkStatDataLeafPaths(obj, prefix) {
 var out = [];
 if (obj == null) return out;
 if (typeof obj !== 'object' || Array.isArray(obj)) {
 if (prefix) out.push(prefix);
 return out;
 }
 var keys = Object.keys(obj);
 if (keys.length === 0 && prefix) {
 out.push(prefix);
 return out;
 }
 for (var i = 0; i < keys.length; i++) {
 var k = keys[i];
 var sub = prefix ? prefix + '.' + k : k;
 out = out.concat(_walkStatDataLeafPaths(obj[k], sub));
 }
 return out;
 }

 // JSONPatch path "/X/Y" → 点风格 "X.Y"
 function _jsonPatchPathToDot(jpPath) {
 if (!jpPath || typeof jpPath !== 'string') return null;
 if (jpPath.charAt(0) !== '/') return null;
 // JSONPatch path 用 / 分隔，~1 表示 /，~0 表示 ~
 var parts = jpPath.slice(1).split('/');
 for (var i = 0; i < parts.length; i++) {
 parts[i] = parts[i].replace(/~1/g, '/').replace(/~0/g, '~');
 }
 return parts.join('.');
 }

 // ===== 1. computeDiff —— 主入口 =====
 //
 // opts = {
 // old_stat_data?: {}, // 上轮值（如果有；首轮可不传）
 // new_stat_data: {}, // 本轮值
 // llm_update_ops?: [{op, path, value}], // JSONPatch RFC 6902 ops（path 是 / 风格）
 // schema_ref?: 'cfs_schema_xxx:primary', // 筛选 registry 内此 schema_ref 的 paths；不传 = 全部
 // round?: <number> // 当前轮次（仅用于元数据，diff 本身不依赖）
 // }
 //
 // 返回 {
 // present: [{ path_id, path, old_value, new_value }],
 // omitted: [{ path_id, path, last_value, reason }],
 // deleted: [{ path_id, path, op }],
 // drift: [{ path, value, reason }],
 // round: <number>,
 // schema_ref: ...
 // }
 function computeDiff(opts) {
 opts = opts || {};
 var oldData = opts.old_stat_data || null;
 var newData = opts.new_stat_data;
 if (newData == null || typeof newData !== 'object') {
 throw new Error('computeDiff: new_stat_data 必须是 object');
 }
 var llmOps = Array.isArray(opts.llm_update_ops) ? opts.llm_update_ops : [];
 var schemaRef = opts.schema_ref || null;
 var round = opts.round != null ? opts.round : null;

 var result = {
 present: [], omitted: [], deleted: [], drift: [],
 round: round, schema_ref: schemaRef
 };

 // === Step 1: 解析 LLM remove ops（构建 path → op 映射）===
 // 注意：path 必须严格 explicit remove，op != 'remove' 不计入
 var explicitRemovePathsDot = {}; // { dotPath: jsonPatchOp }
 for (var i = 0; i < llmOps.length; i++) {
 var op = llmOps[i];
 if (op && op.op === 'remove' && op.path) {
 var dotP = _jsonPatchPathToDot(op.path);
 if (dotP) explicitRemovePathsDot[dotP] = op;
 }
 }

 // === Step 2: 遍历 PathRegistry 中匹配 schema_ref 的 paths，做三态判定 ===
 var registry = PR.getAll();
 var allRegisteredDotPaths = {}; // 用于 drift 检测：注册过的 path → path_id

 var pathIds = Object.keys(registry);
 for (var k = 0; k < pathIds.length; k++) {
 var pid = pathIds[k];
 var r = registry[pid];
 if (schemaRef && r.schema_ref !== schemaRef) continue;

 var pStr = r.path;
 allRegisteredDotPaths[pStr] = pid;

 // 2a. deleted 优先：explicit LLM remove op
 if (explicitRemovePathsDot[pStr]) {
 result.deleted.push({
 path_id: pid, path: pStr, op: explicitRemovePathsDot[pStr]
 });
 continue;
 }

 // 2b. present / omitted 判定
 var hasNew = _hasPath(newData, pStr);
 if (hasNew) {
 var newVal = _getByPath(newData, pStr);
 var oldVal = oldData ? _getByPath(oldData, pStr) : r.last_value;
 if (!_deepEqual(newVal, oldVal)) {
 // 新值跟 old 不同 → present
 result.present.push({
 path_id: pid, path: pStr,
 old_value: oldVal, new_value: newVal
 });
 } else {
 // 新值跟 old 相同（或 old 没有）→ omitted（值未变）
 result.omitted.push({
 path_id: pid, path: pStr,
 last_value: newVal, reason: 'unchanged'
 });
 }
 } else {
 // new 里没出现 → omitted（保留 last_value）
 result.omitted.push({
 path_id: pid, path: pStr,
 last_value: r.last_value, reason: 'not_in_new'
 });
 }
 }

 // === Step 3: drift 检测 —— new_stat_data 里有但 registry 没注册的 path ===
 var newLeafPaths = _walkStatDataLeafPaths(newData, '');
 for (var m = 0; m < newLeafPaths.length; m++) {
 var p = newLeafPaths[m];
 if (!allRegisteredDotPaths[p]) {
 result.drift.push({
 path: p,
 value: _getByPath(newData, p),
 reason: 'path appears in new_stat_data but not in PathRegistry (' +
 (schemaRef ? 'schema_ref=' + schemaRef : 'any schema') + ')'
 });
 }
 }

 // emit drift event 但不抛错（让调用方决定）
 if (result.drift.length > 0) {
 CFS4.emit(CFS4.EVENTS.SCHEMA_DRIFT_DETECTED, {
 source: 'DiffEngine',
 schema_ref: schemaRef,
 unregistered_paths: result.drift.map(function (x) { return x.path; }),
 count: result.drift.length
 });
 L.warn('DiffEngine: ' + result.drift.length + ' unregistered path 出现在 new_stat_data 中', result.drift);
 }

 // emit computed event
 CFS4.emit(CFS4.EVENTS.DIFF_COMPUTED, {
 schema_ref: schemaRef,
 round: round,
 counts: {
 present: result.present.length,
 omitted: result.omitted.length,
 deleted: result.deleted.length,
 drift: result.drift.length
 }
 });

 L.debug('computeDiff: ' + (schemaRef || 'ANY')
 + ' present=' + result.present.length
 + ' omitted=' + result.omitted.length
 + ' deleted=' + result.deleted.length
 + ' drift=' + result.drift.length);

 return result;
 }

 // ===== 2. applyDiffToRegistry —— 可选辅助：根据 diff 结果更新 registry =====
 //
 function applyDiffToRegistry(diffResult) {
 if (!diffResult) return;
 var round = diffResult.round;
 // present → update（写入新值）
 for (var i = 0; i < diffResult.present.length; i++) {
 var p = diffResult.present[i];
 PR.update(p.path_id, p.new_value, round);
 }
 // omitted → markOmitted（last_round 推进，last_value 保留）
 for (var j = 0; j < diffResult.omitted.length; j++) {
 var o = diffResult.omitted[j];
 PR.markOmitted(o.path_id, round);
 }
 // deleted → unregister
 for (var k = 0; k < diffResult.deleted.length; k++) {
 var d = diffResult.deleted[k];
 PR.unregister(d.path_id);
 }
 // drift 不动 registry（按协议铁律：不自动注册）
 }

 // ===== 3. selfTest =====
 async function selfTest() {
 var ids = CFS4.getSchemaIds();
 var sid = ids.primary + '::_test_diff';

 // 1. 构造 schema with 3 paths
 var schema = CFS4.SchemaFrozenLayer.buildDefaultSchemaTemplate();
 schema.paths['p_0010'] = { path: 'attributes.hp', type: 'number', default: 100 };
 schema.paths['p_0011'] = { path: 'attributes.mp', type: 'number', default: 50 };
 schema.paths['p_0012'] = { path: 'system.location', type: 'string', default: '院子' };

 // 绕过 SwapGate 状态机
 // 直接 writeSchema 写 entry + 失效 Resolver cache + 手动 syncFromSchema 同步 PathRegistry
 // 重复跑 selfTest 时 writeSchema 走 update 路径（同 sid + ver=1），完全 idempotent
 await CFS4.SchemaFrozenLayer.writeSchema(schema, { schemaId: sid, ver: 1 });
 CFS4.SchemaResolver.invalidateCache(sid);
 await CFS4.PathRegistry.syncFromSchema(sid);

 // 2. 构造 old_stat_data + new_stat_data + llm_ops
 var oldData = {
 attributes: { hp: 100, mp: 50 },
 system: { location: '院子' }
 };
 var newData = {
 attributes: { hp: 85, mp: 50 }, // hp 变了，mp 没变
 system: { location: '走廊', new_field: '???' } // location 变了；new_field 没注册 → drift
 // attributes.something_deleted 缺失 → 但因为 path 没注册不影响
 };
 var llmOps = [
 // 显式删一个未注册 path（不影响 deleted 三态——只有注册过的才会进 deleted）
 { op: 'remove', path: '/inventory/old_potion' }
 ];

 L.info('selfTest: 跑 computeDiff');
 var diff = computeDiff({
 old_stat_data: oldData,
 new_stat_data: newData,
 llm_update_ops: llmOps,
 schema_ref: sid,
 round: 1
 });

 L.info(' present:', diff.present);
 L.info(' omitted:', diff.omitted);
 L.info(' deleted:', diff.deleted);
 L.info(' drift:', diff.drift);

 // 期望：
 // present = [p_0010 (hp: 100→85), p_0012 (location: 院子→走廊)]
 // omitted = [p_0011 (mp unchanged)]
 // deleted = [] (因为没有注册的 path 被 remove)
 // drift = [system.new_field]

 return diff;
 }

 // ===== 4. cleanup =====
 async function cleanupPhase5Test() {
 var ids = CFS4.getSchemaIds();
 var sid = ids.primary + '::_test_diff';
 // 撤掉 Registry 里 schema_ref = sid 的 path
 var reg = PR.getAll();
 var removed = [];
 Object.keys(reg).forEach(function (k) {
 if (reg[k].schema_ref === sid) {
 PR.unregister(k);
 removed.push(k);
 }
 });
 try { await CFS4.SchemaFrozenLayer.removeSchema(sid, 1); } catch (_e) {}
 CFS4.SchemaResolver.invalidateCache(sid);
 return { schema_id: sid, removed_paths: removed };
 }

 // ===== 5. 导出 =====
 CFS4.DiffEngine = {
 _version: '5.0',
 computeDiff: computeDiff,
 applyDiffToRegistry: applyDiffToRegistry,
 // 暴露内部工具供下游复用
 _getByPath: _getByPath,
 _hasPath: _hasPath,
 _deepEqual: _deepEqual,
 _walkStatDataLeafPaths: _walkStatDataLeafPaths,
 _jsonPatchPathToDot: _jsonPatchPathToDot,
 selfTest: selfTest,
 cleanupPhase5Test: cleanupPhase5Test
 };

 L.info('Diff Engine mounted');
})();


export const DiffEngine = window.CFS4?.DiffEngine;
console.log('[CFS-Suite/diff-engine] DiffEngine ESM bridge OK');
