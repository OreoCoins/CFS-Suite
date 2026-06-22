// PETL smoke test — Node 直跑
// 用法: node test/petl_smoke.mjs
//
// 验证 cfs/core/petl.js 核心行为：
//   1. _internals.matchAny / hasDynamicMarker / isAlreadyAtChatEnd 纯函数正确性
//   2. scanAndTakeover 完整流程：扫描 → 过滤 [cfs:ignore] / [CFS4_*] / disabled / 已 at_depth → 改 position
//   3. LS toggle 关闭时跳过
//   4. rollbackLast 把 entry 改回 oldPosition

// === Mock 全局 ===
const _setLorebookCalls = [];
const _mockEntries = {};

globalThis.window = {};
globalThis.window.parent = undefined;
globalThis.window.CFS4 = {
    PSISPatterns: {
        DYNAMIC: [
            /\{\{\s*[a-zA-Z_][\w-]*\s*::/,
            /\{\{(random|roll|pick|date|time|input|lastusermessage|lastmessage)\s*\}\}/i,
            /<%[\s\S]*?%>/,
        ],
        MVU: [
            /\bmvu(_update)?\b|\[mvu\]/i,
            /\[?initvar\]?/i,
            /JSONPatch/i,
            /<\/?(thinking|analysis)\b/i,
        ],
        EXEMPT_ONESHOT: [],
        REVIEW_PROTOCOL: [],
    },
};

globalThis.localStorage = {
    _kv: {},
    getItem(k) { return this._kv[k] ?? null; },
    setItem(k, v) { this._kv[k] = String(v); },
    removeItem(k) { delete this._kv[k]; },
};

globalThis.document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
    createElement: () => ({
        appendChild: () => {},
        addEventListener: () => {},
        classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => false },
        querySelector: () => null,
        querySelectorAll: () => [],
        style: {},
    }),
};

globalThis.eventOn = () => ({ stop: () => {} });
globalThis.eventOnce = () => ({ stop: () => {} });
globalThis.eventEmit = () => {};
globalThis.eventRemoveListener = () => {};

// 让 setTimeout 立即同步跑（_scheduleBootstrap 立即触发，便于断言）—— 但 PETL.runNow 用的 await/Promise 不受影响
const _origSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn) => { try { fn(); } catch (e) {} return 0; };
globalThis.clearTimeout = () => {};

globalThis.TavernHelper = {
    getCharLorebooks: async () => ({ primary: 'test_wb', additional: [] }),
    getLorebookEntries: async (lb) => _mockEntries[lb] || [],
    setLorebookEntries: async (lb, patches) => {
        _setLorebookCalls.push({ lb, patches });
        // 更新 mock 数据反映写入
        const entries = _mockEntries[lb] || [];
        for (const p of patches) {
            const e = entries.find(x => x.uid === p.uid);
            if (e) {
                if (p.position != null) e.position = p.position;
                if (p.depth != null) e.depth = p.depth;
            }
        }
    },
};

globalThis.toastr = { success: () => {}, info: () => {}, warning: () => {}, error: () => {} };

// === 准备测试数据 ===
_mockEntries['test_wb'] = [
    // ① 命中 DYNAMIC 宏 + position=before_char → 应改
    { uid: 1, comment: 'dyn entry', content: '{{getvar::status}}', enabled: true, position: 'before_character_definition', depth: 0 },
    // ② 命中 EJS → 应改
    { uid: 2, comment: 'ejs entry', content: '<% if (var) %> ok <% endif %>', enabled: true, position: 'after_character_definition', depth: 0 },
    // ③ 命中 MVU → 应改
    { uid: 3, comment: 'mvu init', content: 'initvar 初始化', enabled: true, position: 'before_character_definition', depth: 0 },
    // ④ 已 at_depth_as_user/depth=0 → 跳过
    { uid: 4, comment: 'already at end', content: '{{random:a,b}}', enabled: true, position: 'at_depth_as_user', depth: 0 },
    // ⑤ [cfs:ignore] → 跳过
    { uid: 5, comment: 'dyn entry [cfs:ignore]', content: '{{getvar::x}}', enabled: true, position: 'before_character_definition', depth: 0 },
    // ⑥ [CFS4_* 前缀 → 跳过（kernel.js audit 自管）
    { uid: 6, comment: '[CFS4_SCHEMA|test]', content: 'mvu_update field', enabled: true, position: 'before_character_definition', depth: 0 },
    // ⑦ disabled → 跳过
    { uid: 7, comment: 'disabled dyn', content: '{{getvar::y}}', enabled: false, position: 'before_character_definition', depth: 0 },
    // ⑧ 无动态宏 → 跳过
    { uid: 8, comment: 'plain text', content: '这是一段纯文本，没有任何动态宏。', enabled: true, position: 'before_character_definition', depth: 0 },
];

