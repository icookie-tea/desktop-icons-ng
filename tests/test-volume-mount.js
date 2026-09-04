/* Volume/mount robustness tests (docs/volume-mount-issues.md).
 *
 * V-1: FileItem.eject()/unmount() must report failures (busy volume,
 *      stale mount, permissions) via _logAndPopupError instead of
 *      letting *_finish throw uncaught; destroyed items only log.
 * V-2: the refresh fast path must swap in the *new* GMount when the
 *      same URI is served by a different mount object (unmount/remount
 *      race), via DesktopManager._refreshReusedFileItem().
 * V-3: MountManager._readMountsAsync() must query mount info
 *      asynchronously so a dead network mount cannot freeze the main
 *      loop.
 * V-6: MountManager._scheduleMountRefreshRetry() retries a refresh
 *      while the mount still exists, and gives up (cap) / aborts when
 *      the mount is gone.
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { FileItem } from '../app/file-item.js';
import { DesktopManager } from '../app/desktop-manager.js';
import { MountManager } from '../app/mount-manager.js';
import * as Enums from '../app/enums.js';
import { assert, assertEqual, summary, flushLoop } from './harness.js';

/** A stub FileItem whose _custom is a mock GMount. */
function makeMountItem({ asyncError = null, syncError = null, destroyed = false } = {}) {
    const item = Object.create(FileItem.prototype);
    // uri is a getter-only property on the prototype; shadow it with a
    // data property on the instance
    Object.defineProperty(item, 'uri', { value: 'file:///run/media/user/MOCK' });
    item._destroyed = destroyed;
    item.popups = [];
    item._logAndPopupError = (title, error) => item.popups.push({ title, error });
    const mount = {
        asyncError,
        syncError,
        _finish() {
            if (this.asyncError) {
                throw this.asyncError;
            }
        },
        eject_with_operation(flags, ctx, op, cb) {
            if (this.syncError) {
                throw this.syncError;
            }
            mount.eject_with_operation_finish = mount._finish;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5, () => {
                cb(mount, {});
                return GLib.SOURCE_REMOVE;
            });
        },
        unmount_with_operation(flags, ctx, op, cb) {
            if (this.syncError) {
                throw this.syncError;
            }
            mount.unmount_with_operation_finish = mount._finish;
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5, () => {
                cb(mount, {});
                return GLib.SOURCE_REMOVE;
            });
        },
    };
    item._custom = mount;
    return item;
}


async function runEjectTests() {
    // async failure on eject
    {
        const item = makeMountItem({ asyncError: new Error('mock: volume busy') });
        item.eject();
        await flushLoop(80);
        assertEqual(item.popups.length, 1, 'V-1 eject failure pops up exactly once');
        assertEqual(item.popups[0]?.title, 'Eject Failed', 'V-1 eject failure title');
        assertEqual(item.popups[0]?.error, 'mock: volume busy', 'V-1 eject error message');
    }
    // async failure on unmount
    {
        const item = makeMountItem({ asyncError: new Error('mock: not authorized') });
        item.unmount();
        await flushLoop(80);
        assertEqual(item.popups.length, 1, 'V-1 unmount failure pops up exactly once');
        assertEqual(item.popups[0]?.title, 'Unmount Failed', 'V-1 unmount failure title');
    }
    // sync throw (op call itself fails on a stale mount)
    {
        const item = makeMountItem({ syncError: new Error('mock: sync fail') });
        item.unmount();
        await flushLoop(80);
        assertEqual(item.popups.length, 1, 'V-1 sync throw is reported, not uncaught');
        assertEqual(item.popups[0]?.title, 'Unmount Failed', 'V-1 sync throw title');
    }
    // success → no popup
    {
        const item = makeMountItem();
        item.eject();
        await flushLoop(80);
        assertEqual(item.popups.length, 0, 'V-1 successful eject pops up nothing');
    }
    // destroyed item → log only, no popup
    {
        const item = makeMountItem({ asyncError: new Error('mock: late failure'), destroyed: true });
        item.eject();
        await flushLoop(80);
        assertEqual(item.popups.length, 0, 'V-1 destroyed item does not pop up');
    }
    // no mount → no-op, no throw
    {
        const item = Object.create(FileItem.prototype);
        Object.defineProperty(item, 'uri', { value: 'file:///none' });
        item._custom = null;
        item.popups = [];
        item._logAndPopupError = () => {};
        item.eject();
        item.unmount();
        assertEqual(item.popups.length, 0, 'V-1 null mount is a no-op');
    }
}

