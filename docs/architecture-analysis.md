# Desktop Icons NG (DING) 原理与流程分析

## 一、概述

Desktop Icons NG (DING, `desktop-icons-ng@icookie-tea.github.io`) 是一个 GNOME Shell 扩展（支持 Shell 50/51），用于在桌面上显示文件图标。（本 fork 已改用独立 UUID，与原版 `ding@rastersoft.com` 互不覆盖。）其核心设计是 **Shell 扩展 + 独立 GTK4 进程** 的双层架构：GNOME Shell 扩展负责管理窗口几何和生命周期，独立的 GJS 进程负责渲染图标和处理用户交互。

icookie 分支在此基础上进行了大量重构和功能增强，包括模块化拆分、增量更新、概览动画、拖放修复、**ESM 迁移**、可维护性重构等。

> **模块系统：** 自 2026-07 起，GTK4 子进程层（`app/`）已全部迁移到 **ESM**（`import ... from './xxx.js'` / `gi://`），用 `gjs --module app/ding.js` 启动；Shell 侧 `extension.js`/`prefs.js` 也已 ESM 化。自 2026-08 起仓库内**不再有任何 legacy `imports.*` 用法**：`visible-area.js` 改用 `app/signals.js`（并注入 primaryIndex getter，可脱离 Shell 单测），上游的 `desktop-icons-integration.js`（依赖已移除的 legacy API，且 UUID 不匹配本 fork）已删除；`scripts/check.sh` 有守护禁止回潮。脚本统一在 `scripts/` 目录。

---

## 二、整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    GNOME Shell 扩展层                            │
│  extension.js ──── DING 类                                      │
│  ├── emulate-x11-window-type.js ── Wayland 窗口管理                 │
│  ├── visible-area.js ──── 可用区域计算                            │
│  ├── title-protocol.js ─── 窗口标题协议纯解析（可单测）              │
│  └── gnome-shell-override.js ── Overview 桌面图标动画注入          │
├──────────── D-Bus (com.rastersoft.dingextension) ────────────────┤
┌─────────────────────────────────────────────────────────────────┐
│                   独立 GTK4 进程层 (app/ding.js, ESM)            │
│  ding.js ──── Adw.Application（含 prefs-window 设置窗口）         │
│  ├── desktop-manager.js ──── 桌面管理器（核心，大幅重构）           │
│  │   ├── desktop-monitor.js ── 显示器/工作区/缩放监控（拆分）        │
│  │   ├── grid-layout.js ────── 网格布局与窗口管理（拆分）           │
│  │   ├── mount-manager.js ──── VolumeMonitor/mount 生命周期（拆分）│
│  │   ├── theme-manager.js  ── accent color / 暗色模式             │
│  │   ├── file-operations.js ── 文件操作封装                       │
│  │   ├── sort-manager.js   ── 排序逻辑                             │
│  │   ├── file-changes-queue.js ── 增量更新队列                    │
│  │   ├── desktop-grid.js ──── 网格渲染（每块屏幕一个）              │
│  │   │   └── paint-container.js ── 橡皮筋选择 / 拖放高亮绘制       │
│  │   ├── file-item.js ──── 图标项                                 │
│  │   ├── desktop-icon-item.js ── 图标基础类                         │
│  │   ├── desktop-menu.js ──── 右键菜单                            │
│  │   ├── file-item-menu.js ─── 图标菜单                            │
│  │   ├── thumbnails.js ──── 缩略图加载                           │
│  │   └── auto-ar.js ──── 自动归档                                │
│  ├── dbus-utils.js ──── D-Bus 工具集                              │
│  │   └── dbus-remote-operations.js ── 远程文件操作（拆分）          │
│  ├── preferences.js + prefs-window.js ── 设置（Adw 风格）            │
│  ├── dnd-clipboard-utils.js ── 拖放剪贴板工具                       │
│  ├── signal-manager.js / signals.js ── 信号管理（内置实现）           │
│  ├── file-utils.js / desktop-icons-util.js / constants.js / log.js  │
│  └── menu-helper.js / ask-rename-popup.js / show-error-popup.js …  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 三、启动流程

### 阶段 1：扩展加载

```
GNOME Shell 启用扩展
  └─→ extension.js: DING.constructor()
       ├─→ doKillAllOldDesktopProcesses()   // 杀死残留进程
       └─→ 初始化 data 对象（x11Manager/visibleArea/gnomeShellOverride 置 null）
```

`constructor()` 中会扫描 `/proc` 查找旧的 `ding.js` 进程并 kill 掉，防止 GNOME Shell 重启后出现多个桌面管理进程（ESM 迁移后进程 cmdline 为 `gjs --module <path>/ding.js ...`，匹配用 `includes(ding.js 路径)` 而非前缀）。概览动画注入器（`gnome-shell-override`）不在构造时创建，而是在 `enable()` 中创建并立即 `enable()`（见阶段 2）。

