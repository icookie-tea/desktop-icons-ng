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
import Gio from 'gi://Gio';

import * as dndClipboardUtils from './dnd-clipboard-utils.js';
import * as DBusUtils from './dbus-utils.js';
import * as DesktopIconsUtil from './desktop-icons-util.js';
import * as AskRenamePopup from './ask-rename-popup.js';
import * as Enums from './enums.js';
import * as DebugLog from './log.js';

import Gettext from 'gettext';

const _ = Gettext.domain('ding').gettext;

export var FileOperations = class {
    constructor(desktopManager) {
        this._dm = desktopManager;
        this._clipboardFiles = null;
        this._isCut = false;
    }

    clearFileCoordinates(fileList, dropCoordinates) {
        for (let element of fileList) {
            let file = Gio.File.new_for_uri(element);
            if (!file.is_native() || !file.query_exists(null)) {
                if (dropCoordinates != null) {
                    this._dm._pendingDropFiles[file.get_basename()] = [...dropCoordinates, Date.now()];
                    DebugLog.debugLog(`[dropcoords] non-native ${file.get_basename()} -> (${dropCoordinates[0]},${dropCoordinates[1]}) pending=${Object.keys(this._dm._pendingDropFiles).length}`);
                }
                continue;
            }
            let info = new Gio.FileInfo();
            info.set_attribute_string('metadata::nautilus-icon-position', '');
            if (dropCoordinates != null) {
                info.set_attribute_string('metadata::nautilus-drop-position', `${dropCoordinates[0]},${dropCoordinates[1]}`);
            }
            try {
                file.set_attributes_from_info(info, Gio.FileQueryInfoFlags.NONE, null);
            } catch (e) {
                // gvfs metadata daemon may be unavailable (e.g. non-native
                // files); coordinates are still tracked via _pendingDropFiles
            }
            if (dropCoordinates != null) {
                /* The drop-position attribute is stored in the gvfs metadata
                 * daemon per path and is NOT inherited by the copied file, so
                 * also record it here keyed by basename. FileItem creation
                 * (_applyDropCoordinates) will match it and place the new
                 * icon on the requested grid cell. */
                this._dm._pendingDropFiles[file.get_basename()] = [...dropCoordinates, Date.now()];
                DebugLog.debugLog(`[dropcoords] ${file.get_basename()} -> (${dropCoordinates[0]},${dropCoordinates[1]}) pending=${Object.keys(this._dm._pendingDropFiles).length}`);
            }
        }
    }

    doCopy() {
        dndClipboardUtils.manageCutCopy({ copy: true, fileList: this._dm.getCurrentSelection(false) });
    }

    doCut() {
        dndClipboardUtils.manageCutCopy({ copy: false, fileList: this._dm.getCurrentSelection(false) });
    }

    doTrash() {
        const selection = this._dm._fileList.filter(i => (i.isSelected || i.isKeyboardSelected) && !i.isSpecial).map(i =>
            i.file.get_uri());

        if (selection.length) {
            DBusUtils.RemoteFileOperations.TrashURIsRemote(selection);
        }
    }

    doDeletePermanently() {
        const toDelete = this._dm._fileList.filter(i => (i.isSelected || i.isKeyboardSelected) && !i.isSpecial).map(i =>
            i.file.get_uri());

        if (!toDelete.length) {
            if (this._dm._fileList.some(i => (i.isSelected || i.isKeyboardSelected) && i.isTrash)) {
                this.doEmptyTrash();
            }
            return;
        }

        DBusUtils.RemoteFileOperations.DeleteURIsRemote(toDelete);
    }

    doEmptyTrash(askConfirmation = true) {
        DBusUtils.RemoteFileOperations.EmptyTrashRemote(askConfirmation);
    }

    async updateClipboard() {
        this._clipboardFiles = null;
        const clipboardData = await dndClipboardUtils.readClipboard([Enums.DndTargetInfo.GNOME_CLIPBOARD, Enums.DndTargetInfo.URI_LIST]);
        if (clipboardData === null) {
            return false;
        }
        const data = dndClipboardUtils.processFileList(clipboardData.mimetype, clipboardData.data);
        if (!['cut', 'copy'].includes(data.action)) {
            return false;
        }
        this._isCut = (data.action === 'cut');
        this._clipboardFiles = data.files;
        return true;
    }

    async doPaste(refresh) {
        if (refresh) {
            await this.updateClipboard();
        }
        if (this._clipboardFiles === null) {
            return;
        }
        DebugLog.debugLog(`[paste] files=${this._clipboardFiles.length} cut=${this._isCut} click=(${this._dm._clickX},${this._dm._clickY})`);
        let desktopDir = this._dm._desktopDir.get_uri();
        if (this._isCut) {
            // Moving keeps the files' own metadata::nautilus-icon-position,
            // so cut+paste restores them at their original spot.
            DBusUtils.RemoteFileOperations.MoveURIsRemote(this._clipboardFiles, desktopDir);
        } else {
            // Copies get no metadata of their own — pre-seed the drop
            // position like the drag&drop path does, so pasted copies land
            // on the grid cell under the mouse. Stale source URIs (source
            // deleted after copying) are intentionally NOT filtered here:
            // Nautilus reports them natively, which is better feedback than
            // a silent no-op.
            this.clearFileCoordinates(this._clipboardFiles, [this._dm._clickX, this._dm._clickY]);
            DBusUtils.RemoteFileOperations.CopyURIsRemote(this._clipboardFiles, desktopDir);
        }
    }

    doRename(fileItem, allowReturnOnSameName) {
        if (!fileItem || !fileItem.canRename) {
            return;
        }
        this._dm.unselectAll();
        if (!this._dm._renameWindow) {
            this._dm._renamingFile = fileItem.fileName;
            this._dm._renameWindow = new AskRenamePopup.AskRenamePopup(this._dm, fileItem, allowReturnOnSameName, () => {
                this._dm._renameWindow = null;
                this._dm.newFolderDoRename = null;
                this._dm._renamingFile = null;
            });
        }
    }

    fileExistsOnDesktop(searchName) {
        return this._dm.updateFileList().some(f => f.fileName === searchName);
    }

    getDesktopUniqueFileName(fileName) {
        let fileParts = DesktopIconsUtil.getFileExtensionOffset(fileName);
        let i = 0;
        let newName = fileName;

        while (this.fileExistsOnDesktop(newName)) {
            i += 1;
            newName = `${fileParts.basename} ${i}${fileParts.extension}`;
        }
        return newName;
    }

};
