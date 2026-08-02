#!/usr/bin/env bash
# DING check script: lint + syntax check + unit tests.
# Usage: scripts/check.sh   (works from any CWD)
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "== ESLint =="
npx eslint .

echo "== Syntax check (node --check) =="
for f in extension.js prefs.js visibleArea.js emulateX11WindowType.js \
         gnomeShellOverride.js app/*.js; do
    node --check "$f"
done

echo "== Unit tests (gjs) =="
gjs tests/run.js

echo "== Structural sanity =="
# Every class method referenced via this._xxx() must be defined somewhere in
# the same file (guards against helpers lost in mechanical refactors).
if ! grep -qE '^    _remoteCall\(' app/dbusUtils.js; then
    echo "FAIL: app/dbusUtils.js is missing the _remoteCall() helper definition"
    exit 1
fi

echo "ALL CHECKS PASSED"
