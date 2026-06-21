// L2 smoke test — Node 直跑，不依赖 SillyTavern
// 用法: node test/rsi_l2_smoke.mjs
//
// 验证 rsi.js 新算法对《道渊》v5.1 2026-06-21 fixture 的输出：
//   - findHistoryRange(#5 主请求) = {start: 49, end: 51, hasHistory: true}
//   - 喂 3 主请求入 ring buffer 后 analyze() 的 #5：
//     * historyRange.start=49, end=51
//     * postHistoryBlocks 包含 idx 52-60
//     * idx 54-60 应是 stable（跨 #1#3#5 hash 一致）
//     * idx 52, 53 应是 dynamic（用户输入/STABLE_BATCH 跨轮变化）
//     * preHistoryClusters 应非空（idx 0-48 有变化的块）或为空（若全 stable）

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 跳过 SillyTavern 全局：rsi.js 顶部 _bindEvent 在 node 里会失败但不抛错
// 它会 setTimeout 重试 — node 不会 hang，因为我们 import 完就 process.exit
globalThis.window = undefined;
globalThis.SillyTavern = undefined;

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'daoyuan-0621.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

const { RSI, findHistoryRange } = await import('../cfs/modules/rsi.js');

const snapshots = fixture.snapshots; // [#1, #3, #5]

let pass = 0, fail = 0;
function assert(name, cond, detail) {
    if (cond) { console.log(`  ✅ ${name}`); pass++; }
    else { console.log(`  ❌ ${name} — ${detail || ''}`); fail++; }
}

// ─── Test 1: findHistoryRange on #5 main request ───
console.log('\n[Test 1] findHistoryRange(#5 主请求)');
const blocks5 = snapshots[2].messages.map((m, idx) => ({ idx, role: m.role, len: m.length, hash: m.hash }));
const r5 = findHistoryRange(blocks5);
console.log(`  result: ${JSON.stringify(r5)}`);
assert('hasHistory=true', r5.hasHistory);
assert('start=49 (idx 49 是首个 assistant)', r5.start === 49, `got ${r5.start}`);
assert('end=51 (idx 51 是末 assistant)', r5.end === 51, `got ${r5.end}`);

// ─── Test 2: findHistoryRange on #1 (chatLen=57) ───
console.log('\n[Test 2] findHistoryRange(#1 主请求 chatLen=57)');
const blocks1 = snapshots[0].messages.map((m, idx) => ({ idx, role: m.role, len: m.length, hash: m.hash }));
const r1 = findHistoryRange(blocks1);
console.log(`  result: ${JSON.stringify(r1)}`);
console.log(`  #1 role 分布:`, blocks1.reduce((acc, b) => { acc[b.role] = (acc[b.role] || 0) + 1; return acc; }, {}));

// ─── Test 3: 喂 3 主请求 入 ring buffer 后 analyze() #5 ───
console.log('\n[Test 3] 喂 #1→#3→#5 入 ring buffer 后 analyze() #5');
// 直接调内部 _onPromptReady? 没暴露。借 RSI.resetBuffer + 模拟事件流不行。
// 退而求其次：用 RSI.getRingBuffer() 直接推数据
const ring = RSI.getRingBuffer();
ring.length = 0;
for (const snap of snapshots) {
    const blocks = snap.messages.map((m, idx) => ({ idx, role: m.role, len: m.length, hash: m.hash }));
    ring.push(blocks);
}
const a = RSI.analyze();
console.log(`  status: ${a.status}`);
console.log(`  roundsCount: ${a.roundsCount}, total: ${a.total}`);
console.log(`  historyRange: ${JSON.stringify(a.historyRange)}`);
console.log(`  prefixStableEnd: ${a.prefixStableEnd}, prefixStability: ${a.prefixStability}`);
console.log(`  preHistoryClusters: ${JSON.stringify(a.preHistoryClusters)}`);
console.log(`  postHistoryBlocks (${a.postHistoryBlocks.length}):`);
for (const b of a.postHistoryBlocks) {
    const m = snapshots[2].messages[b.idx];
    console.log(`    idx=${b.idx} ${b.status.padEnd(8)} role=${m.role} len=${m.length} hash=${m.hash}`);
}

assert('analyze status=ok', a.status === 'ok');
assert('historyRange.start=49', a.historyRange.start === 49, `got ${a.historyRange.start}`);
assert('historyRange.end=51', a.historyRange.end === 51, `got ${a.historyRange.end}`);
assert('postHistoryBlocks 长度 = 9 (idx 52-60)', a.postHistoryBlocks.length === 9, `got ${a.postHistoryBlocks.length}`);
// idx 54-60 跨 #1#3#5 应 stable（含 </chathistory> <Lore> </Lore> [已开启指令] <foxp> [全局输出结构化规范]）
const stableIdxs = a.postHistoryBlocks.filter(b => b.status === 'stable').map(b => b.idx);
const dynIdxs = a.postHistoryBlocks.filter(b => b.status === 'dynamic').map(b => b.idx);
console.log(`  stable idxs: ${JSON.stringify(stableIdxs)}`);
console.log(`  dynamic idxs: ${JSON.stringify(dynIdxs)}`);

// ─── Test 4: simple 输出预览 ───
console.log('\n[Test 4] genSimpleOutput 输出预览:\n');
console.log(RSI.genSimpleOutput());

console.log(`\n=== 总计: ${pass} pass / ${fail} fail ===`);
process.exit(fail > 0 ? 1 : 0);
