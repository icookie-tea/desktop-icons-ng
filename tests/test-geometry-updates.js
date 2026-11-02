/* Tests for geometry coalescing in GridLayout.
 *
 * The compositor reports every intermediate monitor/workarea state while it
 * settles (scale change, dock autohide, hotplug). Each snapshot used to
 * rebuild all grids and re-run the icon placement, which showed up as
 * flicker. queueGridUpdate() keeps only the newest snapshot of a burst and
 * applies it once the burst is quiet, never holding the first event of a
 * burst longer than the cap.
 *
 * A fake scheduler drives the timing, so the test is deterministic and
 * instant (advance(ms) runs whatever is due).
 */
import { GridLayout } from '../app/grid-layout.js';
import * as Constants from '../app/constants.js';
import { assertEqual, summary } from './harness.js';

const AREA = {
    x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1,
    monitorIndex: 0, marginTop: 0, marginBottom: 0,
    marginLeft: 0, marginRight: 0, windowMarginTop: 0,
    windowMarginBottom: 0, windowMarginLeft: 0, windowMarginRight: 0,
};

/* Deterministic scheduler: one clock, timers ordered by due time. */
function makeScheduler() {
    let now = 0;
    let nextId = 1;
    const timers = new Map();
    const scheduler = {
        scheduled: [],
        nowMs: () => now,
        schedule(delayMs, callback) {
            const id = nextId++;
            scheduler.scheduled.push(delayMs);
            timers.set(id, { due: now + delayMs, callback });
            return id;
        },
        cancel(id) {
            timers.delete(id);
        },
        advance(ms) {
            const target = now + ms;
            for (;;) {
                let next = null;
                for (const [id, timer] of timers) {
                    if ((timer.due <= target) && ((next === null) || (timer.due < next.timer.due))) {
                        next = { id, timer };
                    }
                }
                if (next === null) {
                    break;
                }
                timers.delete(next.id);
                now = next.timer.due;
                next.timer.callback();
            }
            now = target;
        },
        pending: () => timers.size,
    };
    return scheduler;
}

function makeDM() {
    return {
        _primaryIndex: 0,
        _desktopList: null,
        _primaryScreen: null,
        _desktops: [],
        _asDesktop: true,
        _primaryGridRemovedIcons: false,
        applied: [],
        _removeAllFilesFromGrids: () => {},
        _updateDesktopSafe: () => {},
    };
}

/* The grid windows themselves need GTK; what matters here is which snapshot
 * reached createGridWindows(). */
function makeLayout() {
    const scheduler = makeScheduler();
    const dm = makeDM();
    const layout = new GridLayout(dm, () => true, scheduler);
    layout.createGridWindows = () => dm.applied.push(dm._desktopList);
    return { dm, layout, scheduler };
}

