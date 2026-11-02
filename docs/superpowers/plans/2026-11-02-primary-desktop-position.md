# 仅主屏模式图标位置稳定性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本计划按依赖顺序执行；用户另行选择委派时，可使用 superpowers:subagent-driven-development。

**Goal:** 在仅主屏模式中，用一份持久化的相对位置布局支持主屏切换、分辨率及缩放变化、显示器拔插，避免自动布局覆盖用户位置。

**Architecture:** 桌面是一块跟随当前主屏的逻辑画布。每个图标保存与显示器身份无关的比例锚点，实际显示坐标由当前主屏网格计算；自动投影不反向修改锚点。沿用文件元数据和现有 GridLayout / DesktopGrid 分工，不引入显示器配置数据库。

**Tech Stack:** GJS ES Modules、GTK4、Gio 文件元数据、GLib 定时器、现有 GJS 测试框架、Meson 安装清单。

**Spec:** 本文“设计约定”是经讨论方案的具体化，与下方实施任务一起作为执行依据；本轮仅交付计划，尚未实施功能。

## Global Constraints

- 构建、安装和扩展重新加载由用户手动执行；实施者运行开发检查后告知用户。
- JavaScript 使用 GJS；不引入 npm 运行时依赖，不修改现有 GNOME 支持范围。
- 修复代码时同步更新 `docs/fixes.md` 和相应架构文档，不能提前把计划记为已修复。
- 新增、移动、删除 `app/*.js` 时必须同步 `app/meson.build`；根目录安装文件变化同步根 `meson.build`。
- 第一版复用 `app/icon-remap.js`，不新增生产 JS 模块；新增测试注册到 `tests/run.js`。
- 保留 `icons-only-on-primary` 选项及其当前默认值 `false`，不擅自替用户改变设置。
- 副屏继续保留桌面窗口、右键和文件拖放入口，继续禁止在副屏寄宿图标。
- 普通多屏模式继续使用旧坐标路径；其断屏覆盖缺陷作为独立工作，不在本计划中顺带改写。
- 不提交、推送或合并本计划；实施时每个任务可形成一个本地提交，遵守届时用户的 Git 要求。

## 设计约定

### 1. 范围、收益与边界

第一版重点支持“仅主屏 + 手动摆放”。同一份布局跟随主屏，不区分内置屏、外接屏或接口名称。

| 场景 | 行为 |
|---|---|
| 副屏接入、断开，主屏可用区域未变化 | 主屏图标落格结果保持一致 |
| 主屏切换、主屏被拔掉 | 相同比例锚点投影到新的主屏 |
| 分辨率、缩放、方向、可用边距变化 | 从锚点重新计算目标，不逐次缩放旧显示坐标 |
| 恢复相同网格条件 | 若文件集合、锚点和排列设置未变，恢复相同落格结果 |
| 小屏幕期间拖动部分图标 | 仅为成功落位的被拖图标保存新锚点；其余锚点保留 |
| 主屏容量不足 | 沿用现有放不下计数和限流通知，不把图标迁到副屏，不清除其记录 |
| 扩展重启、重新登录 | 从元数据读回锚点，不依赖上次进程内的主屏矩形 |

比例保持不等于像素不动；网格变小后可能发生碰撞、避让或无法显示。第一版不保证不同配置拥有不同布局，也不保证文件增删、手动移动后恢复之前的完整画面。

不做：显示器硬件身份识别、按屏幕配置保存多套快照、固定像素间距网格重构、跨屏独立记忆、新偏好开关、通用布局插件框架。

### 2. 数据模型与坐标定义

新增字符串元数据属性 `metadata::ding-primary-position`，内容为紧凑 JSON：

```json
{"version":1,"u":0.275,"v":0.35}
```

- `u`、`v` 是 **GTK 图标容器内可用网格区域**的比例，均为有限数，范围 `[0, 1]`。
- 保存已落位单元格的中心比例：`u = (column + 0.5) / columns`，`v = (row + 0.5) / rows`。
- 保存的是比例，不是行列号。屏幕列数变化时按比例映射；同一网格恢复时中心点能稳定回到原格，避免边界浮点误差。
- 投影点先在容器局部坐标中计算，再通过 `DesktopGrid.coordinatesLocalToGlobal()` 转换，复用现有落格入口。
- 不使用整个显示器矩形代替网格区域，不额外乘除 GNOME / GTK 缩放；边距和缩放由现有 DesktopGrid 尺寸及坐标转换处理。
- 图标已经处于新主屏范围内也要投影，不能沿用当前 `isInside()` 跳过逻辑。
- 每次显示都读取同一锚点；网格取整只影响显示位置，不写回比例。

