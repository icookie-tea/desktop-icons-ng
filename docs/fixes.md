# 修复日志

> 2026-08 及更早的条目已归档：[fixes-2026-08.md](archive/fixes-2026-08.md)、[fixes-2026-07.md](archive/fixes-2026-07.md)。

## 2026-09-07

### 性能回归：拖拽橡皮筋划选图标掉帧

**症状：** 上一提交（选中框/键盘环改由 PaintContainer 描边、图标状态变化时无条件 `queue_draw()`）后，拖拽框选图标出现可感知的卡顿/掉帧。

**根因：** 划选热路径新增了两类每帧开销：
1. `desktop-icon-item.js` `_setSelectedStatus()` 在**每次** `setSelected()/unsetSelected()` 后无条件 `grid.queue_draw()`；而橡皮筋 motion 处理器（`desktop-manager.js onMotion()`）对**每个**与选区相交的图标**每个 motion 事件**都调 `setSelected()`，已选中项也不例外。快速划过密集桌面时一次 motion 事件触发 N+1 次整幅 PaintContainer 无效化（事件频率可高达数百 Hz），拖跨主循环。
2. `PaintContainer.vfunc_snapshot()` 每帧创建 `Object.values(grid._fileItems)` 数组拷贝，且为每个已选图标各自新建 Graphene.Rect / Gsk.RoundedRect / Gsk.Stroke / Gsk.PathBuilder / Gsk.Path 并 `append_stroke`——100 个选中项约 500 次 boxed 分配 + 100 个渲染节点/帧，GC/分配器压力导致掉帧。

**修复（外观与行为完全不变）：**
1. `_setSelectedStatus()`：跟踪 CSS 类是否实际增删，仅在视觉真正变化时 `grid.queue_draw()`；已选中项的重复 `setSelected()` 不再触发无效化（样式检查本身已有 `has_css_class` 守卫）。
2. `paint-container.js`：选中框描边按颜色批量合为**一条** Gsk 路径，每色一次 `append_stroke`（普通选中/键盘选中各一条）；拖拽定位网格预览同法批量；1px/2px `Gsk.Stroke` 在构造时缓存（`append_stroke` 会拷贝进渲染节点）；填充复用单个 Graphene.Rect / Gsk.RoundedRect（`push_rounded_clip`/`append_color` 均拷贝）；`Object.values()` 拷贝改为 `for...in` 直接遍历。首帧开销从 O(选中数)×5 分配降至 O(1)——橡胶带本身仍每帧一次 `_snapshotRoundedRect`。

**验证：** `scripts/check.sh` 全绿（eslint / node --check / 13 组 202 断言 gjs 单测）。渲染热路径无单测覆盖，需真机拖拽回归对比确认流畅。

### 相邻行选中框边缘重叠：ICON_HEIGHT 未计入边框/padding

**症状：** 上下相邻两行的图标同时选中时，选中框边缘部分重叠（standard 档约 2~4px），视觉上像一个连成的高框（截图 2026-09-07 09-42-53）。四个图标尺寸档全部存在。

**根因：** 选中框即 `.file-item` 容器的 CSS 框，其实际自然高度 = 图标区（icon_size + `.icon-item` padding 4px×2）+ 两行固定标签（~36–40px + margin_bottom 2px）+ 边框 3px×2 + 内边距 1px×2（standard ≈ 118px）；而网格行距按 `enums.js` 的 `ICON_HEIGHT`（standard = 106）+ `4×elementSpacing` = 114px 起算，常量未计入边框/padding 这 ~20px 装饰，框高 > 行距即重叠。

**修复：**
1. `app/stylesheet.css`：`.file-item` border-width 3px → 2px；`.icon-item` padding 4px → 0（框高减 10px，选中背景更贴近图标）。键盘选中环复用同一 border-width，同步为 2px。
2. `app/enums.js`：`ICON_HEIGHT` 各档上调为 `icon_size + 48`（按两行标签 ~40px 上限估）：tiny 80→84、small 90→96、standard 106→112、large 138→144。行距（ICON_HEIGHT + 8）从此恒 ≥ 框高 + 8px，默认字体下标签行高需 >24px（约 +25% 字号）才可能再溢出。
3. 桌面行数几乎不变（行距每档仅 +6px）；水平方向宽度本已被 clamp 到单元宽度，无此问题，`ICON_WIDTH` 未动。

