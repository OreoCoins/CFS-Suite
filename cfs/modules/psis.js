/**
 * CFS-Suite · modules/psis.js
 *
 * 从 CFS v3.1.7 「MVU+PSIS 守护版」（cfs_content_extracted.js L1-1598）整段迁移。
 *
 * 包含：
 *   - PSIS R1 (Prompt Structural Invariant System) 提示词结构守护
 *   - v3.0 自动守护（已永久禁用，由 PSIS R1 接管，代码保留）
 *   - 「🛡️ MVU 守护」面板（聊天输入框旁按钮 + renderMvuConsole 渲染）
 *   - STYLE_CSS 注入
 *   - initvar 自动生命周期
 *   - worldbook 工具函数（normalizePosition / verifyAnchors / etc.）
 *
 * 跟浮动胶囊（cfs/ui/floating_capsule.js）并存 —— 用户多一个 UI 入口。
 * 完整 panel 拆分到独立模块留 Day 6。
 *
 * 依赖：tavern_helper_polyfill（eventOn / TavernHelper stub）
 */

import { polyfilledApis as _r } from '../compat/tavern_helper_polyfill.js';
// PSIS R1 不依赖 v4.x 核心层，但有些功能（registerPlugin 到 Coordinator）需要 kernel
// 安全做法：ESM import 让 kernel 先就位
import '../core/kernel.js';
void _r;

// ============================================================
// 以下为 cfs_content_extracted.js L1-1598 整段迁移（v3.1.7 主 IIFE）
// ============================================================

﻿/* =================================================================
 * Cache-Friendly Lorebook Scanner v3.1.7「MVU+PSIS 守护版」
 * 入口：聊天输入框旁的按钮「🛡️ MVU 守护」，点击弹面板。
 * 面板注入到酒馆主界面（不在 iframe 内）。
 *
 * v3.0 与 v2.9 的差异：
 * - 通用扫描/修复（A 动态宏前置 + B 扫描深度 + D 强制元叙述）已交给社区脚本
 * "世界书缓存优化器"（jerryzmtz/worldbook-manager），CFS 不再做。
 * - CFS 聚焦三大块 depth 排序：数据库 / MVU / 动态注入 — 一键全部归零，
 * 强制 position=at_depth_as_user + depth=0，插入到 chatHistory 末尾，
 * 确保前置静态 prefix 不被破坏。
 * - 保留独占能力：自动守护、initvar 全自动生命周期、MVU 控制台。

 *
 * v3.1 升级（2026-06-17 cache miss 根因攻坚）：
 * - 新增 PSIS（Prompt Structural Invariant System）模块
 * · R0 PresetGuard: 监听 oai_preset_changed_after，校验预设 prompt_order
 * 中 static markers（worldInfoBefore/After 等）必须在 chatHistory 之前
 * · R1 WorldbookGuard: 监听 worldinfo_updated，扫描 constant=true 且
 * 内容无动态宏的纯静态 entry，强制 position ∈ {before_char, after_char}
 * - 新增 MVU 报错监听：监听 character_message_rendered，扫描回复中
 * "STATEMENT REJECTED" 等 MVU 解析失败 marker，弹 toast 提示
 * - 保留 v3.0 全部功能（三大块归零 / 自动守护 / MVU 控制台 / initvar 生命周期）
 * - PSIS 与 v3.0 自动守护互不冲突：v3.0 守护管"含动态宏的条目归 atDepth=0"，
 * PSIS R1 管"纯静态条目归 before_char"。两者分流，不互相覆盖。
 * =================================================================
 */

