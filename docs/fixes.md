# 修复日志

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

---

## 2026-07-28 (Code Quality)

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

### 拖拽文本到桌面：对齐 Nautilus 行为

**症状：**
- 从文本编辑器拖拽文本到桌面完全不工作（journal log: `Unknown mime type for DnD: text/plain;charset=utf-8`）
- 拖拽文本生成的文件名包含乱码（`Date().valueOf()` 返回字符串而非时间戳）
- URL 被生成 `.html` 自跳转文件，与 Nautilus 行为不一致
- 中文文本和 URL 中的 `/`、`:` 等字符导致文件名非法，文件写入失败，桌面出现空图标框
- 多次拖拽相同内容会覆盖已有文件

**根因：**
- `text/plain;charset=utf-8` mimetype 在 DnD switch 中未处理
- `Date()` 不带 `new` 返回字符串，`.valueOf()` 对字符串返回自身
- JS `\w` 不匹配中文字符，文件名截断逻辑失效
- 目标目录硬编码 `DIRECTORY_DESKTOP` 而非 `getDesktopDir()`

**参考：** Nautilus `src/nautilus-files-view-dnd.c:get_drop_filename()`

**修复：**
- DnD switch 增加 `TEXT_PLAIN` / `TEXT_PLAIN_UTF8` case
- 删除 URL→`.html` 逻辑，统一生成 `.txt` 文件
- 文件名生成：flatten 多行文本 → 截断64字符 → 清理所有非法文件名字符 → 合并连续 `-` → 加 `.txt`
- 复用 `getDesktopUniqueFileName()` 防止文件覆盖
- 目标目录统一使用 `getDesktopDir()`
- 删除死代码：`detectURLorText()`、`writeURLlinktoDesktop()`、`writeHTMLTypeLink()`、`writeTextFileToDesktop()`

| 文件 | 变更 |
|------|------|
| `app/dndClipboardUtils.js` | DnD switch 增加文本处理、const→let |
| `app/desktopManager.js` | 删除3个旧方法、新增 `_writeDroppedText()` |
| `app/desktopIconsUtil.js` | `generateDropFilename()` + `writeDroppedTextFile()` |

**提交：** `3525695` / `32dcd0a`

---

### 暗色模式废弃 API 替换

**症状：** 无（当前 GTK4 仍能运行）

**根因：** `Gdk.Screen.get_default()` 在 GTK4 已废弃，被 try-catch 包裹静默处理。未来 GTK 版本移除此 API 后，暗色模式设置将失效。

**修复：** 替换为 `Gtk.Settings.get_default()`

| 文件 | 变更 |
|------|------|
| `app/desktopManager.js` | `Gtk.Settings.get_for_screen(Gdk.Screen.get_default())` → `Gtk.Settings.get_default()` |

**提交：** `d1ad154`

---

### 空 catch 块补充注释

**症状：** 无（行为正确，仅代码可读性问题）

**根因：** 两处 `set_attributes_from_info()` 的 `catch (e) { }` 缺少注释，维护者不清楚为何静默吞掉错误。

**修复：** 添加注释说明静默处理的合理性（文件可能已被删除或文件系统不支持元数据属性）

| 文件 | 变更 |
|------|------|
| `app/desktopManager.js` | `clearFileCoordinates()` catch 块 |
| `app/desktopIconsUtil.js` | `writeDroppedTextFile()` catch 块 |

**提交：** `7f79582`

---

## 2026-07-30

### 切换主屏后新图标出现在错误显示器

**症状：**
- 双屏（笔记本 + 外接显示器）在 GNOME 控制中心切换主屏后，新创建的桌面图标（无 savedCoordinates）出现在旧主屏而非新主屏
- 已有坐标的图标不受影响（PHASE1 正确恢复）

**根因（3 个 Bug 级联）：**

**Bug 1 — `updateGridWindows` 提前返回不更新 `_primaryScreen`** (`desktopManager.js:389-391`)
- 主屏切换时 `primaryIndex` 改变但显示器几何/分辨率不变
- `updateGridWindows` 检测到 `gridschanged.length == 0` 直接 return，跳过 `_primaryScreen` 更新
- `_primaryScreen` 仍指向旧 `_desktopList` 中的旧 primaryIndex ⇒ 新图标使用错误的显示器坐标
- 之前被掩盖：随后 GNOME 移动 panel 触发 margins 变化，第二次 `updateGridWindows` 走完整路径才修复

**Bug 2 — `_addSingleFileToDesktop` fallback 跳过坐标归属判断** (`desktopManager.js:1689-1694`)
- fallback 循环只检查 `getDistance(x, y) !== -1`（任意有空位的桌面）
- 未如 `_addFilesToDesktop` PHASE3 一样先检查 `=== 0`（坐标属于该桌面）
- 即使 `_primaryScreen` 正确指向主屏，新图标仍被第一个有空位的 desktop 截获（遍历顺序是 [mon0, mon1] ⇒ 总是 mon0）

**Bug 3 — Fallback 锚点是显示器左上角而非 grid 左上角** (`desktopManager.js:1469-1471, 1687-1688`)
- `_primaryScreen.x/y` = 显示器左上角
- `gridGlobalRectangle` 起点 = `monitor.x + windowMarginLeft, monitor.y + windowMarginTop`
- 当主屏有 panel（marginTop=32），锚点 `(monitor.x, monitor.y)` 落在 grid 矩形上方 ⇒ 不属于任何 grid ⇒ fallback 失效

