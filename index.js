/**
 * CFS-Suite · 主入口
 *
 * 加载顺序：
 *   1. polyfill 副作用：./cfs/compat/tavern_helper_polyfill.js 在 import kernel.js 时被链式 import，
 *      把 eventOn / eventOnce / eventEmit / eventOff + TavernHelper stub 挂到 window
 *   2. kernel.js 把 SessionGate / Coordinator / NotificationCenter 装到 window.CFS4.*
 *      并 export 给本文件命名空间
 *   3. APP_READY 触发后，console + toast 报告核心层挂载情况
 *
 * Day 3 范围：仅核心层 3 模块；Day 4 加 Schema Frozen Layer / Schema Swap Gate /
 * Path Registry / Injection Strategy + 改动 #4 #5 #6（cfs_hooks / exclusive_mode / _cfsEdition）。
 */

import { eventSource, event_types } from '../../../../script.js';
import { Coordinator, SessionGate, NotificationCenter } from './cfs/core/kernel.js';

const TAG = '[CFS-Suite]';
const VERSION = '5.0.0-day3';

console.log(`${TAG} v${VERSION} loading...`);

eventSource.once(event_types.APP_READY, () => {
    const kernelStatus = {
        SessionGate: !!SessionGate,
        Coordinator: !!Coordinator,
        NotificationCenter: !!NotificationCenter,
        CFS4Version: window.CFS4?.version,
    };
    console.log(`${TAG} APP_READY confirmed`, kernelStatus);

    const allMounted = !!(SessionGate && Coordinator && NotificationCenter);

    if (typeof toastr !== 'undefined') {
        if (allMounted) {
            toastr.success(
                `CFS Suite v${VERSION} — 核心层 3 模块已挂载（SessionGate/Coordinator/NotificationCenter）`,
                'CFS-Suite',
                { timeOut: 5000 },
            );
        } else {
            toastr.error(
                `CFS Suite v${VERSION} — 核心层加载异常，详见 F12 console`,
                'CFS-Suite',
                { timeOut: 10000 },
            );
        }
    }
});
