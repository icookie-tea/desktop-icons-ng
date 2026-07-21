# 桌面右键菜单修复记录 — 2026-07-21

## 问题

桌面空白处右键菜单存在两个问题：

1. **菜单弹出位置异常**：右键菜单居中出现在鼠标指针下方/上方，并带三角箭头指向鼠标位置，不符合传统右键菜单行为（出现在鼠标指针右下/右上方）。
2. **点击外部无法关闭菜单**：打开右键菜单后，hover 切换菜单项，如果最后 hover 的是一个无 submenu 的 item，点击桌面空白处无法关闭菜单。

## 参考对象

Nautilus（GNOME 文件管理器）的右键菜单行为：出现在鼠标右侧，无箭头，点击外部可正常关闭。

---

## Commit 1: `9d21641` — menu: remove arrow and align desktop context menu to mouse position

### 问题

菜单弹出位置居中且带三角箭头。

### 分析

DING 使用 `Gtk.PopoverMenu` 作为右键菜单。GTK4 的 PopoverMenu 默认居中弹出并显示箭头指向 `set_pointing_to` 指定的矩形区域。

对比 Nautilus 的代码（`nautilus-files-view.c:8232-8275`），发现 Nautilus 做了两件事来改变默认行为：

```c
gtk_popover_set_has_arrow (GTK_POPOVER (self->background_menu), FALSE);
gtk_widget_set_halign (self->background_menu, GTK_ALIGN_START);
```

- `set_has_arrow(false)` — 禁用三角箭头
- `set_halign(GTK_ALIGN_START)` — 左对齐，让菜单出现在鼠标右侧

### 修改

**`app/desktopMenu.js:152-153`**（新增两行）：

```javascript
menuPopover.set_has_arrow(false);
menuPopover.set_halign(Gtk.Align.START);
```

---

## Commit 2: `9d00d49` — menu: fix desktop context menu grab and close behavior

### 问题

点击桌面空白处无法关闭右键菜单，但仅在特定条件下复现：

- 首次 hover 无 submenu 的 item → 点击外部 → **正常关闭** ✓
- hover 有 submenu 的 item（子菜单打开再关闭），然后 hover 无 submenu 的 item → 点击外部 → **无法关闭** ✗

### 深入分析

#### 1. 对比 DING 与 Nautilus 的 PopoverMenu 创建方式

| 方面 | DING（修复前） | Nautilus |
|---|---|---|
| **构造函数** | `new_from_model_full(menu, NESTED)` | `new_from_model(NULL)` 无 flags |
| **菜单 model** | 创建时直接传入 | 先创建空 popover，后 `set_menu_model()` |
| **parent 设置** | `grid.put(popover, x, y)`（通过 Gtk.Fixed 管理位置） | `gtk_widget_set_parent(popover, self)`（直接设为子 widget） |
| **pointing rect** | `width=1, height=1` | `width=0, height=0` |
| **closed 信号** | 仅清除引用 | `gtk_widget_grab_focus()` 恢复焦点 |
| **旧菜单清理** | `grid.remove()` | `gtk_widget_unparent()` |

#### 2. 根本原因：`Gtk.PopoverMenuFlags.NESTED` 导致的 grab 损坏

**关键发现**：`NESTED` flag 让子菜单在主 popover 内嵌显示（而非作为独立 popover）。当用户 hover 到有 submenu 的菜单项时，内嵌子 popover 打开，grab 从父 popover 转移到子 popover。当子菜单关闭时，grab 应该归还给父 popover，但 GTK4 在这方面存在 bug — grab 未能正确恢复。

**现象解释**：
- 首次 hover 无 submenu 的 item：NESTED 子菜单从未触发，grab 完好，GTK 的 autohide 机制正常工作
- hover submenu 后 hover 无 submenu 的 item：grab 已损坏，popover 既不会 auto-hide，也不响应外部点击
- `onPressMainButton` 中的 `unparent()` 在某些情况下因为 grab 状态异常而效果不佳

#### 3. 附加 bug：`desktopGrid.js:101` 变量名写错

```javascript
// 之前（错误）：设置的是 buttonMenuController（右键控制器）
buttonMenuController.propagation_phase = Gtk.PropagationPhase.BUBBLE;
let buttonMainController = new Gtk.GestureClick();
buttonMenuController.propagation_phase = Gtk.PropagationPhase.BUBBLE;  // ← 写错了！
```

左键控制器的 `propagation_phase` 被漏设，实际保持默认值 `TARGET` 而非 `BUBBLE`，可能影响事件传播。

### 修改

#### `app/desktopMenu.js` — `showDesktopMenu()` 方法

| 改动 | 之前 | 之后 |
|---|---|---|
| 构造函数 | `new_from_model_full(menu, Gtk.PopoverMenuFlags.NESTED)` | `new_from_model(menu)`（无 NESTED flag） |
| 旧菜单清理 | `this._lastBgMenu.grid.remove(...)` | `this._lastBgMenu.menuPopover.unparent()` + 立即置 null |
| pointing rect 大小 | `width=1, height=1` | `width=0, height=0`（对齐 Nautilus） |
| parent 设置 | `grid.put(menuPopover, x, y)` | `menuPopover.set_parent(grid)` |
| `_lastBgMenu` 结构 | `{ menuPopover, grid }` | `{ menuPopover }`（不再需要 grid 引用） |
| closed 信号 | 仅清除 `_lastBgMenu` | 增加 `menuPopover.grab_focus()` 恢复焦点 |