**附加 — `getDistance` 距离计算公式笔误** (`desktopGrid.js:354`)
- `Math.pow(x - (...), 2) + Math.pow(x - (...), 2)` 第二个 `x` 应为 `y`
- 不影响 `=== 0` 和 `!== -1` 判断，但影响 PHASE2 最近桌面计算精度

**修复：**

| Bug | 文件 | 变更 |
|-----|------|------|
| Bug 1 | `desktopManager.js:407-414` | early return 前更新 `_primaryScreen` |
| Bug 2 | `desktopManager.js:1738-1753` | fallback 先 `=== 0` 再 `!== -1` |
| Bug 3 | `desktopManager.js:1470-1477, 1743-1750` | 改用 `_desktops.find(g => g._monitor === ...)` 取 grid 实例的 `_x/_y` |
| 笔误 | `desktopGrid.js:357` | `Math.pow(x → y)` |

**提交：** `ecb8791`

---

## 2026-07-30

### 清理 primaryMonitor 调试日志

移除 `ecb8791` 中为诊断主屏切换问题引入的 `console.log` 调试语句，共 35 行。同时移除因日志引入的冗余变量。

| 文件 | 变更 |
|------|------|
| `app/desktopManager.js` | 移除 32 处 `console.log`，移除 `changed`/`isPrimary` 冗余变量 |
| `app/desktopGrid.js` | 移除 3 处 `console.log`，`belong` 变量内联回直接调用 |

### 文件夹自投导致 Nautilus 报错

**症状：**
- 拖拽桌面文件夹图标放回自身位置时，Nautilus 弹出"无法将文件夹移入自身"错误
- 多选文件夹 A、B 后拖拽 A，光标经过 B 时松开鼠标：B 触发自投，A 和 B 都被移入 B 自身
- 拖拽选中文件夹经过另一个选中的文件夹时，路由到 grid 的代码路径调用未定义方法 `receiveMotion()`
- 拖拽已被选中的文件夹时，原位置图标选中效果消失

**根因（3 个 Bug）：**

**Bug 1 — 文件夹 DropTarget 自投检测不完整：**
- `drop` 和 `drag-motion` handler 中的 self-drop 守卫只比较 `dragItem.uri === this._file.get_uri()`，多选时拖拽发起者 A 的 URI ≠ B 的 URI，B 不被识别为自投
- 正确逻辑：检测该文件夹**是否是被拖拽选择的一部分**（`_isSelected && dragItem !== null`）

**Bug 2 — `receiveMotion()` 未定义：**
- `desktopIconItem.js:376` 调用 `this._grid.receiveMotion()`，该方法在 `DesktopGrid` 中不存在
- GJS 静默吞掉 TypeError，路由到 grid 的高亮和 drop 均失效

**Bug 3 — `unHighLightDropTarget` 错误移除选中状态：**
- `drag-leave` 触发 `unHighLightDropTarget()`，无条件删除 `desktop-icons-selected` CSS 类
- 对于实际已被选中的图标，这错误地去掉了选中效果，区分不了"CSS 类因选中而加"还是"因拖拽高亮而加"

**修复：**

| Bug | 文件 | 变更 |
|-----|------|------|
| Bug 1 | `app/fileItem.js:544, 561` | self-drop 检测从 URI 比较改为 `_isSelected && dragItem !== null` |
| Bug 2 | `app/desktopIconItem.js:376` | `receiveMotion()` → `refreshDrag()` |
| Bug 3 | `app/desktopIconItem.js:391` | `unHighLightDropTarget` 删除 CSS 类前加 `!_isSelected` 守卫 |

### 拖拽图标缺少跟随鼠标的图标

**症状：**
- 拖拽桌面图标时，鼠标指针旁只显示 GTK 默认的"文本文件"光标，用户无法感知拖动的是哪个文件

**根因：**
- `_setDragSource()` 中 `drag-begin` 信号未调用 `gtk_drag_source_set_icon()`

**修复：**

| 文件 | 变更 |
|------|------|
| `app/desktopIconItem.js:448-456` | 在 `drag-begin` 中获取 `Gtk.Picture` 的 `GdkPaintable`，调用 `set_icon()` 设置跟随鼠标的图标 |

### 多选拖拽预览：堆叠图标 + 数量徽章

**症状：**
- 多选拖拽时鼠标旁只显示一个图标，用户不知道还拖了其他文件

**修复：**
- 新增 `_createDragIcon()` 方法，多选时使用 `Gtk.Snapshot` 合成堆叠图标
- 最多堆叠 4 个图标，垂直偏移根据数量调整（2个=10px，3个=6px，4个+=4px）
- 水平方向交替偏移 ±6px 形成错落效果
- 右下角绘制圆形深色徽章（20px），白色字体显示总数
- 拖拽发起者的图标始终在最上层

| 文件 | 变更 |
|------|------|
| `app/desktopIconItem.js` | 新增 `_createDragIcon()` 方法，依赖 `Gsk`/`Graphene`/`Pango` |
