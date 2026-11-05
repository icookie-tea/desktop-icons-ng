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
    constructor(desktopManager, getPrimaryOnly = null, scheduler = null) {
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
        /* Items whose automatic anchor migration already failed once. Keyed by
         * the FileItem instance, so a rebuilt item (a new instance) gets a
         * fresh attempt while a failing backend is not retried on every
         * refresh of the same icon. */
        this._primaryMigrationAttempted = new WeakSet();
        /* Geometry coalescing (see queueGridUpdate). The scheduler is injected
         * so the timing rules are testable without waiting real time; the
         * defaults use GLib, which is what production runs. */
        this._scheduleGeometry = scheduler?.schedule ?? ((delayMs, callback) => GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, delayMs, () => {
                callback();
                return GLib.SOURCE_REMOVE;
            }));
        this._cancelGeometryTimer = scheduler?.cancel ?? (timerId => GLib.source_remove(timerId));
        this._nowMs = scheduler?.nowMs ?? (() => Math.floor(GLib.get_monotonic_time() / 1000));
        this._pendingGeometry = null;
        this._geometryTimerId = null;
        /* null (not 0) means "no burst in progress": a monotonic clock may
         * legitimately report 0 at the first event. */
        this._geometryBatchStartedAt = null;
    }

    /* Whether 'icons-only-on-primary' is active. Exposed so the desktop
     * manager can take primary-mode decisions (hidden files) without reading
     * the setting a second time. */
    get primaryOnly() {
        return this._getPrimaryOnly();
    }

    destroy() {
        this._cancelPendingGeometry();
        this._signalManager.disconnectAllSignals();
    }

    /* Rejects monitor descriptions that must not be applied.
     *
     * A zero-sized grid makes every getDistance() return -1 ("full"), so
     * _addFilesToDesktop drops every icon and the desktop appears empty with
     * no way to recover short of restarting the process; the compositor emits
     * such snapshots transiently while it recalculates monitors and
     * workareas. A margin set that consumes the whole area has the same
     * effect on the usable grid, so it is rejected the same way.
     *
     * @returns the snapshot when it is usable, null otherwise
     */
    _isValidGeometry(desktopList) {
        if (!Array.isArray(desktopList) || (desktopList.length === 0)) {
            return null;
        }
        for (const area of desktopList) {
            if (!area || (typeof area !== 'object')) {
                return null;
            }
            for (const key of ['x', 'y', 'width', 'height', 'scaleFactor']) {
                if (!Number.isFinite(area[key])) {
                    return null;
                }
            }
            if (!(area.width > 0) || !(area.height > 0) || !(area.scaleFactor > 0)) {
                return null;
            }
            for (const key of ['marginTop', 'marginBottom', 'marginLeft', 'marginRight',
                'windowMarginTop', 'windowMarginBottom', 'windowMarginLeft', 'windowMarginRight']) {
                const value = area[key] ?? 0;
                if (!Number.isFinite(value) || (value < 0)) {
                    return null;
                }
            }
            const horizontalMargins = (area.marginLeft ?? 0) + (area.marginRight ?? 0);
            const verticalMargins = (area.marginTop ?? 0) + (area.marginBottom ?? 0);
            if ((horizontalMargins >= area.width) || (verticalMargins >= area.height)) {
                return null;
            }
            /* Same computation DesktopGrid does: the grid only exists inside
             * what the margins leave, in logical pixels. */
            const usableWidth = Math.floor((area.width - horizontalMargins) / area.scaleFactor);
            const usableHeight = Math.floor((area.height - verticalMargins) / area.scaleFactor);
            if (!(usableWidth > 0) || !(usableHeight > 0)) {
                return null;
            }
            if (('primaryMonitor' in area) &&
                (!Number.isInteger(area.primaryMonitor) || (area.primaryMonitor < 0))) {
                return null;
            }
        }
        return desktopList;
    }

    /* Applies a geometry snapshot immediately (startup, and the tests). */
    updateGridWindows(newdesktoplist) {
        if (!this._isValidGeometry(newdesktoplist)) {
            DebugLog.debugLog('[grid] updateGridWindows REJECTED invalid monitor description: ' +
                JSON.stringify(newdesktoplist));
            return;
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
    /* Queues a geometry snapshot, coalescing a burst into one relayout.
     *
     * The compositor reports every intermediate state while it settles (scale
     * change, dock autohide, monitor hotplug), and each one used to rebuild
     * every grid. Only the newest valid snapshot is kept and applied once the
     * burst goes quiet, with the first event of a burst never held back longer
     * than GEOMETRY_UPDATE_MAX_WAIT_MS. A relayout driven by this path never
     * writes an icon position: the anchor decides the layout.
     */
    queueGridUpdate(desktopList) {
        if (!this._isValidGeometry(desktopList)) {
            /* Keep the last valid layout (and any valid snapshot already
             * queued): an invalid intermediate state must not replace it. */
            DebugLog.debugLog('[grid] queueGridUpdate IGNORED invalid monitor description');
            return;
        }
        this._pendingGeometry = desktopList;
        const now = this._nowMs();
        if (this._geometryBatchStartedAt === null) {
            this._geometryBatchStartedAt = now;
        }
        if (this._geometryTimerId !== null) {
            this._cancelGeometryTimer(this._geometryTimerId);
            this._geometryTimerId = null;
        }
        const elapsed = now - this._geometryBatchStartedAt;
        const delay = Math.min(Constants.GEOMETRY_UPDATE_DEBOUNCE_MS,
            Math.max(0, Constants.GEOMETRY_UPDATE_MAX_WAIT_MS - elapsed));
        this._geometryTimerId = this._scheduleGeometry(delay, () => {
            /* Cleared first: the callback must not leave a timer id behind
             * that destroy() or a later event would cancel a second time. */
            this._geometryTimerId = null;
            this._geometryBatchStartedAt = null;
            const pending = this._pendingGeometry;
            this._pendingGeometry = null;
            if (pending !== null) {
                this.updateGridWindows(pending);
            }
        });
    }

    _cancelPendingGeometry() {
        if (this._geometryTimerId !== null) {
            this._cancelGeometryTimer(this._geometryTimerId);
            this._geometryTimerId = null;
        }
        this._pendingGeometry = null;
        this._geometryBatchStartedAt = null;
    }

    dbusAdvertiseUpdate() {
        this._signalManager.connectSignal(DBusUtils.extensionControl, 'action-state-changed', (actionGroup, actionName, data) => {
            if (actionName == 'desktopGeometry') {
                this.queueGridUpdate(data.recursiveUnpack());
            }
        });
        this._signalManager.connectSignal(DBusUtils.extensionControl, 'action-added', (actionGroup, actionName) => {
            // this signal allows us to know when the action is available and we can read the initial value
            if (actionName == 'desktopGeometry') {
                /* The initial snapshot is applied immediately: queueing it
                 * would delay the first grid windows (and therefore the first
                 * frame of the desktop) by a whole debounce window. */
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

    /* Grid that may host icons in primary-only mode.
     *
     * _primaryGrid is resolved by _applyHostability(); the fallbacks cover the
     * window between a geometry update and the first _applyHostability() call
     * (and a stale primary index), so a placement never silently does nothing
     * while a hostable grid exists. */
    _hostablePrimaryGrid() {
        if (this._primaryGrid) {
            return this._primaryGrid;
        }
        if (this._dm._primaryScreen) {
            const byMonitor = this._dm._desktops.find(g => g._monitor === this._dm._primaryScreen.monitorIndex);
            if (byMonitor) {
                return byMonitor;
            }
        }
        return this._dm._desktops.find(g => g._hostable !== false) ?? null;
    }

    /* Global point an anchor projects to, in this grid's coordinate space. The
     * anchor is a fraction of the usable container area, so margins and the
     * scale factor are already accounted for by _width/_height. */
    _primaryAnchorTarget(grid, anchor) {
        const [localX, localY] = IconRemap.localPointForPosition(anchor, grid._width, grid._height);
        return grid.coordinatesLocalToGlobal(localX, localY);
    }

    /* Explicit placement intent for an item: the caller's targets map (a drag
     * that already computed the destination), then the drop coordinate
     * recorded by a paste/copy. Both beat a stored anchor: the user action is
     * newer than the file metadata. */
    _primaryExplicitTarget(item, targets) {
        if (targets && targets.has(item.uri)) {
            return targets.get(item.uri);
        }
        if (item.dropCoordinates) {
            return item.dropCoordinates;
        }
        return null;
    }

    /* Places one item on the primary grid, choosing the placement semantics:
     *  - explicit target (drag/paste) -> PRESERVE at that point,
     *  - compact (a sort)             -> ASSIGN (first free cell in order),
     *  - stored anchor                -> PRESERVE at the projected cell,
     *  - legacy coordinate            -> PRESERVE there (first migration),
     *  - nothing at all               -> PRESERVE around the fallback origin.
     * PRESERVE keeps the requested cell when it is free and otherwise takes the
     * nearest free one, which is what reproduces an unchanged grid exactly. */
    _placePrimaryItem(grid, item, targets, arranged) {
        if (arranged && (!item.isSpecial || this._dm.sortSpecialFolders)) {
            /* Sorted layout: fill the grid in the order the caller produced. */
            const target = item.savedCoordinates ?? this.getFallbackPosition();
            if (grid.addFileItemCloseTo(item, target[0], target[1],
                Enums.StoredCoordinates.ASSIGN, {persistLegacy: false}) === false) {
                this._unplacedCount++;
                return false;
            }
            return true;
        }
        const explicit = this._primaryExplicitTarget(item, targets);
        if (explicit) {
            /* Keep pending drops until the cell is committed. A full grid
             * or failed metadata save must not discard the destination. */
            if (grid.addFileItemCloseTo(item, explicit[0], explicit[1],
                Enums.StoredCoordinates.PRESERVE, {persistLegacy: false}) === false) {
                this._unplacedCount++;
                return false;
            }
            return true;
        }
        let target = null;
        if ((item.primaryPositionStatus === 'valid') && item.primaryPosition) {
            target = this._primaryAnchorTarget(grid, item.primaryPosition);
        } else if (item.savedCoordinates) {
            target = item.savedCoordinates;
        }
        if (target === null) {
            target = this.getFallbackPosition();
        }
        if (grid.addFileItemCloseTo(item, target[0], target[1],
            Enums.StoredCoordinates.PRESERVE, {persistLegacy: false}) === false) {
            this._unplacedCount++;
            return false;
        }
        return true;
    }

    /* Places fileList on the primary grid; returns the items that got a cell.
     *
     * Writes no metadata: commitPrimaryPositions() is the explicit step.
     *
     * Manual mode runs in three deterministic batches -- explicit drops, items
     * with a stored anchor, then everything else (a legacy coordinate, or the
     * fallback cell) -- and each batch is ordered by URI, so the result does
     * not depend on directory enumeration order. A sorted layout (arranged)
     * keeps the caller's order instead, because that order IS the layout.
     */
    placePrimaryFiles(fileList, {arranged = false, targets = null} = {}) {
        const grid = this._hostablePrimaryGrid();
        if (grid === null) {
            this._unplacedCount += fileList.length;
            return [];
        }
        const placed = [];
        if (arranged) {
            for (const item of fileList) {
                if (this._placePrimaryItem(grid, item, targets, true)) {
                    placed.push(item);
                }
            }
            return placed;
        }
        const batches = [[], [], []];
        for (const item of fileList) {
            if (this._primaryExplicitTarget(item, targets)) {
                batches[0].push(item);
            } else if ((item.primaryPositionStatus === 'valid') && item.primaryPosition) {
                batches[1].push(item);
            } else {
                batches[2].push(item);
            }
        }
        const byUri = (a, b) => {
            const ua = a.uri ?? '';
            const ub = b.uri ?? '';
            return (ua < ub) ? -1 : ((ua > ub) ? 1 : 0);
        };
        for (const batch of batches) {
            batch.sort(byUri);
            for (const item of batch) {
                if (this._placePrimaryItem(grid, item, targets, false)) {
                    placed.push(item);
                }
            }
        }
        return placed;
    }

    /* Writes the anchor of items that are on the primary grid right now.
     *
     * onlyMissing is the automatic migration: it fills in the anchor of an icon
     * that has none (or whose record is corrupt) and never rewrites a valid
     * one, because a repaint must not become a user edit. An 'unsupported'
     * record belongs to a newer DING and is left untouched. A failed write is
     * remembered per item, so a read-only backend is not hammered on every
     * refresh (an explicit user move always retries).
     */
    commitPrimaryPositions(fileItems, {onlyMissing = false} = {}) {
        const grid = this._hostablePrimaryGrid();
        if (grid === null) {
            return;
        }
        for (const item of fileItems) {
            if (!item || (typeof item.savePrimaryPosition !== 'function')) {
                continue;
            }
            if (onlyMissing) {
                const status = item.primaryPositionStatus;
                if ((status === 'valid') || (status === 'unsupported')) {
                    continue;
                }
                if (this._primaryMigrationAttempted.has(item)) {
                    continue;
                }
            }
            const anchor = grid.getFileItemPrimaryPosition(item);
            if (!anchor) {
                /* Not on the primary grid: there is no cell to record. */
                continue;
            }
            const [x, y] = item.getCoordinates();
            if (!item.savePrimaryPosition(anchor, [x, y]) && onlyMissing) {
                this._primaryMigrationAttempted.add(item);
            }
        }
    }

    addFilesToDesktop(fileList, storeMode) {
        if (this._dm._desktops.length == 0) {
            return [];
        }
        this._unplacedCount = 0;
        if (this._getPrimaryOnly()) {
            /* 'icons-only-on-primary' does not use absolute coordinates at
             * all: the stored anchor decides, and nothing is written back
             * unless the caller asks for it explicitly. ASSIGN is what the
             * sorting paths pass, which is the one case where the placement
             * is a compact fill of the grid instead of a projection. */
            const arranged = storeMode === Enums.StoredCoordinates.ASSIGN;
            const placed = this.placePrimaryFiles(fileList, {arranged});
            const explicitItems = new Set(placed.filter(item => item.dropCoordinates));
            /* Incoming drops are explicit even during an automatic sort;
             * consume them with the resulting cell, not a historical target. */
            this.commitPrimaryPositions([...explicitItems]);
            if (!arranged) {
                /* First sighting of an icon: give it an anchor, but never
                 * rewrite one it already has. Exclude explicit saves so a
                 * failed one is not retried as migration in the same pass. */
                this.commitPrimaryPositions(placed.filter(item => !explicitItems.has(item)), {onlyMissing: true});
            }
            this._reportUnplaced(this._unplacedCount);
            return placed;
        }
        const placed = this._addFilesToLegacyDesktops(fileList, storeMode);
        this._reportUnplaced(this._unplacedCount);
        return placed;
    }

    /* The historical placement path: absolute coordinates against every
     * monitor's grid. Consume pending drops only after successful placement. */
    _addFilesToLegacyDesktops(fileList, storeMode) {
        let placedItems = [];
        let outOfDesktops = [];
        let notAssignedYet = [];

        // First, add those icons that fit in the current desktops
        for (let fileItem of fileList) {
            if (fileItem.savedCoordinates == null) {
                notAssignedYet.push(fileItem);
                continue;
            }
            let [itemX, itemY] = fileItem.savedCoordinates;
            const desktop = this.findDesktopFor(itemX, itemY, { exactOnly: true });
            if (desktop !== null) {
                if (desktop.addFileItemCloseTo(fileItem, itemX, itemY, storeMode) !== false) {
                    if (fileItem.dropCoordinates != null) {
                        fileItem.dropCoordinates = null;
                    }
                    placedItems.push(fileItem);
                } else {
                    this._unplacedCount++;
                }
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
            /* Multi-monitor mode: when the monitor an icon lived on is gone
             * for good the new position is persisted (OVERWRITE); on a mere
             * geometry or scale change it is left alone (PRESERVE), so undoing
             * the change restores the previous layout. Primary-only mode does
             * not come through here (see placePrimaryFiles). */
            const moveMode = this._dm._primaryGridRemovedIcons ? Enums.StoredCoordinates.OVERWRITE : storeMode;
            if (newDesktop.addFileItemCloseTo(fileItem, itemX, itemY, moveMode) !== false) {
                if (fileItem.dropCoordinates != null) {
                    fileItem.dropCoordinates = null;
                }
                placedItems.push(fileItem);
            } else {
                this._unplacedCount++;
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
                storeMode = Enums.StoredCoordinates.OVERWRITE;
            }
            // designated desktop first, any other hostable desktop as fallback
            const desktop = this.findDesktopFor(x, y);
            if (desktop !== null) {
                if (desktop.addFileItemCloseTo(fileItem, x, y, storeMode) !== false) {
                    if (fileItem.dropCoordinates != null) {
                        fileItem.dropCoordinates = null;
                    }
                    placedItems.push(fileItem);
                } else {
                    this._unplacedCount++;
                }
            } else {
                this._unplacedCount++;
            }
        }
        return placedItems;
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
        if (this._dm._lastUnplacedNotify &&
            (now - this._dm._lastUnplacedNotify) < Constants.UNPLACED_NOTIFY_COOLDOWN_US) {
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

    addSingleFileToDesktop(fileItem) {
        if (this._getPrimaryOnly()) {
            this._unplacedCount = 0;
            /* An explicit drop (paste, new file, drag from another monitor) is
             * a user action and records the resulting cell; a plain first
             * sighting only fills in a missing anchor. */
            const hadExplicitTarget = !!this._primaryExplicitTarget(fileItem, null);
            const placed = this.placePrimaryFiles([fileItem]);
            if (placed.length === 0) {
                this._reportUnplaced(this._unplacedCount || 1);
                return null;
            }
            this.commitPrimaryPositions(placed, {onlyMissing: !hadExplicitTarget});
            return placed[0];
        }
        return this._addSingleFileToLegacyDesktop(fileItem);
    }

    _addSingleFileToLegacyDesktop(fileItem) {
        // Explicit drop intent wins over any stored position: a stale
        // nautilus-icon-position (e.g. copied or leftover metadata) must
        // not pull a freshly created/pasted icon onto another monitor.
        if (fileItem.dropCoordinates) {
            const [x, y] = fileItem.dropCoordinates;
            DebugLog.debugLog(`[place] ${fileItem.file.get_basename()} drop=(${x},${y})`);
            const desktop = this.findDesktopFor(x, y);
            if (desktop !== null) {
                if (desktop.addFileItemCloseTo(fileItem, x, y,
                    Enums.StoredCoordinates.OVERWRITE) !== false) {
                    fileItem.dropCoordinates = null;
                    return fileItem;
                }
            }
        }
        if (fileItem.savedCoordinates) {
            const [x, y] = fileItem.savedCoordinates;
            DebugLog.debugLog(`[place] ${fileItem.file.get_basename()} saved=(${x},${y})`);
            const desktop = this.findDesktopFor(x, y, { exactOnly: true });
            if (desktop !== null) {
                if (desktop.addFileItemCloseTo(fileItem, x, y,
                    Enums.StoredCoordinates.PRESERVE) !== false) {
                    return fileItem;
                }
            }
        }
        DebugLog.debugLog(`[place] ${fileItem.file.get_basename()} FALLBACK primary=${!!this._dm._primaryScreen}`);
        this._unplacedCount = 0;
        const [x, y] = this.getFallbackPosition();
        const desktop = this.findDesktopFor(x, y);
        if (desktop !== null) {
            if (desktop.addFileItemCloseTo(fileItem, x, y,
                Enums.StoredCoordinates.ASSIGN) !== false) {
                return fileItem;
            }
        }
        this._unplacedCount = 1;
        this._reportUnplaced(1);
        return null;
    }
};
