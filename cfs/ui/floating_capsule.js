/**
 * CFS-Suite · ui/floating_capsule.js
 *
 * 浮动胶囊入口（Day 4 附加版）。
 * 右下角固定一个胶囊「🛡️ CFS Suite」+ 状态颜色；点击展开 mini 面板。
 *
 * **作用域**：
 *   - 模块挂载状态（13 项）+ Coordinator phase / FallbackStrategy mode
 *   - Audit run 计数实时刷新（每 2 秒）
 *   - 切换 FallbackStrategy mode（v4_full / mvu_fallback）按钮
 *   - 清 PathRegistry localStorage（救命，避免 90KB 累积）
 *   - 跳到 F12 console 历史的提示
 *
 * **不做的事**（留 Day 6 完整 panel.js 迁移）：
 *   - SEM 候选扫描 / 一键迁移
 *   - PSIS+ 操作记录 / 回滚 UI
 *   - 完整 MVU 守护面板（renderMvuConsole 整段）
 */

const TAG = '[CFS-Suite/ui]';
const VERSION = '5.0.0-day4a';

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
            font-family: -apple-system, "Segoe UI", sans-serif;
            cursor: pointer;
            box-shadow: 0 4px 14px rgba(0,0,0,0.3);
            user-select: none;
            transition: transform 0.15s ease;
        }
        #cfs-suite-capsule:hover { transform: scale(1.05); }
        #cfs-suite-capsule.status-warn { background: linear-gradient(135deg, #b8860b 0%, #856200 100%); }
        #cfs-suite-capsule.status-error { background: linear-gradient(135deg, #c0392b 0%, #872c20 100%); }

        #cfs-suite-panel {
            position: fixed;
            right: 16px;
            bottom: 140px;
            z-index: 9999;
            background: #1c1c1e;
            color: #e0e0e0;
            border: 1px solid #444;
            border-radius: 10px;
            box-shadow: 0 6px 24px rgba(0,0,0,0.5);
            min-width: 320px;
            max-width: 380px;
            max-height: 70vh;
            overflow-y: auto;
            padding: 14px 16px;
            font-size: 12px;
            font-family: -apple-system, "Segoe UI", sans-serif;
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
        #cfs-suite-panel .row {
            display: flex;
            justify-content: space-between;
            padding: 2px 0;
        }
        #cfs-suite-panel .row .k { color: #888; }
        #cfs-suite-panel .row .v.ok { color: #6ed29c; }
        #cfs-suite-panel .row .v.warn { color: #f0c060; }
        #cfs-suite-panel .row .v.err { color: #e07060; }
        #cfs-suite-panel .actions {
            margin-top: 10px;
            border-top: 1px solid #333;
            padding-top: 8px;
        }
        #cfs-suite-panel button {
            background: #2a4a6e;
            color: #fff;
            border: 1px solid #3a5a7e;
            padding: 5px 10px;
            border-radius: 4px;
            font-size: 11px;
            cursor: pointer;
            margin-right: 6px;
            margin-bottom: 4px;
        }
        #cfs-suite-panel button:hover { background: #3a5a7e; }
        #cfs-suite-panel button.danger { background: #6e2a2a; border-color: #7e3a3a; }
        #cfs-suite-panel button.danger:hover { background: #7e3a3a; }
        #cfs-suite-panel .hint {
            color: #777;
            font-size: 10px;
            margin-top: 6px;
            line-height: 1.4;
        }
    `;
    document.head.appendChild(style);

    // ===== DOM =====
    const capsule = document.createElement('div');
    capsule.id = 'cfs-suite-capsule';
    capsule.textContent = `🛡️ CFS Suite ${VERSION}`;
    document.body.appendChild(capsule);

    const panel = document.createElement('div');
    panel.id = 'cfs-suite-panel';
    document.body.appendChild(panel);

    // ===== 交互 =====
    capsule.addEventListener('click', (e) => {
        e.stopPropagation();
        panel.classList.toggle('open');
        if (panel.classList.contains('open')) _renderPanel(panel);
    });
    document.addEventListener('click', (e) => {
        if (!panel.contains(e.target) && e.target !== capsule) {
            panel.classList.remove('open');
        }
    });

    // ===== 状态轮询（仅 capsule 颜色，不刷面板）=====
    setInterval(() => _updateCapsuleStatus(capsule), 2000);
    _updateCapsuleStatus(capsule);

    console.log(`${TAG} 浮动胶囊已挂载`);
}

function _moduleStatus() {
    const c = window.CFS4 ?? {};
    return {
        SessionGate: !!c.SessionGate,
        Coordinator: !!c.Coordinator,
        NotificationCenter: !!c.NotificationCenter,
        SchemaFrozenLayer: !!c.SchemaFrozenLayer,
        SchemaSwapGate: !!c.SchemaSwapGate,
        SchemaResolver: !!c.SchemaResolver,
        PathRegistry: !!c.PathRegistry,
        DiffEngine: !!c.DiffEngine,
        PresenceEncoder: !!c.PresenceEncoder,
        InjectionStrategy: !!c.InjectionStrategy,
        FallbackStrategy: !!c.FallbackStrategy,
        HealthMonitor: !!c.HealthMonitor,
        RealTakeover: !!c._realTakeoverIIFEDone,
    };
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
    const phase = window.CFS4?.Coordinator?.getPhase?.() ?? '?';
    capsule.textContent = `🛡️ CFS ${mounted}/${total} · ${phase}`;
}

function _renderPanel(panel) {
    const status = _moduleStatus();
    const phase = window.CFS4?.Coordinator?.getPhase?.() ?? 'unknown';
    const mode = window.CFS4?.FallbackStrategy?.getCurrentMode?.() ?? 'unknown';
    const dynUid = window.CFS4?.InjectionStrategy?.getDynamicEntryUid?.() ?? '?';
    const lastInj = window.CFS4?.InjectionStrategy?.getLastInjection?.() ?? null;
    const auditState = window.CFS4?.Coordinator?.getAuditState?.() ?? {};

    let html = `<h3>🛡️ CFS Suite ${VERSION}</h3>`;

    // 模块状态
    html += '<div><b style="color:#888">模块挂载</b></div>';
    for (const [k, v] of Object.entries(status)) {
        html += `<div class="row"><span class="k">${k}</span><span class="v ${v ? 'ok' : 'err'}">${v ? '✓' : '✗'}</span></div>`;
    }
    const total = Object.keys(status).length;
    const mounted = Object.values(status).filter(Boolean).length;
    html += `<div class="row"><span class="k">小计</span><span class="v ${mounted === total ? 'ok' : 'warn'}">${mounted}/${total}</span></div>`;

    // Coordinator 状态
    html += '<div style="margin-top:8px"><b style="color:#888">Coordinator</b></div>';
    html += `<div class="row"><span class="k">phase</span><span class="v ${phase === 'DONE' || phase === 'READY_FULL' ? 'ok' : 'warn'}">${phase}</span></div>`;

    // FallbackStrategy
    html += '<div style="margin-top:8px"><b style="color:#888">FallbackStrategy</b></div>';
    html += `<div class="row"><span class="k">mode</span><span class="v ${mode === 'v4_full' ? 'ok' : 'warn'}">${mode}</span></div>`;

    // InjectionStrategy 最近一次注入
    html += '<div style="margin-top:8px"><b style="color:#888">InjectionStrategy</b></div>';
    html += `<div class="row"><span class="k">dynamic_entry_uid</span><span class="v">${dynUid}</span></div>`;
    if (lastInj) {
        html += `<div class="row"><span class="k">last 注入</span><span class="v">${lastInj.contentLen ?? '?'} 字符</span></div>`;
    }

    // 快捷动作
    html += '<div class="actions">';
    html += '<button id="cfs-act-mode-full">→ v4_full</button>';
    html += '<button id="cfs-act-mode-fallback">→ mvu_fallback</button>';
    html += '<button id="cfs-act-audit-force">force audit</button>';
    html += '<button id="cfs-act-ls-clear" class="danger">清 LS PathRegistry</button>';
    html += '</div>';

    html += '<div class="hint">F12 console grep [CFS-Suite] / [CFS4] / [CFS v4.x] 看完整日志。本胶囊是 Day 4 附加；完整 MVU 守护面板留 Day 6 迁移。</div>';

    panel.innerHTML = html;

    // 绑事件
    panel.querySelector('#cfs-act-mode-full')?.addEventListener('click', () => {
        window.CFS4?.FallbackStrategy?.recoverToV4?.();
        setTimeout(() => _renderPanel(panel), 200);
    });
    panel.querySelector('#cfs-act-mode-fallback')?.addEventListener('click', () => {
        window.CFS4?.FallbackStrategy?.degradeToFallback?.('manual_from_capsule');
        setTimeout(() => _renderPanel(panel), 200);
    });
    panel.querySelector('#cfs-act-audit-force')?.addEventListener('click', async () => {
        await window.CFS4?.Coordinator?.auditEntries?.({ force: true });
        setTimeout(() => _renderPanel(panel), 200);
    });
    panel.querySelector('#cfs-act-ls-clear')?.addEventListener('click', () => {
        if (!confirm('删 localStorage cfs-suite/scriptvars/* — 下次 F5 PathRegistry 会从 0 重建（恢复 0 条 path）。继续？')) return;
        const removed = [];
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k && k.startsWith('cfs-suite/scriptvars/')) {
                localStorage.removeItem(k);
                removed.push(k);
            }
        }
        alert(`已删 ${removed.length} 项：\n${removed.join('\n')}\n下次 F5 生效。`);
    });
}
