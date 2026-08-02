#!/bin/bash

# Ubuntu variant install (installs as dingubuntu@rastersoft.com to avoid
# clashing with the distro's bundled desktop-icons-ng). Works from any CWD.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 1

rm -rf ~/.local/share/gnome-shell/extensions/dingubuntu@rastersoft.com
rm -rf ~/.local/share/gnome-shell/extensions/ding@rastersoft.com
rm -rf .build
mkdir .build
meson setup --prefix=$HOME/.local/ --localedir=share/gnome-shell/extensions/ding@rastersoft.com/locale .build
ninja -C .build install
rm -rf .build
mv ~/.local/share/gnome-shell/extensions/ding@rastersoft.com ~/.local/share/gnome-shell/extensions/dingubuntu@rastersoft.com
sed -i "s#ding@rastersoft#dingubuntu@rastersoft#" ~/.local/share/gnome-shell/extensions/dingubuntu@rastersoft.com/metadata.json