function makeManagerStub(mountUris = []) {
    const mgr = Object.create(MountManager.prototype);
    // DesktopManager side: FileItem factory host + forced-exit flag
    mgr._parent = { _forcedExit: false };
    mgr._mountRetryCounts = new Map();
    mgr._mountRetryTimeoutId = 0;
    mgr.showDropPlace = false;
    mgr.updates = [];
    mgr._onRefresh = (reason) => mgr.updates.push(reason);
    // No GTK display in unit tests: override the FileItem factory seam
    // (production code path is the 1-line MountManager._createMountFileItem)
    mgr.mountItems = [];
    mgr._createMountFileItem = (file, info, extras, volume) => {
        const item = { file, info, extras, volume };
        mgr.mountItems.push(item);
        return item;
    };
    mgr._volumeMonitor = {
        get_mounts: () => mountUris.map(uri => ({
            get_default_location: () => ({ get_uri: () => uri }),
        })),
    };
    return mgr;
}

function testReuseSyncsCustom() {
    // V-2 lives on DesktopManager (the refresh fast path), not MountManager.
    const dm = Object.create(DesktopManager.prototype);
    // same URI, different GMount → the reused item must adopt it
    {
        const calls = [];
        const old = {
            _custom: 'STALE_MOUNT',
            _updateMetadataFromFileInfo: info => calls.push(['meta', info]),
            _readCoordinatesFromAttribute: (info, attr) => {
                calls.push(['coords', attr]);
                return null;
            },
            _applyDarkTextClass: () => calls.push(['dark']),
            _updateIcon: () => Promise.resolve(),
        };
        const newItem = { _custom: 'FRESH_MOUNT', _fileInfo: 'NEW_INFO' };
        dm._refreshReusedFileItem(old, newItem);
        assertEqual(old._custom, 'FRESH_MOUNT',
            'V-2 reuse path swaps in the new GMount');
        assert(calls.some(c => c[0] === 'meta' && c[1] === 'NEW_INFO'),
            'V-2 metadata refreshed with the new file info');
    }
    // non-drive items keep _custom === null
    {
        const old = {
            _custom: null,
            _updateMetadataFromFileInfo: () => {},
            _readCoordinatesFromAttribute: () => null,
            _applyDarkTextClass: () => {},
            _updateIcon: () => Promise.resolve(),
        };
        dm._refreshReusedFileItem(old, { _custom: null, _fileInfo: 'X' });
        assertEqual(old._custom, null, 'V-2 non-drive items stay null');
    }
}

// A real GError with the g-io-error quark (not CANCELLED): produced by a
// guaranteed-failing query, since GJS offers no convenient GError ctor.
function makeIoError() {
    try {
        const missing = Gio.File.new_for_uri('file:///nonexistent-ding-test-path');
        missing.query_info('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) {
        return e;
    }
    throw new Error('test setup failed to produce a GError');
}

function fakeMountFile(uri, { fail = false, delayMs = 5 } = {}) {
    const real = Gio.File.new_for_uri(uri);
    return {
        get_uri: () => uri,
        get_path: () => real.get_path(),
        query_info_async(attrs, flags, prio, cancellable, cb) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
                if (cancellable.is_cancelled()) {
                    return GLib.SOURCE_REMOVE;
                }
                if (fail) {
                    const err = makeIoError();
                    cb({
                        query_info_finish: () => {
                            throw err;
                        },
                    }, null);
                } else {
                    const info = real.query_info('standard::*,time::modified,unix::mode',
                        Gio.FileQueryInfoFlags.NONE, null);
                    cb({ query_info_finish: () => info }, null);
                }
                return GLib.SOURCE_REMOVE;
            });
        },
    };
}

const fakeVolume = { get_name: () => 'MockDrive' };

