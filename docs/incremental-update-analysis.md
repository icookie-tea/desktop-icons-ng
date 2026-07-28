# DING 桌面全量更新重构分析

## desktop-icons-ng GNOME Shell Extension

**创建日期：** 2026-07-28
**状态：** 待重构

---

## 一、现状分析

### 1.1 当前更新流程

DING 对桌面文件变动的响应是**全量重建**：

```
文件监控事件 (任何类型)
  └─→ _updateDesktopIfChanged()        [desktopManager.js:1475]
        └─→ _updateDesktop()             [desktopManager.js:1188]
              ├─→ _readingDesktopFiles 锁
              ├─→ _doReadAsync()         [desktopManager.js:1240]
              │     ├─→ enumerate_children_async()  全量枚举
              │     ├─→ 对每个文件创建 FileItem 对象
              │     └─→ fileEnum 不关闭              ← 泄漏 (#4)
              │
              └─→ _drawDesktop()           [desktopManager.js:1320]
                    ├─→ _removeAllFilesFromGrids()  销毁全部旧图标
                    ├─→ _fileList = newList         替换列表
                    ├─→ 恢复选中状态 (includes 线性扫描)
                    ├─→ 恢复重命名弹窗 (filter 线性扫描)
                    └─→ _placeAllFilesOnGrids()     [desktopManager.js:1354]
                          ├─→ doStacks()            O(n²) 堆叠排序 ← #36
                          ├─→ doSorts()             排序 + map→forEach ← #39
                          │   └─→ sortAllFilesFromGridsByPosition()
                          │         └─→ map→forEach  ← #39
                          └─→ _addFilesToDesktop()  [desktopManager.js:1367]
                                ├─→ getDistance()   全量扫描 grid ← #37
                                └─→ getDistance x/y bug  ← #11
```

**触发路径（_updateDesktop 调用点）：**

| 触发源 | 文件 | 行号 |
|--------|------|------|
| 文件监控事件 | `desktopManager.js` | 140, 1503, 1511 |
| 设置变更（dark-text, show-emblems, show-drop-place 等） | `desktopManager.js` | 160, 167, 183, 219 |
| 显示/隐藏文件 | `desktopManager.js` | 226 |
| 缩略图设置变更 | `desktopManager.js` | 233 |
| 图标主题变更 | `desktopManager.js` | 240 |
| 挂载/卸载事件 | `desktopManager.js` | 246, 251 |
| 首选项窗口关闭 | `desktopManager.js` | 268 |
| 几何变更 | `desktopManager.js` | 388 |
| 快捷键操作 | `desktopManager.js` | 536, 862 |

### 1.2 当前保护机制

DING 有一个竞争保护机制，但**不是防抖**：

```js
// desktopManager.js:1188-1237
async _updateDesktop() {
    if (this._readingDesktopFiles) {
        // 正在读取，标记为 changed，cancel 当前操作
        this._desktopFilesChanged = true;
        if (this._desktopEnumerateCancellable && !this._forceDraw) {
            this._desktopEnumerateCancellable.cancel();
            this._desktopEnumerateCancellable = null;
        }
        return;
    }

    // ... 枚举 ...
    // 如果枚举后发现 _desktopFilesChanged 为 true，重新来过
    while (true) {
        this._desktopFilesChanged = false;
        fileList = await this._doReadAsync();
        if (!this._desktopFilesChanged) break;
        // 销毁临时创建的 FileItem
        for (let item of fileList) item._onDestroy();
        await waitDelayMs(500);
    }
}
```

**问题：** 这只是在"正在读取时又来了新事件"的情况下有效。如果 10 个文件连续快速创建，会触发 10 次 `_updateDesktop()` 调用——前 9 次发现 `_readingDesktopFiles=true` 而返回，设置 `_desktopFilesChanged=true`，第 10 次正常执行但发现 changed 为 true，重新来过。**净效果：可能做 2-3 次完整枚举，每次都创建/销毁所有 FileItem。**

### 1.3 性能影响量化

桌面有 N 个文件时，一次全量更新需要：

| 操作 | 复杂度 | 说明 |
|------|--------|------|
| 枚举桌面目录 | O(N) | 同步 next_file 循环 |
| 创建 N 个 FileItem | O(N) | 每个文件创建 GTK widget |
| 销毁 N 个旧 FileItem | O(N) | 断开信号 + 销毁 widget |
| getDistance 调用 | O(N × D × G) | N 文件 × D 屏幕 × G grid单元格 |
| 堆叠排序（如开启） | O(N²) | 3 对嵌套循环 |
| 恢复选中状态 | O(S × N) | S 选中文件数 × N 列表扫描 |
| 缩略图加载 | O(N) | 异步，但阻塞主线程部分逻辑 |

