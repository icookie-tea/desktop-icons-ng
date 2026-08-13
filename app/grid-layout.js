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
    }};
