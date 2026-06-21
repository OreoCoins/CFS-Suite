// 集成测试 — 把《道渊》fixture 3 个主请求顺序喂入 RSI + pinner，看完整行为
// 模拟：每轮 ST emit CHAT_COMPLETION_PROMPT_READY → RSI 抓 + pinner 改

globalThis.window = {};
globalThis.localStorage = {
    _kv: {},
    getItem(k) { return this._kv[k] ?? null; },
    setItem(k, v) { this._kv[k] = String(v); },
};
globalThis.SillyTavern = undefined;

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'daoyuan-0621.json'), 'utf8'));

const { RSI } = await import('../cfs/modules/rsi.js');
const { PostHistoryPinner } = await import('../cfs/core/post_history_pinner.js');

// fixture 只有 hash，没真实 content。pinner 需要算 hash 比对 → 必须 hash 同源。
// 用 fixture 的 hash 作 "伪 content"，自己跑 fnv1a8 → 同一 fixture-hash 产生稳定的 pinner-hash。
// 占位符识别需要真 content → 对已知占位 idx 注入真实 marker。
function fnv1a8(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, '0');
}

// 已知《道渊》#5 idx 53 是 STABLE_BATCH (15258字, hash 818eb8b3)
// 已知 #5 idx 57 不是 user_input — 但要测试占位排除，给 idx 57 注入 marker
// 实际占位在哪一块？通过我们之前打印的 #5 内容看：
//   idx 57: user 46 "<user_input> {{lastusermessage}} </user_input>"
const KNOWN_MARKERS = {
    // (snapshotIdx, blockIdx) → marker prefix
    // #3 (chatLen=59): idx 57 是 <user_input>，hash=144359e4
    // #5 (chatLen=61): idx 57 是 <user_input>，hash=144359e4
    // 但 #5 idx 53 STABLE_BATCH 长 15258 字 hash 818eb8b3 — 跨轮唯一，自然 dynamic 不会被 pin
    // 我们仍标 STABLE_BATCH 以验证 skip 路径
};
function getMarker(hash) {
    // 用 hash 反查占位
    if (hash === '818eb8b3') return '<STABLE_BATCH schema="dummy">';
    if (hash === '144359e4') return '<user_input> {{lastusermessage}} </user_input>';
    return null;
}

function snapToChat(snap) {
    return snap.messages.map((m) => {
        const marker = getMarker(m.hash);
        const content = (marker ? marker + ' ' : '') + m.hash;
        return { role: m.role, content };
    });
}

const ring = RSI.getRingBuffer();
ring.length = 0;
PostHistoryPinner.setEnabled(true);

console.log('=== 模拟《道渊》3 个主请求依次进入 ===\n');

for (let i = 0; i < 3; i++) {
    const snap = fixture.snapshots[i];
    const chat = snapToChat(snap);
    const eventData = { chat };
    const lenBefore = chat.length;

    // 先让 pinner 改 chat（pinner 用 RSI 的 hash 同源算法）
    PostHistoryPinner._onPromptReadyForPinning(eventData);
    const lenAfter = eventData.chat.length;

    // 再把（重排后的）chat 进入 RSI ring buffer — 模拟 ST 真实顺序：
    // 但 ring buffer 的入口在 _onPromptReady（订阅同事件）。这里我们直接 push 简化。
    const blocks = eventData.chat.map((m, idx) => ({
        idx, role: m.role, len: m.content.length, hash: fnv1a8(m.content),
    }));
    ring.push(blocks);

    const stats = PostHistoryPinner.stats();
    console.log(`Round ${i + 1} (snap ${snap.id} chatLen=${lenBefore}):`);
    console.log(`  pinner.lastPinCount=${stats.lastPinCount}, lastPinIdxs=${JSON.stringify(stats.lastPinIdxs)}`);
    console.log(`  chat 长度 ${lenBefore} → ${lenAfter} (一致: ${lenBefore === lenAfter})`);
    const a = RSI.analyze();
    if (a.status === 'ok') {
        console.log(`  RSI: historyRange=${JSON.stringify(a.historyRange)} prefixStableEnd=${a.prefixStableEnd}`);
        console.log(`       preHistoryClusters=${JSON.stringify(a.preHistoryClusters)}`);
        console.log(`       postHistoryBlocks 数=${a.postHistoryBlocks.length} (stable=${a.postHistoryBlocks.filter(b=>b.status==='stable').length} dynamic=${a.postHistoryBlocks.filter(b=>b.status==='dynamic').length})`);
    } else {
        console.log(`  RSI: ${a.status} - 再发 ${a.needed} 条`);
    }
    console.log();
}

console.log('=== 最终 RSI simple 输出 ===\n');
console.log(RSI.genSimpleOutput());
