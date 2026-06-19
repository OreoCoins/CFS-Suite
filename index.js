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
// 完整加载链（importing kernel.js 会链式拉起其他依赖）
import { Coordinator, SessionGate, NotificationCenter } from './cfs/core/kernel.js';
import './cfs/core/real_takeover.js';

const TAG = '[CFS-Suite]';
const VERSION = '5.0.0-day4a';

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
        RealTakeover: !!window.CFS4?.RealTakeover,
        CFS4Version: window.CFS4?.version,
    };
    console.log(`${TAG} APP_READY confirmed`, status);

    const allReady = Object.entries(status)
        .filter(([k]) => k !== 'CFS4Version')
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
                .filter(([k, v]) => k !== 'CFS4Version' && !v)
                .map(([k]) => k);
            toastr.error(
                `CFS Suite v${VERSION} — 加载异常，缺：${missing.join(', ')}（看 F12）`,
                'CFS-Suite',
                { timeOut: 10000 },
            );
        }
    }
});
