/**
 * CFS-Suite · modules/rsi.js
 *
 * RSI = Runtime Structure Inspector
 *
 * 跟 PSIS+ 分层互补：
 *   PSIS+ → 优化静态预设拓扑（oai_settings.prompt_order）
 *   RSI   → 诊断运行时真实 messages 拓扑（CHAT_COMPLETION_PROMPT_READY 拿到的 chat 数组）
 *
 * 核心问题：用户 DC 反馈"插件扫预设没问题、cache 命中率仍掉" — 真凶往往是
 * extension_prompts / Author's Note / Summary / Memory / RAG / depth inject 这类
 * **运行时动态注入**的块夹在 stable prefix 和 chat history 之间，PSIS+ 看不见。
 *
 * 工作方式：
 *   1. hook globalThis.fetch 拦 `/api/backends/chat-completions/generate` 真实 HTTP 请求
 *      从 request body 的 messages 数组算 [{idx, role, len, hash}] 存 ring buffer (≤5 轮内存)
 *      ↑ 启动探测 / 模板预编译 / dryRun token counting 都不发 HTTP → 天然不被记
 *      ↑ messages.length ≥ MIN_MAIN_CHAT_LEN 才记，自动滤掉 CFS-MVU / 别扩展的短副请求
 *   2. 用 assistant 块定 history range → 跨轮对账非 history 块 → 报 pre-history 夹层
 *      + post-history 平移污染
 *   3. 给胶囊 panel 提供 simple/full 两种文本输出（panel 渲染 + 复制到剪贴板用）
 *   4. L1 post_history_pinner 复用 findHistoryRange + getRingBuffer 做"前移"重排
 *      pinner 仍订阅 CHAT_COMPLETION_PROMPT_READY（必须运行时改 chat），跟 RSI 解耦
 *
 * 关键算法（L2 重写后）：
 *   - History 段：用首末 assistant idx 定 range；无 assistant → hasHistory=false
 *   - Prefix stable：从 idx=0 起到 historyRange.start 的最长连续 stable
 *   - Pre-history clusters：[prefixStableEnd, historyRange.start) 内的连续 dynamic 段
 *   - Post-history blocks：(historyRange.end, total) 段，stable=应前移，dynamic=保持原位
 *
 * 不接管 / 不修改 — 仅诊断；执行层在 cfs/core/post_history_pinner.js。
 */

const TAG = '[CFS-Suite/rsi]';
const MAX_ROUNDS = 5;
const NEIGHBOR_CONTEXT = 3;              // simple 输出 cluster ± 多少块周边

const _GLOBAL = (typeof window !== 'undefined') ? (window.parent || window) : {};
if (!_GLOBAL.CFS4) _GLOBAL.CFS4 = {};

const _ringBuffer = []; // 每项是一轮的 blocks 数组 [{idx, role, len, hash}, ...]

// 取数策略（2026-06-21 重构，参考 jerryzmtz/worldbook-manager 思路）：
//   旧版订阅 ST 的 CHAT_COMPLETION_PROMPT_READY 事件 → 被启动探测 / 模板预编译 /
//     ST-Prompt-Template / CFS-MVU 副请求 / token counting 全方位污染
//   新版 hook globalThis.fetch 拦 `/api/backends/chat-completions/generate` 真实请求
//     - 启动探测 / 模板预编译 / dryRun token counting 不发 HTTP → 天然不被记 ✓
//     - 主请求 + 副请求都发 HTTP → 都被拦，按 messages.length 阈值区分（实测主 50+ / 副 10-20）
//     - 切卡不触发 HTTP，ring buffer 自然不被污染；chatId 兜底负责清残留
//     - 与 WM 缓存查看器的 fetch patch 是 chain 关系，互不破坏
const MIN_MAIN_CHAT_LEN = 30; // 主请求 messages 数下限，副请求一律 ≤20 块
const TARGET_API_FRAGMENT = '/api/backends/chat-completions/generate';

let _lastSeenChatId = null;
let _lastPushedFingerprint = null;
let _debugVerbose = false; // LS key 'cfs-suite/rsi_debug'='1' 启用

