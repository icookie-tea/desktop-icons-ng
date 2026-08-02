/* Tests for DesktopIconsUtil.generateDropFilename (text-drop filename
 * sanitization). Locks the behaviour after the \\x00-\\x1f regex fix:
 * control chars are stripped, normal digits/letters are preserved.
 * Sanitized names of >= 8 chars get a '.txt' suffix; shorter ones fall
 * back to the (translated) default name. */
import * as DesktopIconsUtil from '../app/desktop-icons-util.js';
import { assertEqual, summary } from './harness.js';

export function runTests() {
    // 1. normal text keeps digits and letters, gets .txt suffix
    assertEqual(DesktopIconsUtil.generateDropFilename('2026 report'),
        '2026 report.txt', 'digits/letters preserved, .txt appended');

    // 2. illegal filename chars are replaced with '-'
    assertEqual(DesktopIconsUtil.generateDropFilename('a<b>c:d"e\\f/g|h?i*j'),
        'a-b-c-d-e-f-g-h-i-j.txt', 'illegal chars replaced');

    // 3. control chars are replaced (regression for \\x00-\\x1f regex bug)
    assertEqual(DesktopIconsUtil.generateDropFilename('aaaa\u0001b\u001fc'),
        'aaaa-b-c.txt', 'control chars replaced');

    // 4. runs of '-' collapse, leading/trailing '-' stripped
    assertEqual(DesktopIconsUtil.generateDropFilename('aaaa---bbbb-'),
        'aaaa-bbbb.txt', 'dash runs collapsed and trimmed');

    // 5. newlines/tabs become spaces
    assertEqual(DesktopIconsUtil.generateDropFilename('line1\nline2\tend'),
        'line1 line2 end.txt', 'newlines/tabs become spaces');

    // 6. long text truncated to 64 chars
    const longText = 'x'.repeat(100);
    assertEqual(DesktopIconsUtil.generateDropFilename(longText).length,
        64 + 4, 'long text truncated to 64 chars plus .txt');

    // 7. short text falls back to the translated default name
    assertEqual(DesktopIconsUtil.generateDropFilename('hi'),
        'Dropped Text.txt', 'short text uses fallback name');

    // 8. Chinese text survives sanitization
    assertEqual(DesktopIconsUtil.generateDropFilename('我的重要文档备份'),
        '我的重要文档备份.txt', 'Chinese text preserved');

    return summary('generateDropFilename');
}
