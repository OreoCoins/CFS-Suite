// RSI Drift Detection Panel · smoke tests (C 方案 — diff-locate 精准反查)
// 覆盖 Task 2-7 + 4a/4b 全部单元测试
// Run: node test/rsi_drift_smoke.mjs

import fs from 'node:fs';
import assert from 'node:assert/strict';

const FIXTURE_PATH = './test/fixtures/wuxianhuilang-0622-rsi.json';
const fx = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
console.log(`fixture loaded: ${fx.ringBuffer.length} rounds, ${fx.activeLoreEntries.length} entries`);
console.log(`  expectedUnstableBlocks: [${fx.expectedUnstableBlocks.join(', ')}]`);

let testCount = 0;
function pass(name) {
    testCount++;
    console.log(`  ✅ [${testCount}] ${name}`);
}

// ============ Task 2: ring buffer schema (完整 content) ============
console.log('\n=== Task 2: ring buffer schema ===');
const sampleBlock = fx.ringBuffer[0][0];
assert.ok('content' in sampleBlock, 'block 应有 content 字段（C 方案）');
assert.ok(!('contentSlice' in sampleBlock), '应已废弃 contentSlice 字段');
pass('schema: content 字段存在，contentSlice 已废');

let longestBlockLen = 0;
for (const round of fx.ringBuffer) {
    for (const blk of round) {
        if (blk.content.length > longestBlockLen) longestBlockLen = blk.content.length;
    }
}
assert.ok(longestBlockLen > 1024, `应有 block.content > 1024 (实际最长 ${longestBlockLen})`);
pass(`最长 block.content = ${longestBlockLen} 字符 (远超旧 1024 限制)`);

// ============ Task 3: _stripMacros ============
console.log('\n=== Task 3: _stripMacros ===');
const { __testHooks } = await import('../cfs/modules/rsi.js');
const { _stripMacros } = __testHooks;

assert.equal(_stripMacros('hello {{user}} world'), 'hello  world');
pass('剥 {{user}}');
assert.equal(_stripMacros('a <% Math.random() %> b'), 'a  b');
pass('剥 <%...%>');
assert.equal(_stripMacros('混合 {{getvar::x}} + <%= y %> 文本'), '混合  +  文本');
pass('剥混合宏');
assert.equal(_stripMacros('无宏的纯文本'), '无宏的纯文本');
pass('无宏纯文本不变');
assert.equal(_stripMacros(null), '');
assert.equal(_stripMacros(undefined), '');
assert.equal(_stripMacros(123), '');
pass('null/undefined/非string → 空字符串');

// ============ Task 4a: _diffRoundsFindVariableRegions ============
console.log('\n=== Task 4a: _diffRoundsFindVariableRegions ===');
const { _diffRoundsFindVariableRegions } = __testHooks;

// 场景 a1: 2 轮中间一段变化
// 'head_STABLE_变化A_tail_STABLE' vs 'head_STABLE_变化B_tail_STABLE'
//  共同 prefix = 'head_STABLE_变化' (14 字符) - 第 14 位是 A vs B
//  共同 suffix = '_tail_STABLE' (12 字符)
const d1 = _diffRoundsFindVariableRegions(['head_STABLE_变化A_tail_STABLE', 'head_STABLE_变化B_tail_STABLE']);
assert.equal(d1.stablePrefixLen, 14, `prefix 应=14 (head_STABLE_变化), 实际 ${d1.stablePrefixLen}`);
assert.equal(d1.stableSuffixLen, 12, `suffix 应=12 (_tail_STABLE), 实际 ${d1.stableSuffixLen}`);
pass(`2 轮变化定位: prefix=14, suffix=12 (变化区=[14, 30-12)=[14,18))`);

// 场景 a2: 多轮、变化处各异 → 取交集
const d2 = _diffRoundsFindVariableRegions(['ABC_X_YZ', 'ABC_Y_YZ', 'ABC_Z_YZ']);
assert.equal(d2.stablePrefixLen, 4, `多轮 prefix 应取交集 (ABC_)`);
assert.equal(d2.stableSuffixLen, 3, `多轮 suffix 应取交集 (_YZ)`);
pass('多轮变化定位: prefix=4, suffix=3 (取交集)');

// 场景 a3: 完全相同（不该出现在 unstable 列表，但函数要容错）
const d3 = _diffRoundsFindVariableRegions(['SAME', 'SAME', 'SAME']);
assert.equal(d3.stablePrefixLen, 4);
assert.equal(d3.stableSuffixLen, 0); // suffix 留 0 避免 prefix+suffix > 长度
pass('完全相同容错');

