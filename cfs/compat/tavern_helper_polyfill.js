/**
 * CFS-Suite · TavernHelper polyfill 兼容层
 *
 * 原 CFS（Cache-Friendly Scanner v4.9.1）是酒馆助手脚本，在 iframe 内跑，靠
 * 酒馆助手注入的全局函数（eventOn / eventOnce / eventEmit / TavernHelper.*）
 * 工作。CFS Suite 作为 ST 原生第三方扩展直接在主 window 跑，没有这些函数。
 *
 * 策略：
 *   - 检测每个 API 是否已存在（酒馆助手共存时已注入 → 保留）
 *   - 不存在则用 ST 原生 API（eventSource / chat_metadata / etc.）按等价语义重写
 *   - 副作用挂到 window，让原 CFS 代码（IIFE 形态）原样 import 后继续工作
 *
 * Day 3 范围：仅 polyfill 微内核段实际依赖的 API（eventOn / Once / Emit / Off）。
 * worldbook / 变量层 polyfill 推迟到 Day 4（path_registry 接入时再写）。
 */

// 路径：从 CFS-Suite/cfs/compat/ 上跳 6 层到 public/script.js
import { eventSource } from '../../../../../../script.js';

const Tag = '[CFS-Suite/polyfill]';

/** 已挂的 polyfill 名列表（便于 F12 排查） */
const polyfilledApis = [];

/** 已存在则不覆盖；不存在则挂 impl 到 window 并记录 */
function _polyfillGlobal(name, impl) {
    if (typeof window[name] === 'function') return;
    window[name] = impl;
    polyfilledApis.push(name);
}

// ===== 事件层 polyfill =====
// 酒馆助手在 iframe 内提供 eventOn(name, handler) 等 4 个全局函数；
// 内部其实是 eventSource.on(...) 的转发。本 polyfill 同等替代。

_polyfillGlobal('eventOn', (eventName, handler) => {
    return eventSource.on(eventName, handler);
});

_polyfillGlobal('eventOnce', (eventName, handler) => {
    return eventSource.once(eventName, handler);
});

_polyfillGlobal('eventEmit', (eventName, ...args) => {
    return eventSource.emit(eventName, ...args);
});

_polyfillGlobal('eventOff', (eventName, handler) => {
    if (typeof eventSource.off === 'function') {
        return eventSource.off(eventName, handler);
    }
    if (typeof eventSource.removeListener === 'function') {
        return eventSource.removeListener(eventName, handler);
    }
    console.warn(`${Tag} eventOff: ST eventSource 既无 .off 也无 .removeListener，无法解绑 ${eventName}`);
});

// ===== TavernHelper 命名空间保护 =====
// 即使 Day 3 不 polyfill 任何 TavernHelper.* 方法，也要保证 window.TavernHelper
// 是个对象，避免原 CFS 代码访问 TavernHelper.xxx 时炸出 TypeError。

if (typeof window.TavernHelper !== 'object' || window.TavernHelper === null) {
    window.TavernHelper = {};
    polyfilledApis.push('TavernHelper (stub)');
}

// ===== Worldbook / 变量层 polyfill 占位 =====
// 这些在 Day 4 path_registry 接入时落地，当前保持未定义让真正用到的模块
// 在调用时报清晰错误，而不是静默吞。

if (polyfilledApis.length > 0) {
    console.log(`${Tag} ${polyfilledApis.length} 项已挂：${polyfilledApis.join(', ')}`);
}

export { polyfilledApis };
