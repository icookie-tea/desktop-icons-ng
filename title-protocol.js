/* DING: Desktop Icons New Generation for GNOME Shell
 *
 * Copyright (C) 2020 Sergio Costas (rastersoft@gmail.com)
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

/*
 * Pure decoding of the DING window-title protocol used by
 * emulate-x11-window-type.js. Kept dependency-free (no Meta/GTK) so it can
 * be unit-tested with plain gjs.
 *
 * Trusted windows set in the title the characters @!, followed by the
 * coordinates where to put the window separated by a comma, ended in a
 * semicolon, then one or more of these letters:
 *
 *   B : put this window at the bottom of the screen
 *   T : put this window at the top of the screen
 *   D : show this window in all desktops
 *   H : hide this window from window list
 *
 * A single trailing blank space is equivalent to @!H, two trailing blank
 * spaces to @!HTD (lets decorated windows opt in via their title).
 */

export function parseTitle(title) {
    const result = {
        x: null,
        y: null,
        keepAtTop: false,
        showInAllDesktops: false,
        isDesktop: false,
        desktopIndex: null,
    };
    if (title === null) {
        return result;
    }
    if ((title.length > 0) && (title[title.length - 1] == ' ')) {
        if ((title.length > 1) && (title[title.length - 2] == ' ')) {
            title = '@!HTD';
        } else {
            title = '@!H';
        }
    }
    const pos = title.search('@!');
    if (pos != -1) {
        const pos2 = title.search(';', pos);
        let coords;
        if (pos2 != -1) {
            coords = title.substring(pos + 2, pos2).trim().split(',');
        } else {
            coords = title.substring(pos + 2).trim().split(',');
        }
        // parseInt never throws (yields NaN on garbage), so the original
        // try/catch around this was dead weight.
        result.x = parseInt(coords[0]);
        result.y = parseInt(coords[1]);
        // Note: the flag scan covers everything after @! (not just the part
        // before ';'), and H is accepted but not acted on — both match the
        // pre-extraction behavior and are pinned by tests/test-title-protocol.js
        const extraChars = title.substring(pos + 2).trim().toUpperCase();
        for (let char of extraChars) {
            switch (char) {
            case 'T':
                result.keepAtTop = true;
                break;
            case 'D':
                result.showInAllDesktops = true;
                break;
            }
        }
    }
    // This string must match the one at desktop-manager.js
    if (title.startsWith("Desktop Icons ")) {
        result.keepAtTop = false;
        result.isDesktop = true;
        result.desktopIndex = parseInt(title.substring(14).trim());
    }
    return result;
}
