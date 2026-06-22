/**
 * CFS-Suite · ui/floating_capsule.js
 *
 * 浮动胶囊入口（Day 4 附加 v2）。
 * 默认右下角，可拖拽到任意位置（位置存 LS）；点击展开折叠面板。
 *
 * **作用域**：
 *   - 模块挂载状态（13 项）+ 状态机阶段 + 接管模式
 *   - 实时刷新（胶囊文字每 2 秒）
 *   - 4 个一键动作：启用接管 / 关闭接管 / 重新校验 entry / 清缓存
 *
 * **不做的事**（留 Day 6 完整 panel.js 迁移）：
 *   - SEM 候选扫描 / 一键迁移
 *   - PSIS+ 操作记录 / 回滚 UI
 *   - 完整 renderMvuConsole
 */

const TAG = '[CFS-Suite/ui]';
const VERSION = '6.2.0';
const LS_POS_KEY = 'cfs-suite/ui/capsule_position_v2';
// 一次性清理 v1 旧 key：v1 默认右下，部分手机机型不可见；v2 改默认右上
// 老用户升级后 v2 不存在 → 走新默认 CSS（右上角）→ 不再被 ST #send_form / iOS home indicator 遮住
try { localStorage.removeItem('cfs-suite/ui/capsule_position'); } catch {}

// 防重复挂载
if (window.__cfsSuiteCapsuleMounted) {
    console.log(`${TAG} 胶囊已挂，skip 重复 init`);
} else {
    window.__cfsSuiteCapsuleMounted = true;
    _mountCapsule();
}

function _mountCapsule() {
    // ===== 样式 =====
    const style = document.createElement('style');
    style.textContent = `
        #cfs-suite-capsule {
            position: fixed;
            right: max(16px, env(safe-area-inset-right, 16px));
            top: calc(60px + env(safe-area-inset-top, 0px));
            z-index: 9999;
            background: linear-gradient(135deg, #2a7f4f 0%, #1a5c3a 100%);
            color: #fff;
            padding: 8px 14px;
            border-radius: 999px;
            font-size: 12px;
            font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
            cursor: move;
            box-shadow: 0 4px 14px rgba(0,0,0,0.3);
            user-select: none;
            -webkit-user-select: none;
            touch-action: none; /* Day 11: 阻止浏览器把触摸当滚动消化掉 */
            transition: transform 0.1s ease;
        }
        #cfs-suite-capsule .capsule-icon::before { content: '🥵'; }
        #cfs-suite-capsule .capsule-text { margin-left: 2px; }
        #cfs-suite-capsule:hover { transform: scale(1.05); }
        #cfs-suite-capsule.dragging {
            transition: none;
            cursor: grabbing;
            box-shadow: 0 8px 22px rgba(0,0,0,0.5);
        }
        #cfs-suite-capsule.status-warn { background: linear-gradient(135deg, #b8860b 0%, #856200 100%); }
        #cfs-suite-capsule.status-error { background: linear-gradient(135deg, #c0392b 0%, #872c20 100%); }

        #cfs-suite-panel {
            position: fixed;
            z-index: 9999;
            background: #1c1c1e;
            color: #e0e0e0;
            border: 1px solid #444;
            border-radius: 10px;
            box-shadow: 0 6px 24px rgba(0,0,0,0.5);
            min-width: 340px;
            max-width: 400px;
            max-height: 70vh;
            overflow-y: auto;
            overflow-x: hidden; /* Day 11: 兜底 — 子组件无意溢出全部截断防穿帮 */
            padding: 14px 16px;
            font-size: 12px;
            font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
            display: none;
        }
        #cfs-suite-panel.open { display: block; }
        #cfs-suite-panel h3 {
            margin: 0 0 8px 0;
            font-size: 13px;
            color: #6ed29c;
            border-bottom: 1px solid #333;
            padding-bottom: 6px;
        }
        #cfs-suite-panel .section { margin-top: 10px; }
        #cfs-suite-panel .section-title {
            color: #888;
            font-weight: bold;
            margin-bottom: 4px;
            font-size: 11px;
        }
        #cfs-suite-panel .row {
            display: flex;
            justify-content: space-between;
            padding: 2px 0;
        }
        #cfs-suite-panel .row .k { color: #aaa; }
        #cfs-suite-panel .row .v.ok { color: #6ed29c; }
        #cfs-suite-panel .row .v.warn { color: #f0c060; }
        #cfs-suite-panel .row .v.err { color: #e07060; }
        #cfs-suite-panel .row .v.info { color: #8acaff; }

        #cfs-suite-panel .actions {
            margin-top: 12px;
            border-top: 1px solid #333;
            padding-top: 10px;
        }
        #cfs-suite-panel button {
            background: #2a4a6e;
            color: #fff;
            border: 1px solid #3a5a7e;
            padding: 6px 11px;
            border-radius: 4px;
            font-size: 12px;
            cursor: pointer;
            margin-right: 6px;
            margin-bottom: 6px;
            width: calc(50% - 8px);
            box-sizing: border-box;
        }
        #cfs-suite-panel button:hover { background: #3a5a7e; }
        #cfs-suite-panel button.primary { background: #2a7f4f; border-color: #3a8f5f; }
        #cfs-suite-panel button.primary:hover { background: #3a8f5f; }
        #cfs-suite-panel button.danger { background: #6e2a2a; border-color: #7e3a3a; }
        #cfs-suite-panel button.danger:hover { background: #7e3a3a; }
        #cfs-suite-panel .hint {
            color: #777;
            font-size: 10px;
            margin-top: 8px;
            line-height: 1.4;
        }
        #cfs-suite-panel .log-box {
            max-height: 160px;
            overflow-y: auto;
            background: #0e0e0f;
            border: 1px solid #333;
            border-radius: 4px;
            padding: 6px 8px;
            margin-top: 10px;
            font-family: 'Consolas', 'Microsoft YaHei Mono', monospace;
            font-size: 10px;
            line-height: 1.5;
        }
        #cfs-suite-panel .log-box-empty {
            color: #555;
            font-style: italic;
            padding: 4px 0;
        }
        #cfs-suite-panel .log-line { padding: 1px 0; word-break: break-all; }
        #cfs-suite-panel .log-line.kind-info    { color: #aaa; }
        #cfs-suite-panel .log-line.kind-success { color: #6ed29c; }
        #cfs-suite-panel .log-line.kind-warn    { color: #f0c060; }
        #cfs-suite-panel .log-line.kind-error   { color: #e07060; }
        #cfs-suite-panel .log-time { color: #555; margin-right: 4px; }
        #cfs-suite-panel .log-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-top: 12px;
            margin-bottom: 0;
        }
        #cfs-suite-panel .log-header .section-title { margin: 0; }
        #cfs-suite-panel .log-clear-btn {
            background: transparent;
            color: #888;
            border: 1px solid #444;
            padding: 1px 7px;
            border-radius: 3px;
            font-size: 10px;
            cursor: pointer;
            width: auto;
            margin: 0;
        }
        #cfs-suite-panel .log-clear-btn:hover { color: #fff; border-color: #888; }

        /* Day 11: 移动端切纯小圆球（40×40 emoji-only），文字进 panel */
        @media (max-width: 768px) {
            #cfs-suite-capsule {
                width: 40px;
                height: 40px;
                padding: 0;
                border-radius: 50%;
                font-size: 22px;
                line-height: 1;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            #cfs-suite-capsule .capsule-icon::before { content: '🧐'; }
            #cfs-suite-capsule .capsule-text { display: none; }
            #cfs-suite-capsule:hover { transform: none; }
        }
    `;
    document.head.appendChild(style);

    // ===== DOM =====
    const capsule = document.createElement('div');
    capsule.id = 'cfs-suite-capsule';
    // Day 11: 拆 icon / text 两个 span — 移动端 CSS 隐藏 text、icon 用 ::before 切 emoji
    capsule.innerHTML = '<span class="capsule-icon"></span><span class="capsule-text">CFS缓存优化器 · 加载中</span>';
    document.body.appendChild(capsule);

    const panel = document.createElement('div');
    panel.id = 'cfs-suite-panel';
    document.body.appendChild(panel);

    // ===== 恢复保存的位置 =====
    _restorePosition(capsule);
    _clampToViewport(capsule);

    // 横竖屏切换 / 窗口缩放后重新钳制，防止旧 px 位置落到不可视区
    let _resizeRaf = 0;
    const _onResize = () => {
        if (_resizeRaf) return;
        _resizeRaf = requestAnimationFrame(() => {
            _resizeRaf = 0;
            _clampToViewport(capsule);
            if (panel.classList.contains('open')) _repositionPanel(capsule, panel);
        });
    };
    window.addEventListener('resize', _onResize);
    window.addEventListener('orientationchange', _onResize);

    // ===== 拖拽（Day 11: 抽 mouse/touch 共用 handlers）=====
    let dragOffsetX = 0, dragOffsetY = 0;
    let dragStartX = 0, dragStartY = 0;
    let isDragging = false;
    let didMove = false;
    // 2026-06-21 G: 手机第二次 tap 失效 BUG —— touchend 后浏览器还会合成派发 mousedown/mouseup
    // 到 capsule + document，二次进入 _onDragStart/_onDragEnd → 再 toggle 一次 → 表现为"打不开"。
    // 长按时浏览器抑制 mouse 合成 → 只走一次 → 正常开。
    // 修：touchstart 时打 suppress 时间窗，600ms 内 mouse 事件直接忽略。
    let _suppressMouseUntil = 0;

    function _onDragStart(clientX, clientY) {
        isDragging = true;
        didMove = false;
        capsule.classList.add('dragging');
        const rect = capsule.getBoundingClientRect();
        dragOffsetX = clientX - rect.left;
        dragOffsetY = clientY - rect.top;
        dragStartX = clientX;
        dragStartY = clientY;
    }
    function _onDragMove(clientX, clientY) {
        if (!isDragging) return;
        const dx = clientX - dragStartX;
        const dy = clientY - dragStartY;
        if (!didMove && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) didMove = true;
        if (!didMove) return;
        const left = Math.max(0, Math.min(window.innerWidth - capsule.offsetWidth, clientX - dragOffsetX));
        const top = Math.max(0, Math.min(window.innerHeight - capsule.offsetHeight, clientY - dragOffsetY));
        capsule.style.left = left + 'px';
        capsule.style.top = top + 'px';
        capsule.style.right = 'auto';
        capsule.style.bottom = 'auto';
        _repositionPanel(capsule, panel);
    }
    function _onDragEnd() {
        if (!isDragging) return;
        isDragging = false;
        capsule.classList.remove('dragging');
        if (didMove) {
            try {
                localStorage.setItem(LS_POS_KEY, JSON.stringify({
                    left: capsule.style.left,
                    top: capsule.style.top,
                }));
            } catch {}
        } else {
            // 未拖动 = 当作点击，切换面板
            panel.classList.toggle('open');
            if (panel.classList.contains('open')) {
                _repositionPanel(capsule, panel);
                _renderPanel(panel);
            }
        }
    }

    // mouse 套（移动端的合成 mouse 在 _suppressMouseUntil 窗口内直接忽略）
    capsule.addEventListener('mousedown', (e) => {
        if (Date.now() < _suppressMouseUntil) return;
        e.preventDefault();
        _onDragStart(e.clientX, e.clientY);
    });
    document.addEventListener('mousemove', (e) => {
        if (Date.now() < _suppressMouseUntil) return;
        _onDragMove(e.clientX, e.clientY);
    });
    document.addEventListener('mouseup', (e) => {
        if (Date.now() < _suppressMouseUntil) return;
        _onDragEnd();
    });

    // touch 套（passive:true 不阻 click 派发；touch-action:none 已防滚动）
    capsule.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        _suppressMouseUntil = Date.now() + 600;
        _onDragStart(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
        if (!isDragging || e.touches.length !== 1) return;
        e.preventDefault(); // 拖动中阻止页面滚动
        _suppressMouseUntil = Date.now() + 600;
        _onDragMove(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });
    document.addEventListener('touchend', () => {
        _suppressMouseUntil = Date.now() + 600;
        _onDragEnd();
    });
    document.addEventListener('touchcancel', () => {
        _suppressMouseUntil = Date.now() + 600;
        _onDragEnd();
    });

    // 点面板外关闭
    document.addEventListener('click', (e) => {
        if (isDragging) return;
        if (!panel.contains(e.target) && e.target !== capsule && !capsule.contains(e.target)) {
            panel.classList.remove('open');
        }
    });

    // 状态轮询
    setInterval(() => _updateCapsuleStatus(capsule), 2000);
    _updateCapsuleStatus(capsule);

    console.log(`${TAG} 浮动胶囊已挂载（可拖拽，位置自动记忆）`);
}

