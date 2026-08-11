# DING 手动回归清单（audit-fixes 批次，2026-08-09）

> 针对提交 `f147f54`（分支 `fix/code-audit-2026-08`，30 文件 +723/−255）的手动验证。
> 自动化状态：`scripts/check.sh` 全绿（eslint 零违规 / node --check / 8 测试组 69 断言 / 结构检查）。
> 自动化只覆盖纯函数，以下**交互行为**均无自动化覆盖，必须真机验证。

## 构建

```bash
bash scripts/refresh_extension.sh
```

构建后重启 GNOME Shell（Alt+F2 → `r`）或注销重登使新扩展生效。

---

## 一、核心回归（对应本次修复，逐项验证）

### 1. 新建文件夹自动改名（P0-1 恢复触发链）
- [ ] 桌面空白右键 → **新建文件夹**
- **预期**：自动弹出改名框，新文件夹名处于可编辑状态（此前静默失效：创建后不弹框）
- **反向**：改名框输入新名回车后，不再次弹框（`newFolderDoRename` 清空逻辑正常）

### 2. Nautilus Scripts 子菜单（P0-3 恢复脚本功能）
准备：
```bash
mkdir -p ~/.local/share/nautilus/scripts
cat > ~/.local/share/nautilus/scripts/hello.sh <<'EOF'
#!/bin/sh
echo "selected: $NAUTILUS_SCRIPT_SELECTED_FILE_PATHS" > /tmp/ding-script-test.txt
EOF
chmod +x ~/.local/share/nautilus/scripts/hello.sh
```
- [ ] 桌面**选中一个图标** → 右键 → 菜单出现 **Scripts** 子菜单 → 点 hello.sh
- **预期**：`/tmp/ding-script-test.txt` 生成，内容含选中文件的路径；无"当模板处理"的行为
- [ ] 脚本目录为空时菜单不出现（删除脚本后验证）
- [ ] 脚本子目录嵌套正常（可选）

### 2b. 图标右键菜单打开/关闭（新增修复：NESTED flag 残留）
- [ ] 图标右键 → 菜单正常出现（无箭头、菜单在鼠标右侧）
- [ ] 打开 **Scripts 子菜单**（或任意含子菜单的项）→ 移开鼠标 → **点击空白处**
- **预期**：整个菜单（含子菜单）**正常关闭**（修复前：关闭子菜单后 grab 损坏，点击外部菜单不消失）
- [ ] 多级子菜单（脚本子目录）同样验证
- [ ] 键盘路径：选中图标按 Shift+F10 或 Menu 键 → 菜单出现 → Esc 关闭 → 方向键继续导航正常（closed 后焦点恢复）

### 3. 文件操作进度框以桌面窗口为父（P0-2 platformData）
- [ ] 从桌面复制/移动一个**大文件**（≥500MB，跨分区更佳，否则进度框一闪而过）到文件夹
- **预期**：Nautilus 进度对话框以桌面窗口为父（出现在桌面之上居中，而非独立位置）；操作后无 journal 报错
- **回归**：普通小文件复制/移动/重命名/删除/回收站/清空回收站均正常（platform_data 不再为空，确保没改坏调用链）

### 4. Shell 热重启无残留进程（P0-4 killAll 修复）
- [ ] 重启 GNOME Shell（纯 Wayland 下 Alt+F2→r 已不可用，任选其一）：
  - `killall -3 gnome-shell`（SIGQUIT，gnome-session 自动重启 shell；会关闭当前应用窗口）
  - 或注销重登（最干净，完整触发扩展 init → doKillAllOldDesktopProcesses）
- **预期**：重启后桌面正常出现
- 验证：
```bash
pgrep -af "ding.js"
```
- **预期**：只有一个 ding.js 进程（修复前旧进程存活 → 双进程争 D-Bus 名 → 新进程无限重启循环，桌面图标丢失）

