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
 *   1. 订阅 CHAT_COMPLETION_PROMPT_READY，每轮把 chat 数组算成 [{idx, role, len, hash}]
 *      存到 ring buffer（最多 5 轮，内存里，不进 LS）
 *   2. 跨轮对账 + 启发式识别 history 段，找 stable → dynamic → stable 的 interlayer cluster
 *   3. 给胶囊 panel 提供 simple/full 两种文本输出（panel 渲染 + 复制到剪贴板用）
 *
 * 关键算法：
 *   - History 段识别：从末尾反向扫，找连续段里 role∈{user,assistant} 占比 ≥80% 的最大窗口
 *     → 这段是 chat history（每轮 hash 会变是天然的，不当 dynamic 处理）
 *   - Prefix stable：从 idx=0 起，连续 hash 跨轮稳定的最长前缀
 *   - Interlayer cluster：prefix 之后 / history 之前的"连续 dynamic 段"
 *     stable→dynamic→stable 或 stable→dynamic→history 的 dynamic 区段
 *
 * 不接管 / 不修改 — 仅诊断 + 引导用户自行排查。
 */

const TAG = '[CFS-Suite/rsi]';
const MAX_ROUNDS = 5;
const HISTORY_OCCUPANCY_THRESHOLD = 0.8; // 末尾段中 user/assistant 占比 ≥ 80% 算 history
const HISTORY_MIN_LEN = 5;               // history 段至少 5 块（防短消息卡误判）
const NEIGHBOR_CONTEXT = 3;              // simple 输出 cluster ± 多少块周边

const _GLOBAL = (typeof window !== 'undefined') ? (window.parent || window) : {};
if (!_GLOBAL.CFS4) _GLOBAL.CFS4 = {};

const _ringBuffer = []; // 每项是一轮的 blocks 数组 [{idx, role, len, hash}, ...]

// 主请求 / 副请求判别：
//   ST 主 Generate() 流程：emit GENERATION_STARTED → ... → CHAT_COMPLETION_PROMPT_READY → ... → GENERATION_ENDED
//   generateRaw（CFS-MVU 副请求）：仅 emit CHAT_COMPLETION_PROMPT_READY，**不 emit** GENERATION_STARTED/ENDED
//   → 用 flag 守门：仅在 _mainGenActive=true 时抓快照
let _mainGenActive = false;
let _mainGenType = null;

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

// 找 history 段起始 idx — 从末尾反向，记录占比 ≥ HISTORY_OCCUPANCY_THRESHOLD 时的最大窗口起点
function _findHistoryStart(blocks) {
    const n = blocks.length;
    let userAsst = 0;
    let total = 0;
    let bestStart = n; // 没找到 = n (无 history)
    for (let i = n - 1; i >= 0; i--) {
        total++;
        const r = blocks[i].role;
        if (r === 'user' || r === 'assistant') userAsst++;
        if (total >= HISTORY_MIN_LEN && userAsst / total >= HISTORY_OCCUPANCY_THRESHOLD) {
            bestStart = i;
        }
    }
    return bestStart;
}