### 阶段 2：扩展启用

```
enable()
  ├─→ new EmulateX11WindowType()            // 窗口类型模拟管理器
  ├─→ new VisibleArea()                     // 可用区域计算器
  ├─→ new GnomeShellOverride().enable()     // icookie 新增：概览动画注入
  │   └─→ InjectionManager.overrideMethod(WorkspaceBackground, '_init')
  └─→ 判断 Shell 是否启动完成：
       ├─→ 未启动 → 连接 'startup-complete' 信号等待
       └─→ 已启动 → 直接调用 innerEnable()
```

### 阶段 3：innerEnable() —— 核心初始化

```
innerEnable()
  ├─→ x11Manager.enable()
  │   └─→ 连接 window_manager 'map' / 'destroy' 信号
  │       （注：旧版曾连接 Main.overview 'hiding' 信号，已随 fc84044 移除）
  │
  ├─→ 监听显示器/工作区变化信号
  │   ├─→ 'monitors-changed'
  │   ├─→ 'workareas-changed'
  │   ├─→ 'updated-usable-area'
  │   └─→ 'notify::scale-factor'
  │
  └─→ Gio.bus_own_name('com.rastersoft.dingextension')
       └─→ D-Bus 名称获取成功后回调：
            ├─→ 创建 D-Bus Action Group
            ├─→ 导出 desktopGeometry / disableTimer action
            └─→ launchDesktop()              // 启动 GTK4 子进程
```

### 阶段 4：启动子进程

```
launchDesktop()
  └─→ LaunchSubprocess.spawnv([<ding.js路径>, '-E', '-P', <app路径>])
      （`gjs --module` 来自 shebang `#!/usr/bin/env -S gjs --module`，argv 本身不含）
       ├─→ Meta.WaylandClient.new_subprocess()   // Wayland 子进程协议
       ├─→ 连接 stdout/stderr，日志输出到 journal
       ├─→ 启动 6 秒超时定时器（防止卡死）
       └─→ wait_async 监控进程退出
            └─→ 进程退出 → doRelaunch() 自动重启
```

> **ESM 说明：** 自 ESM 迁移起子进程以 `gjs --module` 启动（ESM 需要显式 `--module` 标志；shebang `#!/usr/bin/env -S gjs --module` 也支持直接执行）。`-P <path>` 参数保留兼容（旧 searchPath 机制已失效，缩略图子进程仍用它定位 codePath）。

---

## 四、GNOME Shell 扩展层的职责

### 4.1 窗口管理 (emulate-x11-window-type.js)

**目的：** 在 Wayland 下模拟 X11 的窗口类型行为。

Wayland 不允许客户端直接设置窗口类型为 DESKTOP，所以 DING 采用了一种巧妙的机制——**窗口标题协议**：

1. GTK4 进程创建的窗口标题格式为 `"Desktop Icons <n>"`
2. Shell 端的 `EmulateX11WindowType` 监听 `window_manager` 的 `map` 信号
3. 通过 `WaylandClient.query_window_belongs_to()` 识别属于 DING 子进程的窗口
4. `ManageWindow` 类接管窗口，设置 `Meta.WindowType.DESKTOP`，并定位到正确坐标

**窗口标题协议格式：**
```
@!<x>,<y>;<flags>;
  flags: B=底部, T=置顶, D=所有桌面, H=隐藏
```

### 4.2 可用区域计算 (visible-area.js)

计算每个显示器上可用于放置图标的区域，考虑：
- Top panel 高度
- 其他扩展声明的边距（通过 `DesktopIconsUsableArea` 接口）
- 工作区边界

上游 DING 提供 `desktop-icons-integration.js`（`DesktopIconsUsableAreaClass`）供其他扩展注册边距需求；本 fork 已删除该文件——它依赖 GNOME Shell 50 已移除的 legacy `imports` API（加载即崩），其 `IDENTIFIER_UUID` 匹配的是上游 UUID 而非本 fork，且 DING 自身代码零引用。接收端（`VisibleArea.setMarginsForExtension`）保留，将来上游 ESM 化后可重新引入。

### 4.3 Overview 动画注入 (gnome-shell-override.js) — icookie 新增

icookie 分支通过 GNOME Shell 的 `InjectionManager` 重写 `WorkspaceBackground.prototype._init`，在背景层之上插入一个 `Clutter.Clone` 容器：

1. 收集当前显示器上所有 DESKTOP 类型的窗口
2. 为每个窗口创建 `Clutter.Clone`，放入自定义布局器 `DesktopLayout`
3. 监听 `OverviewAdjustment::notify::value`，根据概览过渡状态（进入/退出）计算透明度
4. 使用 `Util.lerp()` 实现平滑淡入淡出

