# DING 全面代码审计报告（2026-08）

> 只读审计，未修改任何代码。基线：`scripts/check.sh` 全绿（eslint 零违规 / node --check / gjs 单测 / 结构检查），meson 清单与磁盘一致。
> 方法：3 路并行全文精读（核心渲染/生命周期、交互操作/工具、Shell 侧/测试/清单）+ 全局模式扫描 + 逐项交叉验证（grep 全仓确认消费方）。P0/P1 关键项已二次抽查坐实。
>
> **环境假设（用户确认，2026-08）：GNOME ≥ 50 已彻底移除 X11 会话，目标环境为纯 Wayland。** 因此本报告中所有 X11 相关分支/兼容代码视为死代码；Wayland 专用路径（platformData parent-handle、`Meta.WaylandClient.new_subprocess`）是唯一路径，相关问题的实际影响面按此评估。

**总览：P0×4、P1×8、P2×9、P3×29、文档/测试一致性 9 项。** 按“高收益低风险”优先级，建议先修 P0 全部 + P1 前 3 项。

---

## P0 — 真实行为 bug（可复现的用户可见错误）

### P0-1 新建文件夹后"自动改名"功能静默失效
- **位置**：`app/file-item.js:281-289` + `app/desktop-manager.js:1606`
- **证据**：`_checkForRename()` 唯一入口是 `_doLabelSizeAllocated()`（file-item.js:283），而 `_doLabelSizeAllocated` 全仓只有定义与 super 调用（desktop-icon-item.js:221、file-item.js:281-282），**无任何信号连接/调用点**。GTK3 时代有 `connectSignal(this._labelEventBox, 'size-allocate', ...)`，GTK4 移植 `_createIconActor` 时丢失。管道另一端完整：`doNewFolder` 仍在设置 `this.newFolderDoRename = newName`（desktop-manager.js:1606，`opts.rename` 默认 true），`doRename` 完成才清空（file-operations.js:155）。
- **根因**：GTK4 移植时 size-allocate 触发链被删，方法留而无调用点。
- **建议**：`_createIconActor` 补 `this.connectSignal(this._label, 'realize', () => this._doLabelSizeAllocated())`（GTK4 无 size-allocate 信号且**无 `allocation` GObject 属性**——`notify::allocation` 是静默死连接，2026-08-09 实测排除；`realize` 是 label 加入 widget 树时必然触发的可靠钩子），或删除整条死链并清理 `newFolderDoRename`（若决定废弃该功能）。
- **风险**：中（功能失效，非崩溃）。**验证**：已修——DING_DEBUG 日志链路 `newFolderDoRename` → `label realized` → `checkForRename match=true` → 弹框出现（见 fixes.md 2026-08-09）

### P0-2 Nautilus 文件操作的 platform_data 恒为空 dict（含 Wayland surface handle 泄漏）
> **纯 Wayland 下影响面最大**：`GdkWayland.WaylandToplevel` 是唯一顶层类型，`parent-handle` 是 Nautilus 进度对话框关联桌面窗口的唯一机制——当前所有操作都在丢失它（进度框永远不以桌面窗口为 parent），且每次操作泄漏一个 surface handle。
- **位置**：`app/dbus-remote-operations.js:125,162,166,174,191,195,199,203,207`
- **证据**：`platformData` 是 async 函数（:125），返回 `{data, freePlatformData}`。但 7 处调用直接传 `this.platformData()`（Promise 对象）给 `_remoteCall` → `new GLib.Variant('a{sv}', promise)` 静默产出空 `@a{sv} {}`（GJS 实测不抛错）；`RenameURIRemote` 里 `await this.platformData().data`（:174）——Promise 无 `.data` 属性 → `undefined`。且函数体已执行 `export_handle()`（:131 附近），但返回的 Promise 无人 await，`freePlatformData`（unexport）永不可达 → 每次操作泄漏一个 Wayland surface handle。
- **根因**：调用点应写 `(await this.platformData()).data`；分拆时沿袭错误。
- **建议**：`const {data, freePlatformData} = await this.platformData()`，D-Bus 回调里调 `freePlatformData()`；其余 7 处同步化。
- **风险**：中（父窗口句柄/时间戳全丢 + handle 泄漏）。**验证**：Wayland 下 DING_DEBUG 操作文件 grep platform 日志；连续复制-粘贴 50 次观察 handle 增长。

