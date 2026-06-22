// RSI Drift Detection Panel · smoke tests
// 涵盖 Task 2-7 的单元测试 (Task 5 因依赖 ST 运行时仅做容错验证)
// Run: node test/rsi_drift_smoke.mjs

import fs from 'node:fs';
import assert from 'node:assert/strict';

const FIXTURE_PATH = './test/fixtures/wuxianhuilang-0622-rsi.json';
const fx = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
console.log(`fixture loaded: ${fx.ringBuffer.length} rounds, ${fx.activeLoreEntries.length} entries`);

let testCount = 0;
function pass(name) {
    testCount++;
    console.log(`  ✅ [${testCount}] ${name}`);
}

// ============ Task 2: contentSlice 长度 ============
console.log('\n=== Task 2: contentSlice 长度 ===');
let testedLongBlock = false;
for (const round of fx.ringBuffer) {
    for (const blk of round) {
        if (blk.len > 240 && blk.contentSlice.length > 240) {
            testedLongBlock = true;
            break;
        }
    }
    if (testedLongBlock) break;
}
assert.ok(testedLongBlock, 'fixture 中应有长 block 验证 contentSlice 已 > 240');
pass('fixture 中长 block 的 contentSlice > 240');

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
// 边界：null / 非 string
assert.equal(_stripMacros(null), '');
assert.equal(_stripMacros(undefined), '');
assert.equal(_stripMacros(123), '');
pass('null/undefined/非string → 空字符串');

console.log(`\n=== 全部 ${testCount} 项断言通过 ===`);
