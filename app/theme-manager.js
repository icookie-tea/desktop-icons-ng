/* DING: Desktop Icons New Generation for GNOME Shell
 *
 * Copyright (C) 2019 Sergio Costas (rastersoft@gmail.com)
 * Based on code original (C) Carlos Soriano
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License, or
 * (at your option) any later version.
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
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Adw from 'gi://Adw';

import * as Prefs from './preferences.js';
import * as DesktopIconsUtil from './desktop-icons-util.js';

export var ThemeManager = class {
    constructor(desktopManager) {
        this._dm = desktopManager;
        this._cssColorProviderSelection = null;
        // Set before any creation attempt: disconnect() runs during shutdown
        // even when monitor creation failed (audit 2026-09-11).
        this._userCssMonitor = null;
        this._userCssMonitorSignalId = undefined;
        this._disconnected = false;
        this._adwStyleManager = Adw.StyleManager.get_default();
        this._accentColorsAvailable = false;
        this.selectColor = new Gdk.RGBA({
            red: 0,
            green: 0,
            blue: 0.9,
            alpha: 1.0,
        });
        // Derived shade (libadwaita --accent-color equivalent: oklab from the
        // base color, min(l,0.5) light / max(l,0.85) dark). Resolved in
        // configureSelectionColor() via GTK's own oklab engine.
        this.accentColor = this.selectColor;
    }

    get accentColorsAvailable() {
        return this._accentColorsAvailable;
    }

    connectAccentColorHandler(handler) {
        // The accent color is resolved in configureSelectionColor() from
        // (1) a user-level override in ~/.config/gtk-4.0/gtk.css (e.g. the
        // Chromaleon extension's `@define-color accent_bg_color`), or
        // (2) the dynamic accent (settings portal / gsettings preset).
        // Re-read on every event that can change either source:
        //  - Adw.StyleManager accent-color change (Settings preset change)
        //  - user gtk.css / imported file changes (override edits)
        try {
            this._accentColorsAvailable =
                this._adwStyleManager.get_system_supports_accent_colors();
        } catch (e) {
            this._accentColorsAvailable = false;
        }

        try {
            this._adwStyleManagerSignalId = this._adwStyleManager.connect('notify', (obj, spec) => {
                if ((spec.get_name() === 'accent-color') || (spec.get_name() === 'accent-color-rgba')) {
                    handler();
                }
            });
        } catch (e) {
            console.log(`Unable to listen to accent color changes: ${e.message}\n${e.stack}`);
        }

        // Monitoring the whole dir also catches Chromaleon replacing
        // custom-accent.css (the @import target of gtk.css). Creation is
        // defensive: a transient inotify failure used to be swallowed with no
        // retry, so accent changes were missed for the whole process lifetime.
        const cssDir = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_config_dir(), 'gtk-4.0'])
        );
        DesktopIconsUtil.monitorDirectoryDefensively(cssDir, {
            flags: Gio.FileMonitorFlags.NONE,
            label: 'the user gtk.css folder',
            onMonitor: monitor => {
                if (this._disconnected) {
                    monitor.cancel();
                    return;
                }
                this._userCssMonitor = monitor;
                this._userCssMonitorSignalId = monitor.connect('changed', () => {
                    // A file write can generate several events (temp file +
                    // rename); debounce and re-read once the dust settles.
                    if (this._userCssChangeTimeoutId !== undefined)
                        GLib.source_remove(this._userCssChangeTimeoutId);
                    this._userCssChangeTimeoutId = GLib.timeout_add(
                        GLib.PRIORITY_DEFAULT,
                        300,
                        () => {
                            this._userCssChangeTimeoutId = undefined;
                            handler();
                            return GLib.SOURCE_REMOVE;
                        }
                    );
                });
            },
        });
    }

    /* All notify handlers (global singletons), the file monitor and the
     * selection-color CssProvider are added for the lifetime of the
     * DesktopManager; without this the extension's disable/enable cycles
     * accumulate live handlers and providers on the global display. */
    disconnect() {
        this._disconnected = true;
        if (this._adwStyleManagerSignalId !== undefined) {
            this._adwStyleManager.disconnect(this._adwStyleManagerSignalId);
            this._adwStyleManagerSignalId = undefined;
        }
        if (this._userCssChangeTimeoutId !== undefined) {
            GLib.source_remove(this._userCssChangeTimeoutId);
            this._userCssChangeTimeoutId = undefined;
        }
        if (this._userCssMonitor) {
            if (this._userCssMonitorSignalId !== undefined)
                this._userCssMonitor.disconnect(this._userCssMonitorSignalId);
            this._userCssMonitor.cancel();
            this._userCssMonitor = null;
            this._userCssMonitorSignalId = undefined;
        }
        if (this._cssColorProviderSelection !== null) {
            Gtk.StyleContext.remove_provider_for_display(
                Gdk.Display.get_default(),
                this._cssColorProviderSelection
            );
            this._cssColorProviderSelection = null;
        }
    }

    /* Read the accent override from the user stylesheet
     * (~/.config/gtk-4.0/gtk.css and its @import chain, e.g. Chromaleon's
     * custom-accent.css). Returns a Gdk.RGBA or null when no override is
     * defined.
     *
     * Reading the file directly (instead of lookup_color()) is deliberate:
     * GTK only re-parses the user stylesheet on theme reloads, which is
     * unreliable (Chromaleon forces it via a high-contrast toggle that races
     * its asynchronous file writes, and a failed re-parse can leave the old
     * color cached). The file itself is the ground truth. */
    _readUserAccentOverride() {
        const cssDir = GLib.build_filenamev([GLib.get_user_config_dir(), 'gtk-4.0']);
        const mainPath = GLib.build_filenamev([cssDir, 'gtk.css']);
        const mainFile = Gio.File.new_for_path(mainPath);
        if (!mainFile.query_exists(null))
            return null;

        const readFile = (path) => {
            try {
                const [ok, bytes] = Gio.File.new_for_path(path).load_contents(null);
                if (!ok)
                    return null;
                return new TextDecoder().decode(bytes);
            } catch (e) {
                return null;
            }
        };

        const contents = [readFile(mainPath)].filter((c) => c !== null);
        if (contents.length === 0)
            return null;

        // Resolve @import url("...") targets relative to gtk.css.
        const importRe = /@import\s+url\(["']?([^"')]+)["']?\)/g;
        let m;
        while ((m = importRe.exec(contents[0])) !== null) {
            const target = m[1];
            let path = null;
            if (target.startsWith('file://')) {
                const f = Gio.File.new_for_uri(target);
                if (f.get_path())
                    path = f.get_path();
            } else if (target.startsWith('/')) {
                path = target;
            } else {
                path = GLib.build_filenamev([cssDir, target]);
            }
            if (path !== null) {
                const content = readFile(path);
                if (content !== null)
                    contents.push(content);
            }
        }

        return ThemeManager.parseAccentOverride(contents);
    }

    /*
     * Pure core of _readUserAccentOverride(): given the CSS contents of
     * gtk.css and its @import chain (in resolution order), return the last
     * parseable `@define-color accent_bg_color` as a Gdk.RGBA, or null.
     * Comments are stripped first so commented-out definitions are ignored.
     */
    static parseAccentOverride(contents) {
        const defineRe = /@define-color\s+accent_bg_color\s+([^;]+);/g;
        let result = null;
        for (const content of contents) {
            const stripped = content.replace(/\/\*[\s\S]*?\*\//g, '');
            let d;
            while ((d = defineRe.exec(stripped)) !== null) {
                const rgba = new Gdk.RGBA();
                if (rgba.parse(d[1].trim()))
                    result = rgba;
            }
        }
        return result;
    }

    configureSelectionColor() {
        if (this._cssColorProviderSelection !== null) {
            Gtk.StyleContext.remove_provider_for_display(
                Gdk.Display.get_default(),
                this._cssColorProviderSelection
            );
        }

        if (!Prefs.desktopSettings.get_boolean('use-accent-color')) {
            // Nautilus-style fixed grey (Nautilus overrides --accent-bg-color
            // to #959595 in its list/grid views): selection, rubberband and
            // drop preview do not follow the accent color.
            this.selectColor = new Gdk.RGBA({
                red: 0x95 / 255,
                green: 0x95 / 255,
                blue: 0x95 / 255,
                alpha: 1.0,
            });
        } else {
            try {
                // 1) User-level override (Chromaleon custom accent, or any
                //    @define-color accent_bg_color in the user gtk.css).
                const override = this._readUserAccentOverride();
                if (override !== null) {
                    this.selectColor = override;
                } else {
                    // 2) Dynamic accent (settings portal / gsettings preset).
                    //    This covers Chromaleon's "GNOME Colors" mode, a disabled
                    //    Chromaleon, and plain systems (no override defined).
                    try {
                        this.selectColor = this._adwStyleManager.get_accent_color_rgba();
                    } catch (e) {
                        // 3) Theme named color (older systems without the portal
                        //    accent).
                        const box = new Gtk.Label();
                        const styleContext = box.get_style_context();
                        styleContext.add_class('view');
                        const [exists, color] = styleContext.lookup_color('accent_bg_color');
                        if (exists)
                            this.selectColor = color;
                        else
                            throw new Error('Style Context does not provide accent_bg_color');
                    }
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
        }
        // Derived shade = libadwaita's --accent-color formula (oklab, keep
        // hue, clamp lightness). libadwaita switches the variant with the
        // color scheme (min(l,0.5) light / max(l,0.85) dark) because Nautilus
        // sits on a solid black/white background. The desktop wallpaper does
        // not change with the color scheme, so by default we always use the
        // brighter dark-mode variant; following the scheme is opt-in via
        // 'accent-shade-follow-color-scheme'.
        let shadeVariant = 'max(l, 0.85)';
        try {
            if (Prefs.desktopSettings.get_boolean('accent-shade-follow-color-scheme') &&
                Prefs.schemaGnomeDarkSettings.get_string('color-scheme') !== 'prefer-dark') {
                shadeVariant = 'min(l, 0.5)';
            }
        } catch (e) {
            // keep the bright variant
        }
        let cssColorDefinition =
            `@define-color desktop_icons_bg_color ${this.selectColor.to_string()};\n` +
            `@define-color desktop_icons_accent_color @desktop_icons_bg_color;\n` +
            `@define-color desktop_icons_accent_color oklab(from @desktop_icons_bg_color ${shadeVariant} a b);\n`;
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

        // Resolve the derived shade through GTK's own oklab engine so the
        // rubberband border/fill and the keyboard selection ring match
        // libadwaita's --accent-color exactly (e.g. #959595 -> ~#dadada in
        // dark mode, like Nautilus's grey views).
        try {
            const box = new Gtk.Label();
            const styleContext = box.get_style_context();
            const [exists, color] = styleContext.lookup_color('desktop_icons_accent_color');
            this.accentColor = exists ? color : this.selectColor;
        } catch (e) {
            this.accentColor = this.selectColor;
        }
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