```
WorkspaceBackground._init (注入后)
  └─→ 原始初始化 → 创建 DesktopLayout 容器
      ├─→ Clutter.Clone 绑定桌面窗口
      └─→ OverviewAdjustment::notify::value
          └─→ lerp(opaque, transparent, progress) 控制透明度
```

### 4.4 几何数据传递

```
extension.js: getDesktopGeometry()
  └─→ 为每个显示器收集：
       { x, y, width, height, scaleFactor, marginTop, marginBottom,
         marginLeft, marginRight, monitorIndex, primaryMonitor }
  └─→ 通过 D-Bus Action 'desktopGeometry' 传递给子进程

icookie 分支额外改动：
  └─→ improved primaryMonitor handling: _primaryIndex < _desktopList.length 时才赋值
```

---

## 五、GTK4 子进程层的职责

### 5.1 入口 (ding.js)

```
ding.js
  ├─→ 解析命令行参数 (-E 桌面模式, -P 代码路径, -D 显示器数据)
  ├─→ 初始化 Gio Promise 封装
  ├─→ 创建 Adw.Application
  └─→ 'startup' → 初始化 Prefs、DBusManager
      'activate' → 创建 DesktopManager 实例
```

### 5.2 DesktopManager 核心流程 (desktop-manager.js) — icookie 重构

icookie 分支对 `DesktopManager` 进行了大规模重构，将大量职责从单体类中提取为独立模块：

```
DesktopManager.constructor()
  ├─→ _themeManager = ThemeManager(this)    // accent color / 暗色模式
  │   └─→ connectAccentColorHandler(() => idle_add(更新选择颜色))
  │       注意：accent color 变更延迟到 idle 回调处理（icookie 修复）
  │
  ├─→ _fileOps = FileOperations(this)        // 文件操作封装
  │   └─→ doCopy/doCut/doTrash/doDelete/doPaste/doRename/doNewFolder
  │
  ├─→ _sortManager = SortManager(this)       // 排序逻辑
  │   └─→ doSorts()
  │
  ├─→ _fileChangesQueue = FileChangesQueue(200, 2)  // icookie: 增量更新队列
  │   └─→ onFlush(events => _processIncrementalEvents())
  │       catch → _scheduleFullRefresh()
  │
  ├─→ 检测显示环境 (X11/Wayland)
  ├─→ 初始化样式（CSS provider）
  ├─→ 创建文件目录监控器 (_monitorDesktopDir)
  ├─→ 连接大量信号：
  │   ├─→ 设置变更（DING 自身、GTK、Nautilus、暗色模式）
  │   ├─→ 图标主题变更
  │   ├─→ 卷挂载/卸载
  │   └─→ D-Bus 几何更新
  ├─→ _createGridWindows()                  // 为每块屏幕创建 DesktopGrid
  ├─→ _dbusAdvertiseUpdate()                // 监听 D-Bus 几何变更
  └─→ _updateDesktop()                      // 首次加载桌面文件

icookie 新增实例变量：
  ├─→ _pendingMoves = {}                     // 待处理的移动操作
  ├─→ _processingIncremental = false          // 增量更新锁
  ├─→ _moveTimeoutId = 0                     // 移动超时定时器
  ├─→ _dragOriginX/Y = 0                    // icookie: 拖拽起始坐标
```

