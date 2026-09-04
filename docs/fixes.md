# 修复日志

> 2026-07 及更早的条目已归档至 [`docs/archive/fixes-2026-07.md`](archive/fixes-2026-07.md)。

## 2026-09-04

### 可维护性重构：VolumeMonitor/mount 逻辑拆分至 `app/mount-manager.js`

**背景：** `desktop-manager.js` 仍是事实上的 god class（~1700 行 / 87 方法），混了桌面枚举、增量事件、mount 卷管理、find-files、新建/重命名编排。其中 mount 逻辑已自成闭环（独立常量、独立状态机、独立测试），是最低风险的拆分目标。

**变更（行为等价，无功能变化）：**

1. **新模块 `app/mount-manager.js`（`MountManager` 类）**：承载 VolumeMonitor 三个信号（mount-added/changed/removed）的监听与刷新调度、`_readMountsAsync()` 异步 mount 信息查询（V-3）、`_createMountFileItem()` 工厂接缝、`_scheduleMountRefreshRetry()` 重试调度（V-6）、相关状态（`_mountRetryCounts`/两个 timeout id/`_mountsQueryCancellable`）。
2. **依赖注入**：`MountManager(parent, onRefresh)` — `parent` 为 DesktopManager（FileItem 构造宿主 + `_forcedExit` 状态），`onRefresh` 为 `DesktopManager._updateDesktopSafe` 回调。刷新方向单向（MountManager → DesktopManager），无循环引用。
3. **`desktop-manager.js` 瘦身**：移除 mount 状态字段、三个信号处理器、三个 mount 方法；`destroy()`/SIGTERM 路径改调 `_mountManager.destroy()`/`cancelQuery()`；刷新流程改调 `_mountManager._readMountsAsync(_mountManager.getMounts(), ...)`。
4. **测试**：`tests/test-volume-mount.js` 的 V-3/V-6 用例改测 `MountManager`（stub 改 `Object.create(MountManager.prototype)` + `_parent` 桩）；V-2 快路径用例留在 DesktopManager（该逻辑未移动）。全部 123 断言通过。
5. **清单/文档**：`app/meson.build` 新增安装项；`docs/architecture-analysis.md` 模块树/表新增条目；`docs/volume-mount-issues.md` 代码位置引用更新。

**验证：** `scripts/check.sh` 全绿（eslint 无新增违规 / node --check / 12 组 gjs 单测 / meson 清单与磁盘一致）。**需用户构建后真机回归**：插拔 U 盘/网络驱动器图标出现与消失、拔插瞬间右键弹出/卸载菜单。

### 右键菜单对齐 Nautilus：可弹出介质不再同时显示「弹出」与「卸载」

**背景：** DING 的驱动器菜单（`app/file-item-menu.js`）对 `canEject`/`canUnmount` 各自独立显示，U 盘两者皆真 → 菜单同时出现「弹出」和「卸载」。Nautilus（`nautilus-files-view.c` `file_should_show_foreach`）明确注释 *"Do not show both Unmount and Eject/Safe Removal; too confusing"*，采用互斥策略：能弹出只显示「弹出」（Eject 是 Unmount 的超集：卸载 + 硬件 safe-removal 信号），「卸载」仅作为不可弹出挂载（网络盘、loop 设备）的兜底。

**变更：** `app/file-item-menu.js` 「卸载」菜单项显示条件改为 `canUnmount && !canEject`（Nautilus 的 `!show_stop` 分支 DING 未实现 stop 动作，不适用）。行为变化：U 盘/光驱右键菜单只剩「弹出」；SMB/NFS 等网络挂载仍显示「卸载」。

**验证：** eslint 零违规、12 组 gjs 单测 123 断言通过。菜单显示逻辑无自动化覆盖（需 GTK 菜单 harness），需真机回归：U 盘菜单只有「弹出」、网络驱动器菜单只有「卸载」。

## 2026-09-02

### 外部/网络驱动器健壮性修复（V-1 ~ V-7，详见 docs/volume-mount-issues.md）

**背景：** 对 VolumeMonitor/mount 生命周期做系统性审查，发现 9 个问题（V-1 ~ V-9，代码 + 本机 gjs 实验验证）。本次修复其中 6 个（V-1 ~ V-7），全部有单元测试覆盖（`tests/test-volume-mount.js`，29 断言）。

**变更：**

1. **V-2 刷新快路径持有 stale GMount（P1）：** `_drawDesktop` 的 URI 集合不变快路径不更新旧 FileItem 的 `_custom`（GMount）。触发条件：500ms 卸载防抖窗口内快速重插同一盘（同挂载点）→ 图标持有死 mount，菜单"弹出/卸载"失效、显示名可能过期，且**之后 F5 永远走快路径无法自愈**。抽出 `_refreshReusedFileItem()`：复用时同步 `old._custom = newItem._custom`（`app/desktop-manager.js`）。
2. **V-1 eject/unmount 失败无反馈（P1）：** `*_with_operation_finish` 失败（卷忙/无权限/死 mount）时直接 throw，无 catch → 静默失败，只有 stderr 堆栈。重构为 `_doMountOperation()`：失败走 `_logAndPopupError` 弹 `ShowErrorPopup`（与 open 等操作的失败处理一致）；图标已销毁时只 log 不弹窗（`app/file-item.js`）。
3. **V-5 菜单动作缺 null 守卫（P3）：** `getFileItemFromURI` 找不到时返回 `null`（菜单打开期间卷被卸载等），7 个按 URI 取 item 的 GAction 回调直接解引用 → TypeError。统一加 `if (file !== null)` 守卫（沿用 `launch-with-discrete-gpu` 既有模式）（`app/file-item-menu.js`）。
4. **V-3 网络挂载同步 query_info（P2）：** mount 的 `query_info(DEFAULT_ATTRIBUTES)` 在主循环回调内同步执行，`access::*` 对死掉的 SMB 服务器会阻塞 gvfs 网络超时（数十秒），整个桌面图标进程冻结。新增 `_readMountsAsync()`：逐个 `query_info_async` 查询，慢挂载只延迟自己的图标，不卡主循环（非阻塞行为由单测钉住）；FileItem 构造抽出 `_createMountFileItem()` 小接缝供测试替换。
5. **V-6 mount 瞬时失败无重试（P3）：** `mount-added` 时 gvfs/udisks 守护进程未就绪 → 图标静默缺失直到下一次无关刷新。新增 `_scheduleMountRefreshRetry()`：mount-added 追加一次延迟二次刷新；查询失败且 mount 仍存在时安排重试；连续失败上限 3 次（`MOUNT_QUERY_MAX_RETRIES`），成功或 mount-removed 清零，防刷新循环（新常量 `MOUNT_RETRY_DELAY_MS`/`MOUNT_QUERY_MAX_RETRIES`，`app/constants.js`）。
6. **V-7 未监听 mount-changed（P3）：** 盘的 label / can-unmount 等属性原地变化时图标名与菜单不更新。补 `mount-changed → _updateDesktopSafe` 监听。

**测试：** 新增 `tests/test-volume-mount.js`（29 断言）：V-1 异步失败/同步 throw/已销毁/成功/无 mount 五路径；V-2 stale mount 换新 + 非驱动器项 no-op；V-3 成功/失败/非阻塞（主循环心跳）/取消；V-6 重试触发/mount 消失不重试/上限与合并。`gjs --module tests/run.js` 全绿（123 断言）。

**未修复（待决策/低优先级）：** V-4 未挂载卷不显示（待产品决策）、V-8 桌面目录不存在时全部图标消失、V-9 无 drive/volume 的本地挂载归类为网络（待运行时验证）。

## 2026-08-13

### 图标全部消失：异常显示器 geometry 导致 grid 零尺寸假满（real-world 事故 + 可复现实验）

**症状：** 用户解压 412MB 压缩包后，桌面图标全部消失。journal 反复打印 `DING: Not enough space to add icons`（17:54:52/17:55:22/17:55:27/17:55:46 共 4 次），重启 DING 进程后恢复。

**根因（已通过 DBus 实验 100% 复现与验证）：**

1. `DesktopGrid.getDistance()` 的"满"判定是 `_occupiedCount >= _maxColumns * _maxRows`；而 `setGridStatus()` 对每个格子调用 `_setGridUse(x,y,false)` 时 `wasInUse=undefined`，计数实际为 `-N + 已放图标数`。**只要 grid 尺寸（宽或高）≤ 0，`0 >= 0` 恒成立 → 所有坐标永远返回 -1 → 每个图标都"放不下"。**
2. 尺寸来自 DBus `desktopGeometry` action（扩展在 monitors-changed / workareas-changed / updated-usable-area / scale-factor 变化时重发）。**合成器某次重算瞬间产生了零/负尺寸的 monitor 描述（实验证实 width=0 或 height=0 或 scale=0 即可触发），DING 无条件重建 grid → 全灭且无自愈**（后续每次刷新都失败，直到进程重启）。
3. 实验：通过 `org.gtk.Actions.SetState` 向 `/com/rastersoft/dingextension/control` 发送 `width=0` 的 geometry → journal 出现与事故逐字一致的 `dist=-1` + `Not enough space to add icons`，图标全灭；发回正常 geometry → 全部恢复。

**变更：**

| 项 | 文件 | 内容 |
|---|---|---|
| 1 | `app/grid-layout.js` | `updateGridWindows()` 入口校验：任一 monitor 的 `width <= 0` / `height <= 0` / `scaleFactor <= 0` → 拒绝整批更新（保留旧布局），只打 `[grid] updateGridWindows REJECTED ...` debug 日志。正常 geometry 更新路径不受影响 |
| 2 | `app/desktop-grid.js` | 纵深防御：`_maxColumns/_maxRows = Math.max(1, floor(...))`，防止其他路径喂入退化尺寸时除零/NaN 连锁（`_elementWidth = width/0`） |

**验证：**

