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
import * as DBusUtils from './dbus-utils.js';
import * as DesktopGrid from './desktop-grid.js';
import * as Enums from './enums.js';
import * as DebugLog from './log.js';

/* Monitor geometry management: subscribes to the extension's D-Bus
 * desktopGeometry action, diffs monitor areas, recreates the per-monitor
 * DesktopGrid windows and keeps _primaryScreen up to date. State lives on
 * the DesktopManager (this._dm). */
export var GridLayout = class {
    constructor(desktopManager) {
        this._dm = desktopManager;
        this._signalIds = [];
    }

    _trackSignal(obj, signal, cb) {
        this._signalIds.push([obj, obj.connect(signal, cb)]);
    }

    destroy() {
        for (let [obj, id] of this._signalIds) {
            obj.disconnect(id);
        }
        this._signalIds = [];
    }

    updateGridWindows(newdesktoplist) {
        /* Reject invalid monitor descriptions (zero/negative width, height or
         * scale). They are transient artifacts of the compositor's
         * monitors-changed / workarea recalculation and must not be applied:
         * a zero-sized grid makes every getDistance() return -1 ("full"), so
         * _addFilesToDesktop drops every icon and the desktop appears empty
         * with no way to recover short of restarting the process. Keep the
         * last valid layout instead. */
        for (const area of newdesktoplist) {
            if (!(area.width > 0) || !(area.height > 0) || !(area.scaleFactor > 0)) {
                DebugLog.debugLog(`[grid] updateGridWindows REJECTED invalid monitor ${area.monitorIndex}: ${area.width}x${area.height} scale=${area.scaleFactor}`);
                return;
            }
        }
        let newPrimaryIndex = -1;
        if ((newdesktoplist.length > 0) && ('primaryMonitor' in newdesktoplist[0])) {
            newPrimaryIndex = newdesktoplist[0].primaryMonitor;
            this._dm._primaryIndex = newPrimaryIndex;
        }
        if (this._dm._desktopList && (newdesktoplist.length == this._dm._desktopList.length)) {
            let gridschanged = [];
            for (let index = 0; index < newdesktoplist.length; index++) {
                let area = newdesktoplist[index];
                let area2 = this._dm._desktopList[index];
                if ((area.x != area2.x) ||
                    (area.y != area2.y) ||
                    (area.width != area2.width) ||
                    (area.height != area2.height) ||
                    (area.scaleFactor !== area2.scaleFactor) ||
                    (area.monitorIndex != area2.monitorIndex)) {
                    gridschanged.push(index);
                    continue;
                }
                if ((area.marginTop != area2.marginTop) ||
                    (area.marginBottom != area2.marginBottom) ||
                    (area.marginLeft != area2.marginLeft) ||
                    (area.marginRight != area2.marginRight)) {
                    if (!gridschanged.includes(index)) {
                        gridschanged.push(index);
                    }
                }
            }
            if (gridschanged.length == 0) {
                if (this._dm._primaryIndex < this._dm._desktopList.length) {
                    this._dm._primaryScreen = this._dm._desktopList[this._dm._primaryIndex];
                } else {
                    this._dm._primaryScreen = null;
                }
                return;
            }
        }
        this._dm._desktopList = newdesktoplist;
        if (this._dm._primaryIndex < this._dm._desktopList.length) {
            this._dm._primaryScreen = this._dm._desktopList[this._dm._primaryIndex];
        } else {
            this._dm._primaryScreen = null;
        }
        this.createGridWindows();
        this._dm._updateDesktopSafe('grid update');
    }
    createGridWindows() {
        this._dm._removeAllFilesFromGrids();
        for (let desktop of this._dm._desktops) {
            desktop.destroy();
        }
        this._dm._desktops = [];
        for (let desktopIndex in this._dm._desktopList) {
            let desktop = this._dm._desktopList[desktopIndex];
            let desktopName;
            if (this._dm._asDesktop) {
                // this name must match the one used in emulateX11WindowType
                desktopName = `Desktop Icons ${desktop.monitorIndex + 1}`;
            } else {
                desktopName = `DING ${desktop.monitorIndex + 1}`;
            }
            this._dm._desktops.push(new DesktopGrid.DesktopGrid(this._dm, desktopName, desktop, this._dm._asDesktop,
                // Defer showing in desktop mode: the window is shown by
                // _drawDesktop once the first icon pass placed the items,
                // so the compositor's first frame (and the shell map
                // animation) shows actual icons instead of an empty window.
                this._dm._asDesktop));
        }
    }
    dbusAdvertiseUpdate() {
        this._trackSignal(DBusUtils.extensionControl, 'action-state-changed', (actionGroup, actionName, data) => {
            if (actionName == 'desktopGeometry') {
                this.updateGridWindows(data.recursiveUnpack());
            }
        });
        this._trackSignal(DBusUtils.extensionControl, 'action-added', (actionGroup, actionName) => {
            // this signal allows us to know when the action is available and we can read the initial value
            if (actionName == 'desktopGeometry') {
                let data = DBusUtils.extensionControl.get_action_state('desktopGeometry');
                this.updateGridWindows(data.recursiveUnpack());
            }
        });
        // This is required to trigger the 'action-added' signal
        DBusUtils.extensionControl.list_actions();
    }

    /* Icon placement across the per-monitor grids.
     * -------------------------------------------------------------- */

    /* Primary-screen fallback cell: where icons with no coordinates land.
     * Reused by addFilesToDesktop and addSingleFileToDesktop. */
    getFallbackPosition() {
        DebugLog.debugLog(`[place] fallback primary#${this._dm._primaryIndex} desktops=${this._dm._desktops.length}`);
        if (this._dm._primaryScreen !== null) {
            const primaryGrid = this._dm._desktops.find(g => g._monitor === this._dm._primaryScreen.monitorIndex);
            if (primaryGrid) {
                return [primaryGrid._x, primaryGrid._y];
            }
            return [
                this._dm._primaryScreen.x + this._dm._primaryScreen.windowMarginLeft,
                this._dm._primaryScreen.y + this._dm._primaryScreen.windowMarginTop,
            ];
        }
        return [0, 0];
    }

    /* Desktop that owns point (x, y): getDistance() === 0 wins; otherwise
     * the first desktop able to host it (getDistance() !== -1), or — with
     * nearest — the closest one. Returns null when nothing can host it. */
    findDesktopFor(x, y, { nearest = false, exactOnly = false } = {}) {
        let firstAvailable = null;
        let nearestDesktop = null;
        let minDistance = -1;
        for (let desktop of this._dm._desktops) {
            const distance = desktop.getDistance(x, y);
            DebugLog.debugLog(`[place] find(${x},${y}) grid#${desktop._monitor} dist=${distance}`);
            if (distance === 0) {
                DebugLog.debugLog(`[place] find(${x},${y}) -> grid#${desktop._monitor} (exact)`);
                return desktop;
            }
            if (exactOnly || distance === -1) {
                continue;
            }
            if (firstAvailable === null) {
                firstAvailable = desktop;
            }
            if ((minDistance === -1) || (distance < minDistance)) {
                minDistance = distance;
                nearestDesktop = desktop;
            }
        }
        const chosen = nearest ? nearestDesktop : firstAvailable;
        DebugLog.debugLog(`[place] find(${x},${y}) -> ${chosen === null ? 'NULL (no hostable grid)' : `grid#${chosen._monitor} ${nearest ? '(nearest)' : '(first-available)'}`}`);
        return chosen;
    }

    addFilesToDesktop(fileList, storeMode) {
        if (this._dm._desktops.length == 0) {
            return;
        }
        let outOfDesktops = [];
        let notAssignedYet = [];

        // First, add those icons that fit in the current desktops
        for (let fileItem of fileList) {
            if (fileItem.savedCoordinates == null) {
                notAssignedYet.push(fileItem);
                continue;
            }
            if (fileItem.dropCoordinates != null) {
                fileItem.dropCoordinates = null;
            }
            let [itemX, itemY] = fileItem.savedCoordinates;
            const desktop = this.findDesktopFor(itemX, itemY, { exactOnly: true });
            if (desktop !== null) {
                desktop.addFileItemCloseTo(fileItem, itemX, itemY, storeMode);
            } else {
                outOfDesktops.push(fileItem);
            }
        }
        // Now, assign those icons that are outside the current desktops,
        // but have assigned coordinates
        for (let fileItem of outOfDesktops) {
            let [itemX, itemY] = fileItem.savedCoordinates;
            const newDesktop = this.findDesktopFor(itemX, itemY, { nearest: true });
            if (newDesktop == null) {
                print('Not enough space to add icons');
                break;
            } else {
                newDesktop.addFileItemCloseTo(fileItem, itemX, itemY, storeMode);
            }
        }
        // Finally, assign those icons that still don't have coordinates
        for (let fileItem of notAssignedYet) {
            let x, y;
            if (fileItem.dropCoordinates == null) {
                [x, y] = this.getFallbackPosition();
                storeMode = Enums.StoredCoordinates.ASSIGN;
            } else {
                [x, y] = fileItem.dropCoordinates;
                fileItem.dropCoordinates = null;
                storeMode = Enums.StoredCoordinates.OVERWRITE;
            }
            // designated desktop first, any other hostable desktop as fallback
            const desktop = this.findDesktopFor(x, y);
            if (desktop !== null) {
                desktop.addFileItemCloseTo(fileItem, x, y, storeMode);
            }
        }
    }

    addSingleFileToDesktop(fileItem) {
        // Explicit drop intent wins over any stored position: a stale
        // nautilus-icon-position (e.g. copied or leftover metadata) must
        // not pull a freshly created/pasted icon onto another monitor.
        if (fileItem.dropCoordinates) {
            const [x, y] = fileItem.dropCoordinates;
            DebugLog.debugLog(`[place] ${fileItem.file.get_basename()} drop=(${x},${y})`);
            fileItem.dropCoordinates = null;
            const desktop = this.findDesktopFor(x, y);
            if (desktop !== null) {
                desktop.addFileItemCloseTo(fileItem, x, y,
                    Enums.StoredCoordinates.OVERWRITE);
                return;
            }
        }
        if (fileItem.savedCoordinates) {
            const [x, y] = fileItem.savedCoordinates;
            DebugLog.debugLog(`[place] ${fileItem.file.get_basename()} saved=(${x},${y})`);
            const desktop = this.findDesktopFor(x, y, { exactOnly: true });
            if (desktop !== null) {
                desktop.addFileItemCloseTo(fileItem, x, y,
                    Enums.StoredCoordinates.PRESERVE);
                return;
            }
        }
        DebugLog.debugLog(`[place] ${fileItem.file.get_basename()} FALLBACK primary=${!!this._dm._primaryScreen}`);
        const [x, y] = this.getFallbackPosition();
        const desktop = this.findDesktopFor(x, y);
        if (desktop !== null) {
            desktop.addFileItemCloseTo(fileItem, x, y,
                Enums.StoredCoordinates.ASSIGN);
        }
    }
};
