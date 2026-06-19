/**
 * CFS-Suite · core/schema_layer.js
 *
 * 从 CFS v4.x（L2595-3469）整段迁移，含两个独立 IIFE：
 *   - Schema Frozen Layer（L2595-3070）— 双锚点 schema 写入/读取/验证
 *   - Schema Swap Gate（L3071-3469）— 双轨期 T_w 调度，pending → active 决策门
 *
 * 两段在原代码里是独立 IIFE，但都挂 window.CFS4.* 并相互依赖（SSG 需要 SFL 提供
 * canonicalize / sha256Hex / writeSchema）。合到单文件管理 import / 加载顺序。
 *
 * 依赖：statdata_engine.js（提供 CFS4 全局 + EVENTS / loadConfig）
 */

import { polyfilledApis as _cfsPolyfillReport } from '../compat/tavern_helper_polyfill.js';
import './statdata_engine.js'; // CFS4 init + L 全局 logger
void _cfsPolyfillReport;

// ============================================================
// 以下整段为 cfs_content_extracted.js L2595-3469（SFL + SSG 两 IIFE）
// ============================================================

/* ==========================================================
 * CFS v4.x: Schema Frozen Layer
 *
 * Hotfix:
 * 实测发现 TavernHelper 的 getLorebookEntries 返回的 entry 模型不含 `extensions` 字段
 * （ST 内部字段，对外暴露 29 个受控字段，无 extensions），导致 extensions.cfs.schema
 * 主锚点失效（写入时无效、读取时找不到）。降级方案：主锚点改用 comment 字段头部魔法串
 * [CFS4_SCHEMA|id=<id>|v=<ver>|sha=<sha>|sealed=<iso>]（comment 是 TavernHelper 透传字段）。
 * SHA256 兜底锚点不变，content 仍保持纯 canonical JSON。
 *
 * 协议契约 v3 §B 双锚点（hotfix 后）：
 * - 主锚点：entry.comment 头部魔法串（正则匹配）
 * - 兜底锚点：CFS 内部记录 (schema_id, ver) → sha256
 * - 任一失效 = 漂移 → emit cfs_schema_drift_detected + toast
 *
 * Canonical JSON 强制规范：
 * - key 字母序排列 / 缩进 2 空格 / 行尾 \n / undefined/NaN/Infinity 抛错
 * ==========================================================*/