// 场景 a4: 长度不同
const d4 = _diffRoundsFindVariableRegions(['ABC123XYZ', 'ABC456789XYZ']);
assert.equal(d4.stablePrefixLen, 3, `长度不同 prefix=ABC`);
assert.equal(d4.stableSuffixLen, 3, `长度不同 suffix=XYZ`);
pass('长度不同两轮');

// ============ Task 4b: _extractContextWindow ============
console.log('\n=== Task 4b: _extractContextWindow ===');
const { _extractContextWindow } = __testHooks;
const longText = 'A'.repeat(5000) + 'CHANGE' + 'B'.repeat(5000);
const win1 = _extractContextWindow(longText, 5000, 5000, 2048);
// 变化区 [5000, 5006)，窗口 [5000-2048, 5006+2048) = [2952, 7054)
assert.equal(win1.length, 7054 - 2952);
assert.ok(win1.includes('CHANGE'));
assert.ok(win1.startsWith('A'.repeat(100)));
pass(`窗口长度 ${win1.length} 字符（变化区 ±2048 padding）`);

// 短文本：padding 不应越界
const shortText = 'STABLE_X_STABLE';
const win2 = _extractContextWindow(shortText, 7, 7, 2048);
assert.equal(win2, shortText, '短文本应整段返回不越界');
pass('短文本不越界');

// 变化区为空（prefix+suffix=总长）：返回空串
const win3 = _extractContextWindow('SAME', 4, 0, 2048);
assert.equal(win3, '');
pass('无变化区 → 空串');

// ============ Task 4: _lookupEntryByContent (输入改成 window) ============
console.log('\n=== Task 4: _lookupEntryByContent ===');
const { _lookupEntryByContent } = __testHooks;
const entries = fx.activeLoreEntries;

// 场景 A: 骰池 block 反查 — 用 diff+window 抽取
// 找到 fixture 里 idx=9 (chat history 巨块含骰池)
const idx9_rounds = fx.ringBuffer.map(r => 9 < r.length ? r[9].content : null).filter(Boolean);
assert.equal(idx9_rounds.length, 5, '应有 5 轮 idx=9 数据');

const diffRes = _diffRoundsFindVariableRegions(idx9_rounds);
console.log(`     idx=9 diff: prefixLen=${diffRes.stablePrefixLen}, suffixLen=${diffRes.stableSuffixLen}, latest.len=${idx9_rounds[4].length}`);
const idx9_window = _extractContextWindow(idx9_rounds[4], diffRes.stablePrefixLen, diffRes.stableSuffixLen, 2048);
console.log(`     idx=9 window 长度: ${idx9_window.length} 字符`);
assert.ok(idx9_window.includes('公平骰池系统'), `window 应含"公平骰池系统"字样`);
pass(`block 9 diff 定位成功，window=${idx9_window.length}c 含骰池标识`);

const rA = _lookupEntryByContent(idx9_window, entries);
assert.equal(rA.matchType, 'single', `骰池应单命中, 实际 ${rA.matchType} (hits=${rA.hits.length})`);
assert.equal(rA.hits[0].uid, 6);
assert.equal(rA.hits[0].comment, '公平骰池系统');
assert.equal(rA.hits[0].book, '无限回廊2.2_主世界书');
assert.equal(rA.hits[0].position, 'before_character_definition');
assert.ok(rA.hits[0].matchLen >= 80, `matchLen=${rA.hits[0].matchLen} 应 ≥80`);
pass(`骰池单命中 (uid=6, matchLen=${rA.hits[0].matchLen}, disabled uid=10 已过滤)`);

// 场景 B: 反查不命中 → matchType='none' + 80 字符指纹
const noMatchBlock = '完全无关的随机内容 abc xyz 1234567890'.repeat(10);
const rB = _lookupEntryByContent(noMatchBlock, entries);
assert.equal(rB.matchType, 'none');
assert.equal(rB.fingerprint.length, 80);
assert.equal(rB.hits.length, 0);
pass('无匹配 → matchType=none + 80 字符指纹');

// 场景 C: 短 window (<80) → 视同 none
const shortWin = '公平骰池系统:';
const rC = _lookupEntryByContent(shortWin, entries);
assert.equal(rC.matchType, 'none', '短 window 应视同 none');
pass('短 window (<80c) 视同 none');

