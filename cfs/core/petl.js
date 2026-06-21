/**
 * CFS-Suite · core/petl.js
 *
 * v6.0 PETL · Prompt Entry Takeover Layer
 *
 * 切卡 / APP_READY 自动扫所有 enabled entry，识别动态宏 → 强制 setLorebookEntries
 * 改 position 到 at_depth_as_user/depth=0。霸王条款，不弹确认。
 *
 * 用户唯一豁免：entry comment 加 [cfs:ignore] 标记 → PETL 永不动该条目。
 * CFS 自管 entry（comment 前缀 [CFS4_）由 kernel.js audit 单独管理，PETL 跳过。
 *
 * 复用 PSIS 识别 patterns（window.CFS4.PSISPatterns，由 psis.js 暴露）：
 *   - DYNAMIC_PATTERNS：{{X::params}} / EJS / {{lastusermessage}} 等
 *   - MVU_PATTERNS：mvu_update / initvar / JSONPatch / 元叙述标签等
 *
 * 持久化：localStorage cfs-suite/petl_history_v1 保留最近 50 次修复记录，支持 rollbackLast。
 */

// 注意：不静态 import polyfill / psis — 它们由 index.js 主链路保证已加载
//   PETL 完全靠 runtime 全局 lookup（window.CFS4.PSISPatterns / TavernHelper / eventOn / toastr）
//   好处：node 烟测可直接 mock 全局 import 不炸（参考 rsi.js / post_history_pinner.js 模式）

const TAG = '[CFS-Suite/petl]';
const VERSION = '6.0.0';
const LS_TOGGLE = 'cfs-suite/petl_auto_takeover';
const LS_HISTORY = 'cfs-suite/petl_history_v1';
const PETL_BOOTSTRAP_DELAY_MS = 5000;
const PETL_CHAT_CHANGE_DELAY_MS = 1500;
const FIX_POSITION = 'at_depth_as_user';
const FIX_DEPTH = 0;
const CFS4_PREFIX = '[CFS4_';
const IGNORE_TAG = '[cfs:ignore]';
const HISTORY_MAX = 50;

const _GLOBAL = (typeof window !== 'undefined' && window.parent) ? window.parent : (typeof window !== 'undefined' ? window : null);

function _isEnabled() {
    try { return localStorage.getItem(LS_TOGGLE) !== '0'; } catch (e) { return true; }
}
function _setEnabled(b) {
    try { localStorage.setItem(LS_TOGGLE, b ? '1' : '0'); } catch (e) {}
}

function _readHistory() {
    try { return JSON.parse(localStorage.getItem(LS_HISTORY) || '[]'); } catch (e) { return []; }
}
function _writeHistory(arr) {
    try { localStorage.setItem(LS_HISTORY, JSON.stringify(arr.slice(-HISTORY_MAX))); } catch (e) {}
}
function _appendHistory(rec) {
    const list = _readHistory();
    list.push(rec);
    _writeHistory(list);
}

function _matchAny(s, patterns) {
    if (!s || !Array.isArray(patterns)) return false;
    for (let i = 0; i < patterns.length; i++) {
        try { if (patterns[i].test(s)) return true; } catch (e) {}
    }
    return false;
}
function _hasDynamicMarker(content) {
    const ps = _GLOBAL && _GLOBAL.CFS4 && _GLOBAL.CFS4.PSISPatterns;
    if (!ps) return false;
    return _matchAny(content, ps.DYNAMIC) || _matchAny(content, ps.MVU);
}

function _isAlreadyAtChatEnd(entry) {
    const p = entry.position;
    const okPos = (p === FIX_POSITION) || (p === 4);
    const okDepth = (entry.depth === FIX_DEPTH) || (entry.depth == null);
    return okPos && okDepth;
}

async function _readLorebookEntries(lorebookName, helper) {
    try {
        return await Promise.resolve(helper.getLorebookEntries(lorebookName));
    } catch (e) {
        console.warn(TAG, '读 worldbook "' + lorebookName + '" 失败:', e);
        return [];
    }
}

