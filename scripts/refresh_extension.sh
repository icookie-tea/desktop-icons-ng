#!/bin/sh

# Dev helper: rebuild + reinstall + kill the running DING process.
# Works from any CWD (POSIX-safe, no BASH_SOURCE under dash).

DINGUBUNTU=0
DING=0
if [ -d ~/.local/share/gnome-shell/extensions/dingubuntu@rastersoft.com ]; then
        DINGUBUNTU=1
fi
if [ -d ~/.local/share/gnome-shell/extensions/ding@rastersoft.com ]; then
        DING=1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ ${DINGUBUNTU} = "1" ]; then
        "$SCRIPT_DIR/ubuntu_install.sh"
fi
if [ ${DING} = "1" ]; then
        "$SCRIPT_DIR/local_install.sh"
fi
"$SCRIPT_DIR/kill.py"
