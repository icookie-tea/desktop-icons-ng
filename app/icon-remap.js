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

/* Icon-position remapping between two monitor areas.
 *
 * DING stores desktop icon positions as absolute screen coordinates
 * (metadata::nautilus-icon-position). Switching the primary monitor without
 * moving the monitors themselves therefore leaves those coordinates pointing
 * at the old screen: the icons keep their numeric position but visually jump
 * to the edge of the new primary monitor, because the old coordinates fall
 * outside it (see docs/fixes.md).
 *
 * With 'icons-only-on-primary' the desktop is defined by the primary monitor,
 * so a position is only meaningful relative to it. This module maps a position
 * from one monitor area to another while preserving the *fractional* position
 * (0..1 of the usable area), which is the property users perceive as "where
 * the icon is".
 *
 * Why fractional and not cell-based: mapping cell indices between grids of
 * different column counts loses information and changes the perceived layout
 * far more (verified: cell mapping moved icons by up to 5 columns on a real
 * 2560x1440 + 1920x1080 pair, because the two grids have different cell
 * counts). The fractional target is clamped by the ordinary grid placement
 * afterwards, so no clamping is done here.
 *
 * Properties (verified in tests/test-icon-remap.js):
 *  - Idempotent: remapping an already-remapped position within the same target
 *    returns the same position, so a placement pass can be re-run on every
 *    refresh without drifting. This is what lets the result stay unpersisted.
 *  - Reversible: A -> B -> A returns the original position, so switching the
 *    primary monitor back restores the previous layout exactly. This is why
 *    the result is NOT rounded: rounding loses up to one pixel per leg and
 *    makes the round trip inexact for small coordinates. The grid placement
 *    floors to a cell anyway, and the caller rounds before persisting.
 *  - Pure: no GObject state, so it is unit-testable without a compositor.
 */

/**
 * Maps a point from one monitor area to another, preserving the fractional
 * position within the area.
 *
 * Returns fractional coordinates on purpose (see the reversibility note
 * above); callers that write the value to disk must round it first, because
 * the metadata attribute holds integers.
 *
 * @param {number[]} position [x, y] in the `from` area's coordinate space
 * @param {object} from source area: {x, y, width, height}
 * @param {object} to target area: {x, y, width, height}
 * @returns {number[]} [x, y] in the `to` area's coordinate space
 */
export function remapPosition(position, from, to) {
    const [x, y] = position;
    /* A degenerate source area would make the fraction 0/0: fall back to the
     * target origin rather than emitting NaN, which would poison the grid
     * placement (getDistance() would return NaN and the icon would be dropped). */
    const fx = from.width > 0 ? clamp01((x - from.x) / from.width) : 0;
    const fy = from.height > 0 ? clamp01((y - from.y) / from.height) : 0;
    return [to.x + fx * to.width, to.y + fy * to.height];
}

function clamp01(value) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.min(1, Math.max(0, value));
}

/** True when the point lies inside the area (edges inclusive of the origin). */
export function isInside(position, area) {
    const [x, y] = position;
    return (x >= area.x) && (x < area.x + area.width) &&
           (y >= area.y) && (y < area.y + area.height);
}
