/* DING: Desktop Icons New Generation for GNOME Shell
 *
 * Copyright (C) 2019 Sergio Costas (rastersoft@gmail.com)
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
'use strict';
const Gdk = imports.gi.Gdk;
const GdkWayland = imports.gi.GdkWayland;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

/* exported DbusOperationsManager, RemoteFileOperationsManager, LegacyRemoteFileOperationsManager */

/* Remote file-operation proxies (Nautilus FileOperations2, FileManager1,
 * previewer, archive manager) plus the template _remoteCall helper. */
class DbusOperationsManager {
    constructor(freeDesktopFileManager, gnomeNautilusPreview, gnomeArchiveManager) {
        this.freeDesktopFileManager = freeDesktopFileManager;
        this.gnomeNautilusPreviewManager = gnomeNautilusPreview;
        this.gnomeArchiveManager = gnomeArchiveManager;
    }

    _sendNoProxyError(callback) {
        if (callback) {
            GLib.idle_add(GLib.PRIORITY_LOW, () => {
                callback(null, 'noProxy');
                return false;
            });
        }
    }

    /**
     * Template for all remote D-Bus calls: proxy availability check, callback
     * forwarding, error logging. `proxyMethod` overrides the method name called
     * on the proxy (some proxies use a different name than the public one).
     */
    _remoteCall(manager, methodName, errorMessage, args, callback, proxyMethod = null) {
        if (!manager.proxy) {
            this._sendNoProxyError(callback);
            return;
        }
        manager.proxy[proxyMethod || methodName](...args, (result, error) => {
            if (callback) {
                callback(result, error);
            }
            if (error) {
                console.log(`${errorMessage}: ${error.message}`);
            }
        });
    }

    ShowItemPropertiesRemote(selection, timestamp, callback) {
        this._remoteCall(this.freeDesktopFileManager, 'ShowItemPropertiesRemote', 'Error showing properties', [selection, this._getStartupId(selection, timestamp)], callback);
    }

    ShowItemsRemote(showInFilesList, timestamp, callback) {
        this._remoteCall(this.freeDesktopFileManager, 'ShowItemsRemote', 'Error showing file on desktop', [showInFilesList, this._getStartupId(showInFilesList, timestamp)], callback);
    }

    ShowFileRemote(uri, integer, boolean, callback) {
        this._remoteCall(this.gnomeNautilusPreviewManager, 'ShowFileRemote', 'Error previewing file', [uri, integer, boolean], callback);
    }

    ExtractRemote(extractFileItem, folder, boolean, callback) {
        this._remoteCall(this.gnomeArchiveManager, 'ExtractRemote', 'Error extracting files', [extractFileItem, folder, true], callback);
    }

    CompressRemote(compressFileItems, folder, boolean, callback) {
        this._remoteCall(this.gnomeArchiveManager, 'CompressRemote', 'Error compressing files', [compressFileItems, folder, boolean], callback);
    }

    _getStartupId(fileUris, timestamp) {
        if (!timestamp) {
            return '';
        }

        const context = Gdk.Display.get_default().get_app_launch_context();
        context.set_timestamp(timestamp);

        if (!this._fileManager) {
            this._fileManager = Gio.File.new_for_path('/').query_default_handler(null);
        }

        return context.get_startup_notify_id(this._fileManager,
            fileUris.map(uri => Gio.File.new_for_uri(uri)));
    }
}


class RemoteFileOperationsManager extends DbusOperationsManager {
    constructor(mainApp, fileOperationsManager, freeDesktopFileManager, gnomeNautilusPreview, gnomeArchiveManager) {
        super(freeDesktopFileManager, gnomeNautilusPreview, gnomeArchiveManager);
        this.fileOperationsManager = fileOperationsManager;
        this._mainApp = mainApp;
        this._createPlatformData();
    }

    _createPlatformData() {
        this.getWaylandParentHandle = this.fileOperationsManager.getWaylandParentHandle = topLevel => {
            return new Promise(resolve => {
                try {
                    topLevel.export_handle((actor, handle) => {
                        if (handle)
                            resolve(handle);
                        else
                            resolve(false);
                    });
                } catch (e) {
                    console.log(`Failed with "${e.message}" while getting wayland parent handle, WaylandHandle`);
                    resolve(false);
                }
            });
        };

        this.platformData = this.fileOperationsManager.platformData = async () => {
            const eventParameters = {
                'parentWindow': this._mainApp.get_active_window(),
                'timestamp': Gdk.CURRENT_TIME,
            };
            const parentWindow = eventParameters.parentWindow;
            const topLevel = parentWindow.get_surface();
            const windowPosition = 'center';
            const timestamp = eventParameters.timestamp;
            let parentHandle = '';

            if (parentWindow) {
                try {
                    if (topLevel.constructor.$gtype === GdkWayland.WaylandToplevel.$gtype) {
                        let handle = await this.getWaylandParentHandle(topLevel);
                        if (handle) {
                            parentHandle = `wayland:${handle}`;
                        }
                    }
                } catch (e) {
                    console.error(e, 'Impossible to determine the parent window');
                }
            }

            return {
                'data': {
                    'parent-handle': new GLib.Variant('s', parentHandle),
                    'timestamp': new GLib.Variant('u', timestamp),
                    'window-position': new GLib.Variant('s', windowPosition),
                },
                freePlatformData: () => {topLevel.unexport_handle();},
            };
        };
    }