### 选中框固定为网格单元尺寸（与拖拽定位网格一致）

**反馈：** 上一修复后选中框高度虽不再重叠，但框高仍随内容自然高度变化（有些高有些低），且与行距之间的空隙偏大。用户确认目标外观：与拖拽时 PaintContainer 绘制的定位网格完全一致（同宽高、对齐单元、无缝平铺）。

**修复：** `desktop-icon-item.js` 的 `setCoordinates()` 中 `container.set_size_request(width, 0)` → `set_size_request(width, height)`：容器固定为完整网格单元尺寸（`elementWidth/elementHeight - 2*elementSpacing`，与定位网格同一组数值）。效果：
1. 同一图标尺寸档下所有选中框/悬停框宽高完全一致（高度不再随内容浮动）；
2. 选中框与拖拽定位网格逐像素重合；
3. 图标/标签位置不变（垂直 Box 中不 expand 的子 widget 从头依次排布，多出的空间留在标签下方）。

安全余量：`ICON_HEIGHT = icon_size + 48` 保证行距 ≥ 框高 + 8px（自然内容高 ≤ icon_size + 48 < 框高），字体行高 ≤ 24px 时内容不会撑破框。

### 单行标签位置偏低：GtkBox 富余空间把标签区压到框底

**症状：** 框固定为单元尺寸后，单行名称的标签比双行名称的第一行低 ~6px，且与图标之间的间距偏大（截图 2026-09-07 09-58-27）。

**根因（离屏 GTK 4.22 实验复现）：** 容器固定高度后内容（icon 64 + 标签区 ~36-42）小于内容区高度，产生 12-18px 富余。GtkBox 会把富余空间插在 icon 与标签区之间（标签区被压在框底，`vexpand` 也无法阻止）；且 `keep_aspect_ratio` 的 `Gtk.Picture` 按容器宽度测量时 natural 高度 = 容器宽度（118 而非 64），进一步打乱分配。结果标签区起始位置随标签自然高度（单行 36 / 双行 42）变化，单行文字看起来下移。

**修复：** 让内容精确填满单元，不留富余空间（`desktop-icon-item.js`）：
1. `setCoordinates()` 中 `this._icon.set_size_request(icon_size, icon_size)`——消除 Picture 的宽高比测量耦合，图标分配恒为 icon_size×icon_size；
2. `setCoordinates()` 中给标签容器 `_labelContainer`（新增保存）设 `set_size_request(-1, height - 6 - icon_size)`（6 = .file-item 边框 2px×2 + 内边距 1px×2），使 icon + 标签区恰好等于内容区高度；
3. `_loadImageAsIcon()` 移除 margin_top/margin_bottom 手动垂直居中——Picture 固定为 icon_size 方框后，`keep_aspect_ratio` 自动 letterbox 居中缩放的 paintable。

效果：标签首行恒紧贴图标下方，单行/双行名称位置完全一致（离屏验证：两种情况 label 均在 icon 底部 y=64 起始，yalign=0 顶部对齐）。

### 选中框补上高亮轮廓（对标拖拽定位网格）

**需求：** 拖拽预览框有完整轮廓（PaintContainer 用 selectColor 全 alpha 描边），鼠标选中框之前只有 35% 背景填充、边框透明，视觉不一致。

**修复：** `.desktop-icons-selected` 的 `border-color` 从透明改为 `alpha(@desktop_icons_bg_color, 1.0)`（即 selectColor，与预览框描边同色）。

### 选中框边框与预览框统一为 1px

**反馈：** 加上轮廓后，选中框比拖拽预览框更粗更亮——CSS border 是 2px，而 PaintContainer 的预览描边是 1px。

**修复：** `.file-item` border-width 2px → 1px（选中态/键盘态同步）；`setCoordinates()` 的 decoration 常量 6 → 4（边框 1px×2 + 内边距 1px×2）；`enums.js` 公式注释同步（ICON_HEIGHT 常量值不变，余量反而更大）。离屏复验：icon 0..64、标签区 64..120，单行/双行一致，精确填充成立。

### 选中框轮廓改由 PaintContainer 绘制（与预览框像素级一致）