`metadata::nautilus-icon-position` 继续服务普通模式、旧版本和首次迁移。在仅主屏模式中，有效的新属性是唯一的手动布局依据。两种属性必须通过不同 API 写入，不能在旧 `savedCoordinates` setter 中暗中联动。

### 3. 写入规则与故障处理

| 操作 | 主屏锚点 | 旧全局坐标 |
|---|---|---|
| 几何变化、主题刷新、普通文件属性刷新 | 不写 | 不写 |
| 手动模式首次迁移 / 新图标首次成功落位 | 仅初始化缺失记录 | 兼容写入当前实际位置 |
| 用户拖动、明确的粘贴 / 拖入落点 | 更新成功落位的操作对象 | 兼容写入当前实际位置 |
| 手动模式下明确执行一次排序 | 更新参与排序且成功落位的对象 | 兼容写入当前实际位置 |
| “保持排列”引发的自动排序 | 不改手动锚点 | 主屏路径不自动覆盖 |
| 普通多屏模式拖动 / 排列 | 不写主屏锚点 | 沿用现有行为 |

- 元数据写入接口返回是否成功，捕获失败并记录日志；失败不能使图标消失或回滚当前显示。
- 一次明确的位置提交尽量用一个 `Gio.FileInfo` 同时写新旧属性，避免两次写入产生中间状态。
- 写失败不声称“已保存”，不在每次自动刷新中无限重试。迁移失败的对象在当前 FileItem 生命周期内标记已尝试；新实例允许再次尝试，明确的用户移动始终可重试。
- `metadata::*` 已包含在 `Enums.DEFAULT_ATTRIBUTES`，不需扩张查询范围。
- 解析返回 `missing / valid / invalid / unsupported` 状态。空值为 missing；损坏 JSON、越界、非数值为 invalid；未知版本为 unsupported。
- missing / invalid 可在首次手动落位后初始化；unsupported 自动回退到旧坐标显示但不自动覆盖。用户明确移动或手动排序可写成本版格式。
- 继续使用已有异步查询取消与销毁保护；复用 FileItem、重建 FileItem、增量属性刷新都要读到新属性，读取过程禁止触发 setter 写盘。

### 4. 迁移、模式切换与文件生命周期

1. **已有有效锚点：** 忽略旧全局位置，直接投影。
2. **没有锚点：** 先根据旧坐标在当前主屏尝试放置，冲突则找空格；成功后从实际格子初始化锚点。
3. **旧坐标位于副屏或屏幕外：** 投到当前主屏并就近避让，以首次看到的结果作为迁移基线。旧记录缺少源坐标系，不能承诺还原历史副屏上的精确比例。
4. **首次启用时已经保持排列：** 自动排序不建立手动布局；切回手动模式时，缺失记录才初始化。
5. **关闭仅主屏：** 保留新属性，普通模式只读写旧属性。再次开启时恢复主屏专属布局；普通模式期间的移动不隐式覆盖它。
6. **副屏拖入、粘贴、新建文件夹：** 显式落点优先于文件携带的旧锚点；先投到主屏，成功落位后提交该对象的新锚点。
7. **重命名与同文件刷新：** 不维护额外 URI 数据库，随文件元数据读回；验证当前后端的移动 / 重命名保留能力，不承诺所有文件系统都会转移元数据。
8. **隐藏文件：** 不占用网格；主屏模式隐藏时不删除主屏锚点，也跳过 `_doReadAsync()` 中清空旧 savedCoordinates 的写入，重新显示后按原锚点参与布局。普通模式的隐藏文件处理维持现状。
9. **主目录、回收站、挂载项：** 复用 FileItem 的元数据读写；不支持写入的 URI 允许本次进程内显示，日志明确保存失败。跨登录持久化以对应后端支持为前提，本版不另建特殊图标数据库。

### 5. 自动排列与确定性

- `keep-arranged=true` 时，以排序规则和当前容量决定显示，保留此前手动锚点；关闭后主动刷新并恢复手动布局。
- 用户在手动模式选择排序，是明确修改布局；排序完成后保存参与对象的新锚点。
- `sort-special-folders=false` 时，特殊图标先按锚点落位，普通图标再排序；不能顺带改写特殊图标锚点。
- 手动布局按“已有位置记录 → 无记录对象”分批；同批使用 URI 的字典序作为固定顺序，不依赖目录枚举顺序或 locale。
- 保留现有就近空格搜索。确定性要求相同输入重复产生相同结果，不承诺全局最小位移，也不增加复杂的最优分配算法。
- 自动排列比较结果相等时，以 URI 作为最终 tie-break，避免相同大小 / 时间的对象在刷新间交换位置。