50 个文件 ≈ 200-500ms，100 个文件 ≈ 500ms-2s。

---

## 二、Nautilus 增量更新架构分析

### 2.1 整体架构

Nautilus 使用**增量更新**，架构分层如下：

```
GFileMonitor (per-directory)
  └─→ nautilus-monitor.c :: dir_changed()        # 事件分类
        └─→ nautilus-file-changes-queue           # 全局变更队列
              └─→ g_idle_add 消费                  # 防抖层 1
                    └─→ nautilus-directory         # 按目录分发
                          └─→ files_added/removed/changed 信号
                                └─→ nautilus-files-view    # 视图层
                                      └─→ adaptive debounce  # 防抖层 2
                                            └─→ view-model splice  # GTK model 批量更新
```

### 2.2 文件监控事件路由

**文件：** `nautilus-monitor.c`

```c
// 行 80-154，dir_changed 回调
case G_FILE_MONITOR_EVENT_CREATED:
    nautilus_file_changes_queue_file_added(child);
    break;
case G_FILE_MONITOR_EVENT_DELETED:
    nautilus_file_changes_queue_file_removed(child);
    break;
case G_FILE_MONITOR_EVENT_MOVED_IN:
    nautilus_file_changes_queue_file_moved_in(child, other);
    break;
case G_FILE_MONITOR_EVENT_MOVED_OUT:
    nautilus_file_changes_queue_file_moved_out(child, other);
    break;
```

每个事件被分类后推入对应的全局队列，**不是直接处理**。

### 2.3 全局变更队列（防抖层 1）

**文件：** `nautilus-file-changes-queue.c`

```c
// 行 43-58
GAsyncQueue * nautilus_file_changes_queue_get(void)

void schedule_call_consume_changes(void) {
    if (call_consume_changes_idle_id == 0) {
        call_consume_changes_idle_id = g_idle_add((GSourceFunc) call_consume_changes, NULL);
    }
}
```

关键点：
- 变更推入 `GAsyncQueue`，**不立即处理**
- `g_idle_add` 确保在 GLib 主循环 idle 时处理
- `idle_id == 0` 检查确保**只有一个消费回调在排队**（防抖）
- `consume_changes` 按类型批量处理：先处理所有 added，再处理 removed，再处理 changed

### 2.4 目录级分发

**文件：** `nautilus-directory.c`

```c
// 行 1014-1085，nautilus_directory_notify_files_added
void nautilus_directory_notify_files_added(GFile *file, ...)
{
    // 只为新增的文件创建 NautilusFile 对象
    NautilusFile *nautilus_file = nautilus_file_get(file, ...);
    // 发射 per-file 信号
    g_signal_emit(directory, directory_signals[FILES_ADDED], 0, file, nautilus_file);
}
```

**只处理受影响的文件**，不重新枚举整个目录。

### 2.5 异步 I/O 节流

**文件：** `nautilus-directory-async.c`

```c
// 行 43-46
#define DIRECTORY_LOAD_ITEMS_PER_CALLBACK 100
#define MAX_ASYNC_JOBS 10
```

- 目录枚举分批次，每次 100 项
- 全局最多 10 个并发异步 I/O job
- 超出限制时目录进入 `waiting_directories` 队列

### 2.6 自适应防抖（防抖层 2）

**文件：** `nautilus-files-view.c`

```c
// 行 82-91
#define UPDATE_INTERVAL_MIN 100      // 100ms 最小
#define UPDATE_INTERVAL_MAX 2000     // 2000ms 最大
#define UPDATE_INTERVAL_INC 250      // 每次递增 250ms
#define UPDATE_INTERVAL_TIMEOUT_INTERVAL 250
#define UPDATE_INTERVAL_RESET 1000   // 空闲 1s 后重置
```

```c
// 行 4553-4588，changes_timeout_callback
static gboolean changes_timeout_callback(gpointer user_data)
{
    // 如果变化仍在快速到来，增加间隔
    if (now - files_view->details->last_change_time < UPDATE_INTERVAL_RESET) {
        files_view->details->update_interval += UPDATE_INTERVAL_INC;
        if (files_view->details->update_interval > UPDATE_INTERVAL_MAX)
            files_view->details->update_interval = UPDATE_INTERVAL_MAX;
    } else {
        files_view->details->update_interval = UPDATE_INTERVAL_MIN;
    }
    // 调度显示待处理文件
    display_pending_files(files_view);
    // 设置下一次 timeout
    g_timeout_add(files_view->details->update_interval, ...);
    return FALSE;
}
```