function _analyze() {
    const rounds = _ringBuffer;
    if (rounds.length < 2) {
        return { status: 'insufficient', roundsCount: rounds.length, needed: 2 - rounds.length };
    }
    const latest = rounds[rounds.length - 1];
    const total = latest.length;
    const N = rounds.length;

    const historyStart = _findHistoryStart(latest);

    // 对 idx ∈ [0, historyStart) 跨轮 hash 对账
    const stability = new Array(total);
    for (let i = 0; i < total; i++) {
        if (i >= historyStart) {
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

    // prefix stable end = idx 从 0 起最长连续 stable 段的 next idx
    let prefixStableEnd = 0;
    for (let i = 0; i < total; i++) {
        if (stability[i].status === 'stable') prefixStableEnd = i + 1;
        else break;
    }

    // interlayer clusters = prefix 之后 / history 之前 的连续 dynamic 段
    const clusters = [];
    let inCluster = false;
    let curStart = -1;
    for (let i = prefixStableEnd; i < historyStart; i++) {
        if (stability[i].status === 'dynamic') {
            if (!inCluster) { inCluster = true; curStart = i; }
        } else if (inCluster) {
            clusters.push({ start: curStart, end: i - 1 });
            inCluster = false;
        }
    }
    if (inCluster) clusters.push({ start: curStart, end: historyStart - 1 });

    // prefixStability 分母是「前缀段总块数」(historyStart)，不是 total — historyStart=0 时无意义
    const prefixStability = historyStart > 0 ? prefixStableEnd / historyStart : null;
    return {
        status: 'ok',
        roundsCount: N,
        total,
        historyStart,
        prefixStableEnd,
        prefixStability,
        stability,
        interlayerClusters: clusters,
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
        return `🔍 请求结构诊断 · 再发 ${a.needed} 条消息后开始判断（已看 ${a.roundsCount} 轮）`;
    }
    const latest = _ringBuffer[_ringBuffer.length - 1];
    const { total, interlayerClusters, stability, roundsCount } = a;
    const lines = [];
    lines.push('=== 请求结构诊断 ===');
    lines.push('');
    lines.push(`已看 ${roundsCount} 轮 · 共 ${total} 块`);
    lines.push('');
    if (interlayerClusters.length === 0) {
        lines.push('✅ 正常 — 未检测到动态注入夹层');
        lines.push('======================');
        return lines.join('\n');
    }
    const clusterDesc = interlayerClusters
        .map(c => c.start === c.end ? `#${c.start}` : `#${c.start}~${c.end}`)
        .join(', ');
    lines.push(`⚠️ 不正常 — 提示词预设存在动态注入：${clusterDesc}`);
    lines.push('');
    for (const c of interlayerClusters) {
        const start = Math.max(0, c.start - NEIGHBOR_CONTEXT);
        const end = Math.min(total - 1, c.end + NEIGHBOR_CONTEXT);
        for (let i = start; i <= end; i++) {
            const marker = (i >= c.start && i <= c.end) ? '  ← 夹层' : '';
            lines.push(_formatBlockRow(i, latest[i], stability[i], marker));
        }
        lines.push('');
    }
    lines.push('请点上方「📋 复制全表」，发给 AI 协助排障关闭对应动态注入功能。');
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

function _onPromptReady(eventData) {
    try {
        // 跳过 CFS-MVU / 其他 generateRaw 副请求：它们不走主 Generate() 流程，flag 不会被置位
        if (!_mainGenActive) return;
        // 跳过非主流程类型（impersonate / continue / swipe / regenerate / quiet）
        if (_mainGenType && _mainGenType !== 'normal' && _mainGenType !== undefined && _mainGenType !== null) return;
        const chat = eventData && eventData.chat;
        if (!Array.isArray(chat) || chat.length === 0) return;
        const blocks = chat.map((m, idx) => {
            const content = _stringifyContent(m && m.content);
            return {
                idx,
                role: (m && m.role) || 'unknown',
                len: content.length,
                hash: _fnv1a8(content),
            };
        });
        _ringBuffer.push(blocks);
        if (_ringBuffer.length > MAX_ROUNDS) _ringBuffer.shift();
    } catch (e) {
        console.warn(`${TAG} _onPromptReady 处理失败`, e);
    }
}

function _onGenerationStarted(type /* , options, dryRun */) {
    _mainGenActive = true;
    _mainGenType = type || 'normal';
}
function _onGenerationEnded(/* chatLength */) {
    _mainGenActive = false;
    _mainGenType = null;
}

// 通过 SillyTavern.getContext().eventSource 订阅 — 同 full_refresh_scheduler 思路
function _bindEvent() {
    try {
        const ctx = (typeof SillyTavern !== 'undefined') && SillyTavern.getContext && SillyTavern.getContext();
        const es = ctx && ctx.eventSource;
        const ev = ctx && ctx.eventTypes;
        if (!es || typeof es.on !== 'function') return false;
        const nPrompt = (ev && ev.CHAT_COMPLETION_PROMPT_READY) || 'chat_completion_prompt_ready';
        const nStart = (ev && ev.GENERATION_STARTED) || 'generation_started';
        const nEnd = (ev && ev.GENERATION_ENDED) || 'generation_ended';
        es.on(nPrompt, _onPromptReady);
        es.on(nStart, _onGenerationStarted);
        es.on(nEnd, _onGenerationEnded);
        console.log(`${TAG} 已订阅 ${nStart} / ${nPrompt} / ${nEnd}（副请求自动跳过）`);
        return true;
    } catch (e) {
        console.warn(`${TAG} 订阅失败，将重试`, e);
    }
    return false;
}

if (!_bindEvent()) {
    setTimeout(() => { if (!_bindEvent()) setTimeout(_bindEvent, 3000); }, 1500);
}

export const RSI = {
    _version: '1.0',
    getRoundsCount: () => _ringBuffer.length,
    getLatest: () => _ringBuffer.length > 0 ? _ringBuffer[_ringBuffer.length - 1] : null,
    analyze: _analyze,
    genSimpleOutput: _genSimpleOutput,
    genFullOutput: _genFullOutput,
    resetBuffer: () => { _ringBuffer.length = 0; },
};

_GLOBAL.CFS4.RSI = RSI;