**反馈：** 统一 1px 后选中框轮廓仍比预览框暗/闷。像素测量（截图 2026-09-07 10-38-14）：预览框描边像素 = selectColor 全强度 (230,73,45) 单行锐利；CSS border 像素 ≈ 72% 混合 (202,76,53) + 一个过渡像素——CSS 1px 边框在亚像素位置会被反锯齿拆到两行稀释，渲染路径上与 Gsk 描边无法做到一致。

**修复：** 选中框/键盘选中框的轮廓从 CSS 移到 PaintContainer，与拖拽预览框走完全相同的 `_snapshotRoundedRect` Gsk 描边路径（1px，selectColor 全 alpha；键盘态 accent 70%，新增 `borderKeyboard` 颜色）：
1. `paint-container.js`：`vfunc_snapshot` 遍历 `grid._fileItems`，对 `isSelected` 的项描边（键盘态用 borderKeyboard）；`_snapshotRoundedRect` 的 fillColor 改为可选；
2. `desktop-icon-item.js`：`_setSelectedStatus()` 末尾调 `this._grid.queue_draw()` 触发重绘；
3. `stylesheet.css`：`.desktop-icons-selected` / `-keyboard` 只保留 35% 背景填充，不再设 border-color；`.file-item` 的 1px 透明 border 保留（纯结构占位，精确填充计算依赖）。

z 序上 PaintContainer 在图标 widget 之下，描边落在透明的 border 区 + 填充外沿 0.5px，与拖拽预览框的遮挡关系完全相同，因此两者渲染像素级一致。

## 2026-09-05

### 可维护性：窗口标题协议抽出 `title-protocol.js`（纯函数可单测）

**背景：** `emulate-x11-window-type.js` 顶层 `import Meta from 'gi://Meta'`，在 headless gjs（无 GNOME Shell 运行时）下无法导入，导致 `ManageWindow._parseTitle()` 的标题协议解析逻辑（`@!x,y;flags`、尾随空格别名、`Desktop Icons <n>`）一直没有测试覆盖。

**变更（行为等价）：** 纯解析逻辑抽到无依赖的新根模块 `title-protocol.js`（`parseTitle(title)` → `{x, y, keepAtTop, showInAllDesktops, isDesktop, desktopIndex}`）；`_parseTitle()` 保留窗口副作用（set_type/keep_above/移动），改为调用 `parseTitle`。同步更新根 `meson.build` install_data 与 `eslint.config.js` ESM 清单。新增 `tests/test-title-protocol.js`（32 断言）钉住：坐标/分号边界、T/D 标志扫描范围、H 不生效、尾随空格别名（x/y 为 parseInt('H')=NaN 的原始行为）、`Desktop Icons <n>` 抑制 keepAtTop。

### 可维护性：SortManager/ThemeManager 纯函数抽取 + 补测试

**变更（行为等价）：**
- `sort-manager.js`：堆叠排序主体抽为静态纯函数 `SortManager.sortFileListByKindStacked(fileList, unstackList, sortOrder, makeStackMarker)`；`_sortByName`/`_sortByKindByName`/`_positionComparator` 改静态。原实例方法委托到静态版本。
- `theme-manager.js`：accent 色解析主体抽为静态纯函数 `ThemeManager.parseAccentOverride(contents)`（接受 `[{contents}]` 数组，返回 `Gdk.RGBA|null`）。

**新增测试：**
- `test-sort-manager.js` 补 24 断言：非唯一类型都建 marker（每类型一个）、unstacked 成员重新插入到其 marker 之后且按当前排序、stacked 成员隐藏在 marker 后、SIZE 排序下 marker 尺寸/时间取自堆中首个成员。
- 新增 `tests/test-theme-accent.js`（24 断言）：注释剥离、同优先级后定义胜、后定义的非法值不覆盖先前的合法值、其他 @define-color 名忽略、rgba() 整数形式。

**发现（潜在限制，测试钉住现状，未改行为）：** `Gdk.RGBA.parse` 只接受 0–255 整数 RGB 分量——十进制形式（如 `rgba(0, 0.5, 1, 0.8)`）会被静默误解析为近黑色且 parse() 返回 true（覆盖先前合法定义）；空格分隔 CSS 形式直接 parse=false（该定义被跳过）。Chromaleon 等主题的 accent 通常是十六进制，实际影响小；若未来支持十进制 rgba 需先修解析。

### 文档更新

