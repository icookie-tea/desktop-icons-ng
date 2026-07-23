# 修复日志

## 2026-07-23

### 桌面右键菜单粘贴始终不可用（Wayland 跨进程剪贴板）

**症状：**
- 从 Nautilus 复制文件后，桌面右键菜单的「粘贴」始终灰色
- `Ctrl+V` 快捷键同样无效

**根因：**
`dndClipboardUtils.js:readClipboard()` 使用 `clipboard.get_formats().contain_mime_type()` 预检剪贴板格式。Wayland 上 `GdkClipboard.get_formats()` 对**跨进程**剪贴板数据返回空/不完整，`contain_mime_type` 永远返回 `false`，跳过读取直接返回 `null`。

Nautilus 没有此问题是因为它用 GType 级别检查（`gdk_content_formats_contain_gtype`），而非 mime 字符串。

**修复：**
1. 移除 `get_formats()` 预检，直接对每种 mime type 调用 `read_async_promise`，失败走 catch
2. 连接 `GdkClipboard::changed` 信号驱动粘贴状态更新，不再等菜单打开时才检查
3. `showDesktopMenu` 从缓存同步判断粘贴状态，不再异步 `await`

**新增依赖：**
- `DesktopMenu` 构造函数连接 `Gdk.Display.get_default().get_clipboard()` 的 `changed` 信号（无断开路径，见 memory-leak-analysis.md 2.2）

| 文件 | 变更 |
|------|------|
| `app/dndClipboardUtils.js` | `readClipboard` 移除格式预检 |
| `app/desktopManager.js` | 初始化 `_clipboardFiles`/`_isCut` |
| `app/desktopMenu.js` | 信号连接、缓存状态、同步判断 |

**提交：** `08ffc31`

---

### 图片缩略图撑宽容器，圆角矩形框与相邻图标重叠

**症状：**
- 横屏截图文件（如 16:9）的选中/悬浮圆角矩形框比普通文件宽
- 相邻容器圆角矩形四边存在细微重叠

**根因：**
`_loadImageAsIcon()` 使用 `get_desired_width()`（120px）作为宽度上限计算缩略图。16:9 截图算出 `width=113`，GtkPicture 加上 CSS padding 后需要 121px，超过容器的 `size_request`（~114px）。GTK 分配更多空间给容器，CSS 背景（圆角矩形）随之变宽。

**修复：**
宽高比计算后，将缩略图缩放至 `icon_size` × `icon_size` 范围内，保持居中显示（margin 补偿）。不影响标准方形图标。

| 文件 | 变更 |
|------|------|
| `app/desktopIconItem.js` | `_loadImageAsIcon` 添加 `icon_size` 缩放约束 |

**提交：** `2d74e3e`

---

### Unhandled promise rejection 每次右键菜单

**症状：**
每次右键桌面弹出菜单，日志输出 `Gjs-WARNING: Unhandled promise rejection`，指向 `showDesktopMenu`。

**根因：**
`showDesktopMenu` 和 `_createDesktopBackgroundMenu` 标记为 `async` 但内部无任何 `await` 操作。调用链 `onPressRightButton` → `showDesktopMenu` 未处理返回的 Promise。

**修复：**
去掉两个函数的 `async` 关键字。

| 文件 | 变更 |
|------|------|
| `app/desktopMenu.js` | 移除 `async`、`await` |

**提交：** `21275a7`

---

### `this.connectSignal is not a function`

**症状：**
右键菜单打不开，日志输出 `TypeError: this.connectSignal is not a function`。

**根因：**
预存 bug。`DesktopMenu` 继承自 `MenuHelper`，后者不继承 `SignalManager`，`this.connectSignal()` 从未定义。之前被 `async` 吞入 Unhandled rejection 未暴露。

**修复：**
改用 `menuPopover.connect()` 直接连接。

| 文件 | 变更 |
|------|------|
| `app/desktopMenu.js` | `this.connectSignal` → `menuPopover.connect` |

**提交：** `603b476`

---

### 右键菜单内存持续增长

**症状：**
每次打开右键菜单，内存用量增加。长时间 session 后累积明显。

**根因：**
两层问题：
1. `closed` 回调中设 `_lastBgMenu = null`，旧 popover 引用丢失但仍在 GTK widget 树中（parent 到 grid），无法 GC
2. 试用 GTK4 不存在的 `destroy()` 方法（GTK3 API），抛异常后更多残留

**修复：**
遵循 GTK4/Nautilus 的 deferred cleanup 模式：
- `closed` 回调不做破坏性操作，只聚焦 grid
- 引用保持到下次 `showDesktopMenu` 才 unparent
- 每次打开前 unparent 旧 popover

| 文件 | 变更 |
|------|------|
| `app/desktopMenu.js` | `destroy()` → `unparent()`，closed 只聚焦 |

**提交：** `4a4568f`

---

### 剪贴板读取错误日志刷屏

**症状：**
每次剪贴板变化（复制/剪切其他应用的内容），日志输出 `Exception while reading clipboard media-type "text/uri-list": 未找到兼容传输格式`。

**根因：**
移除 `get_formats()` 预检后，每次 `changed` 信号都尝试 `read_async_promise`。剪贴板中非文件数据时抛预期错误，catch 块中 console.log 无条件输出。

**修复：**
删除 catch 块中的 console.log（外层已有错误处理）。

| 文件 | 变更 |
|------|------|
| `app/dndClipboardUtils.js` | 删除 catch 中的 console.log |

**提交：** `a09cb4b`

---

### 死代码清理

**删除：**
- `_parseClipboardText()` — 旧版 `x-special/nautilus-clipboard` 格式解析，已由 `processFileList` 替代
- `_getClipboardText()` — 未使用的辅助方法

| 文件 | 变更 |
|------|------|
| `app/desktopManager.js` | 移除两个方法 |

**提交：** `08ffc31`
