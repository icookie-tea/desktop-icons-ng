/* Regression tests for icon-box content placement.
 *
 * Contract: every thumbnail is aspect-fitted and centered inside the same
 * square icon box.  The box itself is positioned by the widget layout; image
 * loading must not invent a per-file vertical alignment policy.
 */
import * as DesktopIconItem from '../app/desktop-icon-item.js';
import { assertDeepEqual, summary } from './harness.js';

export function runTests() {
    const place = DesktopIconItem.calculateThumbnailPlacement;

    assertDeepEqual(place?.(1600, 400, 64),
        { width: 64, height: 16, x: 0, y: 24 },
        'landscape thumbnail is vertically centered in the icon box');
    assertDeepEqual(place?.(400, 1600, 64),
        { width: 16, height: 64, x: 24, y: 0 },
        'portrait thumbnail is horizontally centered in the icon box');
    assertDeepEqual(place?.(512, 512, 64),
        { width: 64, height: 64, x: 0, y: 0 },
        'square thumbnail fills the icon box');

    return summary('icon-layout');
}