// FNV-1a 32-bit hash, 返回 8 hex 字符
function _fnv1a8(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

function _stringifyContent(c) {
    if (typeof c === 'string') return c;
    if (c == null) return '';
    try { return JSON.stringify(c); }
    catch { return String(c); }
}

// 2026-06-22 v6.4 Drift Panel · 反查辅助：剥 entry content 中的动态宏，得到"渲染时不变的稳定子串"
// 用于跟 ring buffer 中已渲染的 block.contentSlice 做 substring 匹配
// 简单 regex（够用，嵌套 {{a::{{b}}}} 也能剥外层，残留 `}` 不影响 ≥80 字符匹配）
const _MACRO_REGEX = /\{\{[^{}]*\}\}|<%[\s\S]*?%>/g;
function _stripMacros(content) {
    if (typeof content !== 'string') return '';
    return content.replace(_MACRO_REGEX, '');
}

// === 2026-06-22 v6.4 Drift Panel · C 方案：diff-locate 精准反查 ===
//
// 流程：跨 N 轮 hash 不稳定的 block →
//   1. _diffRoundsFindVariableRegions: 跨轮算最长公共 prefix/suffix，夹层 = 变化区域
//   2. _extractContextWindow: 变化区 ±2048 字符上下文窗口 (限 latest round content)
//   3. _lookupEntryByContent: 用窗口在 active entries 里做 LCS 反查
// 用 window 而不是整块反查，避免把不变化的 entry 误当元凶。

// 跨 N 轮内容找变化区域 (最长公共前缀 + 最长公共后缀 = 稳定区，剩下是变化区)
// 入: roundsContent[] (≥2 项，每项是该 block 在某一轮的完整 content)
// 出: { stablePrefixLen, stableSuffixLen }
function _diffRoundsFindVariableRegions(roundsContent) {
    if (!Array.isArray(roundsContent) || roundsContent.length < 2) {
        return { stablePrefixLen: 0, stableSuffixLen: 0 };
    }
    const ref = roundsContent[0];
    let prefixLen = ref.length;
    let suffixLen = ref.length;

    for (let r = 1; r < roundsContent.length; r++) {
        const cur = roundsContent[r];
        // 前缀：找 ref 和 cur 的最长公共前缀
        let pl = 0;
        const maxP = Math.min(prefixLen, cur.length);
        while (pl < maxP && ref.charCodeAt(pl) === cur.charCodeAt(pl)) pl++;
        prefixLen = Math.min(prefixLen, pl);

        // 后缀：找最长公共后缀，但不能跟前缀重叠
        let sl = 0;
        const maxS = Math.min(suffixLen, cur.length - prefixLen, ref.length - prefixLen);
        while (sl < maxS && ref.charCodeAt(ref.length - 1 - sl) === cur.charCodeAt(cur.length - 1 - sl)) sl++;
        suffixLen = Math.min(suffixLen, sl);
    }

    return { stablePrefixLen: prefixLen, stableSuffixLen: suffixLen };
}

// 取上下文窗口：变化区 ±padding 字符（用 latest round content）
function _extractContextWindow(latestContent, prefixLen, suffixLen, padding) {
    if (typeof latestContent !== 'string' || latestContent.length === 0) return '';
    const pad = (typeof padding === 'number' && padding >= 0) ? padding : 2048;
    const totalLen = latestContent.length;
    const varStart = prefixLen;
    const varEnd = totalLen - suffixLen;
    if (varStart >= varEnd) return ''; // 无变化区
    const winStart = Math.max(0, varStart - pad);
    const winEnd = Math.min(totalLen, varEnd + pad);
    return latestContent.slice(winStart, winEnd);
}

// 反查：用 window text (含变化区+上下文) 在 active entries 的剥宏 content 里找最长公共子串
// 返回 single (唯一 enabled 命中) / multi (≥2 个 enabled 命中) / none (无命中或 <80 字符)
// 5 道精度保护：①active 限定(调用方负责) ②多命中不挑 ③过滤 disabled ④剥宏匹配 ⑤<80 字符不命中
const _MIN_MATCH_LEN = 80;

// O(n*m) DP 最长公共子串长度（不还原子串，仅给反查打分）
// entry.content 通常 < 50KB × blockSlice ≤ 1024 → 约 50M ops ≈ 50ms，可接受
function _longestCommonSubstrLen(a, b) {
    const n = a.length, m = b.length;
    if (n === 0 || m === 0) return 0;
    let prev = new Uint16Array(m + 1);
    let curr = new Uint16Array(m + 1);
    let maxLen = 0;
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            if (a.charCodeAt(i - 1) === b.charCodeAt(j - 1)) {
                curr[j] = prev[j - 1] + 1;
                if (curr[j] > maxLen) maxLen = curr[j];
            } else {
                curr[j] = 0;
            }
        }
        [prev, curr] = [curr, prev];
        curr.fill(0);
    }
    return maxLen;
}

function _lookupEntryByContent(windowText, entries) {
    const fp = (windowText || '').slice(0, 80);
    if (!Array.isArray(entries) || entries.length === 0 || typeof windowText !== 'string' || windowText.length < _MIN_MATCH_LEN) {
        return { matchType: 'none', hits: [], fingerprint: fp };
    }
    const hits = [];
    for (const e of entries) {
        if (!e || e.enabled === false) continue;             // ③ 过滤 disabled
        const stripped = _stripMacros(e.content || '');       // ④ 剥宏后匹配
        if (stripped.length < _MIN_MATCH_LEN) continue;       // entry 太短 → 跳过
        const matchLen = _longestCommonSubstrLen(windowText, stripped);
        if (matchLen >= _MIN_MATCH_LEN) {                     // ⑤ <80 字符不命中
            hits.push({
                book: e.book, uid: e.uid, comment: e.comment,
                position: e.position, depth: e.depth, matchLen,
            });
        }
    }
    let matchType;
    if (hits.length === 0) matchType = 'none';
    else if (hits.length === 1) matchType = 'single';
    else matchType = 'multi';                                 // ② 多命中不主动挑
    return { matchType, hits, fingerprint: fp };
}

