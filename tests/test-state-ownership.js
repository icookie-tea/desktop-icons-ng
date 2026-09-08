/* State-ownership test: after the DesktopManager split, each manager owns a
 * set of mutable fields. This test fails loudly if a field is renamed,
 * removed from a constructor, or moved to another manager — the executable
 * replacement for a state-ownership documentation table (which would drift).
 *
 * Cross-file access through the old DesktopManager paths is covered by the
 * check_state_ownership() guards in scripts/check.sh. */
import { SelectionManager } from '../app/selection-manager.js';
import { SearchDialog } from '../app/search-dialog.js';
import { KeyboardManager } from '../app/keyboard-manager.js';
import { DndManager } from '../app/dnd-manager.js';
import { assert, assertEqual, summary } from './harness.js';

const fakeDm = {};

export function runTests() {
    // SelectionManager: rubber band + selection rectangle state
    const sel = new SelectionManager(fakeDm);
    assertEqual(sel.rubberBand, false, 'SelectionManager.rubberBand initial');
    assertEqual(sel.rubberBandInitX, 0, 'SelectionManager.rubberBandInitX initial');
    assertEqual(sel.rubberBandInitY, 0, 'SelectionManager.rubberBandInitY initial');
    assertEqual(sel.x1, 0, 'SelectionManager.x1 initial');
    assertEqual(sel.x2, 0, 'SelectionManager.x2 initial');
    assertEqual(sel.y1, 0, 'SelectionManager.y1 initial');
    assertEqual(sel.y2, 0, 'SelectionManager.y2 initial');
    assertEqual(sel.selectionRectangle, null, 'SelectionManager.selectionRectangle initial');
    assertEqual(sel._clickCaptured, false, 'SelectionManager._clickCaptured initial');

    // SearchDialog: type-to-search state (single source of truth for the
    // search string — the keyboard manager only delegates to it)
    const dialog = new SearchDialog(fakeDm);
    assertEqual(dialog.searchString, null, 'SearchDialog.searchString initial');
    assertEqual(dialog.keypressTimeoutID, null, 'SearchDialog.keypressTimeoutID initial');
    assertEqual(dialog._findFileWindow, null, 'SearchDialog._findFileWindow initial (lazy)');

    // KeyboardManager: keyboard navigation state
    const kb = new KeyboardManager(fakeDm);
    assertEqual(kb._lastSelected, null, 'KeyboardManager._lastSelected initial');
    assert(Array.isArray(kb.ignoreKeys) && kb.ignoreKeys.length > 0,
        'KeyboardManager.ignoreKeys is a non-empty list');

    // DndManager: drag state
    const dnd = new DndManager(fakeDm);
    assertEqual(dnd.dragItem, null, 'DndManager.dragItem initial');
    assertEqual(dnd._dragList, null, 'DndManager._dragList initial');
    assertEqual(dnd._dragOriginX, 0, 'DndManager._dragOriginX initial');
    assertEqual(dnd._dragOriginY, 0, 'DndManager._dragOriginY initial');

    return summary('state-ownership');
}
