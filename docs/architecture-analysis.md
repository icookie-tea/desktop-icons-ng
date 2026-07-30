# Desktop Icons NG (DING) 原理与流程分析

## 一、概述

Desktop Icons NG (DING, `ding@rastersoft.com`) 是一个 GNOME Shell 扩展（支持 Shell 50/51），用于在桌面上显示文件图标。其核心设计是 **Shell 扩展 + 独立 GTK4 进程** 的双层架构：GNOME Shell 扩展负责管理窗口几何和生命周期，独立的 GJS 进程负责渲染图标和处理用户交互。

icookie 分支在此基础上进行了大量重构和功能增强，包括模块化拆分、增量更新、概览动画、拖放修复等。

---

## 二、整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    GNOME Shell 扩展层                            │
│  extension.js ──── DING 类                                      │
│  ├── emulateX11WindowType.js ── Wayland 窗口管理                 │
│  ├── visibleArea.js ──── 可用区域计算                            │
│  └── gnomeShellOverride.js ── Overview 桌面图标动画注入          │
├──────────── D-Bus (com.rastersoft.dingextension) ────────────────┤
┌─────────────────────────────────────────────────────────────────┐
│                   独立 GTK4 进程层 (ding.js)                     │
│  ding.js ──── Adw.Application                                   │
│  ├── desktopManager.js ──── 桌面管理器（核心，大幅重构）           │
│  │   ├── ThemeManager       ── accent color / 暗色模式          │
│  │   ├── FileOperations     ── 文件操作封装                      │
│  │   ├── SortManager        ── 排序/堆叠逻辑                    │
│  │   ├── FileChangesQueue   ── 增量更新队列                     │
│  │   ├── desktopGrid.js ──── 网格渲染（每块屏幕一个）             │
│  │   │   └── PaintContainer ── 橡皮筋选择 / 拖放高亮绘制         │
│  │   ├── fileItem.js ──── 图标项                                 │
│  │   ├── desktopIconItem.js ── 图标基础类                         │
│  │   ├── desktopMenu.js ──── 右键菜单                            │
│  │   ├── fileItemMenu.js ─── 图标菜单                            │
│  │   ├── thumbnails.js ──── 缩略图加载                           │
│  │   └── autoAr.js ──── 自动归档                                │
│  ├── dbusUtils.js ──── D-Bus 工具集                              │
│  ├── preferences.js ──── 设置管理                                │
│  ├── dndClipboardUtils.js ── 拖放剪贴板工具                       │
│  └── signalManager.js ─── 信号管理器                             │
└─────────────────────────────────────────────────────────────────┘
```

---

## 三、启动流程

### 阶段 1：扩展加载

```
GNOME Shell 启用扩展
  └─→ extension.js: DING.constructor()
       ├─→ doKillAllOldDesktopProcesses()   // 杀死残留进程
       ├─→ new GnomeShellOverride()         // icookie 新增：概览动画注入器
       └─→ 初始化 data 对象
```

`constructor()` 中会扫描 `/proc` 查找旧的 `ding.js` 进程并 kill 掉，防止 GNOME Shell 重启后出现多个桌面管理进程。icookie 分支在此处还创建了 `gnomeShellOverride` 实例用于注入概览动画逻辑。

### 阶段 2：扩展启用

```
enable()
  ├─→ new EmulateX11WindowType()            // 窗口类型模拟管理器
  ├─→ new VisibleArea()                     // 可用区域计算器
  └─→ 判断 Shell 是否启动完成：
       ├─→ 未启动 → 连接 'startup-complete' 信号等待
       └─→ 已启动 → 直接调用 innerEnable()
```

### 阶段 3：innerEnable() —— 核心初始化

```
innerEnable()
  ├─→ x11Manager.enable()
  │   └─→ 连接 window_manager 'map' / 'destroy' 信号
  │       连接 Main.overview 'hiding' 信号
  │
  ├─→ gnomeShellOverride.enable()           // icookie 新增
  │   └─→ InjectionManager.overrideMethod(WorkspaceBackground, '_init')
  │       注入 Clutter.Clone + DesktopLayout 实现概览动画
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
  └─→ LaunchSubprocess.spawnv(['gjs', 'app/ding.js', '-E', '-P', <path>])
       ├─→ Meta.WaylandClient.new_subprocess()   // Wayland 子进程协议
       ├─→ 连接 stdout/stderr，日志输出到 journal
       ├─→ 启动 6 秒超时定时器（防止卡死）
       └─→ wait_async 监控进程退出
            └─→ 进程退出 → doRelaunch() 自动重启
