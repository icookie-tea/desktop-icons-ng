/* Tests for the icon placement logic that lives on GridLayout:
 * findDesktopFor (exact/nearest/exactOnly), getFallbackPosition and the
 * three-stage addFilesToDesktop / addSingleFileToDesktop routing. Pure
 * logic — grids and the DesktopManager are mocked. */
import { GridLayout } from '../app/grid-layout.js';
import * as Enums from '../app/enums.js';
import { assert, assertEqual, assertDeepEqual, summary } from './harness.js';

/* Mock grid: owns the rectangle (x, y, w, h) and records placements. */
function makeGrid(monitor, x, y, w, h) {
    const placed = [];
    return {
        _monitor: monitor,
        _x: x,
        _y: y,
        placed,
        /* 0 = point inside, >0 = distance outside, -1 = "full"/cannot host */
        getDistance(px, py) {
            if (px >= x && px < x + w && py >= y && py < y + h) {
                return 0;
            }
            const dx = Math.max(x - px, 0, px - (x + w));
            const dy = Math.max(y - py, 0, py - (y + h));
            return Math.hypot(dx, dy);
        },
        addFileItemCloseTo(fileItem, px, py, storeMode) {
            placed.push({ fileItem, x: px, y: py, storeMode });
        },
    };
}

function makeItem(savedCoordinates, dropCoordinates) {
    return {
        savedCoordinates,
        dropCoordinates,
        file: { get_basename: () => `item-${Math.random() * 1e9}` },
    };
}

function makeMockDM({ desktops = [], primaryScreen = null, primaryIndex = 0 } = {}) {
    return {
        _desktops: desktops,
        _primaryScreen: primaryScreen,
        _primaryIndex: primaryIndex,
    };
}

function makeLayout(dm) {
    return new GridLayout(dm);
}

