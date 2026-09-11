# DING 代码审计报告（2026-09-11）

> 只读审计，未在审计阶段修改代码。基线 `audit/hidden-bugs`（起点 `af9fb46`，`scripts/check.sh` 全绿）。
> 方法：5 路并行全文精读（历史项核对 / 派生状态 / 异步竞态 / UI·GTK4·拖放 / Shell·D-Bus）+ 交叉验证。
> 关键结论均经二次核实：GTK 4.22 API 探针、Gio 监视器行为实测、真实 journal 证据与反证（详见各项“证据”列）。
> **总计：P0×5、P1×7 已全部修复（含回归测试）；P2 剩余项见文末。**

## 一、已修复（P0，5 项）

| # | 问题 | 关键证据 | 修复 | 提交 |
|---|------|----------|------|------|
| P0-1 | 加密压缩密码框竞态：点 Cancel/OK 落进 `await _cleanupFile()` 窗口 → 对话框永不可关、`inhibit(LOGOUT\|SUSPEND)` 长期持有 | `auto-ar.js:469` 先 await 清理、`:478` 才装 resolver | `_requestPassphrase()` 弹提示同时同步安装 resolver | `83f82a1` |
| P0-2 | 撤销/重做永久失效：`RemoteFileOperations.isAvailable` 不存在（只有 `ProxyManager` 有） | `desktop-menu.js:205`；`dbus-utils.js:199` | `DbusOperationsManager.isAvailable` getter + `proxy?.UndoStatus` | `c44dcda` |
| P0-3 | Gio 监视器创建失败（inotify 实例耗尽）：桌面目录/回收站/脚本模板 4 处无防护、theme 无重试且 `_userCssMonitor` 未初始化 | journal 268 次 `无法找到默认的本地文件监视器类型`（gnome-control-center 亦报）；`DesktopManager` 异常发生在 `hold()` 之后 → 进程存活但无桌面、扩展永不重启 | `monitorDirectoryDefensively()`（永不抛、2s/5s/10s/30s 有界重试）+ 5 处接线 + 销毁守护 | `30013af` |
| P0-4 | 重命名弹窗调用 GTK3 `set_relative_to`（GTK 4.22 实测不存在）→ 重命名期间刷新全被丢弃；配套隐藏雷：快速路径重挂到已销毁对象 → 清空桌面 | `ask-rename-popup.js:95,101`；GTK 探针 `Popover.prototype.set_relative_to: undefined` | `unparent()/set_parent()`（实测 `unparent` 不触发 `closed`）；两个块改遍历 `this._fileList`；`setRenamePopup` 守卫 | `39aa09a` |
| P0-5 | “新建含选区的文件夹”失败时留下已销毁 item → 键盘导航抛错、下次快速刷新 `container.put(null)` 崩掉并清空桌面 | `file-item-menu.js:657-668` | 先建目录再销毁；移动失败回调自愈；`_canReuseFileItems()` 永不采纳 `_destroyed` item | `e5c3b7d` |

## 二、已修复（P1，7 项）

| # | 问题 | 修复 | 提交 |
|---|------|------|------|
| P1-A | `_readingDesktopFiles` 无 `try/finally`：读失败或中途绘制崩 → 刷新系统永久停摆 | 循环包 `try/finally` | `a2853fc` |
| P1-B | 文件夹图标拖放恒为复制（COPY\|MOVE 被折叠成 ASK）；`text/plain` 当 URI 传给 D-Bus | `resolveDropAction()`；`writeTextIntoFolder()` | `718b633` |
| P1-C | legacy `RenameURIRemote` 非 async（`.catch` TypeError）；同步抛错路径泄漏 Wayland handle | legacy 改 async；catch 里释放 handle | `3674f65` |
| P1-D | 所有 `_pendingMoves` 共用一个超时 → 150ms 内两次 MOVED_OUT 残留幽灵图标 | `_pendingMoveTimeouts[oldPath]` 每项独立 | `fef5466` |
| P1-E | 元数据查询回调无条件清共享 cancellable 并应用结果 → 旧结果覆盖新状态 | 回调持有自身 cancellable + `_destroyed`/最新者胜判断 | `c61411b` |
| P1-F | `/proc` TOCTOU 可致扩展整个会话不加载；6s 看门狗与延迟 show 冲突（慢盘首读被杀循环） | 逐项 try/catch；app 首次刷新激活 shell `disableTimer` | `01ceb73` |
| P1-G | 缩略图队列：超时与 generate/save 双完成、双 `_launchNewBuild()`、promise 悬空 | 每构建本地 cancellable + `complete()` 首个完成者胜；所有路径必结算 | `b8fde23` |