function _restorePosition(capsule) {
    try {
        const raw = localStorage.getItem(LS_POS_KEY);
        if (!raw) return;
        const pos = JSON.parse(raw);
        if (pos.left && pos.top) {
            capsule.style.left = pos.left;
            capsule.style.top = pos.top;
            capsule.style.right = 'auto';
            capsule.style.bottom = 'auto';
        }
    } catch {}
}

function _clampToViewport(capsule) {
    // 只对显式 left/top 像素值生效；默认 right/bottom 由 CSS + env() 处理
    if (!capsule.style.left && !capsule.style.top) return;
    const margin = 4;
    const w = capsule.offsetWidth || 180;
    const h = capsule.offsetHeight || 36;
    const maxLeft = Math.max(margin, window.innerWidth - w - margin);
    const maxTop = Math.max(margin, window.innerHeight - h - margin);
    const curLeft = parseFloat(capsule.style.left) || capsule.getBoundingClientRect().left;
    const curTop = parseFloat(capsule.style.top) || capsule.getBoundingClientRect().top;
    const newLeft = Math.min(maxLeft, Math.max(margin, curLeft));
    const newTop = Math.min(maxTop, Math.max(margin, curTop));
    capsule.style.left = newLeft + 'px';
    capsule.style.top = newTop + 'px';
    capsule.style.right = 'auto';
    capsule.style.bottom = 'auto';
}

function _repositionPanel(capsule, panel) {
    // 面板放在胶囊上方
    const rect = capsule.getBoundingClientRect();
    const panelHeight = panel.offsetHeight || 300;
    let top = rect.top - panelHeight - 8;
    if (top < 8) top = rect.bottom + 8; // 上面装不下就放下面
    let left = rect.left;
    if (left + 360 > window.innerWidth) left = window.innerWidth - 360 - 8;
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
}

function _moduleStatus() {
    const c = window.CFS4 ?? {};
    return {
        '会话状态机': !!c.SessionGate,
        '调度器': !!c.Coordinator,
        '通知中心': !!c.NotificationCenter,
        'Schema 冻结层': !!c.SchemaFrozenLayer,
        'Schema 切换门': !!c.SchemaSwapGate,
        'Schema 解析器': !!c.SchemaResolver,
        'Path 注册表': !!c.PathRegistry,
        '差异引擎': !!c.DiffEngine,
        '存在编码器': !!c.PresenceEncoder,
        '注入策略': !!c.InjectionStrategy,
        '回退策略': !!c.FallbackStrategy,
        '健康监控': !!c.HealthMonitor,
        '真接管': !!c._realTakeoverIIFEDone,
        // Day 5 modules
        // PSIS 是 Coordinator plugin (异步注册)，用 IIFE 完成 flag 判定挂载
        'PSIS R1 守护': !!c._psisIIFEDone,
        'SEM 迁移器': !!c.SEM,
        'PSIS+ 重排器': !!c.PSISPlus,
        'RSI 诊断器': !!c.RSI,
    };
}

function _modeLabel(mode) {
    if (mode === 'v4_full') return { text: '🥵 接管已启用', cls: 'ok' };
    if (mode === 'mvu_fallback') return { text: '⏸ 接管已关闭（用原版 MVU）', cls: 'warn' };
    if (mode === 'v4_degraded') return { text: '⚠️ 自动降级中', cls: 'err' };
    return { text: mode || '未知', cls: 'warn' };
}

function _phaseLabel(phase) {
    const map = {
        BOOTING: { text: '启动中…', cls: 'warn' },
        PROBING: { text: '探测会话…', cls: 'warn' },
        READY_FULL: { text: '会话就绪', cls: 'ok' },
        DONE: { text: '✅ 全部就绪', cls: 'ok' },
        TIMEOUT: { text: '⚠️ 探测超时', cls: 'err' },
    };
    return map[phase] || { text: phase || '?', cls: 'warn' };
}

function _updateCapsuleStatus(capsule) {
    const status = _moduleStatus();
    const total = Object.keys(status).length;
    const mounted = Object.values(status).filter(Boolean).length;
    capsule.classList.remove('status-warn', 'status-error');
    if (mounted < total) {
        if (mounted < total / 2) capsule.classList.add('status-error');
        else capsule.classList.add('status-warn');
    }

    const phase = window.CFS4?.Coordinator?.getState?.()?.phase ?? '?';
    const mode = window.CFS4?.FallbackStrategy?.getCurrentMode?.() ?? '?';
    const modeLbl = _modeLabel(mode);

    // Day 11: 文字写进 .capsule-text 子元素（icon 由 CSS ::before 控制 + 移动端隐藏 text）
    const textEl = capsule.querySelector('.capsule-text');
    if (!textEl) return; // DOM 异常兜底（理论不可达）
    if (mounted === total && (phase === 'DONE' || phase === 'READY_FULL')) {
        textEl.textContent = `CFS缓存优化器 · ${modeLbl.text}`;
    } else if (mounted === total) {
        textEl.textContent = `CFS缓存优化器 · ${_phaseLabel(phase).text}`;
    } else {
        textEl.textContent = `CFS缓存优化器 · 加载中 ${mounted}/${total}`;
    }
}

// ===== 持久化日志（panel re-render 不丢历史，最多保留 50 条）=====
const _logHistory = [];
const LOG_MAX = 50;

function _pushLog(panel, msg, kind = 'info') {
    const now = new Date();
    const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    _logHistory.unshift({ time, msg, kind });
    while (_logHistory.length > LOG_MAX) _logHistory.pop();
    _renderLogBox(panel);
}

function _renderLogBox(panel) {
    const box = panel.querySelector('.log-box');
    if (!box) return;
    if (_logHistory.length === 0) {
        box.innerHTML = '<div class="log-box-empty">（暂无操作记录。按上方按钮后此处会留下持久化提示）</div>';
        return;
    }
    box.innerHTML = _logHistory
        .map(
            (l) =>
                `<div class="log-line kind-${l.kind}"><span class="log-time">${l.time}</span>${_escapeHtml(l.msg)}</div>`,
        )
        .join('');
}

function _escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ===== Day 8: CFS-MVU 走酒馆助手脚本路径（不再做 ST 原生扩展） =====
const CFS_MVU_GITHUB_URL = 'https://github.com/OreoCoins/CFS-MVU';
const CFS_MVU_SCRIPT_JSON_URL = 'https://raw.githubusercontent.com/OreoCoins/CFS-MVU/main/artifact/cfs-mvu-tavern-helper-script.json';
const _cfsMvuStatus = {
    installed: null,
    version: null,
    lastCheckedAt: 0,
    // 2026-06-21 v6 阶段 F：MVU 来源诊断
    sources: [],          // [{type, name, id?, where}]
    sourcesScannedAt: 0,
    sourcesScanError: null,
};

// ===== Day 9: Full Refresh 长期记忆锚点配置 =====
const LS_FULL_REFRESH_INTERVAL = 'cfs-suite/full_refresh_interval';
const LS_FULL_REFRESH_COUNTER = 'cfs-suite/full_refresh_counter';

function _getFullRefreshInterval() {
    try { return parseInt(localStorage.getItem(LS_FULL_REFRESH_INTERVAL) || '0', 10) || 0; }
    catch { return 0; }
}
function _getFullRefreshCounter() {
    try { return parseInt(localStorage.getItem(LS_FULL_REFRESH_COUNTER) || '0', 10) || 0; }
    catch { return 0; }
}
function _setFullRefreshInterval(n) {
    try { localStorage.setItem(LS_FULL_REFRESH_INTERVAL, String(Math.max(0, parseInt(n, 10) || 0))); }
    catch { }
}

// ===== Day 10: 自动 Stable Promotion 配置（Slow Promote / Fast Demote / Periodic Decay）=====
const LS_AP_ENABLED = 'cfs-suite/auto_promote_enabled';
const LS_AP_PROMOTE_AFTER = 'cfs-suite/auto_promote_after_rounds';
const LS_AP_THRASH_LOCK = 'cfs-suite/auto_promote_thrash_lock';
const LS_AP_VOLATILE_RE = 'cfs-suite/auto_promote_volatile_whitelist';
const LS_AP_DECAY_EVERY = 'cfs-suite/auto_promote_decay_every_n';
const DEFAULT_AP_VOLATILE_RE = '(HP$|SAN$|当前|状态$|位置$|余额|经验|欲望|淫乱|堕落|进度|count$|cnt$|time$|timestamp|round|tick)';

function _getAutoPromoteCfg() {
    try {
        const rawEnabled = localStorage.getItem(LS_AP_ENABLED);
        return {
            enabled: rawEnabled === null ? true : (rawEnabled !== '0'),
            promoteAfter: parseInt(localStorage.getItem(LS_AP_PROMOTE_AFTER) || '20', 10) || 20,
            thrashLock: parseInt(localStorage.getItem(LS_AP_THRASH_LOCK) || '3', 10) || 3,
            decayEveryN: parseInt(localStorage.getItem(LS_AP_DECAY_EVERY) || '100', 10) || 100,
            whitelistRe: localStorage.getItem(LS_AP_VOLATILE_RE) || DEFAULT_AP_VOLATILE_RE,
        };
    } catch {
        return { enabled: true, promoteAfter: 20, thrashLock: 3, decayEveryN: 100, whitelistRe: DEFAULT_AP_VOLATILE_RE };
    }
}
function _setAutoPromoteCfg(patch) {
    try {
        if ('enabled' in patch) localStorage.setItem(LS_AP_ENABLED, patch.enabled ? '1' : '0');
        if ('promoteAfter' in patch) localStorage.setItem(LS_AP_PROMOTE_AFTER, String(Math.max(1, parseInt(patch.promoteAfter, 10) || 20)));
        if ('thrashLock' in patch) localStorage.setItem(LS_AP_THRASH_LOCK, String(Math.max(1, parseInt(patch.thrashLock, 10) || 3)));
        if ('decayEveryN' in patch) localStorage.setItem(LS_AP_DECAY_EVERY, String(Math.max(0, parseInt(patch.decayEveryN, 10) || 0)));
        if ('whitelistRe' in patch) localStorage.setItem(LS_AP_VOLATILE_RE, String(patch.whitelistRe || DEFAULT_AP_VOLATILE_RE));
    } catch {}
}
function _getAutoPromoteState() {
    try { return window.CFS4?.InjectionStrategy?.getAutoPromoteState?.() || null; }
    catch { return null; }
}