- 发送 `width=0`、`height=0`、`scale=0` 三种异常 geometry → 全部 REJECTED，图标保持 26 个，无 `Not enough space`
- 发送有效变化 geometry（marginTop 32→100）→ 正常重建（`[grid] desktop#0 rect=(0,100) win=(2048x1052)`），图标正常重排
- 回归：正常 geometry diff 相同 → 不触发刷新（原有 fast-path 不变）
- 事故现场：重启 DING 后无任何报错，图标完整恢复

**遗留：** 17:54 的异常 geometry 由哪个信号/瞬间产生未能从历史日志锁定（当时未开 DING_DEBUG）。修复后即使再次发生，DING 会拒绝并保持旧布局；建议后续如再遇图标消失，先查 `[grid] updateGridWindows REJECTED` 日志（需 DING_DEBUG=1）。

**另记录独立小 bug（未修）：** 17:17 手机 MTP 挂载时 `GFileInfo created without standard::is-hidden/is-backup/is-symlink` CRITICAL ×3 —— MTP 文件系统不提供这些属性，`_doReadAsync`/`handleFileCreated` 的 query_info 需对挂载卷容错（仅警告，不影响功能）。

## 2026-08-10

### 增量更新增强：内容/属性变化单图标刷新 + 事件路由补全（对比 Nautilus 审查后实施）

**背景：** 与 Nautilus（nautilus-monitor.c / nautilus-file-changes-queue.c）对比审查后，确认 DING 的事件路由有真实缺口与死代码。

**变更：**

| 项 | 文件 | 内容 |
|---|---|---|
| P1 | `app/desktop-monitor.js` | `CHANGES_DONE_HINT`/`ATTRIBUTE_CHANGED`（子文件）不再丢弃，新增 `handleFileChanged`：按 URI 定位 item → `updatedMetadata()`（rebuild 图标，缩略图经 modifiedTime 缓存自动失效重生成）。`CHANGED`（逐块写入）保持丢弃。对齐 Nautilus：`CHANGES_DONE_HINT` 触发单文件刷新 |
| P2 | `app/constants.js` | `MAX_INCREMENTAL_EVENTS` 2→8（paste/解压 burst 减少分批次数；队列恒 flush ≤ 上限，overflow 防御分支保留） |
| A' | `app/desktop-monitor.js` | `MOVED_CREATED`/`MOVED_DELETED`（枚举值 11/12）改数字常量路由：**GIR 未暴露这两个成员（GJS 实测为 undefined）**，原有 `case Gio.FileMonitorEvent.MOVED_CREATED:` 是 `case undefined:` 死代码，真实 11/12 事件会落入 default → 全量刷新。现在 11→handleFileCreated、12→handleFileDeleted（防御，实测 inotify 发 MOVED_OUT(null) 而非 12） |
| B | `app/file-item.js` | 删 `onAttributeChanged()` 死代码（全仓无调用点；P1 的 `handleFileChanged → updatedMetadata` 已覆盖且不再限定 .desktop） |
| C | `tests/test-desktop-monitor.js`（新增）+ `tests/run.js` | DesktopMonitor 事件路由单测 25 断言（mock _dm）：过滤规则、RENAMED 参数约定（file=旧/otherFile=新）、CHANGES_DONE_HINT 跟踪/未跟踪、MOVED_DELETED/MOVED_OUT(null) 增量删除、未知路径/超限/未知事件全量兜底 |
| E | `docs/archive/manual-test-checklist.md` | 新增 3 组回归项：重命名增量、内容变化缩略图刷新、拖入子文件夹增量删除 |

**验证：** `node --check` + `scripts/check.sh` 全绿（9 测试模块，DesktopMonitor 新增）。待真机回归：外部改图缩略图刷新、chmod 后图标刷新、拖入子文件夹无闪动（见 checklist #10-12）。

### 重命名文件/文件夹触发全量刷新而非增量更新

**症状：** 默认自由布局下，重命名桌面上的文件或文件夹（F2 改名框或 Nautilus）会触发整桌全量刷新，所有图标销毁重建（闪动）。

**根因（DING_DEBUG 诊断日志确认，分两层）：**
1. GLib 对**同目录内重命名**不产生 MOVED_OUT/MOVED_IN 事件对，而是把 inotify 的 IN_MOVED_FROM/TO 合并为单个 `G_FILE_MONITOR_EVENT_RENAMED`，即使监视器带 `WATCH_MOVES` 也一样。`processIncrementalEvents` 的 switch **没有 RENAMED 分支** → 落入 `default:` → `scheduleFullRefresh()` → `[draw] rebuild N` 全部重建。日志证据：`[monitor] incremental batch=1` → `[monitor] unhandled event 8 -> full refresh` → `[update] FULL REFRESH reason=directory monitor`。此前基于 MOVED_OUT/MOVED_IN 事件对的增量 rename 路径（`handleFileRenamed`）从未被同目录重命名命中。
2. 补上 RENAMED 分支后实测发现：**GLib inotify 的 RENAMED 事件参数顺序与文档相反**（glib2 2.88.3 / Fedora 44 实测，两次重命名前后状态比对确认）——`file`=**旧**路径、`other_file`=**新**路径（文档称 other_file 是旧名）。按文档顺序传参会用新路径找旧 item → `Rename failed: ... not found in desktop list` → 仍走全量刷新。

**修复：** `app/desktop-monitor.js` `processIncrementalEvents` 补 `Gio.FileMonitorEvent.RENAMED` 分支 → `handleFileRenamed(event.otherFile, event.file)`（按实测顺序交换：file=旧、otherFile=新，与 `handleFileRenamed(newFile, oldFile)` 签名匹配）。RENAMED 单事件自带新旧两个路径，无需 pending 合并窗口，比 MOVED_OUT/MOVED_IN 配对路径更稳。

**附带：** 新增 11 处 DING_DEBUG 诊断日志（`[monitor]` 事件流 / `[update] FULL REFRESH reason` / `[draw] reuse|rebuild`，均带单调时钟 ms 时间戳），后续事件路由问题可直接定位。

**验证：** 修复后重命名预期日志链：`[monitor] incremental batch=1` → `[monitor] RENAME incremental old=... new=...`，无 `FULL REFRESH` / `[draw] rebuild`。`node --check` + `scripts/check.sh` 全绿（8 测试模块 + 结构检查）。注：keep-arranged/keep-stacked 开启时仍走全量刷新（刻意设计，布局全局）。

### 登录图标过渡动画（对标 upstream：延迟窗口 show 到首轮图标放置后）

**症状：** 登录后我们的桌面图标瞬间出现在对应位置；upstream DING（master 分支）的图标有"从屏幕中间底部飞到对应位置"的过渡。用户实测确认 gtk4-ding 也有类似效果（它的来源是 maximize→unmaximize hack，见下）。

**调查过程（investigate/login-fade 分支，逐一排除）：**
1. 代码对比：两边 shell 侧（emulateX11WindowType 逐字节一致）、窗口创建、stylesheet.css、启动时机全部无差异、无动画代码
2. gtk4-ding 的过渡 = `maximize() → map → unmaximize()` hack（高分辨率防挂起），mutter unmaximize 动画的副作用
3. 临时探测扩展（ding-map-probe，已删除）抓 window_manager 'map' 信号：**两边 map 状态完全一致**（type=NORMAL、texture=true、overview 已隐藏、t≈2.6s）——启动速度差异不成立
4. 探测 v2 追踪 opacity/scale：**两边 MAP 动画都完整播放**（opacity 0→255、scale 0.01→1.0 平滑曲线）——动画本身无差异
5. **结论：差异在动画期间窗口的内容**——GNOME Shell 的窗口 MAP 动画（windowManager.js `_mapWindow`：pivot(0.5,1.0) 底部中央 + scale 0.01 + opacity 0 → ease 250ms）两边都播放；但 **upstream 的窗口创建→map 间隔（~0.28s）恰好超过首轮枚举耗时，首帧已含图标**；**我们的间隔（~0.23s）差 50ms，首帧为空**，动画在空窗口上播放，图标在动画结束后才渲染 → "瞬间出现"。纯时序巧合。

**修复（c4e9f62）：** 把"时序巧合"变成确定性行为——**桌面模式下窗口延迟到首轮图标放置完成后再 show**：

| 文件 | 变更 |
|------|------|
| `app/desktop-grid.js` | 构造加 `deferShow` 参数；新增幂等 `showWindow()`；show 条件化 |
| `app/grid-layout.js` | `createGridWindows` 桌面模式传 `deferShow=true`（独立模式立即显示） |
| `app/desktop-manager.js` | `_drawDesktop` 图标放置完成后对每个 grid 调 `showWindow()` |

效果：合成器首帧必然包含图标 → shell MAP 动画动画化真实图标（底部中央放大 + 淡入），与 upstream 一致。

**验证：** 用户实测与 master 同款过渡；F5 刷新/图标放置/独立模式不受影响（showWindow 幂等，_drawDesktop 每次调用无害）。

**附：** 之前尝试的 windowActor opacity 淡入方案（ff478da，已回退 e5b54d9）失败原因：mutter 在窗口 map 序列的后续阶段会把 actor opacity 同步回 255，隐式动画被替换为瞬时完成——与本次结论一致（shell MAP 动画才是正确的动画载体）。

---

### Adw.Dialog 短暂触发新动态工作区（Ctrl+F 搜索框 + 压缩对话框）

**症状：** 打开 Ctrl+F 搜索对话框或压缩对话框时，GNOME Shell 顶栏短暂出现一个新的工作区（约 1 秒后消失）。设置面板（Adw.PreferencesWindow）和错误弹窗（Gtk.MessageDialog）无此现象。

**根因：** 两者都是裸的 modal `Adw.Dialog`（继承 **GtkWidget**——不是 GtkWindow！modal 是设计固有且无公开关闭方式）。对照：设置面板非 modal 无此问题；压缩对话框即使有 transient parent 仍复现——**触发因素是 modal 标志**（Wayland 下 xdg_toplevel.set_modal）。

**修复探索（最终结论：保留 Adw.Dialog，接受闪现）：**

