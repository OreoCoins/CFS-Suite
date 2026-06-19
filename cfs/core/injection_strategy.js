/**
 * CFS-Suite · core/injection_strategy.js
 *
 * 从 CFS v4.x（L4321-5271）整段迁移 — 含两个 IIFE：
 *   - Presence Encoder + Injection Strategy（L4321-4717，dry-run 阶段）
 *   - STABLE_BATCH + stability_class 协议进化（L4718-5271，升级前段）
 *
 * 协议契约 v3 §D：Stable Presence Token <STABLE ref="..."/> + STABLE_BATCH
 * 依赖：diff_engine.js / path_registry.js
 */
import { polyfilledApis as _r } from '../compat/tavern_helper_polyfill.js';
import './statdata_engine.js'; import './schema_layer.js'; import './path_registry.js'; import './diff_engine.js';
void _r;

/* ==========================================================
 * CFS v4.x: Presence Encoder + Injection Strategy
 * (dry-run 阶段)
 *
 * 协议契约 v3 §D：
 * - Stable Presence Token 格式：<STABLE ref="<schema_id>:<path_id>"/>
 * - 零 value payload（不带类型/hash/last_value/任何运行时信息）
 * - Injection Strategy 三层：schema / stable presence / mutable delta
 * - 钩 generate_before_combine_prompts（跟 v3.1.7 PSIS R1 抢跑钩共存）
 *
 * dry-run 边界：
 * - 实现编码器 + 注入字符串生成器
 * - 钩 generate_before_combine_prompts 只 log + emit，不改实际 prompt
 * - 未来讨论真正接管 stat_data 渲染（需用户拍板策略）
 *
 * 元规则 lore 内容（写在跟 schema 同区段独立 entry）：
 * 告诉 LLM "看到 <STABLE/> 标签 = 该字段值跨轮稳定，按 schema 中 ref
 * 指向的当前值理解，禁止凭对话上下文推断、改写或猜测"
 * ==========================================================*/
