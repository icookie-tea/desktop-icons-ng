/* Tests for SelectionManager: rubber band geometry, selection actions and
 * the selection query helpers. Pure logic — the DesktopManager is mocked,
 * no GTK display backend is needed. */
import { SelectionManager } from '../app/selection-manager.js';
import * as Enums from '../app/enums.js';
import { assert, assertEqual, summary } from './harness.js';

/* Minimal file-item mock with a real axis-aligned box so that
 * checkIntersects() performs a genuine rectangle intersection test. */
function makeItem(x, y, opts = {}) {
    const box = opts.box ?? { x, y, width: 40, height: 40 };
    const item = {
        isSelected: false,
        isKeyboardSelected: false,
        isAllSelectable: opts.isAllSelectable ?? true,
        isSpecial: opts.isSpecial ?? false,
        isDirectory: opts.isDirectory ?? false,
        touchedByRubberband: false,
        uri: opts.uri ?? `file:///desktop/${x}-${y}`,
        file: { get_uri: () => `file:///desktop/${x}-${y}` },
        _coords: [x, y],
        getCoordinates() {
            return this._coords;
        },
        setSelected() {
            this.isSelected = true;
        },
        unsetSelected() {
            this.isSelected = false;
        },
        toggleSelected() {
            this.isSelected = !this.isSelected;
        },
        checkIntersects(rect) {
            return box.x < rect.x + rect.width &&
                box.x + box.width > rect.x &&
                box.y < rect.y + rect.height &&
                box.y + box.height > rect.y;
        },
    };
    return item;
}

function makeMockDM(items) {
    return {
        _fileList: items,
        _desktops: [{ queue_draw() {} }],
    };
}