**逻辑：** 文件快速变化时，刷新间隔从 100ms 逐渐增加到 2000ms，避免频繁刷新。空闲 1 秒后重置到 100ms。

### 2.7 GTK Model 批量更新

**文件：** `nautilus-view-model.c`

```c
// 行 553-601，nautilus_view_model_remove_items
void nautilus_view_model_remove_items(NautilusViewModel *self, GList *items)
{
    // 将删除操作合并为连续的 splice 范围
    // 减少 ::items-changed 信号发射次数
    g_list_store_splice(store, position, n_remove, n_add, ...);
}

// 行 611-666，nautilus_view_model_add_items
void nautilus_view_model_add_items(NautilusViewModel *self, GList *items)
{
    // 按共同父目录分组，批量添加
    // g_list_store_splice 批量插入
}
```

Nautilus 使用 `GtkListStore.splice()` 做增量更新，**只通知 GTK 变更的部分**，不需要重建整个 widget 树。

---

## 三、DING 增量更新重构方案

### 3.1 总体设计

```
现有: FileMonitor event → _updateDesktopIfChanged → 全量枚举 → 全量重建

目标: FileMonitor event → 分类入队 → 防抖 → 增量处理 → 增量更新 GTK
```

### 3.2 需要新增的组件

#### 3.2.1 FileChangesQueue（变更队列）

**职责：** 接收文件监控事件，分类入队，防抖消费。

```js
class FileChangesQueue {
    constructor() {
        this._added = [];      // 新增文件路径
        this._removed = [];    // 移除文件路径
        this._changed = [];    // 属性变更文件路径
        this._idleId = 0;      // g_idle_add ID
    }

    // 接收文件监控事件
    queueEvent(file, eventType) {
        switch (eventType) {
            case Gio.FileMonitorEvent.CREATED:
            case Gio.FileMonitorEvent.MOVED_IN:
                this._added.push(file.get_path());
                break;
            case Gio.FileMonitorEvent.DELETED:
            case Gio.FileMonitorEvent.MOVED_OUT:
                this._removed.push(file.get_path());
                break;
            case Gio.FileMonitorEvent.CHANGED:
            case Gio.FileMonitorEvent.ATTRIBUTE_CHANGED:
                this._changed.push(file.get_path());
                break;
        }
        this._scheduleConsume();
    }

    // 防抖：确保只有一个消费回调在排队
    _scheduleConsume() {
        if (this._idleId === 0) {
            this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._consume();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // 消费队列，返回变更摘要
    _consume() {
        this._idleId = 0;
        let changes = {
            added: this._added.splice(0),
            removed: this._removed.splice(0),
            changed: this._changed.splice(0),
            needsFullRefresh: this._needsFullRefresh()
        };
        return changes;
    }
}
```

**参考：** Nautilus `nautilus-file-changes-queue.c:43-305`

#### 3.2.2 AdaptiveDebounce（自适应防抖）

**职责：** 根据文件变化频率动态调整刷新间隔。

```js
class AdaptiveDebounce {
    constructor() {
        this._interval = 100;        // UPDATE_INTERVAL_MIN
        this._lastChangeTime = 0;
        this._timeoutId = 0;
    }

    scheduleUpdate(desktopManager) {
        let now = GLib.get_monotonic_time() / 1000; // ms
        if (now - this._lastChangeTime < 1000) {
            // 变化仍在快速到来，增加间隔
            this._interval = Math.min(this._interval + 250, 2000);
        } else {
            this._interval = 100;
        }
        this._lastChangeTime = now;

        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
        }
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._interval, () => {
            desktopManager._processPendingChanges();
            this._timeoutId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }
}
```

**参考：** Nautilus `nautilus-files-view.c:82-91, 4553-4588`

#### 3.2.3 增量文件对比

**职责：** 对比当前 `_fileList` 和变更队列，确定需要增/删/改的文件。