(function () {
 'use strict';

 var _GLOBAL = (typeof window !== 'undefined' && window.parent) || (typeof window !== 'undefined' ? window : null);
 if (!_GLOBAL || !_GLOBAL.CFS4 || !_GLOBAL.CFS4._loaded) {
 console.warn('[CFS v4.x] CFS4 not initialized, abort');
 return;
 }
 if (_GLOBAL.CFS4.PresenceEncoder && _GLOBAL.CFS4.InjectionStrategy) {
 console.warn('[CFS v4.x] PresenceEncoder/InjectionStrategy already mounted, skip');
 return;
 }
 if (!_GLOBAL.CFS4.DiffEngine) {
 console.warn('[CFS v4.x] 依赖未就绪，abort');
 return;
 }

 var CFS4 = _GLOBAL.CFS4;
 var L = CFS4.log;
 var DE = CFS4.DiffEngine;
 var PR = CFS4.PathRegistry;
 var SR = CFS4.SchemaResolver;
 var SFL = CFS4.SchemaFrozenLayer;

 // ===== PresenceEncoder =====
 var TOKEN_RE = /<STABLE\s+ref="([^"]+)"\s*\/>/g;
 var TOKEN_RE_ONE = /<STABLE\s+ref="([^"]+)"\s*\/>/;

 function encodeToken(schemaId, pathId) {
 if (!schemaId || !pathId) throw new Error('encodeToken: schemaId + pathId 必填');
 return '<STABLE ref="' + schemaId + ':' + pathId + '"/>';
 }

 function encodeManyTokens(schemaId, pathIds) {
 if (!Array.isArray(pathIds)) return '';
 var out = [];
 for (var i = 0; i < pathIds.length; i++) {
 out.push(encodeToken(schemaId, pathIds[i]));
 }
 return out.join('');
 }

 function decodeToken(tokenStr) {
 if (!tokenStr) return null;
 var m = TOKEN_RE_ONE.exec(tokenStr);
 if (!m) return null;
 var ref = m[1];
 // 用 lastIndexOf(':') 切 schema_id / path_id（schema_id 含 :primary 后缀）
 var p = SR.parsePathRef(ref);
 return p ? { schema_id: p.schema_id, path_id: p.path_id } : null;
 }

 // 从一段文本里提取所有 token
 function extractAllTokens(text) {
 if (!text) return [];
 var tokens = [];
 var m;
 var re = new RegExp(TOKEN_RE.source, 'g');
 while ((m = re.exec(text)) !== null) {
 var p = SR.parsePathRef(m[1]);
 if (p) tokens.push({ token: m[0], schema_id: p.schema_id, path_id: p.path_id });
 }
 return tokens;
 }

 // ===== 元规则 lore 内容 =====
 function buildMetaRuleLore() {
 return [
 '# CFS v4.x Stable Presence 协议（自动注入，勿修改）',
 '',
 '## 看到 `<STABLE ref="..."/>` 标签时：',
 '',
 '该字段的值**跨轮稳定**（上轮、上上轮、若干轮以来均未变化），按 schema 中 ref',
 '指向的当前值理解。**禁止**凭对话上下文推断、改写或猜测该值。任何"我记得这个值',
 '是 X"的内部推理在此标签前一律作废。',
 '',
 '## 看到本轮变化字段（"mutable delta"）时：',
 '',
 '这是本轮**真正变了**的字段，按字面值理解，是新事实。',
 '',
 '## 未出现的字段（既没 `<STABLE/>` 也没在 delta 里出现）',
 '',
 '默认与上轮一致，不要主动添加或推断新字段。在 `<UpdateVariable>` 输出时，',
 '只对真正变了的字段使用 JSONPatch op（replace/add/remove），其他字段保持沉默。',
 '',
 '## 严禁的输出模式',
 '',
 '- 把 `<STABLE/>` 标签复制到自己输出里（这是给你读的，不是给你重发的）。',
 '- 给一个 `<STABLE/>` 标签指向的字段"补一个值"（值由 schema 维护，禁止覆盖）。',
 '- 把"这个字段当前值是什么"作为对话话题展开。',
 ''
 ].join('\n');
 }

 // 元规则 lore 在 worldbook 内的 schema_id
 function metaRuleSchemaId() {
 var ids = CFS4.getSchemaIds();
 return ids.primary + '::meta_rule';
 }

 // 确保元规则 lore 存在于 worldbook（schema entry 同区段，独立 lore）
 // 用 SchemaFrozenLayer 复用双锚点（comment 魔法串 + sha256 兜底）
 async function ensureMetaRuleLore() {
 var sid = metaRuleSchemaId();
 var rule = buildMetaRuleLore();
 // 把元规则作为 schema 的内容（不带 paths，纯文档）
 var schemaObj = {
 '_$cfs_meta': {
 version: 1,
 description: 'CFS v4.x meta rule lore for stable presence token semantics'
 },
 'rule_text': rule
 };
 try {
 // meta_rule 也 injectable（虽然 v6.1 已取代它）
 var w = await SFL.writeSchema(schemaObj, { schemaId: sid, ver: 1, injectable: true });
 L.info('ensureMetaRuleLore: ' + w.action + ' uid=' + w.uid);
 return w;
 } catch (e) {
 L.error('ensureMetaRuleLore failed', e);
 throw e;
 }
 }

 // ===== InjectionStrategy =====

 // 主入口：生成本轮 v4.x 应注入到 prompt 的三层字符串
 //
 // opts = {
 // schema_id?: '...', // 默认用 active schema_id (primary)
 // new_stat_data: {}, // 本轮 stat_data
 // old_stat_data?: {}, // 上轮（如不传则用 PathRegistry.last_value 推断）
 // llm_update_ops?: [], // JSONPatch ops from LLM
 // round?: <number>
 // }
 //
 // 返回 {
 // schema_ref: { id, ver, sha256 } | null, // 静态层引用（已在 worldbook，不重复注入）
 // meta_rule_ref: { id, ver, sha256 } | null, // 元规则 lore 引用（同上）
 // presence_tokens: '<STABLE/>... ', // 准静态层（占位符）
 // delta_layer: 'attributes.hp: 85\n...', // 动态层（本轮变化）
 // stats: { present, omitted, deleted, drift, presence_token_count, delta_chars, total_chars },
 // raw_diff: <DiffEngine result>
 // }
 async function generateInjection(opts) {
 opts = opts || {};
 var schemaId = opts.schema_id || CFS4.getSchemaIds().primary;
 var newData = opts.new_stat_data;
 var oldData = opts.old_stat_data || null;
 var llmOps = opts.llm_update_ops || [];
 var round = opts.round != null ? opts.round : null;

 if (!newData || typeof newData !== 'object') {
 throw new Error('generateInjection: new_stat_data 必须是 object');
 }

 // 1. resolveSchema 检查存在性
 var resolved = await SR.resolveSchema(schemaId).catch(function () { return null; });
 var metaResolved = await SR.resolveSchema(metaRuleSchemaId()).catch(function () { return null; });

 var schema_ref = resolved ? { id: schemaId, ver: resolved.meta.ver, sha256: resolved.meta.sha256, uid: resolved.uid } : null;
 var meta_rule_ref = metaResolved ? { id: metaRuleSchemaId(), ver: metaResolved.meta.ver, sha256: metaResolved.meta.sha256, uid: metaResolved.uid } : null;

 // 2. 计算三态 diff
 var diff = DE.computeDiff({
 old_stat_data: oldData,
 new_stat_data: newData,
 llm_update_ops: llmOps,
 schema_ref: schemaId,
 round: round
 });

 // 3. 生成 stable presence tokens（omitted 状态 + present_round 早于本轮的 stable path）
 // 简化：所有 omitted 都生成 token
 var presenceTokens = '';
 for (var i = 0; i < diff.omitted.length; i++) {
 presenceTokens += encodeToken(schemaId, diff.omitted[i].path_id);
 }

 // 4. 生成 delta_layer（present 字段）
 var deltaLines = [];
 for (var j = 0; j < diff.present.length; j++) {
 var p = diff.present[j];
 // 简化格式：path: new_value
 var valStr;
 try { valStr = JSON.stringify(p.new_value); }
 catch (_e) { valStr = String(p.new_value); }
 deltaLines.push(p.path + ': ' + valStr);
 }
 var deltaLayer = deltaLines.length > 0 ? '# CFS v4.x mutable delta\n' + deltaLines.join('\n') : '';

 var stats = {
 present: diff.present.length,
 omitted: diff.omitted.length,
 deleted: diff.deleted.length,
 drift: diff.drift.length,
 presence_token_count: diff.omitted.length,
 delta_chars: deltaLayer.length,
 presence_tokens_chars: presenceTokens.length,
 total_chars: deltaLayer.length + presenceTokens.length
 };

 return {
 schema_ref: schema_ref,
 meta_rule_ref: meta_rule_ref,
 presence_tokens: presenceTokens,
 delta_layer: deltaLayer,
 stats: stats,
 raw_diff: diff
 };
 }

 // ===== 钩 generate_before_combine_prompts（dry-run）=====
 // 仅 log + emit event，不真正改 prompt
 var _dryRunHistory = []; // 最近 N 次注入历史（在 F12 查看）
 var _DRY_RUN_HISTORY_MAX = 10;

 // Mvu 在 iframe scope 不可访问，必须走父窗口或 _GLOBAL
 function _resolveMvuP6() {
 if (typeof Mvu !== 'undefined' && Mvu && Mvu.getMvuData) return Mvu;
 if (_GLOBAL && _GLOBAL.Mvu && _GLOBAL.Mvu.getMvuData) return _GLOBAL.Mvu;
 if (typeof window !== 'undefined' && window.Mvu && window.Mvu.getMvuData) return window.Mvu;
 if (typeof window !== 'undefined' && window.parent && window.parent.Mvu && window.parent.Mvu.getMvuData) return window.parent.Mvu;
 return null;
 }
 async function _onGenerateBeforeCombineDryRun() {
 // 尝试从 MVU 拿当前 stat_data
 var newStatData = null;
 try {
 var _mvu = _resolveMvuP6();
 if (_mvu) {
 var mvuData = await _mvu.getMvuData({ type: 'message', message_id: -1 });
 if (mvuData && mvuData.stat_data) newStatData = mvuData.stat_data;
 }
 } catch (e) {
 L.debug('dry-run: Mvu.getMvuData failed', e);
 }
 if (!newStatData) {
 // 没 stat_data 跳过（首轮 / 无 MVU 卡）
 return;
 }

 try {
 var injection = await generateInjection({
 new_stat_data: newStatData,
 round: Date.now() // 用 timestamp 代替轮次
 });
 var historyEntry = {
 at: new Date().toISOString(),
 schema_id: injection.schema_ref && injection.schema_ref.id,
 stats: injection.stats,
 // 不存 full delta_layer / presence_tokens（避免 history 内存膨胀），存 head
 delta_preview: injection.delta_layer.slice(0, 200),
 presence_preview: injection.presence_tokens.slice(0, 200)
 };
 _dryRunHistory.unshift(historyEntry);
 if (_dryRunHistory.length > _DRY_RUN_HISTORY_MAX) _dryRunHistory.pop();

 CFS4.emit(CFS4.EVENTS.INJECTION_APPLIED, {
 mode: 'dry-run',
 schema_id: historyEntry.schema_id,
 stats: injection.stats
 });
 L.info('dry-run injection: present=' + injection.stats.present
 + ' omitted=' + injection.stats.omitted
 + ' deleted=' + injection.stats.deleted
 + ' drift=' + injection.stats.drift
 + ' total_chars=' + injection.stats.total_chars);
 } catch (e) {
 L.warn('dry-run generateInjection failed', e);
 }
 }

 function getDryRunHistory() { return _dryRunHistory.slice(); }

 // hotfix: 钩注册移入 app_ready 修真接管闭环
 // 同步 IIFE 时 ST 事件总线可能未初始化，eventOn 看似成功但 listener 丢失
 var _presenceEncoderHookRegistered = false;
 function _registerPresenceEncoderHook() {
 if (_presenceEncoderHookRegistered) return;
 try {
 if (typeof eventOn === 'function') {
 eventOn('generate_before_combine_prompts', _onGenerateBeforeCombineDryRun);
 _presenceEncoderHookRegistered = true;
 L.info('generate_before_combine_prompts 钩已注册');
 }
 } catch (e) { L.warn('钩注册失败', e); }
 }
 try { eventOnce('app_ready', _registerPresenceEncoderHook); }
 catch (e) { setTimeout(_registerPresenceEncoderHook, 2000); }
 setTimeout(_registerPresenceEncoderHook, 2800); // 兜底

 // ===== selfTest =====
 async function selfTest() {
 var ids = CFS4.getSchemaIds();
 var sid = ids.primary + '::_test_encoder';

 // 1. 写 schema with 3 paths
 var schema = SFL.buildDefaultSchemaTemplate();
 schema.paths['p_0020'] = { path: 'attributes.hp', type: 'number', default: 100 };
 schema.paths['p_0021'] = { path: 'attributes.mp', type: 'number', default: 50 };
 schema.paths['p_0022'] = { path: 'system.location', type: 'string', default: '院子' };
 await SFL.writeSchema(schema, { schemaId: sid, ver: 1 });
 SR.invalidateCache(sid);
 await PR.syncFromSchema(sid);

 // 2. 确保元规则 lore 在
 var meta = await ensureMetaRuleLore();
 L.info('selfTest: meta rule lore ' + meta.action + ' uid=' + meta.uid);

 // 3. 构造测试数据
 var oldData = {
 attributes: { hp: 100, mp: 50 },
 system: { location: '院子' }
 };
 var newData = {
 attributes: { hp: 75, mp: 50 },
 system: { location: '走廊' }
 };

 var injection = await generateInjection({
 schema_id: sid,
 new_stat_data: newData,
 old_stat_data: oldData,
 round: 1
 });

 L.info('selfTest injection.schema_ref:', injection.schema_ref);
 L.info('selfTest injection.meta_rule_ref:', injection.meta_rule_ref);
 L.info('selfTest injection.presence_tokens:', injection.presence_tokens);
 L.info('selfTest injection.delta_layer:', injection.delta_layer);
 L.info('selfTest injection.stats:', injection.stats);

 // 4. 编码/解码 round-trip
 var token = encodeToken(sid, 'p_0099');
 var decoded = decodeToken(token);
 L.info('encode/decode round-trip:', token, '→', decoded);

 return injection;
 }

 async function cleanupPhase6Test() {
 var ids = CFS4.getSchemaIds();
 var sid = ids.primary + '::_test_encoder';
 var reg = PR.getAll();
 var removed = [];
 Object.keys(reg).forEach(function (k) {
 if (reg[k].schema_ref === sid) { PR.unregister(k); removed.push(k); }
 });
 try { await SFL.removeSchema(sid, 1); } catch (_e) {}
 SR.invalidateCache(sid);
 return { schema_id: sid, removed_paths: removed };
 }

 // ===== 导出 =====
 CFS4.PresenceEncoder = {
 _version: '6.0',
 encode: encodeToken,
 encodeMany: encodeManyTokens,
 decode: decodeToken,
 extractAllTokens: extractAllTokens,
 TOKEN_RE: TOKEN_RE
 };

 CFS4.InjectionStrategy = {
 _version: '6.0-dryrun',
 generateInjection: generateInjection,
 buildMetaRuleLore: buildMetaRuleLore,
 metaRuleSchemaId: metaRuleSchemaId,
 ensureMetaRuleLore: ensureMetaRuleLore,
 getDryRunHistory: getDryRunHistory,
 selfTest: selfTest,
 cleanupPhase6Test: cleanupPhase6Test
 };

 L.info('Presence Encoder + Injection Strategy mounted');
})();

