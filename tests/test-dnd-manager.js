/* DnD state lifetime in DndManager.
 *
 * onDragEnd() used to clear only `dragItem`, leaving `_dragList` (the relative
 * offsets of the dragged icons used to draw the drop preview) behind. A
 * finished drag therefore kept its preview list around: the desktops were
 * never told to drop the preview, and the next drag could reuse stale offsets
 * (audit 2026-09-11). */
import { DndManager } from '../app/dnd-manager.js';
import { assertDeepEqual, assertEqual, summary } from './harness.js';

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

/* Primary-only drag double: placement and commit are recorded, the real
 * DesktopGrid math is covered by tests/test-primary-layout.js. */
function makePrimaryDragDm(items, layout) {
    const dm = {
        keepArranged: false,
        sortSpecialFolders: true,
        _fileList: items,
        _refreshReasons: [],
        _updateDesktopSafe(reason) {
            dm._refreshReasons.push(reason);
        },
        _desktops: [{ getGridAt: () => null }],
        _gridLayout: layout,
    };
    return dm;
}

function makeDragItem(uri, x, y, { selected = false, special = false, placeable = true } = {}) {
    const item = {
        uri,
        isSelected: selected,
        isSpecial: special,
        _x: x,
        _y: y,
        _removed: 0,
        _savedSetterCalls: 0,
        _savedCoordinates: [x, y],
        _placeable: placeable,
        getCoordinates: () => [item._x, item._y, item._x + 10, item._y + 10, null],
        removeFromGrid: () => {
            item._removed += 1;
        },
    };
    Object.defineProperty(item, 'savedCoordinates', {
        get() { return this._savedCoordinates; },
        set(value) { this._savedSetterCalls += 1; this._savedCoordinates = value; },
    });
    return item;
}

function makePrimaryLayoutDouble() {
    const layout = {
        primaryOnly: true,
        placements: [],
        commits: [],
        placePrimaryFiles(list, opts) {
            layout.placements.push({ list, opts });
            return list.filter(item => item._placeable);
        },
        commitPrimaryPositions(list) {
            layout.commits.push(list);
        },
    };
    return layout;
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

    // 4. Primary-only drag: only the icons that actually landed are committed,
    //    and the legacy coordinate is written by that single commit -- never
    //    through the item setter (a drag that cannot be placed would otherwise
    //    still leave a coordinate behind).
    {
        const layout = makePrimaryLayoutDouble();
        const a = makeDragItem('file:///a', 0, 0);
        const b = makeDragItem('file:///b', 100, 0, { selected: true });
        const c = makeDragItem('file:///c', 200, 0);
        const manager = Object.create(DndManager.prototype);
        manager._dm = makePrimaryDragDm([a, b, c], layout);

        manager.doMoveWithDragAndDrop(100, 50, 150, 250);

        assertEqual(layout.placements.length, 1, 'the selection is placed once');
        const targets = layout.placements[0].opts.targets;
        assertEqual(targets.size, 1, 'only the selected icon gets a target');
        assertDeepEqual(targets.get('file:///b'), [150, 200], 'the target keeps the drag offset');
        assertEqual(layout.commits.length, 1, 'the placed icons are committed');
        assertDeepEqual(layout.commits[0].map(i => i.uri), ['file:///b'],
            'and only the placed one, not the other icons');
        assertEqual(a._removed + c._removed, 0, 'unselected icons are left in place');
        assertEqual(b._removed, 1, 'the dragged icon is lifted before placement');
        assertEqual(a._savedSetterCalls + b._savedSetterCalls + c._savedSetterCalls, 0,
            'no legacy coordinate is written through the setter');
    }

    // 5. An icon that could not be placed (full grid) keeps its anchor: the
    //    commit set is empty, so nothing is recorded for it.
    {
        const layout = makePrimaryLayoutDouble();
        const stuck = makeDragItem('file:///stuck', 0, 0, { selected: true, placeable: false });
        const manager = Object.create(DndManager.prototype);
        manager._dm = makePrimaryDragDm([stuck], layout);

        manager.doMoveWithDragAndDrop(0, 0, 50, 50);

        assertEqual(layout.placements.length, 1, 'the placement was attempted');
        assertDeepEqual(layout.commits[0], [], 'nothing is committed for an unplaced icon');
    }

    // 6. keep-arranged only lets special icons move, and the implicit reflow
    //    afterwards is the same as before.
    {
        const layout = makePrimaryLayoutDouble();
        const normal = makeDragItem('file:///n', 0, 0, { selected: true });
        const special = makeDragItem('file:///s', 100, 0, { selected: true, special: true });
        const manager = Object.create(DndManager.prototype);
        manager._dm = makePrimaryDragDm([normal, special], layout);
        manager._dm.keepArranged = true;
        /* keep-arranged + sort-special-folders is a no-op drag; this branch is
         * the one that still moves special icons. */
        manager._dm.sortSpecialFolders = false;

        manager.doMoveWithDragAndDrop(0, 0, 40, 40);

        assertEqual(layout.placements[0].opts.targets.size, 1, 'only the special icon is moved');
        assertEqual(layout.placements[0].opts.targets.has('file:///s'), true, 'the special one');
        assertEqual(manager._dm._refreshReasons.length, 1,
            'keep-arranged still triggers the implicit reflow');
    }

    return summary('dnd-manager');
}
