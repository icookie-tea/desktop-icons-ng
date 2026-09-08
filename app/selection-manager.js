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
import Gdk from 'gi://Gdk';

import * as Enums from './enums.js';

/* Icon selection state and logic: rubber band, single/shift/enter
 * selection actions and the selection query helpers used by the menus,
 * the keyboard manager and the refresh pipeline. State lives on this
 * manager; the DesktopManager reference goes through this._dm
 * (same pattern as sort-manager.js / grid-layout.js). */
export var SelectionManager = class {
    constructor(desktopManager) {
        this._dm = desktopManager;
        this.rubberBand = false;
        this.rubberBandInitX = 0;
        this.rubberBandInitY = 0;
        this.x1 = 0;
        this.x2 = 0;
        this.y1 = 0;
        this.y2 = 0;
        this.selectionRectangle = null;
        this._clickCaptured = false;
    }

    clickCaptured() {
        this._clickCaptured = true;
    }

    _getTopLeftIcon() {
        if (this._dm._fileList.length == 0) {
            return null;
        }
        let currentCoords = null;
        let currentItem = null;
        for (let item of this._dm._fileList) {
            const newCoords = item.getCoordinates();
            if ((currentCoords === null) || (newCoords[0] < currentCoords[0]) || (newCoords[1] < currentCoords[1])) {
                currentCoords = newCoords;
                currentItem = item;
            }
        }
        return currentItem;
    }

    _getBottomRightIcon() {
        if (this._dm._fileList.length == 0) {
            return null;
        }
        let currentCoords = null;
        let currentItem = null;
        for (let item of this._dm._fileList) {
            const newCoords = item.getCoordinates();
            if ((currentCoords === null) || (newCoords[0] > currentCoords[0]) || (newCoords[1] > currentCoords[1])) {
                currentCoords = newCoords;
                currentItem = item;
            }
        }
        return currentItem;
    }

    onMotion(x, y) {
        if (this.rubberBand) {
            this.x1 = Math.floor(Math.min(x, this.rubberBandInitX));
            this.x2 = Math.floor(Math.max(x, this.rubberBandInitX));
            this.y1 = Math.floor(Math.min(y, this.rubberBandInitY));
            this.y2 = Math.floor(Math.max(y, this.rubberBandInitY));
            this.selectionRectangle = new Gdk.Rectangle({ 'x': this.x1, 'y': this.y1, 'width': this.x2 - this.x1, 'height': this.y2 - this.y1 });
            for (let grid of this._dm._desktops) {
                grid.queue_draw();
            }
            for (let item of this._dm._fileList) {
                if (item.checkIntersects(this.selectionRectangle)) {
                    item.setSelected();
                    item.touchedByRubberband = true;
                } else if (item.touchedByRubberband) {
                    item.unsetSelected();
                }
            }
        }
        return false;
    }

    onReleaseMainButton() {
        this._clickCaptured = false;
        if (this.rubberBand) {
            this.rubberBand = false;
            this.selectionRectangle = null;
        }
        for (let grid of this._dm._desktops) {
            grid.queue_draw();
        }
        return false;
    }

    _startRubberband(x, y) {
        this.rubberBandInitX = x;
        this.rubberBandInitY = y;
        this.rubberBand = true;
        for (let item of this._dm._fileList) {
            item.touchedByRubberband = false;
        }
    }

    selected(fileItem, action) {
        switch (action) {
            case Enums.Selection.ALONE:
                if (!fileItem.isSelected) {
                    for (let item of this._dm._fileList) {
                        if (item === fileItem) {
                            item.setSelected();
                        } else {
                            item.unsetSelected();
                        }
                    }
                }
                break;
            case Enums.Selection.WITH_SHIFT:
                fileItem.toggleSelected();
                break;
            case Enums.Selection.RIGHT_BUTTON:
                if (!fileItem.isSelected) {
                    for (let item of this._dm._fileList) {
                        if (item === fileItem) {
                            item.setSelected();
                        } else {
                            item.unsetSelected();
                        }
                    }
                }
                break;
            case Enums.Selection.ENTER:
                if (this.rubberBand) {
                    fileItem.setSelected();
                }
                break;
            case Enums.Selection.RELEASE:
                for (let item of this._dm._fileList) {
                    if (item === fileItem) {
                        item.setSelected();
                    } else {
                        item.unsetSelected();
                    }
                }
                break;
        }
    }

    selectAll() {
        for (let fileItem of this._dm._fileList) {
            if (fileItem.isAllSelectable) {
                fileItem.setSelected();
            }
        }
    }

    unselectAll() {
        this._dm._fileList.forEach(f => {
            f.unsetSelected();
            f.isKeyboardSelected = false;
        });
    }

    getCurrentSelection(getUri = false) {
        let selection = [];
        for (let fileItem of this._dm._fileList) {
            if ((fileItem.isSelected) || (fileItem.isKeyboardSelected)) {
                if (getUri) {
                    selection.push(fileItem.file.get_uri());
                } else {
                    selection.push(fileItem);
                }
            }
        }
        if (selection.length !== 0) {
            return selection;
        } else {
            return null;
        }
    }

    getNumberOfSelectedItems() {
        let count = 0;
        for (let item of this._dm._fileList) {
            if ((item.isSelected) || (item.isKeyboardSelected)) {
                count++;
            }
        }
        return count;
    }

    getFileItemFromURI(uri) {
        for (let item of this._dm._fileList) {
            if (uri == item.uri) {
                return item;
            }
        }
        return null;
    }

    checkIfSpecialFilesAreSelected() {
        for (let item of this._dm._fileList) {
            if (item.isSelected && item.isSpecial) {
                return true;
            }
        }
        return false;
    }

    checkIfDirectoryIsSelected() {
        for (let item of this._dm._fileList) {
            if ((item.isSelected || item.isKeyboardSelected) && item.isDirectory) {
                return true;
            }
        }
        return false;
    }
};