/* ==========================================================
 * CFS v4.x: STABLE_BATCH + stability_class 协议进化
 *
 * 数据触发（391 字段实测）：
 * 字段级 <STABLE/> 反而比原 stat_data 大 6% → 单字段 token 协议失效
 *
 * 协议契约 v3 §D patch（用户钉死）：
 * - 保留：Schema Frozen Layer / Path Registry Diff / Lazy Switch
 * - 降级：单字段 <STABLE/> → 调试用途
 * - 正式：STABLE_BATCH + stability_class(volatile/stable/frozen) 三档
 * volatile → 每轮发真实值（进 delta_layer）
 * stable → 批量引用声明（一条 BATCH token 列出 path_id）
 * frozen → 完全不进 prompt（沉入 schema 静态层，元规则约束 LLM）
 *
 * 默认 stability_class = 'volatile'（保守安全）
 * BATCH token 格式（拍板）：
 * <STABLE_BATCH schema="<schema_id>" paths="p_001,p_002,p_003,..."/>
 * path_id 用逗号分隔（CSV 风格，LLM 识别度高）
 *
 * 本 IIFE 覆盖式升级 的 PresenceEncoder + InjectionStrategy。
 * 的单字段 encode() 保留为 _encodeLegacySingle()（调试用），生产路径走 Batch。
 * ==========================================================*/
