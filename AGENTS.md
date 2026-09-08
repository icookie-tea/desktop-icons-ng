# DING - Desktop Icons NG

## 项目概况
GNOME Shell 桌面图标扩展，是官方 Desktop Icons 的 fork/rewrite。包含两部分：
- GTK4 桌面应用（管理桌面图标、拖拽、右键菜单等）
- GNOME Shell 扩展（extension.js, visibleArea.js, emulateX11WindowType.js）

## 构建与运行

构建由用户手动执行，修改完代码后告知用户即可。

## 项目约定
- JavaScript 文件使用 GNOME Shell JavaScript (GJS)
- 修改代码后需要更新对应的文档，例如修复bug需要更新 docs/fixes.md
- **新增/移动/删除 JS 文件时必须同步更新 meson.build 安装清单**（否则构建能通过但安装后缺文件，运行时报 `No JS module ... found`）：
  - `app/*.js` 新文件 → 加入 `app/meson.build` 的 `install_data` 列表
  - 根目录新文件（`extension.js`、`prefs.js`、`visibleArea.js`、`emulateX11WindowType.js`、`gnomeShellOverride.js`、`metadata.json`）→ 加入根 `meson.build` 的 `install_data` 列表
  - 脚本文件（`scripts/`）不安装，无需改 meson.build，但需同步 `scripts/README.md`
  - 验证清单完整性：
    ```bash
    comm -3 <(ls app/*.js | xargs -n1 basename | sort) <(grep -oE "'[A-Za-z0-9-]+\.js'" app/meson.build | tr -d "'" | sort)
    # 输出为空 = 一致
    ```

## 重要文件
- `extension.js` — 扩展入口
- `prefs.js` — 偏好设置
- `metadata.json` — 扩展元数据
- app/ - GTK4 桌面应用
