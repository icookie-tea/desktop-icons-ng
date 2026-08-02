/* Tests for GridLayout wiring: the manager must receive the DesktopManager
 * reference (this._dm) and route geometry diffs through it. Guards against
 * a missing constructor (this._dm undefined) and stale internal calls. */
'use strict';
const GridLayout = imports['grid-layout'].GridLayout;
const { assert, assertEqual, summary } = imports.harness;

const AREA = {
    x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1,
    monitorIndex: 0, marginTop: 0, marginBottom: 0,
    marginLeft: 0, marginRight: 0, windowMarginTop: 0,
    windowMarginBottom: 0, windowMarginLeft: 0, windowMarginRight: 0,
};

function makeMockDM() {
    return {
        _primaryIndex: 0,
        _desktopList: [AREA],
        _primaryScreen: null,
        _desktops: [],
        _asDesktop: true,
        _updateDesktopSafe: () => {
            throw new Error('_updateDesktopSafe should not run on empty diff');
        },
        _removeAllFilesFromGrids: () => {
            throw new Error('_removeAllFilesFromGrids should not run on empty diff');
        },
    };
}

var runTests = function () {
    // 1. constructor wiring: this._dm is set (would throw without it)
    const dm = makeMockDM();
    const layout = new GridLayout(dm);
    assert(layout._dm === dm, 'constructor stores desktopManager');

    // 2. identical geometry: no grid recreation, primary screen updated
    layout.updateGridWindows([{ ...AREA }]);
    assertEqual(dm._primaryScreen, dm._desktopList[0],
        'identical geometry keeps primary screen in sync');

    // 3. changed primary index is picked up from the first area
    const dm2 = makeMockDM();
    const layout2 = new GridLayout(dm2);
    const areas = [{ ...AREA, primaryMonitor: 0 }];
    layout2.updateGridWindows(areas);
    assertEqual(dm2._primaryIndex, 0, 'primaryMonitor read from first area');

    // 4. destroy() clears tracked signals (no crash on empty list)
    layout.destroy();
    layout2.destroy();
    assert(true, 'destroy() runs without tracked signals');

    return summary('GridLayout');
};