> 2026-09-08 起：“按类型堆叠”（keep-stacked）功能已整体移除（见 docs/fixes.md），相关状态（stackInitialCoordinates/_allFileList）与代码一并删除。
```

**后续拆分（可维护性重构）：** `DesktopManager` 进一步拆分为三个独立模块——

| 模块 | 职责 | 行数变化 |
|---|---|---|
| `mount-manager.js` | VolumeMonitor 信号（mount-added/changed/removed）、异步 mount 信息查询（`_readMountsAsync`，V-3）、瞬时失败重试调度（`_scheduleMountRefreshRetry`，V-6） | 2026-09 自 desktop-manager 拆分（见 docs/volume-mount-issues.md） |
| `desktop-monitor.js` | 显示器/工作区/缩放因子监控（`_initMonitor` 等，含信号生命周期管理） | desktop-manager 1850→1547 |
| `grid-layout.js` | 网格布局、窗口创建/销毁、D-Bus 几何广告（`GridLayout` 类） | 新文件 111 行 |
| `dbus-remote-operations.js` | 远程 D-Bus 文件操作（复制/移动/删除等 `_remoteCall` 模板化封装） | dbus-utils 780→542 |

**2026-08 继续拆分（`refactor/dm-split` 分支，desktop-manager 1625→913 行）：**

| 模块 | 职责 | 拥有的状态 |
|---|---|---|
| `selection-manager.js` | 橡皮筋框选、5 种选择动作、选择查询 | `rubberBand`/`selectionRectangle`/`x1..y2`/`_clickCaptured` |
| `search-dialog.js` | Ctrl+F 查找对话框、type-to-search、自动隐藏 | `searchString`/`keypressTimeoutID`/`_findFileWindow` |
| `keyboard-manager.js` | 方向键导航、快捷键、忽略键列表 | `ignoreKeys`/`_lastSelected` |
| `dnd-manager.js` | 图标拖动、外部拖放（文件/纯文本） | `dragItem`/`_dragList`/`_dragOriginX/Y` |

图标放置逻辑（`findDesktopFor`/`getFallbackPosition`/`addFilesToDesktop`）并入 `grid-layout.js`。DesktopManager 保留刷新管线（`_updateDesktop`/`_doReadAsync`/`_drawDesktop`）、设置处理与一行委托 shim，外部调用方零改动。状态归属由 `tests/test-state-ownership.js`（字段存在性）+ `check.sh` 的 `check_state_ownership`（禁止从旧路径读取）双重守护；`check.sh` 还有独立进程冒烟测试（启动 `ding.js` 8 秒，出现 JS ERROR 即失败）。信号跟踪全部统一到 `SignalManager`（原 4 份手写 `_signalIds`/`_trackSignal` 已删除，修复 ProxyManager #34）。

构造函数从 269 行精简到 27 行；`_onDesktopSettingsChanged` 用 switch 分派；`_updateDesktopSafe()` 抽取 14 处重复 catch。

### 5.2.1 网格布局管理 (grid-layout.js) — 重构拆分

`GridLayout` 负责桌面窗口的创建与布局，是 `createGridWindows()` 的宿主：

```
GridLayout
  ├─→ createGridWindows()          // 每块屏幕创建一个 DesktopGrid
  │   └─→ 窗口标题 "Desktop Icons <n>"（与 emulate-x11-window-type.js 协议匹配）
  ├─→ updateGridWindows(data)      // D-Bus 几何变更时重建/调整窗口
  ├─→ dbusAdvertiseUpdate()        // 监听 extensionControl 的 action
  └─→ 信号经 SignalManager 注册，destroy() 统一断开
```

### 5.3 桌面文件读取流程

```
_updateDesktop()
  └─→ _doReadAsync()
       ├─→ enumerate_children_async(桌面目录)
       ├─→ 对每个文件创建 FileItem 实例
       ├─→ 添加特殊文件夹（Home、Trash）
       ├─→ 添加已挂载的卷
       └─→ 过滤隐藏文件（根据设置）

   └─→ _drawDesktop(fileList)
        ├─→ _removeAllFilesFromGrids()        // 清理旧图标
        ├─→ 恢复选中状态
        └─→ _placeAllFilesOnGrids()
             ├─→ keep-arranged → doSorts()     // icookie: SortManager.doSorts()
             └─→ 默认 → _addFilesToDesktop()   // 保留用户位置

_updateDesktopIfChanged()                     // 文件监控回调
  └─→ 过滤无效事件 → push 到 FileChangesQueue
      └─→ flush → _processIncrementalEvents(events)

_processIncrementalEvents(events)             // icookie: 增量处理
  ├─→ 检查锁 (_processingIncremental / _readingDesktopFiles) → 标记 _desktopFilesChanged 并返回
  ├─→ events.length > maxIncremental(2) → _scheduleFullRefresh()
  ├─→ 逐个事件处理：
  │   ├─→ DELETED → _handleFileDeleted(file)
  │   ├─→ CREATED / MOVED_CREATED → await _handleFileCreated(file)
  │   ├─→ MOVED_IN → await _handleMovedIn(file, otherFile)
  │   ├─→ MOVED_OUT → _handleMovedOut(file, otherFile)
  │   ├─→ PRE_UNMOUNT / unknown → _scheduleFullRefresh()
  │   └─→ 处理失败 → _scheduleFullRefresh()
  └─→ if (_desktopFilesChanged) → _scheduleFullRefresh()

_scheduleFullRefresh()                        // icookie: fallback 全量刷新
  └─→ this._updateDesktop().catch(...)
