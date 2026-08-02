/* DING test harness — minimal assertion + main-loop helpers.
 *
 * Run via `gjs tests/run.js` (or `scripts/check.sh`). No external deps.
 */
import GLib from 'gi://GLib';

export var passed = 0;
export var failed = 0;
export var failures = [];

export function assert(cond, msg) {
    if (cond) {
        passed += 1;
    } else {
        failed += 1;
        failures.push(msg);
        print(`FAIL: ${msg}`);
    }
}

export function assertEqual(a, b, msg) {
    if (a === b) {
        passed += 1;
    } else {
        failed += 1;
        failures.push(`${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
        print(`FAIL: ${msg} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
    }
}

export function assertDeepEqual(a, b, msg) {
    const ja = JSON.stringify(a);
    const jb = JSON.stringify(b);
    if (ja === jb) {
        passed += 1;
    } else {
        failed += 1;
        failures.push(`${msg} (expected ${jb}, got ${ja})`);
        print(`FAIL: ${msg} — expected ${jb}, got ${ja}`);
    }
}

/** Runs the GLib main loop for `ms` milliseconds, then resolves. */
export function flushLoop(ms) {
    return new Promise(resolve => {
        const loop = GLib.MainLoop.new(null, false);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            loop.quit();
            return GLib.SOURCE_REMOVE;
        });
        loop.run();
        resolve();
    });
}

export function summary(name) {
    if (failed === 0) {
        print(`PASS ${name}: ${passed} assertions`);
    } else {
        print(`FAIL ${name}: ${failed} failed, ${passed} passed`);
    }
    return failed;
}