### 6. 几何事件合并

在 GTK 端 `GridLayout` 合并 D-Bus 几何更新，避免改 Shell 通信协议。新增排队入口，现有 `updateGridWindows()` 保持为立即应用入口，便于现有测试和初始化使用。

- 静默窗口 200 ms，连续事件最长等待 1000 ms；每次只应用最新有效快照。
- 校验所有数值有限，宽高 / scale 大于零，边距非负且不能吃光可用区域，主屏索引可解析；空列表或非法快照保留上个有效布局。
- 相同快照不重建；不要仅凭显示器数量判断主屏坐标记录应否覆盖。
- destroy 时取消定时器并丢弃待应用数据，保证回调不会访问已销毁窗口。
- 合并只减少过渡布局，不保证 GNOME 在一个静默窗口后必然完成所有配置；后续有效快照仍可继续应用，锚点不受影响。
- 不修改 `extension.js` 的窗口管理时序，不引入新的 GNOME API 或 D-Bus 数据格式。

## 文件与职责

| 文件 | 计划改动 |
|---|---|
| `app/icon-remap.js` | 锚点解析、编码、格子中心归一化及局部坐标投影；保持纯函数 |
| `app/file-item.js` | 新元数据读取与明确位置提交，区分旧坐标 setter |
| `app/desktop-grid.js` | 获取已放置对象的格子锚点；支持不写旧坐标的显示放置 |
| `app/grid-layout.js` | 主屏布局分支、首次迁移、明确提交、事件合并与销毁清理 |
| `app/desktop-manager.js` | 复用实例同步新属性、排序调用意图、模式关闭 / 保持排列关闭后的刷新 |
| `app/dnd-manager.js` | 主屏拖动按实际落位结果提交，仅提交选中对象 |
| `app/sort-manager.js` | 主屏排序只放置，明确排序后才保存；普通模式维持旧路径 |
| `app/file-item-menu.js` | “用选中项新建文件夹”使用显示位置，避免读取陈旧存储坐标 |
| `app/constants.js` | 200 / 1000 ms 几何更新参数 |
| `tests/test-primary-position.js` | 新增纯函数测试 |
| `tests/test-primary-layout.js` | 新增主屏布局、持久化意图、迁移和模式切换测试 |
| `tests/test-geometry-updates.js` | 新增定时器与几何校验测试 |
| 现有相关测试、`tests/run.js` | 更新覆盖和测试注册 |
| `docs/fixes.md`、`docs/architecture-analysis.md` | 实施完成后同步现状与限制 |

## Task 1：建立比例锚点的纯函数契约

**Files:** Modify `app/icon-remap.js`; Create `tests/test-primary-position.js`; Modify `tests/run.js`。

**Interfaces:**

```js
// 下列接口是计划新增接口，不代表当前代码已经存在。
readPrimaryPosition(text) // => {status, position: {u, v} | null}
writePrimaryPosition(position) // => JSON string；非法输入抛 RangeError
positionFromCell(column, row, columns, rows) // => {u, v}；非法输入抛 RangeError
localPointForPosition(position, width, height) // => [localX, localY]；非法输入抛 RangeError
```

- [x] **1. 写失败测试并注册测试模块。** 测试模块导入命名空间，先断言接口存在，再运行行为测试，保证缺接口时有明确失败。核心断言：

```js
const position = Remap.positionFromCell(5, 3, 20, 10);
assertDeepEqual(position, {u: 0.275, v: 0.35}, 'cell centre is proportional');
assertDeepEqual(Remap.localPointForPosition(position, 2000, 1000),
    [550, 350], 'projects into container local coordinates');
assertDeepEqual(Remap.readPrimaryPosition(Remap.writePrimaryPosition(position)),
    {status: 'valid', position}, 'metadata round trip');
assertEqual(Remap.readPrimaryPosition('{"version":2,"u":0.2,"v":0.3}').status,
    'unsupported', 'future format is not silently migrated');
```

