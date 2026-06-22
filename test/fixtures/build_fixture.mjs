// One-shot fixture builder for wuxianhuilang-0622-rsi.json
// Source: WorldbookCacheInspectorDB_full_export.json (desktop), 19:57-20:15 5 main requests
// Run: node test/fixtures/build_fixture.mjs

import fs from 'node:fs';

const DB_PATH = 'C:/Users/30794/Desktop/WorldbookCacheInspectorDB_full_export.json';
const OUT_PATH = 'D:/Silly/CFS-Suite/test/fixtures/wuxianhuilang-0622-rsi.json';
const TARGET_RANGE = [1782129427681, 1782130500009]; // 19:57:07 - 20:15:00

const DB = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
const snaps = DB.promptSnapshots.filter(s => s.timestamp >= TARGET_RANGE[0] && s.timestamp <= TARGET_RANGE[1]);
console.log(`snapshots in window: ${snaps.length}`); // expect 10

// 奇数下标 = 主请求 (24-27 blocks); 偶数 = 副请求 (7 blocks)
const mains = snaps.filter((_, i) => i % 2 === 0);
console.log(`main requests: ${mains.length}`); // expect 5

// FNV-1a 32-bit (与 rsi.js _fnv1a8 一致)
function fnv1a8(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

// snapshot 的 block#0 包含 RSI 自己加的 4 行 hash header (8-hex/行)，剥掉
function snapToRound(snap) {
    return snap.messages.map((m, idx) => {
        let text = m.text || '';
        if (idx === 0) {
            const lines = text.split('\n');
            let skip = 0;
            for (const ln of lines) {
                if (/^[0-9a-f]{8}$/.test(ln)) skip++;
                else break;
            }
            if (skip > 0) text = lines.slice(skip).join('\n');
        }
        return {
            idx,
            role: m.role || 'unknown',
            len: text.length,
            hash: fnv1a8(text),
            contentSlice: text.slice(0, 1024),
        };
    });
}

const ringBuffer = mains.map(snapToRound);
console.log(`ringBuffer rounds: ${ringBuffer.length}`);
console.log(`  round-by-round block count: ${ringBuffer.map(r => r.length).join(', ')}`);

// 模拟无限回廊2.2 active worldbook entries
// 取真实断点位置文本作为骰池条目 content（保留稳定 header）
const diceEntry = {
    book: '无限回廊2.2_主世界书',
    uid: 6,
    comment: '公平骰池系统',
    content: '公平骰池系统:\n\n  设计目的: AI无法生成真随机数。所有需要投骰的场景，AI必须从预埋骰池中按顺序取用结果，禁止自行编造任何数值。\n\n  骰池规则:\n    取用方式: 严格按从左到右顺序取用，每取一个划掉（在输出中标注已用序号），不得跳过、不得挑选\n    耗尽处理: 某类骰子池用完后，AI必须自动执行刷新。\n    禁止行为: 禁止AI以任何理由自行生成投骰结果，包括但不限于"为了叙事流畅""紧急情况""临时判定"\n\n  当前骰池:\n    D4 : [ 占位 ]',
    position: 'before_character_definition',
    depth: 4,
    enabled: true,
};

// 干扰 entry 验证反查精度
const noiseEntries = [
    {
        book: '无限回廊2.2_主世界书',
        uid: 7,
        comment: '世界总纲',
        content: '<世界观_id1>\n无限回廊_总纲:\n\n  世界概述: 未来超维文明构建的军事练兵系统。将契约者投放到已知文艺作品（小说、电影、动漫、游戏、漫画）世界观中进行生存试炼。',
        position: 'before_character_definition',
        depth: 4,
        enabled: true,
    },
    {
        book: '无限回廊2.2_主世界书',
        uid: 10,
        comment: '失效条目',
        content: '公平骰池系统:\n\n  设计目的: AI无法生成真随机数。所有需要投骰的场景，AI必须从预埋骰池中按顺序取用结果，禁止自行编造任何数值。\n\n  骰池规则:\n    取用方式: 严格按从左到右顺序取用',
        position: 'at_depth_as_user',
        depth: 0,
        enabled: false, // disabled → 不应被反查命中
    },
];

const activeLoreEntries = [diceEntry, ...noiseEntries];

// 计算 expectedUnstableBlocks (pre-history 区跨 ≥2 hash 的 idx)
const N = ringBuffer.length;
const latest = ringBuffer[N - 1];
const firstAsst = latest.findIndex(b => b.role === 'assistant');
const prefixEnd = firstAsst >= 0 ? firstAsst : latest.length;
const expectedUnstableBlocks = [];
for (let i = 0; i < prefixEnd; i++) {
    const hashes = new Set();
    let observed = 0;
    for (let r = 0; r < N; r++) {
        if (i < ringBuffer[r].length) {
            hashes.add(ringBuffer[r][i].hash);
            observed++;
        }
    }
    if (observed >= 3 && hashes.size >= 2) expectedUnstableBlocks.push(i);
}
console.log(`pre-history range: [0, ${prefixEnd})`);
console.log(`expectedUnstableBlocks: [${expectedUnstableBlocks.join(', ')}]`);

const fixture = {
    _meta: {
        source: 'WorldbookCacheInspectorDB_full_export.json 19:57-20:15 5 main requests (DeepSeek V4 Pro)',
        built_at: '2026-06-22',
        purpose: 'RSI drift detection panel — 真实跨轮 hash 不稳定数据，骰池条目反查精度验证',
    },
    ringBuffer,
    activeLoreEntries,
    expectedUnstableBlocks,
};

fs.writeFileSync(OUT_PATH, JSON.stringify(fixture, null, 2));
console.log(`\n✅ Written: ${OUT_PATH}`);
console.log(`   size: ${(fs.statSync(OUT_PATH).size / 1024).toFixed(1)} KB`);