- `docs/architecture-analysis.md`：模块树/启动时序对齐当前实现（gnome-shell-override 在 `enable()` 创建；/proc 匹配为 `includes(ding.js 路径)`；desktopGeometry 不再有 debug 刷屏，DING_DEBUG 门控）；新增 11.5 单测矩阵；模块数 35→38、测试文件 8→13。
- 顺手修了 `test-volume-mount.js` 两处：mock 之前 cancel 时吞掉回调（与真 GIO 行为不符——GIO 会回调 CANCELLED 错误），改为回调 CANCELLED 并补断言 `done()` 在 cancel 后仍被调用；删掉一处未使用的 `done` 变量（eslint no-unused-vars）。测试总数 13 组 / 202 断言，`gjs --module tests/run.js` 全绿。

## 2026-09-04

### 可维护性重构：VolumeMonitor/mount 逻辑拆分至 `app/mount-manager.js`

**背景：** `desktop-manager.js` 仍是事实上的 god class（~1700 行 / 87 方法），混了桌面枚举、增量事件、mount 卷管理、find-files、新建/重命名编排。其中 mount 逻辑已自成闭环（独立常量、独立状态机、独立测试），是最低风险的拆分目标。

**变更（行为等价，无功能变化）：**

1. **新模块 `app/mount-manager.js`（`MountManager` 类）**：承载 VolumeMonitor 三个信号（mount-added/changed/removed）的监听与刷新调度、`_readMountsAsync()` 异步 mount 信息查询（V-3）、`_createMountFileItem()` 工厂接缝、`_scheduleMountRefreshRetry()` 重试调度（V-6）、相关状态（`_mountRetryCounts`/两个 timeout id/`_mountsQueryCancellable`）。
2. **依赖注入**：`MountManager(parent, onRefresh)` — `parent` 为 DesktopManager（FileItem 构造宿主 + `_forcedExit` 状态），`onRefresh` 为 `DesktopManager._updateDesktopSafe` 回调。刷新方向单向（MountManager → DesktopManager），无循环引用。
3. **`desktop-manager.js` 瘦身**：移除 mount 状态字段、三个信号处理器、三个 mount 方法；`destroy()`/SIGTERM 路径改调 `_mountManager.destroy()`/`cancelQuery()`；刷新流程改调 `_mountManager._readMountsAsync(_mountManager.getMounts(), ...)`。
4. **测试**：`tests/test-volume-mount.js` 的 V-3/V-6 用例改测 `MountManager`（stub 改 `Object.create(MountManager.prototype)` + `_parent` 桩）；V-2 快路径用例留在 DesktopManager（该逻辑未移动）。全部 123 断言通过。
5. **清单/文档**：`app/meson.build` 新增安装项；`docs/architecture-analysis.md` 模块树/表新增条目；`docs/volume-mount-issues.md` 代码位置引用更新。

**验证：** `scripts/check.sh` 全绿（eslint 无新增违规 / node --check / 12 组 gjs 单测 / meson 清单与磁盘一致）。**需用户构建后真机回归**：插拔 U 盘/网络驱动器图标出现与消失、拔插瞬间右键弹出/卸载菜单。

### 右键菜单对齐 Nautilus：可弹出介质不再同时显示「弹出」与「卸载」

**背景：** DING 的驱动器菜单（`app/file-item-menu.js`）对 `canEject`/`canUnmount` 各自独立显示，U 盘两者皆真 → 菜单同时出现「弹出」和「卸载」。Nautilus（`nautilus-files-view.c` `file_should_show_foreach`）明确注释 *"Do not show both Unmount and Eject/Safe Removal; too confusing"*，采用互斥策略：能弹出只显示「弹出」（Eject 是 Unmount 的超集：卸载 + 硬件 safe-removal 信号），「卸载」仅作为不可弹出挂载（网络盘、loop 设备）的兜底。

**变更：** 驱动器的菜单动作决策抽为纯函数 `FileItemMenu.driveMenuActions(fileItem, selectedItemsNum)`（返回 `[label, action]` 列表，`_createMenu` 渲染），其中「卸载」的显示条件为 `canUnmount && !canEject`（Nautilus 的 `!show_stop` 分支 DING 未实现 stop 动作，不适用）。行为变化：U 盘/光驱右键菜单只剩「弹出」；SMB/NFS 等网络挂载仍显示「卸载」。

