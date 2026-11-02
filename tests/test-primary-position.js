/* Tests for the persistent primary-desktop position anchor.
 *
 * 'icons-only-on-primary' mode needs icon positions that survive a change of
 * the primary monitor, of the resolution or of the scale factor. Screen
 * coordinates cannot do that on their own: they are only meaningful against
 * one monitor geometry, and re-deriving them from the previous geometry
 * accumulates error. The anchor stored on disk is therefore a *fraction* of
 * the usable grid area:
 *
 *     u = (column + 0.5) / columns      v = (row + 0.5) / rows
 *
 * Two properties matter, both asserted here:
 *  - Cell fidelity: floor(u * columns) === column, so a projection into the
 *    same grid lands in the very same cell (no drift over a round trip).
 *  - Purity: projecting never rewrites the anchor, so any number of refreshes
 *    produce the same layout from the same stored bytes.
 */
import * as Remap from '../app/icon-remap.js';
import { assert, assertDeepEqual, assertEqual, summary } from './harness.js';

const REQUIRED_API = ['readPrimaryPosition', 'writePrimaryPosition',
    'positionFromCell', 'localPointForPosition'];

function throwsRangeError(fn, msg) {
    let threw = false;
    try {
        fn();
    } catch (e) {
        threw = e instanceof RangeError;
    }
    assert(threw, msg);
}