// L2 修复：history 识别 — 用 assistant 块作为强锚点
//
// 旧策略（已废弃）：从末尾反向找 user/assistant 占比 ≥80% 的最大窗口。在「预设把指令
// 塞成 role=user」的环境下（《道渊》v5.1 等），整个 chat 几乎全是 user → 反向扫描一路
// 扩张到 idx=0 → 整 chat 被错认成 history → cluster 窗口 [0,0) 长度 0 → 永远漏报。
//
// 新策略：assistant 块是"模型回复"的强信号，user/assistant 占比再高也不能没有
// assistant。用首末 assistant idx 定 history range。chat 完全无 assistant（新会话
// 首发）→ 返回 hasHistory=false。
//
// 不向外扩张 user 邻居 — 用户最新输入（history 末尾的 user）会落到 post-history 段，
// 但它跨轮 hash 必变（每轮新输入）→ 自动被识别为 dynamic，不会被误报"应前移"。
function _findHistoryRange(blocks) {
    const n = blocks.length;
    let firstAsst = -1;
    let lastAsst = -1;
    for (let i = 0; i < n; i++) {
        if (blocks[i].role === 'assistant') {
            if (firstAsst < 0) firstAsst = i;
            lastAsst = i;
        }
    }
    if (firstAsst < 0) {
        return { start: n, end: n - 1, hasHistory: false };
    }
    return { start: firstAsst, end: lastAsst, hasHistory: true };
}

function _analyze() {
    const rounds = _ringBuffer;
    if (rounds.length < 2) {
        return { status: 'insufficient', roundsCount: rounds.length, needed: 2 - rounds.length };
    }
    const latest = rounds[rounds.length - 1];
    const total = latest.length;
    const N = rounds.length;

    const histRange = _findHistoryRange(latest);
    const inHistory = (i) => histRange.hasHistory && i >= histRange.start && i <= histRange.end;

    // 对非 history 块跨轮 hash 对账
    const stability = new Array(total);
    for (let i = 0; i < total; i++) {
        if (inHistory(i)) {
            stability[i] = { idx: i, status: 'history', sameCount: 0, observedCount: 0 };
            continue;
        }
        let same = 0;
        let observed = 0;
        const ref = latest[i].hash;
        for (let r = 0; r < N; r++) {
            const round = rounds[r];
            if (i < round.length) {
                observed++;
                if (round[i].hash === ref) same++;
            }
        }
        // 至少 2 轮观察才有意义；observed < 2 时按 unknown→stable 兜底
        const isStable = (observed >= 2) ? (same === observed) : true;
        stability[i] = {
            idx: i,
            status: isStable ? 'stable' : 'dynamic',
            sameCount: same,
            observedCount: observed,
        };
    }

    // prefixStableEnd: idx 从 0 起最长连续 stable 段的 next idx（到 historyRange.start 截止）
    let prefixStableEnd = 0;
    const prefixBoundary = histRange.hasHistory ? histRange.start : total;
    for (let i = 0; i < prefixBoundary; i++) {
        if (stability[i].status === 'stable') prefixStableEnd = i + 1;
        else break;
    }

    // preHistoryClusters: [prefixStableEnd, histRange.start) 内连续 dynamic 段（旧 interlayerClusters 语义）
    const preHistoryClusters = [];
    {
        let inC = false, cs = -1;
        for (let i = prefixStableEnd; i < prefixBoundary; i++) {
            if (stability[i].status === 'dynamic') {
                if (!inC) { inC = true; cs = i; }
            } else if (inC) {
                preHistoryClusters.push({ start: cs, end: i - 1 });
                inC = false;
            }
        }
        if (inC) preHistoryClusters.push({ start: cs, end: prefixBoundary - 1 });
    }

    // postHistoryBlocks: (histRange.end, total) 段每块都列出（L1 pinner 消费）
    // - status='stable' → 跨轮 hash 内容出现过（不一定同 idx）→ 应前移到 prefix
    //   ⚠️ 关键：post-history 段本身就是平移源 — idx 在变。所以**不能**用"按 idx 对账"
    //   的 stability[i]，必须用"hash 跨轮内容搜索"。pre-history 段则没有平移问题，
    //   保留按 idx 对账。
    // - status='dynamic' → hash 是历史从未出现的新内容 → 用户输入/含时间戳
    const postHistoryBlocks = [];
    if (histRange.hasHistory) {
        const priorHashes = new Set();
        for (let r = 0; r < N - 1; r++) {
            for (const b of rounds[r]) priorHashes.add(b.hash);
        }
        for (let i = histRange.end + 1; i < total; i++) {
            const h = latest[i].hash;
            const seenBefore = priorHashes.has(h);
            const status = seenBefore ? 'stable' : 'dynamic';
            postHistoryBlocks.push({ idx: i, status, seenBefore });
            // 覆盖按 idx 对账的旧 stability — 让 _formatBlockRow 显示正确状态
            stability[i].status = status;
            stability[i].sameCount = seenBefore ? N - 1 : 0;
            stability[i].observedCount = N - 1;
        }
    }

    const prefixStability = prefixBoundary > 0 ? prefixStableEnd / prefixBoundary : null;
    return {
        status: 'ok',
        roundsCount: N,
        total,
        historyRange: histRange,
        prefixStableEnd,
        prefixStability,
        stability,
        preHistoryClusters,
        postHistoryBlocks,
    };
}

