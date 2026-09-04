/* Tests for the DING window-title protocol (title-protocol.js), the pure
 * core of emulate-x11-window-type.js ManageWindow._parseTitle().
 *
 * Protocol: "@!" + "x,y" + optional ";" + flags (B/T/D/H). Trailing-space
 * aliases: one space == @!H, two spaces == @!HTD. "Desktop Icons <n>" marks
 * the DING desktop window and suppresses keep-at-top.
 */
import { parseTitle } from '../title-protocol.js';
import { assert, assertEqual, summary } from './harness.js';

function runTests() {
    // null / plain titles → no coordinates, no flags
    {
        const r = parseTitle(null);
        assertEqual(r.x, null, 'null title → x null');
        assertEqual(r.keepAtTop, false, 'null title → no keepAtTop');
        assertEqual(r.isDesktop, false, 'null title → not desktop');
    }
    {
        const r = parseTitle('Some ordinary window title');
        assertEqual(r.x, null, 'plain title → x null');
        assertEqual(r.y, null, 'plain title → y null');
        assertEqual(r.keepAtTop, false, 'plain title → no keepAtTop');
        assertEqual(r.showInAllDesktops, false, 'plain title → not all desktops');
    }

    // @!x,y; with flags
    {
        const r = parseTitle('@!10,20;T');
        assertEqual(r.x, 10, 'x parsed');
        assertEqual(r.y, 20, 'y parsed');
        assertEqual(r.keepAtTop, true, 'T → keepAtTop');
        assertEqual(r.showInAllDesktops, false, 'no D → not all desktops');
    }
    {
        const r = parseTitle('@!5,6;TD');
        assertEqual(r.x, 5, 'x parsed (TD)');
        assertEqual(r.y, 6, 'y parsed (TD)');
        assertEqual(r.keepAtTop, true, 'T in TD → keepAtTop');
        assertEqual(r.showInAllDesktops, true, 'D in TD → all desktops');
    }
    // no semicolon: coordinates run to end of title
    {
        const r = parseTitle('@!30,40');
        assertEqual(r.x, 30, 'x parsed without semicolon');
        assertEqual(r.y, 40, 'y parsed without semicolon');
    }
    // H is accepted in the flag set but not acted on (pinned original behavior)
    {
        const r = parseTitle('@!1,2;H');
        assertEqual(r.x, 1, 'x parsed with H flag');
        assertEqual(r.keepAtTop, false, 'H does not set keepAtTop');
        assertEqual(r.showInAllDesktops, false, 'H does not set all-desktops');
    }

    // trailing-space aliases. NOTE (pinned original behavior): the alias
    // titles @!H / @!HTD carry no numeric coords, so parseInt('H') yields
    // NaN for x/y (the pre-extraction code set the same NaN via the same
    // parseInt path; _moveIntoPlace() guards on x/y !== null which is true
    // for NaN, but _fixed stays false so no move is scheduled).
    {
        const r = parseTitle('decorated window ');
        assertEqual(r.keepAtTop, false, 'one trailing space (@!H) → no keepAtTop');
        assertEqual(r.showInAllDesktops, false, 'one trailing space → not all desktops');
        assert(Number.isNaN(r.x), 'one trailing space → x is NaN (parseInt of H)');
    }
    {
        const r = parseTitle('decorated window  ');
        assertEqual(r.keepAtTop, true, 'two trailing spaces (@!HTD) → keepAtTop');
        assertEqual(r.showInAllDesktops, true, 'two trailing spaces → all desktops');
        assert(Number.isNaN(r.x), 'two trailing spaces → x is NaN (parseInt of HTD)');
    }

    // "Desktop Icons <n>" → the DING desktop window
    {
        const r = parseTitle('Desktop Icons 1');
        assertEqual(r.isDesktop, true, 'Desktop Icons → isDesktop');
        assertEqual(r.desktopIndex, 1, 'desktop index parsed');
        assertEqual(r.keepAtTop, false, 'desktop title suppresses keepAtTop');
        assertEqual(r.x, null, 'desktop coords come from monitor data, not title');
    }
    {
        const r = parseTitle('Desktop Icons 2');
        assertEqual(r.isDesktop, true, 'second monitor desktop → isDesktop');
        assertEqual(r.desktopIndex, 2, 'desktop index 2 parsed');
    }

    return summary('title-protocol');
}

export { runTests };
