# CFS Suite

> **Cache-Friendly Scanner 套餐版** —— SillyTavern 原生扩展。
> CFS v4.9.1 完整接管层 + fork 自 [MagVarUpdate](https://github.com/MagicalAstrogy/MagVarUpdate) 的 DeepSeek V4 适配版 MVU bundle，**一装即用**。
>
> 当前版本：`v5.2.0` — 自动识别稳态字段 + MVU 守护面板入口修复

---

## 📋 5.2 改了什么（5.0.0-day9 → 5.2.0）

### v5.2.0 — UI 修复 + 文案换人话（2026-06-20）

- **修复 Day 5 假替代历史债** — 原 polyfill 注释「胶囊替代 MVU 守护面板」但实际上**胶囊里完全没接** PSIS / PSIS+ / SEM 任何 UI，只放 ✓ 已挂状态行。5.2 真把入口接上：
  - 胶囊里新增 `MVU 守护面板（PSIS / PSIS+ / SEM）` section
  - **PSIS+ 检测排序** / **SEM 稳态条目迁移** 两块直接挂在胶囊内，展开就能操作
  - 加一个 `打开完整 MVU 守护面板` 按钮，弹 PSIS v3.1.7 原 panel（三大块 + MVU 接口管理）
- **修拖动 bug** — PSIS panel 点一下按钮就拖不动了：SEM `makeDraggable` 绑 mousedown 在 `.cfs-head`，render 重写 innerHTML 后元素被替换但 `__semDraggable` 防重复绑导致永远不重绑 → 改用事件代理（mousedown 绑 panel 持久元素）
- **修边框样式糊一坨** — PSIS+ / SEM 自己没 CSS 定义，class 全在 psis.js STYLE_CSS 里，原版只在 openOrTogglePanel 时注入。5.2 改成模块加载时立即注入 D.head，胶囊里 PSIS+/SEM 一进来就有完整样式
- **删 ID 冲突** — PSIS 完整面板里 renderMvuConsole 末尾重复渲染 PSIS+/SEM，跟胶囊里那份 ID 重复（`cfs-psisp-root` / `cfs-sem-root` 全局唯一）导致 bindEvents 错绑；5.2 完整面板里**只保留**三大块 + MVU 接口管理，PSIS+/SEM 走胶囊次级菜单
- **模块明细折叠 + 错误标红** — 16 项模块状态从平铺改成 details 折叠，全挂时显示 `✓ 全部 16 项已挂`（绿），任何模块未挂时自动展开 + 红底+左边框标红
- **配置 UI 重排** — 自动识别稳态字段配置区改成每项独立块（深色背景 + 边框 + 标题在上输入在下 + 推荐值在右），不再挤一坨
- **术语换人话** — promote / demote / volatile / stable / decay / thrash lock 全部替换成「认作稳态字段 / 撤销 / 变化字段 / 不变 / 重置 / 反复变化几次放弃尝试」

### v5.1.0 — Auto Stable Promotion（未单独发布，并入 5.2）

> 5.1 测试期发现 UI 缺陷必须先修，因此跳过 5.1 单独发布，自动识别稳态字段功能与 UI 修复一起在 5.2 落地。

- **PathRegistry 加 4 字段** — `stable_rounds` / `last_change_round` / `promote_count` / `demote_count`，老 LS 数据缺字段自动补 0
- **Real Takeover 加 `_observeAndAdjust` 观察器** — 在 `applyInjection` 末尾扫 `diff.present`：本轮没变的字段 stable_rounds++、本轮变化的字段立即降级（Fast Demote）。连续 20 轮没变 + 不在白名单 → 自动升 stable（Slow Promote）
- **抖动锁定** — 反复 promote/demote 3 次后永久 volatile，防止跳来跳去打断 cache
- **Periodic Decay** — 默认每 100 轮 promote_count/demote_count 各 -1（不低于 0），给"早期波动后稳定下来"的字段重试窗口，防 regime shift 锁死
- **跨卡通用** — 不依赖 schema 字段命名，靠运行时观察 + 通用末段正则白名单兜底（HP/SAN/当前/状态/位置/余额/经验/欲望/淫乱/堕落/进度/count/cnt/time/timestamp/round/tick）
- **胶囊配置面板** — 5 项 LS 配置项可调（开关 / promote 阈值 / 抖动锁定阈值 / decay 周期 / 黑名单正则）+ 上次扫描统计显示
- **F12 API** — `window.CFS4.InjectionStrategy.getAutoPromoteState()` / `.resetAutoPromoteCounters()`

---

## ⚠️ 霸王规则（装之前必读）

CFS Suite 是**霸王扩展**：

- 安装后**强制接管** `window.Mvu`，禁用**所有**其他 MVU 来源
  - 包括但不限于：卡绑定脚本里的 MVU Zod、ST 全局 MVU 扩展、其他社区 fork
- 禁用是 **silent** 的（无 popup 确认），**下载 = 知情同意**
- 强制接管仅在运行时，不删用户磁盘上的卡 / 扩展文件
- 卸载 CFS Suite 后，其他 MVU 来源自动恢复

**如不接受这些规则，请装 [CFS Solo](https://github.com/OreoCoins/CFS-SillyTavern)**（v4.9.1 单脚本版，不接管 MVU，仅 cache 优化）。

---

## 是什么 / 解决什么问题

DeepSeek V4 在 SillyTavern 长对话场景下有几个老大难：

1. **MVU stat_data 渲染输出污染上下文** → 浪费几千 token，cache prefix 跨轮无法稳定复用
2. **MVU 主程序自 2026-04-25 停更 46 天** → DS V4 协议的 `json_schema` strict mode 直接被拒，工具调用 `tool_choice: 'required'` 偶发拒绝
3. **worldbook entry 位置漂移** → 第三方扩展（如 WM）会改写 CFS 自管 entry 位置，导致 cache 命中率掉 4%

CFS Suite 一口气解决全部：

| 层 | 模块 | 解决 |
|---|---|---|
| **接管层** | `cfs/core/real_takeover.js` | 把 MVU stat_data 渲染替换为 `<STABLE>` token + 增量 BATCH，干净 |
| **位置守护** | `cfs/core/path_registry.js` + `cfs/modules/psis.js` | 4 锚点 audit + 5 触发点撒网修复 |
| **DS4 适配** | CFS-MVU `detect_provider.ts` + `function_call.ts` + `update_variables.ts` | json_object 替代 json_schema / tool_choice='auto' / parser 救命 |
| **回退安全网** | `cfs/core/fallback_strategy.js` + `health_monitor.js` | 接管失败自动降级 mvu_fallback，不破游戏 |

---

## 安装

ST UI → 扩展 → 安装扩展 → 粘贴 git URL：

```
https://github.com/OreoCoins/CFS-Suite
```

→ F5 刷新 ST → CFS Suite 自动启用。

### 验证装好了

F12 console 应该看到（按出现顺序）：

```
[CFS-Suite/polyfill] 13 项已挂：eventOn, eventOnce, eventEmit, ...
[CFS v4.x] StatData Engine 4.0.0 initialized
[CFS-Suite/statdata-engine] CFS4 全局命名空间已 init, version=4.0.0
[CFS v4.x] Schema Frozen Layer mounted
... (12 个模块依次 mount)
[CFS v3.1.7] PSIS plugin 已注册到 Coordinator
[CFS v4.9.1 SEM] 已挂载
[CFS v4.9.3 PSIS Plus] 已挂载
[CFS-Suite] APP_READY confirmed { ... 16 项 true }
```

右下角应该出现绿色浮动胶囊 `🥵 CFS缓存优化器 · 🥵 接管已启用`。

---

## 与 CFS Solo 的关系

| | CFS Solo | **CFS Suite** |
|---|---|---|
| 仓库 | [OreoCoins/CFS-SillyTavern](https://github.com/OreoCoins/CFS-SillyTavern) | 本仓 |
| 安装方式 | 酒馆助手脚本库 | ST 原生扩展（git URL） |
| 包含 CFS 接管层 | ✅ | ✅ |
| 包含 MVU | ❌（依赖酒馆助手装 MVU） | ✅（fork + DS4 适配 bundled） |
| 强制接管 `window.Mvu` | ❌ | ✅（silent） |
| 浮动胶囊 UI | ❌ | ✅（拖拽 + 持久化日志框） |
| 适用场景 | 不用 MVU / 想自管 / 配酒馆助手生态 | 用 MVU + 想要丝滑 + 用 DS V4 |

**两者不可同装**。同装会触发双触发（audit/注入跑 2 倍次数）。装 Suite 前请在酒馆助手脚本管理面板**禁用 CFS Solo 脚本**。

---

## UI 入口

CFS Suite 提供**两个**独立 UI（并存）：

### 1. 浮动胶囊（推荐）
- 右下角浮动 `🥵 CFS缓存优化器 · <模式/阶段>`
- **可拖拽**到屏幕任意位置（位置自动记忆）
- 点击展开折叠面板：
  - 运行状态：当前阶段 / 接管模式 / 模块已挂载数
  - 注入引擎：动态 entry UID + 上次注入字符数
  - 模块明细 16 项
  - 4 个一键动作：🥵 启用接管 / ⏸ 关闭接管 / 🔍 重新校验 entry 位置 / 🗑️ 清空 Path 缓存
  - 持久化日志框（操作历史 50 条 + 时间戳 + 颜色分级）

### 2. 老版「🛡️ MVU 守护」面板
- 聊天输入框旁的 `🛡️ MVU 守护` 按钮（v3.1.7 IIFE 自带）
- 点击弹出完整 renderMvuConsole 面板（含三层分级状态条 / SEM 候选 / PSIS+ 操作记录）
- 适合需要细粒度调试的高级用户

---

## 工程链路

```
MagicalAstrogy/MagVarUpdate (上游 MIT)
        │  fork
        ▼
OreoCoins/CFS-MVU (DS4 适配 / parser 容错 / cfs_hooks / exclusive_mode / _cfsEdition)
        │  yarn build → artifact/bundle.js
        ▼
OreoCoins/CFS-Suite/cfs-mvu/bundle.js (本仓预编译产物)
        │  ST 扩展加载
        ▼
ST 主 window 上挂 window.Mvu + 16 个 window.CFS4.* 模块
```

详见：
- 完整 spec：[`doc/spec-v5.0.md`](./doc/spec-v5.0.md)
- MVU fork 改动清单：[`NOTICE-MVU.md`](./NOTICE-MVU.md) → [CFS-MVU NOTICE](https://github.com/OreoCoins/CFS-MVU/blob/beta/NOTICE.md)
- CFS-MVU 变更日志：[CHANGELOG-CFS](https://github.com/OreoCoins/CFS-MVU/blob/beta/CHANGELOG-CFS.md)

---

## 16 个模块清单

| 层 | 模块 | 文件 | 作用 |
|---|---|---|---|
| 1 | 会话状态机 | `cfs/core/kernel.js` (SessionGate) | 无状态会话探针 |
| 2 | 调度器 | `cfs/core/kernel.js` (Coordinator) | 启动状态机 + 插件总线 |
| 3 | 通知中心 | `cfs/core/kernel.js` (NotificationCenter) | toast 唯一出口 + 启动期合并 |
| 4 | Schema 冻结层 | `cfs/core/schema_layer.js` (SFL) | 双锚点 schema 写入 |
| 5 | Schema 切换门 | `cfs/core/schema_layer.js` (SSG) | T_w=90s 双轨期调度 |
| 6 | Schema 解析器 | `cfs/core/path_registry.js` (SR) | 双层命名空间 |
| 7 | Path 注册表 | `cfs/core/path_registry.js` (PR) | 路径权威列表 |
| 8 | 差异引擎 | `cfs/core/diff_engine.js` | 三态机 (present/omitted/deleted) |
| 9 | 存在编码器 | `cfs/core/injection_strategy.js` (PE) | `<STABLE ref="..."/>` token |
| 10 | 注入策略 | `cfs/core/injection_strategy.js` (IS) | STABLE_BATCH + stability_class |
| 11 | 回退策略 | `cfs/core/fallback_strategy.js` (FS) | mode: v4_full / mvu_fallback / v4_degraded |
| 12 | 健康监控 | `cfs/core/fallback_strategy.js` (HM) | 故障订阅 + 自动降级 |
| 13 | 真接管 | `cfs/core/real_takeover.js` | bootstrapTakeover + autoBootstrap |
| 14 | PSIS R1 守护 | `cfs/modules/psis.js` | 提示词结构守护 + 守护面板 UI |
| 15 | SEM 迁移器 | `cfs/modules/sem.js` | 候选扫描 + 用户授权迁移 |
| 16 | PSIS+ 重排器 | `cfs/modules/psis_plus.js` | 提示词预设结构修复 |

---

## F12 常用命令

```javascript
// 看 CFS-MVU 版本 + 已启用 features
window.Mvu._cfsEdition
// → { version: '5.0.0-day4b', upstream: '...', features: [...6 项] }

// 看 Coordinator 状态
window.CFS4.Coordinator.getState()
// → { phase: 'DONE', since: <ts>, transitions: [...], summary: {...} }

// 看 FallbackStrategy 当前模式
window.CFS4.FallbackStrategy.getCurrentMode()
// → 'v4_full' | 'mvu_fallback' | 'v4_degraded'

// 看 PathRegistry 大小
Object.keys(window.CFS4.PathRegistry.getAll()).length

// 看接管 audit 历史
window.CFS4.Coordinator.getAuditState()
// → { last_run: <ts>, run_count: N, debounce_ms: 5000 }

// 强制跑一次 audit
await window.CFS4.Coordinator.auditEntries({ force: true })
// → { fixed: N, uids: [...] } | { skipped, reason } | { error }

// 手动启用接管（如果当前 mode 不是 v4_full）
window.CFS4.FallbackStrategy.recoverToV4({ force: true })

// 手动关闭接管
window.CFS4.FallbackStrategy.degradeToMvu({ reason: 'manual', auto: false })

// 看 exclusive_mode 接管历史
window.Mvu._cfsHooks  // → { _handlers, _version: '5.0.0-day4b', register, clear }
```

---

## 故障排查

| 现象 | 排查 |
|---|---|
| 红 toast「缺：XXX」 | F12 看具体哪个模块未挂；如 PSIS 未挂检查酒馆助手按钮 API noop polyfill 是否就位 |
| `[CFS Audit]` 触发 2 次 | CFS Solo 还在跑（双触发）— 去酒馆助手脚本面板禁用 CFS Solo |
| 胶囊一直「加载中 N/16」N<16 | F12 看哪个模块红字；常见 import 路径错（应是 6 层 `..` 到 public/script.js）|
| 注入 0 字符 | bootstrapTakeover 未触发 — F12 跑 `CFS4.InjectionStrategy.simulateInjection()` |
| `PathRegistry 持久化体积接近阈值: 90KB` | localStorage 累积，胶囊「🗑️ 清空 Path 缓存」按钮一键解决 |
| ST 加载阶段无任何 [CFS] log | manifest.json `loading_order: 5` 是否被改？ST 版本太老不支持 ESM？ |

---

## 项目结构

```
CFS-Suite/
├── manifest.json                ST 扩展清单
├── index.js                     入口（import 链 + APP_READY 状态汇报）
├── style.css                    占位（实际样式由 v3 IIFE 注入）
├── cfs-mvu/                     预编译 bundle（fork 自 MagVarUpdate）
│   ├── bundle.js
│   ├── bundle.js.map
│   └── version.json
├── cfs/
│   ├── compat/
│   │   └── tavern_helper_polyfill.js   13 API（eventOn / TavernHelper / 变量 / 按钮）
│   ├── core/                    8 文件 5118 行 v4.x 接管层
│   │   ├── statdata_engine.js
│   │   ├── kernel.js
│   │   ├── schema_layer.js
│   │   ├── path_registry.js
│   │   ├── diff_engine.js
│   │   ├── injection_strategy.js
│   │   ├── fallback_strategy.js
│   │   └── real_takeover.js
│   ├── modules/                 3 文件 3111 行 — PSIS R1 + SEM + PSIS+
│   │   ├── psis.js              (含 v3 守护按钮 UI + STYLE_CSS + initvar 守护)
│   │   ├── sem.js
│   │   └── psis_plus.js
│   └── ui/
│       └── floating_capsule.js  浮动胶囊 + 折叠面板 + 持久化日志框
├── README.md
├── NOTICE-MVU.md
├── LICENSE                      MIT
└── doc/
    └── spec-v5.0.md             完整 v5.0 spec
```

---

## License

MIT — © 2026 OreoCoins / CFS-Suite contributors

`cfs-mvu/` 子目录的衍生作品声明 + 上游致谢见 [`NOTICE-MVU.md`](./NOTICE-MVU.md)。
原 MagVarUpdate 上游：© 2025 MagicalAstrogy & StageDog (MIT).
