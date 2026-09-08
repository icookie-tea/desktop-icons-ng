/* DING: Desktop Icons New Generation for GNOME Shell
 *
 * Copyright (C) 2025 Sergio Costas (rastersoft@gmail.com)
 *
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
import * as DBusUtils from './dbus-utils.js';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import * as Prefs from './preferences.js';

import * as TemplatesScriptsManager from './templates-scripts-manager.js';
import * as DesktopIconsUtil from './desktop-icons-util.js';
import * as DebugLog from './log.js';
import * as MenuHelper from './menu-helper.js';
import * as Enums from './enums.js';

import Gettext from 'gettext';

const _ = Gettext.domain('ding').gettext;

export var DesktopMenu = class extends MenuHelper.MenuHelper {
    constructor(desktopManager, mainApp, dbusManager) {
        super(desktopManager, mainApp);

        this._dbusManager = dbusManager;
        this._lastBgMenu = null;
        this.templatesMonitor = new TemplatesScriptsManager.TemplatesScriptsManager(
            DesktopIconsUtil.getTemplatesDir(),
            TemplatesScriptsManager.TemplatesScriptsManagerFlags.HIDE_EXTENSIONS
        );
        this._desktopDir = DesktopIconsUtil.getDesktopDir();
        this._clipboardHasFiles = false;
        this._addActions();

        let clipboard = Gdk.Display.get_default().get_clipboard();
        this._clipboardSignalId = clipboard.connect('changed', () => {
            this._clipboardHasFiles = false;
            this._pasteAction.enabled = false;
            this._desktopManager.updateClipboard().then(hasFiles => {
                this._clipboardHasFiles = hasFiles;
                this._pasteAction.enabled = hasFiles;
            }).catch(e => {
                console.log(`Error updating clipboard on change: ${e.message}\n${e.stack}`);
            });
        });

        this._desktopManager.updateClipboard().then(hasFiles => {
            this._clipboardHasFiles = hasFiles;
            this._pasteAction.enabled = hasFiles;
        }).catch(e => {
            console.log(`Error updating clipboard: ${e.message}\n${e.stack}`);
        });
    }

    /* The clipboard is a process-wide singleton; its 'changed' handler
     * closes over this DesktopMenu, so it must be disconnected when the
     * DesktopManager is destroyed or every disable/enable cycle of the
     * extension leaks one handler + one stale DesktopManager. */
    disconnectSignals() {
        if (this._clipboardSignalId !== undefined) {
            Gdk.Display.get_default().get_clipboard().disconnect(this._clipboardSignalId);
            this._clipboardSignalId = undefined;
        }
    }

    setClickCoordinates(x, y) {
        this._clickX = Math.floor(x);
        this._clickY = Math.floor(y);
        DebugLog.debugLog(`[click] menu click=(${this._clickX},${this._clickY})`);
    }

    _newDocument(menuItem, variantPath) {
        const file = Gio.File.new_for_path(variantPath.get_string()[0]);
        if ((file == null) || !file.query_exists(null)) {
            return;
        }

        const fullName = file.get_basename();
        const finalName = this._desktopManager.getDesktopUniqueFileName(fullName);

        let destination = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP), finalName]));

        try {
            file.copy(destination, Gio.FileCopyFlags.NONE, null, null);
            const info = new Gio.FileInfo();
            DebugLog.debugLog(`[click] template at=(${this._clickX},${this._clickY}) -> ${finalName}`);
            info.set_attribute_string('metadata::nautilus-drop-position', `${this._clickX},${this._clickY}`);
            info.set_attribute_string('metadata::nautilus-icon-position', '');
            destination.set_attributes_from_info(info, Gio.FileQueryInfoFlags.NONE, null);
            // gvfs-metadata writes are async; the create event may arrive
            // before they land, so also record the target by basename like
            // the paste path does (matched in applyDropCoordinates).
            this._desktopManager._pendingDropFiles[finalName] = [this._clickX, this._clickY, Date.now()];
        } catch (e) {
            console.error(e, `Failed to create template ${e.message}`);
            const header = _('Template Creation Failed');
            const text = _('Error while trying to create a Document');
            this._dbusManager.doNotify(header, text);
        }
    }

    _onOpenDesktopInFilesClicked() {
        const context = Gdk.Display.get_default().get_app_launch_context();
        //context.set_timestamp(Gtk.get_current_event_time());
        Gio.AppInfo.launch_default_for_uri_async(this._desktopDir.get_uri(),
            context, null,
            (source, result) => {
                try {
                    Gio.AppInfo.launch_default_for_uri_finish(result);
                } catch (e) {
                    console.log(`Error opening Desktop in Files: ${e.message}`);
                }
            }
        );
    }

    _addActions() {
        this._addNewAction('changeDesktopIconSettings', null, Prefs.showPreferences);
        this._addNewAction('new-folder', ["<Control><Shift>n"], () => this._desktopManager.doNewFolder());
        this._addNewAction('create-template', null, this._newDocument.bind(this), 's');
        this._pasteAction = this._addNewAction('paste', null, () => this._desktopManager.doPaste(false));
        this._addNewAction('undo', ["<Control>z"], () => {
            DBusUtils.RemoteFileOperations.UndoRemote();
        });
        this._addNewAction('redo', ["<Control><Shift>z"], () => {
            DBusUtils.RemoteFileOperations.RedoRemote();
        });
        this._addNewAction('select-all', null, () => this._desktopManager.selectAll());
        this._addNewAction('arrange-icons', null, () => this._desktopManager.sortAllFilesFromGridsByPosition());
        this._addNewActionBoolean('keep-arranged');
        this._addNewActionBoolean('sort-special-folders');
        this._addNewActionSelection('arrangeorder');
        this._addNewAction('show-in-files', null, () => this._onOpenDesktopInFilesClicked());
        this._addNewAction('open-in-terminal-desktop', null, () => {
            DesktopIconsUtil.launchTerminal(this._desktopDir.get_path(), null);
        });
        this._addNewAction('change-background', null, () => {
            const desktopFile = GioUnix.DesktopAppInfo.new('gnome-background-panel.desktop');
            const context = Gdk.Display.get_default().get_app_launch_context();
            context.set_timestamp(Gdk.CURRENT_TIME);
            desktopFile.launch([], context);
        });
        this._addNewAction('show-settings', null, () => {
            const currentDesktop = GLib.getenv('XDG_CURRENT_DESKTOP') ?? '';
            if (currentDesktop.split(':').includes('ubuntu')) {
                const desktopFile = GioUnix.DesktopAppInfo.new('gnome-ubuntu-panel.desktop');
                const context = Gdk.Display.get_default().get_app_launch_context();
                //context.set_timestamp(Gtk.get_current_event_time());
                desktopFile.launch([], context);
            } else {
                Prefs.showPreferences();
            }
        });
        this._addNewAction('display-settings', null, () => {
            let desktopFile = GioUnix.DesktopAppInfo.new('gnome-display-panel.desktop');
            const context = Gdk.Display.get_default().get_app_launch_context();
            context.set_timestamp(Gdk.CURRENT_TIME);
            desktopFile.launch([], context);
        });
    }

    showDesktopMenu(x, y, grid) {
        if (this._lastBgMenu != null) {
            this._lastBgMenu.menuPopover.unparent();
            this._lastBgMenu = null;
        }
        this._pasteAction.enabled = this._clipboardHasFiles;
        let menu = this._createDesktopBackgroundMenu();
        let menuPopover = Gtk.PopoverMenu.new_from_model(menu);
        menuPopover.add_css_class('desktopmenu');
        menuPopover.set_has_arrow(false);
        menuPopover.set_halign(Gtk.Align.START);
        let rect = new Gdk.Rectangle();
        rect.x = x;
        rect.y = y;
        rect.width = 0;
        rect.height = 0;
        menuPopover.set_pointing_to(rect);
        menuPopover.set_parent(grid);
        menuPopover.show();
        menuPopover.popup();
        this._lastBgMenu = { menuPopover };
        menuPopover.connect('closed', () => {
            grid.grab_focus();
        });
    }

    _syncUndoRedo() {
        if (!DBusUtils.RemoteFileOperations.isAvailable) {
            return { undo: false, redo: false };
        }
        switch (DBusUtils.RemoteFileOperations.UndoStatus()) {
            case Enums.UndoStatus.UNDO:
                return { undo: true, redo: false };
            case Enums.UndoStatus.REDO:
                return { undo: false, redo: true };
            default:
                return { undo: false, redo: false };
        }
    }

    _addSortingSubMenu() {
        let arrangeSubMenu = new Gio.Menu();

        let section = this._newSection(arrangeSubMenu);
        this._newMenuElement(_('Keep Arranged...'), 'keep-arranged', section);
        this._newMenuElement(_('Sort Home/Drives/Trash...'), 'sort-special-folders', section);

        this._newMenuElement(_('Sort by Name'), 'arrangeorder', section, GLib.Variant.new_string('NAME'));
        this._newMenuElement(_('Sort by Name Descending'), 'arrangeorder', section, GLib.Variant.new_string('DESCENDINGNAME'));
        this._newMenuElement(_('Sort by Modified Time'), 'arrangeorder', section, GLib.Variant.new_string('MODIFIEDTIME'));
        this._newMenuElement(_('Sort by Type'), 'arrangeorder', section, GLib.Variant.new_string('KIND'));
        this._newMenuElement(_('Sort by Size'), 'arrangeorder', section, GLib.Variant.new_string('SIZE'));

        return arrangeSubMenu;
    }

    _createDesktopBackgroundMenu() {
        let menuContainer = new Gio.Menu();
        let section = this._newSection(menuContainer);
        this._newMenuElement(_('New Folder'), "new-folder", section);

        let templates = this.templatesMonitor.createMenu();
        if (templates !== null) {
            section.append_submenu(_('New Document'), templates);
        }

        section = this._newSection(menuContainer);
        this._newMenuElement(_('Paste'), "paste", section);
        let undoredo = this._syncUndoRedo();
        if (undoredo.undo) {
            this._newMenuElement(_('Undo'), "undo", section);
        }
        if (undoredo.redo) {
            this._newMenuElement(_('Redo'), "redo", section);
        }

        section = this._newSection(menuContainer);
        this._newMenuElement(_('Select All'), "select-all", section);

        section = this._newSection(menuContainer);
        this._newMenuElement(_('Arrange Icons'), "arrange-icons", section);
        section.append_submenu(_('Arrange By...'), this._addSortingSubMenu());

        section = this._newSection(menuContainer);
        this._newMenuElement(_('Show Desktop in Files'), "show-in-files", section);
        this._newMenuElement(_('Open in Terminal'), "open-in-terminal-desktop", section);

        section = this._newSection(menuContainer);
        this._newMenuElement(_('Change Background…'), "change-background", section);

        section = this._newSection(menuContainer);
        this._newMenuElement(_('Desktop Icons Settings'), "show-settings", section);
        this._newMenuElement(_('Display Settings'), "display-settings", section);

        return menuContainer;
    }
}