```

**增量更新机制 (icookie)：**
- `FileChangesQueue` 使用 debounced timer（200ms）+ max-batch-size（2 events）
- 短时间内多次文件变更会被合并，减少不必要的桌面重建
- `_processIncrementalEvents(events)` 逐个处理事件：
  - 有锁或正在读取桌面文件时标记 `_desktopFilesChanged` 直接返回
  - 事件数超过阈值 → 全量刷新
  - 单个事件失败 → 全量刷新
  - PRE_UNMOUNT / unknown event → 全量刷新
- finally 块中释放 `_processingIncremental`，结束后检查 `_desktopFilesChanged` 决定是否全量刷新

**移动操作处理 (icookie)：**
- `MOVED_OUT`: 记录 `{oldPath: newPath}` 到 `_pendingMoves`，启动 150ms timeout
- timeout 触发时：如果路径仍在 `_pendingMoves` 中 → 视为 MOVE（仅更新元数据）；否则视为 DELETE + CREATE

### 5.4 DesktopGrid 网格系统 (desktop-grid.js) — icookie 重构

每个显示器对应一个 `DesktopGrid` 实例：

```
DesktopGrid
  ├─→ Gtk.ApplicationWindow（无边框、透明背景）
  ├─→ Gtk.Fixed 容器（图标定位）
  ├─→ PaintContainer              // icookie: 抽离为独立模块
  │   └─→ vfunc_snapshot()        // 绘制橡皮筋选择框 + 拖放高亮
  ├─→ 网格状态 (_grid_status[x][y])
  └─→ 事件控制器：
       ├─→ GestureClick（左键/右键）
       ├─→ EventControllerMotion（鼠标移动/橡皮筋）
       ├─→ EventControllerKey（键盘导航）
       └─→ DropTargetAsync（拖放目标）
```

**PaintContainer (icookie 新增独立模块)：**
- `vfunc_measure()` — 自定义测量逻辑
- `vfunc_snapshot()` — 使用 Gsk.RoundedRect + Gsk.Stroke 绘制圆角矩形
- 支持橡皮筋选择框（半透明填充 + 边框）和拖放高亮（每格独立圆角矩形）

**网格计算：**
```
_maxColumns = width / (图标宽度 + 间距)
_maxRows    = height / (图标高度 + 间距)
_elementWidth  = width / _maxColumns
_elementHeight = height / _maxRows
```

### 5.5 FileItem 图标项 (file-item.js + desktop-icon-item.js)

```
FileItem 继承 desktopIconItem 继承 SignalManager
  ├─→ Gtk.Box 容器（图标 + 标签）
  ├─→ 读取文件属性（类型、大小、修改时间、可执行性等）
  ├─→ 异步加载缩略图
  ├─→ 处理特殊图标（Home、Trash、外部驱动器）
  │   └─→ Trash 有独立监控器，检测内容变化切换图标
  ├─→ 设置拖放目标
  └─→ 生命周期：
       ├─→ removeFromGrid() → _onDestroy()
       └─→ _destroy() → 取消异步操作 + 断开信号

icookie 新增属性/修复：
  ├─→ isKeyboardSelected — 键盘导航选中标识（替代全局 dragItem）
  ├─→ dropCoordinates — icookie: 修正拖放坐标传递
  └─→ _isBeingDragged — icookie: per-instance 拖拽状态，替代全局检查
```

### 5.6 缩略图系统 (thumbnails.js)

```
ThumbnailLoader
  ├─→ _thumbList 队列（异步处理）
  ├─→ _launchNewBuild() 逐个处理队列
  └─→ 两种生成模式：
       ├─→ GnomeDesktop.DesktopThumbnailFactory（优先，异步）
       └─→ 子进程 fallback（create-thumbnail.js）

icookie 修复：图片缩略图尺寸不超过 icon_size（防止容器撑宽）
```

**ESM 迁移后：** `GnomeDesktop` 改为非阻塞动态 import（`import('gi://GnomeDesktop?version=4.0').then(...)`）——顶层 `await import()` 在 Gtk 窗口渲染后会卡死 promise job queue（见 archive/fixes-2026-08.md 2026-08-02 条目）。`ThumbnailLoader` 构造函数 `await` 该 import 完成后才创建缩略图工厂；`getThumbnail()` 先等待工厂就绪，`GnomeDesktop` 缺失时直接返回 null（不再报错）。

### 5.7 ThemeManager (icookie 新增模块)

```
ThemeManager
  ├─→ connectAccentColorHandler(handler)
  │   ├─→ Adw.StyleManager::notify(accent-color/rgba) → handler()   // 无条件连接
  │   └─→ GFileMonitor(~/.config/gtk-4.0/ 目录) → handler()（300ms 防抖）
  │       （用户 gtk.css / custom-accent.css 覆盖变更；icookie 最终方案：
  │        不依赖 GTK 解析缓存，直接读文件，见 archive/fixes-2026-08.md 2026-08-05 条目）
  │       icookie: handler 被包装在 GLib.idle_add 中（修复竞态）
  │
  ├─→ configureSelectionColor()
  │   ├─→ use-accent-color 关闭 → 固定灰 #959595（Nautilus 风格）
  │   ├─→ _readUserAccentOverride() 优先   // 解析 gtk.css + @import 链的
  │   │     //  @define-color accent_bg_color（Chromaleon 自定义色）
  │   ├─→ 无覆盖 → get_accent_color_rgba()  // portal/预设（含 GNOME Colors 模式）
  │   ├─→ 再失败 → lookup('accent_bg_color')  // 旧系统主题命名色
  │   └─→ Gtk.CssProvider → @define-color desktop_icons_bg_color
  │       icookie: 修复 Gtk 4.9 load_from_data API 兼容（-1 vs NULL）
  │
  └─→ checkApplyDarkModeSetting()        // 暗色模式同步
