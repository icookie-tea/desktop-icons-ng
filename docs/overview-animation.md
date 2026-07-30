# Desktop Icons NG Overview 淡入淡出动画实现分析

## 概述

icookie 分支通过 `gnomeShellOverride.js` 实现了 GNOME Shell 概览模式下桌面图标的淡入淡出效果。这个功能的核心思路是**劫持 GNOME Shell 内部类的初始化流程，在壁纸层之上插入一个自定义容器来承载桌面窗口的克隆**。

---

## 一、整体架构

### 渲染管线对比

```
GNOME Shell 窗口树结构:
├── WorkspaceBackground._bin (BinLayout)
│   ├── _backgroundGroup (Meta.BackgroundGroup, z-index: -1)    ← 壁纸层
│   │   ├── backgroundActor                                      ← GNOME Shell 壁纸内容
│   │   └── desktopLayer                                         ← gnomeShellOverride 注入的容器
│   │       └── Clutter.Clone                                    ← 引用 DING GTK4 窗口
│   │
│   └── windowActor × N                                          ← 所有普通窗口（包括 DING）
```

### 桌面模式 vs 概览模式的渲染路径

**桌面模式：**
- GNOME Shell 直接渲染所有窗口 Actor → `windowActor`（DING GTK4 窗口）正常显示
- Clone opacity = 255，但在 `_backgroundGroup` 中被上层覆盖，视觉上不可见
- **用户看到的是 DING windowActor 本身**

**概览模式：**
- GNOME Shell 切换到 WorkspaceThumbnail（缩略图）渲染管线
- DESKTOP 类型的 `windowActor` 被排除在缩略图之外（通过 `_isOverviewWindow()` 过滤）
- Clone opacity = 0（淡出完成），视觉上桌面图标消失
- **用户看到的是 Clone opacity = 0 的效果**

退出概览时过程对称：Clone opacity 从 0 → 255，GNOME Shell 回到窗口 Actor 渲染管线。

---

## 二、注入机制：InjectionManager

### 2.1 为什么需要注入？

`WorkspaceBackground` 是 GNOME Shell `workspace.js` 中的内部类（每块屏幕、每个工作区都会创建一个实例），负责渲染该工作区的背景层（壁纸 + 模糊效果）。扩展无法通过公开 API 修改它——所以 DING 使用了 `InjectionManager` 来替换原型上的 `_init` 方法。

### 2.2 InjectionManager 的工作原理

```js
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js'

// 初始化注入器
this._injectionManager = new InjectionManager();

// 重写 WorkspaceBackground.prototype._init
this._injectionManager.overrideMethod(
    WorkspaceBackground.prototype, '_init',
    this._newBackgroundInit.bind(this)
);

// 扩展禁用时恢复原方法
this._injectionManager.clear();
```

`InjectionManager` 是 GNOME Shell 内部（`extensions/extension.js`）提供的机制，专门用于 patch 原生类的方法——比直接 monkey-patching `prototype` 更安全，支持清理还原。

### 2.3 为什么选择 `_init`？

GNOME Shell UI 组件遵循构造函数调用 `super()._init(...)` 做初始化的模式。重写 `_init` 可以在对象创建时注入额外逻辑，而且能拿到 `this` 引用——这正是我们需要访问 `this._monitorIndex`、`this._backgroundGroup`、`this._bgManager.backgroundActor` 的原因。

---

## 三、被劫持的 WorkspaceBackground._init

### 3.1 原始 `_init`（GNOME Shell 源码简化）

```js
_init(monitor, ...) {
    this._monitorIndex = monitor;
    // ... 创建 _backgroundGroup、_bgManager 等
}
```

### 3.2 注入后的完整版本