## 三、仍开放（P2，未修复）

| # | 位置 | 问题 | 影响 |
|---|------|------|------|
| P2-1 | `desktop-monitor.js` `applyDropCoordinates()` | `_pendingDropFiles` 的 TTL/64 上限只在应用落点坐标时触发；复制全程失败则永不清理 | 低（映射无界 + 5 分钟窗口内可能误配） |
| P2-2 | `desktop-manager.js` `_refreshReusedFileItem()` | 快速路径不重放 `show-drop-place` 设置 | 低（需一次文件集变化才生效） |
| P2-3 | `dnd-manager.js:125-127` | `onDragEnd` 只清 `dragItem`，不清 `_dragList` | 低（第二次拖拽预览偏移错误） |
| P2-4 | `visible-area.js:78` | `Math.max(0, undefined)` 会把只设部分边距的第三方集成变成 NaN → `_maxColumns` NaN | 低-中（当前 dash-to-dock 四边齐全；属潜在） |
| P2-5 | `extension.js:229-235` | disable 只发 SIGTERM，无升级兜底 | 低（app 主循环阻塞时可能残留旧实例；未复现） |
| P2-6 | `extension.js` `innerEnable()` | 移除 `launchDesktopId` 未归零 → 后续 `source_remove` 警告 | 低（难触发） |
| P2-7 | `desktop-grid.js:490` / `paint-container.js:181` | 每帧 `new Gdk.Rectangle` / `RoundedRect`（P2-2 剩余分配） | 低（GC 抖动，无正确性问题） |
| P2-8 | `extension.js` `doKillAllOldDesktopProcesses()` | 构造时同步全量扫 `/proc`（P2-9 历史项未做） | 低（会话繁忙时短暂阻塞 Shell 主循环） |

## 四、诚实性说明：被推翻/被掩盖的结论

- **状态代理“重命名 → 空白桌面”顺序错误**：`_drawDesktop()` 在清空网格**之前**就调用 `updateFileItem(null)`，而后者因 GTK4 API 缺失先抛异常（P0-4），因此“清空网格后崩溃”的场景当时不可达。两项已合并成对修复；仅修一处会把空白桌面暴露出来。
- **6s 看门狗从未真实发生**：扫全部历史 journal，`Launching DING process` 的 5–9 秒循环间隔出现 **0 次**，按潜在风险处理（P1-F）。
- **`GFileInfo created without standard::*`**：9/9 出现过 119 次，当时 `DEFAULT_ATTRIBUTES` 已是 `standard::*`；此后未再出现，未列为开放项。
- 代理自报测试数“17 suites / 453 assertions”与实测（20 模块 / 337→405 断言）不符；其代码级结论已逐条抽查成立，数字类一律以本地复跑为准。

## 五、历史审计（2026-08）核对结果

- **21 项 FIXED**（P0-1~P0-4、P1-1~P1-7、P2-1、P2-3~P2-6，含“修复未引入新 bug”专项检查）
- **1 项 PARTIAL**：P2-2 每帧分配（主体已修，剩余见 P2-7）
- **1 项 OPEN**：P2-9 同步扫 `/proc`（见 P2-8）
- **2 项已排除**：P1-8（Meta API 废弃已对 mutter 源码证伪）、P2-8（Overview clone 已真机排除）

## 六、测试与验证

- 审计后新增 11 个测试文件（`tests/test-undo-status.js`、`test-new-folder-selection.js`、`test-rename-popup.js`、`test-passphrase-race.js`、`test-monitor-defensive.js`、`test-refresh-guard.js`、`test-icon-drop.js`、`test-pending-moves.js`、`test-metadata-refresh.js`、`test-thumbnail-queue.js`、`test-desktop-grid.js`）。
- `bash scripts/check.sh`：ESLint / `node --check` / 单测 / `ding.js` 冒烟 / 结构检查 全部通过。
- 真机验证要点：ChromaLeon 热重载期间反复刷新、重命名期间触发刷新、拖放文件到文件夹图标、加密压缩取消、慢首次读取（封面缓存）场景。
- 已知缺口：**Shell 侧（extension.js 等）无单测**（依赖 Shell/Meta/Main 无法在 gjs 测试环境导入）——本次为注入桩测试了 app 侧调用点，Shell 侧仅靠代码审查 + 冒烟测试。
