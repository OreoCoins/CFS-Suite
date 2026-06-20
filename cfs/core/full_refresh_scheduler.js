/**
 * CFS-Suite · core/full_refresh_scheduler.js
 *
 * Day 11 BUG 修：让「Full Refresh 每 N 轮一次」真按对话轮次计数。
 *
 * 旧方案漏洞（Day 9）：
 *   counter ++ 写在 applyInjection 内（real_takeover.js），但 applyInjection 全仓只在
 *   bootstrap / kernel 自愈 / 胶囊「启用接管」按钮三处主动调用，没有任何"每轮 LLM 主请求"
 *   的事件订阅。dynamic worldbook entry 写一次后 ST 自动每轮注入它的 content；applyInjection
 *   平时不跑 → counter ++ 永远到不了 N → 用户胶囊 UI 显示"已累计 0/N" 是真值。
 *
 * 新方案：
 *   订阅 ST 原生 `event_types.MESSAGE_RECEIVED`（每条 AI 回复完触发，type='normal' 才算）
 *   → counter ++ 写 LS
 *   → 满 N 时 await CFS4.InjectionStrategy.applyInjection({ force:true, fullRefresh:true })
 *   → counter 重置 0
 *
 * 为什么订阅 MESSAGE_RECEIVED 而非 GENERATE_AFTER_COMBINE_PROMPTS：
 *   后者在 prompt 构建末段触发，force apply 改 worldbook entry 与读取它的 prompt 构建器存在竞态。
 *   MESSAGE_RECEIVED 在本轮回复完成后触发，给下一轮 prompt 构建留足时间安全改 entry，
 *   可靠但延迟 1 轮（用户体感无差，日常 K=20/50 这个量级不敏感）。
 *
 * 配置：cfs-suite/full_refresh_interval LS key（0 = 关闭；>=1 = 每 N 轮触发一次）
 */

const TAG = '[CFS-Suite/full_refresh_scheduler]';
const LS_INTERVAL = 'cfs-suite/full_refresh_interval';
const LS_COUNTER = 'cfs-suite/full_refresh_counter';

function _getInterval() {
    try { return parseInt(localStorage.getItem(LS_INTERVAL) || '0', 10) || 0; }
    catch { return 0; }
}
function _getCounter() {
    try { return parseInt(localStorage.getItem(LS_COUNTER) || '0', 10) || 0; }
    catch { return 0; }
}
function _setCounter(n) {
    try { localStorage.setItem(LS_COUNTER, String(n)); } catch {}
}

async function _onMessageReceived(messageId, type) {
    // 只算 AI 回复 — 用户消息 / impersonate / edit / continue 都跳过
    // type 在 ST 不同版本可能未传；缺失时按 'normal' 兜底
    if (type && type !== 'normal') return;

    const interval = _getInterval();
    if (interval <= 0) return; // 关闭态

    let counter = _getCounter();
    counter++;

    if (counter >= interval) {
        counter = 0;
        _setCounter(counter);
        try {
            const IS = window.CFS4 && window.CFS4.InjectionStrategy;
            if (!IS || typeof IS.applyInjection !== 'function') {
                console.warn(`${TAG} applyInjection 不可用，跳过本轮 Full Refresh`);
                return;
            }
            console.log(`${TAG} 🔄 触发 Full Refresh (interval=${interval}, messageId=${messageId})`);
            await IS.applyInjection({ force: true, fullRefresh: true });
        } catch (e) {
            console.warn(`${TAG} Full Refresh 触发 applyInjection 失败`, e);
        }
    } else {
        _setCounter(counter);
    }
}

// 通过 SillyTavern.getContext() 拿 eventSource / event_types — 比相对路径 import 更稳
// （cfs/core/ 离 public/script.js 6 层 ..，多一层就破）
function _bindEvent() {
    try {
        const ctx = (typeof SillyTavern !== 'undefined') && SillyTavern.getContext && SillyTavern.getContext();
        const es = ctx && ctx.eventSource;
        const ev = ctx && ctx.eventTypes;
        const name = (ev && ev.MESSAGE_RECEIVED) || 'message_received';
        if (es && typeof es.on === 'function') {
            es.on(name, _onMessageReceived);
            console.log(`${TAG} 已订阅 ${name}`);
            return true;
        }
    } catch (e) {
        console.warn(`${TAG} 订阅失败，将重试`, e);
    }
    return false;
}

// 立即试一次；失败则等 APP_READY 后再试（兜底 ST context 延迟暴露）
if (!_bindEvent()) {
    setTimeout(() => { if (!_bindEvent()) setTimeout(_bindEvent, 3000); }, 1500);
}

export const FullRefreshScheduler = {
    _version: '1.0',
    getInterval: _getInterval,
    getCounter: _getCounter,
    setCounter: _setCounter,
};
