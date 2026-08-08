/* Regression tests for the symlink emblem (show-link-emblem setting).
 *
 * Contract: FileItem._getEmblem() must honor the 'show-link-emblem'
 * gsettings key. The live value lives on DesktopManager.showLinkEmblem
 * (desktop-manager.js reads the key at construction and on settings
 * change); items must read it from there.
 *
 * Bug (fixed): _getEmblem() read Prefs.showLinkEmblem, which
 * preferences.js does not export — always undefined → valid symlinks
 * never got the emblem-symbolic-link badge regardless of the setting
 * (which defaults to on).
 */
import { FileItem } from '../app/file-item.js';
import { assert, assertEqual, summary } from './harness.js';

function makeStub({ showLinkEmblem, isBrokenSymlink }) {
    const item = Object.create(FileItem.prototype);
    item._isSymlink = true;
    item._isBrokenSymlink = isBrokenSymlink;
    item._isDesktopFile = false;
    item._desktopManager = { showLinkEmblem };
    return item;
}

function emblemName(icon) {
    if (icon === null)
        return null;
    return icon.get_names()[0]; // Gio.ThemedIcon
}

export function runTests() {
    // --- A: setting ON + valid symlink → arrow emblem (the reported bug) ---
    {
        const item = makeStub({ showLinkEmblem: true, isBrokenSymlink: false });
        assertEqual(emblemName(item._getEmblem()), 'emblem-symbolic-link',
            'valid symlink with show-link-emblem ON gets the link emblem');
    }

    // --- B: setting OFF + valid symlink → no emblem ---
    {
        const item = makeStub({ showLinkEmblem: false, isBrokenSymlink: false });
        assertEqual(item._getEmblem(), null,
            'valid symlink with show-link-emblem OFF gets no emblem');
    }

    // --- C: broken symlink → unreadable emblem regardless of the setting ---
    {
        const off = makeStub({ showLinkEmblem: false, isBrokenSymlink: true });
        assertEqual(emblemName(off._getEmblem()), 'emblem-unreadable',
            'broken symlink always gets the unreadable emblem (setting OFF)');
        const on = makeStub({ showLinkEmblem: true, isBrokenSymlink: true });
        assertEqual(emblemName(on._getEmblem()), 'emblem-unreadable',
            'broken symlink always gets the unreadable emblem (setting ON)');
    }

    assert(true, 'link-emblem contract checked');
    return summary('link-emblem');
}
