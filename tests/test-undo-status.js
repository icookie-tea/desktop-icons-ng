/* Tests for the undo/redo availability contract of the remote-operations
 * managers (app/dbus-remote-operations.js).
 *
 * desktop-menu.js gates UndoStatus() behind `RemoteFileOperations.isAvailable`,
 * but the managers only exposed `proxy`, so the guard was undefined-falsy and
 * the desktop Undo/Redo entries stayed permanently disabled. UndoStatus() must
 * also survive the Nautilus-restart race (proxy gone between check and call). */
import { RemoteFileOperationsManager,
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

export function runTests() {
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

    return summary('UndoStatus');
}