| 方案 | 结果 |
|------|------|
| ① `windowHidePagerTaskbarModal` 尾空格 → T+D（置顶+stick 所有工作区） | 无闪现 ✓，但窗口被钉在所有工作区+置顶，UX 不符合预期，用户否决 |
| ② 构造传 `modal: false` | `Adw.Dialog` 无 modal 属性 → `No property modal on AdwDialog` |
| ③ `set_modal(false)` | Adw.Dialog 是 GtkWidget 非 GtkWindow → `set_modal is not a function` |
| ④ 改 `Gtk.Window` + `set_decorated(false)` | 工作正常但丢失 Adw 观感，用户要求保持 Adw |
| ⑤ 改 `Adw.Window` + `titlebar.pack_end` | Adw.Window 默认 titlebar 是内部 **AdwGizmo**（无 pack API）→ `topBar.pack_end is not a function` |
| ⑥ `Adw.Window` + `set_titlebar(Adw.HeaderBar)` | **`gtk_window_set_titlebar() is not supported for AdwWindow`**（g_error 崩溃重启） |
| ⑦ 回退 ①（裸 Adw.Dialog + 内部 Adw.HeaderBar） | **最终采用**——用户决定接受 ~1s 的新工作区闪现，保留 Adw 观感与 modal 行为 |

**最终状态（commit `6f4156d`）：** 两个对话框回到裸 `Adw.Dialog`（与 `88ae7a9` 一致）：内部 `Adw.HeaderBar`（show-title + 无窗口按钮）+ OK/Cancel；压缩框保留正确的 `present(this._grid._window)` parent；Esc 由 Adw.Dialog 自带（`can_close`）；删除实验期的 Gdk import 与自定义 Esc controller。

**验证：** eslint / node --check / 单测全绿。真机：Ctrl+F 与压缩对话框正常（可见 ~1s 新工作区闪现，可接受；如需消除可随时恢复方案①）。

### 压缩对话框崩溃（审计修复引入的回归：present 参数类型）

**症状：** 图标右键 → 压缩 → `Gjs-CRITICAL: TypeError: Object … is not a subclass of GObject_Object`，CompressDialog 构造失败。

**根因：** 2026-08-09 审计批次把 `this._dialog.present(this._grid.Window)` 按“属性名笔误”改为 `present(this._grid)`——但 `DesktopGrid` 是**纯 JS 类**（窗口在 `._window`，Gtk.ApplicationWindow），`Adw.Dialog.present()` 期望 GObject 参数 → GJS 抛 TypeError。原始代码的 `_grid.Window`（undefined → null）反而静默工作（无 transient parent）。

**修复：** `app/auto-ar.js` → `present(this._grid._window)`（正确的 GtkWidget）。教训：审计建议“应为 this._grid”是错的，同类 `findFiles(grid.Window)`（desktop-manager.js）也传 undefined parent，已一并核查。

**验证：** 右键压缩文件/文件夹 → 压缩对话框正常出现（不再抛错）；eslint / node --check / 单测全绿。

---

## 2026-08-09

### 软链接徽标对齐 Nautilus（右上角 + 16px 自然尺寸 + 半透明）

**症状：** 桌面图标上的软链接标志与 Nautilus 不一致：位置在图标左上角（Nautilus 在右上角），尺寸为图标尺寸的 1/3（64px 图标 → ~21px，把 Adwaita 16px 源图 FORCE_SIZE 放大导致偏糊），且全不透明（Nautilus 的 emblem 盒子带 `dim-label` 样式类 → GTK 默认主题 `opacity: 0.55`）。

**修复：** `app/desktop-icon-item.js` `_addEmblemsToIconIfNeeded()` 三处对齐：

| 项 | 改前 | 改后 |
|------|------|------|
| 位置 | 图标左上角 (0,0) | 右上角 `(iconWidth - emblemWidth, 0)` |
| 尺寸 | `icon_size / 3` + `FORCE_SIZE` | 固定 16px 自然尺寸（Nautilus GtkImage 默认），去掉 FORCE_SIZE |
| 透明度 | 1.0 | `push_opacity(0.75)`（Nautilus 的 `dim-label` 为 0.55，我们稍提亮保证压在图标上仍清晰） |

另加 `lookup_by_gicon` 返回 null 的防御（找不到 emblem 图标时直接返回原 paintable）。改动只在这一处，主题图标/缩略图/断链路径（`_createEmblemedIcon`、`_loadImageAsIcon`）全部经由它，自动生效。

**验证：** `node --input-type=module --check` 语法通过；`push_opacity` 确认在 GTK 4.22 typelib 中存在（GJS 调用验证 OK）；视觉效果待用户实测（构建由用户手动执行）。

---

### 全面代码审计修复批次（audit-fixes）

对全库做了三轮并行全文审计（核心/交互/Shell 侧），产出的分级清单（P0×4 / P1×8 / P2×9 / P3×29 / 文档一致性 9 项）已随修复推进删除（原 docs/archive/code-audit.md，部分条目已过时/有误，如 P1-8 的 deprecated API 判断经 mutter/gnome-shell 源码核实不成立）。本批实施 P0 全部 + P1 五项 + P2/P3 精选。环境假设：GNOME ≥ 50 纯 Wayland（用户确认），X11 相关代码视为死代码。

#### P0-2/P1-4：Nautilus 文件操作 platform_data 恒为空 + Wayland surface handle 泄漏

**症状：** 所有经 `RemoteFileOperationsManager` 的文件操作（移动/复制/重命名/回收站/永久删除/清空回收站/撤销/重做）发送的 platform_data 恒为空 dict——Nautilus 进度对话框永远不以桌面窗口为 parent；且每次操作 `export_handle` 一个 Wayland surface handle，从不 unexport。

**根因：** `platformData()` 是 async 函数（返回 `{data, freePlatformData}`），但 7 处调用点把 **Promise 对象本身** 传进 `_remoteCall`（GJS 把 Promise 静默组包成空 `a{sv}`）；`RenameURIRemote` 写 `await this.platformData().data`——Promise 无 `.data` 属性 → undefined。另：`parentWindow.get_surface()` 在 `if (parentWindow)` 判空**之前**执行，启动/关闭瞬间 `get_active_window()` 为 null 时 TypeError 使整条 Promise reject。

**修复：**

| 文件 | 变更 |
|------|------|
| `app/dbus-remote-operations.js` | 新增 `_remoteCallWithPlatformData()` 模板：`await this.platformData()` 后取 `.data` 传给 proxy 调用，D-Bus 回调中调 `freePlatformData()`（unexport handle）；8 个方法（Move/Copy/Rename/Trash/Delete/EmptyTrash/Undo/Redo）全部改用它；`get_surface()` 移入判空块内并 try/catch；`freePlatformData` 内部判空+容错 |
| `app/dbus-remote-operations.js` `LegacyRemoteFileOperationsManager.DeleteURIsRemote` | **顺带修复 P1-5：** 移除 fire-and-forget 的 `EmptyTrashRemote()`——历史 bug 导致 legacy 接口下每次“永久删除”都先清空整个回收站；现在直接走 `TrashFilesRemote` |

**验证：** `node --check` + eslint 通过；真机验证建议：Wayland 下操作文件后 Nautilus 进度框以桌面窗口为 parent；连续复制-粘贴 50 次观察 handle 不再增长。

#### P0-4：`doKillAllOldDesktopProcesses` 自 ESM 迁移起失效

**症状：** Shell 热重启（`killall -3 gnome-shell` / 崩溃自动重启 / 注销重登）后旧 DING 进程存活，与新进程争 `com.rastersoft.ding`（GtkApplication 无 REPLACE 标志）→ 新进程退出、1s 无限重启循环，桌面图标丢失直到手动 kill。

**根因：** shebang 为 `#!/usr/bin/env -S gjs --module`，`/proc/<pid>/cmdline` 实际是 `gjs --module <path>/ding.js -E -P ...`，而匹配条件是 `contents.startsWith("gjs <path>/ding.js")`——永远 false（实测：等价 shebang 脚本 `startsWith` 不匹配、`includes` 匹配）。

**修复：** `extension.js` `doKillAllOldDesktopProcesses` 改为 `contents.includes(<ding.js 路径>)` 匹配。

**验证：** 等价 shebang 实测（修复前 false / 修复后 true）；真机 `killall -3 gnome-shell` 或注销重登回归（注：GNOME ≥ 50 纯 Wayland 下 Alt+F2→r 已不可用）。

#### P0-1：新建文件夹后“自动改名”静默失效

**症状：** 右键新建文件夹/新建文档后不再自动弹出改名框。

**根因：** GTK4 移植时丢了 GTK3 的 `size-allocate` 触发链：`_checkForRename()` 唯一入口 `_doLabelSizeAllocated()` 全仓无调用点（desktop-icon-item.js:221 定义、file-item.js:281 override，无任何信号连接）。管道另一端完整（`doNewFolder` 设置 `newFolderDoRename`，`doRename` 完成清空），缺的只是触发器。

**修复（两轮演进）：**
- **第一轮（错误方案）：** `_createIconActor` 补 `notify::allocation` 连接——**无效**。GTK4 的 `Gtk.Widget` 没有 `allocation` GObject 属性（Python gi `list_properties` 验证：36 个属性中不存在；GTK3 的 `size-allocate` 是信号，GTK4 既无此信号也无属性通知），GJS 连接无效的 `notify::xxx` 静默接受但永不触发。DING_DEBUG 日志证实：`hook connected` 后无任何回调。
- **最终方案：** 改用 GTK4 真实存在的 **`realize` 信号**——label 加入 widget 树时必然触发一次，此时文件名与 `newFolderDoRename` 均已就绪（改名弹框不依赖布局尺寸；基类 `_calculateLabelRectangle` 记录的 labelwidth/labelheight 无活消费者，realize 时读 0 无害）。

**验证：** DING_DEBUG 日志链路完整：`newFolderDoRename=新建文件夹` → `label realized` → `checkForRename pending=新建文件夹 fileName=新建文件夹 match=true` → 弹框出现；改名完成后全量刷新 `pending=null`（不重复弹框）。

#### P0-3：Nautilus Scripts 子菜单被创建后丢弃，脚本功能整体失效

