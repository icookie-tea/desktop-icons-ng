/* Tests for the undo/redo availability contract of the remote-operations
 * managers (app/dbus-remote-operations.js).
 *
 * desktop-menu.js gates UndoStatus() behind `RemoteFileOperations.isAvailable`,
 * but the managers only exposed `proxy`, so the guard was undefined-falsy and
 * the desktop Undo/Redo entries stayed permanently disabled. UndoStatus() must
 * also survive the Nautilus-restart race (proxy gone between check and call). */
import { DbusOperationsManager, RemoteFileOperationsManager,
    LegacyRemoteFileOperationsManager } from '../app/dbus-remote-operations.js';
import { assert, assertEqual, summary } from './harness.js';

/* Minimal stand-in for ProxyManager (dbus-utils.js): the managers only read
 * `isAvailable` and `proxy`, and the constructor stores its args untouched. */
function makeProxyManager({ available, proxy }) {
    return { isAvailable: available, proxy };
}

function callUndoStatus(manager) {
    try {
        return manager.UndoStatus();
    } catch (e) {
        return `threw: ${e.message}`;
    }
}

export async function runTests() {
    const available = new RemoteFileOperationsManager(
        null, makeProxyManager({ available: true, proxy: { UndoStatus: 1 } }), null, null, null);
    assertEqual(available.isAvailable, true,
        'an available FileOperations proxy makes the manager available');

    const unavailable = new RemoteFileOperationsManager(
        null, makeProxyManager({ available: false, proxy: null }), null, null, null);
    assertEqual(unavailable.isAvailable, false,
        'a missing FileOperations proxy makes the manager unavailable');

    const legacy = new LegacyRemoteFileOperationsManager(
        makeProxyManager({ available: false, proxy: null }), null, null, null);
    assertEqual(legacy.isAvailable, false,
        'the legacy manager reports unavailability with the same contract');

    assertEqual(callUndoStatus(unavailable), undefined,
        'UndoStatus() stays safe when the proxy vanished before the call');
    assertEqual(callUndoStatus(legacy), undefined,
        'legacy UndoStatus() stays safe without a proxy');
    assertEqual(callUndoStatus(available), 1,
        'UndoStatus() reads the proxy property');
    assert(available.isAvailable, 'availability stays reported after a status read');

    // 3. Both managers keep the async contract callers rely on: the rename
    //    popup chains .catch() on RenameURIRemote, which the legacy manager
    //    used to return as undefined.
    {
        const legacy = new LegacyRemoteFileOperationsManager(
            makeProxyManager({ available: false, proxy: null }), null, null, null);
        const returned = legacy.RenameURIRemote(['file:///a'], 'b.txt');
        assert(returned !== null && returned !== undefined && typeof returned.catch === 'function',
            'legacy RenameURIRemote returns a promise');
        assert(returned !== null && returned !== undefined && typeof returned.then === 'function',
            'legacy RenameURIRemote is awaitable');
    }

    // 4. The exported Wayland handle is released even when the proxy call
    //    throws synchronously (it used to leak until another successful call).
    {
        const manager = Object.create(DbusOperationsManager.prototype);
        let freed = false;
        manager.platformData = async () => ({
            data: { 'parent-handle': 1 },
            freePlatformData: () => {
                freed = true;
            },
        });
        const proxyManager = {
            proxy: {
                RenameURIRemote() {
                    throw new Error('proxy vanished');
                },
            },
        };
        await manager._remoteCallWithPlatformData(proxyManager, 'RenameURIRemote', 'Error renaming', [], null);
        assertEqual(freed, true,
            'the Wayland handle is freed when the proxy call throws synchronously');
    }

    return summary('UndoStatus');
}
