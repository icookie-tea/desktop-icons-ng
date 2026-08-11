/* Tests for DesktopMonitor event filtering and incremental routing.
 *
 * Covers: updateDesktopIfChanged filtering (CHANGED dropped,
 * CHANGES_DONE_HINT queued, hidden files, keep-arranged shortcut,
 * ATTRIBUTE_CHANGED on dir vs child), processIncrementalEvents routing
 * (RENAMED arg-order contract, CHANGES_DONE_HINT refresh, MOVED_DELETED,
 * MOVED_OUT without otherFile, unknown-file no-op, full-refresh
 * fallbacks). The DesktopManager is mocked; no real files are touched.
 */
import Gio from 'gi://Gio';

import { DesktopMonitor } from '../app/desktop-monitor.js';
import { assert, assertEqual, summary } from './harness.js';

/* Minimal GFile-like mock. */
function makeFile(path) {
    return {
        _path: path,
        get_path: () => path,
        get_uri: () => `file://${path}`,
        get_basename: () => path.split('/').pop(),
    };
}

function makeEvent(file, otherFile, eventType) {
    return { file, otherFile, eventType };
}

/* DesktopManager mock: everything the monitor touches, all replaceable. */
function makeDm(overrides = {}) {
    const dm = {
        _showHidden: false,
        keepArranged: false,
        keepStacked: false,
        _desktopDir: {
            ...makeFile('/home/u/Desktop'),
            // consumed by monitor.updateWritableByOthers()
            query_info: () => ({ get_attribute_uint32: () => 0 }),
        },
        _fileChangesQueue: { push: () => {} },
        _processingIncremental: false,
        _readingDesktopFiles: false,
        _desktopFilesChanged: false,
        _fileList: [],
        _pendingMoves: {},
        _moveTimeoutId: 0,
        _renameWindow: null,
        _renamingFile: null,
        _desktops: [],
        updateWritableByOthers: () => false,
        getFileItemFromURI: () => null,
        _updateDesktopSafe: () => {},
        ...overrides,
    };
    return dm;
}

function makeItem(path, overrides = {}) {
    return {
        path,
        uri: `file://${path}`,
        fileName: path.split('/').pop(),
        removeFromGrid: () => {},
        onFileRenamed: () => {},
        updatedMetadata: () => {},
        ...overrides,
    };
}