async function scanAndTakeover(opts) {
    opts = opts || {};
    const triggeredBy = opts.triggeredBy || 'unknown';
    if (!opts.force && !_isEnabled()) {
        if (!opts.silent) console.log(TAG, '已通过 LS toggle 禁用，跳过 (triggeredBy=' + triggeredBy + ')');
        return { skipped: true, reason: 'disabled' };
    }
    const helper = (typeof TavernHelper !== 'undefined') ? TavernHelper : (_GLOBAL && _GLOBAL.TavernHelper);
    if (!helper || !helper.getCharLorebooks || !helper.getLorebookEntries || !helper.setLorebookEntries) {
        console.warn(TAG, 'TavernHelper 不可用，跳过');
        return { skipped: true, reason: 'no_helper' };
    }

    let bind;
    try { bind = await Promise.resolve(helper.getCharLorebooks({ name: 'current' })); }
    catch (e) { console.warn(TAG, 'getCharLorebooks 失败:', e); return { skipped: true, reason: 'no_char' }; }
    if (!bind) return { skipped: true, reason: 'no_bind' };

    const names = [];
    if (bind.primary) names.push(bind.primary);
    if (Array.isArray(bind.additional)) {
        for (let i = 0; i < bind.additional.length; i++) {
            const n = bind.additional[i];
            if (n && names.indexOf(n) < 0) names.push(n);
        }
    }
    if (names.length === 0) {
        if (!opts.silent) console.log(TAG, '当前卡无 worldbook，跳过');
        return { skipped: true, reason: 'no_wb' };
    }

    const groupedByBook = {};
    let totalCandidates = 0;
    const skipped = { ignore: 0, cfs4: 0, disabled: 0, position_ok: 0, no_marker: 0 };

    for (let i = 0; i < names.length; i++) {
        const lb = names[i];
        const entries = await _readLorebookEntries(lb, helper);
        if (!Array.isArray(entries) || entries.length === 0) continue;
        for (let j = 0; j < entries.length; j++) {
            const e = entries[j];
            if (!e) continue;
            if (e.enabled === false) { skipped.disabled++; continue; }
            const comment = typeof e.comment === 'string' ? e.comment : '';
            if (comment.indexOf(IGNORE_TAG) >= 0) { skipped.ignore++; continue; }
            if (comment.indexOf(CFS4_PREFIX) === 0) { skipped.cfs4++; continue; }
            if (_isAlreadyAtChatEnd(e)) { skipped.position_ok++; continue; }
            const content = typeof e.content === 'string' ? e.content : '';
            if (!_hasDynamicMarker(content) && !_hasDynamicMarker(comment)) { skipped.no_marker++; continue; }

            if (!groupedByBook[lb]) groupedByBook[lb] = { patches: [], snapshots: [] };
            groupedByBook[lb].patches.push({
                uid: e.uid,
                position: FIX_POSITION,
                depth: FIX_DEPTH,
            });
            groupedByBook[lb].snapshots.push({
                uid: e.uid,
                comment: comment.slice(0, 120),
                oldPosition: e.position,
                oldDepth: e.depth == null ? null : e.depth,
            });
            totalCandidates++;
        }
    }

    if (totalCandidates === 0) {
        if (!opts.silent) console.log(TAG, '⚡ 无需接管 (triggeredBy=' + triggeredBy + ', skipped=' + JSON.stringify(skipped) + ')');
        return { applied: 0, candidates: 0, skipped };
    }

    if (opts.dryRun === true) {
        console.log(TAG, '🔬 dryRun: 候选 ' + totalCandidates + ' 条 (triggeredBy=' + triggeredBy + ')');
        return { applied: 0, candidates: totalCandidates, dryRun: true, groupedByBook, skipped };
    }

    let appliedTotal = 0;
    const failedBooks = [];
    const historyRec = {
        ts: Date.now(),
        triggered_by: triggeredBy,
        books: {},
    };
    const lbs = Object.keys(groupedByBook);
    for (let i = 0; i < lbs.length; i++) {
        const lb = lbs[i];
        const g = groupedByBook[lb];
        try {
            await Promise.resolve(helper.setLorebookEntries(lb, g.patches));
            appliedTotal += g.patches.length;
            historyRec.books[lb] = g.snapshots;
        } catch (e) {
            console.warn(TAG, 'setLorebookEntries 写回 "' + lb + '" 失败:', e);
            failedBooks.push({ lb, error: e && e.message });
        }
    }

    if (appliedTotal > 0) {
        _appendHistory(historyRec);
        console.log(TAG, '⚡ 已自动接管 ' + appliedTotal + ' 条动态注入 entry → ' + FIX_POSITION + '/depth=0 (triggeredBy=' + triggeredBy + ')');
        try {
            if (typeof toastr !== 'undefined' && toastr.success) {
                toastr.success('⚡ CFS PETL 已接管 ' + appliedTotal + ' 条动态注入 entry → chat 末尾。详情→ 浮动胶囊 PETL 记录',
                    'CFS-Suite v6 PETL', { timeOut: 8000 });
            }
        } catch (_eToast) {}
    }
    return { applied: appliedTotal, candidates: totalCandidates, failedBooks, skipped };
}

