# DING 可维护性重构总结（2026-07 ~ 2026-08）

本分支（`refactor/maintainability`）对 DING（Desktop Icons NG）执行了一轮**不影响功能**的可维护性提升重构，目标：降低单文件复杂度、统一代码风格、建立自动化验证、消除潜伏 bug。所有步骤保持行为等价，仅修复重构过程中暴露的真实 bug。

## 动机

- `desktop-manager.js` 1850 行、`dbus-utils.js` 780 行的单体类难以维护
- 无自动化检查：eslint 129 项违规、`generateDropFilename` 正则错误等潜伏 bug 无法被发现
- 脚本散落根目录，依赖 CWD 运行
- 文件命名风格不统一（camelCase），与社区惯例不符

## 阶段总览

| 阶段 | 内容 | 关键产出 |
|---|---|---|
| 0 | 工具链 | `eslint.config.js`（GJS 全局 + exported 规则）、`tests/` gjs 断言 harness（131 断言）、`scripts/check.sh` 一键验证、`docs/refactor-checklist.md` 人工回归清单 |
| 1 | 脚本迁移 | 7 个脚本移入 `scripts/`，均支持任意 CWD；meson/README/AGENTS.md 同步 |
| 2 | 重构 | `_updateDesktopSafe()` 抽取 14 处重复 catch；构造函数 269→27 行 + switch 分派；`app/constants.js` 魔法数字；`app/log.js` 调试门控；死代码清理；`_remoteCall` 模板化（-302 行） |
| 3 | 拆分 | `desktop-monitor.js`(279)/`grid-layout.js`(111)/`dbus-remote-operations.js`(264)；信号生命周期管理（`_trackSignal`/`destroy()`，修复 ProxyManager #34） |
| 4 | ESM 迁移 | 35 个 app 模块 + 8 测试文件迁移 ESM；`app/signals.js` 自实现；`desktop-icons-integration.js` 保持 legacy |
| 5 | 文档 | 本文档 + architecture-analysis/fixes.md 更新 |

## 关键决策

| 决策 | 理由 |
|---|---|
| kebab-case 全量重命名（53 文件） | 社区惯例；GJS legacy import 需用 `imports['kebab-name']` 括号语法（实测不支持映射） |
| `signals` 内置模块自实现为 `app/signals.js` | GJS 1.88 ESM 实测不可导入内置 `signals`/`bytearray` |
| `GnomeDesktop`/`GnomeAutoar` 动态 `import()` | 缺失 GIR 时优雅降级（缩略图/压缩），**禁止顶层 await**（见下） |
| 粘贴定位用 `_pendingDropFiles` + 模糊匹配 | gvfs metadata 不随复制继承是硬事实；basename+前缀匹配是唯一可靠机制（23 断言锁定） |
| stale 剪贴板过滤回退 | 用户判定 Nautilus 原生弹窗报错更好，不重复造轮子 |
| `desktop-icons-integration.js` 保持 legacy | 第三方扩展在 Shell 内用 `imports.*` 加载，ESM 化破坏兼容 |
| 版本 pin 用 `gi://X?version=4.0`；无歧义库用 bare import | 显式 pin 只用于多版本库 |

## ESM 迁移实战结论（GJS 1.88 / mozjs-140）

- `gjs --module` 必需（.js 不自动检测）；内置模块仅 `gettext`/`system`/`cairo`/`console` 可导入
- `print`/`logError`/`ARGV` 全局在 ESM 可用；`ARGV` 在 `--module` 下为 `[]`（`run(ARGV)` 正常）
- **顶层 `await import('gi://...')` 会卡死 promise job queue**：Gtk 窗口渲染后模块的 AsyncModuleExecution 链永不排空，所有后续 microtask 停摆（桌面空、菜单缺项）。必须用非阻塞 `import().then()` + 延迟初始化
- 命名空间冻结：`this.x=` 写模块变量静默失败（prefs 的 `schemaGnomeDarkSettings` bug）
- 裸 `class` 声明不导出（须 `var X = class`）；`export var X;` 无初始化器被 ESLint 报未使用（须 `= null`）
- gettext：必须 `Gettext.domain('ding').gettext` / `.ngettext`（16 文件 + 3 处 ngettext 遗漏修复）

## 验证方式

- `scripts/check.sh`：eslint（零违规）+ 全部 JS `node --check` + gjs 单测（131 断言）+ 结构检查（`_remoteCall` 存在、无裸顶层 class、无裸 `this` 传参、meson manifest 与磁盘一致）
- 单测覆盖：FileChangesQueue(13)/matchPendingDropEntry(23)/GridLayout(27)/SortManager(30)/generateDropFilename(38)
- 用户手动构建：`bash scripts/refresh_extension.sh` + `docs/refactor-checklist.md` 人工回归

## 重构中修复的潜伏 bug（详见 docs/fixes.md）

- thumbnails.js 未定义 `reject`（文档声称已修实际未修）
- `generateDropFilename` 正则 `\\x00-\\x1f` 双反斜杠（数字/字母被污染）
- meson.build 缺新文件清单（构建产物缺文件）
- fileOperations.js 缺 gettext `_`（翻译丢失）
- ding.js 默认 desktop 缺 `scaleFactor` → 窗口尺寸 NaN
- **顶层 await import() 卡死 job queue（桌面空，ESM 引入）**
- 设置窗口置顶/全工作区（标题空格 hack，upstream 设计）
- POTFILES.in 20 条失效文件名（构建后翻译丢失风险）

## 遗留问题（待决策）

- `ding.js` 的 `-P`/searchPath 机制失效：保留参数兼容，删除 `imports.searchPath.unshift`
- 分支合并策略：`refactor/maintainability` → `refactor-260802` 时机由用户决定

> SortManager localeCompare 选项位置 bug **已修复**（2026-08-02）：options 移到第 3 参，按名称排序变为大小写不敏感 + 数字自然排序，测试断言已更新锁定。