```

### 5.8 SortManager (icookie 新增模块)

从 `desktop-manager.js` 抽离，处理排序逻辑（原“按类型堆叠”功能已于 2026-09-08 整体移除：
`stack-item.js`、doStacks/_unstack、sortFileListByKindStacked、keep-stacked/unstackedtypes
设置项、右键菜单 Stack/Unstack This Type 均已删除，见 docs/fixes.md）：

```
SortManager
  ├─→ doSorts(cleargrids)                 // 按名称/类型/大小/修改时间排序
  │   └─→ _sortAllFilesFromGridsByName() / BySize() / ByKind() / ...
  │       └─→ _reassignFilesToDesktop()    // 清除坐标 + 重新分配位置
  │
  └─→ sortAllFilesFromGridsByPosition()    // 按位置排序（支持四角起始）
```

### 5.9 FileOperations (icookie 新增模块)

从 `desktop-manager.js` 抽离，封装所有文件操作：

```
FileOperations
  ├─→ doCopy() / doCut()                  // DnD 剪贴板管理
  ├─→ doTrash() / doDeletePermanently() / doEmptyTrash()
  │   └─→ DBusUtils.RemoteFileOperations.* (通过 Nautilus D-Bus)
  ├─→ doPaste(refresh)                    // 支持 refresh=true 重新读取剪贴板
  ├─→ updateClipboard()                   // 异步更新剪贴板状态
  ├─→ doRename(fileItem, allowReturnOnSameName)
  │   └─→ AskRenamePopup.AskRenamePopup (icookie: 修复菜单生命周期)
  ├─→ fileExistsOnDesktop(searchName)
  ├─→ getDesktopUniqueFileName(fileName)
  └─→ doNewFolder(position?, suggestedName?, opts?)
      └─→ Gio.File.make_directory() + metadata::nautilus-icon-position
```

---

## 六、D-Bus 通信

### 6.1 扩展 → 子进程

```
D-Bus name: com.rastersoft.dingextension
  ├─→ Action: desktopGeometry   → 传递显示器几何数据
  └─→ Action: disableTimer      → 禁用启动超时

> 日志：DING_DEBUG 环境变量门控（`debugLog()`），未设置时静默，避免 journal 刷屏。
```

### 6.2 子进程 → 外部服务

```
DBusUtils.init()
  ├─→ DBusManager              → 管理服务可用性
  ├─→ NautilusFileOperations2  → 文件操作（移动/复制/删除/回收站）
  ├─→ FreeDesktopFileManager   → 打开文件
  ├─→ GnomeNautilusPreview     → 文件预览
  ├─→ SwitcherooControl        → GPU 切换检测
  ├─→ GnomeArchiveManager      → 归档管理
  └─→ GtkVfsMetadata           → 元数据变更通知
```

所有 proxy 通过 `ProxyManager` 包装，自动处理服务可用性检测和服务上线/离线事件。

---

## 七、用户交互流程

### 7.1 图标选择

```
鼠标左键按下
  └─→ onPressMainButton()
       ├─→ 无修饰键 → 清除所有选中
       └─→ _startRubberband()

鼠标移动（按住左键）
  └─→ onMotion()
       └─→ 更新 selectionRectangle → PaintContainer.vfunc_snapshot() 绘制选择框

鼠标左键释放
  └─→ onReleaseMainButton()
       └─→ 结束橡皮筋 → _desktopGrid.queue_draw()
```

### 7.2 图标拖放 (icookie 修复)

```
onDragBegin(item)
  └─→ icookie: 保存 _dragOriginX/Y（在 drag-end 清理前）

onDragMotion(x, y)
  └─→ PaintContainer.selectedList = [[x,y], ...] → queue_draw() 绘制高亮

onDragDataReceived(dropInfo, x, y)
  ├─→ icookie: drop.finish(0) 在第一个 await 之后立即调用（修复竞态）
  │   └─→ move drop.finish() before the second await (FileUtils.readAll)
  │       ensure GdkDrop enters DROPPING state before any further async ops
  ├─→ DING_ICON_LIST → 移动图标（内部重排，使用 _dragOriginX/Y）
  ├─→ URI_LIST → 移动/复制文件到桌面（通过 Nautilus D-Bus）
  │   └─→ icookie: reject folder drop when its own URI is in the dropped filelist
  └─→ TEXT_PLAIN → icookie: sanitize filenames, prevent overwrites

icookie drag icon 修复链：
  ├─→ GtkSnapshot.to_paintable(null) requires null arg (GJS API fix)
  ├─→ GdkPaintable.snapshot() 替代不存在的 GtkSnapshot.append_paintable()
  └─→ _createDragIcon: shrink ghost to match actual icon container size

