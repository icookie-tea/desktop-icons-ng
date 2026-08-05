# DING Desktop Icons New Generation

## What is it

Desktop Icons NG for GNOME Shell. It is a fork/rewrite of the official 'Desktop Icons' extension,
with these advantages:

* Drag'n'Drop, both inside the desktop, between desktop and applications, and nautilus windows
* Allows to use "Open with..." option with several files
* When hovering or clicking on an icon with a name too large to fit, it shows the full name
* Doesn't hang the compositor when there is too much activity in the desktop folder
* And much more...

---

## Changes from Upstream

This branch maintains fixes and enhancements not yet merged to the upstream repository
(<https://gitlab.com/rastersoft/desktop-icons-ng>). Key improvements:

### Bug Fixes

* **Wayland clipboard paste** - desktop context menu paste is now functional (was always grayed out due to cross-process clipboard format detection failure)
* **Context menu position & behavior** - removed arrow, aligned to mouse position, fixed grab/close behavior so clicking outside closes the menu
* **Context menu memory leak** - popover is now properly cleaned up using GTK4/Nautilus deferred cleanup pattern, preventing memory accumulation over long sessions
* **Unhandled promise rejection** - removed unnecessary `async` on `showDesktopMenu` / `_createDesktopBackgroundMenu`
* **`connectSignal is not a function`** - fixed pre-existing bug in `DesktopMenu`
* **Clipboard error log spam** - removed console.log from clipboard read error catch block
* **Image thumbnail overflow** - constrained thumbnail dimensions to `icon_size`, preventing rounded-corner container widening and icon overlap
* **Dead code removal** - removed unused `_parseClipboardText` / `_getClipboardText` methods

### New Features

* **Overview transition sync** - desktop icons fade in/out frame-synchronized with Shell overview transitions via Clutter.Clone + OverviewAdjustment (replaces old post-hoc ease animation)
* **Terminal fallback** - added `ptyxis` to the terminal emulator fallback list
* **Drag text/URLs to desktop** - drag text from editors or URLs into desktop creates `.txt` files, matching Nautilus behavior (handles Chinese, URL sanitization, filename deduplication)
* **Stacked drag preview for multi-select** - shows stacked icon with count badge (e.g. "3") when dragging multiple selected items

### Recent Fixes

* **Primary monitor switch icon placement** - new icons now appear on the correct screen after switching primary display in GNOME settings
* **Folder self-drop routing** - prevents Nautilus "cannot move folder into itself" error and fixes drag-into-selected-folder edge cases
* **Drag cursor/ghost icon** - ghost preview now follows mouse during drag (was showing default text-file placeholder)
* **Accent color refresh on theme change** - selection colors update immediately when the accent color changes (GNOME preset or user-level overrides like Chromaleon), no longer requires restart
* **Ghost preview size fix** - ghost rectangle now matches actual icon container size instead of full grid cell
* **Drop target box-shadow suppression** - removed 1px green outline from Adwaita `:drop(active)` on desktop window during drag

---

## Requirements

* GNOME Shell >= 3.38
* Nautilus >= 3.38
* File-roller >= 3.38 or Gnome AutoAr (including gir1.2 files)
* Desktop folder already created

## Manual installation

The easiest way of installing DING is to run the `scripts/local_install.sh` script. It performs the build steps
specified in the next section.

In Ubuntu, unfortunately, it is not possible to use it directly because the internal desktop-icons-ng
extension interferes. Fortunately, you can find .deb packages for Ubuntu in the oficial page:

<https://www.rastersoft.com/programas/ding.html>

If you still want to use the extension from source code, the only way is to install the
package "gnome-session" to be able to use the standard gnome shell session, and there install the
following extensions from extensions.gnome.org:

* Desktop icons ng
* Dash to dock
* Appindicator and KstatusNotifierItem support
* Tiling assistant

That will allow to have the same experience than the original Ubuntu desktop, but with the most recent
versions of the extensions.

## Internal architecture

The code is divided in two parts: a classic Gtk3 program that manages the whole desktop, and a little
extension (comprised only by the files 'extension.js', 'visible-area.js' and
'emulate-x11-window-type.js') that have these roles:

* Launch the desktop program at startup, relaunch it if it dies, and kill it if the extension is disabled
* Identify the desktop windows and keep it at the bottom of the windows stack, in all desktops
* Detect changes in the desktop/monitors geometry and notify the main desktop program of them

These two last items are paramount in Wayland systems, because there an application can neither set its
role as freely as in X11, nor get that information.

Of course, to avoid breaking the security model of Wayland, it is paramount to ensure that no other
program can pose as DING. In old versions, the process for identifying the window was quite convoluted,
passing an UUID through STDIN and putting it in the window title. But since Gnome Shell 3.38 there is
a new API that allows to check whether a window belongs to an specific process launched from an
extension, which makes the code much cleaner and straightforward.

The extension monitors all 'map' signals, and when a window from the DING process previously
launched is mapped, it knows that it is the desktop window. It stores that window object, sends it to
the bottom of the stack, and connects to three signals:

* raised: it is called every time the window is sent to the front, so in the callback, the extension
sends it again to the bottom.
* position-changed: although the window doesn't have titlebar, it still is possible to move it using
Alt+F7, or pressing Super and dragging it with the mouse, so this callback returns the window to the
right possition every time the user tries to move it.
* unmanaged: called when the window disappears. It deletes the UUID, and waits for the desktop program
to be killed (it will be relaunched again by the extension, and, of course, a new UUID will be used).

It also monitors other signals to ensure that the desktop receives the focus only when there are no
other windows in the current desktop, and to keep the icons in the right screen, no matter if the
user changes to another virtual desktop.

The extension also intercepts three Gnome Shell system calls, in order to hide the desktop windows
from the tab switcher and the Activities mode. These are 'Meta.Display.get_tab_list()',
'Shell.Global.get_window_actors()', and 'Meta.Workspace.list_windows()'.

## Launching the Desktop Icons application stand-alone

It is possible to launch the desktop icons application in stand-alone mode to do debugging and
testing, but, of course, it will behave as a classic Gtk program: there will be a window with its
titlebar, and the background won't be transparent (it could be, but since the idea is to do debug,
it is better this way). To do so, just launch './ding.js' from the repository directory. If it can't
find the schemas file, just enter the 'schemas' folder and type 'glib-compile-schemas .', and retry.