### P0-3 Nautilus Scripts 子菜单被创建后丢弃，脚本功能整体失效
- **位置**：`app/file-item-menu.js:247-251,51,173`
- **证据**：`let submenu = this._scriptsMonitor.createMenu(); if (submenu !== null) { added_element = true; }` —— `submenu` 从未 `append_submenu`（全文件无此调用）；且 `added_element` 在此之前已置 true（:240 附近），该 if 是纯死逻辑。构造时第 3 参 `this._onScriptClicked.bind(this)`（:51）被 `TemplatesScriptsManager` 构造函数忽略（签名只有 `(baseFolder, flags)`）；`_onScriptClicked`（:173）全仓无调用方。即便补 append，菜单项 action 是 `app.create-template`（templates-scripts-manager.js:207），对脚本语义也错。
- **根因**：脚本功能半迁移残留。
- **建议**：补 `section.append_submenu(_('Scripts'), submenu)` + 给 TemplatesScriptsManager 增加脚本专用 action；或删除整个脚本路径（monitor + getFilteredEnviron + _onScriptClicked + createMenu 脚本分支）。
- **风险**：中（功能失效）。**验证**：`~/.local/share/nautilus/scripts/` 放可执行脚本 → 桌面图标右键菜单无 "Scripts" 项。

### P0-4 `doKillAllOldDesktopProcesses` 自 ESM 迁移起永久失效
- **位置**：`extension.js:327-328`（匹配逻辑）+ `app/ding.js:1`（shebang）
- **证据**：shebang `#!/usr/bin/env -S gjs --module` 使 `/proc/<pid>/cmdline` 实际为 `gjs --module <path>/ding.js -E -P ...`，而匹配条件是 `contents.startsWith("gjs <path>/ding.js")` —— 实测（等价 shebang 脚本）：`startsWith("gjs /tmp/x.js")` 对 `gjs --module /tmp/x.js` 返回 false，`includes` 才为 true。ESM 迁移给 shebang 加 `--module` 时未同步此匹配。
- **根因**：字符串匹配与真实 argv 脱节。
- **建议**：改 `contents.includes(build_filenamev([this.path,'app','ding.js']))`。
- **风险**：中——**纯 Wayland 下场景依然存在**：Shell 热重启（`killall -3 gnome-shell` / 崩溃自动重启 / 注销重登——GNOME ≥ 50 纯 Wayland 下 Alt+F2→r 已不可用）时旧进程存活 → 新旧两进程争 `com.rastersoft.ding`（GtkApplication 无 REPLACE 标志）→ 新进程退出、1s 无限重启循环，桌面图标丢失直到手动 kill。另见 extension.js:64 注释（已随修复更新）。
- **验证**：`killall -3 gnome-shell` 或注销重登实测；或单元测试复现 cmdline 匹配。

---

## P1 — 潜在泄漏/竞态/兼容性风险

### P1-1 缩略图队列可永久停摆（save 回调无异常保护）
- **位置**：`app/thumbnails.js:96-100`
- **证据**：`save_thumbnail_async` 回调体 `obj.save_thumbnail_finish(res); this._resolveThumbnail(file, resolve); this._launchNewBuild();` 无 try/catch（外层 try 只保护 generate 阶段）。若 `save_thumbnail_finish` 抛错（磁盘满/缓存目录损坏），`_launchNewBuild()` 不再执行、`_running` 恒 true，此后所有 `getThumbnail` promise 永不 resolve、`_thumbList` 无限积压。另：`_resolveThumbnail` 返回 false 时 `resolve` 永不调用，单图标悬挂。
- **建议**：save 回调包 try/catch（非 CANCELLED 时 `resolve(null)` + `_launchNewBuild()`）；`_resolveThumbnail` false 分支补 `resolve(null)`。
- **风险**：中。**验证**：mock `save_thumbnail_finish` 抛错，断言队列继续处理。