**症状：** `~/.local/share/nautilus/scripts/` 下的脚本永远不出现在图标右键菜单。

**根因：** 两个 bug：① `file-item-menu.js:247` `this._scriptsMonitor.createMenu()` 返回的 submenu **从未 `append_submenu`**（`added_element` 变量逻辑也因此失效）；② 即使 append，菜单项 action 硬编码 `app.create-template`（模板语义），脚本会被当模板处理。

**修复：**

| 文件 | 变更 |
|------|------|
| `app/templates-scripts-manager.js` | `_createTemplatesScriptsSubMenu` action 按 flags 区分：`ONLY_EXECUTABLE` → `app.create-script`，否则 `app.create-template` |
| `app/file-item-menu.js` | `_addActions` 注册 `create-script` action → `_onScriptClicked(路径)`；`_createMenu` 补 `section.append_submenu(_('Scripts'), submenu)` |
| `tests/test-scripts-menu.js` | 新增回归测试（8 断言）：脚本模式 action、模板模式 action、空列表 null、子目录递归 |
| `tests/run.js` | 注册新测试组 |

**验证：** TDD 先红后绿（修复前 `app.create-template` 断言失败）；`scripts/check.sh` 全绿。

#### P1-3：加密压缩密码框点 Cancel 永久泄漏进度元素 + LOGOUT|SUSPEND 抑制

**症状：** 提取加密 zip → 密码框 → 点 Cancel 后：进度窗口残留元素、`mainApp.inhibit` 永不释放（此后无法注销/休眠），直到进程退出。

**根因：** `doExtractFile` 的 finally 在 `_waitingForPassword` 时跳过 `_destroy()`，密码等待分支 `retval=false`（Cancel）后不清理。

**修复：** `app/auto-ar.js` Cancel 分支补 `this._destroy()`。

**验证：** 提取加密 zip → Cancel → 进度窗口元素移除、注销/休眠恢复。

#### P1-1：缩略图队列可永久停摆

**根因：** `save_thumbnail_async` 回调体无 try/catch——`save_thumbnail_finish` 抛错（磁盘满/缓存损坏）后 `_launchNewBuild()` 不再执行、`_running` 恒 true，后续所有 `getThumbnail` promise 永不 resolve、队列无限积压；另 `_resolveThumbnail` 返回 false（lookup 未命中）时 resolve 永不调用。

**修复：** `app/thumbnails.js` save 回调包 try/catch（CANCELLED → 超时已处理，直接 return；其他错误 → `resolve(null)` + `_launchNewBuild()`）；`_resolveThumbnail` false 分支补 `resolve(null)`。

**验证：** mock `save_thumbnail_finish` 抛错 → 队列继续处理后续文件。

#### P1-2：增量创建与全量刷新竞态可致重复图标

**根因：** `handleFileCreated` 直接 push 新 FileItem，无 URI 去重；CREATE 事件在 `_drawDesktop` 之后 flush（全量枚举已含该文件）时 → 同一文件两个图标重叠。

**修复：** `app/desktop-monitor.js` `handleFileCreated` 开头 `getFileItemFromURI(file.get_uri())` 命中则跳过（debug 日志记录）。

**验证：** F5 后 200ms 窗口内创建文件，不再出现重复图标。

#### P1-7：name_acquired 回调无 isEnabled 守卫

**根因：** disable() 在 D-Bus 名称获取窗口内执行时（快速 enable/disable、登出），回调仍会 `launchDesktop()` 拉起无人管理的新进程。

**修复：** `extension.js` name_acquired 回调开头 `if (!this.data.isEnabled) return;`。

**验证：** 反复快速 enable/disable 后 `pgrep -f ding.js` 无孤儿进程。

#### P1-6：gnome-shell-override 私有 API 覆写无防护

**根因：** 注入的 `WorkspaceBackground._init` 直接访问 `Main.overview._overview._controls._stateAdjustment` 等 Shell 私有路径；Shell 版本变动时异常会沿 Workspace 构造链上抛，可能破坏 Shell 启动渲染。

**修复：** `gnome-shell-override.js`：注入逻辑整体包 try/catch（失败静默降级为无动画）+ 可选链/特性检测（`!overviewAdjustment || !this._bgManager || !this._backgroundGroup` 直接 return）；`DesktopLayout.vfunc_allocate` 补 `monitor`/`frameRect` 空值守卫。

**验证：** 50/51 真机 Overview 淡入淡出回归（动画正常 = 注入路径无异常）。

#### 纯 Wayland 环境清理：X11 残留死代码整组删除

| 位置 | 变更 |
|------|------|
| `app/desktop-manager.js` | 删 `using_X11` 字段与 `_initX11Check` X11 分支（每次启动白写 `check-x11wayland` dconf 的 else 分支一并消失）；`mainApp.hold()` 保活逻辑保留并更名 `_initDesktopHold` |
| `app/notify-x11-under-wayland.js` | **文件删除**（含 2 条翻译） |
| `schemas/org.gnome.shell.extensions.ding.gschema.xml` | 删 `check-x11wayland` key |
| `app/meson.build`、`po/POTFILES.in` | 同步移除条目 |
| `extension.js` | 过时注释更新（GNOME ≥ 50 纯 Wayland，重启方式为 `killall -3 gnome-shell` / 注销重登） |

**验证：** `glib-compile-schemas --strict` 通过；meson 清单与磁盘一致；check.sh 全绿。

#### 翻译补包 + 杂项清理

| 位置 | 变更 |
|------|------|
| `app/desktop-icons-util.js:135` | 'No Terminal' 错误弹窗两条字符串补 `_()` |
| `app/auto-ar.js:41` | 进度窗口标题 'Archives Operations' 补 `_()` |
| `app/desktop-manager.js` | `findFiles` 入口守卫：已有查找窗口先关闭（防连按 Ctrl+F 双窗口/信号泄漏/关错窗口，P2-1）；`doNewFolder` catch 两相同分支合并 |
| `app/file-item-menu.js` | `_getExtractable()` 首迭代 return → `.every()` 全量检查 |
| `app/ask-rename-popup.js:63` | `clamp(fileItem.displayName, …)` 字符串恒 NaN → `.length` |
| `app/menu-helper.js`、`app/stack-item.js`、`app/file-operations.js` | 删三处死 gettext 定义（`const _ = Gettext.domain('ding').gettext` 零调用） |
| `app/sort-manager.js` | 两处冗余条件分支简化（if/else 同 continue；恒真 `!_isSpecial`） |
| `app/desktop-grid.js` | 构造函数删重复 `setGridStatus()`（resizeGrid 已做）；删死方法 `updateGridDescription`（字段由构造函数设置） |
| `app/desktop-menu.js:161` | `GLib.getenv('XDG_CURRENT_DESKTOP')` 可能 null → `?? ''` |

**验证：** `scripts/check.sh` 全绿（eslint 零违规 / node --check / 8 测试组 69 断言 / 结构检查）；`glib-compile-schemas --strict` 通过；meson 清单一致。构建由用户执行。

**影响范围：** 桌面图标右键菜单新增 Scripts 子菜单（脚本功能恢复）；新建文件夹改名框恢复；Nautilus 文件操作进度框现在以桌面窗口为 parent；X11Wayland 提示弹窗移除（纯 Wayland 环境不再需要）。无新增安装文件（删除 notify-x11-under-wayland.js 已同步 meson）。

### 图标右键菜单无法关闭（对标 Nautilus 修复，NESTED flag 残留）

**症状：** 图标右键菜单打开 Scripts 子菜单后，关闭子菜单再点击外部，整个菜单无法关闭（此前图标菜单无子菜单项所以未暴露；P0-3 恢复 Scripts 子菜单后暴露）。

**根因：** `file-item-menu.js` 的 `showMenu` 仍用 `Gtk.PopoverMenu.new_from_model_full(menu, Gtk.PopoverMenuFlags.NESTED)`——NESTED 让子菜单在主 popover 内嵌切换显示，子菜单关闭时 grab 未能恢复给父 popover，auto-hide 失效。这与 2026-07-21 桌面菜单修复的是同一根因：当时只修了桌面菜单（`new_from_model`），图标菜单漏修。

**修复（对标 Nautilus `nautilus-files-view.c pop_up_selection_context_menu`）：**

| 变更 | 说明 |
|------|------|
| `new_from_model_full(..., NESTED)` → `new_from_model(menu)` | 子菜单改为独立 popover 弹出，grab 管理恢复正常 |
| 补 `set_has_arrow(false)` + `set_halign(Gtk.Align.START)` | 与桌面菜单/Nautilus 一致：无箭头、菜单在鼠标右侧 |
| 补 `set_pointing_to({x, y, 0, 0})` | 指向鼠标位置（Nautilus 同款 0 尺寸 rect）；键盘路径（null/true 占位）回退到图标左上角 |
| 补 `closed` → `grab_focus()` | Nautilus workaround：popover 关闭后强制夺回焦点，键盘导航恢复（聚焦图标所在 grid 容器） |
| `_lastMenu` unparent 后置 null | 与桌面菜单一致 |

**验证：** eslint / node --check / 单测全绿。真机回归：图标右键 → 打开 Scripts 子菜单 → 关闭 → 点击外部菜单关闭；多级子菜单（脚本子目录）同样验证。

---

## 2026-08-08

### 修复：软链接标志（show-link-emblem）开关无效

**症状：** 设置面板开启「为软链接添加标志」（`show-link-emblem`，默认 true）后，桌面上的有效软链接仍不显示箭头标志；只有损坏软链接有 unreadable 标志。

**根因：** `FileItem._getEmblem()`（`app/file-item.js`）读取 `Prefs.showLinkEmblem`，但 `app/preferences.js` **没有导出**该变量（全仓唯一一处引用，其余所有 `Prefs.*` 均能解析到真实导出）。ES module namespace 访问缺失属性返回 `undefined`（falsy），有效软链接永远走不进 `_getEmblem()` 的分支 → 返回 `null`，不画标志，与设置值无关。正确值维护在 `DesktopManager` 实例上（`desktop-manager.js:206` 构造时读 gsettings，`:263-266` 设置变更时更新并 `_updateDesktopSafe` 重建图标，该链路已就绪）。代码库约定也印证：同类设置 `showDropPlace`/`darkText` 的消费者均读 `this._desktopManager.*`，此处是唯一例外。

