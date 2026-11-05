/* Tests for the "desktop is full" path and the primary-only placement mode.
 *
 * Three behaviors are covered, all pure logic against mocked grids:
 *
 * 1. A grid that cannot host icons reports "full" (-1) to findDesktopFor, so
 *    `icons-only-on-primary` makes every non-primary grid a non-candidate.
 * 2. When some grids are full, every other icon must still be placed on a
 *    hostable grid instead of being abandoned.
 * 3. The "could not be placed" notification is throttled, because a full
 *    desktop re-runs placement on every refresh (file events, theme change,
 *    icon-size change) and would otherwise spam the user.
 */
import { GridLayout } from '../app/grid-layout.js';
import * as Enums from '../app/enums.js';
import { assert, assertEqual, assertDeepEqual, summary } from './harness.js';

/* Mock grid with a mutable hostability switch: `_hostable === false` models a
 * full grid, or a secondary grid under `icons-only-on-primary`. The real
 * DesktopGrid reads the same flag in getDistance(). */
function makeGrid(monitor, x, y, w, h, { hostable = true } = {}) {
    const placed = [];
    return {
        _monitor: monitor,
        _x: x,
        _y: y,
        _hostable: hostable,
        placed,
        getDistance(px, py) {
            if (!this._hostable) {
                return -1;
            }
            if (px >= x && px < x + w && py >= y && py < y + h) {
                return 0;
            }
            const dx = Math.max(x - px, 0, px - (x + w));
            const dy = Math.max(y - py, 0, py - (y + h));
            return Math.hypot(dx, dy);
        },
        _width: w,
        _height: h,
        /* Primary-only placement projects an anchor through the container
         * space; this double keeps that mapping linear so the assertion can
         * compute the expected point by hand. */
        coordinatesLocalToGlobal(lx, ly) {
            return [Math.floor(lx + x), Math.floor(ly + y)];
        },
        /* The primary path records an anchor only for cells it really owns;
         * these doubles do not model cells, so nothing is committed. */
        getFileItemPrimaryPosition() {
            return null;
        },
        addFileItemCloseTo(fileItem, px, py, storeMode, options = {}) {
            this.placed.push({ fileItem, x: px, y: py, storeMode, persistLegacy: options.persistLegacy });
            return true;
        },
    };
}

let seq = 0;
/* Mirrors FileItem: the public savedCoordinates accessor is backed by
 * _savedCoordinates. The remap writes the backing field directly (to avoid the
 * metadata-writing setter), so a mock without the backing field would silently
 * hide the remap — and the real setter would persist to disk, which is exactly
 * the bug the split exists to prevent. */
function makeItem(savedCoordinates, dropCoordinates, { anchor = null } = {}) {
    seq += 1;
    const item = {
        _savedCoordinates: savedCoordinates,
        _dropCoordinates: dropCoordinates,
        uri: 'file:///item-' + seq,
        isSpecial: false,
        primaryPosition: anchor,
        primaryPositionStatus: anchor ? 'valid' : 'missing',
        _setterCalls: 0,
        file: { get_basename: () => 'item-' + seq },
    };
    Object.defineProperty(item, 'savedCoordinates', {
        get() { return this._savedCoordinates; },
        set(value) { this._setterCalls += 1; this._savedCoordinates = value; },
    });
    Object.defineProperty(item, 'dropCoordinates', {
        get() { return this._dropCoordinates; },
        set(value) { this._dropCoordinates = value; },
    });
    return item;
}

function makeMockDM({ desktops = [], primaryScreen = null, primaryIndex = 0 } = {}) {
    const notified = [];
    return {
        _desktops: desktops,
        _primaryScreen: primaryScreen,
        _primaryIndex: primaryIndex,
        _primaryGridRemovedIcons: false,
        _lastUnplacedNotify: 0,
        dbusManager: {
            doNotify: (header, text) => notified.push({ header, text }),
        },
        notified,
    };
}