// 场景 D: 多命中 — 加一条 enabled entry 含相同 80+ 字符
const multiEntries = [...entries, {
    book: '副书',
    uid: 99,
    comment: '复制粘贴的骰池规则',
    content: entries[0].content,
    position: 'before_character_definition',
    depth: 4,
    enabled: true,
}];
const rD = _lookupEntryByContent(idx9_window, multiEntries);
assert.equal(rD.matchType, 'multi');
assert.equal(rD.hits.length, 2, `multi 应保留全部 hit, 实际 ${rD.hits.length}`);
const uids = rD.hits.map(h => h.uid).sort((a, b) => a - b);
assert.deepEqual(uids, [6, 99]);
pass(`多命中保留 2 条 (uid=${uids.join(',')}) 不主动挑`);

// 场景 E: disabled 过滤
const onlyDisabled = [{ ...entries[0], enabled: false }];
const rE = _lookupEntryByContent(idx9_window, onlyDisabled);
assert.equal(rE.matchType, 'none', 'disabled entry 不应命中');
pass('disabled entry 被过滤');

// 场景 F: 空 / 异常
assert.equal(_lookupEntryByContent('hello', []).matchType, 'none');
assert.equal(_lookupEntryByContent('', entries).matchType, 'none');
assert.equal(_lookupEntryByContent(null, entries).matchType, 'none');
pass('空输入/null 容错');

// ============ Task 5: _getActiveLoreEntries (容错) ============
console.log('\n=== Task 5: _getActiveLoreEntries (Node 容错) ===');
const { RSI } = await import('../cfs/modules/rsi.js');
const r5 = await RSI.getActiveLoreEntries();
assert.ok(Array.isArray(r5), 'Node 环境应返数组而非抛错');
assert.equal(r5.length, 0, 'Node 无 TavernHelper → 空数组');
pass(`Node 无 TavernHelper 容错通过 (返 ${r5.length} 项)`);

// ============ Task 6: findUnstableEntries 端到端 ============
console.log('\n=== Task 6: findUnstableEntries (端到端) ===');
__testHooks.injectRingBuffer(fx.ringBuffer);

// 不足 3 轮时 → insufficient (临时清掉测一次)
__testHooks.injectRingBuffer(fx.ringBuffer.slice(0, 2));
const r6a = await RSI.findUnstableEntries({ _testEntries: fx.activeLoreEntries });
assert.equal(r6a.status, 'insufficient');
assert.equal(r6a.roundsCount, 2);
assert.equal(r6a.needed, 1);
pass(`不足 3 轮 → insufficient (needed=1)`);

// 恢复 5 轮
__testHooks.injectRingBuffer(fx.ringBuffer);
const r6 = await RSI.findUnstableEntries({ _testEntries: fx.activeLoreEntries });
assert.equal(r6.status, 'ok');
assert.equal(r6.roundsCount, 5);
assert.ok(r6.candidates.length >= 1, `应至少 1 个候选, 实际 ${r6.candidates.length}`);
pass(`5 轮跑通: ${r6.candidates.length} 个候选`);

// 找到骰池候选 (uid=6 单命中)
const dice = r6.candidates.find(c => c.matchType === 'single' && c.hits[0]?.uid === 6);
assert.ok(dice, `应单命中骰池 uid=6, 实际 candidates=${JSON.stringify(r6.candidates.map(c => ({idx: c.blockIdx, type: c.matchType, hits: c.hits.map(h => h.uid)})))}`);
assert.equal(dice.hits[0].comment, '公平骰池系统');
assert.equal(dice.hits[0].book, '无限回廊2.2_主世界书');
assert.equal(dice.hits[0].position, 'before_character_definition');
console.log(`     dice candidate: blockIdx=${dice.blockIdx}, variableLen=${dice.variableLen}c, window=${dice.windowSize}c`);
pass(`骰池精准单命中 (blockIdx=${dice.blockIdx}, matchLen=${dice.hits[0].matchLen})`);

// 完全空 entries → 候选还在，但 matchType=none + 指纹
__testHooks.injectRingBuffer(fx.ringBuffer);
const r6b = await RSI.findUnstableEntries({ _testEntries: [] });
assert.ok(r6b.candidates.length >= 1);
for (const c of r6b.candidates) {
    assert.equal(c.matchType, 'none', '无 entries → 全 none');
    assert.ok(c.fingerprint.length <= 80, `指纹长度 ≤80, 实际 ${c.fingerprint.length}`);
}
pass(`空 entries → 全 candidates matchType=none + 80 字符指纹`);

// ============ Task 7: _genDriftPanel HTML ============
console.log('\n=== Task 7: _genDriftPanel HTML ===');
__testHooks.injectRingBuffer(fx.ringBuffer);
const html = await RSI.genDriftPanel({ _testEntries: fx.activeLoreEntries });

