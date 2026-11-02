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

/* Persistent primary-desktop anchor.
 * --------------------------------------------------------------
 * Screen coordinates are only meaningful against one monitor geometry, so
 * 'icons-only-on-primary' stores a *fraction* of the usable grid area
 * instead: u = (column + 0.5) / columns, v = (row + 0.5) / rows. The value is
 * the centre of an occupied cell, not its index, so a changed column/row
 * count maps proportionally and an unchanged grid returns to the same cell
 * (floor(u * columns) === column, asserted in tests/test-primary-position.js).
 *
 * The projection is never written back: the anchor is the single source of
 * truth and display coordinates are derived from it on every pass. That is
 * what makes the layout survive resolution/scale changes without drifting --
 * re-deriving a coordinate from a coordinate would accumulate error.
 *
 * Values are deliberately NOT clamped: an out-of-range or non-finite anchor
 * is a corrupt record, reported as such, rather than silently moved to a
 * corner where it would collide with a real icon.
 */

/* Format version of the stored anchor. A record with another version is
 * reported as 'unsupported' so a future DING can migrate it knowingly
 * instead of this version reinterpreting (and overwriting) it. */
const PRIMARY_POSITION_VERSION = 1;

/* Read status of a stored anchor:
 *  - 'missing'     no record (absent or empty attribute)
 *  - 'valid'       a usable {u, v} in [0, 1]
 *  - 'invalid'     corrupt, non-object, NaN/Infinity or out of range
 *  - 'unsupported' well-formed record from a newer format version
 * Callers migrate only 'missing'/'invalid' records automatically; an
 * 'unsupported' one is displayed from its legacy coordinates and is left
 * alone until the user explicitly moves the icon. */

function isFraction(value) {
    return (typeof value === 'number') && Number.isFinite(value) &&
        (value >= 0) && (value <= 1);
}

function assertPosition(position, caller) {
    if (!position || (typeof position !== 'object') ||
        !isFraction(position.u) || !isFraction(position.v)) {
        throw new RangeError(`${caller}: a primary position needs finite u and v in [0, 1]`);
    }
}

/**
 * Parses a stored anchor.
 *
 * @param {string|null} text attribute value as read from Gio.FileInfo
 * @returns {{status: string, position: {u: number, v: number}|null}}
 */
export function readPrimaryPosition(text) {
    if (text == null) {
        return { status: 'missing', position: null };
    }
    if (typeof text !== 'string') {
        return { status: 'invalid', position: null };
    }
    if (text.trim() === '') {
        return { status: 'missing', position: null };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        return { status: 'invalid', position: null };
    }
    if (!parsed || (typeof parsed !== 'object') || Array.isArray(parsed)) {
        return { status: 'invalid', position: null };
    }
    if (!Number.isInteger(parsed.version) || (parsed.version < 1)) {
        return { status: 'invalid', position: null };
    }
    if (parsed.version !== PRIMARY_POSITION_VERSION) {
        return { status: 'unsupported', position: null };
    }
    if (!isFraction(parsed.u) || !isFraction(parsed.v)) {
        return { status: 'invalid', position: null };
    }
    return { status: 'valid', position: { u: parsed.u, v: parsed.v } };
}

/**
 * Serializes an anchor for the metadata attribute.
 *
 * @param {{u: number, v: number}} position
 * @returns {string} compact JSON, e.g. {"version":1,"u":0.275,"v":0.35}
 * @throws {RangeError} when the position is not two finite fractions
 */
export function writePrimaryPosition(position) {
    assertPosition(position, 'writePrimaryPosition');
    return JSON.stringify({
        version: PRIMARY_POSITION_VERSION,
        u: position.u,
        v: position.v,
    });
}

/**
 * Anchor for an occupied grid cell: the centre of the cell as a fraction of
 * the grid, so it maps back to the same cell for any grid of the same shape.
 *
 * @returns {{u: number, v: number}}
 * @throws {RangeError} for non-integer or out-of-range cell coordinates
 */
export function positionFromCell(column, row, columns, rows) {
    if (!Number.isInteger(columns) || (columns < 1) ||
        !Number.isInteger(rows) || (rows < 1) ||
        !Number.isInteger(column) || (column < 0) || (column >= columns) ||
        !Number.isInteger(row) || (row < 0) || (row >= rows)) {
        throw new RangeError('positionFromCell: cell must be a valid cell of a columns x rows grid');
    }
    return { u: (column + 0.5) / columns, v: (row + 0.5) / rows };
}

/**
 * Projects an anchor into the container-local pixel space the grid consumes
 * (see DesktopGrid.coordinatesLocalToGlobal()). Rounded to whole pixels: that
 * is the coordinate space the placement code floors into a cell, and rounding
 * cannot cross a cell boundary because the target is a cell centre.
 *
 * @returns {number[]} [localX, localY]
 * @throws {RangeError} for an invalid anchor or a non-positive container size
 */
export function localPointForPosition(position, width, height) {
    assertPosition(position, 'localPointForPosition');
    if (!Number.isFinite(width) || (width <= 0) ||
        !Number.isFinite(height) || (height <= 0)) {
        throw new RangeError('localPointForPosition: the container size must be positive and finite');
    }
    return [Math.round(position.u * width), Math.round(position.v * height)];
}
