# 设置窗口 Adw 重构 + 行为修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 DING 设置窗口像普通应用窗口（不置顶、不跨工作区、任务栏可见），并以 Adw 标准风格重构其样式与布局。

**Architecture:** 行为修复 = 移除 `preferences.js` 中给窗口标题追加两个空格的 hack（Shell 侧解析为置顶+全工作区标记）；UI 重构 = `prefs-window.js` 从 `Gtk.Box` 手排改为 `Adw.PreferencesPage` + 两个 `Adw.PreferencesGroup`，开关行用 `Adw.SwitchRow`，下拉行用 `Adw.ActionRow` + 现有 `Gtk.ComboBox` 逻辑（复用已验证的 `active-id` 绑定，规避本地无显示环境无法验证 `Adw.ComboRow` 的风险）。窗口保持 `Gtk.Window`（`set_child` 已在项目中验证，规避 `Adw.Window.set_content` 的 API 不确定性），改为可调整大小，默认 520×600。

**Tech Stack:** GJS ESM（`import Adw from 'gi://Adw?version=1'`）、libadwaita、GTK4、Gio.Settings 绑定。

## Global Constraints

- 遵循项目 AGENTS.md：构建由用户手动执行；改 JS 文件须同步 meson.build（本计划不增删文件，无影响）；修复 bug 须更新 `docs/fixes.md`。
- 所有新字符串须走 `Gettext.domain('ding').gettext`（ESM 迁移教训）。
- 新增 subtitle 翻译补 `po/zh_CN.po`，必须通过 `msgfmt -o /dev/null --check po/zh_CN.po`。
- 保持 `preferencesFrame(Gtk, desktopSettings, nautilusSettings, gtkSettings)` 导出签名不变（`preferences.js` 调用方）。
- 本地无显示环境无法运行任何 Adw 控件（段错误）——验证手段为 `node --check` + `npx eslint` + `bash scripts/check.sh` + `msgfmt`，最终由用户 `bash scripts/refresh_extension.sh` 人工验证。

---

### Task 1: 行为修复——设置窗口变普通窗口

**Files:**
- Modify: `app/preferences.js`（`showPreferences()` 函数）

**Interfaces:**
- Consumes: 无（既有 `DesktopIconsUtil`、`PrefsWindow` 导出）
- Produces: 无新接口；`prefsWindow` 变为 `Adw.Window` 实例

- [ ] **Step 1: 修改 `showPreferences()`**

将：

```js
export function showPreferences() {
    if (prefsWindow) {
        return;
    }
    prefsWindow = new Gtk.Window({
        resizable: false,
    });
    prefsWindow.connect('close-request', () => {
        prefsWindow = null;
    });
    prefsWindow.set_title(_('Settings'));
    DesktopIconsUtil.windowHidePagerTaskbarModal(prefsWindow, true);
    let frame = PrefsWindow.preferencesFrame(Gtk, desktopSettings, nautilusSettings, gtkSettings);
    prefsWindow.set_child(frame);
    prefsWindow.present();
}
```

改为：

```js
export function showPreferences() {
    if (prefsWindow) {
        return;
    }
    prefsWindow = new Gtk.Window({
        title: _('Settings'),
        resizable: true,
        default_width: 520,
        default_height: 600,
    });
    prefsWindow.connect('close-request', () => {
        prefsWindow = null;
    });
    // Note: no windowHidePagerTaskbarModal() here — its trailing-space
    // title hack made the Shell treat this window as @!HTD (keep-above +
    // all-workspaces + hidden-from-taskbar). The settings window should
    // behave like a normal application window.
    let frame = PrefsWindow.preferencesFrame(Gtk, desktopSettings, nautilusSettings, gtkSettings);
    prefsWindow.set_child(frame);
    prefsWindow.present();
}
```

（保持 `Gtk.Window`，不引入 `Adw.Window`——`set_child` 已是项目验证过的 API，且 `Adw.Window.set_content` 在本地无显示环境无法验证。）

- [ ] **Step 2: 语法与 lint 验证**

Run: `node --check app/preferences.js && npx eslint app/preferences.js`
Expected: 无输出错误