function _formatStatus(s) {
    if (s.status === 'history') return '对话历史';
    if (s.status === 'stable') return `稳定(${s.sameCount}/${s.observedCount})`;
    const changes = s.observedCount - s.sameCount;
    return `每轮变(${changes}/${s.observedCount})`;
}

function _formatBlockRow(idx, b, s, marker) {
    const idxStr = '#' + String(idx).padStart(3);
    const roleStr = (b.role || '?').padEnd(9);
    const lenStr = String(b.len).padStart(5);
    const statusStr = _formatStatus(s);
    return `  ${idxStr}  ${roleStr} ${lenStr}  ${b.hash}  ${statusStr}${marker || ''}`;
}

function _genSimpleOutput() {
    const a = _analyze();
    if (a.status === 'insufficient') {
        return `请求结构诊断 · 再发 ${a.needed} 条消息后开始判断（已看 ${a.roundsCount} 轮）`;
    }
    const latest = _ringBuffer[_ringBuffer.length - 1];
    const { total, preHistoryClusters, postHistoryBlocks, stability, roundsCount } = a;

    // 期望命中率估算：prefix 稳定段（idx 0 到 prefixStableEnd-1）的字符数 / 总字符数
    // 实际 token 数 ≈ char 数 / 3~4，比例计算时分子分母同除约掉，所以用字符比近似
    let totalChars = 0, prefixChars = 0;
    for (let i = 0; i < total; i++) {
        totalChars += latest[i].len;
        if (i < a.prefixStableEnd) prefixChars += latest[i].len;
    }
    const expectedHitRate = totalChars > 0 ? (prefixChars / totalChars * 100) : 0;

    const lines = [];
    lines.push('=== 请求结构诊断 ===');
    lines.push(`已看 ${roundsCount} 轮 · 共 ${total} 块`);
    lines.push(`期望命中率: ${expectedHitRate.toFixed(1)}%（前缀稳定段 / 总长度）`);
    lines.push(`实际命中率: 请对照后台或 WM 缓存查看器`);
    lines.push('');

    const hasPre = preHistoryClusters.length > 0;
    const stablePost = postHistoryBlocks.filter(b => b.status === 'stable');
    const dynPost = postHistoryBlocks.filter(b => b.status === 'dynamic');
    const allPolluted = [];
    if (hasPre) {
        for (const c of preHistoryClusters) {
            for (let i = c.start; i <= c.end; i++) allPolluted.push(i);
        }
    }
    for (const b of stablePost) allPolluted.push(b.idx);

    if (allPolluted.length === 0) {
        lines.push('✅ 请求结构干净，污染块影响已降至最低。');
        lines.push('======================');
        return lines.join('\n');
    }

    lines.push(`⚠️ 请求结构被其他来源插入污染，请自检清除。`);
    lines.push(`污染块: ${allPolluted.map(i => '#' + i).join(', ')}`);
    if (dynPost.length > 0) {
        lines.push(`（另有 ${dynPost.length} 块动态内容如用户输入 / 含时间戳，正常无需处理）`);
    }
    lines.push('');
    lines.push('—— 污染来源（按常见度排序）——');
    lines.push('• 提示词预设：prompt_order 里的 user-role entry 排在 chat history 之后');
    lines.push('• 世界书条目：position 不是 before_character_definition + constant=true');
    lines.push('• 第三方扩展：JS-Slash-Runner / ST-Prompt-Template / Memory / Summary 等的动态注入');
    lines.push('');
    lines.push('—— CFS 已自动接管的部分 ——');
    lines.push('⚡ audit 检测 CFS 自管 entry 漂移 → 自动 setLorebookEntries 修复');
    lines.push('⚡ PETL 切卡 → 扫所有 enabled entry，含动态宏的强制改到 chat 末尾');
    lines.push('⚡ PSIS 切卡 → 三大块（数据库 / MVU / 动态注入）自动归零');
    lines.push('🛡 唯一豁免：entry comment 加 [cfs:ignore] → CFS 全模块永不动这条');
    lines.push('');
    lines.push('—— 你仍要手动处理的部分（CFS 管不到的来源）——');
    lines.push('① 提示词预设：prompt_order 错序 → ST 提示词管理器调 position 到 before_char');
    lines.push('② 第三方扩展动态注入（JS-Slash-Runner / ST-Prompt-Template / Memory / Summary）→ 关掉或限制其作用域');
    lines.push('③ 想保留某条目当前 position → comment 加 [cfs:ignore] 阻止 CFS 接管');
    lines.push('');

    // 详细块列表（pre-history 夹层 + post-history 段全部展示）
    if (hasPre) {
        for (const c of preHistoryClusters) {
            const s = Math.max(0, c.start - NEIGHBOR_CONTEXT);
            const e = Math.min(total - 1, c.end + NEIGHBOR_CONTEXT);
            for (let i = s; i <= e; i++) {
                const marker = (i >= c.start && i <= c.end) ? '  ← 污染' : '';
                lines.push(_formatBlockRow(i, latest[i], stability[i], marker));
            }
            lines.push('');
        }
    }
    if (postHistoryBlocks.length > 0) {
        for (const b of postHistoryBlocks) {
            const marker = b.status === 'stable' ? '  ← 污染' : '  ← 动态';
            lines.push(_formatBlockRow(b.idx, latest[b.idx], stability[b.idx], marker));
        }
        lines.push('');
    }

    lines.push('点上方「📋 复制全表」发给 AI 协助定位污染来源。');
    lines.push('======================');
    return lines.join('\n');
}