### P1-2 增量创建与全量刷新竞态可致重复图标（疑似）
- **位置**：`app/desktop-monitor.js:139-150`
- **证据**：`handleFileCreated` 直接 `this._dm._fileList.push(fileItem)`，无 `getFileItemFromURI` 去重；`_readingDesktopFiles` 守卫只覆盖读取期，flush 落在 `_drawDesktop` 之后（F5/设置刷新期间排队中的 CREATE 事件）时枚举已含该文件、增量又 push 一份 → 重叠双图标。
- **建议**：`handleFileCreated` 先查 `getFileItemFromURI(file.get_uri())` 命中则跳过（或刷新入口 drain 队列）。
- **风险**：低-中。**验证**：F5 后 200ms 窗口内创建文件，观察重复图标。

### P1-3 加密压缩密码框点 Cancel：进度元素 + 应用抑制永久泄漏
- **位置**：`app/auto-ar.js:463-472`
- **证据**：`finally { ... if (!this._waitingForPassword) { this._destroy(); } }` → 密码等待时跳过清理；随后 `if (this._waitingForPassword) { const retval = await this._waitButtons(); ... if (retval) {...} }` —— retval=false（Cancel）时既不 `_destroy()` 也不 `removeProgress()`，`_inhibitCookie`（LOGOUT|SUSPEND）永不释放、进度窗口残留元素直到进程退出。
- **建议**：retval=false 分支补 `this._destroy()`（或 finally 统一按状态判定）。
- **风险**：中。**验证**：提取加密 zip → 密码框 → Cancel → 进度窗口仍有元素；此后无法注销/休眠（Inhibit 未释放）。

### P1-4 platformData 伴生问题：`get_surface()` 空指针顺序错误 + freePlatformData 不可达
- **位置**：`app/dbus-remote-operations.js:127-155`
- **证据**：`const topLevel = parentWindow.get_surface()`（:131）在 `if (parentWindow)`（:135）之前执行；`get_active_window()` 为 null（启动/关闭瞬间）时 TypeError 在 try 外抛出，整条 Promise 静默 reject。freePlatformData 因 P0-2 不可达。
- **建议**：随 P0-2 合并修复，`get_surface()` 移入 try 并判空。
- **风险**：低-中。**验证**：断点 :155 确认从不执行。

### P1-5 Legacy 接口下"永久删除"会清空整个回收站（疑似）
- **位置**：`app/dbus-remote-operations.js:233-238`
- **证据**：`DeleteURIsRemote` 在 legacy 分支先 fire-and-forget `EmptyTrashRemote()`（:235）再 `TrashFilesRemote` —— 每次永久删除前清空回收站。
- **建议**：legacy 接口无永久删除方法时应走 Trash 并去掉 EmptyTrash 调用（或提示不支持）。
- **风险**：低（仅旧版 Nautilus 命中，现代环境无 FileOperations 旧接口）。**验证**：静态确认即可。

### P1-6 gnome-shell-override 对 Shell 私有 API 的覆写无防护
- **位置**：`gnome-shell-override.js:61,71,125`
- **证据**：`Main.overview._overview._controls._stateAdjustment`、`this._monitorIndex`/`_bgManager`/`_backgroundGroup` 全部是私有路径；异常发生在被注入的 `WorkspaceBackground._init` 内会沿 `Workspace` 构造链上抛，可能破坏 Shell 启动渲染。Shell 51+ 未实测。
- **建议**：注入逻辑整体包 try/catch + 特性检测（`if (!overviewAdjustment) return;`），动画失败静默降级。
- **风险**：高（仅兼容性维度，现网 50/51 工作正常）。**验证**：50.4 真机日志无异常；对 `_stateAdjustment` 打桩模拟缺失路径。

### P1-7 name_acquired 回调无 isEnabled 守卫，disable 竞态可产生孤儿进程（疑似）
- **位置**：`extension.js:193-214`
- **证据**：`Gio.bus_own_name(..., (connection, name) => { ...launchDesktop() }, null)` 回调体内无状态守卫；若 disable() 在名称获取窗口内执行，`currentProcess` 已置 null，回调仍拉起无人管理的新进程。
- **建议**：回调入口与 `launchDesktop()` 顶部加 `if (!this.data.isEnabled) return;`。
- **风险**：中。**验证**：反复快速 enable/disable 后 `pgrep -f ding.js`。

### P1-8 visible-area 使用 deprecated Meta API（继承 upstream）
- **位置**：`visible-area.js:110-111`
- **证据**：`Meta.Display.get_monitor_geometry/get_monitor_scale` 自 Mutter ≥44 废弃；50.4 仍存在故现网不炸，但无版本守卫。文件与 upstream 逐字节一致。
- **建议**：迁移到 `Main.layoutManager.monitors[i]`（已含 x/y/w/h/scale）。纯 Wayland 下无 X11 兼容包袱，迁移无障碍。
- **风险**：低-中。**验证**：50/51 真机几何切换回归。

