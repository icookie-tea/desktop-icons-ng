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
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Adw from 'gi://Adw';

import * as Prefs from './preferences.js';

export var ThemeManager = class {
    constructor(desktopManager) {
        this._dm = desktopManager;
        this._cssColorProviderSelection = null;
        this._adwStyleManager = Adw.StyleManager.get_default();
        this._accentColorsAvailable = false;
        this.selectColor = new Gdk.RGBA({
            red: 0,
            green: 0,
            blue: 0.9,
            alpha: 1.0,
        });
    }

    get accentColorsAvailable() {
        return this._accentColorsAvailable;
    }

    connectAccentColorHandler(handler) {
        try {
            if (this._adwStyleManager.get_system_supports_accent_colors()) {
                this._accentColorsAvailable = true;
                this._adwStyleManager.connect('notify', (obj, spec) => {
                    if ((spec.get_name() === 'accent-color') || (spec.get_name() === 'accent-color-rgba')) {
                        handler();
                    }
                });
            }
        } catch (e) {
            console.log(`System does not support accent colors: ${e.message}\n${e.stack}`);
            this._accentColorsAvailable = false;
        }
    }

    configureSelectionColor() {
        if (this._cssColorProviderSelection !== null) {
            Gtk.StyleContext.remove_provider_for_display(
                Gdk.Display.get_default(),
                this._cssColorProviderSelection
            );
        }

        try {
            if (this._accentColorsAvailable) {
                this.selectColor = this._adwStyleManager.get_accent_color_rgba();
            } else {
                const box = new Gtk.Label();
                const styleContext = box.get_style_context();
                styleContext.add_class('view');
                const [exists, color] = styleContext.lookup_color('accent_bg_color');
                if (exists)
                    this.selectColor = color;
                else
                    throw new Error('Style Context does not provide accent_bg_color');
            }
        } catch (e) {
            console.log(e.message);
            console.log('Setting default accent color to blue');
            this.selectColor = new Gdk.RGBA({
                red: 0,
                green: 0,
                blue: 0.9,
                alpha: 1.0,
            });
        }
        let cssColorDefinition =
            `@define-color desktop_icons_bg_color ${this.selectColor.to_string()};\n`;
        this._cssColorProviderSelection = new Gtk.CssProvider();
        // fix for api change Gtk 4.9
        try {
            this._cssColorProviderSelection.load_from_data(cssColorDefinition);
        } catch (e) {
            const gsizeLength = -1;
            this._cssColorProviderSelection.load_from_data(
                cssColorDefinition,
                gsizeLength
            );
        }
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(),
            this._cssColorProviderSelection,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );
    }

    checkApplyDarkModeSetting() {
        try {
            let displayGtkSettings = Gtk.Settings.get_default();
            displayGtkSettings.gtk_application_prefer_dark_theme = Prefs.schemaGnomeDarkSettings.get_string('color-scheme') === 'prefer-dark';
            return true;
        } catch (e) {
            return false;
        }
    }
};
