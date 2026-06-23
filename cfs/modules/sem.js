/**
 * CFS-Suite · modules/sem.js
 *
 * 从 CFS v4.9.0 / v4.9.1 SEM（cfs_content_extracted.js L6509-7290）整段迁移。
 *
 * SEM = Stable Entry Migrator
 *   - 候选扫描：找 worldbook 里可以迁移到 STABLE_BATCH 的 entry
 *   - 用户授权迁移：弹 popup 让用户确认 → 把 entry 迁到 frozen 层
 *   - 一键回滚：把已迁移的 entry 复原
 *   - Audit 只告警不自动修复（避免误伤）
 *
 * localStorage key 兼容（保留原版）：cfs_sem_migrations_v1
 *
 * 依赖：path_registry / injection_strategy / real_takeover（迁移操作需要 STABLE_BATCH 协议就位）
 */

import { polyfilledApis as _r } from '../compat/tavern_helper_polyfill.js';
import '../core/path_registry.js';
import '../core/injection_strategy.js';
import '../core/real_takeover.js';
void _r;

// ============================================================
// 以下为 cfs_content_extracted.js L6509-7290 SEM IIFE
// ============================================================

// ============================================================
// CFS v4.9.0 SEM (Stable Entry Migrator)
// 候选扫描 + 用户授权迁移 + 一键回滚 + Audit 只告警不自动修复
// spec: D:\Silly\LOG\2026-06-18-stable-entry-migrator-design.md
// ============================================================
(function _SEM_INIT() {
 var _GLOBAL = (typeof window !== 'undefined') ? (window.parent || window) : {};
 if (!_GLOBAL.CFS4) _GLOBAL.CFS4 = {};

 var SEM_CONFIG = {
  MIN_LEN: 500,
  MAX_MACRO_DENSITY: 5.0,
  STABLE_ROUNDS: 2,
  TOAST_THRESHOLD: 3,
  SCHEMA_VERSION: 1,
  PRECHECK_LEN: 1000,
  PRECHECK_DENSITY: 5.0,
  AUDIT_DRIFT_LIMIT: 1,
 };
 var SEM_MACRO_RE = /\{\{[^}]+\}\}|<%[\s\S]*?%>|getvar\(/g;
 var SEM_POS_AT_DEPTH = {
  4: 1,
  'at_depth_as_user': 1,
  'at_depth_as_assistant': 1,
  'at_depth_as_system': 1,
  'at_depth': 1,
 };
 var SEM_POS_PREFIX = 'before_character_definition';

 var _semDriftCount = {};
 var _semDriftNotified = {};
 var _semPassiveDone = false;

 // 2026-06-22 用户反馈第二点："不随着 chat change 改变"。
 // 由 _semBindEvents 在每次 panel 渲染后挂指针；chat_id_changed 监听 debounce 后调用。
 var _semCurrentRefresh = null;

 // === localStorage metadata 层（替代 entry.extensions.cfs.sem）===
 // 实测 TavernHelper.setLorebookEntries 静默丢弃 extensions 字段，metadata 必须本地存
 var SEM_LS_KEY = 'cfs_sem_migrations_v1';

 function _semStoreRead() {
  try {
   var raw = localStorage.getItem(SEM_LS_KEY);
   if (!raw) return {};
   var obj = JSON.parse(raw);
   return (obj && typeof obj === 'object') ? obj : {};
  } catch (e) { return {}; }
 }
 function _semStoreWrite(obj) {
  try { localStorage.setItem(SEM_LS_KEY, JSON.stringify(obj)); return true; }
  catch (e) { console.warn('[SEM] localStorage write failed', e); return false; }
 }
 function _semStoreKey(book, uid) { return book + '::' + uid; }
 function _semStoreGet(book, uid) {
  var all = _semStoreRead();
  return all[_semStoreKey(book, uid)] || null;
 }
 function _semStoreSet(book, uid, rec) {
  var all = _semStoreRead();
  all[_semStoreKey(book, uid)] = rec;
  return _semStoreWrite(all);
 }
 function _semStoreDel(book, uid) {
  var all = _semStoreRead();
  delete all[_semStoreKey(book, uid)];
  return _semStoreWrite(all);
 }
 function _semStoreAll() { return _semStoreRead(); }

 var TH = function () {
  return (typeof TavernHelper !== 'undefined') ? TavernHelper : (_GLOBAL && _GLOBAL.TavernHelper);
 };

 async function _semGetActiveBooks() {
  var helper = TH();
  if (!helper || typeof helper.getCharLorebooks !== 'function') return [];
  try {
   var bind = helper.getCharLorebooks({ name: 'current' });
   var names = [];
   if (bind && bind.primary) names.push(bind.primary);
   if (bind && Array.isArray(bind.additional)) {
    for (var i = 0; i < bind.additional.length; i++) {
     var n = bind.additional[i];
     if (n && names.indexOf(n) < 0) names.push(n);
    }
   }
   return names;
  } catch (e) {
   console.warn('[SEM] getCharLorebooks failed', e);
   return [];
  }
 }

 function _semEstimateGain(len) {
  var totalEst = 50000;
  var g = (len / totalEst) * 100;
  return Math.max(0, Math.min(35, g));
 }

 function _semMacroDensity(content) {
  var macros = content.match(SEM_MACRO_RE);
  var n = macros ? macros.length : 0;
  return n / Math.max(1, content.length / 1000);
 }

 function _semIsAtDepthPos(pos) {
  return SEM_POS_AT_DEPTH[pos] === 1;
 }

 function _semHasMetadata(book, uid) {
  return !!_semStoreGet(book, uid);
 }

 async function _semScanCandidates() {
  var books = await _semGetActiveBooks();
  if (books.length === 0) return [];
  var helper = TH();
  if (!helper || typeof helper.getLorebookEntries !== 'function') return [];

  // 2026-06-22 修法 2 — SEM 降级，让位 PETL/WM
  //   旧 density 阈值（<5/1000 字符）是物理错误的：prefix cache 字节级，
  //   1 个动态宏和 100 个动态宏破坏力一样，"密度低" 不等于 "不破坏 cache"。
  //   实测：跟 WM 走 at_depth_as_user 命中率 80%+，SEM 推 prefix 仅 70%+。
  //   PETL v6 已具备"含动态宏 → 踢 chat 末尾"能力，SEM 只迁纯静态长 entry 兜底。
  var _SEM_PSIS_HOST = (typeof window !== 'undefined') ? ((window.parent && window.parent.CFS4) ? window.parent : window) : null;
  var _SEM_PSIS_PATTERNS = _SEM_PSIS_HOST && _SEM_PSIS_HOST.CFS4 && _SEM_PSIS_HOST.CFS4.PSISPatterns;
  if (!_SEM_PSIS_PATTERNS) {
   console.warn('[SEM] PSISPatterns 未就绪，本次扫描中止（避免旧 density 误判）');
   return [];
  }
  function _semMatchesAnyPattern(s, arr) {
   if (!s || !Array.isArray(arr)) return false;
   for (var _pi = 0; _pi < arr.length; _pi++) {
    try { if (arr[_pi].test(s)) return true; } catch (_e) {}
   }
   return false;
  }
  function _semHasDynamicMarker(s) {
   return _semMatchesAnyPattern(s, _SEM_PSIS_PATTERNS.DYNAMIC)
       || _semMatchesAnyPattern(s, _SEM_PSIS_PATTERNS.MVU);
  }
  // 2026-06-22 WM 风格综合判定：白名单 + unknown 兜底 + 字段风险 + 函数式 getvar
  //   优先用 PSISPatterns.getEntryRiskLevel；老版 PSIS 未升级时退回 DYNAMIC/MVU 双 pattern
  function _semEntryIsRisky(entry) {
   if (typeof _SEM_PSIS_PATTERNS.getEntryRiskLevel === 'function') {
    return _SEM_PSIS_PATTERNS.getEntryRiskLevel(entry) === 'dynamic';
   }
   var c = (entry && typeof entry.content === 'string') ? entry.content : '';
   var cm = (entry && typeof entry.comment === 'string') ? entry.comment : '';
   return _semHasDynamicMarker(c) || _semHasDynamicMarker(cm);
  }

  var out = [];
  for (var bi = 0; bi < books.length; bi++) {
   var book = books[bi];
   var entries;
   try { entries = await helper.getLorebookEntries(book); } catch (e) { continue; }
   if (!Array.isArray(entries)) continue;

   for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!e) continue;
    if (e.disable === true || e.enabled === false) continue;
    var comment = (typeof e.comment === 'string') ? e.comment : '';
    if (comment.indexOf('[CFS4_') === 0) continue;
    // 2026-06-21 用户决定权：[cfs:ignore] 标记的条目不进 SEM 候选
    if (comment.indexOf('[cfs:ignore]') >= 0) continue;
    var content = e.content || '';
    if (content.length < SEM_CONFIG.MIN_LEN) continue;
    if (!_semIsAtDepthPos(e.position)) continue;
    // 2026-06-22 修法 2 + WM 风格补强：命中综合 dynamic 风险即排除
    //   覆盖 EJS/MVU/函数式 getvar/未知宏兜底/字段风险（sticky/cooldown/probability/delay）
    if (_semEntryIsRisky(e)) continue;
    var density = _semMacroDensity(content);  // 仅展示用，不再作筛选

    // v4.9.1: 已迁移过的条目（无论当前 position 在哪）一律从候选表跳过
    // 漂移回拉的条目走「已迁移列表 → ⚡ 重迁所有漂移」单一入口
    if (_semHasMetadata(book, e.uid)) continue;

    var estGain = _semEstimateGain(content.length);
    // 修法 2：已通过精准 pattern 排除动态宏，长度达 PRECHECK_LEN 即推荐
    var recommended = content.length >= SEM_CONFIG.PRECHECK_LEN;

    out.push({
     uid: e.uid,
     book: book,
     comment: comment.slice(0, 60),
     len: content.length,
     position: String(e.position),
     role: e.role,
     constant: !!e.constant,
     macroDensity: density,
     stable: true, // 基础筛通过即视为配置稳态，cross-round hash 留 v5.x
     alreadyMigrated: false,
     estimatedGain: estGain,
     recommendedChecked: recommended,
    });
   }
  }
  out.sort(function (a, b) { return b.len - a.len; });
  return out;
 }

 async function _semMigrate(book, uids) {
  var helper = TH();
  var ok = [], fail = [];
  if (!helper || typeof helper.getLorebookEntries !== 'function') {
   for (var k = 0; k < uids.length; k++) fail.push({uid: uids[k], reason: 'no_helper'});
   return {ok: ok, fail: fail};
  }
  var entries;
  try { entries = await helper.getLorebookEntries(book); }
  catch (e) {
   for (var k2 = 0; k2 < uids.length; k2++) fail.push({uid: uids[k2], reason: 'read_failed'});
   return {ok: ok, fail: fail};
  }

  var patches = [];
  var pending = []; // 待写 localStorage 的 {uid, original}
  for (var i = 0; i < uids.length; i++) {
   var uid = uids[i];
   var ent = null;
   for (var j = 0; j < entries.length; j++) { if (entries[j].uid === uid) { ent = entries[j]; break; } }
   if (!ent) { fail.push({uid: uid, reason: 'not_found'}); continue; }
   var c = (typeof ent.comment === 'string') ? ent.comment : '';
   if (c.indexOf('[CFS4_') === 0) { fail.push({uid: uid, reason: 'cfs_managed_refuse'}); continue; }
   if (_semHasMetadata(book, uid)) { fail.push({uid: uid, reason: 'already_migrated'}); continue; }

   pending.push({
    uid: uid,
    comment: c,
    original: {
     position: ent.position,
     role: (typeof ent.role !== 'undefined') ? ent.role : null,
     constant: !!ent.constant,
     depth: (typeof ent.depth !== 'undefined') ? ent.depth : null,
     order: (typeof ent.order !== 'undefined') ? ent.order : null,
    },
   });

   patches.push({
    uid: uid,
    position: SEM_POS_PREFIX,
    role: 0,
    constant: true,
   });
  }

  if (patches.length === 0) return {ok: ok, fail: fail};

  try {
   await helper.setLorebookEntries(book, patches);
  } catch (e) {
   for (var p = 0; p < patches.length; p++) fail.push({uid: patches[p].uid, reason: 'write_error:' + (e && e.message || e)});
   return {ok: ok, fail: fail};
  }

  // 回读验证 + 仅对验证通过的写 localStorage metadata
  await new Promise(function (r) { setTimeout(r, 1500); });
  var post;
  try { post = await helper.getLorebookEntries(book); } catch (e) { post = null; }
  for (var pi = 0; pi < patches.length; pi++) {
   var pat = patches[pi];
   var pend = null;
   for (var px = 0; px < pending.length; px++) { if (pending[px].uid === pat.uid) { pend = pending[px]; break; } }
   var after = null;
   if (post) {
    for (var pj = 0; pj < post.length; pj++) { if (post[pj].uid === pat.uid) { after = post[pj]; break; } }
   }
   if (after && (after.position === SEM_POS_PREFIX || after.position === 0)) {
    // 写 localStorage metadata
    if (pend) {
     _semStoreSet(book, pat.uid, {
      migrated_at: Date.now(),
      comment: pend.comment,
      original: pend.original,
      schema_version: SEM_CONFIG.SCHEMA_VERSION,
     });
    }
    ok.push(pat.uid);
    // 清重迁/漂移告警状态
    delete _semDriftCount[pat.uid];
    delete _semDriftNotified[pat.uid];
   } else {
    fail.push({uid: pat.uid, reason: 'verify_failed:' + (after && after.position)});
   }
  }
  return {ok: ok, fail: fail};
 }

 async function _semRollback(book, uids) {
  var helper = TH();
  var ok = [], fail = [];
  if (!helper) {
   for (var k = 0; k < uids.length; k++) fail.push({uid: uids[k], reason: 'no_helper'});
   return {ok: ok, fail: fail};
  }

  var patches = [];
  for (var i = 0; i < uids.length; i++) {
   var uid = uids[i];
   var rec = _semStoreGet(book, uid);
   if (!rec || !rec.original) { fail.push({uid: uid, reason: 'no_sem_metadata'}); continue; }
   var o = rec.original;
   var patch = { uid: uid };
   if (typeof o.position !== 'undefined') patch.position = o.position;
   if (o.role !== null && typeof o.role !== 'undefined') patch.role = o.role;
   if (typeof o.constant !== 'undefined') patch.constant = !!o.constant;
   if (o.depth !== null && typeof o.depth !== 'undefined') patch.depth = o.depth;
   if (o.order !== null && typeof o.order !== 'undefined') patch.order = o.order;
   patches.push(patch);
  }

  if (patches.length === 0) return {ok: ok, fail: fail};

  try {
   await helper.setLorebookEntries(book, patches);
   for (var p = 0; p < patches.length; p++) {
    var u = patches[p].uid;
    ok.push(u);
    _semStoreDel(book, u);
    delete _semDriftCount[u];
    delete _semDriftNotified[u];
   }
  } catch (e) {
   for (var p2 = 0; p2 < patches.length; p2++) fail.push({uid: patches[p2].uid, reason: 'write_error:' + (e && e.message || e)});
  }
  return {ok: ok, fail: fail};
 }

 // 2026-06-22 用户报告 BUG：A 卡跑过 SEM → 切 B 卡打开「📋 已迁移列表」
 //   仍显示 A 卡 entry，并提示"建议迁回 prefix"。根因：旧实现走 _semStoreAll() 拿 LS 全集，
 //   不按当前角色绑定的 worldbook 过滤。下游 _semAuditDrift / _semRemigrateDrifted / UI _doMigList
 //   全部受污染（A worldbook 没绑当前角色 → entry_missing/drift 误报）。
 //   修法：默认 activeOnly=true，仅列当前角色绑定 worldbook 的记录。保留 {activeOnly:false} 入口
 //   给将来"跨卡历史清理"需求。
 async function _semListMigrated(opts) {
  var activeOnly = !opts || opts.activeOnly !== false;
  var all = _semStoreAll();
  var keys = Object.keys(all);
  if (keys.length === 0) return [];

  // 按 book 分组，每个 book 一次 getLorebookEntries
  var byBook = {};
  for (var k = 0; k < keys.length; k++) {
   var parts = keys[k].split('::');
   var book = parts[0];
   var uid = Number(parts[1]);
   if (!byBook[book]) byBook[book] = [];
   byBook[book].push(uid);
  }

  if (activeOnly) {
   var activeBooks = await _semGetActiveBooks();
   var activeSet = {};
   for (var ai = 0; ai < activeBooks.length; ai++) activeSet[activeBooks[ai]] = 1;
   for (var bkName in byBook) {
    if (!activeSet[bkName]) delete byBook[bkName];
   }
   if (Object.keys(byBook).length === 0) return [];
  }

  var helper = TH();
  var out = [];
  for (var book in byBook) {
   var entries = null;
   if (helper && typeof helper.getLorebookEntries === 'function') {
    try { entries = await helper.getLorebookEntries(book); } catch (e) { entries = null; }
   }
   var uids = byBook[book];
   for (var ui = 0; ui < uids.length; ui++) {
    var uid2 = uids[ui];
    var rec = all[_semStoreKey(book, uid2)];
    var ent = null;
    if (entries) {
     for (var ei = 0; ei < entries.length; ei++) { if (entries[ei].uid === uid2) { ent = entries[ei]; break; } }
    }
    var curPos = ent ? String(ent.position) : '(不可读)';
    var drifted = ent ? (ent.position !== SEM_POS_PREFIX && ent.position !== 0) : false;
    out.push({
     uid: uid2,
     book: book,
     comment: (rec && rec.comment) ? rec.comment.slice(0, 60) : '',
     migrated_at: rec ? rec.migrated_at : 0,
     current_position: curPos,
     suggested_position: SEM_POS_PREFIX,
     drifted: drifted,
     entry_missing: !ent,
    });
   }
  }
  out.sort(function (a, b) { return b.migrated_at - a.migrated_at; });
  return out;
 }

 // Audit Guard: 检测迁移条目漂移 — 仅告警，不自动修复
 async function _semAuditDrift() {
  try {
   var migrated = await _semListMigrated();
   var NC = _GLOBAL.CFS4 && _GLOBAL.CFS4.NotificationCenter;
   for (var i = 0; i < migrated.length; i++) {
    var m = migrated[i];
    if (m.entry_missing) continue; // entry 被删了，跳过
    if (!m.drifted) {
     delete _semDriftCount[m.uid];
     delete _semDriftNotified[m.uid];
     continue;
    }
    _semDriftCount[m.uid] = (_semDriftCount[m.uid] || 0) + 1;
    if (_semDriftCount[m.uid] >= SEM_CONFIG.AUDIT_DRIFT_LIMIT && !_semDriftNotified[m.uid]) {
     console.warn('[SEM] drift detected uid=' + m.uid + ' pos=' + m.current_position);
     if (NC && typeof NC.notify === 'function') {
      NC.notify('sem_drift', { uid: m.uid, position: m.current_position, comment: m.comment });
     }
     _semDriftNotified[m.uid] = true;
    }
   }
  } catch (e) {
   console.warn('[SEM] audit failed', e);
  }
 }

 // 重迁所有漂移条目（仅对 drifted=true 的 uid 执行迁移）
 async function _semRemigrateDrifted() {
  var migrated = await _semListMigrated();
  var byBook = {};
  for (var i = 0; i < migrated.length; i++) {
   var m = migrated[i];
   if (!m.drifted || m.entry_missing) continue;
   if (!byBook[m.book]) byBook[m.book] = [];
   byBook[m.book].push(m.uid);
  }
  var totalOk = 0, totalFail = 0;
  // 重迁前先删 localStorage 记录（让 _semHasMetadata 判定为 false 才能再次 migrate）
  for (var bk in byBook) {
   for (var ui = 0; ui < byBook[bk].length; ui++) _semStoreDel(bk, byBook[bk][ui]);
  }
  for (var bk2 in byBook) {
   var r = await _semMigrate(bk2, byBook[bk2]);
   totalOk += r.ok.length;
   totalFail += r.fail.length;
  }
  return {ok: totalOk, fail: totalFail};
 }

 // 全部回滚（默认仅当前角色绑定的 worldbook；传 {activeOnly:false} 才回滚跨卡全集）
 // 2026-06-22 同 _semListMigrated 修法：避免在 B 卡上点「↩↩ 全部回滚」误碰 A 卡 entry。
 async function _semRollbackAll(opts) {
  var activeOnly = !opts || opts.activeOnly !== false;
  var all = _semStoreAll();
  var byBook = {};
  for (var key in all) {
   var parts = key.split('::');
   var book = parts[0], uid = Number(parts[1]);
   if (!byBook[book]) byBook[book] = [];
   byBook[book].push(uid);
  }
  if (activeOnly) {
   var activeBooks = await _semGetActiveBooks();
   var activeSet = {};
   for (var ai = 0; ai < activeBooks.length; ai++) activeSet[activeBooks[ai]] = 1;
   for (var bkName in byBook) {
    if (!activeSet[bkName]) delete byBook[bkName];
   }
  }
  var totalOk = 0, totalFail = 0;
  for (var bk in byBook) {
   var r = await _semRollback(bk, byBook[bk]);
   totalOk += r.ok.length;
   totalFail += r.fail.length;
  }
  return {ok: totalOk, fail: totalFail};
 }

 // === 渲染 HTML section（被 renderMvuConsole 末尾追加） ===
 function _semEsc(s) {
  return String(s == null ? '' : s)
   .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
 }

 var _semCachedCands = null;
 var _semCachedMig = null;

 function _semRenderSection() {
  return '<details class="cfs-sem" id="cfs-sem-root" open>' +
   '<summary>📦 世界书优化 SEM — 候选扫描 + 迁移 + 回滚</summary>' +
   '<div class="cfs-sem-body" id="cfs-sem-body">' +
   '<div class="cfs-sem-hint">扫描<b>纯静态长 entry</b> → 用户授权迁到 <b>before_character_definition</b>（prefix 区）参与 cache。含动态宏的 entry 不进候选（PSIS pattern 精准识别）。' +
   '<br><span style="color:#888;font-size:11px">不动 character_book，所有迁移有 metadata 备份 + 一键回滚。</span></div>' +
   '<div class="cfs-sem-actions">' +
   '<button id="cfs-sem-btn-scan" class="cfs-btn cfs-btn-primary">🔍 扫描候选</button>' +
   '<button id="cfs-sem-btn-mig-list" class="cfs-btn">📋 已迁移列表</button>' +
   '</div>' +
   '<div id="cfs-sem-list"></div>' +
   '</div>' +
   '</details>';
 }

 function _semRenderCandList(cands, driftedCnt) {
  driftedCnt = driftedCnt || 0;
  // v6.5: 还原 4.9 主动迁移角色。PSIS pattern 已精准过滤含动态宏 entry，
  // SEM 候选都是纯静态长 entry（risk=safe），理论上应进 prefix 区。
  // 漂移 = 外部工具改回，提示用户可重迁。
  var driftHintHtml = driftedCnt > 0
   ? '<div class="cfs-sem-drift-warn" style="color:#ffa726">⚠ <b>' + driftedCnt + '</b> 条已迁移条目当前不在 prefix 区（被外部改回）。如确认是纯静态长内容，到「📋 已迁移列表」一键重迁回 prefix。</div>'
   : '';
  if (!cands || cands.length === 0) {
   return driftHintHtml + '<div class="cfs-sem-empty">无新增候选 — 当前 worldbook 已无满足条件的未迁移 entry</div>';
  }
  var totalGain = 0;
  for (var i = 0; i < cands.length; i++) if (cands[i].recommendedChecked) totalGain += cands[i].estimatedGain;
  var allChecked = cands.every(function (c) { return c.recommendedChecked; });

  var rows = '';
  for (var k = 0; k < cands.length; k++) {
   var c = cands[k];
   var densColor = c.macroDensity < 3 ? '#7c7' : c.macroDensity < 5 ? '#dd7' : '#d77';
   var stableMark = c.stable ? '✅' : '⚠';
   var migMark = c.alreadyMigrated ? '<span style="color:#7c7;font-size:11px">(已迁)</span>' : '';
   rows += '<tr>' +
    '<td><input type="checkbox" class="cfs-sem-chk" data-uid="' + c.uid + '" data-book="' + _semEsc(c.book) + '"' + (c.recommendedChecked ? ' checked' : '') + '></td>' +
    '<td>' + c.uid + '</td>' +
    '<td title="' + _semEsc(c.comment) + '">' + _semEsc(c.comment.slice(0, 30)) + migMark + '</td>' +
    '<td>' + c.len + '</td>' +
    '<td>' + _semEsc(c.position) + '</td>' +
    '<td>' + stableMark + '</td>' +
    '<td style="color:' + densColor + '">' + c.macroDensity.toFixed(1) + '</td>' +
    '<td>+' + c.estimatedGain.toFixed(1) + '%</td>' +
    '</tr>';
  }
  return driftHintHtml +
   '<div class="cfs-sem-summary">候选 <b>' + cands.length + '</b> 条 · 推荐勾选预估收益 <b>+' + totalGain.toFixed(1) + '%</b></div>' +
   '<div class="cfs-sem-controls">' +
   '<label><input type="checkbox" id="cfs-sem-all"' + (allChecked ? ' checked' : '') + '> 全选</label> ' +
   '<button id="cfs-sem-btn-migrate" class="cfs-btn cfs-btn-primary">⬆ 迁移选中</button> ' +
   '<button id="cfs-sem-btn-rescan" class="cfs-btn">🔄 重新扫描</button>' +
   '</div>' +
   '<div class="cfs-sem-table-wrap"><table class="cfs-sem-table"><thead><tr>' +
   '<th>☑</th><th>uid</th><th>标题</th><th>长度</th><th>位置</th><th>稳态</th><th>密度</th><th>预估收益</th>' +
   '</tr></thead><tbody>' + rows + '</tbody></table></div>';
 }

 function _semRenderMigList(mig) {
  // 2026-06-22 修法：默认仅显示当前角色绑定 worldbook 的迁移记录（避免切卡后看到其他卡的污染）
  var scopeHint = '<div class="cfs-sem-hint" style="color:#888;font-size:11px">仅显示当前角色绑定的 worldbook 迁移记录。切换角色 / 解绑 worldbook 后旧记录会自动隐藏（LS 不删，重新绑回即可见）。</div>';
  if (!mig || mig.length === 0) {
   return scopeHint + '<div class="cfs-sem-empty">尚无已迁移条目</div>';
  }
  var driftedCnt = 0;
  for (var d = 0; d < mig.length; d++) if (mig[d].drifted) driftedCnt++;

  var rows = '';
  for (var i = 0; i < mig.length; i++) {
   var m = mig[i];
   var ts = new Date(m.migrated_at).toLocaleString();
   var rowClass = m.drifted ? ' class="cfs-sem-row-drift"' : '';
   var missingMark = m.entry_missing ? ' <span style="color:#888">(entry 已删除)</span>' : '';
   rows += '<tr' + rowClass + '>' +
    '<td><input type="checkbox" class="cfs-sem-mig-chk" data-uid="' + m.uid + '" data-book="' + _semEsc(m.book) + '"' + (m.drifted ? ' checked' : '') + '></td>' +
    '<td>' + m.uid + '</td>' +
    '<td title="' + _semEsc(m.comment) + '">' + _semEsc(m.comment.slice(0, 30)) + missingMark + '</td>' +
    '<td>' + _semEsc(m.current_position) + '</td>' +
    '<td>' + _semEsc(m.suggested_position) + '</td>' +
    '<td>' + ts + '</td>' +
    '</tr>';
  }

  // v6.5: 还原 4.9 主动迁移角色。v6.4 PETL 已砍，SEM 候选都是 PSIS pattern 判 safe 的纯静态长 entry。
  // 漂移 = 外部工具（手动 / WM / 其他）改回，可一键重迁恢复 prefix 位置。
  var driftWarn = driftedCnt > 0
   ? '<div class="cfs-sem-drift-warn" style="color:#ffa726">⚠ <b>' + driftedCnt + '</b> 条不在 prefix。SEM 候选都是纯静态长 entry（不含动态宏），漂移多是外部工具改回。可「⚡ 重迁回 prefix」恢复，或「↩ 回滚选中」清除 SEM 记录。</div>'
   : '';

  return scopeHint +
   '<div class="cfs-sem-summary">已迁移 <b>' + mig.length + '</b> 条' + (driftedCnt > 0 ? '（其中 <span style="color:#888">' + driftedCnt + '</span> 条不在 prefix）' : '') + '</div>' +
   driftWarn +
   '<div class="cfs-sem-controls">' +
   (driftedCnt > 0 ? '<button id="cfs-sem-btn-remig-drift" class="cfs-btn cfs-btn-primary">⚡ 重迁回 prefix (' + driftedCnt + ')</button> ' : '') +
   '<button id="cfs-sem-btn-rb-sel" class="cfs-btn">↩ 回滚选中</button> ' +
   '<button id="cfs-sem-btn-rb-all" class="cfs-btn">↩↩ 全部回滚</button> ' +
   '<button id="cfs-sem-btn-back" class="cfs-btn">⬅ 返回扫描</button>' +
   '</div>' +
   '<div class="cfs-sem-table-wrap"><table class="cfs-sem-table"><thead><tr>' +
   '<th>☑</th><th>uid</th><th>标题</th><th>当前位置</th><th>建议位置</th><th>迁移时间</th>' +
   '</tr></thead><tbody>' + rows + '</tbody></table></div>';
 }

 // === bindEvents：在 panel innerHTML 重写后调用，绑定 SEM 区按钮 ===
 function _semBindEvents(D, getPanel) {
  var root = D.getElementById('cfs-sem-root');
  if (!root) return;
  var listDiv = D.getElementById('cfs-sem-list');
  var btnScan = D.getElementById('cfs-sem-btn-scan');
  var btnMigList = D.getElementById('cfs-sem-btn-mig-list');

  function _bindCandList() {
   _bindAll();
   var bMig = D.getElementById('cfs-sem-btn-migrate');
   var bRescan = D.getElementById('cfs-sem-btn-rescan');
   if (bRescan) bRescan.onclick = _doScan;
   if (bMig) bMig.onclick = async function () {
    var chks = D.querySelectorAll('.cfs-sem-chk:checked');
    if (chks.length === 0) { alert('请先勾选条目'); return; }
    if (!confirm('即将修改 ' + chks.length + ' 条世界书 entry 的 position，可一键回滚。确认？')) return;
    // 按 book 分组
    var byBook = {};
    for (var i = 0; i < chks.length; i++) {
     var bk = chks[i].getAttribute('data-book');
     var uid = Number(chks[i].getAttribute('data-uid'));
     if (!byBook[bk]) byBook[bk] = [];
     byBook[bk].push(uid);
    }
    var totalOk = 0, totalFail = 0, failDetail = [];
    for (var bk2 in byBook) {
     var r = await _semMigrate(bk2, byBook[bk2]);
     totalOk += r.ok.length;
     totalFail += r.fail.length;
     for (var fi = 0; fi < r.fail.length; fi++) failDetail.push(bk2 + ':' + r.fail[fi].uid + ':' + r.fail[fi].reason);
    }
    var NC = _GLOBAL.CFS4 && _GLOBAL.CFS4.NotificationCenter;
    if (NC) NC.notify('sem_migrated', { ok: totalOk, fail: totalFail, detail: failDetail.join(' | ') });
    if (failDetail.length) console.warn('[SEM] migrate fails:', failDetail);
    await _doScan();
   };
  }

  function _bindMigList() {
   var bSel = D.getElementById('cfs-sem-btn-rb-sel');
   var bAll = D.getElementById('cfs-sem-btn-rb-all');
   var bBack = D.getElementById('cfs-sem-btn-back');
   var bRemig = D.getElementById('cfs-sem-btn-remig-drift');
   if (bBack) bBack.onclick = _doScan;
   if (bSel) bSel.onclick = function () { _doRollback(false); };
   if (bAll) bAll.onclick = function () { _doRollback(true); };
   if (bRemig) bRemig.onclick = async function () {
    if (!confirm('对所有漂移条目重新执行深度迁移？')) return;
    var r = await _semRemigrateDrifted();
    var NC = _GLOBAL.CFS4 && _GLOBAL.CFS4.NotificationCenter;
    if (NC) NC.notify('sem_migrated', { ok: r.ok, fail: r.fail });
    await _doMigList();
   };
  }

  function _bindAll() {
   var allChk = D.getElementById('cfs-sem-all');
   if (allChk) allChk.onchange = function (e) {
    var chks = D.querySelectorAll('.cfs-sem-chk');
    for (var i = 0; i < chks.length; i++) chks[i].checked = e.target.checked;
   };
  }

  async function _doScan() {
   if (!listDiv) return;
   listDiv.innerHTML = '<div class="cfs-sem-hint">扫描中…</div>';
   try {
    var cands = await _semScanCandidates();
    _semCachedCands = cands;
    // 顺便算漂移数 → 候选表头部提示
    var driftedCnt = 0;
    try {
     var mig = await _semListMigrated();
     for (var mi = 0; mi < mig.length; mi++) if (mig[mi].drifted && !mig[mi].entry_missing) driftedCnt++;
    } catch (e0) {}
    listDiv.innerHTML = _semRenderCandList(cands, driftedCnt);
    _bindCandList();
   } catch (e) {
    listDiv.innerHTML = '<div class="cfs-sem-empty" style="color:#d77">扫描失败: ' + _semEsc(e.message || e) + '</div>';
   }
  }

  async function _doMigList() {
   if (!listDiv) return;
   listDiv.innerHTML = '<div class="cfs-sem-hint">查询中…</div>';
   try {
    var mig = await _semListMigrated();
    _semCachedMig = mig;
    listDiv.innerHTML = _semRenderMigList(mig);
    _bindMigList();
   } catch (e) {
    listDiv.innerHTML = '<div class="cfs-sem-empty" style="color:#d77">查询失败: ' + _semEsc(e.message || e) + '</div>';
   }
  }

  async function _doRollback(all) {
   var totalOk = 0, totalFail = 0;
   if (all) {
    if (!confirm('全部回滚 SEM 迁移条目？')) return;
    var ra = await _semRollbackAll();
    totalOk = ra.ok; totalFail = ra.fail;
   } else {
    var sel = Array.from(D.querySelectorAll('.cfs-sem-mig-chk:checked'));
    if (sel.length === 0) { alert('请先勾选条目'); return; }
    if (!confirm('回滚 ' + sel.length + ' 条？')) return;
    var byBook = {};
    for (var i = 0; i < sel.length; i++) {
     var bk = sel[i].getAttribute('data-book');
     var uid = Number(sel[i].getAttribute('data-uid'));
     if (!byBook[bk]) byBook[bk] = [];
     byBook[bk].push(uid);
    }
    var failDetail = [];
    for (var bk2 in byBook) {
     var r = await _semRollback(bk2, byBook[bk2]);
     totalOk += r.ok.length;
     totalFail += r.fail.length;
     for (var fi = 0; fi < r.fail.length; fi++) failDetail.push(bk2 + ':' + r.fail[fi].uid + ':' + r.fail[fi].reason);
    }
    if (failDetail.length) console.warn('[SEM] rollback fails:', failDetail);
   }
   var NC = _GLOBAL.CFS4 && _GLOBAL.CFS4.NotificationCenter;
   if (NC) NC.notify('sem_migrated', { ok: totalOk, fail: totalFail, rollback: true });
   await _doMigList();
  }

  if (btnScan) btnScan.onclick = _doScan;
  if (btnMigList) btnMigList.onclick = _doMigList;

  // 2026-06-22 把"当前 panel 应该刷新哪个 list"挂到模块层指针
  //   chat_id_changed listener 通过该指针触发自动刷新
  //   依据 DOM 上是否存在 mig-list 专属按钮判断当前是候选还是已迁移视图
  _semCurrentRefresh = function () {
   if (!root || !root.open) return;
   if (!listDiv) return;
   if (D.getElementById('cfs-sem-btn-rb-all')) {
    return _doMigList();
   }
   if (D.getElementById('cfs-sem-btn-migrate') || D.getElementById('cfs-sem-btn-rescan')) {
    return _doScan();
   }
  };
 }

 // === 拖动 + localStorage 持久化 ===
 function _semMakeDraggable(D, panel) {
  if (!panel || panel.__semDraggable) return;
  panel.__semDraggable = true;

  // Day 10 fix：原版把 mousedown 绑在 .cfs-head 上 — render() 重写 innerHTML 后
  // handle 元素被替换，listener 丢失但 __semDraggable=true 阻止重绑 → 点一下按钮就拖不动。
  // 改用事件代理：mousedown 直接绑 panel（panel 元素持久不变），
  // 进入回调时再 querySelector('.cfs-head') 拿最新 handle 判断 hit。

  var sx = 0, sy = 0, sl = 0, st = 0, dragging = false;

  panel.addEventListener('mousedown', function (e) {
   var head = panel.querySelector('.cfs-head');
   if (!head || !head.contains(e.target)) return;
   var tn = e.target.tagName;
   if (tn === 'BUTTON' || tn === 'INPUT' || tn === 'A' || tn === 'SUMMARY' || tn === 'LABEL') return;
   dragging = true;
   sx = e.clientX; sy = e.clientY;
   var rect = panel.getBoundingClientRect();
   sl = rect.left; st = rect.top;
   panel.style.left = sl + 'px';
   panel.style.top = st + 'px';
   panel.style.right = 'auto';
   panel.style.bottom = 'auto';
   e.preventDefault();
  });

  // cosmetic: 当前 head cursor 改成 move（render 后会被 STYLE_CSS 默认值盖回，没关系）
  var initialHead = panel.querySelector('.cfs-head');
  if (initialHead) initialHead.style.cursor = 'move';

  var winRef = D.defaultView || _GLOBAL;
  winRef.addEventListener('mousemove', function (e) {
   if (!dragging) return;
   var nl = sl + (e.clientX - sx);
   var nt = st + (e.clientY - sy);
   var w = panel.offsetWidth, h = panel.offsetHeight;
   nl = Math.max(0, Math.min(nl, winRef.innerWidth - w));
   nt = Math.max(0, Math.min(nt, winRef.innerHeight - h));
   panel.style.left = nl + 'px';
   panel.style.top = nt + 'px';
  });

  winRef.addEventListener('mouseup', function () {
   if (!dragging) return;
   dragging = false;
   try {
    localStorage.setItem('cfs_panel_pos', JSON.stringify({
     left: panel.style.left,
     top: panel.style.top,
    }));
   } catch (e0) {}
  });

  winRef.addEventListener('resize', function () {
   try {
    var rect = panel.getBoundingClientRect();
    if (rect.right > winRef.innerWidth || rect.bottom > winRef.innerHeight || rect.left < 0 || rect.top < 0) {
     localStorage.removeItem('cfs_panel_pos');
     panel.style.left = '';
     panel.style.top = '';
     panel.style.right = '30px';
     panel.style.bottom = '';
    }
   } catch (e1) {}
  });
 }

 function _semRestorePos(D, panel) {
  if (!panel) return;
  try {
   var raw = localStorage.getItem('cfs_panel_pos');
   if (!raw) return;
   var pos = JSON.parse(raw);
   var winRef = D.defaultView || _GLOBAL;
   var l = parseInt(pos.left, 10), t = parseInt(pos.top, 10);
   var w = panel.offsetWidth, h = panel.offsetHeight;
   if (!isFinite(l) || !isFinite(t)) return;
   if (l + w > winRef.innerWidth || t + h > winRef.innerHeight || l < 0 || t < 0) {
    localStorage.removeItem('cfs_panel_pos');
    return;
   }
   panel.style.left = pos.left;
   panel.style.top = pos.top;
   panel.style.right = 'auto';
   panel.style.bottom = 'auto';
  } catch (e) {}
 }

 // === 启动期被动扫描提示 ===
 async function _semPassiveScan() {
  if (_semPassiveDone) return;
  _semPassiveDone = true;
  try {
   var cands = await _semScanCandidates();
   var recommended = cands.filter(function (c) { return c.recommendedChecked; });
   if (recommended.length >= SEM_CONFIG.TOAST_THRESHOLD) {
    var totalGain = recommended.reduce(function (a, c) { return a + c.estimatedGain; }, 0);
    var NC = _GLOBAL.CFS4 && _GLOBAL.CFS4.NotificationCenter;
    if (NC && typeof NC.notify === 'function') {
     NC.notify('sem_candidates', { count: recommended.length, gain: totalGain.toFixed(0) });
    }
   }
  } catch (e) {
   console.warn('[SEM] passive scan failed', e);
  }
 }

 // NC routes 已在 NotificationCenter IIFE 内直接添加（line ~2337），此处无需 _addRoute

 // === 暴露 API ===
 _GLOBAL.CFS4.SEM = {
  _version: '4.9.1',
  CONFIG: SEM_CONFIG,
  scanCandidates: _semScanCandidates,
  migrate: _semMigrate,
  rollback: _semRollback,
  rollbackAll: _semRollbackAll,
  remigrateDrifted: _semRemigrateDrifted,
  listMigrated: _semListMigrated,
  auditDrift: _semAuditDrift,
  hasMigrations: function () { return Object.keys(_semStoreAll()).length > 0; },
  renderSection: _semRenderSection,
  bindEvents: _semBindEvents,
  makeDraggable: _semMakeDraggable,
  restorePos: _semRestorePos,
  passiveScan: _semPassiveScan,
 };

 // === 挂 worldinfo_updated → 1.5s 防抖 → audit drift ===
 try {
  if (typeof eventOn === 'function') {
   var _semAuditTimer = null;
   eventOn('worldinfo_updated', function () {
    if (_semAuditTimer) clearTimeout(_semAuditTimer);
    _semAuditTimer = setTimeout(_semAuditDrift, 1500);
   });
  }
 } catch (e) {}

 // === 挂 chat_id_changed → 800ms 防抖 → 清 drift 状态 + 刷新 UI ===
 // 2026-06-22 用户报告："不随着 chat change 改变"
 //   切换 chat / character 后，worldbook 绑定会变；
 //   - 清 _semDriftCount/_semDriftNotified（旧 uid 与新卡可能撞）
 //   - 清 _semPassiveDone（新卡允许重新被动扫描）
 //   - 如果 SEM panel 还展开，按当前显示的 tab 自动重拉数据
 // 兼容 ST 事件名（参考 cfs/core/kernel.js 注释）：chat_id_changed / character_selected
 try {
  if (typeof eventOn === 'function') {
   var _semChatTimer = null;
   var _semOnChatChanged = function () {
    if (_semChatTimer) clearTimeout(_semChatTimer);
    _semChatTimer = setTimeout(function () {
     _semDriftCount = {};
     _semDriftNotified = {};
     _semPassiveDone = false;
     if (typeof _semCurrentRefresh === 'function') {
      try { _semCurrentRefresh(); } catch (e0) { console.warn('[SEM] auto-refresh on chat_id_changed failed', e0); }
     }
    }, 800);
   };
   eventOn('chat_id_changed', _semOnChatChanged);
   try { eventOn('character_selected', _semOnChatChanged); } catch (e1) {}
  }
 } catch (e) {}

 console.log('[CFS v4.9.1 SEM] 已挂载，window.CFS4.SEM 可用');
})();



export const SEM = window.CFS4?.SEM;
console.log('[CFS-Suite/sem] SEM ESM bridge OK, has SEM object =', !!window.CFS4?.SEM);
