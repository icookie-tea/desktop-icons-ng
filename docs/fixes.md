# 修复日志

## 2026-07-28

### Overview 同步过渡：Clutter.Clone + OverviewAdjustment

**症状：**
- 旧方案使用 `actor.ease()` 事后驱动淡入淡出，与 Shell 的过渡动画不同步
- HIDDEN ↔ APP_GRID 切换时桌面图标出现闪烁或延迟

**根因：**
- `window_group.visible = false` 在 `'showing'` 信号之前发生，淡出不可能实现
- 事后 `ease()` 动画与 Shell 内部过渡进度不同步

**修复：**
采用 gtk4-ding 的 Clutter.Clone 方案：
- 新增 `gnomeShellOverride.js`：覆写 `WorkspaceBackground._init`，注入桌面窗口克隆层
- 克隆层透明度由 Shell 内部 `_stateAdjustment` 驱动，帧同步淡入淡出
- 移除 `emulateX11WindowType.js` 中旧的 `_onOverviewHiding` / `_onWindowGroupVisible` 处理器
- 直接在 `OverviewAdjustment` 上监听 `notify::value`（而非 per-workspace 的 `_stateAdjustment`），覆盖所有过渡

| 文件 | 变更 |
|------|------|
| `gnomeShellOverride.js` | 新增，覆写 WorkspaceBackground |
| `emulateX11WindowType.js` | 移除旧 Overview 信号处理器 |
| `extension.js` | 集成 GnomeShellOverride 生命周期 |
| `meson.build` | 添加 gnomeShellOverride.js 到安装列表 |

**提交：** `d0f551c` / `fc84044`

---

### 代码风格统一

**修复：**
- 修复 import 语句分号与空行，统一项目代码风格

| 文件 | 变更 |
|------|------|
| `emulateX11WindowType.js` | 移除多余空行 |
| `gnomeShellOverride.js` | 统一 import 风格 |

**提交：** `b993cae`

---

## 2026-07-21

### 右键菜单弹出位置异常，带三角箭头

**症状：**
- 右键菜单居中出现在鼠标指针下方/上方，带三角箭头指向鼠标位置
- 不符合传统右键菜单行为（应出现在鼠标右侧）

**参考：** Nautilus 的右键菜单行为（出现在鼠标右侧，无箭头）

**修复：**
在 `showDesktopMenu()` 中添加：
- `menuPopover.set_has_arrow(false)` — 禁用三角箭头
- `menuPopover.set_halign(Gtk.Align.START)` — 左对齐，菜单出现在鼠标右侧

| 文件 | 变更 |
|------|------|
| `app/desktopMenu.js` | 添加箭头禁用和左对齐 |

**提交：** `9d21641`

---

### 点击外部无法关闭右键菜单（NESTED flag 导致 grab 损坏）

**症状：**
- hover 有 submenu 的 item 后，再 hover 无 submenu 的 item → 点击桌面空白处无法关闭菜单
- 首次 hover 无 submenu 的 item 时正常关闭

**根因：**
`Gtk.PopoverMenuFlags.NESTED` 让子菜单在主 popover 内嵌显示。当子菜单打开再关闭时，grab 未能正确恢复给父 popover，导致 auto-hide 机制失效。

附加 bug：`desktopGrid.js:101` 左键控制器的 `propagation_phase` 变量名写错，实际未设置。

**修复：**
- 构造函数改为 `new_from_model(menu)`（移除 NESTED flag）
- 旧菜单清理改为 `unparent()` + 立即置 null
- pointing rect 改为 `width=0, height=0`
- parent 设置改为 `menuPopover.set_parent(grid)`
- closed 信号增加 `grab_focus()` 恢复焦点
- `onPressMainButton()` 新增菜单清理逻辑
- 修正 `desktopGrid.js` 变量名

| 文件 | 变更 |
|------|------|
| `app/desktopMenu.js` | 整个 `showDesktopMenu()` 重写 |
| `app/desktopManager.js` | 新增 `unparent()` 清理 |
| `app/desktopGrid.js` | 变量名修正 |

**提交：** `9d00d49`

---

### Overview 退出时桌面图标淡入动画

**症状：**
- 桌面图标在 Overview 和桌面状态切换时无过渡动画，瞬间消失/出现

**深入分析：**
- `window_group.visible = false` 在 `'showing'` 信号之前发生，淡出不可能实现
- 尝试 reparent actor 到 `uiGroup` 破坏了 Mutter 事件路由
- 最终方案：仅实现退出时的淡入

**修复：**
通过 `'hiding'` 信号预置 opacity=0，`notify::visible` 触发时启动 ease 动画到 255。

| 文件 | 变更 |
|------|------|
| `emulateX11WindowType.js` | 新增信号连接、`_onOverviewHiding()`、`_onWindowGroupVisible()` |

**提交：** `99fcb5e`

---

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
