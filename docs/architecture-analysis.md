# Desktop Icons NG (DING) 原理与流程分析

## 一、概述

Desktop Icons NG (DING, `ding@rastersoft.com`) 是一个 GNOME Shell 扩展（支持 Shell 50/51），用于在桌面上显示文件图标。其核心设计是 **Shell 扩展 + 独立 GTK4 进程** 的双层架构：GNOME Shell 扩展负责管理窗口几何和生命周期，独立的 GJS 进程负责渲染图标和处理用户交互。

---

## 二、整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    GNOME Shell 扩展层                            │
│  extension.js ──── DING 类                                      │
│  ├── emulateX11WindowType.js ── Wayland 窗口管理                 │
│  └── visibleArea.js ──── 可用区域计算                            │
├──────────── D-Bus (com.rastersoft.dingextension) ────────────────┤
┌─────────────────────────────────────────────────────────────────┐
│                   独立 GTK4 进程层 (ding.js)                     │
│  ding.js ──── Adw.Application                                   │
│  ├── desktopManager.js ──── 桌面管理器（核心）                    │
│  │   ├── desktopGrid.js ──── 网格渲染（每块屏幕一个）             │
│  │   ├── fileItem.js ──── 图标项                                 │
│  │   ├── desktopIconItem.js ── 图标基础类                         │
│  │   ├── desktopMenu.js ──── 右键菜单                            │
│  │   ├── fileItemMenu.js ─── 图标菜单                            │
│  │   ├── thumbnails.js ──── 缩略图加载                           │
│  │   └── autoAr.js ──── 自动归档                                │
│  ├── dbusUtils.js ──── D-Bus 工具集                              │
│  ├── preferences.js ──── 设置管理                                │
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
       └─→ 初始化 data 对象
```

`constructor()` 中会扫描 `/proc` 查找旧的 `ding.js` 进程并 kill 掉，防止 GNOME Shell 重启后出现多个桌面管理进程。

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

### 4.3 几何数据传递

```
extension.js: getDesktopGeometry()
  └─→ 为每个显示器收集：
       { x, y, width, height, scaleFactor, marginTop, marginBottom,
         marginLeft, marginRight, monitorIndex, primaryMonitor }
  └─→ 通过 D-Bus Action 'desktopGeometry' 传递给子进程
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

### 5.2 DesktopManager 核心流程 (desktopManager.js)

```
DesktopManager.constructor()
  ├─→ 检测显示环境 (X11/Wayland)
  ├─→ 初始化样式（accent color, CSS provider）
  ├─→ 创建文件目录监控器 (_monitorDesktopDir)
  ├─→ 连接大量信号：
  │   ├─→ 设置变更（DING 自身、GTK、Nautilus、暗色模式）
  │   ├─→ 图标主题变更
  │   ├─→ 卷挂载/卸载
  │   └─→ D-Bus 几何更新
  ├─→ _createGridWindows()                  // 为每块屏幕创建 DesktopGrid
  ├─→ _dbusAdvertiseUpdate()                // 监听 D-Bus 几何变更
  └─→ _updateDesktop()                      // 首次加载桌面文件
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
            ├─→ keep-stacked → doStacks()     // 按类型堆叠
            ├─→ keep-arranged → doSorts()     // 排序排列
            └─→ 默认 → _addFilesToDesktop()   // 保留用户位置

_updateDesktopIfChanged()                     // 文件监控回调
  └─→ 过滤无效事件 → 触发 _updateDesktop()
```

**防抖机制：** 如果文件监控在短时间内触发多次变更，`_updateDesktop()` 内部有 `while(true)` 循环等待文件系统稳定，最长等待 1 秒后强制刷新。

### 5.4 DesktopGrid 网格系统 (desktopGrid.js)

每个显示器对应一个 `DesktopGrid` 实例：

```
DesktopGrid
  ├─→ Gtk.ApplicationWindow（无边框、透明背景）
  ├─→ Gtk.Fixed 容器（图标定位）
  ├─→ PaintContainer（自定义绘制：橡皮筋选择框、拖放高亮）
  ├─→ 网格状态 (_gridStatus[x][y])
  └─→ 事件控制器：
       ├─→ GestureClick（左键/右键）
       ├─→ EventControllerMotion（鼠标移动/橡皮筋）
       ├─→ EventControllerKey（键盘导航）
       └─→ DropTargetAsync（拖放目标）
```

网格计算：
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
```

### 5.6 缩略图系统 (thumbnails.js)

```
ThumbnailLoader
  ├─→ _thumbList 队列（异步处理）
  ├─→ _launchNewBuild() 逐个处理队列
  └─→ 两种生成模式：
       ├─→ GnomeDesktop.DesktopThumbnailFactory（优先，异步）
       └─→ 子进程 fallback（createThumbnail.js）
```

---

## 六、D-Bus 通信

### 6.1 扩展 → 子进程

```
D-Bus name: com.rastersoft.dingextension
  ├─→ Action: desktopGeometry   → 传递显示器几何数据
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
       └─→ 更新 selectionRectangle → 判断图标是否在框内 → 选中/取消

鼠标左键释放
  └─→ onReleaseMainButton()
       └─→ 结束橡皮筋 → 重绘网格
```

### 7.2 图标拖放

```
onDragBegin(item)
  └─→ 记录拖拽起始图标

onDragMotion(x, y)
  └─→ 计算偏移量 → 刷新所有网格的拖放高亮

onDragDataReceived(dropInfo, x, y)
  ├─→ DING_ICON_LIST → 移动图标（内部重排）
  ├─→ URI_LIST → 移动/复制文件到桌面（通过 Nautilus D-Bus）
  └─→ TEXT_PLAIN → 检测 URL/文本 → 创建文件
```

### 7.3 键盘导航

```
方向键 → 在图标间移动焦点（最近邻搜索）
Ctrl+A → 全选
Ctrl+Space → 切换当前焦点图标选中
Ctrl+Z/Shift+Ctrl+Z → 撤销/重做
F2 → 重命名
Enter → 打开
F5 → 刷新
输入字母 → 按名称搜索
```

---

## 八、数据持久化

图标位置存储在文件元数据属性中：
```
metadata::nautilus-icon-position → "x,y" 坐标
metadata::nautilus-drop-position → 临时放置坐标
```

桌面刷新时读取这些属性恢复图标位置。如果文件没有保存坐标，则自动分配空位。

---

## 九、进程生命周期管理

```
正常关闭：
  └─→ disable() → killCurrentProcess() → SIGTERM 子进程

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
| 防抖更新 | 监控器 + 1 秒超时强制刷新 | 避免大量文件操作时频繁重建桌面 |
| 信号管理 | SignalManager 封装 | 统一连接/断开，减少泄漏 |
