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

echo "ALL CHECKS PASSED"