```

（原“堆叠拖拽图标”随 keep-stacked 功能一并移除）

### 7.3 键盘导航

```
方向键 → 在图标间移动焦点（最近邻搜索）
Ctrl+A → 全选
Ctrl+Space → 切换当前焦点图标选中
Ctrl+Z/Shift+Ctrl+Z → icookie: 移除死代码，修复 _dragList 封装
F2 → 重命名 (icookie: AskRenamePopup 生命周期修复)
Enter → 打开
F5 → 刷新
输入字母 → 按名称搜索
```

### 7.4 右键菜单 (icookie 修复)

```
icookie 修复链：
  ├─→ follow GTK4/Nautilus menu lifecycle pattern
  ├─→ destroy popover on close (not unparent) — prevent memory accumulation
  ├─→ remove unnecessary async from showDesktopMenu / _createDesktopBackgroundMenu
  ├─→ fix context menu grab and close behavior (Wayland)
  └─→ paste always unavailable (Wayland cross-process clipboard) → fixed
```

---

## 八、数据持久化

图标位置存储在文件元数据属性中：
```
metadata::nautilus-icon-position → "x,y" 坐标
metadata::nautilus-drop-position → icookie: 拖放临时坐标（用于新建文件夹定位）
```

桌面刷新时读取这些属性恢复图标位置。如果文件没有保存坐标，则自动分配空位。

icookie 分支新增 `stackInitialCoordinates`：堆叠模式下保存每个文件的初始坐标，取消堆叠时可恢复。

---

## 九、进程生命周期管理

```
正常关闭：
  └─→ disable() → killCurrentProcess() → SIGTERM 子进程
      └─→ icookie: gnomeShellOverride.disable() (clear InjectionManager)

子进程异常退出：
  └─→ wait_async 回调 → doRelaunch(1000ms) → 重新启动

快速崩溃防护：
  └─→ 如果进程运行 < 1 秒就退出 → 重启延迟 1000ms
      如果进程运行 > 1 秒后退出 → 重启延迟 1ms

Shell 热重载：
  └─→ constructor() 中的 doKillAllOldDesktopProcesses() 清理残留
