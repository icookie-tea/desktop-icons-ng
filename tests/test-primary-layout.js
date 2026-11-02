/* Tests for the persistent primary-desktop anchor storage.
 *
 * 'icons-only-on-primary' keeps a second, coordinate-system independent
 * position per file: metadata::ding-primary-position holds
 * {"version":1,"u":..,"v":..} as a fraction of the usable grid. The rules
 * asserted here are what keep it trustworthy:
 *  - reading is free of side effects (a refresh must never write),
 *  - a save writes the new attribute and the legacy coordinate in ONE
 *    Gio.FileInfo (no intermediate state on disk),
 *  - the legacy setter is never used to write the new attribute (the two
 *    attributes have different meanings and must not be coupled),
 *  - a failed write reports failure and leaves the rendered position alone.
 */
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';

import { FileItem } from '../app/file-item.js';
import { DesktopGrid } from '../app/desktop-grid.js';
import { GridLayout } from '../app/grid-layout.js';
import * as Enums from '../app/enums.js';
import * as IconRemap from '../app/icon-remap.js';
import { assert, assertDeepEqual, assertEqual, summary } from './harness.js';

const PRIMARY = Enums.PRIMARY_POSITION_ATTRIBUTE;
const LEGACY = Enums.LEGACY_POSITION_ATTRIBUTE;

function makeFileInfo(attributes = {}) {
    const info = new Gio.FileInfo();
    for (const [name, value] of Object.entries(attributes)) {
        info.set_attribute_string(name, value);
    }
    return info;
}

/* Prototype-only FileItem: no Gtk widget, no desktop enumeration. The file
 * double records what a save would put on disk, read back from the real
 * Gio.FileInfo so the assertion covers the actual serialized bytes. */
function makeItem(fileInfo, { writeThrows = false, uri = 'file:///home/u/Desktop/a.txt' } = {}) {
    const item = Object.create(FileItem.prototype);
    item._destroyed = false;
    item._writes = [];
    item._file = {
        get_uri: () => uri,
        set_attributes_from_info: info => {
            if (writeThrows) {
                throw new Error('metadata backend unavailable');
            }
            item._writes.push({
                primary: info.get_attribute_as_string(PRIMARY),
                legacy: info.get_attribute_as_string(LEGACY),
            });
        },
    };
    item._primaryPosition = null;
    item._primaryPositionStatus = 'missing';
    /* Same read the real constructor does, so a rebuild is faithful. */
    item._savedCoordinates = item._readCoordinatesFromAttribute(fileInfo, LEGACY);
    item._setterCalls = 0;
    Object.defineProperty(item, 'savedCoordinates', {
        configurable: true,
        get() { return this._savedCoordinates; },
        set(value) { this._setterCalls += 1; this._savedCoordinates = value; },
    });
    item.reloadPrimaryPosition(fileInfo);
    return item;
}


/* ---- placement doubles ---------------------------------------------- */

/* Real DesktopGrid placement code (cell search included) on a prototype-only
 * instance: the GTK container and the two preference reads are stubbed, so the
 * projection math runs without a compositor or a GSettings schema. */
function makePlacementGrid(columns, rows, { x = 0, y = 0, cell = 100 } = {}) {
    const grid = Object.create(DesktopGrid.prototype);
    grid._monitor = 0;
    grid._x = x;
    grid._y = y;
    grid._zoom = 1;
    grid._width = columns * cell;
    grid._height = rows * cell;
    grid._maxColumns = columns;
    grid._maxRows = rows;
    grid._elementWidth = cell;
    grid._elementHeight = cell;
    grid._occupiedCount = 0;
    grid._gridStatus = {};
    grid._fileItems = {};
    grid._destroying = false;
    grid._container = { put: () => {} };
    grid.gridGlobalRectangle = new Gdk.Rectangle({ x, y, width: grid._width, height: grid._height });
    grid.coordinatesLocalToGlobal = (px, py) => [Math.floor(px + x), Math.floor(py + y)];
    grid.coordinatesGlobalToLocal = (X, Y) => [Math.floor(X - x), Math.floor(Y - y)];
    grid._startCorner = () => [false, false];
    grid._addVolumesOpposite = () => false;
    /* Same initial state setGridStatus() builds: every cell explicitly free.
     * Without it every cell reads as occupied and nothing is ever placed. */
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
            grid._setGridUse(column, row, false);
        }
    }
    return grid;
}

