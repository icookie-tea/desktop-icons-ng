/* Tests for FileUtils.matchPendingDropEntry — resolves Nautilus conflict
 * renames ("name (copy).ext" / "name (副本 2).md") to pending drop coords. */
import * as FileUtils from '../app/file-utils.js';
import { assertEqual, summary } from './harness.js';

// pending map helper: basename -> [x, y, ts]
const P = (name, x = 100, y = 200, ts = 1000) => ({ [name]: [x, y, ts] });

export function runTests() {
    // 1. exact match wins
    assertEqual(FileUtils.matchPendingDropEntry(P('a.txt'), 'a.txt'), 'a.txt',
        'exact basename match');

    // 2. Nautilus conflict rename: same stem + " (copy)" suffix
    assertEqual(FileUtils.matchPendingDropEntry(P('笔记文档 (副本).md'), '笔记文档 (副本 2).md'),
        '笔记文档 (副本).md', 'Chinese copy-suffix conflict');

    assertEqual(FileUtils.matchPendingDropEntry(P('report.txt'), 'report (copy).txt'),
        'report.txt', 'English copy-suffix conflict');

    assertEqual(FileUtils.matchPendingDropEntry(P('a.txt'), 'a (another copy).txt'),
        'a.txt', 'another-copy suffix');

    // 3. different extension: no match
    assertEqual(FileUtils.matchPendingDropEntry(P('a.md'), 'a (copy).txt'), null,
        'extension mismatch rejected');

    // 4. unrelated names sharing a short prefix: no match
    assertEqual(FileUtils.matchPendingDropEntry(P('ab.txt'), 'abc (copy).txt'), null,
        'shared-prefix but no conflict-suffix boundary rejected');
    assertEqual(FileUtils.matchPendingDropEntry(P('a.txt'), 'ab (copy).txt'), null,
        'tail does not start with " ("');

    // 5. exact key present but different new name: fuzzy still applies
    assertEqual(FileUtils.matchPendingDropEntry({ 'a.txt': [1, 2, 1000], 'b.txt': [3, 4, 2000] }, 'a (copy).txt'),
        'a.txt', 'fuzzy match with multiple entries');

    // 6. newest timestamp wins on ambiguity
    const multi = {
        'doc (副本).md': [10, 10, 5000],
        'doc.md': [20, 20, 9000],
    };
    assertEqual(FileUtils.matchPendingDropEntry(multi, 'doc (副本 2).md'), 'doc.md',
        'newest pending entry wins');

    // 7. empty pending: no match
    assertEqual(FileUtils.matchPendingDropEntry({}, 'a (copy).txt'), null,
        'empty pending map');

    return summary('matchPendingDropEntry');
}