async function runReadMountsTests() {
    // V-3 success: the factory is called with the right args; retry count cleared
    {
        const file = fakeMountFile('file:///tmp');
        const mgr = makeManagerStub(['file:///tmp']);
        mgr._mountRetryCounts.set('file:///tmp', 2);
        const fileList = [];
        let done = false;
        mgr._readMountsAsync([[file, Enums.FileType.EXTERNAL_DRIVE, fakeVolume]],
            fileList, new Gio.Cancellable(), () => { done = true; });
        await flushLoop(120);
        assert(done, 'V-3 readMountsAsync completes');
        assertEqual(fileList.length, 1, 'V-3 mount FileItem created');
        assertEqual(mgr.mountItems.length, 1, 'V-3 factory called once');
        assertEqual(mgr.mountItems[0]?.extras, Enums.FileType.EXTERNAL_DRIVE,
            'V-3 factory gets the drive extra type');
        assertEqual(mgr.mountItems[0]?.volume, fakeVolume, 'V-3 factory gets the GMount');
        assertEqual(mgr._mountRetryCounts.has('file:///tmp'), false,
            'V-3 success clears the retry count');
    }
    // V-6 failure: no item, retry scheduled while the mount still exists
    {
        const file = fakeMountFile('file:///tmp', { fail: true });
        const mgr = makeManagerStub(['file:///tmp']);
        const fileList = [];
        mgr._readMountsAsync([[file, Enums.FileType.EXTERNAL_DRIVE, fakeVolume]],
            fileList, new Gio.Cancellable(), () => {});
        await flushLoop(120);
        assertEqual(fileList.length, 0, 'V-6 failed mount adds no item');
        assertEqual(mgr._mountRetryCounts.get('file:///tmp'), 1,
            'V-6 failed mount schedules a retry (count 1)');
    }
    // V-3 non-blocking: the main loop keeps turning during a slow query
    {
        let ticks = 0;
        const file = fakeMountFile('file:///tmp', { delayMs: 80 });
        const mgr = makeManagerStub(['file:///tmp']);
        const fileList = [];
        let done = false;
        mgr._readMountsAsync([[file, Enums.FileType.EXTERNAL_DRIVE, fakeVolume]],
            fileList, new Gio.Cancellable(), () => { done = true; });
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
            ticks += 1;
            return GLib.SOURCE_REMOVE;
        });
        await flushLoop(200);
        assert(ticks >= 1, 'V-3 main loop stays responsive while query is in flight');
        assert(done && fileList.length === 1, 'V-3 slow mount still resolves');
    }
    // cancelled: nothing pushed, done() still called
    {
        const cancellable = new Gio.Cancellable();
        const file = fakeMountFile('file:///tmp', { delayMs: 50 });
        const mgr = makeManagerStub(['file:///tmp']);
        const fileList = [];
        let done = false;
        mgr._readMountsAsync([[file, Enums.FileType.EXTERNAL_DRIVE, fakeVolume]],
            fileList, cancellable, () => { done = true; });
        cancellable.cancel();
        await flushLoop(120);
        assertEqual(fileList.length, 0, 'V-3 cancelled read adds no item');
    }
}

async function runScheduleRetryTests() {
    // still mounted → the delayed refresh fires
    {
        const mgr = makeManagerStub(['file:///m']);
        mgr._scheduleMountRefreshRetry('file:///m', 10);
        await flushLoop(100);
        assert(mgr.updates.includes('mount query retry'),
            'V-6 retry refresh fires while the mount still exists');
    }
    // mount gone → nothing scheduled
    {
        const mgr = makeManagerStub([]);
        mgr._scheduleMountRefreshRetry('file:///gone', 10);
        await flushLoop(100);
        assertEqual(mgr.updates.length, 0, 'V-6 no retry once the mount is gone');
        assertEqual(mgr._mountRetryCounts.size, 0, 'V-6 no retry count recorded');
    }
    // consecutive failures are capped; the timer coalesces to one fire
    {
        const mgr = makeManagerStub(['file:///m']);
        for (let i = 0; i < 5; i++) {
            mgr._scheduleMountRefreshRetry('file:///m', 10);
        }
        assertEqual(mgr._mountRetryCounts.get('file:///m'), 3,
            'V-6 retry count capped at 3');
        await flushLoop(100);
        assertEqual(mgr.updates.filter(r => r === 'mount query retry').length, 1,
            'V-6 coalesced retries fire a single refresh');
    }
}

export async function runTests() {
    await runEjectTests();
    testReuseSyncsCustom();
    await runReadMountsTests();
    await runScheduleRetryTests();
    return summary('volume-mount');
}