/* FileItem double. savedCoordinates / dropCoordinates are accessors over the
 * backing fields exactly like the real item, so a test can prove that the
 * placement path bypasses the metadata-writing setters. */
function makePlacementItem(uri, { saved = null, anchor = null, status = null, special = false, drop = null } = {}) {
    const item = {
        uri,
        isSpecial: special,
        container: {},
        primaryPosition: anchor,
        primaryPositionStatus: status ?? (anchor ? 'valid' : 'missing'),
        _savedCoordinates: saved == null ? null : [...saved],
        _dropCoordinates: drop == null ? null : [...drop],
        _saves: [],
        _saveFails: false,
        _setterCalls: 0,
        _dropSetterCalls: 0,
        setCoordinates() {},
        getCoordinates() {
            return [100, 100, 150, 150];
        },
        savePrimaryPosition(position, legacyCoordinates) {
            item._saves.push({ position, legacy: legacyCoordinates });
            if (item._saveFails) {
                return false;
            }
            if (position == null) {
                item.primaryPosition = null;
                item.primaryPositionStatus = 'missing';
            } else {
                item.primaryPosition = { u: position.u, v: position.v };
                item.primaryPositionStatus = 'valid';
            }
            item._savedCoordinates = legacyCoordinates == null ? null : [...legacyCoordinates];
            return true;
        },
    };
    Object.defineProperty(item, 'savedCoordinates', {
        get() { return this._savedCoordinates; },
        set(value) { this._setterCalls += 1; this._savedCoordinates = value; },
    });
    Object.defineProperty(item, 'dropCoordinates', {
        get() { return this._dropCoordinates; },
        set(value) { this._dropSetterCalls += 1; this._dropCoordinates = value; },
    });
    return item;
}

function makePlacementDM(desktops, { primaryIndex = 0 } = {}) {
    return {
        _desktops: desktops,
        _primaryScreen: null,
        _primaryIndex: primaryIndex,
        _primaryGridRemovedIcons: false,
        _lastUnplacedNotify: 0,
        sortSpecialFolders: true,
        dbusManager: { doNotify: () => {} },
    };
}

function makePrimaryLayout(grid, desktops = [grid]) {
    const dm = makePlacementDM(desktops);
    const layout = new GridLayout(dm, () => true);
    layout._primaryGrid = grid;
    layout._applyHostability();
    return { dm, layout };
}

/* uri -> cell map with a stable key order, so two runs can be compared with
 * assertDeepEqual (which compares serialized JSON). */
function cellsOf(grid, items) {
    const map = {};
    for (const item of [...items].sort((a, b) => (a.uri < b.uri ? -1 : (a.uri > b.uri ? 1 : 0)))) {
        const entry = grid._fileItems[item.uri];
        map[item.uri] = entry ? entry.slice(0, 2) : null;
    }
    return map;
}

