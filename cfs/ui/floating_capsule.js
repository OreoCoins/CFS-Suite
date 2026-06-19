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
const VERSION = '5.0.0-day5';
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
            transition: transform 0.1s ease;
        }
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

        /* 移动端胶囊本体放大方便触屏命中（位置已锚定右上，无需再调 top/right） */
        @media (max-width: 768px), (max-height: 500px) {
            #cfs-suite-capsule {
                padding: 10px 16px;
                font-size: 13px;
            }
        }
    `;
    document.head.appendChild(style);

    // ===== DOM =====
    const capsule = document.createElement('div');
    capsule.id = 'cfs-suite-capsule';
    capsule.textContent = `🥵 CFS缓存优化器 · 加载中`;
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

    // ===== 拖拽 =====
    let dragOffsetX = 0, dragOffsetY = 0;
    let dragStartX = 0, dragStartY = 0;
    let isDragging = false;
    let didMove = false;

    capsule.addEventListener('mousedown', (e) => {
        e.preventDefault();
        isDragging = true;
        didMove = false;
        capsule.classList.add('dragging');
        const rect = capsule.getBoundingClientRect();
        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        if (!didMove && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
            didMove = true;
        }
        if (didMove) {
            const left = Math.max(0, Math.min(window.innerWidth - capsule.offsetWidth, e.clientX - dragOffsetX));
            const top = Math.max(0, Math.min(window.innerHeight - capsule.offsetHeight, e.clientY - dragOffsetY));
            capsule.style.left = left + 'px';
            capsule.style.top = top + 'px';
            capsule.style.right = 'auto';
            capsule.style.bottom = 'auto';
            _repositionPanel(capsule, panel);
        }
    });

    document.addEventListener('mouseup', () => {
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
    });

    // 点面板外关闭
    document.addEventListener('click', (e) => {
        if (isDragging) return;
        if (!panel.contains(e.target) && e.target !== capsule) {
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

    if (mounted === total && (phase === 'DONE' || phase === 'READY_FULL')) {
        capsule.textContent = `🥵 CFS缓存优化器 · ${modeLbl.text}`;
    } else if (mounted === total) {
        capsule.textContent = `🥵 CFS缓存优化器 · ${_phaseLabel(phase).text}`;
    } else {
        capsule.textContent = `🥵 CFS缓存优化器 · 加载中 ${mounted}/${total}`;
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
const _cfsMvuStatus = { installed: null, version: null, lastCheckedAt: 0 };

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
    const el = panel?.querySelector?.('.mvu-status-line');
    if (el) el.innerHTML = _renderMvuStatusLine();
}

function _renderMvuStatusLine() {
    if (_cfsMvuStatus.installed && _cfsMvuStatus.version) {
        return `<span class="v ok">✓ CFS-MVU 已生效 (v${_cfsMvuStatus.version})</span>`;
    }
    if (typeof window.Mvu?.getMvuData === 'function') {
        return '<span class="v warn">⚠️ Mvu 存在但非 CFS-MVU 套餐版（建议换装）</span>';
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

async function _scanAndDisableOtherMvu(panel) {
    // 酒馆助手把 getScriptTrees / updateScriptTreesWith 仅暴露给 iframe 内脚本，
    // 主页面 window.TavernHelper 不包含这些方法。
    // 优先用 TavernHelper 直接挂的 namespace（若存在），否则降级到引导手动禁
    const TH = window.TavernHelper;
    const getTrees = TH?.getScriptTrees ?? window.getScriptTrees;
    const updateTreesWith = TH?.updateScriptTreesWith ?? window.updateScriptTreesWith;
    if (typeof getTrees !== 'function' || typeof updateTreesWith !== 'function') {
        _pushLog(panel, '⚠️ 酒馆助手 API 不在 ST 主页面暴露（只在 iframe 内可用）', 'warn');
        _pushLog(panel, '  ↳ 请手动操作：扩展面板 → 酒馆助手 → 脚本管理', 'info');
        _pushLog(panel, '  ↳ 找含「MVU/MagVar/变量框架」名字的脚本（排除 CFS-MVU）', 'info');
        _pushLog(panel, '  ↳ 点关闭按钮禁用，F5 ST 后生效', 'info');
        return;
    }
    _pushLog(panel, '🔍 扫描酒馆助手脚本（global + character + preset）…', 'info');

    const isMvuScript = (s) => {
        const name = (s.name || '').toLowerCase();
        const isMvu = /mvu|magvar|变量框架|variable.?framework/i.test(name);
        const isCfsMvu = /cfs[-_ ]?mvu|cfs[-_ ]?suite/i.test(name);
        return isMvu && !isCfsMvu;
    };

    const types = ['global', 'character', 'preset'];
    const allTargets = [];
    for (const t of types) {
        try {
            const trees = await getTrees({ type: t });
            const scripts = _flattenScriptTrees(trees);
            const targets = scripts.filter(s => isMvuScript(s) && s.enabled !== false);
            if (targets.length > 0) {
                allTargets.push({ type: t, targets });
                _pushLog(panel, `  ↳ ${t}: 找到 ${targets.length} 个`, 'info');
            }
        } catch (e) {
            _pushLog(panel, `  ↳ ${t} 扫描失败: ${e?.message ?? e}`, 'warn');
        }
    }

    if (allTargets.length === 0) {
        _pushLog(panel, '✅ 未发现其他启用的 MVU 脚本，无需禁用', 'success');
        return;
    }

    const allNames = allTargets.flatMap(g => g.targets.map(s => `[${g.type}] 「${s.name}」`)).join('\n');
    const total = allTargets.reduce((sum, g) => sum + g.targets.length, 0);
    if (!confirm(`找到 ${total} 个启用的非 CFS-MVU 脚本：\n${allNames}\n\n确定禁用？（仅运行时禁用，不删脚本）`)) {
        _pushLog(panel, '⏸ 用户取消', 'warn');
        return;
    }

    let disabled = 0;
    for (const { type, targets } of allTargets) {
        const ids = new Set(targets.map(s => s.id));
        try {
            await updateTreesWith((trees) => {
                const updater = (nodes) => nodes.map(n => {
                    if (n.type === 'script' && ids.has(n.id)) {
                        return { ...n, enabled: false };
                    }
                    if (n.type === 'folder' && Array.isArray(n.scripts)) {
                        return { ...n, scripts: updater(n.scripts) };
                    }
                    return n;
                });
                return updater(trees);
            }, { type });
            disabled += targets.length;
            for (const s of targets) _pushLog(panel, `  ↳ ✓ [${type}] ${s.name}`, 'success');
        } catch (e) {
            _pushLog(panel, `  ↳ ✗ ${type} 写回失败: ${e?.message ?? e}`, 'error');
        }
    }
    _pushLog(panel, `🚫 完成：禁用 ${disabled}/${total} 个 MVU 脚本（F5 生效）`, 'success');
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

    // Day 9: Full Refresh 长期记忆锚点配置 section
    const frInterval = _getFullRefreshInterval();
    const frCounter = _getFullRefreshCounter();
    const frStatus = frInterval === 0
        ? '<span class="v warn">关闭（纯 v4_full，cache 最友好但 LLM 可能失忆）</span>'
        : `<span class="v ok">每 ${frInterval} 轮注入一次（已累计 ${frCounter}/${frInterval}，剩 ${Math.max(0, frInterval - frCounter)} 轮触发）</span>`;
    html += '<div class="section">';
    html += '<div class="section-title">长期记忆锚点（Full Refresh）</div>';
    html += `<div class="row"><span class="k">当前状态</span>${frStatus}</div>`;
    html += '<div class="row" style="align-items:center"><span class="k">每 N 轮刷新</span>';
    html += `<input type="number" id="cfs-fr-interval" value="${frInterval}" min="0" max="9999" style="width:80px;background:#0e0e0f;color:#e0e0e0;border:1px solid #444;border-radius:4px;padding:3px 6px;font-size:11px"> <button id="cfs-fr-save" style="padding:2px 8px;font-size:10px;width:auto;margin:0 0 0 4px">保存</button>`;
    html += '</div>';
    html += '<div class="hint" style="margin-top:4px">• 0 = 关闭（默认）• 20 = 高频刷新 • 50 = 中等 • 100 = 稀刷 • 越小 cache miss 越多，但 LLM 越不容易失忆</div>';
    html += '</div>';

    // Day 10: 自动 Stable Promotion 配置 section
    const apCfg = _getAutoPromoteCfg();
    const apState = _getAutoPromoteState();
    const apLast = apState?.last;
    const apTotals = apState?.totals || { promoted: 0, demoted: 0, decayed: 0 };
    const apStatusLine = apCfg.enabled
        ? `<span class="v ok">已开启 — 已识别 ${apTotals.promoted} 个稳态字段 / 撤销了 ${apTotals.demoted} 次${apTotals.decayed ? ' / 重置 ' + apTotals.decayed + ' 次' : ''}</span>`
        : '<span class="v warn">已关闭 — 不优化，所有字段都当变化字段处理</span>';
    const apLastLine = apLast
        ? `<span class="v">第 ${apLast.round} 轮 / 查了 ${apLast.scanned} 个字段 / 本轮新认 ${apLast.promoted} 个 / 撤销 ${apLast.demoted} 个${apLast.locked ? ' / 已放弃 ' + apLast.locked + ' 个' : ''}</span>`
        : '<span class="v warn">尚未开始</span>';
    // Day 10 第三轮 UX 优化：每项配置独立成行，label 在上 input 在下，去掉 promote/demote/volatile/decay 术语换人话
    html += '<div class="section">';
    html += '<div class="section-title">自动识别稳态字段（Day 10）</div>';
    html += `<div class="row" style="margin-top:4px"><span class="k">当前状态</span>${apStatusLine}</div>`;
    html += `<div class="row"><span class="k">上次扫描</span>${apLastLine}</div>`;
    // 开关
    html += '<div style="margin-top:10px;padding:8px;background:#0e0e0f;border-radius:4px;border:1px solid #2a2a30">';
    html += `<label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;color:#e0e0e0"><input type="checkbox" id="cfs-ap-enabled" ${apCfg.enabled ? 'checked' : ''} style="width:14px;height:14px"> <b>启用自动识别</b> <span style="color:#888;font-size:10px">(关掉 = 完全不优化)</span></label>`;
    html += '</div>';
    // 三个数字配置 — 每项一个块，标题在上输入在下
    html += '<div style="margin-top:8px;display:flex;flex-direction:column;gap:8px">';
    // 1. 多少轮算稳态
    html += '<div style="padding:6px 8px;background:#0e0e0f;border-radius:4px;border:1px solid #2a2a30">';
    html += '<div style="font-size:11px;color:#e0e0e0;margin-bottom:4px"><b>① 多少轮没变化才算稳态字段？</b></div>';
    html += `<div style="display:flex;align-items:center;gap:8px"><input type="number" id="cfs-ap-promote-after" value="${apCfg.promoteAfter}" min="1" max="9999" style="width:60px;background:#1a1a1f;color:#e0e0e0;border:1px solid #444;border-radius:3px;padding:3px 6px;font-size:11px"><span style="font-size:10px;color:#888">轮 — 越小越激进、越快省 token；推荐 20</span></div>`;
    html += '</div>';
    // 2. 反复几次放弃
    html += '<div style="padding:6px 8px;background:#0e0e0f;border-radius:4px;border:1px solid #2a2a30">';
    html += '<div style="font-size:11px;color:#e0e0e0;margin-bottom:4px"><b>② 一个字段反复变化几次就放弃尝试？</b></div>';
    html += `<div style="display:flex;align-items:center;gap:8px"><input type="number" id="cfs-ap-thrash-lock" value="${apCfg.thrashLock}" min="1" max="99" style="width:60px;background:#1a1a1f;color:#e0e0e0;border:1px solid #444;border-radius:3px;padding:3px 6px;font-size:11px"><span style="font-size:10px;color:#888">次 — 防止跳来跳去打断缓存；推荐 3</span></div>`;
    html += '</div>';
    // 3. 多少轮重置
    html += '<div style="padding:6px 8px;background:#0e0e0f;border-radius:4px;border:1px solid #2a2a30">';
    html += '<div style="font-size:11px;color:#e0e0e0;margin-bottom:4px"><b>③ 多少轮重置一次"放弃记录"？</b></div>';
    html += `<div style="display:flex;align-items:center;gap:8px"><input type="number" id="cfs-ap-decay" value="${apCfg.decayEveryN}" min="0" max="9999" style="width:60px;background:#1a1a1f;color:#e0e0e0;border:1px solid #444;border-radius:3px;padding:3px 6px;font-size:11px"><span style="font-size:10px;color:#888">轮 — 让早期被放弃的字段有机会重试；推荐 100，填 0 = 永不重置</span></div>`;
    html += '</div>';
    // 4. 黑名单字段
    html += '<div style="padding:6px 8px;background:#0e0e0f;border-radius:4px;border:1px solid #2a2a30">';
    html += '<div style="font-size:11px;color:#e0e0e0;margin-bottom:4px"><b>④ 这些字段永远不要认作稳态（正则）</b></div>';
    html += `<textarea id="cfs-ap-whitelist" rows="2" style="width:100%;box-sizing:border-box;background:#1a1a1f;color:#e0e0e0;border:1px solid #444;border-radius:3px;padding:4px 6px;font-size:10px;font-family:monospace;resize:vertical">${(apCfg.whitelistRe || '').replace(/</g, '&lt;')}</textarea>`;
    html += '<div style="font-size:10px;color:#888;margin-top:3px">HP/SAN/当前位置/时间戳 这类每轮可能变的字段已默认覆盖</div>';
    html += '</div>';
    html += '</div>';
    // 按钮行
    html += '<div style="margin-top:10px;display:flex;justify-content:flex-end;gap:6px">';
    html += '<button id="cfs-ap-reset" style="padding:4px 12px;font-size:11px;width:auto;margin:0">重置识别结果</button>';
    html += '<button id="cfs-ap-save" class="primary" style="padding:4px 14px;font-size:11px;width:auto;margin:0">保存配置</button>';
    html += '</div>';
    html += '<div class="hint" style="margin-top:6px">• 第一次开新卡至少要聊 ① 配的轮数才会开始省 token<br>• 字段一旦认作稳态后，剧情里它真变了会立刻撤销（保证数据正确）<br>• 关掉总开关 = 完全不优化（默认 81% 命中率天花板），开启后期望命中率回升 90%+</div>';
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
            psisPlusMount.innerHTML = '<div style="color:#e88;padding:8px">⚠️ CFS4.PSISPlus 未挂，看 F12 [CFS v4.9.3 PSIS Plus] 启动日志</div>';
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
            semMount.innerHTML = '<div style="color:#e88;padding:8px">⚠️ CFS4.SEM 未挂，看 F12 [CFS v4.9.1 SEM] 启动日志</div>';
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
    panel.querySelector('#cfs-act-install-mvu')?.addEventListener('click', () => _installCfsMvu(panel));
    panel.querySelector('#cfs-act-copy-mvu-url')?.addEventListener('click', () => _copyCfsMvuUrl(panel));
    panel.querySelector('#cfs-act-scan-mvu')?.addEventListener('click', () => _scanAndDisableOtherMvu(panel));

    // Day 10: 自动 Stable Promotion 配置保存
    panel.querySelector('#cfs-ap-save')?.addEventListener('click', () => {
        const enabled = !!panel.querySelector('#cfs-ap-enabled')?.checked;
        const promoteAfter = parseInt(panel.querySelector('#cfs-ap-promote-after')?.value, 10) || 20;
        const thrashLock = parseInt(panel.querySelector('#cfs-ap-thrash-lock')?.value, 10) || 3;
        const decayEveryN = parseInt(panel.querySelector('#cfs-ap-decay')?.value, 10) || 0;
        const whitelistRe = panel.querySelector('#cfs-ap-whitelist')?.value?.trim() || DEFAULT_AP_VOLATILE_RE;
        // 校验正则可编译
        try { new RegExp(whitelistRe); }
        catch (e) {
            _pushLog(panel, '❌ volatile 白名单正则无效：' + (e?.message || e), 'error');
            return;
        }
        _setAutoPromoteCfg({ enabled, promoteAfter, thrashLock, decayEveryN, whitelistRe });
        _pushLog(panel,
            `✓ 自动 promotion 配置已保存：${enabled ? '开启' : '关闭'} / promote@${promoteAfter}轮 / 抖动锁${thrashLock} / decay@${decayEveryN}轮`,
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

    // Day 9: Full Refresh 配置保存
    panel.querySelector('#cfs-fr-save')?.addEventListener('click', () => {
        const input = panel.querySelector('#cfs-fr-interval');
        const n = parseInt(input?.value ?? '0', 10) || 0;
        _setFullRefreshInterval(n);
        if (n === 0) {
            _pushLog(panel, '🔄 Full Refresh 已关闭（保持纯 v4_full cache 最友好模式）', 'warn');
        } else {
            _pushLog(panel, `🔄 Full Refresh 设为每 ${n} 轮刷新一次（重置计数器）`, 'success');
            // 用户改 interval 时同步重置计数器，避免下轮立刻触发
            try { localStorage.setItem(LS_FULL_REFRESH_COUNTER, '0'); } catch {}
        }
        setTimeout(() => _renderPanel(panel), 300);
    });

    // 异步刷新 CFS-MVU 状态
    _refreshCfsMvuStatus(panel);
}