export function runTests() {
    // 1. A burst is coalesced: only the last snapshot is applied.
    {
        const { dm, layout, scheduler } = makeLayout();
        const a = [{ ...AREA, width: 1920 }];
        const b = [{ ...AREA, width: 2560 }];
        const c = [{ ...AREA, width: 3000 }];
        layout.queueGridUpdate(a);
        layout.queueGridUpdate(b);
        layout.queueGridUpdate(c);
        assertEqual(dm.applied.length, 0, 'nothing is applied while the burst is still settling');
        scheduler.advance(Constants.GEOMETRY_UPDATE_DEBOUNCE_MS - 1);
        assertEqual(dm.applied.length, 0, 'still waiting inside the quiet window');
        scheduler.advance(1);
        assertEqual(dm.applied.length, 1, 'one relayout for the whole burst');
        assertEqual(dm.applied[0][0].width, 3000, 'the newest snapshot is the one applied');
        assertEqual(scheduler.pending(), 0, 'the timer is released after applying');
    }

    // 2. Continuous events are not postponed forever: the first event of a
    //    burst is applied at the cap even while new ones keep arriving.
    {
        const { dm, layout, scheduler } = makeLayout();
        /* Events every 100 ms: never a quiet window, so only the cap can
         * release the relayout. */
        let width = 1000;
        for (let i = 0; i < 9; i++) {
            layout.queueGridUpdate([{ ...AREA, width: width++ }]);
            assertEqual(dm.applied.length, 0, 'nothing is applied while the burst continues');
            scheduler.advance(100);
        }
        layout.queueGridUpdate([{ ...AREA, width: width++ }]);
        assertEqual(scheduler.scheduled[scheduler.scheduled.length - 1],
            Constants.GEOMETRY_UPDATE_MAX_WAIT_MS - 900, 'the delay shrinks as the cap approaches');
        scheduler.advance(Constants.GEOMETRY_UPDATE_MAX_WAIT_MS - 900);
        assertEqual(dm.applied.length, 1, 'the cap is respected even under continuous events');
        assertEqual(dm.applied[0][0].width, width - 1, 'and the latest snapshot is applied');
    }

    // 3. An invalid snapshot never displaces a queued valid one.
    {
        const { dm, layout, scheduler } = makeLayout();
        layout.queueGridUpdate([{ ...AREA, width: 2560 }]);
        const invalid = [
            [],
            null,
            [{ ...AREA, width: 0 }],
            [{ ...AREA, height: NaN }],
            [{ ...AREA, scaleFactor: 0 }],
            [{ ...AREA, marginLeft: -1 }],
            [{ ...AREA, marginLeft: 1000, marginRight: 1000 }],
            [{ ...AREA, marginTop: 1080 }],
            [{ ...AREA, marginLeft: 1080, marginRight: 1080 }],
            [{ ...AREA, width: 4, marginLeft: 3, marginRight: 0, scaleFactor: 4 }],
            [{ ...AREA, primaryMonitor: 'first' }],
        ];
        for (const snapshot of invalid) {
            layout.queueGridUpdate(snapshot);
        }
        scheduler.advance(Constants.GEOMETRY_UPDATE_DEBOUNCE_MS);
        assertEqual(dm.applied.length, 1, 'the valid snapshot is still applied once');
        assertEqual(dm.applied[0][0].width, 2560, 'with its own geometry, not an invalid one');
    }

    // 4. An invalid snapshot alone never applies (the previous layout stays).
    {
        const { dm, layout, scheduler } = makeLayout();
        layout.queueGridUpdate([{ ...AREA, width: 0 }]);
        scheduler.advance(Constants.GEOMETRY_UPDATE_MAX_WAIT_MS * 2);
        assertEqual(dm.applied.length, 0, 'no relayout for an unusable snapshot');
        assertEqual(scheduler.pending(), 0, 'and no timer was left behind');
    }

    // 5. destroy() drops the pending snapshot: the callback must not run
    //    against a destroyed layout (it would rebuild windows after disable).
    {
        const { dm, layout, scheduler } = makeLayout();
        layout.queueGridUpdate([{ ...AREA, width: 2560 }]);
        layout.destroy();
        assertEqual(scheduler.pending(), 0, 'the timer is cancelled on destroy');
        scheduler.advance(Constants.GEOMETRY_UPDATE_MAX_WAIT_MS * 2);
        assertEqual(dm.applied.length, 0, 'a destroyed layout never applies a queued snapshot');
    }

    // 6. Identical geometry is not rebuilt (the existing diff still applies).
    {
        const { dm, layout, scheduler } = makeLayout();
        layout.updateGridWindows([{ ...AREA }]);
        assertEqual(dm.applied.length, 1, 'the first snapshot builds the grids');
        layout.updateGridWindows([{ ...AREA }]);
        assertEqual(dm.applied.length, 1, 'an identical snapshot does not rebuild them');
        layout.queueGridUpdate([{ ...AREA }]);
        scheduler.advance(Constants.GEOMETRY_UPDATE_DEBOUNCE_MS);
        assertEqual(dm.applied.length, 1, 'and a queued identical snapshot does not either');
    }

    // 7. updateGridWindows() stays the immediate entry point (startup must not
    //    wait for a debounce window).
    {
        const { dm, layout, scheduler } = makeLayout();
        layout.updateGridWindows([{ ...AREA, width: 2560 }]);
        assertEqual(dm.applied.length, 1, 'the immediate path applies at once');
        assertEqual(scheduler.pending(), 0, 'and schedules nothing');
    }

    // 8. A failed coalesced apply does not wedge the next one: the state is
    //    cleared before the snapshot is applied.
    {
        const { dm, layout, scheduler } = makeLayout();
        let first = true;
        layout.createGridWindows = () => {
            if (first) {
                first = false;
                throw new Error('boom');
            }
            dm.applied.push(dm._desktopList);
        };
        layout.queueGridUpdate([{ ...AREA, width: 1000 }]);
        let threw = false;
        try {
            scheduler.advance(Constants.GEOMETRY_UPDATE_DEBOUNCE_MS);
        } catch (e) {
            threw = true;
        }
        assertEqual(threw, true, 'the failure is visible to the caller');
        layout.queueGridUpdate([{ ...AREA, width: 1200 }]);
        scheduler.advance(Constants.GEOMETRY_UPDATE_DEBOUNCE_MS);
        assertEqual(dm.applied.length, 1, 'the next snapshot is applied normally');
        assertEqual(dm.applied[0][0].width, 1200, 'with the newest geometry');
    }

    return summary('geometry-updates');
}