**修复：**

| 文件 | 变更 |
|------|------|
| `app/file-item.js` | `_getEmblem()` 改用 `this._desktopManager.showLinkEmblem`（一行） |
| `tests/test-link-emblem.js` | 新增回归测试（修复前场景 A 失败）：开启+有效软链接 → `emblem-symbolic-link`；关闭 → null；损坏软链接 → 始终 `emblem-unreadable` |
| `tests/run.js` | 注册新测试组 |

**验证：** TDD 先红后绿——测试先跑出 `valid symlink with show-link-emblem ON gets the link emblem — expected "emblem-symbolic-link", got null`，应用一行修复后通过；`scripts/check.sh` 全部通过（eslint / node --check / gjs 单测 / 结构检查）。构建由用户执行。

**影响范围：** 桌面软链接图标标志——默认开启时有效软链接首次可见箭头标志；运行时切换开关经现有 `show-link-emblem` 分支实时生效；损坏软链接行为不变。无新安装文件 → meson.build 不变。

---

## 2026-08-05

### 强调色改为直接解析用户 gtk.css（跟随 Chromaleon 等用户级覆盖）

**症状：** 安装 Chromaleon（按壁纸生成自定义强调色）后，nautilus、gnome-shell 均跟随自定义色，但 DING 的选中框/橡皮筋/拖放预览仍用系统设置里的 9 种预设强调色。

**根因：** 两条互不相通的强调色通道。Chromaleon 把自定义色写进 `~/.config/gtk-4.0/custom-accent.css`（`@define-color accent_bg_color <hex>`），经用户级 `gtk.css` `@import` 以 USER 优先级（800）覆盖 libadwaita 主题（200）的命名色——nautilus 的 `var(--accent-bg-color)` 由 `@accent_bg_color` 派生，故跟随。而 `org.gnome.desktop.interface accent-color` 是 enum（只能存 9 预设），portal `org.freedesktop.appearance AccentColor` 是另一条通道，Chromaleon 从不修改；DING 此前优先 `get_system_supports_accent_colors()` + `get_accent_color_rgba()` 读这条通道 → 永远拿到预设色。

**修复（两轮演进，最终方案）：**

- **第一轮：** `lookup_color('accent_bg_color')` 优先。实测发现实时跟随不可靠：GTK **不监视** @import 文件，只有主题/高对比度重载才重读用户 CSS；Chromaleon 靠切换 high-contrast 强制重载（GTK 4.22 触发属性是 `gtk-interface-contrast`，不是 `gtk-theme-name`），但该重载与 Chromaleon 的异步写文件存在**时序竞态**，且失败重读会**保留旧解析结果**（gnome-colors 模式下实测卡在旧自定义色）。
- **最终方案：直接解析文件，不再依赖 GTK 解析缓存。** `_readUserAccentOverride()` 读取 `~/.config/gtk-4.0/gtk.css` 及其 `@import` 链（剥注释后取最后一个 `@define-color accent_bg_color`，`Gdk.RGBA.parse` 校验）；`configureSelectionColor()` 优先级：① 用户覆盖（文件里有定义）→ ② `get_accent_color_rgba()`（portal 预设，覆盖 Chromaleon 的 GNOME Colors 模式 / Chromaleon 关闭 / 纯系统）→ ③ `lookup_color('accent_bg_color')`（旧系统）→ ④ 默认蓝。实时更新改为 **GFileMonitor 监视 `~/.config/gtk-4.0/` 目录**（Chromaleon 每次改色必然重写文件，这是它唯一确定的行为；300ms 防抖吸收 temp+rename 多事件）+ Adw `notify` 无条件连接（设置换预设）。**删除** `gtk-interface-contrast` / `gtk-theme-name` 钩子。

| 文件 | 变更 |
|------|------|
| `app/theme-manager.js` | 新增 `_readUserAccentOverride()`（gtk.css + @import 链解析）；`configureSelectionColor()` 四级回退；Adw notify 无条件连接 + `~/.config/gtk-4.0/` 目录 GFileMonitor（300ms 防抖）；`disconnect()` 清理信号/监视器/定时器/provider |

**验证（直接 import 真实 ThemeManager 的探测进程，全场景）：** ① 自定义模式下启动 = 自定义色；② 自定义色切换 → ~0.3s 跟随新色；③ 开启 GNOME Colors → 变为预设色（**此前卡死的场景**）；④ GNOME Colors 模式下切预设（teal→red→pink）→ 依次跟随；⑤ 关闭 GNOME Colors → 回到自定义色。`scripts/check.sh` 全部通过。构建由用户执行。

**影响范围：** 桌面选中框（`.desktop-icons-selected` CSS 类）、橡皮筋/拖放预览（`paint-container.js` 用 `dm.selectColor`）。无新文件 → meson.build 不变。已知限制：监视器只覆盖 `~/.config/gtk-4.0/` 目录内文件（Chromaleon 的产物都在其中）；若该目录不存在则跳过监视（初始读取仍正确）。

**影响范围：** 桌面选中框（`.desktop-icons-selected` CSS 类）、橡皮筋/拖放预览（`paint-container.js` 用 `dm.selectColor`）。无新文件 → meson.build 不变。

---

### 新增开关：是否用强调色绘制选中框/橡皮筋/拖放预览

**需求：** 提供 `use-accent-color` 设置（默认开）。关闭时像 Nautilus 一样**不用强调色**（Nautilus 的列表/网格视图把 `--accent-bg-color` 覆盖成 `#959595` 灰色），开启时用强调色（预设或 Chromaleon 等用户级覆盖）。

**实现：**

| 文件 | 变更 |
|------|------|
| `schemas/org.gnome.shell.extensions.ding.gschema.xml` | 新增 `use-accent-color`（boolean，默认 true） |
| `app/theme-manager.js` | `configureSelectionColor()` 开头分支：关闭时 `selectColor` 直接置为 `#959595` 灰，不经过强调色解析链 |
| `app/prefs-window.js` | Desktop icons 组新增开关“Use the accent color for selection” |
| `app/desktop-manager.js` | `_onDesktopSettingsChanged` 新增 `case 'use-accent-color'`：重新 `configureSelectionColor()` + 所有 desktop `queue_draw()`（实时生效） |

**验证：** 真实 ThemeManager 探测：关闭 → `rgb(149,149,149)`（#959595），开启 → `rgb(60,108,132)`（#3c6c84 自定义色），settings changed 实时切换生效。`glib-compile-schemas --strict` 通过；`scripts/check.sh` 全部通过。构建由用户执行。

---

### 选中/橡皮筋/hover 颜色与 Nautilus 对齐（libadwaita 同款公式）

**需求：** 开关关闭（灰）时，选中框、hover 框、橡皮筋的颜色与 Nautilus 一致；开启（强调色）时同样对齐。

**现状差异：** DING 用 `selectColor`（强调色或灰）自定透明度：选中 bg 50%、hover 硬编码 `rgba(238,238,238,0.2)`、橡皮筋 fill 30%+border 100%；Nautilus（libadwaita）用：`gridview > child:selected` = accent-bg **25%**、hover = `currentColor 4%`、rubberband = border 1px `--accent-color` + bg 20%——其中 `--accent-color` 是**派生色** `oklab(from accent-bg min(l,0.5) a b)`（暗色模式 `max(l,0.85)`），不是 accent-bg 本身。

**实现：**

| 文件 | 变更 |
|------|------|
| `app/theme-manager.js` | 注入 CSS 增加 `desktop_icons_accent_color`（oklab 派生色，变体由 JS 按 `color-scheme` 选 min/max——不用 @media，因为 GTK 对分离 widget 的媒体查询恒解析为浅色变体）；provider 加载后 `lookup_color` 解析回 `this.accentColor` 供 cairo 用 |
| `app/desktop-manager.js` | 新增 `accentColor` getter；`color-scheme` 变更时额外重算 `configureSelectionColor()` + `queue_draw()`（派生色变体随明暗切换） |
| `app/paint-container.js` | 橡皮筋改用派生色：fill 20% + border 100%（原 fill 30%）；圆角 5→6（Nautilus 值）；缓存键加入 accentColor |
| `app/stylesheet.css` | 选中 bg 50%→**25%**；键盘选中环改 `alpha(@desktop_icons_accent_color, 0.5)`（原 bg 色 80%）；hover 改 `color-mix(in srgb, currentColor 4%, transparent)`（原硬编码浅灰 20%） |

**验证（真实 ThemeManager + GTK oklab 引擎探测）：** 暗色模式灰 `#959595` → 派生色 `rgb(206,206,206)`；暗色模式自定义 `#3c6c84` → 派生色 `rgb(163,214,241)`（浅蓝）；浅色变体 `min(l,0.5)` 亦正确（灰 → `rgb(99,99,99)`）；stylesheet.css 含 `color-mix`/`alpha(@color)` 解析无错。`scripts/check.sh` 全部通过。构建由用户执行。

**壁纸可读性优化（与 Nautilus 纯色背景的差异）：** 颜色公式与 Nautilus 一致，但透明度按壁纸场景加码（Nautilus 的 25%/4%/20% 在纯色视图背景上成立，壁纸上会被吞）：选中 bg 25%→**35%**、hover 4%→**10%**、橡皮筋填充 20%→**25%** + 边框 1px→**2px**、键盘选中环 50%→**70%**（保留 3px 宽）、拖放预览边框 0.5px→**1px**。两种模式（灰/强调色）统一生效。