// ===== Day 11: 长期记忆策略 — 三档预设 =====
const LS_LTM_PRESET = 'cfs-suite/long_term_memory_preset';
const LTM_PRESETS = {
    thrifty:  { label: '🚀 节流',  promoteAfter: 10, thrashLock: 3, decayEveryN: 100, fullRefreshInterval: 0,  hint: '只用稳态识别；关闭周期校准；cache 命中率优先。' },
    standard: { label: '⚖️ 标准',  promoteAfter: 20, thrashLock: 3, decayEveryN: 100, fullRefreshInterval: 50, hint: '默认；20 轮稳态识别 + 每 50 轮做一次完整快照校准。' },
    stable:   { label: '🛡️ 稳定',  promoteAfter: 30, thrashLock: 3, decayEveryN: 100, fullRefreshInterval: 20, hint: '稳态识别更保守 + 校准频率较高（每 20 轮一次完整快照）。' },
};
function _getLtmPreset() {
    try { return localStorage.getItem(LS_LTM_PRESET) || ''; } catch { return ''; }
}
function _setLtmPreset(name) {
    try { localStorage.setItem(LS_LTM_PRESET, name); } catch {}
}
function _applyLtmPreset(name) {
    const p = LTM_PRESETS[name];
    if (!p) return false;
    _setAutoPromoteCfg({
        enabled: true,
        promoteAfter: p.promoteAfter,
        thrashLock: p.thrashLock,
        decayEveryN: p.decayEveryN,
        whitelistRe: DEFAULT_AP_VOLATILE_RE,
    });
    _setFullRefreshInterval(p.fullRefreshInterval);
    // 切预设时重置 counter 避免立即触发
    try { localStorage.setItem(LS_FULL_REFRESH_COUNTER, '0'); } catch {}
    _setLtmPreset(name);
    return true;
}
// 升级路径：老用户没存预设 → 根据现有 LS 数值反推
function _inferLtmPreset() {
    const saved = _getLtmPreset();
    if (saved && LTM_PRESETS[saved]) return saved;
    if (saved === 'custom') return 'custom';
    const ap = _getAutoPromoteCfg();
    const fri = _getFullRefreshInterval();
    for (const [name, p] of Object.entries(LTM_PRESETS)) {
        if (ap.promoteAfter === p.promoteAfter
            && ap.thrashLock === p.thrashLock
            && ap.decayEveryN === p.decayEveryN
            && fri === p.fullRefreshInterval
            && ap.whitelistRe === DEFAULT_AP_VOLATILE_RE
            && ap.enabled === true) {
            return name;
        }
    }
    return 'custom';
}

function _getCsrfHeaders() {
    // ST 真 getRequestHeaders 带 CSRF token；window.getRequestHeaders 由 polyfill 或 ST 提供
    try {
        const ctx = window.SillyTavern?.getContext?.();
        if (typeof ctx?.getRequestHeaders === 'function') return ctx.getRequestHeaders();
    } catch {}
    try {
        if (typeof window.getRequestHeaders === 'function') return window.getRequestHeaders();
    } catch {}
    return { 'Content-Type': 'application/json' };
}

function _detectCfsMvuInstalled() {
    // Day 8: 改用真实标识 — window.Mvu._cfsEdition 存在 = CFS-MVU 套餐版已就位
    // 之前用 /api/extensions/discover 是错的（CFS-MVU 不再做 ST 扩展）
    return !!window.Mvu?._cfsEdition;
}

function _refreshCfsMvuStatus(panel) {
    _cfsMvuStatus.installed = _detectCfsMvuInstalled();
    _cfsMvuStatus.version = window.Mvu?._cfsEdition?.version ?? null;
    _cfsMvuStatus.lastCheckedAt = Date.now();
    // 2026-06-21 v6 阶段 F：非套餐版时异步扫来源
    if (!_cfsMvuStatus.installed && typeof window.Mvu?.getMvuData === 'function') {
        _scanOtherMvuSources().then((r) => {
            _cfsMvuStatus.sources = r.sources;
            _cfsMvuStatus.sourcesScannedAt = Date.now();
            _cfsMvuStatus.sourcesScanError = r.scanError;
            const el2 = panel?.querySelector?.('.mvu-status-line');
            if (el2) el2.innerHTML = _renderMvuStatusLine();
        }).catch((e) => {
            _cfsMvuStatus.sourcesScanError = e?.message ?? String(e);
        });
    } else {
        _cfsMvuStatus.sources = [];
        _cfsMvuStatus.sourcesScannedAt = 0;
        _cfsMvuStatus.sourcesScanError = null;
    }
    const el = panel?.querySelector?.('.mvu-status-line');
    if (el) el.innerHTML = _renderMvuStatusLine();
}

function _renderMvuStatusLine() {
    if (_cfsMvuStatus.installed && _cfsMvuStatus.version) {
        return `<span class="v ok">✓ CFS-MVU 已生效 (v${_cfsMvuStatus.version})</span>`;
    }
    if (typeof window.Mvu?.getMvuData === 'function') {
        let html = '<span class="v warn">⚠️ Mvu 存在但非 CFS-MVU 套餐版</span>';
        const ss = _cfsMvuStatus.sources;
        if (Array.isArray(ss) && ss.length > 0) {
            const items = ss.slice(0, 6).map(s =>
                `<li>[${_escapeHtml(s.type)}] <b>${_escapeHtml(s.name)}</b></li>`
            ).join('');
            const more = ss.length > 6 ? `<li>… 共 ${ss.length} 条</li>` : '';
            html += `<ul style="margin:4px 0 2px 16px;padding:0;font-size:11px;line-height:1.4">${items}${more}</ul>`;
        } else if (_cfsMvuStatus.sourcesScannedAt > 0) {
            html += `<div style="font-size:11px;color:#999;margin-top:2px">未识别 MVU 注册来源 · 点 <b>🔍 F12 诊断</b> 自助查</div>`;
        } else {
            html += `<div style="font-size:11px;color:#999;margin-top:2px">来源扫描中…</div>`;
        }
        if (_cfsMvuStatus.sourcesScanError) {
            html += `<div style="font-size:10px;color:#c00">⚠ 部分扫描失败: ${_escapeHtml(_cfsMvuStatus.sourcesScanError)}</div>`;
        }
        html += `<div style="font-size:10px;color:#999;margin-top:2px">注：CFS-Suite v6 不带 MVU bundle，需酒馆助手装套餐版脚本</div>`;
        return html;
    }
    return '<span class="v err">✗ 未装 CFS-MVU（点下方按钮看引导）</span>';
}

async function _installCfsMvu(panel) {
    // Day 8-fix: 酒馆助手不支持 URL 导入，必须用 JSON 文件
    _pushLog(panel, '📥 触发 CFS-MVU JSON 文件下载…', 'info');
    try {
        // CFS-Suite 仓库自带 JSON 文件作为附件
        const localUrl = new URL('../../cfs-mvu/cfs-mvu-tavern-helper-script.json', import.meta.url).href;
        const response = await fetch(localUrl);
        if (!response.ok) throw new Error(`fetch 失败 ${response.status}`);
        const blob = await response.blob();
        const downloadUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = 'cfs-mvu-tavern-helper-script.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(downloadUrl);
        _pushLog(panel, '✅ 文件已下载到浏览器默认下载目录', 'success');
        _pushLog(panel, '  ① 如之前在 ST 装过 CFS-MVU 扩展，先在「管理扩展程序」卸载', 'warn');
        _pushLog(panel, '  ② 扩展面板 → 酒馆助手 → 全局脚本 → 「导入脚本」（JSON 文件）', 'info');
        _pushLog(panel, '  ③ 选择刚下载的 cfs-mvu-tavern-helper-script.json', 'info');
        _pushLog(panel, '  ④ 启用脚本 + 配置 URL/API 密钥 + F5 ST', 'info');
    } catch (e) {
        _pushLog(panel, '❌ 文件下载失败：' + (e?.message ?? e), 'error');
        _pushLog(panel, '  ↳ 手动方式：从 GitHub 下载 cfs-mvu-tavern-helper-script.json', 'info');
        _pushLog(panel, `  ↳ ${CFS_MVU_SCRIPT_JSON_URL}`, 'info');
    }
}

async function _copyCfsMvuUrl(panel) {
    // Day 8: 复制酒馆助手脚本 JSON URL（不再是 git URL）
    try {
        await navigator.clipboard.writeText(CFS_MVU_SCRIPT_JSON_URL);
        _pushLog(panel, `📋 已复制酒馆助手脚本 URL：${CFS_MVU_SCRIPT_JSON_URL}`, 'success');
        _pushLog(panel, '  ↳ 去酒馆助手 → 全局脚本 → 从 URL 导入 → 粘贴', 'info');
    } catch {
        _pushLog(panel, `📋 自动复制失败，手动复制：${CFS_MVU_SCRIPT_JSON_URL}`, 'warn');
    }
}

// ===== Day 7-6: 扫描禁用其他 MVU 脚本（酒馆助手 API） =====

// 递归把 ScriptTree (Script | ScriptFolder) 平展成 Script 数组
function _flattenScriptTrees(trees) {
    const out = [];
    for (const node of trees ?? []) {
        if (node?.type === 'script') out.push(node);
        else if (node?.type === 'folder' && Array.isArray(node.scripts)) {
            out.push(..._flattenScriptTrees(node.scripts));
        }
    }
    return out;
}

