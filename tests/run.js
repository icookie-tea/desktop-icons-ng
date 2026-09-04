#!/usr/bin/env -S gjs --module
/* DING unit test runner.
 *
 * Usage: gjs --module tests/run.js   (from the repository root)
 */
import System from 'system';

import * as TestFileChangesQueue from './test-file-changes-queue.js';
import * as TestDesktopMonitor from './test-desktop-monitor.js';
import * as TestPendingDrop from './test-pending-drop.js';
import * as TestGridLayout from './test-grid-layout.js';
import * as TestSortManager from './test-sort-manager.js';
import * as TestDropFilename from './test-drop-filename.js';
import * as TestClickCoordinates from './test-click-coordinates.js';
import * as TestLinkEmblem from './test-link-emblem.js';
import * as TestScriptsMenu from './test-scripts-menu.js';
import * as TestDriveMenu from './test-drive-menu.js';
import * as TestThemeAccent from './test-theme-accent.js';
import * as TestTitleProtocol from './test-title-protocol.js';
import * as TestVolumeMount from './test-volume-mount.js';

const tests = [
    TestFileChangesQueue,
    TestDesktopMonitor,
    TestPendingDrop,
    TestGridLayout,
    TestSortManager,
    TestDropFilename,
    TestClickCoordinates,
    TestLinkEmblem,
    TestScriptsMenu,
    TestDriveMenu,
    TestThemeAccent,
    TestTitleProtocol,
    TestVolumeMount,
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
    System.exit(code);
});
