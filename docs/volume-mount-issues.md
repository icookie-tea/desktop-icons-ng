# 外部/网络驱动器逻辑问题清单

> 审查日期：2026-08-22（以 git log 为准）
> 范围：VolumeMonitor 接入、mount 生命周期、eject/unmount、网络卷刷新
> 涉及文件：`app/mount-manager.js`（2026-09-04 自 desktop-manager 拆出，承载 VolumeMonitor 信号、异步 mount 查询与重试调度）、`app/desktop-manager.js`（刷新快路径）、`app/desktop-icons-util.js`、`app/file-item.js`、`app/file-item-menu.js`、`app/enums.js`
> 验证方式：代码审读 + 本机 gjs 运行时实验（实验脚本与原始输出见文末附录）
>
> **修复状态（2026-09-02，分支 `fix/volume-mount-robustness`）：** V-1 ~ V-7 已修复（单元测试 `tests/test-volume-mount.js`，详见 `docs/fixes.md` 2026-09-02 条目）；V-8 / V-9 未修复（低优先级/待验证）。

## 涉及的核心代码路径

| 环节 | 位置 |
|---|---|
| VolumeMonitor 信号（`mount-added` / `mount-changed` / `mount-removed`） | `app/mount-manager.js` `_connectSignals()` |
| mount 列表获取与"本地/网络"分类 | `app/desktop-icons-util.js:234-259` `getMounts()` |
| 全量刷新中为每个 mount 建 FileItem（异步 `query_info`） | `app/mount-manager.js` `_readMountsAsync()` |
| 刷新快路径（URI 集合不变时复用旧 FileItem） | `app/desktop-manager.js:1257-1277` |
| FileItem 持有 GMount（`_custom` 唯一赋值点） | `app/file-item.js:43` |
| 驱动器显示名 / 图标取自 GMount | `app/file-item.js:249-250`、`app/desktop-icon-item.js:652` |
| `eject()` / `unmount()` | `app/file-item.js:632-645` |
| `canEject` / `canUnmount` | `app/file-item.js:744-760` |
| Eject/Unmount 菜单项与 GAction | `app/file-item-menu.js:108-115, 385-404` |
| 查询属性集（含 `access::*`） | `app/enums.js:94` `DEFAULT_ATTRIBUTES` |

---

## 问题清单

### V-1 【已确认·P1·已修复】eject/unmount 失败无任何用户反馈

**证据（运行时实验复现）：** 对已卸载（stale）的 GMount 调用 DING 同款代码路径，回调中 `*_finish` 抛出未捕获异常：

```
stale unmount-op callback THROWS (DING has NO catch here): 挂载未实现“eject”或“eject_with_operation”
```

**代码：** `app/file-item.js:632-645`

```js
eject() {
    if (this._custom) {
        this._custom.eject_with_operation(Gio.MountUnmountFlags.NONE, null, null, (obj, res) => {
            obj.eject_with_operation_finish(res);   // 失败即 throw，无 try/catch
        });
    }
}
```

**影响：**
- 高频场景：共享目录被 Nautilus 占用时点"卸载"→ 失败（卷忙），DING 静默无反应，用户以为操作成功或界面卡死；
- 无权限 / 已卸载 / stale mount 同样静默失败；
- 异常堆栈打到 stderr（GNOME Shell 日志），与代码库其他位置失败走 `_logAndPopupError` 弹 `ShowErrorPopup` 的惯例不一致（对照 `app/file-item.js` `_doOpenContext` 对 open 失败的处理）。

**修复方向：** 回调内 try/catch，失败走 `_logAndPopupError`；同步调用 `*_with_operation` 本身也包一层。

---

### V-2 【已确认·P1·已修复】刷新快路径持有 stale GMount，且 F5 无法自愈

**代码证据：**
- `_custom` 全代码库仅在构造函数赋值一次（`app/file-item.js:43`），复用路径（`app/desktop-manager.js:1257-1277`）只更新 `_fileInfo`、坐标、暗色 class，**不更新 `old._custom`**，新 mount 对象随 `newItem._onDestroy()` 被丢弃；
- 显示名 `_getVisibleName()` 读 `this._custom.get_name()`（`app/file-item.js:249-250`），即读 stale mount 的缓存名。

