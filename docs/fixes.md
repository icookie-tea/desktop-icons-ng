# 修复日志

> 2026-08 及更早的条目已归档：[fixes-2026-08.md](archive/fixes-2026-08.md)、[fixes-2026-07.md](archive/fixes-2026-07.md)。

## 2026-09-08

### 图标标签双层文字阴影偏“硬”：模糊≤偏移 + 全不透明（gtk4-ding 样式基调）

**反馈：** 把 gtk4-ding 的双层 `text-shadow` 搬过来后（`0.6px 0.7px 1px black, 0.1em 0.1em 0.1em black`），整体效果偏硬：第二层偏移（0.1em）与模糊（0.1em）相等且颜色全不透明，等于把字形硬偏移复印了一份，重影边缘锐利，像“贴”在壁纸上。

**修复：** `app/stylesheet.css` 两层同时软化（`file-label` / `file-label-dark` 同步）：
1. 颜色全不透明 black/white → `rgba(0,0,0,0.9)` / `rgba(0,0,0,0.6)`（影子与壁纸自然混合，不再“贴”）；
2. 第一层（贴近描边）模糊 1px → 2px，偏移微调 0.6/0.7px → 0.5/0.6px——模糊 > 偏移，干的是晕开而不是复制；
3. 第二层（浮起光晕）模糊 0.1em → 0.3em，偏移 0.1em → 0.08/0.1em，α 0.6。

**代价：** 0.3em（约 3px @ 10-11px 字号）模糊较大，极端情况下文字边缘略发虚；若嫌糊可把第二层降到 0.2em、第一层保持 2px。若想回到纯光晕或保留描边感，备选写法：`0 0 2px rgba(0,0,0,0.9), 0 0 0.35em rgba(0,0,0,0.55)`(光晕) / `0.5px 0.6px 1.2px rgba(0,0,0,0.95), 0.1em 0.1em 0.45em rgba(0,0,0,0.7)`(描边)。

### 拖拽图标到文件夹后，原位置残留空选中框（点空白处才消失）

**症状：** 把桌面图标拖进文件夹后，文件已移入文件夹，但原图标位置残留一个只有 1px 橙色轮廓、无填充、无内容的空圆角框；点击桌面空白处才消失。

**根因：** `a7372bb` 把选中框轮廓从 CSS 改为 PaintContainer 从 `grid._fileItems` map 绘制（为与拖拽预览框像素级对齐）。该场景下的实际状态是“map/`_fileList` 条目仍残留（isSelected=true）但 item 的 container widget 已不在窗口里”——轮廓从 map 画所以存活，35% 填充在 CSS（随 widget 消失），故只剩鬼影框。旧 CSS 方式（如 `661428f`，真机验证无此症状）选中外观完全长在 widget 上，widget 没了外观必消失，同样的残留状态当时不可见。残留状态的确切触发路径尚未定位（待跟进）。

**修复：**
- `app/stylesheet.css`：`.desktop-icons-selected` 恢复 `border-color: @desktop_icons_bg_color`（1px 轮廓回到 CSS）；`.desktop-icons-selected-keyboard` 恢复 `border-color: alpha(@desktop_icons_accent_color, 0.7)`。`.file-item` 的 1px 结构性边框不变，几何与 `setCoordinates()` 的 decoration=4 计算保持一致。
- `app/paint-container.js`：删除选中/键盘选中轮廓的批量描边路径（及不再使用的 `borderKeyboard` 颜色），overlay 只画橡皮筋与拖拽预览。
- `app/desktop-icon-item.js` `_setSelectedStatus()`：移除 `changed` 跟踪与 `_grid.queue_draw()`（选中状态不再影响 overlay，widget 自身 style recalc 负责重绘）。
- `app/desktop-grid.js` `removeItem()`：先删 `_fileItems` 条目再移除 widget——即使 GTK 调用异常，也不会留下能画出鬼影框的残留条目（双保险）。
- `app/desktop-monitor.js` `handleFileDeleted()`：先从 `_fileList` splice 再 `removeFromGrid(true)`——即使移除/销毁中途抛异常，死条目也不会留在列表里污染下一次拖拽选中（三层防护的第三层；来自 2026-09-08 的 `fix/stale-item-after-drag` 诊断分支，三轮真机复现 + 静态分析确认当前删除链路干净，诊断日志未合入）。

