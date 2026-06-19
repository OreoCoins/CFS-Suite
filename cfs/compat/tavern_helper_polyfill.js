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

// ===== getScriptId / 变量层 polyfill (Day 4) =====
// 原 CFS 在酒馆助手脚本里跑，靠 getScriptId() 拿酒馆助手脚本 UUID；script-level 变量
// 通过 getVariables({type:'script', script_id}) / updateVariablesWith(fn, opts) 持久化。
// ST 原生扩展环境用 localStorage 兜底，namespace 用固定 script_id。

const CFS_SUITE_SCRIPT_ID = 'cfs-suite-native-v5';
const LS_SCRIPT_VAR_PREFIX = 'cfs-suite/scriptvars/';

_polyfillGlobal('getScriptId', () => CFS_SUITE_SCRIPT_ID);

_polyfillGlobal('getVariables', (opts) => {
    try {
        if (!opts || opts.type === 'script') {
            const key = LS_SCRIPT_VAR_PREFIX + (opts?.script_id ?? CFS_SUITE_SCRIPT_ID);
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : {};
        }
        // 'chat' / 'message' 类型 — CFS 核心层不用，留空对象
        return {};
    } catch {
        return {};
    }
});

_polyfillGlobal('updateVariablesWith', (updater, opts) => {
    try {
        if (!opts || opts.type === 'script') {
            const key = LS_SCRIPT_VAR_PREFIX + (opts?.script_id ?? CFS_SUITE_SCRIPT_ID);
            const cur = JSON.parse(localStorage.getItem(key) || '{}');
            const next = updater(cur) ?? cur;
            localStorage.setItem(key, JSON.stringify(next));
        }
        // 其他 type 静默忽略
    } catch (e) {
        console.warn(`${Tag} updateVariablesWith 持久化失败`, e);
    }
});

_polyfillGlobal('insertOrAssignVariables', (vars, opts) => {
    try {
        const key = LS_SCRIPT_VAR_PREFIX + ((opts?.script_id) ?? CFS_SUITE_SCRIPT_ID);
        const cur = JSON.parse(localStorage.getItem(key) || '{}');
        const next = Object.assign(cur, vars ?? {});
        localStorage.setItem(key, JSON.stringify(next));
    } catch (e) {
        console.warn(`${Tag} insertOrAssignVariables 失败`, e);
    }
});

// ===== 酒馆助手「按钮注入」API noop (Day 5) =====
// 原 CFS v3.1.7 在 L1223 用 getButtonEvent('xxx') 注册「🛡️ MVU 守护」按钮到聊天输入框旁。
// ST 原生扩展环境没这些函数；CFS-Suite 用浮动胶囊替代。给 noop 让 PSIS 主 IIFE 别中断。

_polyfillGlobal('getButtonEvent', (button_name) => {
    // 返回稳定字符串（CFS 用作 event_id）
    return `cfs-suite-btn::${button_name || 'unnamed'}`;
});

_polyfillGlobal('eventOnButton', (button_name, handler) => {
    // noop — 按钮在原生扩展里不存在，handler 永远不触发
    void button_name; void handler;
});

_polyfillGlobal('appendInexistentScriptButtons', (buttons) => {
    // noop — 同上，不创建任何 ST UI 按钮
    void buttons;
});

_polyfillGlobal('getScriptName', () => 'cfs-suite-native');

// ===== Worldbook polyfill (Day 5) =====
// 这些在 path_registry / TavernHelper.* lorebook 实际用到时再写，
// 当前保持未定义让真正用到的模块在调用时报清晰错误，而不是静默吞。

if (polyfilledApis.length > 0) {
    console.log(`${Tag} ${polyfilledApis.length} 项已挂：${polyfilledApis.join(', ')}`);
}

export { polyfilledApis };
