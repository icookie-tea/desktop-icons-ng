# DING - Desktop Icons NG

## 项目概况
GNOME Shell 桌面图标扩展，是官方 Desktop Icons 的 fork/rewrite。包含两部分：
- GTK4 桌面应用（管理桌面图标、拖拽、右键菜单等）
- GNOME Shell 扩展（根目录 JS：`extension.js`、`visible-area.js`、`emulate-x11-window-type.js`、
  `gnome-shell-override.js`、`title-protocol.js`）

## 构建与运行

构建由用户手动执行，修改完代码后告知用户即可。

## 项目约定
- JavaScript 文件使用 GNOME Shell JavaScript (GJS)
- 修改代码后需要更新对应的文档，例如修复bug需要更新 docs/fixes.md
- **新增/移动/删除 JS 文件时必须同步更新 meson.build 安装清单**（否则构建能通过但安装后缺文件，运行时报 `No JS module ... found`）：
  - `app/*.js` 新文件 → 加入 `app/meson.build` 的 `install_data` 列表
  - 根目录新文件（`extension.js`、`prefs.js`、`visible-area.js`、`emulate-x11-window-type.js`、
    `gnome-shell-override.js`、`title-protocol.js`、`metadata.json`）→ 加入根 `meson.build` 的 `install_data` 列表
  - 脚本文件（`scripts/`）不安装，无需改 meson.build，但需同步 `scripts/README.md`
  - 验证清单完整性：
    ```bash
    comm -3 <(ls app/*.js | xargs -n1 basename | sort) <(grep -oE "'[A-Za-z0-9-]+\.js'" app/meson.build | tr -d "'" | sort)
    # 输出为空 = 一致
    ```

## 重要文件
- `extension.js` — 扩展入口（启动桌面进程、上报监视器/桌面几何）
- `prefs.js` — 偏好设置（齿轮会通过 D-Bus 唤起桌面进程自己的设置窗口）
- `visible-area.js` — 计算可用桌面区域（避开顶栏与 Dock）
- `emulate-x11-window-type.js` — 把桌面窗口钉住（`Meta.WindowType.DESKTOP`、`make_above()`、`stick()`）
- `title-protocol.js` — 解码桌面进程窗口标题里的几何与徽标标志
- `gnome-shell-override.js` — 覆盖 `WorkspaceBackground.prototype._init`，把壁纸挂到图标层
- `metadata.json` — 扩展元数据（`shell-version` 与代码里的 GNOME 版本需同步）
- `schemas/org.gnome.shell.extensions.ding.gschema.xml` — 全部设置项与默认值
- `app/` — GTK4 桌面应用（图标、网格布局、拖放、菜单、剪贴板、缩略图、设置窗口）