**测试：** 新增 `tests/test-drive-menu.js`（8 断言）：可弹出+可卸载→仅弹出、仅可弹出→弹出、不可弹出可卸载→仅卸载、均不可→无、非驱动器→无、多选→无。先验证红（去掉 `!canEject` 守卫测试失败）再转绿。

**验证：** eslint 零违规、13 组 gjs 单测全绿。需真机回归：U 盘菜单只有「弹出」、网络驱动器菜单只有「卸载」。

## 2026-09-02

### 外部/网络驱动器健壮性修复（V-1 ~ V-7，详见 docs/volume-mount-issues.md）

**背景：** 对 VolumeMonitor/mount 生命周期做系统性审查，发现 9 个问题（V-1 ~ V-9，代码 + 本机 gjs 实验验证）。本次修复其中 6 个（V-1 ~ V-7），全部有单元测试覆盖（`tests/test-volume-mount.js`，29 断言）。

**变更：**

1. **V-2 刷新快路径持有 stale GMount（P1）：** `_drawDesktop` 的 URI 集合不变快路径不更新旧 FileItem 的 `_custom`（GMount）。触发条件：500ms 卸载防抖窗口内快速重插同一盘（同挂载点）→ 图标持有死 mount，菜单"弹出/卸载"失效、显示名可能过期，且**之后 F5 永远走快路径无法自愈**。抽出 `_refreshReusedFileItem()`：复用时同步 `old._custom = newItem._custom`（`app/desktop-manager.js`）。
2. **V-1 eject/unmount 失败无反馈（P1）：** `*_with_operation_finish` 失败（卷忙/无权限/死 mount）时直接 throw，无 catch → 静默失败，只有 stderr 堆栈。重构为 `_doMountOperation()`：失败走 `_logAndPopupError` 弹 `ShowErrorPopup`（与 open 等操作的失败处理一致）；图标已销毁时只 log 不弹窗（`app/file-item.js`）。
3. **V-5 菜单动作缺 null 守卫（P3）：** `getFileItemFromURI` 找不到时返回 `null`（菜单打开期间卷被卸载等），7 个按 URI 取 item 的 GAction 回调直接解引用 → TypeError。统一加 `if (file !== null)` 守卫（沿用 `launch-with-discrete-gpu` 既有模式）（`app/file-item-menu.js`）。
4. **V-3 网络挂载同步 query_info（P2）：** mount 的 `query_info(DEFAULT_ATTRIBUTES)` 在主循环回调内同步执行，`access::*` 对死掉的 SMB 服务器会阻塞 gvfs 网络超时（数十秒），整个桌面图标进程冻结。新增 `_readMountsAsync()`：逐个 `query_info_async` 查询，慢挂载只延迟自己的图标，不卡主循环（非阻塞行为由单测钉住）；FileItem 构造抽出 `_createMountFileItem()` 小接缝供测试替换。
5. **V-6 mount 瞬时失败无重试（P3）：** `mount-added` 时 gvfs/udisks 守护进程未就绪 → 图标静默缺失直到下一次无关刷新。新增 `_scheduleMountRefreshRetry()`：mount-added 追加一次延迟二次刷新；查询失败且 mount 仍存在时安排重试；连续失败上限 3 次（`MOUNT_QUERY_MAX_RETRIES`），成功或 mount-removed 清零，防刷新循环（新常量 `MOUNT_RETRY_DELAY_MS`/`MOUNT_QUERY_MAX_RETRIES`，`app/constants.js`）。
6. **V-7 未监听 mount-changed（P3）：** 盘的 label / can-unmount 等属性原地变化时图标名与菜单不更新。补 `mount-changed → _updateDesktopSafe` 监听。

**测试：** 新增 `tests/test-volume-mount.js`（29 断言）：V-1 异步失败/同步 throw/已销毁/成功/无 mount 五路径；V-2 stale mount 换新 + 非驱动器项 no-op；V-3 成功/失败/非阻塞（主循环心跳）/取消；V-6 重试触发/mount 消失不重试/上限与合并。`gjs --module tests/run.js` 全绿（123 断言）。

**未修复（待决策/低优先级）：** V-4 未挂载卷不显示（待产品决策）、V-8 桌面目录不存在时全部图标消失、V-9 无 drive/volume 的本地挂载归类为网络（待运行时验证）。

