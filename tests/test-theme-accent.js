/* Tests for ThemeManager.parseAccentOverride() — the pure core of the
 * user-stylesheet accent reader (~/.config/gtk-4.0/gtk.css + @import chain,
 * e.g. Chromaleon's custom-accent.css). Pins: comment stripping,
 * last-definition-wins, invalid-value skipping, other-color ignoring.
 */
import { ThemeManager } from '../app/theme-manager.js';
import { assert, assertEqual, summary } from './harness.js';

function parse(contents) {
    return ThemeManager.parseAccentOverride(contents);
}

function runTests() {
    // no contents / no definition → null
    assertEqual(parse([]), null, 'empty contents → null');
    assertEqual(parse(['/* nothing here */']), null, 'comment-only → null');
    assertEqual(parse(['@define-color accent_fg_color #123456;']), null,
        'other @define-color names are ignored');

    // single hex definition
    {
        const c = parse(['@define-color accent_bg_color #ff0000;']);
        assert(c !== null, 'hex definition found');
        assertEqual(c.red, 1, 'hex red');
        assertEqual(c.green, 0, 'hex green');
        assertEqual(c.blue, 0, 'hex blue');
        assertEqual(c.alpha, 1, 'hex alpha defaults to 1');
    }

    // last valid definition wins (later rules win at the same priority)
    {
        const c = parse([
            '@define-color accent_bg_color #00ff00;',
            '@define-color accent_bg_color #0000ff;',
        ]);
        assert(c !== null, 'multiple definitions → one wins');
        assertEqual(c.blue, 1, 'last definition wins (blue)');
        assertEqual(c.green, 0, 'earlier definition overridden');
    }

    // a later INVALID value must not clobber an earlier valid one
    {
        const c = parse([
            '@define-color accent_bg_color #0000ff;',
            '@define-color accent_bg_color not-a-color;',
        ]);
        assert(c !== null, 'invalid later value does not clobber');
        assertEqual(c.blue, 1, 'earlier valid definition kept');
    }

    // all values invalid → null
    assertEqual(parse(['@define-color accent_bg_color nope;']), null,
        'only-invalid → null');

    // rgb() form across the @import chain (later file wins).
    // NOTE (latent limitation, pinned): Gdk.RGBA.parse expects INTEGER
    // 0-255 RGB components; decimal values (rgba(0, 0.5, 1, 0.8)) are
    // silently misparsed to near-black, and the space-separated CSS form
    // is rejected outright (parse=false → definition skipped).
    {
        const c = parse([
            '@define-color accent_bg_color #111111;',
            '@define-color accent_bg_color rgba(0, 128, 255, 0.8);',
        ]);
        assert(c !== null, 'rgba() form parsed');
        assert(Math.abs(c.green - 128 / 255) < 1e-6, 'rgba green = 128/255');
        assertEqual(c.blue, 1, 'rgba blue = 255/255');
        assert(Math.abs(c.alpha - 0.8) < 1e-6, 'rgba alpha ≈ 0.8');
    }

    // decimal rgba() misparses to near-black — the definition still
    // "parses" (parse=true), so it clobbers earlier definitions. Pinned
    // as current behavior; see NOTE above.
    {
        const c = parse([
            '@define-color accent_bg_color #0000ff;',
            '@define-color accent_bg_color rgba(0, 0.5, 1, 0.8);',
        ]);
        assert(c !== null, 'decimal rgba() still accepted by parse()');
        assertEqual(c.red, 0, 'decimal green/blue misparsed ≈ 0 (near-black)');
        assert(c.blue < 0.01, 'decimal value 1 parsed as 1/255, not 1.0');
    }

    // commented-out definitions are ignored (comment stripping)
    {
        const c = parse([
            '/* @define-color accent_bg_color #ff0000; */',
            '@define-color accent_bg_color #00ff00;',
        ]);
        assert(c !== null, 'commented definition ignored');
        assertEqual(c.green, 1, 'only the live definition counts');
        assertEqual(c.red, 0, 'commented red not applied');
    }

    return summary('theme-accent');
}

export { runTests };
