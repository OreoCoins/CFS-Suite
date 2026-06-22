/**
 * CFS-Suite · core/petl.js
 *
 * v6.0 PETL · Prompt Entry Takeover Layer
 *
 * 切卡 / APP_READY 自动扫所有 enabled entry，识别动态宏 → 强制 setLorebookEntries
 * 改 position 到 at_depth_as_user/depth=0。霸王条款，不弹确认。
 *
 * 用户唯一豁免：entry comment 加 [cfs:ignore] 标记 → PETL 永不动该条目。
 * CFS 自管 entry（comment 前缀 [CFS4_）由 kernel.js audit 单独管理，PETL 跳过。
 *
 * 复用 PSIS 识别 patterns（window.CFS4.PSISPatterns，由 psis.js 暴露）：
 *   - DYNAMIC_PATTERNS：{{X::params}} / EJS / {{lastusermessage}} 等
 *   - MVU_PATTERNS：mvu_update / initvar / JSONPatch / 元叙述标签等
 *
 * 持久化：localStorage cfs-suite/petl_history_v1 保留最近 50 次修复记录，支持 rollbackLast。
 */

// 注意：不静态 import polyfill / psis — 它们由 index.js 主链路保证已加载
//   PETL 完全靠 runtime 全局 lookup（window.CFS4.PSISPatterns / TavernHelper / eventOn / toastr）
//   好处：node 烟测可直接 mock 全局 import 不炸（参考 rsi.js / post_history_pinner.js 模式）

const TAG = '[CFS-Suite/petl]';
const VERSION = '6.3.0';
const LS_TOGGLE = 'cfs-suite/petl_auto_takeover';
const LS_V49_STRICT = 'cfs-suite/petl_v49_strict_mode';
const LS_HISTORY = 'cfs-suite/petl_history_v1';
const PETL_BOOTSTRAP_DELAY_MS = 5000;
const PETL_CHAT_CHANGE_DELAY_MS = 1500;
const FIX_POSITION = 'at_depth_as_user';
const FIX_DEPTH = 0;
const CFS4_PREFIX = '[CFS4_';
// 2026-06-22 v6.2.0 plan temporal-swan · 新增 character_book 接管标记
const CFS4_AUTO_PREFIX = '[CFS4_AUTO]';
const IGNORE_TAG = '[cfs:ignore]';
const HISTORY_MAX = 50;
// 2026-06-22 v6.2.0 · 大块稳定 character_book entry 前移阈值（plan B Step 3）
const CHARBOOK_STABLE_MIN_LEN = 500;
const STABLE_POSITION = 'before_character_definition';

