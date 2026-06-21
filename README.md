# CFS Suite

> **Cache-Friendly Scanner 套餐版** —— SillyTavern 原生扩展。
> CFS V4.9.3 完整接管层 + 浮动胶囊 6.0 UI,**装一个 = 装两个**(CFS 接管层 + CFS-MVU 套餐版酒馆助手脚本)。
>
> 当前版本:`v6.0.0` — PETL 切卡自动接管 + PathRegistry 霸王切卡 + MVU 来源深度扫描

---

## ⚠️ 霸王规则(装之前必读)

CFS Suite 是**霸王扩展**:

- **切卡自动接管** — 切卡时自动:
  - PETL 扫所有 enabled entry,含动态宏的强制改到 chat 末尾(`at_depth_as_user/depth=0`)
  - PSIS 三大块(数据库 / MVU / 动态注入)自动归零
  - audit 检测 CFS 自管 entry 漂移自动 `setLorebookEntries` 修复
  - PathRegistry 清空旧卡 paths + 重 autoRegister 新卡 stat_data
- **唯一豁免**:entry comment 加 `[cfs:ignore]` 标记 → CFS 全模块永不动这条
- 接管是 **silent** 的(无 popup 确认,Toast 通知),**下载 = 知情同意**
- 接管仅在运行时,不删用户磁盘上的卡 / 扩展文件

