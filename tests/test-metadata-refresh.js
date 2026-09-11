/* Regression tests for incremental metadata refreshes on a FileItem.
 *
 * Bug (audit 2026-09-11): the query_info_async callback unconditionally
 * cleared the shared _queryFileInfoCancellable and applied its result. A
 * newer refresh therefore lost its cancellable handle (so it could no longer
 * be superseded) and an older, slower query could overwrite the newer
 * metadata (name, icon, size). The callback also ran after the item was
 * destroyed. */
import { FileItem } from '../app/file-item.js';
import { assertEqual, summary } from './harness.js';

function makeItem() {
    const item = Object.create(FileItem.prototype);
    item._destroyed = false;
    item._queryFileInfoCancellable = null;
    item._applied = [];
    item._calls = [];
    item._file = {
        query_info_async(attrs, flags, priority, cancellable, callback) {
            item._calls.push({ cancellable, callback });
        },
    };
    item._updateMetadataFromFileInfo = info => item._applied.push(info);
    item._updateName = () => {};
    item._updateIcon = () => Promise.resolve();
    return item;
}

export function runTests() {
    // 1. An older query completing after a newer one must not overwrite it.
    {
        const item = makeItem();
        item._refreshMetadataAsync(true);          // query A
        item._refreshMetadataAsync(true);          // query B supersedes A
        assertEqual(item._calls.length, 2, 'two queries were started');
        const [a, b] = item._calls;

        b.callback({ query_info_finish: () => 'info B' }, null);
        a.callback({ query_info_finish: () => 'info A' }, null);

        assertEqual(JSON.stringify(item._applied), '["info B"]',
            'the stale query result is dropped');
    }

    // 2. Only the newest query may clear the shared cancellable handle.
    {
        const item = makeItem();
        item._refreshMetadataAsync(true);          // A
        const a = item._calls[0];
        item._refreshMetadataAsync(true);          // B
        const b = item._calls[1];

        assertEqual(item._queryFileInfoCancellable, b.cancellable,
            'the newest query owns the handle');

        a.callback({ query_info_finish: () => 'info A' }, null);
        assertEqual(item._queryFileInfoCancellable, b.cancellable,
            'a stale completion does not clear the newer handle');

        b.callback({ query_info_finish: () => 'info B' }, null);
        assertEqual(item._queryFileInfoCancellable, null,
            'the newest completion clears the handle');
    }

    // 3. A callback arriving after destruction must not touch state or throw.
    {
        const item = makeItem();
        item._refreshMetadataAsync(false);
        const call = item._calls[0];
        item._destroyed = true;
        let threw = null;
        try {
            call.callback({ query_info_finish: () => 'info late' }, null);
        } catch (e) {
            threw = e.message;
        }
        assertEqual(threw, null, 'a late callback does not throw');
        assertEqual(item._applied.length, 0,
            'a late callback does not apply metadata after destruction');
    }

    return summary('metadata-refresh');
}