```

---

## 十、关键设计决策

| 设计点 | 方案 | 原因 |
|--------|------|------|
| 双层架构 | Shell 扩展 + 独立 GTK4 进程 | GTK4 不能直接在 Shell 中使用；独立进程崩溃不影响 Shell |
| 窗口定位 | 窗口标题协议 + X11 类型模拟 | Wayland 不允许客户端自行设置窗口类型 |
| 文件操作 | 通过 Nautilus D-Bus 代理 | 权限一致、与系统集成 |
| 图标布局 | 文件元数据持久化 | 位置信息跟随文件，不依赖扩展状态 |
| 防抖更新 (原版) | 监控器 + 1 秒超时强制刷新 | 避免大量文件操作时频繁重建桌面 |
| 增量更新 (icookie) | FileChangesQueue (200ms debounce, max 2 events) | 更精细的批处理，出错 fallback 全量刷新 |
| 信号管理 | SignalManager 封装 | 统一连接/断开，减少泄漏 |
| Overview 动画 (icookie) | InjectionManager + Clutter.Clone | 注入 GNOME Shell 内部类实现淡入淡出 |

---

## 十一、icookie 分支新增特性与修复摘要

### 11.1 模块化重构（模块提取）
- `ThemeManager` — accent color / dark mode 管理
- `FileOperations` — 文件操作封装
- `SortManager` — 排序/堆叠逻辑（堆叠排序核心已抽为静态纯函数 `sortFileListByKindStacked`）
- `PaintContainer` — 自定义绘制容器
- `MountManager`（app/mount-manager.js）— mount 生命周期，见 5.2.1
- `title-protocol.js` — 窗口标题协议（@!x,y;flags / Desktop Icons <n>）纯解析，自 emulate-x11-window-type.js 抽出以支持无 Meta 环境单测

### 11.2 Overview 动画
gnome-shell-override.js 注入 WorkspaceBackground，实现进入/退出概览时桌面图标的淡入淡出效果

### 11.3 增量更新
FileChangesQueue 替代旧的单体防抖机制，支持事件合并和出错 fallback

### 11.5 单元测试（gjs --module，无 GTK 依赖）
`tests/run.js` 跑 13 个测试组（纯逻辑 + GJS 模块，headless）：

| 测试组 | 覆盖 |
|---|---|
| test-grid-layout / test-sort-manager | 网格坐标、排序/堆叠（含 O(n) 堆叠恢复） |
| test-click-coordinates / test-drop / test-link-emblem | 点击命中、拖放文件名/条目匹配、链接徽章 |
| test-scripts-menu / test-drive-menu | 脚本菜单构建、驱动器菜单 Eject/Unmount 判定（对齐 Nautilus） |
| test-file-changes-queue / test-desktop-monitor | 事件合并队列、显示器监听 |
| test-volume-mount | mount 判定纯函数 + 信号 mock 端到端 |
| test-theme-accent | accent 色 @define-color 解析（注释剥离/后定义胜/非法值跳过） |
| test-title-protocol | 窗口标题协议（@!x,y;flags、尾随空格别名、Desktop Icons <n>） |

运行：`gjs --module tests/run.js`（`scripts/check.sh` 会顺带跑）。约束：GJS ESM 命名空间只读（不能 monkeypatch 导入模块）、headless 无 GSettings schema / Meta GI——所以可测点都抽成了不依赖 Shell 的纯函数/静态方法。

### 11.4 DnD 修复（8+ commits）
- per-instance `_isBeingDragged` 替代全局 `dragItem` 检查
- 同步调用 `drop.finish()` after first await（确保 GdkDrop 进入 DROPPING state，消除 gdk_drop_finalize warnings）
- folder self-drop guard (reject when own URI in dropped filelist)
- drag ghost preview 尺寸修正

### 11.5 堆叠拖拽图标 (feature)
multi-select → StackTopMarkerFolder + count badge overlay（e633ac1）

### 11.6 GJS API 兼容性修复
- `Gdk.Screen.get_default()` → `Gtk.Settings.get_default()`
- `GtkSnapshot.to_paintable(null)` null arg fix
- `GtkSnapshot.append_paintable()` → `GdkPaintable.snapshot()`
- Gtk 4.9 `load_from_data()` signature compatibility

### 11.7 右键菜单生命周期修复（5 commits）
- destroy popover on close (not unparent)
- follow GTK4/Nautilus menu lifecycle pattern
- fix Wayland cross-process clipboard paste availability

### 11.8 primary monitor 切换 bug 修复（3 bugs）
- icon placement issues when switching primary monitor
- improved `_primaryIndex` bounds checking in `updateGridWindows()`

### 11.9 其他修复
- Adwaita theme `:drop(active)` box-shadow suppression on desktop window
- ptyxis added to terminal fallback list
- text drop sanitize filenames + prevent overwrites (align with Nautilus)
- thumbnail size capped at icon_size (prevent container overflow)

### 11.10 可维护性重构（阶段 0-3，2026-07）
- 脚本统一迁入 `scripts/`（均可任意 CWD 运行），`scripts/check.sh` 一键验证（eslint + node --check + 单测 + 结构检查 + manifest 一致性）
- 53 个 JS 文件统一 kebab-case 命名（meson/文档/脚本同步）
- `_updateDesktopSafe()` 抽取 14 处重复 catch；构造函数 269→27 行；`_remoteCall` D-Bus 模板化（-302 行）；死代码清理
- 修复潜伏 bug：thumbnails 未定义 `reject`、fileOperations 缺 gettext、`generateDropFilename` 正则双反斜杠、meson 缺新文件清单等
- 拆分：`desktop-monitor.js`/`grid-layout.js`/`dbus-remote-operations.js`；信号生命周期（`_trackSignal`/`destroy()`）

### 11.11 ESM 迁移（阶段 4，2026-07）
- `app/` 38 个模块 + 13 个测试文件迁移到 ESM；`gjs --module` 启动（shebang `#!/usr/bin/env -S gjs --module` 支持直接执行）
- `app/signals.js` 自实现（GJS 1.88 ESM 无法导入内置 `signals`）；`GnomeDesktop`/`GnomeAutoar` 动态 import + TLA 保留容错
- `desktop-icons-integration.js` 保持 legacy（第三方扩展在 Shell 内用 `imports.*` 加载）
- 踩坑记录：命名空间冻结（`this.x=` 写模块变量失败）、裸 `class` 不导出（须 `var X = class`）、gettext 必须 `Gettext.domain('ding').gettext`、`ngettext` 同域
- 修复 ESM 引入的 bug：顶层 `await import()` 卡死 promise job queue（桌面空）、缩略图工厂延迟初始化、prefs 命名空间冻结、gettext domain 丢失（16 文件 + 3 处 ngettext）

### 11.12 设置窗口 Adw 重构（2026-08）
- 设置窗口不再置顶/跨工作区（移除标题空格 hack，`windowHidePagerTaskbarModal` 仅保留给对话框/错误弹窗）
- `prefs-window.js` 改为 `Adw.PreferencesPage` + 两个分组；`Adw.SwitchRow` 开关 + `Adw.ComboRow` 下拉
- 翻译补齐：POTFILES.in 旧文件名修复（20 条失效）、`Sort Home/Drives/Trash...` 与 .po 对齐、12 条新 zh_CN 条目