**如不接受这些规则,请装 [CFS Solo](https://github.com/OreoCoins/CFS-SillyTavern)**(单脚本版,不接管,仅 cache 优化)。

---

## 📋 v6.0.0 主要改动(v5.3 → v6.0)

### 7 阶段一次推到位

| 阶段 | 改动 |
|---|---|
| **G** | 移动端胶囊 touch BUG 修 — 第二次 tap 失效根因(touch + mouse 双套监听被合成 mouse 串扰),加 600ms `_suppressMouseUntil` 时间窗 |
| **A** | audit 自动修复回退 — 撤销 v5.3 告警化,恢复检测 `[CFS4_*]` 自管 entry 漂移自动 `setLorebookEntries` + Toast |
| **B** | PSIS 切卡自动归零 toggle — 新增 `cfs-suite/auto_zero_dynamic_on_chat_change`(默认开),切卡 1.5s 后静默归零 dynamic 类 entry |
| **C** | **PETL 主路径新建** — 新文件 `cfs/core/petl.js`,切卡 + APP_READY 兜底扫所有 source 含动态宏 entry → 强制改 position;LS 持久化历史 + `rollbackLast` 撤销 API |
| **D** | RSI 漏扫补充 — 新增 `getDriftCandidates()` 给 PETL 反查 dynamic 块 contentSlice |
| **E** | 删 `post_history_pinner.js` — v5 暴力拆 `<tag>...</tag>` 翻车原案,PETL 替代 |
| **F** | MVU 注册者深度扫描 — 扫描器从仅看脚本 name 扩到扫脚本 content + 角色卡 `regex_scripts` / `character_book.entries` + **ST 第三方/系统扩展层** |

### 4 个 Hotfix(真机暴露的 friendly BUG)

| Hotfix | 根因 |
|---|---|
| **H1** | `psis.js` IIFE 末尾 `_CFS4G` 引用错作用域(`_registerV31Plugin` 函数内 var) → ReferenceError → ESM 链断 → 浮动胶囊整个消失。修:换成 IIFE 顶层 `P` 别名 |
| **H2** | `path_registry.js` v2.8.1 hotfix 把切卡 reset 阉割 — 切卡 `chat_id_changed` 只 flush 不清,且 boot "已有不覆盖"锁住覆盖路径 → 用户 `PathRegistry.getAll()` 永远是第一个卡的字段。修:新增 `_onChatChanged()` 走霸王 reset 路径(flush 旧 → 清 in-memory → autoRegister 新卡) |
| **H3** | RSI 输出文案"CFS 已尽力"+"pinner 默认关"+"audit 只告警"全部跟 v6 霸王现状矛盾。改成"CFS 已自动接管的部分" + 列出 PETL/PSIS/audit 三条自动接管行为 + 唯一豁免 `[cfs:ignore]` |
| **H4** | 反馈用户主页面 `window.Mvu` 是上游 MagVarUpdate 11 keys,但**酒馆助手脚本管理界面看不到**(在 ST 第三方扩展层)。`_scanAndDisableOtherMvu` 加扫 `/api/extensions/discover` + 用 `extension_settings.disabledExtensions.push` 自动禁用 + 完成后 3s 自动 F5(Esc 阻止) |

### 文案 / 版本号统一(本轮)

- 胶囊展开标题:`5.3.0` → **`6.0.0`**
- MVU 守护面板顶部:`CFS v4.9.3 (PSIS v3.1.7 + PSIS+ v4.9.3 + 接管 v4.8.1 + SEM v4.9.1)` → **`🛡️ MVU 守护面板 — V4.9.3 功能`**
- PSIS Plus 标题:去 v4.9.2 → **`📐 提示词结构 PSIS PLUS — 检测乱序 + 重排 + 自动储存到预设(可还原)`**
- SEM 标题:去 v2.9 → **`📦 世界书优化 SEM — 候选扫描 + 迁移 + 回滚`**

---

## 是什么 / 解决什么问题

DeepSeek V4 在 SillyTavern 长对话场景下有几个老大难:

1. **MVU stat_data 渲染输出污染上下文** → 浪费几千 token,cache prefix 跨轮无法稳定复用
2. **MVU 主程序自 2026-04-25 停更** → DS V4 协议的 `json_schema` strict mode 直接被拒,工具调用 `tool_choice: 'required'` 偶发拒绝
3. **worldbook entry 位置漂移** → 第三方扩展(如 WM)会改写 CFS 自管 entry 位置,导致 cache 命中率掉
4. **切卡后 cache 命中率塌方** → 各种动态注入 entry 让 prompt prefix 跨轮变化(v6 PETL 主路径专治)

CFS Suite 一口气解决全部:

| 层 | 模块 | 解决 |
|---|---|---|
| **接管层** | `cfs/core/real_takeover.js` | 把 MVU stat_data 渲染替换为 `<STABLE>` token + 增量 BATCH |
| **PETL 主路径** | `cfs/core/petl.js` | 切卡自动扫所有 enabled entry,含动态宏的强制改 position(v6 新增) |
| **位置守护** | `cfs/core/path_registry.js` + `cfs/modules/psis.js` | 4 锚点 audit + 5 触发点撒网修复 + 切卡霸王 reset(v6 Hotfix 2) |
| **MVU 来源扫描** | `cfs/ui/floating_capsule.js` `_scanOtherMvuSources` | 酒馆助手脚本 + 角色卡 regex/world_book + ST 第三方扩展(v6 H4) |
| **回退安全网** | `cfs/core/fallback_strategy.js` + `health_monitor.js` | 接管失败自动降级,不破游戏 |

---

## 安装

ST UI → 扩展 → 安装扩展 → 粘贴 git URL:

```
https://github.com/OreoCoins/CFS-Suite
```

→ F5 刷新 ST → CFS Suite 自动启用 → 浮动胶囊 `🥵 CFS缓存优化器 · 6.0.0` 出现在右上角。

### 装 CFS-MVU 套餐版酒馆助手脚本(必备)

CFS-Suite 本身**不带** MVU 接管(bundle 加载路线重审中),需要从胶囊面板下载 CFS-MVU 套餐版酒馆助手脚本:

1. 浮动胶囊 → `🧬 MVU 套餐` section → `📥 下载 CFS-MVU JSON`
2. 酒馆助手 → 全局脚本 → 「导入脚本」(JSON 文件)
3. 启用脚本 + F5 → `window.Mvu._cfsEdition` 应该出现(13 keys 含 `_cfsHooks` / `_cfsEdition`)

### 如果已有其他 MVU 来源(关键 — v6 H4 专治)

胶囊 → `🧬 MVU 套餐` → `⚡ 扫描禁用其他 MVU` 会扫描三类来源:
- 酒馆助手脚本(global / character / preset)
- 角色卡 `regex_scripts` + `character_book.entries`
- **ST 第三方/系统扩展层**(用户在酒馆助手脚本管理界面看不到的来源)

确认后自动批量禁用 + 3s 后自动 F5。

### 验证装好了

F12 console 应该看到:

```
[CFS-Suite/polyfill] 13 项已挂:eventOn, eventOnce, eventEmit, ...
[CFS v4.x] StatData Engine 4.0.0 initialized
[CFS-Suite] APP_READY confirmed { ... 16 项 true, PETL: true }
[CFS-Suite/petl] v6.0.0 loaded (toggle LS=cfs-suite/petl_auto_takeover=ON)
[CFS-PSIS] 切卡自动归零 dynamic 已挂钩
```

右上角应该出现浮动胶囊 `🥵 CFS缓存优化器 · 6.0.0`。

---

## 与 CFS Solo 的关系

| | CFS Solo | **CFS Suite** |
|---|---|---|
| 仓库 | [OreoCoins/CFS-SillyTavern](https://github.com/OreoCoins/CFS-SillyTavern) | 本仓 |
| 安装方式 | 酒馆助手脚本库 | ST 原生扩展(git URL) |
| 包含 CFS 接管层 | ✅ | ✅ |
| 切卡自动接管(PETL) | ❌ | ✅(v6 新增) |
| 浮动胶囊 UI | ❌ | ✅(拖拽 + 持久化日志框) |
| 适用场景 | 不用 MVU / 想自管 | 用 MVU + 想要丝滑 + 用 DS V4 |

**两者不可同装**。同装会触发双触发(audit/注入跑 2 倍次数)。装 Suite 前请在酒馆助手脚本管理面板禁用 CFS Solo 脚本。

---

## UI 入口

CFS Suite 提供**两个**独立 UI(并存):

### 1. 浮动胶囊 6.0(推荐)
- 右上角浮动 `🥵 CFS缓存优化器 · 6.0.0`
- **可拖拽**到屏幕任意位置(位置自动记忆,移动端触屏支持)
- 点击展开折叠面板:
  - 运行状态:Coordinator 阶段 / 接管模式 / 16 项模块明细折叠
  - 🧬 MVU 套餐 section:CFS-MVU 状态 + 来源诊断 + 扫描禁用
  - 📐 提示词结构 PSIS PLUS:检测乱序 + 重排 + 自动储存到预设(可还原)
  - 📦 世界书优化 SEM:候选扫描 + 迁移 + 回滚
  - 🐞 RSI 请求结构诊断:跨轮 hash 对账 + 污染来源识别 + PETL 修复记录
  - 4 个一键动作:🥵 启用接管 / ⏸ 关闭接管 / 🔍 重新校验 entry / 🗑️ 清空 Path 缓存
  - 持久化日志框(操作历史 50 条 + 时间戳 + 颜色分级)

### 2. 老版「🛡️ MVU 守护」面板 (V4.9.3 功能)
- 聊天输入框旁的 `🛡️ MVU 守护` 按钮
- 点击弹出完整面板(三大块归零 / MVU 接口管理 / 切卡自动归零 toggle)
- 适合需要细粒度调试的高级用户

---

## 工程链路

```
MagicalAstrogy/MagVarUpdate (上游 MIT)
        │  fork
        ▼
OreoCoins/CFS-MVU (DS4 适配 / parser 容错 / cfs_hooks / exclusive_mode / _cfsEdition)
        │  yarn build → artifact/cfs-mvu-tavern-helper-script.json
        ▼
酒馆助手 → 全局脚本 → 从 JSON 导入(用户手动一次)
        │
        ▼
window.Mvu = { events, getMvuData, ..., _cfsHooks, _cfsEdition }  (13 keys)
        ▲
        │  CFS-Suite 检测 _cfsEdition 决定深度集成
        │
OreoCoins/CFS-Suite (本仓 — ST 原生扩展)
  ├── 16 个 window.CFS4.* 接管模块
  └── window.CFS4.PETL / PSISAutoZero / RSI / SEM / PSIS+(v6 新增)
```

详见:
- 完整 spec:[`doc/spec-v5.0.md`](./doc/spec-v5.0.md)
- MVU fork 改动清单:[`NOTICE-MVU.md`](./NOTICE-MVU.md) → [CFS-MVU NOTICE](https://github.com/OreoCoins/CFS-MVU/blob/beta/NOTICE.md)

---

## F12 常用命令

```javascript
// === MVU 来源诊断 (v6 新增,用户报"非套餐版"时第一时间跑)===
window.CFS4.diagnoseMvuRegistrant()
// dump window.Mvu 真实内容 + Object.keys 长度 + functions 列表

// === PETL 主路径 (v6 新增)===
window.CFS4.PETL.isEnabled()        // 是否切卡自动接管 dynamic entry
window.CFS4.PETL.runNow()           // 手动跑一次扫描接管
window.CFS4.PETL.getHistory()       // 最近 50 次修复记录
window.CFS4.PETL.rollbackLast()     // 撤销最近一次接管
window.CFS4.PETL.setEnabled(false)  // 关掉(LS toggle)

// === PSIS 切卡自动归零 (v6 新增)===
window.CFS4.PSISAutoZero.isEnabled()
window.CFS4.PSISAutoZero.runNow()
window.CFS4.PSISAutoZero.setEnabled(false)

// === RSI 漏扫补充 (v6 新增)===
window.CFS4.RSI.getDriftCandidates()  // 返回 post-history 段 dynamic 块 contentSlice

// === CFS-MVU 套餐版状态(用户必查)===
window.Mvu._cfsEdition
// → { version: '5.0.0-day4b', upstream: '...', features: [...6 项] }
// 若 undefined 跑 diagnoseMvuRegistrant 看真实 keys

// === 核心层 ===
window.CFS4.Coordinator.getState()
window.CFS4.FallbackStrategy.getCurrentMode()
Object.keys(window.CFS4.PathRegistry.getAll()).length  // 应跟当前卡字段数对得上(v6 H2)
await window.CFS4.Coordinator.auditEntries({ force: true })
```

---

## 故障排查

| 现象 | 排查 |
|---|---|
| 胶囊整个消失 | F12 console 看 ReferenceError;v6 H1 修过 `_CFS4G` 作用域 BUG |
| `PathRegistry.getAll()` 显示别的卡的字段 | v6 Hotfix 2 已治;Ctrl+Shift+R 重载 |
| 「MVU 已存在但非 CFS-MVU 套餐版」 | 跑 `diagnoseMvuRegistrant()` 看真实来源,然后胶囊「扫描禁用其他 MVU」自动清(覆盖 ST 第三方扩展层 — v6 H4) |
| 切卡后 cache 命中率塌方 | PETL 主路径应该自动接管 — F12 console 看 `[CFS-Suite/petl] ⚡ 已自动接管 N 条` |
| 移动端胶囊第二次 tap 打不开 | v6 G 阶段已修(`_suppressMouseUntil` 600ms 窗) |
| `[CFS Audit]` 触发 2 次 | CFS Solo 还在跑 — 去酒馆助手脚本面板禁用 |
| 注入 0 字符 | F12 跑 `CFS4.InjectionStrategy.simulateInjection()` |

---

## 模块清单 — V4.9.3 功能

| 层 | 模块 | 文件 |
|---|---|---|
| 1-3 | SessionGate / Coordinator / NotificationCenter | `cfs/core/kernel.js` |
| 4-5 | Schema 冻结层 / Schema 切换门 | `cfs/core/schema_layer.js` |
| 6-7 | Schema 解析器 / Path 注册表 | `cfs/core/path_registry.js` |
| 8 | 差异引擎(三态机) | `cfs/core/diff_engine.js` |
| 9-10 | 存在编码器 / 注入策略 | `cfs/core/injection_strategy.js` |
| 11-12 | 回退策略 / 健康监控 | `cfs/core/fallback_strategy.js` |
| 13 | 真接管 | `cfs/core/real_takeover.js` |
| 14 | PSIS R1 守护 | `cfs/modules/psis.js` |
| 15 | SEM 迁移器 | `cfs/modules/sem.js` |
| 16 | PSIS+ 重排器 | `cfs/modules/psis_plus.js` |
| **17** | **PETL 主路径(v6 新增)** | `cfs/core/petl.js` |
| Aux | RSI 运行时诊断 | `cfs/modules/rsi.js` |
| Aux | Full Refresh Scheduler | `cfs/core/full_refresh_scheduler.js` |

---

## 历史版本

### v5.3.0 — 胶囊双形态 + RSI 诊断器(2026-06-20)
- 移动端 胶囊改 40×40 小圆 + 🧐 emoji + 触屏拖拽
- SEM 表格 `table-layout: fixed` 修边界
- 长期记忆策略合并(Full Refresh + Auto Stable Promotion 三档预设)
- Full Refresh counter=0 BUG 修(`MESSAGE_RECEIVED` 真按轮次计数)
- RSI 请求结构诊断器(跨轮 hash 对账)

### v5.2.0 — UI 修复 + 文案换人话(2026-06-20)
- 修 Day 5 假替代历史债,胶囊真接 PSIS / PSIS+ / SEM 入口
- PSIS panel 拖动 BUG / PSIS+/SEM 边框糊一坨 / ID 冲突
- 术语换人话(promote → 认作稳态字段 等)

### v5.1.0 — Auto Stable Promotion(并入 5.2)
- PathRegistry 加 4 字段自动识别稳态
- 抖动锁定 / Periodic Decay / 跨卡通用

### v5.0.0-day4b — 初版套餐(2026-06-19)
- CFS V4.9.3 完整接管层 16 模块
- CFS-MVU fork bundle 内嵌 / DS V4 适配

---

## 项目结构

```
CFS-Suite/
├── manifest.json                ST 扩展清单 (v6.0.0)
├── index.js                     入口
├── style.css                    占位
├── cfs-mvu/                     预编译 bundle(路线重审,当前不自动加载)
├── cfs/
│   ├── compat/
│   │   └── tavern_helper_polyfill.js   13 API polyfill
│   ├── core/                    8 文件 + petl.js(v6 新增)
│   │   ├── statdata_engine.js
│   │   ├── kernel.js
│   │   ├── schema_layer.js
│   │   ├── path_registry.js     (v6 H2 切卡霸王 reset)
│   │   ├── diff_engine.js
│   │   ├── injection_strategy.js
│   │   ├── fallback_strategy.js
│   │   ├── real_takeover.js
│   │   ├── petl.js              (v6 新增 主路径)
│   │   └── full_refresh_scheduler.js
│   ├── modules/
│   │   ├── psis.js              (v6 B 切卡自动归零)
│   │   ├── sem.js
│   │   ├── psis_plus.js
│   │   └── rsi.js               (v6 D drift candidates)
│   └── ui/
│       └── floating_capsule.js  (v6 G/F 移动端 touch + MVU 来源扫描)
├── test/                        Node 直跑单测(v6 新增)
│   ├── petl_smoke.mjs           (36/36 ✓)
│   ├── rsi_l2_smoke.mjs         (7/7 ✓)
│   └── fixtures/
├── README.md
├── NOTICE-MVU.md
├── LICENSE                      MIT
└── doc/
    └── spec-v5.0.md
```

---

## License

MIT — © 2026 OreoCoins / CFS-Suite contributors

`cfs-mvu/` 子目录的衍生作品声明 + 上游致谢见 [`NOTICE-MVU.md`](./NOTICE-MVU.md)。
原 MagVarUpdate 上游:© 2025 MagicalAstrogy & StageDog (MIT).
