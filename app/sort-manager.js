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
import * as Enums from './enums.js';
import * as Prefs from './preferences.js';
import * as stackItem from './stack-item.js';

export var SortManager = class {
    constructor(desktopManager) {
        this._dm = desktopManager;
    }

    static _sortByName(fileList) {
        function byName(a, b) {
            // options must be the 3rd argument — in the 2nd (locales) slot
            // engines silently ignore them (see docs/fixes.md).
            return a._label.get_text().localeCompare(b._label.get_text(), undefined, { sensitivity: 'accent', numeric: true });
        }
        fileList.sort(byName);
    }

    static _sortByKindByName(fileList) {
        function byKindByName(a, b) {
            return a.attributeContentType.localeCompare(b.attributeContentType) ||
                a._label.get_text().localeCompare(b._label.get_text(), undefined, { sensitivity: 'accent', numeric: true });
        }
        fileList.sort(byKindByName);
    }

    _sortAllFilesFromGridsByName(order) {
        SortManager._sortByName(this._dm._fileList);
        if (order == Enums.SortOrder.DESCENDINGNAME) {
            this._dm._fileList.reverse();
        }
        this._reassignFilesToDesktop();
    }

    /* Comparator for "Arrange Icons" (position order). Corner inversion
     * flips the x/y directions: top-left grows from the smallest coords,
     * bottom-right from the largest, etc. Extracted for testability. */
    static _positionComparator(cornerInversion) {
        const xMul = cornerInversion[0] ? -1 : 1;
        const yMul = cornerInversion[1] ? -1 : 1;
        return (a, b) => {
            const dx = (a._x1 - b._x1) * xMul;
            if (dx !== 0) {
                return dx;
            }
            return (a._y1 - b._y1) * yMul;
        };
    }

    /* "Arrange Icons" entry point (desktop-menu 'arrange-icons' action).
     * cornerInversion is injectable for tests; production callers omit it. */
    sortAllFilesFromGridsByPosition(cornerInversion = null) {
        if (this._dm.keepArranged) {
            return;
        }
        this._dm._fileList.forEach(f => f.removeFromGrid(false));
        this._dm._fileList.sort(SortManager._positionComparator(cornerInversion ?? Prefs.get_start_corner()));
        this._reassignFilesToDesktop();
    }

    _sortAllFilesFromGridsByModifiedTime() {
        function byTime(a, b) {
            return a._modifiedTime - b._modifiedTime;
        }
        this._dm._fileList.sort(byTime);
        this._reassignFilesToDesktop();
    }

    _sortAllFilesFromGridsBySize() {
        function bySize(a, b) {
            return a.fileSize - b.fileSize;
        }
        this._dm._fileList.sort(bySize);
        this._reassignFilesToDesktop();
    }

    _sortAllFilesFromGridsByKind() {
        let specialFiles = [];
        let directoryFiles = [];
        let validDesktopFiles = [];
        let otherFiles = [];
        let newFileList = [];
        for (let fileItem of this._dm._fileList) {
            if (fileItem._isSpecial) {
                specialFiles.push(fileItem);
                continue;
            }
            if (fileItem._isDirectory) {
                directoryFiles.push(fileItem);
                continue;
            }
            if (fileItem._isValidDesktopFile) {
                validDesktopFiles.push(fileItem);
                continue;
            }
            otherFiles.push(fileItem);
            continue;
        }
        SortManager._sortByName(specialFiles);
        SortManager._sortByName(directoryFiles);
        SortManager._sortByName(validDesktopFiles);
        SortManager._sortByKindByName(otherFiles);
        newFileList.push(...specialFiles);
        newFileList.push(...validDesktopFiles);
        newFileList.push(...directoryFiles);
        newFileList.push(...otherFiles);
        if (this._dm._fileList.length == newFileList.length) {
            this._dm._fileList = newFileList;
        }
        this._reassignFilesToDesktop();
    }

    _reassignFilesToDesktop() {
        if (!this._dm.sortSpecialFolders) {
            this._reassignFilesToDesktopPreserveSpecialFiles();
            return;
        }
        for (let fileItem of this._dm._fileList) {
            fileItem.savedCoordinates = null;
            fileItem.dropCoordinates = null;
        }
        this._dm._addFilesToDesktop(this._dm._fileList, Enums.StoredCoordinates.ASSIGN);
    }

    _reassignFilesToDesktopPreserveSpecialFiles() {
        let specialFiles = [];
        let otherFiles = [];
        let newFileList = [];
        for (let fileItem of this._dm._fileList) {
            if (fileItem._isSpecial) {
                specialFiles.push(fileItem);
                continue;
            }
            otherFiles.push(fileItem);
            fileItem.savedCoordinates = null;
            fileItem.dropCoordinates = null;
        }
        newFileList.push(...specialFiles);
        newFileList.push(...otherFiles);
        if (this._dm._fileList.length == newFileList.length) {
            this._dm._fileList = newFileList;
        }
        this._dm._addFilesToDesktop(this._dm._fileList, Enums.StoredCoordinates.PRESERVE);
    }

    doSorts(cleargrids) {
        if (cleargrids) {
            this._dm._fileList.forEach(f => f.removeFromGrid(false));
        }
        switch (Prefs.getSortOrder()) {
            case Enums.SortOrder.NAME:
                this._sortAllFilesFromGridsByName();
                break;
            case Enums.SortOrder.DESCENDINGNAME:
                this._sortAllFilesFromGridsByName(Enums.SortOrder.DESCENDINGNAME);
                break;
            case Enums.SortOrder.MODIFIEDTIME:
                this._sortAllFilesFromGridsByModifiedTime();
                break;
            case Enums.SortOrder.KIND:
                this._sortAllFilesFromGridsByKind();
                break;
            case Enums.SortOrder.SIZE:
                this._sortAllFilesFromGridsBySize();
                break;
            default:
                this._dm._addFilesToDesktop(this._dm._fileList, Enums.StoredCoordinates.PRESERVE);
                break;
        }
    }

    onToggleStackUnstackThisTypeClicked(type) {
        let unstackList = Prefs.getUnstackList();
        let typeInList = unstackList.includes(type);
        if (typeInList) {
            let index = unstackList.indexOf(type);
            unstackList.splice(index, 1);
        } else {
            unstackList.push(type);
        }
        Prefs.setUnstackList(unstackList);
    }

    doStacks(restack) {
        const selected = this._dm._getCurrentKeyboardIcon()?.uri;
        if (restack) {
            for (let fileItem of this._dm._fileList) {
                fileItem.removeFromGrid(false);
            }
        }
        if (!this._dm.stackInitialCoordinates && !this._dm._allFileList) {
            this._dm._allFileList = [];
            this._saveStackInitialCoordinates();
            restack = false;
        }
        this._sortAllFilesFromGridsByKindStacked(restack);
        this._reassignFilesToDesktop();
        if (selected) {
            this._dm._fileList.forEach(icon => icon.isKeyboardSelected = (icon.uri === selected));
        }
    }

    _unstack() {
        if (this._dm.stackInitialCoordinates && this._dm._allFileList) {
            this._dm._fileList.forEach(f => f.removeFromGrid(false));
            this._restoreStackInitialCoordinates();
            this._dm._fileList = this._dm._allFileList;
            this._dm._allFileList = null;
            if (this._dm.keepArranged) {
                this.doSorts();
            } else {
                this._dm._addFilesToDesktop(this._dm._fileList, Enums.StoredCoordinates.PRESERVE);
            }
        }
    }

    _saveStackInitialCoordinates() {
        this._dm.stackInitialCoordinates = [];
        for (let fileItem of this._dm._fileList) {
            this._dm.stackInitialCoordinates.push([fileItem.fileName, fileItem.savedCoordinates]);
        }
    }

    _restoreStackInitialCoordinates() {
        if (this._dm.stackInitialCoordinates) {
            // Map keyed by fileName: later entries override earlier ones, which
            // matches the old nested-loop semantics (last match wins). Also
            // avoids the old O(n²) scan and the repeated synchronous
            // set_attributes_from_info() calls on each match.
            const coordsMap = new Map(this._dm.stackInitialCoordinates);
            for (let fileItem of this._dm._fileList) {
                const coords = coordsMap.get(fileItem.fileName);
                if (coords !== undefined) {
                    fileItem.savedCoordinates = coords;
                }
            }
        }
        this._dm.stackInitialCoordinates = null;
    }

    _makeStackTopMarkerFolder(type, list) {
        let stackAttribute = type.split('/')[1];
        let fileItem = new stackItem.stackItem(
            this._dm,
            stackAttribute,
            type,
            Enums.FileType.STACK_TOP
        );
        list.push(fileItem);
    }

    _sortAllFilesFromGridsByKindStacked(restack) {
        // Pure core extracted as SortManager.sortFileListByKindStacked() for
        // unit testing (Prefs/stack-item injection).
        this._dm._fileList = SortManager.sortFileListByKindStacked(
            this._dm._fileList,
            Prefs.getUnstackList(),
            Prefs.getSortOrder(),
            (type) => this._makeStackTopMarkerFolder(type));
        if (this._dm._allFileList) {
            this._dm._allFileList = this._dm._fileList;
        }
    }

    /*
     * Pure core of the stacked ("keep stacked") layout: partitions
     * fileList into special / desktop-files / directories / stacked files,
     * sorts each group per sortOrder, creates stack-top markers for
     * non-unique content types and re-inserts unstacked types right after
     * their stack-top entry. Returns the new file list; does not touch
     * desktopManager state.
     *
     * @param fileList items (mutated: isStackTop/stackUnique/updateIcon())
     * @param unstackList content types the user unstacked
     * @param sortOrder Enums.SortOrder value
     * @param makeStackMarker (type) => item; the returned item must expose
     *        isStackMarker + attributeContentType + fileSize/modifiedTime
     */
    static sortFileListByKindStacked(fileList, unstackList, sortOrder, makeStackMarker) {
        function firstStackedByType() {
            // First stacked file of each content type (old loop semantics:
            // 'break' on the first match). Must be built after the
            // stackedFiles sort that happens inside the switch below.
            const map = new Map();
            for (let unstackitem of stackedFiles) {
                if (!map.has(unstackitem.attributeContentType)) {
                    map.set(unstackitem.attributeContentType, unstackitem);
                }
            }
            return map;
        }

        function determineStackTopSizeOrTime(stackedByType) {
            for (let item of otherFiles) {
                if (item.isStackMarker) {
                    const unstackitem = stackedByType.get(item.attributeContentType);
                    if (unstackitem !== undefined) {
                        item.size = unstackitem.fileSize;
                        item.time = unstackitem.modifiedTime;
                    }
                }
            }
        }

        let specialFiles = [];
        let directoryFiles = [];
        let validDesktopFiles = [];
        let otherFiles = [];
        let stackedFiles = [];
        let newFileList = [];
        let stackTopMarkerFolderList = [];
        const unstackSet = new Set(unstackList);
        SortManager._sortByName(fileList);
        const seenTypes = new Set();
        for (let fileItem of fileList) {
            if (fileItem.isSpecial) {
                specialFiles.push(fileItem);
                continue;
            }
            if (fileItem.isDirectory) {
                directoryFiles.push(fileItem);
                continue;
            }
            if (fileItem._isValidDesktopFile) {
                validDesktopFiles.push(fileItem);
                continue;
            }
            const type = fileItem.attributeContentType;
            if (seenTypes.has(type)) {
                stackedFiles.push(fileItem);
            } else {
                seenTypes.add(type);
                fileItem.isStackTop = true;
                otherFiles.push(fileItem);
            }
        }
        const stackedTypes = new Set(stackedFiles.map(f => f.attributeContentType));
        for (let a of otherFiles) {
            if (!stackedTypes.has(a.attributeContentType)) {
                a.stackUnique = true;
            }
        }
        for (let item of otherFiles) {
            if (!item.stackUnique) {
                stackTopMarkerFolderList.push(makeStackMarker(item.attributeContentType));
                item.isStackTop = false;
                stackedFiles.push(item);
            }
            if (item.stackUnique) {
                stackTopMarkerFolderList.push(item);
            }
            item.updateIcon();
        }
        otherFiles = [];
        SortManager._sortByName(specialFiles);
        SortManager._sortByName(directoryFiles);
        SortManager._sortByName(validDesktopFiles);
        SortManager._sortByKindByName(stackedFiles);
        SortManager._sortByKindByName(stackTopMarkerFolderList);
        otherFiles.push(...specialFiles);
        otherFiles.push(...validDesktopFiles);
        otherFiles.push(...directoryFiles);
        otherFiles.push(...stackTopMarkerFolderList);

        function bySize(a, b) {
            return a.fileSize - b.fileSize;
        }
        function byTime(a, b) {
            return a._modifiedTime - b._modifiedTime;
        }
        switch (sortOrder) {
            case Enums.SortOrder.NAME:
                SortManager._sortByName(otherFiles);
                break;
            case Enums.SortOrder.DESCENDINGNAME:
                SortManager._sortByName(otherFiles);
                otherFiles.reverse();
                SortManager._sortByName(stackedFiles);
                stackedFiles.reverse();
                break;
            case Enums.SortOrder.MODIFIEDTIME:
                stackedFiles.sort(byTime);
                determineStackTopSizeOrTime(firstStackedByType());
                otherFiles.sort(byTime);
                break;
            case Enums.SortOrder.KIND:
                break;
            case Enums.SortOrder.SIZE:
                stackedFiles.sort(bySize);
                determineStackTopSizeOrTime(firstStackedByType());
                otherFiles.sort(bySize);
                break;
            default:
                break;
        }
        // Group unstacked content types by type, preserving stackedFiles order,
        // to avoid the old nested scan (and repeated unstackList.includes calls).
        const unstackedByType = new Map();
        for (let unstackitem of stackedFiles) {
            if (!unstackSet.has(unstackitem.attributeContentType)) {
                continue;
            }
            let list = unstackedByType.get(unstackitem.attributeContentType);
            if (list === undefined) {
                list = [];
                unstackedByType.set(unstackitem.attributeContentType, list);
            }
            list.push(unstackitem);
        }
        for (let item of otherFiles) {
            newFileList.push(item);
            const unstacked = unstackedByType.get(item.attributeContentType);
            if (unstacked !== undefined) {
                newFileList.push(...unstacked);
            }
        }
        return newFileList;
    }
};
