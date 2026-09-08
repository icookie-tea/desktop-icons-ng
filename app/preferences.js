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
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw';

import Gio from 'gi://Gio';
const GioSSS = Gio.SettingsSchemaSource;
import * as Enums from './enums.js';
import * as PrefsWindow from './prefs-window.js';

import Gettext from 'gettext';

export var _ = Gettext.domain('ding').gettext;

export var nautilusSettings = null;
export var nautilusCompression = null;
export var gtkSettings = null;
export var desktopSettings = null;
export var mutterSettings = null;
export var a11YKeyboard = null;
export var a11YApplications = null;
// This is already in Nautilus settings, so it should not be made tweakable here
export var CLICK_POLICY_SINGLE = false;
export var prefsWindow = null;
export var schemaGnomeDarkSettings = null;

/**
 *
 * @param path
 */
export function init(path) {
    const schemaSource = GioSSS.get_default();
    const schemaGtk = schemaSource.lookup(Enums.SCHEMA_GTK, true);
    gtkSettings = new Gio.Settings({settings_schema: schemaGtk});
    const schemaObj = schemaSource.lookup(Enums.SCHEMA_NAUTILUS, true);
    if (!schemaObj) {
        nautilusSettings = null;
    } else {
        nautilusSettings = new Gio.Settings({ settings_schema: schemaObj });
        nautilusSettings.connect('changed', _onNautilusSettingsChanged);
        _onNautilusSettingsChanged();
    }
    const compressionSchema = schemaSource.lookup(Enums.SCHEMA_NAUTILUS_COMPRESSION, true);
    if (!compressionSchema) {
        nautilusCompression = null;
    } else {
        nautilusCompression = new Gio.Settings({ settings_schema: compressionSchema });
    }
    const schemaDarkSettings = schemaSource.lookup(Enums.SCHEMA_DARK_SETTINGS, true);
    if (schemaDarkSettings) {
        schemaGnomeDarkSettings = new Gio.Settings({ settings_schema: schemaDarkSettings });
    }
    const schemaA11YKeyboard = schemaSource.lookup(Enums.SCHEMA_A11Y_KEYBOARD, true);
    if (schemaA11YKeyboard) {
        a11YKeyboard = new Gio.Settings({ settings_schema: schemaA11YKeyboard});
    }
    const schemaA11YApplications = schemaSource.lookup(Enums.SCHEMA_A11Y_APPLICATIONS, true);
    if (schemaA11YApplications) {
        a11YApplications = new Gio.Settings({ settings_schema: schemaA11YApplications});
    }

    desktopSettings = PrefsWindow.get_schema(path, Enums.SCHEMA);
    let schemaMutter = schemaSource.lookup(Enums.SCHEMA_MUTTER, true);
    if (schemaMutter) {
        mutterSettings = new Gio.Settings({ settings_schema: schemaMutter });
    }
}

/**
 *
 */
export function showPreferences() {
    if (prefsWindow) {
        return;
    }
    prefsWindow = new Adw.PreferencesWindow({
        title: _('Settings'),
        resizable: true,
        default_width: 520,
        default_height: 600,
    });
    prefsWindow.connect('close-request', () => {
        prefsWindow = null;
    });
    // Note: no windowHidePagerTaskbarModal() here — its trailing-space
    // title hack made the Shell treat this window as @!HTD (keep-above +
    // all-workspaces + hidden-from-taskbar). The settings window should
    // behave like a normal application window.
    let frame = PrefsWindow.preferencesFrame(Gtk, desktopSettings, nautilusSettings, gtkSettings);
    // Adw.PreferencesWindow 自带 Adw.HeaderBar（标题 + CSD 窗口按钮），
    // 与 gnome-shell 的 ExtensionPrefsDialog 同一类，无需手动绘制 header；
    // 裸 Adw.Window 不画 header，窗口将无法拖拽移动。
    // 页面通过 add() 添加（PreferencesWindow 只接受 PreferencesPage）。
    prefsWindow.add(frame);
    prefsWindow.present();
}

/**
 *
 */
export function _onNautilusSettingsChanged() {
    CLICK_POLICY_SINGLE = nautilusSettings.get_string('click-policy') == 'single';
}

/**
 *
 */
export function get_icon_size() {
    return Enums.ICON_SIZE[desktopSettings.get_string('icon-size')];
}

/**
 *
 */
export function get_desired_width() {
    return Enums.ICON_WIDTH[desktopSettings.get_string('icon-size')];
}

/**
 *
 */
export function get_desired_height() {
    return Enums.ICON_HEIGHT[desktopSettings.get_string('icon-size')];
}

export function increase_icon_size() {
    const currentSize = desktopSettings.get_enum('icon-size');
    switch(currentSize) {
        case 3: // tiny
            desktopSettings.set_enum('icon-size', 0); // small
            break;
        case 2: // large
            break;
        default:
            desktopSettings.set_enum('icon-size', currentSize+1);
            break;
    }
}

export function decrease_icon_size() {
    const currentSize = desktopSettings.get_enum('icon-size');
    switch(currentSize) {
        case 3: // tiny
            break;
        case 0: // small
            desktopSettings.set_enum('icon-size', 3);
            break;
        default:
            desktopSettings.set_enum('icon-size', currentSize-1);
            break;
    }
}

/**
 *
 */
export function get_start_corner() {
    return Enums.START_CORNER[desktopSettings.get_string('start-corner')].slice();
}

/**
 *
 */
export function getSortOrder() {
    return Enums.SortOrder[desktopSettings.get_string(Enums.SortOrder.ORDER)];
}