```js
_getDelta(fileChanges) {
    let added = [];
    let removed = [];
    let changed = [];

    // 处理新增
    for (let path of fileChanges.added) {
        if (!this._fileList.find(f => f.file.get_path() === path)) {
            added.push(path);
        }
    }

    // 处理删除
    for (let path of fileChanges.removed) {
        let idx = this._fileList.findIndex(f => f.file.get_path() === path);
        if (idx !== -1) {
            removed.push(this._fileList[idx]);
        }
    }

    // 处理属性变更
    for (let path of fileChanges.changed) {
        let item = this._fileList.find(f => f.file.get_path() === path);
        if (item) changed.push(item);
    }

    return { added, removed, changed };
}
```

### 3.3 需要修改的组件

#### 3.3.1 `_updateDesktopIfChanged`

**当前：** 无条件调用 `_updateDesktop()`（全量重建）

**修改为：**
1. 将事件推入 `FileChangesQueue`
2. 触发 `AdaptiveDebounce.scheduleUpdate()`
3. 仅在某些事件类型下才触发全量刷新（如挂载事件、设置变更）

```js
_updateDesktopIfChanged(file, otherFile, eventType) {
    // 过滤不相关的事件（保留现有逻辑）
    if (eventType == Gio.FileMonitorEvent.CHANGED) return;
    if (!this._showHidden && file.get_basename()[0] == '.') { ... }

    // 推入变更队列
    this._fileChangesQueue.queueEvent(file, eventType);

    // 自适应防抖触发更新
    this._adaptiveDebounce.scheduleUpdate(this);
}
```

#### 3.3.2 `_processPendingChanges`（新增方法）

**职责：** 消费变更队列，执行增量更新。

```js
async _processPendingChanges() {
    let changes = this._fileChangesQueue.consume();

    if (changes.needsFullRefresh) {
        // 某些情况下仍需全量刷新（如大量变更）
        this._updateDesktop();
        return;
    }

    let delta = this._getDelta(changes);

    // 删除移除的文件
    for (let item of delta.removed) {
        item.removeFromGrid(true);
        this._fileList.splice(this._fileList.indexOf(item), 1);
    }

    // 添加新增的文件
    for (let path of delta.added) {
        let file = Gio.File.new_for_path(path);
        let info = file.query_info(Enums.DEFAULT_ATTRIBUTES, ..., null);
        let newItem = new FileItem.FileItem(this, file, info, ..., null);
        this._fileList.push(newItem);
        this._addSingleFileToGrid(newItem);
    }

    // 更新属性变更的文件
    for (let item of delta.changed) {
        item.updateIcon();
        item._refreshMetadataAsync(false);
    }
}
```

#### 3.3.3 `_addSingleFileToGrid`（新增方法）

**职责：** 将单个文件放置到 grid 上，不重建整个 grid。

```js
_addSingleFileToGrid(fileItem, storeMode) {
    let [itemX, itemY] = fileItem.savedCoordinates;
    for (let desktop of this._desktops) {
        if (desktop.getDistance(itemX, itemY) == 0) {
            desktop.addFileItemCloseTo(fileItem, itemX, itemY, storeMode);
            return;
        }
    }
    // 如果 savedCoordinates 不在任何屏幕内，找最近的
    // ...
}
```

#### 3.3.4 设置变更处理

设置变更（图标大小、排序方式、暗色模式等）**仍然走全量刷新**，因为这些变更影响所有图标。但这部分触发频率低，不是性能瓶颈。

### 3.4 需要处理边界情况

| 场景 | 处理策略 |
|------|---------|
| 大量文件同时创建（>50） | 阈值检测，超过阈值降级为全量刷新 |
| 文件在队列消费前被删除 | 创建 FileItem 时检查 `query_exists` |
| 文件重命名（MOVED_OUT + MOVED_IN） | 变更队列中匹配路径，合并为单个 changed 事件 |
| 回收站内容变化 | 只更新回收站图标，不触发全量刷新 |
| 网络驱动器挂载/卸载 | 走全量刷新（特殊文件夹列表变化） |
| DING 进程重启 | 全量刷新（现有逻辑） |

### 3.5 涉及的已有 bug 修复

增量更新重构中需要一并修复的已有问题：

| # | 问题 | 如何修复 |
|---|------|---------|
| #4 | `fileEnum` 不关闭 | 在 `_doReadAsync` 的退出路径加 `fileEnum.close(null)` |
| #36 | 堆叠排序 O(n²) | 增量更新后只排序新增文件，不走全量排序 |
| #37 | `getDistance` 全量扫描 | 添加占用计数器 |
| #39 | `map` 滥用为 `forEach` | 改为 `forEach` |