**代价：** CSS 1px 边框在亚像素位置上会比 Gsk 描边略软（抗锯齿跨两行像素），这是回退的已知视觉代价；换来选中外观与 widget 生命周期绑定，map 状态异常时不再出现鬼影。

### 移除“按类型堆叠”（keep-stacked）功能

### 移除“按类型堆叠”（keep-stacked）功能

**动机：** 该功能 bug 较多（同日已修两例：`_getCurrentKeyboardIcon` shim 丢失、marker 工厂回调契约不匹配），且实际使用频率低；整体移除以降低维护复杂度。

**移除范围：**
- `app/stack-item.js`（整个文件）+ meson 安装清单条目
- `app/sort-manager.js`：`doStacks`/`_unstack`/`_saveStackInitialCoordinates`/`_restoreStackInitialCoordinates`/`_makeStackTopMarkerFolder`/`_sortAllFilesFromGridsByKindStacked`/静态 `sortFileListByKindStacked`（保留 `_sortByKindByName`，sort-by-kind 仍在用）
- `app/desktop-manager.js`：`doStacks`/`_unstack`/`onToggleStackUnstackThisTypeClicked` shim、`keepStacked`/`stackInitialCoordinates`/`_allFileList` 状态、`_placeAllFilesOnGrids` 的 keepStacked 分支、设置变更的 `keep-stacked`/`unstackedtypes` case；`updateFileList()` 简化为直接返回 `_fileList`
- `app/desktop-menu.js`：“Keep Stacked by type...” 菜单项；`app/file-item-menu.js`：Stack/Unstack This Type 菜单项 + `isStackMarker` 条件；`app/file-item.js`：`isStackTop`/`stackUnique`/`isStackMarker`；`app/enums.js`：`FileType.STACK_TOP`；`app/preferences.js`：`getUnstackList`/`setUnstackList`
- 模式：`keep-stacked`、`unstackedtypes` 两个 GSettings key（已重编译 schema）
- 测试：`tests/test-sort-manager.js` 的 stacked-sort 段；`scripts/check.sh` 的 marker 工厂契约守护

**兼容性：** 老用户已存的 `keep-stacked`/`unstackedtypes` 值会被 GSettings 静默忽略；若之前处于堆叠状态，重新启用扩展后图标按保留坐标/排序正常摆放。

### 查找对话框（Ctrl+F / type-to-search）无法打开：AdwDialog.present 缺 parent 参数（基线既有）

**症状：** 按 Ctrl+F 或键入字符触发查找时崩溃：`TypeError: method Adw.Dialog.present: At least 1 argument required, but only 0 passed`（`search-dialog.js` findFiles）。由 check.sh 冒烟测试在 2026-09-08 抓到（冒烟窗口获得焦点后收到真实按键）。

**根因：** 对话框迁移到 `Adw.Dialog` 后，`present()` 与 `Gtk.Window.present()` 不同——`AdwDialog.present(parent)` 必须传 parent 窗口。`findFiles(window, text)` 的 `window` 参数本就为此而存在，但从未被使用。基线既有 bug。

**修复：** `search-dialog.js` findFiles 末尾改为 `this._findFileWindow.present(window)`（window 存在时）。

**附带（冒烟确定性）：** 冒烟窗口可能抢走用户键盘焦点，用户在 8 秒窗口期内的按键会驱动桌面逻辑。`DING_SMOKE=1` 时独立模式窗口在 CAPTURE 阶段消费所有 key-pressed（check.sh 已设置）；键盘行为本身由单测和真机检查覆盖。

