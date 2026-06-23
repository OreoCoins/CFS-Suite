# CFS Suite

> **Cache-Friendly Scanner 套餐版** —— SillyTavern 原生扩展。
> CFS V4.9.3 完整接管层 + 浮动胶囊 6.5 UI，**装一个 = 装两个**(CFS 接管层 + CFS-MVU 套餐版酒馆助手脚本)。
>
> 当前版本：`v6.5.0` —— PSIS R1 切卡全量重扫三大块 + 胶囊 🛡 状态指示符 + SEM 还原 4.9 主动迁移。
> 详见 [doc/v6.5-release-notes.md](doc/v6.5-release-notes.md)。

---

## ⚠️ 霸王规则（装之前必读）

CFS Suite 是**霸王扩展**，自动接管行为分两条链路：

### 自动后台链路（无需用户操作）

- **PSIS R1 启动 + 切卡自动归零** — 扫描三大块（数据库 / MVU / 动态注入）的 position 漂移，自动归零到 `at_depth_as_user/depth=0`；切卡触发时一次重扫三大块
- **kernel.js audit** — CFS 自管 `[CFS4_*]` entry 漂移自动 `setLorebookEntries` 修复
- **PathRegistry 切卡重置** — 清空旧卡 paths + 重 autoRegister 新卡 `stat_data`
- **cfs4_auto_cleanup** — 启动期一次性清掉历史遗留的 `[CFS4_AUTO]` 残留标签（仅独立 worldbook，不动 character_book）

### 用户授权链路（必须点击触发）

- **SEM 主动迁移** — 把 PSIS pattern 判 safe 的纯静态长 entry 推 `before_character_definition`（prefix 区）参与 cache
- **MVU 控制台一键操作** — 启用/禁用/修回 MVU 接口

**唯一豁免**：entry comment 加 `[cfs:ignore]` 标记 → CFS 全模块永不动这条（自 v6.1.1 起 PSIS R1 也尊重此标记）。

自动后台链路是 **silent** 的（无 popup 确认，按需 Toast 通知），**下载 = 知情同意**。接管仅在运行时，不删用户磁盘上的卡 / 扩展文件。

