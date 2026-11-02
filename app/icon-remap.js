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

/* Primary-desktop position anchors ('icons-only-on-primary').
 *
 * Plain DING stores icon positions as absolute screen coordinates
 * (metadata::nautilus-icon-position). Those are only meaningful against one
 * monitor geometry: changing the primary monitor, the resolution or the scale
 * factor either pushes the stored point outside the new screen (the icon
 * collapses to an edge) or leaves a coordinate that no longer describes the
 * same place. Re-deriving a coordinate from the previous coordinate also
 * accumulates error, so the layout drifts a little on every change.
 *
 * This module implements the store used by primary-only mode instead: a
 * *fraction* of the usable grid area.
 *
 *     u = (column + 0.5) / columns      v = (row + 0.5) / rows
 *
 * The fraction is the centre of the occupied cell, so
 * floor(u * columns) === column for every grid shape (asserted over many
 * shapes in tests/test-primary-position.js). That is what makes a projection
 * into an unchanged grid return to the very same cell instead of drifting,
 * and lets a projection into a different grid land proportionally.
 *
 * Two invariants the rest of the code relies on:
 *  - Pure: nothing here has GObject state, so it is testable without a
 *    compositor, and projecting never mutates the stored anchor.
 *  - Strict: a corrupt record is reported as such ('invalid') and an
 *    out-of-range/non-finite input throws. A NaN silently clamped to the
 *    origin would place an icon in the corner with no diagnostic.
 */

const CELL_CENTRE_OFFSET = 0.5;

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
        throw new RangeError(caller + ': a primary position needs finite u and v in [0, 1]');
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
    return {
        u: (column + CELL_CENTRE_OFFSET) / columns,
        v: (row + CELL_CENTRE_OFFSET) / rows,
    };
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