It accepts the following command line parameters:

* -P: specifies the working path. If not set, it will default to './', which means that all the other
files must be in the current path.
* -D: specifies a monitor. It is followed by another parameter in the form: X:Y:W:H:Z being each letter
      a number with, respectively:
  * X: the X coordinate of this monitor
  * Y: the Y coordinate of this monitor
  * W: the width in pixels of this monitor
  * H: the height in pixels of this monitor
  * Z: the zoom value for this monitor
  you can set several -D parameters in the same command line, one for each monitor. A single window
  will be created for each monitor. If no -D parameter is specified, it will create a single monitor
  with a size of 1280x720 pixels.
* -M: specifies which monitor is the primary index, to add there any new file icon.

## Build with Meson

The project uses a build system called [Meson](https://mesonbuild.com/). You can install
in most Linux distributions as "meson". You also need "ninja" and xgettext.

It's possible to read more information in the Meson docs to tweak the configuration if needed.

For a regular use and local development these are the steps to build the
project and install it:

```bash
meson --prefix=$HOME/.local/ --localedir=share/gnome-shell/extensions/ding@rastersoft.com/locale .build
ninja -C .build install
```

It is strongly recommended to delete the destination folder
($HOME/.local/share/gnome-shell/extensions/ding@rastersoft.com) before doing this, to ensure that no old
data is kept.

## Installing with Puppet

If you want to install it in several machines using puppet, you must first create an installation folder
in your local machine using:

```bash
mkdir install_folder
meson --prefix=`pwd`/install_folder --localedir=share/locale .build
ninja -C .build
ninja -C .build install
rm -f install_folder/share/glib-2.0/schemas/gschemas.compiled
```

The content of the `install_folder` folder is what you must copy in the destination computers at /usr. After
doing that, you must run in each computer `sudo glib-compile-schemas /usr/share/glib-2.0/schemas` to update
the schemas in the system.

## Export extension ZIP file for extensions.gnome.org

To create a ZIP file with the extension, just run:

```bash
./scripts/export-zip.sh
```

This will create the file `ding@rastersoft.com.zip` with the extension, following the rules for publishing at extensions.gnome.org.

## .desktop files limitations

To guarantee security, .desktop files can only be launched when several requisites are fullfilled:

* the desktop folder (the folder that contains the desktop files) is writable ONLY by the user
* the .desktop file (the launcher) is writable ONLY by the user
* the .desktop file has been manually enabled by right-clicking on it and selecting "Allow Launching"

If any of these items is false, .desktop files won't work.

## Documentation

* [Architecture Analysis](docs/architecture-analysis.md) - DING dual-layer architecture, startup flow, D-Bus communication
* [Maintainability Refactor](docs/maintainability-refactor.md) - 2026 refactor summary: stages, ESM migration notes, key decisions, verification
* [Fixes Log](docs/fixes.md) - detailed bug fix history with root cause analysis
* [Overview Animation](docs/overview-animation.md) - overview mode fade in/out implementation using Clutter.Clone + OverviewAdjustment

External references: [GNOME Shell Extension Best Practices (EGO)](https://wiki.gnome.org/Projects/GnomeShell/Extensions/BestPractices) - official guidelines for extension development

## Source code and contacting the author

Sergio Costas (upstream author)
<https://gitlab.com/rastersoft/desktop-icons-ng>
<rastersoft@gmail.com>

icookie (this branch maintainer, for personal use)
<1024494987@qq.com>

*This branch was developed with assistance from LLMs: DeepSeek V4 Pro and Qwen3-27B.*