---

## P2 — 性能优化点 / 健壮性 / 翻译缺失

| # | 位置 | 问题 | 建议 | 风险 | 验证 |
|---|------|------|------|------|------|
| P2-1 | `app/desktop-manager.js:907` | 连续 Ctrl+F 无条件新建 `Adw.Dialog` + 新 `SignalManager`，旧窗口/信号不清理；旧按钮回调关的是新窗口 | `findFiles` 开头若 `_findFileWindow` 存在先 `_closeFindFiles(false)` | 低 | 连按两次 Ctrl+F 观察双窗口 |
| P2-2 | `app/paint-container.js:117-157` + `desktop-grid.js:472-476` | 拖拽/橡皮筋绘制每帧新建 `Graphene.Rect`/`Gsk.RoundedRect`/`Gsk.Stroke`/`Gsk.PathBuilder`（N 格 × 4 对象/帧）；`_coordinatesBelongToThisGrid` 每调用 new `Gdk.Rectangle` | 几何对象按尺寸缓存；矩形包含测试改纯数值比较 | 低 | sysprof 采样拖拽期间分配 |
| P2-3 | `app/desktop-icons-util.js:135-136` | 'No Terminal' 错误弹窗两条字符串未包 `_()`（POTFILES 有该文件，纯漏包） | 包 `_()` 并补 .po 条目 | 低 | xgettext 重提取确认 msgid 出现 |
| P2-4 | `app/auto-ar.js:41` | 进度窗口标题 'Archives Operations' 未翻译 | `title: _('Archives Operations')` | 低 | 触发压缩进度窗口看标题 |
| P2-5 | `app/auto-ar.js:25,71` | `_refreshExtensions()` 只在构造时执行，晚于动态 import resolve 时永不刷新 → 压缩/解压菜单消失（疑似，实测大概率在 activate 前 resolve） | `.then` 里赋值后补调 `_refreshExtensions()` | 低-中 | 启动日志打印 format_last 时机 |
| P2-6 | `app/desktop-menu.js:161` | `GLib.getenv('XDG_CURRENT_DESKTOP').split(':')` 未设置时 getenv 返回 null → TypeError | `(GLib.getenv(...) ?? '').split(':')` | 低 | `env -u XDG_CURRENT_DESKTOP` 独立模式点设置 |
| P2-7 | `app/desktop-icons-util.js:191` + `file-item-menu.js:173-186` | `getFilteredEnviron`/`_onScriptClicked` 只服务于已失效的脚本菜单（死路径连带，见 P0-3） | 随 P0-3 一并处理 | 低 | grep 确认 |
| P2-8 | `gnome-shell-override.js:71-75` | ~~Clone 层只在 `WorkspaceBackground._init` 时捕获当时已存在的 DESKTOP 窗口；崩溃重启后的新 DING 窗口永不补进既有层 → 首次会话/重启后 Overview 动画不生效（疑似）~~ **已实测排除（2026-08-10）**：全新登录后 Overview 过渡平滑（动画工作）；`pkill -f ding.js` 崩溃重启后动画仍平滑。两轮推理（登录后不生效 / 崩溃重启后失效）均被真机推翻——GNOME Shell 的 workspace/background 重建路径比假设的频繁（登录时 display config 应用会重建 workspace），clone 机制比预期健壮。无需修复 | — | — | 已排除（真机验证） |
| P2-9 | `extension.js:299-336` | 构造时同步全量扫描 /proc + 阻塞 `proc.wait(null)` | 先按名称过滤纯数字目录 + 只读含 "ding.js" 的 cmdline；kill 改异步 | 低 | 启停耗时对比 |

---

## P3 — 死代码 / 可维护性 / 清理（29 项）

