/* Regression tests for press-handler coordinate spaces.
 *
 * Contract: _clickX/_clickY are consumed as GLOBAL screen coordinates by
 * doPaste(), doNewFolder() and template creation (they seed
 * metadata::nautilus-drop-position, matched against grid rectangles in
 * global space). Both press handlers must therefore store global coords;
 * only the context-menu popover positioning keeps local coords.
 *
 * Bug (fixed): the right-button gesture passed container-local coords, so
 * on a two-monitor setup right-clicking monitor B (global offset 1920,0)
 * at local (300,200) stored (300,200) — interpreted as global, the pasted
 * copy landed on monitor A's grid at the same relative position.
 */
import { DesktopManager } from '../app/desktop-manager.js';
import { assert, assertEqual, assertDeepEqual, summary } from './harness.js';

/* Monitor B sits at global (1920, 0); a right-click at local (300, 200)
 * inside B's grid window is global (2220, 200). */
const LOCAL_X = 300;
const LOCAL_Y = 200;
const GLOBAL_X = 2220;
const GLOBAL_Y = 200;

function makeStub() {
    const calls = {
        setClickCoordinates: null,
        showDesktopMenu: null,
    };
    const dm = Object.create(DesktopManager.prototype);
    dm._desktopMenu = {
        setClickCoordinates: (x, y) => {
            calls.setClickCoordinates = [x, y];
        },
        showDesktopMenu: (x, y, grid) => {
            calls.showDesktopMenu = [x, y, grid];
        },
    };
    return { dm, calls };
}

export function runTests() {
    // --- right-click: must store GLOBAL coords (bug fix) ---
    {
        const { dm, calls } = makeStub();
        const grid = { fake: 'container' };
        dm.onPressRightButton(null, LOCAL_X, LOCAL_Y, GLOBAL_X, GLOBAL_Y, grid);

        assertEqual(dm._clickX, GLOBAL_X,
            'right-click stores GLOBAL X in _clickX (not local)');
        assertEqual(dm._clickY, GLOBAL_Y,
            'right-click stores GLOBAL Y in _clickY (not local)');
        assertDeepEqual(calls.setClickCoordinates, [GLOBAL_X, GLOBAL_Y],
            'setClickCoordinates receives GLOBAL coords (paste/template position)');
        assertDeepEqual(calls.showDesktopMenu, [LOCAL_X, LOCAL_Y, grid],
            'context menu popover still receives LOCAL coords');
    }

    // --- right-click with fractional coords: floored, still global ---
    {
        const { dm } = makeStub();
        dm.onPressRightButton(null, LOCAL_X, LOCAL_Y, GLOBAL_X + 0.7, GLOBAL_Y + 0.4, {});
        assertEqual(dm._clickX, GLOBAL_X, 'global X floored');
        assertEqual(dm._clickY, GLOBAL_Y, 'global Y floored');
    }

    // --- left-click: stores the (already global) coords it receives ---
    {
        const { dm, calls } = makeStub();
        dm._clickCaptured = false;
        dm._desktopMenu._lastBgMenu = null;
        dm.unselectAll = () => {};
        dm._startRubberband = () => {};
        const controller = { get_current_event_state: () => 0 };
        dm.onPressMainButton(controller, GLOBAL_X, GLOBAL_Y, {});

        assertEqual(dm._clickX, GLOBAL_X, 'left-click stores GLOBAL X');
        assertEqual(dm._clickY, GLOBAL_Y, 'left-click stores GLOBAL Y');
        assertDeepEqual(calls.setClickCoordinates, [GLOBAL_X, GLOBAL_Y],
            'left-click setClickCoordinates receives GLOBAL coords');
    }

    assert(true, 'press-handler coordinate contract checked');
    return summary('click-coordinates');
}