**如不接受这些规则，请装 [CFS Solo](https://github.com/OreoCoins/CFS-SillyTavern)**（单脚本版，不接管，仅 cache 优化）。

---

## 是什么 / 解决什么问题

DeepSeek V4 在 SillyTavern 长对话场景下有几个老大难：

1. **MVU stat_data 渲染输出污染上下文** → 浪费几千 token，cache prefix 跨轮无法稳定复用
2. **MVU 主程序自 2026-04-25 停更** → DS V4 协议的 `json_schema` strict mode 直接被拒，工具调用 `tool_choice: 'required'` 偶发拒绝
3. **worldbook entry 位置漂移** → 第三方扩展 / 手动操作会改写 CFS 自管 entry 位置，cache 命中率掉
4. **切卡后 cache 命中率塌方** → 各种动态注入 entry 让 prompt prefix 跨轮变化

CFS Suite 的边界设计：

| 层 | 模块 | 解决 |
|---|---|---|
| **接管层** | `cfs/core/real_takeover.js` | 把 MVU stat_data 渲染替换为 `<STABLE>` token + 增量 BATCH |
| **位置守护（自动）** | `cfs/modules/psis.js` PSIS R1 | 启动 + 切卡自动归零三大块到 `depth=0` |
| **位置守护（自管 entry）** | `cfs/core/kernel.js` audit + `cfs/core/path_registry.js` | 4 锚点 audit + 5 触发点撒网修复 + 切卡霸王 reset |
| **prefix 推迁（授权）** | `cfs/modules/sem.js` | 纯静态长 entry → 用户点击迁 prefix 区参与 cache |
| **prompt order 重排（授权）** | `cfs/modules/psis_plus.js` | 启发式识别乱序 user-role prompt + 用户授权重排 |
| **回退安全网** | `cfs/core/fallback_strategy.js` + `health_monitor.js` | 接管失败自动降级，不破游戏 |
| **诊断器** | `cfs/modules/rsi.js` | 跨轮 hash 对账 + 污染来源识别（不修改，仅展示） |

> **worldbook 位置管理推荐**：v6.4 起 CFS 不再自动接管含动态宏的 entry。推荐用 [WM (jerryzmtz/worldbook-manager)](https://github.com/jerryzmtz/worldbook-manager) 把这类 entry 统一管理到 `at_depth_as_user/depth=0`。CFS 与 WM 区间物理隔离（SEM 推的是 PSIS 判 safe 的纯静态，WM 管的是含动态宏的）。

---

## 安装

ST UI → 扩展 → 安装扩展 → 粘贴 git URL：

```
https://github.com/OreoCoins/CFS-Suite
```

→ F5 刷新 ST → CFS Suite 自动启用 → 浮动胶囊 `🥵 CFS缓存优化器 · 6.5.0` 出现在右上角。

### 装 CFS-MVU 套餐版酒馆助手脚本（必备）

CFS-Suite 本身**不带** MVU 接管（bundle 加载路线重审中），需要从胶囊面板下载 CFS-MVU 套餐版酒馆助手脚本：

1. 浮动胶囊 → `🧬 MVU 套餐` section → `📥 下载 CFS-MVU JSON`
2. 酒馆助手 → 全局脚本 → 「导入脚本」（JSON 文件）
3. 启用脚本 + F5 → `window.Mvu._cfsEdition` 应该出现（13 keys 含 `_cfsHooks` / `_cfsEdition`）

### 如果已有其他 MVU 来源

胶囊 → `🧬 MVU 套餐` → `⚡ 扫描禁用其他 MVU` 会扫描三类来源：

- 酒馆助手脚本（global / character / preset）
- 角色卡 `regex_scripts` + `character_book.entries`
- ST 第三方/系统扩展层（用户在酒馆助手脚本管理界面看不到的来源）

确认后自动批量禁用 + 3s 后自动 F5。

### 验证装好了

F12 console 应该看到：

```
[CFS-Suite/polyfill] 13 项已挂：eventOn, eventOnce, eventEmit, ...
[CFS v4.x] StatData Engine 4.0.0 initialized
[CFS-Suite] v6.5.0 loading...
[CFS-Suite] APP_READY confirmed { ... 17 项 true }
[CFS-Suite/cleanup-v6.4] v6.4 启动清理模块已挂载
[CFS-PSIS] 切卡自动归零 已挂钩
```

右上角应该出现浮动胶囊 `🥵 CFS缓存优化器 · 6.5.0`。进卡后 ~7-10s，胶囊文字后缀出现 `🛡修复N` 或 `🛡✓`（PSIS R1 启动扫描完成的可见反馈）。

---

## 与 CFS Solo 的关系

| | CFS Solo | **CFS Suite** |
|---|---|---|
| 仓库 | [OreoCoins/CFS-SillyTavern](https://github.com/OreoCoins/CFS-SillyTavern) | 本仓 |
| 安装方式 | 酒馆助手脚本库 | ST 原生扩展（git URL） |
| 包含 CFS 接管层 | ✅ | ✅ |
| PSIS R1 自动归零 | ❌ | ✅（启动 + 切卡） |
| SEM 主动迁移 UI | ❌ | ✅（授权链路） |
| 浮动胶囊 UI | ❌ | ✅（拖拽 + 持久化日志框） |
| RSI 跨轮诊断 | ❌ | ✅ |
| 适用场景 | 不用 MVU / 想自管 | 用 MVU + 想要丝滑 + 用 DS V4 |

**两者不可同装**。同装会触发双触发（audit/注入跑 2 倍次数）。装 Suite 前请在酒馆助手脚本管理面板禁用 CFS Solo 脚本。

---

## UI 入口

CFS Suite 提供**两个**独立 UI（并存）：

### 1. 浮动胶囊 6.5（推荐）

- 右上角浮动 `🥵 CFS缓存优化器 · 6.5.0`
- **可拖拽**到屏幕任意位置（位置自动记忆，移动端触屏支持）
- 文字后缀 `🛡修复N` / `🛡✓` / `🛡✗` 实时显示 PSIS R1 状态，hover 看完整 summary tooltip
- 点击展开折叠面板：
  - 运行状态：Coordinator 阶段 / 接管模式 / 17 项模块明细折叠
  - 🧬 **MVU 套餐**：CFS-MVU 状态 + 来源诊断 + 扫描禁用
  - 📐 **提示词结构 PSIS PLUS**：检测乱序 + 重排 + 自动储存到预设（可还原）
  - 📦 **世界书优化 SEM**：候选扫描 + 主动迁移 + 一键回滚（v6.5 还原 4.9 主动姿态）
  - 🐞 **RSI 请求结构诊断**：跨轮 hash 对账 + 污染来源识别 + diff-locate 反查
  - 4 个一键动作：🥵 启用接管 / ⏸ 关闭接管 / 🔍 重新校验 entry / 🗑️ 清空 Path 缓存
  - 持久化日志框（操作历史 50 条 + 时间戳 + 颜色分级）

### 2. 老版「🛡️ MVU 守护」面板（V4.9.3 功能）

- 聊天输入框旁的 `🛡️ MVU 守护` 按钮
- 点击弹出完整面板（三大块归零 / MVU 接口管理 / 切卡自动归零 toggle）
- 适合需要细粒度调试的高级用户

---

## 📈 装机量（GitHub 公开数据近似）

![GitHub Stars](https://img.shields.io/github/stars/OreoCoins/CFS-Suite?style=flat-square&logo=github&label=Stars)
![GitHub Forks](https://img.shields.io/github/forks/OreoCoins/CFS-Suite?style=flat-square&logo=github&label=Forks)
![GitHub Watchers](https://img.shields.io/github/watchers/OreoCoins/CFS-Suite?style=flat-square&logo=github&label=Watchers)
![Commit Activity](https://img.shields.io/github/commit-activity/m/OreoCoins/CFS-Suite?style=flat-square&label=月提交)
![Last Commit](https://img.shields.io/github/last-commit/OreoCoins/CFS-Suite?style=flat-square&label=最近提交)
![License](https://img.shields.io/github/license/OreoCoins/CFS-Suite?style=flat-square)

> **关于"总安装人数 / 今日安装人数"**：GitHub 公开 API **不直接统计** ST 扩展通过 git URL 的安装次数（用户走 ST UI 粘贴 git URL 安装，不经 release / package manager）。
>
> **CFS 自身遵循 no_telemetry 约定**，不内嵌任何上报渠道，所以"安装人数"的真实数据没有公开来源。下面的 Star 增长曲线是 GitHub 公开数据里**最接近"用户兴趣 / 装机意愿"**的近似指标。

### ⭐ Star 增长曲线（总计 / 按日新增）

[![Star History Chart](https://api.star-history.com/svg?repos=OreoCoins/CFS-Suite&type=Date)](https://star-history.com/#OreoCoins/CFS-Suite&Date)

*图源：[star-history.com](https://star-history.com) （自动渲染 SVG，刷新即更新）*

---

## 工程链路

```
MagicalAstrogy/MagVarUpdate (上游 MIT)
        │  fork
        ▼
OreoCoins/CFS-MVU (DS4 适配 / parser 容错 / cfs_hooks / exclusive_mode / _cfsEdition)
        │  yarn build → artifact/cfs-mvu-tavern-helper-script.json
        ▼
酒馆助手 → 全局脚本 → 从 JSON 导入（用户手动一次）
        │
        ▼
window.Mvu = { events, getMvuData, ..., _cfsHooks, _cfsEdition }  (13 keys)
        ▲
        │  CFS-Suite 检测 _cfsEdition 决定深度集成
        │
OreoCoins/CFS-Suite (本仓 — ST 原生扩展)
  ├── 17 个 window.CFS4.* 接管模块
  └── window.CFS4.PSISAutoZero / RSI / SEM / PSIS+
```

详见：
- 完整 spec：[`doc/spec-v5.0.md`](./doc/spec-v5.0.md)
- v6.5 发布说明：[`doc/v6.5-release-notes.md`](./doc/v6.5-release-notes.md)
- MVU fork 改动清单：[`NOTICE-MVU.md`](./NOTICE-MVU.md) → [CFS-MVU NOTICE](https://github.com/OreoCoins/CFS-MVU/blob/beta/NOTICE.md)

---

## F12 常用命令

```javascript
// === PSIS R1 自动归零（v6.5 切卡全量重扫三大块）===
window.CFS4.PSISAutoZero.isEnabled()
window.CFS4.PSISAutoZero.runNow()       // 手动一次跑三大块
window.CFS4.PSISAutoZero.setEnabled(false)
// LS toggle: localStorage['cfs-suite/auto_zero_dynamic_on_chat_change'] = '0' 关闭

// === MVU 来源诊断 ===
window.CFS4.diagnoseMvuRegistrant()
// dump window.Mvu 真实内容 + Object.keys 长度 + functions 列表

// === RSI 跨轮诊断器 ===
window.CFS4.RSI.findUnstableEntries()   // 跨轮 hash diff + window 反查 entry
window.CFS4.RSI.getDriftCandidates()    // 返回 post-history 段 dynamic 块 contentSlice

// === SEM 主动迁移（v6.5 还原 4.9 主动姿态）===
window.CFS4.SEM.scanCandidates()        // PSIS pattern 判 safe 的纯静态长 entry
window.CFS4.SEM.listMigrated()          // 当前卡已迁移列表（activeOnly=true）
window.CFS4.SEM.rollbackAll()           // 一键回滚

// === CFS-MVU 套餐版状态（用户必查）===
window.Mvu._cfsEdition
// → { version: '5.1.0-2026-06-21', upstream: '...', features: [...6 项] }
// 若 undefined 跑 diagnoseMvuRegistrant 看真实 keys

// === 启动清理（v6.4 一次性 [CFS4_AUTO] 残留清扫）===
window.CFS4.cleanupV64.run({force: true})   // 手动重跑

// === 核心层 ===
window.CFS4.Coordinator.getState()
window.CFS4.FallbackStrategy.getCurrentMode()
Object.keys(window.CFS4.PathRegistry.getAll()).length  // 应跟当前卡字段数对得上
await window.CFS4.Coordinator.auditEntries({ force: true })
```

---

## 故障排查

| 现象 | 排查 |
|---|---|
| 胶囊整个消失 | F12 console 看 ReferenceError；用户改过 `[cfs:ignore]` 不生效查 PSIS R1 是否最新版 |
| `PathRegistry.getAll()` 显示别的卡的字段 | 切卡霸王 reset 应触发，Ctrl+Shift+R 重载 |
| 「MVU 已存在但非 CFS-MVU 套餐版」 | 跑 `diagnoseMvuRegistrant()` 看真实来源，胶囊「扫描禁用其他 MVU」自动清（覆盖 ST 第三方扩展层） |
| 切卡后 cache 命中率塌方 | F12 看 `[CFS-PSIS] ⚡ 切卡自动归零: N 条 (db/mvu/dynamic 三大块)`；胶囊文字后缀应同步更新 `🛡修复N` |
| 胶囊不显示 `🛡` 后缀 | PSIS R1 未上报。F12 看 `[PSIS R1] 启动扫描` 日志；如启动报错查 console |
| SEM 列表显示别的卡迁移记录 | `activeOnly=true` 应自动按当前卡过滤；切卡 800ms debounce 后自动刷新 |
| 移动端胶囊第二次 tap 打不开 | 已修（`_suppressMouseUntil` 600ms 窗） |
| `[CFS Audit]` 触发 2 次 | CFS Solo 还在跑 — 去酒馆助手脚本面板禁用 |
| 注入 0 字符 | F12 跑 `CFS4.InjectionStrategy.simulateInjection()` |

---

## 模块清单 — V4.9.3 功能

| 层 | 模块 | 文件 |
|---|---|---|
| 1-3 | SessionGate / Coordinator / NotificationCenter | `cfs/core/kernel.js` |
| 4-5 | Schema 冻结层 / Schema 切换门 | `cfs/core/schema_layer.js` |
| 6-7 | Schema 解析器 / Path 注册表 | `cfs/core/path_registry.js` |
| 8 | 差异引擎（三态机） | `cfs/core/diff_engine.js` |
| 9-10 | 存在编码器 / 注入策略 | `cfs/core/injection_strategy.js` |
| 11-12 | 回退策略 / 健康监控 | `cfs/core/fallback_strategy.js` |
| 13 | 真接管 | `cfs/core/real_takeover.js` |
| 14 | PSIS R1 守护（启动 + 切卡全量重扫） | `cfs/modules/psis.js` |
| 15 | SEM 主动迁移器 | `cfs/modules/sem.js` |
| 16 | PSIS+ 重排器 | `cfs/modules/psis_plus.js` |
| 17 | RSI 跨轮诊断器 | `cfs/modules/rsi.js` |
| Aux | Full Refresh Scheduler | `cfs/core/full_refresh_scheduler.js` |
| Aux | v6.4 启动清理 | `cfs/core/cfs4_auto_cleanup.js` |

---

## 历史版本

- **v6.5.0** (2026-06-23) — PSIS R1 切卡全量重扫三大块 + 胶囊 🛡 状态指示符 + SEM 还原 4.9 主动迁移
- **v6.4.0** (2026-06-23) — **移除 PETL**（命中率回退根因，worldbook 位置交给 WM 管理）+ 启动静默清 `[CFS4_AUTO]` 残留标签
- **v6.2.0** (2026-06-22) — character_book 接管 + PSIS+ 启发式 unknown 接管 + 操作记录 modal + LS 5MB quota 瘦身（含 PETL，v6.4 已移除）
- **v6.1.x** (2026-06-21) — 浮动胶囊 PETL UI + autoRegister 退避就绪重试 + `[cfs:ignore]` 在 PSIS R1 路径生效（hotfix）
- **v6.0.0** (2026-06-20) — 7 阶段一次推到位（移动端胶囊 / audit 自动修复 / PSIS 切卡归零 toggle / RSI 漏扫补充 / MVU 深度扫描）
- **v5.3.0** (2026-06-20) — 胶囊双形态 + RSI 跨轮诊断器初版 + Full Refresh Scheduler
- **v5.2.0 / v5.1.0** — 胶囊真接 PSIS / PSIS+ / SEM 入口 + Auto Stable Promotion
- **v5.0.0-day4b** (2026-06-19) — 初版套餐（CFS V4.9.3 完整接管层 16 模块 + CFS-MVU fork bundle）

---

## 项目结构

```
CFS-Suite/
├── manifest.json                ST 扩展清单 (v6.5.0)
├── index.js                     入口
├── style.css                    占位
├── cfs-mvu/                     预编译 bundle（路线重审，当前不自动加载）
├── cfs/
│   ├── compat/
│   │   └── tavern_helper_polyfill.js   13 API polyfill
│   ├── core/
│   │   ├── statdata_engine.js
│   │   ├── kernel.js                   SessionGate / Coordinator / NotificationCenter / audit
│   │   ├── schema_layer.js
│   │   ├── path_registry.js            (切卡霸王 reset)
│   │   ├── diff_engine.js
│   │   ├── injection_strategy.js
│   │   ├── fallback_strategy.js
│   │   ├── real_takeover.js
│   │   ├── full_refresh_scheduler.js
│   │   └── cfs4_auto_cleanup.js        (v6.4 启动清 [CFS4_AUTO] 残留)
│   ├── modules/
│   │   ├── psis.js                     (启动 + 切卡全量重扫三大块, v6.5)
│   │   ├── sem.js                      (v6.5 还原 4.9 主动迁移)
│   │   ├── psis_plus.js
│   │   └── rsi.js                      (diff-locate 跨轮反查)
│   └── ui/
│       └── floating_capsule.js         (浮动胶囊 6.5 + PSIS R1 🛡 状态指示符)
├── test/                        Node 直跑单测
│   ├── rsi_l2_smoke.mjs                (7/7 ✓)
│   ├── psisp_judge_sanity.mjs
│   └── fixtures/
├── README.md
├── NOTICE-MVU.md
├── LICENSE                      MIT
└── doc/
    ├── spec-v5.0.md
    └── v6.5-release-notes.md
```

---

## License

MIT — © 2026 OreoCoins / CFS-Suite contributors

`cfs-mvu/` 子目录的衍生作品声明 + 上游致谢见 [`NOTICE-MVU.md`](./NOTICE-MVU.md)。
原 MagVarUpdate 上游：© 2025 MagicalAstrogy & StageDog (MIT).