export function runTests() {
    // 1. constructor wiring and initial state
    const dm = makeMockDM([]);
    const sel = new SelectionManager(dm);
    assert(sel._dm === dm, 'constructor stores desktopManager');
    assertEqual(sel.rubberBand, false, 'rubberBand starts disabled');
    assertEqual(sel._clickCaptured, false, '_clickCaptured starts false');
    sel.clickCaptured();
    assertEqual(sel._clickCaptured, true, 'clickCaptured() sets the flag');

    // 2. top-left / bottom-right icon lookup
    const a = makeItem(10, 10);
    const b = makeItem(5, 20);
    const c = makeItem(50, 50);
    const dmTL = makeMockDM([a, b, c]);
    const selTL = new SelectionManager(dmTL);
    assertEqual(selTL._getTopLeftIcon(), b, 'top-left icon wins on smallest x');
    assertEqual(selTL._getBottomRightIcon(), c, 'bottom-right icon wins on largest x/y');
    const selEmpty = new SelectionManager(makeMockDM([]));
    assertEqual(selEmpty._getTopLeftIcon(), null, 'top-left icon is null on empty list');
    assertEqual(selEmpty._getBottomRightIcon(), null, 'bottom-right icon is null on empty list');

    // 3. selected() actions
    let it1 = makeItem(0, 0);
    let it2 = makeItem(100, 0);
    it1.setSelected();
    const dmSel = makeMockDM([it1, it2]);
    const selSel = new SelectionManager(dmSel);

    // ALONE: it1 already selected → no-op (both states preserved)
    selSel.selected(it1, Enums.Selection.ALONE);
    assertEqual(it1.isSelected, true, 'ALONE on selected item is a no-op');

    // ALONE: selects only the target
    it1.unsetSelected();
    it2.setSelected();
    selSel.selected(it1, Enums.Selection.ALONE);
    assertEqual(it1.isSelected, true, 'ALONE selects the target');
    assertEqual(it2.isSelected, false, 'ALONE deselects the others');

    // WITH_SHIFT toggles
    it1.unsetSelected();
    selSel.selected(it1, Enums.Selection.WITH_SHIFT);
    assertEqual(it1.isSelected, true, 'WITH_SHIFT selects unselected item');
    selSel.selected(it1, Enums.Selection.WITH_SHIFT);
    assertEqual(it1.isSelected, false, 'WITH_SHIFT deselects selected item');

    // ENTER only acts while the rubber band is active
    selSel.selected(it1, Enums.Selection.ENTER);
    assertEqual(it1.isSelected, false, 'ENTER outside rubber band is a no-op');
    selSel._startRubberband(0, 0);
    selSel.selected(it1, Enums.Selection.ENTER);
    assertEqual(it1.isSelected, true, 'ENTER inside rubber band selects');
    assertEqual(selSel.rubberBand, true, '_startRubberband enables the band');
    assertEqual(it2.touchedByRubberband, false, '_startRubberband clears touchedByRubberband');

    // RELEASE always selects only the target
    it1.unsetSelected();
    it2.setSelected();
    selSel.selected(it2, Enums.Selection.RELEASE);
    assertEqual(it2.isSelected, true, 'RELEASE selects the target');
    assertEqual(it1.isSelected, false, 'RELEASE deselects the others');

    // 4. selectAll / unselectAll
    let skippable = makeItem(0, 0, { isAllSelectable: false });
    skippable.setSelected();
    const dmAll = makeMockDM([makeItem(0, 0), skippable]);
    const selAll = new SelectionManager(dmAll);
    selAll.selectAll();
    assertEqual(dmAll._fileList[0].isSelected, true, 'selectAll selects selectable items');
    assertEqual(skippable.isSelected, true, 'selectAll leaves non-selectable items untouched');
    dmAll._fileList[0].isKeyboardSelected = true;
    selAll.unselectAll();
    assertEqual(dmAll._fileList[0].isSelected, false, 'unselectAll clears isSelected');
    assertEqual(dmAll._fileList[0].isKeyboardSelected, false, 'unselectAll clears isKeyboardSelected');

    // 5. selection queries
    let q1 = makeItem(0, 0);
    let q2 = makeItem(100, 0);
    let q3 = makeItem(200, 0);
    q1.setSelected();
    q2.isKeyboardSelected = true;
    const dmQ = makeMockDM([q1, q2, q3]);
    const selQ = new SelectionManager(dmQ);
    const current = selQ.getCurrentSelection(false);
    assertEqual(current.length, 2, 'getCurrentSelection counts mouse+keyboard selection');
    assertEqual(selQ.getCurrentSelection(true).length, 2, 'getCurrentSelection(true) returns uris');
    assertEqual(selQ.getCurrentSelection(true)[0], q1.file.get_uri(), 'getCurrentSelection(true) maps to file uri');
    assertEqual(selQ.getNumberOfSelectedItems(), 2, 'getNumberOfSelectedItems counts both kinds');
    q1.unsetSelected();
    q2.isKeyboardSelected = false;
    assertEqual(selQ.getCurrentSelection(false), null, 'getCurrentSelection is null when nothing selected');
    assertEqual(selQ.getFileItemFromURI('file:///desktop/200-0'), q3, 'getFileItemFromURI finds by uri');
    assertEqual(selQ.getFileItemFromURI('file:///desktop/nope'), null, 'getFileItemFromURI is null on miss');

    // 6. special-file / directory checks
    let sp = makeItem(0, 0, { isSpecial: true });
    let dir = makeItem(100, 0, { isDirectory: true });
    const dmCheck = makeMockDM([sp, dir]);
    const selCheck = new SelectionManager(dmCheck);
    assertEqual(selCheck.checkIfSpecialFilesAreSelected(), false, 'no special file selected initially');
    assertEqual(selCheck.checkIfDirectoryIsSelected(), false, 'no directory selected initially');
    sp.setSelected();
    dir.isKeyboardSelected = true;
    assertEqual(selCheck.checkIfSpecialFilesAreSelected(), true, 'special file detected when selected');
    assertEqual(selCheck.checkIfDirectoryIsSelected(), true, 'directory detected via keyboard selection');
    sp.unsetSelected();
    dir.isKeyboardSelected = false;
    assertEqual(selCheck.checkIfSpecialFilesAreSelected(), false, 'special check back to false after deselect');
    assertEqual(selCheck.checkIfDirectoryIsSelected(), false, 'directory check back to false after deselect');

    // 7. rubber band motion: rectangle math + intersection based selection.
    // inBand's box is (15,15,40,40) = 15..55, outBand's is 200..240.
    let inBand = makeItem(15, 15);
    let outBand = makeItem(200, 200);
    const dmBand = makeMockDM([inBand, outBand]);
    const selBand = new SelectionManager(dmBand);
    selBand._startRubberband(10, 10);
    assertEqual(selBand.onMotion(60, 60), false, 'onMotion returns false (signal contract)');
    assertEqual(selBand.x1, 10, 'onMotion x1 is the min of start/motion x');
    assertEqual(selBand.x2, 60, 'onMotion x2 is the max of start/motion x');
    assertEqual(selBand.y1, 10, 'onMotion y1 is the min of start/motion y');
    assertEqual(selBand.y2, 60, 'onMotion y2 is the max of start/motion y');
    assertEqual(inBand.isSelected, true, 'onMotion selects items inside the band');
    assertEqual(inBand.touchedByRubberband, true, 'onMotion marks touched items');
    assertEqual(outBand.isSelected, false, 'onMotion leaves outside items unselected');
    // shrinking the same band back towards the start: inBand leaves it
    selBand.onMotion(12, 12);
    assertEqual(inBand.isSelected, false, 'onMotion deselects items that left the band');
    // a fresh band over the other item selects it
    selBand._startRubberband(190, 190);
    selBand.onMotion(250, 250);
    assertEqual(outBand.isSelected, true, 'onMotion selects items the band moved onto');

    // 8. release: band reset and rectangle cleared
    selBand.onReleaseMainButton();
    assertEqual(selBand.rubberBand, false, 'onReleaseMainButton ends the band');
    assertEqual(selBand.selectionRectangle, null, 'onReleaseMainButton clears the rectangle');
    assertEqual(selBand._clickCaptured, false, 'onReleaseMainButton resets _clickCaptured');

    // 9. motion without an active band is a no-op
    const dmIdle = makeMockDM([makeItem(0, 0)]);
    const selIdle = new SelectionManager(dmIdle);
    assertEqual(selIdle.onMotion(1, 1), false, 'onMotion without band returns false');
    assertEqual(selIdle.selectionRectangle, null, 'onMotion without band keeps rectangle null');

    return summary('SelectionManager');
}
