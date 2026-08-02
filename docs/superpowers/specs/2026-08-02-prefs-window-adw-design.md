# 设置窗口：行为修复 + Adw 风格重构设计

日期：2026-08-02
状态：已批准

## 背景

用户报告 DING 的设置窗口（prefs-window）显示时**置顶**且**在所有工作区可见**，希望它像普通应用窗口一样；同时希望参考其他 GNOME 扩展（Adw 风格）优化设置窗口的样式与布局。

## 根因

`app/preferences.js` 的 `showPreferences()` 调用
`DesktopIconsUtil.windowHidePagerTaskbarModal(prefsWindow, true)`：该函数给窗口标题
追加两个空格。GNOME Shell 侧 `emulate-x11-window-type.js` 的 `ManageWindow._parseTitle()`
把"以两个空格结尾的标题"解析为 `@!HTD` 标记：

- `H` = 从窗口列表/任务栏隐藏
- `T` = 置顶（`make_above()`）
- `D` = 所有工作区可见（`stick()`）

因此设置窗口被置顶、跨工作区显示且不出现在任务栏。

## 第 1 节：行为修复

- `showPreferences()` 移除 `windowHidePagerTaskbarModal(prefsWindow, true)` 调用
  （连同 `set_modal(true)`、`grab_focus()`——模态在单窗口 GTK 应用中无实际效果）。
- 窗口变为普通窗口：不置顶、不跨工作区、任务栏/Alt+Tab 可见、标题正常显示。
- **保留** `file-item-menu.js`（重命名对话框）与 `show-error-popup.js`（错误弹窗）
  的调用——对话框/错误弹窗置顶是合理行为。

## 第 2 节：UI 重构（Adw 风格）

`app/prefs-window.js` 重构为 Adw 标准结构（`Adw.PreferencesPage` +
`Adw.PreferencesGroup` + `Adw.ActionRow`）。依赖已存在（`ding.js` 用 `Adw.Application`）。

### 组 1「桌面图标」

| 行 | 控件 | 设置键 |
|---|---|---|
| 图标大小 | 下拉 | `icon-size` |
| 新图标对齐 | 下拉 | `start-corner` |
| 显示主文件夹 | 开关 | `show-home` |
| 显示回收站 | 开关 | `show-trash` |
| 显示外接驱动器 | 开关 | `show-volumes` |
| 显示网络驱动器 | 开关 | `show-network-volumes` |
| 新驱动器放屏幕对侧 | 开关 | `add-volumes-opposite` |
| 拖放时高亮放置区 | 开关 | `show-drop-place` |
| 用 Nemo 打开文件夹 | 开关 | `use-nemo` |
| 链接加徽章 | 开关 | `show-link-emblem` |
| 标签文字用深色 | 开关 | `dark-text-in-labels` |

### 组 2「与 Nautilus 共享」

| 行 | 控件 | 设置键 |
|---|---|---|
| 点击方式 | 下拉 | `click-policy`（nautilus） |
| 显示隐藏文件 | 开关 | `show-hidden`（gtk） |
| 永久删除菜单项 | 开关 | `show-delete-permanently`（nautilus） |
| 图片缩略图 | 下拉 | `show-image-thumbnails`（nautilus） |

（沿用现有 `buildSelector`/`buildSwitcher` 的 settings 绑定逻辑，改造成 ActionRow 形态。）

### 样式

- 每行 title + subtitle（描述文字）。
- 窗口 `resizable: true`，设默认尺寸（如 520×600），页面可滚动。
- 保持 `get_schema`/`preferencesFrame` 的导出接口不变（`preferences.js` 调用方不变，
  仅去掉行为 hack）。
- 新增约 14 条 subtitle 翻译字符串，补 zh_CN.po（`msgfmt --check` 校验）。

## 验证

- `scripts/check.sh` 全绿（eslint + 单测 + 结构检查）。
- `msgfmt --check po/zh_CN.po` 通过。
- 用户构建后人工验证：设置窗口不置顶、切换工作区不跟随、任务栏可见；
  设置项绑定生效（改设置后桌面即时变化）。
