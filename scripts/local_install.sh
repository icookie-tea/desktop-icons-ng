#!/bin/bash

# Local (user) install. Works from any CWD.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 1

rm -rf ~/.local/share/gnome-shell/extensions/ding@rastersoft.com/*
rm -rf .build
mkdir .build
meson setup --prefix=$HOME/.local/ --localedir=share/gnome-shell/extensions/ding@rastersoft.com/locale .build
ninja -C .build install
rm -rf .build
