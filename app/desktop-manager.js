/* DING: Desktop Icons New Generation for GNOME Shell
 *
 * Copyright (C) 2019-2025 Sergio Costas (rastersoft@gmail.com)
 * Based on code original (C) Carlos Soriano
 * Some code from Gtk4 DING version by (C) Sundeep Mediratta (smedius@gmail.com)
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
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';

import * as FileItem from './file-item.js';
import * as DesktopIconsUtil from './desktop-icons-util.js';
import * as Prefs from './preferences.js';
import * as Enums from './enums.js';
import * as DBusUtils from './dbus-utils.js';
import * as ShowErrorPopup from './show-error-popup.js';
import * as Thumbnails from './thumbnails.js';
import * as FileItemMenu from './file-item-menu.js';
import * as AutoAr from './auto-ar.js';
import * as DesktopMenu from './desktop-menu.js';
import * as DesktopMonitor from './desktop-monitor.js';
import * as GridLayout from './grid-layout.js';
import * as MountManager from './mount-manager.js';
import * as FileChangesQueue from './file-changes-queue.js';
import * as Constants from './constants.js';
import * as DebugLog from './log.js';
import * as ThemeManager from './theme-manager.js';
import * as FileOperations from './file-operations.js';
import * as SortManager from './sort-manager.js';
import * as SelectionManager from './selection-manager.js';
import * as SearchDialog from './search-dialog.js';

import Gettext from 'gettext';

const _ = Gettext.domain('ding').gettext;

export var DesktopManager = class {
    constructor(mainApp, dbusManager, desktopList, codePath, asDesktop, primaryIndex) {
        this.mainApp = mainApp;
        this.dbusManager = dbusManager;
        this._lastSelected = null;
        this._fileList = [];

        this._initDesktopHold(asDesktop);
        this._selectedFiles = null;
        this._popupCounter = 0;

        this._initThemeAndManagers();
        // MountManager owns the VolumeMonitor signals and the async mount
        // query (see docs/volume-mount-issues.md)
        this._mountManager = new MountManager.MountManager(
            this, reason => this._updateDesktopSafe(reason));
        // DesktopMenu queries the clipboard state via updateClipboard() in its
        // constructor, which needs _fileOps — create it first.
        this._desktopMenu = new DesktopMenu.DesktopMenu(this, mainApp, dbusManager);
        this._initPremultipliedCheck();
        this.autoAr = new AutoAr.AutoAr(this);
        this._initGridState(desktopList, primaryIndex, codePath, asDesktop);
        this._selectionManager = new SelectionManager(this);
        this._initFileMonitoring();
        this._initSettingsHandlers(mainApp);
        this._searchDialog = new SearchDialog(this);
        this._initStyles(codePath);
        this._initGridAndMetadata();
        this._initKeyboardAndNautilusCheck();
        this._initProcessLifecycle();
    }

    _initDesktopHold(asDesktop) {
        if (asDesktop) {
            // Don't close the application if there are no desktops
            this.mainApp.hold();
            this._hold_active = true;
        }
    }

    _initThemeAndManagers() {
        this._themeManager = new ThemeManager.ThemeManager(this);
        this._fileOps = new FileOperations.FileOperations(this);
        this._sortManager = new SortManager.SortManager(this);
        this._themeManager.connectAccentColorHandler(() => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._themeManager.configureSelectionColor();
                for (let desktop of this._desktops) {
                    desktop.queue_draw();
                    if (desktop._container) {
                        desktop._container.queue_draw();
                    }
                }
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _initPremultipliedCheck() {
        this._premultiplied = false;
        try {
            for (let f of Prefs.mutterSettings.get_strv('experimental-features')) {
                if (f == 'scale-monitor-framebuffer') {
                    this._premultiplied = true;
                    break;
                }
            }
        } catch (e) {
            // mutter may not expose experimental-features; absence just
            // means no premultiplied-framebuffer optimization
        }
    }

    _initGridState(desktopList, primaryIndex, codePath, asDesktop) {
        this._primaryIndex = primaryIndex;
        if (primaryIndex < desktopList.length) {
            this._primaryScreen = desktopList[primaryIndex];
        } else {
            this._primaryScreen = null;
        }
        this._clickX = 0;
        this._clickY = 0;
        this._dragList = null;
        this.dragItem = null;
        this._dragOriginX = 0;
        this._dragOriginY = 0;
        this.thumbnailLoader = new Thumbnails.ThumbnailLoader(this, codePath);
        this._codePath = codePath;
        this._asDesktop = asDesktop;
        this._desktopList = desktopList;
        this._desktops = [];
        this._signalIds = [];
        this._gridLayout = new GridLayout.GridLayout(this);
    }

    _trackSignal(obj, signal, cb) {
        this._signalIds.push([obj, obj.connect(signal, cb)]);
    }
    _initFileMonitoring() {
        this._monitor = new DesktopMonitor.DesktopMonitor(this);
        this._desktopFilesChanged = false;
        this._readingDesktopFiles = false;
        this._desktopDir = DesktopIconsUtil.getDesktopDir();
        this.desktopFsId = this._desktopDir.query_info('id::filesystem', Gio.FileQueryInfoFlags.NONE, null).get_attribute_string('id::filesystem');
        this._monitor.updateWritableByOthers();
        this._monitorDesktopDir = this._desktopDir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
        this._monitorDesktopDir.set_rate_limit(Constants.MONITOR_RATE_LIMIT_MS);
        this._trackSignal(this._monitorDesktopDir, 'changed', (obj, file, otherFile, eventType) => this._monitor.updateDesktopIfChanged(file, otherFile, eventType));

        this._pendingMoves = {};
        this._processingIncremental = false;
        this._moveTimeoutId = 0;
        this._fileChangesQueue = new FileChangesQueue.FileChangesQueue(Constants.FILE_CHANGES_DEBOUNCE_MS, Constants.MAX_INCREMENTAL_EVENTS);
        this._fileChangesQueue.onFlush(events => {
            this._monitor.processIncrementalEvents(events).catch(e => {
                print(`Unhandled error in incremental update: ${e.message}\n${e.stack}`);
                this._monitor.scheduleFullRefresh();
            });
        });
    }

    _initSettingsHandlers(mainApp) {
        this._fileItemMenu = new FileItemMenu.FileItemMenu(this, mainApp);
        if (Prefs.schemaGnomeDarkSettings) {
            if (this._themeManager.checkApplyDarkModeSetting()) {
                this._trackSignal(Prefs.schemaGnomeDarkSettings, 'changed', (obj, key) => {
                    if (key === 'color-scheme') {
                        this._themeManager.checkApplyDarkModeSetting();
                        // the derived shade variant (light/dark) changed
                        this._themeManager.configureSelectionColor();
                        for (let desktop of this._desktops) {
                            desktop.queue_draw();
                            if (desktop._container) {
                                desktop._container.queue_draw();
                            }
                        }
                    }
                });
            }
        }
        this._showHidden = Prefs.gtkSettings.get_boolean('show-hidden');
        this.showDropPlace = Prefs.desktopSettings.get_boolean('show-drop-place');
        this.showLinkEmblem = Prefs.desktopSettings.get_boolean('show-link-emblem');
        this.darkText = Prefs.desktopSettings.get_boolean('dark-text-in-labels');
        this._trackSignal(Prefs.desktopSettings, 'changed', (obj, key) => this._onDesktopSettingsChanged(key));
        this._trackSignal(Prefs.gtkSettings, 'changed', (obj, key) => {
            if (key == 'show-hidden') {
                this._showHidden = Prefs.gtkSettings.get_boolean('show-hidden');
                this._updateDesktopSafe('hidden setting changed');
            }
        });
        this._trackSignal(Prefs.nautilusSettings, 'changed', (obj, key) => {
            if (key == 'show-image-thumbnails') {
                this._updateDesktopSafe('nautilus settings changed');
            }
        });
        this._gtkIconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        this._trackSignal(this._gtkIconTheme, 'changed', () => {
            this._updateDesktopSafe('gtk icon theme changed');
        });
    }

    _onDesktopSettingsChanged(key) {
        switch (key) {
            case 'dark-text-in-labels':
                this.darkText = Prefs.desktopSettings.get_boolean('dark-text-in-labels');
                // fast-path refresh reuses widgets, so sync the label class here
                this._fileList.forEach(x => x._applyDarkTextClass());
                this._updateDesktopSafe('dark text changed');
                return;
            case 'use-accent-color':
            case 'accent-shade-follow-color-scheme':
                this._themeManager.configureSelectionColor();
                for (let desktop of this._desktops) {
                    desktop.queue_draw();
                    if (desktop._container) {
                        desktop._container.queue_draw();
                    }
                }
                return;
            case 'show-link-emblem':
                this.showLinkEmblem = Prefs.desktopSettings.get_boolean('show-link-emblem');
                this._updateDesktopSafe('show link emblem changed');
                return;
            case 'icon-size':
                this._fileList.forEach(x => x.removeFromGrid(false));
                for (let desktop of this._desktops) {
                    desktop.resizeGrid();
                }
                this._fileList.forEach(x => x.updateIcon());
                this._placeAllFilesOnGrids(true);
                this._updateDesktopSafe('icon size changed');
                return;
            case Enums.SortOrder.ORDER:
                if (this.keepStacked) {
                    this.doStacks(true);
                } else {
                    this.doSorts(true);
                }
                return;
            case 'unstackedtypes':
                if (this.keepStacked) {
                    this.doStacks(true);
                }
                return;
            case 'keep-stacked':
                this.keepStacked = Prefs.desktopSettings.get_boolean('keep-stacked');
                if (!this.keepStacked) {
                    this._unstack();
                } else {
                    this.doStacks(true);
                }
                return;
            case 'keep-arranged':
                this.keepArranged = Prefs.desktopSettings.get_boolean('keep-arranged');
                if (this.keepArranged) {
                    this.doSorts(true);
                }
                return;
            default:
                this.showDropPlace = Prefs.desktopSettings.get_boolean('show-drop-place');
                this._updateDesktopSafe('settings changed');
        }
    }

    _initStyles(codePath) {
        this._cssProvider = new Gtk.CssProvider();
        this._cssProvider.load_from_file(Gio.File.new_for_path(GLib.build_filenamev([codePath, 'stylesheet.css'])));
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), this._cssProvider, Gtk.STYLE_PROVIDER_PRIORITY_USER);
        this._themeManager.configureSelectionColor();
    }

    _initGridAndMetadata() {
        this._gridLayout.createGridWindows();

        DBusUtils.GtkVfsMetadata.connectSignalToProxy('AttributeChanged', this._monitor.metadataChanged.bind(this._monitor));
        this._allFileList = null;
        this._forcedExit = false;
        this._updateDesktopSafe('initial load');
    }

    _initKeyboardAndNautilusCheck() {
        this._scriptsList = [];

        this.ignoreKeys = [Gdk.KEY_space, Gdk.KEY_Shift_L, Gdk.KEY_Shift_R, Gdk.KEY_Control_L, Gdk.KEY_Control_R, Gdk.KEY_Caps_Lock, Gdk.KEY_Shift_Lock, Gdk.KEY_Meta_L, Gdk.KEY_Meta_R, Gdk.KEY_Alt_L, Gdk.KEY_Alt_R, Gdk.KEY_Super_L, Gdk.KEY_Super_R, Gdk.KEY_ISO_Level3_Shift, Gdk.KEY_ISO_Level5_Shift];

        // Check if Nautilus is available
        try {
            DesktopIconsUtil.trySpawn(null, ['nautilus', '--version']);
        } catch (e) {
            this._errorWindow = new ShowErrorPopup.ShowErrorPopup(_('Nautilus File Manager not found'),
                _('The Nautilus File Manager is mandatory to work with Desktop Icons NG.'),
                true);
        }
    }

    destroy() {
        for (let [obj, id] of this._signalIds) {
            obj.disconnect(id);
        }
        this._signalIds = [];
        if (this._mountManager) {
            this._mountManager.destroy();
        }
        if (this._themeManager) {
            this._themeManager.disconnect();
        }
        if (this._desktopMenu) {
            this._desktopMenu.disconnectSignals();
        }
        if (this._cssProvider) {
            Gtk.StyleContext.remove_provider_for_display(Gdk.Display.get_default(), this._cssProvider);
            this._cssProvider = null;
        }
        if (this._gridLayout) {
            this._gridLayout.destroy();
        }
        if (this._searchDialog) {
            this._searchDialog.destroy();
        }
        if (this._fileChangesQueue) {
            this._fileChangesQueue.destroy();
        }
    }

    _initProcessLifecycle() {
        this._pendingDropFiles = {};
        if (this._asDesktop) {
            const signalAdd = GLibUnix.signal_add ?? GLibUnix.signal_add_full;
            this._sigtermID = signalAdd(GLib.PRIORITY_DEFAULT, 15, () => {
                GLib.source_remove(this._sigtermID);
                for (let desktop of this._desktops) {
                    desktop.destroy();
                }
                this._desktops = [];
                this._forcedExit = true;
                if (this._desktopEnumerateCancellable) {
                    this._desktopEnumerateCancellable.cancel();
                }
                if (this._mountManager) {
                    this._mountManager.cancelQuery();
                }
                if (this._hold_active) {
                    this.mainApp.release();
                    this._hold_active = false;
                }
                return false;
            });
        }
        if (this._asDesktop) {
            this._gridLayout.dbusAdvertiseUpdate();
        }
    }

    updateFileList() {
        let updateFileList;
        if (this._allFileList && (this._allFileList.length > 0)) {
            updateFileList = this._allFileList;
        } else {
            updateFileList = this._fileList;
        }
        return updateFileList;
    }







    updateGridWindows(newdesktoplist) {
        this._gridLayout.updateGridWindows(newdesktoplist);
    }

    get selectColor() {
        return this._themeManager.selectColor;
    }

    get accentColor() {
        return this._themeManager.accentColor;
    }

    clearFileCoordinates(fileList, dropCoordinates) {
        this._fileOps.clearFileCoordinates(fileList, dropCoordinates);
    }

    doMoveWithDragAndDrop(xOrigin, yOrigin, xDestination, yDestination) {
        const keepArranged = this.keepArranged || this.keepStacked;
        if (this.sortSpecialFolders && keepArranged) {
            return;
        }
        // Find the grid where the destination lies and aim towards the positive side, middle of grid to ensure drop in the grid
        for (let desktop of this._desktops) {
            const grid = desktop.getGridAt(xDestination, yDestination, true);
            if (grid !== null) {
                xDestination = grid[0] + desktop._elementWidth / 2;
                yDestination = grid[1] + desktop._elementHeight / 2;
                break;
            }
        }
        let deltaX = xDestination - xOrigin;
        let deltaY = yDestination - yOrigin;
        let fileItems = [];
        for (let item of this._fileList) {
            if (item.isSelected) {
                if (keepArranged) {
                    if (item.isSpecial) {
                        fileItems.push(item);
                        item.removeFromGrid(false);
                        let [x, y] = item.getCoordinates();
                        item.savedCoordinates = [x + deltaX, y + deltaY];
                    } else {
                        continue;
                    }
                } else {
                    fileItems.push(item);
                    item.removeFromGrid(false);
                    let [x, y] = item.getCoordinates();
                    item.savedCoordinates = [x + deltaX, y + deltaY];
                }
            }
        }
        // force to store the new coordinates
        this._addFilesToDesktop(fileItems, Enums.StoredCoordinates.OVERWRITE);
        fileItems = undefined;
        if (this.keepArranged) {
            this._updateDesktopSafe('move with drag and drop (keep arranged)');
        }
    }

    onDragBegin(item) {
        this.dragItem = item;
        let [xOrigin, yOrigin] = item.getCoordinates();
        this._dragOriginX = xOrigin;
        this._dragOriginY = yOrigin;
    }

    onDragMotion(x, y) {
        if (this.dragItem === null) {
            for (let desktop of this._desktops) {
                desktop.refreshDrag([[0, 0]], x, y);
            }
            return;
        }
        if (this._dragList === null) {
            let itemList = this.getCurrentSelection(false);
            if (!itemList) {
                return;
            }
            let [x1, y1] = this.dragItem.getCoordinates();
            let oX = x1;
            let oY = y1;
            this._dragList = [];
            for (let item of itemList) {
                [x1, y1] = item.getCoordinates();
                this._dragList.push([x1 - oX, y1 - oY]);
            }
        }
        for (let desktop of this._desktops) {
            desktop.refreshDrag(this._dragList, x, y);
        }
    }

    getDragList() {
        return this._dragList;
    }

    onDragLeave() {
        this._dragList = null;
        for (let desktop of this._desktops) {
            desktop.refreshDrag(null, 0, 0);
        }
    }

    onDragEnd() {
        this.dragItem = null;
    }

    onDragDataReceived(dropInfo, xDestination, yDestination, forceMove) {
        this.onDragLeave();
        if (dropInfo.filelist.length == 0) {
            return;
        }
        switch (dropInfo.mimetype) {
            case Enums.DndTargetInfo.DING_ICON_LIST:
                this.doMoveWithDragAndDrop(this._dragOriginX, this._dragOriginY, xDestination, yDestination);
                break;
            case Enums.DndTargetInfo.GNOME_ICON_LIST:
            case Enums.DndTargetInfo.URI_LIST:
                this.clearFileCoordinates(dropInfo.filelist, [xDestination, yDestination]);
                let data = Gio.File.new_for_uri(dropInfo.filelist[0]).query_info('id::filesystem', Gio.FileQueryInfoFlags.NONE, null);
                let idFS = data.get_attribute_string('id::filesystem');
                if ((this.desktopFsId == idFS) || forceMove) {
                    DBusUtils.RemoteFileOperations.MoveURIsRemote(dropInfo.filelist, DesktopIconsUtil.getDesktopDir().get_uri());
                } else {
                    DBusUtils.RemoteFileOperations.CopyURIsRemote(dropInfo.filelist, DesktopIconsUtil.getDesktopDir().get_uri());
                }
                break;
            case Enums.DndTargetInfo.TEXT_PLAIN:
                this._writeDroppedText(dropInfo.filelist[0], [xDestination, yDestination]);
                break;
        }
    }

    _writeDroppedText(text, dropCoordinates) {
        let filename = DesktopIconsUtil.generateDropFilename(text);
        filename = this.getDesktopUniqueFileName(filename);
        DesktopIconsUtil.writeDroppedTextFile(text, filename, dropCoordinates);
    }

    clickCaptured() {
        this._selectionManager.clickCaptured();
    }

    onPressMainButton(controller, x, y, grid) {
        if (this._selectionManager._clickCaptured) {
            return;
        }
        if (this._desktopMenu._lastBgMenu != null) {
            this._desktopMenu._lastBgMenu.menuPopover.unparent();
            this._desktopMenu._lastBgMenu = null;
        }
        this._pressedMouseButton(x, y);
        let state = DesktopIconsUtil.getControllerStatus(controller);
        if (!state.shift && !state.control) {
            // clear selection
            this._selectionManager.unselectAll();
        }
        this._selectionManager._startRubberband(x, y);
    }

    onReleaseMainButton() {
        return this._selectionManager.onReleaseMainButton();
    }

    _pressedMouseButton(x, y) {
        this._desktopMenu.setClickCoordinates(x, y);
        this._clickX = Math.floor(x);
        this._clickY = Math.floor(y);
    }

    onPressRightButton(controller, x, y, gx, gy, grid) {
        // x/y are container-local (the popover needs them), gx/gy are the
        // global equivalents stored into _clickX/_clickY — every consumer
        // of those interprets them as global screen coordinates.
        DebugLog.debugLog(`[click] stored _click=(${gx},${gy}) menu-local=(${x},${y})`);
        this._pressedMouseButton(gx, gy);
        this._desktopMenu.showDesktopMenu(x, y, grid);
    }

    showPopup() {
        this._popupCounter++;
    }

    hidePopup() {
        if (this._popupCounter > 0)
            this._popupCounter--;
        else
            console.log("Mismatched hidePopup() and showPopup() calls");
    }

    _getTopLeftIcon() {
        return this._selectionManager._getTopLeftIcon();
    }

    _getBottomRightIcon() {
        return this._selectionManager._getBottomRightIcon();
    }

    _setIconAsSelected(icon) {
        this._fileList.forEach(fileItem => fileItem.isKeyboardSelected = fileItem === icon);
    }

    _getLastKeyboardIcon() {
        if ((this._lastSelected !== null) && this._fileList.includes(this._lastSelected)) {
            this._setIconAsSelected(this._lastSelected);
            return this._lastSelected;
        }
        return null;
    }

    _getCurrentKeyboardIcon() {
        let currentKeyboardIcon = null;

        for (let fileItem of this._fileList) {
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
        if (this._popupCounter != 0)
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
                selected = this._getTopLeftIcon();
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
            for (let item of this._fileList) {
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
        if (this._popupCounter != 0)
            return false;
        const isCtrl = (state & Gdk.ModifierType.CONTROL_MASK) != 0;
        const isShift = (state & Gdk.ModifierType.SHIFT_MASK) != 0;
        const isAlt = (state & Gdk.ModifierType.MOD1_MASK) != 0;
        let selection = this.getCurrentSelection(false);
        if (keyval == Gdk.KEY_Home) {
            this._setIconAsSelected(this._getTopLeftIcon());
            return true;
        } else if (keyval == Gdk.KEY_End) {
            this._setIconAsSelected(this._getBottomRightIcon());
            return true;
        } else if (isCtrl && (keyval === Gdk.KEY_space)) {
            const selected = this._getCurrentKeyboardIcon();
            if (selected !== null) {
                selected.toggleSelected();
                return true;
            }
        } else if (isCtrl && ((keyval == Gdk.KEY_C) || (keyval == Gdk.KEY_c))) {
            this.doCopy();
            return true;
        } else if (isCtrl && ((keyval == Gdk.KEY_X) || (keyval == Gdk.KEY_x))) {
            this.doCut();
            return true;
        } else if (isCtrl && ((keyval == Gdk.KEY_V) || (keyval == Gdk.KEY_v))) {
            this.doPaste(true).catch(e => {console.log(`Error doing paste from keyboard: ${e.message}\n${e.stack}`)});
            return true;
        } else if (isAlt && (keyval == Gdk.KEY_Return)) {
            let currentSelection = this.getCurrentSelection(true);
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
                this.doRename(selection[0], false);
                return true;
            }
        } else if (selection && keyval == Gdk.KEY_space) {
            // Support previewing other grids file items.
            DBusUtils.RemoteFileOperations.ShowFileRemote(selection[0].uri, 0, true);
            return true;
        } else if (isCtrl && ((keyval == Gdk.KEY_A) || (keyval == Gdk.KEY_a))) {
            this.selectAll();
            return true;
        } else if (keyval == Gdk.KEY_F5) {
            this._updateDesktopSafe('F5 refresh');
            return true;
        } else if (isCtrl && ((keyval == Gdk.KEY_H) || (keyval == Gdk.KEY_h))) {
            Prefs.gtkSettings.set_boolean('show-hidden', !this._showHidden);
            return true;
        } else if (isCtrl && ((keyval == Gdk.KEY_F) || (keyval == Gdk.KEY_f))) {
            this._searchDialog.findFiles(grid.Window);
            return true;
        } else if (keyval == Gdk.KEY_Escape) {
            this._searchDialog.escape();
            return true;
        } else if ((keyval == Gdk.KEY_Menu) || ((keyval == Gdk.KEY_F10) && isShift)) {
            if (selection) {
                this._fileItemMenu.showMenu(selection[0], null, true);
            } else {
                this._desktopMenu.showDesktopMenu(0, 0, this._desktops[0]._container);
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
            return this._searchDialog.typeKey(keyval, grid.Window);
        }
        return false;
    }

    async updateClipboard() {
        return this._fileOps.updateClipboard();
    }

    async doPaste(refresh) {
        return this._fileOps.doPaste(refresh);
    }

    unselectAll() {
        this._selectionManager.unselectAll();
    }

    showFileMenu(fileItem, x, y) {
        this._fileItemMenu.showMenu(fileItem, x, y);
    }

    selectAll() {
        this._selectionManager.selectAll();
    }

    onMotion(x, y) {
        return this._selectionManager.onMotion(x, y);
    }

    onCancelledMainButton() {
        this.onReleaseMainButton();
    }

    selected(fileItem, action) {
        this._selectionManager.selected(fileItem, action);
    }

    _removeAllFilesFromGrids() {
        for (let fileItem of this._fileList) {
            fileItem.removeFromGrid(true);
        }
        this._fileList = [];
    }

    /* Like _removeAllFilesFromGrids, but keeps the FileItems alive: used by
     * the fast-path refresh, which reuses the widgets. */
    _clearAllFilesFromGrids() {
        for (let fileItem of this._fileList) {
            fileItem.removeFromGrid(false);
        }
        this._fileList = [];
    }

    /* True when both lists hold exactly the same files (same URIs, same
     * count), so icons can be refreshed in place instead of rebuilt. */
    _refreshReusedFileItem(old, newItem) {
        // The GMount behind the same URI may be a *new* object (an
        // unmount/remount inside the refresh window): keeping the stale one
        // breaks eject/unmount and the visible name (V-2)
        if (old._custom !== newItem._custom) {
            old._custom = newItem._custom;
        }
        if (typeof old._updateMetadataFromFileInfo === 'function') {
            old._updateMetadataFromFileInfo(newItem._fileInfo);
            // assign the coordinate fields directly: the setters
            // would write the stale values back to disk
            old._savedCoordinates = old._readCoordinatesFromAttribute(
                newItem._fileInfo, 'metadata::nautilus-icon-position');
            old._dropCoordinates = old._readCoordinatesFromAttribute(
                newItem._fileInfo, 'metadata::nautilus-drop-position');
            old._applyDarkTextClass();
            old._updateIcon().catch(e => {
                print(`Exception while refreshing a reused icon: ${e.message}\n${e.stack}`);
            });
        }
    }

    _canReuseFileItems(newList) {
        if (this._fileList.length !== newList.length) {
            return false;
        }
        const uris = new Set(newList.map(f => f.uri));
        for (const item of this._fileList) {
            if (!uris.has(item.uri)) {
                return false;
            }
        }
        return true;
    }

    async _updateDesktop() {
        if (this._readingDesktopFiles) {
            this._desktopFilesChanged = true;
            return;
        }

        this._readingDesktopFiles = true;
        this._forceDraw = false;
        this._lastDesktopUpdateRequest = GLib.get_monotonic_time();
        let fileList = [];
        while (true) {
            this._desktopFilesChanged = false;
            DebugLog.debugLog(`[update] iter reading=${this._readingDesktopFiles} changed=${this._desktopFilesChanged} forceDraw=${this._forceDraw}`);
            if (!this._desktopDir.query_exists(null)) {
                fileList = [];
                break;
            }
            fileList = await this._doReadAsync();
            DebugLog.debugLog(`[update] read result: ${fileList === null ? 'NULL' : fileList.length + ' files'}`);
            if (this._forcedExit) {
                return;
            }
            if (fileList !== null) {
                if (!this._desktopFilesChanged) {
                    break;
                }
                if (this._forceDraw) {
                    this._drawDesktop(fileList);
                    this._lastDesktopUpdateRequest = GLib.get_monotonic_time();
                } else {
                    // Destroy the unused FileItems to prevent memory leak
                    for (let item of fileList) {
                        item._onDestroy();
                    }
                }
            }
            await DesktopIconsUtil.waitDelayMs(Constants.REFRESH_RETRY_DELAY_MS);
            if ((GLib.get_monotonic_time() - this._lastDesktopUpdateRequest) > Constants.DESKTOP_UPDATE_THROTTLE_US) {
                this._forceDraw = true;
            } else {
                this._forceDraw = false;
            }
        }
        this._readingDesktopFiles = false;
        this._forceDraw = false;
        this._drawDesktop(fileList);
    }

    _doReadAsync() {
        if (this._desktopEnumerateCancellable) {
            this._desktopEnumerateCancellable.cancel();
        }
        this._desktopEnumerateCancellable = new Gio.Cancellable();
        return new Promise((resolve, reject) => {
            this._desktopDir.enumerate_children_async(
                Enums.DEFAULT_ATTRIBUTES,
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                this._desktopEnumerateCancellable,
                (source, result) => {
                    this._desktopEnumerateCancellable = null;
                    try {
                        let fileEnum = source.enumerate_children_finish(result);
                        if (this._desktopFilesChanged && !this._forceDraw) {
                            fileEnum.close(null);
                            resolve(null);
                            return;
                        }
                        let fileList = [];
                        for (let [newFolder, extras] of DesktopIconsUtil.getExtraFolders()) {
                            try {
                                fileList.push(new FileItem.FileItem(this,
                                    newFolder,
                                    newFolder.query_info(Enums.DEFAULT_ATTRIBUTES, Gio.FileQueryInfoFlags.NONE, null),
                                    extras,
                                    null));
                            } catch (e) {
                                print(`Failed with ${e.message} while adding extra folder ${newFolder.get_uri()}\n${e.stack}`);
                            }
                        }
                        let info;
                        while ((info = fileEnum.next_file(null))) {
                            let fileItem = new FileItem.FileItem(this,
                                fileEnum.get_child(info),
                                info,
                                Enums.FileType.NONE,
                                null);
                            if (fileItem.isHidden && !this._showHidden) {
                                /* if there are hidden files in the desktop and the user doesn't want to
                                    show them, remove the coordinates. This ensures that if the user enables
                                    showing them, they won't fight with other icons for the same place
                                */
                                if (fileItem.savedCoordinates) {
                                    // only overwrite them if needed
                                    fileItem.savedCoordinates = null;
                                }
                                fileItem._onDestroy();
                                continue;
                            }
                            fileList.push(fileItem);
                            this._monitor.applyDropCoordinates(fileItem);
                        }
                        fileEnum.close(null);
                        // Mount info is queried asynchronously: a dead network
                        // mount must not freeze the main loop with a
                        // synchronous query_info (V-3)
                        this._mountManager._readMountsAsync(this._mountManager.getMounts(),
                            fileList,
                            this._mountManager.queryCancellable,
                            () => resolve(fileList));
                        return;
                    } catch (e) {
                        print(`Exception while reading desktop folder: ${e.message}\n${e.stack}`);
                        resolve(null);
                    }
                }
            );
        });
    }

    _drawDesktop(fileList) {
        // Clear stacking data that references items about to be destroyed
        this._allFileList = null;
        this.stackInitialCoordinates = null;
        this._pendingMoves = {};
        if (this._moveTimeoutId) {
            GLib.source_remove(this._moveTimeoutId);
            this._moveTimeoutId = 0;
        }
        this._selectedFiles = this.getCurrentSelection(true);
        if (this._renameWindow) {
            // disconnect the popup from the fileItem to avoid it being
            // destroyed when the fileItem is removed from the desktop
            this._renameWindow.updateFileItem(null);
        }
        // Fast path: same file set — refresh metadata in place instead of
        // destroying and recreating every icon widget (avoids flicker on
        // settings/mount refreshes; incremental events already cover the
        // common file-system changes). Falls back to full rebuild whenever
        // the file set changed (stack markers also make URIs differ).
        if (this._canReuseFileItems(fileList)) {
            const oldByUri = new Map(this._fileList.map(f => [f.uri, f]));
            const reused = [];
            for (const newItem of fileList) {
                const old = oldByUri.get(newItem.uri);
                this._refreshReusedFileItem(old, newItem);
                newItem._onDestroy();
                reused.push(old);
            }
            this._clearAllFilesFromGrids();
            this._fileList = reused;
            DebugLog.debugLog(`[draw] reuse ${reused.length}/${fileList.length} t=${Math.floor(GLib.get_monotonic_time() / 1000)}`);
        } else {
            this._removeAllFilesFromGrids();
            this._fileList = fileList;
            DebugLog.debugLog(`[draw] rebuild ${fileList.length} t=${Math.floor(GLib.get_monotonic_time() / 1000)}`);
        }
        // Select the files that were selected before the repaint
        if (this._selectedFiles) {
            for (let fileItem of fileList) {
                if (this._selectedFiles.includes(fileItem.uri)) {
                    fileItem.setSelected();
                }
            }
        }
        if (this._renameWindow) {
            // assign the popover to the new fileItem
            let file = fileList.filter(f => f.fileName == this._renamingFile)[0];
            if (file) {
                file.setRenamePopup(this._renameWindow);
            } else {
                this._renameWindow.closeWindow();
            }
        }
        this._placeAllFilesOnGrids();
        this._selectedFiles = null;
        // First icon pass done — show the desktop windows now (desktop mode
        // defers their initial show until here so the compositor's first
        // frame already contains the icons and the shell map animation
        // animates actual content; see DesktopGrid constructor).
        for (const grid of this._desktops) {
            grid.showWindow();
        }
    }

    _placeAllFilesOnGrids(redisplay = false) {
        this.keepStacked = Prefs.desktopSettings.get_boolean('keep-stacked');
        this.keepArranged = Prefs.desktopSettings.get_boolean('keep-arranged');
        this.sortSpecialFolders = Prefs.desktopSettings.get_boolean('sort-special-folders');
        if (this.keepStacked) {
            this.doStacks(redisplay);
        } else if (this.keepArranged) {
            this.doSorts();
        } else {
            this._addFilesToDesktop(this._fileList, Enums.StoredCoordinates.PRESERVE);
        }
    }

    /* Primary-screen fallback cell: where icons with no coordinates land.
     * Reused by _addFilesToDesktop and _addSingleFileToDesktop. */
    _getFallbackPosition() {
        DebugLog.debugLog(`[place] fallback primary#${this._primaryIndex} desktops=${this._desktops.length}`);
        if (this._primaryScreen !== null) {
            const primaryGrid = this._desktops.find(g => g._monitor === this._primaryScreen.monitorIndex);
            if (primaryGrid) {
                return [primaryGrid._x, primaryGrid._y];
            }
            return [
                this._primaryScreen.x + this._primaryScreen.windowMarginLeft,
                this._primaryScreen.y + this._primaryScreen.windowMarginTop,
            ];
        }
        return [0, 0];
    }

    /* Desktop that owns point (x, y): getDistance() === 0 wins; otherwise
     * the first desktop able to host it (getDistance() !== -1), or — with
     * nearest — the closest one. Returns null when nothing can host it. */
    _findDesktopFor(x, y, { nearest = false, exactOnly = false } = {}) {
        let firstAvailable = null;
        let nearestDesktop = null;
        let minDistance = -1;
        for (let desktop of this._desktops) {
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

    _addFilesToDesktop(fileList, storeMode) {
        if (this._desktops.length == 0) {
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
            const desktop = this._findDesktopFor(itemX, itemY, { exactOnly: true });
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
            const newDesktop = this._findDesktopFor(itemX, itemY, { nearest: true });
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
                [x, y] = this._getFallbackPosition();
                storeMode = Enums.StoredCoordinates.ASSIGN;
            } else {
                [x, y] = fileItem.dropCoordinates;
                fileItem.dropCoordinates = null;
                storeMode = Enums.StoredCoordinates.OVERWRITE;
            }
            // designated desktop first, any other hostable desktop as fallback
            const desktop = this._findDesktopFor(x, y);
            if (desktop !== null) {
                desktop.addFileItemCloseTo(fileItem, x, y, storeMode);
            }
        }
    }

    _addSingleFileToDesktop(fileItem) {
        // Explicit drop intent wins over any stored position: a stale
        // nautilus-icon-position (e.g. copied or leftover metadata) must
        // not pull a freshly created/pasted icon onto another monitor.
        if (fileItem.dropCoordinates) {
            const [x, y] = fileItem.dropCoordinates;
            DebugLog.debugLog(`[place] ${fileItem.file.get_basename()} drop=(${x},${y})`);
            fileItem.dropCoordinates = null;
            const desktop = this._findDesktopFor(x, y);
            if (desktop !== null) {
                desktop.addFileItemCloseTo(fileItem, x, y,
                    Enums.StoredCoordinates.OVERWRITE);
                return;
            }
        }
        if (fileItem.savedCoordinates) {
            const [x, y] = fileItem.savedCoordinates;
            DebugLog.debugLog(`[place] ${fileItem.file.get_basename()} saved=(${x},${y})`);
            const desktop = this._findDesktopFor(x, y, { exactOnly: true });
            if (desktop !== null) {
                desktop.addFileItemCloseTo(fileItem, x, y,
                    Enums.StoredCoordinates.PRESERVE);
                return;
            }
        }
        DebugLog.debugLog(`[place] ${fileItem.file.get_basename()} FALLBACK primary=${!!this._primaryScreen}`);
        const [x, y] = this._getFallbackPosition();
        const desktop = this._findDesktopFor(x, y);
        if (desktop !== null) {
            desktop.addFileItemCloseTo(fileItem, x, y,
                Enums.StoredCoordinates.ASSIGN);
        }
    }



    /* Lazy TTL for _pendingDropFiles: entries that never matched (copy
     * failed, filename changed, ...) expire after 5 minutes; the map is
     * also capped at 64 entries by dropping the oldest. */




    /**
     * Runs a desktop refresh, logging any failure with the given reason.
     * This is the single error-handling path for all _updateDesktop() callers.
     */
    _updateDesktopSafe(reason) {
        DebugLog.debugLog(`[update] FULL REFRESH reason=${reason} t=${Math.floor(GLib.get_monotonic_time() / 1000)}`);
        this._updateDesktop().catch(e => {
            print(`Exception while updating Desktop (${reason}): ${e.message}\n${e.stack}`);
        });
    }

    doCopy() {
        this._fileOps.doCopy();
    }

    doCut() {
        this._fileOps.doCut();
    }

    doTrash() {
        this._fileOps.doTrash();
    }

    doDeletePermanently() {
        this._fileOps.doDeletePermanently();
    }

    doEmptyTrash(askConfirmation = true) {
        this._fileOps.doEmptyTrash(askConfirmation);
    }

    checkIfSpecialFilesAreSelected() {
        return this._selectionManager.checkIfSpecialFilesAreSelected();
    }

    checkIfDirectoryIsSelected() {
        return this._selectionManager.checkIfDirectoryIsSelected();
    }

    getCurrentSelection(getUri = false) {
        return this._selectionManager.getCurrentSelection(getUri);
    }

    getNumberOfSelectedItems() {
        return this._selectionManager.getNumberOfSelectedItems();
    }

    getFileItemFromURI(uri) {
        return this._selectionManager.getFileItemFromURI(uri);
    }

    doRename(fileItem, allowReturnOnSameName) {
        this._fileOps.doRename(fileItem, allowReturnOnSameName);
    }

    fileExistsOnDesktop(searchName) {
        return this._fileOps.fileExistsOnDesktop(searchName);
    }

    getDesktopUniqueFileName(fileName) {
        return this._fileOps.getDesktopUniqueFileName(fileName);
    }

    doNewFolder(position = null, suggestedName = null, opts = { rename: true }) {
        this.unselectAll();

        if (!position) {
            position = [this._clickX, this._clickY];
        }
        DebugLog.debugLog(`[click] new-folder at=(${position[0]},${position[1]}) from=_click=(${this._clickX},${this._clickY})`);

        const baseName = suggestedName ? suggestedName : _('New Folder');
        let newName = this.getDesktopUniqueFileName(baseName);

        if (newName) {
            let dir = DesktopIconsUtil.getDesktopDir().get_child(newName);
            try {
                dir.make_directory(null);
                const info = new Gio.FileInfo();
                info.set_attribute_string('metadata::nautilus-drop-position', `${position.join(',')}`);
                info.set_attribute_string('metadata::nautilus-icon-position', '');
                dir.set_attributes_from_info(info, Gio.FileQueryInfoFlags.NONE, null);
                // gvfs-metadata writes are async; the create event may
                // arrive before they land, so also record by basename like
                // the paste path does (matched in applyDropCoordinates).
                this._pendingDropFiles[newName] = [position[0], position[1], Date.now()];
            } catch (e) {
                console.error(e, 'Failed to create folder');
                const header = _('Folder Creation Failed');
                const text = _('Error while trying to create a Folder');
                this.dbusManager.doNotify(header, text);
                return null;
            }
            if (opts.rename) {
                DebugLog.debugLog(`[rename] newFolderDoRename=${newName}`);
                this.newFolderDoRename = newName;
            }
            if (position || suggestedName) {
                return dir.get_uri();
            }
        }
        return null;
    }


    doStacks(restack) {
        this._sortManager.doStacks(restack);
    }

    sortAllFilesFromGridsByPosition() {
        this._sortManager.sortAllFilesFromGridsByPosition();
    }

    _unstack() {
        this._sortManager._unstack();
    }

    doSorts(cleargrids) {
        this._sortManager.doSorts(cleargrids);
    }

    onToggleStackUnstackThisTypeClicked(type) {
        this._sortManager.onToggleStackUnstackThisTypeClicked(type);
    }
};
