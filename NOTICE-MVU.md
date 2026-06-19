# NOTICE — `cfs-mvu/` 子目录的来源

CFS-Suite 套餐版的 `cfs-mvu/` 子目录是 [`OreoCoins/CFS-MVU`](https://github.com/OreoCoins/CFS-MVU)（fork from [MagicalAstrogy/MagVarUpdate](https://github.com/MagicalAstrogy/MagVarUpdate)）的预编译 bundle。

- 上游基线：`MagicalAstrogy/MagVarUpdate@c1ae3a9`（2026-04-25，[bot] Bundle）
- License：MIT（与上游一致）
- 改动清单：见 [`OreoCoins/CFS-MVU` 的 `NOTICE.md`](https://github.com/OreoCoins/CFS-MVU/blob/beta/NOTICE.md)
- 变更日志：见 [`OreoCoins/CFS-MVU` 的 `CHANGELOG-CFS.md`](https://github.com/OreoCoins/CFS-MVU/blob/beta/CHANGELOG-CFS.md)

CFS-Suite 仓库本身**不重复列 `cfs-mvu/` 内部的改动**。所有 MVU 端修改都集中在 `OreoCoins/CFS-MVU` 仓库追溯。

---

## 当前状态（Day 1）

- `cfs-mvu/` 子目录尚未注入 bundle。Day 2 完成 DS4 / parser / hooks 改动并 webpack build 后，把 `artifact/bundle.js` 等产物拷入。
