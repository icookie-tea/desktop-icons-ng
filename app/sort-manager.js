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

};
