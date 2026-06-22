// PSIS+ judge sanity — 用双人成行 v7.0 真实 8 条 unknown 块测启发式判定
// 用法: node test/psisp_judge_sanity.mjs
//
// 不 import psis_plus.js（ESM 链到 ST script.js 不可达），把判定逻辑 inline 复制一份。
// 这是 sanity 校验，不替代真机验证；改 psis_plus.js 时同步改本文件。

import fs from 'node:fs';

const PRESET_PATH = 'D:/Silly/脚本/双人成行v7.0—长风渡（DS鲸鱼特化版）.json';

// === 与 psis_plus.js 保持一致的判定逻辑 ===
const SKIP_PIN_MARKERS = ['{{lastusermessage}}', '{{lastmessage}}', '<STABLE_BATCH'];
const SOFT_SKIP_MARKERS = ['{{user}}', '{{char}}'];

function tagsBalanced(content) {
    if (!content) return true;
    const trimmed = content.trim();
    if (trimmed.length < 80 && /^<\/?[a-zA-Z_][\w-]*(?:\s+[^>]*)?>\s*$/.test(trimmed)) {
        return false;
    }
    function nameOf(raw) {
        const m = raw.match(/<\/?([a-zA-Z_][\w-]*)/);
        return m ? m[1].toLowerCase() : '';
    }
    let openLine = content.match(/(?:^|\n)[ \t]*<[a-zA-Z_][\w-]*(?:\s+[^>]*)?>[ \t]*(?=\n|$)/g) || [];
    let closeLine = content.match(/(?:^|\n)[ \t]*<\/[a-zA-Z_][\w-]*>[ \t]*(?=\n|$)/g) || [];
    openLine = openLine.filter(t => !/\/\s*>\s*$/.test(t));
    const openCounts = {}, closeCounts = {};
    for (const t of openLine) { const n = nameOf(t); if (n) openCounts[n] = (openCounts[n] || 0) + 1; }
    for (const t of closeLine) { const n = nameOf(t); if (n) closeCounts[n] = (closeCounts[n] || 0) + 1; }
    const allNames = [...Object.keys(openCounts), ...Object.keys(closeCounts)];
    for (const n of allNames) {
        if ((openCounts[n] || 0) !== (closeCounts[n] || 0)) return false;
    }
    return true;
}

function judgeUnknown(identifier, entry) {
    const content = (entry && entry.content) || '';
    const name = (entry && entry.name) || '';
    if (/\[cfs:stable\]/i.test(name) || /\[cfs:stable\]/i.test(content)) return 'stable_move';
    if (/\[cfs:keep-after-history\]/i.test(name) || /\[cfs:ignore\]/i.test(name)) return 'keep_after';
    for (const m of SKIP_PIN_MARKERS) if (content.indexOf(m) >= 0) return 'keep_after';
    if (!tagsBalanced(content)) return 'keep_after';
    if (/\{\{random\b/i.test(content)) return 'uncertain';
    if (/\{\{roll\b/i.test(content)) return 'uncertain';
    if (/\{\{(date|time|datetime)\}\}/i.test(content)) return 'uncertain';
    if (/getvar\s*\(/i.test(content)) return 'uncertain';
    if (/<%[^%]*%>/.test(content)) return 'uncertain';
    for (const m of SOFT_SKIP_MARKERS) if (content.indexOf(m) >= 0) return 'uncertain';
    if (content.length < 200) return 'uncertain';
    const role = entry && entry.role;
    if (role !== 'user' && role !== 'system') return 'uncertain';
    return 'stable_move';
}

// === 跑实测 8 条 ===
// 用 PowerShell 跑：`node test/psisp_judge_sanity.mjs`（git bash 中文路径解析有 codepage 问题）
if (!fs.existsSync(PRESET_PATH)) {
    console.log(`⚠ 预设文件不存在（${PRESET_PATH}）— sanity test 跳过。`);
    console.log('  这通常是 git bash 环境运行（中文路径解析问题）。请用 PowerShell 跑。');
    console.log('  在 CI / 跨环境，缺失此文件视为 OK（仅本地真机校验用）。');
    process.exit(0);
}
const data = JSON.parse(fs.readFileSync(PRESET_PATH, 'utf8'));
const TARGETS = [
    { id: '388e81c9-cc07-44c4-8afa-86e74aa6c69f', label: '历史结束',       expect: 'keep_after' },
    { id: '96383e79-51c3-48f0-8540-230f40e7d114', label: '角色卡开始',     expect: 'keep_after' },
    { id: 'f0fceb55-ff7b-433c-8962-b0c0d5d6d69c', label: '角色卡结束',     expect: 'keep_after' },
    { id: 'b72bb590-e23c-4ca8-9f6c-6020534e9b80', label: '用户输入',       expect: 'keep_after' },
    { id: '4c225784-1f38-4ff9-b06c-b14ad1dfe386', label: '条目召回',       expect: 'keep_after' },
    { id: '483d94f3-3f86-4f13-8d72-d2754d682d24', label: '思维链',         expect: 'stable_move' },
    { id: 'abc7e6ce-78d8-4b61-9eb2-71e5ceb56af3', label: '输出格式',       expect: 'stable_move' },
    { id: 'f02227ab-f751-470e-825a-1ca66fa6cf3f', label: '尾巴不动',       expect: 'uncertain' },
];

let pass = 0, fail = 0;
for (const t of TARGETS) {
    const entry = data.prompts.find(p => p.identifier === t.id);
    if (!entry) {
        console.log(`  ⚠ MISS ${t.label} (${t.id}) — 预设里找不到`);
        fail++;
        continue;
    }
    const verdict = judgeUnknown(t.id, entry);
    const ok = verdict === t.expect;
    const mark = ok ? '✅' : '❌';
    console.log(`  ${mark} ${t.label.padEnd(8, '　')} | len=${String((entry.content || '').length).padStart(4)} | role=${entry.role.padEnd(6)} | expect=${t.expect.padEnd(11)} | got=${verdict}`);
    if (ok) pass++; else fail++;
}

console.log(`\n=== 总计: ${pass} pass / ${fail} fail ===`);
process.exit(fail > 0 ? 1 : 0);
