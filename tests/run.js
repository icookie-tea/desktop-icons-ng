#!/usr/bin/env gjs
/* DING unit test runner.
 *
 * Usage: gjs tests/run.js   (from the repository root)
 */
'use strict';
const GLib = imports.gi.GLib;

// Make app/ and tests/ modules importable regardless of CWD.
const rootDir = GLib.get_current_dir();
imports.searchPath.unshift(GLib.build_filenamev([rootDir, 'app']));
imports.searchPath.unshift(GLib.build_filenamev([rootDir, 'tests']));

const tests = [
    imports['test-file-changes-queue'],
    imports['test-pending-drop'],
    imports['test-sort-manager'],
    imports['test-drop-filename'],
];

async function main() {
    let failedTotal = 0;
    for (const mod of tests) {
        const failed = await mod.runTests();
        failedTotal += failed;
    }
    print(failedTotal === 0 ? 'ALL TESTS PASSED' : `${failedTotal} TEST GROUP(S) FAILED`);
    return failedTotal === 0 ? 0 : 1;
}

main().then(code => {
    imports.system.exit(code);
});
