/* Regression tests for the encrypted-archive passphrase prompt.
 *
 * Bug (audit 2026-09-11): doExtractFile() showed the "Passphrase required"
 * prompt and then awaited _cleanupFile() (removing the partially extracted
 * tree) BEFORE calling _waitButtons(), which installs _buttonPromiseAccept.
 * A Cancel/OK click landing during that window found no resolver: Cancel
 * cancelled the shared cancellable (aborting the cleanup) and OK dropped the
 * typed password; in both cases the later installed resolver was never
 * called, so the dialog could not be dismissed and the LOGOUT|SUSPEND
 * session inhibit stayed held until DING was restarted.
 *
 * The fix arms the button promise synchronously together with the prompt, so
 * a click can never race the resolver installation. */
import { ProgressDialog } from '../app/auto-ar.js';
import { assert, assertEqual, summary } from './harness.js';

function makeAr() {
    const ar = Object.create(ProgressDialog.prototype);
    ar._waitingForPassword = false;
    ar._buttonPromiseAccept = null;
    ar._processBar = { hide() {} };
    ar._passEntry = { show() {} };
    ar._passOkButton = { show() {}, set_receives_default() {} };
    ar._processLabel = { set_label() {} };
    ar._currentPassword = null;
    return ar;
}

export async function runTests() {
    assertEqual(typeof ProgressDialog.prototype._requestPassphrase, 'function',
        'the prompt helper exists so the resolver is armed synchronously');

    if (typeof ProgressDialog.prototype._requestPassphrase !== 'function') {
        return summary('passphrase-race');
    }

    // 1. The resolver is installed before the caller awaits any cleanup.
    {
        const ar = makeAr();
        const promise = ProgressDialog.prototype._requestPassphrase.call(ar, '/tmp/secret.zip');
        assertEqual(ar._waitingForPassword, true, 'the passphrase wait is armed');
        assertEqual(typeof ar._buttonPromiseAccept, 'function',
            'the button resolver is installed synchronously with the prompt');

        // A click arriving before any cleanup await must resolve the promise.
        ar._buttonPromiseAccept(true);
        assertEqual(await promise, true, 'an early OK click is delivered, not lost');
    }

    // 2. Same for Cancel.
    {
        const ar = makeAr();
        const promise = ProgressDialog.prototype._requestPassphrase.call(ar, '/tmp/secret.zip');
        ar._buttonPromiseAccept(false);
        assertEqual(await promise, false, 'an early Cancel click is delivered, not lost');
    }

    return summary('passphrase-race');
}