function _genFullOutput() {
    const a = _analyze();
    if (a.status === 'insufficient') return _genSimpleOutput();
    const latest = _ringBuffer[_ringBuffer.length - 1];
    const { stability, roundsCount, total } = a;
    const lines = [];
    lines.push(`=== 请求结构全表 (${total} 块 / ${roundsCount} 轮) ===`);
    for (let i = 0; i < total; i++) {
        lines.push(_formatBlockRow(i, latest[i], stability[i], ''));
    }
    lines.push('======================');
    return lines.join('\n');
}

function _currentChatId() {
    try {
        const ctx = (typeof SillyTavern !== 'undefined') && SillyTavern.getContext && SillyTavern.getContext();
        if (!ctx) return null;
        return (typeof ctx.getCurrentChatId === 'function') ? (ctx.getCurrentChatId() ?? null) : (ctx.chatId ?? null);
    } catch { return null; }
}

function _pushFromRealRequest(messages, sourceLabel) {
    try {
        if (!Array.isArray(messages) || messages.length < MIN_MAIN_CHAT_LEN) {
            if (_debugVerbose) console.log(`${TAG} ⊘ ${sourceLabel} chat ${messages?.length} 块 < ${MIN_MAIN_CHAT_LEN}，副请求跳过`);
            return;
        }

        // 切卡兜底：chatId 变化时清 ring buffer
        const cid = _currentChatId();
        if (cid !== null && _lastSeenChatId !== null && cid !== _lastSeenChatId) {
            _ringBuffer.length = 0;
            _lastPushedFingerprint = null;
            console.warn(`${TAG} ⚠ chatId 兜底 reset: ${_lastSeenChatId} → ${cid}（清掉 ring 重新计数）`);
        }
        _lastSeenChatId = cid;

        const blocks = messages.map((m, idx) => {
            const content = _stringifyContent(m && m.content);
            return {
                idx,
                role: (m && m.role) || 'unknown',
                len: content.length,
                hash: _fnv1a8(content),
                // 2026-06-22 v6.4 Drift Panel C 方案：存完整 content（128KB hard cap），给 diff-locate 反查算法用
                // 注：旧字段名 contentSlice 已废弃，统一改名 content；ring buffer 5 轮 × 平均 27 块 × ~5KB ≈ 700KB 内存可接受
                content: content.length > 131072 ? content.slice(0, 131072) : content,
            };
        });

        // fingerprint 去重：同一请求被 fetch hook 链多层重复触发时只 push 一次
        const fingerprint = _fnv1a8(blocks.map(b => b.role + ':' + b.hash).join('|'));
        if (fingerprint === _lastPushedFingerprint) {
            if (_debugVerbose) console.log(`${TAG} ⊘ 指纹重复 (fp=${fingerprint}) → skip`);
            return;
        }

        _ringBuffer.push(blocks);
        if (_ringBuffer.length > MAX_ROUNDS) _ringBuffer.shift();
        _lastPushedFingerprint = fingerprint;
        console.log(`${TAG} ↳ push 第 ${_ringBuffer.length}/${MAX_ROUNDS} 轮 (${blocks.length} 块, chatId=${cid}, source=${sourceLabel}, fp=${fingerprint})`);
    } catch (e) {
        console.warn(`${TAG} _pushFromRealRequest 失败`, e);
    }
}