### 死代码（无消费方，均已 grep 交叉验证）
- [P3] `app/desktop-icon-item.js:566` — `_calculateOffset` 死方法，引用未初始化字段 `iconheight`（全仓无赋值 → NaN）；`labelwidth` 仅由死链 `_doLabelSizeAllocated→_calculateLabelRectangle` 写入（与 P0-1 同源，恢复触发链时注意语义）
- [P3] `app/desktop-manager.js:123-127` — `_premultiplied` 只写不读；`:335` `_errorWindow` 只写不读；`:327` `_scriptsList` 只写不读
- [P3] `app/desktop-icon-item.js:628-641` — `get/set state` + `_state` 全仓无 `.state` 消费者
- [P3] `app/desktop-grid.js:135` — `updateGridDescription` 零调用
- [P3] `app/menu-helper.js:26`、`app/stack-item.js:31`、`app/file-operations.js:29` — 三处 `const _ = Gettext.domain('ding').gettext` 死定义（文件内 `_()` 调用数 0）
- [P3] `app/templates-scripts-manager.js:59-64` — `destroy()` 死方法；`_monitorDir` 不在 destroy 中 cancel；两个实例存活整个进程生命周期
- [P3] `app/dbus-utils.js:34-37,57-62` — 6 个导出变量（NautilusFileOperations2/FreeDesktopFileManager/GnomeNautilusPreview/GnomeArchiveManager/GtkVfsMetadata/SwitcherooControl）全仓无消费者；`_programNeeded` 数组分支死代码
- [P3] `app/prefs-window.js:28,58` — 模块级 `var Gtk` 由 `preferencesFrame(_Gtk,...)` 按调用约定赋值，函数间隐式依赖 → 改直接 import
- [P3] `emulate-x11-window-type.js:214-220` — `'destroy'` 处理器空壳死代码（`_activate_window_ID` 从未赋值，对应清理是死代码）

### X11 残留死代码（纯 Wayland 环境假设下整组可删）
- [P3] `app/desktop-manager.js:58,79-101` — `using_X11` 字段 + `_initX11Check` 的 X11 分支在纯 Wayland 下恒不执行；且 else 分支每次启动都 `set_boolean('check-x11wayland', true)` 做无谓 dconf 写入。**注意**：`mainApp.hold()`（:80-81，asDesktop 时保活）与 X11 无关，删除时须把 hold 逻辑保留/移出
- [P3] `app/notify-x11-under-wayland.js` — 整个模块（2.1K）死代码（仅被 `_initX11Check` 引用）
- [P3] `schemas/org.gnome.shell.extensions.ding.gschema.xml:108` — `check-x11wayland` key 死 key（纯 Wayland 下永不生效）
- [P3] 删除需同步：meson.build 移除 `notify-x11-under-wayland.js`、POTFILES.in 移除条目（含 2 条翻译：'Desktop Icons NG is running under X11Wayland' 等）、po 清理
- [P3] `extension.js:64` — 注释 "under X11, with Alt+F2 and R" 过时（GNOME ≥ 50 纯 Wayland 下 Alt+F2→r 已不可用，重启方式为 `killall -3 gnome-shell` / 注销重登；已随 P0-4 修复更新）

