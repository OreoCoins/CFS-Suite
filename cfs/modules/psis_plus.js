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
   // 2026-06-22 v6.2.0 · 写失败显式提示（避免静默吞异常导致用户看不到 AUTO 接管记录）
   //   常见原因：LS quota 超出（before_full_preset 大 dump × 10 条可能撞 5MB 限制）
   console.warn('[PSIS+] localStorage write failed', e);
   try {
    if (typeof toastr !== 'undefined' && toastr.error) {
     toastr.error('CFS PSIS+ 操作记录写入失败（可能 LS 容量超 5MB）。控制台见详细错误。可在 F12 跑 localStorage.removeItem("' + PSIS_PLUS_LS_KEY + '") 清空历史后重试。', 'CFS-Suite PSIS+', { timeOut: 12000 });
    }
   } catch (_e) {}
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

 // === v6.2.0 新增 · 启发式判定 unknown 块是否可前移 ===
 // 背景（2026-06-22 plan temporal-swan）：
 //   双人成行 v7.0 等预设把 8 个 UUID-identifier 的 user-role prompt 排在 chatHistory 之后。
 //   PSIS_BLOCK_REGISTRY 只识别 11 个 ST 内置 identifier，UUID 块全部归 unknown → 旧版主动跳过。
 //   这些 user-role prompt 多数是稳定的思维链/输出格式约束，前移可大幅提升 prompt cache 命中率。
 // 设计：保守白名单 + 多层黑名单逐项排除，所有有疑议的块走 'uncertain' 不前移。

 // 真"全文出现即拒"的动态宏（渲染逐轮变化，无字面引用场景）
 //   2026-06-22 v6.2.0 真机调参（双人成行 v7.0）：原 plan 把 `<user> <user_input> <chathistory>`
 //   也列入是过保守 — 这些在大块提示词里常见字面引用（思维链/输出格式），全文匹配会误杀。
 //   结构性禁令交给 _psisPlusTagsBalanced（独立成行 + 短块孤立标签）处理。
 var SKIP_PIN_MARKERS = [
  '{{lastusermessage}}',
  '{{lastmessage}}',
  '<STABLE_BATCH',
 ];

 // 软拒动态宏（含 → uncertain 而非 keep_after）：
 //   `{{user}}`/`{{char}}` 在 ST 中按 persona/char 名渲染，切 persona 时 prefix cache 断；
 //   但跨轮在同一会话内稳定。保守 uncertain（不前移，但不像硬拒那么绝对）。
 var SOFT_SKIP_MARKERS = [
  '{{user}}',
  '{{char}}',
 ];

 // 反查 oai.prompts[] 拿 prompt entry 完整定义（identifier → entry）
 function _psisPlusFindPromptEntry(identifier) {
  var oai = _psisPlusGetOaiSettings();
  if (!oai || !Array.isArray(oai.prompts)) return null;
  for (var i = 0; i < oai.prompts.length; i++) {
   if (oai.prompts[i] && oai.prompts[i].identifier === identifier) return oai.prompts[i];
  }
  return null;
 }

 // 检测块内 XML 风格标签是否真正"结构性不配对"
 // 06-21 历史教训（D:\Silly\LOG\2026-06-21-rsi-l1l2l3-impl-log.md）：
 //   把孤立的 </chathistory> 闭合标签从 post-history 前移，破坏配对结构 → 模型输出中断。
 //
 // 2026-06-22 实测调整（双人成行 v7.0 思维链/输出格式）：
 //   旧实现用全文 regex 数标签，把 `<user>`/`<foxp>` 等字面引用（嵌在文本中、`$()` 内）
 //   误识别为结构标签 → 配对失败 → 大块稳定 entry 被错误拒绝。
 //
 // 新规则两步走：
 //   1) 整块短（< 80 字符）且 trim 后只剩一个孤立 `<tag>` 或 `</tag>` → 拒（防 14B `</chathistory>`）
 //   2) 否则只数"独立成行 / 块首尾"的真结构标签（前导可缩进），字面引用不计入
 //      中文标签名（`<自定义标签>` 等）regex 不匹配 → 自动忽略，无副作用
 function _psisPlusTagsBalanced(content) {
  if (!content) return true;
  var trimmed = content.trim();
  // (1) 极短块仅含一个孤立标签
  if (trimmed.length < 80 && /^<\/?[a-zA-Z_][\w-]*(?:\s+[^>]*)?>\s*$/.test(trimmed)) {
   return false;
  }
  function nameOf(raw) {
   var m = raw.match(/<\/?([a-zA-Z_][\w-]*)/);
   return m ? m[1].toLowerCase() : '';
  }
  // (2) 仅数独立成行的真结构标签（行首允许缩进，行尾要 \n 或 EOF）
  var openLine = content.match(/(?:^|\n)[ \t]*<[a-zA-Z_][\w-]*(?:\s+[^>]*)?>[ \t]*(?=\n|$)/g) || [];
  var closeLine = content.match(/(?:^|\n)[ \t]*<\/[a-zA-Z_][\w-]*>[ \t]*(?=\n|$)/g) || [];
  // self-close `<tag/>` 过滤
  openLine = openLine.filter(function (t) { return !/\/\s*>\s*$/.test(t); });
  var openCounts = {}, closeCounts = {};
  for (var i = 0; i < openLine.length; i++) {
   var n = nameOf(openLine[i]);
   if (n) openCounts[n] = (openCounts[n] || 0) + 1;
  }
  for (var j = 0; j < closeLine.length; j++) {
   var n2 = nameOf(closeLine[j]);
   if (n2) closeCounts[n2] = (closeCounts[n2] || 0) + 1;
  }
  var allNames = Object.keys(openCounts).concat(Object.keys(closeCounts));
  for (var k = 0; k < allNames.length; k++) {
   var n3 = allNames[k];
   if ((openCounts[n3] || 0) !== (closeCounts[n3] || 0)) return false;
  }
  return true;
 }

 // 启发式判定：unknown 块是否可安全前移
 //   返回 'stable_move' | 'keep_after' | 'uncertain'
 // 注意：{{getvar::xxx}} 是 ST 模板宏（渲染稳定）允许通过；getvar(xxx) 是 JS 函数式（不稳定）拒绝
 function _psisPlusJudgeUnknown(identifier, promptEntry) {
  var content = (promptEntry && promptEntry.content) || '';
  var name = (promptEntry && promptEntry.name) || '';

  // Step A · 显式 comment marker（最高优先级，用户逃生口）
  if (/\[cfs:stable\]/i.test(name) || /\[cfs:stable\]/i.test(content)) return 'stable_move';
  if (/\[cfs:keep-after-history\]/i.test(name) || /\[cfs:ignore\]/i.test(name)) return 'keep_after';

  // Step B · 硬拒名单（真动态宏，全文匹配即拒）
  for (var i = 0; i < SKIP_PIN_MARKERS.length; i++) {
   if (content.indexOf(SKIP_PIN_MARKERS[i]) >= 0) return 'keep_after';
  }

  // Step C · XML 标签配对（独立成行 + 短块孤立标签判定）
  if (!_psisPlusTagsBalanced(content)) return 'keep_after';

  // Step D · 动态宏（区分 ST 模板宏 vs JS 函数式）
  if (/\{\{random\b/i.test(content)) return 'uncertain';
  if (/\{\{roll\b/i.test(content)) return 'uncertain';
  if (/\{\{(date|time|datetime)\}\}/i.test(content)) return 'uncertain';
  if (/getvar\s*\(/i.test(content)) return 'uncertain';
  if (/<%[^%]*%>/.test(content)) return 'uncertain';
  // Step D-soft · persona/char 占位（含字面 {{user}}/{{char}} → 切 persona 时 prefix cache 断风险）
  for (var si = 0; si < SOFT_SKIP_MARKERS.length; si++) {
   if (content.indexOf(SOFT_SKIP_MARKERS[si]) >= 0) return 'uncertain';
  }

  // Step E · 长度阈值（小块前移收益不抵风险）
  if (content.length < 200) return 'uncertain';

  // Step F · role 必须是 user 或 system
  var role = promptEntry && promptEntry.role;
  if (role !== 'user' && role !== 'system') return 'uncertain';

  return 'stable_move';
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
    // 2026-06-22 v6.2.0 · 未知 identifier 走启发式判定（旧版"全跳过"是命中率天花板根因）
    var promptEntry = _psisPlusFindPromptEntry(id);
    var verdict = _psisPlusJudgeUnknown(id, promptEntry);
    if (verdict === 'stable_move') {
     violations.push({
      identifier: id,
      type: 'auto_unknown',
      currentIndex: k,
      enabled: item.enabled !== false,
      promptName: promptEntry && promptEntry.name,
      contentLen: (promptEntry && promptEntry.content) ? promptEntry.content.length : 0,
      judgedBy: 'heuristic',
     });
    } else {
     skipped.push({
      identifier: id, index: k, type: 'unknown',
      reason: verdict,
      promptName: promptEntry && promptEntry.name,
     });
    }
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
 //
 // 2026-06-22 v6.2.0 · 新增 ctxMeta 参数：
 //   { source: 'manual'|'passive_scan'|'oai_preset_changed_after', violations: scan.violations }
 //   snapshot 会带 source + affected_detail（含 type/promptName/contentLen/from/to/judgedBy）
 //   旧调用 _psisPlusRepair(plan) 仍兼容（ctxMeta 缺省时 affected_detail 仅含 from/to）
 async function _psisPlusRepair(planOverride, ctxMeta) {
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

   // 2026-06-22 v6.2.0 · 富化 affected_detail，让操作记录能展示启发式接管细节
   //   优先从 ctxMeta.violations 拿（外部传入的最新 scan），缺省时回退到本次 scan.violations
   var violationsRef = (ctxMeta && Array.isArray(ctxMeta.violations) && ctxMeta.violations.length > 0)
    ? ctxMeta.violations
    : scan.violations;
   var violationByIdent = {};
   for (var vi = 0; vi < violationsRef.length; vi++) {
    var vv = violationsRef[vi];
    if (vv && vv.identifier) violationByIdent[vv.identifier] = vv;
   }
   var affectedDetail = [];
   for (var di = 0; di < (plan.diff || []).length; di++) {
    var d = plan.diff[di];
    var v = violationByIdent[d.identifier] || {};
    affectedDetail.push({
     identifier: d.identifier,
     type: d.type || v.type || 'unknown',
     promptName: v.promptName || null,
     contentLen: v.contentLen || 0,
     from: d.from,
     to: d.to,
     judgedBy: v.judgedBy || (d.type === 'auto_unknown' ? 'heuristic' : 'registry'),
    });
   }

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

   // SNAPSHOT v3：只存 before_order（prompt_order 数组），不再 dump 整个 preset
   //   v4.9.3 (schema v2) 存 before_full_preset 是为了 restore 时不丢非 prompt_order 字段，
   //   但每条 几百 KB × 10 条 容易撞 LS 5MB quota（2026-06-22 实测用户报错）。
   //   v3 改法：restore 时现场拿最新 fullPreset → 仅替换 prompt_order → savePreset。
   //   副作用：用户在接管后改的其他字段（extensions/regex_script_data）restore 时保留不回滚，
   //          这反而更符合直觉（用户的后续改动不应被 restore 抹掉）。
   //   旧 v2 snapshot 通过 before_full_preset 字段继续支持，向后兼容。
   var snapshotSource = (ctxMeta && ctxMeta.source) || 'manual';
   var pushOk = _psisPlusHistoryPush({
    timestamp: Date.now(),
    preset_name: presetName,
    character_id: scan.charId,
    order_idx: clonedOrderIdx,
    before_order: beforeOrder,
    after_order: plan.newOrder,
    affected: scan.violations.map(function (v) { return v.identifier; }),
    affected_detail: affectedDetail,
    source: snapshotSource,
    schema_version: 3,
   });
   var snapshotSize = JSON.stringify(beforeOrder || []).length;
   console.log('[PSIS+] history push source=' + snapshotSource + ' affected=' + affectedDetail.length + ' snapshot_bytes=' + snapshotSize + ' write_ok=' + pushOk);

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

   var ctx = _psisPlusGetContext();
   var pm = ctx && typeof ctx.getPresetManager === 'function' ? ctx.getPresetManager('openai') : null;
   if (!pm || typeof pm.savePreset !== 'function' || typeof pm.getCompletionPresetByName !== 'function') {
    return { ok: false, reason: 'preset_manager_unavailable' };
   }

   var restoreClone;
   if (rec.schema_version === 3 && Array.isArray(rec.before_order)) {
    // v3：现场拿最新 fullPreset → 仅替换 prompt_order[idx].order → savePreset
    //   用户在接管后改的其他字段（extensions/regex_script_data）保留不回滚
    var ref;
    try {
     ref = pm.getCompletionPresetByName(rec.preset_name);
    } catch (e) {
     return { ok: false, reason: 'getCompletionPreset_failed:' + (e && e.message || e) };
    }
    if (!ref) return { ok: false, reason: 'preset_not_found:' + rec.preset_name };
    restoreClone = _psisPlusDeepClone(ref);
    if (!restoreClone || !Array.isArray(restoreClone.prompt_order)) {
     return { ok: false, reason: 'preset_missing_prompt_order' };
    }
    var restoreIdx = (typeof rec.order_idx === 'number' && rec.order_idx >= 0 && restoreClone.prompt_order[rec.order_idx])
     ? rec.order_idx
     : _psisPlusFindOrderIndex(restoreClone, rec.character_id);
    if (restoreIdx < 0) return { ok: false, reason: 'preset_no_matching_order' };
    restoreClone.prompt_order[restoreIdx].order = _psisPlusDeepClone(rec.before_order);
   } else if (rec.schema_version === 2 && rec.before_full_preset) {
    // v2：兼容已有完整 dump snapshot
    restoreClone = _psisPlusDeepClone(rec.before_full_preset);
   } else {
    return { ok: false, reason: 'snapshot_too_old_or_corrupt:v' + (rec.schema_version || '?') };
   }

   try {
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
 // 2026-06-22 v6.2.0：从 notify-only 升级到 auto-repair（plan temporal-swan Step 5）
 //   用户拍板"跨卡跨预设通杀"，不再要求用户手动点 UI 确认；启发式误判可通过 PSIS+ 「📜 操作记录」→「还原」回滚。
 async function _psisPlusPassiveScan() {
  if (_psisPlusStartupDone) return;
  _psisPlusStartupDone = true;
  await _psisPlusAutoRepair({ source: 'passive_scan' });
 }

 // 自动 repair：扫 → 有 violation 直接 repair（含启发式 auto_unknown 块）
 //   独立暴露给 oai_preset_changed_after / chat_id_changed / app_ready / F12 console 复用
 async function _psisPlusAutoRepair(opts) {
  opts = opts || {};
  var src = opts.source || 'auto';
  try {
   var scan = _psisPlusScan();
   // 2026-06-22 v6.2.0 · 显式 console 日志让用户 F12 可观测 AUTO 是否真正触发
   console.log('[PSIS+] autoRepair start source=' + src + ' violations=' + ((scan.violations && scan.violations.length) || 0) + ' preset=' + (scan.presetName || '?'));
   if (!scan.ok) {
    console.warn('[PSIS+] autoRepair abort: scan_failed', scan.error || scan.reason);
    return { ok: false, reason: scan.error || scan.reason || 'scan_failed' };
   }
   if (!scan.violations || scan.violations.length === 0) {
    console.log('[PSIS+] autoRepair noop: no violations');
    return { ok: true, applied: 0, scan: scan };
   }
   var plan = _psisPlusBuildPlan(scan);
   if (!plan) {
    console.warn('[PSIS+] autoRepair abort: plan_failed');
    return { ok: false, reason: 'plan_failed' };
   }
   var r = await _psisPlusRepair(plan, { source: src, violations: scan.violations });
   console.log('[PSIS+] autoRepair done source=' + src + ' result=' + JSON.stringify({ ok: r && r.ok, applied: r && r.affected, reason: r && r.reason }));
   var NC = _GLOBAL.CFS4 && _GLOBAL.CFS4.NotificationCenter;
   if (r.ok) {
    var autoUnknownCount = 0;
    for (var i = 0; i < scan.violations.length; i++) {
     if (scan.violations[i].type === 'auto_unknown') autoUnknownCount++;
    }
    if (NC) {
     NC.notify('psis_plus_repaired', {
      count: r.affected,
      preset: r.presetName,
      auto: true,
      heuristic: autoUnknownCount,
      source: opts.source || 'manual',
     });
    }
   } else {
    if (NC) NC.notify('psis_plus_failed', { detail: r.reason, auto: true, source: opts.source || 'manual' });
   }
   return r;
  } catch (e) {
   console.warn('[PSIS+] auto repair failed', e);
   return { ok: false, reason: 'exception:' + ((e && e.message) || e) };
  }
 }

 // === 渲染 HTML section ===
 function _psisPlusEsc(s) {
  return String(s == null ? '' : s)
   .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
 }

 function _psisPlusRenderSection() {
  return '<details class="cfs-psis-plus" id="cfs-psisp-root" open>' +
   '<summary>📐 提示词结构 PSIS PLUS — 检测乱序 + 重排 + 自动储存到预设（可还原）</summary>' +
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
    // 2026-06-22 v6.2.0 · auto_unknown 块加 [启发式] 前缀 + 名称/长度，让用户一眼分辨判定来源
    var heurPrefix = (v.type === 'auto_unknown')
     ? '<span style="color:#a8c;font-weight:bold;margin-right:6px">[启发式]</span>' : '';
    var nameInfo = v.promptName
     ? '<div style="color:#888;font-size:11px">' + _psisPlusEsc(v.promptName) +
       (v.contentLen ? ' · ' + v.contentLen + 'B' : '') + '</div>'
     : '';
    html += '<tr><td>' + heurPrefix + _psisPlusEsc(v.identifier) + nameInfo + '</td>' +
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
   html += '<details class="cfs-psisp-skipped"><summary>跳过的 unknown 块 ' + scan.skipped.length + ' 项（启发式拒绝 / 兜底保守）</summary>';
   html += '<table class="cfs-sem-table"><thead><tr><th>identifier</th><th>名称</th><th>当前位置</th><th>原因</th></tr></thead><tbody>';
   for (var s = 0; s < scan.skipped.length; s++) {
    var sk = scan.skipped[s];
    var reasonColor = sk.reason === 'keep_after' ? '#888'
     : sk.reason === 'uncertain' ? '#dd7'
     : '#888';
    html += '<tr><td>' + _psisPlusEsc(sk.identifier) + '</td>' +
     '<td style="color:#888;font-size:11px">' + _psisPlusEsc(sk.promptName || '') + '</td>' +
     '<td>index ' + sk.index + '</td>' +
     '<td style="color:' + reasonColor + ';font-size:11px">' + _psisPlusEsc(sk.reason || '') + '</td></tr>';
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

 // 2026-06-22 v6.2.0 · 升级操作记录展示：
 //   - 触发源徽章（manual / auto / passive_scan / oai_preset_changed_after）
 //   - 每个 violation 展开行：[类型徽章] promptName · identifier · index from→to
 //   - auto_unknown 块加紫色 [启发式] 标记，让用户清楚 AUTO 是被哪个启发式判定带进来的
 //   - 旧 schema v2 snapshot 无 affected_detail 时降级展示（兼容已落盘记录）
 function _psisPlusSourceLabel(s) {
  if (!s) return '<span style="color:#888">(manual)</span>';
  if (s === 'manual') return '<span style="color:#aaa">手动</span>';
  if (s === 'oai_preset_changed_after') return '<span style="color:#7af">切预设</span>';
  if (s === 'passive_scan') return '<span style="color:#7af">启动扫描</span>';
  if (s === 'auto') return '<span style="color:#7af">auto</span>';
  return '<span style="color:#888">' + _psisPlusEsc(s) + '</span>';
 }

 // 2026-06-22 v6.2.0 · 操作记录改 modal 弹层（不再挤在窄胶囊侧栏）
 //   modal 宽 min(960px, 95vw)，复用 PSIS+ 已有的 cfs-psisp-modal-bg/cfs-psisp-modal 套路
 //   _psisPlusRenderHistory 仍返回表格 HTML（向后兼容直接渲染场景）
 //   _psisPlusRenderHistoryModal 包成全屏弹层，由 _doHistory 调用
 function _psisPlusRenderHistoryModal(arr) {
  var tableHtml = _psisPlusRenderHistory(arr);
  // inline style 覆写 modal 宽度（不动 psis.js 的 .cfs-psisp-modal CSS，避免影响 diff modal）
  return '<div class="cfs-psisp-modal-bg" id="cfs-psisp-hist-modal-bg">' +
   '<div class="cfs-psisp-modal" style="width:min(960px,95vw);max-height:85vh">' +
   '<div class="cfs-psisp-modal-head">📜 PSIS+ 操作记录</div>' +
   '<div class="cfs-psisp-modal-body">' + tableHtml + '</div>' +
   '<div class="cfs-psisp-modal-foot">' +
   '<button id="cfs-psisp-hist-modal-close" class="cfs-btn">关闭</button>' +
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

   // 新版（v6.2.0+）：每条 violation 紧凑单行（PSIS+ 窄列宽适配）
   //   紫圆=启发式 auto_unknown，蓝圆=内置 registry 类型
   //   超出宽度走 ellipsis，全文进 tooltip
   var detailHtml = '';
   if (Array.isArray(rec.affected_detail) && rec.affected_detail.length > 0) {
    for (var dj = 0; dj < rec.affected_detail.length; dj++) {
     var d = rec.affected_detail[dj];
     var dot = (d.type === 'auto_unknown')
      ? '<span style="color:#a8c">●</span>'
      : '<span style="color:#7af">●</span>';
     // fallback name 优先级：promptName > 内置 registry 类型名（如 charDescription/worldInfoBefore）> identifier 短码
     var name = d.promptName
      || ((d.type && d.type !== 'auto_unknown' && d.type !== 'unknown') ? d.type : null)
      || ('#' + (String(d.identifier || '').slice(0, 6)));
     var pos = (d.from != null && d.to != null) ? (d.from + '→' + d.to) : '';
     var tipParts = [
      'id: ' + (d.identifier || ''),
      'type: ' + (d.type || ''),
      'name: ' + (d.promptName || '(无)'),
      'len: ' + (d.contentLen || 0) + 'B',
      'judgedBy: ' + (d.judgedBy || '(无)'),
     ];
     if (pos) tipParts.push('index: ' + pos);
     var tip = tipParts.join('\n');
     detailHtml += '<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px;line-height:1.6" title="' + _psisPlusEsc(tip) + '">' +
      dot + ' ' + _psisPlusEsc(name) +
      (pos ? ' <span style="color:#888">· ' + pos + '</span>' : '') +
      '</div>';
    }
   } else {
    // 旧 snapshot 降级
    var legacyStr = (rec.affected || []).join(', ');
    detailHtml = '<div style="color:#888;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + _psisPlusEsc(legacyStr) + '">' + _psisPlusEsc(legacyStr) + '</div>';
   }

   var heuristicCount = 0;
   var totalDetail = 0;
   if (Array.isArray(rec.affected_detail)) {
    totalDetail = rec.affected_detail.length;
    for (var hi = 0; hi < totalDetail; hi++) {
     if (rec.affected_detail[hi].type === 'auto_unknown') heuristicCount++;
    }
   }
   var heurSummary = (heuristicCount > 0)
    ? '<span style="color:#a8c">●</span>' + heuristicCount + ' '
    : '';
   var regCount = totalDetail - heuristicCount;
   var regSummary = (regCount > 0)
    ? '<span style="color:#7af">●</span>' + regCount + ' '
    : '';
   var countSummary = (totalDetail > 0) ? (heurSummary + regSummary) : '';

   // 时间/触发列：日期、时间、触发源徽章、计数 — 各占一行紧凑显示
   var dateStr = ts.split(' ')[0] || ts;
   var timeStr = ts.split(' ')[1] || '';
   var metaCol = '<div style="font-size:10px;color:#aaa">' + _psisPlusEsc(dateStr) + '</div>' +
    '<div style="font-size:11px">' + _psisPlusEsc(timeStr) + '</div>' +
    '<div style="font-size:10px;margin-top:2px">' + _psisPlusSourceLabel(rec.source) + '</div>' +
    (countSummary ? '<div style="font-size:10px;margin-top:2px">' + countSummary + '</div>' : '');

   rows += '<tr>' +
    '<td style="text-align:center">' + idx + '</td>' +
    '<td>' + metaCol + '</td>' +
    '<td style="font-size:11px;word-break:break-all" title="' + _psisPlusEsc(rec.preset_name || '') + '">' + _psisPlusEsc(rec.preset_name) + '</td>' +
    '<td>' + detailHtml + '</td>' +
    '<td><button class="cfs-btn cfs-psisp-btn-restore-idx" data-idx="' + idx + '">↩ 还原</button></td>' +
    '</tr>';
  }
  // modal 内宽度足够，不再 fixed layout 压窄
  //   idx/时间/预设/还原 列定宽，接管详情列 auto 拿剩余空间
  return '<div class="cfs-psisp-summary">操作记录 ' + arr.length + ' 条（FIFO，上限 ' + PSIS_PLUS_HISTORY_LIMIT + '）</div>' +
   '<div class="cfs-sem-table-wrap"><table class="cfs-sem-table" style="width:100%"><colgroup>' +
   '<col style="width:40px"><col style="width:110px"><col style="width:180px"><col><col style="width:80px">' +
   '</colgroup><thead><tr>' +
   '<th>idx</th><th>时间 / 触发</th><th>预设</th><th>接管详情</th><th></th>' +
   '</tr></thead><tbody>' + rows + '</tbody></table></div>';
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
    var r = await _psisPlusRepair(plan, { source: 'manual', violations: scan.violations });
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

  // 2026-06-22 v6.2.0 · 操作记录改 modal 弹层（脱离窄胶囊侧栏，宽 min(960px,95vw)）
  function _closeHistModal() {
   var bg = D.getElementById('cfs-psisp-hist-modal-bg');
   if (bg && bg.parentNode) bg.parentNode.removeChild(bg);
  }
  function _renderHistModal() {
   var arr = _psisPlusHistoryRead();
   _closeHistModal();
   var wrapper = D.createElement('div');
   wrapper.innerHTML = _psisPlusRenderHistoryModal(arr);
   var panel = getPanel ? getPanel() : null;
   (panel || D.body).appendChild(wrapper.firstElementChild);

   var bg = D.getElementById('cfs-psisp-hist-modal-bg');
   var bClose = D.getElementById('cfs-psisp-hist-modal-close');
   if (bClose) bClose.onclick = _closeHistModal;
   if (bg) bg.onclick = function (e) { if (e.target === bg) _closeHistModal(); };

   var idxBtns = D.querySelectorAll('.cfs-psisp-btn-restore-idx');
   for (var i = 0; i < idxBtns.length; i++) {
    (function (btn) {
     btn.onclick = async function () {
      var idx = Number(btn.getAttribute('data-idx'));
      if (!confirm('还原到 idx=' + idx + ' 的快照？')) return;
      btn.disabled = true;
      btn.textContent = '还原中…';
      var r = await _psisPlusRestore(idx);
      var NC = _GLOBAL.CFS4 && _GLOBAL.CFS4.NotificationCenter;
      if (r.ok) {
       if (NC) NC.notify('psis_plus_restored', { timestamp: new Date(r.timestamp).toLocaleString(), preset: r.presetName });
      } else {
       if (NC) NC.notify('psis_plus_failed', { detail: r.reason });
      }
      _renderHistModal(); // 刷新表格反映 restore 结果
     };
    })(idxBtns[i]);
   }
  }
  async function _doHistory() {
   _renderHistModal();
  }

  if (btnScan) btnScan.onclick = _doScan;
  if (btnHist) btnHist.onclick = _doHistory;
 }

 // === 暴露 API ===
 _GLOBAL.CFS4.PSISPlus = {
  _version: '6.2.0',
  REGISTRY: PSIS_BLOCK_REGISTRY,
  scan: _psisPlusScan,
  repair: function (planOverride) { return _psisPlusRepair(planOverride); },
  restore: function (idx) { return _psisPlusRestore(idx); },
  history: _psisPlusHistoryRead,
  registry: function () { return PSIS_BLOCK_REGISTRY; },
  renderSection: _psisPlusRenderSection,
  bindEvents: _psisPlusBindEvents,
  passiveScan: _psisPlusPassiveScan,
  autoRepair: _psisPlusAutoRepair, // 2026-06-22 v6.2.0 auto 入口（F12 调试可手动调）
  judgeUnknown: _psisPlusJudgeUnknown, // 暴露启发式判定供调试
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
    // 2026-06-22 v6.2.0 切预设后走 auto-repair（含启发式 auto_unknown）
    setTimeout(function () { _psisPlusAutoRepair({ source: 'oai_preset_changed_after' }); }, 1000);
   });
   // 2026-06-22 v6.2.0 · chat_id_changed 兜底触发 PSIS+ AutoRepair
   //   原因：savePreset → updateList → trigger('change') → applyChatCompletionPreset → 再次 emit
   //   oai_preset_changed_after 形成事件链路依赖。某些操作（如 PSIS+ Restore / 第三方扩展
   //   绕过 PresetManager 直接改 oai_settings.prompt_order）不会触发 oai_preset_changed_after，
   //   导致 AUTO 不跑、操作记录缺漏。加 chat_id_changed 作为"跨卡通杀"信道，切卡必跑。
   //   debounce 2s（晚于 PETL 1.5s，避免与 PETL 抢同帧）
   var _psisPlusChatChangeTimer = null;
   eventOn('chat_id_changed', function () {
    if (_psisPlusChatChangeTimer) clearTimeout(_psisPlusChatChangeTimer);
    _psisPlusChatChangeTimer = setTimeout(function () {
     _psisPlusAutoRepair({ source: 'chat_id_changed' });
    }, 2000);
   });
  }
  if (typeof eventOnce === 'function') {
   eventOnce('app_ready', function () {
    setTimeout(_psisPlusPassiveScan, 500); // hydrate 后 auto-repair（PassiveScan 内部已切到 autoRepair）
   });
  } else {
   setTimeout(_psisPlusPassiveScan, 2000);
  }
 } catch (e) {}

 console.log('[CFS v6.2.0 PSIS Plus] 已挂载，window.CFS4.PSISPlus 可用 (auto-repair + 启发式 unknown 接管)');
})();


export const PSISPlus = window.CFS4?.PSISPlus;
console.log('[CFS-Suite/psis-plus] PSIS+ ESM bridge OK, has PSISPlus object =', !!window.CFS4?.PSISPlus);