// fetch hook：拦真实发出去的 LLM 请求，从 request body 提取 messages
//   - 启动探测 / 模板预编译 / dryRun token counting 不发 HTTP → 不被记
//   - 主请求 + 副请求都发 HTTP → 都被拦，靠 messages.length 阈值区分
//   - 与 WM 缓存查看器 / 别的扩展 fetch patch 是 chain 关系，互不破坏
let _fetchPatched = false;
function _installFetchHook() {
    if (_fetchPatched) {
        console.warn(`${TAG} ⊙ fetch hook 已存在，跳过重复安装`);
        return true;
    }
    try {
        if (typeof globalThis.fetch !== 'function') {
            console.warn(`${TAG} ✗ globalThis.fetch 不可用（typeof=${typeof globalThis.fetch}），无法安装 hook`);
            return false;
        }
        const _origFetch = globalThis.fetch;
        const _boundOrig = _origFetch.bind(globalThis);

        const patchedFetchForRSI = function patchedFetchForRSI(...args) {
            // ⚠️ 关键：所有逻辑严格只读不动 args，永远不 clone Request body。
            // 上一轮 input.clone().text() 会触发 Request body 的 ReadableStream tee'ing，
            // 在 ST/Tauri 流式响应链路下可能让 fetch 内部读 body 时拿到 disturbed stream，
            // 导致请求失败 / stream 中途被夹断。已确认 ST 全部走 init.body=string 模式。
            try {
                const input = args[0];
                const init = args[1];
                const url = typeof input === 'string' ? input : (input && input.url) || '';
                if (url && url.includes(TARGET_API_FRAGMENT)) {
                    if (init && typeof init.body === 'string') {
                        _extractAndPush(init.body, 'fetch');
                    } else if (_debugVerbose) {
                        console.warn(`${TAG} 拦到 ${TARGET_API_FRAGMENT} 但 init.body 非 string (typeof=${typeof init?.body})，跳过抓取`);
                    }
                }
            } catch (e) {
                if (_debugVerbose) console.warn(`${TAG} fetch hook 内部异常（已吞，不影响请求）`, e);
            }
            // 立即透传，不阻塞、不改 args
            return _boundOrig.apply(this, args);
        };

        // 尝试直接赋值（最常见路径）
        try {
            globalThis.fetch = patchedFetchForRSI;
        } catch (e1) {
            // fetch 被 freeze/non-writable → 用 defineProperty 强写
            console.warn(`${TAG} ⚠ globalThis.fetch 直接赋值失败 (${e1.message})，尝试 defineProperty`);
            try {
                Object.defineProperty(globalThis, 'fetch', { value: patchedFetchForRSI, writable: true, configurable: true });
            } catch (e2) {
                console.error(`${TAG} ✗ defineProperty 也失败 (${e2.message})，fetch hook 安装放弃`);
                return false;
            }
        }

        // 验证是否真的装上了
        if (globalThis.fetch !== patchedFetchForRSI) {
            console.error(`${TAG} ✗ fetch 赋值后未生效（可能被 Proxy 拦截 / 立即被其他扩展覆盖），hook 失败`);
            return false;
        }

        _fetchPatched = true;
        console.warn(`${TAG} ✅ fetch hook 已安装（拦 ${TARGET_API_FRAGMENT}），副请求/启动探测自动免疫`);
        return true;
    } catch (e) {
        console.error(`${TAG} ✗ _installFetchHook 顶层异常`, e);
        return false;
    }
}

function _extractAndPush(bodyStr, sourceLabel) {
    try {
        const json = JSON.parse(bodyStr);
        if (Array.isArray(json && json.messages)) {
            _pushFromRealRequest(json.messages, sourceLabel);
        }
    } catch {
        // 非 JSON body 忽略
    }
}

// CHAT_CHANGED 订阅作为切卡主动清除（fetch hook 内 chatId 兜底是 fallback）
function _onChatChanged(chatId) {
    const prevLen = _ringBuffer.length;
    const newCid = chatId ?? _currentChatId();
    // ⚠ ST 在很多场景 emit CHAT_CHANGED 但 chatId 实际没换（如保存 chat / 重命名等）—
    // 加 chatId 比对，仅真正换 chat 时才清，避免误触发
    if (prevLen === 0 && _lastSeenChatId === newCid) return;
    if (_lastSeenChatId === newCid && _lastSeenChatId !== null) {
        console.warn(`${TAG} ⊙ CHAT_CHANGED 触发但 chatId 未变 (${newCid})，跳过 reset`);
        return;
    }
    _ringBuffer.length = 0;
    _lastPushedFingerprint = null;
    _lastSeenChatId = newCid;
    console.warn(`${TAG} ⚠ CHAT_CHANGED reset: chatId=${newCid}（清掉 ${prevLen} 轮）`);
}

let _chatChangedBound = false;
function _bindChatChanged() {
    if (_chatChangedBound) return true;
    try {
        const ctx = (typeof SillyTavern !== 'undefined') && SillyTavern.getContext && SillyTavern.getContext();
        const es = ctx && ctx.eventSource;
        const ev = ctx && ctx.eventTypes;
        if (!es || typeof es.on !== 'function') return false;
        const nChatChanged = (ev && ev.CHAT_CHANGED) || 'chat_id_changed';
        es.on(nChatChanged, _onChatChanged);
        _chatChangedBound = true;
        console.log(`${TAG} 已订阅 ${nChatChanged}`);
        return true;
    } catch (e) {
        if (_debugVerbose) console.warn(`${TAG} CHAT_CHANGED 订阅失败，将重试`, e);
    }
    return false;
}