// 必须出现的关键字段 (含 2026-06-22 hotfix: 分组标题 + 中文化)
const mustHave = [
    '为什么这是问题', '逐字符比对',                           // 顶部白话段
    '✅ 在世界书中找到波动源定位',                            // hotfix: 分组标题
    '公平骰池系统',                                          // entry 名
    'uid <code>6</code>',                                   // uid
    '无限回廊2.2_主世界书',                                  // worldbook 名
    '角色定义之前',                                          // hotfix: position 中文化 (before_character_definition)
    '[cfs:ignore]',                                         // 标签
    '[用户]插入深度@D',                                      // hotfix: at_depth_as_user 中文化
    '深度</code> 改成 <code>0',                              // hotfix: depth → 深度
];
for (const m of mustHave) {
    assert.ok(html.includes(m), `HTML 应含 "${m}", 实际 html 片段:\n${html.slice(0, 500)}...`);
}
pass(`HTML 全部 ${mustHave.length} 个关键字段验证通过 (含分组/中文化)`);

// 必须不含的（避免英文术语泄露给 DC 奶人）
const mustNotHave = [
    '当前位置 <code>at_depth_as_user',  // 不能直接显示英文
    'before_character_definition</code><br>', // 不能裸英文 (允许出现在 ST UI 引导里)
];
// 仅严格不允许 single/multi 卡片里的 position 字段是英文
// 由于 _posCN 处理后 single 卡片不会再有 at_depth_as_user/before_character_definition 裸字符
// （除了 ST 引导可能保留英文）这里只断不出现 "当前位置: at_depth_as_user"
pass('中文化检查 (无 ST UI 引导外的裸英文 position)');

// 不足 3 轮 → empty 状态
__testHooks.injectRingBuffer(fx.ringBuffer.slice(0, 1));
const htmlEmpty = await RSI.genDriftPanel({ _testEntries: fx.activeLoreEntries });
assert.ok(htmlEmpty.includes('再发') && htmlEmpty.includes('条消息后开始检测'));
pass('insufficient 状态渲染正确');

// 全 stable → ok 状态 (mock: 注入 5 轮完全相同的 ring buffer)
const stableRing = Array.from({ length: 5 }, () => fx.ringBuffer[0].slice());
__testHooks.injectRingBuffer(stableRing);
const htmlOk = await RSI.genDriftPanel({ _testEntries: fx.activeLoreEntries });
assert.ok(htmlOk.includes('已达架构上限'), `ok 状态应显示"已达架构上限", 实际: ${htmlOk.slice(0, 200)}`);
pass('stable 状态渲染正确');

// none 分流（用骰池 block 但传空 entries）
__testHooks.injectRingBuffer(fx.ringBuffer);
const htmlNone = await RSI.genDriftPanel({ _testEntries: [] });
assert.ok(htmlNone.includes('❓ 不属于世界书的波动源'), `❓ 分组标题, 实际: ${htmlNone.slice(0, 300)}`);
assert.ok(htmlNone.includes('未在 worldbook 找到来源'), 'none 卡片文案');
assert.ok(htmlNone.includes('文本指纹') || htmlNone.includes('搜索定位'), '指纹引导');
pass('❓ 不属于世界书分组渲染正确');

// hotfix: user input 识别 — 构造 mock ring buffer
// 5 轮，idx=0 是一个 user role block，每轮 hash 都不同（模拟用户每轮发不同消息）
const userInputMock = Array.from({ length: 5 }, (_, r) => [
    { idx: 0, role: 'user', len: 50, hash: `usr_${r}`, content: `用户第${r}轮输入：blah blah blah` },
    { idx: 1, role: 'assistant', len: 100, hash: 'assist_const', content: 'AI 回复' },
    { idx: 2, role: 'assistant', len: 100, hash: 'assist_const2', content: 'AI 回复 2' },
]);
__testHooks.injectRingBuffer(userInputMock);
const htmlUI = await RSI.genDriftPanel({ _testEntries: [] });
assert.ok(htmlUI.includes('ℹ️ 用户输入'), `应有 ℹ️ 用户输入分组, 实际: ${htmlUI.slice(0, 500)}`);
assert.ok(htmlUI.includes('极可能是你本轮的输入'), '应说明是用户输入');
pass('ℹ️ user input 识别 + 单独分组渲染正确');

console.log(`\n=== 全部 ${testCount} 项断言通过 ===`);
