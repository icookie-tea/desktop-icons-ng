# 内存泄漏分析报告

## desktop-icons-ng GNOME 扩展

---

## 一、高风险问题

### 1.1 File Monitor 未取消

**位置：** `app/desktopManager.js:136-138`

```js
this._monitorDesktopDir = this._desktopDir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
this._monitorDesktopDir.set_rate_limit(1000);
this._monitorDesktopDir.connect('changed', ...);
```

`_monitorDesktopDir` 创建后全程未调用 `cancel()`，桌面目录的文件监控句柄永久持有，OS 级别的 inotify/watch 描述符持续占用。

---

### 1.2 DesktopManager 无清理路径，大量单例信号未断开

**位置：** `app/desktopManager.js:92-97, 143-149, 221-252, 331-342`

多个信号连接到全局/单例对象，信号 ID 未保存或保存后也未断开：

| 行号 | 对象 | 信号 |
|------|------|------|
| 92-97 | `Adw.StyleManager.get_default()` | `notify` |
| 143 | `Prefs.schemaGnomeDarkSettings` (GSettings) | `changed` |
| 221 | `Prefs.gtkSettings` (GSettings) | `changed` |
| 229 | `Prefs.nautilusSettings` (GSettings) | `changed` |
| 237 | `Gtk.IconTheme.get_for_display()` | `changed` |
| 243-248 | `Gio.VolumeMonitor.get()` | `mount-added` / `mount-removed` |
| 331-342 | `DBusUtils.extensionControl` | `action-state-changed` / `action-added` |

`DesktopManager` 没有析构/cleanup 方法，这些信号处理函数在进程生命周期内永久驻留。

---

### 1.3 子目录 File Monitor 未取消

**位置：** `app/templatesScriptsManager.js:51-57, 103-107`

```js
// 主目录 monitor
this._monitorDir = baseFolder.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);

// 子目录 monitor（在 _processDirectory 中）
let monitorDir = directory.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
```

信号通过 SignalManager 连接，`destroy()` 时信号会被断开，但 `monitorDir.cancel()` 从未调用。File monitor 对象本身和 OS 文件 watch 资源持续占用。

---

### 1.4 Child Watch 永久残留

**位置：** `app/desktopIconsUtil.js:188-191`

```js
GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, () => { });
```

每次 `trySpawn()`（启动终端、执行脚本等）都注册一个空回调的 child watch。watch ID 不保存、不清理。对于长期运行的子进程（如终端模拟器），这个 watch 条目在主循环中永久存在，每次 spawn 累积一次。

---

## 二、中等风险问题

### 2.1 ProxyManager 信号未跟踪

**位置：** `app/dbusUtils.js:87`

```js
dbusManager.connect(inSystemBus ? 'changed-availability-system' : 'changed-availability-local', () => { ... });
```

信号 ID 未保存。且 `makeNewProxy()` 将旧 proxy 置 null 时，此信号仍连接在 dbusManager 上。

---

### 2.2 DesktopMenu 剪贴板信号未断开

**位置：** `app/desktopMenu.js:54`

```js
let clipboard = Gdk.Display.get_default().get_clipboard();
clipboard.connect('changed', () => { ... });
```

全局唯一的 `GdkClipboard` 对象，每次剪贴板变化触发回调。信号 ID 未保存，无断开机制。该信号在 DesktopManager 生命周期内永久驻留（同类问题见 1.2）。

---

### 2.3 DBusManager 与全局 proxy 变量未清理

**位置：** `app/dbusUtils.js:233-285, 30-36`

模块级全局变量持有 D-Bus proxy 和 action group，`init()` 创建后无销毁路径：

- `NautilusFileOperations2`
- `FreeDesktopFileManager`
- `GnomeNautilusPreview`
- `SwitcherooControl`
- `GnomeArchiveManager`
- `GtkVfsMetadata`
- `extensionControl`

DBusManager 内部的 `_dbusSystemProxy`、`_dbusLocalProxy`、`_notifyProxy` 及它们的信号连接同样无法清理。

---

### 2.4 重复启用时信号可能叠加

**位置：** `extension.js:149-154`

`monitorsChangedId` 和 `workareasChangedId` 在 `innerEnable()` 中连接，仅在 `disable()` 中断开。若 shell 热重载导致 `innerEnable()` 多次调用，旧信号 ID 可能被覆盖前未清理，产生重复的信号处理函数。

---

### 2.5 全局 Settings 信号未断开

**位置：** `app/preferences.js:56`

```js
nautilusSettings.connect('changed', _onNautilusSettingsChanged);
```

模块级全局 `Gio.Settings` 对象，信号 ID 未保存，无断开机制。

---

### 2.6 CssProvider 永久驻留

**位置：** `app/desktopManager.js:256-258`

```js
let cssProvider = new Gtk.CssProvider();
cssProvider.load_from_file(...);
Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), cssProvider, ...);
cssProvider = undefined;
```

CSS provider 添加到 display 的 style context 后引用被丢弃。GTK 内部持有引用，样式表永远无法卸载（单次加载，影响有限）。

---

### 2.7 File Enumerator 未显式关闭

**位置：** `extension.js:278-305`

```js
let fileEnum = procFolder.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NONE, null);
while ((info = fileEnum.next_file(null))) { ... }
```