**触发序列（竞态窗口 ≈ `MOUNT_REMOVED_DELAY_MS` 500ms + 一次刷新时长）：**
1. U 盘 A 挂载在 `/run/media/user/X`（`_fileList` 含该 icon）；
2. 拔出 → `mount-removed` → 刷新被延迟 500ms（`app/mount-manager.js` mount-removed 处理器）；
3. 500ms 内插回同一 U 盘（或同标签盘）→ `mount-added` 立即触发刷新，此时旧 `_fileList` **仍含旧条目**；
4. 新列表 URI 集合与旧列表相同 → 走快路径复用 → 旧 FileItem 保留 stale mount A；
5. **此后每次刷新（包括 F5）URI 集合都不变 → 永远走快路径 → stale 状态无法自愈**，只有出现第二个不同 URI 的 mount 或重启进程才恢复。

**stale 状态的实测行为（gvfs 后端，见附录实验 2）：**

| 调用 | stale 结果 |
|---|---|
| `can_unmount()` | **仍返回 true** → 右键菜单仍显示"卸载" |
| `can_eject()` | false |
| `get_name()` / `get_default_location()` | 返回缓存值（不抛异常） |
| `eject_with_operation()` | 异步回调 throw（见 V-1） |

即用户可见症状：点"卸载"无反应（V-1）；若 stale 的是 udisks 后端 U 盘，`can_eject` 可能返回 GDBusProxy 缓存的旧值 true（**此变体未实测**，本机 polkit 限制无法挂载 U 盘，见"未验证项"），症状为菜单显示"弹出"但点击静默失败。

**修复方向：** 快路径复用循环中对 `EXTERNAL_DRIVE` 项补 `old._custom = newItem._custom`（随后 `_updateMetadataFromFileInfo` 会重算显示名）；一行级改动。

---

### V-3 【机制确认·P2·已修复】网络挂载的同步 `query_info` 在主循环执行，死服务器场景会冻结整个桌面图标进程

**代码：** 原 `app/desktop-manager.js`（现 `app/mount-manager.js` `_readMountsAsync()`）的同步 `query_info`（位于 `enumerate_children_finish` 回调内，即主循环）：

```js
newFolder.query_info(Enums.DEFAULT_ATTRIBUTES, Gio.FileQueryInfoFlags.NONE, null)
```

`DEFAULT_ATTRIBUTES` 含 `access::*`（`app/enums.js:94`），对 gvfs 网络卷意味着跨网络 stat。

**实测：** 服务器在线时仅 10ms（无感）。**服务器不可达时未实测**（需要一台死掉的 SMB 服务器），但机制上：gvfsd 会等网络超时（SMB 协议级，通常 30s 量级甚至更长），期间 DING 主循环完全阻塞——所有图标不可点、拖拽停摆，且**每次全量刷新（F5、设置变化、任意 mount 事件）都会对每个网络卷重复此查询**。

**修复方向：** mount 的 info 查询改 `query_info_async`（`_doReadAsync` 已是 Promise 结构）；或 mount 项使用裁剪属性集（图标只需 `standard::icon`、`standard::display-name`，实测 9ms）。注意：即使服务器在线，每次刷新都新建再销毁 mount 的 FileItem 也是浪费。

---

### V-4 【已确认·P2】未挂载的可移动卷从不显示（设计决策待确认）

**运行时证据：** 本机插着 USB 盘 "Windows"（已连接、未挂载）：

```
== mounts (get_mounts) ==
  smb://...   ← 只有已挂载的
== volumes (get_volumes) ==
  volume: Windows  mounted=UNMOUNTED   ← 存在，但 get_mounts() 不含它
```

`getMounts()`（`app/desktop-icons-util.js:234-259`）只遍历 `volumeMonitor.get_mounts()`，因此：
- auto-mount 被禁用的 U 盘 / SD 卡 → 桌面永不显示（Nautilus 会显示未挂载图标）；
- 空白 CD / 需手动挂载的介质 → 同上。

