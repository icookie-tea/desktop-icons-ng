/* Rounded-rect snapshots in PaintContainer.
 *
 * _snapshotRoundedRect() runs for every cell of every frame; it used to build
 * a fresh Graphene.Rect and Gsk.RoundedRect per call. Both are copied by the
 * snapshot (clip node / color node keep their own copy), so one pair of
 * scratch objects per widget is enough (audit 2026-09-11). The test checks
 * that the same instances reach the snapshot while the geometry still follows
 * the arguments. */
import { PaintContainer } from '../app/paint-container.js';
import { assert, assertEqual, summary } from './harness.js';

function makeContainer() {
    const container = Object.create(PaintContainer.prototype);
    container._stroke1 = { name: 'stroke1' };
    container._stroke2 = { name: 'stroke2' };
    return container;
}

function makeSnapshot(metrics) {
    return {
        push_rounded_clip: roundedRect => metrics.roundedRects.push(roundedRect),
        append_color: (color, rect) => metrics.colors.push([color, rect]),
        append_stroke: (path, stroke, color) => metrics.strokes.push([path, stroke, color]),
        pop: () => { metrics.pops++; },
    };
}

const newMetrics = () => ({ roundedRects: [], colors: [], strokes: [], pops: 0 });

export function runTests() {
    // 1. two paints reuse the same scratch Gsk.RoundedRect / Graphene.Rect
    {
        const container = makeContainer();
        const metrics = newMetrics();
        const snapshot = makeSnapshot(metrics);
        PaintContainer.prototype._snapshotRoundedRect.call(container, snapshot,
            1, 2, 30, 40, 5, { name: 'fill' }, null, 0);
        PaintContainer.prototype._snapshotRoundedRect.call(container, snapshot,
            3, 4, 50, 60, 5, { name: 'fill' }, null, 0);

        assertEqual(metrics.roundedRects.length, 2, 'one rounded clip per paint');
        assert(metrics.roundedRects[0] === metrics.roundedRects[1],
            'the Gsk.RoundedRect scratch object is reused');
        assert(metrics.colors[0][1] === metrics.colors[1][1],
            'the Graphene.Rect scratch object is reused');
        assertEqual(metrics.pops, 2, 'each fill is popped again');
    }

    // 2. the reused objects still carry the geometry of the current call
    {
        const container = makeContainer();
        const metrics = newMetrics();
        const snapshot = makeSnapshot(metrics);
        PaintContainer.prototype._snapshotRoundedRect.call(container, snapshot,
            1, 2, 30, 40, 5, { name: 'fill' }, null, 0);
        PaintContainer.prototype._snapshotRoundedRect.call(container, snapshot,
            3, 4, 50, 60, 5, { name: 'fill' }, null, 0);

        const rect = metrics.colors[1][1];
        assertEqual(rect.get_x(), 3, 'x follows the call');
        assertEqual(rect.get_y(), 4, 'y follows the call');
        assertEqual(rect.get_width(), 50, 'width follows the call');
        assertEqual(rect.get_height(), 60, 'height follows the call');
    }

    // 3. negative sizes are normalized before initializing the scratch rect
    {
        const container = makeContainer();
        const metrics = newMetrics();
        const snapshot = makeSnapshot(metrics);
        PaintContainer.prototype._snapshotRoundedRect.call(container, snapshot,
            10, 20, -30, -40, 5, { name: 'fill' }, null, 0);

        const rect = metrics.colors[0][1];
        assertEqual(rect.get_x(), -20, 'x is shifted by the negative width');
        assertEqual(rect.get_y(), -20, 'y is shifted by the negative height');
        assertEqual(rect.get_width(), 30, 'width is made positive');
        assertEqual(rect.get_height(), 40, 'height is made positive');
    }

    // 4. the border branch still strokes through the cached stroke objects
    {
        const container = makeContainer();
        const metrics = newMetrics();
        const snapshot = makeSnapshot(metrics);
        PaintContainer.prototype._snapshotRoundedRect.call(container, snapshot,
            0, 0, 10, 10, 2, null, { name: 'border' }, 1);
        assertEqual(metrics.colors.length, 0, 'no fill without a color');
        assertEqual(metrics.strokes.length, 1, 'the border is stroked');
        assert(metrics.strokes[0][1] === container._stroke1, 'reusing the cached 1px stroke');
    }

    return summary('paint-container');
}