```js
_newBackgroundInit(originalMethod) {
    return function (...args) {
        originalMethod.call(this, ...args);   // ← 先执行原始初始化
        
        const opaque = 255;
        const transparent = 0;
        
        // Step A: 找到全局概览过渡状态机
        const overviewAdjustment = 
            Main.overview._overview._controls._stateAdjustment;

        // Step B: 收集当前显示器上的 DESKTOP 窗口
        const desktopWindows = global.get_window_actors().filter(a =>
            a.meta_window.get_window_type() === Meta.WindowType.DESKTOP &&
            _windowIsOnThisMonitor(a.meta_window, this._monitorIndex)
        );

        if (desktopWindows.length) {
            // Step C: 创建自定义容器 + Clone
            const desktopLayer = new Clutter.Actor({
                layout_manager: new DesktopLayout(),
                clip_to_allocation: true,
            });

            for (let windowActor of desktopWindows) {
                const clone = new Clutter.Clone({ source: windowActor });
                desktopLayer.add_child(clone);

                // 窗口销毁时清理 Clone
                windowActor.connectObject('destroy', () => {
                    clone.destroy();
                }, this);
            }

            // Step D: 绑定到背景层（自动同步尺寸和位置）
            const syncAll = Clutter.BindConstraint.new(
                this._bgManager.backgroundActor,
                Clutter.BindCoordinate.ALL, offset
            );
            desktopLayer.add_constraint(syncAll);

            // Step E: 监听概览过渡 → 更新透明度
            overviewAdjustment.connectObject('notify::value', () => { ... });

            // Step F: 插入到背景层之上（在壁纸和窗口之间）
            this._backgroundGroup.insert_child_above(
                desktopLayer, this._bgManager.backgroundActor
            );
        }
    };
}
```

---

## 四、Clutter.Clone —— 动画的核心载体

### 4.1 Clone 的工作原理

`Clutter.Clone` **不复制像素数据**，它只是对源 Actor 的引用。每次渲染时：
1. Clone 调用 `paint()` → 转发给 source 的 `paint()`
2. Source（DING GTK4 窗口）自己绘制图标
3. Clone 将结果渲染到 `_backgroundGroup` 的位置

**内存开销几乎为零**。

### 4.2 为什么用 Clone？

1. **不干扰 DING 窗口的正常渲染** — 窗口仍然在原来的层级渲染，Clone 只是"借"一份绘制到另一个位置
2. **自动同步** — 如果图标移动/变化，Clone 下次渲染时自动反映（因为源没变）
3. **不影响 Wayland 窗口协议** — Clone 是 Shell 内部的 Actor，不走客户端-服务端通信

### 4.3 destroy 回调

```js
windowActor.connectObject('destroy', () => {
    clone.destroy();
}, this);
```

当 DING 进程崩溃重启导致窗口重建时，旧 `windowActor` 会被销毁。Clone 必须同步清理，否则它会持有已销毁 Actor 的引用 → 内存泄漏或 crash。

---

## 五、DesktopLayout —— 自定义布局器

### 5.1 为什么需要自定义布局器？

GNOME Shell 在概览模式下渲染缩略图时，背景层会缩小（显示缩小版的壁纸）。Clone 的尺寸和位置必须按同样的比例缩放——这样才能在视觉上"跟随窗口一起飞入概览"。默认的 `BinLayout` 或 `GridLayout` 无法满足这个需求。

### 5.2 DesktopLayout 实现

```js
class DesktopLayout extends Clutter.LayoutManager {
    vfunc_get_preferred_width()   { return [0, 0]; }
    vfunc_get_preferred_height()  { return [0, 0]; }
    
    vfunc_allocate(container, box) {
        const monitorIndex = Main.layoutManager.findIndexForActor(container);
        const monitor = Main.layoutManager.monitors[monitorIndex];
        
        // 计算概览缩放比例（背景层尺寸 vs 显示器实际尺寸）
        const hscale = box.get_width() / monitor.width;
        const vscale = box.get_height() / monitor.height;

        for (const child of container) {
            const frameRect = child.get_source()?.metaWindow.get_frame_rect();
            
            // Clone 的尺寸 = 窗口原始尺寸 × 缩放比例
            childBox.set_size(
                Math.round(frameRect.width * hscale),
                Math.round(frameRect.height * vscale)
            );

            // Clone 的位置 = (窗口位置 - monitor偏移) × 缩放比例
            childBox.set_origin(
                Math.round((frameRect.x - monitor.x) * hscale),
                Math.round((frameRect.y - monitor.y) * vscale)
            );

            child.allocate(childBox);
        }
    }
}
```

