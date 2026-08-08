/* Regression tests for the Nautilus Scripts submenu (P0-3 audit fix):
 * - TemplatesScriptsManager must emit a script-specific action
 *   (app.create-script) for executable entries, while templates keep
 *   emitting app.create-template.
 * - Empty listings yield null (no submenu).
 * - Sub-directories recurse into nested submenus.
 *
 * Bug (fixed): the Scripts submenu was created in file-item-menu.js but
 * never appended (append_submenu missing), so the whole Nautilus-scripts
 * feature silently died; additionally its menu items pointed at the
 * template action (app.create-template), which would spawn the script as
 * a template even if the submenu were restored.
 */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as TemplatesScriptsManager from '../app/templates-scripts-manager.js';
import { assert, assertEqual, summary } from './harness.js';

function makeManager(flags) {
    // null baseFolder: constructor skips GFileMonitor setup (see
    // constructor: entriesDir stays null), so this is headless-safe.
    return new TemplatesScriptsManager.TemplatesScriptsManager(null, flags);
}

function itemAction(menu, i) {
    const action = menu.get_item_attribute_value(i, 'action', GLib.VariantType.new('s'));
    return action === null ? null : action.get_string()[0];
}

function itemTarget(menu, i) {
    const target = menu.get_item_attribute_value(i, 'target', GLib.VariantType.new('s'));
    return target === null ? null : target.get_string()[0];
}

export function runTests() {
    // --- A: executable mode uses the script action ---
    {
        const manager = makeManager(
            TemplatesScriptsManager.TemplatesScriptsManagerFlags.ONLY_EXECUTABLE);
        manager._entries = [['script.sh', '/tmp/script.sh', null]];
        const menu = manager.createMenu();
        assert(menu !== null, 'createMenu() must not be null for non-empty entries');
        assertEqual(menu.get_n_items(), 1, 'one entry → one menu item');
        assertEqual(itemAction(menu, 0), 'app.create-script',
            'script entries use app.create-script action');
        assertEqual(itemTarget(menu, 0), '/tmp/script.sh', 'target is the script path');
    }

    // --- B: template mode keeps the template action ---
    {
        const manager = makeManager(
            TemplatesScriptsManager.TemplatesScriptsManagerFlags.HIDE_EXTENSIONS);
        manager._entries = [['doc.txt', '/tmp/doc.txt', null]];
        const menu = manager.createMenu();
        assert(menu !== null, 'createMenu() must not be null for non-empty entries');
        assertEqual(itemAction(menu, 0), 'app.create-template',
            'template entries keep app.create-template');
    }

    // --- C: empty entries produce null (no submenu) ---
    {
        const manager = makeManager(
            TemplatesScriptsManager.TemplatesScriptsManagerFlags.ONLY_EXECUTABLE);
        manager._entries = [];
        assertEqual(manager.createMenu(), null, 'empty entries yield null');
    }

    // --- D: sub-directories recurse into submenus ---
    {
        const manager = makeManager(
            TemplatesScriptsManager.TemplatesScriptsManagerFlags.ONLY_EXECUTABLE);
        manager._entries = [
            ['sub', '/tmp/sub', [
                ['inner.sh', '/tmp/sub/inner.sh', null],
            ]],
        ];
        const menu = manager.createMenu();
        assert(menu !== null, 'createMenu() must not be null for nested entries');
        const submenu = menu.get_item_link(0, Gio.MENU_LINK_SUBMENU);
        assert(submenu !== null, 'directory entry must produce a submenu');
        assertEqual(itemAction(submenu, 0), 'app.create-script',
            'nested script uses app.create-script');
        assertEqual(itemTarget(submenu, 0), '/tmp/sub/inner.sh',
            'nested target is the script path');
    }

    return summary('ScriptsMenu');
}