---

## 四、工作量评估

### 4.1 新增代码量

| 组件 | 预估行数 | 复杂度 |
|------|---------|--------|
| FileChangesQueue | ~80 行 | 中 |
| AdaptiveDebounce | ~50 行 | 低 |
| `_getDelta` | ~40 行 | 中 |
| `_processPendingChanges` | ~80 行 | 高 |
| `_addSingleFileToGrid` | ~40 行 | 中 |
| 修改 `_updateDesktopIfChanged` | ~10 行 | 低 |
| 修改 `_updateDesktop` | ~20 行 | 中 |
| **合计** | **~320 行** | |

### 4.2 修改影响面

| 文件 | 修改量 |
|------|--------|
| `app/desktopManager.js` | 核心改动，约 350 行新增 + 50 行修改 |
| `app/fileItem.js` | 可能需要调整构造函数支持增量创建 |
| `app/desktopGrid.js` | `_addFileItemTo` 需支持单文件添加 |
| `app/desktopIconItem.js` | 可能不需要改动 |

### 4.3 测试策略

| 测试场景 | 验证要点 |
|---------|---------|
| 单个文件创建 | 只新增一个图标，不重建其他 |
| 单个文件删除 | 只移除一个图标，不重建其他 |
| 批量文件创建（10个） | 防抖生效，只刷新一次 |
| 批量文件创建（100个） | 降级为全量刷新 |
| 文件重命名 | 图标位置不变，只更新标签 |
| 文件属性变更 | 只更新缩略图/元数据 |
| 回收站内容变化 | 只更新回收站图标 |
| 设置变更 | 仍走全量刷新 |
| 选中状态保持 | 增量更新后选中状态不丢失 |
| 重命名弹窗保持 | 增量更新后弹窗不丢失 |

---

## 五、风险与注意事项

### 5.1 主要风险

1. **选中状态丢失** — 增量更新时需要正确维护 `_selectedFiles` 的 URI 引用
2. **缩略图加载竞争** — 新增文件的缩略图加载可能与正在进行的加载冲突
3. **Grid 状态不一致** — 增量添加/删除需要保持 `_gridStatus` 正确
4. **重命名弹窗** — `_renameWindow` 指向的文件可能在增量更新后被移除

### 5.2 渐进式实施建议

```
阶段 1: 最小改动
  - 修复 fileEnum 不关闭 (#4)
  - map → forEach (#39)
  - 添加简单的 debounce（固定 500ms，不做自适应）

阶段 2: 变更队列
  - 实现 FileChangesQueue
  - 修改 _updateDesktopIfChanged 走队列
  - 全量刷新逻辑不变，只是加防抖

阶段 3: 增量更新
  - 实现 _getDelta + _processPendingChanges
  - 实现 _addSingleFileToGrid
  - 处理边界情况

阶段 4: 性能优化
  - 堆叠排序优化 (#36)
  - getDistance 计数器优化 (#37)
  - 自适应防抖
```

---

## 六、gtk4-ding 对比分析

### 6.1 gtk4-ding 更新策略

**结论：gtk4-ding 和 DING 一样，也是全量重建策略，没有增量更新。**

gtk4-ding 将桌面文件监控逻辑抽取到了独立的 `desktopFolderMonitor.js` 模块中（DING 混在 `desktopManager.js` 里），但核心更新流程完全相同。

### 6.2 流程对比

| 阶段 | DING | gtk4-ding |
|------|------|-----------|
| 监控入口 | `_updateDesktopIfChanged()` | `_updateFileListIfChanged()` |
| 文件枚举 | `_doReadAsync()` 全量 | `_doReadAsync()` 全量 |
| 竞争保护 | `_readingDesktopFiles` + `_desktopFilesChanged` | 完全相同的机制（代码几乎一样） |
| Grid 重建 | `_removeAllFilesFromGrids()` → `_drawDesktop()` | `_removeAllFilesFromGrids()` / `_clearAllFilesFromGrids()` → `_drawDesktop()` |
| 防抖 | 无（仅竞争锁） | 无（仅竞争锁） |
| 增量操作 | 无 | 仅 `_metadataChanged` 元数据变更（行578-588） |

### 6.3 gtk4-ding 唯一的增量路径