### 勾选“按类型堆叠”崩溃且图标消失：堆叠顶工厂回调契约不匹配（基线既有）

> 注：该功能已于同日整体移除（见上文），此条保留作为历史修复记录。

**症状：** 在设置里勾选“按类型堆叠”（keep-stacked）后 DING 报 `JS ERROR: TypeError: can't access property "push", list is undefined`（`_makeStackTopMarkerFolder`），且桌面图标全部消失。

**根因：** `036cd8d`（抽取纯函数供无头单测）把 `sortFileListByKindStacked` 的 marker 工厂契约从“往传入的 list 里 push”改成“**返回** item（纯函数自己 push）”，但真实胶水回调 `_makeStackTopMarkerFolder(type, list)` 没跟着改：调用方只传 `type`，`list` 为 `undefined` → `list.push` 崩溃。异常发生在“文件已从网格移除、尚未放回”的中间态，所以图标消失。单测未覆盖：纯函数测试注入的是形状正确的假工厂，真实回调从未被执行。基线既有 bug（非 dm-split 分支引入）。

**修复：** `app/sort-manager.js` `_makeStackTopMarkerFolder(type)` 改为 `return new stackItem.stackItem(...)`，与新契约一致。

**防回归：** `scripts/check.sh` 新增结构守护——`_makeStackTopMarkerFolder` 必须 `return new stackItem`（返回契约），push 式写法直接红。（守护已随功能移除一并删除。）

### 1 行名称的图标在选中框中偏上：内容块改为单元格内垂直居中

**症状：** 选中框（= 网格单元，standard 档 ~116px 高）内，图标紧贴框顶（~6px，边框/padding + 图标 SVG 内边距），而 1 行名称文字下方留有大片空白（像素测量截图 2026-09-08 08-56-51.png：主目录/初稿-修改.pdf 框底空白 ≈ 28~33px；2 行名称的框底部空白仅 ~12px）。整体观感：内容悬在框的上半部。

**根因：** 三件事叠加（均源自 2026-09-07「选中框=网格单元」修复）：
1. 容器固定为整格高度（设计目标，与拖拽定位网格一致）；
2. `setCoordinates()` 把标签容器钉死为「剩余全部高度」（≈48px，按 2 行预留）；
3. 标签在容器内 `yalign=0` 顶部对齐。

于是 1 行名称的「预留第二行」那 ~28px 空区落在标签区底部，且正好在 35% 选中高亮范围内；2 行名称文字填满预留区，无此问题——所以截图里第三个框明显更平衡。

**修复（方案：内容块整体垂直居中）：** `desktop-icon-item.js` `_createIconActor()`：
1. 容器从 `Gtk.Box`（垂直、顺序布局、无居中能力）改为 `Gtk.Overlay`，主 child 为新建的 `contentBox`（垂直 Box，`halign/valign = CENTER`）——Overlay 对非 FILL 对齐的子 widget 按其自然尺寸定位，天然支持块级居中；`_accessibleBox` 改为 `add_overlay()`（默认 FILL，覆盖整格，可焦点区域反而更完整）；
2. 移除「两行占位 Label」套路（`twoLinesLabel`）——它强制标签容器自然高度永远为 2 行，块高恒定，居中退化为无效的 ±4px；
3. `setCoordinates()` 不再给标签容器钉高度（`_labelContainer.set_size_request(-1, …)` 删除），标签容器改回内容驱动的自然高度（1 行 20px / 2 行 40px），块高 = 图标(icon_size) + 实际行数；重命名/换行时 GTK 自动重测，无需手动同步。

**离屏（Xwayland、窗口移出可视区）GTK 4.22 实验验证**（120×116 精确单元，与生产同构）：
- 修改前（顶对齐）：icon y=0，标签 64..84，标签区 48px 内留 28px 空区；
- 修改后 1 行：icon y=16 / 标签 y=80（紧贴图标底 16+64），上下空隙 16/16；
- 修改后 2 行：icon y=6 / 标签 y=70，上下空隙 6/6。