- [ ] **Step 3: 删除不再使用的 `DesktopIconsUtil` import**

`windowHidePagerTaskbarModal` 移除后，`DesktopIconsUtil` 在 preferences.js 中已无其他引用（唯一引用是 L99），删除 `import * as DesktopIconsUtil from './desktop-icons-util.js';` 行（避免 eslint unused 报错）。

- [ ] **Step 4: 提交**

```bash
git add app/preferences.js
git commit -m "fix: settings window is a normal window (no always-on-top / all-workspaces)"
```

---

### Task 2: `prefs-window.js` Adw 重构

**Files:**
- Modify: `app/prefs-window.js`（整文件重构）

**Interfaces:**
- Consumes: Task 1 的调用约定（`preferencesFrame(Gtk, desktopSettings, nautilusSettings, gtkSettings)` 返回 Adw 页面，`prefsWindow.set_content(frame)`）
- Produces: `preferencesFrame`（返回 `Adw.PreferencesPage`）、`buildSwitcher`（返回 `Adw.SwitchRow`）、`buildSelector`（返回 `Adw.ActionRow`）

- [ ] **Step 1: 重构 `buildSwitcher` 为 Adw.SwitchRow**

将现有 `buildSwitcher`（Gtk.Box + Gtk.Switch）整体替换为：

```js
export function buildSwitcher(settings, key, labelText, subtitleText = null) {
    let row = new Adw.SwitchRow({
        title: labelText,
        subtitle: subtitleText,
    });
    if (settings) {
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    } else {
        row.sensitive = false;
    }
    return row;
}
```

（`Gio` 已在文件顶部 import。）

- [ ] **Step 2: 重构 `buildSelector` 为 ActionRow + Gtk.ComboBox**

将现有 `buildSelector` 整体替换为（保留 ListStore + active-id 绑定逻辑，包装进 ActionRow）：

```js
export function buildSelector(settings, key, labelText, elements, subtitleText = null) {
    let listStore = new Gtk.ListStore();
    listStore.set_column_types([GObject.TYPE_STRING, GObject.TYPE_STRING]);
    if (settings) {
        let schemaKey = settings.settings_schema.get_key(key);
        let values = schemaKey.get_range().get_child_value(1).get_child_value(0).get_strv();
        for (let val of values) {
            let iter = listStore.append();
            let visibleText = val;
            if (visibleText in elements) {
                visibleText = elements[visibleText];
            }
            listStore.set(iter, [0, 1], [visibleText, val]);
        }
    }
    let combo = new Gtk.ComboBox({ model: listStore });
    let rendererText = new Gtk.CellRendererText();
    combo.pack_start(rendererText, false);
    combo.add_attribute(rendererText, 'text', 0);
    combo.set_id_column(1);
    if (settings) {
        settings.bind(key, combo, 'active-id', Gio.SettingsBindFlags.DEFAULT);
    } else {
        combo.sensitive = false;
    }
    let row = new Adw.ActionRow({
        title: labelText,
        subtitle: subtitleText,
    });
    row.add_suffix(combo);
    return row;
}
```

- [ ] **Step 3: 重构 `preferencesFrame` 为 Adw.PreferencesPage + 两个 Group**

将 `preferencesFrame` 整体替换为：

