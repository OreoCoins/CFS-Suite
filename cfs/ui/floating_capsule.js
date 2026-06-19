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
const VERSION = '5.0.0-day4a';
const LS_POS_KEY = 'cfs-suite/ui/capsule_position';

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
            right: 16px;
            bottom: 92px;
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
        'PSIS R1 守护': !!c.PSIS,
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

    // 模块明细（可折叠）
    html += '<div class="section">';
    html += '<div class="section-title">模块明细（13 项）</div>';
    for (const [k, v] of Object.entries(status)) {
        html += `<div class="row"><span class="k">${k}</span><span class="v ${v ? 'ok' : 'err'}">${v ? '✓ 已挂' : '✗ 未挂'}</span></div>`;
    }
    html += '</div>';

    // 操作按钮 — 用人话
    html += '<div class="actions">';
    html += '<button id="cfs-act-enable" class="primary">🥵 启用接管</button>';
    html += '<button id="cfs-act-disable">⏸ 关闭接管</button>';
    html += '<button id="cfs-act-audit">🔍 重新校验 entry 位置</button>';
    html += '<button id="cfs-act-ls-clear" class="danger">🗑️ 清空 Path 缓存</button>';
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
}
