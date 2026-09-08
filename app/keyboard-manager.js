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

import * as Prefs from './preferences.js';
import * as DBusUtils from './dbus-utils.js';

/* Keyboard handling: arrow-key icon navigation (with the keyboard
 * selection ring), the accelerator shortcuts (copy/cut/paste/rename/
 * refresh/...) and the type-to-search entry point. The DesktopManager
 * reference goes through this._dm (same pattern as sort-manager.js). */
export var KeyboardManager = class {
    constructor(desktopManager) {
        this._dm = desktopManager;
        this._lastSelected = null;
        this.ignoreKeys = [Gdk.KEY_space, Gdk.KEY_Shift_L, Gdk.KEY_Shift_R, Gdk.KEY_Control_L, Gdk.KEY_Control_R, Gdk.KEY_Caps_Lock, Gdk.KEY_Shift_Lock, Gdk.KEY_Meta_L, Gdk.KEY_Meta_R, Gdk.KEY_Alt_L, Gdk.KEY_Alt_R, Gdk.KEY_Super_L, Gdk.KEY_Super_R, Gdk.KEY_ISO_Level3_Shift, Gdk.KEY_ISO_Level5_Shift];
    }

    _setIconAsSelected(icon) {
        this._dm._fileList.forEach(fileItem => fileItem.isKeyboardSelected = fileItem === icon);
    }

    _getLastKeyboardIcon() {
        if ((this._lastSelected !== null) && this._dm._fileList.includes(this._lastSelected)) {
            this._setIconAsSelected(this._lastSelected);
            return this._lastSelected;
        }
        return null;
    }

    _getCurrentKeyboardIcon() {
        let currentKeyboardIcon = null;

        for (let fileItem of this._dm._fileList) {
            if ((currentKeyboardIcon === null) && (fileItem.isKeyboardSelected)) {
                currentKeyboardIcon = fileItem;
            } else {
                if (fileItem.isKeyboardSelected) {
                    fileItem.isKeyboardSelected = false;
                }
            }
        }
        return currentKeyboardIcon;
    }

    onKeyRelease(keyval, keycode, state) {
        if (this._dm._popupCounter != 0)
            return false;

        const isCtrl = (state & Gdk.ModifierType.CONTROL_MASK) != 0;
        const isShift = (state & Gdk.ModifierType.SHIFT_MASK) != 0;

        if ((keyval == Gdk.KEY_Left) || (keyval == Gdk.KEY_Right) ||
        (keyval == Gdk.KEY_Up) || (keyval == Gdk.KEY_Down)) {
            let selected = this._getCurrentKeyboardIcon();
            if (!selected) {
                selected = this._getLastKeyboardIcon();
                if (selected) {
                    return false;
                }
            }
            // if there is no last selected, or the last selected isn't in the desktop
            // (for example, because it was deleted), select the top-left icon.
            if (!selected) {
                selected = this._dm._getTopLeftIcon();
                if (selected) {
                    selected.isKeyboardSelected = true;
                }
                this._lastSelected = selected;
                return false;
            }
            let selectedCoordinates = selected.getCoordinates();
            let index;
            let multiplier;
            switch (keyval) {
                case Gdk.KEY_Left:
                    index = 0;
                    multiplier = -1;
                    break;
                case Gdk.KEY_Right:
                    index = 0;
                    multiplier = 1;
                    break;
                case Gdk.KEY_Up:
                    index = 1;
                    multiplier = -1;
                    break;
                case Gdk.KEY_Down:
                    index = 1;
                    multiplier = 1;
                    break;
            }
            let newDistance = null;
            let newItem = null;
            for (let item of this._dm._fileList) {
                let itemCoordinates = item.getCoordinates();
                if ((selectedCoordinates[index] * multiplier) >= (itemCoordinates[index] * multiplier)) {
                    continue;
                }
                let distance = Math.pow(selectedCoordinates[0] - itemCoordinates[0], 2) + Math.pow(selectedCoordinates[1] - itemCoordinates[1], 2);
                if ((newDistance === null) || (newDistance > distance)) {
                    newDistance = distance;
                    newItem = item;
                }
            }
            if (newItem === null) {
                newItem = selected;
            } else {
                selected.isKeyboardSelected = false;
                if (isCtrl || isShift) {
                    selected.setSelected();
                }
            }
            newItem.isKeyboardSelected = true;
            this._lastSelected = newItem;
            return false;
        }
        return false;
    }

    onKeyPress(keyval, keycode, state, grid, timestamp) {
        if (this._dm._popupCounter != 0)
            return false;
        const isCtrl = (state & Gdk.ModifierType.CONTROL_MASK) != 0;
        const isShift = (state & Gdk.ModifierType.SHIFT_MASK) != 0;
        const isAlt = (state & Gdk.ModifierType.MOD1_MASK) != 0;
        let selection = this._dm.getCurrentSelection(false);
        if (keyval == Gdk.KEY_Home) {
            this._setIconAsSelected(this._dm._getTopLeftIcon());
            return true;
        } else if (keyval == Gdk.KEY_End) {
            this._setIconAsSelected(this._dm._getBottomRightIcon());
            return true;
        } else if (isCtrl && (keyval === Gdk.KEY_space)) {
            const selected = this._getCurrentKeyboardIcon();
            if (selected !== null) {
                selected.toggleSelected();
                return true;
            }
        } else if (isCtrl && ((keyval == Gdk.KEY_C) || (keyval == Gdk.KEY_c))) {
            this._dm.doCopy();
            return true;
        } else if (isCtrl && ((keyval == Gdk.KEY_X) || (keyval == Gdk.KEY_x))) {
            this._dm.doCut();
            return true;
        } else if (isCtrl && ((keyval == Gdk.KEY_V) || (keyval == Gdk.KEY_v))) {
            this._dm.doPaste(true).catch(e => {console.log(`Error doing paste from keyboard: ${e.message}\n${e.stack}`)});
            return true;
        } else if (isAlt && (keyval == Gdk.KEY_Return)) {
            let currentSelection = this._dm.getCurrentSelection(true);
            DBusUtils.RemoteFileOperations.ShowItemPropertiesRemote(currentSelection, Gdk.CURRENT_TIME);
            return true;
        } else if (keyval == Gdk.KEY_Return) {
            if (selection && (selection.length == 1)) {
                selection[0].doOpen(timestamp);
                return true;
            }
        } else if (keyval == Gdk.KEY_F2) {
            if (selection && (selection.length == 1)) {
                // Support renaming other grids file items.
                this._dm.doRename(selection[0], false);
                return true;
            }
        } else if (selection && keyval == Gdk.KEY_space) {
            // Support previewing other grids file items.
            DBusUtils.RemoteFileOperations.ShowFileRemote(selection[0].uri, 0, true);
            return true;
        } else if (isCtrl && ((keyval == Gdk.KEY_A) || (keyval == Gdk.KEY_a))) {
            this._dm.selectAll();
            return true;
        } else if (keyval == Gdk.KEY_F5) {
            this._dm._updateDesktopSafe('F5 refresh');
            return true;
        } else if (isCtrl && ((keyval == Gdk.KEY_H) || (keyval == Gdk.KEY_h))) {
            Prefs.gtkSettings.set_boolean('show-hidden', !this._dm._showHidden);
            return true;
        } else if (isCtrl && ((keyval == Gdk.KEY_F) || (keyval == Gdk.KEY_f))) {
            this._dm._searchDialog.findFiles(grid.Window);
            return true;
        } else if (keyval == Gdk.KEY_Escape) {
            this._dm._searchDialog.escape();
            return true;
        } else if ((keyval == Gdk.KEY_Menu) || ((keyval == Gdk.KEY_F10) && isShift)) {
            if (selection) {
                this._dm._fileItemMenu.showMenu(selection[0], null, true);
            } else {
                this._dm._desktopMenu.showDesktopMenu(0, 0, this._dm._desktops[0]._container);
            }
            return true;
        } else if (isCtrl && (keyval == Gdk.KEY_plus)) {
            Prefs.increase_icon_size();
            return true;
        } else if (isCtrl && (keyval == Gdk.KEY_minus)) {
            Prefs.decrease_icon_size();
            return true;
        } else {
            if (this.ignoreKeys.includes(keyval)) {
                return false;
            }
            return this._dm._searchDialog.typeKey(keyval, grid.Window);
        }
        return false;
    }
};
