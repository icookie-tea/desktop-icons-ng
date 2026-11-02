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
        let requested = null;
        const clicked = {
            /* Stale legacy coordinate (e.g. from the monitor the icon used to
             * live on) while the icon is rendered on the primary screen: the
             * new folder must appear where the icon actually is. */
            savedCoordinates: [9000, 9000],
            getCoordinates: () => [640, 480, 700, 560, null],
            removeFromGrid: () => {
                removed = true;
            },
        };
        menu._desktopManager = {
            getCurrentSelection: () => ['file:///a'],
            unselectAll: () => {},
            doNewFolder: position => {
                requested = position;
                return null;
            },
        };
        menu._doNewFolderFromSelection(clicked);
        assertEqual(removed, false,
            'failed folder creation must not destroy the clicked icon');
        assertEqual(JSON.stringify(requested), '[640,480]',
            'the new folder uses the rendered position, not the stored coordinate');
    }

    return summary('new-folder-selection');
}
