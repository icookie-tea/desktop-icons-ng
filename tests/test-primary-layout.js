/* Tests for the persistent primary-desktop anchor storage.
 *
 * 'icons-only-on-primary' keeps a second, coordinate-system independent
 * position per file: metadata::ding-primary-position holds
 * {"version":1,"u":..,"v":..} as a fraction of the usable grid. The rules
 * asserted here are what keep it trustworthy:
 *  - reading is free of side effects (a refresh must never write),
 *  - a save writes the new attribute and the legacy coordinate in ONE
 *    Gio.FileInfo (no intermediate state on disk),
 *  - the legacy setter is never used to write the new attribute (the two
 *    attributes have different meanings and must not be coupled),
 *  - a failed write reports failure and leaves the rendered position alone.
 */
import Gio from 'gi://Gio';

import { FileItem } from '../app/file-item.js';
import * as Enums from '../app/enums.js';
import { assert, assertDeepEqual, assertEqual, summary } from './harness.js';

const PRIMARY = Enums.PRIMARY_POSITION_ATTRIBUTE;
const LEGACY = Enums.LEGACY_POSITION_ATTRIBUTE;

function makeFileInfo(attributes = {}) {
    const info = new Gio.FileInfo();
    for (const [name, value] of Object.entries(attributes)) {
        info.set_attribute_string(name, value);
    }
    return info;
}

/* Prototype-only FileItem: no Gtk widget, no desktop enumeration. The file
 * double records what a save would put on disk, read back from the real
 * Gio.FileInfo so the assertion covers the actual serialized bytes. */
function makeItem(fileInfo, { writeThrows = false, uri = 'file:///home/u/Desktop/a.txt' } = {}) {
    const item = Object.create(FileItem.prototype);
    item._destroyed = false;
    item._writes = [];
    item._file = {
        get_uri: () => uri,
        set_attributes_from_info: info => {
            if (writeThrows) {
                throw new Error('metadata backend unavailable');
            }
            item._writes.push({
                primary: info.get_attribute_as_string(PRIMARY),
                legacy: info.get_attribute_as_string(LEGACY),
            });
        },
    };
    item._primaryPosition = null;
    item._primaryPositionStatus = 'missing';
    /* Same read the real constructor does, so a rebuild is faithful. */
    item._savedCoordinates = item._readCoordinatesFromAttribute(fileInfo, LEGACY);
    item._setterCalls = 0;
    Object.defineProperty(item, 'savedCoordinates', {
        configurable: true,
        get() { return this._savedCoordinates; },
        set(value) { this._setterCalls += 1; this._savedCoordinates = value; },
    });
    item.reloadPrimaryPosition(fileInfo);
    return item;
}