(function () {
 'use strict';

 var _GLOBAL = (typeof window !== 'undefined' && window.parent) || (typeof window !== 'undefined' ? window : null);
 if (!_GLOBAL || !_GLOBAL.CFS4 || !_GLOBAL.CFS4._loaded) {
 console.warn('[CFS v4.x] CFS4 not initialized, abort');
 return;
 }
 if (!_GLOBAL.CFS4.PresenceEncoder || !_GLOBAL.CFS4.InjectionStrategy) {
 console.warn('[CFS v4.x] 依赖未就绪，abort');
 return;
 }
 if (_GLOBAL.CFS4.PresenceEncoder._version === '6.1') {
 console.warn('[CFS v4.x] 已加载，skip');
 return;
 }

 var CFS4 = _GLOBAL.CFS4;
 var L = CFS4.log;
 var DE = CFS4.DiffEngine;
 var PR = CFS4.PathRegistry;
 var SR = CFS4.SchemaResolver;
 var SFL = CFS4.SchemaFrozenLayer;

 // ===== PresenceEncoder v6.1 =====
 var BATCH_TOKEN_RE = /<STABLE_BATCH\s+schema="([^"]+)"\s+paths="([^"]+)"\s*\/>/g;
 var BATCH_TOKEN_RE_ONE = /<STABLE_BATCH\s+schema="([^"]+)"\s+paths="([^"]+)"\s*\/>/;

 function encodeBatch(schemaId, pathIds) {
 if (!schemaId) throw new Error('encodeBatch: schemaId 必填');
 if (!Array.isArray(pathIds)) throw new Error('encodeBatch: pathIds 必须是数组');
 if (pathIds.length === 0) return '';
 // CSV 风格：path_id 用逗号分隔
 return '<STABLE_BATCH schema="' + schemaId + '" paths="' + pathIds.join(',') + '"/>';
 }

 function decodeBatch(tokenStr) {
 if (!tokenStr) return null;
 var m = BATCH_TOKEN_RE_ONE.exec(tokenStr);
 if (!m) return null;
 return {
 schema_id: m[1],
 path_ids: m[2].split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; })
 };
 }

 function extractAllBatchTokens(text) {
 if (!text) return [];
 var out = [];
 var re = new RegExp(BATCH_TOKEN_RE.source, 'g');
 var m;
 while ((m = re.exec(text)) !== null) {
 out.push({
 token: m[0],
 schema_id: m[1],
 path_ids: m[2].split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; })
 });
 }
 return out;
 }

 // 保留旧单字段 encode 为 _encodeLegacySingle（调试用）
 var _encodeLegacySingle = CFS4.PresenceEncoder.encode;

 // ===== InjectionStrategy v6.1 =====

 // 默认 stability_class
 var DEFAULT_STABILITY_CLASS = 'volatile';

 // 根据 path_id 取它的 stability_class（PathRegistry 中存的，默认 volatile）
 function _getStabilityClass(pathId) {
 var p = PR.getPath(pathId);
 if (p && p.stability_class) return p.stability_class;
 return DEFAULT_STABILITY_CLASS;
 }

 // 元规则 lore（v6.1 新版本，解释 BATCH + 三档）
 function buildMetaRuleLore_v61() {
 return [
 '# CFS v4.x StatData Engine 元规则（自动注入，勿修改）',
 '',
 '## stat_data 三档字段（stability_class）',
 '',
 '本系统将 stat_data 字段分为三档：',
 '',
 '- **volatile**（易变）：每轮以真实值出现在 mutable delta 中，按字面值理解。',
 '- **stable**（稳定）：跨轮基本不变，本轮通过 `<STABLE_BATCH/>` 标签批量声明"未变"。',
 '- **frozen**（冻结）：跨轮永不变，**不**注入到本 prompt，按 schema 中定义的值理解。',
 '',
 '## 看到 `<STABLE_BATCH schema="..." paths="p_001,p_002,..."/>` 标签时：',
 '',
 '该标签列出的所有 path_id 字段**跨轮稳定，本轮未变**。按 schema 中各 path_id',
 '对应的当前值理解。**禁止**：',
 '- 凭对话上下文推断、改写或猜测这些字段的值',
 '- 把 STABLE_BATCH 标签复制到自己输出里',
 '- 给标签内任一字段"补一个新值"（值由 schema 维护）',
 '- 把"这些字段当前值是什么"作为对话话题展开',
 '',
 '## 看到 mutable delta 段时：',
 '',
 '这是本轮**真正变了**的字段，按字面值理解，是新事实。',
 '',
 '## 未出现在 BATCH 或 delta 里的字段：',
 '',
 '即 frozen 字段。它们的值跨轮永不变，按 schema 定义理解。**不要**',
 '主动添加 frozen 字段到自己的 `<UpdateVariable>` 输出里（这违反协议）。',
 '',
 '## 你的 `<UpdateVariable>` 输出（JSONPatch）规则',
 '',
 '只对**真正改变**的字段使用 op（replace/add/remove）。stable 和 frozen 字段',
 '保持沉默——不要重发它们的值，也不要"为了完整"把它们列出来。',
 ''
 ].join('\n');
 }

 function metaRuleSchemaId_v61() {
 var ids = CFS4.getSchemaIds();
 return ids.primary + '::meta_rule_v61';
 }

 async function ensureMetaRuleLore_v61() {
 var sid = metaRuleSchemaId_v61();
 var rule = buildMetaRuleLore_v61();
 var schemaObj = {
 '_$cfs_meta': {
 version: 1,
 description: 'CFS v4.x meta rule lore (STABLE_BATCH + stability_class)'
 },
 'rule_text': rule
 };
 try {
 // meta_rule_v61 必须 enabled (LLM 要读到这个协议说明)
 var w = await SFL.writeSchema(schemaObj, { schemaId: sid, ver: 1, injectable: true });
 L.info('ensureMetaRuleLore_v61: ' + w.action + ' uid=' + w.uid);
 return w;
 } catch (e) {
 L.error('ensureMetaRuleLore_v61 failed', e);
 throw e;
 }
 }

 // 核心：generateInjection v6.1（按 stability_class 三档分层）
 async function generateInjection_v61(opts) {
 opts = opts || {};
 var schemaId = opts.schema_id || CFS4.getSchemaIds().primary;
 var newData = opts.new_stat_data;
 var oldData = opts.old_stat_data || null;
 var llmOps = opts.llm_update_ops || [];
 var round = opts.round != null ? opts.round : null;

 if (!newData || typeof newData !== 'object') {
 throw new Error('generateInjection: new_stat_data 必须是 object');
 }

 var resolved = await SR.resolveSchema(schemaId).catch(function () { return null; });
 var metaResolved = await SR.resolveSchema(metaRuleSchemaId_v61()).catch(function () { return null; });

 var schema_ref = resolved
 ? { id: schemaId, ver: resolved.meta.ver, sha256: resolved.meta.sha256, uid: resolved.uid }
 : null;
 var meta_rule_ref = metaResolved
 ? { id: metaRuleSchemaId_v61(), ver: metaResolved.meta.ver, sha256: metaResolved.meta.sha256, uid: metaResolved.uid }
 : null;

 var diff = DE.computeDiff({
 old_stat_data: oldData,
 new_stat_data: newData,
 llm_update_ops: llmOps,
 schema_ref: schemaId,
 round: round
 });

 // === 按 stability_class 三档分层 ===
 var deltaLines = []; // volatile present 进这里
 var batchStablePaths = []; // stable omitted 进这里（聚合到一个 BATCH token）
 var frozenSilent = []; // frozen 的不进 prompt，仅记录数

 // present 字段：默认按 stability_class 分流
 // volatile → delta
 // stable → BATCH（即使值变了也走 BATCH，因为 BATCH 表示"跨轮稳定"；
 // 但 present 表示本轮变了 → 这种情况应该升级到 delta 暴露变化）
 // frozen → 不应该出现 present（frozen 跨轮永不变）；若出现 = drift
 for (var i = 0; i < diff.present.length; i++) {
 var p = diff.present[i];
 var cls = _getStabilityClass(p.path_id);
 if (cls === 'frozen') {
 // frozen 字段不应变化；若变化记为 drift（独立处理）
 diff.drift.push({
 path: p.path,
 value: p.new_value,
 reason: 'frozen path changed (path_id=' + p.path_id + ')'
 });
 continue;
 }
 // volatile or stable 字段变化 → 进 delta（暴露真实新值）
 var valStr;
 try { valStr = JSON.stringify(p.new_value); }
 catch (_e) { valStr = String(p.new_value); }
 deltaLines.push(p.path + ': ' + valStr);
 }

 // omitted 字段：默认按 stability_class 分流
 // volatile → 默认认为"本轮没出现 = 没变"，但不进 BATCH（因为 volatile 不保证稳定）→ silent
 // stable → 进 BATCH token
 // frozen → silent（永不进 prompt）
 for (var j = 0; j < diff.omitted.length; j++) {
 var o = diff.omitted[j];
 var clsO = _getStabilityClass(o.path_id);
 if (clsO === 'stable') {
 batchStablePaths.push(o.path_id);
 } else if (clsO === 'frozen') {
 frozenSilent.push(o.path_id);
 }
 // volatile omitted 不进 prompt（默认行为）
 }

 var deltaLayer = deltaLines.length > 0
 ? '# CFS v4.x mutable delta\n' + deltaLines.join('\n')
 : '';
 var presenceBatch = batchStablePaths.length > 0
 ? encodeBatch(schemaId, batchStablePaths)
 : '';

 var stats = {
 present: diff.present.length,
 omitted: diff.omitted.length,
 deleted: diff.deleted.length,
 drift: diff.drift.length,
 // v6.1 新增按 class 拆分
 delta_field_count: deltaLines.length,
 batch_stable_field_count: batchStablePaths.length,
 frozen_silent_field_count: frozenSilent.length,
 // 字符数
 delta_chars: deltaLayer.length,
 batch_token_chars: presenceBatch.length,
 total_injection_chars: deltaLayer.length + presenceBatch.length,
 // 兼容 v6 输出
 presence_token_count: 1, // 现在只有一个 BATCH token
 presence_tokens_chars: presenceBatch.length,
 total_chars: deltaLayer.length + presenceBatch.length
 };

 return {
 schema_ref: schema_ref,
 meta_rule_ref: meta_rule_ref,
 presence_tokens: presenceBatch,
 delta_layer: deltaLayer,
 frozen_silent_count: frozenSilent.length,
 stats: stats,
 raw_diff: diff
 };
 }

 // 替换 dry-run 钩——卸老 listener 加新版
 var _dryRunHistory = [];
 var _DRY_RUN_HISTORY_MAX = 10;

 // Mvu 在 iframe scope 不可访问 → 父窗口 fallback
 function _resolveMvu() {
 if (typeof Mvu !== 'undefined' && Mvu && Mvu.getMvuData) return Mvu;
 if (_GLOBAL && _GLOBAL.Mvu && _GLOBAL.Mvu.getMvuData) return _GLOBAL.Mvu;
 if (typeof window !== 'undefined' && window.Mvu && window.Mvu.getMvuData) return window.Mvu;
 if (typeof window !== 'undefined' && window.parent && window.parent.Mvu && window.parent.Mvu.getMvuData) return window.parent.Mvu;
 return null;
 }
 async function _onGenerateBeforeCombineDryRun_v61() {
 // hotfix v2.4：在 ST 拼 prompt 前同步 audit 一次 CFS entry 位置
 // 这是解决"慢一步修复"的关键 — chat_changed 后的异步 audit 来不及让本轮 prompt 用新位置
 // generate_before_combine_prompts 是 ST 拼 prompt 的最后一道钩，await 完才让 ST 继续
 try {
 var _co = _GLOBAL && _GLOBAL.CFS4 && _GLOBAL.CFS4.Coordinator;
 if (_co && typeof _co.auditEntries === 'function') {
 var _auditRes = await _co.auditEntries({ force: true });
 if (_auditRes && _auditRes.fixed > 0) {
 L.warn('hotfix v2.4: 拼 prompt 前同步修了 ' + _auditRes.fixed + ' 条 entry → 本轮 prompt 用新位置');
 }
 }
 } catch (eAudit) { L.warn('audit before combine failed', eAudit); }

 var newStatData = null;
 try {
 var _mvu = _resolveMvu();
 if (_mvu) {
 var mvuData = await _mvu.getMvuData({ type: 'message', message_id: -1 });
 if (mvuData && mvuData.stat_data) newStatData = mvuData.stat_data;
 }
 } catch (e) { L.debug('dry-run v6.1: Mvu.getMvuData failed', e); }
 if (!newStatData) return;

 try {
 // .3: 自动找 PathRegistry 里含最多 path 的 schema_ref（用户的真实活跃 schema）
 var _reg = PR.getAll();
 var _counts = {};
 Object.keys(_reg).forEach(function(_pid){
 var _sref = _reg[_pid].schema_ref;
 if (_sref) _counts[_sref] = (_counts[_sref] || 0) + 1;
 });
 var _bestSchema = null, _bestCount = 0;
 Object.keys(_counts).forEach(function(_sref){
 if (_counts[_sref] > _bestCount) { _bestCount = _counts[_sref]; _bestSchema = _sref; }
 });
 var injection = await generateInjection_v61({
 schema_id: _bestSchema || CFS4.getSchemaIds().primary,
 new_stat_data: newStatData,
 round: Date.now()
 });
 var historyEntry = {
 at: new Date().toISOString(),
 schema_id: injection.schema_ref && injection.schema_ref.id,
 stats: injection.stats,
 delta_preview: injection.delta_layer.slice(0, 300),
 batch_preview: injection.presence_tokens.slice(0, 300)
 };
 _dryRunHistory.unshift(historyEntry);
 if (_dryRunHistory.length > _DRY_RUN_HISTORY_MAX) _dryRunHistory.pop();
 CFS4.emit(CFS4.EVENTS.INJECTION_APPLIED, {
 mode: 'dry-run-v61',
 schema_id: historyEntry.schema_id,
 stats: injection.stats
 });
 L.info('dry-run v6.1: delta_fields=' + injection.stats.delta_field_count
 + ' batch_stable=' + injection.stats.batch_stable_field_count
 + ' frozen_silent=' + injection.stats.frozen_silent_field_count
 + ' drift=' + injection.stats.drift
 + ' total_chars=' + injection.stats.total_injection_chars);
 } catch (e) { L.warn('dry-run v6.1 generateInjection failed', e); }
 }

 // 钩上新版 listener
 // hotfix: 钩注册移入 app_ready
 var _stableBatchHookRegistered = false;
 function _registerStableBatchHook() {
 if (_stableBatchHookRegistered) return;
 try {
 if (typeof eventOn === 'function') {
 eventOn('generate_before_combine_prompts', _onGenerateBeforeCombineDryRun_v61);
 _stableBatchHookRegistered = true;
 L.info('generate_before_combine_prompts 钩已注册');
 }
 } catch (e) { L.warn('钩注册失败', e); }
 }
 try { eventOnce('app_ready', _registerStableBatchHook); }
 catch (e) { setTimeout(_registerStableBatchHook, 2000); }
 setTimeout(_registerStableBatchHook, 2800);

 // ===== 辅助工具：自动把 stat_data 所有 leaf path 注册并按启发式分类 =====
 // 用户给 schema 灌注 391 字段时手动注册太麻烦，提供一键工具
 async function autoRegisterFromStatData(opts) {
 opts = opts || {};
 var schemaId = opts.schema_id || CFS4.getSchemaIds().primary + '::auto';
 var statData = opts.stat_data;
 var defaultClass = opts.default_class || 'volatile';
 if (!statData) {
 // 自动从 MVU 拿（iframe scope 不可访问 Mvu，走 _resolveMvu）
 var _mvu = _resolveMvu();
 if (!_mvu) {
 throw new Error('autoRegister: 未提供 stat_data 且 Mvu 在所有 scope（iframe / parent / window）都不可用');
 }
 var mvuData = await _mvu.getMvuData({ type: 'message', message_id: -1 });
 if (!mvuData || !mvuData.stat_data) throw new Error('autoRegister: MVU 无 stat_data（当前消息可能没绑定 MVU）');
 statData = mvuData.stat_data;
 }
 var leafPaths = DE._walkStatDataLeafPaths(statData, '');
 // .1: 生产 stat_data 可能含 undefined（直接或嵌套），canonicalize 协议严格拒绝
 // → 写 schema 前递归把 undefined 转 null（仅 autoRegister 这里 sanitize，canonicalize 协议不动）
 function _sanitizeUndef(v) {
 if (v === undefined) return null;
 if (v === null) return null;
 if (typeof v !== 'object') return v;
 if (Array.isArray(v)) {
 var arr = [];
 for (var i = 0; i < v.length; i++) arr.push(_sanitizeUndef(v[i]));
 return arr;
 }
 var out = {};
 for (var k in v) {
 if (Object.prototype.hasOwnProperty.call(v, k)) {
 var subVal = v[k];
 if (subVal !== undefined) out[k] = _sanitizeUndef(subVal);
 }
 }
 return out;
 }
 // 构造 schema：path_id 按 'p_' + 4 位顺序号生成
 var schema = SFL.buildDefaultSchemaTemplate();
 var idx = 0;
 var registered = [];
 var sanitizedCount = 0;
 for (var i = 0; i < leafPaths.length; i++) {
 idx++;
 var pid = 'p_' + String(idx).padStart ? ('p_' + String(idx).padStart(4, '0')) : ('p_' + ('0000' + idx).slice(-4));
 var rawVal = DE._getByPath(statData, leafPaths[i]);
 var defaultVal = _sanitizeUndef(rawVal);
 if (rawVal !== defaultVal && rawVal === undefined) sanitizedCount++;
 schema.paths[pid] = {
 path: leafPaths[i],
 type: 'auto',
 default: defaultVal,
 stability_class: defaultClass
 };
 registered.push({ path_id: pid, path: leafPaths[i], stability_class: defaultClass });
 }
 if (sanitizedCount > 0) L.info('autoRegister: sanitized ' + sanitizedCount + ' undefined 值为 null（生产数据含 undefined 是正常的）');
 // 写 schema entry
 await SFL.writeSchema(schema, { schemaId: schemaId, ver: 1 });
 SR.invalidateCache(schemaId);
 // sync 到 PathRegistry
 await PR.syncFromSchema(schemaId);
 // === .2 hotfix: syncFromSchema 不更新已注册 path 的 last_value（保留旧值，包括 null）===
 // 这导致历史残留 path 的 last_value 仍是 null，跟当前 stat_data 不等 → 全部进 present
 // 修复：autoRegister 完成后强制按当前 stat_data 覆盖 last_value
 var resyncCount = 0;
 for (var rsi = 0; rsi < registered.length; rsi++) {
 var rpid = registered[rsi].path_id;
 var rp = PR.getPath(rpid);
 if (!rp) continue;
 var realVal = _sanitizeUndef(DE._getByPath(statData, rp.path));
 if (!DE._deepEqual(rp.last_value, realVal)) {
 PR.update(rpid, realVal);
 resyncCount++;
 }
 }
 L.info('autoRegisterFromStatData: ' + leafPaths.length + ' paths registered with class=' + defaultClass
 + (resyncCount > 0 ? '；强制 resync ' + resyncCount + ' 个 last_value（修历史残留）' : ''));
 return { schema_id: schemaId, count: leafPaths.length, registered: registered.slice(0, 20), resyncCount: resyncCount };
 }

 // 给一批 path 改 stability_class
 function bulkSetStabilityClass(pathIds, cls) {
 if (!Array.isArray(pathIds)) throw new Error('bulkSetStabilityClass: pathIds 必须是数组');
 if (['volatile', 'stable', 'frozen'].indexOf(cls) < 0) {
 throw new Error('bulkSetStabilityClass: cls 必须是 volatile/stable/frozen');
 }
 var ok = 0, miss = 0;
 for (var i = 0; i < pathIds.length; i++) {
 try {
 var p = PR.getPath(pathIds[i]);
 if (p) { PR.setStabilityClass(pathIds[i], cls); ok++; }
 else miss++;
 } catch (_e) { miss++; }
 }
 L.info('bulkSetStabilityClass: ' + cls + ' ok=' + ok + ' miss=' + miss);
 return { class: cls, ok: ok, miss: miss };
 }

 // selfTest v6.1
 async function selfTest_v61() {
 var ids = CFS4.getSchemaIds();
 var sid = ids.primary + '::_test_batch';

 // 构造 schema with 5 paths，3 档分类
 var schema = SFL.buildDefaultSchemaTemplate();
 schema.paths['p_v01'] = { path: 'attributes.hp', type: 'number', default: 100, stability_class: 'volatile' };
 schema.paths['p_v02'] = { path: 'attributes.mp', type: 'number', default: 50, stability_class: 'volatile' };
 schema.paths['p_s01'] = { path: 'system.location', type: 'string', default: '院子', stability_class: 'stable' };
 schema.paths['p_s02'] = { path: 'system.weather', type: 'string', default: '晴', stability_class: 'stable' };
 schema.paths['p_f01'] = { path: 'meta.character_name', type: 'string', default: '道渊', stability_class: 'frozen' };

 await SFL.writeSchema(schema, { schemaId: sid, ver: 1 });
 SR.invalidateCache(sid);
 await PR.syncFromSchema(sid);

 // 元规则
 var meta = await ensureMetaRuleLore_v61();
 L.info('selfTest v6.1: meta_rule_v61 ' + meta.action + ' uid=' + meta.uid);

 // 构造 stat_data：volatile hp 变了，stable 两条都没变，frozen 也没变
 var oldData = {
 attributes: { hp: 100, mp: 50 },
 system: { location: '院子', weather: '晴' },
 meta: { character_name: '道渊' }
 };
 var newData = {
 attributes: { hp: 65, mp: 50 },
 system: { location: '院子', weather: '晴' },
 meta: { character_name: '道渊' }
 };

 var inj = await generateInjection_v61({
 schema_id: sid,
 new_stat_data: newData,
 old_stat_data: oldData,
 round: 1
 });

 L.info('selfTest v6.1 delta_layer:', inj.delta_layer);
 L.info('selfTest v6.1 presence_tokens:', inj.presence_tokens);
 L.info('selfTest v6.1 frozen_silent_count:', inj.frozen_silent_count);
 L.info('selfTest v6.1 stats:', inj.stats);
 return inj;
 }

 async function cleanupPhase61Test() {
 var ids = CFS4.getSchemaIds();
 var sid = ids.primary + '::_test_batch';
 var reg = PR.getAll();
 var removed = [];
 Object.keys(reg).forEach(function (k) {
 if (reg[k].schema_ref === sid) { PR.unregister(k); removed.push(k); }
 });
 try { await SFL.removeSchema(sid, 1); } catch (_e) {}
 SR.invalidateCache(sid);
 return { schema_id: sid, removed_paths: removed };
 }

 // ===== 覆盖式升级导出 =====

 // PresenceEncoder v6.1
 CFS4.PresenceEncoder._version = '6.1';
 CFS4.PresenceEncoder.encodeBatch = encodeBatch;
 CFS4.PresenceEncoder.decodeBatch = decodeBatch;
 CFS4.PresenceEncoder.extractAllBatchTokens = extractAllBatchTokens;
 CFS4.PresenceEncoder.BATCH_TOKEN_RE = BATCH_TOKEN_RE;
 CFS4.PresenceEncoder._encodeLegacySingle = _encodeLegacySingle; // 调试保留

 // InjectionStrategy v6.1
 CFS4.InjectionStrategy._version = '6.1-dryrun';
 CFS4.InjectionStrategy.generateInjection = generateInjection_v61;
 CFS4.InjectionStrategy.buildMetaRuleLore = buildMetaRuleLore_v61;
 CFS4.InjectionStrategy.metaRuleSchemaId = metaRuleSchemaId_v61;
 CFS4.InjectionStrategy.ensureMetaRuleLore = ensureMetaRuleLore_v61;
 CFS4.InjectionStrategy.getDryRunHistory = function () { return _dryRunHistory.slice(); };
 CFS4.InjectionStrategy.selfTest = selfTest_v61;
 CFS4.InjectionStrategy.cleanupPhase6Test = cleanupPhase61Test;

 // 新增工具
 CFS4.InjectionStrategy.autoRegisterFromStatData = autoRegisterFromStatData;
 CFS4.InjectionStrategy.bulkSetStabilityClass = bulkSetStabilityClass;

 L.info('PresenceEncoder/InjectionStrategy 升级 → STABLE_BATCH + stability_class(volatile/stable/frozen)');
})();


export const PresenceEncoder = window.CFS4?.PresenceEncoder;
export const InjectionStrategy = window.CFS4?.InjectionStrategy;
console.log('[CFS-Suite/injection-strategy] PresenceEncoder + InjectionStrategy ESM bridge OK');
