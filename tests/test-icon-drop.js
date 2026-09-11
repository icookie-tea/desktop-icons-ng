/* Regression tests for folder-icon drag & drop.
 *
 * Bug (audit 2026-09-11): manageIconDrop() collapsed a COPY|MOVE offer to
 * Gdk.DragAction.ASK, and the FileItem drop handler treats anything that is
 * not exactly MOVE as a copy — so dropping files onto a folder icon always
 * copied, even for a move. Plain-text drops were passed to
 * Move/CopyURIsRemote as if the text were a URI (while the desktop writes
 * "Dropped Text.txt"). */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk';
import * as DndClipboardUtils from '../app/dnd-clipboard-utils.js';
import { assert, assertEqual, summary } from './harness.js';

export async function runTests() {
    assertEqual(typeof DndClipboardUtils.resolveDropAction, 'function',
        'resolveDropAction exists so the drop semantics are unit-testable');
    if (typeof DndClipboardUtils.resolveDropAction !== 'function') {
        return summary('icon-drop');
    }

    // 1. Action resolution: a move-capable drag on a folder icon must move.
    {
        assertEqual(DndClipboardUtils.resolveDropAction(Gdk.DragAction.COPY),
            Gdk.DragAction.COPY, 'copy-only drags copy');
        assertEqual(DndClipboardUtils.resolveDropAction(Gdk.DragAction.MOVE),
            Gdk.DragAction.MOVE, 'move-only drags move');
        assertEqual(DndClipboardUtils.resolveDropAction(Gdk.DragAction.COPY | Gdk.DragAction.MOVE),
            Gdk.DragAction.MOVE,
            'copy+move drags move instead of collapsing to ASK (which copied)');
        assertEqual(DndClipboardUtils.resolveDropAction(Gdk.DragAction.ASK),
            Gdk.DragAction.COPY, 'an unusable action falls back to copy');
    }

    // 2. Text dropped on a folder becomes a file inside that folder.
    if (typeof DndClipboardUtils.writeTextIntoFolder === 'function') {
        const dir = Gio.File.new_for_path(GLib.dir_make_tmp('ding-drop-test-XXXXXX'));
        try {
            const existing = dir.get_child('hello world.txt');
            existing.replace_contents('old\n', null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

            DndClipboardUtils.writeTextIntoFolder(dir, 'hello world');

            const written = dir.get_child('hello world (1).txt');
            assert(written.query_exists(null),
                'the text file is written into the folder under a unique name');
            const [, bytes] = written.load_contents(null);
            assertEqual(new TextDecoder().decode(bytes), 'hello world\n',
                'the dropped text is the file content');
        } finally {
            // Manual cleanup: FileUtils.deleteFile needs the *_async_promise
            // helpers that ding.js installs at startup (absent in tests).
            try {
                const children = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                let info;
                while ((info = children.next_file(null)) !== null) {
                    dir.get_child(info.get_name()).delete(null);
                }
                children.close(null);
                dir.delete(null);
            } catch (e) {
                print(`cleanup failed for ${dir.get_path()}: ${e.message}`);
            }
        }
    } else {
        assert(false, 'writeTextIntoFolder must exist');
    }

    return summary('icon-drop');
}
