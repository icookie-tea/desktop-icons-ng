/* Drop-target wiring of a FileItem.
 *
 * When "show-drop-place" is on, the whole container accepts the drop (so the
 * highlight covers it); otherwise the icon and the label do. That wiring ran
 * only from the constructor, so the in-place "fast path" refresh (same file
 * set → the existing FileItems are reused) never replayed it: toggling the
 * setting left every reused icon wired the old way until it was rebuilt.
 * Re-wiring must also remove the previous controllers, otherwise every
 * toggle/refresh piles up another drop target on the same widget
 * (audit 2026-09-11). */
import * as Enums from '../app/enums.js';
import { FileItem } from '../app/file-item.js';
import { DesktopManager } from '../app/desktop-manager.js';
import { assert, assertEqual, summary } from './harness.js';

function makeWidget(name, item) {
    return {
        name,
        remove_controller: controller => item.removed.push([name, controller]),
    };
}

function makeItem({ showDropPlace = true, isDirectory = true } = {}) {
    const item = Object.create(FileItem.prototype);
    item.removed = [];
    item._wired = [];
    item.container = makeWidget('container', item);
    item._icon = makeWidget('icon', item);
    item._label = makeWidget('label', item);
    item._fileExtra = Enums.FileType.NONE;
    item._isDirectory = isDirectory;
    item._desktopManager = { showDropPlace };
    item._dropTargetControllers = [];
    item._dropDestinationWidgets = [];
    // Stand-in for the real (GTK) implementation: record the wiring and the
    // controller that would have to be removed later.
    item._setDropDestination = widget => {
        item._wired.push(widget);
        item._dropTargetControllers.push([widget, { controllerFor: widget.name }]);
    };
    return item;
}

export function runTests() {
    if (typeof FileItem.prototype._updateDropDestinations !== 'function') {
        assert(false, 'FileItem._updateDropDestinations() does not exist yet');
        return summary('drop-place-setting');
    }

    // 1. drop-place enabled → a single drop target on the container
    {
        const item = makeItem({ showDropPlace: true });
        item._updateDropDestinations();
        assertEqual(item._wired.length, 1, 'one drop target when the drop place is shown');
        assert(item._wired[0] === item.container, 'wired on the whole container');
    }

    // 2. drop-place disabled → icon and label carry the drop targets
    {
        const item = makeItem({ showDropPlace: false });
        item._updateDropDestinations();
        assertEqual(item._wired.length, 2, 'two drop targets when it is hidden');
        assert(item._wired[0] === item._icon && item._wired[1] === item._label,
            'wired on the icon and the label');
    }

    // 3. toggling the setting re-wires a reused item and drops the stale
    //    controller (this is what the fast refresh path needs)
    {
        const item = makeItem({ showDropPlace: true });
        item._updateDropDestinations();
        item._desktopManager.showDropPlace = false;
        item._updateDropDestinations();
        assertEqual(item._wired.length, 3, 'the items are re-wired after the setting changed');
        assert(item._wired[1] === item._icon && item._wired[2] === item._label,
            'now wired on the icon and the label');
        assertEqual(item.removed.length, 1, 'the stale container controller is removed');
        assertEqual(item.removed[0][0], 'container', 'from the container');
        assertEqual(item._dropDestinationWidgets.length, 2, 'the widget list reflects the new wiring');
    }

    // 4. re-applying the same setting does not add controllers again
    {
        const item = makeItem({ showDropPlace: false });
        item._updateDropDestinations();
        const wired = item._wired.length;
        item._updateDropDestinations();
        item._updateDropDestinations();
        assertEqual(item._wired.length, wired, 'no churn when the setting did not change');
        assertEqual(item.removed.length, 0, 'nothing is removed either');
    }

    // 5. items that cannot receive drops are never wired
    {
        const item = makeItem({ isDirectory: false });
        item._updateDropDestinations();
        assertEqual(item._wired.length, 0, 'a plain file gets no drop target');
        item._desktopManager.showDropPlace = false;
        item._updateDropDestinations();
        assertEqual(item._wired.length, 0, 'and still none after a settings change');
    }

    // 6. the reuse fast path replays the wiring on the surviving item
    {
        const item = makeItem({ showDropPlace: true });
        // the metadata refresh is exercised elsewhere; only the drop-place
        // replay is under test here
        item._updateMetadataFromFileInfo = () => {};
        item._readCoordinatesFromAttribute = () => null;
        item._applyDarkTextClass = () => {};
        item._updateIcon = () => Promise.resolve();
        let calls = 0;
        item._updateDropDestinations = () => { calls++; };
        const dm = Object.create(DesktopManager.prototype);
        dm._refreshReusedFileItem(item, { _custom: undefined });
        assertEqual(calls, 1, '_refreshReusedFileItem() replays the drop-place wiring');
    }

    return summary('drop-place-setting');
}
