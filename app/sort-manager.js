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

    /* Final tie-break. Two icons with the same name/size/time must not swap
     * cells depending on the order the directory happened to be enumerated in:
     * the result is part of what the user sees, so it has to be deterministic. */
    static _byUri(a, b) {
        const ua = a.uri ?? '';
        const ub = b.uri ?? '';
        return (ua < ub) ? -1 : ((ua > ub) ? 1 : 0);
    }

    static _sortByName(fileList) {
        function byName(a, b) {
            // options must be the 3rd argument — in the 2nd (locales) slot
            // engines silently ignore them (see docs/fixes.md).
            return a._label.get_text().localeCompare(b._label.get_text(), undefined, { sensitivity: 'accent', numeric: true }) ||
                SortManager._byUri(a, b);
        }
        fileList.sort(byName);
    }

    static _sortByKindByName(fileList) {
        function byKindByName(a, b) {
            return a.attributeContentType.localeCompare(b.attributeContentType) ||
                a._label.get_text().localeCompare(b._label.get_text(), undefined, { sensitivity: 'accent', numeric: true }) ||
                SortManager._byUri(a, b);
        }
        fileList.sort(byKindByName);
    }

    _sortAllFilesFromGridsByName(order) {
        SortManager._sortByName(this._dm._fileList);
        if (order == Enums.SortOrder.DESCENDINGNAME) {
            this._dm._fileList.reverse();
        }
        return this._reassignFilesToDesktop();
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
            return (a._y1 - b._y1) * yMul || SortManager._byUri(a, b);
        };
    }

    /* "Arrange Icons" entry point (desktop-menu 'arrange-icons' action).
     * cornerInversion is injectable for tests; production callers omit it. */
    sortAllFilesFromGridsByPosition(cornerInversion = null, { commitPrimaryLayout = false } = {}) {
        if (this._dm.keepArranged) {
            return [];
        }
        this._dm._fileList.forEach(f => f.removeFromGrid(false));
        this._dm._fileList.sort(SortManager._positionComparator(cornerInversion ?? Prefs.get_start_corner()));
        const placed = this._reassignFilesToDesktop();
        /* "Arrange icons" is an explicit user action, so the resulting layout
         * is the one to keep (the caller says so; the automatic paths do not). */
        if (commitPrimaryLayout && this._dm._gridLayout.primaryOnly) {
            this._dm._gridLayout.commitPrimaryPositions(placed);
        }
        return placed;
    }

    _sortAllFilesFromGridsByModifiedTime() {
        function byTime(a, b) {
            return (a._modifiedTime - b._modifiedTime) || SortManager._byUri(a, b);
        }
        this._dm._fileList.sort(byTime);
        return this._reassignFilesToDesktop();
    }

    _sortAllFilesFromGridsBySize() {
        function bySize(a, b) {
            return (a.fileSize - b.fileSize) || SortManager._byUri(a, b);
        }
        this._dm._fileList.sort(bySize);
        return this._reassignFilesToDesktop();
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
        return this._reassignFilesToDesktop();
    }

    /* Re-lays the whole list out. Returns the items that got a cell, so the
     * caller can commit exactly that explicit layout (a full desktop must not
     * record anchors for icons it could not place). */
    _reassignFilesToDesktop() {
        if (!this._dm.sortSpecialFolders) {
            return this._reassignFilesToDesktopPreserveSpecialFiles();
        }
        if (this._dm._gridLayout.primaryOnly) {
            /* The primary layout lives in the anchor: clearing the legacy
             * coordinate here would be a write, and the sort only decides how
             * the icons are distributed over the cells. */
            return this._dm._gridLayout.placePrimaryFiles(this._dm._fileList, { arranged: true });
        }
        for (let fileItem of this._dm._fileList) {
            fileItem.savedCoordinates = null;
            fileItem.dropCoordinates = null;
        }
        return this._dm._addFilesToDesktop(this._dm._fileList, Enums.StoredCoordinates.ASSIGN);
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
            if (!this._dm._gridLayout.primaryOnly) {
                fileItem.savedCoordinates = null;
                fileItem.dropCoordinates = null;
            }
        }
        newFileList.push(...specialFiles);
        newFileList.push(...otherFiles);
        if (this._dm._fileList.length == newFileList.length) {
            this._dm._fileList = newFileList;
        }
        if (this._dm._gridLayout.primaryOnly) {
            /* Special icons are at the head of the list; placePrimaryFiles()
             * keeps their anchor and compacts only the sorted ones. */
            return this._dm._gridLayout.placePrimaryFiles(this._dm._fileList, { arranged: true });
        }
        return this._dm._addFilesToDesktop(this._dm._fileList, Enums.StoredCoordinates.PRESERVE);
    }

    /* commitPrimaryLayout is true only for an explicit user sort (changing
     * 'arrangeorder' by hand, "Arrange icons"): keep-arranged and the refresh
     * paths leave the manual anchors alone. */
    doSorts(cleargrids, { commitPrimaryLayout = false } = {}) {
        if (cleargrids) {
            this._dm._fileList.forEach(f => f.removeFromGrid(false));
        }
        let placed = [];
        switch (Prefs.getSortOrder()) {
            case Enums.SortOrder.NAME:
                placed = this._sortAllFilesFromGridsByName();
                break;
            case Enums.SortOrder.DESCENDINGNAME:
                placed = this._sortAllFilesFromGridsByName(Enums.SortOrder.DESCENDINGNAME);
                break;
            case Enums.SortOrder.MODIFIEDTIME:
                placed = this._sortAllFilesFromGridsByModifiedTime();
                break;
            case Enums.SortOrder.KIND:
                placed = this._sortAllFilesFromGridsByKind();
                break;
            case Enums.SortOrder.SIZE:
                placed = this._sortAllFilesFromGridsBySize();
                break;
            default:
                placed = this._dm._addFilesToDesktop(this._dm._fileList, Enums.StoredCoordinates.PRESERVE);
                break;
        }
        if (commitPrimaryLayout && this._dm._gridLayout.primaryOnly) {
            this._dm._gridLayout.commitPrimaryPositions(placed);
        }
        return placed;
    }

};
