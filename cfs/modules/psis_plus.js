/**
 * CFS-Suite · modules/psis_plus.js
 *
 * 从 CFS v4.9.3 PSIS Plus（cfs_content_extracted.js L7291-7926）整段迁移。
 *
 * PSIS+ = Prompt Structural Invariant System Plus
 *   - 检测排序：扫提示词预设结构，发现"应当在 cache prefix 内"的 entry 排到了 chat 末尾
 *   - 防御性重排：移到 prefix 区（type-based registry 识别 identifier）
 *   - 持久化：localStorage cfs_psis_plus_history_v2 记录已重排的预设快照
 *   - 操作记录 + 回滚：用户能 undo 上一次重排
 *   - 对未知 identifier 全部不动（保守）
 *
 * v4.9.3 修复：savePreset 完整对象架构（之前 v4.9.2 用 patch 模式踩过坑）
 *
 * localStorage key 兼容（保留原版）：cfs_psis_plus_history_v2
 *
 * 依赖：仅 ST 原生（getCompletionPresetByName / savePreset），不依赖 v4.x 核心层
 */

import { polyfilledApis as _r } from '../compat/tavern_helper_polyfill.js';
import './psis.js'; // PSIS 主模块先就位（PSIS+ 是补丁层）
void _r;

// ============================================================
// 以下为 cfs_content_extracted.js L7291-7926 PSIS Plus IIFE
// ============================================================

