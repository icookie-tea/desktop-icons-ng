/* Tests for icon position remapping between monitor areas.
 *
 * The placement code stores positions as absolute screen coordinates. When the
 * primary monitor changes, those coordinates must be reinterpreted relative to
 * the new primary monitor, otherwise the icons visually collapse to the edge
 * of the new screen (the old coordinates fall outside it).
 *
 * The two properties that matter for the design, both asserted here:
 *  - Reversible: A -> B -> A returns the original position, so switching the
 *    primary monitor back restores the previous layout.
 *  - Stable under repetition for a fixed input: the result is a pure function
 *    of the *stored* coordinate, which is why the remapped position does not
 *    have to be written to disk (every refresh recomputes the same value).
 *    Remapping an already-remapped value as if it were the stored one is NOT
 *    stable, and the placement code must never do that.
 */
import { remapPosition, isInside } from '../app/icon-remap.js';
import { assert, assertDeepEqual, summary } from './harness.js';

/* The reporter's real pair: laptop and external display. */
const A = { x: 0, y: 0, width: 2560, height: 1440 };
const B = { x: 2560, y: 0, width: 1920, height: 1080 };

export function runTests() {
    // 1. Corners map to corners: the fractional anchor is preserved.
    {
        assertDeepEqual(remapPosition([0, 0], A, B), [2560, 0], 'top-left maps to the target top-left');
        const br = remapPosition([2559, 1439], A, B);
        assert(Math.abs(br[0] - 4479) < 0.5 && Math.abs(br[1] - 1079) < 0.5,
            'bottom-right maps to the target bottom-right (within half a pixel)');
    }

    // 2. Reversible: A -> B -> A returns the original coordinate, so switching
    //    the primary monitor back restores the previous layout.
    {
        for (const p of [[640, 432], [128, 144], [2432, 1296], [10, 10]]) {
            const roundTrip = remapPosition(remapPosition(p, A, B), B, A);
            assertDeepEqual(roundTrip, p, `A->B->A returns ${p} unchanged`);
        }
    }

    // 3. Stability for a fixed input: recomputing from the same stored
    //    coordinate always yields the same result (no drift across refreshes).
    {
        const stored = [640, 432];
        const first = remapPosition(stored, A, B);
        for (let i = 0; i < 5; i++) {
            assertDeepEqual(remapPosition(stored, A, B), first,
                'recomputing from the stored coordinate is stable');
        }
        // The fractional position is what is preserved, so the icon keeps its
        // place on screen rather than being clamped to a different edge.
        const fxBefore = stored[0] / A.width;
        const fxAfter = (first[0] - B.x) / B.width;
        assert(Math.abs(fxBefore - fxAfter) < 0.001, 'fractional x is preserved');
    }

    // 4. Remapping a value that was already remapped is NOT stable — this
    //    documents the constraint the placement code relies on: it must always
    //    feed the un-rewritten stored coordinate.
    {
        const stored = [640, 432];
        const once = remapPosition(stored, A, B);
        const twice = remapPosition(once, A, B);
        assert(once[0] !== twice[0],
            'feeding an already-remapped value drifts (so only stored coords may be fed)');
    }

    // 5. Degenerate source area: no NaN escapes (a NaN would make getDistance()
    //    return NaN and the icon would be dropped).
    {
        const zero = { x: 0, y: 0, width: 0, height: 0 };
        const result = remapPosition([100, 100], zero, B);
        assert(Number.isFinite(result[0]) && Number.isFinite(result[1]),
            'a zero-sized source area does not produce NaN');
        assertDeepEqual(result, [2560, 0], 'a degenerate source maps to the target origin');
    }

    // 6. A position outside the source is clamped into the target instead of
    //    escaping it (a stale off-screen coordinate must stay on screen).
    {
        const far = remapPosition([99999, 99999], A, B);
        assert(far[0] <= B.x + B.width && far[1] <= B.y + B.height,
            'an off-area coordinate is clamped into the target area');
        const negative = remapPosition([-5000, -5000], A, B);
        assertDeepEqual(negative, [2560, 0], 'a negative coordinate clamps to the target origin');
    }

    // 7. Same-area remap is the identity (nothing changes when the primary
    //    monitor did not move), so the caller can apply it unconditionally.
    {
        for (const p of [[0, 0], [640, 432], [2559, 1439]]) {
            assertDeepEqual(remapPosition(p, A, A), p, 'remapping within the same area is the identity');
        }
    }

    // 8. isInside: used to decide whether a stored coordinate still belongs to
    //    the primary area.
    {
        assert(isInside([100, 100], A), 'a point inside the area');
        assert(!isInside([3000, 100], A), 'a point to the right is outside');
        assert(!isInside([-1, 100], A), 'a point to the left is outside');
        assert(isInside([0, 0], A), 'the origin is inside');
        assert(!isInside([2560, 0], A), 'the right edge is exclusive');
    }

    return summary('icon-remap');
}