export async function runTests() {
    let dm, mon, pushed, refreshed;

    /* ---------- updateDesktopIfChanged: filtering ---------- */

    // 1. CHANGED (per-chunk writes) is always dropped
    dm = makeDm();
    pushed = [];
    dm._fileChangesQueue.push = e => pushed.push(e);
    mon = new DesktopMonitor(dm);
    mon.updateDesktopIfChanged(makeFile('/home/u/Desktop/a.txt'), null, Gio.FileMonitorEvent.CHANGED);
    assertEqual(pushed.length, 0, 'CHANGED dropped');

    // 2. CHANGES_DONE_HINT is queued for incremental refresh
    mon.updateDesktopIfChanged(makeFile('/home/u/Desktop/a.txt'), null, Gio.FileMonitorEvent.CHANGES_DONE_HINT);
    assertEqual(pushed.length, 1, 'CHANGES_DONE_HINT queued');
    assertEqual(pushed[0].eventType, Gio.FileMonitorEvent.CHANGES_DONE_HINT, 'queued event type');

    // 3. hidden files are dropped when showHidden is off
    mon.updateDesktopIfChanged(makeFile('/home/u/Desktop/.secret'), null, Gio.FileMonitorEvent.CHANGES_DONE_HINT);
    assertEqual(pushed.length, 1, 'hidden file dropped');

    // 4. hidden->visible rename passes (old hidden, new visible)
    mon.updateDesktopIfChanged(makeFile('/home/u/Desktop/.old'), makeFile('/home/u/Desktop/new.txt'),
        Gio.FileMonitorEvent.RENAMED);
    assertEqual(pushed.length, 2, 'hidden->visible rename passes filter');

    // 5. keep-arranged short-circuits everything to a full refresh
    dm = makeDm({ keepArranged: true });
    refreshed = 0;
    dm._updateDesktopSafe = () => { refreshed += 1; };
    pushed = [];
    dm._fileChangesQueue.push = e => pushed.push(e);
    mon = new DesktopMonitor(dm);
    mon.updateDesktopIfChanged(makeFile('/home/u/Desktop/a.txt'), null, Gio.FileMonitorEvent.DELETED);
    assertEqual(pushed.length, 0, 'keep-arranged: nothing queued');
    assertEqual(refreshed, 1, 'keep-arranged: full refresh scheduled');

    // 6. ATTRIBUTE_CHANGED on the desktop dir itself -> writable check
    dm = makeDm();
    refreshed = 0;
    dm._updateDesktopSafe = () => { refreshed += 1; };
    dm.updateWritableByOthers = () => true;
    pushed = [];
    dm._fileChangesQueue.push = e => pushed.push(e);
    mon = new DesktopMonitor(dm);
    mon.updateDesktopIfChanged(makeFile('/home/u/Desktop'), null, Gio.FileMonitorEvent.ATTRIBUTE_CHANGED);
    assertEqual(pushed.length, 0, 'dir attribute change not queued');
    assertEqual(refreshed, 1, 'dir attribute change triggers refresh when writability flipped');

    // 7. ATTRIBUTE_CHANGED on a child file is queued (P1 behaviour)
    dm = makeDm();
    pushed = [];
    dm._fileChangesQueue.push = e => pushed.push(e);
    mon = new DesktopMonitor(dm);
    mon.updateDesktopIfChanged(makeFile('/home/u/Desktop/a.txt'), null, Gio.FileMonitorEvent.ATTRIBUTE_CHANGED);
    assertEqual(pushed.length, 1, 'child attribute change queued');

    /* ---------- processIncrementalEvents: routing ---------- */

    // 8. RENAMED arg-order contract: event.file=OLD, event.otherFile=NEW
    //    (verified empirically on GLib inotify); handleFileRenamed must
    //    receive (newFile, oldFile).
    const oldFile = makeFile('/home/u/Desktop/a.txt');
    const newFile = makeFile('/home/u/Desktop/b.txt');
    let renamedArg = null;
    let movedUri = null;
    dm = makeDm({
        _fileList: [makeItem('/home/u/Desktop/a.txt', {
            onFileRenamed: f => { renamedArg = f; },
        })],
        _desktops: [{
            updateFileItemUri: (oldUri, newUri) => { movedUri = [oldUri, newUri]; },
        }],
    });
    mon = new DesktopMonitor(dm);
    await mon.processIncrementalEvents([makeEvent(oldFile, newFile, Gio.FileMonitorEvent.RENAMED)]);
    assert(renamedArg === newFile, 'RENAMED: item.onFileRenamed receives the NEW file');
    assertEqual(movedUri[0], oldFile.get_uri(), 'RENAMED: grid map updated from old URI');
    assertEqual(movedUri[1], newFile.get_uri(), 'RENAMED: grid map updated to new URI');

    // 9. RENAMED with unknown old path falls back to a full refresh
    dm = makeDm();
    refreshed = 0;
    dm._updateDesktopSafe = () => { refreshed += 1; };
    mon = new DesktopMonitor(dm);
    await mon.processIncrementalEvents([makeEvent(oldFile, newFile, Gio.FileMonitorEvent.RENAMED)]);
    assertEqual(refreshed, 1, 'RENAMED unknown old path -> full refresh fallback');

    // 10. CHANGES_DONE_HINT refreshes a tracked item in place
    refreshed = 0;
    dm = makeDm({
        _fileList: [makeItem('/home/u/Desktop/a.txt')],
        getFileItemFromURI: uri => dm._fileList.find(f => f.uri === uri) ?? null,
    });
    dm._updateDesktopSafe = () => { refreshed += 1; };
    const item = dm._fileList[0];
    item.updatedMetadata = () => { item.updated = true; };
    mon = new DesktopMonitor(dm);
    await mon.processIncrementalEvents([makeEvent(makeFile('/home/u/Desktop/a.txt'), null, Gio.FileMonitorEvent.CHANGES_DONE_HINT)]);
    assert(item.updated === true, 'CHANGES_DONE_HINT refreshes tracked item');
    assertEqual(refreshed, 0, 'CHANGES_DONE_HINT tracked: no full refresh');

    // 11. CHANGES_DONE_HINT on an untracked file is a silent no-op
    dm = makeDm(); // getFileItemFromURI -> null
    refreshed = 0;
    dm._updateDesktopSafe = () => { refreshed += 1; };
    mon = new DesktopMonitor(dm);
    await mon.processIncrementalEvents([makeEvent(makeFile('/home/u/Desktop/a.txt'), null, Gio.FileMonitorEvent.CHANGES_DONE_HINT)]);
    assertEqual(refreshed, 0, 'CHANGES_DONE_HINT untracked: no full refresh');

    // 12. MOVED_DELETED (numeric 12 — not exposed by the Gio GIR) removes
    //     the tracked item incrementally
    let removed = 0;
    dm = makeDm({
        _fileList: [makeItem('/home/u/Desktop/a.txt', {
            removeFromGrid: () => { removed += 1; },
        })],
    });
    refreshed = 0;
    dm._updateDesktopSafe = () => { refreshed += 1; };
    mon = new DesktopMonitor(dm);
    await mon.processIncrementalEvents([makeEvent(makeFile('/home/u/Desktop/a.txt'), null, 12)]);
    assertEqual(removed, 1, 'MOVED_DELETED removes the icon');
    assertEqual(dm._fileList.length, 0, 'MOVED_DELETED removes the item from the list');
    assertEqual(refreshed, 0, 'MOVED_DELETED tracked: no full refresh');

    // 13. MOVED_OUT without otherFile (drag into subfolder) = incremental delete
    removed = 0;
    dm = makeDm({
        _fileList: [makeItem('/home/u/Desktop/a.txt', {
            removeFromGrid: () => { removed += 1; },
        })],
    });
    refreshed = 0;
    dm._updateDesktopSafe = () => { refreshed += 1; };
    mon = new DesktopMonitor(dm);
    await mon.processIncrementalEvents([makeEvent(makeFile('/home/u/Desktop/a.txt'), null, Gio.FileMonitorEvent.MOVED_OUT)]);
    assertEqual(removed, 1, 'MOVED_OUT(null) removes the icon');
    assertEqual(refreshed, 0, 'MOVED_OUT(null): no full refresh');

    // 14. DELETED on an unknown file -> full refresh fallback
    dm = makeDm();
    refreshed = 0;
    dm._updateDesktopSafe = () => { refreshed += 1; };
    mon = new DesktopMonitor(dm);
    await mon.processIncrementalEvents([makeEvent(makeFile('/home/u/Desktop/ghost.txt'), null, Gio.FileMonitorEvent.DELETED)]);
    assertEqual(refreshed, 1, 'DELETED unknown path -> full refresh fallback');

    // 15. batch overflow guard: > maxIncremental events -> full refresh
    dm = makeDm({
        _fileChangesQueue: { maxIncremental: 2 },
        _fileList: [makeItem('/home/u/Desktop/a.txt'), makeItem('/home/u/Desktop/b.txt')],
    });
    refreshed = 0;
    dm._updateDesktopSafe = () => { refreshed += 1; };
    mon = new DesktopMonitor(dm);
    await mon.processIncrementalEvents([
        makeEvent(makeFile('/home/u/Desktop/a.txt'), null, Gio.FileMonitorEvent.DELETED),
        makeEvent(makeFile('/home/u/Desktop/b.txt'), null, Gio.FileMonitorEvent.DELETED),
        makeEvent(makeFile('/home/u/Desktop/c.txt'), null, Gio.FileMonitorEvent.DELETED),
    ]);
    assertEqual(refreshed, 1, 'batch > maxIncremental -> full refresh');

    // 16. unknown event type -> full refresh
    dm = makeDm();
    refreshed = 0;
    dm._updateDesktopSafe = () => { refreshed += 1; };
    mon = new DesktopMonitor(dm);
    await mon.processIncrementalEvents([makeEvent(makeFile('/home/u/Desktop/a.txt'), null, Gio.FileMonitorEvent.MOVED)]);
    assertEqual(refreshed, 1, 'unhandled event type -> full refresh');

    return summary('DesktopMonitor');
}