// ===== 2026-06-21 v6 阶段 F：MVU 注册者深度扫描 + 诊断 =====
// 用户反馈：点「扫描禁用其他 MVU」下方显示「未发现」，但顶部仍报「Mvu 存在但非套餐版」
// 根因：旧 isMvuScript 只看 script.name 匹配 MVU/MagVar/变量框架 6 个关键字
//   → 卡作者把脚本命名「道渊数据 / 角色状态管理 / 游戏化系统 / AutoCard」时一律漏扫
// 修：① 扫描判定加 content 关键字（不依赖名字）
//      ② 扩 source 面 ── 加上角色卡 regex_scripts + character_book.entries content
//      ③ 抽 _scanOtherMvuSources 纯查询版给状态行用
//      ④ _diagnoseMvuRegistrant 给用户 F12 自助查
const _MVU_CONTENT_MARKERS = [
    /\bwindow\s*\.\s*Mvu\b/,
    /\bglobalThis\s*\.\s*Mvu\b/,
    /\bMvu\s*\.\s*(init|replaceMvuData|parseMessage|setMvuData|getMvuData|loadMvu|initMvu)\b/,
    /\bMvu\s*=\s*[\{\(\[]/,
    /['"]@(magicalastrogy\/)?magvarupdate['"]/i,
    /\bMagVarUpdate\b/,
    /\bstat_data\s*[:=]/,           // MVU 核心字段
    /\bupdate_variables\s*\(/,      // MVU 核心 API
];
function _isMvuByContent(s) {
    if (typeof s !== 'string' || s.length === 0) return false;
    for (let i = 0; i < _MVU_CONTENT_MARKERS.length; i++) {
        try { if (_MVU_CONTENT_MARKERS[i].test(s)) return true; } catch (e) {}
    }
    return false;
}
function _isCfsMvuByName(n) {
    return /cfs[-_ ]?mvu|cfs[-_ ]?suite/i.test(n || '');
}
function _isMvuScriptDeep(s) {
    if (_isCfsMvuByName(s.name || '')) return false;
    const name = (s.name || '').toLowerCase();
    if (/mvu|magvar|变量框架|variable.?framework/i.test(name)) return true;
    if (_isMvuByContent(s.content || '')) return true;
    return false;
}

async function _scanOtherMvuSources() {
    const sources = [];
    const errs = [];

    // ① 酒馆助手脚本（global / character / preset）—— 名字 OR content 命中
    const TH = window.TavernHelper;
    const getTrees = TH?.getScriptTrees ?? window.getScriptTrees;
    if (typeof getTrees === 'function') {
        const types = ['global', 'character', 'preset'];
        for (let i = 0; i < types.length; i++) {
            const t = types[i];
            try {
                const trees = await getTrees({ type: t });
                const scripts = _flattenScriptTrees(trees);
                for (const s of scripts) {
                    if (s.enabled === false) continue;
                    if (_isMvuScriptDeep(s)) {
                        sources.push({ type: 'tavern_helper:' + t, name: s.name || '(无名)', id: s.id, where: t });
                    }
                }
            } catch (e) {
                errs.push(`tavern_helper:${t}: ${e?.message ?? e}`);
            }
        }
    } else {
        errs.push('TavernHelper.getScriptTrees 不在主页面暴露（iframe-only）');
    }

    // ② 当前角色卡 regex_scripts（伪扩展 ── iframe 沙箱跑代码）+ character_book entries content
    try {
        const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext() : null;
        const charId = ctx?.characterId;
        const char = (typeof charId === 'number' && Array.isArray(ctx?.characters)) ? ctx.characters[charId] : null;
        const charData = char?.data;
        const regexScripts = charData?.extensions?.regex_scripts;
        if (Array.isArray(regexScripts)) {
            for (const r of regexScripts) {
                if (r.disabled === true) continue;
                const haystack = (r.replaceString || '') + ' ' + (r.scriptName || '');
                if (_isMvuByContent(haystack) || /\bmvu\b|\bmagvar\b/i.test(r.scriptName || '')) {
                    sources.push({ type: 'char:regex_script', name: r.scriptName || '(无名 regex)', where: 'card.regex_scripts' });
                }
            }
        }
        const cbEntries = charData?.character_book?.entries;
        if (Array.isArray(cbEntries)) {
            for (const e of cbEntries) {
                if (e.enabled === false) continue;
                const haystack = (e.content || '') + ' ' + (e.comment || '');
                if (_isMvuByContent(haystack)) {
                    sources.push({ type: 'char:character_book', name: e.comment || '(无 comment)', where: 'card.character_book' });
                }
            }
        }
    } catch (e) {
        errs.push(`char_card: ${e?.message ?? e}`);
    }

    // ③ ST 原生扩展层（third-party 目录）—— 用户在酒馆助手脚本管理看不到的来源
    //   关键场景：反馈用户主页面 window.Mvu = 11 keys（=上游 MagVarUpdate 的 createMvu）
    //   既不在酒馆助手脚本，也不在角色卡内嵌，剩下唯一可能就是 ST 第三方扩展
    //   ST API: GET /api/extensions/discover 返回 [{name, type}]
    //   禁用: extension_settings.disabledExtensions.push(name) + saveSettings()
    try {
        const headers = (typeof window.getRequestHeaders === 'function')
            ? window.getRequestHeaders() : { 'Content-Type': 'application/json' };
        const resp = await fetch('/api/extensions/discover', { method: 'GET', headers });
        if (resp.ok) {
            const exts = await resp.json();
            if (Array.isArray(exts)) {
                // 已 disabled 的不算（防止重复显示给用户）
                const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext() : null;
                const extSettings = ctx?.extensionSettings ?? (typeof window.extension_settings !== 'undefined' ? window.extension_settings : null);
                const disabledList = Array.isArray(extSettings?.disabledExtensions) ? extSettings.disabledExtensions : [];
                for (const e of exts) {
                    const name = (typeof e === 'string') ? e : (e?.name || '');
                    if (!name) continue;
                    // 跳过 CFS 自己 + 已禁用
                    if (_isCfsMvuByName(name)) continue;
                    if (disabledList.includes(name)) continue;
                    if (/mvu|magvar|变量框架|variable.?framework/i.test(name)) {
                        sources.push({
                            type: 'st:extension',
                            name: name.replace(/^third-party\//, ''),
                            id: name,                                  // 完整 internalName，禁用 API 用这个
                            where: e?.type === 'system' ? 'ST 内置扩展' : 'ST 第三方扩展',
                            __stExt: true,                             // 标记给禁用流程
                        });
                    }
                }
            }
        } else {
            errs.push('st_extensions: /api/extensions/discover ' + resp.status);
        }
    } catch (e) {
        errs.push('st_extensions: ' + (e?.message ?? e));
    }

    return { sources, scanError: errs.length ? errs.join(' | ') : null };
}

// 2026-06-21 v6 阶段 F+：禁用 ST 原生扩展（用 ST 内部 extension_settings.disabledExtensions API）
async function _disableSTExtension(internalName) {
    const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext() : null;
    const extSettings = ctx?.extensionSettings ?? (typeof window.extension_settings !== 'undefined' ? window.extension_settings : null);
    if (!extSettings || !Array.isArray(extSettings.disabledExtensions)) {
        throw new Error('extension_settings.disabledExtensions 不可用（ST 版本不兼容?）');
    }
    if (!extSettings.disabledExtensions.includes(internalName)) {
        extSettings.disabledExtensions.push(internalName);
    }
    // 保存
    if (ctx && typeof ctx.saveSettingsDebounced === 'function') {
        ctx.saveSettingsDebounced();
    } else if (typeof window.saveSettingsDebounced === 'function') {
        window.saveSettingsDebounced();
    } else if (typeof window.saveSettings === 'function') {
        await window.saveSettings();
    } else {
        throw new Error('saveSettings/saveSettingsDebounced 不可用');
    }
    return true;
}

function _diagnoseMvuRegistrant() {
    console.group('[CFS-Suite] 🔍 MVU 注册者诊断 dump');
    try {
        console.log('window.Mvu exists?', !!window.Mvu);
        if (window.Mvu) {
            console.log('Object.keys(window.Mvu):', Object.keys(window.Mvu));
            console.log('window.Mvu._cfsEdition:', window.Mvu._cfsEdition);
            console.log('window.Mvu.version:', window.Mvu.version);
            console.log('window.Mvu.constructor?.name:', window.Mvu.constructor?.name);
            const fnKeys = Object.keys(window.Mvu).filter(k => typeof window.Mvu[k] === 'function');
            console.log('functions:', fnKeys);
            for (let i = 0; i < Math.min(5, fnKeys.length); i++) {
                const fk = fnKeys[i];
                try { console.log(`  ${fk}.toString() (slice 200):`, String(window.Mvu[fk]).slice(0, 200)); } catch (e) {}
            }
        }
        console.log('CFS-Suite v6: 本身不带 MVU bundle（index.js v6.0.0 注释 line 33）');
        console.log('当前 _cfsMvuStatus snapshot:', JSON.parse(JSON.stringify({ ..._cfsMvuStatus })));
        console.log('提示：复制以上 dump 粘贴到 issue / DC，定位 Mvu 注册源。');
    } catch (e) {
        console.warn('诊断 dump 异常:', e);
    }
    console.groupEnd();
}
if (typeof window !== 'undefined') {
    window.CFS4 = window.CFS4 || {};
    window.CFS4.diagnoseMvuRegistrant = _diagnoseMvuRegistrant;
}

async function _scanAndDisableOtherMvu(panel) {
    // 2026-06-21 v6 阶段 F+：一次性深度扫所有可能来源 + 自动禁用
    //   ① 酒馆助手脚本 (global/character/preset)        — TavernHelper.updateScriptTreesWith 禁用
    //   ② ST 第三方/系统扩展                            — extension_settings.disabledExtensions.push 禁用 [新增]
    //   ③ 角色卡 regex_scripts / character_book entries — 只能告知用户手动改（CFS 无写入 API）
    _pushLog(panel, '🔍 全方位扫描 MVU 注册者（酒馆助手 + ST 扩展 + 角色卡）…', 'info');

    const r = await _scanOtherMvuSources();
    if (r.scanError) _pushLog(panel, '⚠ 扫描部分失败: ' + r.scanError, 'warn');

    const all = r.sources || [];
    if (all.length === 0) {
        _pushLog(panel, '✅ 全方位扫描未发现非 CFS-MVU 来源', 'success');
        _pushLog(panel, '  ↳ 如仍报"Mvu 存在但非套餐版" — 点 🔍 F12 诊断按钮，把 console dump 发我们排查', 'info');
        return;
    }

    // 分类
    const thScripts = all.filter(s => s.type && s.type.startsWith('tavern_helper:'));
    const stExts = all.filter(s => s.type === 'st:extension');
    const cardSrcs = all.filter(s => s.type === 'char:regex_script' || s.type === 'char:character_book');

    // 显示扫描结果
    if (thScripts.length > 0) {
        _pushLog(panel, `📜 酒馆助手脚本: ${thScripts.length} 个`, 'info');
        for (const s of thScripts) _pushLog(panel, `  · [${s.type}] ${s.name}`, 'info');
    }
    if (stExts.length > 0) {
        _pushLog(panel, `🔌 ST 第三方/系统扩展: ${stExts.length} 个`, 'info');
        for (const s of stExts) _pushLog(panel, `  · [${s.where}] ${s.name} (id=${s.id})`, 'info');
    }
    if (cardSrcs.length > 0) {
        _pushLog(panel, `📇 角色卡内嵌 (CFS 无法自动禁用): ${cardSrcs.length} 个`, 'warn');
        for (const s of cardSrcs) _pushLog(panel, `  · [${s.type}] ${s.name}`, 'warn');
    }

    const autoCount = thScripts.length + stExts.length;
    if (autoCount === 0) {
        _pushLog(panel, '⚠️ 全部来源在角色卡内嵌，CFS 无 API 写入 — 请到角色卡编辑器手动改 regex_scripts / character_book', 'warn');
        return;
    }

    const summary = []
        .concat(thScripts.map(s => `[酒馆助手:${s.type.split(':')[1]}] ${s.name}`))
        .concat(stExts.map(s => `[ST 扩展] ${s.name}`))
        .join('\n');
    if (!confirm(`将禁用 ${autoCount} 项非 CFS-MVU 来源：\n${summary}\n${cardSrcs.length > 0 ? `\n（另有 ${cardSrcs.length} 项角色卡内嵌来源 CFS 无法自动处理）\n` : ''}\n确定禁用？（运行时禁用，不删脚本/扩展。完成后会自动 F5 重启）`)) {
        _pushLog(panel, '⏸ 用户取消', 'warn');
        return;
    }

    let disabled = 0;

    // ① 禁用酒馆助手脚本
    if (thScripts.length > 0) {
        const TH = window.TavernHelper;
        const updateTreesWith = TH?.updateScriptTreesWith ?? window.updateScriptTreesWith;
        if (typeof updateTreesWith === 'function') {
            const byType = {};
            for (const s of thScripts) {
                const t = s.type.split(':')[1];
                if (!byType[t]) byType[t] = [];
                byType[t].push(s);
            }
            for (const t of Object.keys(byType)) {
                const ids = new Set(byType[t].map(s => s.id));
                try {
                    await updateTreesWith((trees) => {
                        const updater = (nodes) => nodes.map(n => {
                            if (n.type === 'script' && ids.has(n.id)) return { ...n, enabled: false };
                            if (n.type === 'folder' && Array.isArray(n.scripts)) return { ...n, scripts: updater(n.scripts) };
                            return n;
                        });
                        return updater(trees);
                    }, { type: t });
                    disabled += byType[t].length;
                    for (const s of byType[t]) _pushLog(panel, `  ↳ ✓ [酒馆助手:${t}] ${s.name}`, 'success');
                } catch (e) {
                    _pushLog(panel, `  ↳ ✗ 酒馆助手 ${t} 禁用失败: ${e?.message ?? e}`, 'error');
                }
            }
        } else {
            _pushLog(panel, '⚠️ TavernHelper.updateScriptTreesWith 不可用 — 酒馆助手脚本无法自动禁用，请去脚本管理手动改', 'warn');
        }
    }

    // ② 禁用 ST 第三方/系统扩展（这就是反馈用户的痛点 — 11 keys 上游 MagVarUpdate 来源）
    if (stExts.length > 0) {
        for (const s of stExts) {
            try {
                await _disableSTExtension(s.id);
                _pushLog(panel, `  ↳ ✓ [ST 扩展] ${s.name} 已加入 disabledExtensions`, 'success');
                disabled++;
            } catch (e) {
                _pushLog(panel, `  ↳ ✗ [ST 扩展] ${s.name} 禁用失败: ${e?.message ?? e}`, 'error');
                _pushLog(panel, `      手动方式: ST 扩展面板 → 找「${s.name}」点关闭`, 'info');
            }
        }
    }

    if (disabled === 0) {
        _pushLog(panel, '⚠️ 没有任何来源被禁用', 'warn');
        return;
    }

    _pushLog(panel, `🚫 完成：禁用 ${disabled}/${autoCount} 项 — 3 秒后自动 F5 让生效（按住 Esc 阻止）…`, 'success');
    // 给用户 3s 看完日志再自动刷新
    let _aborted = false;
    const _onEsc = (ev) => { if (ev.key === 'Escape') { _aborted = true; _pushLog(panel, '⏸ 用户按 Esc，取消自动 F5（手动刷新生效）', 'warn'); document.removeEventListener('keydown', _onEsc); } };
    document.addEventListener('keydown', _onEsc);
    setTimeout(() => {
        document.removeEventListener('keydown', _onEsc);
        if (!_aborted) location.reload();
    }, 3000);
}

function _renderPanel(panel) {
    const status = _moduleStatus();
    const phase = window.CFS4?.Coordinator?.getState?.()?.phase ?? 'unknown';
    const mode = window.CFS4?.FallbackStrategy?.getCurrentMode?.() ?? 'unknown';
    const phaseLbl = _phaseLabel(phase);
    const modeLbl = _modeLabel(mode);
    const dynUid = window.CFS4?.InjectionStrategy?.getDynamicEntryUid?.() ?? '—';
    const lastInj = window.CFS4?.InjectionStrategy?.getLastInjection?.() ?? null;

    const total = Object.keys(status).length;
    const mounted = Object.values(status).filter(Boolean).length;

    let html = `<h3>🥵 CFS缓存优化器 · ${VERSION}</h3>`;

    // 总览
    html += '<div class="section">';
    html += '<div class="section-title">运行状态</div>';
    html += `<div class="row"><span class="k">当前阶段</span><span class="v ${phaseLbl.cls}">${phaseLbl.text}</span></div>`;
    html += `<div class="row"><span class="k">接管模式</span><span class="v ${modeLbl.cls}">${modeLbl.text}</span></div>`;
    html += `<div class="row"><span class="k">模块已挂载</span><span class="v ${mounted === total ? 'ok' : 'warn'}">${mounted} / ${total}</span></div>`;
    html += '</div>';

    // 注入状态
    html += '<div class="section">';
    html += '<div class="section-title">注入引擎</div>';
    html += `<div class="row"><span class="k">动态 entry UID</span><span class="v info">${dynUid}</span></div>`;
    if (lastInj && lastInj.contentLen !== undefined) {
        html += `<div class="row"><span class="k">上次注入字符</span><span class="v info">${lastInj.contentLen} 字符</span></div>`;
    } else {
        html += `<div class="row"><span class="k">上次注入</span><span class="v">尚未注入</span></div>`;
    }
    html += '</div>';

    // Day 10: 模块明细（默认折叠 / 有未挂模块时自动展开 + 标红）
    const totalMods = Object.keys(status).length;
    const failedMods = Object.entries(status).filter(([_, v]) => !v).map(([k]) => k);
    const failedCount = failedMods.length;
    const modDetailOpen = failedCount > 0 ? ' open' : ''; // 出错自动展开
    const modSummaryColor = failedCount > 0 ? 'color:#e88' : 'color:#7c7';
    const modSummaryIcon = failedCount > 0 ? `⚠️ ${failedCount} 项未挂` : `✓ 全部 ${totalMods} 项已挂`;
    html += '<div class="section">';
    html += `<details class="cfs-mod-details"${modDetailOpen}>`;
    html += `<summary style="${modSummaryColor};cursor:pointer;font-size:11px;padding:4px 0">📦 模块明细 — <b>${modSummaryIcon}</b><span style="color:#888;font-size:10px;margin-left:6px">(点击展开)</span></summary>`;
    html += '<div style="padding-top:6px">';
    for (const [k, v] of Object.entries(status)) {
        const rowStyle = !v ? 'background:#3a1f20;border-left:2px solid #e88;padding-left:6px' : '';
        html += `<div class="row" style="${rowStyle}"><span class="k">${k}</span><span class="v ${v ? 'ok' : 'err'}">${v ? '✓ 已挂' : '✗ 未挂'}</span></div>`;
    }
    html += '</div></details>';
    html += '</div>';

    // Day 7-5: CFS-MVU 套餐状态 section（默认折叠）
    const mvuInstalled = !!window.Mvu?._cfsEdition;
    const mvuSummaryColor = mvuInstalled ? 'color:#7c7' : 'color:#e88';
    const mvuSummaryIcon = mvuInstalled ? '✓ CFS-MVU 已就位' : '⚠️ CFS-MVU 未装';
    const mvuDetailOpen = mvuInstalled ? '' : ' open';
    html += '<div class="section">';
    html += `<details class="cfs-mvu-details"${mvuDetailOpen}>`;
    html += `<summary style="${mvuSummaryColor};cursor:pointer;font-size:11px;padding:4px 0">🧬 MVU 套餐 — <b>${mvuSummaryIcon}</b></summary>`;
    html += '<div style="padding-top:6px">';
    html += '<div class="row"><span class="k">CFS-MVU 扩展</span><span class="mvu-status-line">' + _renderMvuStatusLine() + '</span></div>';
    // 2026-06-21 v6 阶段 F：MVU F12 诊断入口
    html += '<div class="row" style="justify-content:flex-end;margin-top:4px">';
    html += '<button id="cfs-act-diag-mvu" class="" style="padding:3px 10px;font-size:10px;width:auto;margin:0" title="dump window.Mvu 元信息到 F12 console，定位 MVU 注册者">🔍 F12 诊断 Mvu 来源</button>';
    html += '</div>';
    html += '</div></details>';
    html += '</div>';

    // Day 10 修复 Day 5 假替代：PSIS / PSIS+ / SEM 入口 section
    // 之前 polyfill 注释说"用浮动胶囊替代"但根本没接 — 现在补上
    // 注意：PSIS+ / SEM 的 renderSection() 输出本身就是 <details>，外层不再套，否则要点两次
    html += '<div class="section">';
    html += '<div class="section-title">MVU 守护面板（PSIS / PSIS+ / SEM）</div>';
    html += '<div class="hint" style="margin:4px 0 8px 0">• 下方两块自带展开/收起，点击 summary 标题即可显示按钮和操作<br>• PSIS 三大块（数据库 / MVU / 动态注入）扫描归零功能较重，走独立弹窗</div>';
    // PSIS+ 直接 mount（它自己的 <details> 会作为第一层）
    html += '<div id="cfs-capsule-psisplus-mount" style="margin-top:6px"></div>';
    // SEM 直接 mount
    html += '<div id="cfs-capsule-sem-mount" style="margin-top:6px"></div>';
    // PSIS 三大块全功能面板（独立弹窗，不嵌入避免胶囊爆炸）
    html += '<div class="row" style="margin-top:10px;justify-content:center">';
    html += '<button id="cfs-act-psis-panel" class="primary" style="padding:4px 14px;font-size:11px;width:auto;margin:0">打开完整 MVU 守护面板（PSIS 三大块 + 系统接口管理）</button>';
    html += '</div>';
    html += '</div>';

    // Day 11: 长期记忆策略 section（合并原 Day 9 Full Refresh + Day 10 Auto Stable Promotion）
    const frInterval = _getFullRefreshInterval();
    const frCounter = _getFullRefreshCounter();
    const apCfg = _getAutoPromoteCfg();
    const apState = _getAutoPromoteState();
    const apLast = apState?.last;
    const apTotals = apState?.totals || { promoted: 0, demoted: 0, decayed: 0 };
    const currentPreset = _inferLtmPreset();
    const presetSummaryHtml = Object.entries(LTM_PRESETS).map(([name, p]) => {
        const active = name === currentPreset;
        const style = active
            ? 'background:#2a7f4f;color:#fff;border:1px solid #3a8f5f'
            : 'background:#1a1a1f;color:#cfcfd5;border:1px solid #2a2a30';
        return `<button class="cfs-ltm-preset-btn" data-preset="${name}" style="${style};padding:6px 10px;border-radius:4px;cursor:pointer;font-size:11px;width:auto;margin:0;flex:1;min-width:0">${p.label}</button>`;
    }).join('');
    const apStatusLine = apCfg.enabled
        ? `<span class="v ok">已开启 — 已识别 ${apTotals.promoted} 个稳态字段 / 撤销 ${apTotals.demoted} 次${apTotals.decayed ? ' / 重置 ' + apTotals.decayed + ' 次' : ''}</span>`
        : '<span class="v warn">已关闭 — 所有字段都当变化字段处理</span>';
    const apLastLine = apLast
        ? `<span class="v">第 ${apLast.round} 轮 / 查了 ${apLast.scanned} 个字段 / 本轮新认 ${apLast.promoted} 个 / 撤销 ${apLast.demoted} 个${apLast.locked ? ' / 已放弃 ' + apLast.locked + ' 个' : ''}</span>`
        : '<span class="v warn">尚未开始</span>';
    const frStatusLine = frInterval === 0
        ? '<span class="v warn">已关闭 — 不做周期完整快照</span>'
        : `<span class="v ok">每 ${frInterval} 轮注入一次完整快照（${frCounter}/${frInterval}，剩 ${Math.max(0, frInterval - frCounter)} 轮触发）</span>`;
    const currentPresetHint = currentPreset === 'custom'
        ? '当前为「自定义」— 任一高级参数与三档预设不匹配时落到此模式'
        : (LTM_PRESETS[currentPreset]?.hint || '');

    html += '<div class="section">';
    html += '<div class="section-title">📚 长期记忆策略</div>';
    html += `<div class="hint" style="margin:4px 0 8px 0">① 决定多少字段以 schema 占位符注入 — 越多 cache 越友好<br>② 长会话兜底：每 K 轮把当前全量数据塞一份做完整快照校准</div>`;
    // 三档预设
    html += `<div style="display:flex;gap:6px;margin:8px 0">${presetSummaryHtml}</div>`;
    html += `<div class="hint" style="margin:4px 0 8px 0;color:#8acaff">当前：${LTM_PRESETS[currentPreset]?.label || '🛠️ 自定义'} — ${currentPresetHint}</div>`;
    // 状态行
    html += `<div class="row" style="margin-top:8px"><span class="k">① 稳态识别</span>${apStatusLine}</div>`;
    html += `<div class="row"><span class="k">② 周期校准</span>${frStatusLine}</div>`;
    html += `<div class="row"><span class="k">上次扫描</span>${apLastLine}</div>`;
    // 高级参数折叠
    html += '<details class="cfs-ltm-advanced" style="margin-top:10px"><summary style="cursor:pointer;font-size:11px;padding:4px 0;color:#888">⚙️ 高级参数 — 自定义调节（任一改动会切到「自定义」模式）</summary>';
    html += '<div style="padding-top:8px">';
    // 开关
    html += '<div style="padding:8px;background:#0e0e0f;border-radius:4px;border:1px solid #2a2a30;margin-bottom:8px">';
    html += `<label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;color:#e0e0e0"><input type="checkbox" id="cfs-ap-enabled" ${apCfg.enabled ? 'checked' : ''} style="width:14px;height:14px"> <b>启用稳态识别</b> <span style="color:#888;font-size:10px">(关掉 = 完全不做 ①)</span></label>`;
    html += '</div>';
    html += '<div style="display:flex;flex-direction:column;gap:8px">';
    // ① promote after
    html += '<div style="padding:6px 8px;background:#0e0e0f;border-radius:4px;border:1px solid #2a2a30">';
    html += '<div style="font-size:11px;color:#e0e0e0;margin-bottom:4px"><b>① 多少轮没变化才算稳态字段？</b></div>';
    html += `<div style="display:flex;align-items:center;gap:8px"><input type="number" id="cfs-ap-promote-after" value="${apCfg.promoteAfter}" min="1" max="9999" style="width:60px;background:#1a1a1f;color:#e0e0e0;border:1px solid #444;border-radius:3px;padding:3px 6px;font-size:11px"><span style="font-size:10px;color:#888">轮 — 越小越激进；标准=20</span></div>`;
    html += '</div>';
    // ② thrash lock
    html += '<div style="padding:6px 8px;background:#0e0e0f;border-radius:4px;border:1px solid #2a2a30">';
    html += '<div style="font-size:11px;color:#e0e0e0;margin-bottom:4px"><b>② 一个字段反复变化几次就放弃尝试？</b></div>';
    html += `<div style="display:flex;align-items:center;gap:8px"><input type="number" id="cfs-ap-thrash-lock" value="${apCfg.thrashLock}" min="1" max="99" style="width:60px;background:#1a1a1f;color:#e0e0e0;border:1px solid #444;border-radius:3px;padding:3px 6px;font-size:11px"><span style="font-size:10px;color:#888">次 — 防止跳来跳去打断缓存；推荐 3</span></div>`;
    html += '</div>';
    // ③ decay
    html += '<div style="padding:6px 8px;background:#0e0e0f;border-radius:4px;border:1px solid #2a2a30">';
    html += '<div style="font-size:11px;color:#e0e0e0;margin-bottom:4px"><b>③ 多少轮重置一次"放弃记录"？</b></div>';
    html += `<div style="display:flex;align-items:center;gap:8px"><input type="number" id="cfs-ap-decay" value="${apCfg.decayEveryN}" min="0" max="9999" style="width:60px;background:#1a1a1f;color:#e0e0e0;border:1px solid #444;border-radius:3px;padding:3px 6px;font-size:11px"><span style="font-size:10px;color:#888">轮 — 让早期被放弃的字段有机会重试；推荐 100，填 0 = 永不重置</span></div>`;
    html += '</div>';
    // ④ Full Refresh interval
    html += '<div style="padding:6px 8px;background:#0e0e0f;border-radius:4px;border:1px solid #2a2a30">';
    html += '<div style="font-size:11px;color:#e0e0e0;margin-bottom:4px"><b>④ 每多少轮做一次完整快照校准？</b></div>';
    html += `<div style="display:flex;align-items:center;gap:8px"><input type="number" id="cfs-fr-interval" value="${frInterval}" min="0" max="9999" style="width:60px;background:#1a1a1f;color:#e0e0e0;border:1px solid #444;border-radius:3px;padding:3px 6px;font-size:11px"><span style="font-size:10px;color:#888">轮 — 0=关闭；标准=50；间隔越短 cache 越扰动</span></div>`;
    html += '</div>';
    // ⑤ 黑名单
    html += '<div style="padding:6px 8px;background:#0e0e0f;border-radius:4px;border:1px solid #2a2a30">';
    html += '<div style="font-size:11px;color:#e0e0e0;margin-bottom:4px"><b>⑤ 这些字段永远不要认作稳态（正则）</b></div>';
    html += `<textarea id="cfs-ap-whitelist" rows="2" style="width:100%;box-sizing:border-box;background:#1a1a1f;color:#e0e0e0;border:1px solid #444;border-radius:3px;padding:4px 6px;font-size:10px;font-family:monospace;resize:vertical">${(apCfg.whitelistRe || '').replace(/</g, '&lt;')}</textarea>`;
    html += '<div style="font-size:10px;color:#888;margin-top:3px">HP/SAN/当前位置/时间戳 这类每轮可能变的字段已默认覆盖</div>';
    html += '</div>';
    html += '</div>';
    // 按钮行
    html += '<div style="margin-top:10px;display:flex;justify-content:flex-end;gap:6px">';
    html += '<button id="cfs-ap-reset" style="padding:4px 12px;font-size:11px;width:auto;margin:0">重置识别结果</button>';
    html += '<button id="cfs-ap-save" class="primary" style="padding:4px 14px;font-size:11px;width:auto;margin:0">保存自定义配置</button>';
    html += '</div>';
    html += '</div>'; // close padding-top:8px
    html += '</details>';
    html += '</div>';

    // Day 11: RSI 请求结构诊断 section（CHAT_COMPLETION_PROMPT_READY 拍快照 + 跨轮 hash 对账）
    const rsi = window.CFS4?.RSI;
    const rsiRounds = rsi?.getRoundsCount ? rsi.getRoundsCount() : 0;
    const rsiSimple = rsi?.genSimpleOutput ? _escapeHtml(rsi.genSimpleOutput()) : '🔍 请求结构诊断 · RSI 模块未挂载';
    html += '<div class="section">';
    html += '<div class="section-title">🐞 请求结构诊断（RSI）</div>';
    html += '<div class="hint" style="margin:4px 0 6px 0">看运行时真实发出去的 messages 拓扑（PSIS+ 只看预设静态拓扑，遗漏运行时注入的块）</div>';
    html += `<pre id="cfs-rsi-output" style="background:#0e0e0f;border:1px solid #333;border-radius:4px;padding:8px 10px;font-family:'Consolas','Microsoft YaHei Mono',monospace;font-size:10px;line-height:1.5;color:#cfcfd5;max-height:280px;overflow:auto;margin:4px 0;white-space:pre">${rsiSimple}</pre>`;
    html += '<details style="margin-top:6px"><summary style="cursor:pointer;font-size:11px;color:#888">📋 全表（所有块）</summary>';
    html += `<pre id="cfs-rsi-full" style="background:#0e0e0f;border:1px solid #333;border-radius:4px;padding:8px 10px;font-family:'Consolas','Microsoft YaHei Mono',monospace;font-size:10px;line-height:1.5;color:#cfcfd5;max-height:320px;overflow:auto;margin:4px 0;white-space:pre">（点击展开后加载）</pre>`;
    html += '</details>';
    html += '<div style="display:flex;gap:6px;justify-content:flex-end;margin-top:6px">';
    html += '<button id="cfs-rsi-refresh" style="padding:2px 10px;font-size:10px;width:auto;margin:0">🔄 刷新</button>';
    html += '<button id="cfs-rsi-copy" style="padding:2px 10px;font-size:10px;width:auto;margin:0">📋 复制简洁版</button>';
    html += '<button id="cfs-rsi-copy-full" style="padding:2px 10px;font-size:10px;width:auto;margin:0">📋 复制全表</button>';
    html += '</div>';
    html += `<div class="hint" style="margin-top:4px">${rsiRounds === 0 ? '尚未捕获任何请求；发一条消息后即可看到结构' : `已捕获 ${rsiRounds} 轮请求（buffer 上限 5）`}</div>`;
    html += '</div>';

    // 2026-06-21 v6 PETL section — Prompt Entry Takeover Layer
    // 切卡时自动把含动态宏的 enabled entry 强制改 position 到 at_depth_as_user/depth=0
    // 解决「时间/地点变量等 volatile 字段在 before_char/after_char 高位每轮击穿 cache」
    const petl = window.CFS4?.PETL;
    const petlEnabled = petl?.isEnabled ? petl.isEnabled() : true;
    const petlHistory = petl?.getHistory ? petl.getHistory() : [];
    const petlLastFix = petlHistory.length > 0 ? petlHistory[petlHistory.length - 1] : null;
    const petlHistTotal = petlHistory.reduce((s, r) => {
        const books = r.books || {};
        return s + Object.keys(books).reduce((b, k) => b + (books[k]?.length || 0), 0);
    }, 0);
    html += '<div class="section">';
    html += '<div class="section-title">⚡ PETL · 动态注入接管（v6）</div>';
    html += '<div class="hint" style="margin:4px 0 6px 0">切卡自动扫所有含动态宏 entry（时间/地点/EJS/getvar 等），强制踢到 at_depth_as_user/depth=0；豁免：古法 — 用户在世界书条目名称上加 <code>[cfs:ignore]</code></div>';
    if (!petl) {
        html += '<div style="color:#e88;padding:6px 0">⚠ window.CFS4.PETL 未挂载（看 F12 [CFS-Suite/petl] 启动日志）</div>';
    } else {
        const stateColor = petlEnabled ? '#69db7c' : '#ff8787';
        const stateText = petlEnabled ? 'ON · 切卡自动扫' : 'OFF · 自动扫已禁用';
        html += `<div style="display:flex;align-items:center;gap:8px;margin:4px 0 8px 0;font-size:11px;">
            <span>状态：<b style="color:${stateColor}">${stateText}</b></span>
            <span style="color:#888">|</span>
            <span>历史接管 <b>${petlHistTotal}</b> 条 entry / <b>${petlHistory.length}</b> 次</span>
        </div>`;
        if (petlLastFix) {
            const since = Math.round((Date.now() - petlLastFix.ts) / 1000);
            const lastBookNames = Object.keys(petlLastFix.books || {}).join(' / ');
            const lastCount = Object.keys(petlLastFix.books || {}).reduce((s, k) => s + (petlLastFix.books[k]?.length || 0), 0);
            html += `<div class="hint" style="margin:4px 0">最近一次：${since}s 前接管 <b>${lastCount}</b> 条（${lastBookNames || '?'}，触发=${petlLastFix.triggered_by || '?'}）</div>`;
            const snaps = Object.values(petlLastFix.books || {}).flat().slice(0, 5);
            if (snaps.length > 0) {
                html += '<details style="margin:4px 0"><summary style="cursor:pointer;font-size:10px;color:#888">📋 最近一次接管明细（前 5 条）</summary>';
                html += '<pre style="background:#0e0e0f;border:1px solid #333;border-radius:4px;padding:6px 8px;font-size:10px;line-height:1.5;color:#cfcfd5;max-height:160px;overflow:auto;margin:4px 0;white-space:pre">';
                snaps.forEach(s => {
                    const oldPos = s.oldPosition == null ? '?' : s.oldPosition;
                    html += `uid=${s.uid}  ${oldPos} → at_depth_as_user/depth=0\n  ${_escapeHtml((s.comment || '').slice(0, 80))}\n`;
                });
                html += '</pre></details>';
            }
        } else {
            html += '<div class="hint" style="margin:4px 0">尚未接管任何 entry（切卡或点「立即扫」触发）</div>';
        }
        html += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">';
        if (petlEnabled) {
            html += '<button id="cfs-act-petl-disable" style="padding:3px 10px;font-size:10px;width:auto;margin:0">⏸ 关闭自动扫</button>';
        } else {
            html += '<button id="cfs-act-petl-enable" class="primary" style="padding:3px 10px;font-size:10px;width:auto;margin:0">▶ 开启自动扫</button>';
        }
        html += '<button id="cfs-act-petl-run" class="primary" style="padding:3px 10px;font-size:10px;width:auto;margin:0">⚡ 立即扫并接管</button>';
        html += '<button id="cfs-act-petl-dry" style="padding:3px 10px;font-size:10px;width:auto;margin:0">🔬 预演（不改写）</button>';
        html += '<button id="cfs-act-petl-rollback" class="danger" style="padding:3px 10px;font-size:10px;width:auto;margin:0">↩ 撤销最近一次</button>';
        html += '<button id="cfs-act-petl-clear-hist" style="padding:3px 10px;font-size:10px;width:auto;margin:0">🗑 清空历史</button>';
        html += '</div>';
    }
    html += '</div>';

    // 操作按钮 — 用人话
    html += '<div class="actions">';
    html += '<button id="cfs-act-enable" class="primary">🥵 启用接管</button>';
    html += '<button id="cfs-act-disable">⏸ 关闭接管</button>';
    html += '<button id="cfs-act-audit">🔍 重新校验 entry 位置</button>';
    html += '<button id="cfs-act-ls-clear" class="danger">🗑️ 清空 Path 缓存</button>';
    // Day 7-5/7-6
    html += '<button id="cfs-act-install-mvu" class="primary">📥 下载 CFS-MVU JSON</button>';
    html += '<button id="cfs-act-copy-mvu-url">📋 复制脚本 URL（备用）</button>';
    html += '<button id="cfs-act-scan-mvu" class="danger">🚫 扫描禁用其他 MVU</button>';
    html += '</div>';

    // 持久化日志框（按钮下方，记 CFS 操作提示历史，不消失）
    html += '<div class="log-header">';
    html += '<span class="section-title">操作记录</span>';
    html += '<button class="log-clear-btn" id="cfs-log-clear">清空</button>';
    html += '</div>';
    html += '<div class="log-box"></div>';

    html += '<div class="hint">';
    html += '• <b>启用接管</b>：CFS缓存优化器 接手 prompt 注入，省 token + 防止 MVU 输出污染<br>';
    html += '• <b>关闭接管</b>：临时回到原版 MVU 渲染（用于对比效果）<br>';
    html += '• <b>重新校验</b>：扫世界书 entry 位置 + 自动修复漂移<br>';
    html += '• <b>清空 Path 缓存</b>：删 localStorage 里的 path 记录（救命）<br>';
    html += '• 胶囊可拖动到任意位置，位置自动记忆<br>';
    html += '• F12 看 [CFS-Suite] / [CFS4] / [CFS v4.x] 完整日志';
    html += '</div>';

    panel.innerHTML = html;

    // 渲染日志框（panel 重渲染后历史不丢）
    _renderLogBox(panel);

    // Day 10 修复 Day 5 假替代：挂 PSIS+ / SEM section 到胶囊（用各模块自己的 renderSection 拿 HTML）
    // PSIS+/SEM bindEvents 签名是 (document, getPanel) — 它们用 ID 查元素（cfs-psisp-root / cfs-sem-root 都是全局唯一）
    try {
        const psisPlus = window.CFS4?.PSISPlus;
        const psisPlusMount = panel.querySelector('#cfs-capsule-psisplus-mount');
        if (psisPlus?.renderSection && psisPlusMount) {
            psisPlusMount.innerHTML = psisPlus.renderSection();
            if (typeof psisPlus.bindEvents === 'function') {
                try { psisPlus.bindEvents(document, () => panel); }
                catch (eP) { console.warn('[CFS-Suite] PSIS+ bindEvents 失败', eP); }
            }
        } else if (psisPlusMount) {
            psisPlusMount.innerHTML = '<div style="color:#e88;padding:8px">⚠️ CFS4.PSISPlus 未挂，看 F12 [CFS V4.9.3 功能] 启动日志</div>';
        }
    } catch (eP) { console.warn('[CFS-Suite] 挂 PSIS+ section 失败', eP); }

    try {
        const sem = window.CFS4?.SEM;
        const semMount = panel.querySelector('#cfs-capsule-sem-mount');
        if (sem?.renderSection && semMount) {
            semMount.innerHTML = sem.renderSection();
            if (typeof sem.bindEvents === 'function') {
                try { sem.bindEvents(document, () => panel); }
                catch (eS) { console.warn('[CFS-Suite] SEM bindEvents 失败', eS); }
            }
        } else if (semMount) {
            semMount.innerHTML = '<div style="color:#e88;padding:8px">⚠️ CFS4.SEM 未挂，看 F12 [CFS V4.9.3 功能] 启动日志</div>';
        }
    } catch (eS) { console.warn('[CFS-Suite] 挂 SEM section 失败', eS); }

    // PSIS 完整面板入口（独立弹窗，调 CFS4.PSIS.openPanel）
    panel.querySelector('#cfs-act-psis-panel')?.addEventListener('click', () => {
        const psis = window.CFS4?.PSIS;
        if (typeof psis?.openPanel !== 'function') {
            _pushLog(panel, 'CFS4.PSIS.openPanel 未挂载（看 F12 [CFS v3.0] 启动日志确认 PSIS 模块是否加载）', 'error');
            return;
        }
        try {
            psis.openPanel();
            _pushLog(panel, 'MVU 守护面板已打开（拖标题栏移动 / ESC 关闭）', 'success');
        } catch (e) {
            _pushLog(panel, '打开失败：' + (e?.message || e), 'error');
            console.error(e);
        }
    });

    // 绑事件
    panel.querySelector('#cfs-act-enable')?.addEventListener('click', () => {
        const fs = window.CFS4?.FallbackStrategy;
        if (!fs?.recoverToV4) {
            _pushLog(panel, 'FallbackStrategy.recoverToV4 不可用', 'error');
            return;
        }
        try {
            const r = fs.recoverToV4({ force: true, reason: 'manual_from_capsule' });
            const prev = r?.prevMode;
            const cur = r?.currentMode || 'v4_full';
            _pushLog(panel, `🥵 启用接管：${prev ? prev + ' → ' + cur : '已在 ' + cur}`, 'success');
        } catch (e) {
            _pushLog(panel, '启用失败：' + (e?.message || e), 'error');
            console.error(e);
        }
        setTimeout(() => _renderPanel(panel), 400);
    });

    panel.querySelector('#cfs-act-disable')?.addEventListener('click', () => {
        const fs = window.CFS4?.FallbackStrategy;
        if (!fs?.degradeToMvu) {
            _pushLog(panel, 'FallbackStrategy.degradeToMvu 不可用', 'error');
            return;
        }
        try {
            const r = fs.degradeToMvu({ reason: 'manual_from_capsule', auto: false });
            const prev = r?.prevMode;
            const cur = r?.currentMode || 'mvu_fallback';
            _pushLog(panel, `⏸ 关闭接管：${prev ? prev + ' → ' + cur : '已在 ' + cur}`, 'warn');
        } catch (e) {
            _pushLog(panel, '关闭失败：' + (e?.message || e), 'error');
            console.error(e);
        }
        setTimeout(() => _renderPanel(panel), 400);
    });

    panel.querySelector('#cfs-act-audit')?.addEventListener('click', async () => {
        const co = window.CFS4?.Coordinator;
        if (!co?.auditEntries) {
            _pushLog(panel, 'Coordinator.auditEntries 不可用', 'error');
            return;
        }
        _pushLog(panel, '🔍 开始校验 entry 位置…', 'info');
        try {
            const r = await co.auditEntries({ force: true });
            // 返回结构：{fixed, uids?} | {skipped, reason?} | {error, attempted?}
            if (r?.skipped) {
                _pushLog(panel, `⏸ 跳过：${r.reason || 'debounce 未到时间'}`, 'warn');
            } else if (r?.error) {
                _pushLog(panel, `校验失败：${r.error}${r.attempted ? ' (尝试修正 ' + r.attempted + ' 条)' : ''}`, 'error');
            } else {
                const fixed = r?.fixed ?? 0;
                const uidStr = r?.uids?.length ? ` (uid=${r.uids.join(',')})` : '';
                if (fixed > 0) {
                    _pushLog(panel, `✅ 校验完成：修正 ${fixed} 条${uidStr}`, 'success');
                } else {
                    _pushLog(panel, `✅ 校验完成：位置正确，无需修正`, 'success');
                }
            }
            // 同步从 audit state 拿 run_count 顺便展示
            const ast = co.getAuditState?.();
            if (ast) {
                _pushLog(panel, `  ↳ 累计 audit 跑过 ${ast.run_count} 次`, 'info');
            }
        } catch (e) {
            _pushLog(panel, '校验抛错：' + (e?.message || e), 'error');
            console.error(e);
        }
        setTimeout(() => _renderPanel(panel), 400);
    });

    panel.querySelector('#cfs-act-ls-clear')?.addEventListener('click', () => {
        if (!confirm('删 localStorage 里 cfs-suite/scriptvars/* 全部记录\n下次 F5 后 PathRegistry 会从 0 重建\n继续？')) return;
        const removed = [];
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k && k.startsWith('cfs-suite/scriptvars/')) {
                localStorage.removeItem(k);
                removed.push(k);
            }
        }
        _pushLog(panel, `🗑️ 已删 ${removed.length} 项 localStorage 项（下次 F5 生效）`, 'warn');
        if (removed.length > 0) {
            _pushLog(panel, `  ↳ ${removed.join(' / ')}`, 'info');
        }
    });

    panel.querySelector('#cfs-log-clear')?.addEventListener('click', () => {
        _logHistory.length = 0;
        _renderLogBox(panel);
    });

    // Day 7-5/7-6 事件
    // PETL section 事件
    panel.querySelector('#cfs-act-petl-enable')?.addEventListener('click', () => {
        const p = window.CFS4?.PETL;
        if (!p) { _pushLog(panel, '⚠ PETL 未挂载', 'warn'); return; }
        p.setEnabled(true);
        _pushLog(panel, '▶ PETL 自动扫已开启（切卡时自动扫并接管动态注入 entry）', 'info');
        try { _renderPanel(panel); } catch (_e) {}
    });
    panel.querySelector('#cfs-act-petl-disable')?.addEventListener('click', () => {
        const p = window.CFS4?.PETL;
        if (!p) { _pushLog(panel, '⚠ PETL 未挂载', 'warn'); return; }
        p.setEnabled(false);
        _pushLog(panel, '⏸ PETL 自动扫已关闭（仅手动「立即扫」触发）', 'warn');
        try { _renderPanel(panel); } catch (_e) {}
    });
    panel.querySelector('#cfs-act-petl-run')?.addEventListener('click', async () => {
        const p = window.CFS4?.PETL;
        if (!p) { _pushLog(panel, '⚠ PETL 未挂载', 'warn'); return; }
        _pushLog(panel, '⚡ PETL 立即扫并接管中...', 'info');
        try {
            const r = await p.runNow();
            if (r?.skipped) {
                _pushLog(panel, `⚠ 跳过：${r.reason}`, 'warn');
            } else {
                _pushLog(panel, `⚡ 接管完成：${r.applied || 0} 条 entry（候选 ${r.candidates || 0}） / 跳过 ${JSON.stringify(r.skipped || {})}`, 'ok');
            }
        } catch (e) { _pushLog(panel, `✗ 扫描异常：${e?.message || e}`, 'err'); }
        try { _renderPanel(panel); } catch (_e) {}
    });
    panel.querySelector('#cfs-act-petl-dry')?.addEventListener('click', async () => {
        const p = window.CFS4?.PETL;
        if (!p) { _pushLog(panel, '⚠ PETL 未挂载', 'warn'); return; }
        _pushLog(panel, '🔬 PETL 预演扫描中（不写回）...', 'info');
        try {
            const r = await p.scanDryRun();
            _pushLog(panel, `🔬 预演完成：候选 ${r.candidates || 0} 条 / 跳过 ${JSON.stringify(r.skipped || {})}`, 'info');
            const lbs = r.groupedByBook ? Object.keys(r.groupedByBook) : [];
            lbs.forEach(lb => {
                const snaps = r.groupedByBook[lb].snapshots || [];
                snaps.slice(0, 5).forEach(s => {
                    _pushLog(panel, `  ↳ [${lb}] uid=${s.uid} ${s.oldPosition} → at_depth_as_user/0  ${(s.comment || '').slice(0, 60)}`, 'info');
                });
                if (snaps.length > 5) _pushLog(panel, `  ↳ ...还有 ${snaps.length - 5} 条`, 'info');
            });
        } catch (e) { _pushLog(panel, `✗ 预演异常：${e?.message || e}`, 'err'); }
    });
    panel.querySelector('#cfs-act-petl-rollback')?.addEventListener('click', async () => {
        const p = window.CFS4?.PETL;
        if (!p) { _pushLog(panel, '⚠ PETL 未挂载', 'warn'); return; }
        if (!confirm('撤销 PETL 最近一次接管：把这些 entry 的 position/depth 还原到接管前？\n继续？')) return;
        try {
            const r = await p.rollbackLast();
            if (r.reason) {
                _pushLog(panel, `⚠ 回滚跳过：${r.reason}`, 'warn');
            } else {
                _pushLog(panel, `↩ 已回滚 ${r.reverted || 0} 条 entry 位置`, 'ok');
            }
        } catch (e) { _pushLog(panel, `✗ 回滚异常：${e?.message || e}`, 'err'); }
        try { _renderPanel(panel); } catch (_e) {}
    });
    panel.querySelector('#cfs-act-petl-clear-hist')?.addEventListener('click', () => {
        const p = window.CFS4?.PETL;
        if (!p) { _pushLog(panel, '⚠ PETL 未挂载', 'warn'); return; }
        if (!confirm('清空 PETL 接管历史记录（撤销功能将不可用）？\n继续？')) return;
        try { p.clearHistory(); _pushLog(panel, '🗑 PETL 历史已清空', 'warn'); }
        catch (e) { _pushLog(panel, `✗ 清空异常：${e?.message || e}`, 'err'); }
        try { _renderPanel(panel); } catch (_e) {}
    });

    panel.querySelector('#cfs-act-install-mvu')?.addEventListener('click', () => _installCfsMvu(panel));
    panel.querySelector('#cfs-act-copy-mvu-url')?.addEventListener('click', () => _copyCfsMvuUrl(panel));
    panel.querySelector('#cfs-act-scan-mvu')?.addEventListener('click', () => _scanAndDisableOtherMvu(panel));
    // 2026-06-21 v6 阶段 F：F12 诊断按钮
    panel.querySelector('#cfs-act-diag-mvu')?.addEventListener('click', () => {
        _diagnoseMvuRegistrant();
        _pushLog(panel, '🔍 已 dump window.Mvu 元信息到 F12 console（按 F12 看）', 'info');
    });

    // Day 11: 长期记忆策略 — 三档预设按钮
    panel.querySelectorAll('.cfs-ltm-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const name = btn.getAttribute('data-preset');
            if (!LTM_PRESETS[name]) return;
            _applyLtmPreset(name);
            const p = LTM_PRESETS[name];
            _pushLog(panel,
                `📚 长期记忆策略已切到 ${p.label}：稳态@${p.promoteAfter}轮 / 校准@${p.fullRefreshInterval === 0 ? '关闭' : '每'+p.fullRefreshInterval+'轮'}`,
                'success');
            setTimeout(() => _renderPanel(panel), 200);
        });
    });

    // Day 11: 高级参数 - 保存自定义配置（任一改动 → 自动切到 custom）
    panel.querySelector('#cfs-ap-save')?.addEventListener('click', () => {
        const enabled = !!panel.querySelector('#cfs-ap-enabled')?.checked;
        const promoteAfter = parseInt(panel.querySelector('#cfs-ap-promote-after')?.value, 10) || 20;
        const thrashLock = parseInt(panel.querySelector('#cfs-ap-thrash-lock')?.value, 10) || 3;
        const decayEveryN = parseInt(panel.querySelector('#cfs-ap-decay')?.value, 10) || 0;
        const frInterval = Math.max(0, parseInt(panel.querySelector('#cfs-fr-interval')?.value, 10) || 0);
        const whitelistRe = panel.querySelector('#cfs-ap-whitelist')?.value?.trim() || DEFAULT_AP_VOLATILE_RE;
        try { new RegExp(whitelistRe); }
        catch (e) {
            _pushLog(panel, '❌ 黑名单正则无效：' + (e?.message || e), 'error');
            return;
        }
        _setAutoPromoteCfg({ enabled, promoteAfter, thrashLock, decayEveryN, whitelistRe });
        _setFullRefreshInterval(frInterval);
        try { localStorage.setItem(LS_FULL_REFRESH_COUNTER, '0'); } catch {} // 切配置时同步重置 counter
        _setLtmPreset('custom');
        _pushLog(panel,
            `✓ 自定义配置已保存：稳态识别${enabled ? '开' : '关'}@${promoteAfter}轮 / 完整快照${frInterval === 0 ? '关闭' : '每'+frInterval+'轮'}`,
            enabled ? 'success' : 'warn');
        setTimeout(() => _renderPanel(panel), 300);
    });

    // Day 10: 重置计数（救场用，把所有 path 的 promote/demote/stable_rounds 归零）
    panel.querySelector('#cfs-ap-reset')?.addEventListener('click', () => {
        const is = window.CFS4?.InjectionStrategy;
        if (!is?.resetAutoPromoteCounters) {
            _pushLog(panel, 'InjectionStrategy.resetAutoPromoteCounters 不可用', 'error');
            return;
        }
        if (!confirm('确认重置所有 path 的 promote/demote/stable_rounds 计数？\n(已升 stable 的 path 保留 stable 标记，仅清零观察计数器)')) return;
        try {
            const r = is.resetAutoPromoteCounters();
            _pushLog(panel, `🔄 已重置 ${r.reset} 个 path 的观察计数`, 'success');
        } catch (e) {
            _pushLog(panel, '重置失败：' + (e?.message || e), 'error');
        }
        setTimeout(() => _renderPanel(panel), 300);
    });

    // Day 11: RSI 事件 — 刷新 / 复制 / 全表展开按需加载
    panel.querySelector('#cfs-rsi-refresh')?.addEventListener('click', () => {
        const rsi = window.CFS4?.RSI;
        const el = panel.querySelector('#cfs-rsi-output');
        if (el && rsi?.genSimpleOutput) el.textContent = rsi.genSimpleOutput();
        _pushLog(panel, '🔄 已刷新请求结构诊断', 'info');
    });
    panel.querySelector('#cfs-rsi-copy')?.addEventListener('click', async () => {
        const rsi = window.CFS4?.RSI;
        const text = rsi?.genSimpleOutput?.() ?? '';
        if (!text) { _pushLog(panel, 'RSI 尚无数据', 'warn'); return; }
        try { await navigator.clipboard.writeText(text); _pushLog(panel, '📋 简洁版已复制到剪贴板', 'success'); }
        catch (e) { _pushLog(panel, '复制失败：' + (e?.message || e), 'error'); }
    });
    panel.querySelector('#cfs-rsi-copy-full')?.addEventListener('click', async () => {
        const rsi = window.CFS4?.RSI;
        const text = rsi?.genFullOutput?.() ?? '';
        if (!text) { _pushLog(panel, 'RSI 尚无数据', 'warn'); return; }
        try { await navigator.clipboard.writeText(text); _pushLog(panel, '📋 全表已复制到剪贴板', 'success'); }
        catch (e) { _pushLog(panel, '复制失败：' + (e?.message || e), 'error'); }
    });
    // 全表按需加载（点 details summary 才算）
    const rsiFullDetails = panel.querySelector('#cfs-rsi-full')?.closest('details');
    rsiFullDetails?.addEventListener('toggle', () => {
        if (!rsiFullDetails.open) return;
        const rsi = window.CFS4?.RSI;
        const el = panel.querySelector('#cfs-rsi-full');
        if (el && rsi?.genFullOutput) el.textContent = rsi.genFullOutput();
    });

    // 异步刷新 CFS-MVU 状态
    _refreshCfsMvuStatus(panel);
}