export function runTests() {
    // 0. API contract: the attribute names must exist, or every later
    //    assertion would silently compare undefined values.
    assertEqual(PRIMARY, 'metadata::ding-primary-position', 'the new attribute is namespaced and versioned');
    assertEqual(LEGACY, 'metadata::nautilus-icon-position', 'the legacy attribute keeps its name');

    // 1. A valid record is read into the two accessors.
    {
        const item = makeItem(makeFileInfo({ [PRIMARY]: '{"version":1,"u":0.275,"v":0.35}' }));
        assertEqual(item.primaryPositionStatus, 'valid', 'the record is valid');
        assertDeepEqual(item.primaryPosition, { u: 0.275, v: 0.35 }, 'the anchor is exposed');
    }

    // 2. Every unusable record is reported with its own status, so the
    //    migration code can tell "never had one" from "do not touch this".
    {
        const cases = [
            [{}, 'missing', 'no attribute at all'],
            [{ [PRIMARY]: '' }, 'missing', 'an empty attribute'],
            [{ [PRIMARY]: 'garbage' }, 'invalid', 'corrupt JSON'],
            [{ [PRIMARY]: '{"version":1,"u":2,"v":0.3}' }, 'invalid', 'out-of-range anchor'],
            [{ [PRIMARY]: '{"version":9,"u":0.1,"v":0.1}' }, 'unsupported', 'a newer format'],
        ];
        for (const [attributes, status, why] of cases) {
            const item = makeItem(makeFileInfo(attributes));
            assertEqual(item.primaryPositionStatus, status, `${why} is ${status}`);
            assertEqual(item.primaryPosition, null, `${why} exposes no anchor`);
        }
    }

    // 3. Reading is side-effect free: it runs on every metadata refresh.
    {
        const item = makeItem(makeFileInfo({ [PRIMARY]: '{"version":1,"u":0.5,"v":0.5}' }));
        assertEqual(item._writes.length, 0, 'reading a record never writes');
        item.reloadPrimaryPosition(makeFileInfo({ [PRIMARY]: 'garbage' }));
        assertEqual(item._writes.length, 0, 'even a corrupt record is not "repaired" by reading');
        assertEqual(item.primaryPositionStatus, 'invalid', 'the status follows the last read');
    }

    // 4. One save, one FileInfo: the anchor and the legacy coordinate land
    //    together, so a crash between two writes cannot leave them disagreeing.
    {
        const item = makeItem(makeFileInfo({}));
        const ok = item.savePrimaryPosition({ u: 0.25, v: 0.5 }, [640, 720]);
        assertEqual(ok, true, 'the save reports success');
        assertEqual(item._writes.length, 1, 'exactly one attribute write is issued');
        assertEqual(item._writes[0].primary, '{"version":1,"u":0.25,"v":0.5}',
            'the anchor is stored in the versioned format');
        assertEqual(item._writes[0].legacy, '640,720', 'the legacy coordinate is mirrored');
        assertDeepEqual(item.primaryPosition, { u: 0.25, v: 0.5 }, 'the in-memory anchor follows');
        assertEqual(item.primaryPositionStatus, 'valid', 'and its status becomes valid');
        assertDeepEqual(item.savedCoordinates, [640, 720], 'the legacy mirror follows');
    }

    // 5. The new attribute is never written through the legacy setter (that
    //    would create a second, silent writer with different semantics).
    {
        const item = makeItem(makeFileInfo({}));
        item.savePrimaryPosition({ u: 0.1, v: 0.2 }, null);
        assertEqual(item._setterCalls, 0, 'savePrimaryPosition does not use the savedCoordinates setter');
        assertEqual(item._writes[0].legacy, '', 'a null legacy coordinate clears the attribute');
    }

    // 6. Clearing the anchor is explicit and keeps the status honest.
    {
        const item = makeItem(makeFileInfo({ [PRIMARY]: '{"version":1,"u":0.5,"v":0.5}' }));
        assertEqual(item.savePrimaryPosition(null, null), true, 'clearing reports success');
        assertEqual(item._writes[0].primary, '', 'the anchor attribute is cleared');
        assertEqual(item.primaryPosition, null, 'no anchor is exposed after clearing');
        assertEqual(item.primaryPositionStatus, 'missing', 'the status returns to missing');
    }

    // 7. A failing metadata backend reports false and must not make the icon
    //    disappear: the rendered/legacy state stays as it was.
    {
        const item = makeItem(makeFileInfo({}), { writeThrows: true });
        item._savedCoordinates = [10, 20];
        const ok = item.savePrimaryPosition({ u: 0.5, v: 0.5 }, [30, 40]);
        assertEqual(ok, false, 'a throwing write is reported as failure');
        assertEqual(item.primaryPosition, null, 'the in-memory anchor is not updated on failure');
        assertDeepEqual(item.savedCoordinates, [10, 20], 'the legacy coordinate is unchanged on failure');
    }

    // 8. Rebuilding the FileItem from the same metadata restores the anchor
    //    (the refresh path destroys and recreates items).
    {
        const first = makeItem(makeFileInfo({}));
        first.savePrimaryPosition({ u: 0.75, v: 0.125 }, [111, 222]);
        const stored = first._writes[0];
        const rebuilt = makeItem(makeFileInfo({ [PRIMARY]: stored.primary, [LEGACY]: stored.legacy }));
        assertDeepEqual(rebuilt.primaryPosition, { u: 0.75, v: 0.125 },
            'a rebuilt item reads the same anchor back');
        assertDeepEqual(rebuilt.savedCoordinates, [111, 222], 'and the same legacy coordinate');
    }

    // 9. Invalid input to the save API is a programming error: silently
    //    storing a NaN anchor would place the icon at the corner forever.
    {
        const item = makeItem(makeFileInfo({}));
        let threw = false;
        try {
            item.savePrimaryPosition({ u: NaN, v: 0.5 }, [1, 2]);
        } catch (e) {
            threw = e instanceof RangeError;
        }
        assert(threw, 'a NaN anchor is rejected with a RangeError');
        assertEqual(item._writes.length, 0, 'and nothing is written');
    }


    // ---- placement, migration and persistence intent -------------------

    // 10. A stored anchor decides the cell on an unchanged grid.
    {
        const grid = makePlacementGrid(20, 10);
        const { layout } = makePrimaryLayout(grid);
        const anchor = IconRemap.positionFromCell(5, 3, 20, 10);
        const item = makePlacementItem('file:///a', { anchor });
        const placed = layout.addFilesToDesktop([item], Enums.StoredCoordinates.PRESERVE);
        assertEqual(placed.length, 1, 'an anchored icon is placed');
        assertDeepEqual(cellsOf(grid, [item])['file:///a'], [5, 3],
            'the icon lands in the cell its anchor was made from');
        assertDeepEqual(item.savedCoordinates, null, 'the legacy coordinate is not written');
        assertEqual(item._setterCalls, 0, 'the legacy setter is never used by a projection');
        assertEqual(item._saves.length, 0, 'and the anchor is not rewritten by a repaint');
    }

    // 11. The regression this whole design exists for: shrink the grid, then
    //     restore it, and the layout must come back exactly -- the old code
    //     re-derived a coordinate from a coordinate, so it drifted.
    {
        const big = makePlacementGrid(20, 10);
        const small = makePlacementGrid(15, 7);
        /* A real geometry change recreates the grids (setGridStatus resets
         * occupancy), so the restored pass must run on a fresh grid of the
         * same shape -- reusing the first one would keep its cells occupied. */
        const bigAgain = makePlacementGrid(20, 10);
        const items = [[0, 0], [5, 3], [19, 9]].map(([column, row], index) => makePlacementItem(
            'file:///drift-' + index, { anchor: IconRemap.positionFromCell(column, row, 20, 10) }));
        const stored = items.map(item => IconRemap.writePrimaryPosition(item.primaryPosition));

        const first = makePrimaryLayout(big).layout;
        first.addFilesToDesktop(items, Enums.StoredCoordinates.PRESERVE);
        const originalCells = cellsOf(big, items);

        const second = makePrimaryLayout(small).layout;
        second.addFilesToDesktop(items, Enums.StoredCoordinates.PRESERVE);
        assertEqual(items[2]._saves.length, 0, 'shrinking the grid writes nothing');

        const third = makePrimaryLayout(bigAgain).layout;
        third.addFilesToDesktop(items, Enums.StoredCoordinates.PRESERVE);
        assertDeepEqual(cellsOf(bigAgain, items), originalCells,
            'restoring the grid restores every cell exactly');
        assertDeepEqual(items.map(item => IconRemap.writePrimaryPosition(item.primaryPosition)), stored,
            'and every stored anchor is byte-identical');
    }

    // 11b. A primary monitor with a negative origin (placed left of / above
    //      the laptop) must project into the right cell: the anchor is
    //      relative to the grid, so the offset cancels out.
    {
        const grid = makePlacementGrid(8, 4, { x: -2560, y: -200 });
        const { layout } = makePrimaryLayout(grid);
        const item = makePlacementItem('file:///left', { anchor: IconRemap.positionFromCell(6, 3, 8, 4) });
        layout.addFilesToDesktop([item], Enums.StoredCoordinates.PRESERVE);
        assertDeepEqual(cellsOf(grid, [item])['file:///left'], [6, 3],
            'a negative monitor origin still projects to the stored cell');
        assertEqual(item._saves.length, 0, 'and writes nothing');
    }

    // 12. Determinism: the layout must not depend on enumeration order. Two
    //     colliding anchors make the nearest-free-cell search decide, which is
    //     exactly where order would leak into the result.
    {
        const anchors = [
            ['file:///b', 2, 1],
            ['file:///a', 2, 1],
            ['file:///c', 0, 0],
        ];
        const build = order => {
            const grid = makePlacementGrid(4, 3);
            const items = order.map(([uri, column, row]) => makePlacementItem(uri,
                { anchor: IconRemap.positionFromCell(column, row, 4, 3) }));
            makePrimaryLayout(grid).layout.addFilesToDesktop(items, Enums.StoredCoordinates.PRESERVE);
            return cellsOf(grid, items);
        };
        const forward = build(anchors);
        const backward = build([...anchors].reverse());
        assertDeepEqual(backward, forward, 'the same inputs produce the same layout in any order');
    }

    // 13. Migration touches only what it must: missing/invalid records are
    //     initialised from the cell the icon actually got, 'unsupported' and
    //     valid records are left alone.
    {
        const grid = makePlacementGrid(10, 5);
        const { layout } = makePrimaryLayout(grid);
        const missing = makePlacementItem('file:///m', { saved: [300, 200] });
        const corrupt = makePlacementItem('file:///c', { status: 'invalid' });
        const future = makePlacementItem('file:///f', { status: 'unsupported', saved: [50, 50] });
        const valid = makePlacementItem('file:///v', { anchor: IconRemap.positionFromCell(2, 2, 10, 5) });

        layout.addFilesToDesktop([missing, corrupt, future, valid], Enums.StoredCoordinates.PRESERVE);

        assertEqual(missing._saves.length, 1, 'a missing record is initialised once');
        assertDeepEqual(cellsOf(grid, [missing])['file:///m'], [3, 2],
            'the legacy coordinate decides the first cell');
        assertDeepEqual(missing.primaryPosition, IconRemap.positionFromCell(3, 2, 10, 5),
            'and the anchor records the cell actually used');
        assertEqual(corrupt._saves.length, 1, 'a corrupt record is replaced');
        assertEqual(future._saves.length, 0, 'an unsupported record is never rewritten automatically');
        assertEqual(valid._saves.length, 0, 'a valid anchor is never rewritten by a repaint');
    }

    // 14. A failed migration is remembered for that item, so a read-only
    //     backend is not rewritten on every refresh; a rebuilt item retries.
    {
        const grid = makePlacementGrid(4, 2);
        const { layout } = makePrimaryLayout(grid);
        const item = makePlacementItem('file:///ro', { status: 'invalid' });
        item._saveFails = true;
        layout.addFilesToDesktop([item], Enums.StoredCoordinates.PRESERVE);
        layout.addFilesToDesktop([item], Enums.StoredCoordinates.PRESERVE);
        assertEqual(item._saves.length, 1, 'the failed migration is attempted only once');
        assertEqual(item.primaryPositionStatus, 'invalid', 'and the record stays as it was');

        const rebuilt = makePlacementItem('file:///ro', { status: 'invalid' });
        makePrimaryLayout(grid).layout.addFilesToDesktop([rebuilt], Enums.StoredCoordinates.PRESERVE);
        assertEqual(rebuilt._saves.length, 1, 'a new FileItem instance tries again');
    }

    // 15. An explicit drop wins over the anchor the file carried, and replaces
    //     it: a copied file may bring a position from its old location.
    {
        const grid = makePlacementGrid(10, 5);
        const { layout } = makePrimaryLayout(grid);
        const item = makePlacementItem('file:///copy', {
            anchor: IconRemap.positionFromCell(0, 0, 10, 5),
            drop: [950, 450],
        });
        layout.addFilesToDesktop([item], Enums.StoredCoordinates.PRESERVE);
        assertDeepEqual(cellsOf(grid, [item])['file:///copy'], [9, 4],
            'the drop position decides the cell');
        assertEqual(item._saves.length, 1, 'and the carried anchor is replaced');
        assertDeepEqual(item.primaryPosition, IconRemap.positionFromCell(9, 4, 10, 5),
            'the new anchor records the drop cell');
        assertEqual(item.dropCoordinates, null, 'the drop coordinate is consumed');
        assertEqual(item._dropSetterCalls, 0, 'without a metadata write');
    }

    // 16. A sorted layout is a compact fill in the caller's order and writes
    //     nothing (an automatic sort must not become a manual layout).
    {
        const grid = makePlacementGrid(4, 2);
        const { layout } = makePrimaryLayout(grid);
        const items = ['file:///z', 'file:///a', 'file:///m'].map(uri => makePlacementItem(uri,
            { anchor: IconRemap.positionFromCell(3, 1, 4, 2) }));
        const placed = layout.addFilesToDesktop(items, Enums.StoredCoordinates.ASSIGN);
        assertEqual(placed.length, 3, 'every icon is placed');
        /* Column-major from the top-left corner: the caller's order decides
         * which icon gets which cell (keys in cellsOf() order). */
        assertDeepEqual(cellsOf(grid, items), {
            'file:///a': [0, 1], 'file:///m': [1, 0], 'file:///z': [0, 0],
        }, 'the sort order fills the corner cells in order');
        assertEqual(items[0]._saves.length + items[1]._saves.length + items[2]._saves.length, 0,
            'an automatic sort writes no anchors');
    }

    // 17. A full grid refuses the extra icon: it is counted, keeps its anchor
    //     and is never given a cell it did not get.
    {
        const grid = makePlacementGrid(1, 1);
        const { layout } = makePrimaryLayout(grid);
        const first = makePlacementItem('file:///one', { anchor: IconRemap.positionFromCell(0, 0, 1, 1) });
        const second = makePlacementItem('file:///two', { anchor: IconRemap.positionFromCell(0, 0, 1, 1) });
        const placed = layout.addFilesToDesktop([first, second], Enums.StoredCoordinates.PRESERVE);
        assertEqual(placed.length, 1, 'only one icon fits');
        assertEqual(layout._unplacedCount, 1, 'the other one is counted as unplaced');
        assertEqual(cellsOf(grid, [second])['file:///two'], null, 'it has no cell');
        assertEqual(second._saves.length, 0, 'and no anchor is recorded for it');
        assertDeepEqual(second.primaryPosition, IconRemap.positionFromCell(0, 0, 1, 1),
            'its stored anchor survives untouched');
    }

    // 18. addSingleFileToDesktop: a new icon without a drop only gets a missing
    //     anchor filled in; an explicit drop always records its cell.
    {
        const grid = makePlacementGrid(4, 2);
        const { layout } = makePrimaryLayout(grid);
        const fresh = makePlacementItem('file:///fresh');
        assertEqual(layout.addSingleFileToDesktop(fresh), fresh, 'the item is returned when placed');
        assertEqual(fresh._saves.length, 1, 'its first placement initialises the anchor');
        assertDeepEqual(fresh.primaryPosition, IconRemap.positionFromCell(0, 0, 4, 2),
            'the fallback cell is recorded');

        const dropped = makePlacementItem('file:///dropped', {
            anchor: IconRemap.positionFromCell(0, 0, 4, 2), drop: [350, 150],
        });
        layout.addSingleFileToDesktop(dropped);
        assertDeepEqual(dropped.primaryPosition, IconRemap.positionFromCell(3, 1, 4, 2),
            'an explicit drop replaces an existing anchor');
    }

    return summary('primary-layout');
}