// 启动：fetch hook 立即装；CHAT_CHANGED 订阅等 ST context ready
console.warn(`${TAG} 🚀 rsi.js v2.0 模块加载中，开始安装 fetch hook ...`);
_installFetchHook();
if (!_bindChatChanged()) {
    setTimeout(() => { if (!_bindChatChanged()) setTimeout(_bindChatChanged, 3000); }, 1500);
}

// 调试日志开关：localStorage.setItem('cfs-suite/rsi_debug', '1') 后 F5 即开启
try {
    _debugVerbose = localStorage.getItem('cfs-suite/rsi_debug') === '1';
    if (_debugVerbose) console.log(`${TAG} 🔍 DEBUG 详细日志模式已启用`);
} catch {}

// L2 公共导出 — L1 post_history_pinner 复用同一份 history 识别算法
export function findHistoryRange(blocks) {
    return _findHistoryRange(blocks);
}

// === 2026-06-22 v6.4 Drift Panel · 当前角色 active worldbook 全套 entries ===
// 合并 character_book + primary worldbook + additional worldbooks
// 每个 entry 加 book 字段标识来源
// 容错：任何一层失败 → 跳过该层；全失败返回空数组
// Node 测试环境（无 TavernHelper）→ 返空数组（_lookupEntryByContent 见空数组直接 none，零误报）
async function _getActiveLoreEntries() {
    const out = [];
    let helper, ctx;
    try {
        helper = (typeof TavernHelper !== 'undefined') ? TavernHelper : (typeof window !== 'undefined' ? window.TavernHelper : null);
        ctx = (typeof SillyTavern !== 'undefined') && SillyTavern.getContext && SillyTavern.getContext();
    } catch {}
    if (!helper) {
        if (_debugVerbose) console.warn(`${TAG} _getActiveLoreEntries: TavernHelper 不可用`);
        return out;
    }

    // 1. character_book (卡内嵌 worldbook)
    try {
        const characters = ctx?.characters;
        const chid = ctx?.characterId;
        if (characters && chid != null && characters[chid]?.data?.character_book?.entries) {
            const charName = characters[chid].name || 'unknown';
            const cbName = `__character_book__${charName}`;
            for (const e of characters[chid].data.character_book.entries) {
                out.push({
                    book: cbName,
                    uid: e.uid ?? e.id ?? -1,
                    comment: e.comment || e.name || '',
                    content: e.content || '',
                    position: _normalizeEntryPosition(e),
                    depth: e.depth ?? 4,
                    enabled: e.enabled !== false && (e.disable !== true),
                });
            }
        }
    } catch (e) {
        if (_debugVerbose) console.warn(`${TAG} character_book 读取失败`, e);
    }

    // 2. primary + additional worldbooks
    try {
        const bind = await Promise.resolve(helper.getCharLorebooks({ name: 'current' }));
        const bookNames = [];
        if (bind?.primary) bookNames.push(bind.primary);
        if (Array.isArray(bind?.additional)) bookNames.push(...bind.additional);
        for (const bookName of bookNames) {
            try {
                const entries = await Promise.resolve(helper.getLorebookEntries(bookName));
                for (const e of (entries || [])) {
                    out.push({
                        book: bookName,
                        uid: e.uid ?? -1,
                        comment: e.comment || '',
                        content: e.content || '',
                        position: _normalizeEntryPosition(e),
                        depth: e.depth ?? 4,
                        enabled: e.enabled !== false,
                    });
                }
            } catch (e2) {
                if (_debugVerbose) console.warn(`${TAG} 读 worldbook "${bookName}" 失败`, e2);
            }
        }
    } catch (e) {
        if (_debugVerbose) console.warn(`${TAG} getCharLorebooks 失败`, e);
    }

    return out;
}

// 把 entry.position (数字/字符串) + depth 标准化成可读字符串
// 显示格式：'before_character_definition' / 'at_depth_as_user(depth=N)' 等
function _normalizeEntryPosition(e) {
    const p = e.position;
    if (typeof p === 'string') {
        if (p === 'at_depth_as_user' || p === 'at_depth_as_system' || p === 'at_depth_as_assistant') {
            return `${p}(depth=${e.depth ?? 4})`;
        }
        return p;
    }
    const numToStr = {
        0: 'before_character_definition',
        1: 'after_character_definition',
        2: 'before_author_note',
        3: 'after_author_note',
        4: `at_depth(depth=${e.depth ?? 4})`,
    };
    return numToStr[p] ?? `unknown(${p})`;
}

