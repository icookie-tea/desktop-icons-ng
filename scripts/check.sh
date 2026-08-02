#!/usr/bin/env bash
# DING check script: lint + syntax check + unit tests.
# Usage: scripts/check.sh   (works from any CWD)
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "== ESLint =="
npx eslint .

echo "== Syntax check (node --check) =="
for f in extension.js prefs.js visible-area.js emulate-x11-window-type.js \
         gnome-shell-override.js app/*.js; do
    node --check "$f"
done

echo "== Unit tests (gjs) =="
gjs --module tests/run.js

echo "== Structural sanity =="
# Every class method referenced via this._xxx() must be defined somewhere in
# the same file (guards against helpers lost in mechanical refactors).
if ! grep -qE '^    _remoteCall\(' app/dbus-remote-operations.js; then
    echo "FAIL: app/dbus-remote-operations.js is missing the _remoteCall() helper definition"
    exit 1
fi
# Legacy GJS only exports top-level var/function — classes must be var-declared.
if grep -qE '^class [A-Za-z]' app/*.js; then
    echo "FAIL: top-level bare 'class' declarations are not exported by legacy GJS"
    grep -nE '^class [A-Za-z]' app/*.js
    exit 1
fi
# Extracted sub-managers must never pass a bare 'this' as an argument (the
# DesktopManager reference goes through this._dm).
if grep -nE '\(this[,)]|\[this[,]' app/grid-layout.js app/desktop-monitor.js app/dbus-remote-operations.js; then
    echo "FAIL: bare 'this' passed as argument in extracted manager (should be this._dm)"
    exit 1
fi

echo "ALL CHECKS PASSED"