**hover 改为与明暗无关的中性叠加（icookie 需求）：** 原 hover 用 `color-mix(currentColor 10%)`——`currentColor` 随主题前景色翻转（暗=白/浅=黑），壁纸不随明暗变化时可见性会在同一张壁纸上翻转。改为 `color-mix(in srgb, white 12%, black 12%)`（GTK 实测解析为 `rgba(128,128,128,0.24)`，符合 CSS 规范：白 12% + 黑 12% + 透明 76%）：白分量在暗壁纸显形、黑分量在亮壁纸显形，任何主题/壁纸组合下稳定可见。

**派生色明暗跟随改为可选（icookie 需求）：** libadwaita 的派生色随配色方案切换（浅色 `min(l,0.5)` 深色变体 / 深色 `max(l,0.85)` 亮色变体）——这在 Nautilus 的黑白纯色背景上合理，但桌面**壁纸不随明暗切换**，故新增 `accent-shade-follow-color-scheme`（默认 **false**）：关闭时始终用较亮的深色模式变体（壁纸场景可读性最优）；开启时跟随配色方案（与 Nautilus 一致）。开关实时生效（`_onDesktopSettingsChanged` 与 `use-accent-color` 合并处理）；`color-scheme` 变更仍会重算派生色（跟随模式需要）。验证：真实 ThemeManager 探测——follow=false 时 dark 下 pink→`rgb(255,160,216)`（亮变体）；切 follow=true（dark）仍为亮变体；切 use-accent-color=false 灰→`rgb(206,206,206)`。

---

## 2026-08-04

### 多屏粘贴/新建文件夹落到主屏同位置网格（右键局部坐标被当全局坐标）

**症状：** 双屏（A 左 B 右）下，在 B 屏右键“粘贴”复制的文件，图标出现在 **A 屏与鼠标同位置**的网格，而不是 B 屏鼠标下方；右键“新建文件夹”“新建文档”同样错屏。

**根因：** 坐标空间不一致。右键手势回调（`app/desktop-grid.js`）把**容器局部坐标**直接传给 `onPressRightButton`（左键与拖放路径都会先 `coordinatesLocalToGlobal` 转换——左键是 2022 年补的，右键因 Popover 需要局部坐标而一直未转），存入 `_clickX/_clickY`。而粘贴/新建文件夹/模板路径把 `_clickX/_clickY` 写成 `metadata::nautilus-drop-position`，落位时（`desktop-manager.js` `_addFilesToDesktop`/`_addSingleFileToDesktop` → `getDistance()` → `gridGlobalRectangle.intersect()`）按**全局屏幕坐标**解释。B 屏局部 (300,200) 被当作全局 (300,200)，落在 A 屏矩形内 → 图标放到 A 屏同位置网格。单屏（窗口在原点、边距为 0）时局部≈全局，故一直未暴露；`dcbef19`（粘贴定位功能）引入消费后才变成可见症状。

**修复：** 右键手势回调与左键对称，转换出全局坐标后一并传入；`onPressRightButton` 存全局进 `_clickX/_clickY`，局部坐标仍只用于菜单 Popover 定位。

| 文件 | 变更 |
|------|------|
| `app/desktop-grid.js` | 右键回调 `coordinatesLocalToGlobal` 后传 `(x, y, gx, gy, container)` |
| `app/desktop-manager.js` | `onPressRightButton` 新签名：`_pressedMouseButton(gx, gy)`，`showDesktopMenu(x, y, grid)` 保持局部 |
| `tests/test-click-coordinates.js` | 新增回归测试：右键存全局/菜单收局部、左键存全局、浮点取整 |

**验证：** `gjs --module tests/run.js` 全绿（新增 11 断言）；`scripts/check.sh` 全部通过。

**影响范围：** 菜单粘贴、右键新建文件夹（`file-operations.js`）、右键新建文档/模板（`desktop-menu.js` `_newDocument`）、Ctrl+V 键盘粘贴（最后一次按压为右键时）。

---

### 移除 Nemo 支持（设置项 + 代码 + schema）

**决定：** 桌面图标扩展自身不需要 Nemo——打开文件夹/"在文件管理器中显示"应始终走系统默认应用（Nautilus）。移除 upstream 的 `use-nemo` 开关，减少维护面。

| 位置 | 变更 |
|------|------|
| `app/prefs-window.js` | 删除设置面板 "Use Nemo to open folders" 开关行 |
| `app/desktop-manager.js` | 删除 `this.useNemo` 读取与 `_onDesktopSettingsChanged` 的 `case 'use-nemo'` |
| `app/file-item.js` `_doOpenContext` | 删除目录打开时的 Nemo 分支（回退 trySpawn + 错误日志），目录一律走 `launch_default_for_uri_async` |
| `app/file-item-menu.js` `_onShowInFilesClicked` | 删除 Nemo 分支，直接 `ShowItemsRemote` |
| `schemas/org.gnome.shell.extensions.ding.gschema.xml` | 删除 `use-nemo` key（已存在的旧 dconf 值成为 orphan，无害） |

**行为变化：** 之前开启该开关的用户打开文件夹/“在文件管理器中显示”会启动 Nemo，现在统一使用系统默认文件管理器。

**验证：** `glib-compile-schemas --strict` 通过；`gjs --module tests/run.js` 全部通过（131 断言）；`npx eslint app/` 无错误。po 翻译条目未手动清理（下次 xgettext 提取自动变 obsolete）。

---

### 模板/脚本枚举泄漏 + localeCompare 参数位 + 死代码清理

| 问题 | 位置 | 修复 |
|------|------|------|
| 目录枚举句柄泄漏（所有路径） | `app/templates-scripts-manager.js` `_readDirectory` | 成功路径与 `_entriesFolderChanged` 早退路径均补 `fileEnum.close(null)`（原每次模板/脚本文件夹变更都泄漏句柄，与 2026-08-04 desktop-manager 修复同类） |
| localeCompare options 参数位错误 | `app/templates-scripts-manager.js` `_readDirectory` sort | options 误传第 2 参（locales 位）被静默忽略 + `numeric: 'true'` 为字符串 → 移第 3 参 + `numeric: true` + 去掉 `localeMatcher: 'lookup'`（与 2026-08-02 sort-manager 修复同一模式）。修复后模板/脚本子菜单为大小写不敏感 + 数字自然排序 |
| 超时后缩略图重复工作 | `app/thumbnails.js` `_createThumbnailAsync` | 超时 handler 已调 `_createFailedThumbnailAsync` 并 cancel；generate 回调以 CANCELLED 到达时 catch 再执行一次 → catch 中检测 `CANCELLED` 直接 return |
| 死枚举 | `app/enums.js` | 删除零使用的 `Selection.LEAVE`、`FileExistOperation`、`WhatToDoWithExecutable` |
| 死字段 | `app/file-item.js` | 删除只赋值不读取的 `_monitorTrashId` |
| 重复调用 | `app/desktop-grid.js` | 构造函数 `set_size_request`/`set_default_size` 各调用两次 → 各一次 |
| 空方法 + 调用点 | `app/file-item-menu.js`、`app/desktop-monitor.js`、`app/desktop-manager.js` | 删除空实现 `refreshedIcons()` 及其 4 处调用 |
| 多余空行 | `app/desktop-manager.js` | 清理 `updateFileList`/`_addSingleFileToDesktop` 前的连续空行 |

**验证：** `gjs --module tests/run.js` 全部通过（131 断言）；`npx eslint app/` 无错误。

---

### 提取失败通知静默失效 + 3 处代码清理

| 问题 | 位置 | 修复 |
|------|------|------|
| 提取失败通知不显示（真实 bug） | `app/file-item-menu.js:541,567` | `this._desktopManager.DBusManager.doNotify()` 误用类名（GJS 静默吞 TypeError），改为实例字段 `dbusManager`。影响："无法创建提取文件夹"（提取到新文件夹失败时）和"无法选择提取目录"（FileChooser 无选中目录时）的通知从未弹出 |
| 按位或异味 | `app/desktop-icon-item.js:579` | `loadedImage \| this._destroyed` → `\|\|`（`loadedImage` 可为 `undefined`，按位或依赖隐式转换） |
| 冗余分支 | `app/file-operations.js:198-200` | `doNewFolder` catch 块 `if (position \|\| suggestedName) return null; return null;` 两个分支相同，简化为一个 `return null` |
| accels 前缀不一致 | `app/menu-helper.js:69,82` | `set_accels_for_action(name, ...)` 缺 `"app."` 前缀（与 `_addNewAction` 不一致），统一补上 |

**验证：** `gjs --module tests/run.js` 全部通过（131 断言）；`npx eslint` 无新增错误。

---

### 性能优化：O(n²) 算法改 Map/Set 索引 + 低风险清理（不新增功能）

对照 `docs/memory-leak-analysis.md` 中遗留的未修复项，实施 3 个 O(n²) 算法优化与 4 个低风险清理。所有改动均为内部实现，不改变任何用户可见行为、D-Bus 接口或设置项。

**说明：** 本次完成后 `docs/memory-leak-analysis.md` 已删除（内容过时——多数问题早已修复，剩余项为进程级低影响），修复历史统一由本文档承载。

| 优化 | 位置 | 改动 |
|------|------|------|
| 堆叠排序 O(n²)→O(n) | `app/sort-manager.js` `_sortAllFilesFromGridsByKindStacked` | 4 处 `otherFiles`×`stackedFiles` 嵌套扫描改为 `Set`/`Map` 索引：`seenTypes` 判首见、`firstStackedByType` 取首匹配（保持 break 语义）、`stackedTypes` 判 stackUnique、`unstackSet`+`unstackedByType` 预分组 unstack 展开（保持 stackedFiles 顺序） |
| 坐标恢复 O(n²)→O(n) | `app/sort-manager.js` `_restoreStackInitialCoordinates` | `Map<fileName, coords>` 替代嵌套 forEach（后者覆盖前者 = 原"最后匹配生效"语义）；附带消除每次匹配都触发的同步 `set_attributes_from_info()` 写盘 |
| `getDistance` 空位判断 O(单元格)→O(1) | `app/desktop-grid.js` | 新增 `_occupiedCount` 占用计数，`_setGridUse` 维护，`setGridStatus` 归零；满格判断不再全量扫描 `_gridStatus`（4K 屏 ~8000 单元格） |
| fileEnum 早退泄漏 | `app/desktop-manager.js` `_doReadAsync` | `_desktopFilesChanged && !_forceDraw` 提前 return 分支补 `fileEnum.close(null)`（原漏关，每次全量刷新泄漏一个目录枚举句柄） |
| 字符串拼接 | `app/desktop-icon-item.js` `_setLabelName` | 逐字符 `+=` 改为数组 `push` + `join('')` |
| map 滥用 | `app/auto-ar.js` | 压缩对话框每次按键 `map().includes()` → `some()`（短路、无中间数组） |
| RGBA 每帧分配 | `app/paint-container.js` `vfunc_snapshot` | 拖拽/橡皮筋绘制每帧新建 4 个 `Gdk.RGBA` → 缓存 + `selectColor` 引用比较（主题切换时 `ThemeManager` 替换对象才重建） |