### 冗余/错误写法（行为等价或低影响）
- [P3] `app/desktop-manager.js:1583-1587` — `doNewFolder` catch 块两分支相同（`if (position || suggestedName) { return null; } return null;`）→ 单 `return null`
- [P3] `app/sort-manager.js:89-91,124-133` — 两处冗余条件分支（if/else 都 continue；`!_isSpecial` 在 `_isSpecial` continue 之后恒真）
- [P3] `app/dnd-clipboard-utils.js:81-97` — DING_ICON_LIST 与 URI_LIST 两个 case 代码逐字重复 → 合并 case 标签
- [P3] `app/file-item-menu.js:574-578` — `_getExtractable()` 循环首迭代即 return（只检查第一个文件；当前被 `selectedItemsNum == 1` 守卫掩盖）→ 改 `.every()`
- [P3] `app/ask-rename-popup.js:63` — `clamp(fileItem.displayName, 30, 50)` 传字符串恒得 NaN → `set_width_chars(0)`；应为 `.length`
- [P3] `app/auto-ar.js:667` — `this._dialog.present(this._grid.Window)` 访问不存在属性（`_grid` 是纯 JS 类 DesktopGrid，其窗口在 `._window`）→ **已修（2026-08-10）**：初版误改为 `present(this._grid)` 导致 GJS 抛 `not a subclass of GObject_Object`（压缩对话框崩溃），正确修复为 `present(this._grid._window)`；另 `desktop-manager.js:785,828` 的 `findFiles(grid.Window)` 同样传 undefined parent（见 fixes.md 2026-08-10）
- [P3] `app/paint-container.js:24` vs `desktop-grid.js:34` — `elementSpacing = 2` 重复定义 → 统一导入
- [P3] `app/desktop-grid.js:85,105` — 构造函数双重 `setGridStatus()`（每次 O(网格) 初始化）
- [P3] `app/grid-layout.js:54-64,96-97` — margin-only 变更也全量重建所有 Grid 窗口；`for...in` 遍历数组 → 改 for-of
- [P3] `app/desktop-monitor.js:177-193` — `_moveTimeoutId` 回调内不归零（后续 source_remove 为 no-op，语义脏）
- [P3] `app/dbus-utils.js:114-160,296-309` — 启动同步 `IntrospectSync`/`ListNamesSync` 阻塞主循环；代理激活失败后无限 1s 重试 + 每次重试重新 IntrospectSync → 重试加退避上限
- [P3] `app/dbus-utils.js:180-183` — `includes` 去重 O(n²)（名字 <100，可忽略）→ Set
- [P3] `app/desktop-manager.js:397-406` — `updateFileList()` 前 8 个连续空行
- [P3] `app/file-item.js:353` — `get_is_hidden() | get_is_backup()` 布尔按位或 → `||`
- [P3] `app/file-item.js:684-690` — eject/unmount finish 回调无错误处理
- [P3] `app/theme-manager.js:73-76` — destroy 后 in-flight idle 回调会重新 add CssProvider（退出路径才触发）→ idle 回调查存活标志
- [P3] `app/theme-manager.js:296` — `gtk_application_prefer_dark_theme` 为 GTK 4.16+ 弃用属性（疑似，仍兼容）
- [P3] `extension.js:362,511` — 两处未门控 `console.log`（'Launching DING process' 崩溃循环时 1 条/秒刷 journal；'Received notification for window...'）→ 改 debugLog
- [P3] `emulate-x11-window-type.js:17-33 vs 128-133` — 协议注释宣称支持 B/T/D/H 四标志，`_parseTitle` 只处理 T/D，H 被静默忽略 → 注释删 H 或实现
- [P3] `emulate-x11-window-type.js:122,137,150` — `_parseTitle` Exception console.log 未门控
- [P3] `extension.js:167` — 过时注释（"we kill the desktop program" 实际不再 kill）
- [P3] `gnome-shell-override.js:46` — `origninalMethod` 拼写错误
- [P3] `visible-area.js:18` — ESM 混用 legacy `imports.signals`（兼容残留）
- [P3] `prefs.js:26-33` — 设置窗口 fire-and-forget 激活 app 后立即关闭，app 未运行时静默 no-op（继承 upstream，可加失败提示）
- [P3] `metadata.json` — `shell-version: ["50","51"]` 已声明，`Meta.WaylandClient.new_subprocess`（Mutter ≥47）在支持范围内恒可用，原 "更老 Shell 无限重启" 担忧被版本声明排除，无需处理（仅保留此说明）
- [P3] `auto-ar.js` — 模板字符串当 msgid（`_("Extracting files into '${outputPath}'")`），翻译者易破坏占位符 → 考虑 gettext `%s` 惯例

---

## 文档与测试一致性（9 项）