**这是当前实现的行为事实，是否要补齐属于产品决策**（补齐需监听 `volume-added` / `drive-connected` 并渲染 `GVolume`/`GDrive`，处理"未挂载"图标语义与菜单，工作量中等）。若不补齐，建议在 README/偏好设置说明中写明"仅显示已挂载的卷"。

---

### V-5 【已确认·P3·已修复】菜单 GAction 回调缺 null 守卫

**代码：** `getFileItemFromURI()` 找不到时返回 `null`（`app/desktop-manager.js:1549-1556`），而所有按 URI 取 item 的动作直接解引用，例如 `app/file-item-menu.js:108-115`：

```js
this._addNewAction('eject-drive', null, (action, parameter) => {
    const file = this._desktopManager.getFileItemFromURI(parameter.get_string()[0]);
    file.eject();   // file 可能为 null → TypeError
}, 's');
```

驱动器相关触发路径：菜单打开期间卷被卸载（通知栏点弹出、其他进程 umount）→ 点击菜单项 → TypeError 打 stderr。同类无守卫的还有 `rename-file`、`delete-file`、`toggle-allow-launching`、`cut/copy`（普通文件被外部删除同理）。

**修复方向：** 各回调开头 `if (!file) return;`（可顺手统一处理）。

---

### V-6 【已确认·P3·已修复】mount 图标创建瞬时失败后无重试

**代码：** 原 `app/desktop-manager.js`（现 `app/mount-manager.js` `_readMountsAsync()`），mount 的 `query_info` / FileItem 构造失败仅 `print` 后跳过。

**场景：** `mount-added` 触发刷新时 gvfs/udisks 守护进程尚未就绪（冷启动、挂载点目录尚未创建），该卷图标缺失，直到下一次**不相关**的刷新事件（F5、设置变化、其他 mount 事件）才可能恢复。

**修复方向：** `mount-added` 处理中追加一次 1~2s 后的延迟二次刷新；或记录失败的 mount，刷新时对其单独重试。

---

### V-7 【已确认·P3·已修复】未监听 `mount-changed`

只接了 `mount-added` / `mount-removed`（现 `app/mount-manager.js` `_connectSignals()`）。实际影响有限——udisks 改盘符标签通常伴随挂载点路径变化（新 URI → 全量重建 → 名字自然更新）；gvfs 卷的属性变化（如 `can-unmount` 翻转）不会即时反映到菜单，直到下次任意刷新。顺手补一个 `mount-changed → _updateDesktopSafe` 即可，成本极低。

---

### V-8 【已确认·P4】桌面目录不存在时，驱动器与 Home/Trash 图标一并消失

**代码：** `app/desktop-manager.js:1125-1128`：

```js
if (!this._desktopDir.query_exists(null)) {
    fileList = [];
    break;
}
```

`~/Desktop` 被删/改名后，外部驱动器、Home、Trash 图标全部消失（不只是桌面文件）。行为可以辩护，但较意外；若要改，此分支应仍保留 extra folders + mounts。

---

### V-9 【待运行时验证·P4】无 drive/volume 的本地挂载被归入"网络驱动器"

`getMounts()` 的分类是 `isDrive = (drive != null) || (volume != null)`，取反即受 `show-network-volumes` 开关控制（`app/desktop-icons-util.js:244-248`）。

实测：gvfs `smb://` 卷 → 正确归为网络。理论风险：loop 挂载的 ISO 等无 drive/volume 的本地挂载会被归为"网络"，用户关"显示网络驱动器"时 ISO 一起消失。但 UDisks2 对 `udisksctl loop-setup` 的 loop 设备大概率带 drive 对象（归为本地），且 volume monitor 默认不报告系统挂载（bind mount 等），**实际风险较低，未实测**（无 sudo 无法建 loop 设备）。

---

## 未验证项（环境限制 + 验证方法）

