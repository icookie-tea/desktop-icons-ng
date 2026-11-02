# 安装与部署参考

从 `README.md` 移出的安装细节。日常使用只需要 README 里的两条命令。

## 用户级安装（常用）

```bash
bash scripts/local_install.sh
```

等价于：

```bash
meson setup --prefix=$HOME/.local/ \
  --localedir=share/gnome-shell/extensions/desktop-icons-ng@icookie-tea.github.io/locale .build
ninja -C .build install
```

不要去掉 `--localedir`，否则翻译会装到错误位置。建议先删除目标目录中的旧内容（脚本已包含这一步）。
脚本 `scripts/ubuntu_install.sh` 在此基础上额外清理历史 UUID 的残留。

加载扩展：

```bash
gnome-extensions enable desktop-icons-ng@icookie-tea.github.io
```

X11 下 `Alt`+`F2` 输入 `r` 重载 Shell；Wayland 需要注销后重新登录。

## 与发行版自带版本共存

本项目使用自己的 UUID `desktop-icons-ng@icookie-tea.github.io`，不与发行版的 `ding@rastersoft.com` 冲突，
但两者同时启用只会显示一套桌面图标，请在扩展应用中只启用一个。
若曾用过本项目的旧 UUID，先移除旧副本，避免同时加载两份：

```bash
rm -rf ~/.local/share/gnome-shell/extensions/ding@rastersoft.com
```

## 系统级安装（需要 sudo）

```bash
bash scripts/global_install.sh
```

等价的手动步骤：

```bash
meson setup --prefix=/usr .build
ninja -C .build
sudo ninja -C .build install
rm -f /usr/share/glib-2.0/schemas/gschemas.compiled
sudo glib-compile-schemas /usr/share/glib-2.0/schemas
```

## 多台机器部署

把构建产物（`share/gnome-shell/extensions/…`、`share/glib-2.0/schemas/…`、`share/locale/…`）复制到每台机器的
`/usr` 下对应位置，然后**在每台机器上**执行：

```bash
sudo glib-compile-schemas /usr/share/glib-2.0/schemas
```

## 打包为扩展 ZIP（上传 extensions.gnome.org）

```bash
./scripts/export-zip.sh
```

生成 `desktop-icons-ng@icookie-tea.github.io.zip`，按 extensions.gnome.org 的要求收集 `.js` / `.css` /
`.json` / `locale/` / `schemas/` / `app/`（`scripts/export-zip.sh:53`）。真正上传前需按 EGO 当前规则核对
`metadata.json` 与 schema 声明。
