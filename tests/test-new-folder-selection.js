/* Regression tests for "New Folder with Selection" failure handling, and for
 * the widget-reuse guard that must never re-adopt a destroyed FileItem.
 *
 * Bug (audit 2026-09-11): _doNewFolderFromSelection() destroyed the clicked
 * icon BEFORE creating the folder. When doNewFolder() failed (read-only
 * desktop, permission error) the destroyed item stayed in
 * DesktopManager._fileList with a null container: keyboard navigation threw
 * on getCoordinates() (container.get_allocated_width() on null) and the next
 * fast-path refresh crashed in _addFileItemTo (container.put(null)) after the
 * grids had been cleared — blank desktop until the file set changed. */
import { DesktopManager } from '../app/desktop-manager.js';
import { FileItemMenu } from '../app/file-item-menu.js';
import { assertEqual, summary } from './harness.js';

export function runTests() {
    // 1. A destroyed item must force the full rebuild path instead of being
    //    re-adopted by the reuse fast path.
    {
        const dm = Object.create(DesktopManager.prototype);
        dm._fileList = [
            { uri: 'file:///a', _destroyed: false },
            { uri: 'file:///b', _destroyed: false },
        ];
        assertEqual(dm._canReuseFileItems([{ uri: 'file:///a' }, { uri: 'file:///b' }]), true,
            'an intact file list may still take the reuse fast path');

        dm._fileList = [
            { uri: 'file:///a', _destroyed: false },
            { uri: 'file:///b', _destroyed: true },
        ];
        assertEqual(dm._canReuseFileItems([{ uri: 'file:///a' }, { uri: 'file:///b' }]), false,
            'a destroyed item forces a rebuild instead of being reused');
    }

    // 2. A failed folder creation must leave the clicked icon untouched.
    {
        const menu = Object.create(FileItemMenu.prototype);
        let removed = false;
        const clicked = {
            savedCoordinates: [10, 20],
            removeFromGrid: () => {
                removed = true;
            },
        };
        menu._desktopManager = {
            getCurrentSelection: () => ['file:///a'],
            unselectAll: () => {},
            doNewFolder: () => null,
        };
        menu._doNewFolderFromSelection(clicked);
        assertEqual(removed, false,
            'failed folder creation must not destroy the clicked icon');
    }

    return summary('new-folder-selection');
}
