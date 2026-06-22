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

console.log(`\n=== 全部 ${testCount} 项断言通过 ===`);
