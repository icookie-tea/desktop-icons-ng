# 内存泄漏 & 性能分析报告

## desktop-icons-ng GNOME 扩展

**最后更新：** 2026-07-28

---

## 一、高风险问题 — 内存/OS 资源泄漏

### 1.1 File Monitor 未取消

**位置：** `app/desktop-manager.js:138`、`app/templates-scripts-manager.js:51,103`、`app/file-item.js:73`

```js
// desktop-manager.js:138
this._monitorDesktopDir = this._desktopDir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);

// templates-scripts-manager.js:51
this._monitorDir = baseFolder.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);

// templates-scripts-manager.js:103（子目录，循环中创建）
let monitorDir = directory.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);

// file-item.js:73（回收站监控）
this._monitorTrashDir = this._file.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
```

`_monitorDesktopDir`、`_monitorDir`、`_monitorTrashDir` 创建后全程未调用 `cancel()`。OS 级别的 inotify/watch 描述符持续占用。`templates-scripts-manager` 中子目录 monitor 在 `_processDirectory` 循环中创建，信号通过 SignalManager 连接（`destroy()` 时信号断开），但 monitor 对象本身从未取消。

**统一编号：** [verified-bugs.md #5](.opencode/plans/verified-bugs.md)（结论：进程级资源，session 结束自动回收，暂不修复）

---

### 1.2 DesktopManager 无清理路径，大量全局信号未断开

**位置：** `app/desktop-manager.js`

至少 11 个 `obj.connect(...)` 调用不保存 handler ID（或保存了但不使用），无法断开：

| 行号 | 对象 | 信号 | 保存 ID？ |
|------|------|------|-----------|
| 94 | `_adwStyleManager` (Adw.StyleManager) | `notify` | 否 |
| 140 | `_monitorDesktopDir` (FileMonitor) | `changed` | 否 |
| 145 | `Prefs.schemaGnomeDarkSettings` (GSettings) | `changed` | 否 |
| 157 | `Prefs.desktopSettings` (GSettings) | `changed` | 是（`_settingsId`），但未使用 |
| 223 | `Prefs.gtkSettings` (GSettings) | `changed` | 否 |
| 231 | `Prefs.nautilusSettings` (GSettings) | `changed` | 否 |
| 239 | `_gtkIconTheme` (Gtk.IconTheme) | `changed` | 否 |
| 245 | `_volumeMonitor` (Gio.VolumeMonitor) | `mount-added` | 否 |
| 250 | `_volumeMonitor` (Gio.VolumeMonitor) | `mount-removed` | 否 |
| 333 | `DBusUtils.extensionControl` | `action-state-changed` | 否 |
| 338 | `DBusUtils.extensionControl` | `action-added` | 否 |

**注意：** `_dbusAdvertiseUpdate()`（行332）每次被调用时都会在 `DBusUtils.extensionControl` 上新增信号连接，如果该方法被多次调用，信号会叠加。

`DesktopManager` 没有析构/cleanup 方法，这些信号处理闭包捕获 `this`，在进程生命周期内永久驻留。

**统一编号：** [verified-bugs.md #32](.opencode/plans/verified-bugs.md)

---

### 1.3 Child Watch 永久残留

**位置：** `app/desktop-icons-util.js:190`

```js
GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, () => { });
```

每次 `trySpawn()`（启动终端、执行脚本等）都注册一个空回调的 child watch。watch ID 不保存、不清理。对于长期运行的子进程（如终端模拟器），这个 watch 条目在主循环中永久存在，每次 spawn 累积一次。

GLib 会在子进程退出时自动移除 watch source，但空回调函数对象本身仍占用堆内存直到 GC。

**统一编号：** [verified-bugs.md #43](.opencode/plans/verified-bugs.md)

---

### 1.4 DBusManager D-Bus 信号未断开

**位置：** `app/dbus-utils.js:257-271`

```js
this._dbusLocalProxy.connectSignal('NameOwnerChanged', () => { ... });
this._dbusLocalProxy.connectSignal('ActivatableServicesChanged', () => { ... });
this._dbusSystemProxy.connectSignal('NameOwnerChanged', () => { ... });
this._dbusSystemProxy.connectSignal('ActivatableServicesChanged', () => { ... });
```

`connectSignal` 走 SignalManager 路径，但 DBusManager 无 destroy 方法，这些连接在进程生命周期内永久驻留。

**统一编号：** [verified-bugs.md #33](.opencode/plans/verified-bugs.md)

---

### 1.5 ProxyManager 替换 proxy 时旧信号泄漏

**位置：** `app/dbus-utils.js:133-176`

`makeNewProxy()` 创建新 proxy 并重新连接信号：

```js
this._signalsIDs[signal] = proxy.connect(signal, this._signals[signal]);
```

旧 proxy 的 `_signalsIDs` 被直接覆盖，旧 proxy 上的信号连接从未断开。每次 proxy 重建都泄漏信号连接。

**统一编号：** [verified-bugs.md #34](.opencode/plans/verified-bugs.md)

---

### 1.6 `_pendingDropFiles` 字典可能累积条目

**位置：** `app/desktop-manager.js:285,479,1295`

文件拖放到桌面时，`_pendingDropFiles` 记录文件名到坐标的映射。匹配成功的条目在行1295被 `delete` 清除，但文件快速创建/删除或重命名时，未匹配的条目永远留在字典中。

**统一编号：** [verified-bugs.md #35](.opencode/plans/verified-bugs.md)

---

## 二、中等风险问题

### 2.1 DesktopMenu 剪贴板信号未断开

**位置：** `app/desktop-menu.js:54`

```js
clipboard.connect('changed', () => { ... });
```

全局唯一的 `GdkClipboard` 对象，信号 ID 未保存，无断开机制。

---

### 2.2 全局 Settings 信号未断开（preferences.js）

**位置：** `app/preferences.js:56`

```js
nautilusSettings.connect('changed', _onNautilusSettingsChanged);
```

模块级全局 `Gio.Settings` 对象，信号 ID 未保存。

---

### 2.3 ProxyManager 可用性信号未跟踪

**位置：** `app/dbus-utils.js:87`

```js
dbusManager.connect(inSystemBus ? 'changed-availability-system' : 'changed-availability-local', () => { ... });
```

信号 ID 未保存。`makeNewProxy()` 将旧 proxy 置 null 时，此信号仍连接在 dbusManager 上。

---

### 2.4 重复启用时信号可能叠加

**位置：** `extension.js:143-164`

`innerEnable()` 中连接 `monitorsChangedId`（行159）和 `workareasChangedId`（行164），`disable()` 中断开（行126-133）。`innerEnable()` 入口处（行144-147）会断开 `startupPreparedId`，但**不会断开** `monitorsChangedId` 和 `workareasChangedId`。若 shell 热重载导致 `innerEnable()` 多次调用，这两个信号会叠加。

---

### 2.5 CssProvider 永久驻留

**位置：** `app/desktop-manager.js:258-261`

```js
let cssProvider = new Gtk.CssProvider();
cssProvider.load_from_file(...);
Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), cssProvider, ...);
cssProvider = undefined;
```

CSS provider 添加到 display 的 style context 后引用被丢弃。GTK 内部持有引用，样式表永远无法卸载（单次加载，影响有限）。

---

### 2.6 File Enumerator 未显式关闭

**位置：** `extension.js:288`、`app/desktop-manager.js:1254`

```js
// extension.js:288
let fileEnum = procFolder.enumerate_children('standard::*', ..., null);
while ((info = fileEnum.next_file(null))) { ... }

// desktop-manager.js:1254（更严重——每次桌面刷新都创建）
let fileEnum = source.enumerate_children_finish(result);
```

遍历完成后未调用 `fileEnum.close()`。`desktop-manager.js` 中的问题更严重——每次桌面刷新（文件增删改、图标主题变化、设置变化等）都泄漏一个目录句柄。

**统一编号：** [verified-bugs.md #4](.opencode/plans/verified-bugs.md)

---

### 2.7 堆叠排序 O(n²)

**位置：** `app/desktop-manager.js:1784-1886`

`_sortAllFilesFromGridsByKindStacked` 中存在 3 对嵌套循环：

1. 行1788-1800：对每个普通文件遍历 `otherFiles` 检查 content type 是否已见过
2. 行1803-1809：对每个 `otherFiles` 遍历 `stackedFiles` 检查是否在 stack 中
3. 行1879-1886：对每个 `otherFiles` 遍历 `stackedFiles` 检查是否需要 unstack

桌面文件多时明显卡顿。100 个文件 = 最多 30000 次迭代。应使用 `Map<contentType, FileItem[]>` 索引。

**统一编号：** [verified-bugs.md #36](.opencode/plans/verified-bugs.md)

---

### 2.8 `getDistance` 全量扫描 grid status

**位置：** `app/desktop-grid.js:341-347`

```js
let isFree = false;
for (let element in this._gridStatus) {
    if (!this._gridStatus[element]) {
        isFree = true;
        break;
    }
}
```

每次调用遍历整个 `_gridStatus` 数组（rows × columns，可能数千个单元格）来判断是否还有空位。维护一个占用单元格计数器即可 O(1)。

**统一编号：** [verified-bugs.md #37](.opencode/plans/verified-bugs.md)

---

### 2.9 坐标恢复 O(n²)

**位置：** `app/desktop-manager.js:1721-1728`

```js
this._allFileList.forEach(fileItem => {
    this.stackInitialCoordinates.forEach(savedItem => {
        if (savedItem[0] == fileItem.fileName) {
            fileItem.savedCoordinates = savedItem[1];
        }
    });
});
```

嵌套 forEach，且 `savedCoordinates` setter 触发磁盘写入。应使用 `Map<fileName, coordinates>`。

**统一编号：** [verified-bugs.md #9](.opencode/plans/verified-bugs.md)

---

### 2.10 `getDesktopUniqueFileName` O(n²)

**位置：** `app/desktop-manager.js:1621-1640`

`while` 循环每次迭代调用 `fileExistsOnDesktop`，后者又 `map().includes()` 全量扫描文件列表。文件重名多时放大。应使用 `Set<fileName>` 或 `.some()`。

**统一编号：** [verified-bugs.md #38](.opencode/plans/verified-bugs.md)

---

### 2.11 `map` 滥用为 `forEach`

**位置：** `app/desktop-manager.js:952,1086,1934,2108`

4 处 `this._fileList.map(f => { ... })` 只做副作用，返回值被丢弃。每次创建无用的新数组。

**统一编号：** [verified-bugs.md #39](.opencode/plans/verified-bugs.md)

---

### 2.12 同步磁盘写入在循环中

**位置：** `app/desktop-manager.js:474-493`、`app/file-item.js:779-795,876-889`

`set_attributes_from_info` 是同步 I/O，在循环中逐个文件执行。大量文件时阻塞 UI 线程。

**统一编号：** [verified-bugs.md #40](.opencode/plans/verified-bugs.md)

---

## 三、低风险问题

### 3.1 SignalManager 数组稀疏化

**位置：** `app/signal-manager.js:52`

```js
delete this._signal_list[idx];
```

`delete` 数组元素产生空洞（sparse array），数组长度不缩减。`forEach` 跳过空洞不会崩溃，但长期运行浪费内存。每个桌面图标都是一个 SignalManager 实例。

**统一编号：** [verified-bugs.md #13](.opencode/plans/verified-bugs.md)

---

### 3.2 Cancellable 被覆盖未取消

**位置：** `app/thumbnails.js:90,116`

`this._doCancel` 每次被新 `Gio.Cancellable` 覆盖，旧的异步操作若未完成则无法再被取消。实际影响有限——缩略图生成通常很快完成。

---

### 3.3 AutoAr 定时器可能泄漏

**位置：** `app/auto-ar.js:531-534`

`_destroy()` 调用了 `this._cancellable.cancel()` 但未调用 `_removeTimer()`。若 cancellable 在 try 块完成前触发，递归 timer（`return true`）可能残留。

---

### 3.4 FileItem 异步闭包持有引用

**位置：** `app/file-item.js:295,585,829-860`

`_refreshMetadataAsync`、`_refreshTrashIcon`、`metadataTrusted` setter 中的异步回调通过闭包持有 `this`。虽有 `_destroyed` 守卫，但慢速操作期间对象无法被 GC。

---

### 3.5 `_setLabelName` 字符串拼接低效

**位置：** `app/desktop-icon-item.js:258-292`

循环内 `newText += character` 逐字符拼接字符串，每次创建新字符串对象。应改用数组 + `join('')`。

**统一编号：** [verified-bugs.md #41](.opencode/plans/verified-bugs.md)

---

### 3.6 `vfunc_snapshot` 每帧创建 RGBA 对象

**位置：** `app/desktop-grid.js:556-568`

拖拽框绘制时每帧无条件 `new Gdk.RGBA()`，GC 压力大。应缓存 RGBA 对象，仅在颜色变化时重建。

**统一编号：** [verified-bugs.md #42](.opencode/plans/verified-bugs.md)

---

### 3.7 GJS 静默吞异常

GJS 在 GTK4 signal callback 中会静默吞掉 TypeError 等异常。这意味着代码中调用未定义方法（如 `this.doUndo()`、`this._grid.receiveMotion()`）时不会崩溃、不会报错，只是"什么都不做"。这使得 bug 更难被发现和调试。

已知的受影响代码：
- `desktop-manager.js:825,828` — `doUndo()` / `_doRedo()` 未定义（死代码，因 GTK Action 已处理 Ctrl+Z）
- `desktop-icon-item.js:376` — `receiveMotion()` 未定义

**统一编号：** [verified-bugs.md #1, #3](.opencode/plans/verified-bugs.md)

---

## 四、总结

| 级别 | 数量 | 主要影响 |
|------|------|---------|
| 高风险 | 6 | OS 资源泄漏（文件 watch 描述符、child watch、D-Bus 信号），长期运行累积 |
| 中等风险 | 12 | 信号叠加、O(n²) 算法、同步 I/O 阻塞、map 滥用 |
| 低风险 | 7 | 稀疏数组、闭包引用、cancellable 覆盖、字符串拼接、RGBA 对象、GJS 吞异常 |

**根本原因：** `DesktopManager` 作为顶层核心类，缺少析构/清理生命周期。所有连接到全局单例的信号、创建的 file monitor 和系统资源在进程退出前无法释放。

**影响评估：** DING 进程生命周期通常等同于用户 session，泄漏在单次 session 内影响有限。但在长期运行的 session 中（数天至数周），file monitor 描述符、child watch 条目和信号处理闭包会持续累积，可能导致文件描述符耗尽或内存缓慢增长。

**已修复问题：** 见 [`docs/fixes.md`](fixes.md)

**详细验证状态：** 见 [`.opencode/plans/verified-bugs.md`](.opencode/plans/verified-bugs.md)

---

## 五、修复建议优先级

### 立即可做（低风险、小改动）

1. `map` → `forEach`（4 处，零风险，行级修复）
2. `delete` → `splice`（SignalManager，1 行修复）
3. `_setLabelName` 改用数组拼接
4. `fileEnum.close()` 补充到退出路径

### 中等工作量

5. 堆叠排序用 Map 替代嵌套循环
6. `getDistance` 添加占用计数器
7. `getDesktopUniqueFileName` 用 Set 替代 map+includes
8. RGBA 对象缓存

### 架构级（需设计）

9. DesktopManager 添加 destructor（清理所有信号、file monitor、D-Bus 连接）
10. ProxyManager 替换 proxy 时断开旧信号
11. DBusManager 添加 destroy 方法