const { PETL } = await import('../cfs/core/petl.js');

// 2026-06-22 v6.3.0 · v49 严格模式默认开，但旧用例按 v5/v6.x 行为期望
// → 这里显式关闭 v49 模式跑老路径回归。v49 模式的新用例在文件末尾独立段
PETL.setV49Strict(false);

let pass = 0, fail = 0;
function assert(name, cond, detail) {
    if (cond) { console.log(`  ✅ ${name}`); pass++; }
    else { console.log(`  ❌ ${name} — ${detail || ''}`); fail++; }
}

console.log('\n[Test 1] _internals.matchAny');
const I = PETL._internals;
assert('hit DYNAMIC {{getvar::}}', I.matchAny('{{getvar::status}}', window.CFS4.PSISPatterns.DYNAMIC));
assert('hit DYNAMIC <% EJS %>', I.matchAny('<% if (x) %>', window.CFS4.PSISPatterns.DYNAMIC));
assert('hit DYNAMIC {{random}}', I.matchAny('{{random}}', window.CFS4.PSISPatterns.DYNAMIC));
assert('miss DYNAMIC plain text', !I.matchAny('plain text', window.CFS4.PSISPatterns.DYNAMIC));
assert('miss DYNAMIC {{user}} (静态宏不算)', !I.matchAny('{{user}}', window.CFS4.PSISPatterns.DYNAMIC));
assert('hit MVU initvar', I.matchAny('initvar 初始化', window.CFS4.PSISPatterns.MVU));
assert('hit MVU mvu_update', I.matchAny('mvu_update field', window.CFS4.PSISPatterns.MVU));

console.log('\n[Test 2] _internals.hasDynamicMarker');
assert('dyn content命中', I.hasDynamicMarker('{{getvar::a}}'));
assert('ejs content命中', I.hasDynamicMarker('<% if %>'));
assert('mvu content命中', I.hasDynamicMarker('initvar test'));
assert('plain content 不命中', !I.hasDynamicMarker('plain plain plain'));

console.log('\n[Test 3] _internals.isAlreadyAtChatEnd');
assert('字符串 at_depth_as_user + depth=0 → true', I.isAlreadyAtChatEnd({ position: 'at_depth_as_user', depth: 0 }));
assert('数字 position=4 + depth=0 → true', I.isAlreadyAtChatEnd({ position: 4, depth: 0 }));
assert('at_depth_as_user + depth=null → true (容忍)', I.isAlreadyAtChatEnd({ position: 'at_depth_as_user', depth: null }));
assert('before_char → false', !I.isAlreadyAtChatEnd({ position: 'before_character_definition', depth: 0 }));
assert('at_depth_as_user + depth=3 → false', !I.isAlreadyAtChatEnd({ position: 'at_depth_as_user', depth: 3 }));

