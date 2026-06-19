# CFS Suite v5.0 · 完整 Spec

> 起：2026-06-19
> 版本：v5.0.0-day5（待 Day 7 发布）
> 源 spec：[`D:\Silly\LOG\2026-06-19-cfs-v5.0-mvu-fork-spec.md`](../../../Silly/LOG/2026-06-19-cfs-v5.0-mvu-fork-spec.md)

---

## 1. 立项动机

CFS v4.9.1（GitHub `OreoCoins/CFS-SillyTavern@da2901b`）作为酒馆助手脚本已稳态，主请求 cache 命中率 91~92%。但暴露出三个问题：

1. **MagVarUpdate 上游自 2026-04-25 停更 46 天**（pushedAt 实测 2026-05-04，但代码 HEAD 是 4-25）
2. **DeepSeek V4 协议外挂层无法干净修复**：
   - PR #203 (4-25)「格式化输出」用 `json_schema/response_format` → DS 官方 API 直接 400
   - DS V3 系列官方停供，副 LLM 没法回退
3. **跨扩展 entry 位置漂移**：WM 等外部脚本会改 CFS 自管 entry 位置，sha256 不变但 cache 命中率掉 4%

→ 唯一可控路径：fork MagVarUpdate + CFS 迁到 ST 原生扩展 + silent 接管 `window.Mvu`。

---

## 2. 三仓架构

```
                  MagicalAstrogy/MagVarUpdate (上游 MIT @ c1ae3a9)
                              │ fork
                              ▼
                   OreoCoins/CFS-MVU (beta) ── 6 项改动
                              │ yarn build
                              ▼ (artifact/bundle.js)
   OreoCoins/CFS-Suite (main) ── ST 原生扩展套餐版
                              │
                              ├ cfs-mvu/bundle.js  (上面拷过来的产物)
                              ├ cfs/core/          (v4.x 接管层 8 文件)
                              ├ cfs/modules/       (v3.1.7 守护 + SEM + PSIS+)
                              ├ cfs/compat/        (酒馆助手 API polyfill)
                              └ cfs/ui/            (浮动胶囊)

   OreoCoins/CFS-SillyTavern (main) ── CFS Solo (v4.9.1，作为单脚本版保留)
```

| 仓 | 角色 | 默认分支 | License |
|---|---|---|---|
| `OreoCoins/CFS-MVU` | fork 源码 + bundle | `beta`（沿上游） | MIT (沿用上游 + 衍生条款) |
| `OreoCoins/CFS-Suite` | ST 扩展套餐版 | `main` | MIT |
| `OreoCoins/CFS-SillyTavern` | CFS Solo（单脚本） | `main` | MIT |

---

## 3. CFS-MVU 6 项改动详情