遍历完成后未调用 `fileEnum.close()`，依赖 GC 回收。

---

## 三、低风险问题

### 3.1 Cancellable 被覆盖未取消

**位置：** `app/thumbnails.js:34, 90, 116`

`this._doCancel` 每次被新 `Gio.Cancellable` 覆盖，旧的异步操作若未完成则无法再被取消。

---

### 3.2 AutoAr 定时器可能泄漏

**位置：** `app/autoAr.js:357, 415, 531-533`

`_destroy()` 调用了 `this._cancellable.cancel()` 但未调用 `_removeTimer()`。若 cancellable 在 try 块完成前触发，递归 timer（`return true`）可能残留。

---

### 3.3 SignalManager 数组稀疏化

**位置：** `app/signalManager.js:48-56`

```js
delete this._signal_list[idx];
```

`delete` 数组元素产生空洞（sparse array），数组长度不缩减，长期运行浪费内存。应使用 `splice()` 替代。

---

### 3.4 FileItem 异步闭包持有引用

**位置：** `app/fileItem.js:304-327, 594-612, 839-860`

`_refreshMetadataAsync`、`_refreshTrashIcon`、`metadataTrusted` setter 中的异步回调通过闭包持有 `this`。虽有 `_destroyed` 守卫，但慢速操作（如网络驱动器）期间对象无法被 GC。

---

## 四、总结

| 级别 | 数量 | 主要影响 |
|------|------|---------|
| 高风险 | 4 | OS 资源泄漏（文件 watch 描述符、child watch），长期运行累积 |
| 中风险 | 7 | 全局/单例对象上的信号永久驻留，dbus 连接不清理 |
| 低风险 | 4 | 稀疏数组、闭包引用、cancellable 覆盖 |

**根本原因：** `DesktopManager` 作为顶层核心类，缺少析构/清理生命周期。所有连接到全局单例的信号、创建的 file monitor 和系统资源在进程退出前无法释放。

**影响评估：** DING 进程生命周期通常等同于用户 session，泄漏在单次 session 内影响有限。但在长期运行的 session 中（数天至数周），file monitor 描述符、child watch 条目和信号处理闭包会持续累积，可能导致文件描述符耗尽或内存缓慢增长。

---

## 五、已修复问题

### 5.1 右键菜单 Popover 泄漏（2026-07-23）

**位置：** `app/desktopMenu.js:163-189`

**症状：** 每次右键菜单打开-关闭，`Gtk.PopoverMenu` 及其子对象保留在 widget 树中（parent 到 grid），`_lastBgMenu` 引用在 `closed` 回调中被置 null 后无法再找到旧 popover。下次右键时创建新 popover，旧 popover 因 GTK parent 引用无法 GC。反复操作累积隐藏的 popover，内存持续增长。

**修复：**
- `closed` 回调不再清空 `_lastBgMenu`，保持引用直到下次打开菜单
- 每次打开菜单前 unparent 旧 popover → 触发 widget 树销毁
- 遵循 GTK4/Nautilus 的 deferred cleanup 模式：`closed` 中不做破坏性操作，延迟到下次 show 时清理

**变更：** `commit 4a4568f`

### 5.2 DesktopMenu `connectSignal` 预存 bug（2026-07-23）

**位置：** `app/desktopMenu.js:184`

**症状：** `DesktopMenu` 继承自 `MenuHelper`，后者不继承 `SignalManager`，`this.connectSignal()` 一直未定义。因 `showDesktopMenu` 是 `async`，异常被吞入 Unhandled promise rejection 未暴露。移除多余 `async` 后 TypeError 显现。

**修复：** 改用 `menuPopover.connect()` 替代 `this.connectSignal()`。

**变更：** `commit 603b476`

### 5.3 移除此不必要的 `async`（2026-07-23）

**位置：** `app/desktopMenu.js:163, 221`

**症状：** `showDesktopMenu` 和 `_createDesktopBackgroundMenu` 标记为 `async` 但内部无 await 操作，调用链产生未捕获 Promise rejection。

**修复：** 移除 `async` 关键字。

**变更：** `commit 21275a7`

### 5.4 移除 `readClipboard` 多余日志（2026-07-23）

**位置：** `app/dndClipboardUtils.js:58-60`

**症状：** 移除 `get_formats()` 预检后，每次剪贴板变化都尝试读取两种格式。非文件数据时 `read_async_promise` 抛出预期内的错误，但被 console.log 输出，频繁刷屏。

**修复：** 删除 catch 块中的 console.log。

**变更：** `commit a09cb4b`

### 5.5 图片缩略图撑宽容器（2026-07-23）

**位置：** `app/desktopIconItem.js:556-560`

**症状：** `_loadImageAsIcon` 使用 `get_desired_width()`（120px 或更大）作为缩略图宽度上限。横屏图片（如 16:9 截图）的缩略图渲染为 113×64，GtkPicture 加上 CSS padding 后需要 121px，超过容器的 size_request（≈114px），导致容器撑宽、相邻图标圆角矩形重叠。

**修复：** 完成宽高比计算后，将缩略图缩放至 `icon_size` × `icon_size` 范围内，保持居中显示。

**变更：** `commit 2d74e3e`
