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
import { assert, assertEqual, summary } from './harness.js';

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

    return summary('DesktopGrid');
}
