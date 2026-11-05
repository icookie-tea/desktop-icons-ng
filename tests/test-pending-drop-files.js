/* Pending drop coordinates (dm._pendingDropFiles) bookkeeping.
 *
 * The TTL (5 min) and the 64-entry cap used to run only from
 * applyDropCoordinates(), i.e. only when a later drop successfully matched a
 * new desktop file and had coordinates applied. A copy that failed (or a
 * filename that never appeared) left its entry behind for the rest of the
 * session, and the map could keep growing between two matching drops.
 * Entries are now pruned on insertion as well (audit 2026-09-11). */
import Gio from 'gi://Gio';
import { DesktopMonitor } from '../app/desktop-monitor.js';
import { FileOperations } from '../app/file-operations.js';
import { assert, assertDeepEqual, assertEqual, summary } from './harness.js';

function makeMonitor(pending = {}) {
    const monitor = Object.create(DesktopMonitor.prototype);
    monitor._dm = { _pendingDropFiles: pending };
    return monitor;
}

export function runTests() {
    if (typeof DesktopMonitor.prototype.addPendingDropFile !== 'function') {
        assert(false, 'DesktopMonitor.addPendingDropFile() does not exist yet');
        return summary('pending-drop-files');
    }

    // 1. Entries start with [x, y, timestamp]; an optional fourth field lists
    //    pre-existing URIs which must not consume this pending drop.
    {
        const monitor = makeMonitor();
        monitor.addPendingDropFile('a.txt', [12, 34]);
        const entry = monitor._dm._pendingDropFiles['a.txt'];
        assertEqual(entry[0], 12, 'x is stored');
        assertEqual(entry[1], 34, 'y is stored');
        assertEqual(typeof entry[2], 'number', 'a timestamp is stored for the TTL');
    }

    // 2. expired entries are dropped when a new one is added
    {
        const monitor = makeMonitor({ stale: [1, 2, Date.now() - 6 * 60 * 1000] });
        monitor.addPendingDropFile('fresh.txt', [3, 4]);
        assert(!('stale' in monitor._dm._pendingDropFiles),
            'an expired entry is dropped on insertion');
        assert('fresh.txt' in monitor._dm._pendingDropFiles,
            'the new entry survives the prune');
    }

    // 3. entries without a timestamp (legacy/foreign writers) do not survive
    {
        const monitor = makeMonitor({ untimed: [1, 2] });
        monitor.addPendingDropFile('fresh.txt', [3, 4]);
        assert(!('untimed' in monitor._dm._pendingDropFiles),
            'an entry without timestamp is dropped');
    }

    // 4. the map stays capped at 64 entries, dropping the oldest ones
    {
        const pending = {};
        const base = Date.now() - 60000;
        for (let i = 0; i < 80; i++) {
            pending[`old${i}.txt`] = [i, i, base + i];
        }
        const monitor = makeMonitor(pending);
        monitor.addPendingDropFile('newest.txt', [0, 0]);
        const keys = Object.keys(monitor._dm._pendingDropFiles);
        assert(keys.length <= 64, `the map stays capped (got ${keys.length})`);
        assert(keys.includes('newest.txt'), 'the newest entry is kept');
        assert(!keys.includes('old0.txt'), 'the oldest entry is dropped first');
    }

    // Copying seeds the destination's pending drop without changing source
    // metadata. A move still clears the position that follows the source.
    for (const copy of [true, false]) {
        const monitor = makeMonitor();
        const writes = [];
        const source = {
            is_native: () => true,
            query_exists: () => true,
            get_basename: () => 'source.txt',
            set_attributes_from_info: info => writes.push(info.dup()),
        };
        const originalNewForUri = Gio.File.new_for_uri;
        try {
            Gio.File.new_for_uri = () => source;
            const dm = {
                _monitor: monitor,
                _pendingDropFiles: monitor._dm._pendingDropFiles,
                _fileList: [{ uri: 'file:///Desktop/source.txt' }],
            };
            new FileOperations(dm).clearFileCoordinates(['file:///source.txt'], [12, 34], { copy });
        } finally {
            Gio.File.new_for_uri = originalNewForUri;
        }
        assertEqual(writes.length, copy ? 0 : 1, 'only moving modifies source position metadata');
        assertDeepEqual(monitor._dm._pendingDropFiles['source.txt'].slice(0, 2), [12, 34],
            'both copying and moving seed the destination drop');
        if (!copy) {
            assertEqual(writes[0].get_attribute_as_string('metadata::nautilus-icon-position'), '',
                'moving clears the previous legacy position');
        }
        const existing = {
            uri: 'file:///Desktop/source.txt',
            file: { get_basename: () => 'source.txt' },
            dropCoordinates: null,
        };
        monitor.applyDropCoordinates(existing);
        assertEqual(existing.dropCoordinates, null, 'enumerating existing icons does not steal a drop');
        assert('source.txt' in monitor._dm._pendingDropFiles, 'the new destination still has a pending drop');
        if (copy) {
            monitor.applyDropCoordinates({
                ...existing,
                uri: 'file:///source.txt',
            });
            assert('source.txt' in monitor._dm._pendingDropFiles, 'a copied source cannot consume the drop either');
        }
        const destination = {
            uri: 'file:///Desktop/source%20(copy).txt',
            file: { get_basename: () => 'source (copy).txt' },
            dropCoordinates: null,
        };
        monitor.applyDropCoordinates(destination);
        assertDeepEqual(destination.dropCoordinates.slice(0, 2), [12, 34], 'conflict-renamed destination receives its drop');
        assertEqual(Object.keys(monitor._dm._pendingDropFiles).length, 0, 'destination consumes the pending entry once');
    }

    {
        const monitor = makeMonitor({ 'expired.txt': [12, 34, Date.now() - 6 * 60 * 1000] });
        const fileItem = { file: { get_basename: () => 'expired.txt' }, dropCoordinates: null };
        monitor.applyDropCoordinates(fileItem);
        assertEqual(fileItem.dropCoordinates, null, 'expired drop is pruned before it can move a file');
    }

    return summary('pending-drop-files');
}
