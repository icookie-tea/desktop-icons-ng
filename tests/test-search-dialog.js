/* Tests for SearchDialog pure logic: type-to-search string accumulation,
 * the filename/label scan and the escape path. The Adw.Dialog window is
 * never created here (findFiles is stubbed), so no display backend is
 * needed. */
import { SearchDialog } from '../app/search-dialog.js';
import * as Constants from '../app/constants.js';
import { assert, assertEqual, summary, flushLoop } from './harness.js';

function makeItem(fileName, labelText) {
    return {
        fileName,
        isSelected: false,
        setSelected() {
            this.isSelected = true;
        },
        _label: { get_text: () => labelText ?? fileName },
    };
}

function makeMockDM(items) {
    const calls = { unselectAll: 0 };
    return {
        _fileList: items,
        calls,
        unselectAll() {
            calls.unselectAll++;
        },
        getNumberOfSelectedItems: () => 0,
    };
}

export async function runTests() {
    // 1. constructor wiring and initial state
    const dm = makeMockDM([]);
    const sd = new SearchDialog(dm);
    assert(sd._dm === dm, 'constructor stores desktopManager');
    assertEqual(sd.searchString, null, 'searchString starts null');
    assertEqual(sd._findFileWindow, null, 'dialog window starts closed');

    // 2. scanForFiles: case-insensitive match on fileName and label text
    const items = [
        makeItem('Report.PDF', 'Report.PDF'),
        makeItem('notes.txt', 'Notes (edited)'),
        makeItem('other.txt', 'other.txt'),
    ];
    const dmScan = makeMockDM(items);
    const sdScan = new SearchDialog(dmScan);
    assertEqual(sdScan.scanForFiles('report', false), true,
        'scanForFiles matches fileName case-insensitively');
    assertEqual(sdScan.scanForFiles('edited', false), true,
        'scanForFiles matches the label text');
    assertEqual(sdScan.scanForFiles('zzz', false), false,
        'scanForFiles is false on no match');
    assertEqual(sdScan.scanForFiles('', false), false,
        'scanForFiles is false on empty text');
    assertEqual(sdScan.scanForFiles(null, false), false,
        'scanForFiles is false on null text');

    // 3. scanForFiles with setselected selects only the matches
    const dmSel = makeMockDM([makeItem('a.txt'), makeItem('b.txt')]);
    const sdSel = new SearchDialog(dmSel);
    sdSel.scanForFiles('a.txt', true);
    assertEqual(dmSel._fileList[0].isSelected, true, 'setselected selects matches');
    assertEqual(dmSel._fileList[1].isSelected, false, 'setselected leaves non-matches alone');
    assert(dmSel.calls.unselectAll >= 1, 'setselected clears the previous selection first');

    // 4. typeKey: string accumulation across consecutive keys
    const dmType = makeMockDM([makeItem('aha.txt')]);
    const sdType = new SearchDialog(dmType);
    const findCalls = [];
    sdType._refreshSearchTimeout = () => {
        sdType.keypressTimeoutID = 1;
    };
    sdType.findFiles = (window, text) => findCalls.push(text);
    sdType.typeKey(97, null); // 'a'
    assertEqual(sdType.searchString, 'a', 'typeKey starts the search string');
    assertEqual(findCalls.length, 1, 'typeKey opens the dialog on first match');
    assertEqual(findCalls[0], 'a', 'dialog receives the accumulated string');
    sdType.typeKey(104, null); // 'h'
    assertEqual(sdType.searchString, 'ah', 'typeKey appends while the timeout is active');
    assertEqual(findCalls[findCalls.length - 1], 'ah', 'dialog receives the extended string');

    // 5. typeKey without a match does not accumulate nor open the dialog
    const dmNoMatch = makeMockDM([makeItem('hello.txt')]);
    const sdNoMatch = new SearchDialog(dmNoMatch);
    const noMatchCalls = [];
    sdNoMatch.findFiles = (window, text) => noMatchCalls.push(text);
    sdNoMatch.typeKey(122, null); // 'z' — no file matches
    assertEqual(noMatchCalls.length, 0, 'typeKey does not open the dialog on no match');
    sdNoMatch.typeKey(122, null); // second 'z'
    assertEqual(sdNoMatch.searchString, 'z',
        'without an active timeout the string restarts instead of accumulating');

    // 6. escape: clears the selection and the pending string
    const dmEsc = makeMockDM([]);
    const sdEsc = new SearchDialog(dmEsc);
    sdEsc.searchString = 'pending';
    sdEsc.escape();
    assert(dmEsc.calls.unselectAll >= 1, 'escape clears the selection');
    assertEqual(sdEsc.searchString, null, 'escape clears the search string');

    // 7. real auto-hide timeout: searchString is dropped after the delay
    const dmTO = makeMockDM([]);
    const sdTO = new SearchDialog(dmTO);
    sdTO.searchString = 'x';
    sdTO._refreshSearchTimeout();
    assert(sdTO.keypressTimeoutID !== null, 'timeout source is armed');
    await flushLoop(Constants.KEYPRESS_SEARCH_TIMEOUT_MS + 250);
    assertEqual(sdTO.keypressTimeoutID, null, 'timeout source disarmed after firing');
    assertEqual(sdTO.searchString, null, 'searchString cleared when the timeout fires');

    // 8. destroy() with no window and no timeout is a no-op
    sd.destroy();
    assert(true, 'destroy() runs without window or timeout');

    return summary('SearchDialog');
}
