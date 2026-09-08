/* DING: Desktop Icons New Generation for GNOME Shell
 *
 * Copyright (C) 2019-2025 Sergio Costas (rastersoft@gmail.com)
 * Based on code original (C) Carlos Soriano
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 or later.
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
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

import * as Prefs from './preferences.js';
import * as Constants from './constants.js';
import * as ShowErrorPopup from './show-error-popup.js';
import * as SignalManager from './signal-manager.js';

import Gettext from 'gettext';

const _ = Gettext.domain('ding').gettext;

/* "Find files on desktop" dialog and the incremental type-to-search
 * state (searchString + auto-hide timeout). The dialog window is created
 * on demand; the DesktopManager reference goes through this._dm. */
export var SearchDialog = class {
    constructor(desktopManager) {
        this._dm = desktopManager;
        this.searchString = null;
        this.keypressTimeoutID = null;
        this._findFileWindow = null;
    }

    /* One printable key of the type-to-search sequence. Returns whether
     * the key was consumed (the caller should stop processing then). */
    typeKey(keyval, window) {
        let key = String.fromCharCode(Gdk.keyval_to_unicode(keyval));
        if (this.keypressTimeoutID && this.searchString) {
            this.searchString = this.searchString.concat(key);
        } else {
            this.searchString = key;
        }
        if (this.searchString != '') {
            let found = this.scanForFiles(this.searchString, false);
            if (found) {
                if ((this._dm.getNumberOfSelectedItems() >= 1) && !this.keypressTimeoutID) {
                    let windowError = new ShowErrorPopup.ShowErrorPopup(
                        _('Clear Current Selection before New Search'),
                        null,
                        true);
                    windowError.timeoutClose(2000);
                    return true;
                }
                this._refreshSearchTimeout();
                this.findFiles(window, this.searchString);
            }
        }
        return true;
    }

    /* Escape: clear the selection and any pending search string. */
    escape() {
        this._dm.unselectAll();
        this.searchString = null;
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

    findFiles(window, text) {
        // Re-opening Ctrl+F while a search dialog is already up must close
        // the previous one first: otherwise the old dialog and its signal
        // handlers leak, and the old window's buttons would close the new
        // window (they all operate on this._findFileWindow).
        if (this._findFileWindow) {
            this._closeFindFiles(false);
        }
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
        this._findFileWindow.present();
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
            this._dm.unselectAll();
        }
        this._findFileSignalManager.disconnectAllSignals();
        this._findFileWindow.close();
        this._findFileWindow = null;
    }

    scanForFiles(text, setselected) {
        let found = [];
        if (text && (text != '')) {
            found = this._dm._fileList.filter(f => f.fileName.toLowerCase().includes(text.toLowerCase()) || f._label.get_text().toLowerCase().includes(text.toLowerCase()));
        }
        if (found.length != 0) {
            if (setselected) {
                this._dm.unselectAll();
                found.forEach(f => f.setSelected());
            }
            return true;
        } else {
            return false;
        }
    }

    destroy() {
        if (this.keypressTimeoutID) {
            GLib.source_remove(this.keypressTimeoutID);
            this.keypressTimeoutID = null;
        }
        if (this._findFileWindow) {
            this._closeFindFiles(false);
        }
    }
};