- [x] **2. 执行红灯检查。** `gjs --module tests/run.js`，确认新增断言或接口缺失导致失败；不能只看 `tests/debug-one.js` 的进程退出码，该脚本打印失败但未保证非零退出。
- [x] **3. 实现纯函数。** 按 `column + 0.5` 的公式计算，不取整；解析严格验证版本、类型、有限性和范围。空字符串 / null 返回 missing，非法 JSON / 越界返回 invalid。
- [x] **4. 增加并执行边界用例。** 覆盖零行列、零尺寸、NaN、Infinity、负数、首末格；以 20×10 → 15×7 → 20×10 连续投影 100 次，断言原 position 对象与序列化字符串未变。
- [x] **5. 验证并形成任务交付。** `gjs --module tests/run.js` 全绿；删除其“调用方取整仍严格可逆”等失实注释。建议提交：`feat: define persistent primary desktop position anchors`。
- [x] **6. 不提前删除旧函数。** `remapPosition()` / `isInside()` 的唯一调用方是 Task 3 要移除的 `_remapStoredPositions()`，删除动作放在 Task 3（连同 `tests/test-icon-remap.js`）。Task 1 只新增纯函数，避免留下“测试删了、调用方还在”的中间态。

## Task 2：实现元数据读写与无写入的网格放置

**Files:** Modify `app/file-item.js`, `app/desktop-manager.js`, `app/desktop-grid.js`, `tests/test-desktop-grid.js`, `tests/test-metadata-refresh.js`; Create and register `tests/test-primary-layout.js`。

**Interfaces:** 消费 Task 1；新增以下接口：

```js
// FileItem，读取不触发写入。
get primaryPosition() // => {u, v} | null
get primaryPositionStatus() // => missing | valid | invalid | unsupported
reloadPrimaryPosition(fileInfo) // => void；只读更新，复用实例时同样调用
savePrimaryPosition(position, legacyCoordinates) // => boolean；一次 Gio.FileInfo 提交

// DesktopGrid，现有调用默认行为保持不变。
addFileItemCloseTo(item, x, y, mode, {persistLegacy = true} = {}) // => boolean；网格已满（没有任何空单元格）时返回 false
getFileItemPrimaryPosition(item) // => {u, v} | null；从 _fileItems 中的真实行列计算
```

- [x] **1. 写红灯测试。** 用伪造 `Gio.FileInfo` 输入验证构造 / reload 能读有效、损坏和未知版本记录；用记录 `set_attributes_from_info()` 调用的 fake file 验证新旧属性在同一次提交中写入。
- [x] **2. 测试禁止自动写入。** 对 fake item 的 `savedCoordinates` setter 计数，调用 `addFileItemCloseTo(..., {persistLegacy:false})` 后应为零，包含 item 尚无旧坐标的情况。不能遗漏 `_addFileItemTo()` 的“旧坐标为空就自动保存”分支。
- [x] **3. 执行红灯检查。** `gjs --module tests/run.js`，确认新增契约尚未满足。
- [x] **4. 实现接口。** 在 `_addFileItemTo()` 中透传 persistLegacy；销毁 / 未成功放置返回 false，成功返回 true。读取真实 `_fileItems[item.uri]` 的 column / row 计算锚点，不根据图标 padding 后的左上角反推。

```js
if (persistLegacy &&
    (item.savedCoordinates == null || mode === Enums.StoredCoordinates.OVERWRITE)) {
    item.savedCoordinates = [x, y];
}
```

**必须先修满网格路径。** `_getEmptyPlaceClosestTo()` 找不到空格时返回 `[null, null]`，而 `_addFileItemTo(item, null, null)` 会把 `localX` 算成 `0`：图标被塞到 (0,0)，`_setGridUse(null, null, item)` 的 key 也算成 `0`，覆盖掉真正占据 (0,0) 的格子记录。今天没有暴露，是因为所有调用都先经 `findDesktopFor()` 的 `getDistance() === -1`（满）拦截；`placePrimaryFiles()` 直连主屏网格会绕过这道拦截。因此 `addFileItemCloseTo()` 必须在 `[null, null]` 时直接返回 false，且不得调用 `_addFileItemTo()`。

- [x] **5. 接通所有读取路径。** 构造函数、`_refreshMetadataAsync()` 应用结果、`_refreshReusedFileItem()` 都同步新属性；不得在 reload 中调用保存 API。新增字段的初始化放在第一次调用 reload 之前。
- [x] **6. 测试写入失败和重建。** 写入异常返回 false、现有显示仍在；成功序列化后销毁 fake item，用同一份属性构造新对象，得到相同锚点。确认已有取消 / destroyed 测试继续通过。
- [x] **7. 验证并形成任务交付。** `gjs --module tests/run.js` 全绿。建议提交：`feat: persist primary positions independently of rendered coordinates`。

## Task 3：接通主屏投影、首次迁移与模式隔离

**Files:** Modify `app/grid-layout.js`, `app/desktop-manager.js`, `tests/test-primary-layout.js`, `tests/test-full-desktop.js`, `tests/test-placement.js`。

**Interfaces:** 消费 Task 1 / 2；在 GridLayout 新增：

