/* Regression tests for the thumbnail queue.
 *
 * Bugs (audit 2026-09-11):
 * - per-build state lived on `this` (_doCancel/_timeoutID): when the 5 s
 *   timeout fired while a generate/save callback was already in flight, the
 *   failed-thumbnail path installed a new cancellable, so the still-running
 *   generate callback saved with the fresh (uncancelled) one and BOTH paths
 *   completed, each launching a new build (races on the thumbnail cache).
 * - _launchNewBuild() skipped destroyed items without resolving, so the
 *   caller's promise never settled (leaked the awaiting _updateIcon frame).
 * - the valid-failed-thumbnail shortcut ignored _resolveThumbnail()'s false
 *   return, hanging the promise. */
import { ThumbnailLoader } from '../app/thumbnails.js';
import { assertEqual, summary, flushLoop } from './harness.js';

function makeLoader({ generateCallback = null, failedThumbnail = false } = {}) {
    const loader = Object.create(ThumbnailLoader.prototype);
    loader._timeoutValue = 10;
    loader._thumbList = [];
    loader._running = true;
    loader._useAsyncAPI = true;
    loader._launches = 0;
    loader._saves = 0;
    // Mirrors the real contract: resolves and returns true when the
    // factory has a thumbnail, returns false (leaving the promise pending)
    // when the lookup misses.
    loader._resolveThumbnail = (file, resolve) => {
        resolve('thumb');
        return true;
    };
    loader._launchNewBuild = () => {
        loader._launches += 1;
    };
    loader._thumbnailFactoryLarge = {
        has_valid_failed_thumbnail: () => failedThumbnail,
        generate_thumbnail_async(uri, type, cancellable, callback) {
            if (generateCallback) {
                generateCallback(callback);
            }
        },
        save_thumbnail_async() {
            loader._saves += 1;
        },
        create_failed_thumbnail_async(uri, modifiedTime, cancellable, callback) {
            callback({ create_failed_thumbnail_finish: () => true }, null);
        },
    };
    return loader;
}

function makeFile() {
    return {
        uri: 'file:///desktop/pic.png',
        displayName: 'pic.png',
        modifiedTime: 1,
        _destroyed: false,
        file: {
            query_exists: () => true,
            query_info: () => ({
                get_attribute_uint64: () => 1,
                get_content_type: () => 'image/png',
            }),
        },
    };
}

export async function runTests() {
    // 1. A destroyed item resolves instead of leaking its promise.
    {
        const loader = makeLoader();
        let resolved = 0;
        let value = 'unset';
        loader._thumbList = [[{ _destroyed: true, file: null }, v => {
            resolved += 1;
            value = v;
        }]];
        ThumbnailLoader.prototype._launchNewBuild.call(loader);
        assertEqual(resolved, 1, 'a destroyed queued item resolves its promise');
        assertEqual(value, null, 'with null');
        assertEqual(loader._launches, 0, 'no build is started for a destroyed item');
    }

    // 2. The valid-failed-thumbnail shortcut must not hang the promise.
    {
        const loader = makeLoader({ failedThumbnail: true });
        let resolved = 0;
        let value;
        loader._resolveThumbnail = () => false;
        loader._thumbList = [[makeFile(), v => {
            resolved += 1;
            value = v;
        }]];
        ThumbnailLoader.prototype._launchNewBuild.call(loader);
        assertEqual(resolved, 1, 'a missed lookup still resolves');
        assertEqual(value, null, 'with null');
    }

    // 3. A late generate completion after the timeout must not start a save
    //    nor resolve a second time.
    {
        let lateCallback = null;
        const loader = makeLoader({ generateCallback: cb => { lateCallback = cb; } });
        const file = makeFile();
        let resolved = 0;
        let value = 'unset';
        const resolve = v => {
            resolved += 1;
            value = v;
        };

        ThumbnailLoader.prototype._createThumbnailAsync.call(loader, file, resolve);
        await flushLoop(50);            // the timeout owns the build by now
        assertEqual(resolved, 1, 'the timeout resolves the promise exactly once');
        assertEqual(value, 'thumb', 'through the failed-thumbnail lookup');

        assertEqual(typeof lateCallback, 'function', 'generate was started');
        lateCallback({ generate_thumbnail_finish: () => 'pixbuf' }, null);
        assertEqual(loader._saves, 0,
            'a late generate completion does not start a save');
        assertEqual(resolved, 1, 'the promise is not resolved twice');
        assertEqual(loader._launches, 1,
            'exactly one next build is launched for the completed item');
    }

    return summary('thumbnail-queue');
}