| # | 位置 | 问题 |
|---|------|------|
| D-1 | `docs/fixes.md` + `docs/archive/maintainability-refactor.md` | 声称 "131 断言"，实测 **58**（harness `passed` 计数器跨模块累积，各模块打印的是累积值；文档数字照抄了最后一个模块的值）。SortManager 现 35、generateDropFilename 43 |
| D-2 | `docs/architecture-analysis.md` 概述 | "Shell 侧文件仍为 legacy（imports.*）" 过时：extension.js/prefs.js 已是 ESM，仅 visible-area.js:18 保留 `imports.signals` |
| D-3 | `docs/architecture-analysis.md` 阶段 3 | "x11Manager.enable() … 连接 Main.overview 'hiding' 信号" 已随 fc84044 移除 |
| D-4 | `docs/architecture-analysis.md` 4.4/6.1 | "大量 console.log debug 日志" 已收敛为 DING_DEBUG 门控（仅剩 extension.js 两处，见 P3） |
| D-5 | `docs/architecture-analysis.md` 阶段 4 | 启动 argv 描述不准确：实际 argv 为 `[ding.js路径, '-E', '-P', app路径]`，`gjs --module` 来自 shebang；且未察觉 `--module` 使 killAll 失效（P0-4） |
| D-6 | `docs/architecture-analysis.md` 阶段 3 图 | "innerEnable() → gnomeShellOverride.enable()" 实际在 `enable()`（extension.js:79-82） |
| D-7 | `docs/archive/maintainability-refactor.md` "未落地优化参考" | 4 项中 3 项已落地/决定不做：对象复用（desktop-manager.js:1271-1291）、mount-removed 延迟（constants.js:28 MOUNT_REMOVED_DELAY_MS=500）、并行枚举（fixes.md 明确"评估后不做"）；**仅剩 1 项未落地：绘制同步（iconPlaced，全库无此符号）** |
| D-8 | `docs/fixes.md` | "右键粘贴改 doPaste(true)"（2026-08-04 条目）已被显式 revert：desktop-menu.js:137 现为 `doPaste(false)`（缓存驱动，行为自洽）；"FileOperations 3 处 `_()` 调用"描述随重构过时 |
| D-9 | `eslint.config.js:6` | 注释 "app/*.js files are legacy `imports.gi` scripts" 过时（app/ 已是 ESM） |

**一致项（无需处理）**：meson 清单 × 磁盘 ✓；POTFILES.in 全条目存在且无漏列 gettext 文件 ✓；scripts/README × scripts 8 个脚本 ✓；LINGUAS 29 语言 = 29 个 .po ✓；po 的 `#~` obsolete 条目（es 78、pt_BR 50…）与 fixes.md 预告一致，下次 xgettext 自动清理，非异常；upstream merge-base == HEAD（无待跟踪的上游提交）。

---

## 测试覆盖缺口（高价值补测建议）

当前 58 断言全部为纯函数/原型桩，无任何 GTK/Shell 集成测试；Shell 侧零覆盖。

| 优先级 | 目标 | 测什么 | 难度 |
|--------|------|--------|------|
| 高 | `emulate-x11-window-type.js` `_parseTitle` | 标题协议解析（`@!x,y;flags`、尾空格别名、回退定位）——纯 JS mock 即可 | 中 |
| 高 | `sort-manager.js` `_sortAllFilesFromGridsByKindStacked`/`_restoreStackInitialCoordinates` | 2026-08-04 O(n²)→O(n) 重写无测试锁定，补堆叠分组/展开顺序/坐标恢复语义 | 低-中 |
| 高 | `theme-manager.js` `_readUserAccentOverride` | gtk.css + @import 链解析、剥注释、取最后定义、RGBA 校验（2026-08-05 靠手工探测） | 中 |
| 中 | `visible-area.js` 边距数学 | workarea vs monitor、`_usableAreas` 覆盖规则 | 低 |
| 中 | `file-operations.js` `fileExistsOnDesktop`/`getDesktopUniqueFileName` | 重名去重、副本后缀序列 | 低-中 |
| 中 | `desktop-manager.js` `_processIncrementalEvents` | 事件路由、超限回退全量刷新、`_desktopFilesChanged` 标记 | 中-高 |
| 低 | Shell 侧几何/缩放 | 依赖 Shell 运行时 CI 不可行 → 纯函数提取 + 手工回归清单 | — |

---

## 建议实施顺序

1. **第一批（P0，行为修复）**：P0-2 platformData（含 P1-4）→ P0-4 killAll → P0-1 改名触发链 → P0-3 脚本菜单（或删脚本路径）
2. **第二批（P1 高价值）**：P1-3 auto-ar 密码取消泄漏 → P1-1 缩略图队列保护 → P1-2 增量去重 → P1-7 isEnabled 守卫 → P1-6 override 防护
3. **第三批（P2/P3 批量清理）**：翻译补包（P2-3/4）→ X11 残留死代码整组删除（需同步 schema/POTFILES/meson/po）→ 其余死代码批量删 → Ctrl+F 守卫（P2-1）→ 文档一致性 9 项
4. 每批按项目约定：补测试（优先补上文高价值缺口）、更新 `docs/fixes.md`、同步 meson/POTFILES 清单（本审计无新增文件，清单不变）
