/* Tests for SortManager comparator logic.
 *
 * The comparators sort with localeCompare options in the correct 3rd
 * argument slot (fix: options were previously passed as the 2nd/locales
 * argument and silently ignored): sensitivity 'accent' (case
 * insensitive) + numeric collation. Ordering below is pinned for
 * ASCII names across locales.
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

    // 1. _sortByName: case-insensitive + numeric collation
    let list = [
        mockItem('file2.txt', 'text/plain'),
        mockItem('File10.txt', 'text/plain'),
        mockItem('file1.txt', 'text/plain'),
    ];
    sm._sortByName(list);
    assertDeepEqual(names(list), ['file1.txt', 'file2.txt', 'File10.txt'],
        'numeric collation (file2 before file10)');

    list = [
        mockItem('b.txt', 'text/plain'),
        mockItem('A.txt', 'text/plain'),
        mockItem('c.txt', 'text/plain'),
    ];
    sm._sortByName(list);
    assertDeepEqual(names(list), ['A.txt', 'b.txt', 'c.txt'],
        'case-insensitive (A and a collate together)');

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