```js
export function preferencesFrame(_Gtk, desktopSettings, nautilusSettings, gtkSettings) {
    Gtk = _Gtk;
    let page = new Adw.PreferencesPage();

    // --- Desktop icons group ---
    let desktopGroup = new Adw.PreferencesGroup({
        title: _('Desktop icons'),
    });
    desktopGroup.add(buildSelector(desktopSettings, 'icon-size', _('Size for the desktop icons'), {
        'tiny': _('Tiny'), 'small': _('Small'), 'standard': _('Standard'), 'large': _('Large'),
    }, _('Set the size for the desktop icons')));
    desktopGroup.add(buildSelector(desktopSettings, 'start-corner', _('New icons alignment'), {
        'top-left': _('Top-left corner'),
        'top-right': _('Top-right corner'),
        'bottom-left': _('Bottom-left corner'),
        'bottom-right': _('Bottom-right corner'),
    }, _('Set the corner from where the icons will start to be placed')));
    desktopGroup.add(buildSwitcher(desktopSettings, 'show-home', _('Show the personal folder in the desktop'), _('Show the personal folder in the desktop')));
    desktopGroup.add(buildSwitcher(desktopSettings, 'show-trash', _('Show the trash icon in the desktop'), _('Show the trash icon in the desktop')));
    desktopGroup.add(buildSwitcher(desktopSettings, 'show-volumes', _('Show external drives in the desktop'), _('Show the disk drives connected to the computer')));
    desktopGroup.add(buildSwitcher(desktopSettings, 'show-network-volumes', _('Show network drives in the desktop'), _('Show mounted network volumes in the desktop')));
    desktopGroup.add(buildSwitcher(desktopSettings, 'add-volumes-opposite', _('Add new drives to the opposite side of the screen'), _('When adding drives and volumes to the desktop, add them to the opposite side of the screen')));
    desktopGroup.add(buildSwitcher(desktopSettings, 'show-drop-place', _("Highlight the drop place during Drag'n'Drop"), _('Shows a rectangle in the destination place during DnD')));
    desktopGroup.add(buildSwitcher(desktopSettings, 'use-nemo', _('Use Nemo to open folders'), _('Use Nemo instead of Nautilus to open folders')));
    desktopGroup.add(buildSwitcher(desktopSettings, 'show-link-emblem', _('Add an emblem to soft links'), _('Add an emblem to allow to identify soft links')));
    desktopGroup.add(buildSwitcher(desktopSettings, 'dark-text-in-labels', _('Use dark text in icon labels'), _('Use black for label text')));
    page.add(desktopGroup);

    // --- Nautilus-shared settings group ---
    let nautilusGroup = new Adw.PreferencesGroup({
        title: _('Settings shared with Nautilus'),
    });
    nautilusGroup.add(buildSelector(nautilusSettings, 'click-policy', _('Click type for open files'), {
        'single': _('Single click'), 'double': _('Double click'),
    }, _('How to open files with the mouse')));
    nautilusGroup.add(buildSwitcher(gtkSettings, 'show-hidden', _('Show hidden files'), _('Show hidden files in the desktop')));
    nautilusGroup.add(buildSwitcher(nautilusSettings, 'show-delete-permanently', _('Show a context menu item to delete permanently'), _('Show a context menu item to delete permanently')));
    // Gnome Shell 40 removed this option
    try {
        nautilusGroup.add(buildSelector(nautilusSettings,
            'executable-text-activation',
            _('Action to do when launching a program from the desktop'), {
            'display': _('Display the content of the file'),
            'launch': _('Launch the file'),
            'ask': _('Ask what to do'),
        }, _('What to do when launching a program from the desktop')));
    } catch (e) {
    }
    nautilusGroup.add(buildSelector(nautilusSettings,
        'show-image-thumbnails',
        _('Show image thumbnails'), {
        'never': _('Never'),
        'local-only': _('Local files only'),
        'always': _('Always'),
    }, _('When to show thumbnails for image files')));
    page.add(nautilusGroup);

    return page;
}
```

同时：删除文件顶部 `get_schema` 保持不变；`Gtk` 变量声明保留；顶部新增 `import Adw from 'gi://Adw?version=1';`。删除不再使用的 `Gtk.Separator`/`Gtk.Frame` 相关代码。

- [ ] **Step 4: 语法与 lint 验证**

Run: `node --check app/prefs-window.js && npx eslint app/prefs-window.js`
Expected: 无输出错误

- [ ] **Step 5: 提交**

```bash
git add app/prefs-window.js
git commit -m "refactor: Adw-styled settings window (PreferencesPage + groups + switch/action rows)"
```

---

### Task 3: 补 zh_CN.po 翻译

**Files:**
- Modify: `po/zh_CN.po`

**Interfaces:**
- Consumes: Task 2 引入的 14 条新 subtitle 字符串
- Produces: 可用的中文翻译（`msgfmt --check` 通过）

- [ ] **Step 1: 插入 14 条新翻译**

