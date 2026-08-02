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

    _sortByName(fileList) {
        function byName(a, b) {
            return a._label.get_text().localeCompare(b._label.get_text(), { sensitivity: 'accent', numeric: 'true', localeMatcher: 'lookup' });
        }
        fileList.sort(byName);
    }

    _sortByKindByName(fileList) {
        function byKindByName(a, b) {
            return a.attributeContentType.localeCompare(b.attributeContentType) ||
                a._label.get_text().localeCompare(b._label.get_text(), { sensitivity: 'accent', numeric: 'true', localeMatcher: 'lookup' });
        }
        fileList.sort(byKindByName);
    }

    _sortAllFilesFromGridsByName(order) {
        this._sortByName(this._dm._fileList);
        if (order == Enums.SortOrder.DESCENDINGNAME) {
            this._dm._fileList.reverse();
        }
        this._reassignFilesToDesktop();
    }

    sortAllFilesFromGridsByPosition() {
        if (this._dm.keepArranged) {
            return;
        }
        this._dm._fileList.forEach(f => f.removeFromGrid(false));
        let cornerInversion = Prefs.get_start_corner();
        if (!cornerInversion[0] && !cornerInversion[1]) {
            this._dm._fileList.sort((a, b) => {
                if (a._x1 < b._x1) {
                    return -1;
                }
                if (a._x1 > b._x1) {
                    return 1;
                }
                if (a._y1 < b._y1) {
                    return -1;
                }
                if (a._y1 > b._y1) {
                    return 1;
                }
                return 0;
            });
        }
        if (cornerInversion[0] && cornerInversion[1]) {
            this._dm._fileList.sort((a, b) => {
                if (a._x1 < b._x1) {
                    return 1;
                }
                if (a._x1 > b._x1) {
                    return -1;
                }
                if (a._y1 < b._y1) {
                    return 1;
                }
                if (a._y1 > b._y1) {
                    return -1;
                }
                return 0;
            });
        }
        if (cornerInversion[0] && !cornerInversion[1]) {
            this._dm._fileList.sort((a, b) => {
                if (a._x1 < b._x1) {
                    return 1;
                }
                if (a._x1 > b._x1) {
                    return -1;
                }
                if (a._y1 < b._y1) {
                    return -1;
                }
                if (a._y1 > b._y1) {
                    return 1;
                }
                return 0;
            });
        }
        if (!cornerInversion[0] && cornerInversion[1]) {
            this._dm._fileList.sort((a, b) => {
                if (a._x1 < b._x1) {
                    return -1;
                }
                if (a._x1 > b._x1) {
                    return 1;
                }
                if (a._y1 < b._y1) {
                    return 1;
                }
                if (a._y1 > b._y1) {
                    return -1;
                }
                return 0;
            });
        }
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
            } else {
                otherFiles.push(fileItem);
                continue;
            }
        }
        this._sortByName(specialFiles);
        this._sortByName(directoryFiles);
        this._sortByName(validDesktopFiles);
        this._sortByKindByName(otherFiles);
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
            if (!fileItem._isSpecial) {
                otherFiles.push(fileItem);
                fileItem.savedCoordinates = null;
                fileItem.dropCoordinates = null;
                continue;
            }
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
            this._dm._fileList.forEach((fileItem) => {
                this._dm.stackInitialCoordinates.forEach((savedItem) => {
                    if (savedItem[0] == fileItem.fileName) {
                        fileItem.savedCoordinates = savedItem[1];
                    }
                });
            });
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
        function determineStackTopSizeOrTime() {
            for (let item of otherFiles) {
                if (item.isStackMarker) {
                    for (let unstackitem of stackedFiles) {
                        if (item.attributeContentType == unstackitem.attributeContentType) {
                            item.size = unstackitem.fileSize;
                            item.time = unstackitem.modifiedTime;
                            break;
                        }
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
        let unstackList = Prefs.getUnstackList();
        if (this._dm._allFileList && restack) {
            this._dm._fileList = this._dm._allFileList;
        }
        this._sortByName(this._dm._fileList);
        for (let fileItem of this._dm._fileList) {
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
            } else {
                let type = fileItem.attributeContentType;
                let stacked = false;
                for (let item of otherFiles) {
                    if (type == item.attributeContentType) {
                        stackedFiles.push(fileItem);
                        stacked = true;
                    }
                }
                if (!stacked) {
                    fileItem.isStackTop = true;
                    otherFiles.push(fileItem);
                }
                continue;
            }
        }
        for (let a of otherFiles) {
            let instack = false;
            for (let c of stackedFiles) {
                if (c.attributeContentType == a.attributeContentType) {
                    instack = true;
                    break;
                }
            }
            if (!instack) {
                a.stackUnique = true;
            }
            continue;
        }
        for (let item of otherFiles) {
            if (!item.stackUnique) {
                this._makeStackTopMarkerFolder(item.attributeContentType, stackTopMarkerFolderList);
                item.isStackTop = false;
                stackedFiles.push(item);
            }
            if (item.stackUnique) {
                stackTopMarkerFolderList.push(item);
            }
            item.updateIcon();
        }
        otherFiles = [];
        this._sortByName(specialFiles);
        this._sortByName(directoryFiles);
        this._sortByName(validDesktopFiles);
        this._sortByKindByName(stackedFiles);
        this._sortByKindByName(stackTopMarkerFolderList);
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
        switch (Prefs.getSortOrder()) {
            case Enums.SortOrder.NAME:
                this._sortByName(otherFiles);
                break;
            case Enums.SortOrder.DESCENDINGNAME:
                this._sortByName(otherFiles);
                otherFiles.reverse();
                this._sortByName(stackedFiles);
                stackedFiles.reverse();
                break;
            case Enums.SortOrder.MODIFIEDTIME:
                stackedFiles.sort(byTime);
                determineStackTopSizeOrTime();
                otherFiles.sort(byTime);
                break;
            case Enums.SortOrder.KIND:
                break;
            case Enums.SortOrder.SIZE:
                stackedFiles.sort(bySize);
                determineStackTopSizeOrTime();
                otherFiles.sort(bySize);
                break;
            default:
                break;
        }
        for (let item of otherFiles) {
            newFileList.push(item);
            let itemtype = item.attributeContentType;
            for (let unstackitem of stackedFiles) {
                if (unstackList.includes(unstackitem.attributeContentType) && (unstackitem.attributeContentType == itemtype)) {
                    newFileList.push(unstackitem);
                }
            }
        }
        if (this._dm._allFileList) {
            this._dm._allFileList = this._dm._fileList;
        }
        this._dm._fileList = newFileList;
    }
};