// 2026-06-22 v6.3.0 · v4.9 PSIS R1 严格模式
// 背景：v4.9 时期同卡同预设 RSI 期望命中率 70-85%，v5/v6 PETL 把"动态宏"定义扩太大
//   （EJS / mvu_plot 标签 / {{getvar::xxx}} 静态宏 / JSONPatch 全当 dynamic）→ 大量稳定 entry
//   被踢到 at_depth_as_user 减小 prefix 区 → 命中率退化到 50% 区间。
// 用户手动方案 B 实测：把 4 条 [mvu_plot] 大块（16424B 中的 14066B）迁回 prefix → 命中率 87%。
// 修法：恢复 v4.9 窄义"真破坏者"判定 — 仅 {{lastusermessage}}/{{random}}/{{date}}/etc 这类
//   每轮渲染真变的宏才视为 dynamic；其他 entry 主动迁回 prefix (before_character_definition +
//   constant=true + role=0)。role=0 是关键：v4.9 LOG line 84 教训 — ST 后端 normalize 把
//   (before_char, role=user) 自动撤销回 at_depth_as_user，必须 role=0 才稳。
// LS toggle 默认 1（开），用户能关回老模式。
const V49_DYNAMIC_PATTERNS = [
    // 真随机/最近消息宏（每轮渲染必变）
    /\{\{\s*lastusermessage\s*[:|}]/i,
    /\{\{\s*lastmessage\s*[:|}]/i,
    /\{\{\s*lastcharmessage\s*[:|}]/i,
    /\{\{\s*random\s*[:|}]/i,
    /\{\{\s*roll\s*[:|}]/i,
    /\{\{\s*pick\s*[:|}]/i,
    /\{\{\s*(date|time|datetime|weekday|isotime|isodate)\s*\}\}/i,
    // MVU 变量动态求值（v4.9 log line 203 提到的 uid 53 真破坏者）
    /\{\{\s*format_message_variable\s*::/i,
    // input/原 ST 输入宏
    /\{\{\s*input\s*[:|}]/i,
];
const STABLE_CONSTANT = true;
const STABLE_ROLE = 0; // system - v4.9 关键：ST normalize 不会撤销 (before_char, role=system)

const _GLOBAL = (typeof window !== 'undefined' && window.parent) ? window.parent : (typeof window !== 'undefined' ? window : null);

function _isEnabled() {
    try { return localStorage.getItem(LS_TOGGLE) !== '0'; } catch (e) { return true; }
}
function _setEnabled(b) {
    try { localStorage.setItem(LS_TOGGLE, b ? '1' : '0'); } catch (e) {}
}

// 2026-06-22 v6.3.0 · v4.9 严格模式 toggle（默认开 — 跟 v4.9 PSIS R1 行为一致）
function _isV49Strict() {
    try { return localStorage.getItem(LS_V49_STRICT) !== '0'; } catch (e) { return true; }
}
function _setV49Strict(b) {
    try { localStorage.setItem(LS_V49_STRICT, b ? '1' : '0'); } catch (e) {}
}

function _entryIsV49TrueDynamic(entry) {
    if (!entry) return false;
    const content = typeof entry.content === 'string' ? entry.content : '';
    for (let i = 0; i < V49_DYNAMIC_PATTERNS.length; i++) {
        try { if (V49_DYNAMIC_PATTERNS[i].test(content)) return true; } catch (e) {}
    }
    return false;
}

function _isAlreadyAtPrefix(entry) {
    return entry.position === STABLE_POSITION && entry.constant === true;
}

function _readHistory() {
    try { return JSON.parse(localStorage.getItem(LS_HISTORY) || '[]'); } catch (e) { return []; }
}
function _writeHistory(arr) {
    try { localStorage.setItem(LS_HISTORY, JSON.stringify(arr.slice(-HISTORY_MAX))); } catch (e) {}
}
function _appendHistory(rec) {
    const list = _readHistory();
    list.push(rec);
    _writeHistory(list);
}

function _matchAny(s, patterns) {
    if (!s || !Array.isArray(patterns)) return false;
    for (let i = 0; i < patterns.length; i++) {
        try { if (patterns[i].test(s)) return true; } catch (e) {}
    }
    return false;
}
function _hasDynamicMarker(content) {
    const ps = _GLOBAL && _GLOBAL.CFS4 && _GLOBAL.CFS4.PSISPatterns;
    if (!ps) return false;
    return _matchAny(content, ps.DYNAMIC) || _matchAny(content, ps.MVU);
}

// 2026-06-22 WM 风格补强：综合 entry 风险判定
//   优先用 PSISPatterns.getEntryRiskLevel（白名单 + unknown 兜底 + 字段风险 + 函数式 getvar）
//   仅 'dynamic' 级别才触发 PETL 接管；'warning' 不动（避免误伤 ST 装饰指令类）
//   PSIS 未就绪时退回旧 _hasDynamicMarker（content/comment 任一命中即接管）
function _entryIsDynamic(entry) {
    const ps = _GLOBAL && _GLOBAL.CFS4 && _GLOBAL.CFS4.PSISPatterns;
    if (ps && typeof ps.getEntryRiskLevel === 'function') {
        return ps.getEntryRiskLevel(entry) === 'dynamic';
    }
    const content = typeof entry.content === 'string' ? entry.content : '';
    const comment = typeof entry.comment === 'string' ? entry.comment : '';
    return _hasDynamicMarker(content) || _hasDynamicMarker(comment);
}

function _isAlreadyAtChatEnd(entry) {
    const p = entry.position;
    const okPos = (p === FIX_POSITION) || (p === 4);
    const okDepth = (entry.depth === FIX_DEPTH) || (entry.depth == null);
    return okPos && okDepth;
}

async function _readLorebookEntries(lorebookName, helper) {
    try {
        return await Promise.resolve(helper.getLorebookEntries(lorebookName));
    } catch (e) {
        console.warn(TAG, '读 worldbook "' + lorebookName + '" 失败:', e);
        return [];
    }
}

// === 2026-06-22 v6.2.0 plan temporal-swan 任务 B · character_book 接管 ===

// 拿当前角色卡的 character_book entries（卡内置 worldbook，跟独立 worldbook 字段兼容）
function _petlReadCharacterBook() {
    try {
        const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern && typeof SillyTavern.getContext === 'function')
            ? SillyTavern.getContext()
            : (_GLOBAL && _GLOBAL.SillyTavern && typeof _GLOBAL.SillyTavern.getContext === 'function'
                ? _GLOBAL.SillyTavern.getContext()
                : null);
        if (!ctx) return { charId: null, charObj: null, entries: [] };
        const charId = (typeof ctx.characterId !== 'undefined') ? ctx.characterId : null;
        if (charId == null) return { charId: null, charObj: null, entries: [] };
        const charObj = ctx.characters && ctx.characters[charId];
        if (!charObj || !charObj.data || !charObj.data.character_book) {
            return { charId: charId, charObj: charObj || null, entries: [] };
        }
        const entries = charObj.data.character_book.entries;
        return {
            charId: charId,
            charObj: charObj,
            entries: Array.isArray(entries) ? entries : [],
        };
    } catch (e) {
        console.warn(TAG, '_petlReadCharacterBook failed:', e);
        return { charId: null, charObj: null, entries: [] };
    }
}

// character_book entry 接管动作判定
//   返回 { action: 'to_chat_end' | 'to_prefix' | 'skip', reason?, newPosition?, newConstant?, newRole? }
function _petlJudgeCharbookEntry(entry) {
    if (!entry) return { action: 'skip', reason: 'null' };
    if (entry.enabled === false) return { action: 'skip', reason: 'disabled' };
    const comment = typeof entry.comment === 'string' ? entry.comment : '';
    if (comment.indexOf(IGNORE_TAG) >= 0) return { action: 'skip', reason: 'ignore' };
    // [CFS4_* 前缀 → 已被 PETL 接管过，二次扫跳过（含 [CFS4_AUTO] / kernel.js audit 自管前缀）
    if (comment.indexOf(CFS4_PREFIX) === 0) return { action: 'skip', reason: 'cfs4' };

    const v49Strict = _isV49Strict();

    if (v49Strict) {
        // 2026-06-22 v6.3.0 · v4.9 严格模式（character_book 跟独立 worldbook 同规则）
        if (_entryIsV49TrueDynamic(entry)) {
            if (_isAlreadyAtChatEnd(entry)) return { action: 'skip', reason: 'position_ok' };
            return { action: 'to_chat_end', newPosition: FIX_POSITION, newDepth: FIX_DEPTH };
        }
        if (entry.position === STABLE_POSITION && entry.constant === true) {
            return { action: 'skip', reason: 'position_ok' };
        }
        return {
            action: 'to_prefix',
            newPosition: STABLE_POSITION,
            newConstant: STABLE_CONSTANT,
            newRole: STABLE_ROLE,
            newSelective: false, // v6.3.0 显式语义
        };
    }

    // 旧模式（v5/v6.x 行为）：含动态宏 → chat 末尾，稳定大块 → prefix
    if (_entryIsDynamic(entry)) {
        if (_isAlreadyAtChatEnd(entry)) return { action: 'skip', reason: 'position_ok' };
        return { action: 'to_chat_end', newPosition: FIX_POSITION, newDepth: FIX_DEPTH };
    }
    const content = typeof entry.content === 'string' ? entry.content : '';
    if (content.length >= CHARBOOK_STABLE_MIN_LEN) {
        if (entry.position === STABLE_POSITION && entry.constant === true) {
            return { action: 'skip', reason: 'position_ok' };
        }
        return { action: 'to_prefix', newPosition: STABLE_POSITION, newConstant: true };
    }
    return { action: 'skip', reason: 'no_marker' };
}

// 持久化"当前角色"卡 JSON 到 ST 后端
//   2026-06-22 v6.2.0 实测修法：
//     先前直接 trigger #create_button click 不够。ST backend charaFormatData (characters.js:567)
//     走 `tryParse(data.json_data)` — POST 只从 #character_json_data 隐藏 input 读 character_book，
//     PETL 改的 characters[chid].data.character_book.entries 完全不被读到 → 改动丢失。
//   正确通道（沿用 JS-Slash-Runner lorebook.ts:272-276 模式）：
//     1. 改完内存 (characters[chid].data.character_book) 后
//     2. 把当前 #character_json_data 隐藏 input 字符串 parse → 替换 data.character_book → stringify 写回
//     3. 同步回 characters[chid].json_data 内存字段（避免下次 reload 时被旧值覆盖）
//     4. trigger #create_button click → form submit → backend 写盘
function _petlSyncCharacterBookToFormData() {
    try {
        const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern && typeof SillyTavern.getContext === 'function')
            ? SillyTavern.getContext()
            : null;
        if (!ctx) return false;
        const charId = (typeof ctx.characterId !== 'undefined') ? ctx.characterId : null;
        if (charId == null) return false;
        const charObj = ctx.characters && ctx.characters[charId];
        if (!charObj || !charObj.data || !charObj.data.character_book) return false;

        const $$ = (typeof $ === 'function') ? $
            : (_GLOBAL && typeof _GLOBAL.$ === 'function') ? _GLOBAL.$
            : null;
        if (!$$) return false;

        const $input = $$('#character_json_data');
        if (!$input || $input.length === 0) return false;
        const rawJson = $input.val();
        if (!rawJson || typeof rawJson !== 'string') return false;

        let parsed;
        try { parsed = JSON.parse(rawJson); } catch (e) { return false; }
        if (!parsed || typeof parsed !== 'object') return false;

        // V2 spec: parsed.data.character_book；V1 spec 兜底: 顶层 character_book
        const cbClone = JSON.parse(JSON.stringify(charObj.data.character_book));
        if (parsed.data && typeof parsed.data === 'object') {
            parsed.data.character_book = cbClone;
        } else {
            parsed.character_book = cbClone;
        }

        const newRawJson = JSON.stringify(parsed);
        $input.val(newRawJson);
        // 同步回内存 json_data 字段（下次 ST 切卡重读 characters[chid].json_data 也是新值）
        charObj.json_data = newRawJson;
        return true;
    } catch (e) {
        console.warn(TAG, 'character_book 同步到 #character_json_data 失败:', e);
        return false;
    }
}

// 自取 ST CSRF token — fetch /csrf-token（ST 端点，无前置依赖）
//   2026-06-22 v6.3.0 修：原从 <meta name="csrf-token"> 读拿到的是空/旧，ST 实际 token 存
//   在 fetch('/csrf-token') JSON 字段（见 ST script.js:694 firstLoadInit）
//   /csrf-token 不在 cocktail-plus FAST_ROUTES（实测 ENDPOINT_LIST 只含 characters-all / version），
//   原生 fetch 直接打不会被劫持
async function _petlFetchCsrfToken() {
    try {
        const resp = await fetch('/csrf-token', { credentials: 'same-origin', cache: 'no-store' });
        if (!resp.ok) return null;
        const data = await resp.json();
        return (data && typeof data.token === 'string') ? data.token : null;
    } catch (_) {
        return null;
    }
}

// 走 jQuery $.ajax（XHR 通道）持久化 — 主路径
//   原因：cocktail-plus 只 patch window.fetch（commit 12 已绕过）+ 模板 XHR，没 patch
//   /api/characters/edit XHR（service-worker.ts FAST_ROUTES 也不含该 path）。
//   ST 自带 $.ajaxPrefilter (script.js:665) 自动加正确 CSRF token，无需手动拿。
//   优点：不依赖任何第三方扩展私有 API，纯 ST 自带能力
function _petlSaveCharacterViaAjax($$, form) {
    return new Promise((resolve) => {
        try {
            const formData = new FormData(form);
            $$.ajax({
                url: '/api/characters/edit',
                method: 'POST',
                data: formData,
                processData: false,
                contentType: false,
                cache: false,
                success: () => resolve({ ok: true, source: 'jquery.ajax' }),
                error: (xhr) => resolve({ ok: false, status: xhr.status, source: 'jquery.ajax' }),
            });
        } catch (e) {
            resolve({ ok: false, error: e.message, source: 'jquery.ajax' });
        }
    });
}

// 原生 XMLHttpRequest 兜底 — jQuery 不可用 / $.ajax 异常时使用
//   2026-06-22 v6.3.0 用户拍板"不是所有用户都装 cocktail-plus，需要考量另寻出路"：
//   原 fallback 走 window.__cocktailPlusEarlyBridge.rawFetch 是依赖第三方扩展私有 API，
//   不通用。改用原生 XHR + 主动 fetch /csrf-token 拿 token：
//     - XHR 通道：cocktail-plus 没 patch（确认 early-bridge.ts patchTemplateXHR 只 hook 模板路径）
//     - CSRF token：fetch /csrf-token 端点不被劫持
//   全程零第三方依赖，所有 ST 用户都能用
async function _petlSaveCharacterViaXHR(form) {
    try {
        const csrfToken = await _petlFetchCsrfToken();
        const formData = new FormData(form);
        return await new Promise((resolve) => {
            try {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', '/api/characters/edit', true);
                if (csrfToken) xhr.setRequestHeader('X-CSRF-Token', csrfToken);
                xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, source: 'native.xhr' });
                xhr.onerror = () => resolve({ ok: false, status: 0, source: 'native.xhr' });
                xhr.send(formData);
            } catch (e) {
                resolve({ ok: false, error: e.message, source: 'native.xhr' });
            }
        });
    } catch (e) {
        return { ok: false, error: e.message, source: 'native.xhr' };
    }
}

async function _petlSaveCharacter() {
    try {
        const syncOk = _petlSyncCharacterBookToFormData();
        if (!syncOk) {
            console.warn(TAG, 'character_book 同步到 #character_json_data 失败，持久化中止');
            return false;
        }

        const $$ = (typeof $ === 'function') ? $
            : (_GLOBAL && typeof _GLOBAL.$ === 'function') ? _GLOBAL.$
            : null;
        if ($$ && typeof $$ === 'function') {
            const form = $$('#form_create').get(0);
            if (form) {
                // 主路径：jQuery $.ajax → XHR + ST ajaxPrefilter 自动 CSRF
                if (typeof $$.ajax === 'function') {
                    const result = await _petlSaveCharacterViaAjax($$, form);
                    if (result.ok) {
                        console.log(TAG, '⚡ character 持久化已写盘 (via ' + result.source + ', sync=' + syncOk + ')');
                        return true;
                    }
                    console.warn(TAG, 'jQuery ajax 持久化失败: HTTP ' + result.status + '，回退原生 XHR');
                }
                // Fallback：原生 XHR + 自取 CSRF（零第三方依赖）
                const xhrResult = await _petlSaveCharacterViaXHR(form);
                if (xhrResult.ok) {
                    console.log(TAG, '⚡ character 持久化已写盘 (via ' + xhrResult.source + ', sync=' + syncOk + ')');
                    return true;
                }
                console.warn(TAG, '原生 XHR 持久化也失败:', xhrResult);
                return false;
            }
        }

        // 极端兜底：jQuery / form 都不可用，走纯 fetch（极少触发）
        const formEl = (typeof document !== 'undefined' && document.querySelector)
            ? document.querySelector('#form_create')
            : null;
        if (!formEl) {
            console.warn(TAG, 'jQuery + DOM #form_create 都不可用，character 持久化跳过');
            return false;
        }
        const csrfToken = await _petlFetchCsrfToken();
        const formData = new FormData(formEl);
        const headers = {};
        if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
        const response = await fetch('/api/characters/edit', {
            method: 'POST',
            headers: headers,
            body: formData,
            credentials: 'same-origin',
            cache: 'no-store',
        });
        if (!response.ok) {
            console.warn(TAG, 'character 持久化失败: HTTP ' + response.status + ' via fetch-fallback');
            return false;
        }
        console.log(TAG, '⚡ character 持久化已写盘 (via fetch-fallback, sync=' + syncOk + ')');
        return true;
    } catch (e) {
        console.warn(TAG, 'character 持久化失败:', e);
        return false;
    }
}

// 给 character_book entry 加 [CFS4_AUTO] 前缀（分享卡时其他人可识别 CFS 改动来源）
function _petlAttachAutoPrefix(comment) {
    const c = typeof comment === 'string' ? comment : '';
    if (c.indexOf(CFS4_AUTO_PREFIX) === 0) return c;
    return CFS4_AUTO_PREFIX + ' ' + c;
}

async function scanAndTakeover(opts) {
    opts = opts || {};
    const triggeredBy = opts.triggeredBy || 'unknown';
    if (!opts.force && !_isEnabled()) {
        if (!opts.silent) console.log(TAG, '已通过 LS toggle 禁用，跳过 (triggeredBy=' + triggeredBy + ')');
        return { skipped: true, reason: 'disabled' };
    }
    const helper = (typeof TavernHelper !== 'undefined') ? TavernHelper : (_GLOBAL && _GLOBAL.TavernHelper);
    if (!helper || !helper.getCharLorebooks || !helper.getLorebookEntries || !helper.setLorebookEntries) {
        console.warn(TAG, 'TavernHelper 不可用，跳过');
        return { skipped: true, reason: 'no_helper' };
    }

    let bind;
    try { bind = await Promise.resolve(helper.getCharLorebooks({ name: 'current' })); }
    catch (e) { console.warn(TAG, 'getCharLorebooks 失败:', e); return { skipped: true, reason: 'no_char' }; }
    if (!bind) return { skipped: true, reason: 'no_bind' };

    const names = [];
    if (bind.primary) names.push(bind.primary);
    if (Array.isArray(bind.additional)) {
        for (let i = 0; i < bind.additional.length; i++) {
            const n = bind.additional[i];
            if (n && names.indexOf(n) < 0) names.push(n);
        }
    }
    if (names.length === 0) {
        if (!opts.silent) console.log(TAG, '当前卡无 worldbook，跳过');
        return { skipped: true, reason: 'no_wb' };
    }

    const groupedByBook = {};
    let totalCandidates = 0;
    // v49 strict mode 下 reason 含 to_prefix（迁回 prefix）和 to_chat_end（v4.9 真破坏者踢末尾）
    const skipped = { ignore: 0, cfs4: 0, disabled: 0, position_ok: 0, no_marker: 0 };
    const v49Strict = _isV49Strict();
    let v49ToPrefix = 0, v49ToChatEnd = 0;

    for (let i = 0; i < names.length; i++) {
        const lb = names[i];
        const entries = await _readLorebookEntries(lb, helper);
        if (!Array.isArray(entries) || entries.length === 0) continue;
        for (let j = 0; j < entries.length; j++) {
            const e = entries[j];
            if (!e) continue;
            if (e.enabled === false) { skipped.disabled++; continue; }
            const comment = typeof e.comment === 'string' ? e.comment : '';
            if (comment.indexOf(IGNORE_TAG) >= 0) { skipped.ignore++; continue; }
            if (comment.indexOf(CFS4_PREFIX) === 0) { skipped.cfs4++; continue; }

            if (v49Strict) {
                // 2026-06-22 v6.3.0 · v4.9 严格模式：恢复 PSIS R1 不变量
                //   非 v49 真破坏者 → 必须在 prefix (before_character_definition + constant=true + role=0)
                //   v49 真破坏者 → 必须在 chat 末尾 (at_depth_as_user + depth=0)
                const isTrueDyn = _entryIsV49TrueDynamic(e);

                if (isTrueDyn) {
                    if (_isAlreadyAtChatEnd(e)) { skipped.position_ok++; continue; }
                    if (!groupedByBook[lb]) groupedByBook[lb] = { patches: [], snapshots: [] };
                    groupedByBook[lb].patches.push({
                        uid: e.uid,
                        position: FIX_POSITION,
                        depth: FIX_DEPTH,
                    });
                    groupedByBook[lb].snapshots.push({
                        uid: e.uid,
                        comment: comment.slice(0, 120),
                        oldPosition: e.position,
                        oldDepth: e.depth == null ? null : e.depth,
                        oldConstant: !!e.constant,
                        oldRole: e.role == null ? null : e.role,
                        action: 'to_chat_end',
                    });
                    v49ToChatEnd++;
                    totalCandidates++;
                } else {
                    if (_isAlreadyAtPrefix(e)) { skipped.position_ok++; continue; }
                    if (!groupedByBook[lb]) groupedByBook[lb] = { patches: [], snapshots: [] };
                    groupedByBook[lb].patches.push({
                        uid: e.uid,
                        position: STABLE_POSITION,
                        constant: STABLE_CONSTANT,
                        role: STABLE_ROLE,
                        // v6.3.0 显式 selective=false：constant=true 已优先强制注入，
                        //   但避免 ST 内部某些路径同时检查 selective 时语义分歧
                        selective: false,
                    });
                    groupedByBook[lb].snapshots.push({
                        uid: e.uid,
                        comment: comment.slice(0, 120),
                        oldPosition: e.position,
                        oldDepth: e.depth == null ? null : e.depth,
                        oldConstant: !!e.constant,
                        oldRole: e.role == null ? null : e.role,
                        oldSelective: e.selective == null ? null : !!e.selective,
                        action: 'to_prefix',
                    });
                    v49ToPrefix++;
                    totalCandidates++;
                }
            } else {
                // 旧模式（v5/v6.x 行为）：仅含动态宏的 entry 踢 chat 末尾，其他不动
                if (_isAlreadyAtChatEnd(e)) { skipped.position_ok++; continue; }
                if (!_entryIsDynamic(e)) { skipped.no_marker++; continue; }
                if (!groupedByBook[lb]) groupedByBook[lb] = { patches: [], snapshots: [] };
                groupedByBook[lb].patches.push({
                    uid: e.uid,
                    position: FIX_POSITION,
                    depth: FIX_DEPTH,
                });
                groupedByBook[lb].snapshots.push({
                    uid: e.uid,
                    comment: comment.slice(0, 120),
                    oldPosition: e.position,
                    oldDepth: e.depth == null ? null : e.depth,
                });
                totalCandidates++;
            }
        }
    }

    // 2026-06-22 v6.2.0 plan temporal-swan 任务 B · 扫 character_book entries
    const charBookCands = [];
    const charBookSkipped = { ignore: 0, cfs4: 0, disabled: 0, position_ok: 0, no_marker: 0 };
    const cb = _petlReadCharacterBook();
    if (cb.charObj && Array.isArray(cb.entries) && cb.entries.length > 0) {
        for (let i = 0; i < cb.entries.length; i++) {
            const ent = cb.entries[i];
            const verdict = _petlJudgeCharbookEntry(ent);
            if (verdict.action === 'skip') {
                if (verdict.reason && charBookSkipped[verdict.reason] != null) {
                    charBookSkipped[verdict.reason]++;
                }
                continue;
            }
            charBookCands.push({ idx: i, entry: ent, verdict: verdict });
        }
    }
    const totalCharBookCandidates = charBookCands.length;
    totalCandidates += totalCharBookCandidates;

    if (totalCandidates === 0) {
        if (!opts.silent) console.log(TAG, '⚡ 无需接管 (triggeredBy=' + triggeredBy + ', v49Strict=' + v49Strict + ', skipped=' + JSON.stringify(skipped) + ', charBookSkipped=' + JSON.stringify(charBookSkipped) + ')');
        return { applied: 0, candidates: 0, skipped, charBookSkipped, v49Strict };
    }

    if (opts.dryRun === true) {
        console.log(TAG, '🔬 dryRun: 候选 ' + totalCandidates + ' 条 (worldbook=' + (totalCandidates - totalCharBookCandidates) + ', character_book=' + totalCharBookCandidates + ', triggeredBy=' + triggeredBy + ')');
        return {
            applied: 0,
            candidates: totalCandidates,
            dryRun: true,
            groupedByBook,
            charBookCands: charBookCands.map(c => ({ idx: c.idx, uid: c.entry.uid, action: c.verdict.action })),
            skipped,
            charBookSkipped,
        };
    }

    let appliedTotal = 0;
    const failedBooks = [];
    const historyRec = {
        ts: Date.now(),
        triggered_by: triggeredBy,
        books: {},
    };
    const lbs = Object.keys(groupedByBook);
    for (let i = 0; i < lbs.length; i++) {
        const lb = lbs[i];
        const g = groupedByBook[lb];
        try {
            await Promise.resolve(helper.setLorebookEntries(lb, g.patches));
            appliedTotal += g.patches.length;
            historyRec.books[lb] = g.snapshots;
        } catch (e) {
            console.warn(TAG, 'setLorebookEntries 写回 "' + lb + '" 失败:', e);
            failedBooks.push({ lb, error: e && e.message });
        }
    }

    // === 2026-06-22 v6.2.0 · 应用 character_book 改动 + 持久化卡 JSON ===
    let charBookApplied = 0;
    const charBookSnapshots = [];
    if (totalCharBookCandidates > 0 && cb.charObj && cb.charObj.data && cb.charObj.data.character_book) {
        for (let i = 0; i < charBookCands.length; i++) {
            const cand = charBookCands[i];
            const ent = cand.entry;
            const v = cand.verdict;
            // snapshot 记录原始字段（用于 history 展示，不参与 rollback；按 plan，character_book 无自动 restore）
            charBookSnapshots.push({
                idx: cand.idx,
                uid: ent.uid,
                comment: typeof ent.comment === 'string' ? ent.comment.slice(0, 120) : '',
                oldPosition: ent.position,
                oldDepth: ent.depth == null ? null : ent.depth,
                oldConstant: !!ent.constant,
                oldSelective: ent.selective == null ? null : !!ent.selective,
                action: v.action,
                newPosition: v.newPosition,
            });
            // 改内存（ST 下次 generate 即读到新值）
            if (v.action === 'to_chat_end') {
                ent.position = v.newPosition;
                ent.depth = v.newDepth;
            } else if (v.action === 'to_prefix') {
                ent.position = v.newPosition;
                ent.constant = v.newConstant;
                // v6.3.0 v49 模式：role / selective 也得改
                if (v.newRole != null) ent.role = v.newRole;
                if (v.newSelective != null) ent.selective = v.newSelective;
            }
            ent.comment = _petlAttachAutoPrefix(ent.comment);
            charBookApplied++;
        }
        // 一次 saveCharacterDebounced 覆盖本次所有改动
        const saved = await _petlSaveCharacter();
        if (!saved) {
            console.warn(TAG, 'character_book 内存已改但持久化失败 — 重启 ST 后内存丢失，需用户主动点保存按钮');
        }
        appliedTotal += charBookApplied;
    }
    if (charBookSnapshots.length > 0) {
        historyRec.charBook = {
            charId: cb.charId,
            charName: (cb.charObj && (cb.charObj.name || (cb.charObj.data && cb.charObj.data.name))) || null,
            entries: charBookSnapshots,
        };
    }

    if (appliedTotal > 0) {
        _appendHistory(historyRec);
        const v49Suffix = v49Strict ? ` [v4.9严格] (→prefix=${v49ToPrefix} →chatEnd=${v49ToChatEnd})` : '';
        console.log(TAG, '⚡ 已自动接管 ' + appliedTotal + ' 条 entry (worldbook=' + (appliedTotal - charBookApplied) + ', character_book=' + charBookApplied + ', triggeredBy=' + triggeredBy + ')' + v49Suffix);
        try {
            if (typeof toastr !== 'undefined' && toastr.success) {
                const charBookSuffix = charBookApplied > 0 ? ' (含 ' + charBookApplied + ' 条卡内置)' : '';
                const modeTag = v49Strict ? ' [v4.9 严格]' : '';
                toastr.success('⚡ CFS PETL 已接管 ' + appliedTotal + ' 条 entry' + charBookSuffix + modeTag + '。详情→ 浮动胶囊 PETL 记录',
                    'CFS-Suite v6.3 PETL', { timeOut: 8000 });
            }
        } catch (_eToast) {}
    }
    return { applied: appliedTotal, candidates: totalCandidates, failedBooks, skipped, charBookApplied, charBookSkipped, v49Strict, v49ToPrefix, v49ToChatEnd };
}

let _bootstrapTimer = null;
function _scheduleBootstrap() {
    if (_bootstrapTimer) return;
    _bootstrapTimer = setTimeout(() => {
        _bootstrapTimer = null;
        scanAndTakeover({ triggeredBy: 'bootstrap' })
            .catch(e => console.warn(TAG, 'bootstrap 异常', e));
    }, PETL_BOOTSTRAP_DELAY_MS);
}

let _chatChangeTimer = null;
function _scheduleChatChangeRun() {
    if (_chatChangeTimer) clearTimeout(_chatChangeTimer);
    _chatChangeTimer = setTimeout(() => {
        _chatChangeTimer = null;
        scanAndTakeover({ triggeredBy: 'chat_id_changed' })
            .catch(e => console.warn(TAG, 'chat_id_changed 异常', e));
    }, PETL_CHAT_CHANGE_DELAY_MS);
}

// 订阅 chat_id_changed
try {
    if (typeof eventOn === 'function') {
        eventOn('chat_id_changed', _scheduleChatChangeRun);
        console.log(TAG, '已订阅 chat_id_changed (debounce ' + PETL_CHAT_CHANGE_DELAY_MS + 'ms)');
    } else {
        console.warn(TAG, 'eventOn 不可用，chat_id_changed 未订阅');
    }
} catch (e) {
    console.warn(TAG, 'chat_id_changed 订阅失败:', e);
}

// APP_READY 兜底：覆盖启动时已加载的会话
_scheduleBootstrap();

async function rollbackLast() {
    const helper = (typeof TavernHelper !== 'undefined') ? TavernHelper : (_GLOBAL && _GLOBAL.TavernHelper);
    if (!helper || !helper.setLorebookEntries) return { reverted: 0, reason: 'no_helper' };
    const list = _readHistory();
    if (list.length === 0) return { reverted: 0, reason: 'no_history' };
    const last = list[list.length - 1];
    let revertedTotal = 0;
    const bookNames = Object.keys(last.books || {});
    for (let i = 0; i < bookNames.length; i++) {
        const lb = bookNames[i];
        const snaps = last.books[lb];
        // v6.3.0 兼容 v49 snapshot：含 oldConstant/oldRole/oldSelective 时一并回滚
        const patches = snaps.map(s => {
            const patch = {
                uid: s.uid,
                position: s.oldPosition,
                depth: s.oldDepth == null ? 0 : s.oldDepth,
            };
            if (s.oldConstant != null) patch.constant = s.oldConstant;
            if (s.oldRole != null) patch.role = s.oldRole;
            if (s.oldSelective != null) patch.selective = s.oldSelective;
            return patch;
        });
        try {
            await Promise.resolve(helper.setLorebookEntries(lb, patches));
            revertedTotal += patches.length;
        } catch (e) {
            console.warn(TAG, '回滚 "' + lb + '" 失败:', e);
        }
    }
    _writeHistory(list.slice(0, -1));
    console.log(TAG, '↩ 已回滚最近一次接管: ' + revertedTotal + ' 条');
    try {
        if (typeof toastr !== 'undefined' && toastr.info) {
            toastr.info('↩ CFS PETL 已回滚 ' + revertedTotal + ' 条 entry 位置到接管前', 'CFS-Suite PETL', { timeOut: 5000 });
        }
    } catch (_e) {}
    return { reverted: revertedTotal };
}

export const PETL = {
    _version: VERSION,
    isEnabled: _isEnabled,
    setEnabled: _setEnabled,
    // v6.3.0 v4.9 严格模式控制
    isV49Strict: _isV49Strict,
    setV49Strict: _setV49Strict,
    runNow: () => scanAndTakeover({ triggeredBy: 'manual' }),
    scanDryRun: () => scanAndTakeover({ triggeredBy: 'dry_run', dryRun: true }),
    getHistory: _readHistory,
    rollbackLast,
    clearHistory: () => { _writeHistory([]); return { cleared: true }; },
    // 内部 helpers 暴露给单测用
    _internals: {
        hasDynamicMarker: _hasDynamicMarker,
        isAlreadyAtChatEnd: _isAlreadyAtChatEnd,
        isAlreadyAtPrefix: _isAlreadyAtPrefix,
        matchAny: _matchAny,
        entryIsV49TrueDynamic: _entryIsV49TrueDynamic,
        V49_DYNAMIC_PATTERNS,
    },
};

if (_GLOBAL) {
    if (!_GLOBAL.CFS4) _GLOBAL.CFS4 = {};
    _GLOBAL.CFS4.PETL = PETL;
}

console.log(TAG + ' v' + VERSION + ' loaded (enabled=' + (_isEnabled() ? 'ON' : 'OFF') + ', v49Strict=' + (_isV49Strict() ? 'ON' : 'OFF') + ')');

// 2026-06-22 v6.3.0 · 启动期一次性 toastr 提示 v49 严格模式状态
//   背景：v49 模式默认 ON，但用户可能不知道这条规则的存在。
//   用 LS 一次性 flag 防止 F5 重复弹（首次安装/升级时提示一次）。
//   用户可通过 console: window.CFS4.PETL.setV49Strict(false) 关闭，或在 entry comment 加 [cfs:ignore] 跳过单条
const LS_V49_NOTIFIED = 'cfs-suite/petl_v49_notified_v1';
try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(LS_V49_NOTIFIED) !== '1') {
        // 延迟 6 秒（晚于 bootstrap 5 秒），避免与 PETL 首次接管 toastr 撞车
        setTimeout(() => {
            try {
                if (typeof toastr !== 'undefined' && toastr.info) {
                    const status = _isV49Strict() ? 'ON' : 'OFF';
                    const msg = `PETL v${VERSION} · v4.9 严格模式默认 ${status}\n` +
                        '稳态 entry 自动迁回 prefix 区（命中率显著提升）。\n' +
                        '关闭：F12 跑 window.CFS4.PETL.setV49Strict(false)\n' +
                        '单条豁免：entry comment 加 [cfs:ignore]';
                    toastr.info(msg, 'CFS-Suite v6.3 PETL', { timeOut: 15000, extendedTimeOut: 5000 });
                }
                localStorage.setItem(LS_V49_NOTIFIED, '1');
            } catch (_) {}
        }, 6000);
    }
} catch (_) {}
