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
import * as SignalManager from './signal-manager.js';
import * as DebugLog from './log.js';
import * as Constants from './constants.js';
import * as Prefs from './preferences.js';
import * as IconRemap from './icon-remap.js';

import GLib from 'gi://GLib';
import Gettext from 'gettext';

const _ = Gettext.domain('ding').gettext;
const ngettext = Gettext.domain('ding').ngettext;

/* Monitor geometry management: subscribes to the extension's D-Bus
 * desktopGeometry action, diffs monitor areas, recreates the per-monitor
 * DesktopGrid windows and keeps _primaryScreen up to date. State lives on
 * the DesktopManager (this._dm). */
export var GridLayout = class {
    constructor(desktopManager, getPrimaryOnly = null) {
        this._dm = desktopManager;
        this._signalManager = new SignalManager.SignalManager();
        /* Injected so the placement logic stays testable without GSettings
         * (the tests run headless, with no schema installed). Production
         * passes a getter reading the 'icons-only-on-primary' key. The
         * default stays defensive because desktopSettings is null before
         * Prefs.init() and in the headless test harness. */
        this._getPrimaryOnly = getPrimaryOnly ?? (() => {
            const settings = Prefs.desktopSettings;
            if (!settings) {
                return false;
            }
            return settings.get_boolean('icons-only-on-primary');
        });
        this._unplacedCount = 0;
        this._primaryGrid = null;
        /* Tracks the primary monitor the stored icon coordinates were last
         * interpreted against. When the primary monitor changes, positions are
         * reinterpreted relative to the new one (see _remapStoredPositions) so
         * the icons keep their place instead of collapsing to the new screen's
         * edge. Kept separate from _primaryScreen because that is overwritten
         * on every geometry update. */
        this._coordPrimaryArea = null;
    }

    destroy() {
        this._signalManager.disconnectAllSignals();
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
        const oldPrimaryIndex = this._dm._primaryIndex;
        if ((newdesktoplist.length > 0) && ('primaryMonitor' in newdesktoplist[0])) {
            newPrimaryIndex = newdesktoplist[0].primaryMonitor;
            this._dm._primaryIndex = newPrimaryIndex;
        }
        /* A new primary display with the same monitor count produces no
         * geometry diff, so the placement would not re-run and the positions
         * would stay expressed in the old monitor's coordinate space (icons
         * then collapse to the new screen's edge). Detect it explicitly. */
        const primaryChanged = (newPrimaryIndex !== -1) && (newPrimaryIndex !== oldPrimaryIndex);
        /* The monitor count shrinking means a display was disconnected (a
         * geometry change on the same count is just a reposition/rescale).
         * Only in the first case may a parked icon's position be persisted,
         * because the monitor it referred to is gone for good; a rescale
         * must stay reversible. */
        if (this._dm._desktopList && (newdesktoplist.length < this._dm._desktopList.length)) {
            this._dm._primaryGridRemovedIcons = true;
            DebugLog.debugLog(`[grid] monitor count ${this._dm._desktopList.length} -> ${newdesktoplist.length}: icons parked on the primary grid will be persisted`);
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
                /* The primary display may have changed without any geometry
                 * change (same monitors, different primary): the hostable
                 * grid and the fallback anchor must follow it, and the stored
                 * positions must be re-expressed in the new monitor's space. */
                this._applyHostability();
                if (this._dm._primaryGridRemovedIcons || primaryChanged) {
                    this._dm._updateDesktopSafe(primaryChanged ? 'primary monitor changed' : 'monitor removed');
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

    /* Resolve which grid, if any, may host icons.
     *
     * With 'icons-only-on-primary' enabled, only the primary display's grid
     * hosts icons; every other grid reports "full" (getDistance() === -1), so
     * findDesktopFor() skips it. Those grids keep their window, drop target
     * and right-click menu -- they just stop being icon containers.
     *
     * Falls back to the first grid when the primary monitor index does not
     * match any grid (stale index, or the Shell reporting a primary that is
     * not in the list): otherwise no grid would be hostable and every icon
     * would be dropped. */
    _applyHostability() {
        this._primaryGrid = null;
        if (!this._getPrimaryOnly()) {
            for (const grid of this._dm._desktops) {
                grid._hostable = true;
            }
            return;
        }
        /* Resolve the primary grid by monitor index. _primaryScreen can be
         * null (the Shell reported an index beyond the list), but the
         * Shell's _primaryIndex is still authoritative in that case; falling
         * back to the first grid only when neither matches keeps a stale
         * index from making every grid non-hostable. */
        const primaryMonitor = this._dm._primaryScreen
            ? this._dm._primaryScreen.monitorIndex
            : this._dm._primaryIndex;
        this._primaryGrid = this._dm._desktops.find(g => g._monitor === primaryMonitor)
            ?? this._dm._desktops[0] ?? null;
        for (const grid of this._dm._desktops) {
            grid._hostable = (grid === this._primaryGrid);
        }
        DebugLog.debugLog(`[place] icons-only-on-primary: hostable grid=${this._primaryGrid ? this._primaryGrid._monitor : 'none'}`);
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
        this._applyHostability();
    }
    dbusAdvertiseUpdate() {
        this._signalManager.connectSignal(DBusUtils.extensionControl, 'action-state-changed', (actionGroup, actionName, data) => {
            if (actionName == 'desktopGeometry') {
                this.updateGridWindows(data.recursiveUnpack());
            }
        });
        this._signalManager.connectSignal(DBusUtils.extensionControl, 'action-added', (actionGroup, actionName) => {
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
        /* In primary-only mode the anchor is the hostable grid itself: the
         * raw primary area may not exist (stale index) while a grid still
         * does, and anchoring at (0,0) would put new icons on the wrong
         * display. */
        if (this._primaryGrid) {
            return [this._primaryGrid._x, this._primaryGrid._y];
        }
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
        this._unplacedCount = 0;
        this._remapStoredPositions(fileList);
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
        /* Now, assign those icons that are outside the current desktops, but
         * have assigned coordinates. Every icon is attempted even after one
         * cannot be placed: stopping at the first failure would rely on
         * "no grid can host" staying true for the rest of the batch, which
         * only holds because occupancy is monotonic -- continuing keeps that
         * a non-issue if the grid set ever changes mid-batch. */
        for (let fileItem of outOfDesktops) {
            let [itemX, itemY] = fileItem.savedCoordinates;
            const newDesktop = this.findDesktopFor(itemX, itemY, { nearest: true });
            if (newDesktop == null) {
                this._unplacedCount++;
                continue;
            }
            /* With 'icons-only-on-primary' the icon is parked on the primary
             * grid. When the monitor it used to live on is gone for good the
             * new position is persisted (OVERWRITE); on a mere geometry or
             * scale change the stored position is left alone (PRESERVE), so
             * undoing the change -- or switching the setting off -- restores
             * the previous layout. */
            const moveMode = this._dm._primaryGridRemovedIcons ? Enums.StoredCoordinates.OVERWRITE : storeMode;
            newDesktop.addFileItemCloseTo(fileItem, itemX, itemY, moveMode);
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
            } else {
                this._unplacedCount++;
            }
        }
        this._reportUnplaced(this._unplacedCount);
    }

    /* Tell the user when icons could not be placed, at most once per cooldown.
     *
     * A full desktop re-runs placement on every refresh (desktop directory
     * events, theme change, icon-size change), so an unthrottled notification
     * would fire repeatedly and read as a bug in itself. The count is what
     * matters to the user, and only the first report within the window is
     * shown. */
    _reportUnplaced(count) {
        if (!count) {
            return;
        }
        DebugLog.debugLog(`[place] ${count} icon(s) could not be placed`);
        const now = GLib.get_monotonic_time();
        if ((now - this._dm._lastUnplacedNotify) < Constants.UNPLACED_NOTIFY_COOLDOWN_US) {
            return;
        }
        this._dm._lastUnplacedNotify = now;
        try {
            this._dm.dbusManager.doNotify(_('Desktop is full'),
                ngettext('{0} desktop icon could not be placed',
                    '{0} desktop icons could not be placed', count).replace('{0}', count));
        } catch (e) {
            // A missing notification service must never break placement.
            DebugLog.debugLog(`[place] could not notify about unplaced icons: ${e.message}`);
        }
    }

    /* Reinterpret stored positions when the primary monitor changed.
     *
     * Positions on the desktop are absolute screen coordinates, so a position
     * that was meaningful on the old primary monitor falls outside the new one
     * and the grid placement would collapse it to the nearest edge. Instead,
     * the fractional position within the old primary area is re-applied to the
     * new one, which is what "the icon did not move" means to the user.
     *
     * The result IS persisted (OVERWRITE). Keeping it in memory only was tried
     * and does not work: the stored coordinate would stay in the old monitor's
     * coordinate space while every later refresh assumes the current one, so
     * the next pass would feed an old-space coordinate to the new grid and the
     * icon collapsed to the edge again (2-position oscillation, reproduced).
     * Persisting keeps every icon in one coordinate space, which is what makes
     * the placement deterministic. Reversibility is preserved by the remap
     * being exact: switching the primary monitor back maps the position to the
     * original one (tests/test-icon-remap.js asserts the round trip). */
    _remapStoredPositions(fileList) {
        const area = this._dm._primaryScreen;
        const previous = this._coordPrimaryArea;
        this._coordPrimaryArea = area;
        if (!this._getPrimaryOnly() || !area || !previous) {
            return;
        }
        if ((area.monitorIndex === previous.monitorIndex) &&
            (area.x === previous.x) && (area.y === previous.y) &&
            (area.width === previous.width) && (area.height === previous.height)) {
            return;
        }
        let remapped = 0;
        for (const fileItem of fileList) {
            const stored = fileItem.savedCoordinates;
            if (!stored || IconRemap.isInside(stored, area)) {
                // No position, or already meaningful on the current primary.
                continue;
            }
            const moved = IconRemap.remapPosition(stored, previous, area).map(Math.round);
            /* Write through the public setter this time: the new coordinate is
             * in the current monitor's space and must survive the refresh, so
             * every icon ends up expressed in one coordinate system. */
            fileItem.savedCoordinates = moved;
            remapped++;
        }
        if (remapped > 0) {
            DebugLog.debugLog(`[place] primary monitor changed (${previous.monitorIndex}->${area.monitorIndex}): re-mapped ${remapped} icon position(s)`);
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
        } else {
            this._unplacedCount = 1;
            this._reportUnplaced(1);
        }
    }
};