**等价性保证：** stack top 首次出现顺序、unstack 展开顺序、`determineStackTopSizeOrTime` 首匹配语义均与原实现一致；`firstStackedByType` 在 stackedFiles 排序之后构建（与旧 `break` 时机相同）。

**验证：** `gjs --module tests/run.js` 全部通过（131 断言）；`npx eslint` 无新增错误。

---

### 全面优化审计：死代码清理 + enable/disable 泄漏修复 + 落位去重 + 性能优化（optimization-audit 分支）

对全部 37 个 app 模块 + Shell 侧入口的深入审计（约 11K 行全文阅读 + 模式扫描）。总体结论：生命周期管理（`_trackSignal`/cancellable 取消）与异常处理已成体系；发现的问题集中在死代码、全局单例信号泄漏与未落地的性能优化。

**死代码清理（-86 行）：**

| 位置 | 说明 |
|------|------|
| `app/dnd-clipboard-utils.js` `makeFileListFromSelection` | 全库无调用 |
| `app/preferences.js` `setSortOrder` | 7 个 `Prefs.*` 引用方均未调用 |
| `app/file-operations.js` `doNewFolder` | 重复实现（所有调用点都走 `DesktopManager.doNewFolder`），有行为漂移风险 |
| `app/desktop-manager.js` `_getSortManager` | 无调用 |

**enable/disable 循环泄漏修复（3 处 + 防御）：** 均为「全局单例对象上连接信号、闭包持有 DesktopManager、`destroy()` 不断开」模式，每次扩展重新启用累积监听器 + 旧对象。

| 位置 | 修复 |
|------|------|
| `app/desktop-menu.js` `Gdk.Clipboard 'changed'` | 保存连接 id + `disconnectSignals()`，`destroy()` 调用 |
| `app/theme-manager.js` `Adw.StyleManager 'notify'` + 选择色 CssProvider | 新增 `disconnect()`：断信号 + `remove_provider_for_display` |
| `app/desktop-manager.js` `_initStyles` stylesheet CssProvider | 保存 `_cssProvider`，`destroy()` 中移除 |
| `app/desktop-manager.js` 键盘搜索超时 | `destroy()` 中 `source_remove`（防御：回调会触碰已销毁状态） |

**可维护性重构（行为等价，+117/-174）：**

| 位置 | 变更 |
|------|------|
| `app/sort-manager.js` 4 个 corner 排序分支（~40 行） | 参数化 `_positionComparator(cornerInversion)`（~10 行）；新增 4 条 corner 断言锁定行为 |
| `app/desktop-manager.js` `_addFilesToDesktop`/`_addSingleFileToDesktop` | 提取 `_getFallbackPosition()`（主屏回退坐标，原重复 3 次）与 `_findDesktopFor(x, y, {nearest, exactOnly})`（落位循环去重） |
| 3 处有意空 catch | 补注释说明为何可忽略（`_initPremultipliedCheck`、`clearFileCoordinates`、`desktop-monitor` 清旧位置元数据） |

**性能优化：**

| 优化 | 说明 |
|------|------|
| 图标对象复用（收益最大） | 文件集合不变的全量刷新（设置/mount 变化、F5）不再销毁重建全部 widget：按 URI 集合匹配新旧列表，原地更新 metadata + 缩略图（走缓存）+ dark-text class；集合变化时保持原重建路径。label 暗色 class 提取为 `_applyDarkTextClass()` |
| `mount-removed` 延迟 500ms | 避免 FUSE 卸载竞态 + 合并移除事件突发（`MOUNT_REMOVED_DELAY_MS`，destroy 清理） |
| ~~并行枚举~~（评估后不做） | GIO 同步查询在单线程 JS 上无法并行；异步化 FileItem 构造改动过大，page cache 下同步查询已很快 |

**验证：** `scripts/check.sh` 全绿（8 测试模块，SortManager 30→34 断言）；行为等价改动由现有坐标/粘贴/排序测试锁定。需手动回归：双屏右键粘贴落位、扩展 enable/disable 10 次无内存增长、keep-stacked 下排序、图标属性变化刷新不闪动。

**回归（2026-08-04 晚，用户实测发现）：** 右键菜单“排列图标”报 `this._sortManager.sortAllFilesFromGridsByPosition is not a function`——P2 提取 `_positionComparator` 时误将 `sortAllFilesFromGridsByPosition` 入口方法整体删除（测试只覆盖了 comparator，未覆盖入口）。修复：补回入口方法（可选 `cornerInversion` 参数供测试注入，生产调用不传时行为不变）+ 新增端到端断言（35→35 断言，含 keepArranged 短路与 removeFromGrid/reassign 调用计数）。教训：提取纯函数时必须保留入口方法并补端到端测试。

**回归 2（2026-08-04，双屏 DING_DEBUG 实测）：** 新建文件夹/新建文档落位竞态，两个根因：

| 根因 | 证据 | 修复 |
|------|------|------|
| **gvfs-metadata 异步写读竞态**：`_newDocument`/`doNewFolder` 同步写 `metadata::nautilus-drop-position`，但 metadata daemon 异步落盘，文件创建事件先到 → `[file] created ... drop=[null]` → FALLBACK 主屏角落 | 日志：`[click] template at=(746,325)` 后 `drop=[null]` + `FALLBACK` | 与粘贴路径同机制补 `_pendingDropFiles` basename 兑底（`applyDropCoordinates` 模糊匹配已覆盖） |
| **残留 `nautilus-icon-position` 抢位**：`_addSingleFileToDesktop` 先查 saved 再查 drop，残留坐标（日志中为新文件带 B 屏 cell 局部坐标 386,407）把新图标拉到另一屏 | 日志：`saved=[386,407] drop=[null]` → `grid#0 add`（A 屏） | drop（明确用户意图）优先于 saved；saved 仅作无 drop 时的历史位置（cut+paste 保留位置、全量刷新不受影响） |

**验证：** 双屏日志确认：修复前 B 屏新建模板 drop=[null]→FALLBACK 或残留 saved 拉回 A 屏；修复后 drop 经 `_pendingDropFiles` 注入且优先，落到鼠标所在屏网格。`scripts/check.sh` 全绿。

---

## 2026-08-02 (Maintainability Refactor)

### 缩略图超时回调引用未定义变量 `reject`（bugs#2 未真正修复）

**症状：** 缩略图生成超时时，`_launchNewBuild` 的 timeout 回调调用 `_createFailedThumbnailAsync(file, modifiedTime, resolve, reject)`，`reject` 从未声明 → `ReferenceError`，后续缩略图任务受影响。

**根因：** 之前的修复只删除了函数签名中的 `reject` 参数，未删除调用点的实参。

**修复：** 调用点改为 `this._createFailedThumbnailAsync(file, modifiedTime, resolve)`（ESLint `no-undef` 发现）。

| 文件 | 变更 |
|------|------|
| `app/thumbnails.js:110` | 删除多余 `reject` 实参 |

**提交：** `9ff3873`

### FileOperations 缺少 gettext `_` 定义

**症状：** 新建文件夹/文件夹创建失败提示路径会抛 `ReferenceError: _ is not defined`。

**根因：** `FileOperations` 从 `desktop-manager.js` 抽取时未带上 `Gettext` import，`_('New Folder')` 等 3 处调用无定义。

**修复：** 补充标准 gettext 引入块（ESLint `no-undef` 发现）。

| 文件 | 变更 |
|------|------|
| `app/file-operations.js` | 新增 `Gettext`/`_` 定义 |

**提交：** `9ff3873`

### 文本拖放文件名清洗正则失效（`\x00-\x1f` 控制字符范围）

**症状：** 拖文本到桌面生成的文件名被错误清洗：数字 0/1、字母 x/f、连字符全部被替换为 `-`（"2026 report.txt" → "---- report.t-t"），而真正的控制字符（U+0000–U+001F）未被匹配。