### 5. 加密压缩包密码取消无泄漏（P1-3）
准备（如无加密 zip 可跳过或临时生成：`zip -P secret 加密.zip 文件`，需 zip 支持加密）：
- [ ] 右键加密 zip → 提取到... → 密码框出现 → 点 **Cancel**
- **预期**：进度窗口元素消失（无残留）；随后可以正常注销/休眠（`_inhibitCookie` 已释放）
- 验证抑制是否释放：Cancel 后 `dbus-monitor "interface='org.freedesktop.login1.Manager'"` 观察 Inhibit/Uninhibit，或直接试注销

### 6. F5 刷新后立刻新建文件无重复图标（P1-2 增量去重）
- [ ] 按 F5 刷新桌面，**紧接着**（2 秒内）在桌面新建一个文件（`touch ~/Desktop/测试重复.txt`）
- **预期**：桌面上**只有一个**该文件图标（修复前竞态可能出两个重叠图标）
- 多试几次（竞态窗口小）；试完删除测试文件

### 7. Overview 淡入淡出动画正常（P1-6 防护未误伤）
- [ ] 进/出 Overview 多次（Super 键）
- **预期**：桌面图标平滑淡入淡出，与之前一致
- 验证无降级日志：
```bash
journalctl --user -b | grep "overview animation setup failed"
```
- **预期**：无输出（有输出说明注入失败降级，动画没了）

### 8. Ctrl+F 连续调用（P2-1 窗口守卫）
- [ ] 连续按两次 Ctrl+F
- **预期**：第一次打开搜索对话框；第二次**关闭旧窗口并打开新窗口**（修复前：双窗口共存，旧窗口按钮关的是新窗口）

### 9. 基础功能回归（确认本次改动没改坏）
- [ ] 左键单击选中 / 拖框橡皮筋选择
- [ ] 图标右键菜单完整（打开/打开方式/压缩/提取/发送到/属性/剪切复制粘贴等）
- [ ] 拖拽图标移动（位置保存正常）；拖拽到文件夹
- [ ] 双击打开文件；双击打开文件夹（走系统默认文件管理器）
- [ ] Ctrl+V 粘贴（Nautilus 复制文件后）；Ctrl+Shift+N 新建文件夹
- [ ] 键盘导航（方向键/Enter/F2 重命名/Delete）
- [ ] 排序/堆叠（右键 → 排列图标 → 按名称/类型/大小/时间；堆叠开启）
- [ ] 设置面板开关项（强调色/选中颜色开关、图标大小）实时生效
- [ ] 双屏（如有）：图标落位、主屏切换、多屏拖拽

### 10. 重命名增量更新（不再全量刷新）
- [ ] F2 重命名一个文件和一个文件夹；再用 Nautilus 重命名一个文件
- **预期**：图标标签原位更新、无闪动（修复前整桌图标销毁重建）；位置保持不变
- 日志验证（DING_DEBUG=1）：`[monitor] RENAME incremental old=... new=...`，**无** `FULL REFRESH reason=directory monitor` / `[draw] rebuild`

### 11. 内容/属性变化单图标刷新（CHANGES_DONE_HINT，P1）
- [ ] 用编辑器修改桌面上的图片后保存（或 `cp` 覆盖），观察缩略图
- **预期**：该图标缩略图 1~2 秒内自动更新（modifiedTime 失效重生成），**其余图标无闪动**
- [ ] `chmod +x ~/Desktop/某文件` 后观察图标/可执行标识变化
- 日志（DING_DEBUG=1）：`[monitor] content/attr change ... -> refresh metadata`，无全量刷新

### 12. 拖入子文件夹/移出桌面增量删除
- [ ] 把桌面图标拖进桌面上的文件夹；再移出一个文件到非桌面目录
- **预期**：仅该图标消失，无全桌闪动
- 日志（DING_DEBUG=1）：`[monitor] MOVED_OUT old=... new=null` → `[monitor] DELETED ...`