let _bootstrapTimer = null;
function _scheduleBootstrap() {
    if (_bootstrapTimer) return;
    _bootstrapTimer = setTimeout(() => {
        _bootstrapTimer = null;
        scanAndTakeover({ triggeredBy: 'bootstrap' })
            .catch(e => console.warn(TAG, 'bootstrap 异常', e));
    }, PETL_BOOTSTRAP_DELAY_MS);
}

let _chatChangeTimer = null;
function _scheduleChatChangeRun() {
    if (_chatChangeTimer) clearTimeout(_chatChangeTimer);
    _chatChangeTimer = setTimeout(() => {
        _chatChangeTimer = null;
        scanAndTakeover({ triggeredBy: 'chat_id_changed' })
            .catch(e => console.warn(TAG, 'chat_id_changed 异常', e));
    }, PETL_CHAT_CHANGE_DELAY_MS);
}

// 订阅 chat_id_changed
try {
    if (typeof eventOn === 'function') {
        eventOn('chat_id_changed', _scheduleChatChangeRun);
        console.log(TAG, '已订阅 chat_id_changed (debounce ' + PETL_CHAT_CHANGE_DELAY_MS + 'ms)');
    } else {
        console.warn(TAG, 'eventOn 不可用，chat_id_changed 未订阅');
    }
} catch (e) {
    console.warn(TAG, 'chat_id_changed 订阅失败:', e);
}

// APP_READY 兜底：覆盖启动时已加载的会话
_scheduleBootstrap();

async function rollbackLast() {
    const helper = (typeof TavernHelper !== 'undefined') ? TavernHelper : (_GLOBAL && _GLOBAL.TavernHelper);
    if (!helper || !helper.setLorebookEntries) return { reverted: 0, reason: 'no_helper' };
    const list = _readHistory();
    if (list.length === 0) return { reverted: 0, reason: 'no_history' };
    const last = list[list.length - 1];
    let revertedTotal = 0;
    const bookNames = Object.keys(last.books || {});
    for (let i = 0; i < bookNames.length; i++) {
        const lb = bookNames[i];
        const snaps = last.books[lb];
        const patches = snaps.map(s => ({
            uid: s.uid,
            position: s.oldPosition,
            depth: s.oldDepth == null ? 0 : s.oldDepth,
        }));
        try {
            await Promise.resolve(helper.setLorebookEntries(lb, patches));
            revertedTotal += patches.length;
        } catch (e) {
            console.warn(TAG, '回滚 "' + lb + '" 失败:', e);
        }
    }
    _writeHistory(list.slice(0, -1));
    console.log(TAG, '↩ 已回滚最近一次接管: ' + revertedTotal + ' 条');
    try {
        if (typeof toastr !== 'undefined' && toastr.info) {
            toastr.info('↩ CFS PETL 已回滚 ' + revertedTotal + ' 条 entry 位置到接管前', 'CFS-Suite PETL', { timeOut: 5000 });
        }
    } catch (_e) {}
    return { reverted: revertedTotal };
}

export const PETL = {
    _version: VERSION,
    isEnabled: _isEnabled,
    setEnabled: _setEnabled,
    runNow: () => scanAndTakeover({ triggeredBy: 'manual' }),
    scanDryRun: () => scanAndTakeover({ triggeredBy: 'dry_run', dryRun: true }),
    getHistory: _readHistory,
    rollbackLast,
    clearHistory: () => { _writeHistory([]); return { cleared: true }; },
    // 内部 helpers 暴露给单测用
    _internals: {
        hasDynamicMarker: _hasDynamicMarker,
        isAlreadyAtChatEnd: _isAlreadyAtChatEnd,
        matchAny: _matchAny,
    },
};

if (_GLOBAL) {
    if (!_GLOBAL.CFS4) _GLOBAL.CFS4 = {};
    _GLOBAL.CFS4.PETL = PETL;
}

console.log(TAG + ' v' + VERSION + ' loaded (toggle LS=' + LS_TOGGLE + '=' + (_isEnabled() ? 'ON' : 'OFF') + ')');
