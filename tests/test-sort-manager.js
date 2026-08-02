/* Tests for SortManager comparator logic.
 *
 * NOTE (known quirk, locked as current behaviour): the comparators pass
 * localeCompare options as the SECOND argument (locales position):
 *   a.localeCompare(b, {sensitivity: 'accent', numeric: 'true', ...})
 * Engines silently ignore an options object in the locales slot, so the
 * sort is plain default localeCompare (no case folding, no numeric
 * collation). A fix (options as 3rd argument) is proposed in
 * docs/fixes.md; until then these tests pin the ACTUAL order.
 */
import { SortManager } from '../app/sort-manager.js';
import { assertDeepEqual, summary } from './harness.js';

function mockItem(name, contentType) {
    return {
        _label: { get_text: () => name },
        attributeContentType: contentType,
    };
}

function names(list) {
    return list.map(i => i._label.get_text());
}

export function runTests() {
    // SortManager only stores its desktopManager; comparators don't use it.
    const sm = new SortManager({});

    // 1. _sortByName: plain lexical order (options are ignored — see note)
    let list = [
        mockItem('file2.txt', 'text/plain'),
        mockItem('File10.txt', 'text/plain'),
        mockItem('file1.txt', 'text/plain'),
    ];
    sm._sortByName(list);
    assertDeepEqual(names(list), ['file1.txt', 'File10.txt', 'file2.txt'],
        'lexical order (File10 before file2 — numeric collation not active)');

    list = [
        mockItem('b.txt', 'text/plain'),
        mockItem('A.txt', 'text/plain'),
        mockItem('c.txt', 'text/plain'),
    ];
    sm._sortByName(list);
    assertDeepEqual(names(list), ['A.txt', 'b.txt', 'c.txt'],
        'uppercase sorts before lowercase');

    // 2. _sortByKindByName: groups by content type, name order inside group
    list = [
        mockItem('zebra.txt', 'text/plain'),
        mockItem('alpha.png', 'image/png'),
        mockItem('mango.txt', 'text/plain'),
        mockItem('beta.png', 'image/png'),
    ];
    sm._sortByKindByName(list);
    assertDeepEqual(names(list),
        ['alpha.png', 'beta.png', 'mango.txt', 'zebra.txt'],
        'kind sort groups by contentType (image/png < text/plain), name order inside');

    return summary('SortManager');
}