console.log('\n[Test 4] scanAndTakeover 完整流程');
// 重置 mock entries（bootstrap 在 import 时已跑过，需还原初始状态再测一次完整流程）
_mockEntries['test_wb'] = [
    { uid: 1, comment: 'dyn entry', content: '{{getvar::status}}', enabled: true, position: 'before_character_definition', depth: 0 },
    { uid: 2, comment: 'ejs entry', content: '<% if (var) %> ok <% endif %>', enabled: true, position: 'after_character_definition', depth: 0 },
    { uid: 3, comment: 'mvu init', content: 'initvar 初始化', enabled: true, position: 'before_character_definition', depth: 0 },
    { uid: 4, comment: 'already at end', content: '{{random:a,b}}', enabled: true, position: 'at_depth_as_user', depth: 0 },
    { uid: 5, comment: 'dyn entry [cfs:ignore]', content: '{{getvar::x}}', enabled: true, position: 'before_character_definition', depth: 0 },
    { uid: 6, comment: '[CFS4_SCHEMA|test]', content: 'mvu_update field', enabled: true, position: 'before_character_definition', depth: 0 },
    { uid: 7, comment: 'disabled dyn', content: '{{getvar::y}}', enabled: false, position: 'before_character_definition', depth: 0 },
    { uid: 8, comment: 'plain text', content: '这是一段纯文本，没有任何动态宏。', enabled: true, position: 'before_character_definition', depth: 0 },
];
PETL.clearHistory();  // 清 bootstrap 留下的历史
_setLorebookCalls.length = 0;
PETL.setEnabled(true);
const result = await PETL.runNow();
console.log('  result:', JSON.stringify(result));
assert('应用 3 条 (uid 1/2/3)', result.applied === 3, `actual applied=${result.applied}`);
assert('候选 = 3', result.candidates === 3, `actual candidates=${result.candidates}`);
assert('跳过 position_ok = 1 (uid 4)', result.skipped.position_ok === 1, `actual position_ok=${result.skipped.position_ok}`);
assert('跳过 ignore = 1 (uid 5)', result.skipped.ignore === 1, `actual ignore=${result.skipped.ignore}`);
assert('跳过 cfs4 = 1 (uid 6)', result.skipped.cfs4 === 1, `actual cfs4=${result.skipped.cfs4}`);
assert('跳过 disabled = 1 (uid 7)', result.skipped.disabled === 1, `actual disabled=${result.skipped.disabled}`);
assert('跳过 no_marker = 1 (uid 8)', result.skipped.no_marker === 1, `actual no_marker=${result.skipped.no_marker}`);
assert('setLorebookEntries 被调 1 次（同一 book 一次批量）', _setLorebookCalls.length >= 1, `actual ${_setLorebookCalls.length}`);
const writtenUids = _setLorebookCalls[0]?.patches.map(p => p.uid).sort();
assert('写入 uid 集合 = [1,2,3]', JSON.stringify(writtenUids) === '[1,2,3]', `actual ${JSON.stringify(writtenUids)}`);
assert('每条都改成 at_depth_as_user', _setLorebookCalls[0]?.patches.every(p => p.position === 'at_depth_as_user'));
assert('每条 depth=0', _setLorebookCalls[0]?.patches.every(p => p.depth === 0));

console.log('\n[Test 5] LS toggle 关闭');
PETL.setEnabled(false);
const r2 = await PETL.runNow();
assert('skipped === true', r2.skipped === true);
assert('reason === disabled', r2.reason === 'disabled');
PETL.setEnabled(true);

console.log('\n[Test 6] 二次跑应无候选（uid 1/2/3 已被改到 at_depth_as_user）');
_setLorebookCalls.length = 0;
const r3 = await PETL.runNow();
assert('应用 0 条', r3.applied === 0);
assert('候选 0', r3.candidates === 0);
assert('uid 1/2/3 进入 position_ok skip', r3.skipped.position_ok >= 3, `actual ${r3.skipped.position_ok}`);

console.log('\n[Test 7] rollbackLast 把 entry 改回原 position');
_setLorebookCalls.length = 0;
const rRollback = await PETL.rollbackLast();
console.log('  rollback:', JSON.stringify(rRollback));
assert('回滚 3 条', rRollback.reverted === 3, `actual ${rRollback.reverted}`);
const rollbackPatches = _setLorebookCalls[0]?.patches || [];
const uid1Patch = rollbackPatches.find(p => p.uid === 1);
const uid2Patch = rollbackPatches.find(p => p.uid === 2);
assert('uid 1 回滚到 before_character_definition', uid1Patch?.position === 'before_character_definition');
assert('uid 2 回滚到 after_character_definition', uid2Patch?.position === 'after_character_definition');

console.log('\n[Test 8] history 已清空（rollback 后）');
const hist = PETL.getHistory();
assert('history.length === 0', hist.length === 0, `actual ${hist.length}`);

