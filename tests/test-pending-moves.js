/* Regression tests for pending incremental moves.
 *
 * Bug (audit 2026-09-11): every pending move shared one _moveTimeoutId.
 * handleMovedOut() removed whatever timeout was armed and re-armed only its
 * own, so when two MOVED_OUT events arrived within MOVE_PENDING_TIMEOUT_MS
 * the first entry never expired: its FileItem was never deleted (stale icon)
 * until a full refresh, and a later MOVED_IN could match the stale pair and
 * rename the wrong item. */
import { DesktopMonitor } from '../app/desktop-monitor.js';
import { assertEqual, summary, flushLoop } from './harness.js';

function makeMonitor() {
    const monitor = Object.create(DesktopMonitor.prototype);
    const dm = {
        _pendingMoves: {},
        _pendingMoveTimeouts: {},
        _desktopDir: { get_path: () => '/desktop' },
        _renamingFile: null,
        _desktops: [],
        _fileList: [],
    };
    monitor._dm = dm;
    monitor._deleted = [];
    monitor.handleFileDeleted = file => {
        monitor._deleted.push(file.get_path());
        return true;
    };
    return monitor;
}

export async function runTests() {
    const monitor = makeMonitor();
    const dm = monitor._dm;

    monitor.handleMovedOut({ get_path: () => '/desktop/a.txt' },
        { get_path: () => '/desktop/a-renamed.txt' });
    monitor.handleMovedOut({ get_path: () => '/desktop/b.txt' },
        { get_path: () => '/desktop/b-renamed.txt' });

    assertEqual(JSON.stringify(Object.keys(dm._pendingMoves).sort()), '["/desktop/a.txt","/desktop/b.txt"]',
        'both moves are registered as pending');
    assertEqual(Object.keys(dm._pendingMoveTimeouts ?? {}).length, 2,
        'each pending move owns its own timeout');

    // Let both timeouts fire (MOVE_PENDING_TIMEOUT_MS is 150 ms).
    await flushLoop(400);

    assertEqual(JSON.stringify(dm._pendingMoves), '{}',
        'all pending moves expire');
    assertEqual(monitor._deleted.length, 2,
        'every expired move goes through handleFileDeleted');

    return summary('pending-moves');
}
