/* DING: Desktop Icons New Generation for GNOME Shell
 *
 * Copyright (C) 2019-2025 Sergio Costas (rastersoft@gmail.com)
 * Based on code original (C) Carlos Soriano
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Enums from './enums.js';
import * as DesktopIconsUtil from './desktop-icons-util.js';
import * as FileItem from './file-item.js';
import * as Constants from './constants.js';
import * as SignalManager from './signal-manager.js';

/*
 * MountManager — VolumeMonitor 接入与 mount 生命周期管理
 * （自 desktop-manager.js 拆分，见 docs/volume-mount-issues.md）。
 *
 * 职责：
 * - 监听 mount-added / mount-changed / mount-removed，驱动全量刷新
 *   （通过 onRefresh 回调，由 DesktopManager._updateDesktopSafe 注入）
 * - 全量刷新时异步查询各 mount 的元信息并构造 FileItem
 *   （异步 query_info，死网络卷不冻结主循环，V-3）
 * - mount 瞬时失败的重试调度（上限 MOUNT_QUERY_MAX_RETRIES，V-6）
 */
export var MountManager = class {
    /**
     * @param {object} parent DesktopManager（FileItem 构造的宿主、_forcedExit 状态）
     * @param {function} onRefresh (reason: string) => void，触发全量刷新
     */
    constructor(parent, onRefresh) {
        this._parent = parent;
        this._onRefresh = onRefresh;
        this._volumeMonitor = Gio.VolumeMonitor.get();
        // Volume/mount refresh state (see docs/volume-mount-issues.md)
        this._mountRetryCounts = new Map();
        this._mountRetryTimeoutId = 0;
        this._mountRemovedTimeoutId = 0;
        this._mountsQueryCancellable = new Gio.Cancellable();
        this._signalManager = new SignalManager.SignalManager();
        this._connectSignals();
    }

    get volumeMonitor() {
        return this._volumeMonitor;
    }

    get queryCancellable() {
        return this._mountsQueryCancellable;
    }

    /*
     * Returns the mount list for this volume monitor (local + network,
     * classified by DesktopIconsUtil.getMounts).
     */
    getMounts() {
        return DesktopIconsUtil.getMounts(this._volumeMonitor);
    }

    _connectSignals() {
        this._signalManager.connectSignal(this._volumeMonitor, 'mount-added', (obj, mount) => {
            this._onRefresh('mount added');
            // Second pass: the gvfs/udisks daemon may still be bringing the
            // mount point up when the first refresh runs, in which case the
            // icon is silently dropped (V-6)
            try {
                this._scheduleMountRefreshRetry(mount.get_default_location().get_uri());
            } catch (e) {
                // the mount is already gone; nothing to retry
            }
        });
        this._signalManager.connectSignal(this._volumeMonitor, 'mount-changed', () => {
            // A mount's properties (label, can-unmount, ...) can change in
            // place; the icon name and the menu must follow (V-7)
            this._onRefresh('mount changed');
        });
        this._signalManager.connectSignal(this._volumeMonitor, 'mount-removed', (obj, mount) => {
            try {
                this._mountRetryCounts.delete(mount.get_default_location().get_uri());
            } catch (e) {
                // stale mount object
            }
            // Delay the refresh: at removal time the mount's files may still
            // be queryable (FUSE teardown race), and a short wait coalesces
            // the removal burst.
            if (this._mountRemovedTimeoutId) {
                GLib.source_remove(this._mountRemovedTimeoutId);
            }
            this._mountRemovedTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                Constants.MOUNT_REMOVED_DELAY_MS,
                () => {
                    this._mountRemovedTimeoutId = 0;
                    this._onRefresh('mount removed');
                    return GLib.SOURCE_REMOVE;
                });
        });
    }

    /*
     * Queries the info of all mounts and appends a FileItem per successful
     * query to fileList. Information is queried asynchronously: a dead
     * network mount must not freeze the main loop with a synchronous
     * query_info (V-3).
     */
    _readMountsAsync(mounts, fileList, cancellable, done) {
        let index = 0;
        const queryNext = () => {
            if (cancellable.is_cancelled() || this._parent._forcedExit) {
                done();
                return;
            }
            if (index >= mounts.length) {
                done();
                return;
            }
            const [file, extras, volume] = mounts[index];
            index += 1;
            file.query_info_async(Enums.DEFAULT_ATTRIBUTES,
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                cancellable,
                (source, result) => {
                    try {
                        const info = source.query_info_finish(result);
                        try {
                            fileList.push(this._createMountFileItem(file, info, extras, volume));
                            this._mountRetryCounts.delete(file.get_uri());
                        } catch (e) {
                            print(`Failed with ${e} while adding volume ${file}`);
                            this._scheduleMountRefreshRetry(file.get_uri());
                        }
                    } catch (e) {
                        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                            print(`Failed to query volume ${file.get_uri()}: ${e.message}`);
                            this._scheduleMountRefreshRetry(file.get_uri());
                        }
                    }
                    queryNext();
                });
        };
        queryNext();
    }

    /*
     * Test seam: the production FileItem factory (also the only place a
     * mount FileItem is constructed).
     */
    _createMountFileItem(file, info, extras, volume) {
        return new FileItem.FileItem(this._parent, file, info, extras, volume);
    }

    /*
     * Schedule a delayed full refresh, but only while the mount still
     * exists (transient failures: gvfs/udisks not ready yet, network
     * blip). Consecutive failures are capped so a permanently dead
     * mount cannot turn into a refresh loop (V-6).
     */
    _scheduleMountRefreshRetry(uri, delayMs = Constants.MOUNT_RETRY_DELAY_MS) {
        let stillMounted = false;
        try {
            for (const m of this._volumeMonitor.get_mounts()) {
                if (m.get_default_location().get_uri() === uri) {
                    stillMounted = true;
                    break;
                }
            }
        } catch (e) {
            return;
        }
        if (!stillMounted) {
            return;
        }
        const count = (this._mountRetryCounts.get(uri) ?? 0) + 1;
        if (count > Constants.MOUNT_QUERY_MAX_RETRIES) {
            return;
        }
        this._mountRetryCounts.set(uri, count);
        if (this._mountRetryTimeoutId) {
            GLib.source_remove(this._mountRetryTimeoutId);
        }
        this._mountRetryTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._mountRetryTimeoutId = 0;
            this._onRefresh('mount query retry');
            return GLib.SOURCE_REMOVE;
        });
    }

    /*
     * Cancels an in-flight mount info query (process exit paths).
     */
    cancelQuery() {
        if (this._mountsQueryCancellable) {
            this._mountsQueryCancellable.cancel();
        }
    }

    destroy() {
        this._signalManager.disconnectAllSignals();
        if (this._mountRemovedTimeoutId) {
            GLib.source_remove(this._mountRemovedTimeoutId);
            this._mountRemovedTimeoutId = 0;
        }
        if (this._mountRetryTimeoutId) {
            GLib.source_remove(this._mountRetryTimeoutId);
            this._mountRetryTimeoutId = 0;
        }
        this.cancelQuery();
    }
};