(function () {
 'use strict';

 var _GLOBAL = (typeof window !== 'undefined' && window.parent) || (typeof window !== 'undefined' ? window : null);
 if (!_GLOBAL || !_GLOBAL.CFS4 || !_GLOBAL.CFS4._loaded) {
 console.warn('[CFS v4.x] CFS4 not initialized, abort');
 return;
 }
 if (_GLOBAL.CFS4.SchemaFrozenLayer && _GLOBAL.CFS4.SchemaFrozenLayer._version === '2.1') {
 console.warn('[CFS v4.x] SchemaFrozenLayer 2.1 already mounted, skip');
 return;
 }

 var CFS4 = _GLOBAL.CFS4;
 var L = CFS4.log;
 var SHA256_RECORDS_KEY = 'cfs_v4_schema_sha256_records';

 // ===== 0. comment 主锚点协议 =====
 // 格式：[CFS4_SCHEMA|id=<id>|v=<ver>|sha=<sha256>|sealed=<iso>] <人类可读说明>
 var CFS4_SCHEMA_COMMENT_RE = /^\[CFS4_SCHEMA\|id=([^|]+)\|v=([^|]+)\|sha=([0-9a-f]+)\|sealed=([^\]]+)\]/;

 function parseSchemaComment(comment) {
 if (!comment || typeof comment !== 'string') return null;
 var m = comment.match(CFS4_SCHEMA_COMMENT_RE);
 if (!m) return null;
 return { id: m[1], ver: m[2], sha256: m[3], sealed_at: m[4] };
 }

 function buildSchemaComment(meta) {
 return '[CFS4_SCHEMA|id=' + meta.id + '|v=' + meta.ver + '|sha=' + meta.sha256 + '|sealed=' + meta.sealed_at + '] CFS v4.x 自管 — 勿改本注释前缀和 content（双锚点保护，改了会触发漂移警报）';
 }

 // ===== 1. Canonical JSON 序列化 =====
 function canonicalize(obj) { return _canonicalSerialize(obj, 0); }

 function _canonicalSerialize(value, indent) {
 if (value === null) return 'null';
 if (value === undefined) throw new Error('canonicalize: undefined not allowed (schema 必须显式 null)');
 var t = typeof value;
 if (t === 'boolean') return value ? 'true' : 'false';
 if (t === 'number') {
 if (!isFinite(value)) throw new Error('canonicalize: NaN/Infinity not allowed');
 return JSON.stringify(value);
 }
 if (t === 'string') return JSON.stringify(value);
 if (Array.isArray(value)) {
 if (value.length === 0) return '[]';
 var arrPad = _spaces((indent + 1) * 2);
 var arrClose = _spaces(indent * 2);
 var items = [];
 for (var i = 0; i < value.length; i++) {
 items.push(arrPad + _canonicalSerialize(value[i], indent + 1));
 }
 return '[\n' + items.join(',\n') + '\n' + arrClose + ']';
 }
 if (t === 'object') {
 var keys = Object.keys(value).sort();
 if (keys.length === 0) return '{}';
 var objPad = _spaces((indent + 1) * 2);
 var objClose = _spaces(indent * 2);
 var pairs = [];
 for (var k = 0; k < keys.length; k++) {
 var key = keys[k];
 pairs.push(objPad + JSON.stringify(key) + ': ' + _canonicalSerialize(value[key], indent + 1));
 }
 return '{\n' + pairs.join(',\n') + '\n' + objClose + '}';
 }
 throw new Error('canonicalize: unsupported type ' + t);
 }

 function _spaces(n) { var s = ''; for (var i = 0; i < n; i++) s += ' '; return s; }

 // ===== 2. SHA256 hex =====
 async function sha256Hex(str) {
 var subtle = (_GLOBAL.crypto && _GLOBAL.crypto.subtle) ||
 (typeof crypto !== 'undefined' && crypto.subtle) || null;
 if (!subtle) throw new Error('Web Crypto API 不可用');
 var enc = new TextEncoder();
 var buf = enc.encode(str);
 var hashBuf = await subtle.digest('SHA-256', buf);
 var bytes = new Uint8Array(hashBuf);
 var hex = '';
 for (var i = 0; i < bytes.length; i++) {
 var b = bytes[i].toString(16);
 hex += b.length < 2 ? '0' + b : b;
 }
 return hex;
 }

 // ===== 3. SHA256 records 兜底锚点持久化 =====
 function _recordKey(schemaId, ver) { return schemaId + ':v' + ver; }

 function loadSha256Records() {
 try {
 if (typeof getVariables !== 'function') return {};
 var sv = getVariables({ type: 'script', script_id: getScriptId() });
 return (sv && sv[SHA256_RECORDS_KEY]) || {};
 } catch (e) { L.warn('loadSha256Records failed', e); return {}; }
 }

 function saveSha256Record(schemaId, ver, sha256) {
 try {
 if (typeof updateVariablesWith !== 'function') return false;
 updateVariablesWith(function (vars) {
 if (!vars || typeof vars !== 'object') vars = {};
 if (!vars[SHA256_RECORDS_KEY] || typeof vars[SHA256_RECORDS_KEY] !== 'object') vars[SHA256_RECORDS_KEY] = {};
 vars[SHA256_RECORDS_KEY][_recordKey(schemaId, ver)] = sha256;
 return vars;
 }, { type: 'script', script_id: getScriptId() });
 return true;
 } catch (e) { L.error('saveSha256Record failed', e); return false; }
 }

 function removeSha256Record(schemaId, ver) {
 try {
 updateVariablesWith(function (vars) {
 if (vars && vars[SHA256_RECORDS_KEY]) delete vars[SHA256_RECORDS_KEY][_recordKey(schemaId, ver)];
 return vars;
 }, { type: 'script', script_id: getScriptId() });
 } catch (e) { L.warn('removeSha256Record failed', e); }
 }

 // ===== 4. 当前 worldbook =====
 async function getActiveWorldbook() {
 if (typeof TavernHelper === 'undefined' || !TavernHelper.getCharLorebooks) throw new Error('TavernHelper.getCharLorebooks 不可用');
 var bind;
 try { bind = TavernHelper.getCharLorebooks({ name: 'current' }); }
 catch (e) { throw new Error('getCharLorebooks 失败: ' + e.message); }
 if (!bind || !bind.primary) throw new Error('当前角色卡未绑定 primary worldbook');
 return bind.primary;
 }

 // ===== 5. 主锚点：comment 魔法串匹配（支持 ver 精确过滤实现双轨并存）=====
 // 签名：findEntryBySchemaId(schemaId, optionsOrWorldbook)
 // options = { ver?: number|string, worldbook?: string }
 // 兼容旧调用：第二参数是 string → 当 worldbook 用
 async function findEntryBySchemaId(schemaId, optionsOrWorldbook) {
 var opts = {};
 if (typeof optionsOrWorldbook === 'string') opts.worldbook = optionsOrWorldbook;
 else if (optionsOrWorldbook && typeof optionsOrWorldbook === 'object') opts = optionsOrWorldbook;
 var wb = opts.worldbook || await getActiveWorldbook();
 var entries;
 try { entries = await TavernHelper.getLorebookEntries(wb); }
 catch (e) { throw new Error('getLorebookEntries 失败: ' + e.message); }
 for (var i = 0; i < entries.length; i++) {
 var e = entries[i];
 var meta = parseSchemaComment(e.comment);
 if (!meta) continue;
 if (meta.id !== schemaId) continue;
 if (opts.ver != null && String(meta.ver) !== String(opts.ver)) continue;
 return { entry: e, worldbook: wb, parsedMeta: meta };
 }
 return null;
 }

 // ===== 6. 双锚点校验 =====
 async function verifyAnchors(entry, schemaId, parsedMeta) {
 var result = { ok: true, mainAnchor: true, hashAnchor: true, positionAnchor: true, reason: null };
 var meta = parsedMeta || parseSchemaComment(entry && entry.comment);
 if (!meta || meta.id !== schemaId) {
 result.ok = false; result.mainAnchor = false;
 result.reason = 'main anchor (comment marker) missing or id mismatch';
 return result;
 }
 var recordedSha = null;
 try {
 var records = loadSha256Records();
 recordedSha = records[_recordKey(schemaId, meta.ver)] || null;
 } catch (_e) {}
 if (!recordedSha) recordedSha = meta.sha256 || null;
 if (!recordedSha) {
 result.ok = false; result.hashAnchor = false;
 result.reason = 'no sha256 record (internal lost + comment.sha missing)';
 return result;
 }
 var actualSha;
 try { actualSha = await sha256Hex(entry.content || ''); }
 catch (e) {
 result.ok = false; result.hashAnchor = false;
 result.reason = 'sha256 compute failed: ' + e.message;
 return result;
 }
 if (actualSha !== recordedSha) {
 result.ok = false; result.hashAnchor = false;
 result.reason = 'sha256 mismatch (actual=' + actualSha.slice(0, 12) + '... recorded=' + recordedSha.slice(0, 12) + '...)';
 return result;
 }
 // hotfix v2.2 第四锚点：position/role 校验 — 防外部脚本（WM 等）改坏 entry 位置
 // hotfix v2.8.1：兼容字符串别名（TavernHelper 返回 'before_character_definition' / 'at_depth_as_user' 等）
 //                以及 DYNAMIC entry role=null/undefined 的容忍
 try {
 var ext = entry && entry.extensions && entry.extensions.cfs;
 var expectedPos = (ext && typeof ext.expected_position === 'number') ? ext.expected_position : 0;
 var expectedRole = (ext && typeof ext.expected_role === 'number') ? ext.expected_role : 0;
 // 字符串别名映射
 var _POS_MAP = {
 'before_character_definition': 0, 'after_character_definition': 1,
 'an_top': 2, 'an_bottom': 3, 'at_depth': 4, 'at_depth_as_user': 4,
 'em_top': 5, 'em_bottom': 6, 'outlet': 7
 };
 var actualPos;
 if (typeof entry.position === 'number') actualPos = entry.position;
 else if (typeof entry.position === 'string' && _POS_MAP[entry.position] !== undefined) actualPos = _POS_MAP[entry.position];
 else actualPos = -1;
 // role: null/undefined 视为期望值（TavernHelper at_depth_as_user 模式下 role 可能 null）
 var actualRole;
 if (entry.role == null) actualRole = expectedRole;
 else actualRole = entry.role;
 if (actualPos !== expectedPos || actualRole !== expectedRole) {
 result.ok = false; result.positionAnchor = false;
 result.reason = 'position drift: expected pos=' + expectedPos + ' role=' + expectedRole
 + ', actual pos=' + actualPos + ' role=' + actualRole + ' (raw=' + JSON.stringify(entry.position) + ') (外部脚本改了位置)';
 return result;
 }
 } catch (_e2) { /* 容错：position 校验失败不阻断整体 verify */ }
 return result;
 }

 // ===== 7. writeSchema =====
 async function writeSchema(schemaObj, opts) {
 opts = opts || {};
 var schemaId = opts.schemaId;
 var ver = opts.ver;
 if (!schemaId || typeof schemaId !== 'string') throw new Error('writeSchema: opts.schemaId 必填');
 if (typeof ver !== 'number' && typeof ver !== 'string') throw new Error('writeSchema: opts.ver 必填');
 if (!schemaObj || typeof schemaObj !== 'object') throw new Error('writeSchema: schemaObj 必须是 object');

 var wb = await getActiveWorldbook();
 var canonical = canonicalize(schemaObj);
 var sha = await sha256Hex(canonical);
 var sealed_at = new Date().toISOString();
 var meta = { id: schemaId, ver: ver, sha256: sha, sealed_at: sealed_at };
 var comment = buildSchemaComment(meta);

 // 默认 disabled (storage mode) — schema entry 不进 prompt，避免 worldInfoBefore 暴涨
 // opts.injectable=true 才 enabled=true（元规则 lore 等需要 LLM 看到的 entry）
 var _injectable = opts.injectable === true;
 // hotfix v2.8（字符串别名反转）：
 //   v2.2 改成数字 position=0 实测有问题（TavernHelper 不接受数字，部分 ST 路径下默认值兜底）
 //   v2.8 改回字符串 'before_character_definition' —— TavernHelper 接受字符串别名
 //   keys 加 '_cfs4_position_locked' 告知 WM 等外部脚本：勿改 position
 //   extensions.cfs.expected_position 记录数字期望值（0），供 audit 校验
 var entryPayload = {
 comment: comment,
 content: canonical,
 enabled: _injectable,
 constant: true,
 type: 'constant',
 position: 'before_character_definition',   // 字符串别名 — TavernHelper 翻译为 pos=0
 role: 0,                                     // 0 = system role
 depth: 4,                                    // 对 pos=before_char_def 无影响
 order: 100,
 keys: ['_cfs4_managed', '_cfs4_position_locked'],
 extensions: { cfs: { managed: true, schema_id: schemaId, ver: ver, expected_position: 0, expected_role: 0 } }
 };

 var existing = await findEntryBySchemaId(schemaId, { worldbook: wb, ver: ver });
 var entryUid = null;
 var action;

 if (existing) {
 entryPayload.uid = existing.entry.uid;
 entryUid = existing.entry.uid;
 action = 'update';
 try { await TavernHelper.setLorebookEntries(wb, [entryPayload]); }
 catch (e) { L.error('writeSchema setLorebookEntries (update) failed', e); throw e; }
 } else {
 action = 'create';
 var created = false;
 var errs = [];

 if (!created && typeof TavernHelper.createLorebookEntries === 'function') {
 try {
 var res = await TavernHelper.createLorebookEntries(wb, [entryPayload]);
 if (Array.isArray(res) && res.length > 0) {
 entryUid = (res[0] && res[0].uid != null) ? res[0].uid : (typeof res[0] === 'number' ? res[0] : null);
 }
 created = true;
 } catch (e) { errs.push('createLorebookEntries: ' + e.message); }
 }
 if (!created && typeof TavernHelper.createLorebookEntry === 'function') {
 try {
 var res2 = await TavernHelper.createLorebookEntry(wb, entryPayload);
 if (res2 && res2.uid != null) entryUid = res2.uid;
 else if (typeof res2 === 'number') entryUid = res2;
 created = true;
 } catch (e) { errs.push('createLorebookEntry: ' + e.message); }
 }
 if (!created) {
 try {
 await TavernHelper.setLorebookEntries(wb, [entryPayload]);
 created = true;
 } catch (e) { errs.push('setLorebookEntries (no uid): ' + e.message); }
 }
 if (!created) throw new Error('writeSchema 创建 entry 失败：' + errs.join(' | '));

 // 兜底：如果创建路径没返回 uid，通过 (schemaId, ver) 反查
 if (entryUid == null) {
 try {
 var fb = await findEntryBySchemaId(schemaId, { worldbook: wb, ver: ver });
 if (fb) entryUid = fb.entry.uid;
 } catch (_e) {}
 }
 }

 saveSha256Record(schemaId, ver, sha);
 CFS4.emit(CFS4.EVENTS.SCHEMA_FROZEN, {
 schema_id: schemaId, ver: ver, sha256: sha, sealed_at: sealed_at,
 uid: entryUid, worldbook: wb, action: action
 });
 L.info('writeSchema ' + action + ': ' + schemaId + ' v' + ver + ' sha=' + sha.slice(0, 16) + '... uid=' + entryUid);
 return { schema_id: schemaId, ver: ver, sha256: sha, sealed_at: sealed_at, uid: entryUid, worldbook: wb, action: action };
 }

 // ===== 8. readSchema =====
 async function readSchema(schemaId) {
 if (!schemaId) throw new Error('readSchema: schemaId 必填');
 var found;
 try { found = await findEntryBySchemaId(schemaId); }
 catch (e) { L.warn('readSchema: find entry failed - ' + e.message); return null; }
 if (!found) { L.debug('readSchema: ' + schemaId + ' not found'); return null; }

 var verify = await verifyAnchors(found.entry, schemaId, found.parsedMeta);
 if (!verify.ok) {
 var payload = {
 schema_id: schemaId, uid: found.entry.uid, worldbook: found.worldbook,
 main_anchor_ok: verify.mainAnchor, hash_anchor_ok: verify.hashAnchor, reason: verify.reason
 };
 CFS4.emit(CFS4.EVENTS.SCHEMA_DRIFT_DETECTED, payload);
 L.error('SCHEMA DRIFT: ' + schemaId + ' - ' + verify.reason, payload);
 try {
 var cfg = CFS4._cfg || {};
 if (cfg.drift_toast_enabled !== false) {
 var _nc = (_GLOBAL && _GLOBAL.CFS4 && _GLOBAL.CFS4.NotificationCenter) || null;
 if (_nc) _nc.notify('drift', { schema_id: schemaId, reason: verify.reason });
 }
 } catch (_e) {}
 return null;
 }

 var parsed;
 try { parsed = JSON.parse(found.entry.content); }
 catch (e) {
 L.error('readSchema: canonical JSON parse failed - ' + e.message);
 CFS4.emit(CFS4.EVENTS.SCHEMA_DRIFT_DETECTED, {
 schema_id: schemaId, uid: found.entry.uid, worldbook: found.worldbook,
 reason: 'JSON parse failed: ' + e.message
 });
 return null;
 }
 return { schema: parsed, meta: found.parsedMeta, uid: found.entry.uid, worldbook: found.worldbook };
 }

 // ===== 9. removeSchema (按 ver 精确匹配，防止误关 active) =====
 async function removeSchema(schemaId, ver) {
 // ver 必填，否则可能误关其他版本的 entry
 var found = await findEntryBySchemaId(schemaId, ver != null ? { ver: ver } : undefined);
 if (!found) return false;
 try { await TavernHelper.setLorebookEntries(found.worldbook, [{ uid: found.entry.uid, enabled: false }]); }
 catch (e) { L.warn('removeSchema disable failed', e); }
 if (ver != null) removeSha256Record(schemaId, ver);
 return true;
 }

 // ===== 10. listManagedEntries =====
 async function listManagedEntries() {
 var wb = await getActiveWorldbook();
 var entries = await TavernHelper.getLorebookEntries(wb);
 var managed = [];
 for (var i = 0; i < entries.length; i++) {
 var e = entries[i];
 var meta = parseSchemaComment(e.comment);
 if (meta) {
 managed.push({
 uid: e.uid, schema_id: meta.id, ver: meta.ver, sealed_at: meta.sealed_at,
 sha256: meta.sha256, enabled: e.enabled, contentLen: (e.content || '').length, comment: e.comment
 });
 }
 }
 return { worldbook: wb, entries: managed };
 }

 // ===== 11. cleanupLegacyEntries=====
 async function cleanupLegacyEntries() {
 var wb = await getActiveWorldbook();
 var entries = await TavernHelper.getLorebookEntries(wb);
 var disabled = [];
 var errors = [];
 for (var i = 0; i < entries.length; i++) {
 var e = entries[i];
 // alpha 的旧 comment 前缀是 [_cfs_schema_xxx]，且不含新版 [CFS4_SCHEMA|
 if (e.comment && e.comment.indexOf('[_cfs_schema_') === 0 && e.comment.indexOf('[CFS4_SCHEMA|') < 0) {
 try {
 await TavernHelper.setLorebookEntries(wb, [{
 uid: e.uid,
 enabled: false,
 comment: '[CFS4_LEGACY_DISABLED_v20alpha] ' + e.comment
 }]);
 disabled.push({ uid: e.uid, oldComment: e.comment });
 } catch (err) {
 errors.push({ uid: e.uid, error: err.message });
 }
 }
 }
 L.info('cleanupLegacyEntries: disabled=' + disabled.length + ' errors=' + errors.length);
 return { worldbook: wb, disabled: disabled, errors: errors };
 }

 // ===== 12. Default schema 模板 =====
 function buildDefaultSchemaTemplate() {
 return {
 '_$cfs_meta': {
 version: 1,
 description: 'CFS v4.x default minimal schema',
 convention: '所有 stat_data 路径在 paths 字段中注册，每个 path 携带 type 和 default'
 },
 paths: {}
 };
 }

 // ===== 13. selfTest =====
 async function selfTest(schemaId) {
 var ids = CFS4.getSchemaIds();
 var sid = schemaId || ids.primary;
 L.info('selfTest 开始: ' + sid);
 var template = buildDefaultSchemaTemplate();
 var wResult = await writeSchema(template, { schemaId: sid, ver: 1 });
 L.info('selfTest write ok', wResult);
 var rResult = await readSchema(sid);
 L.info('selfTest read ok', rResult);
 var listResult = await listManagedEntries();
 L.info('selfTest list ok', listResult);
 return { write: wResult, read: rResult, list: listResult };
 }

 // ===== 14. 导出 =====
 CFS4.SchemaFrozenLayer = {
 _version: '2.1',
 canonicalize: canonicalize,
 sha256Hex: sha256Hex,
 parseSchemaComment: parseSchemaComment,
 buildSchemaComment: buildSchemaComment,
 getActiveWorldbook: getActiveWorldbook,
 findEntryBySchemaId: findEntryBySchemaId,
 verifyAnchors: verifyAnchors,
 writeSchema: writeSchema,
 readSchema: readSchema,
 removeSchema: removeSchema,
 listManagedEntries: listManagedEntries,
 buildDefaultSchemaTemplate: buildDefaultSchemaTemplate,
 cleanupLegacyEntries: cleanupLegacyEntries,
 loadSha256Records: loadSha256Records,
 selfTest: selfTest
 };

 L.info('Schema Frozen Layer mounted');
})();

