/* Tests for DesktopGrid cell-occupancy bookkeeping.
 *
 * _occupiedCount is the O(1) "is this grid full?" counter used by
 * getDistance(): when it reaches _maxColumns * _maxRows the grid reports
 * -1 ("full") to GridLayout.findDesktopFor, which then refuses to host
 * icons ("Not enough space to add icons").
 *
 * Regression: freeing a cell used to leave the counter untouched, so every
 * desktop repaint leaked capacity until the grid looked permanently full.
 * These tests call the real method on a prototype-only instance (no GTK
 * widget construction needed). */
import Gdk from 'gi://Gdk';

import { DesktopGrid } from '../app/desktop-grid.js';
import * as Enums from '../app/enums.js';
import { assert, assertDeepEqual, assertEqual, summary } from './harness.js';

const ITEM_A = { uri: 'file:///a' };
const ITEM_B = { uri: 'file:///b' };

function makeGridInstance(maxColumns, maxRows) {
    const grid = Object.create(DesktopGrid.prototype);
    grid._maxColumns = maxColumns;
    grid._maxRows = maxRows;
    grid._occupiedCount = 0;
    grid._gridStatus = {};
    // Coordinates deliberately far outside the rectangle: getDistance()
    // then returns the distance instead of 0 (which means "inside").
    grid.gridGlobalRectangle = new Gdk.Rectangle({ x: 0, y: 0, width: 100, height: 100 });
    grid._x = 0;
    grid._y = 0;
    grid._zoom = 1;
    grid._windowWidth = 100;
    grid._windowHeight = 100;
    return grid;
}


/* ---- persistent primary position ------------------------------------ */

/* Placement-level double: real DesktopGrid methods on a prototype-only
 * instance, with the GTK container and the window translation stubbed so
 * cell math is exercised without a compositor. */
function makePlacementGrid(columns, rows, cellSize = 100) {
    const grid = Object.create(DesktopGrid.prototype);
    grid._monitor = 0;
    grid._x = 0;
    grid._y = 0;
    grid._zoom = 1;
    grid._width = columns * cellSize;
    grid._height = rows * cellSize;
    grid._maxColumns = columns;
    grid._maxRows = rows;
    grid._elementWidth = cellSize;
    grid._elementHeight = cellSize;
    grid._occupiedCount = 0;
    grid._gridStatus = {};
    grid._fileItems = {};
    grid._destroying = false;
    grid._container = { put: () => {} };
    grid.gridGlobalRectangle = new Gdk.Rectangle({ x: 0, y: 0, width: grid._width, height: grid._height });
    grid.coordinatesLocalToGlobal = (x, y) => [Math.floor(x + grid._x), Math.floor(y + grid._y)];
    grid.coordinatesGlobalToLocal = (X, Y) => [Math.floor(X - grid._x), Math.floor(Y - grid._y)];
    return grid;
}

function makePlacementItem(uri, savedCoordinates) {
    const item = {
        uri,
        container: {},
        savedCoordinates,
        setCoordinates() {},
    };
    item.setterCalls = 0;
    Object.defineProperty(item, 'savedCoordinates', {
        get() { return this._savedCoordinates; },
        set(value) { this.setterCalls += 1; this._savedCoordinates = value; },
    });
    item._savedCoordinates = savedCoordinates;
    return item;
}