// ============================================================
// CFS v4.9.2 PSIS Plus — 提示词预设结构修复模块
// 检测排序 + 防御性重排 + 持久化 + 操作记录 + 回滚
// 基于 type-based registry，对未知 identifier 全部不动
// ============================================================
(function _PSIS_PLUS_INIT() {
 var _GLOBAL = (typeof window !== 'undefined') ? (window.parent || window) : {};
 if (!_GLOBAL.CFS4) _GLOBAL.CFS4 = {};

 // === Block Type Registry ===
 // 表外 identifier 一律视为 type='unknown' → 不动
 var PSIS_BLOCK_REGISTRY = {
  'main':               { type: 'system',           mustBeBeforeHistory: true },
  'jailbreak':          { type: 'jailbreak',        mustBeBeforeHistory: true },
  'nsfw':               { type: 'jailbreak',        mustBeBeforeHistory: true },
  'worldInfoBefore':    { type: 'worldbook_static', mustBeBeforeHistory: true },
  'worldInfoAfter':     { type: 'worldbook_static', mustBeBeforeHistory: true },
  'charDescription':    { type: 'character',        mustBeBeforeHistory: true },
  'charPersonality':    { type: 'character',        mustBeBeforeHistory: true },
  'scenario':           { type: 'character',        mustBeBeforeHistory: true },
  'personaDescription': { type: 'character',        mustBeBeforeHistory: true },
  'dialogueExamples':   { type: 'character',        mustBeBeforeHistory: true },
  'chatHistory':        { type: 'chat_history',     mustBeBeforeHistory: null  },
 };

 var PSIS_PLUS_LS_KEY = 'cfs_psis_plus_history_v2'; // v4.9.3: 升级 schema 存完整预设 dump
 var PSIS_PLUS_HISTORY_LIMIT = 10;
 var PSIS_PLUS_VERIFY_DELAY_MS = 500;

 var _psisPlusOpLock = false;
 var _psisPlusStartupDone = false;

 // === localStorage 操作记录 ===
 function _psisPlusHistoryRead() {
  try {
   var raw = localStorage.getItem(PSIS_PLUS_LS_KEY);
   if (!raw) return [];
   var arr = JSON.parse(raw);
   return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
 }
 function _psisPlusHistoryWrite(arr) {
  try {
   while (arr.length > PSIS_PLUS_HISTORY_LIMIT) arr.shift();
   localStorage.setItem(PSIS_PLUS_LS_KEY, JSON.stringify(arr));
   return true;
  } catch (e) {
   console.warn('[PSIS+] localStorage write failed', e);
   return false;
  }
 }
 function _psisPlusHistoryPush(rec) {
  var arr = _psisPlusHistoryRead();
  arr.push(rec);
  return _psisPlusHistoryWrite(arr);
 }

 // === 拿 ST context + 当前 prompt_order ===
 // 同步 PSIS R0 line 1366 的写法：iframe 内 SillyTavern 全局直接可见，
 // 比 _GLOBAL.SillyTavern（window.parent.SillyTavern）更可靠
 function _psisPlusGetContext() {
  try {
   if (typeof SillyTavern !== 'undefined' && SillyTavern && typeof SillyTavern.getContext === 'function') {
    return SillyTavern.getContext();
   }
   if (_GLOBAL && _GLOBAL.SillyTavern && typeof _GLOBAL.SillyTavern.getContext === 'function') {
    return _GLOBAL.SillyTavern.getContext();
   }
   return null;
  } catch (e) {
   console.warn('[PSIS+] getContext failed', e);
   return null;
  }
 }
 function _psisPlusGetOaiSettings() {
  var ctx = _psisPlusGetContext();
  if (!ctx) return null;
  // ST context 顶层字段是 chatCompletionSettings（ST 暴露时重命名了，不是源码里的 oai_settings）
  return ctx.chatCompletionSettings || ctx.oai_settings || ctx.openai_settings || null;
 }
 function _psisPlusGetCharId() {
  var ctx = _psisPlusGetContext();
  return ctx ? (typeof ctx.characterId !== 'undefined' ? ctx.characterId : null) : null;
 }
 function _psisPlusGetPresetName() {
  try {
   var ctx = _psisPlusGetContext();
   if (ctx && typeof ctx.getPresetManager === 'function') {
    var pm = ctx.getPresetManager('openai');
    if (pm && typeof pm.getSelectedPresetName === 'function') {
     return pm.getSelectedPresetName();
    }
   }
   var oai = _psisPlusGetOaiSettings();
   return (oai && oai.preset_settings_openai) || '(未知)';
  } catch (e) { return '(未知)'; }
 }
 // 找到当前预设的 prompt_order 索引
 // ST 实际行为：chatCompletionSettings.prompt_order 通常只含 1 条
 // （当前活跃预设的 order 数组），character_id 字段可能是 ST 内部分配的 ID
 // 而非角色卡 ID。多角色多预设场景下才会有多条。
 function _psisPlusFindOrderIndex(oai, charId) {
  if (!oai || !Array.isArray(oai.prompt_order) || oai.prompt_order.length === 0) return -1;
  // 单条 → 直接用（最常见 case）
  if (oai.prompt_order.length === 1 && oai.prompt_order[0] && Array.isArray(oai.prompt_order[0].order)) {
   return 0;
  }
  // 多条 → 优先按 character_id 匹配
  for (var i = 0; i < oai.prompt_order.length; i++) {
   var po = oai.prompt_order[i];
   if (po && po.character_id == charId && Array.isArray(po.order)) return i;
  }
  // fallback：character_id == null 的全局条
  for (var j = 0; j < oai.prompt_order.length; j++) {
   var po2 = oai.prompt_order[j];
   if (po2 && (po2.character_id == null) && Array.isArray(po2.order)) return j;
  }
  // 最后兜底：第一条 order 数组非空的
  for (var k = 0; k < oai.prompt_order.length; k++) {
   var po3 = oai.prompt_order[k];
   if (po3 && Array.isArray(po3.order)) return k;
  }
  return -1;
 }

 // === Scan：列出违规 + 计算重排目标 ===
 function _psisPlusScan() {
  var oai = _psisPlusGetOaiSettings();
  if (!oai) return { ok: false, error: 'no_oai_settings', violations: [], skipped: [] };
  var charId = _psisPlusGetCharId();
  var orderIdx = _psisPlusFindOrderIndex(oai, charId);
  if (orderIdx < 0) return { ok: false, error: 'no_prompt_order', violations: [], skipped: [] };
  var order = oai.prompt_order[orderIdx].order || [];

  // 找 chatHistory 位置
  var chatIdx = -1;
  for (var i = 0; i < order.length; i++) {
   if (order[i] && order[i].identifier === 'chatHistory') { chatIdx = i; break; }
  }
  if (chatIdx < 0) return { ok: true, violations: [], skipped: [], reason: 'no_chatHistory' };

  var violations = [];
  var skipped = [];
  for (var k = chatIdx + 1; k < order.length; k++) {
   var item = order[k];
   if (!item) continue;
   var id = item.identifier;
   var reg = PSIS_BLOCK_REGISTRY[id];
   if (!reg) {
    // 未知 identifier：跳过 + 记录
    skipped.push({ identifier: id, index: k, type: 'unknown', reason: 'not_in_registry' });
    continue;
   }
   if (reg.mustBeBeforeHistory === true) {
    violations.push({
     identifier: id,
     type: reg.type,
     currentIndex: k,
     enabled: item.enabled !== false,
    });
   }
   // mustBeBeforeHistory === null（chatHistory 自身不会到这） / false 不处理
  }

  return {
   ok: true,
   violations: violations,
   skipped: skipped,
   orderIdx: orderIdx,
   charId: charId,
   presetName: _psisPlusGetPresetName(),
   chatHistoryIndex: chatIdx,
   totalLength: order.length,
  };
 }

 // === Build repair plan：计算重排后的新 order ===
 // 策略：把 violation 块（保持原相对顺序）紧贴 chatHistory 之前移动
 function _psisPlusBuildPlan(scanRes) {
  var oai = _psisPlusGetOaiSettings();
  var order = oai.prompt_order[scanRes.orderIdx].order;
  var violIds = {};
  for (var i = 0; i < scanRes.violations.length; i++) violIds[scanRes.violations[i].identifier] = true;

  // 1) 把 violation 块按原顺序抽出来
  var violBlocks = [];
  var rest = [];
  for (var j = 0; j < order.length; j++) {
   if (order[j] && violIds[order[j].identifier]) violBlocks.push(order[j]);
   else rest.push(order[j]);
  }
  // 2) 在 rest 里找 chatHistory 新位置
  var newChatIdx = -1;
  for (var k = 0; k < rest.length; k++) {
   if (rest[k] && rest[k].identifier === 'chatHistory') { newChatIdx = k; break; }
  }
  if (newChatIdx < 0) return null;
  // 3) 把 violBlocks 插到 chatHistory 之前
  var newOrder = rest.slice(0, newChatIdx).concat(violBlocks).concat(rest.slice(newChatIdx));

  // 4) 构造 diff：每个 violation 的 from/to
  var diff = [];
  for (var v = 0; v < scanRes.violations.length; v++) {
   var vd = scanRes.violations[v];
   var newIdx = -1;
   for (var w = 0; w < newOrder.length; w++) {
    if (newOrder[w] && newOrder[w].identifier === vd.identifier) { newIdx = w; break; }
   }
   diff.push({ identifier: vd.identifier, type: vd.type, from: vd.currentIndex, to: newIdx });
  }
  return { newOrder: newOrder, diff: diff };
 }

 // === Deep clone helper（structuredClone 不可用时回落 JSON） ===
 function _psisPlusDeepClone(obj) {
  if (typeof structuredClone === 'function') {
   try { return structuredClone(obj); } catch (e) {}
  }
  return JSON.parse(JSON.stringify(obj));
 }

 // === Repair：v4.9.3 新架构 ===
 // 关键修正：用 pm.getCompletionPresetByName(name) 拿完整预设对象（含 extensions / regex_script_data 等用户字段）
 // 再用 pm.savePreset(name, completeData, {skipUpdate:true}) 整体落盘，后端无过滤
 // 这样所有非 prompt_order 字段（含正则）原样保留
 async function _psisPlusRepair(planOverride) {
  if (_psisPlusOpLock) {
   return { ok: false, reason: 'busy' };
  }
  _psisPlusOpLock = true;

  try {
   var scan = _psisPlusScan();
   if (!scan.ok) return { ok: false, reason: 'scan_failed:' + scan.error };
   if (scan.violations.length === 0) return { ok: false, reason: 'no_violation' };

   var plan = planOverride || _psisPlusBuildPlan(scan);
   if (!plan) return { ok: false, reason: 'plan_build_failed' };

   var ctx = _psisPlusGetContext();
   var pm = ctx && typeof ctx.getPresetManager === 'function' ? ctx.getPresetManager('openai') : null;
   if (!pm || typeof pm.savePreset !== 'function' || typeof pm.getCompletionPresetByName !== 'function') {
    return { ok: false, reason: 'preset_manager_unavailable' };
   }

   var presetName = scan.presetName;
   if (!presetName || presetName === '(未知)' || presetName === 'gui') {
    return { ok: false, reason: 'invalid_preset_name:' + presetName };
   }

   // 关键：拿完整预设对象（含 extensions / regex_script_data 等所有用户字段）
   // 必须 deep clone，否则修改会污染 ST 内存里的 openai_settings[i]
   var fullPreset;
   try {
    var ref = pm.getCompletionPresetByName(presetName);
    if (!ref) return { ok: false, reason: 'preset_not_found:' + presetName };
    fullPreset = _psisPlusDeepClone(ref);
   } catch (e) {
    return { ok: false, reason: 'getCompletionPreset_failed:' + (e && e.message || e) };
   }

   // 安全闸：确认 fullPreset 含 prompt_order 字段
   if (!fullPreset || !Array.isArray(fullPreset.prompt_order)) {
    return { ok: false, reason: 'preset_missing_prompt_order' };
   }
   var clonedOrderIdx = _psisPlusFindOrderIndex(fullPreset, scan.charId);
   if (clonedOrderIdx < 0) {
    return { ok: false, reason: 'preset_no_matching_order' };
   }

   var beforeOrder = _psisPlusDeepClone(fullPreset.prompt_order[clonedOrderIdx].order);

   // SNAPSHOT：存完整预设（不只是 prompt_order） — v4.9.3 升级
   _psisPlusHistoryPush({
    timestamp: Date.now(),
    preset_name: presetName,
    character_id: scan.charId,
    before_full_preset: _psisPlusDeepClone(fullPreset),  // 完整 dump
    after_order: plan.newOrder,
    affected: scan.violations.map(function (v) { return v.identifier; }),
    schema_version: 2,
   });

   // 只改 clone 的 prompt_order，其它字段原样
   fullPreset.prompt_order[clonedOrderIdx].order = plan.newOrder;

   // 写入：传完整对象，ST 后端无 schema 过滤、整对象落盘
   // 关键：不传 skipUpdate，让 ST 的 updateList 把 presets[idx] 替换 + trigger('change')
   // 自动同步前端 oai_settings.prompt_order（chatCompletionSettings 就是 oai_settings 别名）
   try {
    await pm.savePreset(presetName, fullPreset);
   } catch (e) {
    return { ok: false, reason: 'savePreset_failed:' + (e && e.message || e) };
   }

   // 等持久化完成
   await new Promise(function (r) { setTimeout(r, PSIS_PLUS_VERIFY_DELAY_MS); });

   // v4.9.3 hotfix: verify 改 soft warning
   // 原因：skipUpdate:true 跳过 ST 前端内存同步，getCompletionPresetByName 仍返回修改前引用
   // savePreset 不 throw = 后端写磁盘成功（POST /api/presets/save 已返回 200）
   // 真正的 verify 应该是 F5 重启 ST 后看磁盘内容
   var memSyncOk = false;
   try {
    var afterRef = pm.getCompletionPresetByName(presetName);
    if (afterRef && Array.isArray(afterRef.prompt_order)) {
     var verifyOrderIdx = _psisPlusFindOrderIndex(afterRef, scan.charId);
     if (verifyOrderIdx >= 0 && afterRef.prompt_order[verifyOrderIdx]) {
      var actualOrder = afterRef.prompt_order[verifyOrderIdx].order;
      var actualChatIdx = -1;
      for (var u = 0; u < actualOrder.length; u++) {
       if (actualOrder[u] && actualOrder[u].identifier === 'chatHistory') { actualChatIdx = u; break; }
      }
      var allMoved = true;
      for (var v = 0; v < plan.diff.length; v++) {
       var id = plan.diff[v].identifier;
       var actualIdx = -1;
       for (var w = 0; w < actualOrder.length; w++) {
        if (actualOrder[w] && actualOrder[w].identifier === id) { actualIdx = w; break; }
       }
       if (actualIdx < 0 || actualIdx >= actualChatIdx) { allMoved = false; break; }
      }
      memSyncOk = allMoved;
     }
    }
   } catch (e) {}
   if (!memSyncOk) {
    console.warn('[PSIS+] 写磁盘成功但前端内存未同步（updateList 触发 change 后 oai_settings 应已同步，如仍未同步可手动切预设刷新）');
   }

   return { ok: true, affected: plan.diff.length, presetName: presetName, memSyncOk: memSyncOk };
  } finally {
   _psisPlusOpLock = false;
  }
 }

 // === Restore：v4.9.3 新架构 ===
 // 从 history 拿完整预设 snapshot，savePreset 整对象写回（含所有用户字段）
 // 不再依赖 updatePreset / oai_settings 中转
 async function _psisPlusRestore(idx) {
  idx = idx || 0;
  if (_psisPlusOpLock) return { ok: false, reason: 'busy' };
  _psisPlusOpLock = true;
  try {
   var arr = _psisPlusHistoryRead();
   if (arr.length === 0) return { ok: false, reason: 'no_history' };
   var rec = arr[arr.length - 1 - idx];
   if (!rec) return { ok: false, reason: 'idx_out_of_range' };

   // v4.9.3 snapshot 含完整预设；老 v1 schema 只有 before_order 字段，拒绝以防丢字段
   if (rec.schema_version !== 2 || !rec.before_full_preset) {
    return { ok: false, reason: 'snapshot_too_old_v1_schema' };
   }

   var ctx = _psisPlusGetContext();
   var pm = ctx && typeof ctx.getPresetManager === 'function' ? ctx.getPresetManager('openai') : null;
   if (!pm || typeof pm.savePreset !== 'function') {
    return { ok: false, reason: 'preset_manager_unavailable' };
   }

   var restoreClone = _psisPlusDeepClone(rec.before_full_preset);
   try {
    // 同 repair：不传 skipUpdate，让 updateList 同步前端内存
    await pm.savePreset(rec.preset_name, restoreClone);
   } catch (e) {
    return { ok: false, reason: 'savePreset_failed:' + (e && e.message || e) };
   }

   return { ok: true, timestamp: rec.timestamp, presetName: rec.preset_name };
  } finally {
   _psisPlusOpLock = false;
  }
 }

 // === 启动期被动扫描 ===
 async function _psisPlusPassiveScan() {
  if (_psisPlusStartupDone) return;
  _psisPlusStartupDone = true;
  try {
   var scan = _psisPlusScan();
   if (scan.ok && scan.violations.length >= 1) {
    var NC = _GLOBAL.CFS4 && _GLOBAL.CFS4.NotificationCenter;
    if (NC) NC.notify('psis_plus_detected', { count: scan.violations.length, preset: scan.presetName });
   }
  } catch (e) { console.warn('[PSIS+] passive scan failed', e); }
 }

 // === 渲染 HTML section ===
 function _psisPlusEsc(s) {
  return String(s == null ? '' : s)
   .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
 }

 function _psisPlusRenderSection() {
  return '<details class="cfs-psis-plus" id="cfs-psisp-root" open>' +
   '<summary>📐 提示词结构（PSIS Plus v4.9.2）— 检测乱序 + 重排 + 持久化</summary>' +
   '<div class="cfs-psisp-body" id="cfs-psisp-body">' +
   '<div class="cfs-psisp-hint">点 <b>🔍 检测排序</b> 扫描 chat-completion 预设里被错插到 chatHistory 之后的稳态块</div>' +
   '<div class="cfs-psisp-actions">' +
   '<button id="cfs-psisp-btn-scan" class="cfs-btn cfs-btn-primary">🔍 检测排序</button>' +
   '<button id="cfs-psisp-btn-hist" class="cfs-btn">📜 操作记录</button>' +
   '</div>' +
   '<div id="cfs-psisp-result"></div>' +
   '</div>' +
   '</details>';
 }

 function _psisPlusRenderScanResult(scan) {
  if (!scan.ok) {
   return '<div class="cfs-sem-empty" style="color:#d77">检测失败: ' + _psisPlusEsc(scan.error || scan.reason || '?') + '</div>';
  }
  var html = '<div class="cfs-psisp-summary">当前预设：<b>' + _psisPlusEsc(scan.presetName) + '</b></div>';
  if (scan.violations.length === 0 && scan.skipped.length === 0) {
   html += '<div class="cfs-sem-empty" style="color:#7c7">✓ 排序正常，无违规</div>';
   return html;
  }
  html += '<div class="cfs-psisp-summary">违规 <b>' + scan.violations.length + '</b> 项' +
   (scan.skipped.length > 0 ? '，跳过 <b>' + scan.skipped.length + '</b> 项 unknown 块' : '') + '</div>';

  if (scan.violations.length > 0) {
   html += '<table class="cfs-sem-table"><thead><tr>' +
    '<th>identifier</th><th>type</th><th>当前位置</th><th>状态</th>' +
    '</tr></thead><tbody>';
   for (var i = 0; i < scan.violations.length; i++) {
    var v = scan.violations[i];
    html += '<tr><td>' + _psisPlusEsc(v.identifier) + '</td>' +
     '<td><span class="cfs-psisp-type cfs-psisp-type-' + _psisPlusEsc(v.type) + '">' + _psisPlusEsc(v.type) + '</span></td>' +
     '<td>index ' + v.currentIndex + ' (chatHistory 后)</td>' +
     '<td style="color:#e88">⚠ 违规</td></tr>';
   }
   html += '</tbody></table>';
   html += '<div class="cfs-psisp-actions">' +
    '<button id="cfs-psisp-btn-repair" class="cfs-btn cfs-btn-primary">⚡ 重排修复（预览 diff）</button>' +
    '<button id="cfs-psisp-btn-restore" class="cfs-btn">↩ 还原上次</button>' +
    '</div>';
  }

  if (scan.skipped.length > 0) {
   html += '<details class="cfs-psisp-skipped"><summary>跳过的 unknown 块 ' + scan.skipped.length + ' 项（v5.x 可注册）</summary>';
   html += '<table class="cfs-sem-table"><thead><tr><th>identifier</th><th>当前位置</th></tr></thead><tbody>';
   for (var s = 0; s < scan.skipped.length; s++) {
    var sk = scan.skipped[s];
    html += '<tr><td>' + _psisPlusEsc(sk.identifier) + '</td><td>index ' + sk.index + '</td></tr>';
   }
   html += '</tbody></table></details>';
  }
  return html;
 }

 function _psisPlusRenderDiffModal(scan, plan) {
  var rows = '';
  for (var i = 0; i < plan.diff.length; i++) {
   var d = plan.diff[i];
   var arrow = d.from > d.to ? '↑' : (d.from < d.to ? '↓' : '─');
   rows += '<tr><td>' + _psisPlusEsc(d.identifier) + '</td>' +
    '<td><span class="cfs-psisp-type cfs-psisp-type-' + _psisPlusEsc(d.type) + '">' + _psisPlusEsc(d.type) + '</span></td>' +
    '<td>' + d.from + '</td><td>→</td><td><b>' + d.to + '</b></td><td>' + arrow + '</td></tr>';
  }
  var skipNote = scan.skipped.length > 0
   ? '<div class="cfs-psisp-skip-note">' + scan.skipped.length + ' 项 type=unknown 块保持原位（防御策略）</div>' : '';
  return '<div class="cfs-psisp-modal-bg" id="cfs-psisp-modal-bg">' +
   '<div class="cfs-psisp-modal">' +
   '<div class="cfs-psisp-modal-head">即将重排 ' + plan.diff.length + ' 项 markers</div>' +
   '<div class="cfs-psisp-modal-body">' +
   '<table class="cfs-sem-table"><thead><tr>' +
   '<th>identifier</th><th>type</th><th>from</th><th></th><th>to</th><th></th>' +
   '</tr></thead><tbody>' + rows + '</tbody></table>' +
   skipNote +
   '<div class="cfs-psisp-modal-warn">⚠ 重排后会调 <code>presetManager.updatePreset()</code> 覆盖更新当前选中预设。可一键还原。</div>' +
   '</div>' +
   '<div class="cfs-psisp-modal-foot">' +
   '<button id="cfs-psisp-modal-cancel" class="cfs-btn">取消</button>' +
   '<button id="cfs-psisp-modal-confirm" class="cfs-btn cfs-btn-primary">确认重排</button>' +
   '</div>' +
   '</div></div>';
 }

 function _psisPlusRenderHistory(arr) {
  if (!arr || arr.length === 0) return '<div class="cfs-sem-empty">无操作记录</div>';
  var rows = '';
  for (var i = arr.length - 1; i >= 0; i--) {
   var rec = arr[i];
   var ts = new Date(rec.timestamp).toLocaleString();
   var idx = arr.length - 1 - i;
   rows += '<tr><td>' + idx + '</td>' +
    '<td>' + ts + '</td>' +
    '<td>' + _psisPlusEsc(rec.preset_name) + '</td>' +
    '<td>' + (rec.affected || []).join(', ') + '</td>' +
    '<td><button class="cfs-btn cfs-psisp-btn-restore-idx" data-idx="' + idx + '">↩ 还原</button></td>' +
    '</tr>';
  }
  return '<div class="cfs-psisp-summary">操作记录 ' + arr.length + ' 条（FIFO，上限 ' + PSIS_PLUS_HISTORY_LIMIT + '）</div>' +
   '<table class="cfs-sem-table"><thead><tr>' +
   '<th>idx</th><th>时间</th><th>预设</th><th>影响 markers</th><th></th>' +
   '</tr></thead><tbody>' + rows + '</tbody></table>' +
   '<div class="cfs-psisp-actions">' +
   '<button id="cfs-psisp-btn-back" class="cfs-btn">⬅ 返回</button>' +
   '</div>';
 }

 // === bindEvents ===
 function _psisPlusBindEvents(D, getPanel) {
  var root = D.getElementById('cfs-psisp-root');
  if (!root) return;
  var resultDiv = D.getElementById('cfs-psisp-result');
  var btnScan = D.getElementById('cfs-psisp-btn-scan');
  var btnHist = D.getElementById('cfs-psisp-btn-hist');

  async function _doScan() {
   if (!resultDiv) return;
   resultDiv.innerHTML = '<div class="cfs-sem-hint">扫描中…</div>';
   try {
    var scan = _psisPlusScan();
    resultDiv.innerHTML = _psisPlusRenderScanResult(scan);
    var bRepair = D.getElementById('cfs-psisp-btn-repair');
    var bRestore = D.getElementById('cfs-psisp-btn-restore');
    if (bRepair) bRepair.onclick = function () { _showDiffModal(scan); };
    if (bRestore) bRestore.onclick = _doRestore;
   } catch (e) {
    resultDiv.innerHTML = '<div class="cfs-sem-empty" style="color:#d77">扫描异常: ' + _psisPlusEsc(e.message || e) + '</div>';
   }
  }

  function _showDiffModal(scan) {
   var plan = _psisPlusBuildPlan(scan);
   if (!plan) {
    alert('计算重排方案失败');
    return;
   }
   var bg = D.createElement('div');
   bg.innerHTML = _psisPlusRenderDiffModal(scan, plan);
   var panel = getPanel ? getPanel() : null;
   (panel || D.body).appendChild(bg.firstElementChild);

   var modalBg = D.getElementById('cfs-psisp-modal-bg');
   var bCancel = D.getElementById('cfs-psisp-modal-cancel');
   var bConfirm = D.getElementById('cfs-psisp-modal-confirm');
   function _close() { if (modalBg && modalBg.parentNode) modalBg.parentNode.removeChild(modalBg); }
   if (bCancel) bCancel.onclick = _close;
   if (modalBg) modalBg.onclick = function (e) { if (e.target === modalBg) _close(); };
   if (bConfirm) bConfirm.onclick = async function () {
    bConfirm.disabled = true;
    bConfirm.textContent = '重排中…';
    var r = await _psisPlusRepair(plan);
    _close();
    var NC = _GLOBAL.CFS4 && _GLOBAL.CFS4.NotificationCenter;
    if (r.ok) {
     if (NC) NC.notify('psis_plus_repaired', { count: r.affected, preset: r.presetName });
    } else {
     if (NC) NC.notify('psis_plus_failed', { detail: r.reason });
    }
    await _doScan();
   };
  }

  async function _doRestore() {
   if (!confirm('还原到上一次修改前的排序？')) return;
   var r = await _psisPlusRestore(0);
   var NC = _GLOBAL.CFS4 && _GLOBAL.CFS4.NotificationCenter;
   if (r.ok) {
    if (NC) NC.notify('psis_plus_restored', { timestamp: new Date(r.timestamp).toLocaleString(), preset: r.presetName });
   } else {
    if (NC) NC.notify('psis_plus_failed', { detail: r.reason });
   }
   await _doScan();
  }

  async function _doHistory() {
   if (!resultDiv) return;
   var arr = _psisPlusHistoryRead();
   resultDiv.innerHTML = _psisPlusRenderHistory(arr);
   var bBack = D.getElementById('cfs-psisp-btn-back');
   if (bBack) bBack.onclick = _doScan;
   var idxBtns = D.querySelectorAll('.cfs-psisp-btn-restore-idx');
   for (var i = 0; i < idxBtns.length; i++) {
    (function (btn) {
     btn.onclick = async function () {
      var idx = Number(btn.getAttribute('data-idx'));
      if (!confirm('还原到 idx=' + idx + ' 的快照？')) return;
      var r = await _psisPlusRestore(idx);
      var NC = _GLOBAL.CFS4 && _GLOBAL.CFS4.NotificationCenter;
      if (r.ok) {
       if (NC) NC.notify('psis_plus_restored', { timestamp: new Date(r.timestamp).toLocaleString(), preset: r.presetName });
      } else {
       if (NC) NC.notify('psis_plus_failed', { detail: r.reason });
      }
      await _doHistory();
     };
    })(idxBtns[i]);
   }
  }

  if (btnScan) btnScan.onclick = _doScan;
  if (btnHist) btnHist.onclick = _doHistory;
 }

 // === 暴露 API ===
 _GLOBAL.CFS4.PSISPlus = {
  _version: '4.9.3',
  REGISTRY: PSIS_BLOCK_REGISTRY,
  scan: _psisPlusScan,
  repair: function (planOverride) { return _psisPlusRepair(planOverride); },
  restore: function (idx) { return _psisPlusRestore(idx); },
  history: _psisPlusHistoryRead,
  registry: function () { return PSIS_BLOCK_REGISTRY; },
  renderSection: _psisPlusRenderSection,
  bindEvents: _psisPlusBindEvents,
  passiveScan: _psisPlusPassiveScan,
 };

 // === 启动期挂钩 ===
 // 预设是常驻的，跟会话/角色卡无关，触发点：
 //   1) app_ready 事件 — ST 主体加载完
 //   2) oai_preset_changed_after — 切预设时
 // 不用盲等 setTimeout
 try {
  if (typeof eventOn === 'function') {
   eventOn('oai_preset_changed_after', function () {
    _psisPlusStartupDone = false;
    setTimeout(_psisPlusPassiveScan, 1000);
   });
  }
  if (typeof eventOnce === 'function') {
   eventOnce('app_ready', function () {
    setTimeout(_psisPlusPassiveScan, 500); // 让 chatCompletionSettings 完成 hydrate
   });
  } else {
   // 老版 ST 没 eventOnce → 短延时兜底
   setTimeout(_psisPlusPassiveScan, 2000);
  }
 } catch (e) {}

 console.log('[CFS v4.9.3 PSIS Plus] 已挂载，window.CFS4.PSISPlus 可用 (savePreset 完整对象架构)');
})();


export const PSISPlus = window.CFS4?.PSISPlus;
console.log('[CFS-Suite/psis-plus] PSIS+ ESM bridge OK, has PSISPlus object =', !!window.CFS4?.PSISPlus);
