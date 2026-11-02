/* Tests for SortManager comparator logic.
 *
 * The comparators sort with localeCompare options in the correct 3rd
 * argument slot (fix: options were previously passed as the 2nd/locales
 * argument and silently ignored): sensitivity 'accent' (case
 * insensitive) + numeric collation. Ordering below is pinned for
 * ASCII names across locales.
 */
import { SortManager } from '../app/sort-manager.js';
import { assert, assertDeepEqual, assertEqual, summary } from './harness.js';

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
    // SortManager comparators and the stacked sort are static pure
    // functions, so no instance is needed.

    // 1. _sortByName: case-insensitive + numeric collation
    let list = [
        mockItem('file2.txt', 'text/plain'),
        mockItem('File10.txt', 'text/plain'),
        mockItem('file1.txt', 'text/plain'),
    ];
    SortManager._sortByName(list);
    assertDeepEqual(names(list), ['file1.txt', 'file2.txt', 'File10.txt'],
        'numeric collation (file2 before file10)');

    list = [
        mockItem('b.txt', 'text/plain'),
        mockItem('A.txt', 'text/plain'),
        mockItem('c.txt', 'text/plain'),
    ];
    SortManager._sortByName(list);
    assertDeepEqual(names(list), ['A.txt', 'b.txt', 'c.txt'],
        'case-insensitive (A and a collate together)');

    // 2. _sortByKindByName: groups by content type, name order inside group
    list = [
        mockItem('zebra.txt', 'text/plain'),
        mockItem('alpha.png', 'image/png'),
        mockItem('mango.txt', 'text/plain'),
        mockItem('beta.png', 'image/png'),
    ];
    SortManager._sortByKindByName(list);
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
        cellNames([...cells].sort(SortManager._positionComparator([false, false]))),
        '50,200 | 100,100 | 100,300 | 200,50',
        'corner top-left: x asc, tie-break y asc');
    assertDeepEqual(
        cellNames([...cells].sort(SortManager._positionComparator([true, true]))),
        '200,50 | 100,300 | 100,100 | 50,200',
        'corner bottom-right: x desc, tie-break y desc');
    assertDeepEqual(
        cellNames([...cells].sort(SortManager._positionComparator([true, false]))),
        '200,50 | 100,100 | 100,300 | 50,200',
        'corner top-right: x desc, tie-break y asc');
    assertDeepEqual(
        cellNames([...cells].sort(SortManager._positionComparator([false, true]))),
        '50,200 | 100,300 | 100,100 | 200,50',
        'corner bottom-left: x asc, tie-break y desc');

    // 4. sortAllFilesFromGridsByPosition: entry point used by the
    // 'arrange-icons' menu action (regression: method was dropped during
    // the comparator extraction, only caught at runtime)
    const positioned = [
        { _x1: 100, _y1: 300, _label: { get_text: () => 'd' } },
        { _x1: 100, _y1: 100, _label: { get_text: () => 'c' } },
        { _x1: 50, _y1: 200, _label: { get_text: () => 'b' } },
        { _x1: 200, _y1: 50, _label: { get_text: () => 'a' } },
    ];
    let reassigned = false;
    const dm = {
        keepArranged: false,
        _fileList: positioned,
    };
    const sm2 = new SortManager(dm);
    sm2._reassignFilesToDesktop = () => { reassigned = true; };
    let removed = 0;
    for (const item of positioned) {
        item.removeFromGrid = () => { removed++; };
    }
    sm2.sortAllFilesFromGridsByPosition([false, false]);
    assertDeepEqual(cellNames(positioned),
        '50,200 | 100,100 | 100,300 | 200,50',
        'arrange-icons sorts by position (top-left corner default)');
    if (!(removed === 4 && reassigned)) {
        throw new Error('arrange-icons: expected 4 removeFromGrid calls and reassign');
    }
    dm.keepArranged = true;
    sm2.sortAllFilesFromGridsByPosition(); // must not throw


    // 5. Commit intent in primary-only mode. An automatic reflow (keep
    //    arranged, geometry change, refresh) must never record a manual
    //    layout; only an explicit sort does, and only for the icons that got a
    //    cell.
    {
        const makeSortDm = () => {
            const fileList = ['c', 'a', 'b'].map(name => ({
                uri: 'file:///' + name,
                _x1: 0,
                _y1: 0,
                _label: { get_text: () => name },
                isSpecial: false,
                removeFromGrid: () => {},
            }));
            const layout = {
                primaryOnly: true,
                arranged: [],
                commits: [],
                placePrimaryFiles(list, opts) {
                    layout.arranged.push(opts);
                    return list;
                },
                commitPrimaryPositions(list) {
                    layout.commits.push(list.map(item => item.uri));
                },
            };
            return { dm: { keepArranged: false, sortSpecialFolders: true, _fileList: fileList, _gridLayout: layout }, layout };
        };

        const automatic = makeSortDm();
        const automaticSorter = new SortManager(automatic.dm);
        for (let i = 0; i < 5; i++) {
            automaticSorter._reassignFilesToDesktop();
        }
        assertEqual(automatic.layout.commits.length, 0,
            'five automatic reflows record no manual layout');
        assertEqual(automatic.layout.arranged.length, 5, 'each reflow still places the icons');
        assertEqual(automatic.layout.arranged[0].arranged, true, 'as a sorted layout');

        const explicit = makeSortDm();
        const explicitSorter = new SortManager(explicit.dm);
        explicitSorter.sortAllFilesFromGridsByPosition([false, false], { commitPrimaryLayout: true });
        assertEqual(explicit.layout.commits.length, 1, 'arrange-icons commits once');
        assertDeepEqual([...explicit.layout.commits[0]].sort(),
            ['file:///a', 'file:///b', 'file:///c'], 'and commits every placed icon');
        assertEqual(explicit.dm._fileList[0].uri, 'file:///a',
            'the list was sorted before being placed');

        const keepArranged = makeSortDm();
        keepArranged.dm.keepArranged = true;
        const blocked = new SortManager(keepArranged.dm).sortAllFilesFromGridsByPosition(null,
            { commitPrimaryLayout: true });
        assertDeepEqual(blocked, [], 'keep-arranged ignores the manual arrange action');
        assertEqual(keepArranged.layout.commits.length, 0, 'and commits nothing');
    }

    // 6. A partly placed sort commits only what fit: an icon the grid could
    //    not host must keep the anchor it had.
    {
        const fileList = ['a', 'b'].map(name => ({
            uri: 'file:///' + name, _x1: 0, _y1: 0, _label: { get_text: () => name },
            isSpecial: false, removeFromGrid: () => {}, _placeable: name !== 'b',
        }));
        const commits = [];
        const dm = {
            keepArranged: false,
            sortSpecialFolders: true,
            _fileList: fileList,
            _gridLayout: {
                primaryOnly: true,
                placePrimaryFiles: list => list.filter(item => item._placeable),
                commitPrimaryPositions: list => commits.push(list.map(item => item.uri)),
            },
        };
        new SortManager(dm)._reassignFilesToDesktop();
        dm._gridLayout.commitPrimaryPositions([fileList[0]]);
        assertDeepEqual(commits[0], ['file:///a'], 'only the placed icon is committed');
    }

    // 7. Ties are broken by URI, so two icons with the same size or time never
    //    swap cells depending on directory enumeration order.
    {
        const makeTies = () => [
            { uri: 'file:///z', fileSize: 10, _modifiedTime: 5, _label: { get_text: () => 'same' } },
            { uri: 'file:///a', fileSize: 10, _modifiedTime: 5, _label: { get_text: () => 'same' } },
        ];
        const dm = {
            keepArranged: false,
            sortSpecialFolders: true,
            _fileList: makeTies(),
            _gridLayout: { primaryOnly: false },
        };
        const sorter = new SortManager(dm);
        sorter._reassignFilesToDesktop = () => {};
        sorter._sortAllFilesFromGridsByModifiedTime();
        assertDeepEqual(dm._fileList.map(i => i.uri), ['file:///a', 'file:///z'],
            'equal modification times fall back to URI order');
        dm._fileList = makeTies().reverse();
        sorter._sortAllFilesFromGridsBySize();
        assertDeepEqual(dm._fileList.map(i => i.uri), ['file:///a', 'file:///z'],
            'equal sizes fall back to URI order');

        const cells = [
            { _x1: 10, _y1: 10, uri: 'file:///b' },
            { _x1: 10, _y1: 10, uri: 'file:///a' },
        ];
        assertDeepEqual(
            [...cells].sort(SortManager._positionComparator([false, false])).map(i => i.uri),
            ['file:///a', 'file:///b'],
            'icons in the same cell fall back to URI order');
        assert(SortManager._byUri({ uri: 'file:///a' }, { uri: 'file:///b' }) < 0,
            'the URI comparator is ascending');
    }

    return summary('SortManager');
}
