#!/usr/bin/env bash
# DING check script: lint + syntax check + unit tests.
# Usage: scripts/check.sh   (works from any CWD)
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "== ESLint =="
# Scoped to project files: 'eslint .' would also scan gitignored
# .agents/skills/ (third-party skill scripts) and fail on their style.
npx eslint app tests extension.js prefs.js visible-area.js \
    emulate-x11-window-type.js gnome-shell-override.js

echo "== Syntax check (node --check) =="
for f in extension.js prefs.js visible-area.js emulate-x11-window-type.js \
         gnome-shell-override.js app/*.js; do
    node --check "$f"
done

echo "== Unit tests (gjs) =="
gjs --module tests/run.js

echo "== Smoke test (standalone ding.js, needs a display) =="
# Catches constructor/wiring bugs that unit tests can't see: the process must
# stay alive for the whole window without printing a JS ERROR.
# DING_SMOKE=1 makes the standalone window consume all key events, so the
# user's keystrokes (the window may grab focus) can't trigger desktop logic.
if [ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ]; then
    smoke_log=$(mktemp)
    rc=0
    DING_SMOKE=1 timeout 8 gjs --module app/ding.js -P app >"$smoke_log" 2>&1 || rc=$?
    if [ $rc -ne 124 ] || grep -q "JS ERROR" "$smoke_log"; then
        echo "FAIL: ding.js smoke test (exit=$rc)"
        grep -B1 -A8 "JS ERROR" "$smoke_log" | head -40
        rm -f "$smoke_log"
        exit 1
    fi
    rm -f "$smoke_log"
else
    echo "skip (no DISPLAY/WAYLAND_DISPLAY)"
fi

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
if grep -nE '\(this[,)]|\[this[,]' app/grid-layout.js app/desktop-monitor.js app/dbus-remote-operations.js app/selection-manager.js app/search-dialog.js app/keyboard-manager.js app/dnd-manager.js; then
    echo "FAIL: bare 'this' passed as argument in extracted manager (should be this._dm)"
    exit 1
fi
# Namespace imports (import * as X) must never be constructed bare —
# 'new X(' throws "X is not a constructor" at runtime, use 'new X.ClassName('.
for m in $(grep -oE '^import \* as [A-Za-z]+' app/desktop-manager.js | awk '{print $4}'); do
    if grep -qE "new ${m}\(" app/desktop-manager.js; then
        echo "FAIL: bare namespace construction 'new ${m}(' (must be 'new ${m}.ClassName()')"
        exit 1
    fi
done
# State ownership: fields that moved into a manager during the DesktopManager
# split must be read through that manager, never through the old
# DesktopManager access paths (dm.x / _desktopManager.x / this._dm.x).
# This list is a test, not documentation: when state moves, update the line
# in the same commit — the check failing is the reminder.
check_state_ownership() {
    local fields=$1 allowed=$2 f
    for f in app/*.js; do
        case " $allowed " in *" $f "*) continue ;; esac
        if grep -nE "(dm|_desktopManager|desktopManager|this\._dm)\.(${fields})\b" "$f"; then
            echo "FAIL: $f reads manager-owned state through the old DesktopManager path (fields: $fields)"
            return 1
        fi
    done
}
# selection-manager.js: rubber band + selection rectangle state
check_state_ownership 'rubberBand|selectionRectangle|_clickCaptured|x1|x2|y1|y2' 'app/selection-manager.js' || exit 1
# search-dialog.js: type-to-search state
check_state_ownership 'searchString|_findFileWindow|keypressTimeoutID' 'app/search-dialog.js' || exit 1
# dnd-manager.js: drag state (file-item.js reads dragItem via the DM getter)
check_state_ownership 'dragItem|_dragList|_dragOriginX|_dragOriginY' 'app/dnd-manager.js app/file-item.js' || exit 1
# keyboard-manager.js: keyboard navigation state
check_state_ownership 'ignoreKeys|_lastSelected' 'app/keyboard-manager.js' || exit 1
# Every method called through the DesktopManager reference (this._dm.<m>( /
# this._desktopManager.<m>( / dm.<m>() across app/) must exist on
# DesktopManager — catches methods moved into a manager without a shim
# (e.g. _getCurrentKeyboardIcon, which crash-looped a settings toggle on a
# real device).
while read -r m; do
    if ! grep -qE "^\s+(async )?(get |set )?${m}\(" app/desktop-manager.js; then
        echo "FAIL: '$m' is called on the DesktopManager reference but not defined in app/desktop-manager.js (moved to a manager without a shim?)"
        exit 1
    fi
done < <(grep -rhoE "(this\._dm|this\._desktopManager|\bdm)\.[A-Za-z_$][A-Za-z0-9_$]*\(" app/*.js \
            | grep -oE "[A-Za-z_$][A-Za-z0-9_$]*\($" | tr -d '(' | sort -u)
# The legacy 'imports' global is deprecated by GNOME Shell — everything is
# ESM now (app/signals.js replaces imports.signals). Reject regressions.
if grep -nE '(^|[^.A-Za-z_])imports\.(signals|gi|main|misc|ui)' extension.js prefs.js \
        visible-area.js emulate-x11-window-type.js gnome-shell-override.js title-protocol.js app/*.js; then
    echo "FAIL: legacy 'imports.' usage found (use ESM imports / app/signals.js)"
    exit 1
fi

echo "ALL CHECKS PASSED"