---

## 二、已知无害警告（无需处理）

```
GVFS-WARNING **: meta_journal_iterate: found wrong sized entry, possible journal corruption
```
- gvfs-metadata 的 journal 损坏警告（可能源于异常关机/daemon 被杀），与本次修改无关
- GVFS 容错跳过坏条目；影响仅为个别文件图标位置元数据可能丢失
- 处理：观察即可；如反复出现，`pkill -f gvfs-metadata && rm -f ~/.local/share/gvfs-metadata/home*`（会丢一次图标位置记忆）

---

## 三、测试结果记录

| # | 项 | 通过 | 备注（现象/失败详情） |
|---|----|------|----------------------|
| 1 | 新建文件夹自动改名 | ☐ | |
| 2 | Scripts 子菜单 | ☐ | |
| 3 | 进度框父窗口 | ☐ | |
| 4 | Shell 热重启无残留 | ☐ | |
| 5 | 密码取消无泄漏 | ☐ | |
| 6 | 增量去重 | ☐ | |
| 7 | Overview 动画 | ☐ | |
| 8 | Ctrl+F 守卫 | ☐ | |
| 9 | 基础功能 | ☐ | |

---

## 四、后续工作候选（测试通过后再定）

### A. 补自动化测试（高价值缺口，按优先级）
| 优先级 | 目标 | 测什么 | 难度 |
|--------|------|--------|------|
| 高 | `app/theme-manager.js` `_readUserAccentOverride` | gtk.css + @import 链解析、剥注释、取最后 `@define-color`、RGBA 校验（2026-08-05 靠手工探测验证，无自动化） | 中 |
| 高 | `app/sort-manager.js` 堆叠排序 | `_sortAllFilesFromGridsByKindStacked` / `_restoreStackInitialCoordinates`（O(n²)→O(n) 重写无测试锁定） | 低-中 |
| 高 | `emulate-x11-window-type.js` `_parseTitle` | 标题协议解析（`@!x,y;flags`、尾空格别名、回退定位）——纯 JS mock，无需 Meta typelib | 中 |
| 中 | `visible-area.js` 边距数学 | workarea vs monitor、`_usableAreas` 覆盖规则 | 低 |
| 中 | `app/file-operations.js` 重名去重 | `fileExistsOnDesktop` / `getDesktopUniqueFileName` | 低-中 |
| 中 | `app/desktop-monitor.js` 事件路由 | `_processIncrementalEvents` DELETED/CREATED/MOVED_IN/MOVED_OUT/超限回退 | 中-高 |

### B. 剩余审计项（docs/code-audit.md 未实施）
| 项 | 内容 | 风险 | 备注 |
|----|------|------|------|
| P2-8 | Overview 克隆层只在 `WorkspaceBackground._init` 时捕获窗口——DING 崩溃重启后新窗口不补进动画层 | 中 | 需 Shell 侧 `window_manager 'map'` 动态补建 |
| P2-2 | 拖拽/橡皮筋绘制每帧分配 `Graphene.Rect`/`Gsk.RoundedRect`/`Stroke`/`PathBuilder` | 低 | 性能优化 |
| P2-9 | 启动时同步全量扫描 /proc + 阻塞 `wait()` | 低 | 启动性能 |
| P1-8 | `visible-area.js` deprecated Meta API | 低 | 与 upstream 逐字节一致，建议 Shell 52 适配时一并做 |
| P3 | 杂项清理（未门控 console.log×2、eject/unmount 回调无错误处理、theme-manager idle 存活标志、`gtk_application_prefer_dark_theme` 弃用、emulate-x11 注释 H 标志等） | 低 | 可批量顺手做 |

### C. 分支收尾
- 测试全部通过后：合并 `fix/code-audit-2026-08` → `icookie`（或按你的偏好推送 PR/保持分支）
- 合并后如需继续实施 A/B 项，新建下一个分支