```js
placePrimaryFiles(fileList, {arranged = false, targets = null} = {})
// => 成功放置的 FileItem[]；targets 为 Map<uri, [globalX, globalY]> 或 null。
// 不写位置元数据。arranged=false 用锚点；true 按输入排序顺序分配普通图标。
// arranged 决定传给 addFileItemCloseTo 的 StoredCoordinates：true 用 ASSIGN（从起始角落
// 扫描第一个空格，保持排序的紧凑外观），false 用 PRESERVE（优先命中原格，冲突时找最近空格）。
// 这个映射必须写进注释，否则两者极易混。

// 现有入口的返回契约变化（Task 4 依赖）：
addFilesToDesktop(fileList, storeMode) // => 成功放置的 FileItem[]（原为 undefined）
addSingleFileToDesktop(fileItem)       // => 成功放置的 FileItem 或 null（原为 undefined）
commitPrimaryPositions(fileItems, {onlyMissing = false} = {})
// => void；只提交主屏上已经成功落位的对象。
```

- [x] **1. 写红灯回归。** 记录每个 item 的属性写入次数，覆盖同原点缩小再恢复、不同原点切主屏、负原点、相同主屏但副屏数量变化。自动显示后写入次数为零。
- [x] **2. 实现主屏专属路由。** 在 `addFilesToDesktop()` / `addSingleFileToDesktop()` 的主屏模式入口使用 placePrimaryFiles，普通模式仍走现有三阶段路径。
- [x] **3. 实现确定性放置。** 有位置记录者先处理、无记录者后处理；手动同批按 URI 字典序处理。通过 `localPointForPosition()` 和主屏 grid 的 `coordinatesLocalToGlobal()` 得到目标，以 `persistLegacy:false` 放置；有效锚点不能再走 isInside 过滤。
- [x] **4. 实现首次迁移。** 成功落位后只为 missing / invalid 对象初始化；记录本实例迁移失败，避免通知触发的刷新反复写入。unsupported 自动显示但跳过自动迁移。满屏未落位对象不提交、不丢记录。
- [x] **5. 删除旧主屏连续重映射。** 去掉 `_coordPrimaryArea` 与 `_remapStoredPositions()` 的主屏写盘路径；`_primaryGridRemovedIcons` 只供普通模式旧路径使用，不能覆盖主屏锚点。同步删除随之失去全部调用方的 `remapPosition()` / `isInside()` 与 `tests/test-icon-remap.js`，并从 `tests/run.js` 注销；`app/icon-remap.js` 的模块注释改为只描述比例锚点，不留“重映射结果落盘”的过时论证。
- [x] **6. 模式切换。** 保持主屏属性独立；关闭开关走旧坐标，重新打开读回锚点，不依据旧全局坐标进行第二次迁移。保留副屏 hostability 与交互实现。
- [x] **7. 显式 drop 优先。** 在消费 dropCoordinates 前保留操作对象集合，传入 targets；即使对象携带有效旧锚点，也以 drop 目标放置并提交。副屏落点投到可寄宿主屏后再确定锚点。
- [x] **8. 更新旧测试。** `tests/test-full-desktop.js` 中“主屏断开必须 OVERWRITE”改为“新主屏路径不覆盖锚点”；保留普通模式现状的独立断言，不能借更新测试扩大修复范围。
- [x] **9. 运行验证。** `gjs --module tests/run.js`；用不同枚举顺序重复相同输入，断言实际 URI → 格子映射相同；模拟重建 FileItem 后仍能恢复。建议提交：`fix: project primary icons from persistent anchors`。

## Task 4：明确拖动、排列与新建文件夹的保存意图

**Files:** Modify `app/dnd-manager.js`, `app/sort-manager.js`, `app/desktop-manager.js`, `app/file-item-menu.js`, `tests/test-dnd-manager.js`, `tests/test-sort-manager.js`, `tests/test-primary-layout.js`, `tests/test-new-folder-selection.js`。

**Interfaces:** 消费 Task 3；排序入口增加显式选项，保留旧单参数调用的兼容默认值：

```js
// DesktopManager 和 SortManager 使用相同签名。
doSorts(cleargrids, {commitPrimaryLayout = false} = {})
```

- [x] **1. 写红灯测试。** 主屏 A / B / C 三个图标，小屏幕仅拖动 B 后，保存调用只包含 B；A、C 锚点不变。拖动未落位对象不提交。
- [x] **2. 实现主屏拖动分支。** 仍以 `getCoordinates()` 计算选中对象位移，移除选中对象后通过 targets 放置，再提交成功落位集合；普通模式保留旧 savedCoordinates / OVERWRITE 路径。