**效果与取舍：** 每个选中框内 icon+文字作为整体居中，1 行名的框底空区消除，观感平衡；代价（用户已确认接受）：同行混排 1 行/2 行名称时，1 行名图标比 2 行名低 ~10px（单列排布时无影响）。框仍等于整格（与拖拽定位网格一致），选中框描边/填充、悬停、键盘环、拖拽目标区域均不变。

**验证：** `scripts/check.sh` 全绿（eslint / node --check / 13 组 202 断言 gjs 单测）。GTK 布局无法 headless 单测（Gtk 需显示后端），需用户构建后真机验证：单行/双行名称的选中框观感、顶对齐与居中的切换、重命名后标签重排。

### 回归：居中布局下图标被放大 ~1.4×（缩略图压扁、标签重叠图标）

**症状：** 构建后桌面上 PDF 缩略图明显变大（像素测量截图 2026-09-08 09-26-02.png：页面 45×64 → 64×92，≈1.43×），文件夹图标也长高（~51px → 65px）且标签与图标图形重叠——内容块超出框外。

**根因（Xwayland 离屏实验复现）：** `Gtk.Picture` 的 `keep_aspect_ratio: true` 走旧测量路径，`measure(VERTICAL, for_size)` 返回 `max(固有高度, for_size × 高宽比)`——即 natural 高度与传入的宽度约束耦合（实测 44×64 缩略图：for_size=64 → natural 94；for_size=116 → 169）。旧结构下容器整格固定 + 标签区钉死导致总 natural 超出分配，GtkBox 回退到 MINIMUM 分配（图标恰好 64），耦合被“溢出归位”意外掩盖；新结构下 contentBox 是自然尺寸、有富余空间，Box 按 NATURAL 分配 → 图标被拉高到 ~94px，`keep_aspect_ratio` 又把 png 页放大填满。方形图标（文件夹 64×64）耦合值相同，不受影响——所以只有两个 PDF“变大”。

**修复：** Picture 改用 **`content_fit: Gtk.ContentFit.SCALE_DOWN`**（GTK 4.12+ 新内容适配路径）替代 `keep_aspect_ratio: true`：绘制按 paintable 固有尺寸、只允许缩小、居中——与旧视觉完全一致（旧行为本就等同 scale-down-only，实测旧截图纸页 45×64 即固有尺寸绘制），且测量与父宽度解耦。离屏验证：三种组合（缩略图 1 行/2 行、文件夹图标）图标均恒为 64×64（y=16/y=6），标签紧贴图标（y=80/70），内容块居中不变。

**验证：** eslint / node --check / 13 组 202 断言全绿。需真机确认：PDF 缩略图与文件夹图标恢复到修改前大小、标签不再重叠。

### 方案回退：居中改为「顶部对齐 + 块整体下移 6px」

**反馈：** 真机回归（截图 2026-09-08 09-33-07）后用户认为居中方案导致同行 1 行/2 行名称的图标错位 ~10px，观感不佳。最终方向：恢复最初的顶部对齐（所有图标同行严格对齐），只是让整个图标+标签块稍微下移，不再紧贴框顶。

**修复：** `desktop-icon-item.js`：
1. 容器恢复 `Gtk.Box`（垂直、`valign: START`），删除 Overlay/contentBox 居中结构；`_accessibleBox` 恢复为 Box 子项；
2. 标签容器恢复高度钉死（`set_size_request`），保证块高恒定（图标行对齐、单行/双行标签位置一致）；
3. 新增常量 `contentTopOffset = 6`：`this._icon.margin_top = contentTopOffset`，标签区改钉 `height - 4 - icon_size - contentTopOffset`（四档均 = 42 = 2 行标签 40 + margin_bottom 2，精确填满，默认字体下各区余量不变）；
4. 保留上一轮 `content_fit: SCALE_DOWN` 修复（测量耦合与图标放大问题）。