export function runTests() {
    // 1. One grid full: the remaining orphans must still be placed on a
    //    hostable grid rather than abandoned by the loop.
    {
        const full = makeGrid(0, 0, 0, 100, 100, { hostable: false });
        const spare = makeGrid(1, 100, 0, 100, 100);
        const dm = makeMockDM({ desktops: [full, spare] });
        const layout = new GridLayout(dm);
        // Coordinates outside every grid: they all need the "nearest
        // hostable grid" path, and the first grid cannot host anything.
        const items = [makeItem([500, 500], null), makeItem([600, 600], null), makeItem([700, 700], null)];
        layout.addFilesToDesktop(items, Enums.StoredCoordinates.PRESERVE);
        assertEqual(spare.placed.length, 3,
            'a full grid does not strand the remaining orphaned icons');
        assertEqual(full.placed.length, 0, 'the full grid receives nothing');
        assertEqual(layout._unplacedCount, 0, 'nothing is counted as unplaced');
    }

    // 2. Every grid full: nothing is placed, and every icon is counted.
    {
        const a = makeGrid(0, 0, 0, 100, 100, { hostable: false });
        const b = makeGrid(1, 100, 0, 100, 100, { hostable: false });
        const dm = makeMockDM({ desktops: [a, b] });
        const layout = new GridLayout(dm);
        dm._primaryScreen = { monitorIndex: 0, x: 0, y: 0, windowMarginLeft: 0, windowMarginTop: 0 };
        layout.addFilesToDesktop([makeItem([500, 500], null), makeItem(null, null)],
            Enums.StoredCoordinates.PRESERVE);
        assertEqual(a.placed.length + b.placed.length, 0, 'nothing is placed when every grid is full');
        assertEqual(layout._unplacedCount, 2, 'both unplaceable icons are counted');
    }

    // 3. Notification is throttled: the first report notifies, an immediate
    //    second one (same refresh burst) does not.
    {
        const dm = makeMockDM({ desktops: [] });
        const layout = new GridLayout(dm);
        layout._reportUnplaced(3);
        assertEqual(dm.notified.length, 1, 'the first unplaced report notifies the user');
        assertEqual(dm.notified[0].header, 'Desktop is full', 'notification header');
        layout._reportUnplaced(1);
        assertEqual(dm.notified.length, 1, 'a second report within the cooldown stays silent');
    }

    // 4. A zero count never notifies (the common, healthy case).
    {
        const dm = makeMockDM({ desktops: [] });
        const layout = new GridLayout(dm);
        layout._reportUnplaced(0);
        assertEqual(dm.notified.length, 0, 'nothing is reported when everything was placed');
    }

    // 5. primary-only: only the primary grid may host icons; the others
    //    report "full" so findDesktopFor skips them entirely.
    {
        const laptop = makeGrid(0, 0, 0, 100, 100);
        const external = makeGrid(1, 100, 0, 100, 100);
        const dm = makeMockDM({ desktops: [laptop, external] });
        const layout = new GridLayout(dm, () => true);
        layout._primaryOnly = true;
        layout._primaryGrid = laptop;
        layout._applyHostability();
        assertEqual(layout.findDesktopFor(150, 10, { exactOnly: true }), null,
            'primary-only: a saved position on the secondary grid is not honoured');
        assertEqual(layout.findDesktopFor(50, 10, { exactOnly: true }), laptop,
            'primary-only: the primary grid still hosts icons');
        assertEqual(external._hostable, false, 'primary-only: the secondary grid is marked non-hostable');
    }

    // 6. primary-only fallback: with no _primaryScreen (a stale or
    //    out-of-range index) the known primary grid must still anchor new
    //    icons, instead of falling through to grid #0 or the origin.
    {
        const laptop = makeGrid(0, 0, 0, 100, 100);
        const external = makeGrid(1, 100, 0, 100, 100);
        const dm = makeMockDM({ desktops: [laptop, external], primaryIndex: 1 });
        const layout = new GridLayout(dm, () => true);
        layout._primaryOnly = true;
        layout._primaryGrid = external;
        layout._applyHostability();
        assertDeepEqual(layout.getFallbackPosition(), [100, 0],
            'primary-only fallback uses the primary grid origin even without _primaryScreen');
    }

    // 7. primary-only never persists a placement: a repaint, a monitor
    //    removal or a geometry change must not rewrite the stored layout --
    //    that write-back is exactly what used to make the layout drift. The
    //    anchor is committed only by an explicit user action (see
    //    tests/test-primary-layout.js).
    {
        for (const removed of [true, false]) {
            const primary = makeGrid(0, 0, 0, 100, 100);
            const dm = makeMockDM({ desktops: [primary] });
            const layout = new GridLayout(dm, () => true);
            layout._primaryOnly = true;
            layout._primaryGrid = primary;
            layout._applyHostability();
            dm._primaryGridRemovedIcons = removed;
            const item = makeItem([500, 500], null);
            layout.addFilesToDesktop([item], Enums.StoredCoordinates.PRESERVE);
            assertEqual(primary.placed.length, 1, 'the icon is still placed on the primary grid');
            assertEqual(primary.placed[0].storeMode, Enums.StoredCoordinates.PRESERVE,
                'the placement is a projection, never an overwrite');
            assertEqual(primary.placed[0].persistLegacy, false,
                'and the grid is told not to write the legacy coordinate');
            assertDeepEqual(item.savedCoordinates, [500, 500],
                'the stored coordinate is left exactly as it was');
            assertEqual(item._setterCalls, 0, 'the legacy setter is never used');
        }
    }

    // 8. Turning primary-only off must restore the previous behavior: every
    //    grid hosts again.
    {
        const laptop = makeGrid(0, 0, 0, 100, 100);
        const external = makeGrid(1, 100, 0, 100, 100);
        const dm = makeMockDM({ desktops: [laptop, external] });
        const layout = new GridLayout(dm, () => false);
        layout._primaryOnly = false;
        layout._primaryGrid = laptop;
        layout._applyHostability();
        assertEqual(external._hostable, true, 'with the setting off the secondary grid hosts again');
        assertEqual(layout.findDesktopFor(150, 10, { exactOnly: true }), external,
            'with the setting off a saved position on the secondary grid is honoured');
    }

    // 9. Switching the primary monitor does not reinterpret or rewrite the
    //    legacy coordinate any more: the anchor decides the cell, so nothing
    //    accumulates across geometry changes. The old implementation re-mapped
    //    the stored coordinate and persisted it, which drifted a little on
    //    every switch (the icon could not return to its original cell).
    {
        const laptop = makeGrid(0, 0, 0, 2560, 1440);
        const external = makeGrid(1, 2560, 0, 1920, 1080, { hostable: false });
        const dm = makeMockDM({ desktops: [laptop, external] });
        const layout = new GridLayout(dm, () => true);

        dm._primaryScreen = { monitorIndex: 0, x: 0, y: 0, width: 2560, height: 1440 };
        layout._applyHostability();
        assertEqual(layout._primaryGrid, laptop, 'the laptop hosts first');

        dm._primaryScreen = { monitorIndex: 1, x: 2560, y: 0, width: 1920, height: 1080 };
        layout._applyHostability();
        assertEqual(layout._primaryGrid, external, 'after the switch the external display hosts');

        const item = makeItem([640, 432], null, { anchor: { u: 0.25, v: 0.3 } });
        layout.addFilesToDesktop([item], Enums.StoredCoordinates.PRESERVE);
        assertEqual(external.placed.length, 1, 'the icon is placed on the new primary grid');
        /* 0.25 * 1920 = 480 -> 2560 + 480; 0.3 * 1080 = 324 */
        assertEqual(external.placed[0].x, 3040, 'the anchor, not the old coordinate, decides x');
        assertEqual(external.placed[0].y, 324, 'and y');
        assertDeepEqual(item.savedCoordinates, [640, 432],
            'the legacy coordinate is left untouched (no write-back, no drift)');
        assertEqual(layout._coordPrimaryArea, undefined,
            'the previous-primary-area tracking is gone');
    }

    // 10. A primary change with no geometry change must still trigger a
    //     refresh: the grid diff is empty, so without this the hostable grid
    //     and the anchor projection would keep using the previous primary.
    {
        const AREA0 = { x: 0, y: 0, width: 2560, height: 1440, scaleFactor: 1,
            monitorIndex: 0, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
            windowMarginTop: 0, windowMarginBottom: 0, windowMarginLeft: 0, windowMarginRight: 0,
            primaryMonitor: 0 };
        const AREA1 = { ...AREA0, x: 2560, monitorIndex: 1 };
        const refreshed = [];
        const dm = {
            _primaryIndex: 0,
            _primaryScreen: null,
            _desktopList: [AREA0, AREA1],
            _desktops: [],
            _asDesktop: true,
            _primaryGridRemovedIcons: false,
            _updateDesktopSafe: reason => refreshed.push(reason),
            _removeAllFilesFromGrids: () => {},
        };
        const layout = new GridLayout(dm, () => true);
        // Same geometry, only the primary flag moved to the other monitor.
        layout.updateGridWindows([{ ...AREA0, primaryMonitor: 1 }, AREA1]);
        assert(refreshed.some(r => r.includes('primary monitor changed')),
            'a primary change with identical geometry triggers a refresh');
        assertEqual(dm._primaryIndex, 1, 'the new primary index is recorded');
    }

    // 11. An unchanged primary with identical geometry must NOT refresh (the
    //     previous behavior of skipping the redundant repaint is preserved).
    {
        const AREA0 = { x: 0, y: 0, width: 2560, height: 1440, scaleFactor: 1,
            monitorIndex: 0, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
            windowMarginTop: 0, windowMarginBottom: 0, windowMarginLeft: 0, windowMarginRight: 0,
            primaryMonitor: 0 };
        const refreshed = [];
        const dm = {
            _primaryIndex: 0,
            _primaryScreen: null,
            _desktopList: [AREA0],
            _desktops: [],
            _asDesktop: true,
            _primaryGridRemovedIcons: false,
            _updateDesktopSafe: reason => refreshed.push(reason),
            _removeAllFilesFromGrids: () => {},
        };
        const layout = new GridLayout(dm, () => true);
        layout.updateGridWindows([{ ...AREA0 }]);
        assertEqual(refreshed.length, 0, 'an identical geometry update does not force a repaint');
    }

    // A failed legacy placement must not consume the intended drop location.
    // Cover both startup enumeration and incremental file creation.
    for (const incremental of [false, true]) {
        const full = makeGrid(0, 0, 0, 100, 100, { hostable: false });
        const layout = new GridLayout(makeMockDM({ desktops: [full] }), () => false);
        const item = makeItem(null, [50, 50]);
        if (incremental) {
            layout.addSingleFileToDesktop(item);
        } else {
            layout.addFilesToDesktop([item], Enums.StoredCoordinates.PRESERVE);
        }
        assertDeepEqual(item.dropCoordinates, [50, 50], 'legacy full grid preserves pending drop');
        full._hostable = true;
        layout.addSingleFileToDesktop(item);
        assertEqual(item.dropCoordinates, null, 'legacy successful placement consumes pending drop');
        assertEqual(full.placed[0].x, 50, 'legacy retry uses the requested x');
        assertEqual(full.placed[0].y, 50, 'legacy retry uses the requested y');
    }

    return summary('full-desktop');
}
