/* DING: Desktop Icons New Generation for GNOME Shell
 *
 * Copyright (C) 2024 Sergio Costas (rastersoft@gmail.com)
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

'use strict';
const GLib = imports.gi.GLib;

var FileChangesQueue = class {
    constructor(debounceMs = 200, maxIncremental = 2) {
        this._debounceMs = debounceMs;
        this._maxIncremental = maxIncremental;
        this._pending = [];
        this._timerId = 0;
        this._handler = null;
    }

    get maxIncremental() {
        return this._maxIncremental;
    }

    push(event) {
        this._pending.push(event);
        if (this._pending.length >= this._maxIncremental) {
            this._flush();
        } else {
            this._scheduleFlush();
        }
    }

    _scheduleFlush() {
        if (this._timerId) {
            return;
        }
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._debounceMs, () => {
            this._flush();
            return GLib.SOURCE_REMOVE;
        });
    }

    _flush() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        if (this._pending.length === 0) {
            return;
        }
        const events = this._pending.splice(0);
        if (this._handler) {
            try {
                this._handler(events);
            } catch (e) {
                print(`Error in file changes handler: ${e.message}\n${e.stack}`);
            }
        }
    }

    onFlush(handler) {
        this._handler = handler;
    }

    destroy() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        this._pending = [];
        this._handler = null;
    }
};
