# CFS Suite

> Cache-Friendly Scanner **套餐版** — CFS 核心 + bundled MVU fork，针对 DeepSeek V4 协议做了适配。
>
> 版本：`v5.0.0-day1`（骨架阶段，无功能）

---

## ⚠️ 霸王规则（装之前必读）

CFS Suite 是**霸王扩展**：

- 安装后**强制接管** `window.Mvu`，禁用**所有**其他 MVU 来源
  - 包括但不限于：卡绑定脚本里的 MVU Zod、ST 全局 MVU 扩展、其他社区 fork
- 禁用是 **silent** 的（无 popup 确认），**下载 = 知情同意**
- 强制接管仅在运行时，不删用户磁盘上的卡 / 扩展文件
- 卸载 CFS Suite 后，其他 MVU 来源可恢复

**如不接受这些规则，请装 [CFS Solo](https://github.com/OreoCoins/CFS-SillyTavern)**（v4.9.1 单脚本版，不接管 MVU，仅 cache 优化）。

---

## 安装

ST UI → 扩展 → 安装扩展 → 粘贴 git URL：

```
https://github.com/OreoCoins/CFS-Suite
```

→ F5 刷新 ST → CFS Suite 自动启用。

---

## 与 CFS Solo 的关系

| | CFS Solo | **CFS Suite** |
|---|---|---|
| 仓库 | [OreoCoins/CFS-SillyTavern](https://github.com/OreoCoins/CFS-SillyTavern) | [OreoCoins/CFS-Suite](https://github.com/OreoCoins/CFS-Suite) |
| 安装方式 | 酒馆助手脚本库 | ST 扩展（git URL） |
| 包含 CFS | ✅ | ✅ |
| 包含 MVU | ❌（自管） | ✅（fork 自上游 + DS4 适配） |
| 接管其他 MVU | ❌ | ✅（silent） |
| 适用 | 不用 MVU / 想自管 MVU | 用 MVU + 想要丝滑 |

**两者不可同装**。manifest 启动期会检测，如发现冲突会提示卸载另一个。

---

## 工程链路

```
MagicalAstrogy/MagVarUpdate (upstream MIT)
        │  fork
        ▼
OreoCoins/CFS-MVU (fork + DS4 适配 / parser 容错 / CFS hooks)
        │  webpack build → bundle
        ▼
OreoCoins/CFS-Suite/cfs-mvu/ (预编译产物，本仓)
```

CFS-MVU 改动清单见 [`NOTICE-MVU.md`](./NOTICE-MVU.md) → 链回 CFS-MVU 仓库的 `NOTICE.md`。

---

## 当前状态（Day 1）

- ✅ 仓库骨架就绪（manifest / index.js / style.css 占位）
- ⏸ `cfs-mvu/` 子目录暂空，Day 2 完成 MVU 端改动后注入 bundle
- ⏸ CFS 核心代码（`cfs/core/`、`cfs/modules/`、`cfs/ui/`）Day 3-6 从 [`CFS-SillyTavern@v4.9.1`](https://github.com/OreoCoins/CFS-SillyTavern) 迁移
- ⏸ silent 接管 `window.Mvu` 与其他 MVU 来源（`exclusive_mode`）Day 4 落地

施工计划全文见 [spec](https://github.com/OreoCoins/CFS-Suite/blob/main/doc/spec-v5.0.md)（待写）。

---

## License

MIT — © 2026 OreoCoins / CFS-Suite contributors

`cfs-mvu/` 子目录的衍生作品声明 + 上游致谢见 [`NOTICE-MVU.md`](./NOTICE-MVU.md)。
