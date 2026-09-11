/* Regression tests for the desktop refresh guard.
 *
 * Bug (audit 2026-09-11): _updateDesktop() set _readingDesktopFiles = true
 * and only reset it on the normal path. Any throw — a rejected read or a
 * mid-loop _drawDesktop crash — left the flag set, so every later refresh hit
 * the guard, only set _desktopFilesChanged and returned: the desktop never
 * redrew again (incremental monitor events were dropped too) until the
 * process was restarted. */
import { DesktopManager } from '../app/desktop-manager.js';
import { assert, assertEqual, summary } from './harness.js';

function makeManager(readImpl) {
    const dm = Object.create(DesktopManager.prototype);
    dm._readingDesktopFiles = false;
    dm._desktopFilesChanged = false;
    dm._forceDraw = false;
    dm._forcedExit = false;
    dm._lastDesktopUpdateRequest = 0;
    dm._desktopDir = { query_exists: () => true };
    dm._doReadAsync = readImpl;
    dm._drawDesktop = () => {
        dm._drew = true;
    };
    dm._desktops = [];
    return dm;
}

export async function runTests() {
    // 1. A read failure must still release the guard.
    {
        const dm = makeManager(async () => {
            throw new Error('enumerate failed');
        });
        let threw = false;
        try {
            await dm._updateDesktop();
        } catch (e) {
            threw = true;
        }
        assert(threw, 'the read failure still propagates to _updateDesktopSafe');
        assertEqual(dm._readingDesktopFiles, false,
            'the guard is released after a read failure');
    }

    // 2. A later refresh must not be swallowed by a stuck guard.
    {
        let reads = 0;
        const dm = makeManager(async () => {
            reads += 1;
            if (reads === 1) {
                throw new Error('transient read failure');
            }
            return [];
        });
        try {
            await dm._updateDesktop();
        } catch (e) {
            /* expected */
        }
        await dm._updateDesktop();
        assertEqual(reads, 2, 'the following refresh really reads again');
        assert(dm._drew, 'the following refresh reaches _drawDesktop');
    }

    // 3. A mid-loop draw crash must release the guard too (this is the path
    //    that used to freeze refreshes permanently).
    {
        const dm = makeManager(async () => {
            // Simulate a file event landing during the read plus a queued
            // forced draw: the loop then draws mid-loop on this iteration.
            dm._desktopFilesChanged = true;
            dm._forceDraw = true;
            return [];
        });
        let draws = 0;
        dm._drawDesktop = () => {
            draws += 1;
            throw new Error('draw failed');
        };
        let threw = false;
        try {
            await dm._updateDesktop();
        } catch (e) {
            threw = true;
        }
        assert(threw, 'the mid-loop draw failure propagates');
        assertEqual(draws, 1, 'the mid-loop draw path was exercised');
        assertEqual(dm._readingDesktopFiles, false,
            'the guard is released after a mid-loop draw crash');
    }

    // 4. The first refresh cancels the shell's window-map watchdog (deferred
    //    window show used to risk a 6 s kill/relaunch loop on slow first
    //    reads).
    {
        const dm = makeManager(async () => []);
        assertEqual(typeof dm._disableMapWatchdog, 'function',
            '_disableMapWatchdog exists');
        if (typeof dm._disableMapWatchdog === 'function') {
            let calls = 0;
            const names = [];
            const actionGroup = {
                activate_action(name) {
                    calls += 1;
                    names.push(name);
                },
            };
            dm._disableMapWatchdog(actionGroup);
            dm._disableMapWatchdog(actionGroup);
            assertEqual(calls, 1, 'the watchdog is cancelled exactly once');
            assertEqual(names[0], 'disableTimer',
                'the shell extension disableTimer action is activated');
        }
    }

    return summary('refresh-guard');
}
