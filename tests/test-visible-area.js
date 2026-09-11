/* Tests for the shell-side VisibleArea margin aggregation. The class is
 * shell-free (the primary-index getter is injected), so it runs under plain
 * gjs. Also exercises the app/signals.js implementation it now relies on
 * instead of the legacy imports.signals. */
import { VisibleArea } from '../visible-area.js';
import { assertEqual, assertDeepEqual, summary } from './harness.js';

const PRIMARY = 1;
const va = () => new VisibleArea(() => PRIMARY);

const MARGINS = (top, bottom, left, right) => ({
    top, bottom, left, right,
});

export function runTests() {
    // 1. Signal plumbing: connect / emit / disconnect
    {
        const v = va();
        let calls = 0;
        const id = v.connect('updated-usable-area', () => { calls++; });
        v.emit('updated-usable-area');
        assertEqual(calls, 1, 'connected handler is called on emit');
        v.disconnect(id);
        v.emit('updated-usable-area');
        assertEqual(calls, 1, 'disconnected handler is not called');
    }

    // 2. Single extension margins
    {
        const v = va();
        v.setMarginsForExtension('ext-a', { 0: MARGINS(10, 20, 30, 40) });
        v._refreshMargins();
        assertDeepEqual(v._usableAreas[0], MARGINS(10, 20, 30, 40), 'single extension margins pass through');
    }

    // 3. Max aggregation across extensions, per side, per monitor
    {
        const v = va();
        v.setMarginsForExtension('ext-a', { 0: MARGINS(10, 20, 30, 40), 2: MARGINS(5, 5, 5, 5) });
        v.setMarginsForExtension('ext-b', { 0: MARGINS(15, 5, 10, 50) });
        v._refreshMargins();
        assertDeepEqual(v._usableAreas[0], MARGINS(15, 20, 30, 50), 'per-side max across extensions');
        assertDeepEqual(v._usableAreas[2], MARGINS(5, 5, 5, 5), 'other monitor untouched by the second extension');
    }

    // 4. Negative workspace index maps to the (injected) primary index
    {
        const v = va();
        v.setMarginsForExtension('ext-a', { [-1]: MARGINS(7, 7, 7, 7) });
        v._refreshMargins();
        assertDeepEqual(v._usableAreas[PRIMARY], MARGINS(7, 7, 7, 7), 'negative index → primary index');
        assertEqual(PRIMARY in v._usableAreas, true, 'keyed by the resolved primary index');
    }

    // 5. Negative and explicit primary margins merge (max, not replace)
    {
        const v = va();
        v.setMarginsForExtension('ext-a', { [PRIMARY]: MARGINS(10, 10, 10, 10) });
        v.setMarginsForExtension('ext-b', { [-1]: MARGINS(3, 40, 2, 2) });
        v._refreshMargins();
        assertDeepEqual(v._usableAreas[PRIMARY], MARGINS(10, 40, 10, 10), 'negative + explicit primary merged by max');
    }

    // 6. Removing margins (null) drops the extension from the aggregation
    {
        const v = va();
        v.setMarginsForExtension('ext-a', { 0: MARGINS(10, 10, 10, 10) });
        v.setMarginsForExtension('ext-b', { 0: MARGINS(1, 1, 1, 1) });
        v.setMarginsForExtension('ext-a', null);
        v._refreshMargins();
        assertDeepEqual(v._usableAreas[0], MARGINS(1, 1, 1, 1), 'removed extension no longer contributes');
    }

    // 7. Removing unknown/already-removed extensions is a no-op
    {
        const v = va();
        v.setMarginsForExtension('ghost', null);
        v.setMarginsForExtension('ext-a', { 0: MARGINS(2, 2, 2, 2) });
        v.setMarginsForExtension('ext-a', null);
        v.setMarginsForExtension('ext-a', null);
        v._refreshMargins();
        assertEqual(0 in v._usableAreas, false, 'no usable areas once all margins removed');
    }

    // 8. Re-setting margins for the same extension replaces its old values
    {
        const v = va();
        v.setMarginsForExtension('ext-a', { 0: MARGINS(100, 100, 100, 100) });
        v.setMarginsForExtension('ext-a', { 0: MARGINS(1, 1, 1, 1) });
        v._refreshMargins();
        assertDeepEqual(v._usableAreas[0], MARGINS(1, 1, 1, 1), 'second call replaces, not merges, the same extension');
    }

    // 9. Third-party integrations may report only the sides they use.
    //    Math.max(0, undefined) is NaN, and a NaN margin propagated into
    //    the grid's _maxColumns/_maxRows (icons could not be placed).
    {
        const v = va();
        v.setMarginsForExtension('ext-a', { 0: { top: 30 } });
        v._refreshMargins();
        assertDeepEqual(v._usableAreas[0], MARGINS(30, 0, 0, 0),
            'missing sides default to 0 instead of NaN');
        assertEqual(Number.isNaN(v._usableAreas[0].bottom), false,
            'no NaN leaks into the usable area');
    }

    // 10. Non-numeric side values are ignored (they neither win the max nor
    //     poison the whole area)
    {
        const v = va();
        v.setMarginsForExtension('ext-a', { 0: MARGINS(10, 10, 10, 10) });
        v.setMarginsForExtension('ext-b',
            { 0: { top: undefined, bottom: null, left: '20', right: 50 } });
        v._refreshMargins();
        assertDeepEqual(v._usableAreas[0], MARGINS(10, 10, 10, 50),
            'only finite numbers take part in the max');
    }

    return summary('VisibleArea');
}
