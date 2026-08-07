#!/bin/sh

# Dev helper: rebuild + reinstall + kill the running DING process.
# Works from any CWD (POSIX-safe, no BASH_SOURCE under dash).

DING=0
if [ -d ~/.local/share/gnome-shell/extensions/desktop-icons-ng@icookie-tea.github.io ]; then
        DING=1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ ${DING} = "1" ]; then
        "$SCRIPT_DIR/local_install.sh"
fi
"$SCRIPT_DIR/kill.py"
