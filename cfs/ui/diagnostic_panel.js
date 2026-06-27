/**
 * CFS-Suite · ui/diagnostic_panel.js
 *
 * 诊断面板 MVP（2026-06-26 v6.6.0 P0-g）：把分散在 RSI / PSIS+ / Coordinator / FallbackStrategy
 * 的运行时数据汇聚到一个 section，给用户一眼看清"为什么命中率是这样"。
 *
 * 5 个子区：
 *   1. 前缀稳定率条（基于 RSI.analyze().prefixStability，是 cache 命中率近似）
 *   2. Audit 看板（Coordinator.getAuditState 计数 + 距上次时间）
 *   3. 接管状态（FallbackStrategy.getCurrentMode + InjectionStrategy.getLastInjection）
 *   4. PSIS+ 最近扫描（PSISPlus.scanLatest，事件钩缓存的结果）
 *   5. 前缀漂移明细（懒加载，复用 RSI.genDriftPanel HTML）
 *
 * 加上"🔄 刷新" + "📋 复制诊断报告"两个按钮，让用户能把诊断快照贴到社区求助。
 *
 * 设计原则（v6.6.0 task 9）：
 *   - 不主动跑任何 audit / scan / 写盘，全部读已有缓存。
 *   - 不引入新依赖，全部 API 已在其他模块暴露。
 *   - 真机若数据不足（RSI 还没攒到 2 轮），显示提示而不是空白。
 */