### 5.3 frameRect vs get_meta_window().get_frame_rect()

`child.get_source()` 返回 `windowActor`，然后调用 `metaWindow.get_frame_rect()` 获取窗口的屏幕坐标（包括标题栏）。这是因为 Clone 需要知道源窗口在显示器上的确切位置。

---

## 六、BindConstraint —— 自动同步背景层

```js
const syncAll = Clutter.BindConstraint.new(
    this._bgManager.backgroundActor,   // 绑定目标
    Clutter.BindCoordinate.ALL,        // X/Y/宽度/高度全部绑定
    offset                             // 偏移量（0）
);
desktopLayer.add_constraint(syncAll);
```

`BindConstraint` 是 Clutter 的约束系统——它让 `desktopLayer` 的尺寸和位置始终跟随 `backgroundActor`。这样：
- 窗口切换时，背景层大小变了 → desktopLayer 自动同步
- 不需要手动监听 resize 事件

---

## 七、OverviewAdjustment —— 动画的状态机

### 7.1 OverviewAdjustment 是什么？

```js
const overviewAdjustment = Main.overview._overview._controls._stateAdjustment;
```

`Clutter.ActorScale`（_stateAdjustment 的实际类型）是一个**过渡状态机**，GNOME Shell 用它管理概览的进入/退出动画。

### 7.2 ControlsState 枚举

```js
const ControlsState = {
    HIDDEN: 0,        // 桌面模式（默认）
    WINDOW_PICKER: 1, // 窗口选择器视图
    APP_GRID: 2,      // 应用网格视图
};
```

`value` 属性的范围：
- `value ≈ 0` → HIDDEN（桌面）
- `value ≈ 1` → WINDOW_PICKER
- `value ≈ 2` → APP_GRID

### 7.3 getStateTransitionParams()

每次 `notify::value` 触发时，调用这个方法获取过渡参数：

```js
const params = overviewAdjustment.getStateTransitionParams();
// { initialState, finalState, progress, transitioning }
```

- **initialState** — 动画开始时的状态
- **finalState** — 动画结束时的目标状态
- **progress** — 0.0 → 1.0（如果 transitioning）
- **transitioning** — 是否正在过渡中

### 7.4 lerp() —— 线性插值

```js
const opaque = 255;
const transparent = 0;

if (finalState === HIDDEN)       // 退出概览 → 桌面
    desktopLayer.opacity = Util.lerp(transparent, opaque, progress);
else if (initialState === HIDDEN) // 进入概览
    desktopLayer.opacity = Util.lerp(opaque, transparent, progress);
```

`Util.lerp(a, b, t)` ≈ `a + (b - a) * t`：
- 进入概览（HIDDEN → APP_GRID）：progress 0→1，opacity 255→0（淡出）
- 退出概览（APP_GRID → HIDDEN）：progress 0→1，opacity 0→255（淡入）

### 7.5 非过渡状态的兜底

```js
} else {
    desktopLayer.opacity = overviewAdjustment.value < 0.5 ? opaque : transparent;
}
```

当动画完成、`transitioning === false` 时，直接根据当前 value 设置不透明度。

---

## 八、插入层级 —— _backgroundGroup.insert_child_above()

```js
this._backgroundGroup.insert_child_above(
    desktopLayer, this._bgManager.backgroundActor
);
```

最终渲染层级：
```
_backgroundGroup
├── backgroundActor        ← 壁纸 + 模糊效果（最底层）
└── desktopLayer           ← Clutter.Clone × N（在背景之上、内容之下）
    ├── Clutter.Clone #1   ← windowActor #1 的引用
    ├── Clutter.Clone #2   ← windowActor #2 的引用
    └── ...
```

这样桌面图标在概览中出现在壁纸上方，但不会遮挡其他窗口（因为 `_backgroundGroup` 本身就在所有窗口 Actor 之下）。

---

## 九、完整动画时序图

### 进入概览时：

```
时间轴:   0ms          100ms         200ms         300ms
         |             |             |             |
value:    0 ───────────→ 0.5 ────────→ 1.0 ────────→ 2.0
         (HIDDEN)      (过渡中)       (WINDOW_PICKER) (APP_GRID)

opacity:  255 ──────────→ ~127 ───────→ ~64 ────────→ 0
         (可见)          (半透明)      (几乎消失)     (完全透明)
```