export function runTests() {
    // 0. API contract: the attribute names must exist, or every later
    //    assertion would silently compare undefined values.
    assertEqual(PRIMARY, 'metadata::ding-primary-position', 'the new attribute is namespaced and versioned');
    assertEqual(LEGACY, 'metadata::nautilus-icon-position', 'the legacy attribute keeps its name');

    // 1. A valid record is read into the two accessors.
    {
        const item = makeItem(makeFileInfo({ [PRIMARY]: '{"version":1,"u":0.275,"v":0.35}' }));
        assertEqual(item.primaryPositionStatus, 'valid', 'the record is valid');
        assertDeepEqual(item.primaryPosition, { u: 0.275, v: 0.35 }, 'the anchor is exposed');
    }

    // 2. Every unusable record is reported with its own status, so the
    //    migration code can tell "never had one" from "do not touch this".
    {
        const cases = [
            [{}, 'missing', 'no attribute at all'],
            [{ [PRIMARY]: '' }, 'missing', 'an empty attribute'],
            [{ [PRIMARY]: 'garbage' }, 'invalid', 'corrupt JSON'],
            [{ [PRIMARY]: '{"version":1,"u":2,"v":0.3}' }, 'invalid', 'out-of-range anchor'],
            [{ [PRIMARY]: '{"version":9,"u":0.1,"v":0.1}' }, 'unsupported', 'a newer format'],
        ];
        for (const [attributes, status, why] of cases) {
            const item = makeItem(makeFileInfo(attributes));
            assertEqual(item.primaryPositionStatus, status, `${why} is ${status}`);
            assertEqual(item.primaryPosition, null, `${why} exposes no anchor`);
        }
    }

    // 3. Reading is side-effect free: it runs on every metadata refresh.
    {
        const item = makeItem(makeFileInfo({ [PRIMARY]: '{"version":1,"u":0.5,"v":0.5}' }));
        assertEqual(item._writes.length, 0, 'reading a record never writes');
        item.reloadPrimaryPosition(makeFileInfo({ [PRIMARY]: 'garbage' }));
        assertEqual(item._writes.length, 0, 'even a corrupt record is not "repaired" by reading');
        assertEqual(item.primaryPositionStatus, 'invalid', 'the status follows the last read');
    }

    // 4. One save, one FileInfo: the anchor and the legacy coordinate land
    //    together, so a crash between two writes cannot leave them disagreeing.
    {
        const item = makeItem(makeFileInfo({}));
        const ok = item.savePrimaryPosition({ u: 0.25, v: 0.5 }, [640, 720]);
        assertEqual(ok, true, 'the save reports success');
        assertEqual(item._writes.length, 1, 'exactly one attribute write is issued');
        assertEqual(item._writes[0].primary, '{"version":1,"u":0.25,"v":0.5}',
            'the anchor is stored in the versioned format');
        assertEqual(item._writes[0].legacy, '640,720', 'the legacy coordinate is mirrored');
        assertDeepEqual(item.primaryPosition, { u: 0.25, v: 0.5 }, 'the in-memory anchor follows');
        assertEqual(item.primaryPositionStatus, 'valid', 'and its status becomes valid');
        assertDeepEqual(item.savedCoordinates, [640, 720], 'the legacy mirror follows');
    }

    // 5. The new attribute is never written through the legacy setter (that
    //    would create a second, silent writer with different semantics).
    {
        const item = makeItem(makeFileInfo({}));
        item.savePrimaryPosition({ u: 0.1, v: 0.2 }, null);
        assertEqual(item._setterCalls, 0, 'savePrimaryPosition does not use the savedCoordinates setter');
        assertEqual(item._writes[0].legacy, '', 'a null legacy coordinate clears the attribute');
    }

    // 6. Clearing the anchor is explicit and keeps the status honest.
    {
        const item = makeItem(makeFileInfo({ [PRIMARY]: '{"version":1,"u":0.5,"v":0.5}' }));
        assertEqual(item.savePrimaryPosition(null, null), true, 'clearing reports success');
        assertEqual(item._writes[0].primary, '', 'the anchor attribute is cleared');
        assertEqual(item.primaryPosition, null, 'no anchor is exposed after clearing');
        assertEqual(item.primaryPositionStatus, 'missing', 'the status returns to missing');
    }

    // 7. A failing metadata backend reports false and must not make the icon
    //    disappear: the rendered/legacy state stays as it was.
    {
        const item = makeItem(makeFileInfo({}), { writeThrows: true });
        item._savedCoordinates = [10, 20];
        const ok = item.savePrimaryPosition({ u: 0.5, v: 0.5 }, [30, 40]);
        assertEqual(ok, false, 'a throwing write is reported as failure');
        assertEqual(item.primaryPosition, null, 'the in-memory anchor is not updated on failure');
        assertDeepEqual(item.savedCoordinates, [10, 20], 'the legacy coordinate is unchanged on failure');
    }

    // 8. Rebuilding the FileItem from the same metadata restores the anchor
    //    (the refresh path destroys and recreates items).
    {
        const first = makeItem(makeFileInfo({}));
        first.savePrimaryPosition({ u: 0.75, v: 0.125 }, [111, 222]);
        const stored = first._writes[0];
        const rebuilt = makeItem(makeFileInfo({ [PRIMARY]: stored.primary, [LEGACY]: stored.legacy }));
        assertDeepEqual(rebuilt.primaryPosition, { u: 0.75, v: 0.125 },
            'a rebuilt item reads the same anchor back');
        assertDeepEqual(rebuilt.savedCoordinates, [111, 222], 'and the same legacy coordinate');
    }

    // 9. Invalid input to the save API is a programming error: silently
    //    storing a NaN anchor would place the icon at the corner forever.
    {
        const item = makeItem(makeFileInfo({}));
        let threw = false;
        try {
            item.savePrimaryPosition({ u: NaN, v: 0.5 }, [1, 2]);
        } catch (e) {
            threw = e instanceof RangeError;
        }
        assert(threw, 'a NaN anchor is rejected with a RangeError');
        assertEqual(item._writes.length, 0, 'and nothing is written');
    }

    return summary('primary-layout');
}
