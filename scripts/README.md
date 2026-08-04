# scripts/ — 构建、安装与开发脚本

所有脚本都可通过任意工作目录调用（内部会自行定位仓库根目录）。

| 脚本 | 用途 | 运行方式 |
|------|------|---------|
| `check.sh` | 开发检查：ESLint + 语法检查 + 单元测试 | `bash scripts/check.sh` |
| `local_install.sh` | 本地（用户级）安装到 `~/.local` | `bash scripts/local_install.sh` |
| `global_install.sh` | 系统级安装到 `/usr`（需要 sudo） | `bash scripts/global_install.sh` |
| `ubuntu_install.sh` | Ubuntu 变体安装（装为 `dingubuntu@rastersoft.com`，避免与发行版内置 DING 冲突） | `bash scripts/ubuntu_install.sh` |
| `refresh_extension.sh` | 开发热刷新：重建 + 重装 + 杀掉运行中的 DING 进程（自动选择 ubuntu/local 安装方式） | `bash scripts/refresh_extension.sh` |
| `export-zip.sh` | 打包 `ding@rastersoft.com.zip` 用于 extensions.gnome.org | `bash scripts/export-zip.sh` |
| `kill.py` | 杀掉所有 `ding.js` 进程（被 `refresh_extension.sh` 调用，也可单独使用） | `python3 scripts/kill.py` |
| `meson_post_install.py` | meson 安装后处理（编译 GSettings schemas） | 由 `meson.build` 自动调用 |

## 依赖

- 构建：`meson`、`ninja`、`xgettext`、`glib-compile-schemas`
- `check.sh`：`node`（ESLint）、`gjs`（单元测试）、`npm install`（首次运行前）
