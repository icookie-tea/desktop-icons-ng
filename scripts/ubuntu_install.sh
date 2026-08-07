#!/bin/bash

# Ubuntu variant install. This fork has its own UUID
# (desktop-icons-ng@icookie-tea.github.io), so it no longer clashes with the
# distro's bundled desktop-icons-ng (ding@rastersoft.com): no rename needed.
# Stale user-level installs of this project under the old UUIDs are removed.
# Works from any CWD.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 1

rm -rf ~/.local/share/gnome-shell/extensions/dingubuntu@rastersoft.com
rm -rf ~/.local/share/gnome-shell/extensions/ding@rastersoft.com
rm -rf ~/.local/share/gnome-shell/extensions/desktop-icons-ng@icookie-tea.github.io
rm -rf .build
mkdir .build
meson setup --prefix=$HOME/.local/ --localedir=share/gnome-shell/extensions/desktop-icons-ng@icookie-tea.github.io/locale .build
ninja -C .build install
rm -rf .build
