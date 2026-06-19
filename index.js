import { eventSource, event_types } from '../../../../script.js';

const TAG = '[CFS-Suite]';
const VERSION = '5.0.0-day1';

console.log(`${TAG} v${VERSION} scaffold loaded`);

eventSource.once(event_types.APP_READY, () => {
    console.log(`${TAG} APP_READY confirmed — scaffold visible to ST`);
    if (typeof toastr !== 'undefined') {
        toastr.info(
            'CFS Suite v5.0.0-day1 — 骨架加载成功（暂无功能）',
            'CFS-Suite',
            { timeOut: 5000 },
        );
    }
});