**离屏验证（120×116）：** 缩略图 1 行/2 行、文件夹三种组合 icon 均 (28,6) 64×64（行对齐 ✓），标签均 y=70 紧贴图标，块高 6+64+42+4 装饰 = 116 精确；1 行名下部预留空区 22px（2 行槽位，采纳用户选择）。

**验证：** eslint / node --check / 13 组 202 断言全绿。需真机确认行对齐观感与下移量是否合适（`contentTopOffset` 可再调）。

### PDF 缩略图与其他图标不齐：缩略图改为画布内 7px 顶部内边距

**症状：** 真机回归（截图 2026-09-08 09-37-16，桌面缩放 1.25）显示两个 PDF 的页面图形比其他图标（文档/文件夹）高出 ~8 逻辑 px——widget 位置其实完全一致，差异在图形内容本身。

**根因（像素测量）：** 缩略图 paintable 由 `_loadImageAsIcon` 按页面比例生成后填满 icon_size 正方（PDF 页面 45×64，白色绘满画布顶到顶），而主题图标（text-x-generic 等）的纸张图形在 64px 画布内自带 ~7px 上留白（实测：文档图标图形顶 = 画布顶 + 7 逻辑 px；文件夹图形顶 +17）。widget 全部对齐（y=6），但图形顶部差 ~7px，PDF 显高、显靠上。此差异此前一直存在（旧布局中 PDF 同样顶满画布），本轮用户首次注意到。

**修复：** `_loadImageAsIcon` 把缩略图绘制到 **icon_size×icon_size 透明画布**上：先 `append_color` 透明矩形（保证 paintable intrinsic = icon_size² 且 SCALE_DOWN 不缩放），再 translate 到 (水平居中, 顶部 inset 7) 绘制页面；页面高度限到 icon_size − 7（57），比例不变。效果：页面视觉顶 = 图标区顶 + 7，与文档图标纸张图形完全对齐，且大小与图形几乎一致（57 vs 58）。所有缩略图（PDF/图片）统一行为。

**离屏验证：** 新 paintable intrinsic 64×64，页面 39×57 位于画布 (12,7)；widget (28,6) 64×64 → 页面视觉顶 = 13 逻辑 = 文档图标图形顶 ✓。

**验证：** eslint / node --check / 13 组 202 断言全绿。需真机确认 PDF 页面与相邻文档图标顶部平齐；如页面略小/略大不适，可调 `thumbnailTopInset`（7）。

### 最终方案：统一图标盒，盒内内容双向居中

**反馈：** 按缩略图可见内容顶部做特殊对齐仍不稳定：横向图片贴在
图标区顶部、下方留白过大；而且 `setCoordinates()` 设置公共
`margin_top = 6` 后，异步缩略图加载路径又将其重置为 0，缩略图完成
加载时会向上跳 6 个逻辑像素。

**设计：** 不再尝试对齐不同图片的首个非透明像素，而是统一对齐布局盒：
1. 每个项目使用相同大小、相同顶部位置的 `icon_size × icon_size` 图标盒；
2. 主题图标、PDF 预览和图片缩略图都保持比例，在盒内水平、垂直居中；
3. 标签区固定预留两行并顶部对齐，因此所有标签首行位置一致；
4. 图标盒的公共顶部偏移只由 `setCoordinates()` 管理，异步加载只替换
   paintable，不再修改 margin。

**实现：** `desktop-icon-item.js` 新增纯函数
`calculateThumbnailPlacement()`，将源图像等比例装入正方形图标盒并计算
居中坐标；`_loadImageAsIcon()` 使用该结果绘制透明方形画布，删除固定
`thumbnailTopInset = 7` 和加载完成后的 margin 重置。

**验证：** 新增 `tests/test-icon-layout.js`，覆盖横向、纵向、方形三种
缩略图，验证其在 64×64 图标盒内的尺寸与居中坐标；GJS 单测共 14 组
205 个断言通过。GTK 最终像素效果仍需用户构建后在真机确认。

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
