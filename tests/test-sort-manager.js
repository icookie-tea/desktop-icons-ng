/* Tests for SortManager comparator logic.
 *
 * The comparators sort with localeCompare options in the correct 3rd
 * argument slot (fix: options were previously passed as the 2nd/locales
 * argument and silently ignored): sensitivity 'accent' (case
 * insensitive) + numeric collation. Ordering below is pinned for
 * ASCII names across locales.
 */
import { SortManager } from '../app/sort-manager.js';
import * as Enums from '../app/enums.js';
import { assertDeepEqual, assertEqual, summary } from './harness.js';

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

    // 5. sortFileListByKindStacked: stacked-layout semantics (pure core
    // extracted for testability; pins the O(n²)→O(n) rewrite behavior)
    const mk = (name, type, extra = {}) => ({
        _label: { get_text: () => name },
        fileName: name,
        attributeContentType: type,
        isSpecial: false,
        isDirectory: false,
        _isValidDesktopFile: false,
        isStackMarker: false,
        updateIcon: () => {},
        ...extra,
    });

    // NAME order: output = uniques + markers + specials/desktop-files/dirs,
    // name-sorted together; unstacked types are re-inserted right after an
    // item of the same type. Stacked (non-unstacked) members are intentionally
    // absent — the marker represents the stack (originals are kept in
    // desktopManager._allFileList for unstacking). Pins the O(n²)→O(n) rewrite.
    {
        const list = [
            mk('b.png', 'image/png'),
            mk('a.png', 'image/png'),
            mk('c.png', 'image/png'),
            mk('d.txt', 'text/plain'),
            mk('e.txt', 'text/plain'),
            mk('home', '', { isSpecial: true }),
            mk('app.desktop', 'application/x-desktop', { _isValidDesktopFile: true }),
            mk('docs', '', { isDirectory: true }),
        ];
        const markers = [];
        const out = SortManager.sortFileListByKindStacked(
            list, ['image/png'], Enums.SortOrder.NAME,
            (type) => { const m = mk(`marker-${type}`, type, { isStackMarker: true }); markers.push(m); return m; });
        // A marker is created for EVERY non-unique type (image and text are
        // both doubled here). image/png is unstacked → its members are
        // re-inserted right after marker-image/png; text/plain stays stacked
        // → its members remain hidden behind marker-text/plain.
        assertDeepEqual(out.map(i => i.fileName),
            ['app.desktop', 'docs', 'home', 'marker-image/png', 'a.png', 'b.png', 'c.png', 'marker-text/plain'],
            'NAME: markers for non-unique types, unstacked members after their marker, stacked members hidden');
        assertEqual(markers.length, 2, 'one marker per non-unique type');
        assertEqual(list.find(i => i.fileName === 'a.png').isStackTop, false,
            'stack-top item demoted once its marker takes over');
        const idxMarkerImg = out.findIndex(i => i.fileName === 'marker-image/png');
        assertDeepEqual(out.slice(idxMarkerImg + 1, idxMarkerImg + 4).map(i => i.fileName),
            ['a.png', 'b.png', 'c.png'],
            'unstacked members immediately follow their marker, name-sorted');
        assertEqual(out.some(i => i.fileName === 'd.txt' || i.fileName === 'e.txt'), false,
            'stacked (non-unstacked) text members hidden behind their marker');
    }

    // NAME order, unstacked type: the marker represents the type in the
    // merged list, and the type's members are spliced in right after the
    // marker (re-insertion semantics, pinned).
    {
        const list = [
            mk('b.png', 'image/png'),
            mk('a.png', 'image/png'),
            mk('d.txt', 'text/plain'),
        ];
        const out = SortManager.sortFileListByKindStacked(
            list, ['image/png'], Enums.SortOrder.NAME,
            (type) => mk(`marker-${type}`, type, { isStackMarker: true }));
        // merged+sorted: d.txt, marker-image/png; marker's type matches the
        // unstacked members (a.png, b.png by name) → spliced after the marker
        assertDeepEqual(out.map(i => i.fileName),
            ['d.txt', 'marker-image/png', 'a.png', 'b.png'],
            'unstacked type: members re-inserted right after the marker');
    }

    // SIZE order: a fully-stacked type yields only its marker; the marker's
    // size is copied from the first stacked file of its type (head of
    // stackedFiles after the SIZE sort). NOTE: the production code copies
    // `modifiedTime` (a plain property, undefined on FileItem which exposes
    // a getter instead), so marker.time is pinned as undefined — a latent
    // no-op, documented here rather than "fixed" in this test-only change.
    {
        const list = [
            mk('big.png', 'image/png', { fileSize: 300 }),
            mk('small.png', 'image/png', { fileSize: 100 }),
            mk('mid.png', 'image/png', { fileSize: 200 }),
        ];
        const markers = [];
        const out = SortManager.sortFileListByKindStacked(
            list, [], Enums.SortOrder.SIZE,
            (type) => { const m = mk('marker', type, { isStackMarker: true }); markers.push(m); return m; });
        assertDeepEqual(out.map(i => i.fileName), ['marker'],
            'fully-stacked type: only the marker is shown');
        assertEqual(markers[0].size, 100, 'marker.size copied from first (smallest) stacked file');
        assertEqual(markers[0].time, undefined,
            'marker.time: production reads .modifiedTime (undefined on FileItem) — pinned as no-op');
    }

    // 6. _restoreStackInitialCoordinates: fileName→coords map, last entry
    // wins on duplicates, state cleared after restore.
    {
        const dm3 = {
            _fileList: [
                mk('a.txt', 'text/plain'),
                mk('dup.txt', 'text/plain'),
                mk('z.txt', 'text/plain'), // never stored → untouched
            ],
            stackInitialCoordinates: [
                ['a.txt', [1, 2]],
                ['dup.txt', [9, 9]],
                ['dup.txt', [5, 6]], // duplicate: last match wins
            ],
        };
        const sm3 = new SortManager(dm3);
        sm3._restoreStackInitialCoordinates();
        assertDeepEqual(dm3._fileList.find(i => i.fileName === 'a.txt').savedCoordinates, [1, 2],
            'restore: stored coordinates applied');
        assertDeepEqual(dm3._fileList.find(i => i.fileName === 'dup.txt').savedCoordinates, [5, 6],
            'restore: duplicate fileName — last entry wins');
        assertEqual(dm3._fileList.find(i => i.fileName === 'z.txt').savedCoordinates, undefined,
            'restore: unknown fileName untouched');
        assertEqual(dm3.stackInitialCoordinates, null, 'restore: state cleared');
    }

    return summary('SortManager');
}