**根因：** `generateDropFilename` 的正则 `/[<>:"\\\/|?*\x00-\x1f]/g` 中 `\x00-\x1f` 误写成 `\\x00-\\x1f`（双反斜杠），字符类退化为匹配字面量 `\`、`x`、`0`、`1`、`f`、`-`。

**修复：** 去掉多余反斜杠，恢复控制字符范围语义。修复后数字/字母保留、控制字符被替换。

| 文件 | 变更 |
|------|------|
| `app/desktop-icons-util.js:330` | 正则 `\\x00-\\x1f` → `\x00-\x1f` |

**测试：** `tests/test-drop-filename.js` 锁定行为（8 个用例）。

### SortManager localeCompare 选项被静默忽略（已修复）

**发现：** `_sortByName`/`_sortByKindByName` 中 `localeCompare(b, {sensitivity:'accent', numeric:'true', ...})` 把 options 对象传到了 **locales 参数位**（第 2 参），引擎静默忽略 → 实际为纯字典序（大小写敏感、无数字自然排序，"File10" 排在 "file2" 前）。

**修复（2026-08-02）：** options 移到第 3 参（`localeCompare(b, undefined, {sensitivity: 'accent', numeric: true})`）。现在按名称排序为大小写不敏感 + 数字自然排序（file1 < file2 < file10）；`localeMatcher: 'lookup'` 去掉（默认 best-fit 更合适）。测试断言更新为修复后行为并锁定。

---

### 粘贴复制文件不落在鼠标网格（fallback 位置）

**症状：** 桌面右键"粘贴"复制的文件出现在左上角空位/fallback 位置，而右键"新建文件夹"出现在鼠标网格。

**根因：** 三条创建路径中，只有粘贴复制（`doPaste` → `CopyURIsRemote`）没有设置位置元数据：
- `doNewFolder` 同步写 `metadata::nautilus-drop-position`
- 拖放复制走 `clearFileCoordinates()`（源文件写 drop-position xattr，GIO 复制带 ALL_METADATA 继承；非本地文件走 `_pendingDropFiles`）
- `doPaste` 直接交给 Nautilus D-Bus，无任何坐标处理

**修复：** `doPaste` 复制分支复用 `clearFileCoordinates(this._clipboardFiles, [点击坐标])`，与拖放路径一致。剪切/移动分支不动（保留 icon-position，粘贴后回到原位）。

| 文件 | 变更 |
|------|------|
| `app/file-operations.js` | `doPaste` 复制分支调用 `clearFileCoordinates` |

**提交：** 待定

### 粘贴/拖放复制仍 fallback：gvfs metadata 不随复制继承

**症状：** 上一轮修复（doPaste 调 clearFileCoordinates）后，粘贴复制仍出现在默认位置。

**根因：** `metadata::nautilus-drop-position` 由 gvfs-metadata daemon 按**路径**存储（实测 `gio copy` 后目标文件无该属性），复制到新路径不继承。`clearFileCoordinates` 只对"非本地/不存在"的文件写 `_pendingDropFiles`，本地文件走属性写入（无效）→ 坐标全丢。

**修复：** `clearFileCoordinates` 对**所有**文件无条件写 `_pendingDropFiles[basename]`（带时间戳），FileItem 创建时 `_applyDropCoordinates` 精确匹配定位；补上缺失的 `_pendingDropFiles` TTL（5 分钟）与上限（64 条）惰性清理（bugs#35 声称已修但实际无）。

| 文件 | 变更 |
|------|------|
| `app/file-operations.js` | `clearFileCoordinates` 无条件写 `_pendingDropFiles` |
| `app/desktop-manager.js` | `_applyDropCoordinates` 兼容新格式 + `_prunePendingDropFiles` TTL/上限 |
| `app/desktop-menu.js` | 右键"粘贴"改 `doPaste(true)` |

### 复制后源文件失效，粘贴仍可用但失败

**症状：** 复制文件后删除/移动源文件，右键"粘贴"仍可点击，粘贴报错（Nautilus a11y 警告是启动噪音，实际失败是源 URI 不存在）。

**根因：** 菜单"粘贴"走 `doPaste(false)` 使用缓存的 URI 列表，不校验源文件存在性。

**修复：** `doPaste` 过滤不存在的源 URI；全部失效时提示"Nothing to paste"。右键菜单改用 `doPaste(true)` 保持剪贴板最新。

| 文件 | 变更 |
|------|------|
| `app/file-operations.js` | `doPaste` 源文件存在性过滤 + 空列表提示 |
| `app/desktop-menu.js` | 粘贴 action → `doPaste(true)` |

### 粘贴副本冲突重命名导致定位失效（Nautilus " (副本 2)" 后缀）

**症状：** 复制一个**本身带副本后缀**的文件（如 `笔记文档 (副本).md`）到桌面，桌面已有同名文件时，Nautilus 生成 `笔记文档 (副本 2).md`，图标仍 fallback。

**根因（诊断日志确认）：** `_pendingDropFiles` 按 basename 精确匹配；Nautilus 冲突重命名（本地化后缀 ` (copy)` / ` (副本 N)`）导致新文件名与条目不匹配。

**修复：** `FileUtils.matchPendingDropEntry()` —— 剥离双方"去扩展名 stem"的末尾 ` (…)` 冲突段后比较基础名（扩展名须相同），多条命中取时间戳最新。纯函数 + 23 断言单测锁定（中英文后缀、扩展名不匹配、前缀近似不误配、多条目择优）。

| 文件 | 变更 |
|------|------|
| `app/file-utils.js` | 新增 `stripConflictSuffix` / `matchPendingDropEntry` |
| `app/desktop-manager.js` | `_applyDropCoordinates` 改用模糊匹配 |
| `tests/test-pending-drop.js` | 新增 7 组测试 |

**诊断日志**（`DING_DEBUG=1`）：`[dropmatch] HIT/FUZZY/miss`、`[place] saved/drop/FALLBACK`

### ESM 迁移后桌面为空：顶层 await import() 卡死 promise job queue

**症状：** ESM 迁移后桌面无图标、右键菜单无"新建文件"、枚举完成后 microtask 全部停摆（await 永不恢复）。

**根因（本地复现 + gdb 定位）：** `thumbnails.js`/`auto-ar.js` 的可选依赖用**顶层 `await import('gi://...')`**。GJS 1.88 的 ESM 模块执行链（AsyncModuleExecution）在 **Gtk 窗口开始渲染后永不排空**——promise job queue 死锁——所有后续 microtask（包括枚举的 await 恢复）停摆。诊断链：`[enum] resolving` 后 `[update] read result` 永不打印；gdb 主线程栈显示 `PromiseReactionJob → ModuleObject::execute` 常驻；timeout/idle 源正常但任何 `.then()` 不执行。

**修复：** 顶层 await 改为**非阻塞动态 import**（`.then()` 回调赋值），模块加载不被挂起，job queue 不再被占。

| 文件 | 变更 |
|------|------|
| `app/thumbnails.js` | `GnomeDesktop` 顶层 await → 非阻塞 import().then() |
| `app/auto-ar.js` | `GnomeAutoar` 顶层 await → 非阻塞 import().then() |

**附带修复：** ding.js 独立模式默认 desktop 缺 `scaleFactor` 字段 → 窗口尺寸 NaN（`gdk_wayland_toplevel_compute_size` 断言失败），补 `scaleFactor: 1`。

### ESM 迁移后缩略图报错：GnomeDesktop 异步加载导致工厂未初始化

**症状：** `Error when asking for a thumbnail for XXX: can't access property "lookup", this._thumbnailFactoryLarge is undefined`。

**根因：** 顶层 await 修复（见上条）把 `GnomeDesktop` 改为非阻塞动态 import 后，`ThumbnailLoader` 构造时 `GnomeDesktop` 可能还是 `null`（import 未完成），缩略图工厂从未创建，`_resolveThumbnail` 访问 undefined 工厂。

**修复：** 模块级缓存 import promise；`ThumbnailLoader` 构造时 await 其完成再 `_initFactories()`；`getThumbnail()` 先 `await this._factoriesReady`，工厂不可用（GnomeDesktop 缺失）时直接返回 null。

### 右键菜单复数条目显示英文：ngettext 缺 domain

**症状：** 右键菜单 "Compress 1 file"、"New Folder with 1 Item" 等复数条目显示英文。

**根因：** ESM 迁移修复 gettext domain 时只覆盖了 `Gettext.domain('ding').gettext`，`file-item-menu.js` 三处 `Gettext.ngettext(...)` 仍是裸调用（默认空 domain）→ 找不到 ding.mo 翻译。

**修复：** 三处改为 `Gettext.domain('ding').ngettext(...)`（Compress folder/file + New Folder with N items）。

### 翻译遗漏排查：POTFILES.in 旧文件名 + 5 个未翻译字符串

**排查结果：**
1. **po/POTFILES.in 仍引用 kebab-case 重命名前的旧文件名**（20 条失效）→ 下次构建 xgettext 会丢失这些文件的字符串。已全部映射为新文件名，并补上遗漏的 `app/desktop-menu.js`。验证：新提取 200 条 msgid，`New Folder with {0} item`/`Compress {0} file` 等关键条目都在。
2. **`Sort Home/Drives/Trash..`（两点）与 .po 的 `...`（三点）不匹配**（upstream 遗留）→ 菜单显示英文。代码改回三点，翻译"排序主目录/驱动器/回收站…"立即生效。
3. **4 个新字符串无任何 .po 翻译**：`Rename file`/`Rename folder`/`New filename`/`Dropped Text.txt`。已补 zh_CN.po：重命名文件/重命名文件夹/新文件名/拖放的文本.txt。
4. **无其他遗漏**：16 处 `_` 定义全部走 `Gettext.domain('ding').gettext`；`file-item-menu.js` 三处 ngettext 已修（上条）；legacy 文件的 `imports.` 残留仅限 desktop-icons-integration.js（预期保留）；旧 .po 字符串（`${VisibleName} Stack` 等）对应代码已删除，属正常清理。

### 设置窗口置顶且所有工作区可见

**症状：** 打开扩展设置窗口时，窗口置顶、在所有工作区可见、不出现在任务栏。

**根因：** `showPreferences()` 调用 `windowHidePagerTaskbarModal(prefsWindow, true)`，给窗口标题追加两个空格；GNOME Shell 侧 `emulate-x11-window-type.js` 将"两空格结尾的标题"解析为 `@!HTD` 标记（置顶+所有工作区+隐藏）。这是 upstream 让设置窗口模态化的设计。

**修复：** 移除该调用，设置窗口变为普通窗口（不置顶、不跨工作区、任务栏可见）。重命名对话框与错误弹窗保留原行为。

**附带：** 设置窗口按 Adw 标准风格重构（PreferencesPage + 两个分组 + SwitchRow/ActionRow，可调整大小），新增 12 条 zh_CN 翻译条目（另 5 条复用已有翻译）。

### 设置窗口下拉框改用 AdwComboRow

Gtk.ComboBox 换成 Adw.ComboRow + Gtk.StringList（libadwaita 对 StringList 自动取字符串，无需 expression）。selected 为列表索引，通过 schema 枚举值列表（get_range 的 strv）与设置值双向映射——与旧 active-id 绑定行为等价。构建时本地无显示环境无法运行验证（Adw 控件构造段错误），需在真实 GNOME 会话确认。
