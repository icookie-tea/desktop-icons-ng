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

## 重要文件
- `extension.js` — 扩展入口
- `prefs.js` — 偏好设置
- `metadata.json` — 扩展元数据
- app/ - GTK4 桌面应用

## Codegraph

This project uses codegraph for codebase knowledge.
ALWAYS prefer codegraph_explore over grep/glob for code discovery.

### Priority Order
1. `codegraph_explore` — find functions, classes, routes, variables by pattern
2. `codegraph_search` — search codebase
3. `codegraph_graph` — explore project structure
4. `codegraph_reveal` — get detailed file info
