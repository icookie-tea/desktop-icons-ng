/* Drive context-menu action tests (Nautilus alignment).
 *
 * FileItemMenu.driveMenuActions() decides which of Eject/Unmount appear for
 * a selected drive icon. Aligns with Nautilus (nautilus-files-view.c
 * file_should_show_foreach): never show both — Eject is a superset of
 * Unmount for ejectable media; Unmount is the fallback for non-ejectable
 * mounts (network shares, loop devices).
 */
import { FileItemMenu } from '../app/file-item-menu.js';
import { assertEqual, summary } from './harness.js';

function actionsFor({ isDrive = true, canEject = false, canUnmount = false }, selectedItemsNum = 1) {
    return FileItemMenu.driveMenuActions(
        { isDrive, canEject, canUnmount }, selectedItemsNum);
}

function runTests() {
    // Ejectable + unmountable (typical USB stick): Eject only
    {
        const actions = actionsFor({ canEject: true, canUnmount: true });
        assertEqual(actions.length, 1, 'USB stick offers exactly one action');
        assertEqual(actions[0]?.[1], 'eject-drive', 'USB stick action is Eject');
    }
    // Ejectable only
    {
        const actions = actionsFor({ canEject: true, canUnmount: false });
        assertEqual(actions.length, 1, 'ejectable-only drive offers one action');
        assertEqual(actions[0]?.[1], 'eject-drive', 'ejectable-only action is Eject');
    }
    // Non-ejectable mount (network share / loop): Unmount only
    {
        const actions = actionsFor({ canEject: false, canUnmount: true });
        assertEqual(actions.length, 1, 'network mount offers exactly one action');
        assertEqual(actions[0]?.[1], 'umount-drive', 'network mount action is Unmount');
    }
    // Neither capability: nothing
    {
        assertEqual(actionsFor({ canEject: false, canUnmount: false }).length, 0,
            'incapable drive offers no action');
    }
    // Non-drive item: nothing, regardless of capabilities
    {
        assertEqual(actionsFor({ isDrive: false, canEject: true, canUnmount: true }).length, 0,
            'non-drive items never get drive actions');
    }
    // Multi-selection: nothing (drive actions are per-item)
    {
        assertEqual(actionsFor({ canEject: true, canUnmount: true }, 2).length, 0,
            'multi-selection offers no drive action');
    }
    return summary('drive-menu');
}

export { runTests };
