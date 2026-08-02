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

'use strict';
const GLib = imports.gi.GLib;

/* Debug logging policy:
 * - Error paths keep using print()/console.log() directly (they always go
 *   to the journal).
 * - Verbose/diagnostic logging must go through debugLog() below, which is
 *   only emitted when the DING_DEBUG environment variable is set. */
var debugEnabled = GLib.getenv('DING_DEBUG') !== null;

function debugLog(...args) {
    if (debugEnabled) {
        print(...args);
    }
}
