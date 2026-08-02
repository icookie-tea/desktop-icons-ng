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
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Constants from './constants.js';
import * as DebugLog from './log.js';
import * as Enums from './enums.js';
import * as FileItem from './file-item.js';
import * as FileUtils from './file-utils.js';

/* Desktop directory monitoring: routes GFileMonitor events through the
 * FileChangesQueue, applies incremental create/delete/move/rename updates
 * to the desktop file list, and seeds pending drop coordinates for newly
 * created files. State lives on the DesktopManager (this._dm). */
export var DesktopMonitor = class {
    constructor(desktopManager) {
        this._dm = desktopManager;
    }

    updateDesktopIfChanged(file, otherFile, eventType) {
        if (eventType == Gio.FileMonitorEvent.CHANGED ||
            eventType == Gio.FileMonitorEvent.CHANGES_DONE_HINT) {
            return;
        }
        if (!this._dm._showHidden && (file.get_basename()[0] == '.')) {
            if (!otherFile || (otherFile.get_basename()[0] == '.')) {
                return;
            }
        }
        if (this._dm.keepArranged || this._dm.keepStacked) {
            this.scheduleFullRefresh();
            return;
        }
        switch (eventType) {
            case Gio.FileMonitorEvent.MOVED_IN:
                if (!otherFile ||
                    GLib.path_get_dirname(otherFile.get_path()) !== this._dm._desktopDir.get_path()) {
                    try {
                        let info = new Gio.FileInfo();
                        info.set_attribute_string('metadata::nautilus-icon-position', '');
                        file.set_attributes_from_info(info, Gio.FileQueryInfoFlags.NONE, null);
                    } catch (e) { }
                }
                break;
            case Gio.FileMonitorEvent.MOVED_CREATED:
                try {
                    let info = new Gio.FileInfo();
                    info.set_attribute_string('metadata::nautilus-icon-position', '');
                    file.set_attributes_from_info(info, Gio.FileQueryInfoFlags.NONE, null);
                } catch (e) { }
                break;
            case Gio.FileMonitorEvent.ATTRIBUTE_CHANGED:
                if (file.get_uri() == this._dm._desktopDir.get_uri()) {
                    if (this.updateWritableByOthers()) {
                        this._dm._updateDesktopSafe('directory monitor attribute change');
                    }
                }
                return;
            case Gio.FileMonitorEvent.UNMOUNTED:
                this.scheduleFullRefresh();
                return;
        }
        this._dm._fileChangesQueue.push({ file, otherFile, eventType });
    }
    async processIncrementalEvents(events) {
        if (this._dm._processingIncremental || this._dm._readingDesktopFiles) {
            this._dm._desktopFilesChanged = true;
            return;
        }
        if (events.length > this._dm._fileChangesQueue.maxIncremental) {
            this.scheduleFullRefresh();
            return;
        }
        this._dm._processingIncremental = true;
        try {
            for (const event of events) {
                let success = false;
                switch (event.eventType) {
                    case Gio.FileMonitorEvent.DELETED:
                        success = this.handleFileDeleted(event.file);
                        break;
                    case Gio.FileMonitorEvent.CREATED:
                    case Gio.FileMonitorEvent.MOVED_CREATED:
                        success = await this.handleFileCreated(event.file);
                        break;
                    case Gio.FileMonitorEvent.MOVED_IN:
                        success = await this.handleMovedIn(event.file, event.otherFile);
                        break;
                    case Gio.FileMonitorEvent.MOVED_OUT:
                        success = this.handleMovedOut(event.file, event.otherFile);
                        break;
                    case Gio.FileMonitorEvent.PRE_UNMOUNT:
                        this.scheduleFullRefresh();
                        return;
                    default:
                        this.scheduleFullRefresh();
                        return;
                }
                if (!success) {
                    this.scheduleFullRefresh();
                    return;
                }
            }
        } finally {
            this._dm._processingIncremental = false;
        }
        if (this._dm._desktopFilesChanged) {
            this.scheduleFullRefresh();
        }
    }
    handleFileDeleted(file) {
        const path = file.get_path();
        const index = this._dm._fileList.findIndex(f => f.path === path);
        if (index === -1) {
            return false;
        }
        const fileItem = this._dm._fileList[index];
        if (this._dm._renameWindow && fileItem.fileName === this._dm._renamingFile) {
            this._dm._renameWindow.closeWindow();
        }
        fileItem.removeFromGrid(true);
        this._dm._fileList.splice(index, 1);
        this._dm._fileItemMenu.refreshedIcons();
        return true;
    }
    async handleFileCreated(file) {
        let fileInfo;
        try {
            fileInfo = file.query_info(Enums.DEFAULT_ATTRIBUTES,
                Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            print(`Failed to query info for ${file.get_path()}: ${e.message}`);
            return false;
        }
        const fileItem = new FileItem.FileItem(this._dm, file, fileInfo,
            Enums.FileType.NONE, null);
        if (fileItem.isHidden && !this._dm._showHidden) {
            fileItem._onDestroy();
            return true;
        }
        this.applyDropCoordinates(fileItem);
        this._dm._fileList.push(fileItem);
        this._dm._addSingleFileToDesktop(fileItem);
        this._dm._fileItemMenu.refreshedIcons();
        return true;
    }
    handleMovedOut(file, otherFile) {
        if (!otherFile) {
            return this.handleFileDeleted(file);
        }
        const oldPath = file.get_path();
        const newPath = otherFile.get_path();
        if (GLib.path_get_dirname(newPath) !== this._dm._desktopDir.get_path()) {
            return this.handleFileDeleted(file);
        }
        this._dm._pendingMoves[oldPath] = newPath;
        if (this._dm._moveTimeoutId) {
            GLib.source_remove(this._dm._moveTimeoutId);
        }
        this._dm._moveTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Constants.MOVE_PENDING_TIMEOUT_MS, () => {
            try {
                if (oldPath in this._dm._pendingMoves) {
                    delete this._dm._pendingMoves[oldPath];
                    this.handleFileDeleted(file);
                }
            } catch (e) {
                print(`Error in move timeout cleanup for ${oldPath}: ${e.message}`);
            }
            return GLib.SOURCE_REMOVE;
        });
        return true;
    }
    async handleMovedIn(file, otherFile) {
        if (!otherFile) {
            return await this.handleFileCreated(file);
        }
        const newPath = file.get_path();
        const oldPath = otherFile.get_path();
        if (oldPath in this._dm._pendingMoves && this._dm._pendingMoves[oldPath] === newPath) {
            delete this._dm._pendingMoves[oldPath];
            return await this.handleFileRenamed(file, otherFile);
        }
        return await this.handleFileCreated(file);
    }
    handleFileRenamed(newFile, oldFile) {
        const oldPath = oldFile.get_path();
        const item = this._dm._fileList.find(f => f.path === oldPath);
        if (!item) {
            print(`Rename failed: old file ${oldPath} not found in desktop list`);
            return false;
        }
        const oldUri = oldFile.get_uri();
        const newUri = newFile.get_uri();
        item.onFileRenamed(newFile);
        if (this._dm._renamingFile === oldFile.get_basename())
            this._dm._renamingFile = newFile.get_basename();
        for (let desktop of this._dm._desktops) {
            desktop.updateFileItemUri(oldUri, newUri);
        }
        this._dm._fileItemMenu.refreshedIcons();
        return true;
    }
    applyDropCoordinates(fileItem) {
        const basename = fileItem.file.get_basename();
        const key = FileUtils.matchPendingDropEntry(this._dm._pendingDropFiles, basename);
        if (key !== null) {
            const entry = this._dm._pendingDropFiles[key];
            DebugLog.debugLog(`[dropmatch] ${key === basename ? 'HIT' : 'FUZZY'} ${basename} -> (${entry[0]},${entry[1]})`);
            fileItem.dropCoordinates = entry;
            delete this._dm._pendingDropFiles[key];
        } else {
            DebugLog.debugLog(`[dropmatch] miss ${basename} pending=[${Object.keys(this._dm._pendingDropFiles).join(', ')}]`);
        }
        this.prunePendingDropFiles();
    }
    prunePendingDropFiles() {
        const now = Date.now();
        const keys = Object.keys(this._dm._pendingDropFiles);
        for (let key of keys) {
            const entry = this._dm._pendingDropFiles[key];
            if ((entry[2] && (now - entry[2] > 300000)) || entry[2] === undefined) {
                delete this._dm._pendingDropFiles[key];
            }
        }
        let remaining = Object.keys(this._dm._pendingDropFiles);
        if (remaining.length > 64) {
            remaining.sort((a, b) => this._dm._pendingDropFiles[a][2] - this._dm._pendingDropFiles[b][2]);
            for (let key of remaining.slice(0, remaining.length - 64)) {
                delete this._dm._pendingDropFiles[key];
            }
        }
    }
    scheduleFullRefresh() {
        this._dm._updateDesktopSafe('directory monitor');
    }
    updateWritableByOthers() {
        let info = this._dm._desktopDir.query_info(Gio.FILE_ATTRIBUTE_UNIX_MODE,
            Gio.FileQueryInfoFlags.NONE,
            null);
        this._dm.unixMode = info.get_attribute_uint32(Gio.FILE_ATTRIBUTE_UNIX_MODE);
        let writableByOthers = (this._dm.unixMode & Enums.S_IWOTH) != 0;
        if (writableByOthers != this._dm.writableByOthers) {
            this._dm.writableByOthers = writableByOthers;
            if (this._dm.writableByOthers) {
                print('desktop-icons: Desktop is writable by others - will not allow launching any desktop files');
            }
            return true;
        } else {
            return false;
        }
    }
    metadataChanged(proxy, nameOwner, args) {
        let filepath = GLib.build_filenamev([GLib.get_home_dir(), args[1]]);
        if (this._dm._desktopDir.get_path() === GLib.path_get_dirname(filepath)) {
            for (let fileItem of this._dm.updateFileList()) {
                if (fileItem.path == filepath) {
                    fileItem.updatedMetadata();
                    break;
                }
            }
        }
    }};