```js
// desktopFolderMonitor.js:578-588
_metadataChanged(proxy, nameOwner, args) {
    const filepath = GLib.build_filenamev([GLib.get_home_dir(), args[1]]);
    if (this._desktopDir.get_path() === GLib.path_get_dirname(filepath)) {
        for (let fileItem of this._fileList) {
            if (fileItem.path === filepath) {
                fileItem.updatedMetadata();
                break;
            }
        }
    }
}
```

收到 D-Bus `GtkVfsMetadata::AttributeChanged` 信号后，只更新单个文件的元数据，**不触发全量刷新**。这是 gtk4-ding **唯一**的增量操作。

### 6.4 gtk4-ding 相比 DING 的优化

虽然没有增量更新，但 gtk4-ding 在几个地方做了 DING 没有的优化：

| # | 优化 | DING | gtk4-ding |
|---|------|------|-----------|
| 1 | **对象复用** | `_removeAllFilesFromGrids()` 总是销毁 | 有 `_clearAllFilesFromGrids()` 不销毁，只从 grid 移除 |
| 2 | **异步枚举** | 特殊文件夹、本地文件、挂载点串行加载 | `Promise.all` 并行加载 |
| 3 | **绘制同步** | 无等待机制 | `await fileItem.iconPlaced` 等所有图标到位 |
| 4 | **Cancellable 管理** | `_monitorDesktopDir` 无 cancel 路径 | `_monitorDesktopCancellable` 有 cancel + 自动断开信号 |
| 5 | **pending drop 模糊匹配** | 精确匹配 basename | 正则匹配 basename 前缀（应对 Nautilus 加括号后缀） |
| 6 | **模块拆分** | 所有逻辑在 `desktopManager.js` | 监控逻辑独立到 `desktopFolderMonitor.js` |
| 7 | **mount-removed 延迟** | 立即刷新 | 500ms 延迟后刷新，避免挂载移除时的竞态 |

### 6.5 `_clearAllFilesFromGrids` 对象复用

gtk4-ding 在 `_drawDesktop` 中区分了两种模式：

```js
// desktopManager.js:499-502
if (opts.initialRead)
    this._removeAllFilesFromGrids();  // 首次读取，销毁旧对象
else
    this._clearAllFilesFromGrids();   // 后续刷新，只从 grid 移除，不销毁
```

```js
// desktopManager.js:468-480
_removeAllFilesFromGrids() {
    for (let fileItem of this._displayList)
        fileItem.removeFromGrid({callOnDestroy: true});  // 销毁
    this._displayList = [];
}

_clearAllFilesFromGrids() {
    for (let fileItem of this._displayList)
        fileItem.removeFromGrid({callOnDestroy: false}); // 不销毁
    this._displayList = [];
}
```

**这是 gtk4-ding 最实用的优化**：桌面文件集合没变（比如只是修改了某个文件的属性），只需要从 grid 上移除再重新放置，不需要销毁和重建 GTK widget。DING 没有这个区分，每次都走 `removeFromGrid(true)` 销毁。

**建议：** DING 可以参考这个对象复用模式，在 `_drawDesktop` 中判断文件列表是否相同，相同时跳过销毁。

### 6.6 并行异步枚举

gtk4-ding 的 `_doReadAsync` 用 `Promise.all` 并行加载三类数据：

```js
// desktopFolderMonitor.js:515-521
await Promise.all([
    getLocalFilesInfos(),      // 本地文件
    ...extraFoldersItems,      // 特殊文件夹（Home、Trash）
    ...mountsItems,            // 挂载点
]);
```

DING 是串行的：先加载特殊文件夹，再枚举本地文件，最后加载挂载点。gtk4-ding 的并行模式可以缩短首次加载时间，尤其是网络驱动器挂载点查询慢的时候。

---

## 七、参考链接

| 资源 | 说明 |
|------|------|
| Nautilus `nautilus-monitor.c` | 文件监控事件路由 |
| Nautilus `nautilus-file-changes-queue.c` | 全局变更队列 + 防抖 |
| Nautilus `nautilus-directory-async.c` | 异步 I/O 节流 + 批量枚举 |
| Nautilus `nautilus-files-view.c:82-91,4553-4588` | 自适应防抖 |
| Nautilus `nautilus-view-model.c:553-666` | GTK model splice 批量更新 |
| gtk4-ding `desktopFolderMonitor.js` | 桌面文件监控模块 |
| gtk4-ding `desktopManager.js:468-517` | _drawDesktop + 对象复用 |
| `.opencode/plans/verified-bugs.md` | DING 已有问题清单 |
| `docs/memory-leak-analysis.md` | DING 内存泄漏分析 |