用 Python 按 msgid 排序插入以下条目（保持 .po 排序惯例，位置在第一个大于各 msgid 的条目之前；参考 Task 2 的字符串，subtitle 与 title 相同的条目可以复用——下面列出全部新字符串）：

| msgid | msgstr |
|---|---|
| Set the size for the desktop icons | 设置桌面图标的大小 |
| Set the corner from where the icons will start to be placed | 设置新图标开始放置的角落 |
| Show the personal folder in the desktop | 在桌面上显示个人文件夹 |
| Show the trash icon in the desktop | 在桌面上显示回收站图标 |
| Show the disk drives connected to the computer | 显示连接到计算机的磁盘驱动器 |
| Show mounted network volumes in the desktop | 在桌面上显示已挂载的网络卷 |
| When adding drives and volumes to the desktop, add them to the opposite side of the screen | 添加驱动器和卷时放到屏幕对侧 |
| Shows a rectangle in the destination place during DnD | 拖放时在目标位置显示矩形 |
| Use Nemo instead of Nautilus to open folders | 使用 Nemo 而不是 Nautilus 打开文件夹 |
| Add an emblem to allow to identify soft links | 添加徽章以识别软链接 |
| Use black for label text | 标签文字使用黑色 |
| How to open files with the mouse | 用鼠标打开文件的方式 |
| Show hidden files in the desktop | 在桌面上显示隐藏文件 |
| What to do when launching a program from the desktop | 从桌面启动程序时的操作 |
| When to show thumbnails for image files | 何时显示图片文件的缩略图 |
| Desktop icons | 桌面图标 |
| Settings shared with Nautilus | 与 Nautilus 共享的设置 |

（注：`Show a context menu item to delete permanently` 的 subtitle 与 title 相同，无需新条目；`Show hidden files` 的 subtitle 是新串 `Show hidden files in the desktop`。共 17 条新增。）

- [ ] **Step 2: 校验 .po 语法**

Run: `msgfmt -o /dev/null --check po/zh_CN.po`
Expected: 无输出（成功）

- [ ] **Step 3: 提交**

```bash
git add po/zh_CN.po
git commit -m "i18n: add zh_CN translations for settings-window subtitles"
```

---

### Task 4: 全量验证 + 文档收尾

**Files:**
- Modify: `docs/fixes.md`

**Interfaces:**
- Consumes: 全部前序任务
- Produces: 可交付状态

- [ ] **Step 1: 跑全量检查**

Run: `bash scripts/check.sh`
Expected: `ALL TESTS PASSED` + `ALL CHECKS PASSED`（131+ 断言、eslint、结构检查、manifest 一致性）

- [ ] **Step 2: 更新 docs/fixes.md**

追加：

```markdown
### 设置窗口置顶且所有工作区可见

**症状：** 打开扩展设置窗口时，窗口置顶、在所有工作区可见、不出现在任务栏。

**根因：** `showPreferences()` 调用 `windowHidePagerTaskbarModal(prefsWindow, true)`，给窗口标题追加两个空格；GNOME Shell 侧 `emulate-x11-window-type.js` 将"两空格结尾的标题"解析为 `@!HTD` 标记（置顶+所有工作区+隐藏）。这是 upstream 让设置窗口模态化的设计。

**修复：** 移除该调用，设置窗口变为普通窗口（不置顶、不跨工作区、任务栏可见）。重命名对话框与错误弹窗保留原行为。

**附带：** 设置窗口按 Adw 标准风格重构（PreferencesPage + 两个分组 + SwitchRow/ActionRow，可调整大小），新增 17 条 zh_CN 翻译。
```

- [ ] **Step 3: 提交**

```bash
git add docs/fixes.md
git commit -m "docs: fixes.md — settings window behavior + Adw restyle"
```

- [ ] **Step 4: 告知用户构建验证**

告知用户运行 `bash scripts/refresh_extension.sh`，人工验证：
1. 设置窗口不置顶、切换工作区不跟随、Alt+Tab/任务栏可见
2. 窗口可调整大小，Adw 分组样式正常，描述文字中文显示
3. 开关/下拉改动即时生效（图标大小、显示主文件夹等）