(function () {
 var _GLOBAL = (typeof window !== 'undefined') ? window
  : (typeof self !== 'undefined') ? self : globalThis;
 if (!_GLOBAL.CFS4) _GLOBAL.CFS4 = {};

 var TAG = '[CFS-DiagnosticPanel]';

 // v6.9.0 Task 32：历史采样（最近 30 点）+ sparkline 可视化
 var HIST_MAX = 30;
 var _hitRateHist = [];    // 前缀稳定率历史 [{ts, pct}]
 var _auditCountHist = []; // audit 累计运行次数历史 [{ts, count}]
 var _sampleTimer = null;

 function _esc(s) {
  if (s == null) return '';
  return String(s)
   .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
 }

 // 采样：每 8s 一次（不引入 CPU 压力）
 function _sampleOnce() {
  try {
   var C = _GLOBAL.CFS4 || {};
   var rsi = C.RSI;
   var coord = C.Coordinator;
   var now = Date.now();
   if (rsi && rsi.analyze) {
    try {
     var a = rsi.analyze();
     if (a && a.status === 'ok') {
      var pct = Math.round((a.prefixStability || 0) * 100);
      _hitRateHist.push({ ts: now, pct: pct });
      if (_hitRateHist.length > HIST_MAX) _hitRateHist.shift();
     }
    } catch (e) {}
   }
   if (coord && coord.getAuditState) {
    try {
     var s = coord.getAuditState();
     if (s) {
      _auditCountHist.push({ ts: now, count: s.run_count || 0 });
      if (_auditCountHist.length > HIST_MAX) _auditCountHist.shift();
     }
    } catch (e) {}
   }
  } catch (e) {}
 }

 function _startSampling() {
  if (_sampleTimer) return;
  _sampleOnce();
  _sampleTimer = setInterval(_sampleOnce, 8000);
 }

 // SVG sparkline 渲染（轻量，不引依赖）
 function _renderSparkline(data, opts) {
  opts = opts || {};
  var w = opts.width || 200;
  var h = opts.height || 28;
  var color = opts.color || '#8acaff';
  var fill = opts.fill || 'rgba(138,202,255,0.12)';
  if (!data || data.length === 0) {
   return '<svg width="' + w + '" height="' + h + '" style="display:block"><text x="4" y="' + (h/2+3) + '" font-size="10" fill="#666">尚无样本</text></svg>';
  }
  var min = opts.min, max = opts.max;
  if (min === undefined || max === undefined) {
   min = Infinity; max = -Infinity;
   for (var i = 0; i < data.length; i++) {
    var v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
   }
  }
  if (max === min) max = min + 1;
  var pts = [];
  var stepX = data.length > 1 ? w / (data.length - 1) : w;
  for (var k = 0; k < data.length; k++) {
   var x = k * stepX;
   var y = h - 2 - ((data[k] - min) / (max - min)) * (h - 4);
   pts.push(x.toFixed(1) + ',' + y.toFixed(1));
  }
  var line = '<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>';
  var area = '<polyline points="0,' + h + ' ' + pts.join(' ') + ' ' + w + ',' + h + '" fill="' + fill + '" stroke="none"/>';
  // 最后一个点高亮
  var lastPt = pts[pts.length - 1].split(',');
  var dot = '<circle cx="' + lastPt[0] + '" cy="' + lastPt[1] + '" r="2.5" fill="' + color + '"/>';
  return '<svg width="' + w + '" height="' + h + '" style="display:block">' + area + line + dot + '</svg>';
 }

 // 2026-06-27 v6.5 恢复 plan Task 1.3：prefix 区动态宏命中扫描
 // 扫 chatHistory 之前所有 enabled 块，标红/橙/绿；用户/作者一眼看自己预设 prefix 是否脆
 var _MACRO_TESTS = [
  // 红 — 真动态（每轮必变）
  { re: /\{\{random\b/i,              name: 'random',         sev: 'red' },
  { re: /\{\{roll\b/i,                name: 'roll',           sev: 'red' },
  { re: /\{\{(date|time|datetime)\}\}/i, name: 'date/time',   sev: 'red' },
  { re: /\{\{idle_duration\}\}/i,     name: 'idle_duration',  sev: 'red' },
  { re: /\{\{lastusermessage\}\}/i,   name: 'lastusermessage',sev: 'red' },
  { re: /\{\{lastUserMessage\}\}/,    name: 'lastUserMessage(驼峰)', sev: 'red' },
  { re: /\{\{lastmessage\}\}/i,       name: 'lastmessage',    sev: 'red' },
  { re: /\{\{lastcharmessage\}\}/i,   name: 'lastcharmessage',sev: 'red' },
  { re: /getvar\s*\(/i,               name: 'getvar() 函数式',sev: 'red' },
  { re: /<%[^%]*%>/,                  name: 'EJS <% %>',      sev: 'red' },
  // 橙 — 全局变量副作用（用户切模式按钮即漂）
  { re: /\{\{getglobalvar::/i,        name: 'getglobalvar::', sev: 'orange' },
  { re: /\{\{setglobalvar::/i,        name: 'setglobalvar::', sev: 'orange' },
  // 橙 — chat 局部变量（脚本写入即漂）
  { re: /\{\{getvar::/i,              name: 'getvar::',       sev: 'orange' },
  { re: /\{\{setvar::/i,              name: 'setvar::',       sev: 'orange' },
  // 黄 — persona 切换才漂（同会话内稳）
  { re: /\{\{user\}\}/,               name: 'user',           sev: 'yellow' },
  { re: /\{\{char\}\}/,               name: 'char',           sev: 'yellow' },
 ];

 function _getOaiSettings() {
  try {
   var ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext()
    : (_GLOBAL.SillyTavern && _GLOBAL.SillyTavern.getContext) ? _GLOBAL.SillyTavern.getContext() : null;
   if (!ctx) return null;
   return ctx.chatCompletionSettings || ctx.oai_settings || ctx.openai_settings || null;
  } catch (e) { return null; }
 }

 function _scanPrefixRisk() {
  var oai = _getOaiSettings();
  if (!oai || !Array.isArray(oai.prompts) || !Array.isArray(oai.prompt_order)) {
   return { ok: false, error: 'no_oai_settings' };
  }
  // 选当前 character 对应的 order，否则用第一个
  var charId = null;
  try {
   var ctx2 = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext() : null;
   if (ctx2) charId = ctx2.characterId || (ctx2.characters && ctx2.this_chid) || null;
  } catch (e) {}
  var po = null;
  for (var i = 0; i < oai.prompt_order.length; i++) {
   if (oai.prompt_order[i] && oai.prompt_order[i].character_id == charId) { po = oai.prompt_order[i]; break; }
  }
  if (!po) po = oai.prompt_order[0];
  if (!po || !Array.isArray(po.order)) return { ok: false, error: 'no_order' };
  var promptById = {};
  for (var j = 0; j < oai.prompts.length; j++) {
   if (oai.prompts[j]) promptById[oai.prompts[j].identifier] = oai.prompts[j];
  }
  var chIdx = -1;
  for (var k = 0; k < po.order.length; k++) {
   if (po.order[k] && po.order[k].identifier === 'chatHistory') { chIdx = k; break; }
  }
  if (chIdx < 0) return { ok: false, error: 'no_chatHistory' };
  var rows = [];
  var hardCount = 0, softCount = 0;
  for (var n = 0; n < chIdx; n++) {
   var ent = po.order[n];
   if (!ent) continue;
   var pr = promptById[ent.identifier] || {};
   var content = pr.content || '';
   var hits = [];
   var worst = 'green';
   for (var m = 0; m < _MACRO_TESTS.length; m++) {
    var t = _MACRO_TESTS[m];
    if (t.re.test(content)) {
     hits.push({ name: t.name, sev: t.sev });
     if (t.sev === 'red') worst = 'red';
     else if (t.sev === 'orange' && worst !== 'red') worst = 'orange';
     else if (t.sev === 'yellow' && worst === 'green') worst = 'yellow';
    }
   }
   if (worst === 'red') hardCount++;
   else if (worst === 'orange' || worst === 'yellow') softCount++;
   rows.push({
    idx: n,
    identifier: ent.identifier,
    name: pr.name || ent.identifier,
    role: pr.role || '?',
    enabled: ent.enabled !== false,
    len: content.length,
    hits: hits,
    worst: worst,
   });
  }
  return { ok: true, rows: rows, chatHistoryIdx: chIdx, hardCount: hardCount, softCount: softCount, presetName: oai.name || null };
 }

 function _snapshot() {
  var C = _GLOBAL.CFS4 || {};
  var rsi = C.RSI;
  var psisPlus = C.PSISPlus;
  var coord = C.Coordinator;
  var fs = C.FallbackStrategy;
  var is = C.InjectionStrategy;

  var snap = {
   roundsCount: (rsi && rsi.getRoundsCount) ? rsi.getRoundsCount() : 0,
   analyze: null,
   auditState: null,
   mode: null,
   lastInj: null,
   scanLatest: null,
   coordPhase: null,
   prefixRisk: null,
  };

  try { if (rsi && rsi.analyze) snap.analyze = rsi.analyze(); } catch (e) { snap.analyze = { status: 'error', error: e && e.message }; }
  try { if (coord && coord.getAuditState) snap.auditState = coord.getAuditState(); } catch (e) {}
  try { if (coord && coord.getState) snap.coordPhase = coord.getState().phase; } catch (e) {}
  try { if (fs && fs.getCurrentMode) snap.mode = fs.getCurrentMode(); } catch (e) {}
  try { if (is && is.getLastInjection) snap.lastInj = is.getLastInjection(); } catch (e) {}
  try { if (psisPlus && psisPlus.scanLatest) snap.scanLatest = psisPlus.scanLatest(); } catch (e) {}
  try { snap.prefixRisk = _scanPrefixRisk(); } catch (e) { snap.prefixRisk = { ok: false, error: e && e.message }; }

  return snap;
 }

 function _renderHitRateBar(snap) {
  var html = '<div class="cfs-diag-sub-title">① 前缀稳定率（cache 命中率近似）</div>';
  if (!snap.analyze) {
   return html + '<div class="cfs-diag-hint">请求结构分析器未挂载或未捕获请求</div>';
  }
  if (snap.analyze.status === 'insufficient') {
   return html + '<div class="cfs-diag-hint">再发 ' + snap.analyze.needed + ' 轮消息后开始判断（已看 ' + snap.analyze.roundsCount + ' 轮）</div>';
  }
  if (snap.analyze.status === 'error') {
   return html + '<div class="cfs-diag-hint" style="color:#e88">请求结构分析失败: ' + _esc(snap.analyze.error) + '</div>';
  }
  var pct = Math.round((snap.analyze.prefixStability || 0) * 100);
  var color = pct >= 80 ? '#7c7' : (pct >= 50 ? '#d97' : '#e88');
  html += '<div class="cfs-diag-row"><span class="k">稳定率</span>';
  html += '<span class="v" style="color:' + color + ';font-weight:bold">' + pct + '%</span></div>';
  html += '<div style="background:#222;height:6px;border-radius:3px;overflow:hidden;margin:4px 0 6px 0">';
  html += '<div style="width:' + pct + '%;background:' + color + ';height:100%;transition:width .3s"></div>';
  html += '</div>';
  html += '<div class="cfs-diag-detail">观察 ' + snap.analyze.roundsCount + ' 轮 · prefix 稳定段 idx 0~' + Math.max(0, snap.analyze.prefixStableEnd - 1) + ' (共 ' + snap.analyze.prefixStableEnd + ' 块) · prefix 总长 ' + snap.analyze.total + ' 块</div>';
  // v6.9.0 Task 32：历史 sparkline
  var hitValues = _hitRateHist.map(function (h) { return h.pct; });
  if (hitValues.length > 0) {
   html += '<div class="cfs-diag-spark-wrap"><div class="cfs-diag-spark-label">最近 ' + hitValues.length + ' 个采样点（每 8 秒一次）</div>'
    + _renderSparkline(hitValues, { width: 220, height: 32, color: '#7c7', fill: 'rgba(124,199,124,0.13)', min: 0, max: 100 })
    + '</div>';
  }
  return html;
 }

 function _renderAuditBoard(snap) {
  var html = '<div class="cfs-diag-sub-title">② 自动校验看板</div>';
  if (!snap.auditState) {
   return html + '<div class="cfs-diag-hint">Coordinator.getAuditState 不可用</div>';
  }
  var since = snap.auditState.last_run ? Math.round((Date.now() - snap.auditState.last_run) / 1000) : null;
  html += '<div class="cfs-diag-row"><span class="k">累计运行</span><span class="v">' + snap.auditState.run_count + ' 次</span></div>';
  html += '<div class="cfs-diag-row"><span class="k">距上次</span><span class="v">' + (since !== null ? since + ' 秒前' : '尚未运行') + '</span></div>';
  html += '<div class="cfs-diag-row"><span class="k">debounce</span><span class="v">' + snap.auditState.debounce_ms + 'ms</span></div>';
  // v6.9.0 Task 32：audit 计数 sparkline（看是否每轮在加）
  var auditValues = _auditCountHist.map(function (h) { return h.count; });
  if (auditValues.length >= 2) {
   // 显示增量：计算每两个采样点之间的差值，避免折线一直平
   var delta = [];
   for (var i = 1; i < auditValues.length; i++) delta.push(Math.max(0, auditValues[i] - auditValues[i-1]));
   html += '<div class="cfs-diag-spark-wrap"><div class="cfs-diag-spark-label">最近 ' + delta.length + ' 个 8 秒窗口的校验次数</div>'
    + _renderSparkline(delta, { width: 220, height: 26, color: '#8acaff', fill: 'rgba(138,202,255,0.13)', min: 0 })
    + '</div>';
  }
  return html;
 }

 function _renderTakeoverState(snap) {
  var html = '<div class="cfs-diag-sub-title">③ 接管状态</div>';
  var modeColor = snap.mode === 'v4_full' ? '#7c7'
   : (snap.mode === 'mvu_fallback' || snap.mode === 'v4_degraded') ? '#d97'
   : '#888';
  html += '<div class="cfs-diag-row"><span class="k">当前 mode</span>';
  html += '<span class="v" style="color:' + modeColor + ';font-weight:bold">' + _esc(snap.mode || '未知') + '</span></div>';
  if (snap.coordPhase) {
   html += '<div class="cfs-diag-row"><span class="k">Coordinator phase</span><span class="v">' + _esc(snap.coordPhase) + '</span></div>';
  }
  if (snap.lastInj) {
   var contentLen = (snap.lastInj.content || '').length;
   html += '<div class="cfs-diag-row"><span class="k">最近注入</span><span class="v">' + contentLen + ' 字符 / 第 ' + (snap.lastInj.round || 0) + ' 轮</span></div>';
  }
  return html;
 }

 function _renderPsisPlusState(snap) {
  var html = '<div class="cfs-diag-sub-title">④ 预设排序最近扫描</div>';
  if (!snap.scanLatest) {
   return html + '<div class="cfs-diag-hint">尚未触发扫描（切预设/切卡会自动 passive scan）</div>';
  }
  if (!snap.scanLatest.ok) {
   return html + '<div class="cfs-diag-hint" style="color:#e88">扫描失败: ' + _esc(snap.scanLatest.error || snap.scanLatest.reason || '?') + '</div>';
  }
  var vCount = (snap.scanLatest.violations || []).length;
  var sCount = (snap.scanLatest.skipped || []).length;
  var vColor = vCount > 0 ? '#d97' : '#7c7';
  html += '<div class="cfs-diag-row"><span class="k">预设</span><span class="v">' + _esc(snap.scanLatest.presetName || '?') + '</span></div>';
  html += '<div class="cfs-diag-row"><span class="k">违规</span><span class="v" style="color:' + vColor + '">' + vCount + ' 条</span></div>';
  html += '<div class="cfs-diag-row"><span class="k">跳过</span><span class="v">' + sCount + ' 条</span></div>';
  if (vCount > 0) {
   html += '<div class="cfs-diag-detail" style="margin-top:6px">前 5 条违规：</div>';
   html += '<ul style="margin:4px 0 0 16px;padding:0;font-size:11px;color:#aaa">';
   snap.scanLatest.violations.slice(0, 5).forEach(function (v) {
    html += '<li>' + _esc(v.promptName || v.identifier) + ' <small>(' + (v.contentLen || 0) + ' B, type=' + _esc(v.type) + ')</small></li>';
   });
   if (vCount > 5) html += '<li><i>...还有 ' + (vCount - 5) + ' 条（去「预设排序」tab 看完整列表）</i></li>';
   html += '</ul>';
   html += '<div class="cfs-diag-hint" style="margin-top:6px;color:#a8c">要应用重排：到「📝 预设排序」tab 点 "⚡ 重排修复"</div>';
  }
  return html;
 }

 // 2026-06-27 v6.5 Task 1.4：prefix 风险扫描渲染
 function _renderPrefixRiskScan(snap) {
  var html = '<div class="cfs-diag-sub-title">⑤ 当前预设 prefix 风险扫描（chatHistory 之前的块）</div>';
  var pr = snap.prefixRisk;
  if (!pr) return html + '<div class="cfs-diag-hint">扫描器未运行</div>';
  if (!pr.ok) return html + '<div class="cfs-diag-hint" style="color:#888">无法扫描: ' + _esc(pr.error || '?') + '</div>';
  if (!pr.rows.length) return html + '<div class="cfs-diag-hint">chatHistory 之前没有 enabled 的块</div>';
  var hardColor = pr.hardCount > 0 ? '#e88' : '#7c7';
  var softColor = pr.softCount > 0 ? '#d97' : '#888';
  html += '<div class="cfs-diag-row"><span class="k">硬动态块（每轮必变 → 必击穿）</span><span class="v" style="color:' + hardColor + ';font-weight:bold">' + pr.hardCount + '</span></div>';
  html += '<div class="cfs-diag-row"><span class="k">软风险块（用户操作可漂）</span><span class="v" style="color:' + softColor + '">' + pr.softCount + '</span></div>';
  html += '<div class="cfs-diag-row"><span class="k">prefix 总块数</span><span class="v">' + pr.rows.length + '</span></div>';
  html += '<table style="width:100%;font-size:10.5px;margin-top:6px;border-collapse:collapse">';
  html += '<thead><tr style="color:#888;text-align:left"><th style="padding:2px 4px">idx</th><th style="padding:2px 4px">名</th><th style="padding:2px 4px">role</th><th style="padding:2px 4px;text-align:right">len</th><th style="padding:2px 4px">命中宏</th></tr></thead><tbody>';
  for (var i = 0; i < pr.rows.length; i++) {
   var r = pr.rows[i];
   var dot = r.worst === 'red' ? '🔴' : (r.worst === 'orange' ? '🟠' : (r.worst === 'yellow' ? '🟡' : '🟢'));
   var chips = '';
   if (r.hits.length) {
    chips = r.hits.map(function (h) {
     var bg = h.sev === 'red' ? 'rgba(232,136,136,0.18)' : (h.sev === 'orange' ? 'rgba(217,151,119,0.18)' : 'rgba(220,200,80,0.13)');
     var col = h.sev === 'red' ? '#e88' : (h.sev === 'orange' ? '#d97' : '#cb6');
     return '<span style="display:inline-block;padding:0 5px;margin-right:3px;background:' + bg + ';color:' + col + ';border-radius:3px;font-size:9.5px">' + _esc(h.name) + '</span>';
    }).join('');
   } else {
    chips = '<span style="color:#7c7;font-size:9.5px">静态 ✓</span>';
   }
   html += '<tr style="border-top:1px solid rgba(255,255,255,0.04)">'
    + '<td style="padding:2px 4px;color:#888">' + dot + ' #' + r.idx + '</td>'
    + '<td style="padding:2px 4px;color:#ddd">' + _esc(r.name) + '</td>'
    + '<td style="padding:2px 4px;color:#888">' + _esc(r.role) + '</td>'
    + '<td style="padding:2px 4px;text-align:right;color:#888">' + r.len + '</td>'
    + '<td style="padding:2px 4px">' + chips + '</td>'
    + '</tr>';
  }
  html += '</tbody></table>';
  if (pr.hardCount > 0) {
   html += '<div class="cfs-diag-hint" style="margin-top:6px;color:#e88">⚠ 含红色块即"#0 就 miss"症状的根因；建议预设作者重排或字面化（如 getglobalvar 改字面 schema）</div>';
  } else if (pr.softCount > 0) {
   html += '<div class="cfs-diag-hint" style="margin-top:6px;color:#d97">⚠ 含橙色块 = 用户切"模式按钮"或脚本写变量会让 prefix 该块之后全 miss</div>';
  } else {
   html += '<div class="cfs-diag-hint" style="margin-top:6px;color:#7c7">✓ prefix 区全静态，cache 友好</div>';
  }
  return html;
 }

 function _renderBody(snap) {
  return _renderHitRateBar(snap)
   + '<hr class="cfs-diag-sep">'
   + _renderAuditBoard(snap)
   + '<hr class="cfs-diag-sep">'
   + _renderTakeoverState(snap)
   + '<hr class="cfs-diag-sep">'
   + _renderPsisPlusState(snap)
   + '<hr class="cfs-diag-sep">'
   + _renderPrefixRiskScan(snap);
 }

 function renderSection() {
  return '<details class="cfs-diag" id="cfs-diag-root" open>'
   + '<summary>🩺 诊断 — 命中率 + 校验 + 接管 + 预设排序 汇总</summary>'
   + '<style>'
   + '.cfs-diag .cfs-diag-sub-title{font-size:11px;color:#8acaff;font-weight:bold;margin:8px 0 4px 0}'
   + '.cfs-diag .cfs-diag-row{display:flex;justify-content:space-between;font-size:11px;padding:2px 0}'
   + '.cfs-diag .cfs-diag-row .k{color:#888}'
   + '.cfs-diag .cfs-diag-row .v{color:#e0e0e0}'
   + '.cfs-diag .cfs-diag-detail{font-size:10px;color:#888;margin:2px 0}'
   + '.cfs-diag .cfs-diag-hint{font-size:11px;color:#aaa;padding:4px 0}'
   + '.cfs-diag hr.cfs-diag-sep{border:none;border-top:1px dashed #333;margin:8px 0}'
   + '.cfs-diag .cfs-diag-actions{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}'
   + '.cfs-diag .cfs-diag-actions button{padding:4px 10px;font-size:11px;cursor:pointer;background:#222;color:#ddd;border:1px solid #444;border-radius:3px}'
   + '.cfs-diag .cfs-diag-actions button:hover{background:#333}'
   + '.cfs-diag #cfs-diag-drift-panel{margin-top:8px}'
   + '.cfs-diag .cfs-diag-spark-wrap{margin-top:6px;padding:6px 8px;background:rgba(255,255,255,0.02);border-radius:4px;border:1px solid rgba(255,255,255,0.05)}'
   + '.cfs-diag .cfs-diag-spark-label{font-size:9.5px;color:#777;margin-bottom:3px;letter-spacing:0.3px}'
   + '</style>'
   + '<div id="cfs-diag-body">' + _renderBody(_snapshot()) + '</div>'
   + '<div class="cfs-diag-actions">'
   + '<button id="cfs-diag-refresh" type="button">🔄 刷新</button>'
   + '<button id="cfs-diag-copy" type="button">📋 复制诊断报告</button>'
   + '<button id="cfs-diag-drift" type="button">🔍 前缀漂移明细（懒加载）</button>'
   + '</div>'
   + '<div id="cfs-diag-drift-panel"></div>'
   + '</details>';
 }

 function _genReport() {
  var snap = _snapshot();
  var lines = [];
  lines.push('=== CFS-Suite 诊断报告 ===');
  lines.push('时间: ' + new Date().toISOString());
  lines.push('CFS-Suite 版本: ' + ((_GLOBAL.CFS4 && _GLOBAL.CFS4.DiagnosticPanel && _GLOBAL.CFS4.DiagnosticPanel._version) || '?'));
  lines.push('');
  lines.push('--- ① 前缀稳定率 ---');
  if (snap.analyze) {
   if (snap.analyze.status === 'ok') {
    lines.push('稳定率: ' + Math.round((snap.analyze.prefixStability || 0) * 100) + '%');
    lines.push('观察轮数: ' + snap.analyze.roundsCount);
    lines.push('prefix 稳定段: 0 ~ ' + Math.max(0, snap.analyze.prefixStableEnd - 1) + ' (共 ' + snap.analyze.prefixStableEnd + ' 块)');
    lines.push('prefix 总长: ' + snap.analyze.total + ' 块');
   } else if (snap.analyze.status === 'insufficient') {
    lines.push('数据不足: 再发 ' + snap.analyze.needed + ' 轮');
   } else {
    lines.push('请求结构状态: ' + snap.analyze.status + ' ' + (snap.analyze.error || ''));
   }
  } else {
   lines.push('请求结构分析器未挂载');
  }
  lines.push('');
  lines.push('--- ② Audit ---');
  if (snap.auditState) {
   lines.push('累计运行: ' + snap.auditState.run_count + ' 次');
   lines.push('上次时间: ' + (snap.auditState.last_run ? new Date(snap.auditState.last_run).toISOString() : 'n/a'));
   lines.push('debounce: ' + snap.auditState.debounce_ms + 'ms');
  } else {
   lines.push('Coordinator.getAuditState 不可用');
  }
  lines.push('');
  lines.push('--- ③ 接管 ---');
  lines.push('mode: ' + (snap.mode || '未知'));
  if (snap.coordPhase) lines.push('Coordinator phase: ' + snap.coordPhase);
  if (snap.lastInj) {
   lines.push('最近注入: ' + ((snap.lastInj.content || '').length) + ' 字符 / 第 ' + (snap.lastInj.round || 0) + ' 轮');
  }
  lines.push('');
  lines.push('--- ④ 预设排序最近扫描 ---');
  if (snap.scanLatest) {
   if (snap.scanLatest.ok) {
    lines.push('预设: ' + (snap.scanLatest.presetName || '?'));
    lines.push('违规: ' + ((snap.scanLatest.violations || []).length) + ' 条');
    lines.push('跳过: ' + ((snap.scanLatest.skipped || []).length) + ' 条');
    if ((snap.scanLatest.violations || []).length > 0) {
     lines.push('违规列表（前 10 条）:');
     snap.scanLatest.violations.slice(0, 10).forEach(function (v) {
      lines.push('  - ' + (v.promptName || v.identifier) + ' (' + (v.contentLen || 0) + ' B, type=' + v.type + ')');
     });
    }
   } else {
    lines.push('扫描失败: ' + (snap.scanLatest.error || snap.scanLatest.reason || '?'));
   }
  } else {
   lines.push('尚未触发扫描');
  }
  lines.push('');
  lines.push('--- ⑤ Prefix 风险扫描（chatHistory 之前 enabled 块） ---');
  if (snap.prefixRisk && snap.prefixRisk.ok) {
   lines.push('硬动态块: ' + snap.prefixRisk.hardCount + ' / 软风险: ' + snap.prefixRisk.softCount + ' / 总: ' + snap.prefixRisk.rows.length);
   snap.prefixRisk.rows.forEach(function (r) {
    var tag = r.worst === 'red' ? '🔴' : r.worst === 'orange' ? '🟠' : r.worst === 'yellow' ? '🟡' : '🟢';
    var macros = r.hits.length ? r.hits.map(function(h){return h.name;}).join(',') : '静态';
    lines.push('  ' + tag + ' #' + r.idx + ' ' + (r.name || r.identifier) + ' [' + r.role + ', ' + r.len + 'B] - ' + macros);
   });
  } else {
   lines.push('Prefix 扫描失败: ' + ((snap.prefixRisk && snap.prefixRisk.error) || '?'));
  }
  lines.push('');
  lines.push('=== 报告结束 ===');
  return lines.join('\n');
 }

 function bindEvents(doc, getPanel) {
  doc = doc || document;
  function $(sel) { return doc.querySelector(sel); }

  var refreshBtn = $('#cfs-diag-refresh');
  if (refreshBtn) refreshBtn.onclick = function () {
   var body = $('#cfs-diag-body');
   if (body) body.innerHTML = _renderBody(_snapshot());
  };

  var copyBtn = $('#cfs-diag-copy');
  if (copyBtn) copyBtn.onclick = function () {
   var text = _genReport();
   var resetLabel = function () { copyBtn.textContent = '📋 复制诊断报告'; };
   function fallback() {
    var ta = doc.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    doc.body.appendChild(ta);
    ta.select();
    try {
     doc.execCommand('copy');
     copyBtn.textContent = '✓ 已复制';
     setTimeout(resetLabel, 2000);
    } catch (e) {
     copyBtn.textContent = '复制失败，控制台已 dump';
     console.log('=== CFS 诊断报告 ===\n' + text);
     setTimeout(resetLabel, 2500);
    } finally {
     try { doc.body.removeChild(ta); } catch (e) {}
    }
   }
   if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () {
     copyBtn.textContent = '✓ 已复制';
     setTimeout(resetLabel, 2000);
    }).catch(fallback);
   } else {
    fallback();
   }
  };

  var driftBtn = $('#cfs-diag-drift');
  if (driftBtn) driftBtn.onclick = async function () {
   var el = $('#cfs-diag-drift-panel');
   if (!el) return;
   if (el.innerHTML.trim().length > 0) {
    // 二次点击折叠
    el.innerHTML = '';
    driftBtn.textContent = '🔍 前缀漂移明细（懒加载）';
    return;
   }
   driftBtn.textContent = '⏳ 加载中...';
   el.innerHTML = '<div class="cfs-diag-hint">扫描中...</div>';
   try {
    var rsi = _GLOBAL.CFS4 && _GLOBAL.CFS4.RSI;
    if (rsi && rsi.genDriftPanel) {
     var html = await rsi.genDriftPanel({});
     el.innerHTML = html;
     driftBtn.textContent = '🔼 收起漂移明细';
    } else {
     el.innerHTML = '<div class="cfs-diag-hint" style="color:#e88">前缀漂移面板未挂载</div>';
     driftBtn.textContent = '🔍 前缀漂移明细（懒加载）';
    }
   } catch (e) {
    el.innerHTML = '<div class="cfs-diag-hint" style="color:#e88">加载失败: ' + _esc(e && e.message) + '</div>';
    driftBtn.textContent = '🔍 前缀漂移明细（懒加载）';
   }
  };
 }

 _GLOBAL.CFS4.DiagnosticPanel = {
  _version: '6.9.0',
  snapshot: _snapshot,
  renderSection: renderSection,
  bindEvents: bindEvents,
  genReport: _genReport,
  // v6.9.0 Task 32：历史样本查询
  getHitRateHistory: function () { return _hitRateHist.slice(); },
  getAuditCountHistory: function () { return _auditCountHist.slice(); },
 };

 // v6.9.0 Task 32：启动采样定时器（8 秒一次）
 setTimeout(_startSampling, 3000); // 等 3 秒让 RSI/Coordinator 先就绪

 console.log(TAG + ' 已挂载，window.CFS4.DiagnosticPanel 可用');
})();

export const DiagnosticPanel = (typeof window !== 'undefined') ? (window.CFS4 && window.CFS4.DiagnosticPanel) : null;
console.log('[CFS-Suite/diagnostic-panel] ESM bridge OK, has DiagnosticPanel =', !!DiagnosticPanel);