// === 2026-06-22 v6.3.0 v4.9 严格模式专用测试段 ===
console.log('\n[Test 9] V49_DYNAMIC_PATTERNS 真破坏者识别');
const I9 = PETL._internals;
assert('v49 命中 {{lastusermessage}}', I9.entryIsV49TrueDynamic({ content: '{{lastusermessage}}' }));
assert('v49 命中 {{random}}', I9.entryIsV49TrueDynamic({ content: '{{random}}' }));
assert('v49 命中 {{date}}', I9.entryIsV49TrueDynamic({ content: '{{date}}' }));
assert('v49 命中 {{format_message_variable::}}', I9.entryIsV49TrueDynamic({ content: '{{format_message_variable::stat_data}}' }));
assert('v49 不算 {{getvar::}} (静态宏)', !I9.entryIsV49TrueDynamic({ content: '{{getvar::x}}' }));
assert('v49 不算 EJS <% %>', !I9.entryIsV49TrueDynamic({ content: '<% if (x) %>' }));
assert('v49 不算 mvu_update 标签', !I9.entryIsV49TrueDynamic({ content: 'mvu_update field xxx' }));
assert('v49 不算 JSONPatch 文本', !I9.entryIsV49TrueDynamic({ content: 'apply JSONPatch ops' }));
assert('v49 不算 plain text', !I9.entryIsV49TrueDynamic({ content: '这是一段纯文本' }));

console.log('\n[Test 10] v49 严格模式：非真动态 → 迁回 prefix');
// 准备：清空 history + 重置 _mockEntries（uid=8 plain text 在 at_depth_as_user 应被迁回 prefix）
_mockEntries['test_wb'] = [
    { uid: 1, comment: '含真动态', content: '{{lastusermessage}}', enabled: true, position: 'before_character_definition', depth: 0, role: 0 },
    { uid: 2, comment: 'plain', content: '这是纯文本规则。', enabled: true, position: 'at_depth_as_user', depth: 0, role: 1 },
    { uid: 3, comment: 'ejs', content: '<% if (x) %> ok', enabled: true, position: 'at_depth_as_user', depth: 0, role: 1 },
    { uid: 4, comment: 'getvar', content: '{{getvar::a}}', enabled: true, position: 'at_depth_as_user', depth: 0, role: 1 },
    { uid: 5, comment: '[cfs:ignore]', content: '{{lastusermessage}}', enabled: true, position: 'at_depth_as_user', depth: 0, role: 1 },
];
PETL.clearHistory();
_setLorebookCalls.length = 0;
PETL.setV49Strict(true);
const r10 = await PETL.runNow();
console.log('  v49 result:', JSON.stringify({applied:r10.applied, v49ToPrefix:r10.v49ToPrefix, v49ToChatEnd:r10.v49ToChatEnd, skipped:r10.skipped}));
assert('v49 接管总数 = 4 (uid 1 真动态→chatEnd; 2/3/4 非真动态→prefix)', r10.applied === 4, `actual ${r10.applied}`);
assert('v49 v49ToPrefix = 3 (uid 2/3/4)', r10.v49ToPrefix === 3, `actual ${r10.v49ToPrefix}`);
assert('v49 v49ToChatEnd = 1 (uid 1)', r10.v49ToChatEnd === 1, `actual ${r10.v49ToChatEnd}`);
assert('v49 ignore = 1 (uid 5)', r10.skipped.ignore === 1, `actual ${r10.skipped.ignore}`);
const v49Patches = _setLorebookCalls[0]?.patches || [];
const uid2 = v49Patches.find(p => p.uid === 2);
const uid1Dyn = v49Patches.find(p => p.uid === 1);
assert('v49 uid 2 → position=before_character_definition', uid2?.position === 'before_character_definition');
assert('v49 uid 2 → constant=true', uid2?.constant === true);
assert('v49 uid 2 → role=0 (system, v4.9 LOG 教训)', uid2?.role === 0);
assert('v49 uid 2 → selective=false (v6.3.0 显式语义)', uid2?.selective === false);
assert('v49 uid 1 (真动态) → at_depth_as_user', uid1Dyn?.position === 'at_depth_as_user');
assert('v49 uid 1 → depth=0', uid1Dyn?.depth === 0);

console.log('\n[Test 11] v49 模式回滚保留 oldConstant/oldRole');
const rb = await PETL.rollbackLast();
const rbPatches = _setLorebookCalls[1]?.patches || [];
const rb2 = rbPatches.find(p => p.uid === 2);
assert('v49 rollback 恢复 uid 2 position', rb2?.position === 'at_depth_as_user');
assert('v49 rollback 恢复 uid 2 constant 为 false', rb2?.constant === false);
assert('v49 rollback 恢复 uid 2 role=1 (user)', rb2?.role === 1);

console.log(`\n=== 总计: ${pass} pass / ${fail} fail ===`);
process.exit(fail > 0 ? 1 : 0);
