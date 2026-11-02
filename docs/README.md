# DING 文档索引

> 项目主页说明：根目录 [`README.md`](../README.md)（中文，默认）与 [`README.en.md`](../README.en.md)（英文）。
> 展示用截图放在 [`images/`](images/)。

## 活文档（随代码持续更新）

| 文档 | 说明 |
|---|---|
| [`fixes.md`](fixes.md) | 修复日志（2026-09 起，仅保留近期条目）。修 bug 后按项目约定更新此文件；更早条目见归档 |
| [`architecture-analysis.md`](architecture-analysis.md) | DING 双层架构（Shell 扩展 + GTK4 进程）、启动流程、D-Bus 通信、模块结构分析 |
| [`settings-and-shortcuts.md`](settings-and-shortcuts.md) | 16 项 gsettings 键与默认值、完整快捷键表、独立运行与调试参数（README 移出的参考清单） |
| [`deployment.md`](deployment.md) | 用户级/系统级安装命令、多机部署、扩展 ZIP 打包、与发行版版本的 UUID 共存（README 移出的安装细节） |
| [`overview-animation.md`](overview-animation.md) | 概览模式桌面图标淡入淡出动画的实现分析（Clutter.Clone + OverviewAdjustment） |
| [`volume-mount-issues.md`](volume-mount-issues.md) | 外部/网络驱动器问题清单（V-1 ~ V-9）及修复状态 |

## 实施计划

| 文档 | 说明 |
|---|---|
| [`superpowers/plans/2026-11-02-primary-desktop-position.md`](superpowers/plans/2026-11-02-primary-desktop-position.md) | 仅主屏模式位置稳定性：比例锚点持久化、旧坐标迁移、明确保存意图和几何事件合并。**已实施**（提交 `11c9300`→`b14d891`，实现记录见 [`fixes.md`](fixes.md) 2026-11-02 条目）；计划内的真机验收项（热插拔、实际缩放与 Dock 边距、`keep-arranged` 切换、特殊 URI 写入）尚未在真机验证 |

## 存档（历史时点产物，不再更新）

| 文档 | 说明 |
|---|---|
| [`archive/code-audit-2026-09.md`](archive/code-audit-2026-09.md) | 2026-09-11 全仓审计（P0×5、P1×7 已修 + P2 遗留清单 + 历史项核对） |
| [`archive/maintainability-refactor.md`](archive/maintainability-refactor.md) | 2026-07~08 可维护性重构总结（分支 `refactor/maintainability`） |
| [`archive/manual-test-checklist.md`](archive/manual-test-checklist.md) | audit-fixes 批次（提交 `f147f54`）手动回归清单 |
| [`archive/fixes-2026-07.md`](archive/fixes-2026-07.md) | 修复日志 2026-07 条目归档 |
| [`archive/fixes-2026-08.md`](archive/fixes-2026-08.md) | 修复日志 2026-08 条目归档 |

> 新的一次性产物（某批次/某分支的审计、清单、总结）直接放入 `archive/`，并在本索引登记。