详见 [`OreoCoins/CFS-MVU/NOTICE.md`](https://github.com/OreoCoins/CFS-MVU/blob/beta/NOTICE.md)。

| # | 文件 | 内容 |
|---|---|---|
| #1 | `src/function/detect_provider.ts` (新) + `src/function/update/invoke_extra_model.ts` | 5 类 provider 探测（DS 官方 / DS 反代 / OpenAI / Anthropic / Google / unknown）；DS4 走 `response_format: {type:'json_object'}` + `tool_choice: 'auto'`；其他保持上游 strict `json_schema` + `'required'` |
| #2 | `src/function/function_call.ts` | `degradeJsonSchemaForDS` 去 `additionalProperties:false` / `$schema`；`degradeMvuToolDefinitionForDS` 给 DS4 工具调用路径用 |
| #3 | `src/function/update_variables.ts` | `_cfsPreNormalizeFreeFormCommands` 救命模式：上游 `extractCommands` 空手时识别 3 类自由格式（`<update>` / `op: replace, path: ...` / `add /path = value`）翻译成 `_.set()`；`outError` 加 `[CFS-MVU/soft-skip]` 前缀 |
| #4 | `src/function/cfs_hooks.ts` (新) | `Mvu._cfsHooks` 注册命名空间（onBeforeWrite / onAfterWrite / onParseFailed / readDelegate）；hook 抛错 catch 不中断 MVU 主路径；触发点插桩留 Day 7+ |
| #5 | `src/function/exclusive_mode.ts` (新) | `scanExistingMvu` 启动扫 `window.Mvu` 全局；`lockWindowMvu` 用 `Object.defineProperty configurable:false, writable:false` 锁定；fetch intercept 留 Day 7+ |
| #6 | `src/function/global/index.ts` (改) | `createMvu()` 暴露 `Mvu._cfsEdition = {version, upstream, built_at, features[]}`；`initGlobals` 挂前 scan，挂后 lock |

---

## 4. CFS-Suite 16 个模块挂载逻辑

### ESM 加载链（由 index.js 顶部 import 拓扑算）

```
1. cfs/compat/tavern_helper_polyfill.js    13 API 注入到 window
2. cfs/core/statdata_engine.js              CFS4 全局 init (EVENTS / NS / loadConfig)
3. cfs/core/schema_layer.js                 SFL + SSG
4. cfs/core/path_registry.js                SchemaResolver + PathRegistry
5. cfs/core/diff_engine.js                  Diff Engine 三态机
6. cfs/core/injection_strategy.js           PresenceEncoder + STABLE_BATCH
7. cfs/core/fallback_strategy.js            FallbackStrategy + HealthMonitor
8. cfs/core/real_takeover.js                bootstrapTakeover + autoBootstrap
9. cfs/core/kernel.js                       SessionGate + Coordinator + NotificationCenter
10. cfs/modules/psis.js                     v3.1.7 PSIS R1 + 守护按钮 UI + STYLE_CSS
11. cfs/modules/sem.js                      SEM 候选扫描 + 用户授权迁移
12. cfs/modules/psis_plus.js                PSIS+ 预设结构修复
13. cfs/ui/floating_capsule.js              浮动胶囊
14. index.js                                 APP_READY 状态汇报
```

### Coordinator 启动状态机

```
BOOTING ── app_ready ──> PROBING ── session_ready ──> READY_FULL ── onSessionReady done ──> DONE
   │
   └── 2500ms 超时 ──> TIMEOUT (探测失败，可手动恢复)
```

### Watchdog 指数退避表

```
1s → 2s → 4s → 8s → 15s → 30s → 60s (累计 120s 后放弃)
```

### Audit 5 触发点

1. `app_ready` 后 3s 强制
2. `chat_changed` (force=true)
3. SessionGate 进 READY_FULL
4. macro cache 提交后
5. `worldinfo_updated` 后 500ms / 1500ms / 4000ms 三次延迟

---

## 5. 数据流（请求/注入/接管）

### 5.1 请求路径

```
[用户输入] → ST generate() → generate_before_combine_prompts 钩
                                       │
                                       ├ CFS4.InjectionStrategy.applyInjection()
                                       │  ├ DiffEngine 算 delta + BATCH
                                       │  ├ PresenceEncoder 编 <STABLE ref="..."/>
                                       │  └ TavernHelper.setLorebookEntries() 写到 dynamic entry
                                       │
                                       └ ST 继续拼 prompt + 发请求
[LLM 回复] → MVU parser (CFS-MVU) → updateVariables → eventEmit('mvu_data_changed')
                                       │
                                       └ CFS audit ← worldinfo_updated 触发
```

### 5.2 接管失败回退

```
applyInjection 失败 (3 连续)
      │
      ▼
emit 'cfs_injection_failed'
      │
      ▼
HealthMonitor 累计 → degradeToMvu({reason, auto:true})
      │
      ▼
FallbackStrategy mode = mvu_fallback
      │
      ▼
restoreMvuRendering() (dynamic entry disable + mvu entry re-enable)
      │
      ▼
emit 'cfs_v4_degraded' → toast「🛡️ MVU 接管已暂停」
```

### 5.3 接管恢复

```
用户在胶囊点「🥵 启用接管」
      │
      ▼
FallbackStrategy.recoverToV4({force: true})
      │
      ▼ (跳健康检查)
mode = v4_full
      │
      ▼
emit 'cfs_v4_recovered' → toast「🛡️ MVU 守护已自动恢复启用」
```

---

## 6. 升级路径（Solo → Suite）

### 用户视角

1. 在酒馆助手脚本管理面板**禁用 CFS Solo 脚本**（不删，留作备份）
2. 在 ST 第三方扩展用 git URL 装：`https://github.com/OreoCoins/CFS-Suite`
3. F5 ST → 右下角应出现绿色胶囊 `🥵 CFS缓存优化器`
4. 之前 Solo 装的 `cfs_sem_migrations_v1` / `cfs_psis_plus_history_v2` 等 localStorage 数据**自动复用**（key 兼容）

### 不兼容点

- `cfs-suite/scriptvars/*` 是 Suite 新增的 LS namespace（Solo 用 script-level vars 经酒馆助手）
- PathRegistry 数据**不自动迁移**（Solo 存酒馆助手 script vars，Suite 存 localStorage），首次跑 Suite 会从 0 重建
- 一些 Solo 用户的高级 PathRegistry 自定义可能要手动重导

---

## 7. API Contract

### 7.1 全局命名空间

```javascript
window.CFS4 = {
    _loaded: true,
    version: '4.0.0',          // StatData Engine 版本
    _cfg: {...},               // loadConfig() 返回
    EVENTS: {...},
    NS: {...},
    log: { debug, info, warn, error },

    // v4.x 核心层
    SessionGate, Coordinator, NotificationCenter,
    SchemaFrozenLayer, SchemaSwapGate, SchemaResolver, PathRegistry,
    DiffEngine, PresenceEncoder, InjectionStrategy,
    FallbackStrategy, HealthMonitor,

    // v3.1.7 / v4.9.x 模块（IIFE flag 标记）
    _psisIIFEDone: true,            // PSIS R1
    SEM,                            // SEM 迁移器
    PSISPlus,                       // PSIS+ 重排器
    _realTakeoverIIFEDone: true,    // Real Takeover

    // 顶层 API
    loadConfig, saveConfig, emit, deriveCharacterSlug, getSchemaIds,
};

window.Mvu = {
    // 上游 MVU API（getMvuData / replaceMvuData / parseMessage / ...）
    getMvuData, replaceMvuData, parseMessage,
    getCurrentMvuData /* deprecated */,
    setMvuVariable /* deprecated */,
    isDuringExtraAnalysis,

    // CFS-MVU 改动 #4 #6
    _cfsHooks: {
        _handlers: {},
        _version: '5.0.0-day4b',
        register(handlers),  // 注册全套 hook
        clear(),
    },
    _cfsEdition: {
        version: '5.0.0-day4b',
        upstream: 'MagicalAstrogy/MagVarUpdate@c1ae3a9',
        built_at: '2026-06-19',
        features: ['ds4_adapt', 'schema_degradation', 'parser_fallback',
                   'cfs_hooks', 'exclusive_mode', 'cfs_edition_marker'],
    },
};
```

### 7.2 关键方法

| 方法 | 返回 |
|---|---|
| `CFS4.Coordinator.getState()` | `{phase, since, transitions[], summary, startup_time_ms, ...}` |
| `CFS4.Coordinator.auditEntries({force})` | `Promise<{fixed, uids?} \| {skipped, reason?} \| {error, attempted?}>` |
| `CFS4.Coordinator.getAuditState()` | `{last_run, run_count, debounce_ms}` |
| `CFS4.FallbackStrategy.getCurrentMode()` | `'v4_full' \| 'mvu_fallback' \| 'v4_degraded'` |
| `CFS4.FallbackStrategy.recoverToV4({force})` | `{prevMode, currentMode}` |
| `CFS4.FallbackStrategy.degradeToMvu({reason, auto})` | `{prevMode, currentMode}` |
| `CFS4.InjectionStrategy.getDynamicEntryUid()` | `number \| null` |
| `CFS4.InjectionStrategy.getLastInjection()` | `{contentLen, ...} \| null` |
| `CFS4.InjectionStrategy.simulateInjection()` | `Promise<{...}>` (dry-run 算注入但不写) |
| `CFS4.InjectionStrategy.bootstrapTakeover({force?})` | `Promise<bool>` (Real Takeover 入口) |
| `Mvu._cfsHooks.register(handlers)` | `() => void` (返回 unregister) |

---

## 8. 测试矩阵（待 Day 6 跑完）

| 场景 | 期望 | 状态 |
|---|---|---|
| DS V4 Pro 主 + V4 Flash 副 + 格式化输出 | 不再 Bad Request；stat_data 正确更新；UI 实时刷新 | ⏸ 待跑 |
| DS V4 Pro 主 + V4 Flash 副 + 工具调用 | 工具调用成功；stat_data 正确更新 | ⏸ 待跑 |
| DS V4 Pro 主 + V4 Flash 副 + 聊天消息 | parser 接受多种格式；partial commit 起效 | ⏸ 待跑 |
| OpenAI 主 + GPT-4o 副 + 格式化输出 | 保留 strict json_schema 路径（不退化） | ⏸ 待跑 |
| Anthropic Claude + Claude Haiku 副 + 工具调用 | 走 Anthropic tool spec（不被 DS 路径污染） | ⏸ 待跑 |
| CFS 命中率 | 91~92% 不变（CFS 主路径不动） | ⏸ 待实测 24h |
| 装套餐版 + 已有卡级 MVU Zod 脚本 | exclusive_mode lockWindowMvu 阻止覆盖 | ✅ Day 4b 实测 |
| 装套餐版 + 用户拒绝禁用 CFS Solo | 双触发但功能不破，console 警告 | ✅ Day 3-5 实测 |

---

## 9. 已知限制 / 未来工作

### Day 7+ 推迟项

- **cfs_hooks 触发点插桩**：当前 `Mvu._cfsHooks.register()` API 就绪但 MVU 主路径未调 trigger* helper。需要在 `updateVariables` 写入前后 + `invoke_extra_model` 解析失败处插桩。
- **exclusive_mode fetch intercept**：当前只 lockWindowMvu，未拦截 `MagVarUpdate/artifact/bundle.js` 的网络加载。卡作者更新卡片绑定的 MVU URL 时不会被替换。
- **完整 panel.js 改造**：v3 守护按钮面板（renderMvuConsole 690 行）现在含在 `cfs/modules/psis.js` 整 IIFE 里，未拆独立模块。
- **STYLE_CSS 独立**：现在由 v3 IIFE 动态注入 head，未抽到 `style.css` 静态文件。

### 长期维护

- 上游 cherry-pick 频率：每周一次 `git fetch upstream beta`
- DS4 协议如再变 → `detect_provider.ts` 加版本号 fallback 链
- MagVarUpdate 上游 archive / 删除 → CFS-MVU 完整 fork 可独立存在

---

## 10. 不做的事（明确划界）

- ❌ 不做 Web UI 配置面板（沿用 ST 扩展 setting + 浮动胶囊）
- ❌ 不解决 DS V3 停供问题（DS 商业策略，CFS 无能力）
- ❌ 不卸载用户磁盘上的卡 / 扩展文件（仅运行时禁用）
- ❌ 不动 ST 后端、不动 TavernHelper、不动 ST 主代码
- ❌ 不重写 MVU panel.vue（上游照搬，仅在数据流加 hook）

---

## 附录：施工日志索引

- Day 1 [仓库基建 + 骨架](../../../Silly/LOG/2026-06-19-cfs-suite-day1-impl-log.md)
- Day 2 [CFS-MVU #1 #2 #3](../../../Silly/LOG/2026-06-19-cfs-mvu-day2-impl-log.md)
- Day 3 [核心层 kernel.js](../../../Silly/LOG/2026-06-19-cfs-suite-day3-impl-log.md)
- Day 4 [v4.x 完整 + CFS-MVU #4 #5 #6 + 胶囊](../../../Silly/LOG/2026-06-19-cfs-day4-impl-log.md)
- Day 5 [PSIS R1 + SEM + PSIS+](../../../Silly/LOG/2026-06-19-cfs-suite-day5-impl-log.md)
