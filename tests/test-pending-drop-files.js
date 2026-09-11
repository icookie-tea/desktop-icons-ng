/* Pending drop coordinates (dm._pendingDropFiles) bookkeeping.
 *
 * The TTL (5 min) and the 64-entry cap used to run only from
 * applyDropCoordinates(), i.e. only when a later drop successfully matched a
 * new desktop file and had coordinates applied. A copy that failed (or a
 * filename that never appeared) left its entry behind for the rest of the
 * session, and the map could keep growing between two matching drops.
 * Entries are now pruned on insertion as well (audit 2026-09-11). */
import { DesktopMonitor } from '../app/desktop-monitor.js';
import { assert, assertEqual, summary } from './harness.js';

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

    // 1. the stored shape is [x, y, timestamp] (matchPendingDropEntry and the
    //    drop-coordinate consumers expect exactly that)
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

    return summary('pending-drop-files');
}