// === 2026-06-22 v6.4 Drift Panel · 主入口 findUnstableEntries ===
// 流程：
//   1. ring buffer ≥ 3 轮才可信 (insufficient 兜底)
//   2. 对每个 idx (pre-history 区) 算跨轮 hash 集合，size ≥ 2 即 unstable
//   3. 对每个 unstable idx：diff 定位变化区 → 上下文窗口 → 反查 entry
//   4. 返回候选列表 (single/multi/none 三种 matchType)
async function _findUnstableEntries(opts) {
    const N = _ringBuffer.length;
    if (N < 3) {
        return { status: 'insufficient', roundsCount: N, needed: 3 - N };
    }
    const latest = _ringBuffer[N - 1];
    const histRange = _findHistoryRange(latest);
    const prefixEnd = histRange.hasHistory ? histRange.start : latest.length;

    // 跨轮 hash 不一致 idx (≥3 轮观察, ≥2 个不同 hash)
    const unstableIdx = [];
    for (let i = 0; i < prefixEnd; i++) {
        const hashes = new Set();
        let observed = 0;
        for (let r = 0; r < N; r++) {
            if (i < _ringBuffer[r].length) {
                hashes.add(_ringBuffer[r][i].hash);
                observed++;
            }
        }
        if (observed >= 3 && hashes.size >= 2) {
            unstableIdx.push({ idx: i, distinctHashes: hashes.size, observedRounds: observed });
        }
    }
    if (unstableIdx.length === 0) {
        return { status: 'ok', roundsCount: N, candidates: [] };
    }

    // 拿 active entries（测试可注入 opts._testEntries）
    const entries = opts?._testEntries ?? await _getActiveLoreEntries();

    const candidates = [];
    for (const u of unstableIdx) {
        const blk = latest[u.idx];
        // 取该 idx 跨 N 轮的完整 content (容错：missing → 跳)
        const roundsContent = _ringBuffer
            .map(r => u.idx < r.length ? r[u.idx].content : null)
            .filter(c => typeof c === 'string');
        if (roundsContent.length < 2) continue;

        const { stablePrefixLen, stableSuffixLen } = _diffRoundsFindVariableRegions(roundsContent);
        const latestContent = blk.content || '';
        const window = _extractContextWindow(latestContent, stablePrefixLen, stableSuffixLen, 2048);
        const lookup = _lookupEntryByContent(window, entries);

        candidates.push({
            blockIdx: u.idx,
            role: blk.role,
            len: blk.len,
            distinctHashes: u.distinctHashes,
            observedRounds: u.observedRounds,
            stablePrefixLen,
            stableSuffixLen,
            variableLen: Math.max(0, latestContent.length - stablePrefixLen - stableSuffixLen),
            windowSize: window.length,
            matchType: lookup.matchType,
            hits: lookup.hits,
            fingerprint: lookup.fingerprint,
        });
    }

    return { status: 'ok', roundsCount: N, candidates };
}

// 2026-06-21 v6 阶段 D：drift candidates 给 PETL 漏扫补充
// 返回 postHistoryBlocks 中 status='dynamic' 的 contentSlice 数组
// PETL 拿这些 contentSlice 反查 worldbook entry：哪条 entry 的 content 含某 slice
// → 那条 entry 即为 PETL 漏扫的，下次 scan 时强制加入
// 容忍降级：ring buffer 没 contentSlice 字段（fixture / 老数据）返回空数组
function _getDriftCandidates() {
    if (_ringBuffer.length < 2) return [];
    const latest = _ringBuffer[_ringBuffer.length - 1];
    const a = _analyze();
    if (!a || !Array.isArray(a.postHistoryBlocks)) return [];
    const out = [];
    const seenHash = new Set();
    for (const b of a.postHistoryBlocks) {
        if (b.status !== 'dynamic') continue;
        const blk = latest[b.idx];
        if (!blk || !blk.contentSlice) continue;
        if (seenHash.has(blk.hash)) continue;
        seenHash.add(blk.hash);
        out.push({
            idx: b.idx,
            role: blk.role,
            hash: blk.hash,
            len: blk.len,
            contentSlice: blk.contentSlice,
        });
    }
    return out;
}
export function getDriftCandidates() { return _getDriftCandidates(); }

// 2026-06-22 v6.4 Drift Panel · 测试钩子（仅给单测用，业务不依赖）
export const __testHooks = {
    _stripMacros,
    _lookupEntryByContent,
    _longestCommonSubstrLen,
    _diffRoundsFindVariableRegions,
    _extractContextWindow,
    injectRingBuffer: (rb) => { _ringBuffer.length = 0; _ringBuffer.push(...rb); },
};

export const RSI = {
    _version: '2.2', // 2026-06-22 v6.4: Drift Panel — contentSlice 1024 + _stripMacros
    getRoundsCount: () => _ringBuffer.length,
    getLatest: () => _ringBuffer.length > 0 ? _ringBuffer[_ringBuffer.length - 1] : null,
    getRingBuffer: () => _ringBuffer, // L1 pinner 需要查上一轮做跨轮 hash 比对
    analyze: _analyze,
    findHistoryRange: _findHistoryRange,
    getDriftCandidates: _getDriftCandidates, // v6 阶段 D: PETL 漏扫补充入口
    getActiveLoreEntries: _getActiveLoreEntries, // v6.4 Drift Panel: 反查源数据
    findUnstableEntries: _findUnstableEntries,   // v6.4 Drift Panel: 主入口
    genSimpleOutput: _genSimpleOutput,
    genFullOutput: _genFullOutput,
    resetBuffer: () => { _ringBuffer.length = 0; },
};

_GLOBAL.CFS4.RSI = RSI;