export function runTests() {
    // 0. The whole module contract: a missing function must fail loudly here
    //    instead of throwing a TypeError halfway through the behaviour tests.
    const missing = REQUIRED_API.filter(name => typeof Remap[name] !== 'function');
    for (const name of missing) {
        assert(false, `icon-remap.${name}() is missing`);
    }
    if (missing.length) {
        return summary('primary-position');
    }

    // 1. A cell is stored as its centre, not as its index: mapping by index
    //    would lose information when the column/row count changes.
    {
        const position = Remap.positionFromCell(5, 3, 20, 10);
        assertDeepEqual(position, { u: 0.275, v: 0.35 }, 'cell centre is proportional');
    }

    // 2. Projection into the container-local space the grid consumes.
    {
        const position = Remap.positionFromCell(5, 3, 20, 10);
        assertDeepEqual(Remap.localPointForPosition(position, 2000, 1000), [550, 350],
            'projects into container local coordinates');
    }

    // 3. Metadata round trip.
    {
        const position = Remap.positionFromCell(5, 3, 20, 10);
        assertDeepEqual(Remap.readPrimaryPosition(Remap.writePrimaryPosition(position)),
            { status: 'valid', position }, 'metadata round trip');
        assertEqual(Remap.writePrimaryPosition(position), '{"version":1,"u":0.275,"v":0.35}',
            'stored form is compact JSON with an explicit version');
    }

    // 4. A future format must not be silently reinterpreted.
    {
        assertEqual(Remap.readPrimaryPosition('{"version":2,"u":0.2,"v":0.3}').status,
            'unsupported', 'future format is not silently migrated');
        assertEqual(Remap.readPrimaryPosition('{"u":0.2,"v":0.3}').status, 'invalid',
            'a record without a version is invalid');
        assertEqual(Remap.readPrimaryPosition('{"version":"1","u":0.2,"v":0.3}').status, 'invalid',
            'a non-numeric version is invalid');
    }

    // 5. Missing records: absent or empty attribute value.
    {
        for (const empty of [null, undefined, '', '   ']) {
            assertDeepEqual(Remap.readPrimaryPosition(empty), { status: 'missing', position: null },
                `${JSON.stringify(empty)} is a missing record`);
        }
    }

    // 6. Corrupt / out-of-range records are invalid, never partially applied.
    {
        const invalid = [
            'not json',
            '[]',
            '"0.2,0.3"',
            '{"version":1}',
            '{"version":1,"u":0.2}',
            '{"version":1,"u":0.2,"v":null}',
            '{"version":1,"u":"0.2","v":0.3}',
            '{"version":1,"u":-0.1,"v":0.3}',
            '{"version":1,"u":0.2,"v":1.1}',
            '{"version":1,"u":1e999,"v":0.3}',
        ];
        for (const text of invalid) {
            assertEqual(Remap.readPrimaryPosition(text).status, 'invalid',
                `${text} is invalid`);
        }
        assertEqual(Remap.readPrimaryPosition('{"version":1,"u":0,"v":0}').status, 'valid',
            'the top-left corner is a valid anchor');
        assertEqual(Remap.readPrimaryPosition('{"version":1,"u":1,"v":1}').status, 'valid',
            'the bottom-right fraction is a valid anchor');
    }

    // 7. Cell fidelity: every cell of many grid shapes survives the round trip.
    //    This is the property the whole design rests on (a projection into an
    //    unchanged grid must return to the same cell).
    {
        let mismatches = 0;
        for (const columns of [1, 2, 3, 7, 10, 15, 20, 33]) {
            for (const rows of [1, 2, 3, 7, 10, 21]) {
                for (let column = 0; column < columns; column++) {
                    for (let row = 0; row < rows; row++) {
                        const { u, v } = Remap.positionFromCell(column, row, columns, rows);
                        if (Math.floor(u * columns) !== column || Math.floor(v * rows) !== row) {
                            mismatches += 1;
                        }
                    }
                }
            }
        }
        assertEqual(mismatches, 0, 'every cell maps back to itself');
    }

    // 8. Projection is rounded into an integer container coordinate, and a
    //    cell centre never rounds across a cell boundary (real grids are
    //    dozens of pixels wide, so half a pixel cannot matter).
    {
        for (const columns of [7, 10, 15, 20]) {
            for (let column = 0; column < columns; column++) {
                const { u } = Remap.positionFromCell(column, 0, columns, 1);
                for (const width of [997, 1024, 1920, 2560, 3001]) {
                    const [x] = Remap.localPointForPosition({ u, v: 0.5 }, width, 100);
                    const cellWidth = Math.floor(width / columns);
                    assertEqual(Math.floor(x / cellWidth), Math.min(column, columns - 1),
                        `width ${width} columns ${columns} column ${column} keeps its cell`);
                }
            }
        }
    }

    // 9. Purity: 100 projections through changing grid shapes leave both the
    //    anchor object and its serialized form untouched (the grid may only
    //    round the projection for display, never write it back).
    {
        const position = Remap.positionFromCell(5, 3, 20, 10);
        const stored = Remap.writePrimaryPosition(position);
        for (let i = 0; i < 100; i++) {
            Remap.localPointForPosition(position, i % 2 ? 2000 : 1500, i % 2 ? 1000 : 700);
        }
        assertDeepEqual(position, { u: 0.275, v: 0.35 }, 'the anchor object is not mutated');
        assertEqual(Remap.writePrimaryPosition(position), stored, 'the serialized anchor is stable');
    }

    // 10. Invalid inputs are programming errors, not silently clamped values:
    //    a clamped NaN would place an icon at (0,0) with no diagnostic.
    {
        throwsRangeError(() => Remap.positionFromCell(0, 0, 0, 10), 'zero columns throws');
        throwsRangeError(() => Remap.positionFromCell(0, 0, 10, 0), 'zero rows throws');
        throwsRangeError(() => Remap.positionFromCell(-1, 0, 10, 10), 'negative column throws');
        throwsRangeError(() => Remap.positionFromCell(10, 0, 10, 10), 'column past the last one throws');
        throwsRangeError(() => Remap.positionFromCell(1.5, 0, 10, 10), 'a fractional column throws');
        throwsRangeError(() => Remap.positionFromCell(NaN, 0, 10, 10), 'NaN column throws');
        throwsRangeError(() => Remap.positionFromCell(0, 0, Infinity, 10), 'Infinity columns throws');
        throwsRangeError(() => Remap.localPointForPosition({ u: 0.5, v: 0.5 }, 0, 100),
            'zero width throws');
        throwsRangeError(() => Remap.localPointForPosition({ u: 0.5, v: 0.5 }, 100, NaN),
            'NaN height throws');
        throwsRangeError(() => Remap.localPointForPosition({ u: 2, v: 0.5 }, 100, 100),
            'an out-of-range anchor throws');
        throwsRangeError(() => Remap.localPointForPosition(null, 100, 100),
            'a null anchor throws');
        throwsRangeError(() => Remap.writePrimaryPosition({ u: 0.5 }), 'an anchor without v throws');
        throwsRangeError(() => Remap.writePrimaryPosition({ u: NaN, v: 0.5 }), 'a NaN anchor throws');
        throwsRangeError(() => Remap.writePrimaryPosition({ u: -0.1, v: 0.5 }),
            'a negative anchor throws');
    }

    return summary('primary-position');
}
