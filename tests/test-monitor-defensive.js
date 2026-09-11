/* Regression tests for defensive directory-monitor creation.
 *
 * Gio.File.monitor_directory() fails transiently when inotify instances are
 * exhausted ("Unable to find default local file monitor type" — seen in this
 * machine's journal, including from gnome-control-center). Any exception
 * escaping that call aborted the calling constructor: for DesktopManager
 * construction it ran after mainApp.hold(), so the DING process stayed alive
 * with no desktop and the shell extension never relaunched it (audit
 * 2026-09-11). The helper must never throw and must retry with backoff. */
import * as DesktopIconsUtil from '../app/desktop-icons-util.js';
import { ThemeManager } from '../app/theme-manager.js';
import { assert, assertEqual, summary, flushLoop } from './harness.js';

function makeFile({ failures = 0, monitor = { rateLimit: 0, set_rate_limit(v) { this.rateLimit = v; } } } = {}) {
    const state = { calls: 0 };
    return {
        state,
        get_path: () => '/tmp/example-dir',
        monitor_directory() {
            state.calls += 1;
            if (state.calls <= failures) {
                throw new Error('Unable to find default local file monitor type');
            }
            return monitor;
        },
    };
}

export async function runTests() {
    if (typeof DesktopIconsUtil.monitorDirectoryDefensively !== 'function') {
        assert(false, 'monitorDirectoryDefensively must exist');
        return summary('monitor-defensive');
    }

    // 1. Success path: the monitor is handed over with its rate limit applied.
    {
        const file = makeFile({});
        const got = [];
        DesktopIconsUtil.monitorDirectoryDefensively(file, {
            flags: 'WATCH_MOVES',
            label: 'the Desktop folder',
            rateLimit: 1000,
            retryDelaysMs: [10],
            onMonitor: m => got.push(m),
        });
        assertEqual(got.length, 1, 'a successful creation hands the monitor to onMonitor');
        assertEqual(got[0].rateLimit, 1000, 'the rate limit is applied');
        assertEqual(file.state.calls, 1, 'no retry after success');
    }

    // 2. Transient failure: retried, then handed over.
    {
        const file = makeFile({ failures: 1 });
        const got = [];
        DesktopIconsUtil.monitorDirectoryDefensively(file, {
            flags: 'WATCH_MOVES',
            label: 'the Desktop folder',
            retryDelaysMs: [10],
            onMonitor: m => got.push(m),
        });
        assertEqual(got.length, 0, 'nothing is handed over on the failed attempt');
        await flushLoop(60);
        assertEqual(got.length, 1, 'the retry recreates and hands over the monitor');
        assertEqual(file.state.calls, 2, 'exactly one retry was needed');
    }

    // 3. Permanent failure: no throw, bounded retries, then give up quietly.
    {
        const file = makeFile({ failures: 99 });
        let threw = null;
        try {
            DesktopIconsUtil.monitorDirectoryDefensively(file, {
                flags: 'WATCH_MOVES',
                label: 'the Desktop folder',
                retryDelaysMs: [10, 10],
                onMonitor: () => {},
            });
        } catch (e) {
            threw = e.message;
        }
        assertEqual(threw, null, 'monitor creation failures never propagate');
        await flushLoop(80);
        assertEqual(file.state.calls, 3, 'initial attempt plus two bounded retries');
    }

    // 4. ThemeManager.disconnect() tolerates a monitor that was never created
    //    (its field used to stay undefined when creation threw, and the
    //    `!== null` guard dereferenced it during shutdown).
    {
        const tm = Object.create(ThemeManager.prototype);
        tm._userCssMonitor = undefined;
        tm._userCssMonitorSignalId = undefined;
        tm._adwStyleManagerSignalId = undefined;
        tm._userCssChangeTimeoutId = undefined;
        tm._cssColorProviderSelection = null;
        let threw = null;
        try {
            ThemeManager.prototype.disconnect.call(tm);
        } catch (e) {
            threw = e.message;
        }
        assertEqual(threw, null, 'disconnect() tolerates a monitor that was never created');
    }

    return summary('monitor-defensive');
}
