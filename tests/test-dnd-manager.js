/* DnD state lifetime in DndManager.
 *
 * onDragEnd() used to clear only `dragItem`, leaving `_dragList` (the relative
 * offsets of the dragged icons used to draw the drop preview) behind. A
 * finished drag therefore kept its preview list around: the desktops were
 * never told to drop the preview, and the next drag could reuse stale offsets
 * (audit 2026-09-11). */
import { DndManager } from '../app/dnd-manager.js';
import { assertEqual, summary } from './harness.js';

function makeManager() {
    const manager = Object.create(DndManager.prototype);
    manager._refreshes = [];
    manager._dm = {
        _desktops: [{
            refreshDrag: (...args) => manager._refreshes.push(args),
        }],
    };
    return manager;
}

export function runTests() {
    // 1. the end of a drag clears both pieces of state and the preview
    {
        const manager = makeManager();
        manager.dragItem = { uri: 'file:///a' };
        manager._dragList = [[10, 20], [0, 0]];
        DndManager.prototype.onDragEnd.call(manager);
        assertEqual(manager.dragItem, null, 'the dragged item is forgotten');
        assertEqual(manager._dragList, null, 'the drag preview list is forgotten');
        assertEqual(manager._refreshes.length, 1, 'every desktop is asked to drop the preview');
        assertEqual(manager._refreshes[0]?.[0], null, 'with a null preview list');
    }

    // 2. getDragList() no longer reports a finished drag
    {
        const manager = makeManager();
        manager.dragItem = { uri: 'file:///a' };
        manager._dragList = [[1, 1]];
        DndManager.prototype.onDragEnd.call(manager);
        assertEqual(manager.getDragList(), null, 'no drag list is reported after the drag ended');
    }

    // 3. a drag end without a previous drag begin is harmless
    {
        const manager = makeManager();
        manager.dragItem = null;
        manager._dragList = null;
        DndManager.prototype.onDragEnd.call(manager);
        assertEqual(manager._dragList, null, 'stays clean');
        assertEqual(manager._refreshes.length, 1, 'the desktops are still told to drop any preview');
    }

    return summary('dnd-manager');
}
