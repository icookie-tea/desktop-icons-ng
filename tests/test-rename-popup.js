/* Regression tests for the rename popup across desktop refreshes.
 *
 * Bug (audit 2026-09-11): updateFileItem() called the GTK3-only
 * Gtk.Popover.set_relative_to() (GTK 4.22 has no such method, verified), so
 * _drawDesktop()'s updateFileItem(null) threw and the whole refresh was
 * dropped while a rename popup was open.
 *
 * Bug 2 (latent, masked by bug 1): the reuse fast path destroys every newly
 * created FileItem and keeps the reused ones, but the rename reattach block
 * looked the target up in the original (destroyed) list, so
 * setRenamePopup() dereferenced container === null right after the grids had
 * been cleared — blank desktop.
 *
 * GTK4 reparenting semantics (probed on GTK 4.22): unparent() detaches
 * without emitting 'closed' (the rename survives) and set_parent() maps the
 * popover again. */
import { AskRenamePopup } from '../app/ask-rename-popup.js';
import { FileItem } from '../app/file-item.js';
import { DesktopManager } from '../app/desktop-manager.js';
import { assert, assertEqual, summary } from './harness.js';

function makePopoverSpy(initialParent = null) {
    return {
        _parent: initialParent,
        unparentCalls: 0,
        get_parent() {
            return this._parent;
        },
        unparent() {
            this.unparentCalls += 1;
            this._parent = null;
        },
        set_parent(parent) {
            this._parent = parent;
        },
        set_position() {},
    };
}

function makeTextAreaSpy(position = 7) {
    return {
        position,
        get_position() {
            return this.position;
        },
        set_position(value) {
            this.position = value;
        },
    };
}

export function runTests() {
    const callUpdateFileItem = (popup, item) => {
        try {
            AskRenamePopup.prototype.updateFileItem.call(popup, item);
            return null;
        } catch (e) {
            return e.message;
        }
    };

    // 1. updateFileItem(null) detaches the popover without throwing.
    {
        const parent = {};
        const popover = makePopoverSpy(parent);
        const textArea = makeTextAreaSpy(7);
        const popup = { _popover: popover, _textArea: textArea, _fileItem: 'old', _cursorPosition: 0 };

        const error = callUpdateFileItem(popup, null);
        assertEqual(error, null, 'updateFileItem(null) must not throw');
        assertEqual(popup._fileItem, null, 'null detaches the file item');
        assertEqual(popover.unparentCalls, 1, 'null unparents the popover');
        assertEqual(popover.get_parent(), null, 'the popover has no parent after detach');
        assertEqual(popup._cursorPosition, 7, 'the cursor position is preserved for the reattach');
    }

    // 2. updateFileItem(item) reparents to the item's container (GTK4 way).
    {
        const oldParent = {};
        const newContainer = {};
        const popover = makePopoverSpy(oldParent);
        const textArea = makeTextAreaSpy(7);
        const popup = { _popover: popover, _textArea: textArea, _fileItem: null, _cursorPosition: 3 };
        const item = { container: newContainer };

        const error = callUpdateFileItem(popup, item);
        assertEqual(error, null, 'updateFileItem(item) must not throw');
        assertEqual(popup._fileItem, item, 'the item is recorded');
        assertEqual(popover.get_parent(), newContainer, 'the popover re-attaches to the new container');
        assertEqual(popover.unparentCalls, 1, 'the old parent is released first');
        assertEqual(textArea.position, 3, 'the saved cursor position is restored');
    }

    // 3. setRenamePopup() on a destroyed item is a no-op, not a crash.
    {
        const destroyed = { _destroyed: true, container: null, _realizeId: 0 };
        let threw = false;
        try {
            FileItem.prototype.setRenamePopup.call(destroyed, { updateFileItem() {} });
        } catch (e) {
            threw = true;
        }
        assert(!threw, 'setRenamePopup() on a destroyed item must not throw');
    }

    // 4. The refresh reattaches to the REUSED item, not the destroyed new one.
    {
        const dm = Object.create(DesktopManager.prototype);
        dm._pendingMoves = {};
        dm._pendingMoveTimeouts = {};
        dm._selectedFiles = null;
        dm._renamingFile = 'a.txt';
        let reattachedTo = null;
        let popupDropped = false;
        dm._renameWindow = {
            updateFileItem() {},
            closeWindow() {
                popupDropped = true;
            },
        };
        dm.getCurrentSelection = () => null;
        dm._canReuseFileItems = () => true;
        dm._refreshReusedFileItem = () => {};
        dm._clearAllFilesFromGrids = () => {};
        dm._placeAllFilesOnGrids = () => {};
        dm._desktops = [];
        const oldItem = {
            uri: 'file:///a.txt',
            fileName: 'a.txt',
            setRenamePopup() {
                reattachedTo = 'reused';
            },
        };
        const newItem = {
            uri: 'file:///a.txt',
            fileName: 'a.txt',
            _onDestroy() {},
            setRenamePopup() {
                reattachedTo = 'destroyed';
            },
        };
        dm._fileList = [oldItem];

        dm._drawDesktop([newItem]);
        assertEqual(reattachedTo, 'reused',
            'the rename popup must be reattached to the reused item');
        assertEqual(popupDropped, false,
            'the popup must not be dropped while the file still exists');
    }

    return summary('rename-popup');
}