export function runTests() {
    const A = makeGrid(0, 0, 0, 100, 100);
    const B = makeGrid(1, 100, 0, 100, 100);

    // 1. findDesktopFor: exact hit wins regardless of order
    {
        const layout = makeLayout(makeMockDM({ desktops: [A, B] }));
        assertEqual(layout.findDesktopFor(10, 10), A, 'exact hit on A');
        assertEqual(layout.findDesktopFor(150, 10), B, 'exact hit on B');
    }
    // 2. findDesktopFor: exact hit wins over nearer outside candidate
    {
        const near = makeGrid(2, 200, 0, 10, 100);
        const layout = makeLayout(makeMockDM({ desktops: [A, near] }));
        // (95, 50) is outside A by 5px, but inside near? no — 95 < 200.
        // Use a point outside A that is still nearer to A than to near:
        assertEqual(layout.findDesktopFor(95, 50), A, 'exact hit beats outside candidates');
    }
    // 3. findDesktopFor exactOnly: outside point returns null
    {
        const layout = makeLayout(makeMockDM({ desktops: [A, B] }));
        assertEqual(layout.findDesktopFor(50, 150, { exactOnly: true }), null,
            'exactOnly returns null for a point outside every grid');
    }
    // 4. findDesktopFor: first-available vs nearest
    {
        const layout = makeLayout(makeMockDM({ desktops: [A, B] }));
        // (120, 150): distance to A = 50 (below), to B = 50 (below); first-available = A
        assertEqual(layout.findDesktopFor(120, 150), A, 'default picks the first hostable grid');
        // (250, 50): far from A (150), closer to B (50) → nearest = B
        assertEqual(layout.findDesktopFor(250, 50, { nearest: true }), B, 'nearest picks the closest hostable grid');
        assertEqual(layout.findDesktopFor(250, 50), A, 'non-nearest still returns first hostable');
    }
    // 5. findDesktopFor: grid that cannot host (distance -1) is skipped
    {
        const dead = { _monitor: 9, getDistance: () => -1, addFileItemCloseTo() {} };
        const layout = makeLayout(makeMockDM({ desktops: [dead, B] }));
        assertEqual(layout.findDesktopFor(150, 10, { nearest: true }), B,
            'non-hostable grids are skipped even in nearest mode');
        const layout2 = makeLayout(makeMockDM({ desktops: [dead] }));
        assertEqual(layout2.findDesktopFor(10, 10), null, 'no hostable grid → null');
    }

    // 6. getFallbackPosition
    {
        const dm = makeMockDM({ desktops: [A, B], primaryIndex: 0, primaryScreen: null });
        const layout = makeLayout(dm);
        // no primaryScreen → origin
        assertDeepEqual(layout.getFallbackPosition(), [0, 0], 'no primary screen → [0,0]');
        // primaryScreen matching grid A (monitor 0)
        dm._primaryScreen = { monitorIndex: 0, x: 0, y: 0, windowMarginLeft: 3, windowMarginTop: 4 };
        assertDeepEqual(layout.getFallbackPosition(), [0, 0], 'primary grid found → its origin');
        // primaryScreen without a matching grid → margins of the raw area
        dm._primaryScreen = { monitorIndex: 7, x: 500, y: 600, windowMarginLeft: 10, windowMarginTop: 20 };
        assertDeepEqual(layout.getFallbackPosition(), [510, 620], 'no matching grid → area + window margins');
    }

    // 7. addFilesToDesktop: three-stage routing
    {
        const A7 = makeGrid(0, 0, 0, 100, 100);
        const B7 = makeGrid(1, 100, 0, 100, 100);
        const dm = makeMockDM({ desktops: [A7, B7], primaryIndex: 0, primaryScreen: null });
        const layout = makeLayout(dm);
        dm._primaryScreen = { monitorIndex: 0, x: 0, y: 0, windowMarginLeft: 0, windowMarginTop: 0 };

        const inA = makeItem([10, 10], null);
        const outSide = makeItem([50, 150], null);   // outside, nearest = A
        const noCoords = makeItem(null, null);       // → fallback cell (A origin), ASSIGN
        const dropped = makeItem(null, [150, 10]);   // → drop position, OVERWRITE

        layout.addFilesToDesktop([inA, outSide, noCoords, dropped], Enums.StoredCoordinates.PRESERVE);

        assertEqual(A7.placed.length, 3, 'A receives in-grid, out-of-side (nearest) and fallback items');
        assertEqual(B7.placed.length, 1, 'B receives the dropped item');
        assertDeepEqual(A7.placed[0], { fileItem: inA, x: 10, y: 10, storeMode: Enums.StoredCoordinates.PRESERVE },
            'in-grid item placed at its saved coordinates with the given store mode');
        assertEqual(A7.placed[1].fileItem, outSide, 'out-of-desktop item goes to the nearest grid');
        assertEqual(A7.placed[2].fileItem, noCoords, 'coordinate-less item uses the fallback cell');
        assertEqual(A7.placed[2].storeMode, Enums.StoredCoordinates.ASSIGN, 'coordinate-less item is stored (ASSIGN)');
        assertEqual(dropped.dropCoordinates, null, 'drop coordinates are consumed');
        assertDeepEqual(B7.placed[0], { fileItem: dropped, x: 150, y: 10, storeMode: Enums.StoredCoordinates.OVERWRITE },
            'dropped item placed at drop coordinates with OVERWRITE');
    }
    // 8. addFilesToDesktop: saved dropCoordinates on a saved-coordinates item are discarded
    {
        const A8 = makeGrid(0, 0, 0, 100, 100);
        const B8 = makeGrid(1, 100, 0, 100, 100);
        const dm = makeMockDM({ desktops: [A8, B8] });
        const layout = makeLayout(dm);
        const stale = makeItem([10, 10], [150, 150]);
        layout.addFilesToDesktop([stale], Enums.StoredCoordinates.PRESERVE);
        assertEqual(stale.dropCoordinates, null, 'stale drop coordinates are cleared on the saved path');
        assertEqual(A8.placed.length, 1, 'item placed by saved coordinates, not by the stale drop');
    }
    // 9. addFilesToDesktop with no grids is a no-op
    {
        const layout = makeLayout(makeMockDM({ desktops: [] }));
        layout.addFilesToDesktop([makeItem([10, 10], null)], Enums.StoredCoordinates.ASSIGN);
        assert(true, 'empty desktop list does not throw');
    }

    // 10. addSingleFileToDesktop: dropCoordinates beat savedCoordinates
    {
        const A10 = makeGrid(0, 0, 0, 100, 100);
        const B10 = makeGrid(1, 100, 0, 100, 100);
        const dm = makeMockDM({ desktops: [A10, B10] });
        const layout = makeLayout(dm);
        const item = makeItem([10, 10], [150, 10]);
        layout.addSingleFileToDesktop(item);
        assertEqual(B10.placed.length, 1, 'drop intent wins over the stored position');
        assertEqual(item.dropCoordinates, null, 'drop coordinates consumed');
        assertEqual(B10.placed[0].storeMode, Enums.StoredCoordinates.OVERWRITE, 'drop intent stores OVERWRITE');
    }
    // 11. addSingleFileToDesktop: savedCoordinates with exactOnly
    {
        const A11 = makeGrid(0, 0, 0, 100, 100);
        const B11 = makeGrid(1, 100, 0, 100, 100);
        const dm = makeMockDM({ desktops: [A11, B11] });
        const layout = makeLayout(dm);
        const inItem = makeItem([10, 10], null);
        layout.addSingleFileToDesktop(inItem);
        assertEqual(A11.placed.length, 1, 'saved position inside a grid is honoured');
        assertEqual(A11.placed[0].storeMode, Enums.StoredCoordinates.PRESERVE, 'saved position stores PRESERVE');
    }
    // 12. addSingleFileToDesktop: outside saved position falls to the fallback cell
    {
        const C = makeGrid(0, 0, 0, 100, 100);
        const D = makeGrid(1, 100, 0, 100, 100);
        const dm2 = makeMockDM({ desktops: [C, D], primaryIndex: 1, primaryScreen: null });
        const layout2 = makeLayout(dm2);
        const outItem = makeItem([500, 500], null);
        layout2.addSingleFileToDesktop(outItem);
        assertEqual(C.placed.length, 1, 'outside saved position is not honoured (exactOnly)');
        assertEqual(C.placed[0].x, 0, 'no primary screen → fallback [0,0]');
        assertEqual(C.placed[0].y, 0, 'no primary screen → fallback [0,0]');
        assertEqual(C.placed[0].storeMode, Enums.StoredCoordinates.ASSIGN, 'fallback placement stores ASSIGN');
        assertEqual(D.placed.length, 0, 'fallback lands on the grid owning [0,0], not D');
    }

    return summary('GridLayout placement');
}
