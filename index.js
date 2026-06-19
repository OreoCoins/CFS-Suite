/**
 * CFS-Suite · 主入口（Day 4a）
 *
 * ESM 加载链（保证依赖顺序）：
 *   cfs/compat/tavern_helper_polyfill.js  ← 副作用挂全局
 *     ↓
 *   cfs/core/statdata_engine.js           ← CFS4 全局 init（EVENTS / NS / loadConfig）
 *     ↓
 *   cfs/core/schema_layer.js              ← SFL + SSG
 *     ↓
 *   cfs/core/path_registry.js             ← SchemaResolver + PathRegistry
 *     ↓
 *   cfs/core/diff_engine.js               ← Diff Engine 三态机
 *     ↓
 *   cfs/core/injection_strategy.js        ← PresenceEncoder + InjectionStrategy + STABLE_BATCH
 *     ↓
 *   cfs/core/fallback_strategy.js         ← FallbackStrategy + HealthMonitor
 *     ↓
 *   cfs/core/real_takeover.js             ← bootstrapTakeover + autoBootstrap
 *     ↓
 *   cfs/core/kernel.js                    ← SessionGate + Coordinator + NotificationCenter
 *
 * Day 4a 范围：核心层 v4.x 全套（除 SEM/PSIS+ 在 Day 5）。
 * Day 4b 范围：CFS-MVU 改动 #4 cfs_hooks / #5 exclusive_mode / #6 _cfsEdition。
 *
 * 验证策略（双套并存风险缓解）：
 *   - 装上 Day 4a 后**先在酒馆助手里禁用 CFS Solo 脚本**，再 F5 看 CFS-Suite 单跑
 *   - Day 4b silent disable CFS Solo 之前，并存会双触发 audit/注入
 */

import { eventSource, event_types } from '../../../../script.js';

// ⚠️ CFS-MVU bundle 加载暂时禁用（spec 路线重审中）
// 现状：bundle 是酒馆助手专用格式，依赖一堆酒馆助手特有 API（getTavernHelperVersion /
//   getButtonEvent / SillyTavern.saveChat / eventEmit 全套 ~30+ 个），polyfill 补不完。
// 决策：等用户拍板新方案 — fork ST 原生 MVU 扩展 / 让 MVU 仍走酒馆助手脚本 / 重写为原生扩展
// 详见：D:\Silly\LOG\2026-06-19-cfs-mvu-route-rethink.md（待写）
// 当前：CFS-Suite 仍跑 16 项 v4.x 接管层 + 浮动胶囊；MVU 用户自管（酒馆助手脚本/卡级 MVU）
// import('./cfs-mvu/bundle.js') ... 已禁用

console.log('[CFS-Suite] cfs-mvu/bundle.js 加载已暂禁 — 等待 MVU 路线重审');

// 完整加载链（importing kernel.js 会链式拉起其他依赖）
import { Coordinator, SessionGate, NotificationCenter } from './cfs/core/kernel.js';
// Real Takeover 不挂独立 CFS4.RealTakeover，而是 attach 到 CFS4.InjectionStrategy。
// 用 import 拿 ESM export 的判据对象（基于 IIFE 完成 flag），不查 window.CFS4.RealTakeover。
import { RealTakeover } from './cfs/core/real_takeover.js';
// Day 5：v3.1.7 PSIS R1 主程序 + v4.9.1 SEM + v4.9.3 PSIS+
// PSIS 必须在 PSIS+ 之前 import（PSIS+ 是补丁层）
import { PSIS } from './cfs/modules/psis.js';
import { SEM } from './cfs/modules/sem.js';
import { PSISPlus } from './cfs/modules/psis_plus.js';
// Day 4 附加 UI：右下角浮动胶囊 + 折叠面板（完整 panel.js 留 Day 6）
import './cfs/ui/floating_capsule.js';

const TAG = '[CFS-Suite]';
const VERSION = '5.0.0-day6';

console.log(`${TAG} v${VERSION} loading...`);

eventSource.once(event_types.APP_READY, () => {
    const status = {
        // Core kernel
        SessionGate: !!SessionGate,
        Coordinator: !!Coordinator,
        NotificationCenter: !!NotificationCenter,
        // v4.x 完整模块
        SchemaFrozenLayer: !!window.CFS4?.SchemaFrozenLayer,
        SchemaSwapGate: !!window.CFS4?.SchemaSwapGate,
        SchemaResolver: !!window.CFS4?.SchemaResolver,
        PathRegistry: !!window.CFS4?.PathRegistry,
        DiffEngine: !!window.CFS4?.DiffEngine,
        PresenceEncoder: !!window.CFS4?.PresenceEncoder,
        InjectionStrategy: !!window.CFS4?.InjectionStrategy,
        FallbackStrategy: !!window.CFS4?.FallbackStrategy,
        HealthMonitor: !!window.CFS4?.HealthMonitor,
        RealTakeover: !!RealTakeover,
        // Day 5 — modules 层
        PSIS: !!PSIS,
        SEM: !!SEM,
        PSISPlus: !!PSISPlus,
        // CFSMvuBundle 检查暂时移除（bundle 加载已禁用，等 MVU 路线重审）
        CFS4Version: window.CFS4?.version,
        MvuExists: !!window.Mvu,
        MvuCfsEdition: window.Mvu?._cfsEdition?.version ?? '<不是 CFS-MVU>',
    };
    console.log(`${TAG} APP_READY confirmed`, status);

    const allReady = Object.entries(status)
        .filter(([k]) => k !== 'CFS4Version' && k !== 'MvuCfsEdition' && k !== 'MvuExists')
        .every(([, v]) => v);

    if (typeof toastr !== 'undefined') {
        if (allReady) {
            const mountedCount = Object.values(status).filter(v => v === true).length;
            toastr.success(
                `CFS Suite v${VERSION} — v4.x 完整模块（${mountedCount} 项）已挂载`,
                'CFS-Suite',
                { timeOut: 6000 },
            );
        } else {
            const missing = Object.entries(status)
                .filter(([k, v]) => k !== 'CFS4Version' && k !== 'MvuCfsEdition' && k !== 'MvuExists' && !v)
                .map(([k]) => k);
            toastr.error(
                `CFS Suite v${VERSION} — 加载异常，缺：${missing.join(', ')}（看 F12）`,
                'CFS-Suite',
                { timeOut: 10000 },
            );
        }
    }
});