    MoveURIsRemote(fileList, uri, callback) {
        this._remoteCall(this.fileOperationsManager, 'MoveURIsRemote', 'Error moving files', [fileList, uri, this.platformData()], callback);
    }

    CopyURIsRemote(fileList, uri, callback) {
        this._remoteCall(this.fileOperationsManager, 'CopyURIsRemote', 'Error copying files', [fileList, uri, this.platformData()], callback);
    }

    async RenameURIRemote(fileList, uri, callback) {
        if (!this.fileOperationsManager.proxy) {
            this._sendNoProxyError(callback);
            return;
        }
        const platformData = await this.platformData().data;
        this.fileOperationsManager.proxy.RenameURIRemote(
            fileList,
            uri,
            platformData,
            (result, error) => {
                if (callback) {
                    callback(result, error);
                }
                if (error) {
                    console.log(`Error copying files: ${error.message}`);
                }
            }
        );
    }

    TrashURIsRemote(fileList, callback) {
        this._remoteCall(this.fileOperationsManager, 'TrashURIsRemote', 'Error moving files', [fileList, this.platformData()], callback);
    }

    DeleteURIsRemote(fileList, callback) {
        this._remoteCall(this.fileOperationsManager, 'DeleteURIsRemote', 'Error deleting files on the desktop', [fileList, this.platformData()], callback);
    }

    EmptyTrashRemote(askConfirmation, callback) {
        this._remoteCall(this.fileOperationsManager, 'EmptyTrashRemote', 'Error trashing files on the desktop', [askConfirmation, this.platformData()], callback);
    }

    UndoRemote(callback) {
        this._remoteCall(this.fileOperationsManager, 'UndoRemote', 'Error performing undo', [this.platformData()], callback);
    }

    RedoRemote(callback) {
        this._remoteCall(this.fileOperationsManager, 'RedoRemote', 'Error performing redo', [this.platformData()], callback);
    }

    UndoStatus() {
        return this.fileOperationsManager.proxy.UndoStatus;
    }
}


class LegacyRemoteFileOperationsManager extends DbusOperationsManager {
    constructor(fileOperationsManager, freeDesktopFileManager, gnomeNautilusPreview, gnomeArchiveManager) {
        super(freeDesktopFileManager, gnomeNautilusPreview, gnomeArchiveManager);
        this.fileOperationsManager = fileOperationsManager;
    }

    MoveURIsRemote(fileList, uri, callback) {
        this._remoteCall(this.fileOperationsManager, 'MoveURIsRemote', 'Error moving files', [fileList, uri], callback);
    }

    CopyURIsRemote(fileList, uri, callback) {
        this._remoteCall(this.fileOperationsManager, 'CopyURIsRemote', 'Error copying files', [fileList, uri], callback);
    }

    RenameURIRemote(fileList, uri, callback) {
        this._remoteCall(this.fileOperationsManager, 'RenameURIRemote', 'Error renaming files', [fileList, uri], callback, 'RenameFileRemote');
    }

    TrashURIsRemote(fileList, callback) {
        this._remoteCall(this.fileOperationsManager, 'TrashURIsRemote', 'Error moving files', [fileList], callback, 'TrashFilesRemote');
    }

    DeleteURIsRemote(fileList, callback) {
        if (this.fileOperationsManager.proxy) {
            this.EmptyTrashRemote();
        }
        this._remoteCall(this.fileOperationsManager, 'DeleteURIsRemote', 'Error deleting files on the desktop', [fileList], callback, 'TrashFilesRemote');
    }

    EmptyTrashRemote(callback) {
        this._remoteCall(this.fileOperationsManager, 'EmptyTrashRemote', 'Error trashing files on the desktop', [], callback);
    }

    UndoRemote(callback) {
        this._remoteCall(this.fileOperationsManager, 'UndoRemote', 'Error performing undo', [], callback);
    }

    RedoRemote(callback) {
        this._remoteCall(this.fileOperationsManager, 'RedoRemote', 'Error performing redo', [], callback);
    }

    UndoStatus() {
        return this.fileOperationsManager.proxy.UndoStatus;
    }
}


/**
 *
 */
