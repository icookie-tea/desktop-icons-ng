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
import Adw from 'gi://Adw';

import * as FileItem from './file-item.js';
import * as DesktopIconsUtil from './desktop-icons-util.js';
import * as Prefs from './preferences.js';
import * as Enums from './enums.js';
import * as NotifyX11UnderWayland from './notify-x11-under-wayland.js';
import * as DBusUtils from './dbus-utils.js';
import * as ShowErrorPopup from './show-error-popup.js';
import * as Thumbnails from './thumbnails.js';
import * as FileItemMenu from './file-item-menu.js';
import * as AutoAr from './auto-ar.js';
import * as SignalManager from './signal-manager.js';
import * as DesktopMenu from './desktop-menu.js';
import * as DesktopMonitor from './desktop-monitor.js';
import * as GridLayout from './grid-layout.js';
import * as FileChangesQueue from './file-changes-queue.js';
import * as Constants from './constants.js';
import * as DebugLog from './log.js';
import * as ThemeManager from './theme-manager.js';
import * as FileOperations from './file-operations.js';
import * as SortManager from './sort-manager.js';

import Gettext from 'gettext';

const _ = Gettext.domain('ding').gettext;

export var DesktopManager = class {
    constructor(mainApp, dbusManager, desktopList, codePath, asDesktop, primaryIndex) {
        this.mainApp = mainApp;
        this.dbusManager = dbusManager;
        this._lastSelected = null;
        this._fileList = [];

        this.using_X11 = Gdk.Display.get_default().constructor.$gtype.name === 'GdkX11Display';
        this._initX11Check(asDesktop);
        this._selectedFiles = null;
        this._clickCaptured = false;
        this._popupCounter = 0;

        this._initThemeAndManagers();
        // DesktopMenu queries the clipboard state via updateClipboard() in its
        // constructor, which needs _fileOps — create it first.
        this._desktopMenu = new DesktopMenu.DesktopMenu(this, mainApp, dbusManager);
        this._initPremultipliedCheck();
        this.autoAr = new AutoAr.AutoAr(this);
        this._initGridState(desktopList, primaryIndex, codePath, asDesktop);
        this._initFileMonitoring();
        this._initSettingsHandlers(mainApp);
        this._initStyles(codePath);
        this._initGridAndMetadata();
        this._initKeyboardAndNautilusCheck();
        this._initProcessLifecycle();
    }

    _initX11Check(asDesktop) {
        if (asDesktop) {
            this.mainApp.hold(); // Don't close the application if there are no desktops
            this._hold_active = true;
            if (this.using_X11) {
                let usingWayland = GLib.getenv('XDG_SESSION_TYPE') == 'wayland';
                if (usingWayland) {
                    // the system is using Wayland, but GTK is using X11!!!!!!
                    DBusUtils.extensionControl.activate_action('disableTimer', null);
                    if (Prefs.desktopSettings.get_boolean('check-x11wayland')) {
                        this._notifyX11UnderWayland = new NotifyX11UnderWayland.NotifyX11UnderWayland(doNotShowAnymore => {
                            this._notifyX11UnderWayland = null;
                            if (doNotShowAnymore) {
                                Prefs.desktopSettings.set_boolean('check-x11wayland', false);
                            }
                        });
                    }
                }
            } else {
                // if the problem is fixed and appears again, DING should show the message
                Prefs.desktopSettings.set_boolean('check-x11wayland', true);
            }
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
                    }
                });
            }
        }
        this._showHidden = Prefs.gtkSettings.get_boolean('show-hidden');
        this.showDropPlace = Prefs.desktopSettings.get_boolean('show-drop-place');
        this.useNemo = Prefs.desktopSettings.get_boolean('use-nemo');
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
        this._volumeMonitor = Gio.VolumeMonitor.get();
        this._trackSignal(this._volumeMonitor, 'mount-added', () => {
            this._updateDesktopSafe('mount added');
        });
        this._trackSignal(this._volumeMonitor, 'mount-removed', () => {
            this._updateDesktopSafe('mount removed');
        });
    }

    _onDesktopSettingsChanged(key) {
        switch (key) {
            case 'dark-text-in-labels':
                this.darkText = Prefs.desktopSettings.get_boolean('dark-text-in-labels');
                this._updateDesktopSafe('dark text changed');
                return;
            case 'show-link-emblem':
                this.showLinkEmblem = Prefs.desktopSettings.get_boolean('show-link-emblem');
                this._updateDesktopSafe('show link emblem changed');
                return;
            case 'use-nemo':
                this.useNemo = Prefs.desktopSettings.get_boolean('use-nemo');
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
        this.rubberBand = false;

        let cssProvider = new Gtk.CssProvider();
        cssProvider.load_from_file(Gio.File.new_for_path(GLib.build_filenamev([codePath, 'stylesheet.css'])));
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), cssProvider, Gtk.STYLE_PROVIDER_PRIORITY_USER);
        cssProvider = undefined;
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
        if (this._gridLayout) {
            this._gridLayout.destroy();
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
        this._clickCaptured = true;
    }

    onPressMainButton(controller, x, y, grid) {
        if (this._clickCaptured) {
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
            this.unselectAll();
        }
        this._startRubberband(x, y);
    }

    onReleaseMainButton() {
        this._clickCaptured = false;
        if (this.rubberBand) {
            this.rubberBand = false;
            this.selectionRectangle = null;
        }
        for (let grid of this._desktops) {
            grid.queue_draw();
        }
        return false;
    }

    _pressedMouseButton(x, y) {
        this._desktopMenu.setClickCoordinates(x, y);
        this._clickX = Math.floor(x);
        this._clickY = Math.floor(y);
    }

    onPressRightButton(controller, x, y, grid) {
        this._pressedMouseButton(x, y);
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
        if (this._fileList.length == 0) {
            return null;
        }
        let currentCoords = null;
        let currentItem = null;
        for (let item of this._fileList) {
            const newCoords = item.getCoordinates();
            if ((currentCoords === null) || (newCoords[0] < currentCoords[0]) || (newCoords[1] < currentCoords[1])) {
                currentCoords = newCoords;
                currentItem = item;
            }
        }
        return currentItem;
    }

    _getBottomRightIcon() {
        if (this._fileList.length == 0) {
            return null;
        }
        let currentCoords = null;
        let currentItem = null;
        for (let item of this._fileList) {
            const newCoords = item.getCoordinates();
            if ((currentCoords === null) || (newCoords[0] > currentCoords[0]) || (newCoords[1] > currentCoords[1])) {
                currentCoords = newCoords;
                currentItem = item;
            }
        }
        return currentItem;
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
            this.findFiles(grid.Window);
            return true;
        } else if (keyval == Gdk.KEY_Escape) {
            this.unselectAll();
            if (this.searchString) {
                this.searchString = null;
            }
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
            let key = String.fromCharCode(Gdk.keyval_to_unicode(keyval));
            if (this.keypressTimeoutID && this.searchString) {
                this.searchString = this.searchString.concat(key);
            } else {
                this.searchString = key;
            }
            if (this.searchString != '') {
                let found = this.scanForFiles(this.searchString, false);
                if (found) {
                    if ((this.getNumberOfSelectedItems() >= 1) && !this.keypressTimeoutID) {
                        let windowError = new ShowErrorPopup.ShowErrorPopup(
                            _('Clear Current Selection before New Search'),
                            null,
                            true);
                        windowError.timeoutClose(2000);
                        return true;
                    }
                    this._refreshSearchTimeout();
                    this.findFiles(grid.Window, this.searchString);
                }
            }
            return true;
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
        this._fileList.forEach(f => {
            f.unsetSelected();
            f.isKeyboardSelected = false;
        });
    }

    _refreshSearchTimeout() {
        if (this.keypressTimeoutID) {
            GLib.source_remove(this.keypressTimeoutID);
            this.keypressTimeoutID = null;
        }
        if (Prefs.a11YKeyboard) {
            // if the user has enabled any keyboard assistive technology,
            // disable the timeout to hide the search window
            if (Prefs.a11YKeyboard.get_boolean('stickykeys-enable') ||
                Prefs.a11YKeyboard.get_boolean('slowkeys-enable') ||
                Prefs.a11YKeyboard.get_boolean('bouncekeys-enable') ||
                Prefs.a11YKeyboard.get_boolean('mousekeys-enable')) {
                    return;
            }
        }
        if (Prefs.a11YApplications) {
            // if the user has enabled the screen reader,
            // disable the timeout to hide the search window
            if (Prefs.a11YApplications.get_boolean('screen-reader-enabled')) {
                return;
            }
        }

        this.keypressTimeoutID = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Constants.KEYPRESS_SEARCH_TIMEOUT_MS, () => {
            this.searchString = null;
            this.keypressTimeoutID = null;
            if (this._findFileWindow) {
                this._closeFindFiles(false);
            }
            return false;
        });
    }

    showFileMenu(fileItem, x, y) {
        this._fileItemMenu.showMenu(fileItem, x, y);
    }

    findFiles(window, text) {
        this._findFileWindow = new Adw.Dialog({
            'title': _('Find Files on Desktop'),
        });
        const container = new Gtk.Box({
            'orientation': Gtk.Orientation.VERTICAL,
        });
        this._findFileWindow.set_child(container);
        const topBar = new Adw.HeaderBar({
            'show-title': true,
            'decoration-layout': '',
        });
        this._findFileButton = Gtk.Button.new_with_label(_('OK'));
        this._findFileButton.sensitive = false;
        topBar.pack_end(this._findFileButton);
        const cancelButton = Gtk.Button.new_with_label(_('Cancel'));
        topBar.pack_start(cancelButton);
        container.append(topBar);

        this._findFileTextArea = new Gtk.Entry({
            margin_start: 18,
            margin_end: 18,
            margin_top: 18,
            margin_bottom: 18,
        });
        container.append(this._findFileTextArea);

        this._findFileSignalManager = new SignalManager.SignalManager();
        this._findFileSignalManager.connectSignal(this._findFileTextArea, 'activate', () => {
            if (this._findFileButton.sensitive) {
                this._closeFindFiles(false);
            }
        });
        this._findFileSignalManager.connectSignal(this._findFileButton, 'clicked', () => {
            this._closeFindFiles(false);
        });
        this._findFileSignalManager.connectSignal(cancelButton, 'clicked', () => {
            this._closeFindFiles(true);
        });
        let keyController = new Gtk.EventControllerKey();
        this._findFileWindow.add_controller(keyController);
        this._findFileSignalManager.connectSignal(keyController, 'key-pressed', (controller, keyval, keycode, state) => {
            if (keyval == Gdk.KEY_Escape) {
                this._closeFindFiles(true);
                return true;
            }
            return false;
        });
        this._findFileSignalManager.connectSignal(this._findFileTextArea, 'changed', () => {
            if (this.scanForFiles(this._findFileTextArea.text, true)) {
                this._findFileButton.sensitive = true;
                if (this._findFileTextArea.has_css_class('not-found')) {
                    this._findFileTextArea.remove_css_class('not-found');
                }
            } else {
                this._findFileButton.sensitive = false;
                this._findFileTextArea.error_bell();
                if (!this._findFileTextArea.has_css_class('not-found')) {
                    this._findFileTextArea.add_css_class('not-found');
                }
            }
            this._refreshSearchTimeout();
        });
        this._findFileWindow.show();
        this._findFileWindow.present(window);
        this._findFileTextArea.grab_focus();
        if (text) {
            this._findFileTextArea.set_text(text);
            this._findFileTextArea.set_position(text.length);
        } else {
            this.scanForFiles(null);
        }
    }

    _closeFindFiles(cancelled) {
        if (cancelled) {
            this.unselectAll();
        }
        this._findFileSignalManager.disconnectAllSignals();
        this._findFileWindow.close();
        this._findFileWindow = null;
    }

    scanForFiles(text, setselected) {
        let found = [];
        if (text && (text != '')) {
            found = this._fileList.filter(f => f.fileName.toLowerCase().includes(text.toLowerCase()) || f._label.get_text().toLowerCase().includes(text.toLowerCase()));
        }
        if (found.length != 0) {
            if (setselected) {
                this.unselectAll();
                found.forEach(f => f.setSelected());
            }
            return true;
        } else {
            return false;
        }
    }

    selectAll() {
        for (let fileItem of this._fileList) {
            if (fileItem.isAllSelectable) {
                fileItem.setSelected();
            }
        }
    }

    onMotion(x, y) {
        if (this.rubberBand) {
            this.x1 = Math.floor(Math.min(x, this.rubberBandInitX));
            this.x2 = Math.floor(Math.max(x, this.rubberBandInitX));
            this.y1 = Math.floor(Math.min(y, this.rubberBandInitY));
            this.y2 = Math.floor(Math.max(y, this.rubberBandInitY));
            this.selectionRectangle = new Gdk.Rectangle({ 'x': this.x1, 'y': this.y1, 'width': this.x2 - this.x1, 'height': this.y2 - this.y1 });
            for (let grid of this._desktops) {
                grid.queue_draw();
            }
            for (let item of this._fileList) {
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

    onCancelledMainButton() {
        this.onReleaseMainButton();
    }

    _startRubberband(x, y) {
        this.rubberBandInitX = x;
        this.rubberBandInitY = y;
        this.rubberBand = true;
        for (let item of this._fileList) {
            item.touchedByRubberband = false;
        }
    }

    selected(fileItem, action) {
        switch (action) {
            case Enums.Selection.ALONE:
                if (!fileItem.isSelected) {
                    for (let item of this._fileList) {
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
                    for (let item of this._fileList) {
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
                for (let item of this._fileList) {
                    if (item === fileItem) {
                        item.setSelected();
                    } else {
                        item.unsetSelected();
                    }
                }
                break;
        }
    }

    _removeAllFilesFromGrids() {
        for (let fileItem of this._fileList) {
            fileItem.removeFromGrid(true);
        }
        this._fileList = [];
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
                        for (let [newFolder, extras, volume] of DesktopIconsUtil.getMounts(this._volumeMonitor)) {
                            try {
                                fileList.push(new FileItem.FileItem(this,
                                    newFolder,
                                    newFolder.query_info(Enums.DEFAULT_ATTRIBUTES, Gio.FileQueryInfoFlags.NONE, null),
                                    extras,
                                    volume));
                            } catch (e) {
                                print(`Failed with ${e} while adding volume ${newFolder}`);
                            }
                        }
                        resolve(fileList);
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
        this._removeAllFilesFromGrids();
        this._fileList = fileList;
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
        this._fileItemMenu.refreshedIcons();
        this._selectedFiles = null;
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
            let addedToDesktop = false;
            for (let desktop of this._desktops) {
                if (desktop.getDistance(itemX, itemY) == 0) {
                    addedToDesktop = true;
                    desktop.addFileItemCloseTo(fileItem, itemX, itemY, storeMode);
                    break;
                }
            }
            if (!addedToDesktop) {
                outOfDesktops.push(fileItem);
            }
        }
        // Now, assign those icons that are outside the current desktops,
        // but have assigned coordinates
        for (let fileItem of outOfDesktops) {
            let minDistance = -1;
            let [itemX, itemY] = fileItem.savedCoordinates;
            let newDesktop = null;
            for (let desktop of this._desktops) {
                let distance = desktop.getDistance(itemX, itemY);
                if (distance == -1) {
                    continue;
                }
                if ((minDistance == -1) || (distance < minDistance)) {
                    minDistance = distance;
                    newDesktop = desktop;
                }
            }
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
                if (this._primaryScreen !== null) {
                    const primaryGrid = this._desktops.find(g => g._monitor === this._primaryScreen.monitorIndex);
                    if (primaryGrid) {
                        x = primaryGrid._x;
                        y = primaryGrid._y;
                    } else {
                        x = this._primaryScreen.x + this._primaryScreen.windowMarginLeft;
                        y = this._primaryScreen.y + this._primaryScreen.windowMarginTop;
                    }
                } else {
                    x = 0;
                    y = 0;
                }
                storeMode = Enums.StoredCoordinates.ASSIGN;
            } else {
                [x, y] = fileItem.dropCoordinates;
                fileItem.dropCoordinates = null;
                storeMode = Enums.StoredCoordinates.OVERWRITE;
            }
            // try first in the designated desktop
            let assigned = false;
            for (let desktop of this._desktops) {
                if (desktop.getDistance(x, y) == 0) {
                    desktop.addFileItemCloseTo(fileItem, x, y, storeMode);
                    assigned = true;
                    break;
                }
            }
            if (assigned) {
                continue;
            }
            // if there is no space in the designated desktop, try in another
            for (let desktop of this._desktops) {
                if (desktop.getDistance(x, y) != -1) {
                    desktop.addFileItemCloseTo(fileItem, x, y, storeMode);
                    break;
                }
            }
        }
    }

















    _addSingleFileToDesktop(fileItem) {
        if (fileItem.savedCoordinates) {
            const [x, y] = fileItem.savedCoordinates;
            DebugLog.debugLog(`[place] ${fileItem.file.get_basename()} saved=(${x},${y})`);
            for (let desktop of this._desktops) {
                if (desktop.getDistance(x, y) === 0) {
                    desktop.addFileItemCloseTo(fileItem, x, y,
                        Enums.StoredCoordinates.PRESERVE);
                    return;
                }
            }
        }
        if (fileItem.dropCoordinates) {
            const [x, y] = fileItem.dropCoordinates;
            DebugLog.debugLog(`[place] ${fileItem.file.get_basename()} drop=(${x},${y})`);
            fileItem.dropCoordinates = null;
            for (let desktop of this._desktops) {
                if (desktop.getDistance(x, y) === 0) {
                    desktop.addFileItemCloseTo(fileItem, x, y,
                        Enums.StoredCoordinates.OVERWRITE);
                    return;
                }
            }
            for (let desktop of this._desktops) {
                if (desktop.getDistance(x, y) !== -1) {
                    desktop.addFileItemCloseTo(fileItem, x, y,
                        Enums.StoredCoordinates.OVERWRITE);
                    return;
                }
            }
        }
        DebugLog.debugLog(`[place] ${fileItem.file.get_basename()} FALLBACK primary=${!!this._primaryScreen}`);
        let x, y;
        if (this._primaryScreen !== null) {
            const primaryGrid = this._desktops.find(g => g._monitor === this._primaryScreen.monitorIndex);
            if (primaryGrid) {
                x = primaryGrid._x;
                y = primaryGrid._y;
            } else {
                x = this._primaryScreen.x + this._primaryScreen.windowMarginLeft;
                y = this._primaryScreen.y + this._primaryScreen.windowMarginTop;
            }
        } else {
            x = 0;
            y = 0;
        }
        for (let desktop of this._desktops) {
            if (desktop.getDistance(x, y) === 0) {
                desktop.addFileItemCloseTo(fileItem, x, y,
                    Enums.StoredCoordinates.ASSIGN);
                return;
            }
        }
        for (let desktop of this._desktops) {
            if (desktop.getDistance(x, y) !== -1) {
                desktop.addFileItemCloseTo(fileItem, x, y,
                    Enums.StoredCoordinates.ASSIGN);
                return;
            }
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
        for (let item of this._fileList) {
            if (item.isSelected && item.isSpecial) {
                return true;
            }
        }
        return false;
    }

    checkIfDirectoryIsSelected() {
        for (let item of this._fileList) {
            if ((item.isSelected || item.isKeyboardSelected) && item.isDirectory) {
                return true;
            }
        }
        return false;
    }

    getCurrentSelection(getUri = false) {
        let selection = [];
        for (let fileItem of this._fileList) {
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
        for (let item of this._fileList) {
            if ((item.isSelected) || (item.isKeyboardSelected)) {
                count++;
            }
        }
        return count;
    }

    getFileItemFromURI(uri) {
        for (let item of this._fileList) {
            if (uri == item.uri) {
                return item;
            }
        }
        return null;
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
            } catch (e) {
                console.error(e, 'Failed to create folder');
                const header = _('Folder Creation Failed');
                const text = _('Error while trying to create a Folder');
                this.dbusManager.doNotify(header, text);
                if (position || suggestedName) {
                    return null;
                }
                return null;
            }
            if (opts.rename) {
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

    _getSortManager() {
        return this._sortManager;
    }
};
