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

    // 3. _positionComparator: x asc, then y asc, per corner inversion
    const cells = [
        { _x1: 100, _y1: 300 },
        { _x1: 100, _y1: 100 },
        { _x1: 50, _y1: 200 },
        { _x1: 200, _y1: 50 },
    ];
    const cellNames = c => c.map(i => `${i._x1},${i._y1}`).join(' | ');

    assertDeepEqual(
        cellNames([...cells].sort(sm._positionComparator([false, false]))),
        '50,200 | 100,100 | 100,300 | 200,50',
        'corner top-left: x asc, tie-break y asc');
    assertDeepEqual(
        cellNames([...cells].sort(sm._positionComparator([true, true]))),
        '200,50 | 100,300 | 100,100 | 50,200',
        'corner bottom-right: x desc, tie-break y desc');
    assertDeepEqual(
        cellNames([...cells].sort(sm._positionComparator([true, false]))),
        '200,50 | 100,100 | 100,300 | 50,200',
        'corner top-right: x desc, tie-break y asc');
    assertDeepEqual(
        cellNames([...cells].sort(sm._positionComparator([false, true]))),
        '50,200 | 100,300 | 100,100 | 200,50',
        'corner bottom-left: x asc, tie-break y desc');

    return summary('SortManager');
}