```

---

## 四、GNOME Shell 扩展层的职责

### 4.1 窗口管理 (emulateX11WindowType.js)

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

### 4.2 可用区域计算 (visibleArea.js)

计算每个显示器上可用于放置图标的区域，考虑：
- Top panel 高度
- 其他扩展声明的边距（通过 `DesktopIconsUsableArea` 接口）
- 工作区边界

其他扩展可以通过 `desktopIconsIntegration.js` 中的 `DesktopIconsUsableAreaClass` 注册自己的边距需求。

### 4.3 Overview 动画注入 (gnomeShellOverride.js) — icookie 新增

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
  ├─→ 大量 console.log debug 日志（用于排查显示器切换问题）
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

### 5.2 DesktopManager 核心流程 (desktopManager.js) — icookie 重构

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
  ├─→ _sortManager = SortManager(this)       // 排序/堆叠逻辑
  │   └─→ doSorts() / doStacks()
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
  └─→ stackInitialCoordinates               // icookie: 堆叠初始状态保存
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
             ├─→ keep-stacked → doStacks()     // icookie: SortManager.doStacks()
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

### 5.4 DesktopGrid 网格系统 (desktopGrid.js) — icookie 重构

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

### 5.5 FileItem 图标项 (fileItem.js + desktopIconItem.js)

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
       └─→ 子进程 fallback（createThumbnail.js）

icookie 修复：图片缩略图尺寸不超过 icon_size（防止容器撑宽）
```

### 5.7 ThemeManager (icookie 新增模块)

```
ThemeManager
  ├─→ connectAccentColorHandler(handler)
  │   └─→ Adw.StyleManager::notify(accent-color/rgba) → handler()
  │       icookie: handler 被包装在 GLib.idle_add 中（修复竞态）
  │
  ├─→ configureSelectionColor()
  │   ├─→ accentColorsAvailable ? get_accent_color_rgba() : lookup('accent_bg_color')
  │   └─→ Gtk.CssProvider → @define-color desktop_icons_bg_color
  │       icookie: 修复 Gtk 4.9 load_from_data API 兼容（-1 vs NULL）
  │
  └─→ checkApplyDarkModeSetting()        // 暗色模式同步
```

### 5.8 SortManager (icookie 新增模块)

从 `desktopManager.js` 抽离，处理所有排序和堆叠逻辑：

```
SortManager
  ├─→ doSorts(cleargrids)                 // 按名称/类型/大小/修改时间排序
  │   └─→ _sortAllFilesFromGridsByName() / BySize() / ByKind() / ...
  │       └─→ _reassignFilesToDesktop()    // 清除坐标 + 重新分配位置
  │
  ├─→ doStacks(restack)                   // icookie: 堆叠逻辑
  │   ├─→ _saveStackInitialCoordinates()   // 保存堆叠前状态 (fileName → coordinate pairs)
  │   ├─→ _sortAllFilesFromGridsByKindStacked(restack)  // 私有方法，按 contentType 分组
  │   │   └─→ unstackList 中的类型不堆叠（可展开）
  │   └─→ _restoreStackInitialCoordinates() // icookie: 取消堆叠恢复
  │       └─→ 遍历 fileName 匹配 → 恢复 savedCoordinates
  │
  ├─→ sortAllFilesFromGridsByPosition()    // 按位置排序（支持四角起始）
  └─→ onToggleStackUnstackThisTypeClicked(type)
      └─→ toggle type in Prefs.getUnstackList()
```

### 5.9 FileOperations (icookie 新增模块)

从 `desktopManager.js` 抽离，封装所有文件操作：

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
  ├─→ Action: desktopGeometry   → 传递显示器几何数据 (icookie: 大量 debug 日志)
  └─→ Action: disableTimer      → 禁用启动超时
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

icookie stacked drag icons (feature):
  └─→ multi-select → StackTopMarkerFolder + count badge overlay
```

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

### 11.1 模块化重构（4 个模块提取）
- `ThemeManager` — accent color / dark mode 管理
- `FileOperations` — 文件操作封装
- `SortManager` — 排序/堆叠逻辑
- `PaintContainer` — 自定义绘制容器

### 11.2 Overview 动画
gnomeShellOverride.js 注入 WorkspaceBackground，实现进入/退出概览时桌面图标的淡入淡出效果

### 11.3 增量更新
FileChangesQueue 替代旧的单体防抖机制，支持事件合并和出错 fallback

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