(() => {
 'use strict';

 console.log('[CFS] Loaded v4.0');

 const BTN_NAME = '🛡️ MVU 守护';
 const PANEL_ID = 'cfs-panel';
 const STYLE_ID = 'cfs-style';

 const P = typeof window.parent !== 'undefined' ? window.parent : window;
 const D = P.document;
 const T = P.toastr || window.toastr;
 const askConfirm = (msg) => (P.confirm ? P.confirm(msg) : window.confirm(msg));
 // === spec v2: NotificationCenter helper（toast 统一出口，自动启动期合并/防抖）===
 const NC = () => (P && P.CFS4 && P.CFS4.NotificationCenter) || (window.CFS4 && window.CFS4.NotificationCenter) || null;
 const _coord = () => (P && P.CFS4 && P.CFS4.Coordinator) || (window.CFS4 && window.CFS4.Coordinator) || null;

 // ---------- 配置 ----------
 const CFG = {
 // 修复目标位置（硬编码，不暴露选项）
 FIX_POSITION: 'at_depth_as_user',
 FIX_DEPTH: 0,

 // === 数据库类识别 ===
 DB_COMMENT_PREFIXES: ['TavernDB-', 'tavernDB-', 'ChatSheets-', 'chatSheets-', 'Sheet-', '表-', 'Table-'],
 DB_CONTENT_HINTS: [
 // SQL DDL / DML
 /CREATE\s+(TABLE|INDEX)/i,
 /DROP\s+(TABLE|INDEX|DATABASE)/i,
 /ALTER\s+TABLE/i,
 /INSERT\s+(INTO|OR\s+REPLACE)\s+\w+/i,
 /UPDATE\s+\w+\s+SET/i,
 /DELETE\s+FROM\s+\w+/i,
 /SELECT\s+.+\s+FROM\s+\w+/i,
 /\b(INNER|LEFT|RIGHT|OUTER|CROSS)\s+JOIN\b/i,
 /\bPRIMARY\s+KEY\b/i,
 /\bFOREIGN\s+KEY\b/i,
 // chatSheets 输出 schema 标签
 /<\/?(chatSheets|TavernDB|sheet)[\s>]/i,
 // 中文数据库术语（要求是"数据库/表/字段"+ 后跟动词或冒号才算，避免误伤）
 /数据库\s*(操作|更新|查询|结构|表|字段|记录|规则|协议|schema|更新规则|输出格式)/,
 /(表|字段)\s*(名|结构|约束|定义|更新|插入|删除|记录)/,
 /chatSheets|TavernDB|sheet_\w+/,
 ],

 // === MVU 类识别 ===
 MVU_PATTERNS: [
 // MVU 主接口
 /\bmvu(_update)?\b|\[mvu\]/i,
 /\[?initvar\]?/i,
 // JSON Patch
 /JSONPatch|JSON\s*Patch|RFC\s*6902/i,
 /<\/?(UpdateVariable|Analysis|JSONPatch)\b/i,
 /\bop\s*[:：]\s*(replace|delta|insert|remove|move)\b/i,
 // 变量管理 / 输出格式
 /变量更新规则|变量输出格式|输出格式强调/,
 /format_message_variable|setvar\s*::|getvar\s*::/i,
 // 元叙述标签（移自 v2.9 D 类）
 /<\/?(thinking|analysis|self_check|self_review|reasoning|reflection|cot|chain[_-]?of[_-]?thought|logic_check|审理|自查|审议|审核|内观)\b/i,
 ],

 // === 动态注入识别 ===
 DYNAMIC_PATTERNS: [
 // 通用 {{namespace::args}} — 必须有 :: 才算（避免抓 {{user}}/{{char}}/{{newchat}} 等静态宏）
 /\{\{\s*[a-zA-Z_][\w-]*\s*::/,
 // 内置动态宏（无参数形式）
 /\{\{(lastusermessage|lastmessage|lastcharmessage|random|roll|pick|date|time|weekday|isodate|datetimeformat|input)\s*\}\}/i,
 // EJS（含 <% %> <%- %> <%= %> <% if %> <% for %> 所有形式）
 /<%[\s\S]*?%>/,
 ],

 // 一次性接口（开局用，开局后应禁用）
 EXEMPT_ONESHOT_PATTERNS: [
 /\[?initvar\]?/i,
 /开局\s*(变量\s*)?初始化|变量\s*池\s*初始化/,
 /first[_\s]*reply[_\s]*init|init[_\s]*on[_\s]*first/i,
 ],

 // hotfix v2.2：审查协议类（LLM 自带输出格式协议，关闭与否由用户决定）
 // 命中此类的 entry：CFS UI 不再标"建议启用"，状态显示为"用户决定"
 REVIEW_PROTOCOL_PATTERNS: [
 /\[?mvu_plot\]?/i,
 /\[?plot_review\]?/i,
 /<logic_check\b|<\/logic_check>/i,
 /<plot_review\b|<\/plot_review>/i,
 /合理性审查|普通审查|逻辑审查|审查协议|审查规则/,
 ],
 };

 // ---------- 状态 ----------
 const STATE = {
 scanned: false,
 categoryStats: {
 db: { total: 0, needFix: 0, entries: [] },
 mvu: { total: 0, needFix: 0, entries: [] },
 dynamic: { total: 0, needFix: 0, entries: [] },
 },
 systemEntries: [], // MVU 控制台显示用（同 v2.9）
 lorebooks: { primary: null, additional: [] },
 guardHandle: null,
 guardDebounceTimer: null,
 guardWorking: false,
 guardFixCount: 0,
 autoLifecycleEnabled: false,
 autoLifecycleHandles: [],
 autoLifecycleDebounce: null,
 autoLifecycleWorking: false,
 autoLifecycleLastDecision: null,
 };

 // ---------- 工具 ----------
 const matchAny = (s, patterns) => {
 if (!s) return false;
 for (let i = 0; i < patterns.length; i++) if (patterns[i].test(s)) return true;
 return false;
 };
 const isDbEntry = (comment, content) => {
 if (comment && CFG.DB_COMMENT_PREFIXES.some((p) => comment.indexOf(p) >= 0)) return true;
 if (comment && matchAny(comment, CFG.DB_CONTENT_HINTS)) return true;
 if (content) {
 const head = content.length > 800 ? content.substring(0, 800) : content;
 if (matchAny(head, CFG.DB_CONTENT_HINTS)) return true;
 }
 return false;
 };
 const isMvuEntry = (comment, content) => {
 if (comment && matchAny(comment, CFG.MVU_PATTERNS)) return true;
 if (content) {
 const head = content.length > 800 ? content.substring(0, 800) : content;
 if (matchAny(head, CFG.MVU_PATTERNS)) return true;
 }
 return false;
 };
 const isDynamicEntry = (comment, content) => {
 if (content && matchAny(content, CFG.DYNAMIC_PATTERNS)) return true;
 return false;
 };
 const isOneShotSystemEntry = (comment, content) => {
 if (comment && matchAny(comment, CFG.EXEMPT_ONESHOT_PATTERNS)) return true;
 if (content) {
 const head = content.length > 600 ? content.substring(0, 600) : content;
 if (matchAny(head, CFG.EXEMPT_ONESHOT_PATTERNS)) return true;
 }
 return false;
 };
 // hotfix v2.2：审查协议类 — LLM 输出格式协议（与 MVU 数据流无关，用户已决定 enable/disable）
 const isReviewProtocolEntry = (comment, content) => {
 if (comment && matchAny(comment, CFG.REVIEW_PROTOCOL_PATTERNS)) return true;
 if (content) {
 const head = content.length > 600 ? content.substring(0, 600) : content;
 if (matchAny(head, CFG.REVIEW_PROTOCOL_PATTERNS)) return true;
 }
 return false;
 };
 // 系统接口 = 数据库 ∪ MVU（用于 MVU 控制台 + 守护）
 const isSystemInterface = (comment, content) => isDbEntry(comment, content) || isMvuEntry(comment, content);

 // 三大类分类（一个 entry 可能同属多类，全部归入）
 const classify = (comment, content) => {
 const cats = [];
 if (isDbEntry(comment, content)) cats.push('db');
 if (isMvuEntry(comment, content)) cats.push('mvu');
 if (isDynamicEntry(comment, content)) cats.push('dynamic');
 return cats;
 };

 // 判定：position 或 depth 任一异常 = 需优化
 // === 跟 PSIS R1 对齐===
 // 旧版本只认 at_depth_as_user + depth=0 是已优化，看到 PSIS R1 改的 before_char + role=0
 // 也会报"需优化"。这就是"扫描-修补-PSIS 自动修复"循环冲突根源。
 // 修复：双轨认可
 // - PSIS R1 风格：before_char/after_char + role=0/system → 已优化（cache prefix 内）
 // - v4.x 自管 entry：comment 魔法串识别 → 全部豁免
 // - v3.0 风格：at_depth_as_user + depth=0 → 旧逻辑保留
 const needsOptimize = (entry) => {
 // 1) PSIS R1 认可的静态层位置
 if (entry.position === 'before_character_definition'
 || entry.position === 'after_character_definition') {
 const r = entry.role;
 if (r === null || r === undefined || r === 0 || r === 'system') return false;
 }
 // 2) CFS v4.x 自管 entry 全部豁免
 if (entry.comment && typeof entry.comment === 'string') {
 var c4cmt = entry.comment;
 if (c4cmt.indexOf('[CFS4_SCHEMA|') === 0) return false;
 if (c4cmt.indexOf('[CFS4_LEGACY_DISABLED_') === 0) return false;
 if (c4cmt.indexOf('[CFS4_CLEANED|') === 0) return false;
 }
 if (Array.isArray(entry.keys) && entry.keys.indexOf('_cfs4_managed') >= 0) return false;
 if (entry.extensions && entry.extensions.cfs && entry.extensions.cfs.managed === true) return false;
 // 3) v3.0 风格（旧逻辑保留）：at_depth_as_user + depth=0
 return entry.position !== CFG.FIX_POSITION || entry.depth !== CFG.FIX_DEPTH;
 };

 const esc = (s) =>
 String(s == null ? '' : s)
 .replace(/&/g, '&amp;')
 .replace(/</g, '&lt;')
 .replace(/>/g, '&gt;')
 .replace(/"/g, '&quot;');

 // ---------- 扫描 ----------
 async function scanAll() {
 STATE.categoryStats = {
 db: { total: 0, needFix: 0, entries: [] },
 mvu: { total: 0, needFix: 0, entries: [] },
 dynamic: { total: 0, needFix: 0, entries: [] },
 };
 STATE.systemEntries = [];

 let bind;
 try {
 bind = TavernHelper.getCharLorebooks({ name: 'current' });
 } catch (e) {
 T.error('获取当前角色卡世界书失败：' + e.message);
 return;
 }
 STATE.lorebooks = { primary: bind.primary || null, additional: bind.additional || [] };

 const names = [];
 if (bind.primary) names.push(bind.primary);
 if (Array.isArray(bind.additional)) {
 for (let i = 0; i < bind.additional.length; i++) {
 const n = bind.additional[i];
 if (n && names.indexOf(n) < 0) names.push(n);
 }
 }
 if (names.length === 0) {
 T.warning('当前角色卡没有绑定任何世界书');
 STATE.scanned = true;
 return;
 }

 for (let i = 0; i < names.length; i++) {
 const lorebook = names[i];
 let entries;
 try {
 entries = await TavernHelper.getLorebookEntries(lorebook);
 } catch (e) {
 T.error('读取世界书 "' + lorebook + '" 失败：' + e.message);
 continue;
 }
 for (let j = 0; j < entries.length; j++) {
 const entry = entries[j];
 const cats = classify(entry.comment, entry.content);
 if (cats.length === 0) continue;

 const bad = needsOptimize(entry);
 const rec = {
 lorebook: lorebook,
 uid: entry.uid,
 comment: entry.comment || '(无 comment)',
 enabled: entry.enabled !== false,
 position: entry.position,
 depth: entry.depth,
 categories: cats,
 needFix: bad,
 };
 for (let k = 0; k < cats.length; k++) {
 const cat = cats[k];
 STATE.categoryStats[cat].total++;
 if (bad) STATE.categoryStats[cat].needFix++;
 STATE.categoryStats[cat].entries.push(rec);
 }

 // MVU 控制台数据（系统接口 = db 或 mvu）
 if (cats.indexOf('db') >= 0 || cats.indexOf('mvu') >= 0) {
 STATE.systemEntries.push({
 lorebook: lorebook,
 uid: entry.uid,
 comment: entry.comment || '(无 comment)',
 enabled: entry.enabled !== false,
 subtype: isOneShotSystemEntry(entry.comment, entry.content) ? 'oneshot' : 'persistent',
 contentLen: entry.content ? entry.content.length : 0,
 // hotfix v2.2: 保留 content 头部 300 字符供 isReviewProtocolEntry 判定
 content: typeof entry.content === 'string' ? entry.content.slice(0, 300) : '',
 position: entry.position,
 depth: entry.depth,
 keys: Array.isArray(entry.keys) ? entry.keys.slice() : [],
 });
 }
 }
 }
 STATE.scanned = true;
 }

 // ---------- 修复：按 category 一键归 0 ----------
 // 去重：一个 entry 可能同时属多类，按 lorebook::uid 合并
 function collectTargets(category) {
 const seen = new Set();
 const out = [];
 const list = category === 'all'
 ? STATE.categoryStats.db.entries
 .concat(STATE.categoryStats.mvu.entries)
 .concat(STATE.categoryStats.dynamic.entries)
 : STATE.categoryStats[category].entries;
 for (let i = 0; i < list.length; i++) {
 const r = list[i];
 if (!r.needFix) continue;
 const key = r.lorebook + '::' + r.uid;
 if (seen.has(key)) continue;
 seen.add(key);
 out.push(r);
 }
 return out;
 }

 async function applyFixesByCategory(category, opts) {
 opts = opts || {};
 const silent = !!opts.silent;
 const targets = collectTargets(category);
 if (targets.length === 0) {
 if (!silent) T.info('没有需要优化的条目');
 return 0;
 }
 if (!silent && !opts.skipConfirm) {
 const label = category === 'all' ? '三大块全部' : ({ db: '数据库类', mvu: 'MVU 类', dynamic: '动态注入类' }[category] || category);
 if (!askConfirm('把 ' + targets.length + ' 条 ' + label + ' 条目强制改为 position=at_depth_as_user, depth=0 ？')) return 0;
 }
 const groups = {};
 for (let i = 0; i < targets.length; i++) {
 const t = targets[i];
 if (!groups[t.lorebook]) groups[t.lorebook] = [];
 groups[t.lorebook].push({
 uid: t.uid,
 position: CFG.FIX_POSITION,
 depth: CFG.FIX_DEPTH,
 });
 }
 let success = 0, failed = 0;
 const lbs = Object.keys(groups);
 for (let i = 0; i < lbs.length; i++) {
 try {
 await TavernHelper.setLorebookEntries(lbs[i], groups[lbs[i]]);
 success += groups[lbs[i]].length;
 } catch (e) {
 failed += groups[lbs[i]].length;
 if (!silent) T.error('写回 "' + lbs[i] + '" 失败：' + e.message);
 else console.error('[CFS] 写回 "' + lbs[i] + '" 失败：', e);
 }
 }
 if (!silent) {
 T.success('✅ 已优化: ' + success + ' 条（depth → 0）' + (failed ? '，失败 ' + failed : ''));
 await scanAll();
 render();
 }
 return success;
 }

 // ---------- 守护（仅自动归一三大类异常 depth）----------
 const GUARD_VAR_KEY = 'cfs_guard_enabled';
 function saveGuardState(enabled) {
 try {
 const patch = {}; patch[GUARD_VAR_KEY] = !!enabled;
 insertOrAssignVariables(patch, { type: 'global' });
 } catch (e) { console.warn('[CFS Guard] 保存状态失败', e); }
 }
 function loadGuardState() {
 try {
 const vars = getVariables({ type: 'global' });
 return !!(vars && vars[GUARD_VAR_KEY]);
 } catch (e) { return false; }
 }
 function startGuard() {
 if (STATE.guardHandle) return;
 // v3.1.7 神经化：v3.0 自动守护已被 PSIS R1 完全替代，永久禁用 — 防止 tryRestoreOnReady 误触发
 console.warn('[CFS v3.1.7] startGuard 调用被拦截 — v3.0 守护已永久禁用，PSIS R1 接管');
 saveGuardState(false);
 return;
 /* DEAD CODE 保留以备语义参考 */
 STATE.guardHandle = eventOn('worldinfo_updated', function () {
 if (STATE.guardWorking) return;
 if (STATE.guardDebounceTimer) clearTimeout(STATE.guardDebounceTimer);
 STATE.guardDebounceTimer = setTimeout(async function () {
 STATE.guardDebounceTimer = null;
 STATE.guardWorking = true;
 try {
 await scanAll();
 const n = await applyFixesByCategory('all', { silent: true });
 if (n > 0) {
 STATE.guardFixCount += n;
 console.log('[CFS Guard] 自动归零 ' + n + ' 条（累计 ' + STATE.guardFixCount + '）');
 if (D.getElementById(PANEL_ID)) {
 await scanAll();
 render();
 }
 }
 } catch (e) { console.error('[CFS Guard] 守护异常', e); }
 finally { STATE.guardWorking = false; }
 }, 800);
 });
 console.log('[CFS Guard] 已启用');
 }
 function stopGuard() {
 if (!STATE.guardHandle) return;
 STATE.guardHandle.stop();
 STATE.guardHandle = null;
 if (STATE.guardDebounceTimer) { clearTimeout(STATE.guardDebounceTimer); STATE.guardDebounceTimer = null; }
 console.log('[CFS Guard] 已停用');
 }
 function toggleGuard() {
 if (STATE.guardHandle) {
 stopGuard(); saveGuardState(false);
 T.info('自动守护已停用'); render();
 } else {
 startGuard(); saveGuardState(true);
 T.success('自动守护已启用 — 每次世界书更新自动把三大块 depth 归 0');
 render();
 }
 }

 // ---------- MVU 系统接口生命周期 ----------
 async function applySystemEntryPatches(patchesByLb) {
 let success = 0, failed = 0;
 const lbs = Object.keys(patchesByLb);
 for (let i = 0; i < lbs.length; i++) {
 const lb = lbs[i];
 try {
 await TavernHelper.setLorebookEntries(lb, patchesByLb[lb]);
 success += patchesByLb[lb].length;
 } catch (e) {
 failed += patchesByLb[lb].length;
 T.error('写回 "' + lb + '" 失败：' + e.message);
 }
 }
 return { success: success, failed: failed };
 }

 function getRealAiReplyCount() {
 try {
 const ctx = (typeof SillyTavern !== 'undefined') ? SillyTavern.getContext() : null;
 if (!ctx || !ctx.chat || !Array.isArray(ctx.chat)) return -1;
 let count = 0;
 for (let i = 2; i < ctx.chat.length; i++) {
 const m = ctx.chat[i];
 if (m && !m.is_user) count++;
 }
 return count;
 } catch (e) { return -1; }
 }
 function getChatStateLabel() {
 const c = getRealAiReplyCount();
 if (c < 0) return '<i>未知（无法读取 chat）</i>';
 if (c === 0) return '🆕 新会话（应启用 initvar 等 AI 第一轮回复完成初始化）';
 return '📖 已对话 (' + c + ' 轮 AI 回复)（应禁用 initvar）';
 }

 const AUTO_LIFECYCLE_VAR_KEY = 'cfs_auto_lifecycle_enabled';
 function saveAutoLifecycleState(enabled) {
 try {
 const patch = {}; patch[AUTO_LIFECYCLE_VAR_KEY] = !!enabled;
 insertOrAssignVariables(patch, { type: 'global' });
 } catch (e) {}
 }
 function loadAutoLifecycleState() {
 try {
 const vars = getVariables({ type: 'global' });
 if (!vars || vars[AUTO_LIFECYCLE_VAR_KEY] === undefined) return true;
 return !!vars[AUTO_LIFECYCLE_VAR_KEY];
 } catch (e) { return true; }
 }

 async function enforceLifecycle() {
 if (STATE.autoLifecycleWorking) return;
 STATE.autoLifecycleWorking = true;
 try {
 const aiCount = getRealAiReplyCount();
 if (aiCount < 0) return;
 const shouldEnable = (aiCount === 0);
 const decision = shouldEnable ? 'new_chat' : 'in_progress';

 let bind;
 try { bind = TavernHelper.getCharLorebooks({ name: 'current' }); } catch (e) { return; }
 const names = [];
 if (bind && bind.primary) names.push(bind.primary);
 if (bind && Array.isArray(bind.additional)) {
 for (let i = 0; i < bind.additional.length; i++) {
 const n = bind.additional[i];
 if (n && names.indexOf(n) < 0) names.push(n);
 }
 }
 if (names.length === 0) return;

 const oneshotTargets = [];
 for (let i = 0; i < names.length; i++) {
 const lorebook = names[i];
 let entries;
 try { entries = await TavernHelper.getLorebookEntries(lorebook); } catch (e) { continue; }
 for (let j = 0; j < entries.length; j++) {
 const e = entries[j];
 if (!isSystemInterface(e.comment, e.content)) continue;
 if (!isOneShotSystemEntry(e.comment, e.content)) continue;
 if (e.enabled !== shouldEnable) {
 oneshotTargets.push({ lorebook: lorebook, uid: e.uid, comment: e.comment });
 }
 }
 }
 STATE.autoLifecycleLastDecision = decision;
 if (oneshotTargets.length === 0) return;

 const groups = {};
 for (let i = 0; i < oneshotTargets.length; i++) {
 const t = oneshotTargets[i];
 if (!groups[t.lorebook]) groups[t.lorebook] = [];
 const patch = { uid: t.uid, enabled: shouldEnable };
 // v3.1.7：禁用 enforceLifecycle 改 position 行为（保 enable/disable 但不动 position）
 // if (!shouldEnable) { patch.position = CFG.FIX_POSITION; patch.depth = CFG.FIX_DEPTH; }
 groups[t.lorebook].push(patch);
 }
 const r = await applySystemEntryPatches(groups);
 if (r.success > 0) {
 const action = shouldEnable ? '🆕 启用' : '🔒 关闭';
 const cmts = oneshotTargets.map(function (t) { return t.comment; }).join(', ');
 T.info('🤖 自动生命周期：' + action + ' ' + r.success + ' 条 initvar — ' + cmts);
 if (D.getElementById(PANEL_ID)) { await scanAll(); render(); }
 }
 } catch (e) { console.error('[CFS Auto] enforceLifecycle 失败', e); }
 finally { STATE.autoLifecycleWorking = false; }
 }
 function debounceLifecycle() {
 if (STATE.autoLifecycleDebounce) clearTimeout(STATE.autoLifecycleDebounce);
 STATE.autoLifecycleDebounce = setTimeout(enforceLifecycle, 600);
 }
 function startAutoLifecycle() {
 if (STATE.autoLifecycleHandles.length > 0) return;
 try { STATE.autoLifecycleHandles.push(eventOn('chat_id_changed', debounceLifecycle)); } catch (e) {}
 try { STATE.autoLifecycleHandles.push(eventOn('character_message_rendered', debounceLifecycle)); } catch (e) {}
 try { STATE.autoLifecycleHandles.push(eventOn('message_deleted', debounceLifecycle)); } catch (e) {}
 try { STATE.autoLifecycleHandles.push(eventOn('chat_deleted', debounceLifecycle)); } catch (e) {}
 STATE.autoLifecycleEnabled = true;
 debounceLifecycle();
 }
 function stopAutoLifecycle() {
 for (let i = 0; i < STATE.autoLifecycleHandles.length; i++) {
 try { STATE.autoLifecycleHandles[i].stop(); } catch (e) {}
 }
 STATE.autoLifecycleHandles = [];
 if (STATE.autoLifecycleDebounce) { clearTimeout(STATE.autoLifecycleDebounce); STATE.autoLifecycleDebounce = null; }
 STATE.autoLifecycleEnabled = false;
 }
 function toggleAutoLifecycle() {
 if (STATE.autoLifecycleEnabled) {
 stopAutoLifecycle(); saveAutoLifecycleState(false);
 T.info('自动 initvar 生命周期已停用');
 } else {
 startAutoLifecycle(); saveAutoLifecycleState(true);
 T.success('自动 initvar 生命周期已启用');
 }
 if (D.getElementById(PANEL_ID)) render();
 }

 // ---------- MVU 控制台三按钮 ----------
 async function restorePersistentInterfaces() {
 const list = STATE.systemEntries;
 const targets = list.filter(function (s) {
 var isV4M = Array.isArray(s.keys) && s.keys.indexOf('_cfs4_managed_mvu') >= 0;
 return s.subtype === 'persistent' && !s.enabled && !isV4M;
 });
 if (targets.length === 0) { T.info('没有需要修回的常驻接口'); return; }
 if (!askConfirm('把 ' + targets.length + ' 条被禁用的常驻系统接口启用回来吗？')) return;
 const groups = {};
 for (let i = 0; i < targets.length; i++) {
 const t = targets[i];
 if (!groups[t.lorebook]) groups[t.lorebook] = [];
 groups[t.lorebook].push({ uid: t.uid, enabled: true });
 }
 const r = await applySystemEntryPatches(groups);
 T.success('✅ 已修回: ' + r.success + ' 条' + (r.failed ? '，失败 ' + r.failed : ''));
 await scanAll(); render();
 }
 async function enableAllSystemInterfaces() {
 const list = STATE.systemEntries;
 const targets = list.filter(function (s) { return !s.enabled; });
 if (targets.length === 0) { T.info('所有系统接口已全部启用'); return; }
 const oneshotCount = targets.filter(function (s) { return s.subtype === 'oneshot'; }).length;
 if (!askConfirm('启用全部 ' + targets.length + ' 条系统接口（含 ' + oneshotCount + ' 条 initvar）？\n开局后记得关 initvar。')) return;
 const groups = {};
 for (let i = 0; i < targets.length; i++) {
 const t = targets[i];
 if (!groups[t.lorebook]) groups[t.lorebook] = [];
 groups[t.lorebook].push({ uid: t.uid, enabled: true });
 }
 const r = await applySystemEntryPatches(groups);
 T.success('✅ 已启用: ' + r.success + ' 条 initvar');
 await scanAll(); render();
 }
 async function disableOneShotInterfaces() {
 const list = STATE.systemEntries;
 const targets = list.filter(function (s) { return s.subtype === 'oneshot' && s.enabled; });
 if (targets.length === 0) { T.info('没有需要关闭的一次性接口'); return; }
 if (!askConfirm('禁用 ' + targets.length + ' 条一次性 initvar 接口？\n顺便把 position 改成 at_depth_as_user/depth=0 cache 友好。')) return;
 const groups = {};
 for (let i = 0; i < targets.length; i++) {
 const t = targets[i];
 if (!groups[t.lorebook]) groups[t.lorebook] = [];
 groups[t.lorebook].push({
 uid: t.uid, enabled: false,
 position: CFG.FIX_POSITION, depth: CFG.FIX_DEPTH,
 });
 }
 const r = await applySystemEntryPatches(groups);
 T.success('✅ 已关闭: ' + r.success + ' 条 initvar');
 await scanAll(); render();
 }

 // ---------- UI ----------
 function closePanel() {
 const panel = D.getElementById(PANEL_ID);
 if (panel) panel.remove();
 }
 function openOrTogglePanel() {
 let panel = D.getElementById(PANEL_ID);
 if (panel) {
 panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
 return;
 }
 if (!D.getElementById(STYLE_ID)) {
 const style = D.createElement('style');
 style.id = STYLE_ID;
 style.textContent = STYLE_CSS;
 D.head.appendChild(style);
 }
 panel = D.createElement('div');
 panel.id = PANEL_ID;
 D.body.appendChild(panel);
 // ESC 关闭面板（只绑定一次）
 if (!D._cfsEscBound) {
 D._cfsEscBound = true;
 D.addEventListener('keydown', function (e) {
 if (e.key === 'Escape') {
 const p = D.getElementById(PANEL_ID);
 if (p && p.style.display !== 'none') p.style.display = 'none';
 }
 });
 }
 render();
 }

 function renderCategoryBlock(catKey, label, icon) {
 const s = STATE.categoryStats[catKey];
 const ok = s.total - s.needFix;
 const fixBtnCls = s.needFix > 0 ? 'cfs-btn cfs-btn-warn' : 'cfs-btn cfs-btn-disabled';
 const fixBtnDisabled = s.needFix === 0 ? 'disabled' : '';
 return '<div class="cfs-cat-block">' +
 '<div class="cfs-cat-head">' +
 '<span class="cfs-cat-icon">' + icon + '</span>' +
 '<span class="cfs-cat-label">' + label + '</span>' +
 '<span class="cfs-cat-stats">共 <b>' + s.total + '</b> 条 ｜ ' +
 (s.needFix > 0
 ? '<span class="cfs-needfix">⚠️ 需优化 <b>' + s.needFix + '</b></span>'
 : '<span class="cfs-allok">✅ 全部 depth=0</span>') +
 ' ｜ 已优化 ' + ok + '</span>' +
 '</div>' +
 '<div class="cfs-cat-action">' +
 '<button class="' + fixBtnCls + '" data-fix-cat="' + catKey + '" ' + fixBtnDisabled + '>⚡ 归零' +
 (s.needFix > 0 ? ' (' + s.needFix + ')' : '') +
 '</button>' +
 '</div>' +
 '</div>';
 }

 function renderMvuConsole() {
 const list = STATE.systemEntries;
 if (list.length === 0) {
 return '<details class="cfs-mvu"><summary>🔧 MVU 系统接口管理（未发现系统接口）</summary></details>';
 }
 const persistent = list.filter(function (s) { return s.subtype === 'persistent'; });
 const oneshot = list.filter(function (s) { return s.subtype === 'oneshot'; });
 // hotfix v2.2: 审查协议 entry 不计入"建议启用"计数（用户已决定）
 const persistDisabled = persistent.filter(function (s) {
 var isV4M = Array.isArray(s.keys) && s.keys.indexOf('_cfs4_managed_mvu') >= 0;
 var isReview = isReviewProtocolEntry(s.comment, s.content);
 return !s.enabled && !isV4M && !isReview;
 }).length;
 const oneshotEnabled = oneshot.filter(function (s) { return s.enabled; }).length;

 const renderEntry = function (s) {
 const status = s.enabled ? '<span class="cfs-mvu-ok">✅ 已启用</span>' : '<span class="cfs-mvu-no">❌ 已禁用</span>';
 const isV4Managed = Array.isArray(s.keys) && s.keys.indexOf('_cfs4_managed_mvu') >= 0;
 // hotfix v2.2: 审查协议类（mvu_plot / 逻辑审查 / 普通审查）→ 用户决定不强建议
 const isReview = isReviewProtocolEntry(s.comment, s.content);
 const warn = isV4Managed
 ? ' <span class="cfs-mvu-warn cfs-mvu-v4managed">✅ v4.x 接管中</span>'
 : isReview
 ? ' <span class="cfs-mvu-warn cfs-mvu-review">✋ 审查协议（用户决定）</span>'
 : (s.subtype === 'persistent' && !s.enabled)
 ? ' <span class="cfs-mvu-warn">⚠️ 建议启用</span>'
 : (s.subtype === 'oneshot' && s.enabled)
 ? ' <span class="cfs-mvu-warn">⚠️ 开局后建议关</span>'
 : '';
 return '<div class="cfs-mvu-entry">' +
 '<span class="cfs-mvu-name">' + esc(s.comment) + '</span>' +
 '<span class="cfs-mvu-meta">uid=' + s.uid + ' · ' + esc(s.lorebook) + '</span>' +
 '<span class="cfs-mvu-status">' + status + warn + '</span>' +
 '</div>';
 };

 const autoOn = STATE.autoLifecycleEnabled;
 const autoBtnText = autoOn ? '🤖 已自动管理' : '🤖 自动管理（已关）';
 const autoBtnCls = autoOn ? 'cfs-btn cfs-btn-guard-on' : 'cfs-btn';
 const chatState = getChatStateLabel();

 // v4.x 状态行（mvu_fallback / v4_full / v4_degraded）
 let v4StatusHtml = '';
 try {
 const v4 = (window.parent && window.parent.CFS4) || window.CFS4;
 if (v4 && v4.FallbackStrategy && typeof v4.FallbackStrategy.getCurrentMode === 'function') {
 const mode = v4.FallbackStrategy.getCurrentMode();
 const labels = { 'mvu_fallback': '⚪ 未接管', 'v4_full': '🟢 接管中', 'v4_degraded': '🟡 已降级' };
 const last = (v4.InjectionStrategy && typeof v4.InjectionStrategy.getLastInjection === 'function')
 ? v4.InjectionStrategy.getLastInjection() : null;
 const statsTxt = (mode === 'v4_full' && last)
 ? ' · 注入 ' + last.injected_chars + ' 字符 · 接管 ' + last.mvu_disabled_count + ' 条 mvu'
 : '';
 v4StatusHtml =
 '<div class="cfs-v4-status">' +
 '<span class="cfs-v4-mode-label">v4.x:</span>' +
 '<span class="cfs-v4-mode-badge cfs-v4-mode-' + mode + '">' + (labels[mode] || mode) + '</span>' +
 '<span class="cfs-v4-stats">' + statsTxt + '</span>' +
 '</div>';
 }
 } catch (e) {}

 // === spec v2: Coordinator 启动状态区块 ===
 let coordStatusHtml = '';
 try {
 const v4 = (window.parent && window.parent.CFS4) || window.CFS4;
 const co = v4 && v4.Coordinator;
 if (co && typeof co.getState === 'function') {
 const st = co.getState();
 const summary = st.summary || {};
 const v4xSum = summary.v4_bootstrap || null;
 const dur = st.startup_time_ms ? ' (用时 ' + (st.startup_time_ms / 1000).toFixed(1) + 's)' : '';

 // hotfix v2.2: 用 FallbackStrategy.getCurrentMode 作为"真接管"权威信号
 // 避免 v4_bootstrap plugin 因延迟注册时序问题让 summary 缺失但实际已接管的 UI 矛盾
 let fsMode = null;
 try { fsMode = v4 && v4.FallbackStrategy && v4.FallbackStrategy.getCurrentMode && v4.FallbackStrategy.getCurrentMode(); } catch (e0) {}
 const fsActive = (fsMode === 'v4_full');

 let icon, text, cls, detailHtml = '';
 const isReadyNoMvu = (st.phase === 'READY_NO_MVU') || (v4xSum && v4xSum.summary && /no_mvu_card|未使用 MVU/.test(v4xSum.summary));
 const isTimeout = st.phase === 'TIMEOUT' || (v4xSum && v4xSum.summary && /timeout|未就绪/.test(v4xSum.summary));
 const summaryOk = v4xSum && v4xSum.ok === true && !isReadyNoMvu;
 // 真接管 OR：① Coordinator summary 上报 OK ② FallbackStrategy 已 v4_full
 const isOk = (st.phase === 'DONE' || st.phase === 'READY_FULL') && (summaryOk || fsActive);

 if (fsActive && st.phase !== 'TIMEOUT' && !isReadyNoMvu) {
 // 接管已生效（最强信号），即使 Coordinator summary 缺失也优先显示绿
 icon = '✅'; text = '接管中' + dur; cls = 'cfs-coord-ok';
 detailHtml = v4xSum && v4xSum.summary
 ? '<div class="cfs-coord-detail-mini">' + esc(v4xSum.summary) + '</div>'
 : '<div class="cfs-coord-detail-mini">FallbackStrategy.mode = v4_full</div>';
 } else if (st.phase === 'BOOTING' || st.phase === 'PROBING') {
 icon = '⏳'; text = '等待会话进入'; cls = 'cfs-coord-pending';
 detailHtml = '<div class="cfs-coord-detail-mini">SessionGate 探针: ' + (co._chatChangedSeen ? '已收到 chat_changed' : '等待 chat_changed') + '</div>' +
 // v2.5: 移动端等不及可点按钮立即重试接管
 '<div class="cfs-coord-actions">' +
 '<button id="cfs-coord-btn-takeover" class="cfs-btn cfs-btn-takeover-light" title="点击立即重试接管探针">立即重试接管</button>' +
 '</div>';
 } else if (isTimeout) {
 icon = '❌'; text = '接管失败' + dur; cls = 'cfs-coord-fail';
 detailHtml =
 '<div class="cfs-coord-detail">' +
 '原因：等待 60s 仍未拿到 <code>Mvu.getMvuData()</code>。可能 MVU 扩展未装、加载慢、或本卡未用 MVU。<br/>' +
 '<div class="cfs-coord-actions">' +
 '<button id="cfs-coord-btn-takeover" class="cfs-btn cfs-btn-takeover" title="超时后手动重试接管（手机端可用，无需 F12）">超时手动接管</button>' +
 '<button id="cfs-coord-btn-copy-f12" class="cfs-btn cfs-btn-copy" title="复制 F12 控制台命令">复制 F12 命令</button>' +
 '</div>' +
 '仓库：<a href="https://github.com/OreoCoins/CFS-SillyTavern" target="_blank">github.com/OreoCoins/CFS-SillyTavern</a>' +
 '</div>';
 } else if (isReadyNoMvu) {
 icon = '—'; text = '未启用（本卡未使用 MVU）' + dur; cls = 'cfs-coord-skip';
 detailHtml = '<div class="cfs-coord-detail-mini">PSIS 仍正常运行</div>';
 } else if (isOk) {
 icon = '✅'; text = '接管中' + dur; cls = 'cfs-coord-ok';
 if (v4xSum && v4xSum.summary) detailHtml = '<div class="cfs-coord-detail-mini">' + esc(v4xSum.summary) + '</div>';
 } else {
 icon = '⏳'; text = '准备中'; cls = 'cfs-coord-pending';
 detailHtml = '<div class="cfs-coord-detail-mini">phase=' + esc(st.phase) + ' fs_mode=' + esc(fsMode || '?') + '</div>' +
 // v2.5: 异常状态下也允许手动救回
 '<div class="cfs-coord-actions">' +
 '<button id="cfs-coord-btn-takeover" class="cfs-btn cfs-btn-takeover-light" title="点击立即重试接管">立即重试接管</button>' +
 '</div>';
 }

 coordStatusHtml =
 '<div class="cfs-coord-status ' + cls + '">' +
 '<div class="cfs-coord-head"><b>v4.x 启动状态：</b>' + icon + ' ' + esc(text) + '</div>' +
 detailHtml +
 '</div>';
 }
 } catch (e) {}

 let html = '<details class="cfs-mvu" open>' +
 '<summary>🔧 MVU 系统接口管理（' + list.length + ' 条；常驻 <b>' + persistent.length + '</b> / 一次性 <b>' + oneshot.length + '</b>）</summary>' +
 '<div class="cfs-mvu-body">' +
 v4StatusHtml +
 coordStatusHtml +
 '<div class="cfs-mvu-auto">' +
 '<button id="cfs-mvu-auto-toggle" class="' + autoBtnCls + '" title="切卡/新会话自动开 initvar；AI 第一轮回复后自动关">' + autoBtnText + '</button>' +
 '<span class="cfs-mvu-auto-state">📍 当前: ' + chatState + '</span>' +
 '</div>';
 if (persistent.length > 0) {
 html += '<div class="cfs-mvu-section"><div class="cfs-mvu-title">常驻接口（应永远启用）</div>' +
 persistent.map(renderEntry).join('') + '</div>';
 }
 if (oneshot.length > 0) {
 html += '<div class="cfs-mvu-section"><div class="cfs-mvu-title">一次性接口（开局用，开局后关）</div>' +
 oneshot.map(renderEntry).join('') + '</div>';
 }
 html += '<div class="cfs-mvu-actions">' +
 '<button id="cfs-mvu-restore" class="cfs-btn ' + (persistDisabled > 0 ? 'cfs-btn-primary' : '') + '" title="把被禁用的常驻接口一键修回">' +
 '🔁 修回常驻 ' + (persistDisabled > 0 ? '(' + persistDisabled + ')' : '') + '</button>' +
 '<button id="cfs-mvu-open" class="cfs-btn" title="开新卡 / 重置变量池前用">🆕 开新卡前</button>' +
 '<button id="cfs-mvu-close" class="cfs-btn ' + (oneshotEnabled > 0 ? 'cfs-btn-warn' : '') + '" title="AI 第一轮完成后用">' +
 '🔒 关 initvar ' + (oneshotEnabled > 0 ? '(' + oneshotEnabled + ')' : '') + '</button>' +
 '</div>' +
 '<div class="cfs-mvu-tip">💡 典型生命周期：<b>开新卡前</b> → AI 第一轮 → <b>关 initvar</b>。</div>' +
 '</div></details>';
 // v4.9 SEM section
 try {
  const _semNs = (window.parent && window.parent.CFS4 && window.parent.CFS4.SEM) || (window.CFS4 && window.CFS4.SEM);
  if (_semNs && typeof _semNs.renderSection === 'function') {
   html += _semNs.renderSection();
  }
 } catch (eSem) { console.warn('[CFS] SEM renderSection 失败', eSem); }
 // v4.9.2 PSIS Plus section
 try {
  const _ppNs = (window.parent && window.parent.CFS4 && window.parent.CFS4.PSISPlus) || (window.CFS4 && window.CFS4.PSISPlus);
  if (_ppNs && typeof _ppNs.renderSection === 'function') {
   html += _ppNs.renderSection();
  }
 } catch (ePp) { console.warn('[CFS] PSIS Plus renderSection 失败', ePp); }
 return html;
 }

 function render() {
 const panel = D.getElementById(PANEL_ID);
 if (!panel) return;

 const lbInfo = [];
 if (STATE.lorebooks.primary) lbInfo.push('<b>主</b> ' + esc(STATE.lorebooks.primary));
 if (Array.isArray(STATE.lorebooks.additional)) {
 for (let i = 0; i < STATE.lorebooks.additional.length; i++)
 lbInfo.push('<b>附</b> ' + esc(STATE.lorebooks.additional[i]));
 }

 const totalNeedFix =
 STATE.categoryStats.db.needFix +
 STATE.categoryStats.mvu.needFix +
 STATE.categoryStats.dynamic.needFix;
 const allBtnCls = totalNeedFix > 0 ? 'cfs-btn cfs-btn-allfix' : 'cfs-btn cfs-btn-disabled';
 const allBtnDisabled = totalNeedFix === 0 ? 'disabled' : '';

 const guarding = !!STATE.guardHandle;
 const guardBtnText = guarding ? '🛡️ 守护中…' : '🛡️ 启用自动守护';
 const guardBtnCls = guarding ? 'cfs-btn cfs-btn-guard-on' : 'cfs-btn';
 const guardStatLine = guarding
 ? '🛡️ 守护已启用 ｜ 累计自动归零 <b>' + STATE.guardFixCount + '</b> 条'
 : '';

 const scanHint = STATE.scanned ? '' : '<div class="cfs-empty">点【🔍 扫描】开始</div>';

 // v4.9 分级状态：浅度（PSIS） / 中度（v4.x 接管） / 深度（SEM 迁移）
 let tierBarHtml = '';
 let semActive = false;
 let semCnt = 0;
 try {
  const _v4 = (window.parent && window.parent.CFS4) || window.CFS4;
  const _sem = _v4 && _v4.SEM;
  if (_sem && typeof _sem.hasMigrations === 'function') {
   semActive = _sem.hasMigrations();
   if (semActive) semCnt = Object.keys(JSON.parse(localStorage.getItem('cfs_sem_migrations_v1') || '{}')).length;
  }
  const _fs = _v4 && _v4.FallbackStrategy;
  const _midActive = _fs && _fs.getCurrentMode && _fs.getCurrentMode() === 'v4_full';
  const _shallowActive = true; // PSIS 始终启用
  const _legacyPaused = semActive; // SEM 启用时，v3.1.7「三大块归零」暂停
  tierBarHtml = '<div class="cfs-tier-bar">' +
   '<span class="cfs-tier-item cfs-tier-' + (_shallowActive ? 'on' : 'off') + '" title="PSIS 提示词结构守护，不动 worldbook entry">浅度 ' + (_shallowActive ? '✓' : '○') + ' PSIS</span>' +
   '<span class="cfs-tier-item cfs-tier-' + (_midActive ? 'on' : 'off') + '" title="v4.x SCHEMA + STABLE_BATCH 接管 + disable MVU 渲染 entry">中度 ' + (_midActive ? '✓' : '○') + ' 接管</span>' +
   '<span class="cfs-tier-item cfs-tier-' + (semActive ? 'on' : 'off') + '" title="SEM 把稳态 entry 迁到 prefix 区">深度 ' + (semActive ? '✓ (' + semCnt + ' 条)' : '○') + ' 迁移</span>' +
   (_legacyPaused ? '<span class="cfs-tier-item cfs-tier-paused" title="深度优化启用时，浅度 Legacy 自动暂停以避免目标冲突">Legacy 三大块归零 ⏸ 已暂停</span>' : '') +
   '</div>';
 } catch (eTb) {}

 const _fixAllPaused = semActive;
 const _fixAllCls = _fixAllPaused ? 'cfs-btn cfs-btn-disabled' : allBtnCls;
 const _fixAllDisabled = _fixAllPaused ? 'disabled' : allBtnDisabled;
 const _fixAllTitle = _fixAllPaused
  ? '深度优化已启用，浅度 Legacy「三大块归零」自动暂停。若需启用请先全部回滚 SEM 迁移'
  : '一键把三大块全部需优化的强制改成 at_depth_as_user, depth=0';
 const _fixAllText = _fixAllPaused ? '⏸ 三大块归零（已暂停）' : ('⚡⚡ 三大块全部归零' + (totalNeedFix > 0 ? ' (' + totalNeedFix + ')' : ''));

 panel.innerHTML =
 '<div class="cfs-card">' +
 '<div class="cfs-head">' +
 '<h3>🛡️ CFS v4.9.3 (PSIS v3.1.7 + PSIS+ v4.9.3 + 接管 v4.8.1 + SEM v4.9.1)</h3>' +
 '<button class="cfs-close" id="cfs-btn-close" title="关闭">✕</button>' +
 '<div class="cfs-lbs">' + (lbInfo.join(' · ') || '<i>未识别绑定世界书 — 先扫描</i>') + '</div>' +
 '</div>' +
 tierBarHtml +
 '<div class="cfs-ctrl">' +
 '<button id="cfs-btn-scan" class="cfs-btn cfs-btn-primary">🔍 扫描</button>' +
 '<button id="cfs-btn-fix-all" class="' + _fixAllCls + '" ' + _fixAllDisabled + ' title="' + _fixAllTitle + '">' +
 _fixAllText + '</button>' +
 '<button id="cfs-btn-guard" class="' + guardBtnCls + '" title="每次世界书更新自动把三大块 depth 归 0">' + guardBtnText + '</button>' +
 '</div>' +
 (guardStatLine ? '<div class="cfs-guard-stat">' + guardStatLine + '</div>' : '') +
 '<div class="cfs-cat-zone">' +
 '<div class="cfs-cat-title">📊 三大块 depth 排序（position=at_depth_as_user 且 depth=0 视为已优化）</div>' +
 (STATE.scanned
 ? renderCategoryBlock('db', '数据库类条目', '🗃️') +
 renderCategoryBlock('mvu', 'MVU/系统接口类', '🧬') +
 renderCategoryBlock('dynamic', '动态注入类（含动态宏 / EJS）', '⚡')
 : scanHint) +
 '</div>' +
 renderMvuConsole() +
 '<div class="cfs-footer">' +
 '<details><summary>说明</summary>' +
 '<ul>' +
 '<li>三大块：<b>数据库</b>（chatSheets/SQL 关键词/&lt;chatSheets&gt;标签）+ <b>MVU</b>（mvu_update/initvar/JSONPatch/&lt;thinking&gt;等元叙述标签/变量管理）+ <b>动态注入</b>（{{X::params}}/&lt;% EJS %&gt;/{{lastmessage}} 等）。</li>' +
 '<li>判定：<code>position</code> ≠ <code>at_depth_as_user</code> 或 <code>depth</code> ≠ 0 任一即视为需优化。</li>' +
 '<li>修复：强制 <code>position=at_depth_as_user</code> + <code>depth=0</code>（插入到 chatHistory 末尾、紧贴最新 user 消息），前置静态 prefix 不被破坏。</li>' +
 '<li>通用 cache 优化（A 动态宏前置 / B 扫描深度 / D 强制元叙述禁用）请用社区脚本「世界书缓存优化器」（jerryzmtz/worldbook-manager），CFS 不再做。</li>' +
 '</ul></details>' +
 '</div>' +
 '</div>';

 // 事件绑定
 D.getElementById('cfs-btn-close').onclick = closePanel;
 D.getElementById('cfs-btn-scan').onclick = async function () {
 T.info('🔍 扫描中…');
 await scanAll();
 render();
 const t = STATE.categoryStats.db.total + STATE.categoryStats.mvu.total + STATE.categoryStats.dynamic.total;
 const n = STATE.categoryStats.db.needFix + STATE.categoryStats.mvu.needFix + STATE.categoryStats.dynamic.needFix;
 T.success('✅ 扫描完成: 三大块 ' + t + ' 条命中，' + n + ' 条需优化');
 };
 const btnAll = D.getElementById('cfs-btn-fix-all');
 if (btnAll && !btnAll.disabled) btnAll.onclick = function () { applyFixesByCategory('all'); };
 const fixBtns = panel.querySelectorAll('[data-fix-cat]');
 for (let i = 0; i < fixBtns.length; i++) {
 const b = fixBtns[i];
 if (b.disabled) continue;
 b.onclick = function () { applyFixesByCategory(b.getAttribute('data-fix-cat')); };
 }
 D.getElementById('cfs-btn-guard').onclick = toggleGuard;
 const btnRestore = D.getElementById('cfs-mvu-restore');
 if (btnRestore) btnRestore.onclick = restorePersistentInterfaces;
 const btnOpen = D.getElementById('cfs-mvu-open');
 if (btnOpen) btnOpen.onclick = enableAllSystemInterfaces;
 const btnClose = D.getElementById('cfs-mvu-close');
 if (btnClose) btnClose.onclick = disableOneShotInterfaces;
 const btnAutoToggle = D.getElementById('cfs-mvu-auto-toggle');
 if (btnAutoToggle) btnAutoToggle.onclick = toggleAutoLifecycle;

 // v2.5: 移动端按钮 — 超时手动接管 + 复制 F12 命令
 const btnTakeover = D.getElementById('cfs-coord-btn-takeover');
 if (btnTakeover) btnTakeover.onclick = async function () {
 const v4 = (P && P.CFS4) || window.CFS4;
 if (!v4 || !v4.InjectionStrategy || typeof v4.InjectionStrategy.bootstrapTakeover !== 'function') {
 if (T) T.error('CFS v4.x 未加载，无法接管。请确认脚本已启用 + F5 刷新');
 return;
 }
 btnTakeover.disabled = true;
 const _oldText = btnTakeover.textContent;
 btnTakeover.textContent = '接管中...';
 try {
 const res = await v4.InjectionStrategy.bootstrapTakeover({ force: true });
 if (res && res.success) {
 const inj = res.steps && res.steps.find(function (s) { return s.step === 'applyInjection'; });
 const chars = (inj && inj.result && inj.result.injected_chars) || 0;
 if (T) T.success('手动接管成功，注入 ' + chars + ' 字符', '', { timeOut: 6000 });
 } else if (res && res.skipped) {
 if (T) T.warning('启动门控未放行：' + (res.reason || '未知') + '，phase=' + (res.phase || '?') + '。稍等几秒再点', '', { timeOut: 8000 });
 } else {
 const errStep = res && res.steps && res.steps.find(function (s) { return s.error || s.skipped; });
 const errMsg = (errStep && (errStep.error || JSON.stringify(errStep.skipped))) || (res && res.reason) || '未知';
 if (T) T.error('接管失败：' + errMsg + '。可能 MVU 扩展未装或未启用', '', { timeOut: 12000 });
 }
 } catch (e) {
 if (T) T.error('接管异常：' + (e && e.message), '', { timeOut: 10000 });
 } finally {
 btnTakeover.disabled = false;
 btnTakeover.textContent = _oldText;
 setTimeout(render, 300); // 等 mode change 事件先到，再 render
 }
 };

 const btnCopyF12 = D.getElementById('cfs-coord-btn-copy-f12');
 if (btnCopyF12) btnCopyF12.onclick = async function () {
 const cmd = 'window.CFS4.InjectionStrategy.bootstrapTakeover({force: true})';
 try {
 if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
 await navigator.clipboard.writeText(cmd);
 if (T) T.success('F12 命令已复制到剪贴板', '', { timeOut: 4000 });
 } else {
 if (T) T.info('剪贴板不可用。命令：' + cmd, '', { timeOut: 15000 });
 }
 } catch (e) {
 if (T) T.info('复制失败。命令：' + cmd, '', { timeOut: 15000 });
 }
 };

 // v4.9 SEM: 绑定 section 内事件 + 面板拖动 + 位置恢复
 try {
 const _semNs2 = (window.parent && window.parent.CFS4 && window.parent.CFS4.SEM) || (window.CFS4 && window.CFS4.SEM);
 if (_semNs2) {
 if (typeof _semNs2.bindEvents === 'function') _semNs2.bindEvents(D, function () { return panel; });
 if (typeof _semNs2.makeDraggable === 'function') _semNs2.makeDraggable(D, panel);
 if (typeof _semNs2.restorePos === 'function') _semNs2.restorePos(D, panel);
 }
 } catch (eSem2) { console.warn('[CFS] SEM bindEvents 失败', eSem2); }

 // v4.9.2 PSIS Plus: 绑定 section 内事件
 try {
 const _ppNs2 = (window.parent && window.parent.CFS4 && window.parent.CFS4.PSISPlus) || (window.CFS4 && window.CFS4.PSISPlus);
 if (_ppNs2 && typeof _ppNs2.bindEvents === 'function') {
 _ppNs2.bindEvents(D, function () { return panel; });
 }
 } catch (ePp2) { console.warn('[CFS] PSIS Plus bindEvents 失败', ePp2); }
 }

 // ---------- CSS ----------
 const STYLE_CSS = [
 '#' + PANEL_ID + ' { position: fixed; top: 50px; right: 30px; width: min(680px, 90vw); max-height: 85vh; background: #1f1f23; border: 1px solid #555; border-radius: 8px; box-shadow: 0 8px 32px rgba(0,0,0,0.6); z-index: 99999; color: #ddd; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; display: flex; flex-direction: column; overflow: hidden; }',
 '.cfs-card { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow-y: auto; }',
 '.cfs-head { padding: 12px 16px; background: #2a2a30; border-bottom: 1px solid #3a3a40; position: relative; flex-shrink: 0; }',
 '.cfs-head h3 { margin: 0 0 4px; font-size: 15px; color: #fff; }',
 '.cfs-close { position: absolute; right: 12px; top: 12px; background: transparent; border: 1px solid #555; color: #ddd; width: 26px; height: 26px; border-radius: 4px; cursor: pointer; font-size: 14px; line-height: 1; padding: 0; }',
 '.cfs-close:hover { background: #444; }',
 '.cfs-lbs { font-size: 11px; color: #aaa; }',
 '.cfs-ctrl { padding: 10px 16px; display: flex; gap: 6px; flex-wrap: wrap; border-bottom: 1px solid #3a3a40; flex-shrink: 0; }',
 '.cfs-btn { padding: 5px 12px; border-radius: 4px; border: 1px solid #555; background: #2a2a30; color: #ddd; cursor: pointer; font-size: 12px; }',
 '.cfs-btn:hover:not(:disabled) { background: #34343a; }',
 '.cfs-btn:disabled { opacity: 0.4; cursor: not-allowed; }',
 '.cfs-btn-primary { background: #2c5aa0; border-color: #3a6fc0; }',
 '.cfs-btn-warn { background: #a06a2c; border-color: #c08a3a; color: #fff; }',
 '.cfs-btn-allfix { background: #c54a2c; border-color: #e06a3a; color: #fff; font-weight: bold; }',
 '.cfs-btn-disabled { opacity: 0.5; }',
 '.cfs-btn-guard-on { background: #2c8a4a; border-color: #3aa55a; color: #fff; font-weight: bold; box-shadow: 0 0 6px rgba(58, 165, 90, 0.5); }',
 '.cfs-guard-stat { padding: 6px 16px; background: #1c2c20; color: #afe8af; font-size: 11px; border-bottom: 1px solid #2c5a3a; flex-shrink: 0; }',
 '.cfs-guard-stat b { color: #ffd866; }',
 '.cfs-empty { padding: 30px 20px; text-align: center; color: #888; font-size: 13px; }',
 '.cfs-cat-zone { padding: 10px 16px; border-bottom: 1px solid #3a3a40; flex-shrink: 0; }',
 '.cfs-cat-title { font-size: 12px; color: #aab; font-weight: bold; margin-bottom: 8px; }',
 '.cfs-cat-block { display: flex; align-items: center; gap: 10px; padding: 8px 10px; background: #26262c; border-radius: 4px; margin-bottom: 6px; flex-wrap: wrap; }',
 '.cfs-cat-head { flex: 1; display: flex; align-items: center; gap: 8px; min-width: 280px; flex-wrap: wrap; }',
 '.cfs-cat-icon { font-size: 16px; }',
 '.cfs-cat-label { font-size: 13px; color: #fff; font-weight: bold; }',
 '.cfs-cat-stats { font-size: 11px; color: #aaa; }',
 '.cfs-cat-stats b { color: #fff; }',
 '.cfs-needfix { color: #f8c875; }',
 '.cfs-needfix b { color: #ffae66; }',
 '.cfs-allok { color: #afe8af; }',
 '.cfs-cat-action { flex-shrink: 0; }',
 '.cfs-mvu { padding: 8px 16px; background: #1f2228; border-bottom: 1px solid #3a3a40; flex-shrink: 0; font-size: 12px; }',
 '.cfs-mvu > summary { cursor: pointer; color: #b89cff; font-weight: bold; outline: none; }',
 '.cfs-mvu > summary b { color: #ffd866; }',
 '.cfs-mvu-body { margin-top: 8px; }',
 '.cfs-mvu-section { margin-bottom: 8px; }',
 '.cfs-mvu-title { font-size: 11px; color: #aaa; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; padding-bottom: 2px; border-bottom: 1px solid #2a2a30; }',
 '.cfs-mvu-entry { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 5px 8px; background: #1a1c20; border-radius: 3px; margin-bottom: 3px; font-size: 11px; }',
 '.cfs-mvu-name { font-weight: bold; color: #cdd9ff; flex: 0 0 auto; }',
 '.cfs-mvu-meta { color: #777; font-size: 10px; }',
 '.cfs-mvu-status { margin-left: auto; }',
 '.cfs-mvu-ok { color: #afe8af; }',
 '.cfs-mvu-no { color: #f88; }',
 '.cfs-mvu-warn { color: #f8c875; font-size: 10px; }',
 '.cfs-mvu-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; padding-top: 8px; border-top: 1px solid #2a2a30; }',
 '.cfs-mvu-tip { margin-top: 8px; padding: 6px 10px; background: rgba(180,140,255,0.08); border-radius: 3px; color: #aab0c0; font-size: 11px; }',
 '.cfs-mvu-tip b { color: #d8c8ff; }',
 '.cfs-mvu-auto { display: flex; align-items: center; gap: 10px; padding: 6px 10px; margin-bottom: 8px; background: rgba(46,200,140,0.08); border: 1px solid rgba(46,200,140,0.25); border-radius: 4px; flex-wrap: wrap; }',
 '.cfs-mvu-auto-state { font-size: 11px; color: #aaa; flex: 1; min-width: 240px; }',
 '.cfs-v4-status { display: flex; gap: 8px; align-items: center; padding: 5px 10px; margin-bottom: 6px; background: rgba(100,140,255,0.06); border: 1px solid rgba(100,140,255,0.18); border-radius: 4px; font-size: 11px; flex-wrap: wrap; }',
 '.cfs-v4-mode-label { color: #888; }',
 '.cfs-v4-mode-badge { padding: 2px 8px; border-radius: 3px; font-weight: 600; }',
 '.cfs-v4-mode-mvu_fallback { background: #444; color: #ccc; }',
 '.cfs-v4-mode-v4_full { background: #3a5a3a; color: #a8e6a8; }',
 '.cfs-v4-mode-v4_degraded { background: #6a4a1a; color: #f0c060; }',
 '.cfs-v4-stats { color: #999; font-size: 11px; }',
 '.cfs-mvu-v4managed { background: #3a5a3a; color: #a8e6a8; }',
 '.cfs-mvu-review { background: #444a55; color: #c0c8d0; }',  // hotfix v2.2 审查协议中性色
 // spec v2: 启动状态区块
 '.cfs-coord-status { padding: 8px 10px; margin-bottom: 6px; border-radius: 4px; font-size: 11px; }',
 '.cfs-coord-status.cfs-coord-pending { background: rgba(150,150,150,0.08); border: 1px solid rgba(150,150,150,0.25); color: #aaa; }',
 '.cfs-coord-status.cfs-coord-ok { background: rgba(80,160,80,0.08); border: 1px solid rgba(80,160,80,0.3); color: #a8e6a8; }',
 '.cfs-coord-status.cfs-coord-skip { background: rgba(140,140,140,0.06); border: 1px solid rgba(140,140,140,0.25); color: #999; }',
 '.cfs-coord-status.cfs-coord-fail { background: rgba(200,60,60,0.10); border: 1px solid #cc3a3a; color: #ff7a7a; font-weight: 500; }',
 '.cfs-coord-head { font-size: 12px; margin-bottom: 4px; }',
 '.cfs-coord-status.cfs-coord-fail .cfs-coord-head { color: #ff5050; font-weight: 600; }',
 '.cfs-coord-detail { font-size: 11px; line-height: 1.6; color: #ddd; }',
 '.cfs-coord-status.cfs-coord-fail .cfs-coord-detail { color: #ffb0b0; }',
 '.cfs-coord-detail code { background: #1a1a1f; padding: 2px 6px; border-radius: 2px; color: #f8d775; display: inline-block; margin: 4px 0; }',
 '.cfs-coord-detail a { color: #88c0ff; text-decoration: none; }',
 '.cfs-coord-detail a:hover { text-decoration: underline; }',
 '.cfs-coord-detail-mini { font-size: 11px; color: #98c898; margin-top: 2px; }',
 // v2.5 移动端救回按钮样式
 '.cfs-coord-actions { display: flex; gap: 8px; margin: 10px 0 6px; flex-wrap: wrap; }',
 '.cfs-btn-takeover { background: #3a6fa0; border-color: #4a80b0; color: #fff; font-weight: 600; padding: 8px 16px; font-size: 13px; min-height: 38px; }',
 '.cfs-btn-takeover:hover:not(:disabled) { background: #4a80b0; }',
 '.cfs-btn-takeover:disabled { opacity: 0.5; cursor: wait; }',
 '.cfs-btn-takeover-light { background: #2a3a4a; border-color: #3a4a5a; color: #ccd; padding: 6px 14px; font-size: 12px; min-height: 32px; }',
 '.cfs-btn-takeover-light:hover:not(:disabled) { background: #3a4a5a; }',
 '.cfs-btn-takeover-light:disabled { opacity: 0.5; cursor: wait; }',
 '.cfs-btn-copy { background: #555; border-color: #666; color: #ddd; padding: 8px 12px; font-size: 12px; min-height: 38px; }',
 '.cfs-btn-copy:hover:not(:disabled) { background: #666; }',
 '.cfs-footer { padding: 10px 16px; border-top: 1px solid #3a3a40; font-size: 11px; color: #888; flex-shrink: 0; }',
 '.cfs-footer code { background: #2a2a30; padding: 1px 5px; border-radius: 2px; color: #f8d775; }',
 '.cfs-footer ul { margin: 6px 0 0 18px; padding: 0; }',
 '.cfs-footer li { margin: 4px 0; }',
 // v4.9 SEM section
 '.cfs-sem { margin: 10px 16px; border: 1px solid #3a3a45; border-radius: 6px; background: #25252a; }',
 '.cfs-sem > summary { padding: 8px 12px; cursor: pointer; font-size: 13px; color: #cfcfd5; user-select: none; }',
 '.cfs-sem > summary:hover { background: #2c2c33; }',
 '.cfs-sem-body { padding: 10px 12px; }',
 '.cfs-sem-hint { font-size: 12px; color: #aaa; margin-bottom: 8px; }',
 '.cfs-sem-empty { font-size: 12px; color: #888; padding: 10px 0; text-align: center; }',
 '.cfs-sem-summary { font-size: 12px; color: #cfcfd5; margin: 8px 0; }',
 '.cfs-sem-actions, .cfs-sem-controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 6px 0; }',
 '.cfs-sem-controls label { font-size: 12px; color: #cfcfd5; }',
 '.cfs-sem-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }',
 '.cfs-sem-table th { text-align: left; padding: 4px 6px; border-bottom: 1px solid #444; color: #ddd; background: #2a2a32; position: sticky; top: 0; }',
 '.cfs-sem-table td { padding: 4px 6px; border-bottom: 1px solid #333; color: #cfcfd5; vertical-align: middle; }',
 '.cfs-sem-table tr:hover { background: #2c2c33; }',
 '.cfs-sem-row-drift td { color: #ff9c9c; background: #3a2020; }',
 '.cfs-sem-row-drift:hover td { background: #4a2828; }',
 '.cfs-sem-drift-warn { background: #3a2020; border-left: 3px solid #d77; padding: 6px 10px; margin: 6px 0; font-size: 12px; color: #ff9c9c; border-radius: 3px; }',
 // v4.9 分级状态条
 '.cfs-tier-bar { display: flex; gap: 6px; padding: 6px 12px; margin: 0 16px 6px; background: #1a1a1f; border: 1px solid #2a2a30; border-radius: 6px; font-size: 11px; }',
 '.cfs-tier-item { padding: 3px 8px; border-radius: 3px; color: #888; }',
 '.cfs-tier-on { background: #1f3320; color: #98c898; }',
 '.cfs-tier-off { background: #2a2a30; color: #777; }',
 '.cfs-tier-paused { background: #332820; color: #c89868; text-decoration: line-through; }',
 // v4.9.2 PSIS Plus
 '.cfs-psis-plus { margin: 10px 16px; border: 1px solid #3a3a45; border-radius: 6px; background: #25252a; }',
 '.cfs-psis-plus > summary { padding: 8px 12px; cursor: pointer; font-size: 13px; color: #cfcfd5; user-select: none; }',
 '.cfs-psis-plus > summary:hover { background: #2c2c33; }',
 '.cfs-psisp-body { padding: 10px 12px; }',
 '.cfs-psisp-hint { font-size: 12px; color: #aaa; margin-bottom: 8px; }',
 '.cfs-psisp-summary { font-size: 12px; color: #cfcfd5; margin: 8px 0; }',
 '.cfs-psisp-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 8px 0; }',
 '.cfs-psisp-type { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; background: #2a2a32; color: #aaa; }',
 '.cfs-psisp-type-system { background: #2d2050; color: #b8a8e8; }',
 '.cfs-psisp-type-character { background: #20402d; color: #98d8a8; }',
 '.cfs-psisp-type-worldbook_static { background: #203045; color: #88c8ff; }',
 '.cfs-psisp-type-jailbreak { background: #402520; color: #e8a898; }',
 '.cfs-psisp-type-chat_history { background: #303030; color: #ccc; }',
 '.cfs-psisp-skipped { margin-top: 8px; }',
 '.cfs-psisp-skipped > summary { padding: 4px 8px; cursor: pointer; font-size: 11px; color: #888; }',
 // modal
 '.cfs-psisp-modal-bg { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 1000001; display: flex; align-items: center; justify-content: center; }',
 '.cfs-psisp-modal { background: #1f1f23; border: 1px solid #555; border-radius: 8px; width: min(560px, 92vw); max-height: 80vh; display: flex; flex-direction: column; box-shadow: 0 12px 40px rgba(0,0,0,0.8); }',
 '.cfs-psisp-modal-head { padding: 12px 16px; border-bottom: 1px solid #3a3a40; font-weight: 600; color: #ddd; }',
 '.cfs-psisp-modal-body { padding: 12px 16px; overflow-y: auto; }',
 '.cfs-psisp-modal-foot { padding: 10px 16px; border-top: 1px solid #3a3a40; display: flex; gap: 8px; justify-content: flex-end; }',
 '.cfs-psisp-modal-warn { margin-top: 10px; padding: 8px 10px; background: #332820; border-left: 3px solid #c89868; color: #e0c8a8; font-size: 11px; border-radius: 3px; }',
 '.cfs-psisp-modal-warn code { background: #1a1a1f; padding: 1px 4px; border-radius: 2px; color: #f8d775; }',
 '.cfs-psisp-skip-note { margin-top: 8px; font-size: 11px; color: #888; font-style: italic; }',
 ].join('\n');

 // ---------- 注册按钮事件 ----------
 try {
 const eventId = getButtonEvent(BTN_NAME);
 eventOn(eventId, openOrTogglePanel);
 console.log('[CFS v3.0] 已注册按钮事件，event_id =', eventId);
 } catch (e) {
 console.error('[CFS v3.0] 注册按钮失败：', e);
 if (T) T.error('CFS v3.0 注册按钮失败：' + e.message);
 }

 // ---------- spec v2: 监听 Coordinator + Fallback 事件，自动刷新面板状态区块 ----------
 try {
 if (typeof eventOn === 'function') {
 const _coordRefresh = function () {
 try {
 const panel = D.getElementById(PANEL_ID);
 if (panel && panel.offsetParent !== null) render();
 } catch (eR) {}
 };
 eventOn('cfs:coordinator:done', _coordRefresh);
 eventOn('cfs_v4_recovered', _coordRefresh);
 eventOn('cfs_v4_degraded', _coordRefresh);
 }
 } catch (eE) { console.warn('[CFS] Coordinator 面板刷新钩注册失败', eE); }

 // ---------- 启动时恢复持久化状态 ----------
 function tryRestoreOnReady() {
 try {
 const wasEnabled = loadGuardState();
 if (wasEnabled) {
 startGuard();
 console.log('[CFS Guard] 已自动恢复启用');
 const _nc1 = NC(); if (_nc1) _nc1.notify('mvu_recovered', {});
 }
 } catch (e) { console.warn('[CFS] 守护恢复失败', e); }
 try {
 const autoOn = loadAutoLifecycleState();
 if (autoOn) {
 startAutoLifecycle();
 console.log('[CFS Auto] 自动 initvar 生命周期已启用');
 const _nc2 = NC(); if (_nc2) _nc2.notify('initvar_auto', {});
 }
 } catch (e) { console.warn('[CFS Auto] 生命周期恢复失败', e); }
 }
 try {
 eventOnce('app_ready', tryRestoreOnReady);
 } catch (e) {
 setTimeout(tryRestoreOnReady, 1500);
 }
 setTimeout(function () {
 if (!STATE.guardHandle && !STATE.autoLifecycleEnabled) tryRestoreOnReady();
 }, 1500);

 // ============================================================
 // PSIS · Prompt Structural Invariant System (v3.1)
 // 跨卡通用结构性约束：保证 static injection 永远在 chat history 之前
 // 唯一公理：constant=true 且无动态宏 → position ∈ {before_char, after_char}
 // ============================================================
 const PSIS_DYNAMIC_PATTERNS = [
 /\{\{\s*[a-zA-Z_][\w-]*\s*::/,
 /\{\{(lastusermessage|lastmessage|lastcharmessage|random|roll|pick|date|time|weekday|isodate|datetimeformat|input)\s*\}\}/i,
 /<%[\s\S]*?%>/,
 ];
 const PSIS_POS_STR_TO_NUM = {
 // v3.1.7：用 TavernHelper 真实字符串（之前 'before_char' 错了）
 'before_character_definition': 0,
 'after_character_definition': 1,
 'before_author_note': 2,
 'after_author_note': 3,
 'at_depth_as_system': 4,
 'at_depth_as_user': 4,
 'at_depth_as_assistant': 4,
 'before_example_messages': 5,
 'after_example_messages': 6,
 'outlet': 7,
 // 兼容旧字符串别名（防 ST 版本差异）
 'before_char': 0, 'after_char': 1,
 'before_an': 2, 'after_an': 3, 'EMTop': 5, 'EMBottom': 6,
 };
 const PSIS_STATIC_ALLOWED_NUMS = [0, 1]; // before_char, after_char
 function psisHasDynamic(content) {
 if (!content) return false;
 for (let i = 0; i < PSIS_DYNAMIC_PATTERNS.length; i++) {
 if (PSIS_DYNAMIC_PATTERNS[i].test(content)) return true;
 }
 return false;
 }
 function psisPosNum(p) {
 if (typeof p === 'number') return p;
 if (typeof p === 'string' && PSIS_POS_STR_TO_NUM[p] !== undefined) return PSIS_POS_STR_TO_NUM[p];
 return -1;
 }
 function psisIsR1Violation(entry) {
 // === 白名单 hook：CFS v4.x StatData Engine 自管的 entry 全部豁免===
 // 升级到三锚点 OR 判定（comment 魔法串 + keys 数组 + extensions 字段）
 if (entry) {
 // 锚点 1: comment 头部魔法串
 if (entry.comment && typeof entry.comment === 'string') {
 var c4cmt = entry.comment;
 if (c4cmt.indexOf('[CFS4_SCHEMA|') === 0) return false;
 if (c4cmt.indexOf('[CFS4_LEGACY_DISABLED_') === 0) return false;
 if (c4cmt.indexOf('[CFS4_CLEANED|') === 0) return false;
 }
 // 锚点 2: keys 数组（TavernHelper 透传字段，用户改 comment 仍能识别）
 if (Array.isArray(entry.keys) && entry.keys.indexOf('_cfs4_managed') >= 0) return false;
 // 锚点 3: extensions 结构（写无害，未来 ST 透传时自动启用）
 if (entry.extensions && entry.extensions.cfs && entry.extensions.cfs.managed === true) return false;
 }
 // === 白名单结束，下方为 v3.1.7 原逻辑 ===
 // v3.1.7：兼容新旧 API — constant boolean 或 type string
 const isConstant = entry.constant === true || entry.type === 'constant';
 if (!isConstant) return false;
 // 兼容 enabled 字段（新 API）或 disable 字段（旧 API）
 const isDisabled = entry.disable === true || entry.enabled === false;
 if (isDisabled) return false;
 if (psisHasDynamic(entry.content || '')) return false;
 const n = psisPosNum(entry.position);
 if (PSIS_STATIC_ALLOWED_NUMS.indexOf(n) < 0) return true;
 // role 检查：兼容数字 (0/1/2) 和字符串 ('system'/'user'/'assistant')
 const r = entry.role;
 if (r !== null && r !== undefined && r !== 0 && r !== 'system') return true;
 return false;
 }
 async function psisScanR1Violations() {
 const violations = [];
 let bind;
 try { bind = TavernHelper.getCharLorebooks({ name: 'current' }); }
 catch (e) { return violations; }
 const names = [];
 if (bind && bind.primary) names.push(bind.primary);
 if (bind && Array.isArray(bind.additional))
 for (let i = 0; i < bind.additional.length; i++) {
 const n = bind.additional[i];
 if (n && names.indexOf(n) < 0) names.push(n);
 }
 for (let i = 0; i < names.length; i++) {
 const lb = names[i];
 let entries;
 try { entries = await TavernHelper.getLorebookEntries(lb); } catch (e) { continue; }
 for (let k = 0; k < entries.length; k++) {
 const e = entries[k];
 if (psisIsR1Violation(e)) {
 violations.push({
 lorebook: lb, uid: e.uid, comment: e.comment,
 position: e.position, contentLen: (e.content || '').length,
 });
 }
 }
 }
 return violations;
 }
 async function psisApplyR1Fix(violations) {
 if (!violations || violations.length === 0) return 0;
 const groups = {};
 for (let i = 0; i < violations.length; i++) {
 const v = violations[i];
 if (!groups[v.lorebook]) groups[v.lorebook] = [];
 // v3.1.7 关键修复：同时把 role 改成 0 (system)
 // 因为 ST 视 before_char/after_char + role=user 为非法组合，会自动 normalize
 // 回 atDepth + role=user。必须用 (position=0, role=0) 这种合法组合才能稳定。
 groups[v.lorebook].push({ uid: v.uid, position: 'before_character_definition', role: 0, depth: 4 });
 }
 let success = 0;
 const lbs = Object.keys(groups);
 for (let i = 0; i < lbs.length; i++) {
 try {
 await TavernHelper.setLorebookEntries(lbs[i], groups[lbs[i]]);
 success += groups[lbs[i]].length;
 } catch (e) { console.error('[PSIS R1] 写回 ' + lbs[i] + ' 失败', e); }
 }
 return success;
 }
 function psisCheckR0Violation() {
 try {
 const ctx = (typeof SillyTavern !== 'undefined') ? SillyTavern.getContext() : null;
 if (!ctx) return null;
 const oai = ctx.oai_settings || ctx.openai_settings;
 if (!oai || !Array.isArray(oai.prompt_order)) return null;
 const charId = ctx.characterId !== undefined ? Number(ctx.characterId) : null;
 let orderObj = null;
 if (charId !== null) orderObj = oai.prompt_order.find(function (po) { return po.character_id === charId; });
 if (!orderObj) orderObj = oai.prompt_order[0];
 if (!orderObj || !Array.isArray(orderObj.order)) return null;
 const ord = orderObj.order;
 const chatIdx = ord.findIndex(function (x) { return x.identifier === 'chatHistory'; });
 if (chatIdx < 0) return null;
 const staticMarkers = ['worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality', 'scenario', 'personaDescription', 'dialogueExamples'];
 const violations = [];
 for (let i = 0; i < staticMarkers.length; i++) {
 const sm = staticMarkers[i];
 const idx = ord.findIndex(function (x) { return x.identifier === sm; });
 if (idx >= 0 && idx > chatIdx) violations.push({ marker: sm, idx: idx, chatIdx: chatIdx });
 }
 return violations.length ? violations : null;
 } catch (e) { console.warn('[PSIS R0] 检查失败', e); return null; }
 }

 let PSIS_handles = [];
 let PSIS_R1FixCount = 0;
 let PSIS_R1Debounce = null;
 function psisStart() {
 if (PSIS_handles.length > 0) return;
 try {
 PSIS_handles.push(eventOn('worldinfo_updated', function () {
 if (PSIS_R1Debounce) clearTimeout(PSIS_R1Debounce);
 // v3.1.7 加固：worldinfo_updated 后做 3 次延迟扫描，对抗 WM 合并蓝灯重写
 async function _psisR1Run(tag) {
 try {
 const violations = await psisScanR1Violations();
 if (violations.length > 0) {
 const n = await psisApplyR1Fix(violations);
 PSIS_R1FixCount += n;
 console.log('[PSIS R1 ' + tag + '] 自动修复 ' + n + ' 条（累计 ' + PSIS_R1FixCount + '）');
 if (n > 0) { const _nc = NC(); if (_nc) _nc.notify('psis_r1_fix', { n: n, tag: tag, key: tag }); }
 }
 } catch (e) { console.warn('[PSIS R1 ' + tag + ']', e); }
 }
 PSIS_R1Debounce = setTimeout(function () {
 PSIS_R1Debounce = null;
 _psisR1Run('900ms');
 setTimeout(function () { _psisR1Run('3s'); }, 2100);
 setTimeout(function () { _psisR1Run('10s'); }, 9100);
 }, 900);
 }));
 } catch (e) {}
 try {
 PSIS_handles.push(eventOn('oai_preset_changed_after', function () {
 const r0v = psisCheckR0Violation();
 if (r0v) {
 const names = r0v.map(function (v) { return v.marker; }).join(', ');
 const _nc = NC(); if (_nc) _nc.notify('psis_r0', { names: names, marker_set: names });
 console.warn('[PSIS R0] prompt_order 违规', r0v);
 }
 }));
 } catch (e) {}
 // v3.1.7：抢在 prompt 拼装之前修复（在 EWC autoSwitch 之后立即同步修复）
 try {
 PSIS_handles.push(eventOn('generation_started', async function () {
 try {
 // 给 EWC autoSwitch 一点时间先跑完（它也在 generation_started 触发）
 await new Promise(function(r){ setTimeout(r, 50); });
 const violations = await psisScanR1Violations();
 if (violations.length > 0) {
 const n = await psisApplyR1Fix(violations);
 PSIS_R1FixCount += n;
 console.warn('[PSIS R1 抢跑] 在 prompt 拼装前修复 ' + n + ' 条（在 generation_started 钩）');
 }
 } catch (e) { console.warn('[PSIS R1 抢跑]', e); }
 }));
 } catch (e) {}
 try {
 PSIS_handles.push(eventOn('generate_before_combine_prompts', async function () {
 try {
 const violations = await psisScanR1Violations();
 if (violations.length > 0) {
 const n = await psisApplyR1Fix(violations);
 PSIS_R1FixCount += n;
 console.warn('[PSIS R1 拼装前] 最后一刀修复 ' + n + ' 条');
 }
 } catch (e) { console.warn('[PSIS R1 拼装前]', e); }
 }));
 } catch (e) {}
 console.log('[PSIS] 已启用 R0 + R1 + 抢跑守护');
 }
 function psisStop() {
 for (let i = 0; i < PSIS_handles.length; i++) {
 try { PSIS_handles[i].stop(); } catch (e) {}
 }
 PSIS_handles = [];
 }

 // ============================================================
 // MVU 报错监听（v3.1 议题 1 兜底）
 // 监听 character_message_rendered，扫描内容含 MVU 报错 marker
 // ============================================================
 const MVU_ERROR_PATTERNS = [
 /STATEMENT REJECTED/,
 /MVU\s*额外模型解析/,
 /\[mvu[^\]]*?\][^]*?(无效|失败|错误|Error|error)/i,
 /<!-- STATEMENT REJECTED -->/,
 /\[MVU\s*额外模型解析\]/,
 ];
 let MVU_WATCH_handle = null;
 function startMvuErrorWatcher() {
 if (MVU_WATCH_handle) return;
 try {
 MVU_WATCH_handle = eventOn('character_message_rendered', function () {
 try {
 const ctx = (typeof SillyTavern !== 'undefined') ? SillyTavern.getContext() : null;
 if (!ctx || !ctx.chat || ctx.chat.length === 0) return;
 const last = ctx.chat[ctx.chat.length - 1];
 if (!last || last.is_user) return;
 const msg = String(last.mes || '');
 for (let i = 0; i < MVU_ERROR_PATTERNS.length; i++) {
 if (MVU_ERROR_PATTERNS[i].test(msg)) {
 { const _nc = NC(); const _pat = MVU_ERROR_PATTERNS[i].source.slice(0, 30); if (_nc) _nc.notify('mvu_error', { pattern: _pat, pattern_hash: _pat }); }
 console.warn('[CFS MVU Watcher] 命中', MVU_ERROR_PATTERNS[i]);
 break;
 }
 }
 } catch (e) {}
 });
 console.log('[CFS MVU Watcher] 已启用');
 } catch (e) { console.warn('[CFS MVU Watcher] 启用失败', e); }
 }
 function stopMvuErrorWatcher() {
 if (MVU_WATCH_handle) { try { MVU_WATCH_handle.stop(); } catch (e) {} MVU_WATCH_handle = null; }
 }

 // ============================================================
 // v3.1 自动启动：在原 tryRestoreOnReady 之外独立启动 PSIS + MVU Watcher
 // ============================================================
 function v31_autoStart() {
 // spec v2: PSIS 启动 toast 删除，所有上报统一走 NC.report('psis') 汇总到启动报告
 console.log('[CFS v3.1.7] PSIS 启动中');
 try {
 // v3.1.7 议题 2 根治：永久关停 v3.0 自动守护（避免与 PSIS R1 互相打架）
 try {
 if (STATE.guardHandle) { stopGuard(); }
 saveGuardState(false);
 console.log('[CFS v3.1.7] v3.0 自动守护已永久停用（由 PSIS R1 接管）');
 } catch (eGd) { console.warn('[CFS v3.1.7] 关停 v3.0 守护失败', eGd); }
 psisStart();
 startMvuErrorWatcher();
 // 启动时立即跑一次 R0 检查
 var _r0Summary = '';
 const r0v = psisCheckR0Violation();
 if (r0v) {
 const names = r0v.map(function (v) { return v.marker; }).join(', ');
 _r0Summary = '⚠ R0 警告：[' + names + '] 在历史之后';
 const _nc = NC(); if (_nc) _nc.notify('psis_r0', { names: names, marker_set: names });
 console.warn('[PSIS R0] 启动检查命中', r0v);
 }
 // 启动时立即跑一次 R1 扫描+修复
 psisScanR1Violations().then(function (vs) {
 console.warn('[PSIS R1] 启动扫描: 发现 ' + vs.length + ' 条违规');
 if (vs.length > 0) {
 console.warn('[PSIS R1] 违规明细:', vs);
 psisApplyR1Fix(vs).then(function (n) {
 console.warn('[PSIS R1] 修复 ' + n + ' / ' + vs.length + ' 条');
 PSIS_R1FixCount += n;
 const _nc = NC();
 if (_nc) _nc.report('psis', { ok: true, summary: '启动扫描修复 ' + n + ' / ' + vs.length + ' 条' + (_r0Summary ? '；' + _r0Summary : '') });
 // 立即再扫一次确认是否成功
 setTimeout(function () {
 psisScanR1Violations().then(function (vs2) {
 console.warn('[PSIS R1] 修复后再扫: 剩余 ' + vs2.length + ' 条违规');
 if (vs2.length > 0) console.warn('[PSIS R1] 仍违规的:', vs2);
 });
 }, 1500);
 });
 } else {
 const _nc = NC();
 if (_nc) _nc.report('psis', { ok: true, summary: '启动扫描无违规 (共 ' + vs.length + ' 条受控条目)' + (_r0Summary ? '；' + _r0Summary : '') });
 }
 }).catch(function (e) {
 console.warn('[PSIS R1 启动扫描]', e);
 const _nc = NC();
 if (_nc) _nc.report('psis', { ok: false, summary: 'R1 扫描异常: ' + (e && e.message) });
 });
 } catch (e) {
 console.warn('[CFS v3.1 autoStart]', e);
 const _nc = NC();
 if (_nc) _nc.report('psis', { ok: false, summary: '启动异常: ' + (e && e.message) });
 }
 }
 // ===== 改造点（spec v2）：v31_autoStart 改为 Coordinator plugin =====
 // 旧：app_ready + setTimeout 撒网触发 → 在 welcome-screen 期间疯狂启动
 // 新：注册为 Coordinator plugin（priority=10），等 SessionGate 放行后串行触发
 // 加载顺序：v3.1.7 IIFE 在 v4.x 之前加载，所以 Coordinator 在 IIFE 关闭时还不存在
 //          → 用 setTimeout 延迟到下一个 tick，等 v4.x IIFE 跑完再注册
 var _v31Started = false;
 function _v31RunOnce(ctxLabel) {
 if (_v31Started) return { ok: true, summary: '已运行' };
 _v31Started = true;
 try { v31_autoStart(); } catch (e0) { console.warn('[CFS v3.1.7] v31_autoStart 异常', e0); }
 return { ok: true, summary: '已启动 (' + ctxLabel + ')' };
 }
 function _registerV31Plugin(retryLeft) {
 retryLeft = (retryLeft == null) ? 50 : retryLeft;
 try {
 var _CFS4G = (typeof window !== 'undefined' && window.parent) || (typeof window !== 'undefined' ? window : null);
 if (_CFS4G && _CFS4G.CFS4 && _CFS4G.CFS4.Coordinator && typeof _CFS4G.CFS4.Coordinator.register === 'function') {
 _CFS4G.CFS4.Coordinator.register({
 name: 'psis',
 priority: 10,
 onSessionReady: function (ctx) { return _v31RunOnce(ctx && ctx.phase || 'ready'); },
 onSessionTimeout: function () { return _v31RunOnce('timeout'); }
 });
 console.log('[CFS v3.1.7] PSIS plugin 已注册到 Coordinator');
 return;
 }
 if (retryLeft > 0) {
 setTimeout(function () { _registerV31Plugin(retryLeft - 1); }, 50);
 return;
 }
 // 超过 2.5s 仍没挂上 Coordinator → 走老 app_ready 兜底
 console.warn('[CFS v3.1.7] Coordinator 长期不可用，PSIS 启动走 app_ready 兜底');
 try { eventOnce('app_ready', v31_autoStart); }
 catch (e) { setTimeout(v31_autoStart, 1800); }
 } catch (eR) {
 console.warn('[CFS v3.1.7] PSIS plugin 注册失败', eR);
 }
 }
 setTimeout(_registerV31Plugin, 0);

})();

// ============================================================
// ESM export
// PSIS 实际不挂独立 CFS4.PSIS 对象（v3.1.7 架构），而是 _registerV31Plugin
// 异步重试 50ms × 50 次注册到 Coordinator 插件总线（name='psis'）。
// ESM tail 同步求值时 plugin register 尚未发生 → 用 IIFE 完成 flag 替代。
// ============================================================
if (window.CFS4) window.CFS4._psisIIFEDone = true;

export const PSIS = window.CFS4?._psisIIFEDone
    ? {
        mounted: true,
        _via: 'v3.1.7 IIFE done; Coordinator plugin name=psis (异步注册到总线)',
    }
    : null;

console.log(
    '[CFS-Suite/psis] PSIS R1 ESM bridge OK, IIFE done =',
    !!window.CFS4?._psisIIFEDone,
);
