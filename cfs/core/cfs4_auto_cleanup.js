/**
 * CFS-Suite · core/cfs4_auto_cleanup.js
 *
 * 2026-06-23 v6.4: 启动期静默清除 [CFS4_AUTO] 标签
 *
 * 历史背景:
 *   PETL v6.x (现已砍掉) 切卡自动接管 worldbook entries 时会在 entry.comment 前加
 *   `[CFS4_AUTO]` 前缀。v6.4 砍 PETL 后这些标签变成残留标记，需要清掉让用户看到
 *   entries 名称恢复原貌。
 *
 * 处理范围:
 *   - ✅ 独立 worldbook entries（通过 TavernHelper.setLorebookEntries 改 comment）
 *   - ❌ character_book entries（卡内嵌 worldbook）— 涉及角色卡 PNG 写盘，
 *        v6.x PETL 已做过的 character_book 破坏需要用户删卡重导。
 *        卡可以重导，聊天存档不丢。详情见 README v6.4 发布说明。
 *
 * 行为:
 *   - 只删 comment 中的 `[CFS4_AUTO]` 子串 + 紧邻空格
 *   - 不改 entry.position/depth/constant/role 等其他字段
 *   - 不删 entry 本身
 *   - 启动后等 ST APP_READY + 切卡 + 2 秒 debounce 触发一次
 *   - 完成后 toastr 通知 + LS 写一次性 flag 避免重复扫
 *   - 用户主动清 LS flag (cfs-suite/cleanup_v6_4_done) 可强制再扫
 */

const TAG = '[CFS-Suite/cleanup-v6.4]';
const LS_DONE_FLAG = 'cfs-suite/cleanup_v6_4_done';
const CFS4_AUTO_TAG_RE = /\s*\[CFS4_AUTO\]\s*/g;

const _GLOBAL = (typeof window !== 'undefined') ? (window.parent || window) : {};

function _isAlreadyDone() {
    try { return localStorage.getItem(LS_DONE_FLAG) === '1'; }
    catch { return false; }
}

function _markDone() {
    try { localStorage.setItem(LS_DONE_FLAG, '1'); } catch {}
}

async function _cleanupAllWorldbooks() {
    let helper;
    try {
        helper = (typeof TavernHelper !== 'undefined') ? TavernHelper : (_GLOBAL && _GLOBAL.TavernHelper);
    } catch {}
    if (!helper || typeof helper.getCharLorebooks !== 'function' || typeof helper.setLorebookEntries !== 'function') {
        console.warn(TAG, 'TavernHelper 不可用，跳过');
        return { cleanedCount: 0, books: [], skipped: 'no_helper' };
    }

    let bind;
    try { bind = await Promise.resolve(helper.getCharLorebooks({ name: 'current' })); }
    catch (e) {
        console.warn(TAG, 'getCharLorebooks 失败:', e);
        return { cleanedCount: 0, books: [], skipped: 'no_char' };
    }

    const bookNames = [];
    if (bind && bind.primary) bookNames.push(bind.primary);
    if (bind && Array.isArray(bind.additional)) {
        for (const n of bind.additional) {
            if (n && bookNames.indexOf(n) < 0) bookNames.push(n);
        }
    }
    if (bookNames.length === 0) {
        return { cleanedCount: 0, books: [], skipped: 'no_books' };
    }

    let totalCleaned = 0;
    const cleanedPerBook = {};
    for (const bookName of bookNames) {
        let entries;
        try { entries = await Promise.resolve(helper.getLorebookEntries(bookName)); }
        catch (e) {
            console.warn(TAG, `读 worldbook "${bookName}" 失败:`, e);
            continue;
        }
        if (!Array.isArray(entries) || entries.length === 0) continue;

        const patches = [];
        for (const e of entries) {
            if (!e || typeof e.comment !== 'string') continue;
            if (!CFS4_AUTO_TAG_RE.test(e.comment)) {
                CFS4_AUTO_TAG_RE.lastIndex = 0;
                continue;
            }
            CFS4_AUTO_TAG_RE.lastIndex = 0;
            const newComment = e.comment.replace(CFS4_AUTO_TAG_RE, ' ').trim();
            if (newComment === e.comment) continue;
            patches.push({ uid: e.uid, comment: newComment });
        }
        if (patches.length === 0) continue;

        try {
            await Promise.resolve(helper.setLorebookEntries(bookName, patches));
            cleanedPerBook[bookName] = patches.length;
            totalCleaned += patches.length;
            console.log(TAG, `已清 ${patches.length} 条 [CFS4_AUTO] 标签 from "${bookName}"`);
        } catch (e) {
            console.warn(TAG, `写回 "${bookName}" 失败:`, e);
        }
    }

    return { cleanedCount: totalCleaned, books: cleanedPerBook };
}

async function _runCleanup(opts) {
    opts = opts || {};
    if (!opts.force && _isAlreadyDone()) {
        if (opts.verbose) console.log(TAG, '已跑过 (LS flag), 跳过');
        return { skipped: 'already_done' };
    }

    try {
        const result = await _cleanupAllWorldbooks();
        if (result.skipped) {
            console.log(TAG, '跳过原因:', result.skipped);
            return result;
        }
        if (result.cleanedCount > 0) {
            console.log(TAG, `✅ 清理完成: ${result.cleanedCount} 条 entry 移除 [CFS4_AUTO] 标签`, result.books);
            // 2026-06-23 用户拍板：CFS toast 已经太多，cleanup 完全静默，只 console.log
        } else {
            console.log(TAG, '✓ 无需清理 (没有 [CFS4_AUTO] 标签)');
        }
        _markDone();
        return result;
    } catch (e) {
        console.warn(TAG, '清理异常:', e);
        return { error: e && e.message };
    }
}

// 启动期触发：等 ST APP_READY + 2.5s debounce (晚于其他模块 bootstrap)
let _cleanupScheduled = false;
function _scheduleCleanup() {
    if (_cleanupScheduled) return;
    _cleanupScheduled = true;
    let triggered = false;
    const runOnce = () => {
        if (triggered) return;
        triggered = true;
        setTimeout(() => { _runCleanup({ verbose: true }); }, 2500);
    };
    try {
        const ctx = (typeof SillyTavern !== 'undefined') && SillyTavern.getContext && SillyTavern.getContext();
        const es = ctx && ctx.eventSource;
        const ev = ctx && ctx.eventTypes;
        if (es && typeof es.once === 'function' && ev && ev.APP_READY) {
            es.once(ev.APP_READY, runOnce);
        } else {
            setTimeout(runOnce, 6000);
        }
    } catch {
        setTimeout(runOnce, 6000);
    }
}
_scheduleCleanup();

// 暴露给 F12 手动触发: window.CFS4.cleanupV64.run({force:true})
if (_GLOBAL) {
    if (!_GLOBAL.CFS4) _GLOBAL.CFS4 = {};
    _GLOBAL.CFS4.cleanupV64 = {
        run: (opts) => _runCleanup(opts || {}),
        isDone: _isAlreadyDone,
        clearFlag: () => { try { localStorage.removeItem(LS_DONE_FLAG); } catch {} },
    };
}

console.log(TAG, 'v6.4 启动清理模块已挂载 (APP_READY 后自动跑一次)');
