# DING 文档索引

## 活文档（随代码持续更新）

| 文档 | 说明 |
|---|---|
| [`fixes.md`](fixes.md) | 修复日志（2026-08 起）。修 bug 后按项目约定更新此文件；2026-07 及更早条目见 [`archive/fixes-2026-07.md`](archive/fixes-2026-07.md) |
| [`architecture-analysis.md`](architecture-analysis.md) | DING 双层架构（Shell 扩展 + GTK4 进程）、启动流程、D-Bus 通信、模块结构分析 |
| [`overview-animation.md`](overview-animation.md) | 概览模式桌面图标淡入淡出动画的实现分析（Clutter.Clone + OverviewAdjustment） |
| [`volume-mount-issues.md`](volume-mount-issues.md) | 外部/网络驱动器问题清单（V-1 ~ V-9）及修复状态 |

## 存档（历史时点产物，不再更新）

| 文档 | 说明 |
|---|---|
| [`archive/code-audit.md`](archive/code-audit.md) | 2026-08 全面代码审计报告（P0~P3 分级清单），修复进展以 `fixes.md` 为准 |
| [`archive/maintainability-refactor.md`](archive/maintainability-refactor.md) | 2026-07~08 可维护性重构总结（分支 `refactor/maintainability`） |
| [`archive/manual-test-checklist.md`](archive/manual-test-checklist.md) | audit-fixes 批次（提交 `f147f54`）手动回归清单 |
| [`archive/fixes-2026-07.md`](archive/fixes-2026-07.md) | 修复日志 2026-07 条目归档 |

> 新的一次性产物（某批次/某分支的审计、清单、总结）直接放入 `archive/`，并在本索引登记。