#### `app/desktopManager.js` — `onPressMainButton()` 方法

新增菜单清理逻辑（在 `_pressedMouseButton` 之前）：

```javascript
if (this._desktopMenu._lastBgMenu != null) {
    this._desktopMenu._lastBgMenu.menuPopover.unparent();
    this._desktopMenu._lastBgMenu = null;
}
```

#### `app/desktopGrid.js:101`

```javascript
// 修复变量名
buttonMainController.propagation_phase = Gtk.PropagationPhase.BUBBLE;
```

### 修改文件

| 文件 | 行号 | 改动 |
|---|---|---|
| `app/desktopMenu.js` | 144-169 | 整个 `showDesktopMenu()` 方法重写 |
| `app/desktopManager.js` | 657-660 | 新增 `unparent()` 清理 |
| `app/desktopGrid.js` | 101 | 变量名修正 |

---

## Commit 3: `99fcb5e` — overview: fade-in desktop icons on exit

### 问题

桌面图标在 Overview 和桌面状态切换时完全没有过渡动画，进入 Overview 时瞬间消失、退出时瞬间出现，像闪烁一样不自然。

### 原始机制

`emulateX11WindowType.js:155` 将桌面窗口设置为 `Meta.WindowType.DESKTOP`。Mutter 对该类型窗口的行为是：在进入 Overview 时隐藏、退出时显示。隐藏/显示通过 `global.window_group.visible` 统一控制。

### 深入 GNOME Shell 源码分析

#### 关键代码路径

**`layout.js:_updateVisibility()`**：
```javascript
global.window_group.visible = !this._inOverview;
```
这一行决定了所有 `window_group` 内窗口在 Overview 中的可见性。

**进入 Overview**（`overview.js:show()`）：
```
show() → layoutManager.showOverview() → window_group.visible = false → THEN 'showing' 信号
```

**退出 Overview**（`overview.js:_hideDone()`）：
```
'hiding' 信号 → animateFromOverview() → _hideDone() → window_group.visible = true
```

#### 尝试一：Overview 信号 + opacity 动画（失败）

连接到 `Main.overview.connect('showing')` / `hiding`，在信号处理函数中对桌面窗口 actor 做 opacity ease 动画。

**失败原因**：`window_group.visible` 的切换在两个方向上都**在信号之前发生**（进入时在 `showing` 之前隐藏，退出时在动画完成后才恢复）。无论怎么改 opacity，窗口的父容器 `window_group` 已经被隐藏，动画不可见。

#### 尝试二：reparent actor 到 `uiGroup`（失败）

将桌面窗口的 `Meta.WindowActor` 从 `window_group` reparent 到 `Main.layoutManager.uiGroup`（后者在 Overview 期间保持可见），然后通过 Overview 信号控制 opacity。

```javascript
global.window_group.remove_child(actor);
Main.layoutManager.uiGroup.add_child(actor);
```

**失败原因**：reparent `Meta.WindowActor` 破坏了 Mutter 的事件路由，导致 Overview 状态下桌面图标层未正确消失、阻塞了其他 UI 和应用的事件响应。

#### 最终方案：仅 fade-in（退而求其次）

通过深入分析 GNOME Shell 源码后确认：**淡出（进入 Overview）在 Mutter 架构下不可能实现**，因为 `window_group.visible = false` 在 `'showing'` 信号之前就发生了，没有任何信号可以在此之前拦截。

淡入（退出 Overview）可以通过两阶段实现：

| 阶段 | 时机 | 操作 |
|---|---|---|
| 1 | `'hiding'` 信号 | 预置所有桌面窗口 actor 的 opacity 为 0，设置 `_fadeInNeeded = true` |
| 2 | `global.window_group.notify::visible` | window_group 恢复可见（actor 当前 opacity=0，用户不可见），启动 ease 动画到 255 |

**时序图**：
```
Overview 退出动画开始
    ↓
'hiding' 信号 → opacity = 0（actor 仍在隐藏的 window_group 中）
    ↓ （Overview 动画播放中 ~250ms）
_hideDone() → hideOverview() → window_group.visible = true
    ↓
notify::visible 触发 → ease({ opacity: 255, duration: 250 })
    ↓
桌面图标平滑淡入完成
```

### 修改文件

| 文件 | 行号 | 改动 |
|---|---|---|
| `emulateX11WindowType.js` | 21 | 新增 `import Clutter from 'gi://Clutter'` |
| `emulateX11WindowType.js` | 224-226 | `enable()` 中连接 `hiding` 和 `notify::visible` 信号 |
| `emulateX11WindowType.js` | 248-255 | `disable()` 中断开新增信号 |
| `emulateX11WindowType.js` | 274-281 | 新增 `_onOverviewHiding()` — 预置 opacity 为 0 |
| `emulateX11WindowType.js` | 284-298 | 新增 `_onWindowGroupVisible()` — window_group 恢复时淡入 |

### 早期错误提交

`d70cf0b` 和其父提交之间的内容包含了尝试一（仅 Overview 信号）和尝试二（reparent actor）的代码。这些提交已被 `99fcb5e` 修正，最终方案回滚了 reparent 逻辑，仅保留淡入。