### 退出概览时：

```
时间轴:   0ms           100ms         200ms         300ms
         |              |             |             |
value:    2 ────────────→ 1.5 ────────→ 1.0 ────────→ 0
         (APP_GRID)      (过渡中)       (WINDOW_PICKER) (HIDDEN)

opacity:   0 ────────────→ ~64 ────────→ ~127 ───────→ 255
         (透明)          (半透明)      (几乎可见)     (完全可见)
```

---

## 十、关联修复：fc84044 —— 从 per-workspace 到全局 adjustment

原始实现有一个 bug——每个 `WorkspaceBackground` 实例都连接了**自己工作区的** `_stateAdjustment`。但概览过渡是全局的，不是每块屏幕独立的。

```js
// ❌ 旧版本（bug）
const stateAdjustment = this._bgManager.backgroundActor.get_parent()._controls?._stateAdjustment;
// 每个工作区有自己的 adjustment → 重复连接、状态不同步

// ✅ icookie 修复
const overviewAdjustment = Main.overview._overview._controls._stateAdjustment;
// 全局单一 adjustment → 所有屏幕共享同一过渡状态
```

---

## 十一、为什么这套方案有效？

| 设计点 | 原因 |
|--------|------|
| InjectionManager | GNOME Shell 不暴露 API，只能 patch 原型方法 |
| Clutter.Clone | 零内存开销的引用机制，自动跟随源窗口变化 |
| BindConstraint | 无需手动监听 resize，自动同步背景层尺寸 |
| OverviewAdjustment | GNOME Shell 内部状态机，提供标准化的过渡参数 |
| Util.lerp() | 线性插值实现平滑动画（Clutter 内置 Easing） |
| _backgroundGroup 层级 | 在壁纸之上、所有窗口之下，视觉正确且不影响交互 |

## 十二、总结：桌面图标概览淡入淡出的完整流程

### 1. 扩展加载时

`extension.js constructor()` 创建 `GnomeShellOverride` → `enable()` 注入到 `WorkspaceBackground.prototype._init`。

### 2. GNOME Shell 初始化 WorkspaceBackground

每个屏幕、每个工作区的 `WorkspaceBackground` 调用 `_init()`，DING 的注入版本执行：
1. 收集当前显示器上的 DESKTOP 窗口（通过 `Meta.WindowType.DESKTOP` 过滤）
2. 为每个窗口创建 `Clutter.Clone` → 放入自定义布局器 `DesktopLayout`
3. 绑定约束 + 监听 `OverviewAdjustment::notify::value`
4. 插入到 `_backgroundGroup`（壁纸层）之上

### 3. 桌面模式渲染路径

GNOME Shell 直接渲染所有窗口 Actor → DING `windowActor` 正常显示。Clone opacity = 255，但在背景层被覆盖，视觉上不可见。**用户看到的是 DING windowActor 本身。**

### 4. 进入概览时

- GNOME Shell 切换到 WorkspaceThumbnail（缩略图）渲染管线
- DESKTOP 类型的 `windowActor` 被 `_isOverviewWindow()` 排除
- Clone opacity: 255 → 0（通过 `Util.lerp(opaque, transparent, progress)`）
- **视觉上桌面图标淡出消失**

### 5. 退出概览时

- GNOME Shell 回到窗口 Actor 渲染管线
- Clone opacity: 0 → 255（通过 `Util.lerp(transparency, opaque, progress)`）
- DING windowActor 继续正常存在且可见
- **视觉上桌面图标淡入出现**

### 关键理解点

1. **DING windowActor 全程不变** — 没有被隐藏、销毁或移动，始终在窗口树中渲染
2. **Clone 是"借"不是"复制"** — 零内存开销的引用机制
3. **动画在 Shell 侧完成** — `OverviewAdjustment` + `Util.lerp()` 都在 GNOME Shell 内部执行，不涉及 IPC 通信
4. **Clone opacity 控制视觉可见性** — 桌面模式 opacity=255（被挡住），概览模式 opacity=0（唯一可见路径）