| 项 | 限制 | 验证方法 |
|---|---|---|
| udisks 后端 stale GMount 的 `can_eject` 是否返回缓存 true | 本沙箱 gjs 无 polkit 授权，无法挂载 U 盘（`Not authorized to perform operation`）；无 sudo | 在有图形会话的终端手动：`gjs -m 附录脚本2`（把目标换成 U 盘 mount），或直接用 DING 触发 V-2 竞态后看菜单 |
| 死服务器下同步 `query_info` 的实际阻塞时长 | 需要一台不可达的 SMB/NFS 服务器 | 对不可达 host 建 gvfs 挂载后跑 `附录脚本1`，观察 `sync query_info(ALL attrs)` 耗时 |
| V-2 竞态在真实 DING 进程中的完整复现 | 需要在 500ms 窗口内快速拔插 | 插 U 盘 → 快速拔出再插回（<1s）→ 观察图标菜单的"卸载"是否点不动、F5 是否无法恢复 |

## 实验副作用说明

验证过程中卸载并重新挂载了 `smb://10.222.22.212/project/`（已恢复，两个 SMB 挂载均在线）；未对任何本地介质做写操作。

---

## 建议修复顺序（2026-09-02 前）

1. **V-2**（一行改动，消除 stale mount 根源，连带改善 V-1 的一个触发面）
2. **V-1**（eject/unmount 错误反馈，高频用户可感知）
3. **V-5**（null 守卫，防 TypeError）
4. **V-3**（mount 查询异步化 / 属性裁剪，网络卷健壮性）
5. **V-6 / V-7**（低成本顺手项）
6. **V-4**（先做产品决策：是否显示未挂载卷）
7. **V-8 / V-9**（低优先级，可讨论）

## 附录：实验脚本与原始输出

脚本（已存于 /tmp，此处存档）：

**脚本 1：挂载列表 + stale 探测 + 耗时（vm-check.js / vm-check2.js / vm-check5.js 合并版）**

```js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const vm = Gio.VolumeMonitor.get();
const ATTRS = 'metadata::*,standard::*,access::*,time::modified,unix::mode';

console.log('== mounts ==');
for (const m of vm.get_mounts()) {
    const uri = m.get_default_location().get_uri();
    const isDrive = (m.get_drive() != null) || (m.get_volume() != null);
    console.log(`  ${uri}  driveOrVolume=${isDrive}  name="${m.get_name()}"  can_eject=${m.can_eject()}  can_unmount=${m.can_unmount()}`);
}
console.log('== volumes (含未挂载) ==');
for (const v of vm.get_volumes()) {
    console.log(`  ${v.get_name()}  mounted=${v.get_mount() ? 'yes' : 'UNMOUNTED'}`);
}

// 对指定 mount：同步 query_info 耗时 → 卸载 → 探测 stale 对象 → 模拟 DING 的 eject 调用
// （完整脚本见会话记录；关键步骤如下）
// 1. mount.query_info(ATTRS, NONE, null)                 // 同步，主循环内
// 2. mount.unmount_with_operation(...)
// 3. stale: can_eject() / can_unmount() / get_name() / get_default_location()
// 4. stale: eject_with_operation(..., cb)  // cb 内无 catch，复刻 file-item.js:634
```

**原始输出（2026-08-22，本机）：**

```
== mounts (get_mounts) ==
  smb://10.222.127.2/share/   driveOrVolume=false  name="10.222.127.2 上的 share"   can_eject=false  can_unmount=true
== volumes (get_volumes) ==
  volume: Windows  mounted=UNMOUNTED          ← V-4 证据：已连接未挂载的 U 盘

== 在线 SMB 同步 query_info 耗时（V-3 在线基线）==
sync query_info(ALL attrs): 10ms  type=2
sync query_info(std only):   6ms
icon=folder-remote  display=10.222.127.2 上的 share  (9ms)

== 对 smb://10.222.22.212/project/ 卸载后探测 stale GMount（V-1/V-2 证据）==
  live:   can_eject=false can_unmount=true name="10.222.22.212 上的 project"
  unmount: ok
  stale can_eject   = false
  stale can_unmount = true                     ← 菜单仍会显示"卸载"
  stale get_name    = "10.222.22.212 上的 project"
  stale default_location = smb://10.222.22.212/project/
  stale unmount_with_operation: no sync throw
  stale eject callback THROWS (DING has NO catch here): 挂载未实现“eject”或“eject_with_operation”
  volume monitor still lists it: false

== USB 挂载尝试（未验证项说明）==
mount failed: Not authorized to perform operation   ← 沙箱 gjs 无 polkit 授权
```
