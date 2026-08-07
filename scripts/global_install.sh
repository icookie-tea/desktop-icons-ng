#!/bin/bash

# System-wide install (requires sudo). Works from any CWD.
PREFIX=/usr

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 1

sudo rm -rf ${PREFIX}/share/gnome-shell/extensions/desktop-icons-ng@icookie-tea.github.io/*
rm -rf .build
mkdir .build
meson setup --prefix=${PREFIX} .build
ninja -C .build
sudo ninja -C .build install
rm -rf .build