/* ==========================================================
 * CFS v4.x: Schema Swap Gate
 * (mutation debounce layer · T_w 时间驱动 · pending → active 决策门)
 *
 * 协议契约 v3 §E：
 * - 职责钉死：只控制 schema 从 pending → active 的决策。
 * 不承担 diff 延迟、不承担全局节流、不承担其他模块防抖。
 * 不接受任何非 schema 触发源。
 * - 状态机：[active v] → propose → [active v, pending v+1]
 * → (commit | rollback | T_w 到期) → lazy swap
 * → [active v+1, deprecated v] → 一轮回滚窗口 → [active v+1]
 * - T_w 默认 90s，可配 30 ~ 600，仅控制 pending → active gate
 * - 跟 Diff Engine 完全异步解耦（diff 始终针对当前 active schema）
 *
 * 持久化：gate state 存到 getVariables({type:'script'}) 的
 * cfs_v4_swap_gate_state key，跨 F5 恢复
 * ==========================================================*/
(function () {
 'use strict';

 var _GLOBAL = (typeof window !== 'undefined' && window.parent) || (typeof window !== 'undefined' ? window : null);
 if (!_GLOBAL || !_GLOBAL.CFS4 || !_GLOBAL.CFS4._loaded) {
 console.warn('[CFS v4.x] CFS4 not initialized, abort');
 return;
 }
 if (_GLOBAL.CFS4.SchemaSwapGate && _GLOBAL.CFS4.SchemaSwapGate._version) {
 console.warn('[CFS v4.x] SchemaSwapGate already mounted, skip');
 return;
 }
 if (!_GLOBAL.CFS4.SchemaFrozenLayer) {
 console.warn('[CFS v4.x] 依赖 SchemaFrozenLayer 未就绪，abort');
 return;
 }

 var CFS4 = _GLOBAL.CFS4;
 var L = CFS4.log;
 var SFL = CFS4.SchemaFrozenLayer;
 var GATE_STATE_KEY = 'cfs_v4_swap_gate_state';

 // ===== 0. 内存 state 缓存 =====
 // state 结构：{ '<schema_id>': { active, pending, deprecated, swap_timer_id } }
 // active = { ver, sha256, sealed_at, uid } | null
 // pending = { ver, sha256, sealed_at, uid, swap_at_iso } | null
 // deprecated = { ver, sha256, sealed_at, uid, rounds_remaining } | null (rounds_remaining = 1 / 0 / -1)
 // swap_timer_id 内存态不持久化（F5 后通过 swap_at_iso 比对当前时间重建）
 var _state = {};
 var _timerHandles = {}; // { schema_id: setTimeout handle }
 var _depRoundCounter = {}; // { schema_id: 用于 deprecated 倒计时 }

 // ===== 1. State 持久化 =====
 function _persistState() {
 try {
 if (typeof updateVariablesWith !== 'function') return false;
 // 持久化时去掉 swap_timer_id（内存态）
 var persistable = {};
 var keys = Object.keys(_state);
 for (var i = 0; i < keys.length; i++) {
 var s = _state[keys[i]];
 persistable[keys[i]] = {
 active: s.active || null,
 pending: s.pending || null,
 deprecated: s.deprecated || null
 };
 }
 updateVariablesWith(function (vars) {
 if (!vars || typeof vars !== 'object') vars = {};
 vars[GATE_STATE_KEY] = persistable;
 return vars;
 }, { type: 'script', script_id: getScriptId() });
 return true;
 } catch (e) {
 L.error('SwapGate persist failed', e);
 return false;
 }
 }

 function _loadState() {
 try {
 if (typeof getVariables !== 'function') return {};
 var sv = getVariables({ type: 'script', script_id: getScriptId() });
 return (sv && sv[GATE_STATE_KEY]) || {};
 } catch (e) {
 L.warn('SwapGate loadState failed', e);
 return {};
 }
 }

 // ===== 2. 工具：当前时间 + T_w =====
 function _now() { return new Date().toISOString(); }
 function _getTw() {
 var cfg = CFS4._cfg || {};
 var t = cfg.swap_gate_T_w_seconds;
 if (typeof t !== 'number' || t < 30) t = 90;
 if (t > 600) t = 600;
 return t;
 }

 // ===== 3. 当前 active 引用=====
 function getActiveRef(schemaId) {
 var s = _state[schemaId];
 if (!s || !s.active) return null;
 return Object.assign({ schema_id: schemaId }, s.active);
 }

 function getPendingRef(schemaId) {
 var s = _state[schemaId];
 if (!s || !s.pending) return null;
 return Object.assign({ schema_id: schemaId }, s.pending);
 }

 function getDeprecatedRef(schemaId) {
 var s = _state[schemaId];
 if (!s || !s.deprecated) return null;
 return Object.assign({ schema_id: schemaId }, s.deprecated);
 }

 function getState(schemaId) {
 if (schemaId) return _state[schemaId] || null;
 return _state;
 }

 // ===== 4. propose：用户改 schema，进入 pending 状态 =====
 async function propose(schemaObj, opts) {
 opts = opts || {};
 var schemaId = opts.schemaId;
 var ver = opts.ver;
 if (!schemaId || typeof schemaId !== 'string') throw new Error('propose: opts.schemaId 必填');
 if (typeof ver !== 'number' && typeof ver !== 'string') throw new Error('propose: opts.ver 必填');

 // 验证 ver 比 active.ver 大
 var current = _state[schemaId];
 if (current && current.active) {
 var aVer = parseFloat(current.active.ver);
 var nVer = parseFloat(ver);
 if (!isNaN(aVer) && !isNaN(nVer) && nVer <= aVer) {
 throw new Error('propose: 新 ver (' + ver + ') 必须大于当前 active.ver (' + current.active.ver + ')');
 }
 }
 if (current && current.pending) {
 throw new Error('propose: schema ' + schemaId + ' 已有 pending v' + current.pending.ver + '，请先 commit 或 rollback');
 }

 // 调 SchemaFrozenLayer.writeSchema 写入新版本
 var w = await SFL.writeSchema(schemaObj, { schemaId: schemaId, ver: ver });

 // 计算 swap_at
 var Tw = _getTw();
 var swapAtMs = Date.now() + Tw * 1000;
 var swapAtIso = new Date(swapAtMs).toISOString();

 // 更新 state
 if (!_state[schemaId]) _state[schemaId] = { active: null, pending: null, deprecated: null };
 _state[schemaId].pending = {
 ver: ver, sha256: w.sha256, sealed_at: w.sealed_at, uid: w.uid, swap_at_iso: swapAtIso
 };

 // 如果当前没有 active（首次 propose），直接立即提升为 active（不走 T_w）
 if (!_state[schemaId].active) {
 L.info('propose: ' + schemaId + ' 首次写入，无 active，直接提升为 active 不走 T_w');
 _state[schemaId].active = _state[schemaId].pending;
 _state[schemaId].pending = null;
 _persistState();
 CFS4.emit(CFS4.EVENTS.SCHEMA_SWAP_COMMITTED, {
 schema_id: schemaId, ver: ver, sha256: w.sha256,
 commit_reason: 'initial', uid: w.uid
 });
 return { status: 'active', schema_id: schemaId, ver: ver, sha256: w.sha256 };
 }

 // 启动 T_w 定时器
 _scheduleAutoSwap(schemaId, Tw);
 _persistState();

 L.info('propose: ' + schemaId + ' v' + ver + ' 进入 pending，T_w=' + Tw + 's，swap_at=' + swapAtIso);
 CFS4.emit(CFS4.EVENTS.SCHEMA_SWAP_PENDING, {
 schema_id: schemaId, ver: ver, sha256: w.sha256, swap_at_iso: swapAtIso, T_w: Tw, uid: w.uid
 });
 return { status: 'pending', schema_id: schemaId, ver: ver, swap_at_iso: swapAtIso, T_w: Tw };
 }

 // ===== 5. 定时器：T_w 到期自动 swap =====
 function _scheduleAutoSwap(schemaId, delaySec) {
 if (_timerHandles[schemaId]) {
 clearTimeout(_timerHandles[schemaId]);
 delete _timerHandles[schemaId];
 }
 _timerHandles[schemaId] = setTimeout(function () {
 delete _timerHandles[schemaId];
 _lazySwap(schemaId, 'timeout').catch(function (e) {
 L.error('autoSwap failed for ' + schemaId, e);
 });
 }, delaySec * 1000);
 }

 // ===== 6. lazySwap：pending → active；旧 active → deprecated =====
 async function _lazySwap(schemaId, reason) {
 var s = _state[schemaId];
 if (!s || !s.pending) {
 L.warn('_lazySwap: no pending for ' + schemaId);
 return false;
 }
 var oldActive = s.active;
 var newActive = s.pending;
 s.active = newActive;
 s.pending = null;
 if (oldActive) {
 s.deprecated = Object.assign({}, oldActive, { rounds_remaining: 1 });
 // 重置 deprecated 轮次计数
 _depRoundCounter[schemaId] = 0;
 } else {
 s.deprecated = null;
 }
 _persistState();

 L.info('lazySwap [' + (reason || 'unknown') + ']: ' + schemaId
 + ' active=v' + newActive.ver
 + (oldActive ? ', deprecated=v' + oldActive.ver + ' (一轮回滚窗口)' : ''));
 CFS4.emit(CFS4.EVENTS.SCHEMA_SWAP_COMMITTED, {
 schema_id: schemaId,
 from_ver: oldActive ? oldActive.ver : null,
 to_ver: newActive.ver,
 sha256: newActive.sha256,
 reason: reason || 'unknown',
 has_deprecated_window: !!oldActive
 });
 return true;
 }

 // ===== 7. commit：用户显式 commit，绕过 T_w =====
 async function commit(schemaId) {
 if (!schemaId) throw new Error('commit: schemaId 必填');
 var s = _state[schemaId];
 if (!s || !s.pending) {
 L.warn('commit: no pending for ' + schemaId);
 return false;
 }
 if (_timerHandles[schemaId]) {
 clearTimeout(_timerHandles[schemaId]);
 delete _timerHandles[schemaId];
 }
 return _lazySwap(schemaId, 'explicit_commit');
 }

 // ===== 8. rollback：用户显式 rollback，删 pending =====
 async function rollback(schemaId) {
 if (!schemaId) throw new Error('rollback: schemaId 必填');
 var s = _state[schemaId];
 if (!s || !s.pending) {
 L.warn('rollback: no pending for ' + schemaId);
 return false;
 }
 if (_timerHandles[schemaId]) {
 clearTimeout(_timerHandles[schemaId]);
 delete _timerHandles[schemaId];
 }
 var pendingRef = s.pending;
 s.pending = null;
 _persistState();
 // disable pending entry
 try {
 await SFL.removeSchema(schemaId, pendingRef.ver);
 } catch (e) { L.warn('rollback: removeSchema failed', e); }
 L.info('rollback: ' + schemaId + ' pending v' + pendingRef.ver + ' 已撤销');
 CFS4.emit(CFS4.EVENTS.SCHEMA_SWAP_ROLLED_BACK, {
 schema_id: schemaId, rolled_back_ver: pendingRef.ver
 });
 return true;
 }

 // ===== 9. deprecated 一轮回滚窗口对齐 generate_before_combine_prompts =====
 // 第一次触发：标记本轮已用，留用户最后机会
 // 第二次触发：disable deprecated entry，state.deprecated = null
 function _onGenerateBeforeCombine() {
 var keys = Object.keys(_state);
 for (var i = 0; i < keys.length; i++) {
 var sid = keys[i];
 var s = _state[sid];
 if (!s || !s.deprecated) continue;
 _depRoundCounter[sid] = (_depRoundCounter[sid] || 0) + 1;
 if (_depRoundCounter[sid] === 1) {
 L.debug('deprecated [' + sid + '] 第 1 轮窗口，下一轮才真正 disable');
 } else if (_depRoundCounter[sid] >= 2) {
 var dep = s.deprecated;
 L.info('deprecated [' + sid + '] 窗口耗尽，disable v' + dep.ver);
 s.deprecated = null;
 _depRoundCounter[sid] = 0;
 _persistState();
 // 异步 disable 旧 entry（不阻塞 prompt 拼装）
 SFL.removeSchema(sid, dep.ver).catch(function (e) {
 L.warn('deprecated disable failed for ' + sid, e);
 });
 }
 }
 }

 // ===== 10. boot：从持久化恢复 state =====
 function _bootRestore() {
 var loaded = _loadState();
 var sids = Object.keys(loaded);
 for (var i = 0; i < sids.length; i++) {
 var sid = sids[i];
 _state[sid] = {
 active: loaded[sid].active || null,
 pending: loaded[sid].pending || null,
 deprecated: loaded[sid].deprecated || null
 };
 // 如果有 pending 且 swap_at 已过期 → 立即 lazySwap
 if (_state[sid].pending && _state[sid].pending.swap_at_iso) {
 var swapAt = new Date(_state[sid].pending.swap_at_iso).getTime();
 var now = Date.now();
 if (swapAt <= now) {
 L.info('boot: ' + sid + ' pending 已过期 (swap_at=' + _state[sid].pending.swap_at_iso + ')，立即 lazySwap');
 _lazySwap(sid, 'boot_expired').catch(function (e) {
 L.error('boot lazySwap failed', e);
 });
 } else {
 var remainSec = Math.ceil((swapAt - now) / 1000);
 L.info('boot: ' + sid + ' pending 重建定时器，剩余 ' + remainSec + 's');
 _scheduleAutoSwap(sid, remainSec);
 }
 }
 }
 L.info('SwapGate boot: 恢复 ' + sids.length + ' 条 schema state');
 }

 // ===== 11. selfTest（F12 调试用）=====
 async function selfTest() {
 var ids = CFS4.getSchemaIds();
 var sid = ids.primary + '::swap_test'; // 隔离测试 schema_id 避免影响真实数据
 var t1 = SFL.buildDefaultSchemaTemplate();
 t1.paths['test.a'] = { type: 'string', default: 'v1' };
 var t2 = SFL.buildDefaultSchemaTemplate();
 t2.paths['test.a'] = { type: 'string', default: 'v2' };

 L.info('selfTest: propose v1 (首次，应直接 active)');
 var r1 = await propose(t1, { schemaId: sid, ver: 1 });
 L.info(' → state:', getState(sid));

 L.info('selfTest: propose v2 (应进入 pending)');
 var r2 = await propose(t2, { schemaId: sid, ver: 2 });
 L.info(' → state:', getState(sid));

 L.info('selfTest: explicit commit v2');
 var r3 = await commit(sid);
 L.info(' → state:', getState(sid));
 L.info(' active 现在应是 v2，deprecated 应是 v1（rounds_remaining=1）');

 // 不实际触发 generate_before_combine_prompts，跑完测试后留状态供观察
 return { initial: r1, pending: r2, committed: r3, finalState: getState(sid) };
 }

 // ===== 12. cleanup（测试后清理 swap_test schema 残留）=====
 async function cleanupSwapTest() {
 var ids = CFS4.getSchemaIds();
 var sid = ids.primary + '::swap_test';
 var s = _state[sid];
 if (s) {
 if (s.active) try { await SFL.removeSchema(sid, s.active.ver); } catch (_e) {}
 if (s.pending) try { await SFL.removeSchema(sid, s.pending.ver); } catch (_e) {}
 if (s.deprecated) try { await SFL.removeSchema(sid, s.deprecated.ver); } catch (_e) {}
 delete _state[sid];
 _persistState();
 }
 return { cleaned: sid };
 }

 // ===== 13. 钩 generate_before_combine_prompts（跟 v3.1.7 PSIS 共存）=====
 try {
 if (typeof eventOn === 'function') {
 eventOn('generate_before_combine_prompts', _onGenerateBeforeCombine);
 }
 } catch (e) { L.warn('SwapGate hook generate_before_combine_prompts failed', e); }

 // ===== 14. boot 恢复持久化 state =====
 try { eventOnce('app_ready', _bootRestore); }
 catch (e) { setTimeout(_bootRestore, 1800); }
 // 兜底
 setTimeout(function () {
 if (Object.keys(_state).length === 0) _bootRestore();
 }, 2600);

 // ===== 15. 导出 =====
 CFS4.SchemaSwapGate = {
 _version: '3.0',
 propose: propose,
 commit: commit,
 rollback: rollback,
 getActiveRef: getActiveRef,
 getPendingRef: getPendingRef,
 getDeprecatedRef: getDeprecatedRef,
 getState: getState,
 getTw: _getTw,
 selfTest: selfTest,
 cleanupSwapTest: cleanupSwapTest
 };

 L.info('Schema Swap Gate mounted (T_w=' + _getTw() + 's)');
})();


// ============================================================
// ESM export — SchemaFrozenLayer + SchemaSwapGate
// ============================================================
export const SchemaFrozenLayer = window.CFS4?.SchemaFrozenLayer;
export const SchemaSwapGate = window.CFS4?.SchemaSwapGate;

console.log('[CFS-Suite/schema-layer] SFL + SSG ESM bridge OK');
