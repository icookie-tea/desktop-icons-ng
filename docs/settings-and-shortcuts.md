# 设置项与快捷键参考

从 `README.md` 移出的参考清单，便于逐项查阅。

## gsettings 设置项

schema：`schemas/org.gnome.shell.extensions.ding.gschema.xml`（命名空间 `org.gnome.shell.extensions.ding`）。
设置窗口属于桌面进程；也可以直接用 gsettings 修改，例如：

```bash
gsettings set org.gnome.shell.extensions.ding icons-only-on-primary true
```

| 键 | 默认 | 含义 |
|---|---|---|
| `icon-size` | `standard` | 图标大小 |
| `start-corner` | `top-left` | 新图标的起始角落 |
| `arrangeorder` | `NAME` | 排序依据（名称/大小/类型/日期） |
| `keep-arranged` | `false` | 始终保持排列 |
| `icons-only-on-primary` | `false` | 图标仅放置在主显示器 |
| `use-accent-color` | `true` | 选框/框选/拖放预览跟随系统强调色（关闭则固定灰色） |
| `accent-shade-follow-color-scheme` | `false` | 强调色深浅跟随配色方案。默认关闭：浅色与深色方案都用较亮的深色档，因为壁纸不随配色变化 |
| `show-home` | `true` | 显示主目录 |
| `show-trash` | `true` | 显示垃圾桶 |
| `show-volumes` | `true` | 显示可移动驱动器 |
| `show-network-volumes` | `false` | 显示网络驱动器 |
| `add-volumes-opposite` | `true` | 新挂载项加在与起始角落相对的一侧 |
| `sort-special-folders` | `false` | 排序时包含主目录/垃圾桶/驱动器等特殊项 |
| `show-drop-place` | `true` | 显示拖放落点矩形 |
| `show-link-emblem` | `true` | 符号链接显示徽标 |
| `dark-text-in-labels` | `false` | 标签使用黑色文字 |

## 快捷键

实现见 `app/keyboard-manager.js:61-219`：`onKeyRelease` 处理方向键移动，`onKeyPress` 处理快捷键，
作用于当前选中项与键盘焦点图标；右键菜单打开时 `onKeyPress` 直接返回 false。

| 按键 | 作用 |
|---|---|
| 方向键 / `Home` / `End` | 移动键盘焦点 |
| `Space` | 预览选中项 |
| `Return` / `Alt`+`Return` | 打开 / 属性 |
| `F2` | 重命名 |
| `Ctrl`+`Space` | 切换选中 |
| `Ctrl`+`A` / `Esc` | 全选 / 取消选择 |
| `Ctrl`+`C` / `X` / `V` | 复制 / 剪切 / 粘贴 |
| `Ctrl`+`H` | 显示/隐藏隐藏文件 |
| `Ctrl`+`F` | 搜索对话框 |
| `F5` | 刷新桌面 |
| `Menu` / `Shift`+`F10` | 打开右键菜单 |
| `Ctrl`+`+` / `Ctrl`+`-` | 放大 / 缩小图标 |

## 独立运行与调试

桌面进程可以脱离 Shell 扩展单独运行，用于本地测试。此时它表现为普通 GTK 程序：带标题栏、背景不透明。

```bash
gjs --module app/ding.js -P app
```

若提示找不到 schema，先在 `schemas/` 目录下执行 `glib-compile-schemas .` 再重试。

参数（以 `gjs --module app/ding.js -h` 的输出为准，`app/ding.js:42-60`）：

| 参数 | 含义 |
|---|---|
| `-h` | 显示用法 |
| `-E` | 以真实桌面模式运行（透明窗口，数据由 Shell 扩展提供） |
| `-P path` | 代码所在路径（默认 `./`） |
| `-M index` | 指定哪个监视器是主监视器（新文件图标会加到这里） |
| `-D x:y:w:h:z:t:b:l:r:i` | 一个监视器的定义，每个监视器写一次 |

`-D` 各字段：`x`/`y` 原点坐标，`w`/`h` 像素尺寸，`z` 缩放（须 ≥ 1），`t`/`b`/`l`/`r` 上/下/左/右边距（像素），
`i` 监视器索引（0、1、……）。不提供 `-D` 时，会以 **1900×1000** 创建单个桌面用于独立模式
（`app/ding.js:143-144`）。

环境变量：`DING_SMOKE=1` 让窗口消耗全部按键事件，避免调试时的按键触发真实桌面逻辑；
扩展侧设 `DING_DEBUG=1` 才输出详细日志（`extension.js:34-37`），避免监视器变化时刷屏。