```js
const placed = layout.placePrimaryFiles(selectedItems, {targets});
layout.commitPrimaryPositions(placed);
```

`keep-arranged` + `sort-special-folders` 时 `dnd-manager.js` 另有一条分支（特殊图标直接 `item.savedCoordinates = [x + deltaX, y + deltaY]` 再走 OVERWRITE）。这条分支同样要在主屏模式换成 targets + commitPrimaryPositions，否则拖特殊图标只写旧坐标、不写锚点，下一次刷新就被弹回。

- [x] **3. 写排列红灯测试。** 自动排序重复 5 次、几何变化后自动排序，都不得保存手动锚点；手动一次性排序只保存参与排序且放得下的对象；特殊图标不参与排序时不保存它们。
- [x] **4. 区分排序调用来源。** `arrangeorder` 设置变化且 `keepArranged=false` 时显式传 commitPrimaryLayout:true；开启保持排列、保持排列期间切排序规则以及 `_placeAllFilesOnGrids()` 都为 false。**桌面菜单的“整理图标”**（`desktop-menu.js` 的 `arrange-icons` → `sortAllFilesFromGridsByPosition()`）同样是用户明确的排序动作，必须走同一条提交路径：给该方法加 `{commitPrimaryLayout = false} = {}{BT} 并让菜单调用点传 true。漏掉它会让“整理图标”在主屏模式下刷新后弹回旧布局。
- [x] **5. 实现主屏排序放置。** `_reassignFilesToDesktop()` / PreserveSpecialFiles 分支在主屏模式调用 `placePrimaryFiles(...,{arranged:true})`，不清空 savedCoordinates 或 primaryPosition。两个 reassignment 方法返回成功参与排序的对象列表；每个 `_sortAllFilesFromGridsBy...()` 返回该列表，`doSorts()` 用本次局部变量接收并按显式选项提交，不新增跨刷新 pending 状态。特殊图标不参与排序时，从提交集合排除。
- [x] **6. 恢复手动布局。** `keep-arranged` 变为 false 时主动 `_updateDesktopSafe()`；有锚点者恢复，缺记录者首次落位后初始化。隐藏文件处理不清除主屏锚点。
- [x] **7. 排序并列稳定。** 现有比较器返回 0 时使用 URI 字典序，测试同大小 / 时间对象在不同枚举顺序下输出一致。
- [x] **8. 使用显示位置新建文件夹。** “用选中项新建文件夹”从 `clickedItem.getCoordinates()` 取前两项；测试保存坐标屏幕外而显示坐标在主屏时，新文件夹得到显示落点。原有创建失败恢复逻辑不变。
- [x] **9. 运行验证。** `gjs --module tests/run.js`，重点确认普通模式 DnD 和原有排序测试无回归。建议提交：`fix: save primary layout only for explicit placement changes`。

## Task 5：合并几何事件并清理定时器

**Files:** Modify `app/grid-layout.js`, `app/constants.js`, `tests/run.js`; Create `tests/test-geometry-updates.js`。

**Interfaces:** 在 GridLayout 新增 `queueGridUpdate(desktopList)`；D-Bus 两处回调使用此入口，内部最终调用已有 `updateGridWindows(desktopList)`。

```js
// app/constants.js
export var GEOMETRY_UPDATE_DEBOUNCE_MS = 200;
export var GEOMETRY_UPDATE_MAX_WAIT_MS = 1000;
```

- [x] **1. 写红灯测试。** 以 fake scheduler 验证 A → B → C 快照只应用 C；持续事件在 1000 ms 达到上限时应用最新有效快照；相同快照不重复重建；destroy 后不执行回调。
- [x] **2. 使调度可测试。** GridLayout 第三个可选构造参数注入 `{schedule, cancel, nowMs}`：`schedule(delayMs, callback)` 返回 timer id，`cancel(timerId)` 取消调度，`nowMs()` 返回单调毫秒数。生产默认使用 GLib；保留现有第二个 getPrimaryOnly 参数，不改变其测试语义。fake scheduler 的 `advance(ms)` 推进时间并依次执行到期回调，无需真实等待一秒。
- [x] **3. 实现排队状态。** 保存 `_pendingGeometry`、`_geometryTimerId`、`_geometryBatchStartedAt`；schedule 返回 timer id。每次替换快照，重设计时为 `min(200, max(0, 1000 - elapsed))`；应用时先清理 pending 状态。
- [x] **4. 补全校验。** 空列表、NaN / Infinity、宽高 / 缩放非正、负边距、边距总和大于等于尺寸、无可用主屏时拒绝更新；按 DesktopGrid 公式计算并取整后的局部可用宽高也必须大于零。保留现有桌面，无效快照不能覆盖队列中最后一个有效快照。
- [x] **5. 清理销毁与重复数据。** destroy 取消 timer 并清空 pending；超时回调先清零 timer id。沿用几何 diff 跳过相同数据，禁止回调在 disable 后继续触发布局。
- [x] **6. 首次几何立即应用。** `action-added` 分支是初次几何（`createGridWindows()` 与首次图标枚举都由它触发），排队会让桌面创建整体推后至少 200 ms。该分支保持直接调用 `updateGridWindows()`；只有 `action-state-changed`（运行期变化）进入合并队列。测试要分别断言这两条入口。
- [x] **7. 执行验证。** `gjs --module tests/run.js`，断言事件合并前后主屏锚点的保存次数都是零。建议提交：`fix: coalesce desktop geometry changes before relayout`。

## Task 6：完成回归、文档与用户验收交接

**Files:** Modify `docs/fixes.md`, `docs/architecture-analysis.md`；复查本计划涉及的全部源文件和测试。

- [x] **1. 补齐集成矩阵。** 在 `tests/test-primary-layout.js` 用真实纯函数和 fake 元数据后端串起：加载 → 迁移 → 小屏投影 → 重建对象 → 仅移动一个对象 → 大屏恢复。断言未移动对象锚点字节内容保持不变，移动对象恢复时使用新锚点。
- [x] **2. 验证双模式及显式落点。** 主屏 on → off → 普通模式拖动 → on；复制文件携带旧新属性 → 明确落点 → 刷新；保持排列 on → 几何变化 → off。分别检查落格结果和属性写入集合，避免只断言 setter 次数却不检查画面位置。
- [x] **3. 检查代码并更新文档。** 在 fixes 中记录已实施机制、迁移方式、旧版本回退限制、特殊 URI 写入限制和真机未验项目；修正 2026-10-09 条目中与新行为冲突的描述，保留其历史背景。在架构文档说明主屏锚点 / 普通全局坐标的职责。
- [x] **4. 执行开发检查。** 不构建、不安装、不刷新正在运行的扩展：

```bash
gjs --module tests/run.js
bash scripts/check.sh
git diff --check
comm -3 <(ls app/*.js | xargs -n1 basename | sort) <(grep -oE "'[A-Za-z0-9-]+\.js'" app/meson.build | tr -d "'" | sort)
```

预期：单测 / 检查退出码均为 0；安装清单比较无输出。check.sh 在有显示环境时会启动短暂独立 smoke 窗口，但不安装扩展。无显示环境跳过 smoke 时，交付中明确说明，不能声称真机通过。

- [x] **5. 完成代码审查与必要修正。** 重点检查自动写盘分支、复制文件的旧锚点、特殊图标、元数据刷新覆盖、主屏未就绪和定时器销毁；修正后仅重跑受影响测试及必要的全量检查。
- [x] **6. 更新任务状态并交接。** 只勾选已有证据的任务，记录开发检查输出摘要。建议最终文档提交：`docs: describe primary desktop position persistence and validation`。

### 用户手动构建后验收

| 操作 | 通过条件 |
|---|---|
| 开启仅主屏，将图标摆在左上、中间、右下 | 副屏无图标，副屏菜单及拖入入口可用 |
| 保持主屏不变，插拔副屏 3 次 | 主屏布局无持续跳动，原锚点不变 |
| 2560×1440 → 1920×1080 → 2560×1440 | 未编辑布局在相同网格条件下回到原格，无累积偏移 |
| 切换两块屏幕为主屏，再切回 | 布局跟随主屏，副屏不出现遗留图标 |
| 拔掉当前主屏，再接入并设回 | 布局迁到新主屏，切回后恢复 |
| 修改系统缩放及 Dock / 顶栏占用边距后恢复 | 图标不落入不可用区域，恢复时使用原锚点 |
| 小屏期间只移动一个图标，再恢复大屏 | 仅该图标保存新位置，其他图标仍按原锚点恢复 |
| 在小屏期间重启 DING，再恢复大屏 | 布局依据仍在，不能依赖进程内 previous area |
| 保持排列开启后改变分辨率，再关闭 | 自动排序正常；已有手动布局可恢复 |
| 手动模式执行一次排序后重启 | 保存并恢复排序后的新布局 |
| 主屏模式关闭 / 普通模式拖动 / 再开启 | 读取此前主屏布局，行为与文档一致 |
| 主屏放满，再增加图标 | 通知限流；已有图标保留，未落位对象记录不丢失 |
| 主目录、回收站、挂载项移动后重启 | 支持元数据的后端恢复；不支持者有明确失败日志 |

### 回退策略

关闭 `icons-only-on-primary` 即回到旧模式；不要批量清除新元数据。回退旧版本可读取最后一次明确提交时写入的全局坐标，但旧版本不理解比例锚点，不能承诺在不同显示几何下恢复同样的主屏布局。

## 实施修订（2026-11-02 复核）

实施前对着代码复核了本计划，以下六点已并入任务，否则会出现“单测全绿、真机错误”：

| # | 问题 | 落在 |
|---|---|---|
| 1 | 满网格时 `_getEmptyPlaceClosestTo()` 返回 `[null, null]`，`_addFileItemTo()` 会把它算成 (0,0) 并覆盖 `_gridStatus[0]`；主屏直连路径绕过 `findDesktopFor()` 的满屏拦截 | Task 2 |
| 2 | 桌面菜单“整理图标”（`sortAllFilesFromGridsByPosition`）是显式排序，原计划未纳入提交集合 | Task 4 |
| 3 | `_reassignFilesToDesktop()` 依赖 `addFilesToDesktop()` 的返回集合，而该入口原本返回 `undefined` | Task 3 接口 |
| 4 | 把 `action-added`（初次几何）也纳入 200 ms 合并会让桌面创建推迟 | Task 5 |
| 5 | `keep-arranged` + `sort-special-folders` 时 DnD 有独立分支，原计划只改写普通拖动分支 | Task 4 |
| 6 | Task 3 删掉 `_remapStoredPositions()` 后 `remapPosition()` / `isInside()` 与 `test-icon-remap.js` 成为死代码，Task 1 的“保留”与此冲突 | Task 1 / Task 3 |

另有两处需要在实施中固定、不改结构：`arranged` 必须对应 `StoredCoordinates.ASSIGN`、按锚点投影必须对应 `PRESERVE`（`_getEmptyPlaceClosestTo()` 的两条语义不同）；主屏模式下隐藏文件跳过 `savedCoordinates = null` 会保留 legacy 坐标，需在 `docs/fixes.md` 说明。

## 实施状态（2026-11-02）

计划已实施完成，形成 6 个本地提交（分支 fix/primary-desktop-position）：

| 提交 | 内容 |
|---|---|
| docs: plan for persistent primary desktop position anchors | 计划本体 + 复核修订 |
| feat: define persistent primary desktop position anchors | Task 1 |
| feat: persist primary positions independently of rendered coordinates | Task 2 |
| fix: project primary icons from persistent anchors | Task 3 |
| fix: save primary layout only for explicit placement changes | Task 4 |
| fix: coalesce desktop geometry changes before relayout | Task 5 |
| docs: describe primary desktop position persistence and validation | Task 6 |

开发检查（最近一次全量）：`gjs --module tests/run.js` 全绿（约 970 条断言，37 组），`scripts/check.sh` 全绿（ESLint + `node --check` + 单测 + 结构检查；无显示环境时 smoke 跳过），`git diff --check` 无输出，`app/meson.build` 安装清单比对无输出（本轮未新增/移动/删除 `app/*.js`）。

实施中据实调整的三处：

1. `DesktopGrid` 增加 `_startCorner()` / `_addVolumesOpposite()` 两个实例方法作为测试接缝，使主屏投影能跑真实网格落格代码而不需要 GSettings schema；生产行为不变。
2. `app/icon-remap.js` 的 `localPointForPosition()` 返回取整后的整数像素。计划原文的断言是 `[550, 350]`，而 `0.275*2000` 在双精度下是 `550.0000000000001`；取整是落格代码消费的坐标空间，且目标点是格心，半像素误差不可能跨格。
3. 新增 `GridLayout.primaryOnly` getter 供 `DesktopManager` 判断隐藏文件分支，避免二次读取 GSettings。

未验证（需真机）：热插拔、实际缩放与 Dock/顶栏边距、`keep-arranged` 与几何变化的交互、特殊 URI（回收站/挂载项）的元数据写入。单测不等同于这些结论，验收表见上。

## 完成判据

- 自动几何变化不覆盖已有主屏锚点；恢复不依赖连续映射或内存中的旧主屏区域。
- 明确拖动 / 排列 / 落点操作只提交本次成功落位的对象。
- 同一网格、对象集合、设置及锚点下，刷新顺序与目录枚举顺序不会改变最终布局。
- 新旧位置属性职责清晰；正常模式不被主屏属性接管；保持排列不破坏手动锚点。
- 所有开发检查通过，用户手动构建与真机验收结果另行记录，不把单测等同于热插拔实测。
