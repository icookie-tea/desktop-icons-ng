/* DING: Desktop Icons New Generation for GNOME Shell
 *
 * Copyright (C) 2019-2025 Sergio Costas (rastersoft@gmail.com)
 * Based on code original (C) Carlos Soriano
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 or later.
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

import * as Enums from './enums.js';
import * as DBusUtils from './dbus-utils.js';
import * as DesktopIconsUtil from './desktop-icons-util.js';

/* Drag & drop state and handlers: internal icon dragging (with the
 * relative-position list used for the multi-select preview) and foreign
 * drop targets (file lists and plain text). The DesktopManager reference
 * goes through this._dm (same pattern as sort-manager.js). */
export var DndManager = class {
    constructor(desktopManager) {
        this._dm = desktopManager;
        this.dragItem = null;
        this._dragList = null;
        this._dragOriginX = 0;
        this._dragOriginY = 0;
    }

    doMoveWithDragAndDrop(xOrigin, yOrigin, xDestination, yDestination) {
        const keepArranged = this._dm.keepArranged || this._dm.keepStacked;
        if (this._dm.sortSpecialFolders && keepArranged) {
            return;
        }
        // Find the grid where the destination lies and aim towards the positive side, middle of grid to ensure drop in the grid
        for (let desktop of this._dm._desktops) {
            const grid = desktop.getGridAt(xDestination, yDestination, true);
            if (grid !== null) {
                xDestination = grid[0] + desktop._elementWidth / 2;
                yDestination = grid[1] + desktop._elementHeight / 2;
                break;
            }
        }
        let deltaX = xDestination - xOrigin;
        let deltaY = yDestination - yOrigin;
        let fileItems = [];
        for (let item of this._dm._fileList) {
            if (item.isSelected) {
                if (keepArranged) {
                    if (item.isSpecial) {
                        fileItems.push(item);
                        item.removeFromGrid(false);
                        let [x, y] = item.getCoordinates();
                        item.savedCoordinates = [x + deltaX, y + deltaY];
                    } else {
                        continue;
                    }
                } else {
                    fileItems.push(item);
                    item.removeFromGrid(false);
                    let [x, y] = item.getCoordinates();
                    item.savedCoordinates = [x + deltaX, y + deltaY];
                }
            }
        }
        // force to store the new coordinates
        this._dm._addFilesToDesktop(fileItems, Enums.StoredCoordinates.OVERWRITE);
        fileItems = undefined;
        if (this._dm.keepArranged) {
            this._dm._updateDesktopSafe('move with drag and drop (keep arranged)');
        }
    }

    onDragBegin(item) {
        this.dragItem = item;
        let [xOrigin, yOrigin] = item.getCoordinates();
        this._dragOriginX = xOrigin;
        this._dragOriginY = yOrigin;
    }

    onDragMotion(x, y) {
        if (this.dragItem === null) {
            for (let desktop of this._dm._desktops) {
                desktop.refreshDrag([[0, 0]], x, y);
            }
            return;
        }
        if (this._dragList === null) {
            let itemList = this._dm.getCurrentSelection(false);
            if (!itemList) {
                return;
            }
            let [x1, y1] = this.dragItem.getCoordinates();
            let oX = x1;
            let oY = y1;
            this._dragList = [];
            for (let item of itemList) {
                [x1, y1] = item.getCoordinates();
                this._dragList.push([x1 - oX, y1 - oY]);
            }
        }
        for (let desktop of this._dm._desktops) {
            desktop.refreshDrag(this._dragList, x, y);
        }
    }

    getDragList() {
        return this._dragList;
    }

    onDragLeave() {
        this._dragList = null;
        for (let desktop of this._dm._desktops) {
            desktop.refreshDrag(null, 0, 0);
        }
    }

    onDragEnd() {
        this.dragItem = null;
    }

    onDragDataReceived(dropInfo, xDestination, yDestination, forceMove) {
        this.onDragLeave();
        if (dropInfo.filelist.length == 0) {
            return;
        }
        switch (dropInfo.mimetype) {
            case Enums.DndTargetInfo.DING_ICON_LIST:
                this.doMoveWithDragAndDrop(this._dragOriginX, this._dragOriginY, xDestination, yDestination);
                break;
            case Enums.DndTargetInfo.GNOME_ICON_LIST:
            case Enums.DndTargetInfo.URI_LIST:
                this._dm.clearFileCoordinates(dropInfo.filelist, [xDestination, yDestination]);
                let data = Gio.File.new_for_uri(dropInfo.filelist[0]).query_info('id::filesystem', Gio.FileQueryInfoFlags.NONE, null);
                let idFS = data.get_attribute_string('id::filesystem');
                if ((this._dm.desktopFsId == idFS) || forceMove) {
                    DBusUtils.RemoteFileOperations.MoveURIsRemote(dropInfo.filelist, DesktopIconsUtil.getDesktopDir().get_uri());
                } else {
                    DBusUtils.RemoteFileOperations.CopyURIsRemote(dropInfo.filelist, DesktopIconsUtil.getDesktopDir().get_uri());
                }
                break;
            case Enums.DndTargetInfo.TEXT_PLAIN:
                this._writeDroppedText(dropInfo.filelist[0], [xDestination, yDestination]);
                break;
        }
    }

    _writeDroppedText(text, dropCoordinates) {
        let filename = DesktopIconsUtil.generateDropFilename(text);
        filename = this._dm.getDesktopUniqueFileName(filename);
        DesktopIconsUtil.writeDroppedTextFile(text, filename, dropCoordinates);
    }
};