export function runTests() {
    // 1. A grid is "full" only while every cell is occupied, and freeing a
    //    cell must make it hostable again (the leak made it stay full).
    {
        const grid = makeGridInstance(2, 1);
        grid._setGridUse(0, 0, ITEM_A);
        grid._setGridUse(1, 0, ITEM_B);
        assertEqual(grid.getDistance(-1000, -1000), -1,
            'grid reports full when every cell is occupied');

        grid._setGridUse(0, 0, false);
        assert(grid.getDistance(-1000, -1000) !== -1,
            'freeing one cell makes the grid hostable again');

        grid._setGridUse(1, 0, false);
        assertEqual(grid._occupiedCount, 0,
            'freeing all cells returns occupancy to zero');
        assert(grid.getDistance(-1000, -1000) !== -1,
            'an empty grid is hostable');
    }

    // 2. Bookkeeping is per cell and idempotent: re-occupying a cell counts
    //    once, and freeing an already-free cell does not go negative.
    {
        const grid = makeGridInstance(4, 1);
        grid._setGridUse(0, 0, ITEM_A);
        grid._setGridUse(0, 0, ITEM_B);
        assertEqual(grid._occupiedCount, 1,
            're-occupying the same cell keeps the count at one');

        grid._setGridUse(0, 0, false);
        grid._setGridUse(0, 0, false);
        assertEqual(grid._occupiedCount, 0,
            'freeing an already-free cell does not go negative');
    }

    // 3. Repaint loop: clear + refill must not accumulate occupancy. This is
    //    the sequence _clearAllFilesFromGrids/_placeAllFilesOnGrids runs on
    //    every desktop refresh.
    {
        const grid = makeGridInstance(8, 1);
        const items = ['a', 'b', 'c'].map(uri => ({ uri }));
        const cells = items.map((item, i) => [i, 0]);
        for (let round = 0; round < 5; round++) {
            cells.forEach(([x, y], i) => grid._setGridUse(x, y, items[i]));
            cells.forEach(([x, y]) => grid._setGridUse(x, y, false));
        }
        assertEqual(grid._occupiedCount, 0,
            'five clear/refill rounds leave no leaked occupancy');
        assert(grid.getDistance(-1000, -1000) !== -1,
            'grid is still hostable after repeated repaints');
    }

    // 4. _coordinatesBelongToThisGrid() runs for every icon on every frame;
    //    it must reuse a single probe rectangle instead of allocating a
    //    fresh Gdk.Rectangle per call.
    {
        const seen = [];
        const grid = Object.create(DesktopGrid.prototype);
        grid.gridGlobalRectangle = {
            intersect: rect => {
                seen.push(rect);
                return [true];
            },
        };
        const first = grid._coordinatesBelongToThisGrid(5, 6);
        const second = grid._coordinatesBelongToThisGrid(7, 8);
        assertEqual(seen.length, 2, 'intersect() is called once per probe');
        assert(seen[0] === seen[1], 'the same Gdk.Rectangle instance is reused');
        assertEqual(seen[1].x, 7, 'the reused rectangle is updated in x');
        assertEqual(seen[1].y, 8, 'the reused rectangle is updated in y');
        assertEqual(seen[1].width, 1, 'and keeps the 1x1 probe size');
        assertEqual(seen[1].height, 1, 'in both axes');
        assertEqual(first, true, 'the intersection result is returned');
        assertEqual(second, true, 'also on the second call');
    }


    // 5. A full grid must refuse a placement. It used to fall through to
    //    _addFileItemTo(null, null), which computes localX = 0: the icon was
    //    stacked on cell 0 and _gridStatus[0] was overwritten with the
    //    newcomer, so the real occupant later "freed" a cell it never held.
    {
        const grid = makePlacementGrid(2, 2);
        const occupants = ['a', 'b', 'c', 'd'].map(uri => makePlacementItem(uri, null));
        grid._addFileItemTo(occupants[0], 0, 0, Enums.StoredCoordinates.PRESERVE, false);
        grid._addFileItemTo(occupants[1], 1, 0, Enums.StoredCoordinates.PRESERVE, false);
        grid._addFileItemTo(occupants[2], 0, 1, Enums.StoredCoordinates.PRESERVE, false);
        grid._addFileItemTo(occupants[3], 1, 1, Enums.StoredCoordinates.PRESERVE, false);
        assertEqual(grid._occupiedCount, 4, 'the grid is full before the extra icon');

        const latecomer = makePlacementItem('file:///late', null);
        assertEqual(grid.addFileItemCloseTo(latecomer, 10, 10, Enums.StoredCoordinates.PRESERVE),
            false, 'a full grid refuses the placement');
        assertEqual(grid._fileItems[latecomer.uri], undefined,
            'the refused icon is not registered in the grid');
        assertEqual(grid._gridStatus[0], occupants[0],
            'the real occupant of cell 0 is not overwritten');
        assertEqual(grid.getFileItemPrimaryPosition(latecomer), null,
            'an unplaced icon has no anchor');
    }

    // 6. persistLegacy:false is what the primary-only projection uses: it must
    //    never touch the legacy coordinate setter, not even for an icon that
    //    has no stored coordinate yet (the "assign on first placement" path).
    {
        const grid = makePlacementGrid(2, 1);
        const fresh = makePlacementItem('file:///fresh', null);
        assertEqual(grid._addFileItemTo(fresh, 0, 0, Enums.StoredCoordinates.ASSIGN, false),
            true, 'the placement succeeds');
        assertEqual(fresh.setterCalls, 0, 'persistLegacy:false never writes savedCoordinates');
        assertEqual(fresh.savedCoordinates, null, 'the stored coordinate stays empty');

        const explicit = makePlacementItem('file:///explicit', [5, 5]);
        grid._addFileItemTo(explicit, 1, 0, Enums.StoredCoordinates.OVERWRITE, false);
        assertEqual(explicit.setterCalls, 0,
            'even an OVERWRITE action does not persist when persistLegacy is false');
        assertEqual(JSON.stringify(explicit.savedCoordinates), '[5,5]',
            'the old coordinate is left untouched');
    }

    // 7. The default keeps the historical behaviour (new icon or explicit
    //    overwrite writes the coordinate).
    {
        const grid = makePlacementGrid(2, 1);
        const fresh = makePlacementItem('file:///fresh2', null);
        grid._addFileItemTo(fresh, 0, 0, Enums.StoredCoordinates.ASSIGN);
        assertEqual(fresh.setterCalls, 1, 'a new icon still gets its coordinate stored');
        assertEqual(fresh.savedCoordinates[0], 2, 'stored x is the element origin plus spacing');

        const kept = makePlacementItem('file:///kept', [5, 5]);
        grid._addFileItemTo(kept, 1, 0, Enums.StoredCoordinates.PRESERVE);
        assertEqual(kept.setterCalls, 0, 'PRESERVE does not rewrite an existing coordinate');
    }

    // 8. getFileItemPrimaryPosition derives the anchor from the real cell the
    //    item occupies (not from its padded top-left pixel).
    {
        const grid = makePlacementGrid(4, 2);
        const item = makePlacementItem('file:///anchored', null);
        grid._addFileItemTo(item, 3, 1, Enums.StoredCoordinates.PRESERVE, false);
        assertDeepEqual(grid.getFileItemPrimaryPosition(item), { u: 0.875, v: 0.75 },
            'anchor is the centre of the occupied cell');
        assertEqual(grid.getFileItemPrimaryPosition(makePlacementItem('file:///other', null)), null,
            'an icon outside this grid has no anchor');
    }

    // 9. A destroyed grid refuses placements instead of touching dead widgets.
    {
        const grid = makePlacementGrid(2, 1);
        grid._destroying = true;
        const item = makePlacementItem('file:///zombie', null);
        assertEqual(grid._addFileItemTo(item, 0, 0, Enums.StoredCoordinates.PRESERVE), false,
            'a destroyed grid reports failure');
    }

    return summary('DesktopGrid');
}
